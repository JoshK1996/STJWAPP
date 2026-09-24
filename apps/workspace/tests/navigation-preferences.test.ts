import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  normalizePreferences, preferencesSchema, preferencesPatchSchema,
  workspaceNavigationIds, organizationNavigationIds, type Preferences,
} from '../shared/preferences';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { savePersonalPreferences } from '../server/preferences';

const legacy = {
  theme: 'dark', accent: 'custom', customColor: '#123456', artwork: 'none', depth: false,
  contrast: 'high', textSize: 'large', compact: true, navigation: 'rail', corners: 'crisp',
  reducedMotion: true, home: 'clock',
  widgetOrder: ['community', 'hours', 'requests', 'people', 'clock', 'metrics'], hiddenWidgets: ['people'],
};
const reversedWorkspace = () => [...workspaceNavigationIds].reverse();
const reversedOrganization = () => [...organizationNavigationIds].reverse();
const withoutOrders = ({ workspaceNavOrder: _w, organizationNavOrder: _o, ...rest }: Preferences) => rest;

test('old valid preferences gain exact existing group defaults without losing any legacy choice', () => {
  const old = structuredClone(legacy), result = normalizePreferences(old);
  assert.deepEqual(withoutOrders(result), old);
  assert.deepEqual(result.workspaceNavOrder, ['overview', 'clock', 'time-records', 'payroll', 'staff', 'schedule', 'calendar', 'messages', 'requests', 'reports']);
  assert.deepEqual(result.organizationNavOrder, ['school', 'care', 'dismissal', 'workspace', 'audit', 'settings']);
  assert.deepEqual(old, legacy); assert.deepEqual(preferencesSchema.parse(result), result);
});

test('stored navigation repairs only its own arrays and preserves recognized first-occurrence order', () => {
  const stored = { ...structuredClone(legacy), workspaceNavOrder: ['reports', 'clock', 'reports', 'future-page', null, 7, 'school', ['staff']], organizationNavOrder: ['settings', 'school', 'settings', 'reports'] };
  const before = structuredClone(stored), result = normalizePreferences(stored);
  assert.deepEqual(withoutOrders(result), legacy);
  assert.deepEqual(result.workspaceNavOrder, ['reports', 'clock', ...workspaceNavigationIds.filter(id => !['reports', 'clock'].includes(id))]);
  assert.deepEqual(result.organizationNavOrder, ['settings', 'school', ...organizationNavigationIds.filter(id => !['settings', 'school'].includes(id))]);
  assert.deepEqual(stored, before);
  for (const invalid of [null, 'clock', {}, 3, false]) {
    const normalized = normalizePreferences({ ...legacy, workspaceNavOrder: invalid, organizationNavOrder: reversedOrganization() });
    assert.deepEqual(normalized.workspaceNavOrder, workspaceNavigationIds);
    assert.deepEqual(normalized.organizationNavOrder, reversedOrganization());
    assert.deepEqual(withoutOrders(normalized), legacy);
  }
});

test('newly recognized missing navigation IDs append deterministically; valid saved orders are exact', () => {
  const priorCatalog = ['reports', ...workspaceNavigationIds.filter(id => id !== 'reports' && id !== 'messages')];
  const evolved = normalizePreferences({ ...legacy, workspaceNavOrder: priorCatalog });
  assert.deepEqual(evolved.workspaceNavOrder, [...priorCatalog, 'messages']);
  const complete = preferencesSchema.parse({ ...legacy, workspaceNavOrder: reversedWorkspace(), organizationNavOrder: reversedOrganization() });
  assert.deepEqual(normalizePreferences(complete), complete);
});

test('pre-payroll saved order appends Payroll without moving existing choices', () => {
  const prior = ['reports', 'clock', 'overview', 'time-records', 'staff', 'schedule', 'calendar', 'messages', 'requests'];
  const result = normalizePreferences({ ...legacy, workspaceNavOrder: prior });
  assert.deepEqual(result.workspaceNavOrder, [...prior, 'payroll']);
  assert.deepEqual(withoutOrders(result), legacy);
});

test('legacy invalid and unknown top-level behavior is unchanged, with independently normalized nav', () => {
  const defaultLegacy = withoutOrders(preferencesSchema.parse({}));
  for (const value of [undefined, null, [], 'wrong', 1, { ...legacy, theme: 'unknown' }, { ...legacy, futurePreference: true }]) {
    assert.deepEqual(withoutOrders(normalizePreferences(value)), defaultLegacy);
  }
  const result = normalizePreferences({ ...legacy, theme: 'invalid', workspaceNavOrder: reversedWorkspace(), organizationNavOrder: reversedOrganization() });
  assert.deepEqual(withoutOrders(result), defaultLegacy);
  assert.deepEqual(result.workspaceNavOrder, reversedWorkspace()); assert.deepEqual(result.organizationNavOrder, reversedOrganization());
});

test('default and normalized array values are independent, while PATCH never supplies omitted defaults', () => {
  const one = preferencesSchema.parse({}), two = preferencesSchema.parse({}), normalized = normalizePreferences({});
  one.workspaceNavOrder.reverse(); one.organizationNavOrder.reverse(); normalized.workspaceNavOrder.pop(); normalized.organizationNavOrder.pop();
  assert.deepEqual(two.workspaceNavOrder, workspaceNavigationIds); assert.deepEqual(two.organizationNavOrder, organizationNavigationIds);
  assert.deepEqual(preferencesPatchSchema.parse({}), {});
  assert.deepEqual(preferencesPatchSchema.parse({ accent: 'forest' }), { accent: 'forest' });
  assert.deepEqual(preferencesPatchSchema.parse({ workspaceNavOrder: reversedWorkspace() }), { workspaceNavOrder: reversedWorkspace() });
  assert.deepEqual(preferencesPatchSchema.parse({ organizationNavOrder: reversedOrganization() }), { organizationNavOrder: reversedOrganization() });
});

