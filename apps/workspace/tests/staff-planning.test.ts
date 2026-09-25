import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { performance } from 'node:perf_hooks';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { getStaffPlanning, saveCoverageRule, saveHoursTarget, previewStaffPlanning, applyStaffPlanning, planningDefinitionHistory } from '../server/staff-planning';
import { expandCoverage, measureCoverage, openCoverageSlots, measureTargets, hoursMicroseconds, elapsedWithin } from '../server/staff-planning-engine';
import { authenticatedScheduleDatabase, createSchedule } from '../server/staff-scheduling';
import { updateManagedJob } from '../server/staff-authority';
import { assertRuntimeAccess, runtimeGrantsSql } from '../server/runtime-access';
import type { CoverageRule, PlanningPreview, PlanningQuery } from '../shared/staff-planning';
import type { StaffScheduleSnapshot } from '../shared/staff-scheduling';

type Person = { actor: Actor; proof: string; cookie: string; csrf: string };
const origin = 'http://localhost:3199', zone = 'America/New_York';
let db: Database, app: ReturnType<typeof createApp>, owner: Person, unitId: string, otherUnit: string;
const status = (code: number) => (error: any) => error.status === code;
async function authenticate(id: string): Promise<Person> {
  await db.query('DELETE FROM auth_limits'); const user = (await db.query('SELECT id,org_id,email FROM users WHERE id=$1', [id])).rows[0], password = 'Synthetic-' + randomUUID();
  const token = await db.transaction(tx => issueSetup(tx, user as { id: string; org_id: string }));
  assert.equal((await request(app).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ mode: 'password', email: user.email, credential: password }); assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie'][0].split(';')[0], me = await request(app).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, proof: digest(cookie.slice(cookie.indexOf('=') + 1)), cookie, csrf: me.body.actor.csrf };
}
async function job(unit = unitId) { const id = randomUUID(); await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)', [id, owner.actor.org_id, unit, 'Synthetic planning ' + id.slice(0, 6)]); return id; }
async function employee(jobIds: string[], role = 'employee', unit = unitId) {
  const id = randomUUID(); await db.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)', [id, owner.actor.org_id, id + '@stjw.org', 'Synthetic planner ' + id.slice(0, 6), role]);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [owner.actor.org_id, id, unit]);
  for (const jobId of jobIds) await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)', [owner.actor.org_id, id, jobId]);
  return id;
}
function rule(jobId: string, changes: Record<string, unknown> = {}) { return { jobId, label: 'Synthetic weekday coverage', startDate: '2027-01-04', endDate: '2027-01-04', frequency: 'daily', interval: 1, weekdays: [], startsLocal: '08:00', endsLocal: '10:00', endDayOffset: 0, staffCount: 1, active: true, expectedVersion: 0, commandId: randomUUID(), reason: 'Synthetic planning fixture', ...changes }; }
const oneDay: PlanningQuery = { start: '2027-01-04', end: '2027-01-04' };
async function createRule(jobId: string, changes: Record<string, unknown> = {}) { const id = randomUUID(), input = rule(jobId, changes); await saveCoverageRule(db, owner.actor, owner.proof, id, input); return { id, input }; }
const read = (query: PlanningQuery = oneDay, who = owner, database = db) => getStaffPlanning(database, who.actor, who.proof, query);
const preview = (ruleId: string, query: PlanningQuery = oneDay, who = owner, database = db) => previewStaffPlanning(database, who.actor, who.proof, { query, ruleIds: [ruleId] });
function applyInput(plan: PlanningPreview, userId: string, all = false) { return { sourceHash: plan.sourceHash, assignments: (all ? plan.slots : plan.slots.slice(0, 1)).map(slot => ({ slotId: slot.id, userId })), commandId: randomUUID(), reason: 'Human reviewed synthetic choices' }; }
function probe(effect: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database { return { ...db, transaction: work => db.transaction(tx => work({ query: async<T extends Row = Row>(sql: string, params: any[] = []) => { const result = await tx.query<T>(sql, params); await effect(tx, sql, params); return result; } })) }; }
function sampleRule(changes: Partial<CoverageRule> = {}): CoverageRule { return { id: randomUUID(), jobId: randomUUID(), label: 'Synthetic recurrence', timezone: zone, version: 1, startDate: '2024-01-31', endDate: null, frequency: 'monthly', interval: 1, weekdays: [], startsLocal: '08:00', endsLocal: '09:00', endDayOffset: 0, staffCount: 1, active: true, ...changes }; }
function shift(rule: CoverageRule, userId: string, startsAt: string, endsAt: string): StaffScheduleSnapshot { return { id: randomUUID(), userId, employeeName: 'Synthetic employee', jobId: rule.jobId, jobTitle: 'Synthetic job', unitId: randomUUID(), unitName: 'Synthetic unit', startsAt, endsAt, note: '', version: 1, status: 'scheduled', updatedAt: startsAt, cancelledAt: null }; }
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'planning.owner@example.test' });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: 'stjw.org' }); owner = await authenticate((await db.query("SELECT id FROM users WHERE role='owner'")).rows[0].id);
  const units = (await db.query('SELECT id FROM units ORDER BY id')).rows; unitId = units[0].id; otherUnit = units[1].id;
});
after(async () => { await db?.close(); });

