import { z } from 'zod';

export const workforceV2Limits = Object.freeze({ rows: 20_000, staff: 20_000, buckets: 1_024, days: 367, hourlyDays: 32 });
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** Validate before Date construction: Date.parse alone normalizes invalid calendar dates. */
export function workforceInstantMicroseconds(value: string): bigint {
  const match = instantPattern.exec(value);
  if (!match) throw new RangeError('Use a valid UTC timestamp with at most six fractional digits.');
  const [, y, m, d, h, minute, second, fraction = ''] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), min = Number(minute), sec = Number(second);
  const days = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || min > 59 || sec > 59)
    throw new RangeError('Invalid UTC calendar date or time.');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, min, sec, 0);
  return BigInt(date.getTime()) * 1000n + BigInt(fraction.padEnd(6, '0'));
}

/** Euclidean floor, including negative epochs; BigInt division alone truncates toward zero. */
export function workforceFloorDivide(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('The divisor must be positive.');
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

const firstInstant = workforceInstantMicroseconds('0001-01-01T00:00:00Z');
const lastInstant = workforceInstantMicroseconds('9999-12-31T23:59:59.999999Z');
export function workforceUtcFromMicroseconds(value: bigint): string {
  if (value < firstInstant || value > lastInstant) throw new RangeError('Timestamp is outside supported UTC years 0001–9999.');
  const seconds = workforceFloorDivide(value, 1_000_000n), fraction = value - seconds * 1_000_000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + '.' + fraction.toString().padStart(6, '0') + 'Z';
}
export function canonicalWorkforceUtc(value: string): string {
  return workforceUtcFromMicroseconds(workforceInstantMicroseconds(value));
}
const validInstant = (value: string) => { try { workforceInstantMicroseconds(value); return true; } catch { return false; } };
export const workforceUtcMicrosSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(validInstant, 'Invalid UTC calendar date or time.');
export const workforceMicrosecondsSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const workforceExactSecondsSchema = z.string().regex(/^(0|[1-9][0-9]{0,13})\.[0-9]{6}$/);
export function workforceExactSeconds(value: string): string {
  const micros = BigInt(workforceMicrosecondsSchema.parse(value));
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}
export const workforceLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => validInstant(value + 'T00:00:00Z'), 'Invalid calendar date.');
export const workforceReportQueryV2Schema = z.object({
  start: workforceLocalDateSchema, end: workforceLocalDateSchema,
  group: z.enum(['hour', 'day', 'week', 'month', 'year']).default('day'),
  unitId: z.uuid().optional(), userId: z.uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (!validInstant(value.start + 'T00:00:00Z') || !validInstant(value.end + 'T00:00:00Z')) return;
  const days = (workforceInstantMicroseconds(value.end + 'T00:00:00Z') - workforceInstantMicroseconds(value.start + 'T00:00:00Z')) / 86_400_000_000n + 1n;
  if (days < 1n || days > BigInt(workforceV2Limits.days)) ctx.addIssue({ code: 'custom', path: ['end'], message: 'Choose 1–367 inclusive calendar dates.' });
  if (value.group === 'hour' && days > BigInt(workforceV2Limits.hourlyDays)) ctx.addIssue({ code: 'custom', path: ['end'], message: 'Hourly reports support at most 32 calendar dates.' });
});
const label = z.string().min(1).max(500), count = z.number().int().nonnegative();
export const workforceSourceRowV2Schema = z.object({
  id: z.uuid(), shift_id: z.uuid(), revision: z.number().int().min(1).max(2_147_483_647),
  user_id: z.uuid(), employee_name: label, job_id: z.uuid(), job_title: label,
  unit_id: z.uuid(), unit_name: label, kind: z.enum(['work', 'break']),
  started_at: workforceUtcMicrosSchema, ended_at: workforceUtcMicrosSchema.nullable(),
}).strict();
export const workforceReportRowV2Schema = workforceSourceRowV2Schema.extend({
  recorded_duration_microseconds: workforceMicrosecondsSchema.nullable(),
  clipped_started_at: workforceUtcMicrosSchema.nullable(), clipped_ended_at: workforceUtcMicrosSchema.nullable(),
  duration_microseconds: workforceMicrosecondsSchema,
}).strict().superRefine((row, ctx) => {
  if (!validInstant(row.started_at) || (row.ended_at !== null && !validInstant(row.ended_at)) || !workforceMicrosecondsSchema.safeParse(row.duration_microseconds).success) return;
  const start = workforceInstantMicroseconds(row.started_at), end = row.ended_at === null ? null : workforceInstantMicroseconds(row.ended_at);
  const duration = BigInt(row.duration_microseconds);
  const original = end === null ? null : (end - start).toString();
  if ((end !== null && end < start) || row.recorded_duration_microseconds !== original)
    ctx.addIssue({ code: 'custom', message: 'Recorded duration must match the original source boundaries, including an open null end.' });
  if (duration === 0n) {
    if (row.clipped_started_at !== null || row.clipped_ended_at !== null) ctx.addIssue({ code: 'custom', message: 'Zero contribution has no clipped interval.' });
  } else if (row.clipped_started_at === null || row.clipped_ended_at === null) {
    ctx.addIssue({ code: 'custom', message: 'Positive contribution requires both clipped boundaries.' });
  } else if (validInstant(row.clipped_started_at) && validInstant(row.clipped_ended_at)) {
    const left = workforceInstantMicroseconds(row.clipped_started_at), right = workforceInstantMicroseconds(row.clipped_ended_at);
    if (right - left !== duration || left < start || (end !== null && right > end)) ctx.addIssue({ code: 'custom', message: 'Clipped duration is inconsistent with its source.' });
  }
});
export const workforceBucketV2Schema = z.object({
  key: workforceUtcMicrosSchema, startsAt: workforceUtcMicrosSchema, endsAt: workforceUtcMicrosSchema, label,
  workMicroseconds: workforceMicrosecondsSchema, breakMicroseconds: workforceMicrosecondsSchema,
}).strict();
export const workforceStaffTotalV2Schema = z.object({
  userId: z.uuid(), name: label, workMicroseconds: workforceMicrosecondsSchema, breakMicroseconds: workforceMicrosecondsSchema,
}).strict();
export const workforceReportV2Schema = z.object({
  schemaVersion: z.literal(2), precisionVersion: z.literal(2), durationUnit: z.literal('microsecond'),
  timezone: z.string().min(1).max(80), asOf: workforceUtcMicrosSchema,
  range: z.object({ from: workforceUtcMicrosSchema, toExclusive: workforceUtcMicrosSchema }).strict(),
  query: workforceReportQueryV2Schema, workMicroseconds: workforceMicrosecondsSchema, breakMicroseconds: workforceMicrosecondsSchema,
  sourceRowCount: count.max(workforceV2Limits.rows), contributingRowCount: count.max(workforceV2Limits.rows),
  rows: z.array(workforceReportRowV2Schema).max(workforceV2Limits.rows),
  buckets: z.array(workforceBucketV2Schema).max(workforceV2Limits.buckets),
  staff: z.array(workforceStaffTotalV2Schema).max(workforceV2Limits.staff), notice: z.string().max(2000),
}).strict();

export type WorkforceReportQueryV2 = z.infer<typeof workforceReportQueryV2Schema>;
export type WorkforceSourceRowV2 = z.infer<typeof workforceSourceRowV2Schema>;
export type WorkforceReportRowV2 = z.infer<typeof workforceReportRowV2Schema>;
export type WorkforceBucketV2 = z.infer<typeof workforceBucketV2Schema>;
export type WorkforceStaffTotalV2 = z.infer<typeof workforceStaffTotalV2Schema>;
export type WorkforceReportV2 = z.infer<typeof workforceReportV2Schema>;
