import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { previewCompensation, saveCompensation, compensationImportWorkbookContext } from '../server/compensation';
import { compensationCsvColumns, type CompensationRate } from '../shared/compensation';
import { toCsv } from '../server/reports';
import { totpAt } from '../server/totp';

// Isolated PGlite, normal API setup/login only. Committed-boundary gates do not
// establish actual multi-connection PostgreSQL lock-queue behavior.
const origin = 'http://localhost:3195', reason = 'Synthetic reviewed compensation change';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string; role: string; units: string[]; setupUrl: string; assigned: boolean };
type Input = { userId: string; jobId: string; expectedVersion: number; rates: CompensationRate[]; reason: string; sourceCsv?: string };
type Command = Input & { previewHash: string; commandId: string; reviewed: true };
type Fixture = { user: Person; auth: Auth; target: Person; first: Command; firstReceipt: any; raw: Input; command: Command; csv: string };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, otherUnit: string, jobId: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, auth: Auth, path: string, body?: unknown, method = 'post') {
  const agent = request(app(database));
  return body === undefined ? agent.get('/api' + path).set('Cookie', auth.cookie)
    : (agent as any)[method]('/api' + path).set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = ownerAuth, method = 'post') {
  const result = await send(db, auth, path, body, method); assert.ok(result.status < 300, 'Synthetic normal API operation failed'); return result.body;
}
async function cookieAuth(cookie: string, database = db): Promise<Auth> {
  const response = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(response.status, 200);
  return { cookie, csrf: response.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function signIn(user: Pick<Person, 'email' | 'password'>, database = db): Promise<Auth> {
  const response = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: user.password, mode: 'password' });
  assert.equal(response.status, 200); assert.ok(response.body.challenge === undefined && !response.body.requiresCredentialChange, 'Normal synthetic fixture requires complete password sign-in');
  const cookies = response.headers['set-cookie'] as unknown as string[]; assert.ok(cookies?.length > 0, 'Password login must create its own session');
  return cookieAuth(cookies[0].split(';')[0], database);
}
async function completeSetup(user: Person) {
  const response = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(user.setupUrl).hash.slice(7), password: user.password });
  assert.equal(response.status, 200); return signIn(user);
}
async function person(role = 'finance', setup = true, assigned = false): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const created = await ok('/staff', { name: 'Synthetic pay session staff', email, role, unitIds: [unitId], jobIds: assigned ? [jobId] : [] });
  const user = { id: created.id as string, email, password, role, units: [unitId], setupUrl: created.setupUrl as string, assigned };
  if (setup) await completeSetup(user); return user;
}
const asActor = (user: Person): Actor => ({ ...owner, id: user.id, email: user.email, role: user.role as Actor['role'], unit_ids: user.units });
async function change(user: Person, changes: Record<string, unknown>) {
  return ok('/staff/' + user.id, { expectedRevision:await testStaffRevision(db,user.id), name: 'Synthetic pay session staff', email: user.email, role: user.role, active: true,
    unitIds: user.units, jobIds: user.assigned ? [jobId] : [], ...changes }, ownerAuth, 'patch');
}
const rate = (): CompensationRate => ({ id: randomUUID(), startsOn: '2026-01-01', endsOn: null, amount: '999999999999.9999', currency: 'USD', basis: 'hour', voided: false, note: '=SYNTHETIC exact café' });
function sourceCsv(raw: Input) {
  return toCsv(raw.rates.map(r => ({ userId: raw.userId, jobId: raw.jobId, recordVersion: raw.expectedVersion, rateId: r.id, ...r, endsOn: r.endsOn ?? '' })), [...compensationCsvColumns]);
}
async function prepare(raw: Input, auth: Auth): Promise<Command> {
  const response = await send(db, auth, '/compensation/preview', raw); assert.equal(response.status, 200);
  return { ...raw, previewHash: response.body.previewHash, commandId: randomUUID(), reviewed: true };
}
async function fixture(existing?: Person): Promise<Fixture> {
  const user = existing ?? await person();
  const auth = await signIn(user), target = await person('employee', false, true), initial: Input = { userId: target.id, jobId, expectedVersion: 0, rates: [rate()], reason };
  // Direct CSV input is intentionally text; the business parser owns its exact
  // established treatment of new formula-looking notes and amount normalization.
  initial.rates[0].note = 'Synthetic exact café'; const csv = sourceCsv(initial);
  const imported = await send(db, auth, '/compensation/import-preview', { userId: target.id, jobId, expectedVersion: 0, reason, csv }); assert.equal(imported.status, 200);
  const first: Command = { ...imported.body.input, previewHash: imported.body.data.previewHash, commandId: randomUUID(), reviewed: true };
  const saved = await send(db, auth, '/compensation/save', first); assert.equal(saved.status, 200);
  const raw: Input = { userId: target.id, jobId, expectedVersion: 1, rates: first.rates.map(r => ({ ...r, amount: '19.1250', note: '=SYNTHETIC exact café' })), reason };
  return { user, auth, target, first, firstReceipt: saved.body, raw, command: await prepare(raw, auth), csv };
}
const pairQuery = (f: Fixture) => new URLSearchParams({ userId: f.target.id, jobId }).toString();
const routes = (f: Fixture) => [
  { name: 'staff', path: '/compensation/staff' },
  { name: 'jobs', path: '/compensation/jobs?userId=' + f.target.id },
  { name: 'record', path: '/compensation/record?' + pairQuery(f) },
  { name: 'template', path: '/compensation/template?' + pairQuery(f) },
  { name: 'history', path: '/compensation/history?' + pairQuery(f) },
  { name: 'source', path: '/compensation/history-source?' + pairQuery(f) + '&version=1' },
  { name: 'csv', path: '/compensation/export?' + pairQuery(f) + '&format=csv' },
  { name: 'json', path: '/compensation/export?' + pairQuery(f) + '&format=json' },
  { name: 'preview', path: '/compensation/preview', body: f.raw },
  { name: 'import', path: '/compensation/import-preview', body: { userId: f.target.id, jobId, expectedVersion: 1, reason, csv: sourceCsv(f.raw) } },
  { name: 'save', path: '/compensation/save', body: f.command },
];
async function state(f: Fixture) {
  return {
    schedules: (await db.query('SELECT * FROM compensation_schedules WHERE org_id=$1 AND user_id=$2 ORDER BY id', [owner.org_id, f.target.id])).rows,
    history: (await db.query('SELECT h.* FROM compensation_history h JOIN compensation_schedules s ON s.id=h.schedule_id AND s.org_id=h.org_id WHERE s.org_id=$1 AND s.user_id=$2 ORDER BY h.version', [owner.org_id, f.target.id])).rows,
    commands: (await db.query('SELECT * FROM compensation_commands WHERE org_id=$1 AND actor_id=$2 ORDER BY command_id', [owner.org_id, f.user.id])).rows,
    audits: (await db.query("SELECT id,action,target_id,detail FROM audit_events WHERE org_id=$1 AND actor_id=$2 AND action LIKE 'compensation.%' ORDER BY id", [owner.org_id, f.user.id])).rows,
  };
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => { if (!observed) { observed = true; await action(); } return db.transaction(fn); } };
  return { database, observed: () => observed };
}
function afterQuery(match: (sql: string, params: any[] | undefined, result: { rows: Row[] }) => boolean, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params); if (!observed && match(sql, params, result)) { observed = true; await effect(tx); } return result;
  } })) };
  return { database, observed: () => observed };
}
const afterAudit = (f: Fixture, action: string, effect: (tx: Queryable) => Promise<void>) => afterQuery((sql, params) => sql.startsWith('INSERT INTO audit_events') && params?.[2] === f.user.id && params[3] === action, effect);
function noPrivateOutput(response: any) {
  assert.equal(response.headers['content-disposition'], undefined); assert.equal(response.body.rows, undefined); assert.equal(response.body.rates, undefined);
  assert.equal(response.body.schedule, undefined); assert.equal(response.body.previewHash, undefined); assert.equal(response.body.input, undefined);
}
async function newUnit() {
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Synthetic pay unit ' + randomUUID(), kind: 'department', parentId: null, description: 'Local synthetic test', reason };
  const review = await ok('/organization/units/preview', input); await ok('/organization/units/save', { ...input, structureVersion: review.structureVersion, previewHash: review.previewHash, commandId: randomUUID(), reviewed: true }); return input.id;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'compensation.session.owner@example.test' });
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200); ownerAuth = await signIn({ email: owner.email, password });
  unitId = await newUnit(); otherUnit = await newUnit(); jobId = (await ok('/jobs', { unitId, title: 'Synthetic pay session job' })).id;
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });

