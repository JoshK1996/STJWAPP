import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { aggregateSegmentsV2, readWorkforceReportSourceV2, workforceReportBoundsV2, workforceReportColumnsV2 } from '../server/reports-v2';
import { aggregateSegments, getReport, reportColumns, toCsv } from '../server/reports';
import {
  canonicalWorkforceUtc, workforceInstantMicroseconds, workforceUtcFromMicroseconds, workforceExactSeconds,
  workforceUtcMicrosSchema, workforceMicrosecondsSchema, workforceReportQueryV2Schema, workforceReportV2Schema,
  workforceReportRowV2Schema, type WorkforceSourceRowV2, type WorkforceReportQueryV2,
} from '../shared/workforce-reports-v2';
import { connectDatabase, migrate, type Database, type Queryable } from '../server/db';
import { initialize } from '../server/seed';
import { createStaff } from '../server/workforce';
import type { Actor } from '../server/security';

const baseUser = randomUUID(), baseJob = randomUUID(), baseUnit = randomUUID();
const day: WorkforceReportQueryV2 = { start: '2026-09-21', end: '2026-09-21', group: 'day' };
const later = '2026-09-22T00:00:00.000000Z';
function row(start: string, end: string | null, changes: Partial<WorkforceSourceRowV2> = {}): WorkforceSourceRowV2 {
  return { id: randomUUID(), shift_id: randomUUID(), revision: 1, user_id: baseUser, employee_name: 'Synthetic exact employee',
    job_id: baseJob, job_title: 'Synthetic job', unit_id: baseUnit, unit_name: 'Synthetic unit', kind: 'work',
    started_at: canonicalWorkforceUtc(start), ended_at: end === null ? null : canonicalWorkforceUtc(end), ...changes };
}
const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
const problem = (status: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === status;

test('timestamp primitives reject normalized invalid dates and preserve equivalent UTC instants', () => {
  for (const invalid of ['2026-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-00-01T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '0000-01-01T00:00:00Z', '2026-01-01T00:00:00.1234567Z',
    '2026-01-01T00:00:00+00:00', 'infinity']) assert.throws(() => workforceInstantMicroseconds(invalid), RangeError, invalid);
  assert.equal(canonicalWorkforceUtc('2000-02-29T01:02:03.1234Z'), '2000-02-29T01:02:03.123400Z');
  assert.equal(workforceInstantMicroseconds('2026-01-01T00:00:00.1234Z'), workforceInstantMicroseconds('2026-01-01T00:00:00.123400Z'));
  assert.equal(workforceInstantMicroseconds('2026-01-01T00:00:00.123401Z') - workforceInstantMicroseconds('2026-01-01T00:00:00.123400Z'), 1n);
  assert.equal(workforceUtcMicrosSchema.safeParse('2026-01-01T00:00:00.1234Z').success, false);
  assert.equal(workforceUtcMicrosSchema.safeParse('2026-02-30T00:00:00.000000Z').success, false);
});

test('negative epochs use floor and round-trip both supported year boundaries exactly', () => {
  assert.equal(workforceInstantMicroseconds('1969-12-31T23:59:59.999999Z'), -1n);
  for (const value of ['0001-01-01T00:00:00.000000Z', '0099-12-31T23:59:59.123456Z', '1969-12-31T23:59:59.999999Z',
    '1969-12-31T23:59:59.000001Z', '1970-01-01T00:00:00.000000Z', '9999-12-31T23:59:59.999999Z'])
    assert.equal(workforceUtcFromMicroseconds(workforceInstantMicroseconds(value)), value);
  assert.throws(() => workforceUtcFromMicroseconds(workforceInstantMicroseconds('0001-01-01T00:00:00Z') - 1n), RangeError);
  assert.throws(() => workforceUtcFromMicroseconds(workforceInstantMicroseconds('9999-12-31T23:59:59.999999Z') + 1n), RangeError);
  const report = aggregateSegmentsV2([row('1969-12-31T23:59:59.999999Z', '1970-01-01T00:00:00.000001Z')],
    { start: '1969-12-31', end: '1970-01-01', group: 'day' }, 'UTC', '1970-01-02T00:00:00.000000Z');
  assert.equal(report.workMicroseconds, '2');
  assert.deepEqual(report.buckets.map(b => b.workMicroseconds), ['1', '1']);
});

test('query defaults and exact calendar limits reject unknown, repeated and invalid inputs', () => {
  assert.equal(workforceReportQueryV2Schema.parse({ start: day.start, end: day.end }).group, 'day');
  for (const input of [{ ...day, start: ['2026-09-21'] }, { ...day, start: '2026-02-30' }, { ...day, end: '2026-09-20' },
    { ...day, asOf: later }, { ...day, precisionVersion: 2 }, { start: '2026-01-01', end: '2027-01-03', group: 'day' },
    { start: '2026-01-01', end: '2026-02-02', group: 'hour' }]) assert.equal(workforceReportQueryV2Schema.safeParse(input).success, false);
  assert.equal(workforceReportQueryV2Schema.safeParse({ start: '2026-01-01', end: '2027-01-02', group: 'day' }).success, true);
  assert.equal(workforceReportQueryV2Schema.safeParse({ start: '2026-01-01', end: '2026-02-01', group: 'hour' }).success, true);
  assert.throws(() => workforceReportBoundsV2(day, 'Invalid/Timezone'), problem(400));
  assert.throws(() => workforceReportBoundsV2({ start: '2011-12-30', end: '2011-12-30', group: 'day' }, 'Pacific/Apia'), problem(400));
  assert.throws(() => workforceReportBoundsV2({ start: '9999-12-31', end: '9999-12-31', group: 'day' }, 'UTC'), problem(400));
});

test('one thousand short intervals sum before formatting while v1 keeps endpoint truncation', () => {
  const base = workforceInstantMicroseconds('2026-09-21T12:00:00Z');
  const rows = Array.from({ length: 1000 }, (_, i) => row(workforceUtcFromMicroseconds(base + BigInt(i) * 1000n + 100n), workforceUtcFromMicroseconds(base + BigInt(i) * 1000n + 200n)));
  const report = aggregateSegmentsV2(rows, day, 'UTC', later);
  assert.equal(report.workMicroseconds, '100000');
  assert.equal(workforceExactSeconds(report.workMicroseconds), '0.100000');
  assert.equal(sum(report.rows.map(r => r.duration_microseconds)), report.workMicroseconds);
  assert.equal(report.staff[0].workMicroseconds, report.workMicroseconds);
  assert.equal(report.buckets[0].workMicroseconds, report.workMicroseconds);
  assert.equal(report.contributingRowCount, 1000);
  assert.equal(aggregateSegments(rows, day, 'UTC', new Date(later)).workMs, 0);
});

test('exact same-millisecond clipping preserves original durations, open ends and as-of', () => {
  const asOf = '2026-09-21T00:00:00.000006Z';
  const report = aggregateSegmentsV2([
    row('2026-09-20T23:59:59.999999Z', '2026-09-21T00:00:00.000004Z'),
    row('2026-09-21T00:00:00.000004Z', null, { kind: 'break' }),
    row('2026-09-21T00:00:00.000007Z', '2026-09-21T00:00:00.000009Z'),
  ], day, 'UTC', asOf);
  assert.equal(report.workMicroseconds, '4'); assert.equal(report.breakMicroseconds, '2');
  assert.equal(report.rows[0].recorded_duration_microseconds, '5');
  assert.equal(report.rows[0].started_at, '2026-09-20T23:59:59.999999Z');
  assert.equal(report.rows[0].clipped_started_at, '2026-09-21T00:00:00.000000Z');
  assert.equal(report.rows[1].recorded_duration_microseconds, null); assert.equal(report.rows[1].ended_at, null);
  assert.equal(report.rows[1].clipped_ended_at, asOf);
  assert.equal(report.rows[2].duration_microseconds, '0'); assert.equal(report.rows[2].clipped_started_at, null); assert.equal(report.rows[2].clipped_ended_at, null);
  assert.equal(report.sourceRowCount, 3); assert.equal(report.contributingRowCount, 2);
});

test('range-end clipping is exact and independent of later as-of', () => {
  const report = aggregateSegmentsV2([row('2026-09-21T23:59:59.999999Z', '2026-09-22T00:00:00.000001Z')], day, 'UTC', '2026-09-23T00:00:00.000000Z');
  assert.equal(report.workMicroseconds, '1'); assert.equal(report.rows[0].recorded_duration_microseconds, '2');
  assert.equal(report.rows[0].clipped_ended_at, report.range.toExclusive);
});

test('zero points at range start are retained, range-end points excluded, ties sort by exact start and id', () => {
  const ids = Array.from({ length: 4 }, () => randomUUID()).sort();
  const rows = ids.map((id, i) => row('2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z', { id, kind: i % 2 ? 'break' : 'work', job_id: randomUUID() })).reverse();
  rows.push(row('2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'));
  const report = aggregateSegmentsV2(rows, day, 'UTC', later);
  assert.deepEqual(report.rows.map(r => r.id), ids);
  assert.equal(report.sourceRowCount, 4); assert.equal(report.contributingRowCount, 0);
  assert.equal(report.workMicroseconds, '0'); assert.equal(report.breakMicroseconds, '0');
  assert.deepEqual(report.buckets, []); assert.deepEqual(report.staff, []);
  assert.ok(report.rows.every(r => r.recorded_duration_microseconds === '0' && r.clipped_started_at === null && r.clipped_ended_at === null));
});

test('spring-forward has 23 actual hours without a fabricated gap bucket', () => {
  const report = aggregateSegmentsV2([row('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z')],
    { start: '2026-03-08', end: '2026-03-08', group: 'hour' }, 'America/New_York', '2026-03-10T00:00:00.000000Z');
  assert.equal(report.workMicroseconds, '82800000000'); assert.equal(report.buckets.length, 23);
  assert.equal(sum(report.buckets.map(b => b.workMicroseconds)), report.workMicroseconds);
  assert.ok(report.buckets.every(b => !b.label.includes('02:00')));
});

test('fall-back retains distinct repeated-hour keys and offset labels', () => {
  const report = aggregateSegmentsV2([row('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z')],
    { start: '2026-11-01', end: '2026-11-01', group: 'hour' }, 'America/New_York', '2026-11-03T00:00:00.000000Z');
  assert.equal(report.workMicroseconds, '90000000000'); assert.equal(report.buckets.length, 25);
  const repeated = report.buckets.filter(b => b.label.includes('01:00'));
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].key, repeated[1].key); assert.notEqual(repeated[0].label, repeated[1].label);
  assert.equal(sum(report.buckets.map(b => b.workMicroseconds)), report.workMicroseconds);
});

