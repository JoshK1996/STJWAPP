import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, Problem, type Actor } from '../server/security';
import { previewStaffImport, applyStaffImport, getStaffImport, getStaffImportSource, getStaffImportTemplate, listStaffImports } from '../server/imports';
import { totpAt } from '../server/totp';

// Normal HTTP setup/login in isolated PGlite. Gates below prove committed
// boundaries; they are not evidence of real PostgreSQL lock queues.
const origin = 'http://localhost:3193';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string; role: string; units: string[] };
type Fixture = { user: Person; auth: Auth; csv: string; emails: string[] };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, childId: string, otherUnit: string, jobId: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, auth: Auth, path: string, body?: unknown, method = 'post') {
  const agent = request(app(database));
  return body === undefined ? agent.get('/api' + path).set('Cookie', auth.cookie)
    : (agent as any)[method]('/api' + path).set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = ownerAuth, method = 'post') {
  const r = await send(db, auth, path, body, method); assert.ok(r.status < 300, r.body.error); return r.body;
}
async function cookieAuth(cookie: string, database = db): Promise<Auth> {
  const me = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function signIn(user: Pick<Person, 'email' | 'password'>, database = db) {
  const r = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ email: user.email, credential: user.password, mode: 'password' });
  assert.equal(r.status, 200); assert.equal(r.body.requiresCredentialChange, undefined);
  return cookieAuth((r.headers['set-cookie'] as unknown as string[])[0].split(';')[0], database);
}
async function person(role = 'manager', units = [unitId]): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const created = await ok('/staff', { name: 'Synthetic import author', email, role, unitIds: units, jobIds: [] });
  const setup = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(created.setupUrl).hash.slice(7), password });
  assert.equal(setup.status, 200); return { id: created.id, email, password, role, units };
}
const actor = (user: Person) => ({ ...owner, id: user.id, email: user.email, role: user.role, unit_ids: user.units }) as Actor;
async function changeStaff(user: Person, changes: { role?: string; active?: boolean; unitIds?: string[] }) {
  await ok('/staff/' + user.id, { name: 'Synthetic import author', email: user.email, role: user.role, active: true, unitIds: user.units, jobIds: [], ...changes }, ownerAuth, 'patch');
}
function csvRows(role = 'employee', units = [unitId], count = 1, jobs = [jobId]) {
  const emails = Array.from({ length: count }, () => randomUUID() + '@stjw.org');
  const csv = '\ufeffname,email,role,unitIds,jobIds\r\n' + emails.map((email, i) => `Synthetic imported ${i + 1},${email},${role},${units.join('|')},${jobs.join('|')}`).join('\r\n') + '\r\n';
  return { csv, emails };
}
async function fixture(role = 'manager', units = [unitId], count = 1): Promise<Fixture> {
  const user = await person(role, units); return { user, auth: await signIn(user), ...csvRows('employee', [unitId], count) };
}
async function prepared(f: Fixture) {
  const r = await send(db, f.auth, '/imports/staff/preview', { csv: f.csv }); assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.count, f.emails.length); assert.equal(r.body.sourceHash, digest(f.csv)); return r.body;
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => observed };
}
async function state(f: Fixture) {
  return {
    batches: (await db.query('SELECT id,source_hash,applied_at,rows,receipt FROM import_batches WHERE actor_id=$1 ORDER BY id', [f.user.id])).rows,
    accounts: (await db.query(`SELECT id,email,role,active,password_hash IS NULL AS password_unset,pin_hash IS NULL AS pin_unset FROM users WHERE email=ANY($1::text[]) ORDER BY email`, [f.emails])).rows,
    counts: (await db.query(`SELECT
      (SELECT count(*)::int FROM user_units x JOIN users u ON u.id=x.user_id WHERE u.email=ANY($2::text[])) AS memberships,
      (SELECT count(*)::int FROM user_jobs x JOIN users u ON u.id=x.user_id WHERE u.email=ANY($2::text[])) AS jobs,
      (SELECT count(*)::int FROM setup_tokens x JOIN users u ON u.id=x.user_id WHERE u.email=ANY($2::text[])) AS setup_tokens,
      (SELECT count(*)::int FROM audit_events WHERE actor_id=$1 AND (action LIKE 'import.%' OR action='staff.created')) AS audits`, [f.user.id, f.emails])).rows[0],
  };
}
function afterAudit(user: Person, action: string, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith('INSERT INTO audit_events') && params?.[2] === user.id && params[3] === action) { observed = true; await effect(tx); }
    return result;
  } })) };
  return { database, observed: () => observed };
}
async function newUnit(parentId: string | null) {
  const input = { id: randomUUID(), expectedVersion: 0, name: 'Synthetic import unit ' + randomUUID(), kind: parentId ? 'department' : 'school', parentId, description: 'Synthetic tests only', reason: 'Synthetic explicit subgroup boundary' };
  const preview = await ok('/organization/units/preview', input);
  await ok('/organization/units/save', { ...input, structureVersion: preview.structureVersion, previewHash: preview.previewHash, commandId: randomUUID(), reviewed: true });
  return input.id;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'staff.import.owner@example.test' });
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  ownerAuth = await signIn({ email: owner.email, password });
  unitId = await newUnit(null); childId = await newUnit(unitId); otherUnit = await newUnit(null);
  jobId = (await ok('/jobs', { unitId, title: 'Synthetic imported job' })).id;
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });

