import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { listPeople, createPerson, updatePerson, createPersonTransaction } from '../server/school-people';
import { currentReportActor, recheckReportSession } from '../server/report-source-access';

// Normal local setup/login only. Boundary gates exercise committed revocation,
// not genuine concurrent PostgreSQL row waits. No session rows are fabricated.
const origin = 'http://localhost:3196';
type Auth = { cookie: string; csrf: string; hash: string };
type Staff = { id: string; email: string; password: string; role: string; units: string[]; auth: Auth };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, childUnit: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, auth: Auth, path: string, body?: unknown, method = 'post') {
  const agent = request(app(database));
  return body === undefined ? agent.get('/api' + path).set('Cookie', auth.cookie)
    : (agent as any)[method]('/api' + path).set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = ownerAuth, method = 'post') {
  const r = await send(db, auth, path, body, method); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body;
}
async function signIn(user: { email: string; password: string }, database = db): Promise<Auth> {
  const login = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: user.password, mode: 'password' });
  assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, undefined);
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function staff(role = 'employee', units = [unitId], office = true): Promise<Staff> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const created = await ok('/staff', { name: 'Synthetic person office', email, role, unitIds: units, jobIds: [] });
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(created.setupUrl).hash.slice(7), password })).status, 200);
  const result = { id: created.id, email, password, role, units, auth: await signIn({ email, password }) };
  if (office) for (const unit of units) await ok('/school/office-grants', { unitId: unit, userId: result.id, enabled: true });
  return result;
}
const asActor = (s: Staff): Actor => ({ ...owner, id: s.id, email: s.email, role: s.role, unit_ids: [...s.units] });
async function staffChange(s: Staff, change: Record<string, unknown>) {
  return ok('/staff/' + s.id, { name: 'Synthetic person office', email: s.email, role: s.role, active: true, unitIds: s.units, jobIds: [], ...change }, ownerAuth, 'patch');
}
async function newUnit(parentId: string | null = null) {
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Synthetic person unit ' + randomUUID(), kind: 'school', parentId, description: 'Isolated local fixture', reason: 'Synthetic person access fixture' };
  const preview = await ok('/organization/units/preview', input); await ok('/organization/units/save', { ...input, structureVersion: preview.structureVersion, previewHash: preview.previewHash, commandId: randomUUID(), reviewed: true }); return input.id;
}
const payload = () => ({ unitId, name: 'Synthetic Contact ' + randomUUID(), email: 'synthetic@example.test', phone: '123' });
async function fixture(s?: Staff) {
  const user = s ?? await staff(), person = await ok('/school/people', payload(), user.auth);
  return { user, person, input: { name: 'Synthetic renamed contact', email: 'new@example.test', phone: '456', version: person.version } };
}
async function state() {
  return {
    people: (await db.query('SELECT * FROM school_people WHERE org_id=$1 ORDER BY id', [owner.org_id])).rows,
    history: (await db.query("SELECT * FROM school_history WHERE org_id=$1 AND entity_type LIKE 'person.%' ORDER BY id", [owner.org_id])).rows,
    audits: (await db.query("SELECT id,action,target_id,detail FROM audit_events WHERE org_id=$1 AND action LIKE 'school.person.%' ORDER BY id", [owner.org_id])).rows,
  };
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => { if (!observed) { observed = true; await action(); } return db.transaction(fn); } };
  return { database, observed: () => observed };
}
function afterQuery(match: (sql: string, params: any[] | undefined) => boolean, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params); if (!observed && match(sql, params)) { observed = true; await effect(tx); } return result;
  } })) };
  return { database, observed: () => observed };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'person.session.owner@example.test' });
  const u = (await db.query("SELECT id,org_id,name,email FROM users WHERE role='owner'")).rows[0];
  owner = { id: u.id, org_id: u.org_id, name: u.name, email: u.email, role: 'owner', mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  ownerAuth = await signIn({ email: owner.email, password }); unitId = await newUnit(); childUnit = await newUnit(unitId);
});
after(async () => { await db?.close(); });