test('month, year and ISO-week boundaries split microseconds without fixed-day assumptions', () => {
  for (const [start, end, group] of [['2026-09-30', '2026-10-01', 'month'], ['2026-12-31', '2027-01-01', 'year'], ['2026-09-20', '2026-09-21', 'week']] as const) {
    const report = aggregateSegmentsV2([row(`${start}T23:59:59.999999Z`, `${end}T00:00:00.000001Z`)],
      { start, end, group }, 'UTC', `${end}T01:00:00.000000Z`);
    assert.equal(report.workMicroseconds, '2'); assert.deepEqual(report.buckets.map(b => b.workMicroseconds), ['1', '1']);
  }
});

test('totals above safe Number range stay exact in rows, buckets, staff and JSON', () => {
  const rows = Array.from({ length: 300 }, () => row('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'));
  const report = aggregateSegmentsV2(rows, { start: '2026-01-01', end: '2026-12-31', group: 'year' }, 'UTC', '2027-01-02T00:00:00.000000Z');
  assert.equal(report.workMicroseconds, '9460800000000000');
  assert.ok(BigInt(report.workMicroseconds) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(report.staff[0].workMicroseconds, report.workMicroseconds); assert.equal(report.buckets[0].workMicroseconds, report.workMicroseconds);
  assert.equal(workforceExactSeconds(report.workMicroseconds), '9460800000.000000');
  assert.equal(JSON.parse(JSON.stringify(report)).workMicroseconds, report.workMicroseconds);
  assert.equal(workforceMicrosecondsSchema.parse('99999999999999999999'), '99999999999999999999');
  for (const bad of ['-1', '01', '1.0', '1e3', '100000000000000000000', '', ' 1']) assert.equal(workforceMicrosecondsSchema.safeParse(bad).success, false);
});

test('bad source precision, duplicate identity, reversed bounds and source caps fail explicitly', () => {
  const valid = row('2026-09-21T00:00:00Z', '2026-09-21T00:00:01Z');
  assert.throws(() => aggregateSegmentsV2([{ ...valid, started_at: new Date(valid.started_at) }], day, 'UTC', later), problem(422));
  assert.throws(() => aggregateSegmentsV2([{ ...valid, started_at: '2026-09-21T00:00:00.000Z' }], day, 'UTC', later), problem(422));
  assert.throws(() => aggregateSegmentsV2([{ ...valid, ended_at: '2026-09-20T00:00:00.000000Z' }], day, 'UTC', later), problem(422));
  assert.throws(() => aggregateSegmentsV2([valid, valid], day, 'UTC', later), problem(422));
  assert.throws(() => aggregateSegmentsV2(Array(20_001).fill(valid), day, 'UTC', later), problem(400));
  assert.throws(() => aggregateSegmentsV2([valid], day, 'UTC', '2026-09-22T00:00:00.000Z'), problem(422));
});

test('strict v2 response literals and original/clipped duration invariants reject malformed evidence', () => {
  const report = aggregateSegmentsV2([row('2026-09-21T00:00:00Z', null)], day, 'UTC', later);
  for (const change of [{ schemaVersion: 1 }, { precisionVersion: 1 }, { durationUnit: 'millisecond' }, { workMicroseconds: 86400000000 }, { workMs: 1 }])
    assert.equal(workforceReportV2Schema.safeParse({ ...report, ...change }).success, false);
  const source = report.rows[0];
  assert.equal(workforceReportRowV2Schema.safeParse({ ...source, recorded_duration_microseconds: source.duration_microseconds }).success, false);
  assert.equal(workforceReportRowV2Schema.safeParse({ ...source, clipped_ended_at: null }).success, false);
  assert.equal(workforceReportRowV2Schema.safeParse({ ...source, duration_microseconds: '0' }).success, false);
});

test('v1 CSV columns and millisecond serialization remain unchanged beside explicit v2 columns', () => {
  assert.deepEqual(reportColumns, ['employee_name', 'unit_name', 'job_title', 'kind', 'started_at', 'ended_at', 'duration_seconds', 'shift_id', 'id', 'revision']);
  assert.equal(toCsv([{ duration_seconds: 0.001 }], ['duration_seconds']), '\uFEFF"duration_seconds"\r\n"0.001"');
  assert.ok(workforceReportColumnsV2.includes('duration_microseconds'));
  assert.equal((workforceReportColumnsV2 as readonly string[]).includes('duration_seconds'), false);
  assert.equal((workforceReportColumnsV2 as readonly string[]).includes('duration_ms'), false);
});

let db: Database, owner: Actor, people: { actor: Actor; job: { id: string; unit_id: string } }[];
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'v2.foundation@example.test' });
  const user = (await db.query("SELECT id,org_id,name,email FROM users WHERE role='owner'")).rows[0];
  const jobs = (await db.query('SELECT id,unit_id FROM jobs ORDER BY unit_id,title')).rows;
  const units = [...new Set(jobs.map(j => j.unit_id))];
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', mode: 'password', unit_ids: units };
  people = [];
  for (const unit of units.slice(0, 2)) {
    const job = jobs.find(j => j.unit_id === unit)!;
    const name = 'Synthetic v2 employee', email = `${randomUUID()}@stjw.org`;
    const id = await db.transaction(tx => createStaff(tx, owner, { name, email, role: 'employee', unitIds: [unit], jobIds: [job.id] }, 'stjw.org'));
    people.push({ actor: { id, org_id: owner.org_id, name, email, role: 'employee', mode: 'password', unit_ids: [unit] }, job: { id: job.id, unit_id: unit } });
  }
});
after(async () => { await db?.close(); });
async function recorded(person: typeof people[number], start: string, end: string | null, revision = 1) {
  const shiftId = randomUUID(), id = randomUUID();
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,$6)', [shiftId, owner.org_id, person.actor.id, start, end, revision]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision) VALUES($1,$2,$3,$4,'work',$5,$6,$7)", [id, owner.org_id, shiftId, person.job.id, start, end, revision]);
  return { id, shiftId };
}
const read = (actor: Actor, query: unknown, wrapper?: (tx: Queryable) => Queryable) => db.transaction(async tx => {
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  return readWorkforceReportSourceV2(wrapper ? wrapper(tx) : tx, actor, query);
});