test('calendar recurrence skips nonexistent month/year dates and blocks ambiguous or missing DST local times', () => {
  const monthly = expandCoverage([sampleRule()], { start: '2024-01-01', end: '2024-04-30' });
  assert.deepEqual(monthly.occurrences.map(row => row.date), ['2024-01-31', '2024-03-31']); assert.equal(monthly.warnings.filter(row => row.code === 'SKIPPED_DATE').length, 2);
  const leap = sampleRule({ startDate: '2024-02-29', frequency: 'yearly' });
  assert.equal(expandCoverage([leap], { start: '2025-01-01', end: '2025-12-31' }).occurrences.length, 0); assert.equal(expandCoverage([leap], { start: '2028-01-01', end: '2028-12-31' }).occurrences.length, 1);
  for (const [date, time] of [['2027-03-14', '02:30'], ['2027-11-07', '01:30']]) {
    const result = expandCoverage([sampleRule({ startDate: date, endDate: date, frequency: 'daily', startsLocal: time, endsLocal: '04:00' })], { start: date, end: date });
    assert.equal(result.occurrences.length, 0); assert.equal(result.warnings[0].code, 'DST_BLOCKED');
  }
  const weekly = expandCoverage([sampleRule({ startDate: '2027-01-04', frequency: 'weekly', weekdays: [1, 3], interval: 2 })], { start: '2027-01-04', end: '2027-01-24' });
  assert.deepEqual(weekly.occurrences.map(row => row.date), ['2027-01-04', '2027-01-06', '2027-01-18', '2027-01-20']);
});

test('coverage measures partial shift gaps and unique employees with exact microseconds; open seats merge adjacent gaps', () => {
  const current = sampleRule({ startDate: oneDay.start, endDate: oneDay.end, frequency: 'daily', staffCount: 2 }), expanded = expandCoverage([current], oneDay), occurrence = expanded.occurrences[0], a = randomUUID(), b = randomUUID();
  const middle = occurrence.startsAt.slice(0, 11) + '13:30:00.000001Z';
  const rows = [shift(current, a, occurrence.startsAt, occurrence.endsAt), shift(current, a, occurrence.startsAt, occurrence.endsAt), shift(current, b, occurrence.startsAt, middle)];
  measureCoverage(expanded.occurrences, rows);
  assert.equal(occurrence.uncoveredMicroseconds, '1799999999'); assert.equal(occurrence.excessMicroseconds, '0'); assert.equal(occurrence.slices[0].assigned, 2);
  const slots = openCoverageSlots(expanded.occurrences); assert.equal(slots.length, 1); assert.equal(slots[0].startsAt, middle);
});

test('job hours targets use exact complete calendar periods and label partial selections without prorating', () => {
  const current = sampleRule(), employeeId = randomUUID(), target = { id: randomUUID(), version: 1, jobId: current.jobId, period: 'week' as const, hours: '40.25', effectiveFrom: '2027-01-04', effectiveThrough: null, active: true };
  const rows = [shift(current, employeeId, '2027-01-04T13:00:00.000001Z', '2027-01-04T14:00:00.000002Z')];
  const result = measureTargets([target], rows, { start: '2027-01-06', end: '2027-01-06' }, zone)[0];
  assert.equal(result.start, '2027-01-04'); assert.equal(result.end, '2027-01-10'); assert.equal(result.partial, true); assert.equal(result.targetMicroseconds, hoursMicroseconds('40.25').toString()); assert.equal(result.scheduledMicroseconds, '3600000001');
  assert.equal(elapsedWithin([...rows, { ...rows[0], id: randomUUID() }], rows[0].startsAt, rows[0].endsAt), 3600000001n);
  assert.equal(elapsedWithin([...rows, { ...rows[0], id: randomUUID(), jobId: randomUUID() }], rows[0].startsAt, rows[0].endsAt), 3600000001n);
});