test('normal owner/admin/finance have organization-wide pay access; manager and employee do not', async () => {
  const f = await fixture(), admin = await person('admin'), manager = await person('manager'), employee = await person('employee');
  for (const auth of [ownerAuth, await signIn(admin), f.auth]) for (const r of routes(f).filter(r => r.name !== 'save')) {
    const response = await send(db, auth, r.path, r.body); assert.equal(response.status, 200, r.name); assert.match(response.headers['cache-control'], /private.*no-store/);
  }
  for (const denied of [manager, employee]) {
    const auth = await signIn(denied); for (const r of routes(f)) assert.equal((await send(db, auth, r.path, r.body)).status, 403, r.name);
  }
  assert.equal((await send(db, f.auth, '/compensation/record?' + new URLSearchParams({ userId: randomUUID(), jobId }))).status, 404);
  assert.equal((await send(db, f.auth, '/compensation/record?' + new URLSearchParams({ userId: f.target.id, jobId: randomUUID() }))).status, 404);
});

test('public pay services require actual matching proof and reject privileged supplied mode substitutions', async () => {
  const f = await fixture(), before = await state(f), calls = (proof: string | undefined, supplied = asActor(f.user)) => [
    () => previewCompensation(db, supplied, f.raw, proof), () => saveCompensation(db, supplied, f.command, proof),
    () => db.transaction(tx => compensationImportWorkbookContext(tx, supplied, proof, { userId: f.target.id, jobId })),
  ];
  for (const proof of [undefined, '', 'not-a-hash', '0'.repeat(64), ownerAuth.hash]) for (const call of calls(proof)) await assert.rejects(call, (e: any) => e.status === 401);
  for (const mode of ['pin', 'api'] as const) for (const call of calls(f.auth.hash, { ...asActor(f.user), mode })) await assert.rejects(call, (e: any) => e.status === 403);
  assert.deepEqual(await state(f), before);
});

