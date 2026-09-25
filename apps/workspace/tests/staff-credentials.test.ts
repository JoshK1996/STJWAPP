import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, opaqueToken, verifyPassword, type Actor } from '../server/security';
import { createStaffAccount } from '../server/temporary-credentials';
import { resetStaffTemporaryCredentials } from '../server/staff-credentials';

const origin = 'http://localhost:3197', password = 'Original!8', temporary = 'Temporary!8', temporaryPin = '563918';
let db: Database, unitId: string, owner: Auth;
type Auth = { actor: Actor; cookie: string; csrf: string; hash: string };
const application = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
function post(path: string, body: object, auth?: Auth, database = db) { return request(application(database)).post('/api' + path).set('Origin', origin).set('Cookie', auth?.cookie ?? '').set('X-CSRF-Token', auth?.csrf ?? '').send(body); }
async function signed(email: string): Promise<Auth> {
  const login = await post('/auth/login', { email, credential: password, mode: 'password' }); assert.equal(login.status, 200, login.body.error);
  const cookie = login.headers['set-cookie'][0].split(';')[0], me = await request(application()).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function person(role: 'employee' | 'manager' | 'admin' = 'employee', pending = false) {
  const email = randomUUID() + '@stjw.org';
  const created = await createStaffAccount(db, owner.actor, owner.hash, { name: 'Synthetic sign-in recovery', email, role, unitIds: [unitId], jobIds: [], ...(pending ? { initialCredentials: { password: temporary, pin: temporaryPin } } : {}) }, 'stjw.org', origin);
  if ('setupUrl' in created) { const setup = await post('/auth/setup', { token: new URL(created.setupUrl).hash.slice('#setup='.length), password }); assert.equal(setup.status, 200, setup.body.error); }
  return { id: created.id, email, auth: pending ? undefined : await signed(email) };
}
const input = () => ({ commandId: randomUUID(), password: temporary, pin: temporaryPin, reason: 'Synthetic first-sign-in assistance' });
async function snapshot(id: string) {
  return {
    user: (await db.query('SELECT password_hash,pin_hash,pin_lookup,pin_lookup_key_id,requires_credential_change FROM users WHERE id=$1', [id])).rows[0],
    sessions: (await db.query('SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY token_hash', [id])).rows,
    commands: (await db.query('SELECT command_id FROM staff_credential_commands WHERE target_id=$1 ORDER BY command_id', [id])).rows,
  };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'synthetic.recovery.owner@example.test' });
  const row = (await db.query("SELECT id,org_id,email FROM users WHERE role='owner'")).rows[0]; unitId = (await db.query('SELECT id FROM units LIMIT 1')).rows[0].id;
  const token = await db.transaction(tx => issueSetup(tx, { id: row.id, org_id: row.org_id })); assert.equal((await post('/auth/setup', { token, password })).status, 200); owner = await signed(row.email);
});
beforeEach(async () => { await db.query('DELETE FROM auth_limits'); });
after(async () => { await db?.close(); });