test('normal person writes preserve request defaults, no-op versioning and contact/household permissions', async () => {
  const f = await fixture(), household = await ok('/school/households', { unitId, name: 'Synthetic household' });
  const student = await ok('/school/students', { unitId, name: 'Synthetic child', studentNumber: randomUUID() });
  await ok('/school/households/' + household.id + '/members', { personId: f.person.id, role: 'guardian' });
  await ok('/school/students/' + student.id + '/contacts', { personId: f.person.id, relationship: 'Parent', isGuardian: true, canCommunicate: false, canPickup: false, pickupUntil: null, emergencyPriority: 1, restrictionNote: 'Synthetic restriction retained' });
  const links = async () => ({ contacts: (await db.query('SELECT * FROM student_contacts WHERE person_id=$1', [f.person.id])).rows, household: (await db.query('SELECT * FROM household_members WHERE person_id=$1', [f.person.id])).rows });
  const original = await links(), result = await send(db, f.user.auth, '/school/people/' + f.person.id, { name: f.person.name, version: 1 }, 'patch');
  assert.equal(result.status, 200); assert.equal(result.body.email, ''); assert.equal(result.body.phone, ''); assert.equal(result.body.version, 2); assert.deepEqual(await links(), original);
  const noOp = await send(db, f.user.auth, '/school/people/' + f.person.id, { name: f.person.name, email: '', phone: '', version: 2 }, 'patch');
  assert.equal(noOp.status, 200); assert.equal(noOp.body.version, 3);
  const list = await send(db, f.user.auth, '/school/people?unitId=' + unitId); assert.equal(list.status, 200); assert.match(list.headers['cache-control'], /private.*no-store/);
  assert.deepEqual(Object.keys(list.body.rows.find((r: any) => r.id === f.person.id)).sort(), ['email', 'id', 'name', 'phone', 'student_id', 'version']);
  const history = (await db.query("SELECT snapshot FROM school_history WHERE entity_id=$1 AND entity_type='person.updated' ORDER BY created_at,id", [f.person.id])).rows;
  assert.equal(history.length, 2); assert.equal(history[0].snapshot.before.email, f.person.email); assert.equal(history[0].snapshot.after.email, '');
});

test('exact office unit and current owner/admin scope are authoritative, including explicit subgroups', async () => {
  const s = await staff(), admin = await staff('admin', [unitId], false);
  assert.equal((await send(db, s.auth, '/school/people?unitId=' + childUnit)).status, 403);
  assert.equal((await send(db, s.auth, '/school/people', { ...payload(), unitId: childUnit })).status, 403);
  for (const auth of [ownerAuth, admin.auth]) assert.equal((await send(db, auth, '/school/people?unitId=' + childUnit)).status, 200);
  const unrelated = await ok('/school/people', { ...payload(), unitId: childUnit });
  assert.equal((await send(db, s.auth, '/school/people/' + unrelated.id, { name: 'Synthetic denied', version: 1 }, 'patch')).status, 403);
  assert.equal((await send(db, s.auth, '/school/people?unitId=' + randomUUID())).status, 404);
});

test('all public service operations require a real matching password session hash', async () => {
  const f = await fixture(), before = await state();
  const calls = (hash: string | undefined, actor = asActor(f.user)) => [() => listPeople(db, actor, unitId, hash), () => createPerson(db, actor, payload(), hash), () => updatePerson(db, actor, f.person.id, f.input, hash)];
  for (const hash of [undefined, '', 'bad', '0'.repeat(64), ownerAuth.hash]) for (const call of calls(hash)) await assert.rejects(call, (e: any) => e.status === 401);
  for (const mode of ['api', 'pin'] as const) for (const call of calls(f.user.auth.hash, { ...asActor(f.user), mode })) await assert.rejects(call, (e: any) => e.status === 403);
  assert.deepEqual(await state(), before);
});

test('committed normal logout after middleware denies directory, create and update without evidence changes', async () => {
  const f = await fixture();
  for (const route of [{ path: '/school/people?unitId=' + unitId }, { path: '/school/people', body: payload() }, { path: '/school/people/' + f.person.id, body: f.input, method: 'patch' }]) {
    const auth = await signIn(f.user), before = await state();
    const gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const response = await send(gate.database, auth, route.path, route.body, route.method); assert.ok(gate.observed()); assert.equal(response.status, 401); assert.equal(response.body.rows, undefined); assert.deepEqual(await state(), before);
  }
});

