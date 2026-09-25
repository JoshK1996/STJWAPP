import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { issueSetup } from '../server/security';
import { staffRecordRevision } from '../server/staff-revision';

// Normal synthetic HTTP setup/login; PGlite serializes transaction concurrency.
const origin = 'http://localhost:3196', password = 'Synthetic-' + randomUUID();
type Auth = { cookie: string; csrf: string };
let db: Database, app: ReturnType<typeof createApp>, owner: Auth, adminA: Auth, adminB: Auth, jobs: any[];
function send(auth: Auth | undefined, path: string, body?: unknown, method = body === undefined ? 'get' : 'post') {
  const req = (request(app) as any)[method]('/api' + path).set('Origin', origin);
  if (auth) req.set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf);
  return body === undefined ? req : req.send(body);
}
async function login(email: string): Promise<Auth> {
  const response = await send(undefined, '/auth/login', { mode: 'password', email, credential: password });
  assert.equal(response.status, 200, response.body.error);
  const cookie = response.headers['set-cookie'][0].split(';')[0], me = await send({ cookie, csrf: '' }, '/me');
  assert.equal(me.status, 200); return { cookie, csrf: me.body.actor.csrf };
}
async function create(role = 'employee') {
  const email = randomUUID() + '@stjw.org';
  const response = await send(owner, '/staff', { name: 'Synthetic editable employee', email, role, unitIds: [jobs[0].unit_id, jobs[1].unit_id], jobIds: [jobs[0].id] });
  assert.equal(response.status, 201, response.body.error);
  const setup = await send(undefined, '/auth/setup', { token: new URL(response.body.setupUrl).hash.slice(7), password });
  assert.equal(setup.status, 200); return { id: response.body.id as string, email, auth: await login(email) };
}
async function read(id: string, auth = adminA) {
  const response = await send(auth, '/staff'); assert.equal(response.status, 200);
  const row = response.body.rows.find((person: any) => person.id === id); assert.ok(row); return row;
}
const edit = (row: any, changes: Record<string, unknown> = {}) => ({ name: row.name, email: row.email, role: row.role, active: row.active, unitIds: row.unit_ids, jobIds: row.job_ids, expectedRevision: row.revision, ...changes });
const countAudits = async (id: string) => (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='staff.updated'", [id])).rows[0].n;
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'staff.editing.owner@example.test' });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
  const identity = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, { id: identity.id, org_id: identity.org_id }));
  assert.equal((await send(undefined, '/auth/setup', { token, password })).status, 200);
  owner = await login('staff.editing.owner@example.test'); jobs = (await send(owner, '/jobs')).body.rows;
  adminA = (await create('admin')).auth; adminB = (await create('admin')).auth;
});
after(async () => { await db?.close(); });

test('staff revision is canonical, credential-free and required on full employee edits', async () => {
  const employee = await create(), row = await read(employee.id);
  assert.match(row.revision, /^[a-f0-9]{64}$/);
  assert.equal('password_hash' in row, false); assert.equal('pin_hash' in row, false);
  const me = (await send(adminA, '/me')).body;
  assert.equal(staffRecordRevision(me.actor.org_id, row), row.revision);
  assert.equal(staffRecordRevision(me.actor.org_id.toUpperCase(), { ...row, id: row.id.toUpperCase(), unit_ids: [...row.unit_ids].reverse().flatMap((id: string) => [id.toUpperCase(), id]), job_ids: [...row.job_ids, ...row.job_ids] }), row.revision);
  const legacy = edit(row); delete (legacy as any).expectedRevision;
  assert.equal((await send(adminA, '/staff/' + employee.id, legacy, 'patch')).status, 400);
  assert.equal((await send(adminA, '/staff/' + employee.id, edit(row, { expectedRevision: 'invalid' }), 'patch')).status, 400);
  assert.equal(await countAudits(employee.id), 0);
});

test('two administrators cannot silently replace another full editor name or assignments', async () => {
  const employee = await create(), first = await read(employee.id), stale = await read(employee.id, adminB);
  assert.equal((await send(adminA, '/staff/' + employee.id, edit(first, { name: 'Reviewed current name', jobIds: [jobs[0].id, jobs[1].id] }), 'patch')).status, 200);
  const currentSession = await login(employee.email), before = await read(employee.id), beforeAudits = await countAudits(employee.id);
  const rejected = await send(adminB, '/staff/' + employee.id, edit(stale, { email: 'changed.' + employee.email }), 'patch');
  assert.equal(rejected.status, 409); assert.match(rejected.body.error, /Reload latest/);
  assert.deepEqual(await read(employee.id), before); assert.equal(await countAudits(employee.id), beforeAudits);
  assert.equal((await send(currentSession, '/me')).status, 200, 'A stale edit must not revoke the current employee session.');
  const accepted = await send(adminB, '/staff/' + employee.id, edit(before, { name: 'Reviewed final name' }), 'patch');
  assert.equal(accepted.status, 200); assert.equal((await read(employee.id)).name, 'Reviewed final name');
  assert.equal((await send(currentSession, '/me')).status, 401, 'An accepted full edit retains existing session revocation.');
});

test('a stale full form cannot undo a saved narrow job assignment', async () => {
  const employee = await create(), stale = await read(employee.id, adminB);
  const source = await send(adminA, '/staff/' + employee.id + '/assignments'); assert.equal(source.status, 200, source.body.error);
  const saved = await send(adminA, '/staff/' + employee.id + '/assignments', { unitIds: source.body.unitIds, jobIds: [jobs[0].id, jobs[1].id], expectedRevision: source.body.revision }, 'put');
  assert.equal(saved.status, 200, saved.body.error);
  const before = await read(employee.id), audits = await countAudits(employee.id);
  assert.notEqual(before.revision, stale.revision);
  assert.equal((await send(adminB, '/staff/' + employee.id, edit(stale, { name: 'Old form attempt' }), 'patch')).status, 409);
  assert.deepEqual(await read(employee.id), before); assert.equal(await countAudits(employee.id), audits);
});

test('competing full edits with the same source allow only one committed update', async () => {
  const employee = await create(), source = await read(employee.id);
  const responses = await Promise.all([
    send(adminA, '/staff/' + employee.id, edit(source, { name: 'First submitted name' }), 'patch'),
    send(adminB, '/staff/' + employee.id, edit(source, { name: 'Second submitted name' }), 'patch'),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(await countAudits(employee.id), 1);
});

test('valid revision cannot bypass employee authority or the active-clock full-edit restriction', async () => {
  const employee = await create(), source = await read(employee.id);
  assert.equal((await send(employee.auth, '/staff/' + employee.id, edit(source), 'patch')).status, 403);
  assert.equal((await send(employee.auth, '/clock', { action: 'clock_in', jobId: jobs[0].id, commandId: randomUUID() })).status, 200);
  const blocked = await send(adminA, '/staff/' + employee.id, edit(source, { name: 'Edited while working' }), 'patch');
  assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Clock out/);
  assert.equal((await send(employee.auth, '/clock', { action: 'clock_out', commandId: randomUUID() })).status, 200);
  assert.deepEqual(await read(employee.id), source); assert.equal(await countAudits(employee.id), 0);
});