test('administrator resets an existing account transactionally, preserving MFA and revoking old access without auditing secrets', async () => {
  const target = await person(), value = input(), setup = await db.transaction(tx => issueSetup(tx, { id: target.id, org_id: owner.actor.org_id })), token = opaqueToken();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,'Synthetic retained token',$4,'[\"staff:read\"]',now()+interval '1 day')", [randomUUID(), owner.actor.org_id, target.id, digest(token)]);
  const factorId = randomUUID(); await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'Synthetic cipher','Synthetic digest',now(),now())", [target.id, owner.actor.org_id, factorId]);
  const response = await post(`/staff/${target.id}/temporary-credentials`, value, owner); assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(response.body, { id: target.id, requiresCredentialChange: true, replayed: false });
  const state = await snapshot(target.id); assert.equal(state.user.requires_credential_change, true); assert.equal(state.user.pin_lookup, null);
  assert.ok(await verifyPassword(value.password, state.user.password_hash)); assert.ok(await verifyPassword(value.pin, state.user.pin_hash)); assert.equal(state.sessions.length, 0);
  assert.equal((await db.query('SELECT id FROM mfa_factors WHERE user_id=$1 AND enabled_at IS NOT NULL', [target.id])).rows[0].id, factorId);
  assert.ok((await db.query('SELECT consumed_at FROM setup_tokens WHERE token_hash=$1', [digest(setup)])).rows[0].consumed_at);
  assert.ok((await db.query('SELECT revoked_at FROM api_tokens WHERE token_hash=$1', [digest(token)])).rows[0].revoked_at);
  const events = (await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND action='staff.temporary_credentials_reset'", [target.id])).rows;
  assert.deepEqual(events.map(event => event.detail), [{ commandId: value.commandId, reason: value.reason, requiresCredentialChange: true }]);
  const receipt = JSON.stringify((await db.query('SELECT * FROM staff_credential_commands WHERE command_id=$1', [value.commandId])).rows);
  for (const secret of [value.password, value.pin, state.user.password_hash, state.user.pin_hash]) assert.ok(!receipt.includes(secret));
  await assert.rejects(db.query("UPDATE staff_credential_commands SET fingerprint=repeat('0',64) WHERE command_id=$1", [value.commandId]), /immutable/);
  const onboarding = await post('/auth/login', { email: target.email, credential: temporary, mode: 'password' });
  assert.equal(onboarding.status, 200); assert.equal(onboarding.body.requiresCredentialChange, true);
  const replacement = await post('/auth/credentials/complete', { challenge: onboarding.body.challenge, password: 'PrivateMfa!8', pin: '749201' }); assert.equal(replacement.status, 200, replacement.body.error);
  const protectedLogin = await post('/auth/login', { email: target.email, credential: 'PrivateMfa!8', mode: 'password' });
  assert.equal(protectedLogin.status, 200); assert.equal(typeof protectedLogin.body.challenge, 'string'); assert.equal(protectedLogin.body.requiresCredentialChange, undefined);
  assert.equal((await snapshot(target.id)).sessions.length, 0, 'recovery must not bypass the preserved MFA factor');
});

test('shared temporary PIN recovery uses email/password and forces both replacements before password or PIN sessions', async () => {
  const a = await person('employee', true), b = await person('employee', true), value = input();
  assert.equal((await post(`/staff/${a.id}/temporary-credentials`, value, owner)).status, 200);
  const ambiguous = await post('/auth/login', { mode: 'pin', credential: temporaryPin }); assert.equal(ambiguous.status, 401); assert.match(ambiguous.body.error, /shared temporary PIN/);
  assert.ok(!JSON.stringify(ambiguous.body).includes(a.email) && !JSON.stringify(ambiguous.body).includes(b.email));
  const login = await post('/auth/login', { email: a.email, credential: temporary, mode: 'password' }); assert.equal(login.status, 200); assert.equal(login.body.requiresCredentialChange, true);
  assert.equal((await snapshot(a.id)).sessions.length, 0);
  assert.equal((await post('/auth/credentials/complete', { challenge: login.body.challenge, password: temporary, pin: '704193' })).status, 400);
  const done = await post('/auth/credentials/complete', { challenge: login.body.challenge, password: 'Private!88', pin: '704193' }); assert.equal(done.status, 200, done.body.error);
  const clock = await post('/auth/login', { mode: 'pin', credential: '704193' }); assert.equal(clock.status, 200);
  const cookie = clock.headers['set-cookie'][0].split(';')[0]; assert.equal((await request(application()).get('/api/staff').set('Cookie', cookie)).status, 403);
  const completed = await snapshot(a.id), retry = await post(`/staff/${a.id}/temporary-credentials`, value, owner);
  assert.deepEqual(retry.body, { id: a.id, requiresCredentialChange: false, replayed: true }); assert.deepEqual(await snapshot(a.id), completed);
  assert.equal((await post('/auth/login', { email: a.email, credential: 'Private!88', mode: 'password' })).status, 200);
});

test('command retries are actor/target/input bound and competing duplicates cannot reset twice', async () => {
  const target = await person(), value = input();
  const results = await Promise.all([resetStaffTemporaryCredentials(db, owner.actor, owner.hash, target.id, value), resetStaffTemporaryCredentials(db, owner.actor, owner.hash, target.id, value)]);
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  const before = await snapshot(target.id);
  await assert.rejects(resetStaffTemporaryCredentials(db, owner.actor, owner.hash, target.id, { ...value, password: 'Changed!88' }), (error: any) => error.status === 409);
  const other = await person(), admin = await person('admin');
  await assert.rejects(resetStaffTemporaryCredentials(db, owner.actor, owner.hash, other.id, value), (error: any) => error.status === 409);
  await assert.rejects(resetStaffTemporaryCredentials(db, admin.auth!.actor, admin.auth!.hash, target.id, value), (error: any) => error.status === 409);
  assert.deepEqual(await snapshot(target.id), before);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='staff.temporary_credentials_reset'", [target.id])).rows.length, 1);
});

