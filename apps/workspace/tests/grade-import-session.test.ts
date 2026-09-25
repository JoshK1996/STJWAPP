import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { previewGradeImport, applyGradeImport, parseGradeCsv } from '../server/grade-imports';
import { toCsv } from '../server/reports';
import { gradeImportColumns } from '../shared/grade-imports';
import { totpAt } from '../server/totp';

// These tests use isolated PGlite and normal HTTP setup/login. JavaScript gates
// prove committed boundaries; they are not real PostgreSQL lock-queue evidence.
const origin = 'http://localhost:3192';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string; role: string };
type Fixture = { user: Person; auth: Auth; section: Row; student: Row; book: Row; assignment: Row };
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, otherUnit: string, year: Row, term: Row, categoryId: string;
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
  assert.equal(r.status, 200); return cookieAuth((r.headers['set-cookie'] as unknown as string[])[0].split(';')[0], database);
}
async function person(role = 'employee'): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const created = await ok('/staff', { name: 'Synthetic grade import staff', email, role, unitIds: [unitId], jobIds: [] });
  const setup = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(created.setupUrl).hash.slice(7), password });
  assert.equal(setup.status, 200); return { id: created.id, email, password, role };
}
const actor = (user: Person) => ({ ...owner, id: user.id, email: user.email, role: user.role, unit_ids: [unitId] }) as Actor;
async function grant(user: Person, enabled: boolean) { await ok('/school/office-grants', { unitId, userId: user.id, enabled }); }
async function changeStaff(user: Person, changes: { role?: string; active?: boolean; unitIds?: string[] }) {
  await ok('/staff/' + user.id, { expectedRevision:await testStaffRevision(db,user.id), name: 'Synthetic grade import staff', email: user.email, role: user.role, active: true, unitIds: [unitId], jobIds: [], ...changes }, ownerAuth, 'patch');
}
async function teachers(f: Fixture, enabled: boolean) {
  const current = (await send(db, ownerAuth, '/school/sections/' + f.section.id)).body.section;
  assert.ok(current?.id);
  await ok('/school/sections/' + f.section.id, { name: current.name, room: current.room, capacity: current.capacity, version: current.version, teacherIds: enabled ? [f.user.id] : [] }, ownerAuth, 'patch');
}
async function fixture(access: 'teacher' | 'office' | 'admin' = 'teacher'): Promise<Fixture> {
  const user = await person(access === 'admin' ? 'admin' : 'employee'), auth = await signIn(user);
  if (access === 'office') await grant(user, true);
  const section = await ok('/school/sections', { unitId, yearId: year.id, name: 'Synthetic import class ' + randomUUID(), homeroom: false, capacity: 20, teacherIds: access === 'teacher' ? [user.id] : [] });
  const student = await ok('/school/students', { unitId, name: 'Synthetic grade-session learner', studentNumber: randomUUID() });
  await ok(`/school/students/${student.id}/enrollments`, { enrollment: { yearId: year.id, gradeLevel: 'Synthetic only', startsOn: '2026-01-01', endsOn: '2026-12-31' } });
  await ok(`/school/sections/${section.id}/roster`, { studentId: student.id, startsOn: '2026-01-01', endsOn: '2026-06-30' });
  const book = await ok('/school/gradebooks', { sectionId: section.id, termId: term.id });
  const assignment = await ok('/school/grade-assignments', { bookId: book.id, bookVersion: book.version, commandId: randomUUID(), title: 'Synthetic session assignment', instructions: '', categoryId, dueOn: '2026-03-15', maxPointsUnits: 10000 });
  return { user, auth, section, student, book, assignment };
}
async function prepared(f: Fixture, auth = f.auth) {
  const template = await send(db, auth, `/school/grade-assignments/${f.assignment.id}/import-template`); assert.equal(template.status, 200);
  const csv = toCsv(parseGradeCsv(template.text).map(r => ({ ...r, status: 'scored', points: '89.99', note: 'Exact synthetic grade note' })), [...gradeImportColumns]);
  const raw = { csv, reason: 'Synthetic session boundary review' };
  const r = await send(db, auth, `/school/grade-assignments/${f.assignment.id}/import-previews`, raw); assert.equal(r.status, 200); assert.equal(r.body.plan.errors, 0);
  return { raw, preview: r.body, apply: { sourceHash: r.body.sourceHash, planHash: r.body.planHash, reviewed: true as const } };
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
    book: (await db.query('SELECT version,status FROM gradebooks WHERE id=$1', [f.book.id])).rows,
    assignment: (await db.query('SELECT version FROM grade_assignments WHERE id=$1', [f.assignment.id])).rows,
    scores: (await db.query('SELECT student_id,status,points_units,note,version,expected FROM grade_scores WHERE assignment_id=$1 ORDER BY student_id', [f.assignment.id])).rows,
    counts: (await db.query(`SELECT
      (SELECT count(*)::int FROM grade_import_batches WHERE actor_id=$1 AND assignment_id=$2) AS batches,
      (SELECT count(*)::int FROM grade_import_batches WHERE actor_id=$1 AND assignment_id=$2 AND applied_at IS NOT NULL) AS applied,
      (SELECT count(*)::int FROM school_history WHERE entity_id=$3) AS history,
      (SELECT count(*)::int FROM audit_events WHERE actor_id=$1 AND action LIKE 'grading.import_%') AS audits`, [f.user.id, f.assignment.id, f.book.id])).rows[0],
  };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'grade.session.owner@example.test' });
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  [unitId, otherUnit] = (await db.query('SELECT id FROM units ORDER BY id')).rows.map(r => r.id as string);
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: 'owner', mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  ownerAuth = await signIn({ email: owner.email, password }); categoryId = randomUUID();
  const settings = await send(db, ownerAuth, '/school/grading/settings?unitId=' + unitId); assert.equal(settings.status, 200);
  await ok('/school/grading/settings', { unitId, version: settings.body.version, confirmed: true, reason: 'Synthetic test policy; not an STJW school policy.', policy: {
    name: 'Synthetic explicit session test policy', calculation: 'total_points', missing: 'zero', emptyCategories: 'renormalize', allowExtraCredit: false, capAt100: true, decimals: 2, rounding: 'nearest',
    categories: [{ id: categoryId, name: 'Synthetic practice', weight: 10000 }], scale: [{ label: 'Example', minimum: 0 }],
  } }, ownerAuth, 'put');
  year = await ok('/school/years', { unitId, name: 'Synthetic grade session year', startsOn: '2026-01-01', endsOn: '2026-12-31' });
  term = await ok('/school/terms', { yearId: year.id, name: 'Synthetic first term', startsOn: '2026-01-01', endsOn: '2026-06-30' });
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });

