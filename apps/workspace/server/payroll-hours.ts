import type { Database } from './db';
import { payrollPresentationCsv } from './payroll-presentation';
import { audit, canReport, requireCondition, type Actor } from './security';
import { readWorkforceReportSourceV2 } from './reports-v2';
import { toCsv } from './reports';
import { withAuthorizedWorkforceSource, type WorkforceReportProof } from './workforce-report-access';
import { buildPayrollHoursReport, payrollHoursExportQuerySchema, payrollHoursLimits, payrollHoursQuerySchema, type PayrollHoursReport } from '../shared/payroll-hours';
import { withSpreadsheetSlot } from './spreadsheet-admission';
import { generatePayrollHoursXlsx } from './payroll-hours-xlsx-runtime';

export const payrollHoursCsvColumns = ['row_kind', 'user_id', 'employee_name', 'job_id', 'job_title', 'unit_id', 'unit_name', 'work_hours', 'break_hours', 'total_hours',
  'work_microseconds', 'break_microseconds', 'total_microseconds', 'shift_count', 'segment_count', 'ongoing_segment_count', 'employee_count', 'as_of', 'timezone', 'start', 'end', 'precision', 'notice'];
export function payrollHoursCsv(value: PayrollHoursReport): string {
  const evidence = { as_of: value.report.asOf, timezone: value.report.timezone, start: value.report.query.start, end: value.report.query.end,
    precision: 'Exact microseconds; decimal hours half-up to 6 places after aggregation', notice: value.notice };
  const amount = (row: PayrollHoursReport['totals'] | PayrollHoursReport['employees'][number]) => ({
    work_hours: row.workHours, break_hours: row.breakHours, total_hours: row.totalHours, work_microseconds: row.workMicroseconds,
    break_microseconds: row.breakMicroseconds, total_microseconds: row.totalMicroseconds, shift_count: row.shiftCount, segment_count: row.segmentCount, ongoing_segment_count: row.ongoingSegmentCount,
  });
  const rows: Record<string, unknown>[] = [];
  for (const employee of value.employees) {
    rows.push({ row_kind: 'employee', user_id: employee.userId, employee_name: employee.name, ...amount(employee), ...evidence });
    for (const job of employee.jobs) rows.push({ row_kind: 'job', user_id: employee.userId, employee_name: employee.name,
      job_id: job.jobId, job_title: job.jobTitle, unit_id: job.unitId, unit_name: job.unitName, ...amount({ ...employee, ...job }), ...evidence });
  }
  rows.push({ row_kind: 'total', ...amount(value.totals), employee_count: value.totals.employeeCount, ...evidence });
  return toCsv(rows, payrollHoursCsvColumns);
}
function payload(value: PayrollHoursReport) {
  const text = JSON.stringify(value) + '\n';
  requireCondition(Buffer.byteLength(text) <= payrollHoursLimits.inputBytes, 413, 'This hours summary is too large. Choose a shorter range or a single employee/unit.');
  return text;
}
export function getAuthorizedPayrollHours(db: Database, actor: Actor, proof: WorkforceReportProof, raw: unknown) {
  const query = payrollHoursQuerySchema.parse(raw);
  return withAuthorizedWorkforceSource(db, actor, proof, async (tx, current) => {
    requireCondition(canReport(current), 403, 'A current reporting role is required for payroll hours.');
    return readWorkforceReportSourceV2(tx, current, query);
  }, async (_tx, _current, source) => { const result = buildPayrollHoursReport(source); payload(result); return result; }, { repeatableRead: true });
}
export function exportAuthorizedPayrollHours(db: Database, actor: Actor, proof: WorkforceReportProof, raw: unknown, options: { signal?: AbortSignal } = {}) {
  const { format, presentation, ...query } = payrollHoursExportQuerySchema.parse(raw);
  requireCondition(format !== 'json' || presentation === undefined,400,'Source JSON keeps exact evidence; presentation options apply only to Excel and CSV.');
  const run = () => withAuthorizedWorkforceSource(db, actor, proof, async (tx, current) => {
    requireCondition(canReport(current), 403, 'A current reporting role is required for payroll hours.');
    return readWorkforceReportSourceV2(tx, current, query);
  }, async (tx, current, source) => {
    const result = buildPayrollHoursReport(source), text = payload(result);
    const body = format === 'xlsx' ? (await generatePayrollHoursXlsx(text, { ...options, presentation })).buffer : format === 'json' ? text : presentation ? payrollPresentationCsv(result,presentation) : payrollHoursCsv(result);
    requireCondition(!options.signal?.aborted, 499, 'Hours download was cancelled.');
    requireCondition(Buffer.byteLength(body) <= payrollHoursLimits.outputBytes, 413, 'This hours export is too large. Choose a shorter range or a single employee/unit.');
    await audit(tx, current, 'payroll.hours_exported', null, { query, format, ...(presentation ? { presentation } : {}), schemaVersion: 1, sourceSchemaVersion: 2, precisionVersion: 2,
      durationUnit: 'microsecond', sourceRowCount: source.rows.length, employeeCount: result.employees.length, asOf: source.asOf });
    requireCondition(!options.signal?.aborted, 499, 'Hours download was cancelled.');
    return { body, format, asOf: source.asOf, query };
  }, { repeatableRead: true });
  return format === 'xlsx' ? withSpreadsheetSlot(`${actor.org_id}:${actor.id}`, run) : run();
}
