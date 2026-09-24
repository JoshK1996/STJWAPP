import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { createImportWorkbookTemplate, parseImportWorkbook, workbookImportColumns } from '../server/import-workbook-parser.mjs';
import { runImportWorkbook, type WorkbookTemplate } from '../server/import-workbook-runtime';
import { parseCompensationCsv } from '../server/compensation-csv';
import { compensationCsvColumns } from '../shared/compensation';
import { workbookConvertResultSchemaFor, workbookTemplateInput, workbookInspectInput, workbookConvertInput } from '../shared/import-workbooks';

const userId = randomUUID(), jobId = randomUUID(), rateId = randomUUID();
const row = () => [userId, jobId, '7', rateId, '2026-01-01', '', '0.10', 'USD', 'hour', 'false', '=Literal café, "quoted" 🕊\nsecond line'];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const convert = (bytes: Uint8Array) => parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: 'compensation_rates', action: 'convert', bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: hash(bytes) });
async function changed(change: (sheet: ExcelJS.Worksheet) => void) {
  const template = await createImportWorkbookTemplate('compensation_rates', [row()]), book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(template.bytes) as any); change(book.worksheets[0]); return new Uint8Array(await book.xlsx.writeBuffer());
}
const csvRows = (csv: string): string[][] => parse(csv, { bom: true, skip_empty_lines: true });

test('pay workbook preserves exact text and current pair/version through the existing CSV parser', async () => {
  assert.deepEqual(workbookImportColumns.compensation_rates, compensationCsvColumns);
  const values = row(), template = await createImportWorkbookTemplate('compensation_rates', [values]);
  const result = await convert(template.bytes); workbookConvertResultSchemaFor('compensation_rates').parse(result);
  assert.deepEqual(csvRows(result.csv), [[...compensationCsvColumns], values]);
  const rates = parseCompensationCsv(result.csv, { userId, jobId, expectedVersion: 7, previous: [] });
  assert.equal(rates[0].amount, '0.1'); assert.equal(rates[0].note, values[10]); assert.equal(rates[0].id, rateId);
  assert.throws(() => parseCompensationCsv(result.csv, { userId, jobId, expectedVersion: 8, previous: [] }), (e: any) => e.status === 409);
  assert.equal(result.csvHash, hash(result.csv)); assert.equal(result.csvBytes, Buffer.byteLength(result.csv));
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(template.bytes) as any);
  assert.equal(book.worksheets[0].getCell('K201').numFmt, '@'); assert.equal(book.worksheets[0].getCell('A3').value, null);
});

test('pay headers may be reordered and padded but are never silently remapped or merged', async () => {
  const headers = [...compensationCsvColumns].reverse().map(name => ' ' + name + ' ');
  const result = await convert(await changed(sheet => { sheet.getRow(1).values = headers; sheet.getRow(2).values = row().reverse(); }));
  workbookConvertResultSchemaFor('compensation_rates').parse(result); assert.deepEqual(result.headers, headers);
  assert.deepEqual(csvRows(result.csv)[1], row().reverse());
  assert.equal(parseCompensationCsv(result.csv, { userId, jobId, expectedVersion: 7, previous: [] })[0].amount, '0.1');
  for (const change of [(s: ExcelJS.Worksheet) => { s.getCell('B1').value = ' userId '; }, (s: ExcelJS.Worksheet) => { s.getCell('L2').value = 'Must not disappear'; }])
    await assert.rejects(convert(await changed(change)), (e: any) => e.code === 'header_mismatch');
});

test('pay numeric/date/boolean/formula cells reject instead of changing compensation values', async () => {
  for (const value of [0.1, new Date('2026-01-01T00:00:00Z'), false, { formula: '1/10', result: 0.1 }])
    await assert.rejects(convert(await changed(sheet => { sheet.getCell('G2').value = value; })), (e: any) => ['non_text_cell', 'unsupported_feature'].includes(e.code));
});

