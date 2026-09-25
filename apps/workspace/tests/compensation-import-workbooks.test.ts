import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { inspectImportWorkbook, convertImportWorkbook, downloadImportWorkbookTemplate } from '../server/import-workbooks';
import { compensationCsvColumns } from '../shared/compensation';

const origin = 'http://localhost:3000', password = 'Synthetic-pay-workbook-' + randomUUID();
type Auth = { actor: Actor; cookie: string; csrf: string; hash: string };
let db: Database, app: ReturnType<typeof createApp>, owner: Auth, finance: Auth, admin: Auth, manager: Auth, employee: Auth, unitId: string, jobId: string;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scope = (userId: string) => ({ kind: 'compensation_rates' as const, userId, jobId });
const pairQuery = (userId: string) => `userId=${userId}&jobId=${jobId}`;
async function authenticated(headers: unknown): Promise<Auth> {
  assert.ok(Array.isArray(headers)); const cookie = String(headers[0]).split(';')[0];
  const me = await request(app).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
const send = (who: Auth, path: string, body: object, method: 'post' | 'patch' = 'post') => request(app)[method](path).set('Origin', origin).set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf).send(body);
async function ok(who: Auth, path: string, body: object, method: 'post' | 'patch' = 'post') { const response = await send(who, path, body, method); assert.ok(response.status < 300, `Expected success for ${path}; got ${response.status}`); return response.body; }
async function provision(role: 'employee' | 'finance' | 'admin' | 'manager' = 'employee') {
  const input = { name: 'Synthetic pay workbook ' + role, email: randomUUID() + '@example.test', role, unitIds: [unitId], jobIds: [jobId] };
  const created = await ok(owner, '/api/staff', input), token = new URL(created.setupUrl).hash.slice(7);
  const setup = await request(app).post('/api/auth/setup').set('Origin', origin).send({ token, password }); assert.equal(setup.status, 200);
  return { auth: await authenticated(setup.headers['set-cookie']), input };
}
async function current(userId: string) { const response = await request(app).get('/api/compensation/record?' + pairQuery(userId)).set('Cookie', owner.cookie); assert.equal(response.status, 200); return response.body; }
async function changeRates(userId: string, rates: object[]) {
  const record = await current(userId), input = { userId, jobId, expectedVersion: record.schedule?.version ?? 0, rates, reason: 'Explicit synthetic pay template source change' };
  const preview = await ok(owner, '/api/compensation/preview', input);
  return ok(owner, '/api/compensation/save', { ...input, previewHash: preview.previewHash, reviewed: true, commandId: randomUUID() });
}
const rate = (note = '=Literal synthetic pay note') => ({ id: randomUUID(), startsOn: '2026-01-01', endsOn: null, amount: '10.25', currency: 'USD', basis: 'hour', voided: false, note });
async function upload(userId: string, value: string | number = '10.25') {
  const template = await downloadImportWorkbookTemplate(db, owner.actor, owner.hash, scope(userId)), book = new ExcelJS.Workbook();
  await book.xlsx.load(template.buffer as any); const sheet = book.worksheets[0];
  sheet.getCell('E2').value = '2026-01-01'; sheet.getCell('G2').value = value; sheet.getCell('H2').value = 'USD'; sheet.getCell('I2').value = 'hour'; sheet.getCell('K2').value = '=Literal synthetic pay note';
  const bytes = Buffer.from(await book.xlsx.writeBuffer()); return { ...scope(userId), base64: bytes.toString('base64'), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(bytes) };
}
function wrapped(beforeFinal?: () => Promise<void>, afterQuery?: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  let transactions = 0; return { ...db, transaction: async action => {
    if (++transactions === 2 && beforeFinal) await beforeFinal();
    return db.transaction(tx => action({ query: async<T extends Row>(sql: string, params: any[] = []) => {
      const result = await tx.query<T>(sql, params); if (afterQuery) await afterQuery(tx, sql, params); return result;
    } }));
  } };
}
async function counts() { return (await db.query("SELECT (SELECT count(*) FROM compensation_schedules) AS records,(SELECT count(*) FROM compensation_history) AS history,(SELECT count(*) FROM compensation_commands) AS commands")).rows; }
async function auditCount(action: string) { return Number((await db.query('SELECT count(*) AS n FROM audit_events WHERE action=$1', [action])).rows[0].n); }
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'pay.workbook.owner@example.test' });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: 'example.test' });
  const person = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, person as { id: string; org_id: string }));
  const setup = await request(app).post('/api/auth/setup').set('Origin', origin).send({ token, password }); assert.equal(setup.status, 200); owner = await authenticated(setup.headers['set-cookie']);
  const me = await request(app).get('/api/me').set('Cookie', owner.cookie); unitId = me.body.units[0].id;
  jobId = (await ok(owner, '/api/jobs', { unitId, title: 'Synthetic pay workbook job' })).id;
  finance = (await provision('finance')).auth; admin = (await provision('admin')).auth; manager = (await provision('manager')).auth; employee = (await provision()).auth;
});
after(async () => { await db?.close(); });

