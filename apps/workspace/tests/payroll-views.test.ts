import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { digest, issueSetup, opaqueToken, type Actor } from '../server/security';
import { createApp } from '../server/app';
import { createPayrollView, deletePayrollView, listPayrollViews, resolvePayrollView, updatePayrollView } from '../server/payroll-views';
import { payrollViewFiltersSchema, resolvePayrollViewFilters, type PayrollViewFilters } from '../shared/payroll-views';
import { workforceReportBoundsV2 } from '../server/reports-v2';

let db: Database, org: string, unit: string, otherUnit: string, job: string, otherJob: string;
const defaults = { period: 'this_week', group: 'day', comparePrevious: false } as const;
const rejectStatus = (work: () => Promise<unknown>, status: number) => assert.rejects(async () => await work(), (error: any) => error.status === status);
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'views.fixture.owner@example.test' });
  org = (await db.query('SELECT id FROM organizations')).rows[0].id;
  const jobs = (await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2')).rows;
  [job, unit, otherJob, otherUnit] = [jobs[0].id, jobs[0].unit_id, jobs[1].id, jobs[1].unit_id];
});
after(async () => { await db?.close(); });
async function account(role: Actor['role'] = 'admin', units = [unit]) {
  const id = randomUUID(), hash = digest(opaqueToken());
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic saved-view reader',$4)", [id, org, id + '@example.test', role]);
  for (const unitId of units) await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [org, id, unitId]);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic-csrf',clock_timestamp()+interval '1 hour')", [hash, org, id]);
  return { actor: { id, org_id: org, name: 'Synthetic saved-view reader', email: id + '@example.test', role, mode: 'password', unit_ids: units } as Actor, hash, proof: { mode: 'password' as const, hash } };
}
type Reader = Awaited<ReturnType<typeof account>>;
const input = (filters: Partial<PayrollViewFilters> = {}, name = 'My weekly hours') => ({ id: randomUUID(), name, filters: { ...defaults, ...filters } });
const create = (reader: Reader, value = input(), database = db) => createPayrollView(database, reader.actor, reader.hash, value);
const list = (reader: Reader, database = db) => listPayrollViews(database, reader.actor, reader.proof);
const open = (reader: Reader, id: string, database = db) => resolvePayrollView(database, reader.actor, reader.proof, id);
const audits = async (id: string) => (await db.query("SELECT action,detail FROM audit_events WHERE actor_id=$1 AND action LIKE 'payroll.view_%' ORDER BY created_at,id", [id])).rows;
function probe(callback: (tx: Queryable, sql: string, params: any[], result: { rows: Row[] }) => Promise<void>): Database {
  return { ...db, transaction: <T>(work: (tx: Queryable) => Promise<T>) => db.transaction(tx => work({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params); await callback(tx, sql, params, result); return result;
  } })) };
}
async function history(userId: string, jobId: string) {
  const shift = randomUUID();
  await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-01-01T12:00:00Z','2026-01-01T13:00:00Z')", [shift, org, userId]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work','2026-01-01T12:00:00Z','2026-01-01T13:00:00Z')", [randomUUID(), org, shift, jobId]);
}

test('personal filter views are owned by the account, scoped by organization, and never contain result rows', async () => {
  const first = await account(), second = await account(), value = input();
  const saved = await create(first, value);
  assert.equal(saved.revision, 1); assert.equal(saved.availability, 'available'); assert.equal(saved.unavailableReason, null);
  assert.deepEqual(saved.filters, defaults); assert.match(saved.createdAt, /\.\d{6}Z$/);
  assert.deepEqual((await list(first)).views, [saved]); assert.deepEqual((await list(second)).views, []);
  for (const action of [() => open(second, value.id), () => updatePayrollView(db, second.actor, second.hash, value.id, { revision: 1, name: 'Other', filters: defaults }), () => deletePayrollView(db, second.actor, second.hash, value.id, { revision: 1 })]) await rejectStatus(action, 404);
  const row = (await db.query('SELECT * FROM payroll_saved_views WHERE user_id=$1', [first.actor.id])).rows[0];
  assert.equal('result' in row, false); assert.equal('rows' in row.filters, false);
  // A client ID is namespaced to its account; it cannot overwrite someone else's view.
  await create(second, { ...value, name: 'My separate same-ID view' });
  assert.equal((await list(first)).views[0].name, value.name);
  const forged = { ...first.actor, org_id: randomUUID() };
  await rejectStatus(() => listPayrollViews(db, forged, first.proof), 403);
});

