import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createImportWorkbookTemplate, parseImportWorkbook, workbookImportColumns } from '../server/import-workbook-parser.mjs';
import { schoolWorkbookKinds, workbookConvertResultSchemaFor, type WorkbookKind } from '../shared/import-workbooks';
import { schoolImportCatalog, type SchoolImportContext } from '../shared/school-imports';
import { parseSchoolCsv } from '../server/school-imports';

const id = '10000000-0000-4000-8000-000000000001';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
type SupportedSchoolKind = (typeof schoolWorkbookKinds)[number] extends `school_${infer Kind}` ? Kind : never;
const supportedSchoolKinds = schoolWorkbookKinds.map(kind => kind.slice(7) as SupportedSchoolKind);
const values: Record<SupportedSchoolKind, string[]> = {
  students: ['000012', 'Synthetic café, "name" 🕊', ''],
  enrollments: ['000012', '08', '2026-09-01', '2027-06-30', 'enrolled'],
  roster: ['000012', '2026-09-01', '2027-06-30'],
  households: ['', '0', 'Synthetic household', 'Line one\nLine two', 'false'],
  household_members: [id, '1', id, '1', 'guardian', 'false'],
  contacts: [id, '000012', '1', id, '1', '0', 'Emergency contact', 'false', 'true', 'false', 'keep', '', '', 'keep', ''],
};
function context(kind: SupportedSchoolKind): SchoolImportContext {
  return { kind, unitId: id, ...(kind === 'roster' ? { sectionId: id } : kind === 'enrollments' ? { yearId: id } : {}) } as SchoolImportContext;
}
const convert = (bytes: Uint8Array, kind: WorkbookKind) => parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind, action: 'convert', bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(bytes) });
async function filled(kind: SupportedSchoolKind, change?: (sheet: ExcelJS.Worksheet) => void) {
  const template = await createImportWorkbookTemplate(`school_${kind}`);
  assert.equal(template.hash, sha(template.bytes));
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(template.bytes) as any);
  const sheet = book.worksheets[0];
  assert.equal(sheet.getCell(501, schoolImportCatalog[kind].columns.length).numFmt, '@');
  assert.equal(sheet.getCell(2, 1).value, null);
  values[kind].forEach((value, i) => { sheet.getCell(2, i + 1).value = value; });
  change?.(sheet);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

for (const kind of supportedSchoolKinds) test(`school ${kind} blank Excel template preserves exact values through its existing CSV contract`, async () => {
  const target = `school_${kind}` as const;
  assert.deepEqual(workbookImportColumns[target], schoolImportCatalog[kind].columns);
  const bytes = await filled(kind), converted = await convert(bytes, target);
  workbookConvertResultSchemaFor(target).parse(converted);
  const expected = Object.fromEntries(schoolImportCatalog[kind].columns.map((column, i) => [column, values[kind][i]]));
  assert.deepEqual(parseSchoolCsv(context(kind), converted.csv), [expected]);
  assert.deepEqual(converted.rowMap, [{ csvRow: 2, worksheetRow: 2 }]);
  assert.equal(converted.workbookHash, sha(bytes));
  assert.equal(converted.rowCount, 1);
});

test('school imports reject other destinations and reordered, duplicate or extra columns', async () => {
  const roster = await filled('roster');
  await assert.rejects(convert(roster, 'school_students'), (error: any) => error.code === 'header_mismatch');
  for (const change of [
    (s: ExcelJS.Worksheet) => { s.getCell('A1').value = 'name'; s.getCell('B1').value = 'studentNumber'; },
    (s: ExcelJS.Worksheet) => { s.getCell('B1').value = 'studentNumber'; },
    (s: ExcelJS.Worksheet) => { s.getCell('D2').value = 'must never disappear'; },
  ]) await assert.rejects(convert(await filled('students', change), 'school_students'), (error: any) => error.code === 'header_mismatch');
  await assert.rejects(convert(await filled('contacts', s => { s.getCell('P2').value = 'extra permission'; }), 'school_contacts'), (error: any) => error.code === 'header_mismatch');
});

test('school dates, booleans, versions and formulas are never coerced from Excel values', async () => {
  for (const [kind, coordinate, value] of [
    ['students', 'C2', new Date('2020-01-01T00:00:00Z')],
    ['households', 'B2', 0],
    ['contacts', 'H2', true],
    ['roster', 'B2', { formula: 'TODAY()', result: 46288 }],
  ] as const) {
    const bytes = await filled(kind, sheet => { sheet.getCell(coordinate).value = value; });
    await assert.rejects(convert(bytes, `school_${kind}`), (error: any) => ['non_text_cell', 'unsupported_feature'].includes(error.code));
  }
});

test('school CSV record bound fails before an unusable converted result can publish', async () => {
  const bytes = await filled('households', sheet => { sheet.getCell('D2').value = 'é'.repeat(2100); });
  await assert.rejects(convert(bytes, 'school_households'), (error: any) => error.code === 'limit');
});

test('worker destination whitelist rejects prototypes and caller-defined headers', async () => {
  for (const kind of ['__proto__', 'constructor', 'school_grades', 'school_people', 'School_students']) {
    await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, action: 'template', kind }), (error: any) => error.code === 'invalid_input');
  }
  await assert.rejects(parseImportWorkbook({ schemaVersion: 1, parserVersion: 1, action: 'template', kind: 'school_students', columns: ['password'] }), (error: any) => error.code === 'invalid_input');
});

test('school literal formula-like text is retained without export-only escaping', async () => {
  const bytes = await filled('students', sheet => { sheet.getCell('B2').value = '=Literal synthetic name'; });
  const converted = await convert(bytes, 'school_students');
  assert.equal(parseSchoolCsv(context('students'), converted.csv)[0].name, '=Literal synthetic name');
});
