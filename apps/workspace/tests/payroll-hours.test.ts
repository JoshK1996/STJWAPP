import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { parse as parseCsv } from 'csv-parse/sync';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { aggregateSegmentsV2 } from '../server/reports-v2';
import { getAuthorizedPayrollHours, exportAuthorizedPayrollHours, payrollHoursCsv } from '../server/payroll-hours';
import { buildPayrollHoursReport, payrollDecimalHours, payrollHoursReportSchema, payrollHoursLimits } from '../shared/payroll-hours';
import { workforceInstantMicroseconds, workforceUtcFromMicroseconds, type WorkforceSourceRowV2 } from '../shared/workforce-reports-v2';
import { serializePayrollHoursXlsx, payrollHoursNumeric } from '../server/payroll-hours-xlsx';
import { generatePayrollHoursXlsx } from '../server/payroll-hours-xlsx-runtime';
import { withSpreadsheetSlot } from '../server/spreadsheet-admission';

const query = { start: '2026-09-20', end: '2026-09-20', group: 'day' as const };
const asOf = '2026-09-21T00:00:00.000000Z', base = '2026-09-20T14:00:00.000000Z';
const userId = randomUUID(), jobId = randomUUID(), unitId = randomUUID(), shiftId = randomUUID();
function segment(micros = 1000n, changes: Partial<WorkforceSourceRowV2> = {}): WorkforceSourceRowV2 {
  return { id: randomUUID(), shift_id: shiftId, revision: 1, user_id: userId, employee_name: 'Synthetic 😀 café', job_id: jobId,
    job_title: '=Synthetic job', unit_id: unitId, unit_name: 'Synthetic unit', kind: 'work', started_at: base,
    ended_at: workforceUtcFromMicroseconds(workforceInstantMicroseconds(base) + micros), ...changes };
}
const pure = (rows = [segment(), segment()]) => buildPayrollHoursReport(aggregateSegmentsV2(rows, query, 'UTC', asOf));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// All authority proofs are issued by normal local API setup/login. Exact segment
// SQL below is synthetic precision source data, never a fabricated session.
let db: Database, owner: Actor, ownerAuth: Auth, units: string[], jobs: string[], target: Person;
const origin = 'http://localhost:3199';
type Auth = { cookie: string; csrf: string; hash: string };
type Person = { id: string; email: string; password: string; role: Actor['role']; units: string[] };
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
async function send(path: string, body: unknown, auth = ownerAuth, method = 'post', database = db) {
  const response = await (request(app(database)) as any)[method]('/api' + path).set('Origin', origin).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body);
  assert.ok(response.status < 300, 'Synthetic normal API mutation failed'); return response.body;
}
async function login(person: Pick<Person, 'email' | 'password'>, database = db): Promise<Auth> {
  const response = await request(app(database)).post('/api/auth/login').set('Origin', origin).send({ mode: 'password', email: person.email, credential: person.password });
  assert.equal(response.status, 200); const cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me = await request(app(database)).get('/api/me').set('Cookie', cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf('=') + 1)) };
}
async function person(role: Actor['role'] = 'admin', assigned = units): Promise<Person> {
  const email = randomUUID() + '@stjw.org', password = 'Synthetic-' + randomUUID();
  const response = await send('/staff', { name: 'Synthetic payroll staff', email, role, unitIds: assigned, jobIds: [] });
  const setup = await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token: new URL(response.setupUrl).hash.slice(7), password }); assert.equal(setup.status, 200);
  return { id: response.id, email, password, role, units: assigned };
}
const actor = (person: Person): Actor => ({ ...owner, id: person.id, email: person.email, role: person.role, unit_ids: person.units });
const proof = (auth: Auth) => ({ mode: 'password' as const, hash: auth.hash });
async function change(person: Person, changes: Record<string, unknown>) {
  await send('/staff/' + person.id, { name: 'Synthetic payroll staff', email: person.email, role: person.role, active: true, unitIds: person.units, jobIds: [], ...changes }, ownerAuth, 'patch');
}
function probe(effect: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  return { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params); await effect(tx, sql, params); return result;
  } })) };
}
const auditCount = async (id: string) => Number((await db.query("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action='payroll.hours_exported'", [id])).rows[0].n);
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'payroll.hours.owner@example.test' });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, mode: 'password', unit_ids: [] };
  const password = 'Synthetic-' + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  ownerAuth = await login({ email: owner.email, password });
  const found = (await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2')).rows; jobs = found.map(r => r.id); units = found.map(r => r.unit_id);
  assert.notEqual(units[0], units[1]); target = await person('employee');
  const shift = randomUUID();
  await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-09-20T14:00:00.000001Z','2026-09-20T14:00:00.002002Z')", [shift, owner.org_id, target.id]);
  for (let index = 0; index < 2; index++) await db.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), owner.org_id, shift, jobs[index], index ? 'break' : 'work', index ? '2026-09-20T14:00:00.001001Z' : '2026-09-20T14:00:00.000001Z', index ? '2026-09-20T14:00:00.002002Z' : '2026-09-20T14:00:00.001001Z']);
});
after(async () => { await db?.close(); });

