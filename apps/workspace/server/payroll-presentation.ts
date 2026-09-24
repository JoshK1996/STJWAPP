import { DateTime } from 'luxon';
import type { PayrollHoursReport } from '../shared/payroll-hours';
import { payrollPresentationLabels, payrollPresentationOptionsSchema, payrollPresentationRows, payrollPresentationValue, type PayrollPresentationOptions } from '../shared/payroll-presentation';
import { toCsv } from './reports';

export function payrollPresentationContext(value: PayrollHoursReport) {
  const date = (input: string) => DateTime.fromISO(input, { zone: 'UTC' }).setLocale('en-US').toFormat('MMM d, yyyy');
  const captured = DateTime.fromISO(value.report.asOf, { zone: value.report.timezone });
  if (!captured.isValid) throw new RangeError('Invalid report time zone.');
  return { start: date(value.report.query.start), end: date(value.report.query.end),
    period: `${date(value.report.query.start)} – ${date(value.report.query.end)}`,
    capturedAt: captured.setLocale('en-US').toFormat('MMM d, yyyy, h:mm:ss a ZZZZ'), timezone: value.report.timezone,
    scope: [value.report.query.unitId ? 'Selected department' : 'All authorized departments', value.report.query.userId ? 'Selected employee' : 'All authorized employees'].join(' · '),
  };
}
/** Flat data only: no subtotal rows that would double-count spreadsheet sums. */
export function payrollPresentationCsv(value: PayrollHoursReport, raw: PayrollPresentationOptions): string {
  const options = payrollPresentationOptionsSchema.parse(raw), context = payrollPresentationContext(value);
  const headers = ['Employee', ...(options.grouping === 'jobs' ? ['Job', 'Department'] : []),
    ...options.columns.map(key => payrollPresentationLabels[key]), 'Period start', 'Period end', 'Time zone', 'Captured at'];
  const rows = payrollPresentationRows(value, options).map(row => ({ Employee: row.employee, Job: row.job, Department: row.department,
    ...Object.fromEntries(options.columns.map(key => [payrollPresentationLabels[key], payrollPresentationValue(row.amounts, key, options)])),
    'Period start': context.start, 'Period end': context.end, 'Time zone': context.timezone, 'Captured at': context.capturedAt,
  }));
  return toCsv(rows, headers);
}