test('overnight windows belong to their start date and retain complete times without a second-day duplicate tail', () => {
  const current = sampleRule({ startDate: '2027-01-04', endDate: '2027-01-04', frequency: 'daily', startsLocal: '22:00', endsLocal: '06:00', endDayOffset: 1 });
  const first = expandCoverage([current], { start: '2027-01-04', end: '2027-01-04' }); assert.equal(first.occurrences.length, 1);
  assert.equal(first.occurrences[0].startsAt, '2027-01-05T03:00:00.000000Z'); assert.equal(first.occurrences[0].endsAt, '2027-01-05T11:00:00.000000Z');
  assert.equal(expandCoverage([current], { start: '2027-01-05', end: '2027-01-05' }).occurrences.length, 0);
  const next = { ...current, id: randomUUID(), startDate: '2027-01-05', endDate: '2027-01-05', startsLocal: '05:00', endsLocal: '07:00', endDayOffset: 0 as const };
  for (const date of ['2027-01-04', '2027-01-05']) { const result = expandCoverage([current, next], { start: date, end: date }); assert.equal(result.occurrences.length, 1); assert.equal(result.occurrences[0].conflict, true); assert.equal(result.warnings[0].code, 'RULE_OVERLAP'); }
});

test('definition create/edit/archive retains history, rejects stale versions and preserves exact retries', async () => {
  const jobId = await job(), current = await createRule(jobId), edit = { ...current.input, label: 'Reviewed revised coverage', expectedVersion: 1, commandId: randomUUID() };
  assert.equal((await saveCoverageRule(db, owner.actor, owner.proof, current.id, edit)).version, 2);
  assert.equal((await saveCoverageRule(db, owner.actor, owner.proof, current.id, edit)).replayed, true);
  await assert.rejects(saveCoverageRule(db, owner.actor, owner.proof, current.id, { ...edit, label: 'Stale change', commandId: randomUUID() }), status(409));
  await saveCoverageRule(db, owner.actor, owner.proof, current.id, { ...edit, active: false, expectedVersion: 2, commandId: randomUUID() });
  const history = await planningDefinitionHistory(db, owner.actor, owner.proof, 'rule', current.id); assert.deepEqual(history.rows.map(row => row.action), ['archived', 'updated', 'created']);
  assert.equal((await read({ ...oneDay, jobId })).occurrences.length, 0);
});

test('planning shows full job coverage and separate targets but creates no allowance until explicitly selected assignments apply', async () => {
  const jobId = await job(), userId = await employee([jobId]), current = await createRule(jobId, { staffCount: 2 });
  const targetId = randomUUID(); await saveHoursTarget(db, owner.actor, owner.proof, targetId, { jobId, period: 'day', hours: '8', effectiveFrom: oneDay.start, effectiveThrough: oneDay.end, active: true, expectedVersion: 0, commandId: randomUUID(), reason: 'Synthetic job target' });
  const first = await read({ ...oneDay, jobId }); assert.equal(first.schedules.length, 0); assert.equal(first.targetPeriods[0].scheduledMicroseconds, '0'); assert.equal(first.occurrences[0].staffCount, 2);
  const plan = await preview(current.id, { ...oneDay, jobId }); assert.equal(plan.slots.length, 2); assert.ok(plan.candidates.some(person => person.id === userId)); assert.equal((plan as any).assignments, undefined);
  const input = applyInput(plan, userId), result = await applyStaffPlanning(db, owner.actor, owner.proof, plan.id, input); assert.equal(result.appliedCount, 1);
  const second = await read({ ...oneDay, jobId }); assert.equal(second.schedules.length, 1); assert.equal(second.occurrences[0].slices[0].missing, 1); assert.equal(second.targetPeriods[0].scheduledMicroseconds, '7200000000');
  assert.equal((await applyStaffPlanning(db, owner.actor, owner.proof, plan.id, input)).replayed, true);
  await assert.rejects(applyStaffPlanning(db, owner.actor, owner.proof, plan.id, { ...input, commandId: randomUUID() }), status(409));
});

