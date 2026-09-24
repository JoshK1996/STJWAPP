import { DateTime } from 'luxon';
import type { Queryable } from './db';
import { canReport, orgWide, requireCondition, type Actor } from './security';
import {
  workforceReportQueryV2Schema, workforceReportV2Schema, workforceSourceRowV2Schema, workforceUtcMicrosSchema,
  workforceInstantMicroseconds, workforceUtcFromMicroseconds, workforceFloorDivide, workforceV2Limits,
  type WorkforceReportQueryV2, type WorkforceReportV2, type WorkforceReportRowV2,
} from '../shared/workforce-reports-v2';

const max = (...values: bigint[]) => values.reduce((a, b) => a > b ? a : b);
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const compare = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
function calendarMicros(value: DateTime): bigint {
  requireCondition(value.isValid && Number.isSafeInteger(value.toMillis()), 400, 'Choose a supported timezone and calendar range.');
  const result = BigInt(value.toMillis()) * 1000n;
  try { workforceUtcFromMicroseconds(result); } catch { requireCondition(false, 400, 'Calendar boundaries must fall within UTC years 0001–9999.'); }
  return result;
}
export function workforceReportBoundsV2(rawQuery: unknown, zone: string) {
  const parsed = workforceReportQueryV2Schema.safeParse(rawQuery);
  requireCondition(parsed.success, 400, 'Choose a valid report query: at most 367 dates, or 32 hourly dates.');
  const query = parsed.data;
  const first = DateTime.fromISO(query.start, { zone }).startOf('day');
  const last = DateTime.fromISO(query.end, { zone }).startOf('day');
  requireCondition(first.isValid && last.isValid && first.toISODate() === query.start && last.toISODate() === query.end, 400, 'Choose valid local calendar dates and timezone.');
  const start = calendarMicros(first), end = calendarMicros(last.plus({ days: 1 }));
  requireCondition(end > start, 400, 'Choose a valid date range.');
  return { query, start, end };
}

/** Pure exact producer. No authentication or current-source publication proof is performed here. */
export function aggregateSegmentsV2(rawRows: unknown[], rawQuery: unknown, zone: string, asOf: string): WorkforceReportV2 {
  const { query, start, end } = workforceReportBoundsV2(rawQuery, zone);
  requireCondition(workforceUtcMicrosSchema.safeParse(asOf).success, 422, 'The report requires an exact supported source as-of timestamp.');
  requireCondition(rawRows.length <= workforceV2Limits.rows, 400, 'This report exceeds 20,000 segments. Choose a shorter range.');
  const now = workforceInstantMicroseconds(asOf);
  const seen = new Set<string>();
  const selected = rawRows.map(raw => {
    const parsed = workforceSourceRowV2Schema.safeParse(raw);
    requireCondition(parsed.success, 422, 'A recorded time source has unsupported identities, values or timestamp precision.');
    const row = parsed.data, from = workforceInstantMicroseconds(row.started_at), to = row.ended_at === null ? null : workforceInstantMicroseconds(row.ended_at);
    requireCondition(to === null || to >= from, 422, 'A recorded time source has reversed boundaries.');
    requireCondition(!seen.has(row.id), 422, 'The report source contains a duplicate segment.');
    seen.add(row.id);
    return { row, from, to };
  }).filter(({ from, to }) => from < end && (to === null || to > start || (to === from && from >= start)))
    .sort((a, b) => compare(a.from, b.from) || a.row.id.localeCompare(b.row.id));
  const buckets = new Map<string, { start: bigint; end: bigint; label: string; work: bigint; break: bigint }>();
  const staff = new Map<string, { name: string; work: bigint; break: bigint }>();
  const rows: WorkforceReportRowV2[] = [];
  let work = 0n, rest = 0n, contributingRowCount = 0;
  for (const { row, from, to } of selected) {
    const left = max(from, start), right = min(to ?? now, end, now), duration = max(0n, right - left);
    rows.push({ ...row, recorded_duration_microseconds: to === null ? null : (to - from).toString(),
      clipped_started_at: duration > 0n ? workforceUtcFromMicroseconds(left) : null,
      clipped_ended_at: duration > 0n ? workforceUtcFromMicroseconds(right) : null, duration_microseconds: duration.toString() });
    if (duration === 0n) continue;
    contributingRowCount++;
    const person = staff.get(row.user_id) ?? { name: row.employee_name, work: 0n, break: 0n };
    requireCondition(person.name === row.employee_name, 422, 'The source contains inconsistent employee identity labels.');
    person[row.kind] += duration;
    staff.set(row.user_id, person);
    if (row.kind === 'work') work += duration; else rest += duration;
    for (let cursor = left; cursor < right;) {
      // Only calendar lookup uses a Number; floor is essential for instants before epoch.
      const local = DateTime.fromMillis(Number(workforceFloorDivide(cursor, 1000n)), { zone });
      const base = local.startOf(query.group);
      const bucketStart = calendarMicros(base), bucketEnd = calendarMicros(base.plus({ [query.group + 's']: 1 }));
      const boundary = min(bucketEnd, right);
      requireCondition(bucketStart <= cursor && boundary > cursor, 422, 'The timezone produced an unsupported report boundary.');
      const key = workforceUtcFromMicroseconds(bucketStart);
      const bucket = buckets.get(key) ?? { start: bucketStart, end: bucketEnd,
        label: base.toFormat(query.group === 'hour' ? 'LLL d HH:mm ZZ' : query.group === 'month' ? 'LLL yyyy' : query.group === 'year' ? 'yyyy' : 'LLL d'), work: 0n, break: 0n };
      bucket[row.kind] += boundary - cursor;
      buckets.set(key, bucket);
      requireCondition(buckets.size <= workforceV2Limits.buckets, 400, 'This report exceeds 1,024 calendar buckets.');
      cursor = boundary;
    }
  }
  requireCondition(staff.size <= workforceV2Limits.staff, 400, 'This report exceeds 20,000 employees.');
  return workforceReportV2Schema.parse({ schemaVersion: 2, precisionVersion: 2, durationUnit: 'microsecond', timezone: zone, asOf,
    range: { from: workforceUtcFromMicroseconds(start), toExclusive: workforceUtcFromMicroseconds(end) }, query,
    workMicroseconds: work.toString(), breakMicroseconds: rest.toString(), sourceRowCount: rows.length, contributingRowCount, rows,
    buckets: [...buckets.entries()].sort(([, a], [, b]) => compare(a.start, b.start)).map(([key, b]) => ({ key, startsAt: key, endsAt: workforceUtcFromMicroseconds(b.end), label: b.label, workMicroseconds: b.work.toString(), breakMicroseconds: b.break.toString() })),
    staff: [...staff.entries()].sort(([aId, a], [bId, b]) => a.name.localeCompare(b.name) || aId.localeCompare(bId)).map(([userId, p]) => ({ userId, name: p.name, workMicroseconds: p.work.toString(), breakMicroseconds: p.break.toString() })),
    notice: 'Recorded work and break durations only, calculated in integer microseconds. Paid-break, overtime, leave accrual, and payroll rules are not configured.',
  });
}

