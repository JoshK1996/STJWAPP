import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { createManagedJob, issueManagedStaffSetupLink, updateStaffAccount } from '../server/staff-authority';
import { totpAt } from '../server/totp';

// Isolated PGlite; credentials are established by normal setup/login only.
// Committed-boundary gates are not real PostgreSQL lock-queue evidence.
const origin = 'http://localhost:3194';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string; role: string; units: string[]; setupUrl: string; revision?: string };
type Fixture = { user: Person; auth: Auth; target: Person; jobTitle: string };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, childId: string, otherUnit: string, jobId: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, auth: Auth, path: string, body?: unknown, method = 'post') {
  const agent = request(app(database));
  return body === undefined ? agent.get('/api' + path).set('Cookie', auth.cookie)
    : (agent as any)[method]('/api' + path).set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = ownerAuth, method = 'post') {
  const response = await send(db, auth, path, body, method); assert.ok(response.status < 300, response.body.error); return response.body;
}
async function cookieAuth(cookie: string, database = db): Promise<Auth> {
  const me = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function signIn(user: Pick<Person, 'email' | 'password'>, database = db) {
  const response = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: user.password, mode: 'password' });
  assert.equal(response.status, 200); assert.ok(response.body.challenge === undefined, 'Normal fixture login must not return an MFA challenge');
  return cookieAuth((response.headers['set-cookie'] as unknown as string[])[0].split(';')[0], database);
}
async function completeSetup(user: Person, token = new URL(user.setupUrl).hash.slice(7)) {
  const response = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password: user.password }); assert.equal(response.status, 200); return signIn(user);
}
async function person(role = 'manager', units = [unitId], setup = true): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const created = await ok('/staff', { name: 'Synthetic authority staff', email, role, unitIds: units, jobIds: role === 'employee' && units.includes(unitId) ? [jobId] : [] });
  const result: Person = { id: created.id, email, password, role, units, setupUrl: created.setupUrl };
  if (setup) await completeSetup(result); await refreshRevision(result); return result;
}
const actor = (user: Person) => ({ ...owner, id: user.id, email: user.email, role: user.role, unit_ids: user.units }) as Actor;
const bodyFor = (user: Person, changes: Record<string, unknown> = {}) => ({ name: 'Synthetic authority staff', email: user.email, role: user.role, active: true, unitIds: user.units, jobIds: user.role === 'employee' && user.units.includes(unitId) ? [jobId] : [], expectedRevision: user.revision, ...changes });
async function refreshRevision(user: Person) {
  const response = await send(db, ownerAuth, '/staff'); assert.equal(response.status, 200);
  const current = response.body.rows.find((row: any) => row.id === user.id); assert.ok(current);
  user.revision = current.revision;
}
async function changeStaff(user: Person, changes: Record<string, unknown>) { await refreshRevision(user); const result = await ok('/staff/' + user.id, bodyFor(user, changes), ownerAuth, 'patch'); await refreshRevision(user); return result; }
async function fixture(): Promise<Fixture> {
  const user = await person(), target = await person('employee', [unitId], false);
  return { user, target, auth: await signIn(user), jobTitle: 'Synthetic authority job ' + randomUUID() };
}
const routes = (f: Fixture) => [
  { kind: 'update', path: '/staff/' + f.target.id, method: 'patch', body: bodyFor(f.target, { name: 'Synthetic reviewed edit' }), action: 'staff.updated' },
  { kind: 'setup', path: '/staff/' + f.target.id + '/setup-link', method: 'post', body: {}, action: 'staff.setup_issued' },
  { kind: 'job', path: '/jobs', method: 'post', body: { unitId, title: f.jobTitle }, action: 'job.created' },
];
async function direct(f: Fixture, kind: string, proof: string | undefined, supplied = actor(f.user), database = db) {
  if (kind === 'update') return updateStaffAccount(database, supplied, proof, f.target.id, routes(f)[0].body, 'stjw.org');
  if (kind === 'setup') return issueManagedStaffSetupLink(database, supplied, proof, f.target.id, origin);
  return createManagedJob(database, supplied, proof, routes(f)[2].body);
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => observed };
}
function afterAudit(f: Fixture, action: string, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith('INSERT INTO audit_events') && params?.[2] === f.user.id && params[3] === action) { observed = true; await effect(tx); }
    return result;
  } })) };
  return { database, observed: () => observed };
}
async function state(f: Fixture) {
  return {
    target: (await db.query('SELECT id,name,email,role,active FROM users WHERE id=$1 AND org_id=$2', [f.target.id, owner.org_id])).rows,
    units: (await db.query('SELECT unit_id FROM user_units WHERE user_id=$1 ORDER BY unit_id', [f.target.id])).rows,
    jobs: (await db.query('SELECT job_id FROM user_jobs WHERE user_id=$1 ORDER BY job_id', [f.target.id])).rows,
    counts: (await db.query(`SELECT
      (SELECT count(*)::int FROM jobs WHERE org_id=$1 AND title=$3) AS created_jobs,
      (SELECT count(*)::int FROM setup_tokens WHERE user_id=$2) AS setup_tokens,
      (SELECT count(*)::int FROM setup_tokens WHERE user_id=$2 AND consumed_at IS NULL) AS live_setup_tokens,
      (SELECT count(*)::int FROM sessions WHERE user_id=$2) AS target_sessions,
      (SELECT count(*)::int FROM api_tokens WHERE user_id=$2 AND revoked_at IS NULL) AS active_target_tokens,
      (SELECT count(*)::int FROM audit_events WHERE actor_id=$4 AND action=ANY($5::text[])) AS audits`, [owner.org_id, f.target.id, f.jobTitle, f.user.id, routes(f).map(r => r.action)])).rows[0],
  };
}
async function newUnit(parentId: string | null) {
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Synthetic authority unit ' + randomUUID(), kind: 'department', parentId, description: 'Local synthetic tests', reason: 'Test explicit staff management scopes' };
  const review = await ok('/organization/units/preview', input); await ok('/organization/units/save', { ...input, structureVersion: review.structureVersion, previewHash: review.previewHash, commandId: randomUUID(), reviewed: true }); return input.id;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'staff.authority.owner@example.test' });
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200); ownerAuth = await signIn({ email: owner.email, password });
  unitId = await newUnit(null); childId = await newUnit(unitId); otherUnit = await newUnit(null); jobId = (await ok('/jobs', { unitId, title: 'Synthetic authority work' })).id;
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });

