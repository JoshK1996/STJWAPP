import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { createApp } from '../server/app';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { digest, issueSetup, opaqueToken, type Actor } from '../server/security';
import { clockCommand } from '../server/workforce';

const origin = 'http://localhost:3282', path = '/api/clock/history';
const password = 'Synthetic!936';
const base = DateTime.now().setZone('America/New_York').startOf('day').minus({ days: 2 }).plus({ hours: 8 });
type Auth = { cookie: string; csrf: string; hash: string; actor: Actor };
type Person = { auth: Auth; pin: string; shiftId: string; minutes: number };
let db: Database, app: ReturnType<typeof createApp>, owner: Auth, unitId: string, jobId: string;
const people: Person[] = [];

const get = (url: string, auth?: Auth) => request(app).get(url).set('Cookie', auth?.cookie ?? '');
const post = (url: string, body: object, auth?: Auth) => request(app).post(url)
  .set('Origin', origin).set('Cookie', auth?.cookie ?? '').set('X-CSRF-Token', auth?.csrf ?? '').send(body);
async function session(response: request.Response): Promise<Auth> {
  assert.equal(response.status, 200, response.body.error);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const me = await request(app).get('/api/me').set('Cookie', cookie);
  assert.equal(me.status, 200, me.body.error);
  return { cookie, csrf: me.body.actor.csrf, actor: me.body.actor, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
const pinSession = async (pin: string) => session(await post('/api/auth/login', { mode: 'pin', credential: pin }));

before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: 'personal.history.owner@example.test' });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
  const user = (await db.query("SELECT id,org_id FROM users WHERE email='personal.history.owner@example.test'")).rows[0];
  const job = (await db.query('SELECT id,unit_id FROM jobs WHERE org_id=$1 ORDER BY title LIMIT 1', [user.org_id])).rows[0];
  unitId = job.unit_id; jobId = job.id;
  const token = await db.transaction(tx => issueSetup(tx, { id: user.id, org_id: user.org_id }));
  owner = await session(await post('/api/auth/setup', { token, password }));
  for (const [index, role] of ['owner', 'admin', 'employee'].entries()) {
    let auth = owner;
    if (role !== 'owner') {
      const created = await post('/api/staff', {
        name: `Synthetic personal history ${role}`, email: `${randomUUID()}@stjw.org`, role,
        unitIds: [unitId], jobIds: [jobId],
      }, owner);
      assert.equal(created.status, 201, created.body.error);
      auth = await session(await post('/api/auth/setup', { token: created.body.setupUrl.split('#setup=')[1], password }));
    }
    const pin = ['736291', '736292', '736293'][index];
    assert.equal((await post('/api/auth/pin', { password, pin }, auth)).status, 200);
    const opened = await clockCommand(db, auth.actor, { action: 'clock_in', jobId, commandId: randomUUID() }, base.toJSDate());
    const minutes = [15, 40, 95][index];
    await clockCommand(db, auth.actor, { action: 'clock_out', commandId: randomUUID() }, base.plus({ minutes }).toJSDate());
    people.push({ auth, pin, shiftId: opened.shift.id, minutes });
  }
});
after(async () => { await db?.close(); });

test('PIN-only HTTP sign-in scopes personal history to the employee even for owner and administrator roles', async () => {
  for (const person of people) {
    const pin = await pinSession(person.pin);
    assert.equal(pin.actor.id, person.auth.actor.id);
    assert.equal(pin.actor.mode, 'pin');
    const result = await get(path + '?period=all', pin);
    assert.equal(result.status, 200, result.body.error);
    assert.match(result.headers['cache-control'], /private.*no-store/);
    assert.deepEqual(result.body.rows.map((row: { id: string }) => row.id), [person.shiftId]);
    assert.equal(result.body.summary.workMicroseconds, (BigInt(person.minutes) * 60_000_000n).toString());
    assert.equal(result.body.summary.shiftCount, 1);
    assert.equal(result.body.jobs[0].jobId, jobId);
    assert.equal(result.body.jobs[0].unitId, unitId);
    for (const other of people.filter(value => value !== person)) assert.ok(!JSON.stringify(result.body).includes(other.shiftId));
    assert.doesNotMatch(JSON.stringify(result.body), /password_hash|pin_hash|pin_lookup|csrf|pay_rate|hourlyRate|permissions/);
  }
});