test('committed normal logout after middleware denies every pay read/write/file and retained replay', async () => {
  const f = await fixture(), before = await state(f);
  for (const r of [...routes(f), { name: 'receipt', path: '/compensation/save', body: f.first }]) {
    const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const response = await send(gate.database, auth, r.path, r.body); assert.ok(gate.observed()); assert.equal(response.status, 401, r.name); noPrivateOutput(response); assert.deepEqual(await state(f), before);
  }
});

test('current role/activity and revoked membership sessions are observed without inventing finance unit scope', async () => {
  const f = await fixture();
  for (const r of routes(f).filter(r => ['preview', 'save', 'source'].includes(r.name))) {
    const auth = await signIn(f.user), before = await state(f), gate = beforeTransaction(() => change(f.user, { role: 'employee' }));
    assert.equal((await send(gate.database, auth, r.path, r.body)).status, 401); assert.ok(gate.observed());
    const current = await signIn(f.user); await assert.rejects(saveCompensation(db, asActor(f.user), f.command, current.hash), (e: any) => e.status === 403);
    assert.deepEqual(await state(f), before); await change(f.user, {});
  }
  const auth = await signIn(f.user), units = beforeTransaction(() => change(f.user, { unitIds: [otherUnit] }));
  assert.equal((await send(units.database, auth, '/compensation/record?' + pairQuery(f))).status, 401); assert.ok(units.observed());
  const fresh = await signIn(f.user); assert.equal((await send(db, fresh, '/compensation/record?' + pairQuery(f))).status, 200);
  const inactive = beforeTransaction(() => change(f.user, { active: false }));
  assert.equal((await send(inactive.database, fresh, '/compensation/preview', f.raw)).status, 403); assert.ok(inactive.observed());
});