test('normal owners, administrators and managers retain distinct provisioning roles and exact subgroup scope', async () => {
  const manager = await fixture(), admin = await fixture('admin');
  for (const [auth, role, units, expected] of [
    [ownerAuth, 'admin', [childId], 200], [ownerAuth, 'owner', [unitId], 403],
    [admin.auth, 'manager', [childId], 200], [admin.auth, 'admin', [unitId], 403],
    [manager.auth, 'employee', [unitId], 200], [manager.auth, 'manager', [unitId], 403],
    [manager.auth, 'employee', [childId], 403], [manager.auth, 'employee', [unitId, childId], 403],
  ] as [Auth, string, string[], number][]) {
    const input = csvRows(role, units, 1, []), r = await send(db, auth, '/imports/staff/preview', { csv: input.csv }); assert.equal(r.status, expected, role);
    if (expected === 200) { const applied = await send(db, auth, `/imports/staff/${r.body.id}/apply`, { sourceHash: r.body.sourceHash }); assert.equal(applied.status, 200); assert.equal(applied.body.created, 1); }
  }
  await changeStaff(manager.user, { unitIds: [unitId, childId] });
  const current = await signIn(manager.user), child = csvRows('employee', [childId], 1, []);
  assert.equal((await send(db, current, '/imports/staff/preview', { csv: child.csv })).status, 200);
});

test('every staff import service requires actual matching password proof, not a supplied privileged Actor', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f);
  for (const proof of [undefined, '', 'not-a-hash', ownerAuth.hash]) {
    const calls = [
      () => previewStaffImport(db, actor(f.user), f.csv, 'stjw.org', proof),
      () => applyStaffImport(db, actor(f.user), p.id, p.sourceHash, 'stjw.org', proof),
      () => getStaffImport(db, actor(f.user), proof, p.id), () => getStaffImportSource(db, actor(f.user), proof, p.id),
      () => getStaffImportTemplate(db, actor(f.user), proof), () => listStaffImports(db, actor(f.user), proof, {}),
    ];
    for (const call of calls) await assert.rejects(call(), (e: any) => e.status === 401);
  }
  assert.deepEqual(await state(f), before);
});

test('staff import template, history, detail and source deny logout committed after middleware', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f);
  for (const path of ['/imports/staff/template', '/imports/staff', `/imports/staff/${p.id}`, `/imports/staff/${p.id}/source`]) {
    const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const r = await send(gate.database, auth, path); assert.ok(gate.observed()); assert.equal(r.status, 401, path);
    assert.equal(r.headers['content-disposition'], undefined); assert.equal(r.body.rows, undefined); assert.equal(r.body.receipt, undefined); assert.ok(!r.text.includes(f.emails[0]));
  }
  assert.deepEqual(await state(f), before);
});