test('managed writes preserve owner/admin/manager rules and explicit subgroup assignments', async () => {
  const f = await fixture(), admin = await person('admin'), adminAuth = await signIn(admin), child = await person('employee', [childId], false);
  for (const r of routes(f)) assert.ok((await send(db, f.auth, r.path, r.body, r.method)).status < 300);
  await refreshRevision(f.target);
  assert.equal((await send(db, f.auth, '/staff/' + f.target.id, bodyFor(f.target, { role: 'manager' }), 'patch')).status, 403);
  for (const suffix of ['', '/setup-link']) assert.equal((await send(db, f.auth, '/staff/' + child.id + suffix, suffix ? {} : bodyFor(child), suffix ? 'post' : 'patch')).status, 403);
  assert.equal((await send(db, f.auth, '/jobs', { unitId: childId, title: 'Synthetic inaccessible descendant' })).status, 403);
  assert.equal((await send(db, adminAuth, '/staff/' + admin.id + '/setup-link', {})).status, 403);
  assert.equal((await send(db, adminAuth, '/staff/' + f.user.id, bodyFor(f.user, { role: 'admin' }), 'patch')).status, 403);
  assert.equal((await send(db, adminAuth, '/staff/' + child.id + '/setup-link', {})).status, 200);
  assert.equal((await send(db, ownerAuth, '/staff/' + owner.id + '/setup-link', {})).status, 403);
  await changeStaff(f.user, { unitIds: [unitId, childId] }); const current = await signIn(f.user);
  assert.equal((await send(db, current, '/staff/' + child.id + '/setup-link', {})).status, 200);
  assert.equal((await send(db, current, '/jobs', { unitId: childId, title: 'Synthetic explicitly assigned job' })).status, 201);
});

