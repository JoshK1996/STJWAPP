import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DateTime} from 'luxon';
import {connectDatabase, migrate, type Database, type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createStaff} from '../server/workforce';
import {digest, opaqueToken, type Actor} from '../server/security';
import {listPersonalTime} from '../server/personal-time';
import {timeMicroseconds} from '../server/time-record-access';
import {adjustTimeRecord} from '../server/time-records';
import {personalTimeQuery, personalTimeReportSchema} from '../shared/personal-time';

let db: Database, owner: Actor, jobs: any[], ownerHash: string;
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, {demo: false, ownerEmail: 'personal.time.owner@example.test'});
  const user = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  jobs = (await db.query('SELECT * FROM jobs ORDER BY title')).rows;
  owner = {id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', unit_ids: jobs.map(job => job.unit_id), mode: 'password'};
  ownerHash = await session(owner);
});
after(async () => {await db?.close();});
async function session(actor: Actor, mode: 'pin' | 'password' = actor.mode as 'pin' | 'password') {
  const hash = digest(opaqueToken());
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')", [hash, actor.org_id, actor.id, mode, opaqueToken()]);
  return hash;
}
async function person(mode: 'pin' | 'password' = 'pin') {
  const email = randomUUID() + '@stjw.org';
  const id = await db.transaction(tx => createStaff(tx, owner, {name: 'Synthetic personal history worker', email, role: 'employee', unitIds: [...new Set(jobs.map(job => job.unit_id))], jobIds: jobs.map(job => job.id)}, 'stjw.org'));
  const actor: Actor = {id, org_id: owner.org_id, name: 'Synthetic personal history worker', email, role: 'employee', mode, unit_ids: jobs.map(job => job.unit_id)};
  return {actor, hash: await session(actor)};
}
type Person = Awaited<ReturnType<typeof person>>;
type Entry = {start: string; end: string | null; kind?: 'work' | 'break'; job?: any};
async function card(p: Person, entries: Entry[]) {
  const id = randomUUID();
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)', [id, p.actor.org_id, p.actor.id, entries[0].start, entries.at(-1)!.end]);
  for (const entry of entries) await db.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), p.actor.org_id, id, (entry.job ?? jobs[0]).id, entry.kind ?? 'work', entry.start, entry.end]);
  return id;
}
const hours = (count: number) => (BigInt(count) * 3600000000n).toString();
const query = (p: Person, raw: unknown = {period: 'all'}, database = db) => listPersonalTime(database, p.actor, p.hash, raw);
function intercept(operation: (sql: string, params: any[], tx: Queryable) => Promise<void>): Database {
  return {...db, transaction: fn => db.transaction(tx => fn({query: async <T extends Record<string, any>>(sql: string, params: any[] = []) => {await operation(sql, params, tx); return tx.query<T>(sql, params);}}))};
}

test('strict personal query rejects identity selectors, malformed dates and conflicting period parameters', () => {
  assert.deepEqual(personalTimeQuery.parse({}), {period: 'week', offset: 0});
  assert.equal(personalTimeQuery.parse({period: 'custom', from: '2024-02-29', to: '2024-03-01', offset: '25'}).offset, 25);
  for (const raw of [{userId: randomUUID()}, {orgId: randomUUID()}, {unitId: randomUUID()}, {jobId: randomUUID()}, {anchor: '2023-02-29'}, {anchor: '1899-12-31'}, {anchor: '9999-01-01'}, {offset: -1}, {offset: 10001}, {period: 'all', anchor: '2024-01-01'}, {period: 'custom'}, {period: 'day', from: '2024-01-01'}, {period: 'custom', from: '2024-02-02', to: '2024-01-01'}, {period: 'custom', from: '2024-02-02', to: '2024-02-02', anchor: '2024-02-02'}]) assert.equal(personalTimeQuery.safeParse(raw).success, false, JSON.stringify(raw));
});

