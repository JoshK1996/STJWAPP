import { DateTime } from 'luxon';
import { z } from 'zod';
import { workforceLocalDateSchema, workforceReportQueryV2Schema, workforceUtcMicrosSchema, type WorkforceReportQueryV2 } from './workforce-reports-v2';

export const payrollViewLimit = 25;
const id = z.uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
export const payrollViewFiltersSchema = z.object({
  period: z.enum(['this_week', 'last_week', 'last_14_days', 'this_month', 'custom']),
  start: workforceLocalDateSchema.optional(), end: workforceLocalDateSchema.optional(),
  group: z.enum(['hour', 'day', 'week', 'month', 'year']).default('day'),
  unitId: id.optional(), userId: id.optional(), comparePrevious: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.period === 'custom') {
    const result = workforceReportQueryV2Schema.safeParse({ start: value.start, end: value.end, group: value.group });
    if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  } else if (value.start !== undefined || value.end !== undefined) {
    context.addIssue({ code: 'custom', path: ['period'], message: 'Relative periods resolve their dates when opened; omit fixed start and end dates.' });
  }
});
const name = z.string().trim().min(1).max(80);
export const createPayrollViewSchema = z.object({ id, name, filters: payrollViewFiltersSchema }).strict();
export const updatePayrollViewSchema = z.object({ revision, name, filters: payrollViewFiltersSchema }).strict();
export const deletePayrollViewSchema = z.object({ revision }).strict();
export const payrollViewIdSchema = id;
export const savedPayrollViewSchema = z.object({
  id, name, revision, filters: payrollViewFiltersSchema,
  createdAt: workforceUtcMicrosSchema, updatedAt: workforceUtcMicrosSchema,
  availability: z.enum(['available', 'unavailable']), unavailableReason: z.string().max(500).nullable(),
}).strict();
export const payrollViewListSchema = z.object({ views: z.array(savedPayrollViewSchema).max(payrollViewLimit), limit: z.literal(payrollViewLimit) }).strict();
export const resolvedPayrollViewSchema = z.object({
  view: savedPayrollViewSchema, query: workforceReportQueryV2Schema,
  comparisonQuery: workforceReportQueryV2Schema.nullable(), timezone: z.string().min(1).max(80), asOf: workforceUtcMicrosSchema,
}).strict();
export type PayrollViewFilters = z.infer<typeof payrollViewFiltersSchema>;
export type SavedPayrollView = z.infer<typeof savedPayrollViewSchema>;
export type PayrollViewList = z.infer<typeof payrollViewListSchema>;
export type ResolvedPayrollView = z.infer<typeof resolvedPayrollViewSchema>;

/** Matches existing calendar presets, not an inferred payroll or overtime policy.
 * The caller supplies the database capture time and organization's timezone. */
export function resolvePayrollViewFilters(raw: unknown, timezone: string, asOf: string): { query: WorkforceReportQueryV2; comparisonQuery: WorkforceReportQueryV2 | null } {
  const filters = payrollViewFiltersSchema.parse(raw);
  const localToday = DateTime.fromISO(workforceUtcMicrosSchema.parse(asOf), { zone: timezone });
  if (!localToday.isValid) throw new RangeError('The organization timezone or capture time is unavailable.');
  // Calendar arithmetic uses date labels; zoned subtraction can silently skip a
  // missing civil date (for example, Pacific/Apia's 2011-12-30).
  const today = DateTime.utc(localToday.year, localToday.month, localToday.day);
  let first: DateTime = today, last: DateTime = today;
  if (filters.period === 'this_week') first = today.startOf('week');
  else if (filters.period === 'last_week') { first = today.minus({ weeks: 1 }).startOf('week'); last = first.plus({ days: 6 }); }
  else if (filters.period === 'last_14_days') first = today.minus({ days: 13 });
  else if (filters.period === 'this_month') first = today.startOf('month');
  else { first = DateTime.fromISO(filters.start!, { zone: 'UTC' }); last = DateTime.fromISO(filters.end!, { zone: 'UTC' }); }
  if (!first.isValid || !last.isValid)
    throw new RangeError('A selected local date is unavailable in the organization timezone.');
  const selection = { group: filters.group, ...(filters.unitId ? { unitId: filters.unitId } : {}), ...(filters.userId ? { userId: filters.userId } : {}) };
  const query = workforceReportQueryV2Schema.parse({ ...selection, start: first.toISODate(), end: last.toISODate() });
  // UTC calendar midnights count dates, not elapsed hours across DST transitions.
  const days = DateTime.fromISO(query.end, { zone: 'UTC' }).diff(DateTime.fromISO(query.start, { zone: 'UTC' }), 'days').days + 1;
  const comparisonQuery = filters.comparePrevious ? workforceReportQueryV2Schema.parse({ ...selection,
    start: first.minus({ days }).toISODate(), end: first.minus({ days: 1 }).toISODate() }) : null;
  for (const range of [query, ...(comparisonQuery ? [comparisonQuery] : [])]) for (const date of [range.start, range.end]) {
    if (DateTime.fromISO(date, { zone: timezone }).startOf('day').toISODate() !== date)
      throw new RangeError('A selected local date is unavailable in the organization timezone.');
  }
  return { query, comparisonQuery };
}