test('exact aggregation precedes decimal rounding and distinct shift counts span jobs', () => {
  const other = randomUUID(), value = pure([segment(), segment(), segment(1000n, { kind: 'break', job_id: other, job_title: 'Other' }), segment(0n)]);
  assert.equal(value.totals.workMicroseconds, '2000'); assert.equal(value.totals.workHours, '0.000001');
  assert.equal(value.totals.breakHours, '0.000000'); assert.equal(value.totals.totalHours, '0.000001');
  assert.equal(value.totals.shiftCount, 1); assert.equal(value.totals.segmentCount, 4); assert.equal(value.employees[0].jobs.length, 2);
  assert.equal(payrollDecimalHours(1799n), '0.000000'); assert.equal(payrollDecimalHours(1800n), '0.000001');
  assert.equal(payrollDecimalHours(3_600_000_000n), '1.000000');
});
test('multiple annual sources aggregate beyond Number safe integer without loss', () => {
  const rows = Array.from({ length: 400 }, () => segment(0n, { shift_id: randomUUID(), started_at: '2026-01-01T00:00:00.000001Z', ended_at: '2027-01-01T00:00:00.000000Z' }));
  const value = buildPayrollHoursReport(aggregateSegmentsV2(rows, { start: '2026-01-01', end: '2026-12-31' }, 'UTC', '2027-01-02T00:00:00.000000Z'));
  const expected = (365n * 86_400_000_000n - 1n) * 400n;
  assert.ok(expected > BigInt(Number.MAX_SAFE_INTEGER)); assert.equal(value.totals.workMicroseconds, String(expected)); assert.equal(value.totals.shiftCount, 400);
});
test('open zero-contribution and clipped DST sources remain explicit without closed-shift claims', () => {
  const value = buildPayrollHoursReport(aggregateSegmentsV2([segment(0n, { ended_at: null })], query, 'UTC', base));
  assert.equal(value.totals.workMicroseconds, '0'); assert.equal(value.totals.ongoingSegmentCount, 1); assert.equal(value.totals.employeeCount, 1);
  assert.equal(value.report.rows[0].recorded_duration_microseconds, null);
  const dst = buildPayrollHoursReport(aggregateSegmentsV2([segment(0n, { started_at: '2026-11-01T04:00:00.000000Z', ended_at: '2026-11-02T05:00:00.000000Z' })],
    { start: '2026-11-01', end: '2026-11-01' }, 'America/New_York', '2026-11-03T00:00:00.000000Z'));
  assert.equal(dst.totals.workHours, '25.000000'); assert.match(dst.notice, /not calculated or certified payroll/);
});
test('strict version/unknown fields and inconsistent or duplicate source summaries reject', () => {
  const value = pure(); assert.equal(payrollHoursReportSchema.safeParse({ ...value, schemaVersion: 2 }).success, false);
  assert.equal(payrollHoursReportSchema.safeParse({ ...value, grossPay: 1 }).success, false);
  assert.throws(() => buildPayrollHoursReport({ ...value.report, workMicroseconds: '1' }));
  assert.throws(() => buildPayrollHoursReport({ ...value.report, rows: [value.report.rows[0], value.report.rows[0]] }));
});
test('CSV formula protection and empty-report provenance are explicit', () => {
  const csv = payrollHoursCsv(pure()); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /"'=Synthetic job"/);
  assert.match(csv, /"employee"/); assert.match(csv, /"job"/); assert.match(csv, /"total"/); assert.ok(csv.includes('Exact microseconds'));
  const empty = payrollHoursCsv(pure([])); assert.equal(empty.split('\r\n').length, 2); assert.ok(empty.includes(asOf)); assert.ok(empty.includes('"0.000000"'));
});

