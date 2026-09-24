import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { previewSchoolImport, applySchoolImport } from '../server/school-imports';
import { totpAt } from '../server/totp';

// Isolated PGlite with normal HTTP setup/login. These deterministic JavaScript
// gates are committed-boundary regressions, not PostgreSQL lock-queue tests.
const origin = 'http://localhost:3191';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, otherUnit: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, auth: Auth, path: string, body?: unknown) {
  const agent = request(app(database));
  return body === undefined ? agent.get('/api' + path).set('Cookie', auth.cookie)
    : agent.post('/api' + path).set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body as object);
}
async function cookieAuth(cookie: string, database = db): Promise<Auth> {
  const me = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function signIn(user: Pick<Person, 'email' | 'password'>, database = db) {
  const r = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: user.password, mode: 'password' });
  assert.equal(r.status, 200); return cookieAuth((r.headers['set-cookie'] as unknown as string[])[0].split(';')[0], database);
}
async function person(role = 'employee', office = true): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const r = await send(db, ownerAuth, '/staff', { name: 'Synthetic school import staff', email, role, unitIds: [unitId], jobIds: [] });
  assert.equal(r.status, 201);
  const setup = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(r.body.setupUrl).hash.slice(7), password });
  assert.equal(setup.status, 200);
  const user = { id: r.body.id as string, email, password }; if (office) await grant(user, true); return user;
}
async function grant(user: Person, enabled: boolean) {
  assert.equal((await send(db, ownerAuth, '/school/office-grants', { unitId, userId: user.id, enabled })).status, 200);
}
async function changeStaff(user: Person, changes: { role?: string; active?: boolean; unitIds?: string[] }) {
  const r = await request(app()).patch('/api/staff/' + user.id).set('Cookie', ownerAuth.cookie).set('Origin', origin).set('X-CSRF-Token', ownerAuth.csrf)
    .send({ name: 'Synthetic school import staff', email: user.email, role: 'employee', active: true, unitIds: [unitId], jobIds: [], ...changes });
  assert.equal(r.status, 200);
}
function input() {
  const number = 'SESSION-' + randomUUID().slice(0, 12);
  return { context: { kind: 'students', unitId }, csv: `\uFEFFstudentNumber,name,dateOfBirth\r\n${number},Synthetic student,` };
}
const body = (p: any) => ({ sourceHash: p.sourceHash, planHash: p.planHash, reviewed: true });
const supplied = (u: Person, role = 'employee') => ({ ...owner, id: u.id, email: u.email, role, unit_ids: [unitId] }) as Actor;
async function prepared(auth: Auth, database = db) {
  const raw = input(), r = await send(database, auth, '/school/imports/preview', raw); assert.equal(r.status, 201); assert.equal(r.body.plan.counts.errors, 0);
  return { raw, preview: r.body, apply: body(r.body) };
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => observed };
}
async function counts(userId: string) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM school_import_batches WHERE actor_id=$1) AS batches,
    (SELECT count(*)::int FROM school_import_batches WHERE actor_id=$1 AND applied_at IS NOT NULL) AS applied,
    (SELECT count(*)::int FROM students WHERE org_id=$2) AS students,
    (SELECT count(*)::int FROM school_people WHERE org_id=$2) AS people,
    (SELECT count(*)::int FROM school_history WHERE actor_id=$1) AS history,
    (SELECT count(*)::int FROM audit_events WHERE actor_id=$1 AND action LIKE 'school.%') AS audits`, [userId, owner.org_id])).rows[0];
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'school.session.owner@example.test' });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  [unitId, otherUnit] = (await db.query('SELECT id FROM units ORDER BY id')).rows.map(r => r.id as string);
  owner = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: 'owner', mode: 'password', unit_ids: [] } as Actor;
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  ownerAuth = await signIn({ email: owner.email, password });
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });

test('school import direct services require the actual matching password proof, never an optional bypass', async () => {
  const user = await person(), auth = await signIn(user), p = await prepared(auth), actor = supplied(user);
  const before = await counts(user.id);
  for (const proof of [undefined, '', 'not-a-hash', ownerAuth.hash]) {
    await assert.rejects(previewSchoolImport(db, actor, input(), proof), (e: any) => e.status === 401);
    await assert.rejects(applySchoolImport(db, actor, p.preview.id, p.apply, proof), (e: any) => e.status === 401);
  }
  assert.deepEqual(await counts(user.id), before);
});

test('every school import read/export denies a normal logout committed after middleware', async () => {
  const user = await person(), initial = await signIn(user), p = await prepared(initial);
  const paths = [`/school/imports/template/students?unitId=${unitId}`, `/school/imports/template/households?unitId=${unitId}&populated=true`,
    `/school/imports/identities/export?unitId=${unitId}`, `/school/imports?unitId=${unitId}`, `/school/imports/${p.preview.id}`, `/school/imports/${p.preview.id}/source`];
  const before = await counts(user.id);
  for (const path of paths) {
    const auth = await signIn(user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const r = await send(gate.database, auth, path); assert.ok(gate.observed()); assert.equal(r.status, 401, path);
    assert.equal(r.headers['content-disposition'], undefined); assert.equal(r.body.plan, undefined); assert.equal(r.body.receipt, undefined);
    assert.ok(!r.text.includes('Synthetic student'));
  }
  assert.deepEqual(await counts(user.id), before);
});

test('preview, first apply and applied receipt retry all deny committed post-middleware logout', async () => {
  const user = await person(), auth = await signIn(user), pending = await prepared(auth), applied = await prepared(auth);
  assert.equal((await send(db, auth, `/school/imports/${applied.preview.id}/apply`, applied.apply)).status, 200);
  const before = await counts(user.id);
  for (const [path, raw] of [['/school/imports/preview', input()], [`/school/imports/${pending.preview.id}/apply`, pending.apply], [`/school/imports/${applied.preview.id}/apply`, applied.apply]] as [string, unknown][]) {
    const fresh = await signIn(user), gate = beforeTransaction(async () => { assert.equal((await send(db, fresh, '/auth/logout', {})).status, 200); });
    const r = await send(gate.database, fresh, path, raw); assert.ok(gate.observed()); assert.equal(r.status, 401); assert.equal(r.body.receipt, undefined);
  }
  assert.deepEqual(await counts(user.id), before);
});

test('current role and unit membership override cached actors after normal staff changes', async () => {
  const admin = await person('admin', false), auth = await signIn(admin), stale = supplied(admin, 'admin'), before = await counts(admin.id);
  const gate = beforeTransaction(() => changeStaff(admin, { role: 'employee' }));
  assert.equal((await send(gate.database, auth, '/school/imports/preview', input())).status, 401); assert.ok(gate.observed());
  const fresh = await signIn(admin); await assert.rejects(previewSchoolImport(db, stale, input(), fresh.hash), (e: any) => e.status === 403);
  assert.deepEqual(await counts(admin.id), before);
  const office = await person(), proof = await signIn(office), batch = await prepared(proof);
  const moved = beforeTransaction(() => changeStaff(office, { unitIds: [otherUnit] }));
  assert.equal((await send(moved.database, proof, `/school/imports/${batch.preview.id}/apply`, batch.apply)).status, 401);
  const movedProof = await signIn(office); await assert.rejects(applySchoolImport(db, supplied(office), batch.preview.id, batch.apply, movedProof.hash), (e: any) => e.status === 403);
  assert.equal((await db.query('SELECT applied_at FROM school_import_batches WHERE id=$1', [batch.preview.id])).rows[0].applied_at, null);
  const inactive = await person(), activeProof = await signIn(inactive), disabled = beforeTransaction(() => changeStaff(inactive, { active: false }));
  assert.equal((await send(disabled.database, activeProof, `/school/imports/template/students?unitId=${unitId}`)).status, 403); assert.ok(disabled.observed());
});

test('committed office-grant loss denies pending writes, reads and already-applied receipts without session revocation', async () => {
  const user = await person(), auth = await signIn(user), pending = await prepared(auth), applied = await prepared(auth);
  assert.equal((await send(db, auth, `/school/imports/${applied.preview.id}/apply`, applied.apply)).status, 200);
  const before = await counts(user.id);
  for (const [path, raw] of [[`/school/imports/${pending.preview.id}/apply`, pending.apply], ['/school/imports/preview', input()],
    [`/school/imports/${applied.preview.id}/apply`, applied.apply], [`/school/imports/${applied.preview.id}/source`, undefined]] as [string, unknown][]) {
    await grant(user, true); const gate = beforeTransaction(() => grant(user, false));
    assert.equal((await send(gate.database, auth, path, raw)).status, 403); assert.ok(gate.observed());
    assert.equal((await send(db, auth, '/me')).status, 200);
  }
  assert.deepEqual(await counts(user.id), before);
});

test('private source and immutable receipts stay private and valid retries preserve one application', async () => {
  const first = await person(), second = await person('admin', false), a = await signIn(first), b = await signIn(second), p = await prepared(a);
  for (const suffix of ['', '/source']) assert.equal((await send(db, b, `/school/imports/${p.preview.id}${suffix}`)).status, 404);
  assert.equal((await send(db, b, `/school/imports/${p.preview.id}/apply`, p.apply)).status, 404);
  assert.equal((await send(db, b, `/school/imports?unitId=${unitId}`)).body.batches.length, 0);
  const downloaded = await send(db, a, `/school/imports/${p.preview.id}/source`).buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => callback(null, Buffer.concat(chunks)));
  }); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, Buffer.from(p.raw.csv));
  const firstApply = await send(db, a, `/school/imports/${p.preview.id}/apply`, p.apply); assert.equal(firstApply.status, 200);
  const before = await counts(first.id), fresh = await signIn(first), retry = await send(db, fresh, `/school/imports/${p.preview.id}/apply`, p.apply);
  assert.equal(retry.status, 200); assert.deepEqual(retry.body, firstApply.body); assert.deepEqual(await counts(first.id), before);
});

// Accelerate only the initial INSERT of this new synthetic HTTP login. Never
// update an existing session row, inject proof or claim configured-duration expiry.
async function shortSession(user: Person) {
  let expires = 0, inserted = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith('INSERT INTO sessions') && params?.[2] === user.id) {
        assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], 'password');
        assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
        inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires); return tx.query<R>(sql, changed);
      }
      return tx.query<R>(sql, params);
    },
  })) };
  const auth = await signIn(user, database); assert.ok(inserted); return { auth, expires };
}
function afterAudit(user: Person, action: string, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (sql.startsWith('INSERT INTO audit_events') && params?.[2] === user.id && params[3] === action) { observed = true; await effect(tx); }
      return result;
    },
  })) };
  return { database, observed: () => observed };
}
const untilExpired = (expires: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 40)));

test('final DB-clock session expiry after real preview/apply audit rolls back every domain write (accelerated new-session fixture)', async () => {
  const user = await person(), regular = await signIn(user), p = await prepared(regular);
  for (const [action, path, raw] of [['school.import.previewed', '/school/imports/preview', input()],
    ['school.import.applied', `/school/imports/${p.preview.id}/apply`, p.apply]] as [string, string, unknown][]) {
    const short = await shortSession(user), before = await counts(user.id), gate = afterAudit(user, action, () => untilExpired(short.expires));
    const r = await send(gate.database, short.auth, path, raw); assert.ok(gate.observed()); assert.equal(r.status, 401);
    assert.equal(r.body.plan, undefined); assert.equal(r.body.receipt, undefined); assert.deepEqual(await counts(user.id), before);
  }
  assert.equal((await db.query('SELECT applied_at,receipt FROM school_import_batches WHERE id=$1', [p.preview.id])).rows[0].applied_at, null);
  assert.equal((await send(db, regular, `/school/imports/${p.preview.id}/apply`, p.apply)).status, 200);
});

test('final source-export expiry suppresses bytes and rolls back export audit (accelerated new-session fixture)', async () => {
  const user = await person(), initial = await signIn(user), p = await prepared(initial), short = await shortSession(user);
  const before = await counts(user.id), gate = afterAudit(user, 'school.import.source_exported', () => untilExpired(short.expires));
  const r = await send(gate.database, short.auth, `/school/imports/${p.preview.id}/source`); assert.ok(gate.observed()); assert.equal(r.status, 401);
  assert.equal(r.headers['content-disposition'], undefined); assert.ok(!r.text.includes('Synthetic student')); assert.deepEqual(await counts(user.id), before);
});

test('actual SQL failure after the final apply audit rolls back records, receipt and audits before a safe retry', async () => {
  const user = await person(), auth = await signIn(user), p = await prepared(auth), before = await counts(user.id);
  const gate = afterAudit(user, 'school.import.applied', async tx => { await tx.query('SELECT 1/0'); });
  assert.equal((await send(gate.database, auth, `/school/imports/${p.preview.id}/apply`, p.apply)).status, 500); assert.ok(gate.observed());
  assert.deepEqual(await counts(user.id), before); assert.equal((await db.query('SELECT receipt FROM school_import_batches WHERE id=$1', [p.preview.id])).rows[0].receipt, null);
  assert.equal((await send(db, auth, `/school/imports/${p.preview.id}/apply`, p.apply)).status, 200);
});

test('serialization retry reloads actual proof after a normal logout between transaction attempts', async () => {
  const user = await person(), auth = await signIn(user), before = await counts(user.id); let attempts = 0, fault = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    attempts++;
    if (attempts === 2) assert.equal((await send(db, auth, '/auth/logout', {})).status, 200);
    return db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (!fault && sql.startsWith('INSERT INTO audit_events') && params?.[2] === user.id && params[3] === 'school.import.previewed') {
        fault = true; throw Object.assign(Error('Synthetic serialization fault after real audit'), { code: '40001' });
      }
      return result;
    } }));
  } };
  assert.equal((await send(database, auth, '/school/imports/preview', input())).status, 401);
  assert.equal(attempts, 2); assert.ok(fault); assert.deepEqual(await counts(user.id), before);
});

test('read-only template and applied-receipt branches recheck expiry after initial proof (accelerated new-session fixture)', async () => {
  const user = await person(), auth = await signIn(user), p = await prepared(auth);
  assert.equal((await send(db, auth, `/school/imports/${p.preview.id}/apply`, p.apply)).status, 200);
  for (const [path, raw] of [[`/school/imports/template/students?unitId=${unitId}`, undefined], [`/school/imports/${p.preview.id}/apply`, p.apply]] as [string, unknown][]) {
    const short = await shortSession(user), before = await counts(user.id); let paused = false;
    const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
      query: async <R extends Row = Row>(sql: string, params?: any[]) => {
        const result = await tx.query<R>(sql, params);
        if (!paused && sql.includes('SELECT s.token_hash FROM sessions') && params?.[0] === short.auth.hash) {
          assert.equal(result.rows.length, 1); paused = true; await untilExpired(short.expires);
        }
        return result;
      },
    })) };
    const response = await send(database, short.auth, path, raw); assert.ok(paused); assert.equal(response.status, 401);
    assert.equal(response.headers['content-disposition'], undefined); assert.equal(response.body.receipt, undefined); assert.deepEqual(await counts(user.id), before);
  }
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test('normal MFA confirmation after middleware invalidates old import proof and permits its verified replacement', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const user = await person(), auth = await signIn(user), enrollment = await send(db, auth, '/auth/mfa/enroll', { password: user.password });
    assert.equal(enrollment.status, 200); let replacement = '';
    const gate = beforeTransaction(async () => {
      const confirmed = await send(db, auth, '/auth/mfa/confirm', { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) });
      assert.equal(confirmed.status, 200); replacement = (confirmed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    });
    assert.equal((await send(gate.database, auth, '/school/imports/preview', input())).status, 401); assert.ok(gate.observed());
    const current = await cookieAuth(replacement); assert.equal((await send(db, current, '/school/imports/preview', input())).status, 201);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test('temporary onboarding, actual PIN proof and read-only bearer cannot access school imports', async () => {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const temp = await send(db, ownerAuth, '/staff', { name: 'Synthetic unfinished school setup', email, role: 'admin', unitIds: [unitId], jobIds: [], initialCredentials: { password, pin: '672491' } });
  assert.equal(temp.status, 201);
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: password, mode: 'password' });
  assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
  assert.ok((login.headers['set-cookie'] as unknown as string[]).every(value => value.startsWith('stjw_session=;') && value.includes('Expires=Thu, 01 Jan 1970')));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [temp.body.id])).rows[0].n, 0);
  await assert.rejects(previewSchoolImport(db, supplied({ id: temp.body.id, email, password }, 'admin'), input(), ownerAuth.hash), (e: any) => e.status === 403 && /temporary credentials/.test(e.message));
  const user = await person(), auth = await signIn(user); assert.equal((await send(db, auth, '/auth/pin', { password: user.password, pin: '731958' })).status, 200);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: '731958', mode: 'pin' }); assert.equal(pin.status, 200);
  const proof = await cookieAuth((pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
  assert.equal((await send(db, proof, `/school/imports/template/students?unitId=${unitId}`)).status, 403);
  await assert.rejects(previewSchoolImport(db, supplied(user), input(), proof.hash), (e: any) => e.status === 401);
  const token = await send(db, ownerAuth, '/tokens', { name: 'Synthetic school denial', scopes: ['staff:read', 'reports:read'], days: 1 }); assert.equal(token.status, 200);
  assert.equal((await request(app()).get(`/api/school/imports/template/students?unitId=${unitId}`).set('Authorization', 'Bearer ' + token.body.token)).status, 403);
});

test('apply preserves academics before batch before current actor/session and repeats final proof for receipt replay', async () => {
  const user = await person(), auth = await signIn(user), p = await prepared(auth);
  const trace: { sql: string; params?: any[] }[] = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => { trace.push({ sql, params }); return tx.query<R>(sql, params); },
  })) };
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.length = 0; const r = await send(database, auth, `/school/imports/${p.preview.id}/apply`, p.apply); assert.equal(r.status, 200);
    const academic = trace.findIndex(x => x.sql.includes('pg_advisory_xact_lock') && x.params?.[0] === 'academic-timetable:' + owner.org_id);
    const batch = trace.findIndex(x => x.sql.includes('FROM school_import_batches') && x.sql.includes('FOR UPDATE'));
    const actor = trace.findIndex(x => x.sql.includes('FROM users WHERE id=$1 AND org_id=$2 FOR SHARE'));
    const sessions = trace.map((x, i) => x.sql.includes('SELECT s.token_hash FROM sessions') ? i : -1).filter(i => i >= 0);
    assert.deepEqual(trace.slice(0, academic).map(x => x.sql), ["SET LOCAL statement_timeout='15s'", "SET LOCAL lock_timeout='5s'"]);
    assert.ok(batch > academic && actor > batch && sessions[0] > actor); assert.equal(sessions.length, 2);
    if (attempt === 0) {
      assert.equal(sessions[1], trace.length - 2);
      assert.match(trace.at(-1)!.sql, /FROM school_import_batches.*expires_at>clock_timestamp\(\)/);
      assert.deepEqual(trace.at(-1)!.params, [p.preview.id, owner.org_id, user.id]);
    } else assert.equal(sessions[1], trace.length - 1);
    assert.equal(trace.some(x => /FROM users.*FOR UPDATE/.test(x.sql)), false);
  }
});
