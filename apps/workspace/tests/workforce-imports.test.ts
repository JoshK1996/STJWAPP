import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { createStaffAccount } from '../server/temporary-credentials';
import { createManagedJob, updateManagedJob, updateStaffAccount } from '../server/staff-authority';
import { previewWorkforceImport, applyWorkforceImport, getWorkforceImport } from '../server/workforce-imports';
import { createSchedule } from '../server/staff-scheduling';
import { workforceImportColumns } from '../shared/workforce-imports';
import { inspectImportWorkbook, convertImportWorkbook, downloadImportWorkbookTemplate } from '../server/import-workbooks';

const origin = 'http://localhost:3197', password = 'Synthetic!8';
type Auth = { actor: Actor; cookie: string; csrf: string; hash: string };
let db: Database, owner: Auth, units: Row[];
const application = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
const post = (path: string, body: object, auth?: Auth) => request(application()).post('/api' + path).set('Origin', origin).set('Cookie', auth?.cookie ?? '').set('X-CSRF-Token', auth?.csrf ?? '').send(body);
async function signIn(email: string): Promise<Auth> {
  const login = await post('/auth/login', { email, credential: password, mode: 'password' }); assert.equal(login.status, 200, login.body.error);
  const cookie = login.headers['set-cookie'][0].split(';')[0], me = await request(application()).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function staff(role: 'employee' | 'manager' | 'admin' = 'employee', jobId?: string, unit = units[0]) {
  const email = randomUUID() + '@stjw.org', name = 'Synthetic import employee';
  const created = await createStaffAccount(db, owner.actor, owner.hash, { name, email, role, unitIds: [unit.id], jobIds: jobId ? [jobId] : [] }, 'stjw.org', origin);
  assert.ok('setupUrl' in created); assert.equal((await post('/auth/setup', { token: new URL(created.setupUrl).hash.slice(7), password })).status, 200);
  return { id: created.id, email, name, auth: await signIn(email) };
}
async function job(unit = units[0]) { const title = 'Synthetic job ' + randomUUID(); const value = await createManagedJob(db, owner.actor, owner.hash, { unitId: unit.id, title, description: 'Fixture job' }); return { id: value.id, title }; }
const csv = (kind: 'jobs' | 'schedules', rows: string[][]) => [workforceImportColumns[kind], ...rows].map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(',')).join('\r\n');
const preview = (kind: 'jobs' | 'schedules', source: string, auth = owner, database = db) => previewWorkforceImport(database, auth.actor, auth.hash, kind, { csv: source });
const apply = (kind: 'jobs' | 'schedules', value: { id: string; sourceHash: string }, auth = owner, database = db) => applyWorkforceImport(database, auth.actor, auth.hash, kind, value.id, { sourceHash: value.sourceHash });
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'synthetic.bulk.owner@example.test' });
  units = (await db.query('SELECT id,name FROM units ORDER BY id')).rows;
  const row = (await db.query("SELECT id,org_id,email FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, { id: row.id, org_id: row.org_id })); assert.equal((await post('/auth/setup', { token, password })).status, 200); owner = await signIn(row.email);
});
beforeEach(async () => { await db.query('DELETE FROM auth_limits'); });
after(async () => { await db?.close(); });

