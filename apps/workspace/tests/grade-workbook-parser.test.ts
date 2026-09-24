import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { createImportWorkbookTemplate, parseImportWorkbook, workbookImportColumns } from "../server/import-workbook-parser.mjs";
import { runImportWorkbook, type WorkbookTemplate } from "../server/import-workbook-runtime";
import { parseGradeCsv } from "../server/grade-imports";
import { gradeImportColumns } from "../shared/grade-imports";
import { workbookInspectInput, workbookConvertInput, workbookTemplateInput, workbookConvertResultSchemaFor, workbookInspectResultSchema } from "../shared/import-workbooks";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const assignmentId = randomUUID(), studentId = randomUUID();
const row = () => [assignmentId, "7", "3", studentId, '=Literal café, "name" 🕊', "scored", "10.25", '=Literal note, "quoted"\nsecond line'];
const convert = (bytes: Uint8Array) => parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "convert", bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: hash(bytes) });
async function changed(change: (sheet: ExcelJS.Worksheet) => void) {
  const template = await createImportWorkbookTemplate("grade_scores", [row()]);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(template.bytes) as any); change(workbook.worksheets[0]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

test("populated grade template retains fixed identities, versions, exact text and existing CSV roundtrip", async () => {
  assert.deepEqual(workbookImportColumns.grade_scores, gradeImportColumns);
  const values = row(), template = await createImportWorkbookTemplate("grade_scores", [values]);
  assert.equal(template.hash, hash(template.bytes));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(template.bytes) as any);
  assert.equal(workbook.worksheets[0].getCell("H201").numFmt, "@"); assert.equal(workbook.worksheets[0].getCell("H3").value, null);
  const result = await convert(template.bytes); workbookConvertResultSchemaFor("grade_scores").parse(result);
  assert.deepEqual(parseGradeCsv(result.csv), [Object.fromEntries(gradeImportColumns.map((column, i) => [column, values[i]]))]);
  assert.equal(result.csvHash, hash(result.csv)); assert.equal(result.csvBytes, Buffer.byteLength(result.csv));
  assert.ok(result.csv.startsWith("\uFEFF")); assert.deepEqual(result.rowMap, [{ csvRow: 2, worksheetRow: 2 }]);
});

test("grade conversion accepts the existing exact unordered header set without remapping its order", async () => {
  const bytes = await changed(sheet => { sheet.getRow(1).values = [...gradeImportColumns].reverse(); sheet.getRow(2).values = row().reverse(); });
  const result = await convert(bytes); workbookConvertResultSchemaFor("grade_scores").parse(result);
  assert.deepEqual(result.headers, [...gradeImportColumns].reverse()); assert.equal(parseGradeCsv(result.csv)[0].points, "10.25");
});

test("generated grade text either roundtrips exactly or explicitly rejects XML sanitization", async () => {
  const samples = ["carriage\rreturn", "windows\r\nline", "control\u000bvalue", "control\u0000value", "literal _x000B_ and _x000D_", "literal &amp; &#13; <tag> &lt; &#xB;"];
  let roundtripped = 0;
  for (const sample of samples) {
    const values = row(); values[7] = sample;
    let template;
    try { template = await createImportWorkbookTemplate("grade_scores", [values]); }
    catch (error) { assert.equal((error as { code?: string }).code, "unsupported_feature", `Unexpected rejection for ${JSON.stringify(sample)}`); continue; }
    const result = await convert(template.bytes);
    assert.equal(parseGradeCsv(result.csv)[0].note, sample, `Altered publication for ${JSON.stringify(sample)}`);
    roundtripped++;
  }
  assert.ok(roundtripped > 0, "Literal escape-looking strings must remain usable");
});

test("grade template and conversion require1–200 captured rows without fabricating empty-roster scores", async () => {
  const values = Array.from({ length: 200 }, () => row());
  const template = await createImportWorkbookTemplate("grade_scores", values); assert.equal((await convert(template.bytes)).rowCount, 200);
  await assert.rejects(createImportWorkbookTemplate("grade_scores", [...values, row()]), (e: any) => e.code === "invalid_input");
  const tooMany = await changed(sheet => { for (let r = 3; r <= 202; r++) sheet.getRow(r).values = row(); });
  await assert.rejects(convert(tooMany), (e: any) => e.code === "limit");
  await assert.rejects(createImportWorkbookTemplate("grade_scores", []), (e: any) => e.code === "invalid_input");
});

test("grade template rows are bounded text only and unavailable on existing blank template tasks", async () => {
  for (const rows of [undefined, [row().slice(1)], [[...row().slice(0, 7), { formula: "1+1", result: 2 }]], [[...row().slice(0, 7), "x".repeat(8193)]]])
    await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "template", rows }), (e: any) => e.code === "invalid_input");
  for (const kind of ["finance", "school_students"])
    await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind, action: "template", rows: [row()] }), (e: any) => e.code === "invalid_input");
  await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "template", rows: [row()], columns: ["secret"] }), (e: any) => e.code === "invalid_input");
});

test("grade generated source must fit20k encoded records and200k CSV without truncation", async () => {
  const largeRow = row(); largeRow[4] = "a".repeat(7000); largeRow[5] = "b".repeat(7000); largeRow[7] = "c".repeat(7000);
  await assert.rejects(createImportWorkbookTemplate("grade_scores", [largeRow]), (e: any) => e.code === "limit");
  const many = Array.from({ length: 200 }, () => { const item = row(); item[7] = "é".repeat(1000); return item; });
  await assert.rejects(createImportWorkbookTemplate("grade_scores", many), (e: any) => e.code === "limit");
});

test("grade uploads reject actual numeric dates, booleans and formula scores instead of coercing them", async () => {
  for (const value of [10.25, new Date("2026-01-01T00:00:00Z"), true, { formula: "10+1", result: 11 }]) {
    const bytes = await changed(sheet => { sheet.getCell("G2").value = value; });
    await assert.rejects(convert(bytes), (e: any) => ["non_text_cell", "unsupported_feature"].includes(e.code));
  }
  for (const change of [(s: ExcelJS.Worksheet) => { s.getCell("I2").value = "must not disappear"; }, (s: ExcelJS.Worksheet) => { s.getCell("H1").value = "points"; }])
    await assert.rejects(convert(await changed(change)), (e: any) => e.code === "header_mismatch");
});

test("public grade workbook scope accepts only assignmentId and never supplied template rows", () => {
  assert.deepEqual(workbookTemplateInput.parse({ kind: "grade_scores", assignmentId }), { kind: "grade_scores", assignmentId });
  for (const extra of [{ rows: [row()] }, { unitId: randomUUID() }, { assignmentId: [assignmentId, assignmentId] }])
    assert.ok(!workbookTemplateInput.safeParse({ kind: "grade_scores", assignmentId, ...extra }).success);
  const bytes = "YQ==";
  assert.ok(!workbookInspectInput.safeParse({ kind: "grade_scores", base64: bytes }).success);
  assert.ok(!workbookConvertInput.safeParse({ kind: "grade_scores", assignmentId, base64: bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: "a".repeat(64), rows: [] }).success);
});

test("fixed real worker transports only grade text rows and validates its generated bytes", async () => {
  const template = await runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "template", rows: [row()] }) as WorkbookTemplate;
  assert.equal(template.hash, hash(template.buffer));
  const result = await runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "inspect", bytes: new Uint8Array(template.buffer), sheetId: 1 });
  const inspected = workbookInspectResultSchema.parse(result); assert.equal(inspected.samples[1].cells[6].value, "10.25");
});