test('fresh grants, memberships, role and active account override stale supplied authority', async () => {
  for (const change of ['grant', 'membership', 'role', 'inactive']) {
    const f = await fixture(await staff(change === 'role' ? 'admin' : 'employee', [unitId], change !== 'role'));
    const before = await state(), actor = asActor(f.user), gate = beforeTransaction(async () => {
      if (change === 'grant') await ok('/school/office-grants', { unitId, userId: f.user.id, enabled: false });
      else await staffChange(f.user, change === 'membership' ? { unitIds: [childUnit] } : change === 'role' ? { role: 'employee' } : { active: false });
    });
    await assert.rejects(updatePerson(gate.database, actor, f.person.id, f.input, f.user.auth.hash), (e: any) => [401, 403].includes(e.status));
    assert.ok(gate.observed()); assert.deepEqual(await state(), before);
    if (change === 'role' || change === 'membership') {
      const fresh = await signIn(f.user);
      await assert.rejects(listPeople(db, actor, unitId, fresh.hash), (e: any) => e.status === 403);
    }
  }
});

test('stale version and student-linked edits reject; pending applicant manual behavior remains available', async () => {
  const f = await fixture();
  assert.equal((await send(db, f.user.auth, '/school/people/' + f.person.id, { ...f.input, version: 2 }, 'patch')).status, 409);
  const student = await ok('/school/students', { unitId, name: 'Synthetic student protected', studentNumber: randomUUID() });
  const personId = (await db.query('SELECT person_id FROM students WHERE id=$1', [student.id])).rows[0].person_id;
  assert.equal((await send(db, f.user.auth, '/school/people/' + personId, { name: 'Synthetic denied rename', version: 1 }, 'patch')).status, 400);
  const year = await ok('/school/years', { unitId, name: 'Synthetic applicant year', startsOn: '2026-01-01', endsOn: '2026-12-31' });
  const application = await ok('/school/admissions', { unitId, yearId: year.id, commandId: randomUUID(), name: 'Synthetic pending applicant', gradeLevel: 'Synthetic', newContact: { name: 'Synthetic admission contact' } });
  const row = (await db.query('SELECT applicant_id FROM admission_applications WHERE id=$1', [application.id])).rows[0]; assert.ok(row);
  const edited = await send(db, f.user.auth, '/school/people/' + row.applicant_id, { name: 'Synthetic edited applicant', version: 1 }, 'patch'); assert.equal(edited.status, 200);
  assert.equal((await db.query('SELECT applicant_id FROM admission_applications WHERE id=$1', [application.id])).rows[0].applicant_id, row.applicant_id);
});

test('actual audit SQL failure rolls back the person row, school history and audit atomically', async () => {
  const f = await fixture();
  for (const r of [{ path: '/school/people', body: payload(), action: 'school.person.created' }, { path: '/school/people/' + f.person.id, body: f.input, action: 'school.person.updated', method: 'patch' }]) {
    const before = await state(), gate = afterQuery((sql, p) => sql.startsWith('INSERT INTO audit_events') && p?.[2] === f.user.id && p[3] === r.action, async tx => { await tx.query('SELECT 1/0'); });
    const response = await send(gate.database, f.user.auth, r.path, r.body, r.method); assert.ok(gate.observed()); assert.equal(response.status, 500); assert.deepEqual(await state(), before);
  }
});

// Accelerate only the original INSERT from a new normal login. Existing proof
// rows are never rewritten; expiry is confirmed using PostgreSQL's clock.
async function shortSession(s: Staff) {
  let inserted = false, expires = 0;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    if (sql.startsWith('INSERT INTO sessions') && params?.[2] === s.id) {
      assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], 'password'); assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
      inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires); return tx.query<R>(sql, changed);
    } return tx.query<R>(sql, params);
  } })) };
  const auth = await signIn(s, database); assert.ok(inserted); return { auth, expires };
}
test('final session expiry denies materialized directory and rolls back audited create/update', async () => {
  const f = await fixture();
  for (const r of [{ path: '/school/people?unitId=' + unitId }, { path: '/school/people', body: payload(), action: 'school.person.created' }, { path: '/school/people/' + f.person.id, body: f.input, method: 'patch', action: 'school.person.updated' }]) {
    const short = await shortSession(f.user), before = await state();
    const gate = afterQuery((sql, p) => r.action ? sql.startsWith('INSERT INTO audit_events') && p?.[2] === f.user.id && p[3] === r.action : sql.startsWith('SELECT p.id,p.name'), async tx => {
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, short.expires - Date.now() + 40)));
      assert.equal((await tx.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [new Date(short.expires)])).rows[0].expired, true);
    });
    const response = await send(gate.database, short.auth, r.path, r.body, r.method); assert.ok(gate.observed()); assert.equal(response.status, 401); assert.equal(response.body.rows, undefined); assert.equal(response.body.id, undefined); assert.deepEqual(await state(), before);
  }
});