test('staff preview, apply and stable receipt replay deny post-middleware logout without writes', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const applied of [false, true]) {
    if (applied) assert.equal((await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 200);
    const before = await state(f);
    for (const [path, body] of [['/imports/staff/preview', { csv: csvRows().csv }], [`/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash }]] as const) {
      const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
      assert.equal((await send(gate.database, auth, path, body)).status, 401); assert.ok(gate.observed());
    }
    assert.deepEqual(await state(f), before);
  }
});

test('current role, activity and exact units override actors cached before middleware or a previous sign-in', async () => {
  for (const loss of ['role', 'units'] as const) {
    const f = await fixture(), p = await prepared(f), before = await state(f), stale = actor(f.user);
    const gate = beforeTransaction(() => changeStaff(f.user, loss === 'role' ? { role: 'employee' } : { unitIds: [otherUnit] }));
    assert.equal((await send(gate.database, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 401); assert.ok(gate.observed());
    const current = await signIn(f.user);
    const calls = [
      () => previewStaffImport(db, stale, f.csv, 'stjw.org', current.hash),
      () => applyStaffImport(db, stale, p.id, p.sourceHash, 'stjw.org', current.hash),
      () => getStaffImport(db, stale, current.hash, p.id), () => getStaffImportSource(db, stale, current.hash, p.id),
    ];
    for (const call of calls) await assert.rejects(call(), (e: any) => e.status === 403);
    if (loss === 'role') {
      await assert.rejects(getStaffImportTemplate(db, stale, current.hash), (e: any) => e.status === 403);
      await assert.rejects(listStaffImports(db, stale, current.hash, {}), (e: any) => e.status === 403);
    } else {
      const history = await listStaffImports(db, stale, current.hash, {}); assert.deepEqual(history.rows, []);
    }
    assert.deepEqual(await state(f), before);
  }
  const inactive = await fixture(), gate = beforeTransaction(() => changeStaff(inactive.user, { active: false }));
  assert.equal((await send(gate.database, inactive.auth, '/imports/staff/template')).status, 403); assert.ok(gate.observed());
});

test('exact retained source and receipts are author-private, and replay creates no credentials or duplicate accounts', async () => {
  const f = await fixture('manager', [unitId], 2), p = await prepared(f);
  for (const suffix of ['', '/source']) assert.equal((await send(db, ownerAuth, `/imports/staff/${p.id}${suffix}`)).status, 404);
  assert.equal((await send(db, ownerAuth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 404);
  const ownerHistory = await send(db, ownerAuth, '/imports/staff'); assert.equal(ownerHistory.status, 200); assert.ok(ownerHistory.body.rows.every((row: Row) => row.id !== p.id));
  const source = await send(db, f.auth, `/imports/staff/${p.id}/source`).buffer(true).parse((res: any, callback: any) => {
    const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
  assert.equal(source.status, 200); assert.deepEqual(source.body, Buffer.from(f.csv)); assert.equal(digest(source.body.toString('utf8')), p.sourceHash);
  const first = await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash }); assert.equal(first.status, 200); assert.equal(first.body.created, 2);
  const before = await state(f), replay = await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash });
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.deepEqual(await state(f), before);
  assert.deepEqual(first.body.accounts.map((a: Row) => a.row), [2, 3]); assert.equal(new Set(first.body.accounts.map((a: Row) => a.userId)).size, 2);
  assert.equal(before.accounts.length, 2); assert.ok(before.accounts.every(a => a.password_unset && a.pin_unset)); assert.equal(before.counts.setup_tokens, 0);
  assert.equal(before.counts.memberships, 2); assert.equal(before.counts.jobs, 2);
  const detail = await send(db, f.auth, `/imports/staff/${p.id}`); assert.equal(detail.status, 200); assert.deepEqual(detail.body.receipt, first.body);
  assert.equal((await send(db, ownerAuth, `/imports/staff/${p.id}`)).status, 404);
});

test('actual SQL failure after preview or apply audit rolls back sources, accounts, assignments and receipt evidence', async () => {
  const f = await fixture('manager', [unitId], 2), beforePreview = await state(f);
  const previewFault = afterAudit(f.user, 'import.previewed', async tx => { await tx.query('SELECT 1/0'); });
  assert.equal((await send(previewFault.database, f.auth, '/imports/staff/preview', { csv: f.csv })).status, 500); assert.ok(previewFault.observed()); assert.deepEqual(await state(f), beforePreview);
  const p = await prepared(f), before = await state(f), applyFault = afterAudit(f.user, 'import.applied', async tx => { await tx.query('SELECT 1/0'); });
  assert.equal((await send(applyFault.database, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 500); assert.ok(applyFault.observed()); assert.deepEqual(await state(f), before);
  const detail = await send(db, f.auth, `/imports/staff/${p.id}`); assert.equal(detail.status, 200); assert.equal(detail.body.receipt, null);
  assert.equal((await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 200);
});

// Accelerated expiry changes only the original INSERT generated by normal login
// for a new synthetic session. No session row is fabricated or later updated.
async function shortSession(user: Person) {
  let expires = 0, inserted = false;
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

test('final preview and apply expiry undo audited account creation (accelerated original-session fixture)', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const [action, path, body] of [['import.previewed', '/imports/staff/preview', { csv: f.csv }], ['import.applied', `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash }]] as const) {
    const short = await shortSession(f.user), before = await state(f), gate = afterAudit(f.user, action, () => untilExpired(short.expires));
    const r = await send(gate.database, short.auth, path, body); assert.ok(gate.observed()); assert.equal(r.status, 401); assert.equal(r.body.created, undefined); assert.deepEqual(await state(f), before);
  }
  assert.equal((await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 200);
});

