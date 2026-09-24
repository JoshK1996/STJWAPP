import ExcelJS from "exceljs";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { snapshotEnvelopeSchema } from "../shared/report-snapshots";
import { xlsxLimits, XlsxFailure, type SnapshotXlsxInput } from "./report-snapshot-xlsx-contract";
export { xlsxLimits, XlsxFailure, type SnapshotXlsxInput } from "./report-snapshot-xlsx-contract";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: any): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(value));
}
/** No escaping that changes source text. These values are not lossless in this pinned writer. */
export function xlsxText(value: string, maxUnits: number = xlsxLimits.cellUnits): string {
  if (value.length > maxUnits) throw new XlsxFailure("limit");
  if (/[\u0000-\u0008\u000b-\u000f\u0010-\u001f\u007f\ufffe\uffff]|_x[0-9a-f]{4}_/i.test(value)) throw new XlsxFailure("unsupported");
  for (const point of value) { const n = point.codePointAt(0)!; if (n >= 0xd800 && n <= 0xdfff) throw new XlsxFailure("unsupported"); }
  return value;
}
export function xlsxChunks(value: string): string[] {
  xlsxText(value, xlsxLimits.inputBytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + xlsxLimits.chunkUnits, value.length);
    if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
    chunks.push(value.slice(offset, end)); offset = end;
  }
  return chunks.length ? chunks : [""];
}
function scalar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return xlsxText(value);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  throw new XlsxFailure("invalid");
}
function maxOutput(value?: number) {
  if (value === undefined) return xlsxLimits.outputBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > xlsxLimits.outputBytes) throw new XlsxFailure("invalid");
  return value;
}
/** Pure synthetic-testable writer. Production invokes it only in the bounded worker. */
export async function serializeSnapshotXlsx(raw: SnapshotXlsxInput, maxBytes?: number): Promise<Buffer> {
  const cap = maxOutput(maxBytes);
  if (!raw || typeof raw.payloadText !== "string" || typeof raw.envelopeText !== "string" || !/^[a-f0-9]{64}$/.test(raw.jsonHash) || !/^[a-f0-9]{64}$/.test(raw.csvHash)) throw new XlsxFailure("invalid");
  if (Buffer.byteLength(raw.payloadText) + Buffer.byteLength(raw.envelopeText) > xlsxLimits.inputBytes) throw new XlsxFailure("limit");
  let envelope;
  try { envelope = snapshotEnvelopeSchema.parse(JSON.parse(raw.envelopeText)); } catch { throw new XlsxFailure("invalid"); }
  if (hash(raw.envelopeText) !== raw.jsonHash || hash(raw.payloadText) !== envelope.payloadHash || canonical(envelope.data) !== raw.payloadText || canonical(envelope) !== raw.envelopeText) throw new XlsxFailure("invalid");
  const data = envelope.data;
  if (data.rowCount !== data.rows.length || data.rows.some(row => Object.keys(row).length !== data.columns.length || data.columns.some(column => !Object.hasOwn(row, column.key)))) throw new XlsxFailure("invalid");
  // Preflight all values before opening the archive; failures never leave partial output.
  const headers = data.columns.map(c => xlsxText(c.label));
  for (const row of data.rows) for (const column of data.columns) scalar(row[column.key]);
  const metadata: Record<string, unknown> = {
    export_format_version: "1", writer: "exceljs 4.4.0", artifact_kind: "Derived workbook; original JSON/CSV remain the retained artifacts",
    snapshot_id: envelope.id, report_id: data.reportId, report_version: data.reportVersion,
    envelope_schema_version: envelope.schemaVersion, data_schema_version: data.schemaVersion, source: data.source,
    name: data.name, description: data.description, as_of: data.asOf, source_read_started_at: data.sourceReadStartedAt,
    captured_at: envelope.capturedAt, reviewer_id: envelope.reviewerId, review_reason: envelope.reason,
    timezone: data.timezone, range: data.range, row_count: data.rowCount, source_row_count: data.sourceRowCount,
    payload_sha256: envelope.payloadHash, retained_json_sha256: raw.jsonHash, retained_csv_sha256: raw.csvHash,
    precision: data.source === "workforce" ? (data.schemaVersion === 2 ? "microseconds (version 2)" : "legacy milliseconds (version 1)") : "As captured; see selected column labels and source provenance",
    definition: data.definition, columns: data.columns, source_provenance: data.provenance, notice: data.notice,
    scalar_representation: "Data values are text; null is blank. Source JSON preserves exact original types and null versus empty string.",
    source_json_reconstruction: "Concatenate Source JSON chunk cells in numeric part order with no separators; encode UTF-8 and compare payload_sha256.",
  };
  const provenance: string[][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    const chunks = xlsxChunks(typeof value === "string" ? value : canonical(value));
    chunks.forEach((chunk, index) => provenance.push([key, String(index + 1), String(chunks.length), chunk]));
  }
  const source = xlsxChunks(raw.payloadText);
  if (provenance.length + source.length > xlsxLimits.metadataRows) throw new XlsxFailure("limit");
  const buffers: Buffer[] = []; let bytes = 0;
  const sink = new Writable({ write(chunk, _encoding, callback) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length;
    if (bytes > cap) callback(new XlsxFailure("limit")); else { buffers.push(part); callback(); }
  } });
  // Register before ExcelJS begins writing. Consume all error branches, including an early stream failure.
  let failure: unknown;
  sink.on("error", error => { failure = error; });
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false, useStyles: false });
  const failurePromise = new Promise<never>((_, reject) => sink.once("error", reject));
  void failurePromise.catch(() => {});
  try {
    const sheet = book.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = data.columns.map(() => ({ width: 26 }));
    sheet.addRow(headers).commit();
    for (const row of data.rows) sheet.addRow(data.columns.map(column => scalar(row[column.key]))).commit();
    sheet.commit();
    const proof = book.addWorksheet("Provenance"); proof.columns = [{ width: 32 }, { width: 10 }, { width: 10 }, { width: 90 }];
    proof.addRow(["Field", "Part", "Parts", "Value"]).commit(); for (const row of provenance) proof.addRow(row).commit(); proof.commit();
    const json = book.addWorksheet("Source JSON"); json.columns = [{ width: 10 }, { width: 90 }];
    json.addRow(["Part", "Exact payload chunk"]).commit(); source.forEach((chunk, index) => json.addRow([String(index + 1), chunk]).commit()); json.commit();
    await Promise.race([book.commit(), failurePromise]);
    if (failure) throw failure;
    return Buffer.concat(buffers, bytes);
  } catch (error) {
    // ExcelJS exposes the underlying archive at runtime; abort prevents further compression after a capped sink fails.
    (book as unknown as { zip: { abort(): void } }).zip.abort(); sink.destroy(); buffers.length = 0;
    throw error instanceof XlsxFailure ? error : new XlsxFailure("invalid");
  }
}
