import { z } from 'zod';
import type { PayrollHoursReport } from './payroll-hours';

export const payrollPresentationColumns = ['workHours', 'breakHours', 'totalHours', 'shiftCount', 'ongoingSegmentCount'] as const;
export const payrollPresentationLabels: Record<typeof payrollPresentationColumns[number], string> = {
  workHours: 'Work hours', breakHours: 'Break hours', totalHours: 'Recorded hours incl. breaks',
  shiftCount: 'Shifts', ongoingSegmentCount: 'Open time records',
};
export const payrollPresentationOptionsSchema = z.object({
  title: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use a single-line report title.').default('Employee hours report'),
  decimalPlaces: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  grouping: z.enum(['employees', 'jobs']).default('employees'),
  sortBy: z.enum(['name', 'work_hours']).default('name'),
  columns: z.array(z.enum(payrollPresentationColumns)).min(1).max(payrollPresentationColumns.length)
    .refine(values => new Set(values).size === values.length, 'Choose each column once.')
    .refine(values => values.includes('workHours'), 'Work hours must remain visible.')
    .default(['workHours', 'breakHours', 'shiftCount', 'ongoingSegmentCount']),
  includeAudit: z.boolean().default(false),
}).strict();
export type PayrollPresentationOptions = z.infer<typeof payrollPresentationOptionsSchema>;
export type PayrollPresentationColumn = typeof payrollPresentationColumns[number];
export const defaultPayrollPresentationOptions: PayrollPresentationOptions = payrollPresentationOptionsSchema.parse({});

/** Display rounding applies once to an already aggregated exact duration. */
export function payrollPresentationHours(microseconds: string, decimalPlaces: 2 | 3 | 4 = 2): string {
  if (!/^(0|[1-9][0-9]{0,20})$/.test(microseconds) || ![2, 3, 4].includes(decimalPlaces)) throw new RangeError('Invalid hours presentation.');
  const scale = 10n ** BigInt(decimalPlaces), units = (BigInt(microseconds) * scale + 1_800_000_000n) / 3_600_000_000n;
  return `${units / scale}.${String(units % scale).padStart(decimalPlaces, '0')}`;
}
type Amounts = Pick<PayrollHoursReport['totals'], 'workMicroseconds' | 'breakMicroseconds' | 'totalMicroseconds' | 'shiftCount' | 'ongoingSegmentCount'>;
export function payrollPresentationValue(row: Amounts, column: PayrollPresentationColumn, options: Pick<PayrollPresentationOptions, 'decimalPlaces'>): string | number {
  if (column === 'shiftCount' || column === 'ongoingSegmentCount') return row[column];
  return payrollPresentationHours(row[column === 'workHours' ? 'workMicroseconds' : column === 'breakHours' ? 'breakMicroseconds' : 'totalMicroseconds'], options.decimalPlaces);
}
export type PayrollPresentationRow = { employee: string; job?: string; department?: string; amounts: Amounts };
/** The caller supplies the authorized immutable report, never a fresh identity lookup. */
export function payrollPresentationRows(value: PayrollHoursReport, raw: PayrollPresentationOptions): PayrollPresentationRow[] {
  const options = payrollPresentationOptionsSchema.parse(raw);
  const names = new Map<string, number>(), occurrences = new Map<string, number>();
  for (const employee of value.employees) names.set(employee.name, (names.get(employee.name) ?? 0) + 1);
  const rows = value.employees.flatMap<PayrollPresentationRow>(employee => {
    const occurrence = (occurrences.get(employee.name) ?? 0) + 1; occurrences.set(employee.name, occurrence);
    // Same-name people remain separate without exposing long internal identifiers.
    const name = (names.get(employee.name) ?? 0) > 1 ? `${employee.name} (person ${occurrence})` : employee.name;
    return options.grouping === 'jobs'
      ? employee.jobs.map(job => ({ employee: name, job: job.jobTitle, department: job.unitName, amounts: job }))
      : [{ employee: name, amounts: employee }];
  });
  if (options.sortBy === 'work_hours') rows.sort((left, right) => {
    const delta = BigInt(right.amounts.workMicroseconds) - BigInt(left.amounts.workMicroseconds);
    return delta > 0n ? 1 : delta < 0n ? -1 : 0;
  });
  return rows;
}
export function buildPayrollPresentationTable(value: PayrollHoursReport, raw: PayrollPresentationOptions) {
  const options = payrollPresentationOptionsSchema.parse(raw);
  const columns = [{ key: 'employee', label: 'Employee' }, ...(options.grouping === 'jobs' ? [{ key: 'job', label: 'Job' }, { key: 'department', label: 'Department' }] : []),
    ...options.columns.map(key => ({ key, label: payrollPresentationLabels[key] }))];
  return { columns,
    rows: payrollPresentationRows(value, options).map(row => [row.employee, ...(options.grouping === 'jobs' ? [row.job ?? '', row.department ?? ''] : []),
      ...options.columns.map(key => String(payrollPresentationValue(row.amounts, key, options)))]),
    totals: ['All selected records', ...(options.grouping === 'jobs' ? ['', ''] : []), ...options.columns.map(key => String(payrollPresentationValue(value.totals, key, options)))],
  };
}
export const payrollPresentationNotice = 'Recorded hours for review, not calculated or approved payroll. Break pay, overtime, taxes and deductions are not calculated. Display values are rounded after exact aggregation; rounded rows may not sum to the rounded total. A shift shared by jobs is counted once in the overall total. Open time records have no recorded end. Same-name person numbers distinguish people only within this report.';