test('grade import services require actual matching proof even when callers supply a privileged Actor', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f);
  for (const proof of [undefined, '', 'not-a-hash', ownerAuth.hash]) {
    await assert.rejects(previewGradeImport(db, actor(f.user), f.assignment.id, p.raw, proof), (e: any) => e.status === 401);
    await assert.rejects(applyGradeImport(db, actor(f.user), p.preview.id, p.apply, proof), (e: any) => e.status === 401);
  }
  assert.deepEqual(await state(f), before);
});

test('every grade template/history/detail/source route denies normal logout committed after middleware', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f);
  for (const path of [`/school/grade-assignments/${f.assignment.id}/import-template`, `/school/grade-assignments/${f.assignment.id}/import-previews`, `/school/grade-imports/${p.preview.id}`, `/school/grade-imports/${p.preview.id}/source`]) {
    const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
    const r = await send(gate.database, auth, path); assert.ok(gate.observed()); assert.equal(r.status, 401, path);
    assert.equal(r.headers['content-disposition'], undefined); assert.equal(r.body.plan, undefined); assert.equal(r.body.receipt, undefined); assert.ok(!r.text.includes('Synthetic grade-session learner'));
  }
  assert.deepEqual(await state(f), before);
});

test('grade preview, apply and retained receipt all deny post-middleware logout with no evidence changes', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const applied of [false, true]) {
    if (applied) assert.equal((await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 200);
    const before = await state(f);
    for (const [path, raw] of [[`/school/grade-assignments/${f.assignment.id}/import-previews`, p.raw], [`/school/grade-imports/${p.preview.id}/apply`, p.apply]] as [string, unknown][]) {
      const auth = await signIn(f.user), gate = beforeTransaction(async () => { assert.equal((await send(db, auth, '/auth/logout', {})).status, 200); });
      assert.equal((await send(gate.database, auth, path, raw)).status, 401); assert.ok(gate.observed());
    }
    assert.deepEqual(await state(f), before);
  }
});

