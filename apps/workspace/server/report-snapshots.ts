import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, Problem, type Actor } from "./security";
import { loadReportSource } from "./report-library";
import { toCsv } from "./reports";
import { manifestSchema, reportTransaction as transaction, currentReportActor, recheckReportSession as session, authorizeReportManifest as authorize, buildReportManifest as manifest, lockReportExtraction } from "./report-source-access";
import { captureSnapshotInput, prepareSnapshotInput, snapshotDataSchema, snapshotEnvelopeSchema, snapshotExportInput, snapshotLimits as limits, snapshotListInput, snapshotSummarySchema, type SnapshotData, type SnapshotSummary } from "../shared/report-snapshots";
import { withSnapshotXlsxSlot, generateSnapshotXlsx, assertXlsxNotAborted } from "./report-snapshot-xlsx-runtime";

const unavailable = () => new Problem(404, "This saved report result is unavailable under your current access.");
const allowed = (condition: unknown) => { if (!condition) throw unavailable(); };
export function canonicalSnapshot(value: unknown): string {
  function stable(input: any): any {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(stable);
    if (typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype)
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
    throw new Problem(500, "Report data could not be encoded safely.");
  }
  return JSON.stringify(stable(value));
}
async function currentActor(tx: Queryable, actor: Actor, sessionHash: string | undefined, write = false): Promise<Actor> {
  requireCondition(actor.mode === "password" && sessionHash, 403, "Password sign-in is required for saved report snapshots.");
  return currentReportActor(tx, actor, sessionHash, write);
}
async function own(tx: Queryable, actor: Actor, id: string, lock = false) {
  const row = (await tx.query("SELECT * FROM saved_reports WHERE id=$1 AND org_id=$2 AND user_id=$3" + (lock ? " FOR UPDATE" : ""), [id, actor.org_id, actor.id])).rows[0];
  allowed(row); return row;
}
function verified(row: Row) {
  try {
    const access = manifestSchema.parse(row.access_manifest), data = snapshotDataSchema.parse(JSON.parse(row.payload_text));
    if (digest(row.payload_text) !== row.payload_hash || digest(canonicalSnapshot(access)) !== row.manifest_hash) throw new Error();
    if (canonicalSnapshot(data) !== row.payload_text) throw new Error();
    if (row.json_text && (digest(row.json_text) !== row.json_hash || digest(row.csv_text) !== row.csv_hash)) throw new Error();
    if (data.reportId !== row.report_id || data.reportVersion !== row.report_version || access.source !== data.source) throw new Error();
    return { access, data };
  } catch { throw new Problem(500, "Saved report integrity could not be verified."); }
}
function summary(row: Row, data: SnapshotData): SnapshotSummary {
  return { id: row.id, reportId: row.report_id, reportVersion: row.report_version, source: data.source, name: data.name, asOf: data.asOf, capturedAt: new Date(row.captured_at).toISOString(), rowCount: data.rowCount, sourceRowCount: data.sourceRowCount, payloadHash: row.payload_hash, jsonHash: row.json_hash, csvHash: row.csv_hash, bytes: row.bytes, ...(data.schemaVersion===2?{precisionVersion:2 as const}:{}) };
}
async function snapshot(tx: Queryable, actor: Actor, reportId: string, id: string) {
  await own(tx, actor, reportId);
  const row = (await tx.query("SELECT * FROM report_run_snapshots WHERE id=$1 AND org_id=$2 AND user_id=$3 AND report_id=$4", [id, actor.org_id, actor.id, reportId])).rows[0]; allowed(row);
  const value = verified(row); await authorize(tx, actor, value.access); return { row, ...value };
}
export async function prepareReportSnapshot(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, raw: unknown) {
  const input = prepareSnapshotInput.parse(raw);
  const preflight = await transaction(db, async tx => { const fresh = await currentActor(tx, actor, sessionHash); const report = await own(tx, fresh, reportId); requireCondition(!report.archived && report.version === input.version, 409, "The saved definition changed or is archived. Reload before preparing a snapshot."); return { actor: fresh, report }; });
  const copy = await transaction(db, async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await tx.query("SET LOCAL statement_timeout='15s'");
    await lockReportExtraction(tx, actor);
    const now = new Date((await tx.query("SELECT clock_timestamp() AS now")).rows[0].now);
    const source = await loadReportSource(tx, preflight.actor, preflight.report.definition, now, { id: reportId, version: input.version, auditSources: false });
    const data = snapshotDataSchema.parse({ ...source.report, name: preflight.report.name, description: preflight.report.description, schemaVersion: source.report.precisionVersion===2?2:1, sourceReadStartedAt: now.toISOString() });
    requireCondition(source.rows.length <= limits.rows, 400, "Narrow the report before saving a snapshot.");
    return { data, access: await manifest(tx, preflight.actor, data.definition, source) };
  });
  const payload = canonicalSnapshot(copy.data), manifestText = canonicalSnapshot(copy.access), bytes = Buffer.byteLength(payload) + Buffer.byteLength(manifestText);
  requireCondition(bytes <= limits.bytes, 400, "This report exceeds the 8 MiB snapshot limit. Narrow its range or columns.");
  return transaction(db, async tx => {
    const fresh = await currentActor(tx, actor, sessionHash, true); await authorize(tx, fresh, copy.access);
    const report = await own(tx, fresh, reportId, true); requireCondition(!report.archived && report.version === input.version, 409, "The saved definition changed or is archived. Prepare it again.");
    await tx.query("DELETE FROM report_run_previews WHERE org_id=$1 AND user_id=$2 AND expires_at<=clock_timestamp()", [actor.org_id, actor.id]);
    const count = (await tx.query("SELECT count(*)::integer AS n FROM report_run_previews WHERE org_id=$1 AND user_id=$2", [actor.org_id, actor.id])).rows[0].n;
    requireCondition(count < limits.previews, 409, "Three snapshot reviews are already open. Save one or wait for a review to expire.");
    const id = randomUUID(), snapshotId = randomUUID(), payloadHash = digest(payload);
    const row = (await tx.query("INSERT INTO report_run_previews(id,org_id,user_id,report_id,report_version,snapshot_id,payload_text,payload_hash,access_manifest,manifest_hash,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '10 minutes') RETURNING expires_at", [id, actor.org_id, actor.id, reportId, input.version, snapshotId, payload, payloadHash, manifestText, digest(manifestText), bytes])).rows[0];
    await audit(tx, fresh, "report_snapshot.prepared", id, { reportId, version: input.version, source: copy.data.source, payloadHash, rowCount: copy.data.rowCount, bytes }); await session(tx, fresh, sessionHash!);
    return { id, snapshotId, expiresAt: new Date(row.expires_at).toISOString(), payloadHash, data: copy.data };
  });
}
export async function readReportSnapshotPreview(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, previewId: string) {
  return transaction(db, async tx => {
    const fresh = await currentActor(tx, actor, sessionHash); await own(tx, fresh, reportId);
    const row = (await tx.query("SELECT * FROM report_run_previews WHERE id=$1 AND org_id=$2 AND user_id=$3 AND report_id=$4 AND expires_at>clock_timestamp()", [previewId, actor.org_id, actor.id, reportId])).rows[0]; allowed(row);
    const { access, data } = verified(row); await authorize(tx, fresh, access); await session(tx, fresh, sessionHash!);
    requireCondition((await tx.query("SELECT expires_at>clock_timestamp() AS valid FROM report_run_previews WHERE id=$1", [row.id])).rows[0]?.valid, 409, "This snapshot review expired. Prepare it again.");
    return { id: row.id, snapshotId: row.snapshot_id, expiresAt: new Date(row.expires_at).toISOString(), payloadHash: row.payload_hash, data };
  });
}
export async function captureReportSnapshot(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, raw: unknown) {
  const input = captureSnapshotInput.parse(raw), fingerprint = digest(canonicalSnapshot({ reportId, ...input }));
  return transaction(db, async tx => {
    const fresh = await currentActor(tx, actor, sessionHash, true);
    const receipt = (await tx.query("SELECT * FROM report_snapshot_commands WHERE org_id=$1 AND user_id=$2 AND command_id=$3", [actor.org_id, actor.id, input.commandId])).rows[0];
    if (receipt) {
      requireCondition(receipt.fingerprint === fingerprint, 409, "That capture command was already used for a different review.");
      const saved = await snapshot(tx, fresh, reportId, receipt.snapshot_id); await session(tx, fresh, sessionHash!); return { snapshot: summary(saved.row, saved.data) };
    }
    const preview = (await tx.query("SELECT * FROM report_run_previews WHERE id=$1 AND org_id=$2 AND user_id=$3 AND report_id=$4 FOR UPDATE", [input.previewId, actor.org_id, actor.id, reportId])).rows[0];
    requireCondition(preview, 409, "This snapshot review is unavailable or already captured. Reload saved snapshots before preparing again.");
    const { access, data } = verified(preview); await authorize(tx, fresh, access);
    const report = await own(tx, fresh, reportId, true);
    requireCondition(!report.archived && report.version === input.version && preview.report_version === input.version, 409, "The saved definition changed or is archived. Prepare and review again.");
    requireCondition(preview.payload_hash === input.payloadHash, 409, "The reviewed payload does not match this capture.");
    const now = new Date((await tx.query("SELECT clock_timestamp() AS now")).rows[0].now);
    requireCondition(new Date(preview.expires_at) > now, 409, "This snapshot review expired. Prepare and review again.");
    const envelope = snapshotEnvelopeSchema.parse({ schemaVersion: data.schemaVersion, id: preview.snapshot_id, capturedAt: now.toISOString(), reviewerId: actor.id, reason: input.reason, payloadHash: input.payloadHash, data });
    const json = canonicalSnapshot(envelope), metadata = { snapshot_row_kind: data.rows.length ? "record" : "empty_report", snapshot_row_count: data.rowCount, snapshot_source_row_count: data.sourceRowCount, snapshot_id: preview.snapshot_id, snapshot_captured_at: now.toISOString(), snapshot_payload_hash: input.payloadHash, report_id: reportId, report_version: input.version, report_as_of: data.asOf, report_timezone: data.timezone, report_source_versions: canonicalSnapshot(data.provenance), ...(data.schemaVersion===2?{snapshot_schema_version:2,workforce_precision_version:2,duration_unit:"microsecond"}:{}) };
    const csvRows = data.rows.length ? data.rows : [Object.fromEntries(data.columns.map(column => [column.key, null]))];
    // BOM-free UTF-8 keeps stored text and exact exported bytes identical across
    // PostgreSQL drivers, including decoders that discard a leading BOM.
    const csv = toCsv(csvRows.map(row => ({ ...row, ...metadata })), [...data.columns.map(c => c.key), ...Object.keys(metadata)]).replace(/^\uFEFF/, "");
    const bytes = preview.bytes + Buffer.byteLength(json) + Buffer.byteLength(csv);
    requireCondition(bytes <= limits.bytes, 400, "The complete export exceeds 8 MiB. Prepare a narrower report.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('report-snapshot-quota:'||$1,0))", [actor.org_id]);
    const quota = (await tx.query("SELECT count(*)::integer AS n,coalesce(sum(bytes),0)::bigint AS bytes,count(*) FILTER(WHERE user_id=$2)::integer AS own_n,coalesce(sum(bytes) FILTER(WHERE user_id=$2),0)::bigint AS own_bytes FROM report_run_snapshots WHERE org_id=$1", [actor.org_id, actor.id])).rows[0];
    requireCondition(quota.n < limits.organizationCount && Number(quota.bytes) + bytes <= limits.organizationBytes && quota.own_n < limits.accountCount && Number(quota.own_bytes) + bytes <= limits.accountBytes, 409, "Retained snapshot capacity has been reached. Existing snapshots are preserved.");
    requireCondition((await tx.query("SELECT expires_at>clock_timestamp() AS valid FROM report_run_previews WHERE id=$1", [preview.id])).rows[0]?.valid, 409, "This snapshot review expired. Prepare it again.");
    const row = (await tx.query("INSERT INTO report_run_snapshots(id,org_id,user_id,report_id,report_version,preview_id,payload_text,payload_hash,access_manifest,manifest_hash,json_text,json_hash,csv_text,csv_hash,bytes,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *", [preview.snapshot_id, actor.org_id, actor.id, reportId, input.version, input.previewId, preview.payload_text, input.payloadHash, canonicalSnapshot(access), preview.manifest_hash, json, digest(json), csv, digest(csv), bytes, now])).rows[0];
    await tx.query("INSERT INTO report_snapshot_commands(org_id,user_id,command_id,snapshot_id,fingerprint) VALUES($1,$2,$3,$4,$5)", [actor.org_id, actor.id, input.commandId, row.id, fingerprint]);
    await tx.query("DELETE FROM report_run_previews WHERE id=$1 AND org_id=$2 AND user_id=$3", [input.previewId, actor.org_id, actor.id]);
    await audit(tx, fresh, "report_snapshot.captured", row.id, { reportId, version: input.version, source: data.source, payloadHash: input.payloadHash, jsonHash: row.json_hash, csvHash: row.csv_hash, rowCount: data.rowCount, bytes }); await session(tx, fresh, sessionHash!);
    return { snapshot: summary(row, data) };
  });
}
export async function readReportSnapshot(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, id: string, format?: "csv" | "json") {
  return transaction(db, async tx => {
    const fresh = await currentActor(tx, actor, sessionHash), saved = await snapshot(tx, fresh, reportId, id);
    const envelope = snapshotEnvelopeSchema.parse(JSON.parse(saved.row.json_text));
    requireCondition(canonicalSnapshot(envelope.data) === saved.row.payload_text && envelope.payloadHash === saved.row.payload_hash && envelope.id === id, 500, "Saved report integrity could not be verified.");
    await audit(tx, fresh, format ? "report_snapshot.exported" : "report_snapshot.viewed", id, { reportId, format: format ?? null, payloadHash: saved.row.payload_hash, bytes: saved.row.bytes }); await session(tx, fresh, sessionHash!);
    return { snapshot: envelope, payloadHash: saved.row.payload_hash, jsonHash: saved.row.json_hash, csvHash: saved.row.csv_hash, bytes: saved.row.bytes, ...(format ? { content: format === "csv" ? saved.row.csv_text : saved.row.json_text } : {}) };
  });
}
/** Private immutable copy -> bounded generation -> fresh authority and audit -> response. */
export async function exportReportSnapshotXlsx(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, id: string, signal?: AbortSignal) {
  const identity = { ...actor, unit_ids: [...actor.unit_ids] };
  return withSnapshotXlsxSlot(`${identity.org_id}:${identity.id}`, async () => {
    assertXlsxNotAborted(signal);
    const copy = await transaction(db, async tx => {
      const fresh = await currentActor(tx, identity, sessionHash), saved = await snapshot(tx, fresh, reportId, id);
      const envelope = snapshotEnvelopeSchema.parse(JSON.parse(saved.row.json_text));
      requireCondition(canonicalSnapshot(envelope.data) === saved.row.payload_text && envelope.payloadHash === saved.row.payload_hash && envelope.id === id, 500, "Saved report integrity could not be verified.");
      await session(tx, fresh, sessionHash!);
      return { input: { payloadText: saved.row.payload_text as string, envelopeText: saved.row.json_text as string, jsonHash: saved.row.json_hash as string, csvHash: saved.row.csv_hash as string }, payloadHash: saved.row.payload_hash, manifestHash: saved.row.manifest_hash };
    });
    assertXlsxNotAborted(signal);
    const generated = await generateSnapshotXlsx(copy.input, { signal });
    return transaction(db, async tx => {
      assertXlsxNotAborted(signal);
      const fresh = await currentActor(tx, identity, sessionHash), saved = await snapshot(tx, fresh, reportId, id);
      requireCondition(saved.row.payload_text === copy.input.payloadText && saved.row.json_text === copy.input.envelopeText && saved.row.payload_hash === copy.payloadHash && saved.row.json_hash === copy.input.jsonHash && saved.row.csv_hash === copy.input.csvHash && saved.row.manifest_hash === copy.manifestHash, 500, "Saved report integrity could not be verified.");
      await audit(tx, fresh, "report_snapshot.exported", id, { reportId, format: "xlsx", payloadHash: copy.payloadHash, jsonHash: copy.input.jsonHash, csvHash: copy.input.csvHash, exportHash: generated.hash, bytes: generated.bytes, exportFormatVersion: generated.formatVersion });
      await session(tx, fresh, sessionHash!); assertXlsxNotAborted(signal);
      return { ...generated, payloadHash: copy.payloadHash as string };
    });
  });
}
export async function listReportSnapshots(db: Database, actor: Actor, sessionHash: string | undefined, reportId: string, raw: unknown = {}) {
  const { offset } = snapshotListInput.parse(raw);
  return transaction(db, async tx => {
    const fresh = await currentActor(tx, actor, sessionHash); await own(tx, fresh, reportId);
    // Lists read only a small immutable summary and the necessary scope manifest,
    // not up to 128 MiB of retained export bodies. Full hashes are verified on open/export.
    const rows = (await tx.query(`SELECT id,report_id,report_version,access_manifest,manifest_hash,payload_hash,json_hash,csv_hash,bytes,captured_at,
      payload_text::jsonb->>'name' AS name,payload_text::jsonb->>'source' AS source,payload_text::jsonb->>'asOf' AS as_of,
      payload_text::jsonb->>'schemaVersion' AS schema_version,payload_text::jsonb->>'precisionVersion' AS precision_version,
      (payload_text::jsonb->>'rowCount')::integer AS row_count,(payload_text::jsonb->>'sourceRowCount')::integer AS source_row_count
      FROM report_run_snapshots WHERE org_id=$1 AND user_id=$2 AND report_id=$3 ORDER BY captured_at DESC,id LIMIT 101`, [actor.org_id, actor.id, reportId])).rows;
    requireCondition(rows.length <= limits.accountCount, 500, "Snapshot capacity integrity could not be verified.");
    const visible: SnapshotSummary[] = [];
    for (const row of rows) {
      const access = manifestSchema.parse(row.access_manifest);
      requireCondition(digest(canonicalSnapshot(access)) === row.manifest_hash && access.source === row.source, 500, "Snapshot scope integrity could not be verified.");
      requireCondition(row.schema_version==="1"?row.precision_version===null:row.schema_version==="2"&&row.precision_version==="2"&&row.source==="workforce",500,"Snapshot version integrity could not be verified.");
      try {
        await authorize(tx, fresh, access);
        visible.push(snapshotSummarySchema.parse({ id: row.id, reportId: row.report_id, reportVersion: row.report_version, source: row.source,
          name: row.name, asOf: row.as_of, capturedAt: new Date(row.captured_at).toISOString(), rowCount: row.row_count, sourceRowCount: row.source_row_count,
          payloadHash: row.payload_hash, jsonHash: row.json_hash, csvHash: row.csv_hash, bytes: row.bytes, ...(row.schema_version==="2"?{precisionVersion:2 as const}:{}) }));
      } catch (error) { if (!(error instanceof Problem && error.status === 404)) throw error; }
    }
    await session(tx, fresh, sessionHash!); return { rows: visible.slice(offset, offset + limits.pageSize), nextOffset: visible.length > offset + limits.pageSize ? offset + limits.pageSize : null };
  });
}
export function installReportSnapshots(app: Express, db: Database) {
  const who = (req: Request) => ({ actor: (req as AppRequest).actor, hash: (req as AppRequest).sessionHash, reportId: z.uuid().parse(req.params.id) });
  app.post("/api/report-library/:id/snapshot-previews", async (req, res) => { const x = who(req); res.status(201).json(await prepareReportSnapshot(db, x.actor, x.hash, x.reportId, req.body)); });
  app.get("/api/report-library/:id/snapshot-previews/:previewId", async (req, res) => { const x = who(req); res.json(await readReportSnapshotPreview(db, x.actor, x.hash, x.reportId, z.uuid().parse(req.params.previewId))); });
  app.post("/api/report-library/:id/snapshots", async (req, res) => { const x = who(req); res.status(201).json(await captureReportSnapshot(db, x.actor, x.hash, x.reportId, req.body)); });
  app.get("/api/report-library/:id/snapshots", async (req, res) => { const x = who(req); res.json(await listReportSnapshots(db, x.actor, x.hash, x.reportId, req.query)); });
  app.get("/api/report-library/:id/snapshots/:snapshotId", async (req, res) => { const x = who(req); res.json(await readReportSnapshot(db, x.actor, x.hash, x.reportId, z.uuid().parse(req.params.snapshotId))); });
  app.get("/api/report-library/:id/snapshots/:snapshotId/export", async (req, res) => {
    const x = who(req), id = z.uuid().parse(req.params.snapshotId), { format } = snapshotExportInput.parse(req.query);
    if (format === "xlsx") {
      const controller = new AbortController(), cancel = () => { if (!res.writableFinished) controller.abort(); };
      req.once("aborted", cancel); res.once("close", cancel);
      try {
        const data = await exportReportSnapshotXlsx(db, x.actor, x.hash, x.reportId, id, controller.signal); assertXlsxNotAborted(controller.signal);
        res.set({ "X-Export-SHA256": data.hash, "X-Snapshot-Payload-SHA256": data.payloadHash, "X-Export-Format-Version": "2", "Cache-Control": "private, no-store", "Content-Length": String(data.bytes), "X-Content-Type-Options": "nosniff" }).type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`stjw-snapshot-${id}.xlsx`).send(data.buffer);
      } finally { req.off("aborted", cancel); res.off("close", cancel); }
      return;
    }
    const data = await readReportSnapshot(db, x.actor, x.hash, x.reportId, id, format); res.set("X-Snapshot-SHA256", format === "csv" ? data.csvHash : data.jsonHash).type(format === "csv" ? "text/csv" : "application/json").attachment(`stjw-snapshot-${id}.${format}`).send(data.content);
  });
}