test('pay template starter has no invented amounts and current financial roles alone can download it', async () => {
  for (const who of [owner, finance, admin]) {
    const template = await downloadImportWorkbookTemplate(db, who.actor, who.hash, scope(employee.actor.id)), book = new ExcelJS.Workbook(); await book.xlsx.load(template.buffer as any);
    const values = book.worksheets[0].getRow(2).values; assert.ok(Array.isArray(values));
    assert.equal(values[1], employee.actor.id); assert.equal(values[2], jobId); assert.equal(values[3], '0');
    for (const address of ['D2', 'E2', 'F2', 'G2', 'H2', 'I2', 'K2']) assert.ok([null, ''].includes(book.worksheets[0].getCell(address).value as any));
    assert.equal(book.worksheets[0].getCell('J2').value, 'false');
  }
  for (const who of [manager, employee]) await assert.rejects(downloadImportWorkbookTemplate(db, { ...who.actor, role: 'owner' }, who.hash, scope(employee.actor.id)), (e: any) => e.status === 403);
  for (const hash of [undefined, 'f'.repeat(64), owner.hash]) await assert.rejects(downloadImportWorkbookTemplate(db, finance.actor, hash, scope(employee.actor.id)), (e: any) => e.status === 401);
  const response = await request(app).get('/api/import-workbooks/template?kind=compensation_rates&' + pairQuery(employee.actor.id)).set('Cookie', finance.cookie);
  assert.equal(response.status, 200); assert.match(response.headers['content-disposition'], /stjw-editable-pay-template.xlsx/); assert.match(response.headers['cache-control'], /private, no-store/);
});

test('converted pay text requires existing business preview and explicit save; exact CSV is retained', async () => {
  const input = await upload(employee.actor.id), before = await counts();
  const inspected = await inspectImportWorkbook(db, finance.actor, finance.hash, { ...scope(employee.actor.id), base64: input.base64, sheetId: 1 }); assert.equal(inspected.samples.length, 2);
  const converted = await convertImportWorkbook(db, finance.actor, finance.hash, input); assert.deepEqual(await counts(), before);
  const preview = await ok(finance, '/api/compensation/import-preview', { userId: employee.actor.id, jobId, expectedVersion: 0, reason: 'Review synthetic pay workbook', csv: converted.csv });
  assert.deepEqual(await counts(), before); const body = { ...preview.input, previewHash: preview.data.previewHash, commandId: randomUUID(), reviewed: true };
  const saved = await ok(finance, '/api/compensation/save', body); assert.equal(saved.version, 1); assert.deepEqual(await ok(finance, '/api/compensation/save', body), saved);
  const source = await request(app).get('/api/compensation/history-source?' + pairQuery(employee.actor.id) + '&version=1').set('Cookie', finance.cookie);
  assert.equal(source.status, 200); assert.equal(source.text, converted.csv);
  const event = (await db.query("SELECT detail FROM audit_events WHERE action='import.workbook_converted' ORDER BY created_at DESC LIMIT 1")).rows[0].detail;
  assert.equal(event.kind, 'compensation_rates'); assert.equal(event.userId, employee.actor.id); assert.ok(!JSON.stringify(event).includes('Literal synthetic pay note'));
  assert.equal((await send(finance, '/api/compensation/import-preview', { userId: employee.actor.id, jobId, expectedVersion: 1, reason: 'Stale imported version rejected', csv: converted.csv })).status, 409);
});