test('authority and final proof bracket person locks and writes without later academic/parent locks', async () => {
  const f = await fixture(), sqls: string[] = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { sqls.push(sql); return tx.query<R>(sql, params); } })) };
  const changed = await updatePerson(database, asActor(f.user), f.person.id, f.input, f.user.auth.hash); assert.equal(changed.version, 2);
  const account = sqls.findIndex(s => s.includes('FROM users') && s.includes('FOR SHARE')), session = sqls.findIndex(s => s.includes('FROM sessions s')),
    grant = sqls.findIndex(s => s.includes('school_office_grants') && s.includes('FOR SHARE')), person = sqls.findIndex(s => s.includes('school_people') && s.includes('FOR UPDATE')),
    audit = sqls.findIndex(s => s.startsWith('INSERT INTO audit_events'));
  assert.ok(account >= 0 && account < session && session < grant && grant < person && person < audit);
  assert.ok(sqls.at(-1)?.includes('FROM sessions s')); assert.equal(sqls.filter(s => s.includes('FROM sessions s')).length, 2);
  assert.ok(!sqls.some(s => s.includes('pg_advisory') || /(?:FROM|UPDATE) (?:students|households).*FOR (?:UPDATE|SHARE)/.test(s)));
});

test('HTTP protocol keeps private results and rejects anonymous, PIN, bearer and invalid write origins', async () => {
  const f = await fixture(), routes = ['/school/people?unitId=' + unitId, '/school/people', '/school/people/' + f.person.id];
  assert.equal((await request(app()).get('/api' + routes[0])).status, 401);
  assert.equal((await request(app()).post('/api/school/people').set('Cookie', f.user.auth.cookie).set('Origin', origin).send(payload())).status, 403);
  assert.equal((await request(app()).post('/api/school/people').set('Cookie', f.user.auth.cookie).set('Origin', 'https://invalid.example').set('X-CSRF-Token', f.user.auth.csrf).send(payload())).status, 403);
  await ok('/auth/pin', { password: f.user.password, pin: '746293' }, f.user.auth);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: f.user.email, credential: '746293', mode: 'pin' }); assert.equal(pin.status, 200);
  const cookie = (pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]; assert.equal((await request(app()).get('/api' + routes[0]).set('Cookie', cookie)).status, 403);
  const token = await ok('/tokens', { name: 'Synthetic person denial', scopes: ['reports:read'], days: 1 });
  assert.equal((await request(app()).get('/api' + routes[0]).set('Authorization', 'Bearer ' + token.token)).status, 403);
  assert.equal((await send(db, f.user.auth, '/school/people', { ...payload(), isGuardian: true })).status, 400);
});

test('directory returns all 1000 records and rejects overflow without a misleading partial list', async () => {
  const largeUnit = await newUnit();
  // Synthetic domain setup through the same transaction-only write service,
  // with normal owner proof and its final check. No credential/session writes.
  await db.transaction(async tx => {
    const actor = await currentReportActor(tx, owner, ownerAuth.hash);
    for (let i = 0; i < 1000; i++) await createPersonTransaction(tx, actor, { unitId: largeUnit, name: `Synthetic bounded directory ${i}`, email: '', phone: '' });
    await recheckReportSession(tx, actor, ownerAuth.hash);
  });
  const full = await send(db, ownerAuth, '/school/people?unitId=' + largeUnit); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000);
  await ok('/school/people', { unitId: largeUnit, name: 'Synthetic overflow contact' });
  const overflow = await send(db, ownerAuth, '/school/people?unitId=' + largeUnit); assert.equal(overflow.status, 422); assert.equal(overflow.body.rows, undefined); assert.match(overflow.body.error, /No partial directory/);
});