test('real SQL text extraction preserves six digits where the ordinary driver and v1 lose them', async () => {
  const source = await recorded(people[0], '2025-01-10T12:00:00.123400Z', '2025-01-10T12:00:00.123456Z');
  const query = { start: '2025-01-10', end: '2025-01-10', group: 'day' as const, userId: people[0].actor.id };
  const raw = (await db.query('SELECT started_at,ended_at FROM segments WHERE id=$1', [source.id])).rows[0];
  assert.equal(new Date(raw.started_at).getTime(), new Date(raw.ended_at).getTime());
  const before = (await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;
  const report = await read(owner, query);
  assert.equal(report.rows[0].started_at, '2025-01-10T12:00:00.123400Z'); assert.equal(report.rows[0].ended_at, '2025-01-10T12:00:00.123456Z');
  assert.equal(report.workMicroseconds, '56'); assert.equal(report.rows[0].recorded_duration_microseconds, '56');
  assert.equal(workforceUtcMicrosSchema.safeParse(report.asOf).success, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n, before);
  assert.equal((await getReport(db, owner, query)).workMs, 0);
});

test('SQL source uses only the active revision while preserving an old null-ended segment', async () => {
  const source = await recorded(people[0], '2025-01-11T12:00:00.000001Z', '2025-01-11T12:00:00.000004Z', 2);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision) VALUES($1,$2,$3,$4,'work',$5,NULL,1)",
    [randomUUID(), owner.org_id, source.shiftId, people[0].job.id, '2025-01-11T12:00:00.000001Z']);
  const report = await read(owner, { start: '2025-01-11', end: '2025-01-11', group: 'day', userId: people[0].actor.id });
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].revision, 2); assert.equal(report.workMicroseconds, '3');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM segments WHERE shift_id=$1 AND ended_at IS NULL', [source.shiftId])).rows[0].n, 1);
});

