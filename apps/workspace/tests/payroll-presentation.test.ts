import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';
import { SaxesParser } from 'saxes';
import { aggregateSegmentsV2 } from '../server/reports-v2';
import { buildPayrollHoursReport } from '../shared/payroll-hours';
import { workforceInstantMicroseconds, workforceUtcFromMicroseconds, type WorkforceSourceRowV2 } from '../shared/workforce-reports-v2';
import { buildPayrollPresentationTable, defaultPayrollPresentationOptions, payrollPresentationHours, payrollPresentationOptionsSchema, payrollPresentationRows } from '../shared/payroll-presentation';
import { payrollPresentationContext, payrollPresentationCsv } from '../server/payroll-presentation';
import { serializePayrollHoursXlsx } from '../server/payroll-hours-xlsx';
import { generatePayrollHoursXlsx } from '../server/payroll-hours-xlsx-runtime';

const start = '2026-09-20T14:00:00.000000Z', captured = '2026-09-21T00:00:00.000000Z';
const person = randomUUID(), job = randomUUID(), unit = randomUUID(), shift = randomUUID();
const options = defaultPayrollPresentationOptions;
function segment(micros: bigint, changes: Partial<WorkforceSourceRowV2> = {}): WorkforceSourceRowV2 {
  return { id: randomUUID(), shift_id: shift, revision: 1, user_id: person, employee_name: 'Synthetic employee', job_id: job, job_title: 'School office', unit_id: unit, unit_name: 'School', kind: 'work', started_at: start,
    ended_at: workforceUtcFromMicroseconds(workforceInstantMicroseconds(start) + micros), ...changes };
}
function report(rows: WorkforceSourceRowV2[] = [segment(3_600_000_000n), segment(900_000_000n, { kind: 'break' })]) {
  return buildPayrollHoursReport(aggregateSegmentsV2(rows, { start: '2026-09-20', end: '2026-09-20' }, 'America/New_York', captured));
}
async function workbook(payload: string, presentation = options) {
  const bytes = await serializePayrollHoursXlsx(payload, undefined, presentation), book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as any); return { book, bytes, zip: await JSZip.loadAsync(bytes) };
}

test('readable hours round directly from exact aggregates without six-decimal double rounding', () => {
  assert.equal(payrollPresentationHours('17999999', 2), '0.00');
  assert.equal(payrollPresentationHours('18000000', 2), '0.01');
  assert.equal(payrollPresentationHours('1800000', 3), '0.001');
  assert.equal(payrollPresentationHours('180000', 4), '0.0001');
  assert.equal(payrollPresentationHours('999999999999999999999', 4), '277777777777.7778');
  const value = report([segment(9_000_000n), segment(9_000_000n)]);
  assert.equal(buildPayrollPresentationTable(value, options).rows[0][1], '0.01');
  assert.equal(value.totals.workMicroseconds, '18000000');
  for (const invalid of ['-1', '01', '1.2', '1e10', 'Infinity']) assert.throws(() => payrollPresentationHours(invalid));
});

test('presentation choices reject duplicates, hidden work hours and unknown or unbounded settings', () => {
  for (const raw of [{ columns: [] }, { columns: ['breakHours'] }, { columns: ['workHours', 'workHours'] }, { decimalPlaces: 15 }, { grouping: 'all_totals' }, { title: 'a\nb' }, { title: 'x'.repeat(101) }, { includeAudit: 'true' }, { grossPay: true }])
    assert.equal(payrollPresentationOptionsSchema.safeParse(raw).success, false);
  assert.equal(options.decimalPlaces, 2); assert.equal(options.includeAudit, false);
});

test('employee and job layouts use names, selected ordered columns and distinct overall totals', () => {
  const secondJob = randomUUID(), secondPerson = randomUUID();
  const value = report([segment(3_600_000_000n), segment(1_800_000_000n, { job_id: secondJob, job_title: 'After-school care' }),
    segment(7_200_000_000n, { user_id: secondPerson, employee_name: 'Other employee', shift_id: randomUUID() })]);
  const chosen = payrollPresentationOptionsSchema.parse({ grouping: 'jobs', columns: ['workHours', 'shiftCount'], sortBy: 'work_hours' });
  const table = buildPayrollPresentationTable(value, chosen);
  assert.deepEqual(table.columns.map(column => column.label), ['Employee', 'Job', 'Department', 'Work hours', 'Shifts']);
  assert.equal(table.rows.length, 3); assert.equal(table.rows[0][0], 'Other employee'); assert.equal(table.rows[0][3], '2.00');
  assert.equal(table.totals[3], '3.50'); assert.equal(table.totals[4], '2');
  assert.ok(!JSON.stringify(table).includes(person)); assert.ok(!JSON.stringify(table).includes(secondJob));
  assert.equal(payrollPresentationRows(value, options).length, 2);
});

test('same-name employees remain distinguishable within the report without exposing IDs', () => {
  const value = report([segment(1n), segment(2n, { user_id: randomUUID(), shift_id: randomUUID() })]);
  const names = buildPayrollPresentationTable(value, options).rows.map(row => row[0]);
  assert.deepEqual(names, ['Synthetic employee (person 1)', 'Synthetic employee (person 2)']);
});