test('all public staff authority services require actual matching proof even with a privileged supplied Actor', async () => {
  const f = await fixture(), before = await state(f);
  for (const proof of [undefined, '', 'not-a-hash', ownerAuth.hash]) for (const r of routes(f)) await assert.rejects(direct(f, r.kind, proof), (e: any) => e.status === 401);
  assert.deepEqual(await state(f), before);
});

test('normal logout committed after middleware denies each managed write with no evidence changes', async () => {
  const f = await fixture(), before = await state(f);
  for (const r of routes(f)) {
    const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const response = await send(gate.database, auth, r.path, r.body, r.method); assert.ok(gate.observed()); assert.equal(response.status, 401); assert.equal(response.body.setupUrl, undefined); assert.equal(response.body.id, undefined); assert.deepEqual(await state(f), before);
  }
});

test('post-middleware role and unit removal invalidate old proof, and fresh proof cannot revive a stale actor', async () => {
  for (const loss of ['role', 'units'] as const) {
    const f = await fixture(), before = await state(f);
    for (const r of routes(f)) {
      const auth = await signIn(f.user), gate = beforeTransaction(() => changeStaff(f.user, loss === 'role' ? { role: 'employee' } : { unitIds: [otherUnit] }));
      assert.equal((await send(gate.database, auth, r.path, r.body, r.method)).status, 401); assert.ok(gate.observed());
      const current = await signIn(f.user); await assert.rejects(direct(f, r.kind, current.hash, actor(f.user)), (e: any) => e.status === 403); assert.deepEqual(await state(f), before);
      await changeStaff(f.user, {});
    }
  }
});

test('fresh target role, full target scope and inactivity restrictions are preserved', async () => {
  const f = await fixture();
  for (const kind of ['role', 'scope'] as const) {
    await changeStaff(f.target, {}); const gate = beforeTransaction(() => changeStaff(f.target, kind === 'role' ? { role: 'manager', jobIds: [] } : { unitIds: [unitId, childId] }));
    assert.equal((await send(gate.database, f.auth, '/staff/' + f.target.id + '/setup-link', {})).status, 403); assert.ok(gate.observed());
  }
  await changeStaff(f.target, { active: false }); assert.equal((await send(db, f.auth, '/staff/' + f.target.id + '/setup-link', {})).status, 403);
  const before = await state(f), inactive = beforeTransaction(() => changeStaff(f.user, { active: false }));
  assert.equal((await send(inactive.database, f.auth, '/jobs', routes(f)[2].body)).status, 403); assert.ok(inactive.observed()); assert.deepEqual(await state(f), before);
});

// Only the original INSERT of a normal new synthetic login is shortened.
// Existing sessions are never changed and no proof is fabricated.
async function shortSession(user: Person) {
  let inserted = false, expires = 0;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    if (sql.startsWith('INSERT INTO sessions') && params?.[2] === user.id) {
      assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], 'password'); assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
      inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires); return tx.query<R>(sql, changed);
    }
    return tx.query<R>(sql, params);
  } })) };
  const auth = await signIn(user, database); assert.ok(inserted); return { auth, expires };
}
const untilExpired = (expires: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 40)));

test('expiry after actual audit rolls back all three operations and suppresses setup URLs (accelerated original-session fixture)', async () => {
  const f = await fixture();
  for (const r of routes(f)) {
    const short = await shortSession(f.user), before = await state(f), gate = afterAudit(f, r.action, () => untilExpired(short.expires));
    const response = await send(gate.database, short.auth, r.path, r.body, r.method); assert.ok(gate.observed()); assert.equal(response.status, 401); assert.equal(response.body.setupUrl, undefined); assert.equal(response.body.id, undefined); assert.deepEqual(await state(f), before);
  }
});

test('actual SQL failure after audit rolls back staff edits, target session revocation, setup replacement and jobs', async () => {
  const f = await fixture(), targetAuth = await completeSetup(f.target);
  for (const r of routes(f)) {
    const before = await state(f), gate = afterAudit(f, r.action, async tx => { await tx.query('SELECT 1/0'); });
    const response = await send(gate.database, f.auth, r.path, r.body, r.method); assert.equal(response.status, 500); assert.ok(gate.observed()); assert.equal(response.body.setupUrl, undefined); assert.deepEqual(await state(f), before);
    assert.equal((await send(db, targetAuth, '/me')).status, 200);
  }
});