test('SQL zero points respect inclusive local start and exclusive next date', async () => {
  const atStart = await recorded(people[0], '2025-01-12T05:00:00.000000Z', '2025-01-12T05:00:00.000000Z');
  await recorded(people[0], '2025-01-13T05:00:00.000000Z', '2025-01-13T05:00:00.000000Z');
  const report = await read(owner, { start: '2025-01-12', end: '2025-01-12', group: 'day', userId: people[0].actor.id });
  assert.deepEqual(report.rows.map(r => r.id), [atStart.id]); assert.equal(report.workMicroseconds, '0');
});

test('internal SQL scope honors own identity and exact assigned manager unit, with PIN explicitly denied', async () => {
  await recorded(people[0], '2025-01-14T12:00:00.000001Z', '2025-01-14T12:00:00.000004Z');
  await recorded(people[1], '2025-01-14T12:00:00.000001Z', '2025-01-14T12:00:00.000004Z');
  const query = { start: '2025-01-14', end: '2025-01-14', group: 'day' };
  assert.equal((await read(owner, query)).rows.length, 2);
  assert.deepEqual((await read(people[0].actor, query)).rows.map(r => r.user_id), [people[0].actor.id]);
  assert.equal((await read(people[0].actor, { ...query, userId: people[1].actor.id })).rows.length, 0);
  const manager = { ...people[0].actor, role: 'manager' };
  assert.ok((await read(manager, query)).rows.every(r => r.unit_id === people[0].job.unit_id));
  assert.equal((await read(manager, { ...query, unitId: people[1].job.unit_id })).rows.length, 0);
  await assert.rejects(read({ ...owner, mode: 'pin' }, query), problem(403));
});