test('exact historical receipt/source survive later edits; receipts are actor-keyed while pay history remains role-shared', async () => {
  const f = await fixture(), old = await state(f), second = await send(db, f.auth, '/compensation/save', f.command); assert.equal(second.status, 200);
  const before = await state(f), retry = await send(db, f.auth, '/compensation/save', f.first); assert.equal(retry.status, 200); assert.deepEqual(retry.body, f.firstReceipt); assert.deepEqual(await state(f), before);
  assert.equal((await send(db, f.auth, '/compensation/save', { ...f.first, reason: 'Different retained payload' })).status, 409);
  const source = await send(db, f.auth, '/compensation/history-source?' + pairQuery(f) + '&version=1'); assert.equal(source.status, 200); assert.equal(source.text, f.csv);
  const other = await person(), otherAuth = await signIn(other); assert.equal((await send(db, otherAuth, '/compensation/save', f.first)).status, 409);
  const shared = await send(db, otherAuth, '/compensation/history-source?' + pairQuery(f) + '&version=1'); assert.equal(shared.status, 200); assert.equal(shared.text, f.csv);
  const retained = (await state(f)).history[0]; assert.deepEqual(retained, old.history[0]); assert.equal(retained.snapshot.rates[0].amount, '999999999999.9999');
});

// The original INSERT of a new normal synthetic login is shortened; existing
// session rows are never rewritten. This is accelerated expiry, not natural TTL acceptance.
async function shortSession(user: Person) {
  let inserted = false, expires = 0;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    if (sql.startsWith('INSERT INTO sessions') && params?.[2] === user.id) {
      assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], 'password'); assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
      inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires); return tx.query<R>(sql, changed);
    } return tx.query<R>(sql, params);
  } })) };
  const auth = await signIn(user, database); assert.ok(inserted); return { auth, expires };
}
async function expireAt(tx: Queryable, expires: number) {
  await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 40)));
  assert.equal((await tx.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [new Date(expires)])).rows[0].expired, true);
}

test('final expiry after actual pay audit rolls back changes, previews and materialized downloads', async () => {
  const f = await fixture();
  const selected = [
    { path: '/compensation/save', body: f.command, action: 'compensation.saved' },
    { path: '/compensation/preview', body: f.raw, action: 'compensation.previewed' },
    { path: '/compensation/export?' + pairQuery(f) + '&format=csv', action: 'compensation.exported' },
    { path: '/compensation/history-source?' + pairQuery(f) + '&version=1', action: 'compensation.source_downloaded' },
  ];
  for (const r of selected) {
    const short = await shortSession(f.user), before = await state(f), gate = afterAudit(f, r.action, tx => expireAt(tx, short.expires));
    const response = await send(gate.database, short.auth, r.path, r.body); assert.ok(gate.observed()); assert.equal(response.status, 401); noPrivateOutput(response); assert.deepEqual(await state(f), before);
  }
});

test('retained receipt does not bypass final expiry even though replay creates no audit', async () => {
  const f = await fixture(), short = await shortSession(f.user), before = await state(f);
  const gate = afterQuery((sql, params, result) => sql.includes('FROM compensation_commands') && params?.[1] === f.user.id && result.rows.length === 1, tx => expireAt(tx, short.expires));
  const response = await send(gate.database, short.auth, '/compensation/save', f.first); assert.ok(gate.observed()); assert.equal(response.status, 401); noPrivateOutput(response); assert.deepEqual(await state(f), before);
});

