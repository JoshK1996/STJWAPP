import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { initialDefinition, initialWorkforceDefinitionV2, outputColumns, reportDefinition, reportSources, type ReportSource } from "../shared/report-library";
import { snapshotEnvelopeSchema } from "../shared/report-snapshots";
import { canonicalSnapshot } from "../server/report-snapshots";
import { serializeSnapshotXlsx, xlsxChunks, xlsxText, xlsxLimits, type SnapshotXlsxInput } from "../server/report-snapshot-xlsx";
import { generateSnapshotXlsx, withSnapshotXlsxSlot } from "../server/report-snapshot-xlsx-runtime";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const instant = "2025-01-02T00:00:00.000000Z";
function fixture(source: ReportSource = "workforce", precise = false, values?: unknown[], count = 1): SnapshotXlsxInput {
  const definition: any = precise ? initialWorkforceDefinitionV2() : initialDefinition(source);
  if (source === "care") definition.programId = randomUUID();
  if (source === "grades") definition.bookId = randomUUID();
  if (source === "finance") Object.assign(definition, { unitId: randomUUID(), financialReportId: randomUUID() });
  if (source === "attendance") Object.assign(definition, { unitId: randomUUID(), yearId: randomUUID(), period: "Daily" });
  if (precise) { definition.columns = ["employee_name", "duration_microseconds", "recorded_duration_microseconds", "started_at", "ended_at"]; }
  reportDefinition.parse(definition);
  const columns = outputColumns(definition), cells = values ?? (precise ? ["Synthetic", "9007199254740993", null, instant, null] : ["Synthetic exact", "0000123", "0.1000", true, null, 9007199254740991, " =SUM(A1:A2)"]);
  const rows = Array.from({ length: count }, () => Object.fromEntries(columns.map((column, index) => [column.key, cells[index % cells.length]])));
  const data = { schemaVersion: precise ? 2 : 1, reportId: randomUUID(), reportVersion: 1, name: "Synthetic spreadsheet", description: "Only synthetic data", source, definition, columns, rows, rowCount: count, sourceRowCount: count, asOf: instant, sourceReadStartedAt: instant, timezone: "UTC", range: { from: "2025-01-01", to: "2025-01-01" }, notice: "Synthetic retained evidence", provenance: precise ? { sourceSchemaVersion: 2, precisionVersion: 2, durationUnit: "microsecond", asOf: instant, range: { from: "2025-01-01T00:00:00.000000Z", toExclusive: instant }, workMicroseconds: "9007199254740993", breakMicroseconds: "0", sourceRowCount: count, contributingRowCount: count } : { version: "original" }, ...(precise ? { precisionVersion: 2, durationUnit: "microsecond" } : {}) };
  const payloadText = canonicalSnapshot(data), envelope = snapshotEnvelopeSchema.parse({ schemaVersion: data.schemaVersion, id: randomUUID(), capturedAt: instant, reviewerId: randomUUID(), reason: "Reviewed synthetic report", payloadHash: hash(payloadText), data });
  const envelopeText = canonicalSnapshot(envelope);
  return { payloadText, envelopeText, jsonHash: hash(envelopeText), csvHash: hash("synthetic retained CSV") };
}
function cells(xml: string) {
  const values = new Map<string, { type: string; text: string }>(); let ref = "", type = "", text = "", inText = false;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", node => { if (node.name === "c") { ref = String(node.attributes.r); type = String(node.attributes.t ?? ""); text = ""; } if (node.name === "t" || node.name === "v") inText = true; });
  parser.on("text", chunk => { if (inText) text += chunk; });
  parser.on("closetag", node => { if (node.name === "t" || node.name === "v") inText = false; if (node.name === "c") values.set(ref, { type, text }); });
  parser.write(xml).close(); return values;
}
async function inspect(bytes: Buffer, input: SnapshotXlsxInput) {
  const zip = await JSZip.loadAsync(bytes), names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  assert.equal(names.filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 4);
  assert.ok(!names.some(name => /vba|externalLink|sharedStrings/i.test(name)));
  for (const name of names.filter(name => name.endsWith(".xml") || name.endsWith(".rels"))) {
    const xml = await zip.file(name)!.async("string"); new SaxesParser().write(xml).close();
    assert.doesNotMatch(xml, /<f(?:\s|>)|<hyperlink\b|TargetMode="External"|<!DOCTYPE/);
  }
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  for (const name of ["Report", "Data", "Provenance", "Source JSON"]) assert.ok(workbook.includes(`name="${name}"`));
  const data = cells(await zip.file("xl/worksheets/sheet2.xml")!.async("string"));
  for (const value of data.values()) assert.ok(["str", "inlineStr"].includes(value.type), value.type);
  const chunks = cells(await zip.file("xl/worksheets/sheet4.xml")!.async("string"));
  const payload = [...chunks].filter(([ref]) => /^B[2-9]\d*$|^B1\d+$/.test(ref)).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))).map(([, value]) => value.text).join("");
  assert.equal(payload, input.payloadText); assert.equal(hash(payload), JSON.parse(input.envelopeText).payloadHash);
  return { data, zip, provenance: cells(await zip.file("xl/worksheets/sheet3.xml")!.async("string")) };
}

