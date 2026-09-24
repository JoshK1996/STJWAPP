import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { audit, digest, requireCondition, Problem, type Actor } from "./security";
import { schoolActor } from "./school";
import { lockAcademics } from "./timetable-engine";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import { termGpaPolicySchema, termGpaCalculatorVersion, type TermGpaConfiguration } from "../shared/term-gpa";
import {
  gpaPolicyScopeInput, gpaPolicyListInput, gpaPolicyHistoryInput,
  gpaPolicyCreateInput, gpaPolicyUpdateInput, gpaPolicyConfirmInput, gpaPolicyArchiveInput,
  gpaPolicyLimits as limits, gpaPolicyHashAlgorithm,
  gpaPolicyCatalogSchema, gpaPolicyRecordSchema, gpaPolicyVersionSchema, gpaPolicyMutationResultSchema,
  gpaPolicyHistoryPageSchema, gpaPolicyVersionsPageSchema,
  type GpaPolicyCatalog, type GpaPolicyEvidence, type GpaPolicyRecord, type GpaPolicyVersion,
  type GpaPolicyDetail, type GpaPolicyMutationResult, type GpaPolicyList, type GpaPolicyHistoryPage, type GpaPolicyVersionsPage,
} from "../shared/gpa-policies";
import { canonicalStandingJson, gradingPolicyEvidenceHash } from "./standing-policy-provenance";
import { readStandingPolicyCatalog } from "./standing-policies";

/** Hash parsed, explicit configuration without changing captured text. */
export function gpaPolicyEvidenceHash(policy: unknown): string {
  termGpaPolicySchema.parse(policy);
  return digest(canonicalStandingJson({ schemaVersion: 1, kind: "term_gpa_policy", policy }));
}
async function readCatalog(tx: Queryable, actor: Actor, unitId: string, yearId: string): Promise<GpaPolicyCatalog> {
  return gpaPolicyCatalogSchema.parse(await readStandingPolicyCatalog(tx, actor, unitId, yearId));
}

