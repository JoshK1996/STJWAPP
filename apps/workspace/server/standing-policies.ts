import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { audit, digest, requireCondition, Problem, type Actor } from "./security";
import { schoolActor } from "./school";
import { lockAcademics } from "./timetable-engine";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import { standingPolicySchema } from "../shared/academic-standing";
import { gradingPolicySchema, type GradingPolicy } from "../shared/grading";
import {
  standingPolicyScopeInput, standingPolicyListInput, standingPolicyHistoryInput,
  standingPolicyCreateInput, standingPolicyUpdateInput, standingPolicyConfirmInput, standingPolicyArchiveInput,
  standingPolicyLimits as limits, standingPolicyHashAlgorithm,
  type StandingConfiguration, type StandingPolicyCatalog, type StandingGradingEvidence, type StandingPolicyEvidence,
  type StandingPolicyRecord, type StandingPolicyVersion, type StandingPolicyDetail, type StandingPolicyMutationResult,
  type StandingPolicyList, type StandingPolicyHistoryPage, type StandingPolicyVersionsPage,
} from "../shared/standing-policies";
import { canonicalStandingJson, gradingPolicyEvidenceHash, standingPolicyEvidenceHash } from "./standing-policy-provenance";

const iso = (value: any): string => new Date(value).toISOString();
const json = (value: unknown) => JSON.stringify(value);
const configurationHash = (configuration: StandingConfiguration) => digest(canonicalStandingJson({ schemaVersion: 1, kind: "standing_configuration", configuration }));
const unavailable = "Standing policy not found under your current school access.";

async function policyTransaction<T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  try {
    return await reportTransaction(db, async tx => {
      await tx.query("SET LOCAL statement_timeout = '15s'");
      await tx.query("SET LOCAL lock_timeout = '5s'");
      return fn(tx);
    });
  } catch (error: any) {
    if (["55P03", "57014"].includes(error.code)) throw new Problem(503, "The policy source is busy or exceeded its review time limit. Retry the same command when the source is available.");
    throw error;
  }
}