test('failed setup replacement preserves the previous link and a successful replacement revokes prior links', async () => {
  const f = await fixture(), before = await state(f), gate = afterAudit(f, 'staff.setup_issued', async tx => { await tx.query('SELECT 1/0'); });
  assert.equal((await send(gate.database, f.auth, '/staff/' + f.target.id + '/setup-link', {})).status, 500); assert.ok(gate.observed()); assert.deepEqual(await state(f), before);
  const targetAuth = await completeSetup(f.target); assert.equal((await send(db, targetAuth, '/me')).status, 200);
  const first = await ok('/staff/' + f.target.id + '/setup-link', {}, f.auth), second = await ok('/staff/' + f.target.id + '/setup-link', {}, f.auth);
  assert.ok(first.setupUrl !== second.setupUrl, 'Successful setup requests must return distinct links');
  const submit = (url: string) => request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(url).hash.slice(7), password: f.target.password });
  assert.equal((await submit(first.setupUrl)).status, 400); assert.equal((await submit(second.setupUrl)).status, 200);
  assert.equal((await send(db, targetAuth, '/me')).status, 401);
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test('normal MFA confirmation invalidates the middleware proof and accepts the verified replacement', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const f = await fixture(), enrollment = await send(db, f.auth, '/auth/mfa/enroll', { password: f.user.password }); assert.equal(enrollment.status, 200); let replacement = '';
    const before = await state(f), gate = beforeTransaction(async () => {
      const confirmed = await send(db, f.auth, '/auth/mfa/confirm', { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) }); assert.equal(confirmed.status, 200); replacement = (confirmed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    });
    assert.equal((await send(gate.database, f.auth, '/staff/' + f.target.id + '/setup-link', {})).status, 401); assert.ok(gate.observed()); assert.deepEqual(await state(f), before);
    const current = await cookieAuth(replacement); assert.equal((await send(db, current, '/staff/' + f.target.id + '/setup-link', {})).status, 200);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test('temporary onboarding, actual PIN and bearer proofs cannot substitute for staff password authority', async () => {
  const f = await fixture(), before = await state(f), email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const temp = await ok('/staff', { name: 'Synthetic unfinished authority', email, role: 'manager', unitIds: [unitId], jobIds: [], initialCredentials: { password, pin: '672491' } });
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: password, mode: 'password' }); assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [temp.id])).rows[0].n, 0);
  const unfinished = actor({ id: temp.id, email, password, role: 'manager', units: [unitId], setupUrl: '' });
  for (const r of routes(f)) await assert.rejects(direct(f, r.kind, ownerAuth.hash, unfinished), (e: any) => e.status === 403);
  await ok('/auth/pin', { password: f.user.password, pin: '731958' }, f.auth);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: f.user.email, credential: '731958', mode: 'pin' }); assert.equal(pin.status, 200);
  const pinAuth = await cookieAuth((pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
  for (const r of routes(f)) { assert.equal((await send(db, pinAuth, r.path, r.body, r.method)).status, 403); await assert.rejects(direct(f, r.kind, pinAuth.hash), (e: any) => e.status === 401); }
  const token = await ok('/tokens', { name: 'Synthetic staff authority denial', scopes: ['staff:read'], days: 1 });
  for (const r of routes(f)) assert.equal((await (request(app()) as any)[r.method]('/api' + r.path).set('Origin', origin).set('Authorization', 'Bearer ' + token.token).send(r.body)).status, 403);
  assert.deepEqual(await state(f), before);
});