test('retry-safe concurrent creation returns one view and one audit; changed payloads never overwrite it', async () => {
  const reader = await account(), value = input({ unitId: unit.toUpperCase() }, '  Weekly hours  ');
  const [first, replay] = await Promise.all([create(reader, value), create(reader, { ...value, name: 'Weekly hours', filters: { ...value.filters, unitId: unit } })]);
  assert.deepEqual(first, replay); assert.equal((await audits(reader.actor.id)).length, 1);
  await rejectStatus(() => create(reader, { ...value, name: 'Different payload' }), 409);
  const changed = await updatePayrollView(db, reader.actor, reader.hash, first.id, { revision: 1, name: 'Renamed', filters: defaults });
  assert.equal(changed.revision, 2); assert.equal((await create(reader, value)).name, 'Renamed');
  assert.equal((await audits(reader.actor.id)).length, 2);
});

test('stale concurrent edits and deletes conflict, soft deletion is retained, and deleted IDs cannot be revived', async () => {
  const reader = await account(), value = input(), saved = await create(reader, value);
  const results = await Promise.allSettled(['First edit', 'Second edit'].map(name => updatePayrollView(db, reader.actor, reader.hash, saved.id, { revision: 1, name, filters: defaults })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  await rejectStatus(() => deletePayrollView(db, reader.actor, reader.hash, saved.id, { revision: 1 }), 409);
  assert.deepEqual(await deletePayrollView(db, reader.actor, reader.hash, saved.id, { revision: 2 }), { id: saved.id, revision: 3, deleted: true });
  assert.deepEqual((await list(reader)).views, []); await rejectStatus(() => open(reader, saved.id), 404);
  await rejectStatus(() => create(reader, value), 409);
  await rejectStatus(() => deletePayrollView(db, reader.actor, reader.hash, saved.id, { revision: 2 }), 409);
  const tombstone = (await db.query('SELECT revision,deleted_at FROM payroll_saved_views WHERE user_id=$1 AND id=$2', [reader.actor.id, saved.id])).rows[0];
  assert.equal(tombstone.revision, 3); assert.ok(tombstone.deleted_at); assert.equal((await audits(reader.actor.id)).length, 3);
  await assert.rejects(db.query('DELETE FROM payroll_saved_views WHERE user_id=$1', [reader.actor.id]), /retain their deletion evidence/);
});

test('the 25-active-view limit is serialized per account and soft deletion frees exactly one slot', async () => {
  const reader = await account(); const first = await create(reader);
  for (let i = 1; i < 24; i++) await create(reader, input({}, 'View ' + i));
  const results = await Promise.allSettled([create(reader, input({}, 'At the limit')), create(reader, input({}, 'Over the limit'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  assert.equal((await list(reader)).views.length, 25);
  await deletePayrollView(db, reader.actor, reader.hash, first.id, { revision: 1 }); await create(reader, input({}, 'Replacement'));
  assert.equal((await list(reader)).views.length, 25);
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM payroll_saved_views WHERE user_id=$1', [reader.actor.id])).rows[0].count), 26);
  assert.equal((await list(await account())).views.length, 0);
});

test('only current reporting roles can manage views; PIN and bearer writes are forbidden', async () => {
  for (const role of ['developer', 'owner', 'admin', 'finance', 'manager'] as const) {
    const reader = await account(role); assert.equal((await create(reader)).revision, 1);
  }
  const employee = await account('employee');
  await rejectStatus(() => create(employee), 403); await rejectStatus(() => list(employee), 403);
  const reader = await account(); const pinActor = { ...reader.actor, mode: 'pin' as const };
  await rejectStatus(() => listPayrollViews(db, pinActor, reader.proof), 403);
  await rejectStatus(() => createPayrollView(db, pinActor, reader.hash, input()), 403);
  await rejectStatus(() => createPayrollView(db, { ...reader.actor, mode: 'api' }, reader.hash, input()), 403);
  await rejectStatus(() => createPayrollView(db, reader.actor, undefined, input()), 401);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [reader.actor.id]);
  await rejectStatus(() => create(reader), 403); await rejectStatus(() => list(reader), 403);
});

test('API reports:read reads only the same account views and is rechecked after scope or token revocation', async () => {
  const reader = await account(), saved = await create(reader), hash = digest(opaqueToken()), tokenId = randomUUID();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic saved-view reader','[\"reports:read\"]',clock_timestamp()+interval '1 hour')", [tokenId, org, reader.actor.id, hash]);
  const actor: Actor = { ...reader.actor, mode: 'api', scopes: ['reports:read'] }, proof = { mode: 'api' as const, hash };
  assert.equal((await listPayrollViews(db, actor, proof)).views[0].id, saved.id);
  assert.equal((await resolvePayrollView(db, actor, proof, saved.id)).view.id, saved.id);
  await db.query("UPDATE api_tokens SET scopes='[\"staff:read\"]' WHERE id=$1", [tokenId]);
  await rejectStatus(() => listPayrollViews(db, actor, proof), 403);
  await db.query("UPDATE api_tokens SET scopes='[\"reports:read\"]',revoked_at=clock_timestamp() WHERE id=$1", [tokenId]);
  await rejectStatus(() => resolvePayrollView(db, actor, proof, saved.id), 403);
  await rejectStatus(() => listPayrollViews(db, actor, { ...proof, hash: undefined }), 401);
});

test('a stale unit assignment never broadens a saved filter to all units and parent membership does not imply child access', async () => {
  const reader = await account('manager'), saved = await create(reader, input({ unitId: unit }));
  await db.query('DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2', [reader.actor.id, unit]);
  const listed = (await list(reader)).views[0]; assert.equal(listed.availability, 'unavailable'); assert.equal(listed.filters.unitId, unit);
  await rejectStatus(() => open(reader, saved.id), 404);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [org, reader.actor.id, unit]);
  const child = randomUUID(); await db.query("INSERT INTO units(id,org_id,name,kind,parent_id) VALUES($1,$2,$3,'department',$4)", [child, org, 'Synthetic child ' + child, unit]);
  await rejectStatus(() => create(reader, input({ unitId: child })), 404);
  assert.equal((await open(reader, saved.id)).query.unitId, unit);
});

test('manager scope preserves own historical work outside assigned units and another employee historical work inside assigned units', async () => {
  const reader = await account('manager'), former = await account('employee', [otherUnit]);
  await history(reader.actor.id, otherJob); await history(former.actor.id, job);
  const own = await create(reader, input({ unitId: otherUnit, userId: reader.actor.id }));
  assert.equal((await open(reader, own.id)).query.unitId, otherUnit);
  const historical = await create(reader, input({ unitId: unit, userId: former.actor.id }));
  assert.equal((await open(reader, historical.id)).query.userId, former.actor.id);
  await rejectStatus(() => create(reader, input({ unitId: otherUnit, userId: former.actor.id })), 404);
  const inaccessible = await account('employee', [otherUnit]);
  await rejectStatus(() => create(reader, input({ userId: inaccessible.actor.id })), 404);
});

test('missing and deactivated selections stay explicit; foreign IDs use the same unavailable response without disclosing identities', async () => {
  const reader = await account(), target = await account('employee'), saved = await create(reader, input({ userId: target.actor.id }));
  await db.query('UPDATE users SET active=false WHERE id=$1', [target.actor.id]);
  assert.equal((await list(reader)).views[0].availability, 'unavailable'); await rejectStatus(() => open(reader, saved.id), 404);
  await rejectStatus(() => create(reader, input({ userId: target.actor.id })), 404);
  const temporaryUnit = randomUUID(); await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,'department')", [temporaryUnit, org, 'Temporary ' + temporaryUnit]);
  const unitView = await create(reader, input({ unitId: temporaryUnit })); await db.query('DELETE FROM units WHERE id=$1', [temporaryUnit]);
  assert.equal((await list(reader)).views.find(view => view.id === unitView.id)?.availability, 'unavailable');
  const foreignOrg = randomUUID(), foreignUnit = randomUUID(), foreignUser = randomUUID();
  await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic other organization','UTC')", [foreignOrg]);
  await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,'Synthetic other unit','department')", [foreignUnit, foreignOrg]);
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic other employee','employee')", [foreignUser, foreignOrg, foreignUser + '@example.test']);
  for (const filters of [{ unitId: foreignUnit }, { unitId: randomUUID() }, { userId: foreignUser }, { userId: randomUUID() }]) {
    await assert.rejects(() => create(reader, input(filters)), (error: any) => error.status === 404 && error.message === unavailableMessage);
  }
});
const unavailableMessage = 'This view uses a unit, employee or calendar range that is unavailable under your current access. Edit its filters before opening it.';

test('strict schemas reject unknown fields, invalid custom dates/ranges, stale revisions and inconsistent relative periods', async () => {
  for (const filters of [
    { ...defaults, start: '2026-09-01' }, { ...defaults, userId: 'not-a-uuid' }, { ...defaults, comparePrevious: 'true' },
    { ...defaults, group: 'quarter' }, { ...defaults, rows: [] },
    { ...defaults, period: 'custom' }, { ...defaults, period: 'custom', start: '2026-02-30', end: '2026-03-02' },
    { ...defaults, period: 'custom', start: '2026-03-02', end: '2026-03-01' },
    { ...defaults, period: 'custom', start: '2025-01-01', end: '2026-01-03' },
    { ...defaults, period: 'custom', group: 'hour', start: '2026-01-01', end: '2026-02-02' },
  ]) assert.equal(payrollViewFiltersSchema.safeParse(filters).success, false);
  const reader = await account();
  await assert.rejects(async () => create(reader, { ...input(), name: 'x'.repeat(81) }));
  await assert.rejects(async () => create(reader, { ...input(), ownerId: reader.actor.id } as any));
  assert.equal((await list(reader)).views.length, 0); assert.equal((await audits(reader.actor.id)).length, 0);
  const saved = await create(reader);
  for (const revision of [0, 1.5, 2_147_483_648, '1', undefined]) {
    await assert.rejects(async () => updatePayrollView(db, reader.actor, reader.hash, saved.id, { revision, name: 'Invalid edit', filters: defaults }));
    await assert.rejects(async () => deletePayrollView(db, reader.actor, reader.hash, saved.id, { revision }));
  }
  const unavailableDate = probe(async (_tx, sql, _params, result) => {
    if (sql.includes('AS as_of FROM organizations')) result.rows[0].timezone = 'Pacific/Apia';
  });
  await rejectStatus(() => create(reader, input({ period: 'custom', start: '2011-12-30', end: '2011-12-30' }), unavailableDate), 400);
  assert.equal((await list(reader)).views[0].revision, 1); assert.equal((await audits(reader.actor.id)).length, 1);
});

test('relative periods use organization-local dates and equal preceding calendar spans across DST and year boundaries', () => {
  const spring = resolvePayrollViewFilters({ ...defaults, comparePrevious: true }, 'America/New_York', '2026-03-08T14:00:00.000000Z');
  assert.deepEqual(spring.query, { start: '2026-03-02', end: '2026-03-08', group: 'day' });
  assert.deepEqual(spring.comparisonQuery, { start: '2026-02-23', end: '2026-03-01', group: 'day' });
  const bounds = workforceReportBoundsV2(spring.query, 'America/New_York'); assert.equal(bounds.end - bounds.start, 167n * 3_600_000_000n);
  const fall = resolvePayrollViewFilters({ ...defaults, period: 'last_14_days', comparePrevious: true }, 'America/New_York', '2026-11-01T14:00:00.000000Z');
  assert.deepEqual(fall.query, { start: '2026-10-19', end: '2026-11-01', group: 'day' });
  assert.deepEqual(fall.comparisonQuery, { start: '2026-10-05', end: '2026-10-18', group: 'day' });
  const previous = resolvePayrollViewFilters({ ...defaults, period: 'last_week' }, 'America/New_York', '2026-01-05T12:00:00.000000Z');
  assert.equal(previous.query.start, '2025-12-29'); assert.equal(previous.query.end, '2026-01-04');
  const month = resolvePayrollViewFilters({ ...defaults, period: 'this_month' }, 'America/New_York', '2026-01-01T03:30:00.000000Z');
  assert.equal(month.query.start, '2025-12-01'); assert.equal(month.query.end, '2025-12-31');
  const custom = resolvePayrollViewFilters({ ...defaults, period: 'custom', start: '2026-03-07', end: '2026-03-09', comparePrevious: true }, 'America/New_York', '2026-03-10T00:00:00.000000Z');
  assert.equal(custom.comparisonQuery?.start, '2026-03-04'); assert.equal(custom.comparisonQuery?.end, '2026-03-06');
  assert.throws(() => resolvePayrollViewFilters(defaults, 'Invalid/Zone', '2026-03-10T00:00:00.000000Z'));
  assert.throws(() => resolvePayrollViewFilters({ ...defaults, period: 'custom', start: '2011-12-30', end: '2011-12-30' }, 'Pacific/Apia', '2026-03-10T00:00:00.000000Z'));
  assert.throws(() => resolvePayrollViewFilters({ ...defaults, period: 'custom', start: '2011-12-31', end: '2011-12-31', comparePrevious: true }, 'Pacific/Apia', '2012-01-01T00:00:00.000000Z'));
  assert.throws(() => resolvePayrollViewFilters({ ...defaults, period: 'last_14_days' }, 'Pacific/Apia', '2012-01-11T12:00:00.000000Z'));
});

test('resolve uses database capture time and timezone rather than the caller clock, keeping filters scoped', async () => {
  const reader = await account(), saved = await create(reader, input({ unitId: unit, period: 'this_month', comparePrevious: true }));
  const events: string[] = [];
  const wrapped = probe(async (_tx, sql, _params, result) => {
    events.push(sql); if (sql.includes('AS as_of FROM organizations')) result.rows[0] = { timezone: 'America/New_York', as_of: '2026-01-01T03:30:00.123456Z' };
  });
  const result = await open(reader, saved.id, wrapped);
  assert.equal(events[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(result.asOf, '2026-01-01T03:30:00.123456Z'); assert.equal(result.timezone, 'America/New_York');
  assert.equal(result.query.start, '2025-12-01'); assert.equal(result.query.end, '2025-12-31');
  assert.equal(result.comparisonQuery?.unitId, unit); assert.equal(result.comparisonQuery?.start, '2025-10-31');
  assert.equal(DateTime.fromISO(result.query.start).isValid, true);
});

test('session expiry, credential replacement and inactive accounts deny publication without leaking saved names', async () => {
  for (const change of ['expired', 'removed', 'inactive', 'setup']) {
    const reader = await account(); const saved = await create(reader);
    if (change === 'expired') await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [reader.hash]);
    else if (change === 'removed') await db.query('DELETE FROM sessions WHERE token_hash=$1', [reader.hash]);
    else if (change === 'inactive') await db.query('UPDATE users SET active=false WHERE id=$1', [reader.actor.id]);
    else await db.query("UPDATE users SET requires_credential_change=true,require_password_change=true,require_pin_change=true,password_hash='synthetic-test-hash',pin_hash='synthetic-test-hash' WHERE id=$1", [reader.actor.id]);
    const status = ['expired', 'removed'].includes(change) ? 401 : 403;
    await rejectStatus(() => list(reader), status); await rejectStatus(() => open(reader, saved.id), status);
    await rejectStatus(() => create(reader), status);
  }
});

test('account UPDATE is first, and audit failure or proof expiry rolls back every mutation and audit together', async () => {
  for (const failure of ['audit', 'expiry']) for (const operation of ['create', 'update', 'delete']) {
    const reader = await account(), value = input();
    if (operation !== 'create') await create(reader, value);
    const before = (await audits(reader.actor.id)).length; let injected = false; const events: string[] = [];
    const wrapped = probe(async (tx, sql, params) => {
      events.push(sql);
      if (!injected && sql.includes('INSERT INTO audit_events') && String(params[3]).startsWith('payroll.view_')) {
        injected = true;
        if (failure === 'audit') throw Error('Synthetic audit insertion failure');
        await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [reader.hash]);
      }
    });
    const run = () => operation === 'create' ? create(reader, value, wrapped) : operation === 'update'
      ? updatePayrollView(wrapped, reader.actor, reader.hash, value.id, { revision: 1, name: 'Edited', filters: defaults })
      : deletePayrollView(wrapped, reader.actor, reader.hash, value.id, { revision: 1 });
    await assert.rejects(run, (error: any) => failure === 'audit' ? /Synthetic audit/.test(error.message) : error.status === 401);
    assert.equal(injected, true); assert.equal((await audits(reader.actor.id)).length, before);
    const firstRowLock = events.find(sql => /FOR (UPDATE|SHARE)/.test(sql))!;
    assert.match(firstRowLock, /FROM users WHERE id=\$1 AND org_id=\$2 FOR UPDATE/);
    const views = (await list(reader)).views;
    assert.equal(views.length, operation === 'create' ? 0 : 1);
    if (operation !== 'create') { assert.equal(views[0].revision, 1); assert.equal(views[0].name, value.name); }
  }
});

test('read publication rechecks sessions and bearer tokens after loading the saved filters', async () => {
  for (const mode of ['password', 'api'] as const) {
    const reader = await account(), saved = await create(reader), hash = mode === 'password' ? reader.hash : digest(opaqueToken());
    if (mode === 'api') await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic expiry proof','[\"reports:read\"]',clock_timestamp()+interval '1 hour')", [randomUUID(), org, reader.actor.id, hash]);
    let injected = false;
    const wrapped = probe(async (tx, sql) => {
      if (!injected && sql.includes('FROM payroll_saved_views')) {
        injected = true;
        await tx.query(`UPDATE ${mode === 'password' ? 'sessions' : 'api_tokens'} SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, [hash]);
      }
    });
    await rejectStatus(() => resolvePayrollView(wrapped, { ...reader.actor, mode, scopes: ['reports:read'] }, { mode, hash }, saved.id), mode === 'password' ? 401 : 403);
    assert.equal(injected, true);
    // The deliberately injected expiry is rolled back with the failed read transaction.
    assert.equal((await open(reader, saved.id)).view.id, saved.id);
  }
});

test('normal-issued password, PIN and API credentials enforce route access, CSRF, revision conflicts and soft deletion', async () => {
  const origin = 'http://localhost:3199', app = createApp(db, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner' AND email='views.fixture.owner@example.test'")).rows[0];
  const owner: Actor = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  const signed = await request(app).post('/api/auth/login').set('Origin', origin).send({ mode: 'password', email: owner.email, credential: password });
  assert.equal(signed.status, 200);
  const cookie = (signed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me = await request(app).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  const csrf = me.body.actor.csrf;
  const write = (path: string, value: unknown, method = 'post') => (request(app) as any)[method]('/api' + path).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(value);
  const value = input({ comparePrevious: true });
  assert.equal((await request(app).get('/api/payroll/views')).status, 401);
  assert.equal((await request(app).post('/api/payroll/views').set('Origin', origin).set('Cookie', cookie).send(value)).status, 403);
  assert.equal((await request(app).post('/api/payroll/views').set('Origin', 'https://foreign.example.test').set('Cookie', cookie).set('X-CSRF-Token', csrf).send(value)).status, 403);
  const created = await write('/payroll/views', value); assert.equal(created.status, 201); assert.equal(created.body.revision, 1);
  assert.equal((await write('/payroll/views', value)).body.id, value.id);
  for (const path of ['/payroll/views', `/payroll/views/${value.id}/resolve`]) {
    const read = await request(app).get('/api' + path).set('Cookie', cookie); assert.equal(read.status, 200); assert.match(read.headers['cache-control'], /no-store/);
  }
  const issued = await write('/tokens', { name: 'Synthetic saved-view reports', scopes: ['reports:read'], days: 1 }); assert.equal(issued.status, 200);
  for (const path of ['/payroll/views', `/payroll/views/${value.id}/resolve`]) assert.equal((await request(app).get('/api' + path).set('Authorization', 'Bearer ' + issued.body.token)).status, 200);
  for (const [method, path, body] of [['post', '/payroll/views', input()], ['patch', `/payroll/views/${value.id}`, { revision: 1, name: 'Bearer edit', filters: defaults }], ['delete', `/payroll/views/${value.id}`, { revision: 1 }]] as const) {
    assert.equal((await (request(app) as any)[method]('/api' + path).set('Origin', origin).set('Authorization', 'Bearer ' + issued.body.token).send(body)).status, 403);
  }
  const staffOnly = await write('/tokens', { name: 'Synthetic staff-only proof', scopes: ['staff:read'], days: 1 }); assert.equal(staffOnly.status, 200);
  assert.equal((await request(app).get('/api/payroll/views').set('Authorization', 'Bearer ' + staffOnly.body.token)).status, 403);
  assert.equal((await write('/tokens/' + issued.body.id + '/revoke', {})).status, 200);
  assert.equal((await request(app).get('/api/payroll/views').set('Authorization', 'Bearer ' + issued.body.token)).status, 403);
  assert.equal((await write('/auth/pin', { password, pin: '58392617' })).status, 200);
  const pin = await request(app).post('/api/auth/login').set('Origin', origin).send({ mode: 'pin', credential: '58392617' }); assert.equal(pin.status, 200);
  const pinCookie = (pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const pinMe = await request(app).get('/api/me').set('Cookie', pinCookie); assert.equal(pinMe.status, 200);
  for (const path of ['/payroll/views', `/payroll/views/${value.id}/resolve`]) assert.equal((await request(app).get('/api' + path).set('Cookie', pinCookie)).status, 403);
  assert.equal((await request(app).post('/api/payroll/views').set('Origin', origin).set('Cookie', pinCookie).set('X-CSRF-Token', pinMe.body.actor.csrf).send(input())).status, 403);
  assert.equal((await write('/payroll/views/' + value.id, { revision: 1, name: 'Updated through API', filters: defaults }, 'patch')).body.revision, 2);
  assert.equal((await write('/payroll/views/' + value.id, { revision: 1, name: 'Stale API edit', filters: defaults }, 'patch')).status, 409);
  assert.equal((await write('/payroll/views/' + value.id, { revision: 2 }, 'delete')).body.deleted, true);
  assert.equal((await request(app).get('/api/payroll/views/' + value.id + '/resolve').set('Cookie', cookie)).status, 404);
  assert.equal((await audits(owner.id)).length, 3);
});