// SQL text projection occurs before the driver can truncate timestamptz to Date.
// Unsupported/BC/infinite values must fail validation rather than masquerade as a null open end.
const exactSql = (column: 's.started_at' | 's.ended_at') => `CASE WHEN ${column} IS NULL THEN NULL
  WHEN ${column}>='0001-01-01T00:00:00Z'::timestamptz AND ${column}<'10000-01-01T00:00:00Z'::timestamptz
  THEN to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE 'unsupported' END`;

/**
 * Internal read-only source helper, NOT a guarded service/route. The caller must own a
 * consistent source transaction, supply a currently verified actor, and perform fresh
 * full-manifest/session or token publication authorization before exposing this result.
 */
export async function readWorkforceReportSourceV2(tx: Queryable, actor: Actor, rawQuery: unknown): Promise<WorkforceReportV2> {
  requireCondition(actor.mode === 'password' || actor.mode === 'api', 403, 'Reports require workspace sign-in or scoped reporting access.');
  const metadata = (await tx.query<{ timezone: string; as_of: string }>(`SELECT timezone,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of
    FROM organizations WHERE id=$1`, [actor.org_id])).rows[0];
  requireCondition(metadata, 404, 'Report organization not found.');
  const { query, start, end } = workforceReportBoundsV2(rawQuery, metadata.timezone);
  const rows = (await tx.query(`SELECT s.id,s.kind,${exactSql('s.started_at')} AS started_at,${exactSql('s.ended_at')} AS ended_at,
    h.revision,h.id AS shift_id,h.user_id,u.name AS employee_name,j.id AS job_id,j.title AS job_title,n.id AS unit_id,n.name AS unit_name
    FROM segments s JOIN shifts h ON h.id=s.shift_id AND h.org_id=s.org_id
    JOIN users u ON u.id=h.user_id AND u.org_id=h.org_id JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id
    JOIN units n ON n.id=j.unit_id AND n.org_id=j.org_id
    WHERE s.org_id=$1 AND s.revision=h.revision AND s.started_at<$3::timestamptz
    AND (s.ended_at IS NULL OR s.ended_at>$2::timestamptz OR (s.ended_at=s.started_at AND s.started_at>=$2::timestamptz))
    AND ($4::boolean OR h.user_id=$5) AND ($6::boolean OR h.user_id=$5 OR n.id=ANY($7::uuid[]))
    AND ($8::uuid IS NULL OR n.id=$8) AND ($9::uuid IS NULL OR h.user_id=$9)
    ORDER BY s.started_at,s.id LIMIT 20001`, [actor.org_id, workforceUtcFromMicroseconds(start), workforceUtcFromMicroseconds(end),
    canReport(actor), actor.id, orgWide(actor), actor.unit_ids, query.unitId ?? null, query.userId ?? null])).rows;
  return aggregateSegmentsV2(rows, query, metadata.timezone, metadata.as_of);
}

export const workforceReportColumnsV2 = Object.freeze(['employee_name', 'unit_name', 'job_title', 'kind', 'started_at', 'ended_at',
  'recorded_duration_microseconds', 'clipped_started_at', 'clipped_ended_at', 'duration_microseconds', 'shift_id', 'id', 'revision'] as const);
export type { WorkforceReportQueryV2 };