test('a normally clocked-in target cannot be edited, and clock-out permits the existing operation', async () => {
  const f = await fixture(), targetAuth = await completeSetup(f.target);
  await ok('/clock', { action: 'clock_in', jobId, commandId: randomUUID() }, targetAuth);
  const before = await state(f); assert.equal((await send(db, f.auth, '/staff/' + f.target.id, routes(f)[0].body, 'patch')).status, 409); assert.deepEqual(await state(f), before);
  await ok('/clock', { action: 'clock_out', commandId: randomUUID() }, targetAuth);
  assert.equal((await send(db, f.auth, '/staff/' + f.target.id, routes(f)[0].body, 'patch')).status, 200); assert.equal((await send(db, targetAuth, '/me')).status, 401);
});

test('sorted initial account locks precede proof in both UUID directions and proof is last after every managed write', async () => {
  const trace: { sql: string; params?: any[] }[] = [];
  // Choose the median of three API-issued UUIDs as actor. This guarantees both
  // lock directions without probabilistic retries or altering database IDs.
  const candidates = [await person('manager', [unitId], false), await person('manager', [unitId], false), await person('manager', [unitId], false)].sort((a, b) => a.id.localeCompare(b.id));
  const user = candidates[1], targets = [candidates[0], candidates[2]];
  for (const target of targets) { await changeStaff(target, { role: 'employee', jobIds: [jobId] }); target.role = 'employee'; }
  const f: Fixture = { user, auth: await completeSetup(user), target: targets[0], jobTitle: 'Synthetic ordered job ' + randomUUID() };
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { trace.push({ sql, params }); return tx.query<R>(sql, params); } })) };
  for (const target of targets) for (const kind of ['update', 'setup']) {
    trace.length = 0; const current = { ...f, target }; await direct(current, kind, f.auth.hash, actor(f.user), database);
    const locks = trace.filter(x => /^SELECT id FROM users WHERE id=\$1 AND org_id=\$2 FOR (SHARE|UPDATE)$/.test(x.sql));
    assert.equal(locks.length, 2); assert.deepEqual(locks.map(x => x.params?.[0]), [f.user.id, target.id].sort());
    assert.ok(locks.every(x => x.sql.endsWith(x.params?.[0] === f.user.id ? 'FOR SHARE' : 'FOR UPDATE')));
    const currentActor = trace.findIndex(x => x.sql.includes('SELECT id,org_id,name,email,role,active FROM users'));
    assert.ok(currentActor > trace.indexOf(locks[1])); const proofs = trace.map((x, i) => x.sql.includes('SELECT s.token_hash FROM sessions') ? i : -1).filter(i => i >= 0);
    assert.equal(proofs.length, 2); assert.ok(proofs[0] > currentActor); assert.equal(proofs[1], trace.length - 1);
  }
  trace.length = 0; await direct(f, 'job', f.auth.hash, actor(f.user), database);
  const proof = trace.findIndex(x => x.sql.includes('SELECT s.token_hash FROM sessions')), unit = trace.findIndex(x => x.sql.includes('FROM units') && x.sql.includes('FOR SHARE'));
  assert.ok(proof >= 0 && unit > proof); assert.ok(trace.at(-1)?.sql.includes('SELECT s.token_hash FROM sessions'));
  trace.length = 0;
  const uppercase = { ...actor(f.user), id: f.user.id.toUpperCase(), org_id: owner.org_id.toUpperCase(), unit_ids: [unitId.toUpperCase()] };
  await issueManagedStaffSetupLink(database, uppercase, f.auth.hash, f.target.id.toUpperCase(), origin);
  const canonical = trace.filter(x => /^SELECT id FROM users WHERE id=\$1 AND org_id=\$2 FOR (SHARE|UPDATE)$/.test(x.sql));
  assert.deepEqual(canonical.map(x => x.params?.[0]), [f.user.id, f.target.id].sort()); assert.ok(canonical.every(x => x.params?.[1] === owner.org_id));
  trace.length = 0; await assert.rejects(issueManagedStaffSetupLink(database, uppercase, f.auth.hash, f.user.id.toUpperCase(), origin), (e: any) => e.status === 403);
  const self = trace.filter(x => /^SELECT id FROM users WHERE id=\$1 AND org_id=\$2 FOR (SHARE|UPDATE)$/.test(x.sql));
  assert.equal(self.length, 1); assert.equal(self[0].params?.[0], f.user.id); assert.ok(self[0].sql.endsWith('FOR UPDATE'));
});
