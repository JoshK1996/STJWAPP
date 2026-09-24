import { z } from 'zod';
import { workforceReportQueryV2Schema, workforceReportV2Schema, workforceV2Limits, type WorkforceReportV2 } from './workforce-reports-v2';

export const payrollHoursLimits = Object.freeze({ inputBytes: 16 * 1024 * 1024, outputBytes: 32 * 1024 * 1024, deadlineMs: 15000, heapMb: 192 });
export const payrollHoursQuerySchema = workforceReportQueryV2Schema;
export const payrollHoursExportQuerySchema = workforceReportQueryV2Schema.safeExtend({ format: z.enum(['csv', 'xlsx', 'json']).default('csv') });
const micros = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const hours = z.string().regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/);
const count = z.number().int().min(0).max(workforceV2Limits.rows);
const label = z.string().min(1).max(500);
const amounts = { workMicroseconds: micros, breakMicroseconds: micros, totalMicroseconds: micros,
  workHours: hours, breakHours: hours, totalHours: hours, shiftCount: count, segmentCount: count, ongoingSegmentCount: count };
export const payrollHoursJobSchema = z.object({ jobId: z.uuid(), jobTitle: label, unitId: z.uuid(), unitName: label, ...amounts }).strict();
export const payrollHoursEmployeeSchema = z.object({ userId: z.uuid(), name: label, ...amounts, jobs: z.array(payrollHoursJobSchema).max(workforceV2Limits.rows) }).strict();
export const payrollHoursReportSchema = z.object({
  schemaVersion: z.literal(1), report: workforceReportV2Schema,
  employees: z.array(payrollHoursEmployeeSchema).max(workforceV2Limits.staff),
  totals: z.object({ ...amounts, employeeCount: count }).strict(), notice: z.string().max(2000),
}).strict();
export type PayrollHoursReport = z.infer<typeof payrollHoursReportSchema>;
export type PayrollHoursEmployee = z.infer<typeof payrollHoursEmployeeSchema>;
export type PayrollHoursJob = z.infer<typeof payrollHoursJobSchema>;

/** Positive decimal hours, half-up to six places AFTER exact aggregation. */
export function payrollDecimalHours(microseconds: bigint): string {
  if (microseconds < 0n) throw new RangeError('Hours cannot be negative.');
  const millionths = (microseconds + 1800n) / 3600n;
  return `${millionths / 1_000_000n}.${(millionths % 1_000_000n).toString().padStart(6, '0')}`;
}
type Accumulator = { work: bigint; breaks: bigint; shifts: Set<string>; segments: number; ongoing: number };
const accumulator = (): Accumulator => ({ work: 0n, breaks: 0n, shifts: new Set(), segments: 0, ongoing: 0 });
function finish(value: Accumulator) {
  return { workMicroseconds: String(value.work), breakMicroseconds: String(value.breaks), totalMicroseconds: String(value.work + value.breaks),
    workHours: payrollDecimalHours(value.work), breakHours: payrollDecimalHours(value.breaks), totalHours: payrollDecimalHours(value.work + value.breaks),
    shiftCount: value.shifts.size, segmentCount: value.segments, ongoingSegmentCount: value.ongoing };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Pure projection only: authorization belongs to the service publication wrapper. */
export function buildPayrollHoursReport(raw: WorkforceReportV2): PayrollHoursReport {
  const report = workforceReportV2Schema.parse(raw), total = accumulator(), seen = new Set<string>();
  const employees = new Map<string, { name: string; totals: Accumulator; jobs: Map<string, { jobTitle: string; unitId: string; unitName: string; totals: Accumulator }> }>();
  for (const row of report.rows) {
    if (seen.has(row.id)) throw new RangeError('Duplicate report segment.'); seen.add(row.id);
    let employee = employees.get(row.user_id);
    if (!employee) { employee = { name: row.employee_name, totals: accumulator(), jobs: new Map() }; employees.set(row.user_id, employee); }
    if (employee.name !== row.employee_name) throw new RangeError('Inconsistent employee source identity.');
    let job = employee.jobs.get(row.job_id);
    if (!job) { job = { jobTitle: row.job_title, unitId: row.unit_id, unitName: row.unit_name, totals: accumulator() }; employee.jobs.set(row.job_id, job); }
    if (job.jobTitle !== row.job_title || job.unitId !== row.unit_id || job.unitName !== row.unit_name) throw new RangeError('Inconsistent job source identity.');
    for (const value of [total, employee.totals, job.totals]) {
      if (row.kind === 'work') value.work += BigInt(row.duration_microseconds); else value.breaks += BigInt(row.duration_microseconds);
      value.shifts.add(row.shift_id); value.segments++; if (row.ended_at === null) value.ongoing++;
    }
  }
  if (report.sourceRowCount !== report.rows.length || total.work.toString() !== report.workMicroseconds || total.breaks.toString() !== report.breakMicroseconds)
    throw new RangeError('Report totals do not match complete source rows.');
  return payrollHoursReportSchema.parse({ schemaVersion: 1, report,
    employees: [...employees].map(([userId, employee]) => ({ userId, name: employee.name, ...finish(employee.totals),
      jobs: [...employee.jobs].map(([jobId, job]) => ({ jobId, jobTitle: job.jobTitle, unitId: job.unitId, unitName: job.unitName, ...finish(job.totals) }))
        .sort((a, b) => compare(a.unitName, b.unitName) || compare(a.jobTitle, b.jobTitle) || compare(a.jobId, b.jobId)),
    })).sort((a, b) => compare(a.name, b.name) || compare(a.userId, b.userId)),
    totals: { ...finish(total), employeeCount: employees.size },
    notice: 'Hours summary, not calculated or certified payroll. Exact microseconds are authoritative; decimal hours are rounded half-up to six places after aggregation. Total hours include work and breaks without assuming breaks are paid. Counts include all selected source segments, including zero contributions. Ongoing counts identify segments with no recorded end, not approval or whole-shift status. Each download reads current authorized data and may differ from an earlier preview.',
  });
}
