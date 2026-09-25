import { DateTime } from 'luxon';

export type RecordedSegment = { jobId: string; kind: string; startedAt: string; endedAt: string | null };
export type EditTimeSegment = { key: string; jobId: string; kind: string; start: string; end: string; startOffset: number; endOffset: number; rawStart?: string; rawEnd?: string };
export const localTimeFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS";
export const localTime = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat(localTimeFormat);
export function recordInstant(value: string): bigint {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw Error('Enter a valid date and time.');
  return BigInt(millis) * 1000n + BigInt((value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '').padEnd(6, '0').slice(3, 6) || '0');
}
export const recordSpan = (start: string, end: string | null) => end ? recordInstant(end) - recordInstant(start) : null;
export function recordDuration(value: bigint | string | null) {
  if (value === null) return 'In progress';
  const micros = BigInt(value), seconds = micros > 0n ? micros / 1000000n : 0n;
  if (!seconds && micros > 0n) return 'Less than 1 sec';
  const h = seconds / 3600n, m = seconds % 3600n / 60n, s = seconds % 60n;
  return h ? `${h}h ${m}m${s ? ` ${s}s` : ''}` : m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`;
}
export function recordTotals(segments: RecordedSegment[]) {
  return segments.reduce((sum, item) => {
    sum[item.kind === 'work' ? 'work' : 'break'] += recordSpan(item.startedAt, item.endedAt) ?? 0n;
    return sum;
  }, { work: 0n, break: 0n });
}
export function resolveRecordTime(value: string, zone: string, offset: number) {
  const local = DateTime.fromISO(value, { zone: 'UTC' }), time = DateTime.fromISO(value, { zone });
  if (!local.isValid || !time.isValid || time.toFormat(localTimeFormat) !== local.toFormat(localTimeFormat))
    throw Error('This local time does not exist in the organization timezone. Choose another time.');
  const options = time.getPossibleOffsets();
  if (options.length > 1) {
    const selected = options.find(option => option.offset === offset);
    if (!selected) throw Error('Choose the daylight or standard-time occurrence for the repeated time.');
    return selected.toUTC().toISO()!;
  }
  return time.toUTC().toISO()!;
}
export function editRecordRows(segments: RecordedSegment[], zone: string): EditTimeSegment[] {
  return segments.map((row, index) => ({ key: `source-${index}`, jobId: row.jobId, kind: row.kind,
    start: localTime(row.startedAt, zone), end: localTime(row.endedAt!, zone),
    startOffset: DateTime.fromISO(row.startedAt).setZone(zone).offset,
    endOffset: DateTime.fromISO(row.endedAt!).setZone(zone).offset,
    rawStart: row.startedAt, rawEnd: row.endedAt! }));
}
export function updateRecordBoundary(rows: EditTimeSegment[], index: number, edge: 'start' | 'end', value: string, offset?: number) {
  const original = rows[index];
  const previousOffset = edge === 'start' ? original.startOffset : original.endOffset;
  if (value === original[edge] && (offset === undefined || offset === previousOffset)) return rows;
  return rows.map((row, at) => {
    const next = { ...row };
    if (at === index) {
      next[edge] = value;
      next[edge === 'start' ? 'rawStart' : 'rawEnd'] = undefined;
      next[edge === 'start' ? 'startOffset' : 'endOffset'] = offset ?? NaN;
    }
    if (edge === 'start' && at === index - 1) { next.end = value; next.rawEnd = undefined; next.endOffset = offset ?? NaN; }
    if (edge === 'end' && at === index + 1) { next.start = value; next.rawStart = undefined; next.startOffset = offset ?? NaN; }
    return next;
  });
}
export function proposedRecordSegments(rows: EditTimeSegment[], zone: string): Required<RecordedSegment>[] {
  if (!rows.length || rows.length > 200) throw Error('A time card needs between 1 and 200 entries.');
  const segments = rows.map(row => ({ jobId: row.jobId, kind: row.kind,
    startedAt: row.rawStart ?? resolveRecordTime(row.start, zone, row.startOffset),
    endedAt: row.rawEnd ?? resolveRecordTime(row.end, zone, row.endOffset) }));
  for (const [index, row] of segments.entries()) {
    if (!row.jobId || !['work', 'break'].includes(row.kind)) throw Error(`Choose a job and type for entry ${index + 1}.`);
    if (recordInstant(row.endedAt) < recordInstant(row.startedAt)) throw Error(`Entry ${index + 1} must end at or after it starts. For an overnight shift, choose the following date.`);
    if (index && recordInstant(row.startedAt) !== recordInstant(segments[index - 1].endedAt)) throw Error(`Entries ${index} and ${index + 1} must meet without a gap or overlap.`);
  }
  return segments;
}
export function splitRecordEntry(rows: EditTimeSegment[], index: number, zone: string, key: string) {
  if (rows.length >= 200) throw Error('A time card can have at most 200 entries.');
  const row = rows[index], start = recordInstant(row.rawStart ?? resolveRecordTime(row.start, zone, row.startOffset)), end = recordInstant(row.rawEnd ?? resolveRecordTime(row.end, zone, row.endOffset));
  // A new boundary has millisecond precision; existing outside boundaries stay exact.
  const middle = ((start + end) / 2n / 1000n) * 1000n;
  if (middle <= start || middle >= end) throw Error('Choose a longer entry before splitting it.');
  const instant = new Date(Number(middle / 1000n)).toISOString(), local = localTime(instant, zone), offset = DateTime.fromISO(instant).setZone(zone).offset;
  return rows.flatMap((item, at) => at === index ? [
    { ...item, end: local, endOffset: offset, rawEnd: undefined },
    { ...item, key, start: local, startOffset: offset, rawStart: undefined },
  ] : [item]);
}
export function moveRecordDate(rows: EditTimeSegment[], date: string) {
  const source = DateTime.fromISO(rows[0]?.start ?? '', { zone: 'UTC' }).startOf('day'), target = DateTime.fromISO(date, { zone: 'UTC' });
  if (!source.isValid || !target.isValid) throw Error('Choose a valid date to move this time card.');
  const days = target.diff(source, 'days').days;
  if (days === 0) return rows;
  return rows.map(row => ({ ...row,
    start: DateTime.fromISO(row.start, { zone: 'UTC' }).plus({ days }).toFormat(localTimeFormat),
    end: DateTime.fromISO(row.end, { zone: 'UTC' }).plus({ days }).toFormat(localTimeFormat),
    startOffset: NaN, endOffset: NaN, rawStart: undefined, rawEnd: undefined,
  }));
}
