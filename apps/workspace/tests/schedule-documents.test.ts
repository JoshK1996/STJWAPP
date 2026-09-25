import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { runScheduleDocument, inspectScheduleDocument } from '../server/schedule-documents';
import { scheduleImportTimestamp, scheduleDraftCsv, type ScheduleImportContext } from '../shared/schedule-documents';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
// Worker-safe bounded ZIP utility also supplies a deterministic CRC for synthetic test packages.
import { workbookCrc32 } from '../server/import-workbook-zip.mjs';

function zip(entries: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, source] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(source), crc = workbookCrc32(bytes), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(directory, filename); offset += header.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function word(body: string) { return zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` }); }
function pdf(value = 'Employee     Start     End') {
  const stream = value ? `BT /F1 12 Tf 40 740 Td (${value}) Tj ET` : '', objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n', offsets = [0]; objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(output); output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`; return Buffer.from(output);
}

test('CSV arbitrary headers/order and quoted multiline cells are extracted without schedule interpretation', async () => {
  const bytes = Buffer.from('\uFEFFNotes,Worker,Finish,Start\r\n"First, line\nSecond",Example,16:00,08:00');
  const result = await runScheduleDocument('csv', bytes);
  assert.equal(result.sourceHash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.sheets[0].rows[1].cells, ['First, line\nSecond', 'Example', '16:00', '08:00']);
});
test('XLSX supports arbitrary headings and typed dates/numbers but rejects formulas and external content', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('School schedule');
  sheet.addRow(['Worker', 'Date', 'Hours']); sheet.addRow(['Example', new Date('2026-10-05T08:00:00Z'), 8]);
  const result = await runScheduleDocument('xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()));
  assert.deepEqual(result.sheets[0].rows[1].cells, ['Example', '2026-10-05T08:00:00', '8']); assert.ok(result.warnings.some(value => value.includes('no time zone')));
  sheet.getCell('C2').value = { formula: '4+4', result: 8 };
  await assert.rejects(runScheduleDocument('xlsx', new Uint8Array(await workbook.xlsx.writeBuffer())), /Formulas/);
});
test('DOCX tables preserve cells and paragraphs while rejecting malformed XML, archive traversal and external relationships', async () => {
  const bytes = word('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Example Employee</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>08:00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
  const result = await runScheduleDocument('docx', bytes); assert.deepEqual(result.sheets[0].rows[0].cells, ['Example Employee', '08:00']);
  await assert.rejects(runScheduleDocument('docx', word('<w:p>')), /Malformed/);
  await assert.rejects(runScheduleDocument('docx', zip({ '../word/document.xml': '<x/>' })), (error: any) => error.status === 422);
  await assert.rejects(runScheduleDocument('docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>', 'word/_rels/document.xml.rels': '<Relationships><Relationship TargetMode="External" Target="file:///private"/></Relationships>' })), /External/);
  await assert.rejects(runScheduleDocument('docx', word('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]><w:p/>')), (error: any) => error.status === 422);
});
test('PDF text is extracted as review candidates, empty PDF is explicit, and invalid containers fail', async () => {
  const result = await runScheduleDocument('pdf', pdf()); assert.ok(result.sheets[0].rows.flatMap(row => row.cells).join(' ').includes('Employee'));
  const empty = await runScheduleDocument('pdf', pdf('')); assert.equal(empty.sheets[0].rows.length, 0); assert.ok(empty.warnings.some(value => value.includes('OCR is not available')));
  await assert.rejects(runScheduleDocument('pdf', Buffer.from('not a PDF')), /valid text-based PDF/);
});
test('worker cancellation/deadline terminates without publishing a partial result', async () => {
  const controller = new AbortController(); controller.abort(); await assert.rejects(runScheduleDocument('csv', Buffer.from('a,b'), controller.signal), (error: any) => error.status === 499);
  await assert.rejects(runScheduleDocument('pdf', pdf(), undefined, 1), (error: any) => error.status === 503);
  const running = new AbortController(), pending = runScheduleDocument('pdf', pdf(), running.signal); setTimeout(() => running.abort(), 5);
  await assert.rejects(pending, (error: any) => error.status === 499);
});
test('local dates use the explicit organization zone, reject gap/fold/invalid dates and support chosen date order', () => {
  assert.equal(scheduleImportTimestamp('2026-10-05 08:00', 'America/New_York'), '2026-10-05T12:00:00.000Z');
  assert.equal(scheduleImportTimestamp('10/05/2026 8:30 PM', 'America/New_York', 'mdy'), '2026-10-06T00:30:00.000Z');
  assert.equal(scheduleImportTimestamp('05/10/2026 08:00', 'America/New_York', 'dmy'), '2026-10-05T12:00:00.000Z');
  assert.throws(() => scheduleImportTimestamp('2026-03-08 02:30', 'America/New_York'), /gap/);
  assert.throws(() => scheduleImportTimestamp('2026-11-01 01:30', 'America/New_York'), /twice/);
  assert.equal(scheduleImportTimestamp('2026-11-01T01:30:00-05:00', 'America/New_York'), '2026-11-01T06:30:00.000Z');
  assert.throws(() => scheduleImportTimestamp('2026-02-29 08:00', 'America/New_York'), /invalid/);
});
test('draft validation preserves explicit exclusions and rejects unassigned/ambiguous jobs, invalid durations and oversized rows', () => {
  const context: ScheduleImportContext = { timezone: 'America/New_York', staff: [{ id: 'p', name: 'Example', email: 'example@stjw.org', active: true, unit_ids: ['u'], job_ids: ['j'] }], jobs: [{ id: 'j', title: 'Morning duty', unit_id: 'u' }], units: [{ id: 'u', name: 'School' }] };
  const row = { source: 'row2', include: true, userId: 'p', jobId: 'j', start: '2026-10-05 08:00', end: '2026-10-05 10:00', note: 'A "quoted" note' };
  const result = scheduleDraftCsv([row, { ...row, include: false, userId: '' }], context); assert.equal(result.errors.length, 0); assert.ok(result.csv.includes('2026-10-05T12:00:00.000Z')); assert.ok(result.csv.includes('""quoted""'));
  assert.equal(scheduleDraftCsv([{ ...row, end: '2026-10-05 07:00' }], context).errors.length, 1);
  assert.equal(scheduleDraftCsv([row], { ...context, jobs: [...context.jobs, { ...context.jobs[0], id: 'duplicate' }] }).errors.length, 1);
  assert.equal(scheduleDraftCsv([row], { ...context, staff: [{ ...context.staff[0], job_ids: [] }] }).errors.length, 1);
});