test('personal history accepts day, week, month, year, custom and all-history selections through HTTP', async () => {
  const employee = people[2], pin = await pinSession(employee.pin), day = base.toISODate()!;
  for (const period of ['day', 'week', 'month', 'year', 'custom', 'all']) {
    const query = new URLSearchParams({ period });
    if (period === 'custom') { query.set('from', day); query.set('to', day); }
    else if (period !== 'all') query.set('anchor', day);
    const result = await get(path + '?' + query.toString(), pin);
    assert.equal(result.status, 200, `${period}: ${result.body.error}`);
    assert.equal(result.body.range.period, period);
    assert.deepEqual(result.body.rows.map((row: { id: string }) => row.id), [employee.shiftId]);
    assert.equal(result.body.offset, 0);
    assert.equal(result.body.hasMore, false);
  }
  const password = await get(path + '?period=all', employee.auth);
  assert.equal(password.status, 200, password.body.error);
  assert.deepEqual(password.body.rows.map((row: { id: string }) => row.id), [employee.shiftId]);
});

test('history query rejects identity overrides and malformed filters without exposing another employee', async () => {
  const pin = await pinSession(people[1].pin);
  for (const query of [
    `userId=${people[0].auth.actor.id}`, `orgId=${owner.actor.org_id}`, `jobId=${jobId}`, `unitId=${unitId}`,
    'role=owner', 'period=anything', 'period=day&period=year', 'offset=-1', 'offset=0.5', 'offset=10001',
    'period=custom&from=2026-10-02&to=2026-10-01', 'period=custom&from=2026-10-01',
    'period=week&from=2026-10-01&to=2026-10-02', 'period=all&anchor=2026-10-01',
  ]) {
    const result = await get(path + '?' + query, pin);
    assert.equal(result.status, 400, query);
    assert.match(result.headers['cache-control'], /no-store/);
    assert.equal(result.body.rows, undefined);
    assert.equal(result.body.summary, undefined);
  }
  const tooBroad = await get(path + '?period=custom&from=2020-01-01&to=2026-10-01', pin);
  assert.equal(tooBroad.status, 422);
  assert.equal(tooBroad.body.rows, undefined);
});

test('administrator PIN history access does not open management routes or time-card writes', async () => {
  const pin = await pinSession(people[1].pin);
  for (const url of [
    '/api/time-records', `/api/time-records/${people[1].shiftId}`, '/api/payroll/hours', '/api/payroll/review',
    '/api/staff', `/api/staff/${people[1].auth.actor.id}/assignments`, '/api/jobs',
    '/api/workforce/attention-policy', '/api/auth/mfa',
  ]) assert.equal((await get(url, pin)).status, 403, url);
  for (const url of ['/api/time-corrections', `/api/time-records/${people[1].shiftId}/adjust`, '/api/auth/pin']) {
    assert.equal((await post(url, {}, pin)).status, 403, url);
  }
  const preferences = await request(app).patch('/api/me/preferences').set('Origin', origin)
    .set('Cookie', pin.cookie).set('X-CSRF-Token', pin.csrf).send({});
  assert.equal(preferences.status, 403);
  assert.equal((await get('/api/clock', pin)).status, 200);
});

test('the PIN history allowance is GET-only and anonymous or bearer-token requests remain denied', async () => {
  const pin = await pinSession(people[1].pin);
  for (const method of ['post', 'put', 'patch', 'delete', 'head'] as const) {
    const pending = request(app)[method](path).set('Origin', origin).set('Cookie', pin.cookie).set('X-CSRF-Token', pin.csrf);
    const result = await (method === 'head' ? pending : pending.send({}));
    assert.equal(result.status, 403, method);
    assert.match(result.headers['cache-control'], /no-store/);
  }
  assert.equal((await get(path)).status, 401);
  const token = opaqueToken();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic personal history token',$5,now()+interval '1 hour')",
    [randomUUID(), owner.actor.org_id, owner.actor.id, digest(token), JSON.stringify(['reports:read', 'staff:read'])]);
  for (const withCookie of [false, true]) {
    const result = await request(app).get(path).set('Authorization', 'Bearer ' + token).set('Cookie', withCookie ? pin.cookie : '');
    assert.equal(result.status, 403);
    assert.equal(result.body.rows, undefined);
  }
});

test('PIN history stops at cookie-session expiry and after normal logout', async () => {
  const expired = await pinSession(people[2].pin);
  assert.equal((await get(path, expired)).status, 200);
  // Accelerate only this synthetic session's persisted expiry; the real authentication middleware handles denial.
  await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [expired.hash]);
  const stale = await get(path, expired);
  assert.equal(stale.status, 401);
  assert.match(stale.headers['cache-control'], /no-store/);
  assert.equal(stale.body.rows, undefined);
  const signed = await pinSession(people[2].pin);
  assert.equal((await get(path, signed)).status, 200);
  const logout = await post('/api/auth/logout', {}, signed);
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /^stjw_session=;/);
  assert.equal((await get(path, signed)).status, 401);
  assert.equal((await get('/api/clock', signed)).status, 401);
});