test('overlapping same-job requirements are explicit conflicts and cannot generate assignments', async () => {
  const jobId = await job(), a = await createRule(jobId); await createRule(jobId, { startsLocal: '09:00', endsLocal: '11:00' });
  const data = await read({ ...oneDay, jobId }); assert.ok(data.occurrences.every(row => row.conflict)); assert.equal(data.totals.requiredMicroseconds, '0'); assert.equal(data.warnings[0].code, 'RULE_OVERLAP');
  await assert.rejects(preview(a.id, { ...oneDay, jobId }), status(409));
});

test('changed source and overlapping manual schedules invalidate previews without partial writes', async () => {
  const jobId = await job(), userId = await employee([jobId]), current = await createRule(jobId), plan = await preview(current.id, { ...oneDay, jobId });
  await createSchedule(db, owner.actor, { userId, jobId, startsAt: plan.slots[0].startsAt, endsAt: plan.slots[0].endsAt, commandId: randomUUID(), note: '', reason: 'Synthetic concurrent schedule' });
  await assert.rejects(applyStaffPlanning(db, owner.actor, owner.proof, plan.id, applyInput(plan, userId)), status(409));
  assert.equal((await db.query('SELECT id FROM schedules WHERE job_id=$1', [jobId])).rows.length, 1);
});

test('explicit choices cannot assign unavailable, duplicate-overlapping or unknown employees and roll back the whole plan', async () => {
  const jobId = await job(), userId = await employee([jobId]), unrelated = await employee([]), current = await createRule(jobId, { staffCount: 2 }), plan = await preview(current.id, { ...oneDay, jobId });
  await assert.rejects(applyStaffPlanning(db, owner.actor, owner.proof, plan.id, applyInput(plan, unrelated)), status(409));
  await assert.rejects(applyStaffPlanning(db, owner.actor, owner.proof, plan.id, applyInput(plan, userId, true)), status(409));
  assert.equal((await db.query('SELECT id FROM schedules WHERE job_id=$1', [jobId])).rows.length, 0);
});

test('current password proof, actual role and explicit manager scope protect planning reads and writes', async () => {
  const outside = await job(otherUnit), inside = await job(), manager = await authenticate(await employee([inside], 'manager')), employeeActor = await authenticate(await employee([inside]));
  const managed = await getStaffPlanning(db, manager.actor, manager.proof, oneDay); assert.ok(!managed.jobs.some(job => job.id === outside));
  await assert.rejects(saveCoverageRule(db, manager.actor, manager.proof, randomUUID(), rule(outside)), status(403));
  await assert.rejects(getStaffPlanning(db, employeeActor.actor, employeeActor.proof, oneDay), status(403));
  await assert.rejects(getStaffPlanning(db, { ...owner.actor, mode: 'pin' }, owner.proof, oneDay), status(403));
  await assert.rejects(getStaffPlanning(db, owner.actor, '0'.repeat(64), oneDay), status(401));
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [manager.actor.id]); await assert.rejects(read(oneDay, manager), status(403));
});

test('plan application audit errors and late proof expiry roll back schedules, histories and immutable receipts', async () => {
  for (const failure of ['audit', 'expiry']) {
    const jobId = await job(), userId = await employee([jobId]), current = await createRule(jobId), plan = await preview(current.id, { ...oneDay, jobId });
    const database = probe(async (tx, sql, params) => { if (sql.startsWith('INSERT INTO audit_events') && params[3] === 'schedule.plan_applied') { if (failure === 'audit') throw Error('Synthetic planning audit failure'); await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [owner.proof]); } });
    await assert.rejects(applyStaffPlanning(database, owner.actor, owner.proof, plan.id, applyInput(plan, userId)), failure === 'audit' ? /Synthetic planning audit failure/ : status(401));
    assert.equal((await db.query('SELECT id FROM schedules WHERE job_id=$1', [jobId])).rows.length, 0); assert.equal((await db.query('SELECT preview_id FROM staff_planning_applications WHERE preview_id=$1', [plan.id])).rows.length, 0);
  }
});