test('exact teacher and office grants are reloaded after middleware, including applied-receipt reads', async () => {
  for (const kind of ['teacher', 'office'] as const) {
    const f = await fixture(kind), p = await prepared(f);
    assert.equal((await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 200);
    const before = await state(f), access = (enabled: boolean) => kind === 'teacher' ? teachers(f, enabled) : grant(f.user, enabled);
    for (const [path, raw] of [[`/school/grade-assignments/${f.assignment.id}/import-template`, undefined], [`/school/grade-imports/${p.preview.id}/apply`, p.apply], [`/school/grade-imports/${p.preview.id}/source`, undefined]] as [string, unknown][]) {
      await access(true); const gate = beforeTransaction(() => access(false));
      assert.equal((await send(gate.database, f.auth, path, raw)).status, 404); assert.ok(gate.observed());
      assert.equal((await send(db, f.auth, '/me')).status, 200);
    }
    assert.deepEqual(await state(f), before);
  }
});

test('fresh role, membership and active account override stale grade actors and sessions', async () => {
  const f = await fixture('admin'), p = await prepared(f), stale = actor(f.user), before = await state(f);
  const role = beforeTransaction(() => changeStaff(f.user, { role: 'employee' }));
  assert.equal((await send(role.database, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 401); assert.ok(role.observed());
  const current = await signIn(f.user); await assert.rejects(applyGradeImport(db, stale, p.preview.id, p.apply, current.hash), (e: any) => e.status === 404);
  assert.deepEqual(await state(f), before);
  const teacher = await fixture(), tp = await prepared(teacher), original = await state(teacher), moved = beforeTransaction(() => changeStaff(teacher.user, { unitIds: [otherUnit] }));
  assert.equal((await send(moved.database, teacher.auth, `/school/grade-imports/${tp.preview.id}/apply`, tp.apply)).status, 401);
  const movedProof = await signIn(teacher.user); await assert.rejects(applyGradeImport(db, actor(teacher.user), tp.preview.id, tp.apply, movedProof.hash), (e: any) => e.status === 404);
  assert.deepEqual(await state(teacher), original);
  const inactive = await fixture(), denied = beforeTransaction(() => changeStaff(inactive.user, { active: false }));
  assert.equal((await send(denied.database, inactive.auth, `/school/grade-assignments/${inactive.assignment.id}/import-template`)).status, 403); assert.ok(denied.observed());
});

test('retained grade sources and receipts stay author-private and exact retries preserve one score change', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const suffix of ['', '/source']) assert.equal((await send(db, ownerAuth, `/school/grade-imports/${p.preview.id}${suffix}`)).status, 404);
  assert.equal((await send(db, ownerAuth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 404);
  const history = await send(db, ownerAuth, `/school/grade-assignments/${f.assignment.id}/import-previews`); assert.equal(history.status, 200); assert.deepEqual(history.body.rows, []);
  const source = await send(db, f.auth, `/school/grade-imports/${p.preview.id}/source`).buffer(true).parse((res: any, callback: any) => {
    const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => callback(null, Buffer.concat(chunks)));
  }); assert.equal(source.status, 200); assert.deepEqual(source.body, Buffer.from(p.raw.csv)); assert.equal(digest(source.body.toString('utf8')), p.preview.sourceHash);
  const first = await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply); assert.equal(first.status, 200);
  const saved = await state(f), fresh = await signIn(f.user), replay = await send(db, fresh, `/school/grade-imports/${p.preview.id}/apply`, p.apply);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.deepEqual(await state(f), saved); assert.equal(saved.scores[0].points_units, 8999);
});

// Only the original INSERT for a newly authenticated synthetic login is shortened.
// No existing session is updated and no unauthenticated proof is inserted.
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
function afterAudit(user: Person, action: string, effect: (tx: Queryable) => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith('INSERT INTO audit_events') && params?.[2] === user.id && params[3] === action) { observed = true; await effect(tx); }
    return result;
  } })) };
  return { database, observed: () => observed };
}