const malformed = () => [
  { workspaceNavOrder: [] }, { organizationNavOrder: [] },
  { workspaceNavOrder: [...workspaceNavigationIds.slice(1), 'clock'] },
  { organizationNavOrder: [...organizationNavigationIds.slice(1), 'care'] },
  { workspaceNavOrder: [...workspaceNavigationIds.slice(1), 'school'] },
  { organizationNavOrder: [...organizationNavigationIds.slice(1), 'overview'] },
  { workspaceNavOrder: [...workspaceNavigationIds.slice(1), 'https://example.test'] },
  { workspaceNavOrder: [...workspaceNavigationIds, 'future-page'] },
  { organizationNavOrder: null }, { workspaceNavOrder: 'overview' },
  { organizationNavOrder: [...organizationNavigationIds.slice(1), 3] },
  { hiddenNavigation: ['clock'] },
];
test('write schemas reject incomplete, duplicate, foreign, unknown and nonarray navigation data', () => {
  for (const input of malformed()) {
    assert.equal(preferencesPatchSchema.safeParse(input).success, false);
    assert.equal(preferencesSchema.safeParse({ ...legacy, ...input }).success, false);
  }
});

// Normal synthetic setup/login, then the actual current-proof preference route.
const origin = 'http://localhost:3193';
let db: Database, auth: { cookie: string; csrf: string; hash: string; actor: Actor };
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
const patch = (body: unknown) => request(app()).patch('/api/me/preferences').set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send(body as object);
async function state() {
  return {
    preferences: (await db.query('SELECT preferences FROM users WHERE id=$1 AND org_id=$2', [auth.actor.id, auth.actor.org_id])).rows[0].preferences,
    audits: (await db.query("SELECT id,detail FROM audit_events WHERE actor_id=$1 AND action='preferences.updated' ORDER BY id", [auth.actor.id])).rows,
  };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); const email = 'navigation.owner@example.test', password = 'Synthetic-' + randomUUID();
  await initialize(db, { demo: false, ownerEmail: email });
  const u = (await db.query('SELECT id,org_id FROM users WHERE email=$1', [email])).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, u as Actor));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  const login = await request(app()).post('/api/auth/login').set('Origin', origin).send({ email, credential: password, mode: 'password' }); assert.equal(login.status, 200);
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me = await request(app()).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  auth = { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)), actor: me.body.actor };
});
after(async () => { await db?.close(); });

test('normal saves, independent group patches, branding fields and older payloads retain unrelated orders', async () => {
  const full = preferencesSchema.parse({ ...legacy, workspaceNavOrder: reversedWorkspace(), organizationNavOrder: reversedOrganization() });
  let result = await patch(full); assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true, preferences: full }); assert.equal(result.headers['cache-control'], 'private, no-store');
  const brand = { accent: 'forest', artwork: 'subtle', depth: true };
  result = await patch(brand); assert.equal(result.status, 200); let expected = { ...full, ...brand };
  assert.deepEqual(result.body.preferences, expected);
  result = await patch({ workspaceNavOrder: [...workspaceNavigationIds] }); assert.equal(result.status, 200); expected = { ...expected, workspaceNavOrder: [...workspaceNavigationIds] };
  assert.deepEqual(result.body.preferences, expected);
  result = await patch({ organizationNavOrder: [...organizationNavigationIds] }); assert.equal(result.status, 200); expected = { ...expected, organizationNavOrder: [...organizationNavigationIds] };
  assert.deepEqual(result.body.preferences, expected);
  // Re-establish nondefaults so an old full payload must preserve them too.
  assert.equal((await patch({ workspaceNavOrder: reversedWorkspace(), organizationNavOrder: reversedOrganization() })).status, 200);
  result = await patch(legacy); assert.equal(result.status, 200); assert.deepEqual(result.body.preferences, full);
  const beforeRead = await state(), me = await request(app()).get('/api/me').set('Cookie', auth.cookie); assert.equal(me.status, 200); assert.deepEqual(me.body.actor.preferences, full); assert.deepEqual(await state(), beforeRead);
});

test('malformed navigation patches reject atomically without preference or audit writes', async () => {
  const before = await state();
  for (const input of malformed()) assert.equal((await patch(input)).status, 400);
  assert.deepEqual(await state(), before);
});

test('real post-audit SQL failure retains both stored orders and all existing preferences', async () => {
  const before = await state(); let audited = false;
  const database: Database = { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith('INSERT INTO audit_events') && params[3] === 'preferences.updated') { audited = true; await tx.query('SELECT 1/0'); }
    return result;
  } })) };
  await assert.rejects(savePersonalPreferences(database, auth.actor, auth.hash, { workspaceNavOrder: [...workspaceNavigationIds], organizationNavOrder: [...organizationNavigationIds] }), (e: any) => e.code === '22012');
  assert.ok(audited); assert.deepEqual(await state(), before);
});