test('SQL source samples exact as-of once and only sends read queries with text boundary parameters', async () => {
  await recorded(people[0], '2025-01-15T12:00:00.123450Z', null);
  const asOf = '2025-01-15T12:00:00.123456Z', queries: { sql: string; params: unknown[] }[] = [];
  const report = await read(owner, { start: '2025-01-15', end: '2025-01-15', group: 'day', userId: people[0].actor.id }, tx => ({
    query: async <T extends Record<string, any>>(sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      const result = await tx.query<T>(sql, params);
      if (sql.includes('AS as_of')) return { ...result, rows: result.rows.map(r => ({ ...r, as_of: asOf })) };
      return result;
    },
  }));
  assert.equal(report.asOf, asOf); assert.equal(report.workMicroseconds, '6'); assert.equal(report.rows[0].ended_at, null);
  assert.equal(queries.filter(q => q.sql.includes('clock_timestamp()')).length, 1);
  assert.equal(queries.length, 2); assert.ok(queries.every(q => q.sql.trimStart().startsWith('SELECT')));
  assert.ok(queries[1].params.slice(1, 3).every(p => typeof p === 'string' && workforceUtcMicrosSchema.safeParse(p).success));
});

test('SQL negative-epoch text survives the driver and contributes the last microsecond before epoch', async () => {
  const source = await recorded(people[1], '1969-12-31T23:59:59.999999Z', '1970-01-01T00:00:00.000000Z');
  const report = await read(owner, { start: '1969-12-31', end: '1969-12-31', group: 'hour', userId: people[1].actor.id });
  assert.equal(report.rows[0].id, source.id); assert.equal(report.workMicroseconds, '1');
  assert.equal(report.rows[0].started_at, '1969-12-31T23:59:59.999999Z');
  assert.equal(sum(report.buckets.map(b => b.workMicroseconds)), '1');
});

test('SQL infinite ends and BC sources fail explicitly instead of becoming open or an AD date', async () => {
  await recorded(people[1], '2025-02-01T12:00:00Z', 'infinity');
  await assert.rejects(read(owner, { start: '2025-02-01', end: '2025-02-01', group: 'day', userId: people[1].actor.id }), problem(422));
  await recorded(people[1], '0001-01-01 00:00:00+00 BC', '2025-01-01T12:00:00Z');
  await assert.rejects(read(owner, { start: '2025-01-01', end: '2025-01-01', group: 'day', userId: people[1].actor.id }), problem(422));
});

test('source organization identity cannot be substituted for an unrelated organization', async () => {
  await assert.rejects(read({ ...owner, org_id: randomUUID() }, { start: day.start, end: day.end }), problem(404));
});