test('final grade preview/apply expiry rolls back all scores, versions, batches and audits (accelerated original-session fixture)', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const [action, path, raw] of [['grading.import_previewed', `/school/grade-assignments/${f.assignment.id}/import-previews`, p.raw], ['grading.import_applied', `/school/grade-imports/${p.preview.id}/apply`, p.apply]] as [string, string, unknown][]) {
    const short = await shortSession(f.user), before = await state(f), gate = afterAudit(f.user, action, () => untilExpired(short.expires));
    const r = await send(gate.database, short.auth, path, raw); assert.ok(gate.observed()); assert.equal(r.status, 401); assert.equal(r.body.plan, undefined); assert.equal(r.body.changed, undefined); assert.deepEqual(await state(f), before);
  }
  assert.equal((await db.query('SELECT receipt FROM grade_import_batches WHERE id=$1', [p.preview.id])).rows[0].receipt, null);
  assert.equal((await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 200);
});

test('final template/source/detail expiry suppresses bytes and rolls back read audit (accelerated original-session fixture)', async () => {
  const f = await fixture(), p = await prepared(f);
  for (const [action, path] of [['grading.import_template_exported', `/school/grade-assignments/${f.assignment.id}/import-template`], ['grading.import_source_exported', `/school/grade-imports/${p.preview.id}/source`], ['grading.import_read', `/school/grade-imports/${p.preview.id}`]]) {
    const short = await shortSession(f.user), before = await state(f), gate = afterAudit(f.user, action, () => untilExpired(short.expires));
    const r = await send(gate.database, short.auth, path); assert.ok(gate.observed()); assert.equal(r.status, 401); assert.equal(r.headers['content-disposition'], undefined); assert.ok(!r.text.includes('Synthetic grade-session learner')); assert.deepEqual(await state(f), before);
  }
});

test('history and applied-receipt branches repeat proof after initial check (accelerated original-session fixture)', async () => {
  const f = await fixture(), p = await prepared(f); assert.equal((await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 200);
  for (const [path, raw] of [[`/school/grade-assignments/${f.assignment.id}/import-previews`, undefined], [`/school/grade-imports/${p.preview.id}/apply`, p.apply]] as [string, unknown][]) {
    const short = await shortSession(f.user), before = await state(f); let paused = false;
    const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (!paused && sql.includes('SELECT s.token_hash FROM sessions') && params?.[0] === short.auth.hash) { assert.equal(result.rows.length, 1); paused = true; await untilExpired(short.expires); }
      return result;
    } })) };
    const r = await send(database, short.auth, path, raw); assert.ok(paused); assert.equal(r.status, 401); assert.equal(r.body.rows, undefined); assert.equal(r.body.changed, undefined); assert.deepEqual(await state(f), before);
  }
});

test('real SQL failure after apply audit rolls back grade evidence and allows one safe same-preview retry', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f), gate = afterAudit(f.user, 'grading.import_applied', async tx => { await tx.query('SELECT 1/0'); });
  assert.equal((await send(gate.database, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 500); assert.ok(gate.observed()); assert.deepEqual(await state(f), before);
  assert.equal((await db.query('SELECT receipt FROM grade_import_batches WHERE id=$1', [p.preview.id])).rows[0].receipt, null);
  const first = await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply); assert.equal(first.status, 200);
  const saved = await state(f), replay = await send(db, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.deepEqual(await state(f), saved);
});