for (const mode of ['pin', 'password'] as const) test(`${mode} sees only their current cards, with no other employee or pay data`, async () => {
  const p = await person(mode), other = await person(mode);
  const id = await card(p, [{start: '2024-05-01T12:00:00.000000Z', end: '2024-05-01T13:00:00.000000Z'}]);
  const otherId = await card(other, [{start: '2024-05-01T12:00:00.000000Z', end: '2024-05-01T20:00:00.000000Z'}]);
  const report = await query(p); assert.equal(report.summary.workMicroseconds, hours(1)); assert.deepEqual(report.rows.map(row => row.id), [id]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${otherId}|${other.actor.id}|${other.actor.email}|pay_rate|password|pin_hash|credential`));
  assert.deepEqual(personalTimeReportSchema.parse(report), report);
  const forged = await listPersonalTime(db, {...p.actor, role: 'developer', unit_ids: []}, p.hash, {period: 'all'});
  assert.equal(forged.summary.workMicroseconds, hours(1)); assert.equal(forged.rows.length, 1);
});

test('exact microseconds split overnight work, breaks and jobs without rounding individual entries', async () => {
  const p = await person();
  await card(p, [
    {start: '2024-05-02T03:59:59.999999Z', end: '2024-05-02T04:00:00.000001Z'},
    {start: '2024-05-02T04:00:00.000001Z', end: '2024-05-02T04:00:00.000003Z', kind: 'break'},
    {start: '2024-05-02T04:00:00.000003Z', end: '2024-05-02T04:00:01.000004Z', job: jobs[1]},
  ]);
  const whole = await query(p), selected = await query(p, {period: 'day', anchor: '2024-05-02'});
  assert.equal(whole.summary.workMicroseconds, '1000003'); assert.equal(whole.summary.breakMicroseconds, '2'); assert.equal(whole.summary.totalMicroseconds, '1000005');
  assert.deepEqual(whole.daily, [{date: '2024-05-01', workMicroseconds: '1', breakMicroseconds: '0'}, {date: '2024-05-02', workMicroseconds: '1000002', breakMicroseconds: '2'}]);
  assert.equal(selected.summary.workMicroseconds, '1000002'); assert.equal(selected.rows[0].workMicroseconds, '1000003'); assert.equal(selected.rows[0].periodWorkMicroseconds, '1000002');
  assert.equal(selected.rows[0].segments[0].startedAt, '2024-05-02T03:59:59.999999Z'); assert.equal(selected.rows[0].segments[0].periodWorkMicroseconds, '1');
  assert.equal(selected.jobs.find(job => job.jobId === jobs[0].id)!.workMicroseconds, '1'); assert.equal(selected.jobs.find(job => job.jobId === jobs[1].id)!.workMicroseconds, '1000001');
  assert.equal(selected.summary.daysWorked, 1); assert.equal(whole.summary.daysWorked, 2);
});

test('organization calendar days cover actual 23-hour and 25-hour daylight-saving days', async () => {
  const p = await person();
  await card(p, [{start: '2024-03-10T05:00:00.000000Z', end: '2024-03-11T04:00:00.000000Z'}]);
  await card(p, [{start: '2024-11-03T04:00:00.000000Z', end: '2024-11-04T05:00:00.000000Z'}]);
  const spring = await query(p, {period: 'day', anchor: '2024-03-10'}), fall = await query(p, {period: 'day', anchor: '2024-11-03'});
  assert.equal(spring.timezone, 'America/New_York'); assert.equal(spring.summary.workMicroseconds, hours(23)); assert.equal(fall.summary.workMicroseconds, hours(25));
  assert.equal(spring.daily.length, 1); assert.equal(fall.daily.length, 1);
  assert.equal((await query(p, {period: 'day', anchor: '2024-03-11'})).summary.shiftCount, 0);
});

test('pre-1970 microseconds floor correctly across the organization midnight boundary', async () => {
  const p = await person(); await card(p, [{start: '1969-01-02T04:59:59.999999Z', end: '1969-01-02T05:00:00.000001Z'}]);
  const report = await query(p); assert.deepEqual(report.daily, [{date: '1969-01-01', workMicroseconds: '1', breakMicroseconds: '0'}, {date: '1969-01-02', workMicroseconds: '1', breakMicroseconds: '0'}]);
});

test('week/month/year/custom bounds follow calendar dates, including leap years and year-crossing weeks', async () => {
  const p = await person();
  const week = await query(p, {period: 'week', anchor: '2024-12-31'}); assert.equal(week.range.from, '2024-12-30'); assert.equal(week.range.to, '2025-01-05');
  const month = await query(p, {period: 'month', anchor: '2024-02-15'}); assert.equal(month.range.from, '2024-02-01'); assert.equal(month.range.to, '2024-02-29');
  const year = await query(p, {period: 'year', anchor: '2024-07-01'}); assert.equal(year.range.from, '2024-01-01'); assert.equal(year.range.to, '2024-12-31'); assert.equal(year.trend.group, 'month');
  const custom = await query(p, {period: 'custom', from: '2024-01-01', to: '2024-12-31'}); assert.equal(custom.range.to, '2024-12-31');
  await assert.rejects(query(p, {period: 'custom', from: '2024-01-01', to: '2025-01-01'}), (error: any) => error.status === 422 && /366/.test(error.message));
  assert.equal((await query(p, {period: 'day', anchor: '9998-12-31'})).summary.shiftCount, 0);
  assert.equal((await query(p, {period: 'week', anchor: '1900-01-01'})).range.from, '1900-01-01');
});

test('all history spans years while pages preserve full-range totals and deterministic current cards', async () => {
  const p = await person(), ids: string[] = [];
  for (let day = 1; day <= 26; day++) {
    const start = DateTime.fromISO('2024-01-01T12:00:00Z').plus({days: day - 1});
    ids.push(await card(p, [{start: start.toUTC().toISO()!, end: start.plus({hours: 1}).toUTC().toISO()!}]));
  }
  ids.push(await card(p, [{start: '2023-01-01T12:00:00.000000Z', end: '2023-01-01T14:00:00.000000Z'}]));
  const first = await query(p), second = await query(p, {period: 'all', offset: 25}), empty = await query(p, {period: 'all', offset: 50});
  assert.equal(first.rows.length, 25); assert.equal(first.nextOffset, 25); assert.equal(second.rows.length, 2); assert.equal(second.nextOffset, null); assert.equal(second.hasMore, false);
  assert.equal(first.summary.workMicroseconds, hours(28)); assert.deepEqual(second.summary, first.summary); assert.deepEqual(empty.summary, first.summary); assert.equal(empty.rows.length, 0);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 27); assert.equal(first.history.firstDate, '2023-01-01'); assert.equal(first.history.lastDate, '2024-01-26');
  assert.deepEqual(first.trend.points, [{date: '2023-01-01', workMicroseconds: hours(2), breakMicroseconds: '0'}, {date: '2024-01-01', workMicroseconds: hours(26), breakMicroseconds: '0'}]);
  assert.equal(first.daily.length, 27);
});

test('approved administrative edits replace the effective history without double-counting retained originals', async () => {
  const p = await person(), id = await card(p, [{start: '2024-05-01T12:00:00.000000Z', end: '2024-05-01T13:00:00.000000Z'}]);
  await adjustTimeRecord(db, owner, id, {shiftId: id, sourceRevision: 1, commandId: randomUUID(), reason: 'Synthetic reviewed correction to personal history', segments: [{jobId: jobs[1].id, kind: 'work', startedAt: '2024-05-01T12:00:00.000Z', endedAt: '2024-05-01T14:00:00.000Z'}]}, ownerHash);
  await db.query('DELETE FROM user_jobs WHERE user_id=$1', [p.actor.id]); await db.query('DELETE FROM user_units WHERE user_id=$1', [p.actor.id]);
  const report = await query(p); assert.equal(report.summary.workMicroseconds, hours(2)); assert.equal(report.rows[0].revision, 2); assert.equal(report.rows[0].segments.length, 1); assert.equal(report.jobs[0].jobId, jobs[1].id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM segments WHERE shift_id=$1', [id])).rows[0].count, 2);
});

test('open shifts use a precise single observed instant and remain personal after current assignments are removed', async () => {
  const p = await person(), start = new Date(Date.now() - 3600000).toISOString(); await card(p, [{start, end: null}]);
  await db.query('DELETE FROM user_jobs WHERE user_id=$1', [p.actor.id]); await db.query('DELETE FROM user_units WHERE user_id=$1', [p.actor.id]);
  const report = await query(p); assert.equal(report.summary.openCount, 1); assert.equal(report.rows[0].endedAt, null);
  assert.equal(report.summary.workMicroseconds, (timeMicroseconds(report.observedAt) - timeMicroseconds(start)).toString());
  assert.equal(report.rows[0].segments[0].workMicroseconds, report.summary.workMicroseconds);
});

test('empty history has readable zero totals and today bounds; future stored cards never become worked time', async () => {
  const p = await person(); await card(p, [{start: '9998-01-01T12:00:00.000000Z', end: '9998-01-01T13:00:00.000000Z'}]);
  const report = await query(p); assert.equal(report.summary.shiftCount, 0); assert.equal(report.summary.totalMicroseconds, '0'); assert.deepEqual(report.history, {firstDate: null, lastDate: null});
  assert.deepEqual(report.daily, []); assert.deepEqual(report.jobs, []); assert.equal(report.range.from, DateTime.fromISO(report.observedAt, {zone: report.timezone}).toISODate());
});

test('service refuses missing, mismatched, expired and revoked session proof and API-mode actors', async () => {
  const p = await person(), other = await person(), password = await session(p.actor, 'password');
  for (const hash of [undefined as any, opaqueToken(), other.hash, password]) await assert.rejects(listPersonalTime(db, p.actor, hash, {}), (error: any) => error.status === 401);
  await assert.rejects(listPersonalTime(db, {...p.actor, mode: 'api'}, p.hash, {}), (error: any) => error.status === 403);
  await assert.rejects(listPersonalTime(db, {...p.actor, org_id: randomUUID()}, p.hash, {}), (error: any) => [401, 403].includes(error.status));
  await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [p.hash]); await assert.rejects(query(p), (error: any) => error.status === 401);
  await db.query('DELETE FROM sessions WHERE token_hash=$1', [other.hash]); await assert.rejects(query(other), (error: any) => error.status === 401);
});

test('inactive accounts and outstanding initial credential setup cannot read with stale actor snapshots', async () => {
  const inactive = await person(); await db.query('UPDATE users SET active=false WHERE id=$1', [inactive.actor.id]); await assert.rejects(query(inactive), (error: any) => error.status === 403);
  const setup = await person(); await db.query("UPDATE users SET password_hash='synthetic-unused',pin_hash='synthetic-unused',requires_credential_change=true,require_password_change=true,require_pin_change=true WHERE id=$1", [setup.actor.id]); await assert.rejects(query(setup), (error: any) => error.status === 403);
});

test('PIN personal history retains the restricted MFA exemption while password sessions require proof', async () => {
  const p = await person('password');
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic',clock_timestamp(),clock_timestamp())", [p.actor.id, p.actor.org_id, randomUUID()]);
  await assert.rejects(query(p), (error: any) => error.status === 401);
  const pinHash = await session(p.actor, 'pin'); assert.equal((await listPersonalTime(db, {...p.actor, mode: 'pin'}, pinHash, {})).summary.shiftCount, 0);
  await db.query('UPDATE sessions SET mfa_verified=true WHERE token_hash=$1', [p.hash]); assert.equal((await query(p)).summary.shiftCount, 0);
});

test('expiry after the source read and external revocation before publication both withhold history', async () => {
  const p = await person(); await card(p, [{start: '2024-05-01T12:00:00.000000Z', end: '2024-05-01T13:00:00.000000Z'}]);
  const expires = intercept(async (sql, _params, tx) => {if (sql.includes('FROM segments g JOIN shifts s')) await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [p.hash]);});
  await assert.rejects(query(p, {period: 'all'}, expires), (error: any) => error.status === 401);
  let transactions = 0;
  const revoked: Database = {...db, transaction: async fn => {const value = await db.transaction(fn); if (++transactions === 1) await db.query('DELETE FROM sessions WHERE token_hash=$1', [p.hash]); return value;}};
  await assert.rejects(query(p, {period: 'all'}, revoked), (error: any) => error.status === 401); assert.equal(transactions, 1);
});

test('large source limits fail explicitly rather than silently truncating history', async () => {
  const p = await person();
  const oversized: Database = {...db, transaction: fn => db.transaction(tx => fn({query: async <T extends Record<string, any>>(sql: string, params: any[] = []) => {
    if (sql.includes('ORDER BY s.started_at DESC,s.id LIMIT 10001')) return {rows: Array.from({length: 10001}, () => ({id: randomUUID()})) as unknown as T[]};
    return tx.query<T>(sql, params);
  }}))};
  await assert.rejects(query(p, {period: 'all'}, oversized), (error: any) => error.status === 422 && /10,000/.test(error.message) && /shorter/.test(error.message));
});