test('legacy HTTP schedule boundary rechecks revoked proof and rolls back service history', async () => {
  const jobId = await job(), userId = await employee([jobId]), before = (await db.query('SELECT count(*)::int AS n FROM staff_schedule_history')).rows[0].n;
  await assert.rejects(createSchedule(authenticatedScheduleDatabase(db, owner.actor, '0'.repeat(64)), owner.actor, { userId, jobId, startsAt: '2027-01-07T13:00:00.000Z', endsAt: '2027-01-07T14:00:00.000Z', note: '', reason: 'Synthetic revoked proof', commandId: randomUUID() }), status(401));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM staff_schedule_history')).rows[0].n, before);
});

test('weekly target source includes complete weeks on both sides of a year boundary', async () => {
  const jobId = await job(), userId = await employee([jobId]);
  for (const [start, end] of [['2024-12-30T13:00:00.000Z', '2024-12-30T15:00:00.000Z'], ['2026-01-04T13:00:00.000Z', '2026-01-04T16:00:00.000Z']]) await createSchedule(db, owner.actor, { userId, jobId, startsAt: start, endsAt: end, commandId: randomUUID(), note: '', reason: 'Synthetic complete-week boundary' });
  await saveHoursTarget(db, owner.actor, owner.proof, randomUUID(), { jobId, period: 'week', hours: '40', effectiveFrom: '2024-12-01', effectiveThrough: '2026-02-01', active: true, expectedVersion: 0, commandId: randomUUID(), reason: 'Synthetic weekly target boundary' });
  const january = await read({ start: '2025-01-01', end: '2025-01-01', jobId }), december = await read({ start: '2025-12-31', end: '2025-12-31', jobId });
  assert.equal(january.targetPeriods[0].start, '2024-12-30'); assert.equal(january.targetPeriods[0].scheduledMicroseconds, '7200000000');
  assert.equal(december.targetPeriods[0].end, '2026-01-04'); assert.equal(december.targetPeriods[0].scheduledMicroseconds, '10800000000');
});

test('expiry at the final transaction check rolls back all selected assignments', async () => {
  const jobId = await job(), userId = await employee([jobId]), current = await createRule(jobId), plan = await preview(current.id, { ...oneDay, jobId });
  const database: Database = { ...db, transaction: work => db.transaction(tx => work({ query: async<T extends Row = Row>(sql: string, params: any[] = []) => {
    if (sql.startsWith('SELECT id FROM staff_planning_previews WHERE org_id=') && sql.includes('expires_at>clock_timestamp()')) return { rows: [] as T[] };
    return tx.query<T>(sql, params);
  } })) };
  await assert.rejects(applyStaffPlanning(database, owner.actor, owner.proof, plan.id, applyInput(plan, userId)), status(409));
  assert.equal((await db.query('SELECT id FROM schedules WHERE job_id=$1', [jobId])).rows.length, 0);
  assert.equal((await db.query('SELECT preview_id FROM staff_planning_applications WHERE preview_id=$1', [plan.id])).rows.length, 0);
});