function xmlCells(xml: string) {
  const found = new Map<string, { type: string; text: string }>(); let ref = '', type = '', text = '', inside = false;
  const parser = new SaxesParser();
  parser.on('opentag', node => { if (node.name === 'c') { ref = String(node.attributes.r); type = String(node.attributes.t ?? ''); text = ''; } if (['t', 'v'].includes(node.name)) inside = true; });
  parser.on('text', chunk => { if (inside) text += chunk; });
  parser.on('closetag', node => { if (['t', 'v'].includes(node.name)) inside = false; if (node.name === 'c') found.set(ref, { type, text }); });
  parser.write(xml).close(); return found;
}
async function inspect(bytes: Buffer, payload: string) {
  const zip = await JSZip.loadAsync(bytes), names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  assert.equal(names.filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 6);
  assert.ok(!names.some(name => /vba|externalLink|sharedStrings/i.test(name)));
  for (const name of names.filter(name => /\.(xml|rels)$/.test(name))) {
    const xml = await zip.file(name)!.async('string'); new SaxesParser().write(xml).close(); assert.doesNotMatch(xml, /<f(?:\s|>)|<hyperlink\b|TargetMode="External"|<!DOCTYPE/);
  }
  const source = xmlCells(await zip.file('xl/worksheets/sheet6.xml')!.async('string'));
  const reconstructed = [...source].filter(([ref]) => /^B\d+$/.test(ref) && Number(ref.slice(1)) > 1).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))).map(([, value]) => value.text).join('');
  assert.equal(reconstructed, payload);
  const metadata = xmlCells(await zip.file('xl/worksheets/sheet5.xml')!.async('string')); assert.ok([...metadata.values()].some(cell => cell.text === hash(payload)));
  for (const name of names.filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
    const cells = xmlCells(await zip.file(name)!.async('string'));
    const numericColumns = new Set([...cells].filter(([ref, cell]) => /^[A-Z]+1$/.test(ref) && ['workHoursNumeric', 'breakHoursNumeric', 'totalHoursNumeric'].includes(cell.text)).map(([ref]) => ref.replace(/1$/, '')));
    for (const [ref, cell] of cells) {
      if (Number(ref.replace(/^[A-Z]+/, '')) > 1 && numericColumns.has(ref.replace(/\d+$/, ''))) { assert.ok(['n', ''].includes(cell.type)); assert.ok(Number.isFinite(Number(cell.text))); }
      else assert.ok(['str', 'inlineStr'].includes(cell.type));
    }
  }
  const sourceRows = xmlCells(await zip.file('xl/worksheets/sheet4.xml')!.async('string')); return { zip, sourceRows };
}
test('actual empty-env worker retains exact text/JSON/UTC6 with numeric companions in six sheets', async () => {
  const payload = JSON.stringify(pure([segment(123456n)])) + '\n', result = await generatePayrollHoursXlsx(payload);
  assert.equal(hash(result.buffer), result.hash); assert.equal(result.bytes, result.buffer.length);
  const output = await inspect(result.buffer, payload); assert.equal(output.sourceRows.get('K2')!.text, base); assert.equal(output.sourceRows.get('P2')!.text, '123456');
  await inspect((await generatePayrollHoursXlsx(JSON.stringify(pure([])))).buffer, JSON.stringify(pure([])));
});
test('numeric hours are usable number cells only in named companions and reject unsafe/nonfinite input', async () => {
  assert.equal(payrollHoursNumeric('0.000000'), 0); assert.equal(payrollHoursNumeric('1.250000'), 1.25);
  assert.equal(payrollHoursNumeric('999999999.999999'), 999999999.999999);
  for (const invalid of ['1000000000.000000', '9007199254740993.000000', 'Infinity', 'NaN', '-0.000000', '1e2', '01.000000', '1.25', '=1.250000']) assert.throws(() => payrollHoursNumeric(invalid));
  const value = pure([segment(3_600_000_000n), segment(900_000_000n, { kind: 'break' })]), payload = JSON.stringify(value);
  const { zip } = await inspect((await generatePayrollHoursXlsx(payload)).buffer, payload);
  for (const [sheet, columns] of [['1', ['L2', 'M2', 'N2']], ['2', ['P2', 'Q2', 'R2']], ['3', ['K2', 'L2', 'M2']]] as const) {
    const cells = xmlCells(await zip.file('xl/worksheets/sheet' + sheet + '.xml')!.async('string'));
    assert.deepEqual(columns.map(ref => Number(cells.get(ref)!.text)), [1, 0.25, 1.25]);
    assert.ok(columns.every(ref => ['', 'n'].includes(cells.get(ref)!.type)));
  }
  const jobs = xmlCells(await zip.file('xl/worksheets/sheet2.xml')!.async('string'));
  assert.equal(jobs.get('D2')!.text, '=Synthetic job'); assert.ok(['str', 'inlineStr'].includes(jobs.get('D2')!.type));
  assert.equal(jobs.get('G2')!.text, '1.000000'); assert.equal(jobs.get('J2')!.text, '3600000000');
  const provenance = await zip.file('xl/worksheets/sheet5.xml')!.async('string'); assert.match(provenance, /approximate spreadsheet companions/); assert.match(provenance, /not authoritative/);
});
test('workbook unsupported text, changed derived totals, caps, timeout and cancellation fail without silently changing data', async () => {
  for (const name of ['a\rb', 'a\u0000b', '_x0041_', '_X00aF_', '\ud800']) {
    const payload = JSON.stringify(pure([segment(1n, { employee_name: name })]));
    await assert.rejects(serializePayrollHoursXlsx(payload), (error: any) => error.code === 'unsupported');
  }
  const value = pure(); value.totals.workMicroseconds = '999'; await assert.rejects(serializePayrollHoursXlsx(JSON.stringify(value)), (e: any) => e.code === 'invalid');
  const payload = JSON.stringify(pure());
  await assert.rejects(generatePayrollHoursXlsx(payload, { maxBytes: 100 }), (e: any) => e.status === 422);
  await assert.rejects(generatePayrollHoursXlsx(' '.repeat(payrollHoursLimits.inputBytes + 1)), (e: any) => e.status === 413);
  await assert.rejects(generatePayrollHoursXlsx(payload, { deadlineMs: 1 }), (e: any) => e.status === 503);
  const controller = new AbortController(), pending = generatePayrollHoursXlsx(payload, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (e: any) => e.status === 499); assert.ok((await generatePayrollHoursXlsx(payload)).bytes > 100);
});
test('normal-auth owner summary and all exports retain exact source; audit never stores private rows', async () => {
  const result = await getAuthorizedPayrollHours(db, owner, proof(ownerAuth), query);
  assert.equal(result.totals.workMicroseconds, '1000'); assert.equal(result.totals.breakMicroseconds, '1001'); assert.equal(result.totals.shiftCount, 1);
  assert.equal(result.employees[0].jobs.length, 2); assert.equal(result.report.rows[0].started_at, '2026-09-20T14:00:00.000001Z');
  const before = await auditCount(owner.id);
  for (const format of ['csv', 'json', 'xlsx'] as const) {
    const output = await exportAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, format }); assert.equal(output.format, format);
    if (format === 'json') assert.equal(JSON.parse(output.body as string).totals.totalMicroseconds, '2001');
    if (format === 'xlsx') assert.ok(Buffer.isBuffer(output.body));
  }
  assert.equal(await auditCount(owner.id), before + 3);
  const evidence = (await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='payroll.hours_exported'", [owner.id])).rows;
  for (const row of evidence) { assert.equal(row.detail.rows, undefined); assert.equal(row.detail.employees, undefined); assert.equal(row.detail.sourceRowCount, 2); }
});
test('current manager explicit units/filtering and current reporting role are enforced', async () => {
  const manager = await person('manager', [units[0]]); let auth = await login(manager);
  assert.equal((await getAuthorizedPayrollHours(db, actor(manager), proof(auth), query)).totals.totalMicroseconds, '1000');
  const ownShift = randomUUID();
  await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-09-19T14:00:00Z','2026-09-19T14:00:00.000003Z')", [ownShift, owner.org_id, manager.id]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work','2026-09-19T14:00:00Z','2026-09-19T14:00:00.000003Z')", [randomUUID(), owner.org_id, ownShift, jobs[1]]);
  const own = await getAuthorizedPayrollHours(db, actor(manager), proof(auth), { ...query, start: '2026-09-19', end: '2026-09-19' });
  assert.equal(own.totals.workMicroseconds, '3'); assert.equal(own.employees[0].userId, manager.id);
  assert.equal((await getAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, userId: target.id, unitId: units[1] })).totals.breakMicroseconds, '1001');
  await change(manager, { unitIds: [units[1]] });
  await assert.rejects(getAuthorizedPayrollHours(db, actor(manager), proof(auth), query), (e: any) => e.status === 401);
  auth = await login(manager);
  assert.equal((await getAuthorizedPayrollHours(db, actor(manager), proof(auth), query)).totals.totalMicroseconds, '1001');
  await change(manager, { role: 'employee' });
  auth = await login(manager);
  for (const format of ['csv', 'json', 'xlsx']) await assert.rejects(exportAuthorizedPayrollHours(db, actor(manager), proof(auth), { ...query, format }), (e: any) => e.status === 403);
  await assert.rejects(getAuthorizedPayrollHours(db, actor(target), proof(await login(target)), query), (e: any) => e.status === 403);
});
test('ordinary logout revokes a cached actor/proof; PIN mode and missing actual proof deny', async () => {
  const reader = await person(), auth = await login(reader); await send('/auth/logout', {}, auth);
  for (const format of ['csv', 'json', 'xlsx']) await assert.rejects(exportAuthorizedPayrollHours(db, actor(reader), proof(auth), { ...query, format }), (e: any) => e.status === 401);
  await assert.rejects(getAuthorizedPayrollHours(db, owner, { mode: 'password', hash: undefined }, query), (e: any) => e.status === 401);
  await assert.rejects(getAuthorizedPayrollHours(db, { ...owner, mode: 'pin' }, proof(ownerAuth), query), (e: any) => e.status === 401);
  assert.equal(await auditCount(reader.id), 0);
});
test('normal-issued bearer requires current reports scope and revocation proof', async () => {
  const allowed = await send('/tokens', { name: 'Synthetic payroll report', scopes: ['reports:read'], days: 1 });
  const apiActor = { ...owner, mode: 'api' as const, scopes: ['reports:read'] }, apiProof = { mode: 'api' as const, hash: digest(allowed.token) };
  assert.equal((await getAuthorizedPayrollHours(db, apiActor, apiProof, query)).totals.totalMicroseconds, '2001');
  await send('/tokens/' + allowed.id + '/revoke', {});
  await assert.rejects(exportAuthorizedPayrollHours(db, apiActor, apiProof, { ...query, format: 'csv' }), (e: any) => e.status === 403);
  const denied = await send('/tokens', { name: 'Synthetic staff only', scopes: ['staff:read'], days: 1 });
  await assert.rejects(getAuthorizedPayrollHours(db, apiActor, { mode: 'api', hash: digest(denied.token) }, query), (e: any) => e.status === 403);
});
test('actual post-audit SQL error rolls back and the same export later succeeds', async () => {
  const reader = await person(), auth = await login(reader); let fired = false;
  const database = probe(async (tx, sql, params) => { if (sql.startsWith('INSERT INTO audit_events') && params[3] === 'payroll.hours_exported') { fired = true; await tx.query('SELECT 1/0'); } });
  await assert.rejects(exportAuthorizedPayrollHours(database, actor(reader), proof(auth), { ...query, format: 'xlsx' }));
  assert.equal(fired, true); assert.equal(await auditCount(reader.id), 0);
  await exportAuthorizedPayrollHours(db, actor(reader), proof(auth), { ...query, format: 'csv' }); assert.equal(await auditCount(reader.id), 1);
});
test('accelerated original normal-session INSERT expires after audit and rolls back publication', async () => {
  const reader = await person(); let creation = false;
  // Only original authenticated INSERT input is shortened; existing proof rows
  // are never edited. This is a labeled accelerated local clock fixture.
  const loginDb: Database = { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    if (sql.startsWith('INSERT INTO sessions') && params?.[2] === reader.id) { creation = true; const next = [...params]; next[5] = new Date(Date.now() + 1500); return tx.query<R>(sql, next); }
    return tx.query<R>(sql, params);
  } })) };
  const auth = await login(reader, loginDb); assert.equal(creation, true); let fired = false;
  const database = probe(async (_tx, sql, params) => { if (sql.startsWith('INSERT INTO audit_events') && params[3] === 'payroll.hours_exported') { fired = true; await new Promise(resolve => setTimeout(resolve, 1600)); } });
  await assert.rejects(exportAuthorizedPayrollHours(database, actor(reader), proof(auth), { ...query, format: 'json' }), (e: any) => e.status === 401);
  assert.equal(fired, true); assert.equal(await auditCount(reader.id), 0);
});
test('shared spreadsheet admission spans authorization/generation and releases on denied or cancelled work', async () => {
  await withSpreadsheetSlot('other-synthetic-workbook', async () => {
    await assert.rejects(exportAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, format: 'xlsx' }), (e: any) => e.status === 429);
  });
  const before = await auditCount(owner.id), controller = new AbortController(); controller.abort();
  await assert.rejects(exportAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, format: 'xlsx' }, { signal: controller.signal }), (e: any) => e.status === 499);
  assert.equal(await auditCount(owner.id), before);
  assert.ok(Buffer.isBuffer((await exportAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, format: 'xlsx' })).body));
});
test('repeatable-read is first, input is privately parsed, and unsupported filters never run a report', async () => {
  const input = { ...query }, statements: string[] = [];
  const database = probe(async (_tx, sql) => { statements.push(sql); if (sql.includes('ISOLATION LEVEL')) input.start = 'invalid-after-parse'; });
  const value = await getAuthorizedPayrollHours(database, owner, proof(ownerAuth), input);
  assert.equal(statements[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); assert.equal(value.report.query.start, query.start);
  assert.throws(() => getAuthorizedPayrollHours(db, owner, proof(ownerAuth), { ...query, payRate: 'yes' }));
});
test('installed HTTP routes publish private typed downloads and deny committed post-middleware logout', async () => {
  const suffix = new URLSearchParams(query).toString(), summaryPath = '/api/payroll/hours?' + suffix;
  const summary = await request(app()).get(summaryPath).set('Cookie', ownerAuth.cookie);
  assert.equal(summary.status, 200); assert.equal(summary.body.totals.totalMicroseconds, '2001'); assert.match(summary.headers['cache-control'], /no-store/);
  for (const format of ['csv', 'json', 'xlsx']) {
    const response = await request(app()).get('/api/payroll/hours/export?' + suffix + '&format=' + format).set('Cookie', ownerAuth.cookie);
    assert.equal(response.status, 200); assert.match(response.headers['cache-control'], /private.*no-store/);
    assert.ok(response.headers['content-disposition'].includes('.' + format)); assert.match(response.headers['x-stjw-report-as-of'], /\.\d{6}Z$/);
    assert.ok(response.headers['content-type'].includes(format === 'xlsx' ? 'spreadsheetml' : format === 'csv' ? 'text/csv' : 'application/json'));
  }
  const reader = await person();
  for (const path of [summaryPath, ...['csv', 'json', 'xlsx'].map(format => '/api/payroll/hours/export?' + suffix + '&format=' + format)]) {
    const auth = await login(reader); let fired = false;
    const database: Database = { ...db, query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await db.query<R>(sql, params);
      if (!fired && sql.includes('FROM sessions s JOIN users u')) { fired = true; await send('/auth/logout', {}, auth); }
      return result;
    } };
    const response = await request(app(database)).get(path).set('Cookie', auth.cookie);
    assert.equal(fired, true); assert.equal(response.status, 401); assert.equal(response.headers['content-disposition'], undefined); assert.equal(response.body.report, undefined);
  }
  assert.equal(await auditCount(reader.id), 0);
});

