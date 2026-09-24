import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { issueSetup, type Actor } from '../server/security';

// Normal local setup/login. Only the original application INSERT of a new
// synthetic preview receives an accelerated deadline. No stored batch or
// credential/session is updated, and every expiry check uses the database clock.
const origin = 'http://localhost:3194';
let db: Database, actor: Actor, unitId: string, cookie: string, csrf: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function send(database: Database, path: string, body: object) {
  return request(app(database)).post('/api' + path).set('Cookie', cookie).set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
}
const applyBody = (preview: any) => ({ sourceHash: preview.sourceHash, planHash: preview.planHash, reviewed: true });
function source(kind: 'students' | 'households') {
  return kind === 'students'
    ? { context: { kind, unitId }, csv: `\uFEFFstudentNumber,name,dateOfBirth\r\nDEADLINE-${randomUUID().slice(0, 12)},Synthetic deadline student,\r\n` }
    : { context: { kind, unitId }, csv: 'householdId,version,name,address,archived\r\n,0,Synthetic deadline household,,false\r\n' };
}
function acceleratedPreview(alreadyExpired = false) {
  let inserted = false;
  const database: Database = { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
      if (sql.startsWith('INSERT INTO school_import_batches(')) {
        assert.equal(inserted, false); assert.equal(params.length, 9); inserted = true;
        const original = 'INSERT INTO school_import_batches(id,org_id,unit_id,actor_id,context,source_hash,plan_hash,input_rows,plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *';
        assert.equal(sql, original);
        const changed = original.replace('input_rows,plan)', 'input_rows,plan,expires_at)')
          .replace('$8,$9)', alreadyExpired ? "$8,$9,clock_timestamp()-interval '1 second')" : "$8,$9,clock_timestamp()+interval '4 seconds')");
        return tx.query<R>(changed, params);
      }
      return tx.query<R>(sql, params);
    },
  })) };
  return { database, inserted: () => inserted };
}
async function expired(tx: Queryable, id: string) {
  const deadline = performance.now() + 6500;
  while (performance.now() < deadline) {
    const row = (await tx.query('SELECT expires_at<=clock_timestamp() AS expired FROM school_import_batches WHERE id=$1', [id])).rows[0];
    assert.ok(row); if (row.expired) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail('Accelerated original preview did not reach its database deadline');
}
function expireAfterAudit(id: string) {
  let audited = false;
  const database: Database = { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
      const result = await tx.query<R>(sql, params);
      if (sql.startsWith('INSERT INTO audit_events') && params[3] === 'school.import.applied' && params[4] === id) {
        assert.equal(audited, false); audited = true; await expired(tx, id);
      }
      return result;
    },
  })) };
  return { database, audited: () => audited };
}
async function state(id: string) {
  return {
    people: (await db.query('SELECT * FROM school_people WHERE org_id=$1 ORDER BY id', [actor.org_id])).rows,
    students: (await db.query('SELECT * FROM students WHERE org_id=$1 ORDER BY id', [actor.org_id])).rows,
    households: (await db.query('SELECT * FROM households WHERE org_id=$1 ORDER BY id', [actor.org_id])).rows,
    history: (await db.query('SELECT * FROM school_history WHERE actor_id=$1 ORDER BY id', [actor.id])).rows,
    audits: (await db.query("SELECT id,action,target_id,detail FROM audit_events WHERE actor_id=$1 AND action LIKE 'school.%' ORDER BY id", [actor.id])).rows,
    batch: (await db.query('SELECT id,applied_at,receipt,plan_hash,source_hash FROM school_import_batches WHERE id=$1', [id])).rows,
  };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'school.deadline.owner@example.test' });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  unitId = (await db.query('SELECT id FROM units ORDER BY id LIMIT 1')).rows[0].id;
  actor = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: 'owner', mode: 'password', unit_ids: [] } as Actor;
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, actor));
  const setup = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password }); assert.equal(setup.status, 200);
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email: actor.email, credential: password, mode: 'password' }); assert.equal(login.status, 200);
  cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me = await request(app()).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200); csrf = me.body.actor.csrf;
});
after(async () => { await db?.close(); });

for (const kind of ['students', 'households'] as const) test(`${kind} import expiry after the real apply audit rolls back every intended change`, async () => {
  const original = acceleratedPreview(), raw = source(kind), preview = await send(original.database, '/school/imports/preview', raw);
  assert.equal(preview.status, 201); assert.ok(original.inserted()); assert.equal(preview.body.plan.counts.errors, 0);
  const before = await state(preview.body.id), gated = expireAfterAudit(preview.body.id);
  const result = await send(gated.database, '/school/imports/' + preview.body.id + '/apply', applyBody(preview.body));
  assert.ok(gated.audited(), 'Actual apply audit must precede the deadline failure'); assert.equal(result.status, 409); assert.match(result.body.error, /expired/);
  assert.deepEqual(await state(preview.body.id), before);
  const refreshed = await send(db, '/school/imports/preview', raw); assert.equal(refreshed.status, 201);
  const applied = await send(db, '/school/imports/' + refreshed.body.id + '/apply', applyBody(refreshed.body)); assert.equal(applied.status, 200); assert.equal(applied.body.receipt.records.length, 1);
});

test('an already-expired original preview is rejected using the database clock before domain writes', async () => {
  const original = acceleratedPreview(true), preview = await send(original.database, '/school/imports/preview', source('students'));
  assert.equal(preview.status, 201); assert.ok(original.inserted()); const before = await state(preview.body.id);
  const result = await send(db, '/school/imports/' + preview.body.id + '/apply', applyBody(preview.body));
  assert.equal(result.status, 409); assert.deepEqual(await state(preview.body.id), before);
});

test('an applied receipt remains replayable after its original preview deadline and source version changes', async () => {
  const original = acceleratedPreview(), preview = await send(original.database, '/school/imports/preview', source('households'));
  assert.equal(preview.status, 201); const applied = await send(db, '/school/imports/' + preview.body.id + '/apply', applyBody(preview.body)); assert.equal(applied.status, 200);
  const id = applied.body.receipt.records[0].householdId;
  const changed = await request(app()).patch('/api/school/households/' + id).set('Cookie', cookie).set('Origin', origin).set('X-CSRF-Token', csrf)
    .send({ name: 'Changed later synthetic household', address: '', archived: false, version: 1 }); assert.equal(changed.status, 200);
  await expired(db, preview.body.id); const before = await state(preview.body.id);
  const replay = await send(db, '/school/imports/' + preview.body.id + '/apply', applyBody(preview.body));
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, applied.body); assert.deepEqual(await state(preview.body.id), before);
});