test('actual post-audit SQL failure rolls back complete pay evidence and a known-failed command can retry once', async () => {
  const f = await fixture();
  for (const r of [
    { path: '/compensation/save', body: f.command, action: 'compensation.saved' },
    { path: '/compensation/import-preview', body: routes(f).find(x => x.name === 'import')!.body, action: 'compensation.import_previewed' },
    { path: '/compensation/export?' + pairQuery(f) + '&format=json', action: 'compensation.exported' },
  ]) {
    const before = await state(f), gate = afterAudit(f, r.action, async tx => { await tx.query('SELECT 1/0'); });
    const response = await send(gate.database, f.auth, r.path, r.body); assert.ok(gate.observed()); assert.equal(response.status, 500); noPrivateOutput(response); assert.deepEqual(await state(f), before);
  }
  const saved = await send(db, f.auth, '/compensation/save', f.command); assert.equal(saved.status, 200); assert.equal(saved.body.version, 2);
  const beforeRetry = await state(f), retry = await send(db, f.auth, '/compensation/save', f.command); assert.equal(retry.status, 200); assert.deepEqual(retry.body, saved.body); assert.deepEqual(await state(f), beforeRetry);
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test('normal MFA confirmation revokes cached pay proof and its verified replacement remains usable', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const f = await fixture(), enrollment = await send(db, f.auth, '/auth/mfa/enroll', { password: f.user.password }); assert.equal(enrollment.status, 200); let replacement = '';
    const before = await state(f), gate = beforeTransaction(async () => {
      const confirmed = await send(db, f.auth, '/auth/mfa/confirm', { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) }); assert.equal(confirmed.status, 200);
      replacement = (confirmed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    });
    assert.equal((await send(gate.database, f.auth, '/compensation/save', f.command)).status, 401); assert.ok(gate.observed()); assert.deepEqual(await state(f), before);
    const current = await cookieAuth(replacement); assert.equal((await send(db, current, '/compensation/record?' + pairQuery(f))).status, 200);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test('temporary credentials, actual PIN and bearer proof cannot open pay operations or substitute for password proof', async () => {
  const f = await fixture(), before = await state(f), email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const temp = await ok('/staff', { name: 'Synthetic pay onboarding', email, role: 'finance', unitIds: [unitId], jobIds: [], initialCredentials: { password, pin: '682493' } });
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: password, mode: 'password' }); assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [temp.id])).rows[0].n, 0);
  const unfinished = asActor({ id: temp.id, email, password, role: 'finance', units: [unitId], assigned: false, setupUrl: '' });
  await assert.rejects(previewCompensation(db, unfinished, f.raw, ownerAuth.hash), (e: any) => e.status === 403);
  await ok('/auth/pin', { password: f.user.password, pin: '739152' }, f.auth);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: f.user.email, credential: '739152', mode: 'pin' }); assert.equal(pin.status, 200);
  const pinAuth = await cookieAuth((pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
  for (const r of routes(f)) assert.equal((await send(db, pinAuth, r.path, r.body)).status, 403, r.name);
  await assert.rejects(saveCompensation(db, asActor(f.user), f.command, pinAuth.hash), (e: any) => e.status === 401);
  const token = await ok('/tokens', { name: 'Synthetic pay denial', scopes: ['reports:read'], days: 1 });
  for (const r of routes(f)) {
    const req = request(app()), result = r.body === undefined ? await req.get('/api' + r.path).set('Authorization', 'Bearer ' + token.token)
      : await req.post('/api' + r.path).set('Origin', origin).set('Authorization', 'Bearer ' + token.token).send(r.body);
    assert.equal(result.status, 403, r.name);
  }
  assert.deepEqual(await state(f), before);
});

