import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { buildPayrollHoursReport, payrollHoursLimits, payrollHoursReportSchema } from '../shared/payroll-hours';
import { xlsxText } from './report-snapshot-xlsx';
import { XlsxFailure } from './report-snapshot-xlsx-contract';

const amountColumns = ['workHours', 'breakHours', 'totalHours', 'workMicroseconds', 'breakMicroseconds', 'totalMicroseconds', 'shiftCount', 'segmentCount', 'ongoingSegmentCount'] as const;
const numericColumns = ['workHoursNumeric', 'breakHoursNumeric', 'totalHoursNumeric'] as const;
const sourceColumns = ['id', 'shift_id', 'revision', 'user_id', 'employee_name', 'job_id', 'job_title', 'unit_id', 'unit_name', 'kind', 'started_at', 'ended_at',
  'recorded_duration_microseconds', 'clipped_started_at', 'clipped_ended_at', 'duration_microseconds'] as const;
const scalar = (value: string | number | null) => value === null ? null : xlsxText(String(value));
/** Approximate spreadsheet companions only. Guard the six-place decimal's
 * integer millionths within Excel's 15 significant digits and JS safe integers. */
export function payrollHoursNumeric(value: string): number {
  if (!/^(0|[1-9][0-9]{0,8})\.[0-9]{6}$/.test(value)) throw new XlsxFailure('invalid');
  const millionths = BigInt(value.replace('.', ''));
  if (millionths > 999_999_999_999_999n || millionths > BigInt(Number.MAX_SAFE_INTEGER)) throw new XlsxFailure('limit');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new XlsxFailure('invalid');
  return number;
}
const numeric = (value: { workHours: string; breakHours: string; totalHours: string }) =>
  [value.workHours, value.breakHours, value.totalHours].map(payrollHoursNumeric);
function chunks(value: string) {
  xlsxText(value, payrollHoursLimits.inputBytes);
  const output: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 16000, value.length);
    if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
    output.push(value.slice(offset, end)); offset = end;
  }
  return output;
}
/** Fixed workbook with exact text evidence and clearly named approximate numeric
 * hours companions; production calls this only in the bounded worker. */
export async function serializePayrollHoursXlsx(payloadText: string, maxBytes = payrollHoursLimits.outputBytes): Promise<Buffer> {
  if (typeof payloadText !== 'string' || Buffer.byteLength(payloadText) > payrollHoursLimits.inputBytes || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > payrollHoursLimits.outputBytes) throw new XlsxFailure('limit');
  let value;
  try {
    value = payrollHoursReportSchema.parse(JSON.parse(payloadText));
    if (JSON.stringify(buildPayrollHoursReport(value.report)) !== JSON.stringify(value)) throw new Error('Summary source mismatch');
  } catch { throw new XlsxFailure('invalid'); }
  const sheets: { name: string; headers: readonly string[]; rows: (string | number | null)[][] }[] = [
    { name: 'Employees', headers: ['userId', 'name', ...amountColumns, ...numericColumns], rows: value.employees.map(employee => [...[employee.userId, employee.name, ...amountColumns.map(key => employee[key])].map(scalar), ...numeric(employee)]) },
    { name: 'Jobs', headers: ['userId', 'employeeName', 'jobId', 'jobTitle', 'unitId', 'unitName', ...amountColumns, ...numericColumns], rows: value.employees.flatMap(employee => employee.jobs.map(job =>
      [...[employee.userId, employee.name, job.jobId, job.jobTitle, job.unitId, job.unitName, ...amountColumns.map(key => job[key])].map(scalar), ...numeric(job)])) },
    { name: 'Totals', headers: ['employeeCount', ...amountColumns, ...numericColumns], rows: [[...[value.totals.employeeCount, ...amountColumns.map(key => value.totals[key])].map(scalar), ...numeric(value.totals)]] },
    { name: 'Source segments', headers: sourceColumns, rows: value.report.rows.map(row => sourceColumns.map(key => scalar(row[key]))) },
  ];
  const metadata = {
    formatVersion: '1', summarySchemaVersion: '1', sourceSchemaVersion: '2', precisionVersion: '2', durationUnit: 'microsecond',
    asOf: value.report.asOf, timezone: value.report.timezone, query: JSON.stringify(value.report.query), range: JSON.stringify(value.report.range),
    sourceRowCount: String(value.report.sourceRowCount), contributingRowCount: String(value.report.contributingRowCount),
    payloadSha256: createHash('sha256').update(payloadText).digest('hex'), notice: value.notice, sourceNotice: value.report.notice,
    representation: 'Exact source and six-decimal hours are text; source nulls are blank. Only workHoursNumeric, breakHoursNumeric and totalHoursNumeric are numbers. Source JSON preserves exact types and null versus empty string.',
    numericHours: 'Numeric hours are approximate spreadsheet companions for formulas, derived from the final six-decimal text. They are not authoritative and infer no pay policy. Use exact microseconds for exact arithmetic. Each numeric companion is bounded to 15 significant decimal digits; formula sums can introduce further floating-point rounding.',
    reconstruction: 'Concatenate Source JSON chunks by numeric Part without separators, encode UTF-8, and verify payloadSha256. The JSON contains the full summary and original authorized report.',
  };
  sheets.push({ name: 'Provenance', headers: ['Field', 'Value'], rows: Object.entries(metadata).map(row => row.map(scalar)) });
  sheets.push({ name: 'Source JSON', headers: ['Part', 'Exact JSON chunk'], rows: chunks(payloadText).map((chunk, index) => [String(index + 1), chunk]) });
  const buffers: Buffer[] = []; let bytes = 0, failure: unknown;
  const sink = new Writable({ write(chunk, _encoding, callback) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length;
    if (bytes > maxBytes) callback(new XlsxFailure('limit')); else { buffers.push(part); callback(); }
  } });
  sink.on('error', error => { failure = error; });
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false, useStyles: false });
  const failed = new Promise<never>((_, reject) => sink.once('error', reject)); void failed.catch(() => {});
  try {
    for (const data of sheets) {
      const sheet = book.addWorksheet(data.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = data.headers.map(() => ({ width: 26 })); sheet.addRow([...data.headers]).commit();
      for (const row of data.rows) sheet.addRow(row).commit(); sheet.commit();
    }
    await Promise.race([book.commit(), failed]); if (failure) throw failure;
    return Buffer.concat(buffers, bytes);
  } catch (error) {
    (book as unknown as { zip: { abort(): void } }).zip.abort(); sink.destroy(); buffers.length = 0;
    throw error instanceof XlsxFailure ? error : new XlsxFailure('invalid');
  }
}
