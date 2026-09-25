import { DateTime } from 'luxon';
import { digest, requireCondition } from './security';
import { timeMicroseconds } from './time-record-access';
import { planningLimits, type CoverageRule, type CoverageOccurrence, type PlanningWarning, type PlanningSlot, type PlanningQuery, type HoursTarget, type TargetPeriod } from '../shared/staff-planning';
import type { StaffScheduleSnapshot } from '../shared/staff-scheduling';

export const exactIso = (date: DateTime) => date.toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'000Z'");
export const localDay = (date: string, timezone: string) => {
  const result = DateTime.fromISO(date, { zone: timezone });
  requireCondition(result.isValid && result.toISODate() === date, 400, 'This local date or organization timezone is unavailable.');
  return result;
};
export function hoursMicroseconds(hours: string) {
  const [whole, fraction = ''] = hours.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * 36_000_000n;
}
export function planningBounds(query: PlanningQuery, zone: string) {
  return { from: exactIso(localDay(query.start, zone)), through: exactIso(localDay(query.end, zone).plus({ days: 1 })) };
}
export function elapsedWithin(schedules: StaffScheduleSnapshot[], from: string, through: string) {
  const left = timeMicroseconds(from), right = timeMicroseconds(through);
  const groups = new Map<string, Array<[bigint, bigint]>>();
  for (const row of schedules.filter(row => row.status === 'scheduled')) {
    const a = timeMicroseconds(row.startsAt), b = timeMicroseconds(row.endsAt), start = a > left ? a : left, end = b < right ? b : right;
    if (end <= start) continue;
    const key = row.userId, intervals = groups.get(key) ?? []; intervals.push([start, end]); groups.set(key, intervals);
  }
  let sum = 0n;
  // One employee cannot occupy two instants at once. Targets pass one job;
  // candidate ordering passes all permitted jobs and unions legacy overlaps.
  for (const intervals of groups.values()) {
    intervals.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    let start = intervals[0][0], end = intervals[0][1];
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart <= end) { if (nextEnd > end) end = nextEnd; }
      else { sum += end - start; start = nextStart; end = nextEnd; }
    }
    sum += end - start;
  }
  return sum;
}
function occurs(rule: CoverageRule, date: DateTime) {
  const anchor = localDay(rule.startDate, rule.timezone), name = date.toISODate()!;
  if (name < rule.startDate || rule.endDate && name > rule.endDate) return false;
  if (rule.frequency === 'daily') return Math.round(date.diff(anchor, 'days').days) % rule.interval === 0;
  if (rule.frequency === 'weekly') return rule.weekdays.includes(date.weekday) && Math.round(date.startOf('week').diff(anchor.startOf('week'), 'weeks').weeks) % rule.interval === 0;
  if (rule.frequency === 'monthly') return (date.year * 12 + date.month - anchor.year * 12 - anchor.month) % rule.interval === 0 && date.day === anchor.day;
  return (date.year - anchor.year) % rule.interval === 0 && date.month === anchor.month && date.day === anchor.day;
}
function skipped(rule: CoverageRule, date: DateTime) {
  if (!['monthly', 'yearly'].includes(rule.frequency) || date.day !== date.daysInMonth) return false;
  const anchor = localDay(rule.startDate, rule.timezone), name = date.toISODate()!;
  if (name < rule.startDate || rule.endDate && name > rule.endDate || anchor.day <= date.day) return false;
  return rule.frequency === 'monthly'
    ? (date.year * 12 + date.month - anchor.year * 12 - anchor.month) % rule.interval === 0
    : (date.year - anchor.year) % rule.interval === 0 && date.month === anchor.month;
}
function wallTime(date: string, time: string, zone: string) {
  const expected = `${date}T${time}`, result = DateTime.fromISO(expected, { zone });
  if (!result.isValid || result.toFormat("yyyy-MM-dd'T'HH:mm") !== expected || result.getPossibleOffsets().length !== 1) return null;
  return result;
}
export function expandCoverage(rules: CoverageRule[], query: PlanningQuery): { occurrences: CoverageOccurrence[]; warnings: PlanningWarning[] } {
  const occurrences: CoverageOccurrence[] = [], warnings: PlanningWarning[] = [];
  for (const rule of rules.filter(row => row.active && (!query.jobId || row.jobId === query.jobId))) {
    const contextEnd = localDay(query.end, rule.timezone).plus({ days: 1 }).toISODate()!;
    // Adjacent dates are overlap context only. Returned windows belong to their
    // start date, so an overnight tail is never offered twice for generation.
    for (let day = localDay(query.start, rule.timezone).minus({ days: 1 }); day.toISODate()! <= contextEnd; day = day.plus({ days: 1 })) {
      const date = day.toISODate()!;
      if (date >= query.start && date <= query.end && skipped(rule, day)) warnings.push({ code: 'SKIPPED_DATE', ruleIds: [rule.id], date, message: `${rule.label}: the anchored day does not exist in ${day.toFormat('LLLL yyyy')}; this occurrence is skipped, never moved.` });
      if (!occurs(rule, day)) continue;
      const from = wallTime(date, rule.startsLocal, rule.timezone), to = wallTime(day.plus({ days: rule.endDayOffset }).toISODate()!, rule.endsLocal, rule.timezone);
      if (!from || !to || to.toMillis() <= from.toMillis() || to.toMillis() - from.toMillis() > 86400000) {
        if (date >= query.start && date <= query.end) warnings.push({ code: 'DST_BLOCKED', ruleIds: [rule.id], date, message: `${rule.label} on ${date} needs an explicit time decision: a local time is missing, ambiguous, or exceeds the 24-hour saved-shift limit. Edit the rule or create a reviewed individual shift; no time was moved.` });
        continue;
      }
      if (to <= localDay(query.start, rule.timezone)) continue;
      const startsAt = exactIso(from), endsAt = exactIso(to);
      occurrences.push({ id: digest(JSON.stringify([rule.id, date, startsAt, endsAt])), ruleId: rule.id, date, jobId: rule.jobId, label: rule.label, startsAt, endsAt, staffCount: rule.staffCount, slices: [], requiredMicroseconds: '0', filledMicroseconds: '0', uncoveredMicroseconds: '0', excessMicroseconds: '0', conflict: false });
      requireCondition(occurrences.length <= planningLimits.occurrences, 400, 'Too many coverage occurrences. Choose one job or a shorter period.');
    }
  }
  occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  for (let i = 0; i < occurrences.length; i++) for (let j = i + 1; j < occurrences.length && occurrences[j].startsAt < occurrences[i].endsAt; j++) {
    const a = occurrences[i], b = occurrences[j];
    if (a.jobId !== b.jobId) continue;
    if (!(a.date >= query.start && a.date <= query.end || b.date >= query.start && b.date <= query.end)) continue;
    a.conflict = b.conflict = true;
    warnings.push({ code: 'RULE_OVERLAP', ruleIds: [...new Set([a.ruleId, b.ruleId])], date: a.date, message: `Coverage rules overlap for the same job on ${a.date}. Resolve the overlap before generating assignments; counts are not added or merged.` });
    requireCondition(warnings.length <= 1000, 400, 'Too many recurrence conflicts to display safely. Choose one job or a shorter period and correct its overlapping rules.');
  }
  return { occurrences: occurrences.filter(row => row.date >= query.start && row.date <= query.end), warnings };
}
export function measureCoverage(occurrences: CoverageOccurrence[], schedules: StaffScheduleSnapshot[]) {
  for (const occurrence of occurrences) {
    const rows = schedules.filter(row => row.status === 'scheduled' && row.jobId === occurrence.jobId && row.startsAt < occurrence.endsAt && row.endsAt > occurrence.startsAt);
    const points = [...new Set([occurrence.startsAt, occurrence.endsAt, ...rows.flatMap(row => [row.startsAt > occurrence.startsAt ? row.startsAt : occurrence.startsAt, row.endsAt < occurrence.endsAt ? row.endsAt : occurrence.endsAt])])].sort();
    let required = 0n, filled = 0n, uncovered = 0n, excess = 0n;
    for (let index = 1; index < points.length; index++) {
      const startsAt = points[index - 1], endsAt = points[index], duration = timeMicroseconds(endsAt) - timeMicroseconds(startsAt);
      const employeeIds = [...new Set(rows.filter(row => row.startsAt < endsAt && row.endsAt > startsAt).map(row => row.userId))].sort();
      const assigned = employeeIds.length, missing = Math.max(0, occurrence.staffCount - assigned), extra = Math.max(0, assigned - occurrence.staffCount);
      occurrence.slices.push({ startsAt, endsAt, assigned, required: occurrence.staffCount, missing, excess: extra, employeeIds });
      required += duration * BigInt(occurrence.staffCount); filled += duration * BigInt(Math.min(assigned, occurrence.staffCount)); uncovered += duration * BigInt(missing); excess += duration * BigInt(extra);
    }
    Object.assign(occurrence, { requiredMicroseconds: required.toString(), filledMicroseconds: filled.toString(), uncoveredMicroseconds: uncovered.toString(), excessMicroseconds: excess.toString() });
  }
  return occurrences;
}
export function openCoverageSlots(occurrences: CoverageOccurrence[]): PlanningSlot[] {
  const slots: PlanningSlot[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.conflict) continue;
    for (let position = 1; position <= occurrence.staffCount; position++) {
      const current: { value: { startsAt: string; endsAt: string } | null } = { value: null };
      const flush = () => {
        if (!current.value) return;
        slots.push({ id: digest(JSON.stringify([occurrence.id, current.value.startsAt, current.value.endsAt, position])), ruleId: occurrence.ruleId, occurrenceId: occurrence.id, date: occurrence.date, jobId: occurrence.jobId, ...current.value, position });
        requireCondition(slots.length <= planningLimits.slots, 400, 'More than 1,000 open shift choices. Choose fewer rules or a shorter period.'); current.value = null;
      };
      for (const slice of occurrence.slices) {
        if (slice.missing < position) { flush(); continue; }
        if (current.value?.endsAt === slice.startsAt) current.value.endsAt = slice.endsAt;
        else { flush(); current.value = { startsAt: slice.startsAt, endsAt: slice.endsAt }; }
      }
      flush();
    }
  }
  return slots;
}
export function measureTargets(targets: HoursTarget[], schedules: StaffScheduleSnapshot[], query: PlanningQuery, zone: string): TargetPeriod[] {
  const result: TargetPeriod[] = [];
  for (const target of targets.filter(row => row.active && (!query.jobId || row.jobId === query.jobId))) {
    for (let from = localDay(query.start, zone).startOf(target.period); from.toISODate()! <= query.end; from = from.plus({ [target.period + 's']: 1 })) {
      const through = from.plus({ [target.period + 's']: 1 }), start = from.toISODate()!, end = through.minus({ days: 1 }).toISODate()!;
      if (end < target.effectiveFrom || target.effectiveThrough && start > target.effectiveThrough) continue;
      const planned = elapsedWithin(schedules.filter(row => row.jobId === target.jobId), exactIso(from), exactIso(through)), amount = hoursMicroseconds(target.hours);
      const partial = query.start > start || query.end < end || target.effectiveFrom > start || Boolean(target.effectiveThrough && target.effectiveThrough < end);
      result.push({ targetId: target.id, jobId: target.jobId, period: target.period, start, end, targetHours: target.hours, targetMicroseconds: amount.toString(), scheduledMicroseconds: planned.toString(), deltaMicroseconds: (planned - amount).toString(), partial, label: `${start} – ${end}${partial ? ' · Complete calendar-period target; selected/effective dates cover only part' : ''}` });
    }
  }
  return result;
}
