import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Express } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, Problem, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { brandingSnapshotSchema, organizationBrandingSettingsSchema, organizationBrandingCurrentSchema,
  publishOrganizationBrandingSchema, organizationBrandingReceiptSchema, organizationBrandingHistoryRowSchema,
  brandingHistoryQuerySchema, organizationBrandingHistorySchema, unconfiguredBrandingSettings,
  type BrandingSnapshot, type OrganizationBrandingSettings, type OrganizationBrandingHistoryRow,
  type OrganizationBrandingReceipt } from "../shared/organization-branding";

const utc = (column: string) => `to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const emptyQuery = z.object({}).strict();
const capture = (actor: Actor): Actor => ({ ...actor, id: z.uuid().parse(actor.id).toLowerCase(), org_id: z.uuid().parse(actor.org_id).toLowerCase(), unit_ids: [...actor.unit_ids] });
function proof(hash: string | undefined): string {
  requireCondition(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), 401, "Your session has expired or changed. Sign in again."); return hash;
}
async function transaction<T>(db: Database, action: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'"); return action(tx);
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (["40001", "40P01"].includes(code ?? "") && attempt < 2) continue;
      if (["55P03", "57014", "40001", "40P01"].includes(code ?? "")) throw new Problem(503, "Organization appearance is busy. Retry the same request and command when available.");
      throw error;
    }
  }
}
/** JSON-only canonical encoding. Every public caller validates its strict schema first. */
export function canonicalBrandingJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalBrandingJson).join(",") + "]";
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype)
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalBrandingJson((value as Row)[key])).join(",") + "}";
  throw new Problem(422, "Organization appearance evidence contains unsupported data.");
}
export function brandingSettingsHash(settings: OrganizationBrandingSettings): string {
  const parsed = organizationBrandingSettingsSchema.parse(settings);
  return digest(canonicalBrandingJson({ schemaVersion: 1, kind: "organization_branding_settings", settings: parsed }));
}
function evidence(condition: unknown): asserts condition {
  requireCondition(condition, 422, "Retained organization appearance evidence is inconsistent.");
}
function checked<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw); evidence(result.success); return result.data;
}
function checkedSnapshot(raw: unknown): BrandingSnapshot {
  const snapshot = checked(brandingSnapshotSchema, raw); evidence(brandingSettingsHash(snapshot.settings) === snapshot.settingsHash); return snapshot;
}
function initial(): BrandingSnapshot {
  const settings = { ...unconfiguredBrandingSettings };
  return { schemaVersion: 1, configured: false, version: 0, settings, settingsHash: brandingSettingsHash(settings), updatedAt: null };
}
function checkedHistory(row: Row): OrganizationBrandingHistoryRow {
  const result = checked(organizationBrandingHistoryRowSchema, {
    id: row.id, commandId: row.command_id, version: row.version, before: checkedSnapshot(row.before_state), after: checkedSnapshot(row.after_state),
    reason: row.reason, actor: { id: row.actor_id, name: row.actor_name }, createdAt: row.created_text,
  });
  evidence(row.before_version === result.before.version && row.before_settings_hash === result.before.settingsHash
    && row.settings_hash === result.after.settingsHash && (result.version === 1 ? row.previous_history_id === null : typeof row.previous_history_id === "string"));
  return result;
}
async function historyRow(tx: Queryable, orgId: string, id: string): Promise<OrganizationBrandingHistoryRow> {
  const row = (await tx.query(`SELECT h.*,${utc("h.created_at")} AS created_text FROM organization_branding_history h WHERE h.org_id=$1 AND h.id=$2`, [orgId, id])).rows[0];
  evidence(row); return checkedHistory(row);
}
async function current(tx: Queryable, orgId: string, write = false): Promise<{ snapshot: BrandingSnapshot; historyId: string | null }> {
  const row = (await tx.query(`SELECT b.*,${utc("b.updated_at")} AS updated_text FROM organization_branding b WHERE b.org_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [orgId])).rows[0];
  if (!row) return { snapshot: initial(), historyId: null };
  const snapshot = checkedSnapshot({ schemaVersion: 1, configured: true, version: row.version, settings: row.settings, settingsHash: row.settings_hash, updatedAt: row.updated_text });
  const saved = await historyRow(tx, orgId, row.history_id);
  evidence(isDeepStrictEqual(snapshot, saved.after)); return { snapshot, historyId: row.history_id };
}
function requireOwner(actor: Actor) { requireCondition(["developer", "owner"].includes(actor.role), 403, "Only the current organization owner may publish or review organization appearance history."); }
async function receipt(tx: Queryable, actor: Actor, row: Row): Promise<OrganizationBrandingReceipt> {
  let decoded: unknown; try { decoded = JSON.parse(row.result_text); } catch { throw new Problem(422, "Retained organization appearance receipt is invalid."); }
  const result = checked(organizationBrandingReceiptSchema, decoded);
  evidence(canonicalBrandingJson(result) === row.result_text && digest(row.result_text) === row.result_hash
    && row.org_id === actor.org_id && row.actor_id === actor.id && result.commandId === row.command_id
    && result.historyId === row.history_id && result.snapshot.version === row.version && result.snapshot.settingsHash === row.settings_hash);
  checkedSnapshot(result.snapshot);
  const saved = await historyRow(tx, actor.org_id, result.historyId);
  evidence(saved.actor.id === actor.id && saved.commandId === result.commandId && isDeepStrictEqual(saved.after, result.snapshot)
    && saved.before.version === result.beforeVersion && row.created_text === saved.createdAt);
  return result;
}