test('every read and applied receipt branch checks the final database clock (accelerated original-session fixture)', async () => {
  const f = await fixture(), p = await prepared(f); assert.equal((await send(db, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 200);
  for (const [path, body] of [['/imports/staff/template', undefined], ['/imports/staff', undefined], [`/imports/staff/${p.id}`, undefined], [`/imports/staff/${p.id}/source`, undefined], [`/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash }]] as [string, unknown][]) {
    const short = await shortSession(f.user), before = await state(f); let paused = false;
    const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (!paused && sql.includes('SELECT s.token_hash FROM sessions') && params?.[0] === short.auth.hash) { assert.equal(result.rows.length, 1); paused = true; await untilExpired(short.expires); }
      return result;
    } })) };
    const r = await send(database, short.auth, path, body); assert.ok(paused); assert.equal(r.status, 401); assert.equal(r.headers['content-disposition'], undefined);
    assert.equal(r.body.rows, undefined); assert.equal(r.body.accounts, undefined); assert.ok(!r.text.includes(f.emails[0])); assert.deepEqual(await state(f), before);
  }
});

test('serialization retry rechecks a normal logout between attempts instead of publishing stale staff authority', async () => {
  const f = await fixture(), before = await state(f); let attempts = 0, fault = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    attempts++; if (attempts === 2) assert.equal((await send(db, f.auth, '/auth/logout', {})).status, 200);
    return db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (!fault && sql.startsWith('INSERT INTO audit_events') && params?.[2] === f.user.id && params[3] === 'import.previewed') { fault = true; throw Object.assign(Error('Synthetic serialization fault after actual audit'), { code: '40001' }); }
      return result;
    } }));
  } };
  assert.equal((await send(database, f.auth, '/imports/staff/preview', { csv: f.csv })).status, 401); assert.equal(attempts, 2); assert.ok(fault); assert.deepEqual(await state(f), before);
});

test('concurrent local retries and an ambiguous response retain one exact account-creation receipt', async () => {
  const f = await fixture(), p = await prepared(f), path = `/imports/staff/${p.id}/apply`, body = { sourceHash: p.sourceHash };
  const results = await Promise.all([send(db, f.auth, path, body), send(db, f.auth, path, body)]); assert.ok(results.every(r => r.status === 200)); assert.deepEqual(results[0].body, results[1].body);
  const stored = await state(f); assert.equal(stored.accounts.length, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND action='import.applied'", [f.user.id])).rows[0].n, 1);
  const lost = await fixture(), lp = await prepared(lost); let dropped = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    const result = await db.transaction(fn); if (!dropped) { dropped = true; throw new Problem(503, 'Synthetic lost response after committed transaction'); } return result;
  } };
  assert.equal((await send(database, lost.auth, `/imports/staff/${lp.id}/apply`, { sourceHash: lp.sourceHash })).status, 503); assert.ok(dropped);
  const before = await state(lost), receipt = await send(db, lost.auth, `/imports/staff/${lp.id}/apply`, { sourceHash: lp.sourceHash }); assert.equal(receipt.status, 200); assert.equal(receipt.body.created, 1); assert.deepEqual(await state(lost), before);
  assert.equal((await send(db, f.auth, path, body)).status, 200); assert.deepEqual(await state(f), stored);
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test('MFA confirmation between middleware and service invalidates the old proof and accepts its verified replacement', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const f = await fixture(), enrollment = await send(db, f.auth, '/auth/mfa/enroll', { password: f.user.password }); assert.equal(enrollment.status, 200); let replacement = '';
    const gate = beforeTransaction(async () => {
      const confirmed = await send(db, f.auth, '/auth/mfa/confirm', { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) }); assert.equal(confirmed.status, 200); replacement = (confirmed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    });
    assert.equal((await send(gate.database, f.auth, '/imports/staff/template')).status, 401); assert.ok(gate.observed());
    const current = await cookieAuth(replacement); assert.equal((await send(db, current, '/imports/staff/template')).status, 200);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test('temporary onboarding, real PIN and bearer credentials cannot become password staff-import authority', async () => {
  const f = await fixture(), p = await prepared(f), email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const temp = await ok('/staff', { name: 'Synthetic unfinished staff import setup', email, role: 'admin', unitIds: [unitId], jobIds: [], initialCredentials: { password, pin: '672491' } });
  for (const mode of ['password', 'pin']) {
    const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: mode === 'password' ? password : '672491', mode });
    assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
    assert.ok((login.headers['set-cookie'] as unknown as string[]).every(value => value.startsWith('stjw_session=;') && value.includes('Expires=Thu, 01 Jan 1970')));
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [temp.id])).rows[0].n, 0);
  await assert.rejects(previewStaffImport(db, actor({ id: temp.id, email, password, role: 'admin', units: [unitId] }), f.csv, 'stjw.org', ownerAuth.hash), (e: any) => e.status === 403 && /temporary credentials/.test(e.message));
  await ok('/auth/pin', { password: f.user.password, pin: '731958' }, f.auth);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: f.user.email, credential: '731958', mode: 'pin' }); assert.equal(pin.status, 200);
  const proof = await cookieAuth((pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
  for (const path of ['/imports/staff/template', '/imports/staff', `/imports/staff/${p.id}`, `/imports/staff/${p.id}/source`]) assert.equal((await send(db, proof, path)).status, 403);
  assert.equal((await send(db, proof, '/imports/staff/preview', { csv: f.csv })).status, 403);
  assert.equal((await send(db, proof, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 403);
  await assert.rejects(previewStaffImport(db, actor(f.user), f.csv, 'stjw.org', proof.hash), (e: any) => e.status === 401);
  const token = await ok('/tokens', { name: 'Synthetic staff import denial', scopes: ['staff:read', 'reports:read'], days: 1 });
  for (const path of ['/imports/staff/template', '/imports/staff', `/imports/staff/${p.id}`, `/imports/staff/${p.id}/source`]) assert.equal((await request(app()).get('/api' + path).set('Authorization', 'Bearer ' + token.token)).status, 403);
});

test('staff import apply and replay lock current account before proof and domain, then recheck proof last', async () => {
  const f = await fixture(), p = await prepared(f), trace: { sql: string; params?: any[] }[] = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { trace.push({ sql, params }); return tx.query<R>(sql, params); } })) };
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.length = 0; assert.equal((await send(database, f.auth, `/imports/staff/${p.id}/apply`, { sourceHash: p.sourceHash })).status, 200);
    const user = trace.findIndex(x => x.sql.includes('FROM users WHERE id=$1 AND org_id=$2 FOR SHARE'));
    const batch = trace.findIndex(x => x.sql.includes('FROM import_batches') && x.sql.includes('FOR UPDATE'));
    const proofs = trace.map((x, i) => x.sql.includes('SELECT s.token_hash FROM sessions') ? i : -1).filter(i => i >= 0);
    assert.ok(user >= 0 && batch > user); assert.equal(proofs.length, 2); assert.ok(proofs[0] > user && proofs[0] < batch); assert.equal(proofs[1], trace.length - 1);
    assert.equal(trace.slice(0, user).some(x => /FOR (UPDATE|SHARE)/.test(x.sql)), false);
  }
});