test('job template is blank; readable preview creates nothing; atomic apply/retry retains exact immutable source and receipt', async () => {
  const template = await request(application()).get('/api/imports/workforce/jobs/template').set('Cookie', owner.cookie);
  assert.equal(template.status, 200); assert.ok(template.text.includes('community')); assert.equal(template.text.trim().split(/\r?\n/).length, 1);
  const title = 'New "visual", job ' + randomUUID(), source = '\uFEFF' + csv('jobs', [[units[0].name, title, 'Readable description'], [units[0].name, title + ' 2', 'Second description']]);
  const beforeCount = (await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n;
  const response = await post('/imports/workforce/jobs/preview', { csv: source }, owner); assert.equal(response.status, 200, response.body.error);
  const value = response.body; assert.equal(value.rows[0].title, title); assert.equal(value.rows[0].community, units[0].name); assert.equal(value.rows[0].unitId, undefined);
  assert.equal((await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n, beforeCount);
  const results = await Promise.all([apply('jobs', value), apply('jobs', value)]); assert.deepEqual(results[0], results[1]); assert.equal(results[0].created, 2);
  assert.equal((await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n, Number(beforeCount) + 2);
  const retained = (await db.query('SELECT source_base64,source_hash,receipt FROM workforce_import_batches WHERE id=$1', [value.id])).rows[0]; assert.equal(Buffer.from(retained.source_base64, 'base64').toString('utf8'), source); assert.equal(retained.source_hash, digest(source)); assert.deepEqual(retained.receipt, results[0]);
  await assert.rejects(db.query("UPDATE workforce_import_batches SET source_base64='changed' WHERE id=$1", [value.id]), /immutable/);
  await assert.rejects(db.query('DELETE FROM workforce_import_batches WHERE id=$1', [value.id]), /immutable/);
  assert.equal((await request(application()).get('/api/imports/workforce/jobs').set('Cookie', owner.cookie)).body.rows[0].applied, true);
  assert.deepEqual((await getWorkforceImport(db, owner.actor, owner.hash, 'jobs', value.id)).receipt, results[0]);
});

test('schedule import resolves names/emails, preserves explicit offset times, writes version history and never clocks in staff', async () => {
  const duty = await job(), person = await staff('employee', duty.id);
  const source = csv('schedules', [[person.email.toUpperCase(), units[0].name, duty.title, '2026-10-05T08:00:00-04:00', '2026-10-05T10:00:00-04:00', 'Morning'], [person.email, units[0].name, duty.title, '2026-10-05T10:00:00-04:00', '2026-10-05T12:00:00-04:00', 'Adjacent']]);
  const value = await preview('schedules', source); assert.equal(value.rows[0].startsAt, '2026-10-05T12:00:00.000Z'); assert.equal(value.rows[0].employee, person.name);
  const receipt = await apply('schedules', value); assert.equal(receipt.created, 2); assert.deepEqual(await apply('schedules', value), receipt);
  const rows = (await db.query('SELECT id,version,status FROM schedules WHERE user_id=$1 ORDER BY starts_at', [person.id])).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.version === 1 && row.status === 'scheduled'));
  assert.equal((await db.query('SELECT count(*) AS n FROM staff_schedule_history WHERE schedule_id=ANY($1::uuid[])', [rows.map(row => row.id)])).rows[0].n, 2);
  assert.equal((await db.query('SELECT id FROM shifts WHERE user_id=$1', [person.id])).rows.length, 0);
});

test('preview rejects duplicates, ambiguous names, malformed dates, unassigned work and intra-file or existing overlaps', async () => {
  const duty = await job(), person = await staff('employee', duty.id), unassigned = await staff(), title = 'Dup ' + randomUUID();
  await assert.rejects(preview('jobs', csv('jobs', [[units[0].name, title, ''], [units[0].name, title.toUpperCase(), '']])), (error: any) => error.status === 400);
  await assert.rejects(preview('jobs', csv('jobs', [[units[0].name, duty.title, '']])), (error: any) => error.status === 409);
  const line = [person.email, units[0].name, duty.title, '2026-11-01T08:00:00-05:00', '2026-11-01T10:00:00-05:00', ''];
  await assert.rejects(preview('schedules', csv('schedules', [[...line.slice(0, 3), '2026-11-01T08:00:00', line[4], '']])), (error: any) => error.status === 400);
  await assert.rejects(preview('schedules', csv('schedules', [[unassigned.email, ...line.slice(1)]])), (error: any) => error.status === 400);
  await assert.rejects(preview('schedules', csv('schedules', [line, [...line.slice(0, 3), '2026-11-01T09:00:00-05:00', '2026-11-01T11:00:00-05:00', 'Overlap']])), (error: any) => error.status === 409);
  await createSchedule(db, owner.actor, { userId: person.id, jobId: duty.id, startsAt: '2026-11-01T13:00:00Z', endsAt: '2026-11-01T15:00:00Z', note: '', commandId: randomUUID(), reason: 'Synthetic conflict' });
  await assert.rejects(preview('schedules', csv('schedules', [line])), (error: any) => error.status === 409);
  await createManagedJob(db, owner.actor, owner.hash, { unitId: units[0].id, title: duty.title, description: 'Ambiguity fixture allowed by individual creation' });
  await assert.rejects(preview('schedules', csv('schedules', [line])), (error: any) => error.status === 400);
});

test('source changes after preview require re-review: job revision, employee assignment and competing schedule', async () => {
  const duty = await job(), person = await staff('employee', duty.id);
  const source = csv('schedules', [[person.email, units[0].name, duty.title, '2026-10-15T12:00:00Z', '2026-10-15T14:00:00Z', '']]);
  const first = await preview('schedules', source);
  await updateManagedJob(db, owner.actor, owner.hash, duty.id, { unitId: units[0].id, title: duty.title, description: 'Changed after review', active: true, expectedVersion: 1, reason: 'Synthetic revision' });
  await assert.rejects(apply('schedules', first), (error: any) => error.status === 409);
  const second = await preview('schedules', source);
  await createSchedule(db, owner.actor, { userId: person.id, jobId: duty.id, startsAt: '2026-10-15T12:00:00Z', endsAt: '2026-10-15T14:00:00Z', note: '', commandId: randomUUID(), reason: 'Competing schedule' });
  await assert.rejects(apply('schedules', second), (error: any) => error.status === 409);
  const third = await preview('schedules', source.replaceAll('10-15', '10-16'));
  const currentStaff = await request(application()).get('/api/staff').set('Cookie', owner.cookie); assert.equal(currentStaff.status, 200);
  const expectedRevision = currentStaff.body.rows.find((row: any) => row.id === person.id).revision;
  await updateStaffAccount(db, owner.actor, owner.hash, person.id, { name: person.name, email: person.email, role: 'employee', unitIds: [units[0].id], jobIds: [], active: true, expectedRevision }, 'stjw.org');
  await assert.rejects(apply('schedules', third), (error: any) => error.status === 409);
  assert.equal((await db.query('SELECT id FROM schedules WHERE user_id=$1', [person.id])).rows.length, 1);
});

test('scope, owner-only preview recovery, CSRF, actual session and revoked authority deny without imports', async () => {
  const manager = await staff('manager'), employee = await staff(), otherAdmin = await staff('admin'), title = 'Scope ' + randomUUID();
  const source = csv('jobs', [[units[0].name, title, '']]);
  const value = await preview('jobs', source, manager.auth);
  assert.equal((await post(`/imports/workforce/jobs/${value.id}/apply`, { sourceHash: value.sourceHash }, { ...manager.auth, csrf: 'wrong' })).status, 403);
  await assert.rejects(preview('jobs', source, employee.auth), (error: any) => error.status === 403);
  await assert.rejects(apply('jobs', value, otherAdmin.auth), (error: any) => error.status === 404);
  if (units.length > 1) await assert.rejects(preview('jobs', csv('jobs', [[units[1].name, title, '']]), manager.auth), (error: any) => error.status === 400);
  await db.query('DELETE FROM user_units WHERE user_id=$1', [manager.id]);
  await assert.rejects(apply('jobs', value, manager.auth), (error: any) => error.status === 403);
  await db.query('DELETE FROM sessions WHERE token_hash=$1', [otherAdmin.auth.hash]);
  await assert.rejects(preview('jobs', source, otherAdmin.auth), (error: any) => error.status === 401);
  await assert.rejects(previewWorkforceImport(db, owner.actor, undefined, 'jobs', { csv: source }), (error: any) => error.status === 401);
  assert.equal((await db.query('SELECT id FROM jobs WHERE title=$1', [title])).rows.length, 0);
});

test('failed final audit and expired final session roll back the entire job batch and preserve a retryable preview', async () => {
  const title = 'Rollback ' + randomUUID(), value = await preview('jobs', csv('jobs', [[units[0].name, title, ''], [units[0].name, title + ' two', '']]));
  for (const mode of ['audit', 'session', 'expiry']) {
    let wrote = false;
    const wrapped: Database = { ...db, transaction: async <T>(work: (tx: Queryable) => Promise<T>) => db.transaction(tx => work({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith('INSERT INTO jobs')) wrote = true;
      if (mode === 'expiry' && wrote && sql.includes("created_at+interval '24 hours'>clock_timestamp()")) return { rows: [] };
      if (sql.startsWith('INSERT INTO audit_events') && params?.[3] === 'workforce.import_applied') {
        if (mode === 'audit') throw Error('Synthetic final audit failure');
        if (mode === 'session') await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [owner.hash]);
      }
      return tx.query<R>(sql, params);
    } })) };
    await assert.rejects(apply('jobs', value, owner, wrapped), (error: any) => mode === 'audit' ? /Synthetic final audit failure/.test(error.message) : error.status === (mode === 'session' ? 401 : 409));
    assert.equal((await db.query('SELECT id FROM jobs WHERE title LIKE $1', [title + '%'])).rows.length, 0);
    assert.equal((await db.query('SELECT receipt FROM workforce_import_batches WHERE id=$1', [value.id])).rows[0].receipt, null);
  }
  assert.equal((await apply('jobs', value)).created, 2);
});