test('readable HTTP payroll exports honor options and current explicit unit scope', async () => {
  const presentation = { title: 'School hours for review', decimalPlaces: 2, grouping: 'jobs', sortBy: 'name', columns: ['workHours', 'breakHours'], includeAudit: false };
  const reader = await person('manager', [units[0]]), auth = await login(reader);
  const selectedUnit = (await db.query('SELECT name FROM units WHERE id=$1', [units[0]])).rows[0].name;
  const excludedUnit = (await db.query('SELECT name FROM units WHERE id=$1', [units[1]])).rows[0].name;
  // A user-written title may name a community absent from the authorized data.
  presentation.title = excludedUnit + ' excluded from this scope';
  const suffix = new URLSearchParams({ ...query, presentation: JSON.stringify(presentation) });
  for (const format of ['csv', 'xlsx']) {
    const pending = request(app()).get('/api/payroll/hours/export?' + suffix + '&format=' + format).set('Cookie', auth.cookie);
    if (format === 'xlsx') pending.buffer(true).parse((response, done) => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => done(null, Buffer.concat(chunks))); response.on('error', done);
    });
    const response = await pending;
    assert.equal(response.status, 200); assert.match(response.headers['cache-control'], /private.*no-store/);
    if (format === 'csv') {
      assert.match(response.text, /"Employee","Job","Department","Work hours","Break hours"/);
      const rows = parseCsv<Record<string, string>>(response.text, { columns: true, bom: true });
      assert.deepEqual(rows.map((row: Record<string, string>) => row.Department), [selectedUnit]);
      assert.ok(!response.text.includes(target.id)); assert.ok(!response.text.includes('work_microseconds'));
      assert.equal(response.text.split('\r\n').length, 2);
    } else {
      const zip = await JSZip.loadAsync(response.body);
      const workbook = await zip.file('xl/workbook.xml')!.async('string');
      assert.match(workbook, /Report overview/); assert.match(workbook, /Hours by job/); assert.doesNotMatch(workbook, /Source JSON/);
      const detail = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
      const cells = xmlCells(detail);
      assert.equal(cells.get('A1')?.text, presentation.title);
      const departments = [...cells].filter(([ref, cell]) => /^C[0-9]+$/.test(ref) && Number(ref.slice(1)) >= 7 && cell.text !== '').map(([, cell]) => cell.text);
      assert.deepEqual(departments, [selectedUnit]); assert.ok(!detail.includes(target.id));
    }
  }
  const evidence = (await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='payroll.hours_exported'", [reader.id])).rows;
  assert.equal(evidence.length, 2); assert.deepEqual(evidence[0].detail.presentation, presentation);
  assert.equal(evidence[0].detail.employees, undefined); assert.equal(evidence[0].detail.sourceRowCount, 1);
  await change(reader, { role: 'employee' });
  const fresh = await login(reader);
  assert.equal((await request(app()).get('/api/payroll/hours/export?' + suffix + '&format=csv').set('Cookie', fresh.cookie)).status, 403);
});

test('HTTP payroll exports reject invalid options and preserve exact JSON contract without a publication audit', async () => {
  const before = await auditCount(owner.id);
  for (const [format, presentation] of [['csv', '{broken'], ['csv', '{}'+ ' '.repeat(3001)], ['csv', JSON.stringify({ decimalPlaces: 99 })], ['csv', JSON.stringify({ columns: ['workHours', 'workHours'] })], ['json', '{}']]) {
    const suffix = new URLSearchParams({ ...query, format, presentation });
    const response = await request(app()).get('/api/payroll/hours/export?' + suffix).set('Cookie', ownerAuth.cookie);
    assert.equal(response.status, 400); assert.equal(response.headers['content-disposition'], undefined);
  }
  assert.equal(await auditCount(owner.id), before);
});