const iso = (value: any): string => new Date(value).toISOString();
const json = (value: unknown) => JSON.stringify(value);
const configurationHash = (configuration: TermGpaConfiguration) => digest(canonicalStandingJson({ schemaVersion: 1, kind: "term_gpa_configuration", configuration }));
const unavailable = "GPA policy not found under your current school access.";

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
  const row = (await tx.query("SELECT unit_id,year_id FROM gpa_policies WHERE org_id=$1 AND id=$2", [actor.org_id, policyId])).rows[0];
  requireCondition(row, 404, unavailable); return row;
}
function record(row: Row): GpaPolicyRecord {
  const value = gpaPolicyRecordSchema.parse({ id: row.id, orgId: row.org_id, unitId: row.unit_id, yearId: row.year_id, version: row.version,
    archived: row.archived, configuration: row.configuration, draftHash: row.draft_hash, catalogHash: row.catalog_hash, evidence: row.evidence,
    activePolicyVersionId: row.active_policy_version_id, confirmedVersion: row.confirmed_version,
    hasUnconfirmedChanges: row.confirmed_configuration_hash !== row.draft_hash, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  checkRecord(value); return value;
}
function version(row: Row): GpaPolicyVersion {
  const value = gpaPolicyVersionSchema.parse({ policyVersionId: row.id, policyId: row.policy_id, version: row.version, draftVersion: row.draft_version,
    policyHash: row.policy_hash, configurationHash: row.configuration_hash, policy: row.policy, evidence: row.evidence,
    sourceDescription: row.source_description, reason: row.reason, confirmedBy: { id: row.confirmed_by, name: row.confirmed_name }, confirmedAt: iso(row.confirmed_at) });
  checkVersion(value);
  requireCondition(value.policy.orgId === row.org_id && value.policy.unitId === row.unit_id && value.policy.yearId === row.year_id, 422, "Stored GPA confirmation scope is inconsistent.");
  return value;
}
async function confirmed(tx: Queryable, actor: Actor, row: Row): Promise<GpaPolicyVersion | null> {
  if (!row.active_policy_version_id) return null;
  const found = (await tx.query("SELECT * FROM gpa_policy_versions WHERE org_id=$1 AND policy_id=$2 AND id=$3", [actor.org_id, row.id, row.active_policy_version_id])).rows[0];
  requireCondition(found, 409, "The policy confirmation evidence is unavailable."); return version(found);
}
function selectedEvidence(catalog: GpaPolicyCatalog, config: TermGpaConfiguration): GpaPolicyEvidence {
  const terms = catalog.terms.filter(r => config.termIds.includes(r.id));
  const courses = catalog.courses.filter(r => config.courseRules.some(rule => rule.courseId === r.id));
  requireCondition(terms.length === config.termIds.length && courses.length === config.courseRules.length, 422, "Every selected term and course must belong to the exact school unit/year catalog.");
  const gradingPolicies = config.acceptedGradingPolicies.map(ref => {
    const entry = catalog.gradingPolicies.find(r => r.hash === ref.hash && r.version === ref.version);
    requireCondition(entry, 422, "Every accepted grading policy hash/version must exist in the current verified catalog.");
    const actualLabels = entry.policy.scale.map(s => s.label), configuredLabels = ref.labelRules.map(rule => rule.label);
    requireCondition(actualLabels.length > 0 && actualLabels.length === configuredLabels.length && new Set(actualLabels).size === actualLabels.length &&
      actualLabels.every(label => configuredLabels.includes(label)), 422, "Map every exact captured grading-scale label once, using points or an explicit unsupported reason.");
    return entry;
  });
  return { schemaVersion: 1, hashAlgorithm: gpaPolicyHashAlgorithm, catalogHash: catalog.catalogHash, unit: catalog.unit, year: catalog.year, terms, courses, gradingPolicies };
}
function checkEvidence(configuration: TermGpaConfiguration, evidence: GpaPolicyEvidence, unitId: string, yearId: string) {
  requireCondition(evidence.unit.id === unitId && evidence.year.id === yearId, 422, "Stored GPA catalog scope is inconsistent.");
  const selected = selectedEvidence({ ...evidence, gradeLevels: { source: "explicit_configuration_required", values: [] } }, configuration);
  requireCondition(canonicalStandingJson(selected) === canonicalStandingJson(evidence), 422, "Stored GPA evidence must contain exactly the reviewed selections.");
  for (const ref of evidence.gradingPolicies)
    requireCondition(gradingPolicyEvidenceHash(ref.policy) === ref.hash, 422, "Stored GPA grading evidence does not match its hash.");
}
function checkRecord(value: GpaPolicyRecord) {
  requireCondition(value.draftHash === configurationHash(value.configuration) && value.catalogHash === value.evidence.catalogHash &&
    (value.activePolicyVersionId === null) === (value.confirmedVersion === 0), 422, "Stored GPA draft evidence is inconsistent.");
  checkEvidence(value.configuration, value.evidence, value.unitId, value.yearId);
}
function checkVersion(value: GpaPolicyVersion) {
  const { schemaVersion: _s, calculatorVersion: _c, policyId: _id, version: _v, orgId: _o, unitId: _u, yearId: _y, ...configuration } = value.policy;
  requireCondition(value.policy.policyId === value.policyId && value.policy.version === value.version && value.policyHash === gpaPolicyEvidenceHash(value.policy) &&
    value.configurationHash === configurationHash(configuration), 422, "Stored GPA confirmation hashes or identities are inconsistent.");
  checkEvidence(configuration, value.evidence, value.policy.unitId, value.policy.yearId);
}
function checkedResult(raw: unknown, orgId: string, unitId: string, yearId: string): GpaPolicyMutationResult {
  const value = gpaPolicyMutationResultSchema.parse(raw); checkRecord(value.policy);
  requireCondition(value.policy.orgId === orgId && value.policy.unitId === unitId && value.policy.yearId === yearId, 422, "Stored GPA receipt scope is inconsistent.");
  requireCondition((value.confirmed === null) === (value.policy.activePolicyVersionId === null), 422, "Stored GPA receipt confirmation is inconsistent.");
  if (value.confirmed) {
    checkVersion(value.confirmed);
    requireCondition(value.confirmed.policyId === value.policy.id && value.confirmed.policyVersionId === value.policy.activePolicyVersionId && value.confirmed.version === value.policy.confirmedVersion &&
      value.confirmed.policy.orgId === orgId && value.confirmed.policy.unitId === unitId && value.confirmed.policy.yearId === yearId &&
      value.policy.hasUnconfirmedChanges === (value.policy.draftHash !== value.confirmed.configurationHash), 422, "Stored GPA receipt confirmation does not match its policy.");
  }
  return value;
}
export async function gpaPolicyCatalog(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const input = gpaPolicyScopeInput.parse(raw);
  return policyTransaction(db, async tx => {
    const actor = await context(tx, supplied, sessionHash, input.unitId); await settingsMutex(tx, input.unitId);
    const result = await readCatalog(tx, actor, input.unitId, input.yearId); await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}
export async function listGpaPolicies(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<GpaPolicyList> {
  const input = gpaPolicyListInput.parse(raw);
  return policyTransaction(db, async tx => {
    const actor = await context(tx, supplied, sessionHash, input.unitId);
    requireCondition((await tx.query("SELECT id FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3", [input.yearId, actor.org_id, input.unitId])).rows.length, 404, "School year not found.");
    const rows = (await tx.query("SELECT * FROM gpa_policies WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND ($4::uuid IS NULL OR id<$4) ORDER BY id DESC LIMIT $5", [actor.org_id, input.unitId, input.yearId, input.beforeId ?? null, limits.page + 1])).rows;
    await recheckReportSession(tx, actor, sessionHash!);
    return { rows: rows.slice(0, limits.page).map(record), nextBeforeId: rows.length > limits.page ? rows[limits.page - 1].id : null };
  });
}
async function readPolicy<T>(db: Database, supplied: Actor, sessionHash: string | undefined, rawId: unknown, fn: (tx: Queryable, actor: Actor, row: Row) => Promise<T>) {
  const id = z.uuid().parse(rawId);
  return policyTransaction(db, async tx => {
    const scope = await scopeForPolicy(tx, supplied, id), actor = await context(tx, supplied, sessionHash, scope.unit_id);
    const row = (await tx.query("SELECT * FROM gpa_policies WHERE org_id=$1 AND id=$2 FOR SHARE", [actor.org_id, id])).rows[0];
    requireCondition(row, 404, unavailable); const result = await fn(tx, actor, row);
    await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}
export async function gpaPolicyDetail(db: Database, actor: Actor, hash: string | undefined, id: unknown): Promise<GpaPolicyDetail> {
  return readPolicy(db, actor, hash, id, async (tx, current, row) => ({ policy: record(row), confirmed: await confirmed(tx, current, row),
    allowedActions: { edit: !row.archived, confirm: !row.archived && ["developer", "owner"].includes(current.role), archive: !row.archived, restore: row.archived },
    catalogFreshness: "compare_with_current_catalog" }));
}
export async function gpaPolicyHistory(db: Database, actor: Actor, hash: string | undefined, id: unknown, raw: unknown = {}): Promise<GpaPolicyHistoryPage> {
  const input = gpaPolicyHistoryInput.parse(raw);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const rows = (await tx.query("SELECT * FROM gpa_policy_history WHERE org_id=$1 AND policy_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4", [current.org_id, row.id, input.beforeVersion ?? null, limits.page + 1])).rows;
    const result = gpaPolicyHistoryPageSchema.parse({ rows: rows.slice(0, limits.page).map(r => ({ version: r.version, action: r.action, before: r.before_state, after: r.after_state, reason: r.reason, actor: { id: r.actor_id, name: r.actor_name }, createdAt: iso(r.created_at) })), nextBeforeVersion: rows.length > limits.page ? rows[limits.page - 1].version : null });
    for (const item of result.rows) { if (item.before) checkRecord(item.before); checkRecord(item.after); }
    return result;
  });
}
export async function gpaPolicyVersions(db: Database, actor: Actor, hash: string | undefined, id: unknown, raw: unknown = {}): Promise<GpaPolicyVersionsPage> {
  const input = gpaPolicyHistoryInput.parse(raw);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const rows = (await tx.query("SELECT * FROM gpa_policy_versions WHERE org_id=$1 AND policy_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4", [current.org_id, row.id, input.beforeVersion ?? null, limits.page + 1])).rows;
    return gpaPolicyVersionsPageSchema.parse({ rows: rows.slice(0, limits.page).map(version), nextBeforeVersion: rows.length > limits.page ? rows[limits.page - 1].version : null });
  });
}
export async function gpaPolicyVersion(db: Database, actor: Actor, hash: string | undefined, id: unknown, rawVersionId: unknown): Promise<GpaPolicyVersion> {
  const versionId = z.uuid().parse(rawVersionId);
  return readPolicy(db, actor, hash, id, async (tx, current, row) => {
    const found = (await tx.query("SELECT * FROM gpa_policy_versions WHERE org_id=$1 AND policy_id=$2 AND id=$3", [current.org_id, row.id, versionId])).rows[0];
    requireCondition(found, 404, "Confirmed policy version not found."); return version(found);
  });
}

type Action = "create" | "update" | "confirm" | "archive";
export async function changeGpaPolicy(db: Database, supplied: Actor, sessionHash: string | undefined, action: Action, raw: unknown, rawId?: unknown): Promise<GpaPolicyMutationResult> {
  // Copy/normalize into a private validated command before locks or await points.
  const schemas = { create: gpaPolicyCreateInput, update: gpaPolicyUpdateInput, confirm: gpaPolicyConfirmInput, archive: gpaPolicyArchiveInput };
  requireCondition(Object.hasOwn(schemas, action), 400, "Unknown gpa policy action.");
  const input = schemas[action].parse(raw), suppliedId = action === "create" ? null : z.uuid().parse(rawId);
  const fingerprint = digest(canonicalStandingJson({ action, id: suppliedId, input }));
  return policyTransaction(db, async tx => {
    const scope = action === "create" ? { unit_id: (input as z.infer<typeof gpaPolicyCreateInput>).unitId, year_id: (input as z.infer<typeof gpaPolicyCreateInput>).yearId } : await scopeForPolicy(tx, supplied, suppliedId!);
    const actor = await context(tx, supplied, sessionHash, scope.unit_id);
    if (action === "confirm") requireCondition(["developer", "owner"].includes(actor.role), 403, "Only the current organization owner may confirm a school policy.");
    if (action !== "archive") await settingsMutex(tx, scope.unit_id);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["gpa-command:" + actor.org_id + ":" + actor.id + ":" + input.commandId]);
    const previous = (await tx.query("SELECT fingerprint,result FROM gpa_policy_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3", [actor.org_id, actor.id, input.commandId])).rows[0];
    if (previous) {
      requireCondition(previous.fingerprint === fingerprint, 409, "This command was already used for a different policy action.");
      const result = checkedResult(previous.result, actor.org_id, scope.unit_id, scope.year_id);
      await recheckReportSession(tx, actor, sessionHash!); return result;
    }
    const policyId = suppliedId ?? randomUUID();
    const old = suppliedId ? (await tx.query("SELECT * FROM gpa_policies WHERE org_id=$1 AND id=$2 FOR UPDATE", [actor.org_id, policyId])).rows[0] : null;
    if (suppliedId) requireCondition(old && old.version === (input as { expectedVersion: number }).expectedVersion, 409, "This policy changed. Refresh and review the current version before continuing.");
    if (old && action !== "archive") requireCondition(!old.archived, 409, "Restore this policy before editing or confirming it.");
    const before = old ? record(old) : null;
    let createdConfirmation: GpaPolicyVersion | null = null;
    if (action === "create" || action === "update") {
      const value = input as z.infer<typeof gpaPolicyCreateInput> | z.infer<typeof gpaPolicyUpdateInput>;
      const catalog = await readCatalog(tx, actor, scope.unit_id, scope.year_id);
      requireCondition(value.catalogHash === catalog.catalogHash, 409, "The policy catalog changed. Reload it and review every selection before saving.");
      // The pure engine is the final configuration authority, with only actual server scope.
      termGpaPolicySchema.parse({ ...value.configuration, schemaVersion: 1, calculatorVersion: termGpaCalculatorVersion, policyId, version: 1, orgId: actor.org_id, unitId: scope.unit_id, yearId: scope.year_id });
      const evidence = selectedEvidence(catalog, value.configuration), draftHash = configurationHash(value.configuration);
      if (action === "create") await tx.query(`INSERT INTO gpa_policies(id,org_id,unit_id,year_id,version,configuration,draft_hash,catalog_hash,evidence,created_by,updated_by)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$9)`, [policyId, actor.org_id, scope.unit_id, scope.year_id, json(value.configuration), draftHash, catalog.catalogHash, json(evidence), actor.id]);
      else await tx.query("UPDATE gpa_policies SET version=version+1,configuration=$3,draft_hash=$4,catalog_hash=$5,evidence=$6,updated_by=$7,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, json(value.configuration), draftHash, catalog.catalogHash, json(evidence), actor.id]);
    } else if (action === "confirm") {
      const value = input as z.infer<typeof gpaPolicyConfirmInput>;
      requireCondition(value.draftHash === old!.draft_hash && value.catalogHash === old!.catalog_hash, 409, "Confirm the exact saved draft and catalog you reviewed.");
      const catalog = await readCatalog(tx, actor, scope.unit_id, scope.year_id);
      requireCondition(catalog.catalogHash === old!.catalog_hash, 409, "The policy catalog changed. Reload and save the reviewed draft before confirming.");
      selectedEvidence(catalog, old!.configuration); // Validate current existence; retain ORIGINAL evidence below.
      const policy = termGpaPolicySchema.parse({ ...old!.configuration, schemaVersion: 1, calculatorVersion: termGpaCalculatorVersion, policyId, version: old!.confirmed_version + 1, orgId: actor.org_id, unitId: scope.unit_id, yearId: scope.year_id });
      const policyHash = gpaPolicyEvidenceHash(policy), versionId = randomUUID();
      const inserted = (await tx.query(`INSERT INTO gpa_policy_versions(id,org_id,policy_id,version,draft_version,policy_hash,configuration_hash,policy,evidence,source_description,reason,confirmed_by,confirmed_name,unit_id,year_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [versionId, actor.org_id, policyId, policy.version, old!.version, policyHash, old!.draft_hash, json(policy), json(old!.evidence), value.sourceDescription, value.reason, actor.id, actor.name, scope.unit_id, scope.year_id])).rows[0];
      createdConfirmation = version(inserted);
      await tx.query("UPDATE gpa_policies SET version=version+1,active_policy_version_id=$3,confirmed_version=$4,confirmed_configuration_hash=draft_hash,updated_by=$5,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, versionId, policy.version, actor.id]);
    } else {
      const value = input as z.infer<typeof gpaPolicyArchiveInput>;
      requireCondition(value.archived !== old!.archived, 409, value.archived ? "This policy is already archived." : "This policy is already active.");
      await tx.query("UPDATE gpa_policies SET version=version+1,archived=$3,updated_by=$4,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2", [actor.org_id, policyId, value.archived, actor.id]);
    }
    const row = (await tx.query("SELECT * FROM gpa_policies WHERE org_id=$1 AND id=$2", [actor.org_id, policyId])).rows[0];
    const after = record(row), historyAction = action === "archive" ? (row.archived ? "archived" : "restored") : ({ create: "created", update: "updated", confirm: "confirmed" } as const)[action];
    await tx.query("INSERT INTO gpa_policy_history(id,org_id,policy_id,version,action,before_state,after_state,reason,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [randomUUID(), actor.org_id, policyId, row.version, historyAction, before ? json(before) : null, json(after), input.reason, actor.id, actor.name]);
    const result = checkedResult({ policy: after, confirmed: createdConfirmation ?? await confirmed(tx, actor, row) }, actor.org_id, scope.unit_id, scope.year_id);
    await tx.query("INSERT INTO gpa_policy_commands(org_id,actor_id,command_id,policy_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)", [actor.org_id, actor.id, input.commandId, policyId, fingerprint, json(result)]);
    await audit(tx, actor, "gpa.policy." + historyAction, policyId, { unitId: row.unit_id, yearId: row.year_id, version: row.version, draftHash: row.draft_hash, catalogHash: row.catalog_hash, policyVersionId: row.active_policy_version_id });
    await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}

/** Root installs this only after source/test review; no app.ts side effect. */
export function installGpaPolicies(app: Express, db: Database) {
  const base = "/api/school/gpa/policies";
  const send = (res: any, data: unknown) => res.set("Cache-Control", "private, no-store").json(data);
  app.get(base + "/catalog", async (req, res) => send(res, await gpaPolicyCatalog(db, schoolActor(req), (req as AppRequest).sessionHash, req.query)));
  app.get(base, async (req, res) => send(res, await listGpaPolicies(db, schoolActor(req), (req as AppRequest).sessionHash, req.query)));
  app.get(base + "/:id/history", async (req, res) => send(res, await gpaPolicyHistory(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.query)));
  app.get(base + "/:id/versions", async (req, res) => send(res, await gpaPolicyVersions(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.query)));
  app.get(base + "/:id/versions/:versionId", async (req, res) => send(res, await gpaPolicyVersion(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id, req.params.versionId)));
  app.get(base + "/:id", async (req, res) => send(res, await gpaPolicyDetail(db, schoolActor(req), (req as AppRequest).sessionHash, req.params.id)));
  app.post(base, async (req, res) => {
    const result = await changeGpaPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "create", req.body);
    send(res.status(201), result);
  });
  app.patch(base + "/:id", async (req, res) => send(res, await changeGpaPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "update", req.body, req.params.id)));
  app.post(base + "/:id/confirm", async (req, res) => send(res, await changeGpaPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "confirm", req.body, req.params.id)));
  app.post(base + "/:id/archive", async (req, res) => send(res, await changeGpaPolicy(db, schoolActor(req), (req as AppRequest).sessionHash, "archive", req.body, req.params.id)));
}

/** Pure stored-evidence checks only. Callers must establish their own current
 * authority and transaction locks; none of these exports authorizes a read. */
export { version as decodeGpaPolicyVersionEvidence, checkEvidence as validateGpaPolicyEvidence, checkVersion as validateGpaPolicyVersionEvidence };