test('historical pay templates retain voided entries and remain readable after target deactivation', async () => {
  const person = await provision(), values = [rate(), { ...rate('Historical voided rate'), voided: true }]; await changeRates(person.auth.actor.id, values);
  await ok(owner, '/api/staff/' + person.auth.actor.id, { ...person.input, expectedRevision: await testStaffRevision(db,person.auth.actor.id), active: false, jobIds: [] }, 'patch');
  const template = await downloadImportWorkbookTemplate(db, finance.actor, finance.hash, scope(person.auth.actor.id));
  const result = await convertImportWorkbook(db, finance.actor, finance.hash, { ...scope(person.auth.actor.id), base64: template.buffer.toString('base64'), sheetId: 1, headerRow: 1, expectedWorkbookHash: template.hash });
  const rows = parse(result.csv, { bom: true, columns: true }) as Record<string, string>[]; assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.rateId).sort(), values.map(r => r.id).sort()); assert.equal(rows.find(r => r.rateId === values[1].id)?.voided, 'true');
  for (const value of values) assert.equal(rows.find(row => row.rateId === value.id)?.note, value.note);
  const unchanged = await send(finance, '/api/compensation/import-preview', { userId: person.auth.actor.id, jobId, expectedVersion: 1, reason: 'No fabricated change', csv: result.csv }); assert.equal(unchanged.status, 400);
});

test('pay templates reject source and captured identity changes during the unlocked worker window', async () => {
  for (const kind of ['record', 'identity'] as const) {
    const person = await provision(), before = await auditCount('import.workbook_template_downloaded');
    const gated = wrapped(async () => { if (kind === 'record') await changeRates(person.auth.actor.id, [rate()]); else await ok(owner, '/api/staff/' + person.auth.actor.id, { ...person.input, expectedRevision: await testStaffRevision(db,person.auth.actor.id), name: 'Changed captured synthetic identity', active: true }, 'patch'); });
    await assert.rejects(downloadImportWorkbookTemplate(gated, finance.actor, finance.hash, scope(person.auth.actor.id)), (e: any) => e.status === 409);
    assert.equal(await auditCount('import.workbook_template_downloaded'), before);
  }
});

test('logout after worker completion denies both converted pay data and private coordinate errors', async () => {
  for (const invalid of [false, true]) {
    const person = await provision('finance'), input = await upload(employee.actor.id, invalid ? 12.5 : '12.50'), before = await auditCount('import.workbook_converted');
    const gated = wrapped(async () => { assert.equal((await send(person.auth, '/api/auth/logout', {})).status, 200); });
    await assert.rejects(convertImportWorkbook(gated, person.auth.actor, person.auth.hash, input), (e: any) => e.status === 401);
    assert.equal(await auditCount('import.workbook_converted'), before);
  }
});

test('pay workbook publication rolls back its audit on an actual database failure', async () => {
  const input = await upload(employee.actor.id, '14.25'), before = await auditCount('import.workbook_converted');
  const gated = wrapped(undefined, async (tx, sql, params) => { if (sql.startsWith('INSERT INTO audit_events') && params.includes('import.workbook_converted')) await tx.query('SELECT 1/0'); });
  await assert.rejects(convertImportWorkbook(gated, finance.actor, finance.hash, input)); assert.equal(await auditCount('import.workbook_converted'), before);
});

test('oversized complete pay records reject XLSX generation instead of omitting retained entries', async () => {
  const person = await provision(), rates = Array.from({ length: 70 }, () => ({ ...rate('é'.repeat(500)), voided: true })); await changeRates(person.auth.actor.id, rates);
  const before = await current(person.auth.actor.id);
  await assert.rejects(downloadImportWorkbookTemplate(db, finance.actor, finance.hash, scope(person.auth.actor.id)), (e: any) => e.status === 413);
  assert.deepEqual(await current(person.auth.actor.id), before);
  const file = await upload(employee.actor.id); file.userId = person.auth.actor.id;
  // An oversized retained schedule does not prevent structural inspection of an uploaded file.
  assert.equal((await inspectImportWorkbook(db, finance.actor, finance.hash, { ...scope(person.auth.actor.id), base64: file.base64 })).workbookHash, file.expectedWorkbookHash);
});