test('isolated XLSX catalogs provide blank text templates and preserve source fingerprints through conversion and preview', async () => {
  for (const kind of ['jobs', 'schedules'] as const) {
    const template = await downloadImportWorkbookTemplate(db, owner.actor, owner.hash, { kind });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(template.buffer as any); const sheet = workbook.worksheets[0];
    assert.deepEqual((sheet.getRow(1).values as string[]).slice(1), [...workforceImportColumns[kind]]);
    assert.equal(sheet.getRow(2).getCell(1).value, null); assert.equal(sheet.getRow(2).getCell(1).numFmt, '@');
    const duty = await job(), person = await staff('employee', duty.id);
    const row = kind === 'jobs' ? [units[0].name, 'Workbook job ' + randomUUID(), 'Text notes'] : [person.email, units[0].name, duty.title, '2026-10-25T08:00:00-04:00', '2026-10-25T10:00:00-04:00', 'Text times'];
    sheet.getRow(2).values = row; const base64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
    const inspected = await inspectImportWorkbook(db, owner.actor, owner.hash, { kind, base64 });
    const converted = await convertImportWorkbook(db, owner.actor, owner.hash, { kind, base64, sheetId: inspected.sheets[0].sheetId, headerRow: 1, expectedWorkbookHash: inspected.workbookHash });
    assert.equal(converted.rowCount, 1); assert.equal(converted.csvHash, digest(converted.csv));
    assert.equal((await preview(kind, converted.csv)).rows.length, 1);
    await assert.rejects(convertImportWorkbook(db, owner.actor, owner.hash, { kind, base64, sheetId: inspected.sheets[0].sheetId, headerRow: 1, expectedWorkbookHash: '0'.repeat(64) }), (error: any) => error.status === 409);
    sheet.getCell('A2').value = { formula: '1+1', result: 2 };
    await assert.rejects(inspectImportWorkbook(db, owner.actor, owner.hash, { kind, base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') }), (error: any) => [400, 422].includes(error.status));
  }
});