export async function getOrganizationBranding(db: Database, suppliedActor: Actor, sessionHash: string | undefined) {
  const hash = proof(sessionHash), identity = capture(suppliedActor);
  return transaction(db, async tx => {
    const actor = await currentReportActor(tx, identity, hash), { snapshot } = await current(tx, actor.org_id);
    const owner = ["developer", "owner"].includes(actor.role), result = organizationBrandingCurrentSchema.parse({ ...snapshot, allowedActions: { publish: owner, history: owner } });
    JSON.stringify(result); await recheckReportSession(tx, actor, hash); return result;
  });
}
export async function publishOrganizationBranding(db: Database, suppliedActor: Actor, sessionHash: string | undefined, raw: unknown) {
  const hash = proof(sessionHash), identity = capture(suppliedActor), input = publishOrganizationBrandingSchema.parse(raw);
  const fingerprint = digest(canonicalBrandingJson({ schemaVersion: 1, kind: "organization_branding_command", input }));
  return transaction(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`organization-branding-command:${identity.org_id}:${identity.id}:${input.commandId}`]);
    const actor = await currentReportActor(tx, identity, hash); requireOwner(actor);
    const prior = (await tx.query(`SELECT c.*,${utc("c.created_at")} AS created_text FROM organization_branding_commands c WHERE c.org_id=$1 AND c.actor_id=$2 AND c.command_id=$3`, [actor.org_id, actor.id, input.commandId])).rows[0];
    if (prior) {
      requireCondition(prior.fingerprint === fingerprint, 409, "This command was already used for a different appearance change.");
      const result = await receipt(tx, actor, prior); JSON.stringify(result); await recheckReportSession(tx, actor, hash); return result;
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`organization-branding:${actor.org_id}`]);
    const before = await current(tx, actor.org_id, true);
    requireCondition(input.expectedVersion === before.snapshot.version, 409, "Organization appearance changed. Refresh and review the current version before publishing.");
    const settingsHash = brandingSettingsHash(input.settings);
    requireCondition(!before.snapshot.configured || settingsHash !== before.snapshot.settingsHash, 409, "These settings are already published. Change the draft before publishing another version.");
    const at = (await tx.query(`SELECT ${utc("clock_timestamp()")} AS at`)).rows[0].at;
    const after = brandingSnapshotSchema.parse({ schemaVersion: 1, configured: true, version: before.snapshot.version + 1, settings: input.settings, settingsHash, updatedAt: at });
    const id = randomUUID(), history = organizationBrandingHistoryRowSchema.parse({
      id, commandId: input.commandId, version: after.version, before: before.snapshot, after, reason: input.reason, actor: { id: actor.id, name: actor.name }, createdAt: at,
    });
    await tx.query(`INSERT INTO organization_branding_history(id,org_id,version,command_id,previous_history_id,before_version,before_settings_hash,before_state,after_state,settings_hash,reason,actor_id,actor_name,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, actor.org_id, after.version, input.commandId, before.historyId, before.snapshot.version,
      before.snapshot.settingsHash, JSON.stringify(history.before), JSON.stringify(history.after), settingsHash, input.reason, actor.id, actor.name, at]);
    if (before.historyId) await tx.query("UPDATE organization_branding SET version=$1,settings=$2,settings_hash=$3,history_id=$4,updated_at=$5 WHERE org_id=$6", [after.version, JSON.stringify(after.settings), settingsHash, id, at, actor.org_id]);
    else await tx.query("INSERT INTO organization_branding(org_id,version,settings,settings_hash,history_id,updated_at) VALUES($1,$2,$3,$4,$5,$6)", [actor.org_id, after.version, JSON.stringify(after.settings), settingsHash, id, at]);
    const result = organizationBrandingReceiptSchema.parse({ schemaVersion: 1, commandId: input.commandId, historyId: id, beforeVersion: before.snapshot.version, snapshot: after });
    const text = canonicalBrandingJson(result);
    await tx.query("INSERT INTO organization_branding_commands(org_id,actor_id,command_id,history_id,version,settings_hash,fingerprint,result_text,result_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [actor.org_id, actor.id, input.commandId, id, after.version, settingsHash, fingerprint, text, digest(text), at]);
    const changedFields = Object.keys(input.settings).filter(key => input.settings[key as keyof OrganizationBrandingSettings] !== before.snapshot.settings[key as keyof OrganizationBrandingSettings]);
    await audit(tx, actor, "organization.branding_published", actor.org_id, { commandId: input.commandId, version: after.version, settingsHash, changedFields });
    JSON.stringify(result); await recheckReportSession(tx, actor, hash); return result;
  });
}
export async function listOrganizationBrandingHistory(db: Database, suppliedActor: Actor, sessionHash: string | undefined, rawQuery: unknown) {
  const hash = proof(sessionHash), identity = capture(suppliedActor), input = brandingHistoryQuerySchema.parse(rawQuery);
  return transaction(db, async tx => {
    const actor = await currentReportActor(tx, identity, hash); requireOwner(actor);
    const { snapshot } = await current(tx, actor.org_id);
    const rows = snapshot.configured ? (await tx.query(`SELECT h.*,${utc("h.created_at")} AS created_text FROM organization_branding_history h
      WHERE h.org_id=$1 AND ($2::integer IS NULL OR h.version<$2) ORDER BY h.version DESC LIMIT $3`, [actor.org_id, input.beforeVersion ?? null, input.limit + 1])).rows : [];
    const selected = rows.slice(0, input.limit).map(checkedHistory);
    const result = organizationBrandingHistorySchema.parse({ rows: selected, currentVersion: snapshot.version, nextBeforeVersion: rows.length > input.limit ? selected.at(-1)!.version : null });
    JSON.stringify(result); await recheckReportSession(tx, actor, hash); return result;
  });
}
export function installOrganizationBranding(app: Express, db: Database) {
  app.get("/api/organization/branding", async (req, res) => {
    emptyQuery.parse(req.query); const request = req as AppRequest;
    const result = await getOrganizationBranding(db, request.actor!, request.sessionHash); res.set("Cache-Control", "private, no-store").json(result);
  });
  app.post("/api/organization/branding", async (req, res) => {
    emptyQuery.parse(req.query); const request = req as AppRequest;
    const result = await publishOrganizationBranding(db, request.actor!, request.sessionHash, req.body); res.set("Cache-Control", "private, no-store").json(result);
  });
  app.get("/api/organization/branding/history", async (req, res) => {
    const request = req as AppRequest;
    const result = await listOrganizationBrandingHistory(db, request.actor!, request.sessionHash, req.query); res.set("Cache-Control", "private, no-store").json(result);
  });
}
