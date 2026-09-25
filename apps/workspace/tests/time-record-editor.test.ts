import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editRecordRows, moveRecordDate, proposedRecordSegments, recordDuration, recordTotals, resolveRecordTime, splitRecordEntry, updateRecordBoundary, type RecordedSegment } from '../src/time-record-editor';

const zone = 'America/New_York';
const original: RecordedSegment[] = [
  { jobId: 'one', kind: 'work', startedAt: '2026-09-21T12:00:00.123456Z', endedAt: '2026-09-21T16:00:00.654321Z' },
  { jobId: 'one', kind: 'break', startedAt: '2026-09-21T16:00:00.654321Z', endedAt: '2026-09-21T16:30:00.123456Z' },
  { jobId: 'two', kind: 'work', startedAt: '2026-09-21T16:30:00.123456Z', endedAt: '2026-09-21T20:00:00.123456Z' },
];
test('untouched and job-only edits retain each exact source timestamp', () => {
  const rows = editRecordRows(original, zone);
  assert.deepEqual(proposedRecordSegments(rows, zone), original);
  const jobChanged = rows.map(row => ({ ...row, jobId: 'other' }));
  assert.deepEqual(proposedRecordSegments(jobChanged, zone).map(({ startedAt, endedAt }) => ({ startedAt, endedAt })), original.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })));
  assert.equal(updateRecordBoundary(rows, 0, 'start', rows[0].start), rows);
});
test('editing adjoining boundaries preserves continuity and untouched outside microseconds', () => {
  const rows = editRecordRows(original, zone), changed = updateRecordBoundary(rows, 0, 'end', '2026-09-21T12:15:00.000');
  const proposed = proposedRecordSegments(changed, zone);
  assert.equal(proposed[0].endedAt, '2026-09-21T16:15:00.000Z');
  assert.equal(proposed[1].startedAt, proposed[0].endedAt);
  assert.equal(proposed[0].startedAt, original[0].startedAt);
  assert.equal(proposed[1].endedAt, original[1].endedAt);
  assert.equal(proposed[2].endedAt, original[2].endedAt);
});
test('DST missing times are rejected and repeated times require an explicit occurrence', () => {
  assert.throws(() => resolveRecordTime('2026-03-08T02:30', zone, NaN), /does not exist/);
  assert.throws(() => resolveRecordTime('2026-11-01T01:30', zone, NaN), /Choose the daylight/);
  assert.equal(resolveRecordTime('2026-11-01T01:30', zone, -240), '2026-11-01T05:30:00.000Z');
  assert.equal(resolveRecordTime('2026-11-01T01:30', zone, -300), '2026-11-01T06:30:00.000Z');
  assert.throws(() => resolveRecordTime('not a date', zone, NaN), /does not exist/);
});
test('an edited repeated boundary resolves both adjoining entries with the same chosen occurrence', () => {
  const rows = editRecordRows(original, zone);
  const moved = moveRecordDate(rows, '2026-11-01');
  const changed = updateRecordBoundary(moved, 0, 'end', '2026-11-01T01:30:00.000', -300);
  assert.equal(changed[0].endOffset, -300);
  assert.equal(changed[1].startOffset, -300);
  assert.equal(changed[0].end, changed[1].start);
});
test('splitting a recorded entry adds millisecond boundary while retaining exact outer boundaries', () => {
  const rows = editRecordRows(original, zone), split = splitRecordEntry(rows, 0, zone, 'new');
  const result = proposedRecordSegments(split, zone);
  assert.equal(result.length, 4);
  assert.equal(result[0].startedAt, original[0].startedAt);
  assert.equal(result[1].endedAt, original[0].endedAt);
  assert.equal(result[0].endedAt, result[1].startedAt);
  assert.deepEqual(recordTotals(result), recordTotals(original));
  const tiny = editRecordRows([{ jobId: 'one', kind: 'work', startedAt: '2026-09-21T12:00:00.000001Z', endedAt: '2026-09-21T12:00:00.000002Z' }], zone);
  assert.throws(() => splitRecordEntry(tiny, 0, zone, 'tiny'), /longer entry/);
});
test('moving whole card preserves local clock times and overnight dates and requires DST choice', () => {
  const overnight = editRecordRows([{ jobId: 'one', kind: 'work', startedAt: '2026-10-31T02:00:00.000Z', endedAt: '2026-10-31T05:30:00.000Z' }], zone);
  assert.equal(moveRecordDate(overnight, '2026-10-30'), overnight);
  const moved = moveRecordDate(overnight, '2026-10-31');
  assert.equal(moved[0].start, '2026-10-31T22:00:00.000');
  assert.equal(moved[0].end, '2026-11-01T01:30:00.000');
  assert.throws(() => proposedRecordSegments(moved, zone), /Choose the daylight/);
  const resolved = updateRecordBoundary(moved, 0, 'end', moved[0].end, -300);
  assert.equal(recordTotals(proposedRecordSegments(resolved, zone)).work, 16200000000n);
});
test('validation identifies inverted dates and submillisecond gaps or overlaps', () => {
  const rows = editRecordRows(original, zone);
  assert.throws(() => proposedRecordSegments(updateRecordBoundary(rows, 0, 'start', '2026-09-22T08:00'), zone), /end at or after/);
  const gap = rows.map(row => ({ ...row })); gap[1].rawStart = '2026-09-21T16:00:00.654322Z';
  assert.throws(() => proposedRecordSegments(gap, zone), /gap or overlap/);
  gap[1].rawStart = '2026-09-21T16:00:00.654320Z';
  assert.throws(() => proposedRecordSegments(gap, zone), /gap or overlap/);
});
test('totals aggregate exact work and break independently before human duration formatting', () => {
  const total = recordTotals(original);
  assert.equal(total.work, 27000530865n);
  assert.equal(total.break, 1799469135n);
  assert.equal(total.work + total.break, 28800000000n);
  assert.equal(recordDuration(total.work), '7h 30m');
  assert.equal(recordDuration(1n), 'Less than 1 sec');
  assert.equal(recordDuration(null), 'In progress');
});
test('zero-duration source entries retain exact evidence and a worked interval can be corrected to zero', () => {
  const zero: RecordedSegment[] = [{ jobId: 'one', kind: 'work', startedAt: '2026-09-21T12:00:00.123456Z', endedAt: '2026-09-21T12:00:00.123456Z' }];
  assert.deepEqual(proposedRecordSegments(editRecordRows(zero, zone), zone), zero);
  const recorded: RecordedSegment[] = [{ jobId: 'one', kind: 'work', startedAt: '2026-09-21T12:00:00.000Z', endedAt: '2026-09-21T13:00:00.000Z' }];
  const rows = editRecordRows(recorded, zone);
  const corrected = proposedRecordSegments(updateRecordBoundary(rows, 0, 'end', rows[0].start), zone);
  assert.equal(corrected[0].startedAt, recorded[0].startedAt);
  assert.equal(corrected[0].endedAt, recorded[0].startedAt);
  assert.deepEqual(recordTotals(corrected), { work: 0n, break: 0n });
});