test('readable CSV is one aggregation level with formula protection and friendly context', () => {
  const value = report([segment(3_600_000_000n, { employee_name: '=Synthetic name', job_title: '+Synthetic job' })]);
  const csv = payrollPresentationCsv(value, { ...options, grouping: 'jobs', columns: ['workHours'] });
  const rows = parse(csv, { columns: true, bom: true }) as Record<string, string>[];
  assert.equal(rows.length, 1); assert.equal(rows[0].Employee, "'=Synthetic name"); assert.equal(rows[0].Job, "'+Synthetic job");
  assert.equal(rows[0]['Work hours'], '1.00'); assert.equal(rows[0]['Period start'], 'Sep 20, 2026');
  assert.match(rows[0]['Captured at'], /Sep 20, 2026, 8:00:00 PM EDT/);
  assert.equal(rows[0]['Time zone'], 'America/New_York');
  assert.ok(!csv.includes(person)); assert.ok(!csv.includes('work_microseconds')); assert.ok(!csv.includes('0.000000'));
  assert.deepEqual(parse(payrollPresentationCsv(report([]), options), { columns: true, bom: true }), []);
});

test('Excel has readable numeric cells, color hierarchy, data bars, frozen/filter headers and print settings', async () => {
  const value = report(), { book, zip } = await workbook(JSON.stringify(value));
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Report overview', 'Employee hours']);
  const overview = book.worksheets[0], details = book.worksheets[1];
  assert.equal(overview.getCell('A1').value, 'Employee hours report'); assert.equal(overview.getCell('A7').value, 1);
  assert.equal(details.getCell('A7').value, 'Synthetic employee'); assert.equal(details.getCell('B7').value, 1); assert.equal(details.getCell('C7').value, 0.25);
  assert.equal(details.getCell('B7').numFmt, '#,##0.00'); assert.equal(details.getCell('D7').numFmt, '#,##0');
  assert.equal(details.views[0].state, 'frozen'); assert.equal((details.views[0] as any).ySplit, 6);
  assert.equal(details.pageSetup.fitToWidth, 1); assert.equal(details.pageSetup.printTitlesRow, '1:6');
  assert.deepEqual(details.autoFilter, 'A6:E7');
  const styles = await zip.file('xl/styles.xml')!.async('string'); assert.match(styles, /FF245CB9/); assert.match(styles, /FF087F8C/);
  const chart = await zip.file('xl/worksheets/sheet1.xml')!.async('string'); assert.match(chart, /dataBar/); assert.match(chart, /FF68C9C3/);
  for (const name of Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name))) {
    const xml = await zip.file(name)!.async('string'); new SaxesParser().write(xml).close();
    assert.doesNotMatch(xml, /<f(?:\s|>)|<hyperlink\b|TargetMode="External"|<!DOCTYPE/); assert.ok(!xml.includes(person));
  }
});

test('custom titles and formula-like names are text cells; selection applies to detail columns', async () => {
  const value = report([segment(3_605_400_000n, { employee_name: '=Synthetic name' })]);
  const selected = { ...options, title: '=Review, not a formula', decimalPlaces: 3 as const, columns: ['workHours' as const] };
  const { book } = await workbook(JSON.stringify(value), selected), sheet = book.worksheets[1];
  assert.equal(sheet.getCell('A1').value, '=Review, not a formula'); assert.equal(sheet.getCell('A7').value, '=Synthetic name');
  assert.equal(sheet.getCell('B7').value, 1.002); assert.equal(sheet.getCell('B7').numFmt, '#,##0.000');
  assert.equal(sheet.getCell('C6').value, null); assert.equal(sheet.getCell('C7').value, null);
});

test('optional audit sheets preserve the original payload and default legacy export is unchanged', async () => {
  const value = report(), payload = JSON.stringify(value) + '\n';
  const { book } = await workbook(payload, { ...options, includeAudit: true });
  assert.equal(book.worksheets.length, 8); assert.equal(book.getWorksheet('Employees')!.getCell('A2').value, person);
  const chunks: string[] = []; book.getWorksheet('Source JSON')!.eachRow((row, index) => { if (index > 1) chunks.push(String(row.getCell(2).value)); });
  assert.equal(chunks.join(''), payload);
  const legacy = new ExcelJS.Workbook(); await legacy.xlsx.load(await serializePayrollHoursXlsx(payload) as any);
  assert.deepEqual(legacy.worksheets.map(sheet => sheet.name), ['Employees', 'Jobs', 'Totals', 'Source segments', 'Provenance', 'Source JSON']);
});

test('empty reports and open records remain explicit with numeric zeros', async () => {
  const { book } = await workbook(JSON.stringify(report([])));
  assert.equal(book.worksheets[0].getCell('A7').value, 0); assert.match(String(book.worksheets[1].getCell('A7').value), /No time records/);
  assert.equal(book.worksheets[1].getCell('B9').value, 0);
  const open = report([segment(0n, { ended_at: null })]);
  const generated = await workbook(JSON.stringify(open));
  assert.equal(generated.book.worksheets[0].getCell('D7').value, 1);
  assert.equal(generated.book.worksheets[0].getCell('D13').value, '1 open');
  assert.match(payrollPresentationContext(open).capturedAt, /EDT/);
});

test('bounded empty-environment worker honors presentation, audit selection, invalid settings and output cap', async () => {
  const payload = JSON.stringify(report());
  const result = await generatePayrollHoursXlsx(payload, { presentation: { ...options, grouping: 'jobs' } });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(result.buffer as any);
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Report overview', 'Hours by job']);
  await assert.rejects(generatePayrollHoursXlsx(payload, { presentation: options, maxBytes: 100 }), (error: any) => error.status === 422);
  await assert.rejects(generatePayrollHoursXlsx(payload, { presentation: { ...options, decimalPlaces: 99 } as any }), (error: any) => error.status === 422);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generatePayrollHoursXlsx(payload, { presentation: options, signal: controller.signal }), (error: any) => error.status === 499);
});