let db: Database, actor: Actor, cookie: string, proof: string, csrf: string;
const origin = 'http://localhost:3193', application = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: 'stjw.org' });
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: 'synthetic.documents@example.test' });
  const row = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0], token = await db.transaction(tx => issueSetup(tx, { id: row.id, org_id: row.org_id }));
  const setup = await request(application()).post('/api/auth/setup').set('Origin', origin).send({ token, password: 'Synthetic!8' }); assert.equal(setup.status, 200);
  const login = await request(application()).post('/api/auth/login').set('Origin', origin).send({ email: 'synthetic.documents@example.test', credential: 'Synthetic!8', mode: 'password' }); assert.equal(login.status, 200);
  cookie = login.headers['set-cookie'][0].split(';')[0]; proof = digest(cookie.slice(cookie.indexOf('=') + 1)); const me = await request(application()).get('/api/me').set('Cookie', cookie); actor = me.body.actor; csrf = actor.csrf!;
});
after(async () => { await db?.close(); });
test('normal HTTP requires current password management + CSRF; extracted text is private and creates no schedules', async () => {
  const input = { format: 'csv', base64: Buffer.from('Name,Date\nSynthetic,2026-10-05').toString('base64') };
  assert.equal((await request(application()).post('/api/schedule-documents/inspect').set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', 'wrong').send(input)).status, 403);
  const before = (await db.query('SELECT count(*) AS n FROM schedules')).rows[0].n;
  const response = await request(application()).post('/api/schedule-documents/inspect').set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(input);
  assert.equal(response.status, 200, response.body.error); assert.equal(response.headers['cache-control'], 'private, no-store'); assert.equal(response.body.timezone, 'America/New_York'); assert.equal(response.body.sheets[0].rows[1].cells[0], 'Synthetic');
  assert.equal((await db.query('SELECT count(*) AS n FROM schedules')).rows[0].n, before);
  await assert.rejects(inspectScheduleDocument(db, { ...actor, mode: 'pin' }, undefined, input), (error: any) => error.status === 401);
});
test('only document inspection admits bodies larger than 512 KiB and its 3 MiB envelope remains enforced', async () => {
  const input = { format: 'csv', base64: Buffer.from(Array.from({ length: 300 }, () => 'x'.repeat(2000)).join('\n')).toString('base64') };
  assert.ok(JSON.stringify(input).length > 512 * 1024);
  const send = (path: string, value: object) => request(application()).post('/api' + path).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(value);
  const valid = await send('/schedule-documents/inspect', input); assert.equal(valid.status, 200, valid.body.error); assert.equal(valid.body.sheets[0].rows.length, 300);
  assert.equal((await send('/imports/workforce/schedules/preview', input)).status, 413);
  assert.equal((await send('/schedule-documents/inspect', { format: 'csv', base64: 'A'.repeat(3 * 1024 * 1024) })).status, 413);
});
test('role revocation while a malformed document is parsed hides the parser error and produces no inspection audit', async () => {
  let calls = 0;
  const changed: Database = { query: db.query.bind(db), close: async () => {}, transaction: async work => { if (++calls === 2) await db.query("UPDATE users SET role='employee' WHERE id=$1", [actor.id]); return db.transaction(work); } };
  const before = (await db.query("SELECT count(*) AS n FROM audit_events WHERE action='schedule.document_inspected'")).rows[0].n;
  try { await assert.rejects(inspectScheduleDocument(changed, actor, proof, { format: 'pdf', base64: Buffer.from('not a PDF').toString('base64') }), (error: any) => error.status === 403); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [actor.id]); }
  assert.equal((await db.query("SELECT count(*) AS n FROM audit_events WHERE action='schedule.document_inspected'")).rows[0].n, before);
});
test('revocation while parsing suppresses document text and successful inspection audit', async () => {
  let calls = 0;
  const changed: Database = { query: db.query.bind(db), close: async () => {}, transaction: async work => { if (++calls === 2) await db.query('DELETE FROM sessions WHERE token_hash=$1', [proof]); return db.transaction(work); } };
  const before = (await db.query("SELECT count(*) AS n FROM audit_events WHERE action='schedule.document_inspected'")).rows[0].n;
  await assert.rejects(inspectScheduleDocument(changed, actor, proof, { format: 'csv', base64: Buffer.from('Sensitive extracted cell').toString('base64') }), (error: any) => error.status === 401);
  assert.equal((await db.query("SELECT count(*) AS n FROM audit_events WHERE action='schedule.document_inspected'")).rows[0].n, before);
});
