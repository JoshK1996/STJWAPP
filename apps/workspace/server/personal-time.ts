import {DateTime} from 'luxon';
import {personalTimeQuery, type PersonalTimeCard, type PersonalTimeDuration, type PersonalTimeJob, type PersonalTimePoint, type PersonalTimeReport} from '../shared/personal-time';
import type {Database, Row} from './db';
import {currentClockActor, recheckClockSession} from './clock-session-access';
import {preciseTimeSql, timeJobs, timeMicroseconds, timeNow, timeTransaction} from './time-record-access';
import {requireCondition, type Actor} from './security';

type Total = {work: bigint; rest: bigint};
const zero = (): Total => ({work: 0n, rest: 0n});
const durations = (value: Total): PersonalTimeDuration => ({workMicroseconds: value.work.toString(), breakMicroseconds: value.rest.toString()});
const add = (value: Total, kind: string, amount: bigint) => {if (kind === 'work') value.work += amount; else value.rest += amount;};
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const elapsed = (start: bigint, end: bigint) => end > start ? end - start : 0n;
const identity = (job: Row): PersonalTimeJob => ({jobId: job.id, title: job.title, unitId: job.unit_id, unitName: job.unit_name});
const points = (values: Map<string, Total>): PersonalTimePoint[] => [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({date, ...durations(value)}));

