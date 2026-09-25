import { z } from "zod";
import type { Database, Queryable } from "./db";
import { requireCondition, Problem, type Actor } from "./security";
import type { loadReportSource } from "./report-library";
import { reportDefinition } from "../shared/report-library";
import { snapshotLimits as limits } from "../shared/report-snapshots";

const ids = z.array(z.uuid()).max(limits.rows);
export const manifestSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("workforce"), mode: z.enum(["self", "unit", "assigned", "organization"]), unitIds: ids,
    records: z.array(z.object({ id: z.uuid(), shiftId: z.uuid(), revision: z.number().int().positive(), userId: z.uuid(), jobId: z.uuid(), unitId: z.uuid() }).strict()).max(limits.rows) }).strict(),
  z.object({ source: z.literal("care"), unitId: z.uuid(), programId: z.uuid(), sessionIds: ids }).strict(),
  z.object({ source: z.literal("grades"), unitId: z.uuid(), bookId: z.uuid(), sectionId: z.uuid(), termId: z.uuid(), bookVersion: z.number().int().positive(), sourceHash: z.string().length(64) }).strict(),
  z.object({ source: z.literal("attendance"), unitId: z.uuid(), yearId: z.uuid(), sectionIds: ids, sessions: z.array(z.object({ id: z.uuid(), version: z.number().int().positive() }).strict()).max(limits.rows) }).strict(),
  z.object({ source: z.literal("finance"), unitId: z.uuid(), reportId: z.uuid(), version: z.number().int().positive() }).strict(),
  z.object({ source: z.literal("compensation"), unitIds: ids, records: z.array(z.object({ id: z.uuid(), version: z.number().int().positive(), userId: z.uuid(), jobId: z.uuid(), unitId: z.uuid(), rateId: z.uuid() }).strict()).max(5000) }).strict(),
]);
export type Manifest = z.infer<typeof manifestSchema>;
const unavailable = () => new Problem(404, "This saved report result is unavailable under your current access.");
const allowed = (condition: unknown) => { if (!condition) throw unavailable(); };
const unique = (values: string[]) => [...new Set(values)].sort();
export async function lockReportExtraction(tx: Queryable, actor: Actor) {
  const row = (await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('report-source-extraction:'||$1||':'||$2,0)) AS acquired", [actor.org_id, actor.id])).rows[0];
  requireCondition(row.acquired, 429, "Another report is being prepared for this account. Try again after it finishes.");
}
export async function reportTransaction<T>(db: Database, action: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(action); }
    catch (error: any) { if (!["40001", "40P01"].includes(error.code) || attempt >= 2) throw error; }
  }
}
export async function recheckReportSession(tx: Queryable, actor: Actor, hash: string) {
  requireCondition((await tx.query(`SELECT s.token_hash FROM sessions s WHERE s.token_hash=$1 AND s.org_id=$2 AND s.user_id=$3
    AND s.mode='password' AND s.expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.org_id=s.org_id AND u.active=true AND u.requires_credential_change=false)
    AND (s.mfa_verified OR NOT EXISTS(SELECT 1 FROM mfa_factors f WHERE f.user_id=s.user_id AND f.enabled_at IS NOT NULL)) FOR SHARE OF s`, [hash, actor.org_id, actor.id])).rows.length, 401, "Your session has expired or changed. Sign in again.");
}
export async function currentReportActor(tx: Queryable, actor: Actor, sessionHash: string | undefined, write = false): Promise<Actor> {
  requireCondition(actor.mode === "password", 403, "Password sign-in is required for reports.");
  const row = (await tx.query(`SELECT id,org_id,name,email,role,active FROM users WHERE id=$1 AND org_id=$2 FOR ${write ? "UPDATE" : "SHARE"}`, [actor.id, actor.org_id])).rows[0];
  requireCondition(row?.active, 403, "This account is inactive or unavailable.");
  const credentials = (await tx.query("SELECT requires_credential_change FROM users WHERE id=$1 AND org_id=$2", [actor.id, actor.org_id])).rows[0];
  requireCondition(credentials && !credentials.requires_credential_change, 403, "Complete the required credential changes before opening the workspace.");
  if (sessionHash) await recheckReportSession(tx, actor, sessionHash);
  const units = (await tx.query("SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id FOR SHARE", [actor.org_id, actor.id])).rows.map(r => r.unit_id);
  return { ...actor, ...row, mode: "password", unit_ids: units };
}
async function office(tx: Queryable, actor: Actor, unitId: string) {
  if (["developer", "owner", "admin"].includes(actor.role)) return true;
  if (!actor.unit_ids.includes(unitId)) return false;
  return (await tx.query("SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE", [actor.org_id, actor.id, unitId])).rows.length > 0;
}
async function classes(tx: Queryable, actor: Actor, unitId: string, classIds: string[], yearId?: string) {
  const found = (await tx.query("SELECT id FROM sections WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) AND ($4::uuid IS NULL OR year_id=$4)", [actor.org_id, unitId, classIds, yearId ?? null])).rows;
  allowed(found.length === classIds.length);
  if (await office(tx, actor, unitId)) return;
  allowed(actor.unit_ids.includes(unitId) && classIds.length > 0);
  // No section/book row lock follows these grant locks. Academic writers lock
  // sections before replacing teachers; taking section locks here would invert it.
  const grants = (await tx.query("SELECT section_id FROM section_teachers WHERE org_id=$1 AND user_id=$2 AND section_id=ANY($3::uuid[]) ORDER BY section_id FOR SHARE", [actor.org_id, actor.id, classIds])).rows;
  allowed(grants.length === classIds.length);
}
export async function authorizeReportManifest(tx: Queryable, actor: Actor, m: Manifest) {
  const unitIds = "unitIds" in m ? m.unitIds : [m.unitId];
  allowed((await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[])", [actor.org_id, unitIds])).rows.length === unitIds.length);
  if (m.source === "workforce") {
    const wide = ["developer", "owner", "admin", "finance"].includes(actor.role), manager = actor.role === "manager";
    if (m.mode === "organization") allowed(wide);
    if (m.mode !== "self") allowed(wide || (manager && m.unitIds.every(id => actor.unit_ids.includes(id))));
    const rows = (await tx.query(`SELECT s.id,s.shift_id,s.revision,h.user_id,j.id AS job_id,j.unit_id FROM segments s
      JOIN shifts h ON h.id=s.shift_id AND h.org_id=s.org_id JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id
      WHERE s.org_id=$1 AND s.id=ANY($2::uuid[])`, [actor.org_id, m.records.map(r => r.id)])).rows;
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const ref of m.records) { const row = byId.get(ref.id); allowed(row && row.shift_id === ref.shiftId && row.revision === ref.revision && row.user_id === ref.userId && row.job_id === ref.jobId && row.unit_id === ref.unitId); allowed(wide || ref.userId === actor.id || (manager && actor.unit_ids.includes(ref.unitId))); }
  } else if (m.source === "care") {
    allowed(await office(tx, actor, m.unitId));
    allowed((await tx.query("SELECT id FROM care_programs WHERE id=$1 AND org_id=$2 AND unit_id=$3", [m.programId, actor.org_id, m.unitId])).rows.length);
    allowed((await tx.query("SELECT id FROM care_sessions WHERE org_id=$1 AND program_id=$2 AND id=ANY($3::uuid[])", [actor.org_id, m.programId, m.sessionIds])).rows.length === m.sessionIds.length);
  } else if (m.source === "grades") {
    allowed((await tx.query("SELECT id FROM gradebooks WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND section_id=$4 AND term_id=$5", [m.bookId, actor.org_id, m.unitId, m.sectionId, m.termId])).rows.length);
    allowed((await tx.query("SELECT id FROM school_terms WHERE id=$1 AND org_id=$2 AND unit_id=$3", [m.termId, actor.org_id, m.unitId])).rows.length);
    await classes(tx, actor, m.unitId, [m.sectionId]);
  } else if (m.source === "attendance") {
    allowed((await tx.query("SELECT id FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3", [m.yearId, actor.org_id, m.unitId])).rows.length);
    await classes(tx, actor, m.unitId, m.sectionIds, m.yearId);
    const found = (await tx.query(`SELECT r.session_id AS id,r.version FROM jsonb_to_recordset($1::jsonb) x(id uuid,version integer)
      JOIN attendance_revisions r ON r.session_id=x.id AND r.version=x.version
      JOIN attendance_sessions s ON s.id=r.session_id WHERE s.org_id=$2 AND s.unit_id=$3 AND s.year_id=$4 AND s.section_id=ANY($5::uuid[])`, [JSON.stringify(m.sessions), actor.org_id, m.unitId, m.yearId, m.sectionIds])).rows;
    allowed(found.length === m.sessions.length);
  } else if (m.source === "finance") {
    allowed(["developer", "owner", "admin", "finance"].includes(actor.role));
    allowed((await tx.query("SELECT r.id FROM financial_reports r JOIN financial_report_versions v ON v.report_id=r.id AND v.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2 AND r.unit_id=$3 AND v.version=$4", [m.reportId, actor.org_id, m.unitId, m.version])).rows.length);
  } else {
    allowed(["developer", "owner", "admin", "finance"].includes(actor.role));
    const found = (await tx.query(`SELECT x.id,x.version,x."rateId" FROM jsonb_to_recordset($1::jsonb) x(id uuid,version integer,"userId" uuid,"jobId" uuid,"unitId" uuid,"rateId" uuid)
      JOIN compensation_schedules c ON c.id=x.id AND c.user_id=x."userId" AND c.job_id=x."jobId"
      JOIN jobs j ON j.id=c.job_id AND j.org_id=c.org_id AND j.unit_id=x."unitId"
      WHERE c.org_id=$2 AND (c.version=x.version OR EXISTS(SELECT 1 FROM compensation_history h WHERE h.schedule_id=c.id AND h.org_id=c.org_id AND h.version=x.version))`, [JSON.stringify(m.records), actor.org_id])).rows;
    allowed(found.length === m.records.length);
  }
}
export async function buildReportManifest(tx: Queryable, actor: Actor, def: z.infer<typeof reportDefinition>, source: Awaited<ReturnType<typeof loadReportSource>>): Promise<Manifest> {
  const rows = source.rows, c = source.context;
  let result: unknown;
  if (def.source === "workforce") {
    const wide = ["developer", "owner", "admin", "finance"].includes(actor.role), manager = actor.role === "manager";
    const mode = !wide && !manager ? "self" : def.unitId ? "unit" : wide ? "organization" : "assigned";
    const unitIds = mode === "self" ? (def.unitId ? [def.unitId] : []) : def.unitId ? [def.unitId] : wide ? (await tx.query("SELECT id FROM units WHERE org_id=$1 ORDER BY id", [actor.org_id])).rows.map(r => r.id) : actor.unit_ids;
    result = { source: def.source, mode, unitIds: unique(unitIds), records: rows.map(r => ({ id: r.id, shiftId: r.shift_id, revision: r.revision, userId: r.user_id, jobId: r.job_id, unitId: r.unit_id })) };
  } else if (def.source === "care") result = { source: def.source, unitId: c.unitId, programId: def.programId, sessionIds: rows.map(r => r.id) };
  else if (def.source === "grades") result = { source: def.source, ...c };
  else if (def.source === "attendance") result = { source: def.source, unitId: def.unitId, yearId: def.yearId, sectionIds: unique(c.sectionIds), sessions: c.sessionVersions };
  else if (def.source === "finance") result = { source: def.source, ...c };
  else result = { source: def.source, unitIds: unique([...rows.map(r => r.unit_id), ...(def.unitId ? [def.unitId] : [])]), records: rows.map(r => ({ id: r.record_id, version: r.record_version, userId: r.user_id, jobId: r.job_id, unitId: r.unit_id, rateId: r.rate_id })) };
  return manifestSchema.parse(result);
}