test('pay note XML and line ending edge cases roundtrip exactly or explicitly reject before publication', async () => {
  let accepted = 0;
  for (const value of ['carriage\rreturn', 'windows\r\nline', 'control\u000bvalue', 'control\0value', 'literal _x000B_ and _x000D_', 'literal &amp; &#13; <tag>']) {
    const values = row(); values[10] = value; let template;
    try { template = await createImportWorkbookTemplate('compensation_rates', [values]); }
    catch (error) { assert.equal((error as any).code, 'unsupported_feature'); continue; }
    assert.equal(csvRows((await convert(template.bytes)).csv)[1][10], value); accepted++;
  }
  assert.ok(accepted > 0);
});

test('complete pay templates enforce 200 rows and exact 64000 UTF-8 bytes without truncation', async () => {
  const rows = Array.from({ length: 200 }, () => { const values = row(); values[3] = randomUUID(); values[10] = ''; return values; });
  const base = await convert((await createImportWorkbookTemplate('compensation_rates', rows)).bytes);
  let remaining = 64000 - base.csvBytes; assert.ok(remaining > 0 && remaining < 200000);
  for (const values of rows) {
    const bytes = Math.min(remaining, 1000); values[10] = 'é'.repeat(Math.floor(bytes / 2)) + (bytes % 2 ? 'x' : ''); remaining -= bytes;
  }
  assert.equal(remaining, 0);
  const template = await createImportWorkbookTemplate('compensation_rates', rows), result = await convert(template.bytes);
  workbookConvertResultSchemaFor('compensation_rates').parse(result); assert.equal(result.rowCount, 200); assert.equal(result.csvBytes, 64000); assert.equal(csvRows(result.csv).length, 201);
  rows.at(-1)![10] += 'x';
  await assert.rejects(createImportWorkbookTemplate('compensation_rates', rows), (e: any) => e.code === 'limit');
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(template.bytes) as any); book.worksheets[0].getCell('K201').value = rows.at(-1)![10];
  await assert.rejects(convert(new Uint8Array(await book.xlsx.writeBuffer())), (e: any) => e.code === 'limit');
  await assert.rejects(createImportWorkbookTemplate('compensation_rates', [...rows, row()]), (e: any) => e.code === 'invalid_input');
  await assert.rejects(convert(await changed(sheet => { for (let r = 3; r <= 202; r++) sheet.getRow(r).values = row(); })), (e: any) => e.code === 'limit');
});

test('pay rows remain a server-only template contract with bounded text and conservative record size', async () => {
  for (const rows of [undefined, [], [row().slice(1)], [[...row().slice(0, 10), { formula: '1+1' }]]])
    await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: 'compensation_rates', action: 'template', rows }), (e: any) => e.code === 'invalid_input');
  const huge = row(); huge[10] = 'é'.repeat(5000);
  await assert.rejects(createImportWorkbookTemplate('compensation_rates', [huge]), (e: any) => e.code === 'limit');
  const scope = { kind: 'compensation_rates', userId, jobId };
  assert.deepEqual(workbookTemplateInput.parse(scope), scope);
  for (const extra of [{ unitId: randomUUID() }, { rows: [row()] }, { assignmentId: randomUUID() }, { userId: [userId] }, { actorId: userId }])
    assert.equal(workbookTemplateInput.safeParse({ ...scope, ...extra }).success, false);
  assert.equal(workbookInspectInput.safeParse({ kind: 'compensation_rates', userId, base64: 'YQ==' }).success, false);
  assert.equal(workbookConvertInput.safeParse({ ...scope, base64: 'YQ==', sheetId: 1, headerRow: 1, expectedWorkbookHash: 'a'.repeat(64), expectedVersion: 7 }).success, false);
});

test('fixed real worker transports pay template rows and validates the converted exact result', async () => {
  const template = await runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: 'compensation_rates', action: 'template', rows: [row()] }) as WorkbookTemplate;
  assert.equal(template.hash, hash(template.buffer));
  const result = await runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: 'compensation_rates', action: 'convert', bytes: new Uint8Array(template.buffer), sheetId: 1, headerRow: 1, expectedWorkbookHash: template.hash });
  const converted = workbookConvertResultSchemaFor('compensation_rates').parse(result);
  assert.deepEqual(csvRows(converted.csv)[1], row());
});