/** Self-only read boundary. No role, user, unit, or job selector can widen it. */
export async function listPersonalTime(db: Database, supplied: Actor, sessionHash: string, raw: unknown): Promise<PersonalTimeReport> {
  const input = personalTimeQuery.parse(raw);
  const result = await timeTransaction(db, async tx => {
    const actor = await currentClockActor(tx, supplied, sessionHash, false);
    const organization = (await tx.query('SELECT timezone FROM organizations WHERE id=$1', [actor.org_id])).rows[0];
    requireCondition(organization, 404, 'Organization not found.');
    const timezone = organization.timezone as string, observedAt = await timeNow(tx), now = timeMicroseconds(observedAt);
    const today = DateTime.fromISO(observedAt, {zone: timezone}).startOf('day');
    requireCondition(today.isValid, 422, 'The organization time zone needs to be configured.');
    const stored = (await tx.query(`SELECT ${preciseTimeSql('min(s.started_at)')} AS first_at,
      ${preciseTimeSql('max(least(coalesce(s.ended_at,$3::timestamptz),$3::timestamptz))')} AS last_at
      FROM shifts s WHERE s.org_id=$1 AND s.user_id=$2 AND s.started_at<=$3
      AND EXISTS(SELECT 1 FROM segments g WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision)`, [actor.org_id, actor.id, observedAt])).rows[0];
    const history = {firstDate: stored.first_at ? DateTime.fromISO(stored.first_at, {zone: timezone}).toISODate() : null,
      lastDate: stored.last_at ? DateTime.fromISO(stored.last_at, {zone: timezone}).toISODate() : null};
    const anchor = input.anchor ? DateTime.fromISO(input.anchor, {zone: timezone}).startOf('day') : today;
    requireCondition(anchor.isValid && (!input.anchor || anchor.toISODate() === input.anchor), 422, 'Choose a valid calendar date in your organization time zone.');
    let start: DateTime = anchor, end: DateTime = anchor.plus({days: 1});
    if (input.period === 'week') {start = anchor.startOf('week'); end = start.plus({weeks: 1});}
    if (input.period === 'month') {start = anchor.startOf('month'); end = start.plus({months: 1});}
    if (input.period === 'year') {start = anchor.startOf('year'); end = start.plus({years: 1});}
    if (input.period === 'custom') {
      start = DateTime.fromISO(input.from!, {zone: timezone}).startOf('day');
      const last = DateTime.fromISO(input.to!, {zone: timezone}).startOf('day'); end = last.plus({days: 1});
      requireCondition(start.isValid && last.isValid && start.toISODate() === input.from && last.toISODate() === input.to && end > start, 422, 'Choose valid calendar dates in your organization time zone.');
      requireCondition(end.diff(start, 'days').days <= 366, 422, 'Choose at most 366 calendar dates, or select All history.');
    }
    if (input.period === 'all') {
      start = history.firstDate ? DateTime.fromISO(history.firstDate, {zone: timezone}).startOf('day') : today;
      end = (history.lastDate ? DateTime.fromISO(history.lastDate, {zone: timezone}).startOf('day') : today).plus({days: 1});
    }
    requireCondition(start.isValid && end.isValid && end > start, 422, 'Choose a valid date range.');
    const shifts = (await tx.query(`SELECT s.id,s.revision,${preciseTimeSql('s.started_at')} AS started_at,${preciseTimeSql('s.ended_at')} AS ended_at
      FROM shifts s WHERE s.org_id=$1 AND s.user_id=$2 AND s.started_at<$4 AND s.started_at<=$5
      AND (coalesce(s.ended_at,'infinity'::timestamptz)>$3 OR (s.ended_at=s.started_at AND s.started_at>=$3))
      AND EXISTS(SELECT 1 FROM segments g WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision)
      ORDER BY s.started_at DESC,s.id LIMIT 10001`, [actor.org_id, actor.id, start.toJSDate(), end.toJSDate(), observedAt])).rows;
    requireCondition(shifts.length <= 10000, 422, 'This history contains more than 10,000 time cards. Choose a year, month, or shorter custom range.');
    const segments = (await tx.query(`SELECT g.id,g.shift_id,g.job_id,g.kind,${preciseTimeSql('g.started_at')} AS started_at,${preciseTimeSql('g.ended_at')} AS ended_at
      FROM segments g JOIN shifts s ON s.org_id=g.org_id AND s.id=g.shift_id AND s.revision=g.revision
      WHERE s.org_id=$1 AND s.user_id=$2 AND s.id=ANY($3::uuid[])
      ORDER BY g.shift_id,g.started_at,g.ended_at,g.id LIMIT 20001`, [actor.org_id, actor.id, shifts.map(row => row.id)])).rows;
    requireCondition(segments.length <= 20000, 422, 'This history contains more than 20,000 time entries. Choose a year, month, or shorter custom range.');
    const jobs = await timeJobs(tx, actor, [...new Set(segments.map(row => row.job_id))]);
    const jobMap = new Map(jobs.map(job => [job.id, job]));
    const segmentMap = new Map<string, Row[]>();
    for (const segment of segments) {const list = segmentMap.get(segment.shift_id) ?? []; list.push(segment); segmentMap.set(segment.shift_id, list);}
    const beginning = BigInt(start.toMillis()) * 1000n, ending = BigInt(end.toMillis()) * 1000n;
    const totals = zero(), byJob = new Map<string, Total>(), byDay = new Map<string, Total>();
    let daySlices = 0;
    const rows: PersonalTimeCard[] = shifts.map(shift => {
      const whole = zero(), period = zero();
      const cardSegments = (segmentMap.get(shift.id) ?? []).map(segment => {
        const from = timeMicroseconds(segment.started_at), until = min(timeMicroseconds(segment.ended_at ?? observedAt), now);
        const clippedStart = max(from, beginning), clippedEnd = min(until, ending), duration = elapsed(from, until), clipped = elapsed(clippedStart, clippedEnd);
        const full = zero(), selected = zero(); add(full, segment.kind, duration); add(selected, segment.kind, clipped);
        add(whole, segment.kind, duration); add(period, segment.kind, clipped); add(totals, segment.kind, clipped);
        if (clipped > 0n) {
          const jobTotal = byJob.get(segment.job_id) ?? zero(); add(jobTotal, segment.kind, clipped); byJob.set(segment.job_id, jobTotal);
          for (let cursor = clippedStart; cursor < clippedEnd;) {
            requireCondition(++daySlices <= 50000, 422, 'This history covers too many calendar-day entries. Choose a year, month, or shorter custom range.');
            const milliseconds = cursor / 1000n - (cursor < 0n && cursor % 1000n !== 0n ? 1n : 0n);
            const date = DateTime.fromMillis(Number(milliseconds), {zone: timezone});
            const next = min(BigInt(date.startOf('day').plus({days: 1}).toMillis()) * 1000n, clippedEnd);
            requireCondition(next > cursor, 422, 'A recorded date cannot be represented in the organization time zone.');
            const key = date.toISODate()!, total = byDay.get(key) ?? zero(); add(total, segment.kind, next - cursor); byDay.set(key, total); cursor = next;
          }
        }
        return {id: segment.id, kind: segment.kind as 'work' | 'break', ...identity(jobMap.get(segment.job_id)!), startedAt: segment.started_at, endedAt: segment.ended_at,
          ...durations(full), periodWorkMicroseconds: selected.work.toString(), periodBreakMicroseconds: selected.rest.toString()};
      });
      return {id: shift.id, revision: shift.revision, startedAt: shift.started_at, endedAt: shift.ended_at,
        ...durations(whole), periodWorkMicroseconds: period.work.toString(), periodBreakMicroseconds: period.rest.toString(), segments: cardSegments};
    });
    const daily = points(byDay), group = input.period === 'year' || input.period === 'all' || end.diff(start, 'days').days > 62 ? 'month' : 'day';
    const grouped = new Map<string, Total>();
    for (const day of daily) {const key = group === 'month' ? day.date.slice(0, 7) + '-01' : day.date, total = grouped.get(key) ?? zero(); total.work += BigInt(day.workMicroseconds); total.rest += BigInt(day.breakMicroseconds); grouped.set(key, total);}
    const from = start.toISODate()!, to = end.minus({days: 1}).toISODate()!;
    const label = input.period === 'all' ? 'All history' : input.period === 'day' ? start.toFormat('MMM d, yyyy') : input.period === 'month' ? start.toFormat('MMMM yyyy') : input.period === 'year' ? start.toFormat('yyyy') : `${start.toFormat('MMM d, yyyy')} – ${end.minus({days: 1}).toFormat('MMM d, yyyy')}`;
    const hasMore = rows.length > input.offset + 25;
    const report: PersonalTimeReport = {timezone, observedAt, range: {period: input.period, from, to, label}, history,
      summary: {...durations(totals), shiftCount: rows.length, openCount: rows.filter(row => !row.endedAt).length, totalMicroseconds: (totals.work + totals.rest).toString(), daysWorked: daily.filter(day => BigInt(day.workMicroseconds) > 0n).length},
      daily, trend: {group, points: points(grouped)}, jobs: [...byJob].map(([id, value]) => ({...identity(jobMap.get(id)!), ...durations(value)})).sort((a, b) => a.title.localeCompare(b.title) || a.jobId.localeCompare(b.jobId)),
      rows: rows.slice(input.offset, input.offset + 25), offset: input.offset, hasMore, nextOffset: hasMore ? input.offset + 25 : null};
    await recheckClockSession(tx, actor, sessionHash);
    return report;
  }, true);
  // An external revocation committed after the data snapshot must still prevent publication.
  return timeTransaction(db, async tx => {const actor = await currentClockActor(tx, supplied, sessionHash, false); await recheckClockSession(tx, actor, sessionHash); return result;});
}