test('grade transaction retries reacquire actual proof after a normal logout between attempts', async () => {
  const f = await fixture(), p = await prepared(f), before = await state(f); let attempts = 0, fault = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    attempts++; if (attempts === 2) assert.equal((await send(db, f.auth, '/auth/logout', {})).status, 200);
    return db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (!fault && sql.startsWith('INSERT INTO audit_events') && params?.[2] === f.user.id && params[3] === 'grading.import_previewed') { fault = true; throw Object.assign(Error('Synthetic serialization fault after actual audit'), { code: '40001' }); }
      return result;
    } }));
  } };
  assert.equal((await send(database, f.auth, `/school/grade-assignments/${f.assignment.id}/import-previews`, p.raw)).status, 401); assert.equal(attempts, 2); assert.ok(fault); assert.deepEqual(await state(f), before);
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test('normal MFA confirmation invalidates cached grade proof and accepts the verified replacement', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  try {
    const f = await fixture(), enrollment = await send(db, f.auth, '/auth/mfa/enroll', { password: f.user.password }); assert.equal(enrollment.status, 200); let replacement = '';
    const gate = beforeTransaction(async () => {
      const confirmed = await send(db, f.auth, '/auth/mfa/confirm', { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) }); assert.equal(confirmed.status, 200); replacement = (confirmed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    });
    assert.equal((await send(gate.database, f.auth, `/school/grade-assignments/${f.assignment.id}/import-template`)).status, 401); assert.ok(gate.observed());
    const current = await cookieAuth(replacement); assert.equal((await send(db, current, `/school/grade-assignments/${f.assignment.id}/import-template`)).status, 200);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test('temporary onboarding, actual PIN and bearer proofs cannot be recast as grade-import password authority', async () => {
  const f = await fixture(), p = await prepared(f), email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const temp = await ok('/staff', { name: 'Synthetic unfinished grade setup', email, role: 'admin', unitIds: [unitId], jobIds: [], initialCredentials: { password, pin: '672491' } });
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: password, mode: 'password' }); assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
  assert.ok((login.headers['set-cookie'] as unknown as string[]).every(value => value.startsWith('stjw_session=;') && value.includes('Expires=Thu, 01 Jan 1970')));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [temp.id])).rows[0].n, 0);
  await assert.rejects(previewGradeImport(db, actor({ id: temp.id, email, password, role: 'admin' }), f.assignment.id, p.raw, ownerAuth.hash), (e: any) => e.status === 403 && /required credential changes/.test(e.message));
  await ok('/auth/pin', { password: f.user.password, pin: '731958' }, f.auth);
  const pin = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: f.user.email, credential: '731958', mode: 'pin' }); assert.equal(pin.status, 200);
  const proof = await cookieAuth((pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
  assert.equal((await send(db, proof, `/school/grade-assignments/${f.assignment.id}/import-template`)).status, 403);
  await assert.rejects(previewGradeImport(db, actor(f.user), f.assignment.id, p.raw, proof.hash), (e: any) => e.status === 401);
  const token = await ok('/tokens', { name: 'Synthetic grade denial', scopes: ['reports:read'], days: 1 });
  assert.equal((await request(app()).get(`/api/school/grade-assignments/${f.assignment.id}/import-template`).set('Authorization', 'Bearer ' + token.token)).status, 403);
});

test('grade imports retain academic-before-account locks and final proof on new apply and receipt replay', async () => {
  const f = await fixture(), p = await prepared(f), trace: { sql: string; params?: any[] }[] = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { trace.push({ sql, params }); return tx.query<R>(sql, params); } })) };
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.length = 0; assert.equal((await send(database, f.auth, `/school/grade-imports/${p.preview.id}/apply`, p.apply)).status, 200);
    const academic = trace.findIndex(x => x.sql.includes('pg_advisory_xact_lock') && x.params?.[0] === 'academic-timetable:' + owner.org_id);
    const user = trace.findIndex(x => x.sql.includes('FROM users WHERE id=$1 AND org_id=$2 FOR SHARE'));
    const domain = trace.findIndex(x => x.sql.includes('FROM gradebooks') && x.sql.includes('FOR UPDATE'));
    const sessions = trace.map((x, i) => x.sql.includes('SELECT s.token_hash FROM sessions') ? i : -1).filter(i => i >= 0);
    assert.ok(academic >= 0 && user > academic && domain > user); assert.equal(trace.slice(0, academic).some(x => /FOR (UPDATE|SHARE)/.test(x.sql)), false);
    assert.equal(sessions.length, 2); assert.ok(sessions[0] > user); assert.equal(sessions[1], trace.length - 1); assert.equal(trace.some(x => /FROM users.*FOR UPDATE/.test(x.sql)), false);
  }
});