test('reset enforces hierarchy, no-self, active target, CSRF, strict input and actual current password proof', async () => {
  const target = await person(), manager = await person('manager'), admin = await person('admin'), before = await snapshot(target.id);
  assert.equal((await post(`/staff/${target.id}/temporary-credentials`, input(), manager.auth)).status, 403);
  assert.equal((await post(`/staff/${admin.id}/temporary-credentials`, input(), admin.auth)).status, 403);
  assert.equal((await post(`/staff/${owner.actor.id}/temporary-credentials`, input(), admin.auth)).status, 403);
  assert.equal((await post(`/staff/${target.id}/temporary-credentials`, { ...input(), password: 'short' }, owner)).status, 400);
  assert.equal((await post(`/staff/${target.id}/temporary-credentials`, { ...input(), role: 'owner' }, owner)).status, 400);
  assert.equal((await post(`/staff/${target.id}/temporary-credentials`, input(), { ...owner, csrf: 'wrong' })).status, 403);
  await assert.rejects(resetStaffTemporaryCredentials(db, owner.actor, undefined, target.id, input()), (error: any) => error.status === 401);
  await assert.rejects(resetStaffTemporaryCredentials(db, owner.actor, target.auth!.hash, target.id, input()), (error: any) => error.status === 401);
  await assert.rejects(resetStaffTemporaryCredentials(db, { ...owner.actor, mode: 'pin' }, owner.hash, target.id, input()), (error: any) => error.status === 403);
  assert.deepEqual(await snapshot(target.id), before);
  await db.query('UPDATE users SET active=false WHERE id=$1', [target.id]); assert.equal((await post(`/staff/${target.id}/temporary-credentials`, input(), owner)).status, 409);
});

test('audit failure and late session expiry roll back credentials, revocations and receipt together', async () => {
  const target = await person(), before = await snapshot(target.id);
  for (const failure of ['audit', 'expiry']) {
    const wrapped: Database = { ...db, transaction: async <T>(work: (tx: Queryable) => Promise<T>) => db.transaction(tx => work({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (failure === 'audit' && sql.startsWith('INSERT INTO audit_events')) throw Error('Synthetic audit failure');
      const result = await tx.query<R>(sql, params);
      if (failure === 'expiry' && sql.startsWith('INSERT INTO audit_events')) await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [owner.hash]);
      return result;
    } })) };
    await assert.rejects(resetStaffTemporaryCredentials(wrapped, owner.actor, owner.hash, target.id, input()), (error: any) => failure === 'audit' ? /Synthetic audit failure/.test(error.message) : error.status === 401);
    assert.deepEqual(await snapshot(target.id), before);
  }
});

test('a previously supplied administrator actor cannot reset after revocation, role removal or unverified MFA enrollment', async () => {
  const target = await person(), before = await snapshot(target.id), revoked = await person('admin'), demoted = await person('admin'), enrolled = await person('admin');
  await db.query('DELETE FROM sessions WHERE token_hash=$1', [revoked.auth!.hash]);
  await assert.rejects(resetStaffTemporaryCredentials(db, revoked.auth!.actor, revoked.auth!.hash, target.id, input()), (error: any) => error.status === 401);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [demoted.id]);
  await assert.rejects(resetStaffTemporaryCredentials(db, demoted.auth!.actor, demoted.auth!.hash, target.id, input()), (error: any) => error.status === 403);
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'Synthetic cipher','Synthetic digest',now(),now())", [enrolled.id, owner.actor.org_id, randomUUID()]);
  await assert.rejects(resetStaffTemporaryCredentials(db, enrolled.auth!.actor, enrolled.auth!.hash, target.id, input()), (error: any) => error.status === 401);
  assert.deepEqual(await snapshot(target.id), before);
});
