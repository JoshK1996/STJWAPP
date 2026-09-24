import { parse } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Express, Request } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, manages, Problem, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { createStaff, validateStaff } from "./workforce";
import { toCsv } from "./reports";
import { staffInput } from "../shared/contracts";
import { staffImportColumns, staffImportLimits, staffImportRowsSchema, staffImportPreviewInput, staffImportApplyInput,
  staffImportReceiptSchema, staffImportDetailSchema, staffImportSummarySchema, staffImportListQuery, staffImportCursorSchema, staffImportListSchema,
  type StaffImportDetail, type StaffImportReceipt } from "../shared/staff-imports";

export const staffColumns = [...staffImportColumns];
const notice = "Accounts were created without credentials. Issue individual private setup links from Staff." as const;
const utc = (column: string) => `to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const dates = `${utc("b.created_at")} AS created_text,${utc("b.created_at+interval '24 hours'")} AS expires_text,${utc("b.applied_at")} AS applied_text`;
const mandatoryProof = (hash: string | undefined): string => {
  requireCondition(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), 401, "Your session has expired or changed. Sign in again."); return hash;
};
export function staffImportSourceBudget(raw: unknown = process.env.STAFF_IMPORT_SOURCE_BUDGET_BYTES): number {
  if (raw === undefined) return staffImportLimits.defaultSourceBudgetBytes;
  const valid = typeof raw === "number" ? Number.isSafeInteger(raw) : typeof raw === "string" && /^(?:0|[1-9]\d{0,10})$/.test(raw);
  const value = valid ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < staffImportLimits.minimumSourceBudgetBytes || value > staffImportLimits.maximumSourceBudgetBytes)
    throw new Error("STAFF_IMPORT_SOURCE_BUDGET_BYTES must be an integer from 1048576 to 1073741824.");
  return value;
}
/** Transaction-only proof, without any academic/domain lock. Caller owns final proof. */
export async function currentStaffImportActor(tx: Queryable, supplied: Actor, sessionHash: string | undefined): Promise<Actor> {
  const actor = await currentReportActor(tx, supplied, mandatoryProof(sessionHash));
  requireCondition(manages(actor), 403, "Staff management access required."); return actor;
}
async function transaction<T>(db: Database, action: (tx: Queryable) => Promise<T>, repeatable = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      if (repeatable) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'"); return action(tx);
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (["40001", "40P01"].includes(code ?? "") && attempt < 2) continue;
      if (["55P03", "57014", "40001", "40P01"].includes(code ?? "")) throw new Problem(503, "Staff import access is busy. Retry the same import request.");
      throw error;
    }
  }
}
function capture(actor: Actor) { return { ...actor, unit_ids: [...actor.unit_ids] }; }
function sourceBytes(csv: string) {
  const bytes = Buffer.from(csv, "utf8");
  requireCondition(csv.length <= staffImportLimits.characters && bytes.length <= staffImportLimits.sourceBytes, 413, "Staff CSV exceeds the supported character or UTF-8 byte limit.");
  requireCondition(bytes.toString("utf8") === csv, 400, "Staff CSV must contain valid Unicode text."); return bytes;
}
function parseRows(csv: string) {
  let raw: string[][];
  try { raw = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: staffImportLimits.recordCharacters, relax_column_count: false }); }
  catch { throw new Problem(400, "Invalid CSV. Use the staff template and bounded text records."); }
  requireCondition(raw.length > 1 && raw.length <= staffImportLimits.rows + 1, 400, "Import between 1 and 500 employees.");
  requireCondition(isDeepStrictEqual(raw[0], staffColumns), 400, "Use the exact headers from the staff import template.");
  const seen = new Set<string>();
  return raw.slice(1).map(values => {
    const row = staffInput.parse({ name: values[0], email: values[1], role: values[2], unitIds: values[3].split("|").filter(Boolean), jobIds: values[4].split("|").filter(Boolean) });
    requireCondition(!seen.has(row.email), 400, "The CSV contains duplicate email addresses."); seen.add(row.email); return row;
  });
}
type StaffRow = z.infer<typeof staffInput>;
function capturedScope(actor: Actor, rows: StaffRow[]) {
  requireCondition(rows.every(row => !["developer", "owner"].includes(row.role) && (actor.role !== "admin" || row.role !== "admin") &&
    (actor.role !== "manager" || row.role === "employee" && row.unitIds.every(id => actor.unit_ids.includes(id)))), 403, "The complete staff import is outside your current management scope.");
}
async function lockedRows(tx: Queryable, actor: Actor, rows: StaffRow[], domain: string) {
  capturedScope(actor, rows);
  const jobIds = [...new Set(rows.flatMap(row => row.jobIds))].sort();
  const jobs = (await tx.query("SELECT id,unit_id,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [actor.org_id, jobIds])).rows;
  requireCondition(jobs.length === jobIds.length && jobs.every(job => job.active), 400, "Jobs must be current active jobs in the assigned units.");
  const unitIds = [...new Set([...rows.flatMap(row => row.unitIds), ...jobs.map(job => job.unit_id as string)])].sort();
  const units = (await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [actor.org_id, unitIds])).rows;
  requireCondition(units.length === unitIds.length, 400, "Unknown organizational unit.");
  for (const row of rows) await validateStaff(tx, actor, row, domain);
}
function retainedSource(row: Row) {
  requireCondition(row.evidence_version === 2 && typeof row.source_base64 === "string", 404, "Original source was not retained for this legacy import.");
  const bytes = Buffer.from(row.source_base64, "base64"), csv = bytes.toString("utf8");
  requireCondition(bytes.toString("base64") === row.source_base64 && Buffer.from(csv, "utf8").equals(bytes), 422, "Retained staff import source is inconsistent.");
  sourceBytes(csv); requireCondition(digest(csv) === row.source_hash, 422, "Retained staff import source hash is inconsistent."); return { csv, bytes };
}
function checked(row: Row): StaffImportDetail {
  try {
    const rows = staffImportRowsSchema.parse(row.rows);
    requireCondition(isDeepStrictEqual(rows, row.rows), 422, "Retained staff import rows are inconsistent.");
    if (row.evidence_version === 2) requireCondition(isDeepStrictEqual(parseRows(retainedSource(row).csv), rows), 422, "Retained staff import source and rows differ.");
    return staffImportDetailSchema.parse({ id: row.id, sourceHash: row.source_hash, rows, count: rows.length, evidenceVersion: row.evidence_version,
      createdAt: row.created_text, expiresAt: row.expires_text, appliedAt: row.applied_text,
      sourceAvailable: row.source_base64 !== null, receiptState: row.applied_at ? row.receipt ? "retained" : "legacy_unavailable" : "pending", receipt: row.receipt });
  } catch { throw new Problem(422, "Retained staff import evidence is inconsistent. No accounts were created by this request."); }
}
async function owned(tx: Queryable, actor: Actor, id: string, lock = false) {
  const row = (await tx.query(`SELECT b.*,${dates} FROM import_batches b WHERE b.id=$1 AND b.org_id=$2 AND b.actor_id=$3${lock ? " FOR UPDATE OF b" : ""}`, [id, actor.org_id, actor.id])).rows[0];
  requireCondition(row, 404, "Import preview not found."); return row;
}
async function publish<T>(tx: Queryable, actor: Actor, proof: string, result: T) { JSON.stringify(result); await recheckReportSession(tx, actor, proof); return result; }
async function fresh(tx: Queryable, actor: Actor, id: string) {
  requireCondition((await tx.query("SELECT id FROM import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3 AND applied_at IS NULL AND created_at+interval '24 hours'>clock_timestamp()", [id, actor.org_id, actor.id])).rows.length, 409, "Preview expired. Upload and review the file again.");
}
export async function previewStaffImport(db: Database, supplied: Actor, csv: string, domain: string, sessionHash: string | undefined,
  options?: { sourceBudgetBytes: number }) {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied), input = staffImportPreviewInput.parse({ csv });
  const bytes = sourceBytes(input.csv), source = bytes.toString("base64"), budget = staffImportSourceBudget(options?.sourceBudgetBytes ?? staffImportLimits.defaultSourceBudgetBytes);
  return transaction(db, async tx => {
    // Namespace is preview-only and always precedes account locks.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["staff-import-source:" + identity.org_id]);
    const actor = await currentStaffImportActor(tx, identity, proof), rows = parseRows(input.csv);
    await lockedRows(tx, actor, rows, domain);
    const existing = (await tx.query("SELECT email FROM users WHERE email=ANY($1::text[])", [rows.map(row => row.email)])).rows;
    requireCondition(!existing.length, 409, "At least one email already has an account. This template creates new staff only.");
    const used = BigInt((await tx.query("SELECT coalesce(sum(octet_length(source_base64)),0)::text AS used FROM import_batches WHERE org_id=$1", [actor.org_id])).rows[0].used);
    requireCondition(used + BigInt(Buffer.byteLength(source, "ascii")) <= BigInt(budget), 409, "The organization's retained staff-import source budget is full. Ask the owner to review the configured capacity. Existing evidence has been preserved.");
    const id = randomUUID(), sourceHash = digest(input.csv);
    await tx.query("INSERT INTO import_batches(id,org_id,actor_id,source_hash,rows,evidence_version,source_base64) VALUES($1,$2,$3,$4,$5,2,$6)", [id, actor.org_id, actor.id, sourceHash, JSON.stringify(rows), source]);
    await audit(tx, actor, "import.previewed", id, { sourceHash, rowCount: rows.length, sourceBytes: bytes.length, serializedSourceBytes: Buffer.byteLength(source, "ascii"), evidenceVersion: 2 });
    return publish(tx, actor, proof, checked(await owned(tx, actor, id)));
  });
}
export async function applyStaffImport(db: Database, supplied: Actor, id: string, sourceHash: string, domain: string, sessionHash: string | undefined): Promise<StaffImportReceipt> {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied), batchId = z.uuid().parse(id), input = staffImportApplyInput.parse({ sourceHash });
  try { return await transaction(db, async tx => {
    const actor = await currentStaffImportActor(tx, identity, proof), row = await owned(tx, actor, batchId, true);
    requireCondition(row.source_hash === input.sourceHash, 404, "Import preview not found.");
    const evidence = checked(row); capturedScope(actor, evidence.rows);
    if (evidence.receipt) return publish(tx, actor, proof, evidence.receipt);
    requireCondition(evidence.appliedAt === null, 409, "This legacy import was already applied, but no creation receipt was retained. Review its history and Staff records. Do not import it again.");
    await fresh(tx, actor, batchId); await lockedRows(tx, actor, evidence.rows, domain);
    const accounts: StaffImportReceipt["accounts"] = [];
    for (const [index, staff] of evidence.rows.entries()) accounts.push({ row: index + 2, userId: await createStaff(tx, actor, staff, domain) });
    await fresh(tx, actor, batchId);
    const appliedAt = (await tx.query(`SELECT ${utc("clock_timestamp()")} AS now`)).rows[0].now;
    const receipt = staffImportReceiptSchema.parse({ schemaVersion: 1, batchId, sourceHash: input.sourceHash, created: accounts.length, appliedAt, accounts, notice });
    await tx.query("UPDATE import_batches SET applied_at=$1,receipt=$2 WHERE id=$3 AND org_id=$4 AND actor_id=$5", [appliedAt, JSON.stringify(receipt), batchId, actor.org_id, actor.id]);
    await audit(tx, actor, "import.applied", batchId, { sourceHash: input.sourceHash, rowCount: accounts.length, receiptVersion: 1 });
    return publish(tx, actor, proof, receipt);
  }); } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "users_email_key")
      throw new Problem(409, "At least one email already has an account. No accounts were created by this import request.");
    throw error;
  }
}
export async function getStaffImport(db: Database, supplied: Actor, sessionHash: string | undefined, id: string) {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied), batchId = z.uuid().parse(id);
  return transaction(db, async tx => {
    const actor = await currentStaffImportActor(tx, identity, proof), result = checked(await owned(tx, actor, batchId)); capturedScope(actor, result.rows);
    await audit(tx, actor, "import.read", batchId, { sourceHash: result.sourceHash }); return publish(tx, actor, proof, result);
  });
}
export async function getStaffImportSource(db: Database, supplied: Actor, sessionHash: string | undefined, id: string) {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied), batchId = z.uuid().parse(id);
  return transaction(db, async tx => {
    const actor = await currentStaffImportActor(tx, identity, proof), row = await owned(tx, actor, batchId), evidence = checked(row); capturedScope(actor, evidence.rows);
    const source = retainedSource(row);
    await audit(tx, actor, "import.source_exported", batchId, { sourceHash: row.source_hash, bytes: source.bytes.length });
    return publish(tx, actor, proof, { csv: source.csv, sourceHash: row.source_hash as string, bytes: source.bytes.length, filename: `stjw-staff-import-${batchId}-source.txt` });
  });
}
export async function getStaffImportTemplate(db: Database, supplied: Actor, sessionHash: string | undefined) {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied);
  return transaction(db, async tx => {
    const actor = await currentStaffImportActor(tx, identity, proof), csv = toCsv([], staffColumns);
    await audit(tx, actor, "import.template_downloaded", null, {}); return publish(tx, actor, proof, csv);
  });
}
export async function listStaffImports(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const proof = mandatoryProof(sessionHash), identity = capture(supplied), query = staffImportListQuery.parse(raw), limit = query.limit ? Number(query.limit) : 50;
  let cursor: z.infer<typeof staffImportCursorSchema> | undefined;
  if (query.cursor) {
    try { const bytes = Buffer.from(query.cursor, "base64url"); requireCondition(bytes.toString("base64url") === query.cursor, 400, "Invalid staff history cursor."); cursor = staffImportCursorSchema.parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new Problem(400, "Invalid staff history cursor."); }
  }
  return transaction(db, async tx => {
    const actor = await currentStaffImportActor(tx, identity, proof);
    const scope = `b.org_id=$1 AND b.actor_id=$2 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.rows) r
      WHERE r->>'role' IN ('developer','owner') OR ($3='admin' AND r->>'role'='admin') OR ($3='manager' AND
      (r->>'role'<>'employee' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'unitIds') u WHERE NOT (u=ANY($4::text[]))))))`;
    const params = [actor.org_id, actor.id, actor.role, actor.unit_ids];
    const counts = (await tx.query(`SELECT count(*)::text AS batches,count(applied_at)::text AS applied FROM import_batches b WHERE ${scope}`, params)).rows[0];
    const revision = digest(JSON.stringify([counts.batches, counts.applied]));
    const authorityHash = digest(JSON.stringify([actor.org_id, actor.id, actor.role, [...actor.unit_ids].sort(), limit]));
    requireCondition(!cursor || cursor.revision === revision && cursor.authorityHash === authorityHash, 409, "Staff import history changed. Reload the entire list.");
    const rows = (await tx.query(`SELECT b.id,b.source_hash,b.evidence_version,b.applied_at,b.receipt IS NOT NULL AS has_receipt,b.source_base64 IS NOT NULL AS has_source,jsonb_array_length(b.rows) AS count,${dates}
      FROM import_batches b WHERE ${scope} AND ($5::timestamptz IS NULL OR (b.created_at,b.id)<($5::timestamptz,$6::uuid)) ORDER BY b.created_at DESC,b.id DESC LIMIT $7`, [...params, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    const result = staffImportListSchema.parse({ rows: page.map(row => staffImportSummarySchema.parse({ id: row.id, sourceHash: row.source_hash, count: row.count, evidenceVersion: row.evidence_version,
      createdAt: row.created_text, expiresAt: row.expires_text, appliedAt: row.applied_text, sourceAvailable: row.has_source,
      receiptState: row.applied_at ? row.has_receipt ? "retained" : "legacy_unavailable" : "pending" })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify(staffImportCursorSchema.parse({ version: 1, createdAt: last.created_text, id: last.id, revision, authorityHash }))).toString("base64url") : null });
    return publish(tx, actor, proof, result);
  }, true);
}
export function installStaffImports(app: Express, db: Database, domain: string, options = { sourceBudgetBytes: staffImportSourceBudget() }) {
  const sourceBudgetBytes = staffImportSourceBudget(options.sourceBudgetBytes);
  const auth = (req: Request) => { const { actor, sessionHash } = req as AppRequest; return { actor, sessionHash }; };
  app.use("/api/imports/staff", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  app.get("/api/imports/staff/template", async (req, res) => { const { actor, sessionHash } = auth(req), csv = await getStaffImportTemplate(db, actor, sessionHash); res.attachment("stjw-staff-template.csv").type("text/csv").send(csv); });
  app.post("/api/imports/staff/preview", async (req, res) => { const { actor, sessionHash } = auth(req), input = staffImportPreviewInput.parse(req.body); res.json(await previewStaffImport(db, actor, input.csv, domain, sessionHash, { sourceBudgetBytes })); });
  app.get("/api/imports/staff", async (req, res) => { const { actor, sessionHash } = auth(req); res.json(await listStaffImports(db, actor, sessionHash, req.query)); });
  app.get("/api/imports/staff/:id/source", async (req, res) => { const { actor, sessionHash } = auth(req), source = await getStaffImportSource(db, actor, sessionHash, z.uuid().parse(req.params.id));
    res.set("X-STJW-Source-SHA256", source.sourceHash).set("Content-Length", String(source.bytes)).set("X-Content-Type-Options", "nosniff").attachment(source.filename).type("text/plain; charset=utf-8").send(Buffer.from(source.csv, "utf8")); });
  app.get("/api/imports/staff/:id", async (req, res) => { const { actor, sessionHash } = auth(req); res.json(await getStaffImport(db, actor, sessionHash, z.uuid().parse(req.params.id))); });
  app.post("/api/imports/staff/:id/apply", async (req, res) => { const { actor, sessionHash } = auth(req), input = staffImportApplyInput.parse(req.body); res.json(await applyStaffImport(db, actor, z.uuid().parse(req.params.id), input.sourceHash, domain, sessionHash)); });
}