test('application locks sorted selected accounts before exclusive scoped jobs and rejects competing stale previews', async () => {
  const jobId = await job(), a = await employee([jobId]), b = await employee([jobId]), current = await createRule(jobId), first = await preview(current.id, { ...oneDay, jobId }), second = await preview(current.id, { ...oneDay, jobId });
  const statements: string[] = [], database = probe(async (_tx, sql) => { statements.push(sql); });
  const results = await Promise.allSettled([applyStaffPlanning(database, owner.actor, owner.proof, first.id, applyInput(first, a)), applyStaffPlanning(db, owner.actor, owner.proof, second.id, applyInput(second, b))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal((results.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  const accounts = statements.findIndex(sql => sql.startsWith('SELECT id FROM users') && sql.includes('ORDER BY id FOR NO KEY UPDATE'));
  const jobs = statements.findIndex(sql => sql.startsWith('SELECT id,unit_id FROM jobs') && sql.includes('ORDER BY id FOR UPDATE'));
  assert.ok(accounts >= 0 && jobs > accounts); assert.equal((await db.query('SELECT id FROM schedules WHERE job_id=$1', [jobId])).rows.length, 1);
});

test('rule and target history keep referenced jobs in their original community after definition moves', async () => {
  const oldJob = await job(), newJob = await job(), current = await createRule(oldJob);
  await saveCoverageRule(db, owner.actor, owner.proof, current.id, { ...current.input, jobId: newJob, expectedVersion: 1, commandId: randomUUID() });
  const row = (await db.query('SELECT title,description,version FROM jobs WHERE id=$1', [oldJob])).rows[0];
  await assert.rejects(updateManagedJob(db, owner.actor, owner.proof, oldJob, { unitId: otherUnit, title: row.title, description: row.description, active: true, expectedVersion: row.version, reason: 'Synthetic moved definition guard' }), status(409));
});

test('HTTP planning reads and writes use ordinary password authentication, CSRF and private responses', async () => {
  const jobId = await job(), id = randomUUID(), path = '/api/schedules/planning/rules/' + id;
  assert.equal((await request(app).put(path).set('Origin', origin).set('Cookie', owner.cookie).send(rule(jobId))).status, 403);
  const saved = await request(app).put(path).set('Origin', origin).set('Cookie', owner.cookie).set('X-CSRF-Token', owner.csrf).send(rule(jobId)); assert.equal(saved.status, 200, saved.body.error); assert.equal(saved.headers['cache-control'], 'private, no-store');
  const response = await request(app).get('/api/schedules/planning').query({ ...oneDay, jobId }).set('Cookie', owner.cookie); assert.equal(response.status, 200, response.body.error); assert.equal(response.body.rules.some((rule: any) => rule.id === id), true);
});

test('bounded annual recurrence generates 365 explicit choices quickly and rejects more than1000', () => {
  const start = performance.now(), current = sampleRule({ startDate: '2027-01-01', frequency: 'daily', staffCount: 1 });
  const data = expandCoverage([current], { start: '2027-01-01', end: '2027-12-31' }), slots = openCoverageSlots(measureCoverage(data.occurrences, []));
  assert.equal(slots.length, 365); assert.ok(performance.now() - start < 10000);
  const large = expandCoverage([{ ...current, staffCount: 3 }], { start: '2027-01-01', end: '2027-12-31' }); assert.throws(() => openCoverageSlots(measureCoverage(large.occurrences, [])), /1,000/);
});

test('1000 explicitly chosen recurring assignments use the existing audited schedule service within bounded local execution', async () => {
  const jobId = await job(), people = await Promise.all(Array.from({ length: 4 }, () => employee([jobId]))), current = await createRule(jobId, { startDate: '2027-01-01', endDate: '2027-09-07', staffCount: 4 });
  const start = performance.now(), plan = await preview(current.id, { start: '2027-01-01', end: '2027-12-31', jobId }), previewMs = performance.now() - start; assert.equal(plan.slots.length, 1000);
  const applyStart = performance.now(), result = await applyStaffPlanning(db, owner.actor, owner.proof, plan.id, { sourceHash: plan.sourceHash, assignments: plan.slots.map(slot => ({ slotId: slot.id, userId: people[slot.position - 1] })), commandId: randomUUID(), reason: 'Explicit synthetic annual bulk selection' });
  const applyMs = performance.now() - applyStart; assert.equal(result.appliedCount, 1000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM staff_schedule_history WHERE schedule_id=ANY($1::uuid[])', [result.schedules.map(row => row.id)])).rows[0].n, 1000);
  console.log(JSON.stringify({ event: 'staff_planning_local_pglite_benchmark', slots: 1000, previewMs: Math.round(previewMs), applyMs: Math.round(applyMs), payloadBytes: Buffer.byteLength(JSON.stringify(plan)) }));
});

test('restricted runtime role can save, preview and apply while retained planning evidence is immutable', async () => {
  const jobId = await job(), userId = await employee([jobId]), initialUser = (await db.query('SELECT session_user AS name')).rows[0].name;
  for (const statement of runtimeGrantsSql().match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await db.query(statement);
  try {
    await db.query('SET SESSION AUTHORIZATION stjw_runtime'); await assertRuntimeAccess(db);
    const current = await createRule(jobId), plan = await preview(current.id, { ...oneDay, jobId }); assert.equal((await applyStaffPlanning(db, owner.actor, owner.proof, plan.id, applyInput(plan, userId))).appliedCount, 1);
    await assert.rejects(db.query('DELETE FROM staff_planning_definitions'), /permission denied/);
    for (const table of ['staff_planning_history', 'staff_planning_previews', 'staff_planning_applications', 'staff_planning_commands']) await assert.rejects(db.query('DELETE FROM ' + table), /permission denied/);
  } finally { await db.query('SET SESSION AUTHORIZATION "' + String(initialUser).replaceAll('"', '""') + '"'); }
});