test('pair mutex and complete sorted accounts precede proof in both UUID orders, self and spelling aliases', async () => {
  const candidates = [await person('finance', false, true), await person('finance', false, true), await person('finance', false, true)].sort((a, b) => a.id.localeCompare(b.id));
  const user = candidates[1], auth = await completeSetup(user), trace: { sql: string; params?: any[] }[] = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    // Evidence remains in process. Proof values are never put in assertions/logs.
    trace.push({ sql, params }); return tx.query<R>(sql, params);
  } })) };
  for (const target of [candidates[0], candidates[2], user]) {
    const raw: Input = { userId: target.id, jobId, expectedVersion: 0, rates: [rate()], reason }; trace.length = 0;
    await previewCompensation(database, asActor(user), raw, auth.hash);
    const pairLock = trace.findIndex(x => x.sql.includes('pg_advisory_xact_lock') && x.params?.[0] === `compensation:${owner.org_id}:${target.id}:${jobId}`);
    const account = trace.findIndex(x => x.sql.includes('FROM users') && x.sql.includes('ANY($2::uuid[])') && x.sql.includes('ORDER BY id FOR SHARE'));
    const proof = trace.findIndex(x => x.sql.includes('SELECT s.token_hash FROM sessions'));
    assert.ok(pairLock >= 0 && account > pairLock && proof > account); assert.deepEqual(trace[account].params?.[1], [...new Set([user.id, target.id])].sort());
    assert.ok(trace.at(-1)?.sql.includes('SELECT s.token_hash FROM sessions'));
  }
  const target = candidates[0], raw: Input = { userId: target.id.toUpperCase(), jobId: jobId.toUpperCase(), expectedVersion: 0, rates: [rate()], reason };
  const supplied = { ...asActor(user), id: user.id.toUpperCase(), org_id: owner.org_id.toUpperCase(), unit_ids: [unitId.toUpperCase()] }; trace.length = 0;
  const review = await previewCompensation(database, supplied, raw, auth.hash);
  assert.ok(trace.some(x => x.sql.includes('pg_advisory_xact_lock') && x.params?.[0] === `compensation:${owner.org_id}:${target.id}:${jobId}`));
  const command: Command = { ...raw, previewHash: review.previewHash, commandId: randomUUID().toUpperCase(), reviewed: true };
  const saved = await saveCompensation(database, supplied, command, auth.hash); assert.deepEqual(await saveCompensation(database, supplied, command, auth.hash), saved);
  await assert.rejects(saveCompensation(database, supplied, { ...command, commandId: command.commandId.toLowerCase() }, auth.hash), (e: any) => e.status === 409);
  trace.length = 0; await db.transaction(tx => compensationImportWorkbookContext({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { trace.push({ sql, params }); return tx.query<R>(sql, params); } }, supplied, auth.hash, { userId: target.id, jobId }));
  const mutex = trace.findIndex(x => x.sql.includes('pg_advisory_xact_lock')), accounts = trace.findIndex(x => x.sql.includes('FROM users') && x.sql.includes('FOR SHARE'));
  assert.ok(mutex >= 0 && accounts > mutex);
});

test('current authority preserves inactive and unassigned historical corrections without allowing new rate identities', async () => {
  const f = await fixture(); await change(f.target, { active: false, jobIds: [], unitIds: [otherUnit] });
  assert.equal((await send(db, f.auth, '/compensation/history-source?' + pairQuery(f) + '&version=1')).status, 200);
  assert.equal((await send(db, f.auth, '/compensation/template?' + pairQuery(f))).status, 200);
  const addition = { ...f.raw, rates: [...f.raw.rates, { ...rate(), startsOn: '2026-01-01', voided: true }] };
  assert.equal((await send(db, f.auth, '/compensation/preview', addition)).status, 409);
  const command = await prepare(f.raw, f.auth); assert.equal((await send(db, f.auth, '/compensation/save', command)).status, 200);
  const source = await send(db, f.auth, '/compensation/history-source?' + pairQuery(f) + '&version=1'); assert.equal(source.text, f.csv);
});