// Every path takes academics before authority. No academic lock is acquired
// after a user/grant/domain lock. Settings writers use their own existing mutex.
async function context(tx: Queryable, supplied: Actor, sessionHash: string | undefined, unitId: string) {
  requireCondition(sessionHash, 401, "A current password session is required.");
  await lockAcademics(tx, supplied.org_id);
  const actor = await currentReportActor(tx, supplied, sessionHash);
  if (!["developer", "owner", "admin"].includes(actor.role)) {
    requireCondition(actor.unit_ids.includes(unitId), 403, "Explicit school unit access is required.");
    requireCondition((await tx.query("SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE", [actor.org_id, actor.id, unitId])).rows.length, 403, "School office access is required.");
  }
  requireCondition((await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=$2", [actor.org_id, unitId])).rows.length, 404, unavailable);
  return actor;
}
async function settingsMutex(tx: Queryable, unitId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["grading-settings:" + unitId]);
}
async function scopeForPolicy(tx: Queryable, actor: Actor, policyId: string) {
  const row = (await tx.query("SELECT unit_id,year_id FROM standing_policies WHERE org_id=$1 AND id=$2", [actor.org_id, policyId])).rows[0];
  requireCondition(row, 404, unavailable); return row;
}
function record(row: Row): StandingPolicyRecord {
  return { id: row.id, orgId: row.org_id, unitId: row.unit_id, yearId: row.year_id, version: row.version,
    archived: row.archived, configuration: row.configuration, draftHash: row.draft_hash, catalogHash: row.catalog_hash, evidence: row.evidence,
    activePolicyVersionId: row.active_policy_version_id, confirmedVersion: row.confirmed_version,
    hasUnconfirmedChanges: row.confirmed_configuration_hash !== row.draft_hash, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function version(row: Row): StandingPolicyVersion {
  return { policyVersionId: row.id, policyId: row.policy_id, version: row.version, draftVersion: row.draft_version,
    policyHash: row.policy_hash, configurationHash: row.configuration_hash, policy: row.policy, evidence: row.evidence,
    sourceDescription: row.source_description, reason: row.reason, confirmedBy: { id: row.confirmed_by, name: row.confirmed_name }, confirmedAt: iso(row.confirmed_at) };
}
async function confirmed(tx: Queryable, actor: Actor, row: Row): Promise<StandingPolicyVersion | null> {
  if (!row.active_policy_version_id) return null;
  const found = (await tx.query("SELECT * FROM standing_policy_versions WHERE org_id=$1 AND policy_id=$2 AND id=$3", [actor.org_id, row.id, row.active_policy_version_id])).rows[0];
  requireCondition(found, 409, "The policy confirmation evidence is unavailable."); return version(found);
}
async function readCatalog(tx: Queryable, actor: Actor, unitId: string, yearId: string): Promise<StandingPolicyCatalog> {
  // Organization-before-unit ordering agrees with academic source publication.
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [actor.org_id]);
  const unit = (await tx.query("SELECT id,name FROM units WHERE org_id=$1 AND id=$2 FOR SHARE", [actor.org_id, unitId])).rows[0];
  const yr = (await tx.query("SELECT id,name,version,starts_on::text,ends_on::text,archived FROM school_years WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR SHARE", [actor.org_id, unitId, yearId])).rows[0];
  requireCondition(unit && yr, 404, "Choose an existing school year in this exact unit.");
  const termRows = (await tx.query("SELECT id,name,version,starts_on::text,ends_on::text,locked_at FROM school_terms WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 ORDER BY id LIMIT $4 FOR SHARE", [actor.org_id, unitId, yearId, limits.terms + 1])).rows;
  const courseRows = (await tx.query(`SELECT c.id,c.code,c.title,c.version,c.archived,
    EXISTS(SELECT 1 FROM sections s WHERE s.org_id=c.org_id AND s.unit_id=c.unit_id AND s.course_id=c.id AND s.year_id=$3) AS offered
    FROM courses c WHERE c.org_id=$1 AND c.unit_id=$2 ORDER BY c.id LIMIT $4 FOR SHARE OF c`, [actor.org_id, unitId, yearId, limits.courses + 1])).rows;
  requireCondition(termRows.length <= limits.terms && courseRows.length <= limits.courses, 422, "This policy catalog exceeds the supported identity limit; no entries were truncated.");
  const setting = (await tx.query("SELECT policy,version FROM grading_settings WHERE org_id=$1 AND unit_id=$2 AND confirmed FOR SHARE", [actor.org_id, unitId])).rows[0];
  // One actual representative per exact JSON/version pair, bounded before data
  // reaches the service. No roster, scores, results or private review notes.
  const releaseRows = (await tx.query(`SELECT DISTINCT ON (r.snapshot->'book'->'policy',r.snapshot->'book'->'policy_version')
      r.id,r.book_id,r.book_version,r.created_at,r.snapshot->'book'->'policy' AS policy,r.snapshot->'book'->'policy_version' AS policy_version
    FROM gradebook_releases r JOIN gradebooks b ON b.id=r.book_id AND b.org_id=r.org_id AND b.unit_id=r.unit_id
    JOIN school_terms t ON t.id=b.term_id AND t.org_id=b.org_id AND t.unit_id=b.unit_id
    WHERE r.org_id=$1 AND r.unit_id=$2 AND t.year_id=$3
    ORDER BY r.snapshot->'book'->'policy',r.snapshot->'book'->'policy_version',r.created_at,r.id LIMIT $4`, [actor.org_id, unitId, yearId, limits.catalogPolicies + 1])).rows;
  requireCondition(releaseRows.length <= limits.catalogPolicies, 422, "This policy catalog exceeds the supported grading-policy limit; no entries were truncated.");
  const refs = new Map<string, StandingGradingEvidence>();
  const add = (policy: unknown, value: unknown, provenance: StandingGradingEvidence["provenance"][number]) => {
    requireCondition(gradingPolicySchema.safeParse(policy).success && typeof value === "number" && Number.isSafeInteger(value) && value > 0, 409, "Captured grading policy evidence is invalid; review the source configuration.");
    const hash = gradingPolicyEvidenceHash(policy), key = hash + ":" + value;
    const ref = refs.get(key) ?? { hash, version: value as number, policy: policy as GradingPolicy, provenance: [] };
    ref.provenance.push(provenance); refs.set(key, ref);
  };
  if (setting) add(setting.policy, setting.version, { kind: "confirmed_settings", unitId, version: setting.version });
  for (const r of releaseRows) add(r.policy, r.policy_version, { kind: "reviewed_release", releaseId: r.id, bookId: r.book_id, bookVersion: r.book_version, createdAt: iso(r.created_at) });
  requireCondition(refs.size <= limits.catalogPolicies, 422, "This policy catalog exceeds the supported grading-policy limit; no entries were truncated.");
  const data = { schemaVersion: 1 as const, hashAlgorithm: standingPolicyHashAlgorithm, unit: { id: unit.id, name: unit.name },
    year: { id: yr.id, name: yr.name, version: yr.version, startsOn: yr.starts_on, endsOn: yr.ends_on, archived: yr.archived },
    terms: termRows.map(r => ({ id: r.id, name: r.name, version: r.version, startsOn: r.starts_on, endsOn: r.ends_on, locked: !!r.locked_at })),
    courses: courseRows.map(r => ({ id: r.id, code: r.code, title: r.title, version: r.version, archived: r.archived, offeredInYear: r.offered })),
    gradingPolicies: [...refs.values()].sort((a, b) => (a.hash + ":" + a.version).localeCompare(b.hash + ":" + b.version)),
    gradeLevels: { source: "explicit_configuration_required" as const, values: [] as [] } };
  requireCondition(Buffer.byteLength(json(data)) <= limits.catalogBytes, 422, "This policy catalog exceeds the supported evidence size; no entries were truncated.");
  // Provenance location/count may change when an identical policy is reviewed
  // again. It does not change the business catalog or rewrite saved provenance.
  const catalogHash = digest(canonicalStandingJson({ ...data, gradingPolicies: data.gradingPolicies.map(({ provenance: _p, ...r }) => r) }));
  return { ...data, catalogHash };
}
function selectedEvidence(catalog: StandingPolicyCatalog, config: StandingConfiguration): StandingPolicyEvidence {
  const terms = catalog.terms.filter(r => config.termIds.includes(r.id));
  const courses = catalog.courses.filter(r => config.courseRules.some(rule => rule.courseId === r.id));
  requireCondition(terms.length === config.termIds.length && courses.length === config.courseRules.length, 422, "Every selected term and course must belong to the exact school unit/year catalog.");
  const gradingPolicies = config.acceptedGradingPolicies.map(ref => {
    const entry = catalog.gradingPolicies.find(r => r.hash === ref.hash && r.version === ref.version);
    requireCondition(entry, 422, "Every accepted grading policy hash/version must exist in the current verified catalog.");
    if ("allowedLabels" in ref) requireCondition(ref.allowedLabels.every(label => entry.policy.scale.some(s => s.label === label)), 422, "Allowed labels must occur in the exact captured grading scale.");
    return entry;
  });
  return { schemaVersion: 1, hashAlgorithm: standingPolicyHashAlgorithm, catalogHash: catalog.catalogHash, unit: catalog.unit, year: catalog.year, terms, courses, gradingPolicies };
}
export async function standingPolicyCatalog(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const input = standingPolicyScopeInput.parse(raw);
  return policyTransaction(db, async tx => {
    const actor = await context(tx, supplied, sessionHash, input.unitId); await settingsMutex(tx, input.unitId);
    const result = await readCatalog(tx, actor, input.unitId, input.yearId); await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}
export async function listStandingPolicies(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<StandingPolicyList> {
  const input = standingPolicyListInput.parse(raw);
  return policyTransaction(db, async tx => {
    const actor = await context(tx, supplied, sessionHash, input.unitId);
    requireCondition((await tx.query("SELECT id FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3", [input.yearId, actor.org_id, input.unitId])).rows.length, 404, "School year not found.");
    const rows = (await tx.query("SELECT * FROM standing_policies WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND ($4::uuid IS NULL OR id<$4) ORDER BY id DESC LIMIT $5", [actor.org_id, input.unitId, input.yearId, input.beforeId ?? null, limits.page + 1])).rows;
    await recheckReportSession(tx, actor, sessionHash!);
    return { rows: rows.slice(0, limits.page).map(record), nextBeforeId: rows.length > limits.page ? rows[limits.page - 1].id : null };
  });
}
async function readPolicy<T>(db: Database, supplied: Actor, sessionHash: string | undefined, rawId: unknown, fn: (tx: Queryable, actor: Actor, row: Row) => Promise<T>) {
  const id = z.uuid().parse(rawId);
  return policyTransaction(db, async tx => {
    const scope = await scopeForPolicy(tx, supplied, id), actor = await context(tx, supplied, sessionHash, scope.unit_id);
    const row = (await tx.query("SELECT * FROM standing_policies WHERE org_id=$1 AND id=$2 FOR SHARE", [actor.org_id, id])).rows[0];
    requireCondition(row, 404, unavailable); const result = await fn(tx, actor, row);
    await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}
export async function standingPolicyDetail(db: Database, actor: Actor, hash: string | undefined, id: unknown): Promise<StandingPolicyDetail> {
  return readPolicy(db, actor, hash, id, async (tx, current, row) => ({ policy: record(row), confirmed: await confirmed(tx, current, row),
    allowedActions: { edit: !row.archived, confirm: !row.archived && ["developer", "owner"].includes(current.role), archive: !row.archived, restore: row.archived },
    catalogFreshness: "compare_with_current_catalog" }));
}
export async function standingPolicyHistory(db: Database, actor: Actor, hash: string | undefined, id: unknown, raw: unknown = {}): Promise<StandingPolicyHistoryPage> {
  const input = standingPolicyHistoryInput.parse(raw);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const rows = (await tx.query("SELECT * FROM standing_policy_history WHERE org_id=$1 AND policy_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4", [current.org_id, row.id, input.beforeVersion ?? null, limits.page + 1])).rows;
    return { rows: rows.slice(0, limits.page).map(r => ({ version: r.version, action: r.action, before: r.before_state, after: r.after_state, reason: r.reason, actor: { id: r.actor_id, name: r.actor_name }, createdAt: iso(r.created_at) })), nextBeforeVersion: rows.length > limits.page ? rows[limits.page - 1].version : null };
  });
}
export async function standingPolicyVersions(db: Database, actor: Actor, hash: string | undefined, id: unknown, raw: unknown = {}): Promise<StandingPolicyVersionsPage> {
  const input = standingPolicyHistoryInput.parse(raw);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const rows = (await tx.query("SELECT * FROM standing_policy_versions WHERE org_id=$1 AND policy_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4", [current.org_id, row.id, input.beforeVersion ?? null, limits.page + 1])).rows;
    return { rows: rows.slice(0, limits.page).map(version), nextBeforeVersion: rows.length > limits.page ? rows[limits.page - 1].version : null };
  });
}
export async function standingPolicyVersion(db: Database, actor: Actor, hash: string | undefined, id: unknown, rawVersionId: unknown): Promise<StandingPolicyVersion> {
  const versionId = z.uuid().parse(rawVersionId);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const found = (await tx.query("SELECT * FROM standing_policy_versions WHERE org_id=$1 AND policy_id=$2 AND id=$3", [current.org_id, row.id, versionId])).rows[0];
    requireCondition(found, 404, "Confirmed policy version not found."); return version(found);
  });
}

type Action = "create" | "update" | "confirm" | "archive";
export async function changeStandingPolicy(db: Database, supplied: Actor, sessionHash: string | undefined, action: Action, raw: unknown, rawId?: unknown): Promise<StandingPolicyMutationResult> {
  // Copy/normalize into a private validated command before locks or await points.
  const schemas = { create: standingPolicyCreateInput, update: standingPolicyUpdateInput, confirm: standingPolicyConfirmInput, archive: standingPolicyArchiveInput };
  requireCondition(Object.hasOwn(schemas, action), 400, "Unknown standing policy action.");
  const input = schemas[action].parse(raw), suppliedId = action === "create" ? null : z.uuid().parse(rawId);
  const fingerprint = digest(canonicalStandingJson({ action, id: suppliedId, input }));
  return policyTransaction(db, async tx => {
    const scope = action === "create" ? { unit_id: (input as z.infer<typeof standingPolicyCreateInput>).unitId, year_id: (input as z.infer<typeof standingPolicyCreateInput>).yearId } : await scopeForPolicy(tx, supplied, suppliedId!);
    const actor = await context(tx, supplied, sessionHash, scope.unit_id);
    if (action === "confirm") requireCondition(["developer", "owner"].includes(actor.role), 403, "Only the current organization owner may confirm a school policy.");
    if (action !== "archive") await settingsMutex(tx, scope.unit_id);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standing-command:" + actor.org_id + ":" + actor.id + ":" + input.commandId]);
    const previous = (await tx.query("SELECT fingerprint,result FROM standing_policy_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3", [actor.org_id, actor.id, input.commandId])).rows[0];
    if (previous) {
      requireCondition(previous.fingerprint === fingerprint, 409, "This command was already used for a different policy action.");
      await recheckReportSession(tx, actor, sessionHash!); return previous.result as StandingPolicyMutationResult;
    }
    const policyId = suppliedId ?? randomUUID();
    const old = suppliedId ? (await tx.query("SELECT * FROM standing_policies WHERE org_id=$1 AND id=$2 FOR UPDATE", [actor.org_id, policyId])).rows[0] : null;
    if (suppliedId) requireCondition(old && old.version === (input as { expectedVersion: number }).expectedVersion, 409, "This policy changed. Refresh and review the current version before continuing.");
    if (old && action !== "archive") requireCondition(!old.archived, 409, "Restore this policy before editing or confirming it.");
    const before = old ? record(old) : null;
    let createdConfirmation: StandingPolicyVersion | null = null;
    if (action === "create" || action === "update") {
      const value = input as z.infer<typeof standingPolicyCreateInput> | z.infer<typeof standingPolicyUpdateInput>;
      const catalog = await readCatalog(tx, actor, scope.unit_id, scope.year_id);
      requireCondition(value.catalogHash === catalog.catalogHash, 409, "The policy catalog changed. Reload it and review every selection before saving.");
      // The pure engine is the final configuration authority, with only actual server scope.
      standingPolicySchema.parse({ ...value.configuration, schemaVersion: 1, policyId, version: 1, orgId: actor.org_id, unitId: scope.unit_id, yearId: scope.year_id });
      const evidence = selectedEvidence(catalog, value.configuration), draftHash = configurationHash(value.configuration);
      if (action === "create") await tx.query(`INSERT INTO standing_policies(id,org_id,unit_id,year_id,version,configuration,draft_hash,catalog_hash,evidence,created_by,updated_by)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$9)`, [policyId, actor.org_id, scope.unit_id, scope.year_id, json(value.configuration), draftHash, catalog.catalogHash, json(evidence), actor.id]);
      else await tx.query("UPDATE standing_policies SET version=version+1,configuration=$3,draft_hash=$4,catalog_hash=$5,evidence=$6,updated_by=$7,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, json(value.configuration), draftHash, catalog.catalogHash, json(evidence), actor.id]);
    } else if (action === "confirm") {
      const value = input as z.infer<typeof standingPolicyConfirmInput>;
      requireCondition(value.draftHash === old!.draft_hash && value.catalogHash === old!.catalog_hash, 409, "Confirm the exact saved draft and catalog you reviewed.");
      const catalog = await readCatalog(tx, actor, scope.unit_id, scope.year_id);
      requireCondition(catalog.catalogHash === old!.catalog_hash, 409, "The policy catalog changed. Reload and save the reviewed draft before confirming.");
      selectedEvidence(catalog, old!.configuration); // Validate current existence; retain ORIGINAL evidence below.
      const policy = standingPolicySchema.parse({ ...old!.configuration, schemaVersion: 1, policyId, version: old!.confirmed_version + 1, orgId: actor.org_id, unitId: scope.unit_id, yearId: scope.year_id });
      const policyHash = standingPolicyEvidenceHash(policy), versionId = randomUUID();
      const inserted = (await tx.query(`INSERT INTO standing_policy_versions(id,org_id,policy_id,version,draft_version,policy_hash,configuration_hash,policy,evidence,source_description,reason,confirmed_by,confirmed_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [versionId, actor.org_id, policyId, policy.version, old!.version, policyHash, old!.draft_hash, json(policy), json(old!.evidence), value.sourceDescription, value.reason, actor.id, actor.name])).rows[0];
      createdConfirmation = version(inserted);
      await tx.query("UPDATE standing_policies SET version=version+1,active_policy_version_id=$3,confirmed_version=$4,confirmed_configuration_hash=draft_hash,updated_by=$5,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, versionId, policy.version, actor.id]);
    } else {
      const value = input as z.infer<typeof standingPolicyArchiveInput>;
      requireCondition(value.archived !== old!.archived, 409, value.archived ? "This policy is already archived." : "This policy is already active.");
      await tx.query("UPDATE standing_policies SET version=version+1,archived=$3,updated_by=$4,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, value.archived, actor.id]);
    }
    const row = (await tx.query("SELECT * FROM standing_policies WHERE org_id=$1 AND id=$2", [actor.org_id, policyId])).rows[0];
    const after = record(row), historyAction = action === "archive" ? (row.archived ? "archived" : "restored") : ({ create: "created", update: "updated", confirm: "confirmed" } as const)[action];
    await tx.query("INSERT INTO standing_policy_history(id,org_id,policy_id,version,action,before_state,after_state,reason,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [randomUUID(), actor.org_id, policyId, row.version, historyAction, before ? json(before) : null, json(after), input.reason, actor.id, actor.name]);
    const result: StandingPolicyMutationResult = { policy: after, confirmed: createdConfirmation ?? await confirmed(tx, actor, row) };
    await tx.query("INSERT INTO standing_policy_commands(org_id,actor_id,command_id,policy_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)", [actor.org_id, actor.id, input.commandId, policyId, fingerprint, json(result)]);
    await audit(tx, actor, "standing.policy." + historyAction, policyId, { unitId: row.unit_id, yearId: row.year_id, version: row.version, draftHash: row.draft_hash, catalogHash: row.catalog_hash, policyVersionId: row.active_policy_version_id });
    await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}

/** Root installs this only after source/test review; no app.ts side effect. */
export function installStandingPolicies(app: Express, db: Database) {
  const base = "/api/school/standing/policies";
  const send = (res: any, data: unknown) => res.set("Cache-Control", "private, no-store").json(data);
  app.get(base + "/catalog", async (req, res) => send(res, await standingPolicyCatalog(db, schoolActor(req), (req as AppRequest).sessionHash, req.query)));
  app.get(base, async (req, res) => send(res, await listStandingPolicies(db, schoolActor(req), (req as AppRequest).sessionHash, req.query)));
  app.get(base + "/:id/history", async (req, res) => send(res, await standingPolicyHistory(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.query)));
  app.get(base + "/:id/versions", async (req, res) => send(res, await standingPolicyVersions(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.query)));
  app.get(base + "/:id/versions/:versionId", async (req, res) => send(res, await standingPolicyVersion(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.params.versionId)));
  app.get(base + "/:id", async (req, res) => send(res, await standingPolicyDetail(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id)));
  app.post(base, async (req, res) => {
    const result = await changeStandingPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "create", req.body);
    send(res.status(201), result);
  });
  app.patch(base + "/:id", async (req, res) => send(res, await changeStandingPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "update", req.body, req.params.id)));
  app.post(base + "/:id/confirm", async (req, res) => send(res, await changeStandingPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "confirm", req.body, req.params.id)));
  app.post(base + "/:id/archive", async (req, res) => send(res, await changeStandingPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "archive", req.body, req.params.id)));
}

/** Transaction-only catalog reader. Caller must hold current school authority,
 * academics and the existing grading-settings mutex before calling. */
export { readCatalog as readStandingPolicyCatalog };