test("all six legacy sources preserve scalar lexical values and exact payload bytes in independent OOXML", async () => {
  for (const source of reportSources) {
    const input = fixture(source), output = await serializeSnapshotXlsx(input), found = await inspect(output, input);
    assert.equal(found.data.get("B2")!.text, "0000123"); assert.equal(found.data.get("C2")!.text, "0.1000"); assert.equal(found.data.get("D2")!.text, "true");
  }
});
test("v2 duration strings above safe numeric range and UTC6/null evidence are retained", async () => {
  const input = fixture("workforce", true), found = await inspect(await serializeSnapshotXlsx(input), input);
  assert.equal(found.data.get("B2")!.text, "9007199254740993"); assert.equal(found.data.get("D2")!.text, instant);
  assert.equal(JSON.parse(input.payloadText).rows[0].recorded_duration_microseconds, null);
  assert.ok([...found.provenance.values()].some(cell => cell.text === "microseconds (version 2)"));
});
test("readable workbook opens with a styled hours report while exact source sheets retain their original cells", async () => {
  const input = fixture("workforce", true), found = await inspect(await serializeSnapshotXlsx(input), input);
  const sheetXml = await found.zip.file("xl/worksheets/sheet1.xml")!.async("string"), report = cells(sheetXml);
  assert.equal(report.get("A1")!.text, "Synthetic spreadsheet");
  assert.equal(report.get("B7")!.text, "2,501,999.79");
  assert.equal(report.get("C7")!.text, "—");
  assert.equal(found.data.get("B2")!.text, "9007199254740993");
  assert.match(sheetXml, /ySplit="6"/);
  assert.match(sheetXml, /autoFilter ref="A6:E7"/);
  assert.match(sheetXml, /orientation="portrait"/);
  assert.match(await found.zip.file("xl/styles.xml")!.async("string"), /FF17355E/);
  const workbook = await found.zip.file("xl/workbook.xml")!.async("string");
  assert.ok(workbook.indexOf('name="Report"') < workbook.indexOf('name="Data"'));
  assert.match(workbook, /name="_xlnm.Print_Titles"[^>]*>[^<]*\$6:\$6</);
  assert.doesNotMatch(workbook, /\$1:\$6/);
});
test("long title description and cells wrap or visibly abbreviate without changing retained source values", async () => {
  const input = fixture("workforce", false, ["W".repeat(5000)]);
  const envelope = JSON.parse(input.envelopeText);
  envelope.data.name = "W".repeat(100);
  envelope.data.description = "Synthetic report description with wide WWW headings. ".repeat(9);
  envelope.data.notice = "Synthetic notice\n".repeat(100);
  const payloadText = canonicalSnapshot(envelope.data); envelope.payloadHash = hash(payloadText);
  const envelopeText = canonicalSnapshot(envelope), next = { ...input, payloadText, envelopeText, jsonHash: hash(envelopeText) };
  const found = await inspect(await serializeSnapshotXlsx(next), next);
  const reportXml = await found.zip.file("xl/worksheets/sheet1.xml")!.async("string"), report = cells(reportXml);
  const heights = new Map<number, number>(), parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", node => { if (node.name === "row") heights.set(Number(node.attributes.r), Number(node.attributes.ht)); });
  parser.write(reportXml).close();
  const rowHeight = (row: number) => heights.get(row)!;
  assert.ok(rowHeight(1) > 44 && rowHeight(1) <= 360);
  assert.ok(rowHeight(4) > 36 && rowHeight(4) <= 360);
  assert.ok(rowHeight(5) <= 360);
  assert.ok(rowHeight(7) > 120 && rowHeight(7) <= 300);
  assert.ok(report.get("A7")!.text.replaceAll("\n", " ").includes("[full text: Data]"));
  assert.ok(report.get("A5")!.text.replaceAll("\n", " ").includes("[full text: Source JSON]"));
  assert.equal(found.data.get("A2")!.text, "W".repeat(5000));
});
test("formula-like text whitespace LF XML punctuation and Unicode are literal text without formulas", async () => {
  const values = ["=SUM(A1:A2)", "+1", "-1", "@name", " \t\n quoted <&> \" ' 😀 é ", "00001", "https://example.test/"];
  const input = fixture("workforce", false, values), found = await inspect(await serializeSnapshotXlsx(input), input);
  values.forEach((value, index) => assert.equal(found.data.get(String.fromCharCode(65 + index) + "2")!.text, value));
});
test("unsupported writer transformations fail explicitly without silent text changes", async () => {
  for (const value of ["a\rb", "a\r\nb", "a\u0000b", "a\u000bb", "a\u007fb", "\uffff", "\ud800", "_x0041_", "_x000d_", "_X00aF_", "_x005F_x0041_"]) {
    const input = fixture("workforce", false, [value]); await assert.rejects(serializeSnapshotXlsx(input), (error: any) => error.code === "unsupported");
  }
});
test("cell cap and surrogate-safe chunks preserve exact values at boundaries", async () => {
  assert.equal(xlsxText("x".repeat(32767)).length, 32767); assert.throws(() => xlsxText("x".repeat(32768)), (e: any) => e.code === "limit");
  const value = "a".repeat(15999) + "😀" + "b".repeat(17000), chunks = xlsxChunks(value);
  assert.equal(chunks.join(""), value); assert.ok(chunks.every(chunk => chunk.length <= 16000));
  const input = fixture("workforce", false, ["x".repeat(32767)]); await inspect(await serializeSnapshotXlsx(input), input);
});
test("maximum row count passes through actual capped worker without losing the final record", async () => {
  const input = fixture("workforce", false, ["r"], 20000);
  assert.ok(Buffer.byteLength(input.payloadText) + Buffer.byteLength(input.envelopeText) <= xlsxLimits.inputBytes);
  const output = await generateSnapshotXlsx(input), found = await inspect(output.buffer, input);
  assert.equal(found.data.get("A20001")!.text, "r"); assert.equal(found.data.size, 20001 * 7);
  const changed = JSON.parse(input.envelopeText); changed.data.rows.push(changed.data.rows[0]); changed.data.rowCount++; changed.data.sourceRowCount++;
  const payloadText = canonicalSnapshot(changed.data); changed.payloadHash = hash(payloadText); const envelopeText = canonicalSnapshot(changed);
  await assert.rejects(serializeSnapshotXlsx({ ...input, payloadText, envelopeText, jsonHash: hash(envelopeText) }), (e: any) => e.code === "invalid");
});
test("empty snapshot contains only Data headers and complete provenance/source evidence", async () => {
  const input = fixture("workforce", true, undefined, 0), found = await inspect(await serializeSnapshotXlsx(input), input);
  assert.equal(found.data.size, JSON.parse(input.payloadText).columns.length);
  assert.ok([...found.provenance.values()].some(cell => cell.text === "0"));
});
test("invalid hashes schema versions payloads and excessive source/output reject", async () => {
  const input = fixture();
  await assert.rejects(serializeSnapshotXlsx({ ...input, jsonHash: "0".repeat(64) }), (e: any) => e.code === "invalid");
  const changed = JSON.parse(input.envelopeText); changed.schemaVersion = 3; const text = canonicalSnapshot(changed);
  await assert.rejects(serializeSnapshotXlsx({ ...input, envelopeText: text, jsonHash: hash(text) }), (e: any) => e.code === "invalid");
  await assert.rejects(serializeSnapshotXlsx({ ...input, payloadText: "x".repeat(xlsxLimits.inputBytes) }), (e: any) => e.code === "limit");
  await assert.rejects(serializeSnapshotXlsx(input, 100), (e: any) => e.code === "limit");
});
test("actual empty-environment worker loads fixed ESM entry and emits bounded exact bytes", async () => {
  const input = fixture("workforce", true), result = await generateSnapshotXlsx(input);
  assert.equal(result.hash, hash(result.buffer)); assert.equal(result.bytes, result.buffer.length); assert.equal(result.formatVersion, 2);
  await inspect(result.buffer, input);
});
test("actual worker timeout cancellation and output cap fail cleanly then allow success", async () => {
  const input = fixture();
  await assert.rejects(generateSnapshotXlsx(input, { deadlineMs: 1 }), (e: any) => e.status === 503);
  const controller = new AbortController(), pending = generateSnapshotXlsx(input, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (e: any) => e.status === 499);
  await assert.rejects(generateSnapshotXlsx(input, { maxBytes: 100 }), (e: any) => e.status === 422);
  assert.ok((await generateSnapshotXlsx(input)).bytes > 100);
});
test("one process/account slot rejects contenders and releases on failure", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withSnapshotXlsxSlot("synthetic-a", () => gate);
  await assert.rejects(withSnapshotXlsxSlot("synthetic-a", async () => {}), (e: any) => e.status === 429);
  await assert.rejects(withSnapshotXlsxSlot("synthetic-b", async () => {}), (e: any) => e.status === 429);
  release(); await first;
  await assert.rejects(withSnapshotXlsxSlot("synthetic-a", async () => { throw new Error("synthetic failure"); }));
  assert.equal(await withSnapshotXlsxSlot("synthetic-b", async () => 7), 7);
});
