import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { initializeSchoolDemo } from "../server/school-seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { initialDefinition, reportDefinition, type ReportDefinition } from "../shared/report-library";
import { saveReport, runReport } from "../server/report-library";
import { canonicalSnapshot, prepareReportSnapshot, captureReportSnapshot, readReportSnapshot, listReportSnapshots, readReportSnapshotPreview } from "../server/report-snapshots";
import { previewFinancialReport, publishFinancialReport } from "../server/finance";
import { previewCompensation, saveCompensation } from "../server/compensation";

let db: Database, app: ReturnType<typeof createApp>, owner: Actor, teacher: Actor, auth: any, teacherAuth: any;
let unit: Row, section: Row, book: Row, program: Row, finance: Row;
const origin = "http://localhost:3000", year = new Date().getUTCFullYear(), day = `${year}-01-05`;
async function session(actor: Actor) { const token = opaqueToken(), csrf = opaqueToken(), hash = digest(token); await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')", [hash, actor.org_id, actor.id, csrf]); return { cookie: "stjw_session=" + token, csrf, hash }; }
async function send(path: string, body: unknown, who = auth, method = "post") { return (request(app) as any)[method]("/api" + path).set("Cookie", who.cookie).set("Origin", origin).set("X-CSRF-Token", who.csrf).send(body); }
async function ok(path: string, body: unknown, who = auth, method = "post") { const res = await send(path, body, who, method); assert.ok(res.status < 300, JSON.stringify(res.body)); return res.body; }
async function saved(def = initialDefinition("workforce"), actor = owner, credential = auth) { return saveReport(db, actor, credential.hash, { id: randomUUID(), version: 0, name: "Synthetic frozen report", description: "Synthetic report review", definition: def, archived: false, reason: "Synthetic initial definition" }); }
async function prepared(def = initialDefinition("workforce"), actor = owner, credential = auth) { const report = await saved(def, actor, credential); const preview = await prepareReportSnapshot(db, actor, credential.hash, report.id, { version: report.version }); return { report, preview }; }
function command(preview: any, changes = {}) { return { version: preview.data.reportVersion, previewId: preview.id, payloadHash: preview.payloadHash, commandId: randomUUID(), reviewed: true, reason: "Reviewed synthetic report evidence", ...changes }; }
async function captured(def = initialDefinition("workforce"), actor = owner, credential = auth) { const result = await prepared(def, actor, credential), input = command(result.preview), response = await captureReportSnapshot(db, actor, credential.hash, result.report.id, input); return { ...result, input, id: response.snapshot.id }; }
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: true, ownerEmail: "snapshots.owner@example.test" }); await initializeSchoolDemo(db, true);
  const person = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0]; unit = (await db.query("SELECT * FROM units WHERE kind='school'")).rows[0];
  owner = { ...person, mode: "password", unit_ids: [unit.id] } as Actor;
  section = (await db.query("SELECT * FROM sections WHERE unit_id=$1 ORDER BY name", [unit.id])).rows[0];
  const t = (await db.query("SELECT u.* FROM section_teachers a JOIN users u ON u.id=a.user_id WHERE a.section_id=$1", [section.id])).rows[0]; teacher = { ...t, mode: "password", unit_ids: [unit.id] } as Actor;
  auth = await session(owner); teacherAuth = await session(teacher); app = createApp(db, { origin, production: false, staffDomain: "stjw.org", demo: true });
  program = await ok("/care/programs", { unitId: unit.id, name: "Synthetic snapshot care", room: "Room", capacity: 30, instructions: "Synthetic care instruction", confirmed: true, archived: false, staffIds: [teacher.id], version: 0, reason: "Synthetic care fixture" });
  const student = (await db.query("SELECT student_id FROM section_students WHERE section_id=$1 LIMIT 1", [section.id])).rows[0].student_id;
  await ok(`/care/programs/${program.id}/enrollments`, { studentId: student, startsOn: `${year}-01-01`, endsOn: `${year}-12-31`, enabled: true, version: 0, reason: "Synthetic enrollment" });
  await ok("/care/check-in", { programId: program.id, programVersion: program.version, studentId: student, arrivalName: "Synthetic arrival", received: true, commandId: randomUUID() });
  await ok("/school/grading/settings", { unitId: unit.id, version: 0, confirmed: true, policy: { name: "Synthetic policy", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: randomUUID(), name: "Practice", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] }, reason: "Synthetic grading policy" }, auth, "put");
  const term = await ok("/school/terms", { yearId: section.year_id, name: "Synthetic annual term", startsOn: `${year}-01-01`, endsOn: `${year}-12-31` });
  book = await ok("/school/gradebooks", { sectionId: section.id, termId: term.id });
  await ok("/school/attendance/config", { unitId: unit.id, weekdays: [1, 2, 3, 4, 5, 6, 7], periods: ["Daily"], confirmed: true, version: 0, reason: "Synthetic attendance policy" }, auth, "put");
  const code = await ok("/school/attendance/codes", { unitId: unit.id, code: "SYN", label: "Synthetic present", category: "present", excused: false, reasonRequired: false });
  const opened = await ok("/school/attendance/sessions", { sectionId: section.id, date: day, period: "Daily" });
  await ok(`/school/attendance/sessions/${opened.session.id}`, { version: opened.session.version, submit: true, marks: opened.marks.map((m: any) => ({ studentId: m.student_id, codeId: code.id, note: "Synthetic private note" })) }, auth, "put");
  const fin = await previewFinancialReport(db, owner, auth.hash, { unitId: unit.id, reportId: randomUUID(), expectedVersion: 0, metadata: { title: "Synthetic finances", sourceName: "Synthetic CSV", currency: "USD", kind: "actual", basis: "period_activity", from: day, to: day, note: "Excluded private metadata" }, csv: "lineCode,lineLabel,group,rowKind,amount,note\nA,=Synthetic line,Operations,detail,0.1,Private line\nB,Other,Operations,detail,0.2,\nT,Total,Operations,total,0.3,", reason: "Synthetic source review" });
  finance = await publishFinancialReport(db, owner, auth.hash, fin.id, { sourceHash: fin.sourceHash, fingerprint: fin.fingerprint, reviewed: true });
  const job = (await db.query("SELECT job_id FROM user_jobs WHERE user_id=$1 LIMIT 1", [teacher.id])).rows[0].job_id;
  const pay = { userId: teacher.id, jobId: job, expectedVersion: 0, rates: [{ id: randomUUID(), startsOn: `${year}-01-01`, endsOn: null, amount: "18.125", currency: "USD", basis: "hour", voided: false, note: "Synthetic rate" }], reason: "Synthetic pay fixture" };
  const pp = await previewCompensation(db, owner, pay, auth.hash); await saveCompensation(db, owner, { ...pay, previewHash: pp.previewHash, reviewed: true, commandId: randomUUID() }, auth.hash);
});
afterEach(async () => { await db.query("DELETE FROM report_run_previews"); });
after(async () => { await db?.close(); });
function definition(source: string): ReportDefinition {
  const def: any = initialDefinition(source as any);
  if (source === "care") def.programId = program.id;
  if (source === "grades") def.bookId = book.id;
  if (source === "finance") Object.assign(def, { unitId: unit.id, financialReportId: finance.reportId, financialVersion: 1 });
  if (source === "attendance") Object.assign(def, { unitId: unit.id, yearId: section.year_id, period: "Daily", sectionIds: [], range: { preset: "custom", from: day, to: day } });
  return reportDefinition.parse(def);
}
test("all six source snapshots capture reviewed rows, hidden scopes and immutable exact exports", async () => {
  for (const source of ["workforce", "care", "grades", "attendance", "finance", "compensation"]) {
    const result = await captured(definition(source)); assert.ok(result.preview.data.sourceRowCount > 0, source);
    const raw = (await db.query("SELECT * FROM report_run_snapshots WHERE id=$1", [result.id])).rows[0];
    assert.deepEqual({ payload: digest(raw.payload_text) === raw.payload_hash, manifest: digest(canonicalSnapshot(raw.access_manifest)) === raw.manifest_hash, json: digest(raw.json_text) === raw.json_hash, csv: digest(raw.csv_text) === raw.csv_hash }, { payload: true, manifest: true, json: true, csv: true });
    const read = await readReportSnapshot(db, owner, auth.hash, result.report.id, result.id, "json");
    assert.deepEqual(read.snapshot.data, result.preview.data); assert.equal(digest(read.content), read.jsonHash);
    assert.equal(JSON.parse(read.content).payloadHash, result.preview.payloadHash);
    const csv = await readReportSnapshot(db, owner, auth.hash, result.report.id, result.id, "csv"); assert.equal(digest(csv.content), csv.csvHash);
    const values = parse(csv.content, { columns: true, bom: true }); assert.equal(values.length, result.preview.data.rowCount); assert.ok(values.every((r: any) => r.snapshot_row_kind === "record"));
    assert.ok(!read.content.includes("access_manifest")); assert.ok(!read.content.includes("Excluded private metadata"));
    assert.equal((await listReportSnapshots(db, owner, auth.hash, result.report.id)).rows.length, 1);
  }
});
test("source changes after review and later definition edits never regenerate frozen rows or bytes", async () => {
  const result = await prepared(definition("workforce"));
  await db.query("UPDATE users SET name=name||' renamed' WHERE id=$1", [teacher.id]);
  const input = command(result.preview), saved = await captureReportSnapshot(db, owner, auth.hash, result.report.id, input);
  const before = await readReportSnapshot(db, owner, auth.hash, result.report.id, saved.snapshot.id, "json"); assert.deepEqual(before.snapshot.data, result.preview.data);
  await saveReport(db, owner, auth.hash, { id: result.report.id, version: 1, definition: result.report.definition, archived: true, name: "Changed definition title", description: "", reason: "Archive old definition" });
  const after = await readReportSnapshot(db, owner, auth.hash, result.report.id, saved.snapshot.id, "json"); assert.equal(after.content, before.content);
});
test("capture retries survive consumed previews and later definition changes, reject conflicting commands", async () => {
  const result = await captured();
  await saveReport(db, owner, auth.hash, { id: result.report.id, version: 1, definition: result.report.definition, archived: true, name: "Archived after capture", description: "", reason: "Synthetic archive after capture" });
  assert.equal((await captureReportSnapshot(db, owner, auth.hash, result.report.id, result.input)).snapshot.id, result.id);
  await assert.rejects(captureReportSnapshot(db, owner, auth.hash, result.report.id, { ...result.input, reason: "Different reviewed reason" }), (e: any) => e.status === 409);
  await assert.rejects(captureReportSnapshot(db, owner, auth.hash, result.report.id, { ...result.input, commandId: randomUUID() }), (e: any) => e.status === 409);
  assert.equal((await db.query("SELECT id FROM report_run_snapshots WHERE report_id=$1", [result.report.id])).rows.length, 1);
});
test("empty CSV has explicit metadata-only row and zero source/result counts", async () => {
  const def: any = definition("workforce"); def.range = { preset: "custom", from: "2000-01-01", to: "2000-01-01" };
  const result = await captured(def), csv = await readReportSnapshot(db, owner, auth.hash, result.report.id, result.id, "csv"), rows = parse(csv.content, { columns: true, bom: true }) as Record<string, string>[];
  assert.equal(result.preview.data.rowCount, 0); assert.equal(rows.length, 1); assert.equal(rows[0].snapshot_row_kind, "empty_report"); assert.equal(rows[0].snapshot_row_count, "0"); assert.equal(rows[0].snapshot_source_row_count, "0"); assert.equal(rows[0].snapshot_id, result.id); assert.equal(rows[0].snapshot_payload_hash, result.preview.payloadHash);
  for (const column of result.preview.data.columns) assert.equal(rows[0][column.key], "");
});
test("current role and entire hidden workforce scope deny old organization summaries and retries", async () => {
  const def: any = definition("workforce"); def.layout = "summary"; def.sort = { key: "group_name", direction: "asc" };
  const result = await captured(def);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [owner.id]);
  try {
    await assert.rejects(readReportSnapshot(db, owner, auth.hash, result.report.id, result.id), (e: any) => e.status === 404);
    assert.deepEqual((await listReportSnapshots(db, owner, auth.hash, result.report.id)).rows, []);
    await assert.rejects(captureReportSnapshot(db, owner, auth.hash, result.report.id, result.input), (e: any) => e.status === 404);
  } finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
  assert.equal((await readReportSnapshot(db, owner, auth.hash, result.report.id, result.id)).payloadHash, result.preview.payloadHash);
});
test("private ownership, revoked sessions and agent/PIN modes cannot read or capture snapshots", async () => {
  const result = await captured();
  await assert.rejects(readReportSnapshot(db, teacher, teacherAuth.hash, result.report.id, result.id), (e: any) => e.status === 404);
  await assert.rejects(prepareReportSnapshot(db, { ...owner, mode: "api" }, auth.hash, result.report.id, { version: 1 }), (e: any) => e.status === 403);
  await assert.rejects(readReportSnapshot(db, { ...owner, mode: "pin" }, auth.hash, result.report.id, result.id), (e: any) => e.status === 403);
  const expired = await session(owner); await db.query("DELETE FROM sessions WHERE token_hash=$1", [expired.hash]);
  await assert.rejects(readReportSnapshot(db, owner, expired.hash, result.report.id, result.id), (e: any) => e.status === 401);
});
test("office revocation blocks care snapshots despite unchanged care staff assignment", async () => {
  await db.query("INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, teacher.id, owner.id]);
  const result = await captured(definition("care"), teacher, teacherAuth);
  await db.query("DELETE FROM school_office_grants WHERE user_id=$1", [teacher.id]);
  assert.equal((await db.query("SELECT user_id FROM care_staff WHERE user_id=$1 AND program_id=$2", [teacher.id, program.id])).rows.length, 1);
  await assert.rejects(readReportSnapshot(db, teacher, teacherAuth.hash, result.report.id, result.id), (e: any) => e.status === 404);
});
test("attendance all-class selections freeze expanded scope and reject partial remaining teaching access", async () => {
  await db.query("INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, teacher.id, owner.id]);
  const result = await captured(definition("attendance"), teacher, teacherAuth);
  await db.query("DELETE FROM school_office_grants WHERE user_id=$1", [teacher.id]);
  await assert.rejects(readReportSnapshot(db, teacher, teacherAuth.hash, result.report.id, result.id), (e: any) => e.status === 404);
});
test("removing a teacher from the captured gradebook blocks immutable grade snapshots", async () => {
  const result = await captured(definition("grades"), teacher, teacherAuth);
  await db.query("DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2", [section.id, teacher.id]);
  try { await assert.rejects(readReportSnapshot(db, teacher, teacherAuth.hash, result.report.id, result.id), (e: any) => e.status === 404); }
  finally { await db.query("INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, section.id, teacher.id]); }
});
test("finance/pay permission revocation and archived financial sources preserve correct historical behavior", async () => {
  const fin = await captured(definition("finance")), pay = await captured(definition("compensation"));
  assert.equal((await db.query("UPDATE financial_reports SET archived=true WHERE id=$1 RETURNING id", [finance.reportId])).rows.length, 1);
  assert.equal((await readReportSnapshot(db, owner, auth.hash, fin.report.id, fin.id)).payloadHash, fin.preview.payloadHash);
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [owner.id]);
  try { for (const result of [fin, pay]) await assert.rejects(readReportSnapshot(db, owner, auth.hash, result.report.id, result.id), (e: any) => e.status === 404); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
});
test("expiry, definition races, forged input and preview bounds reject capture without writing snapshots", async () => {
  const result = await prepared();
  await db.query("UPDATE report_run_previews SET expires_at=now()-interval '1 second' WHERE id=$1", [result.preview.id]);
  await assert.rejects(readReportSnapshotPreview(db, owner, auth.hash, result.report.id, result.preview.id));
  await assert.rejects(captureReportSnapshot(db, owner, auth.hash, result.report.id, command(result.preview)), (e: any) => e.status === 409);
  const fresh = await prepared(); await assert.rejects(captureReportSnapshot(db, owner, auth.hash, fresh.report.id, command(fresh.preview, { payloadHash: "0".repeat(64) })), (e: any) => e.status === 409);
  await assert.rejects(captureReportSnapshot(db, owner, auth.hash, fresh.report.id, command(fresh.preview, { rows: [] })));
  const a = await prepared(), b = await prepared(); assert.ok(a.preview.id && b.preview.id);
  await assert.rejects(prepared(), (e: any) => e.status === 409);
});
test("capture rolls back snapshot, command and preview consumption when audit fails", async () => {
  const result = await prepared(); const faulty: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, params) => { if (sql.includes("INSERT INTO audit_events") && params?.[3] === "report_snapshot.captured") throw new Error("Synthetic audit failure"); return tx.query(sql, params); } })) };
  await assert.rejects(captureReportSnapshot(faulty, owner, auth.hash, result.report.id, command(result.preview)), /Synthetic audit failure/);
  assert.equal((await db.query("SELECT id FROM report_run_snapshots WHERE report_id=$1", [result.report.id])).rows.length, 0);
  assert.equal((await db.query("SELECT id FROM report_run_previews WHERE id=$1", [result.preview.id])).rows.length, 1);
});
test("scope revoked between extraction and publication discards the candidate", async () => {
  const report = await saved(); let calls = 0; const wrapped: Database = { ...db, transaction: async fn => { if (++calls === 3) await db.query("UPDATE users SET role='employee' WHERE id=$1", [owner.id]); return db.transaction(fn); } };
  try { await assert.rejects(prepareReportSnapshot(wrapped, owner, auth.hash, report.id, { version: 1 }), (e: any) => e.status === 404); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
  assert.equal((await db.query("SELECT id FROM report_run_previews WHERE report_id=$1", [report.id])).rows.length, 0);
});
test("retained snapshots and receipts reject UPDATE/DELETE and HTTP exports retain hashes", async () => {
  const result = await captured();
  await assert.rejects(db.query("UPDATE report_run_snapshots SET payload_text='{}' WHERE id=$1", [result.id]), /append-only/);
  await assert.rejects(db.query("DELETE FROM report_run_snapshots WHERE id=$1", [result.id]), /append-only/);
  await assert.rejects(db.query("DELETE FROM report_snapshot_commands WHERE snapshot_id=$1", [result.id]), /append-only/);
  const response = await request(app).get(`/api/report-library/${result.report.id}/snapshots/${result.id}/export?format=json`).set("Cookie", auth.cookie);
  assert.equal(response.status, 200); assert.equal(digest(response.text), response.headers["x-snapshot-sha256"]);
  assert.equal((await send(`/report-library/${result.report.id}/snapshot-previews`, { version: 1, source: "finance" })).status, 400);
});
test("the complete immutable export cap rejects oversized representations atomically", async () => {
  const result = await prepared();
  const data = { ...result.preview.data, rows: [{ ...result.preview.data.rows[0], employee_name: "x".repeat(4 * 1024 * 1024) }], rowCount: 1 };
  const payload = canonicalSnapshot(data), payloadHash = digest(payload);
  await db.query("UPDATE report_run_previews SET payload_text=$1,payload_hash=$2,bytes=$3 WHERE id=$4", [payload, payloadHash, Buffer.byteLength(payload), result.preview.id]);
  await assert.rejects(captureReportSnapshot(db, owner, auth.hash, result.report.id, command(result.preview, { payloadHash })), (e: any) => e.status === 400 && e.message.includes("8 MiB"));
  assert.equal((await db.query("SELECT id FROM report_run_snapshots WHERE report_id=$1", [result.report.id])).rows.length, 0);
  assert.equal((await db.query("SELECT id FROM report_run_previews WHERE id=$1", [result.preview.id])).rows.length, 1);
});
test("busy source extraction rejects live and snapshot runs before loading any source rows", async () => {
  const report = await saved(); let sourceReads = 0;
  const busy: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: async <T extends Row = Row>(sql: string, params?: any[]) => {
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: false }] as unknown as T[] };
    if (sql.includes("FROM segments")) sourceReads++;
    return tx.query<T>(sql, params);
  } })) };
  await assert.rejects(runReport(busy, owner, definition("workforce"), { sessionHash: auth.hash }), (e: any) => e.status === 429);
  await assert.rejects(prepareReportSnapshot(busy, owner, auth.hash, report.id, { version: 1 }), (e: any) => e.status === 429);
  assert.equal(sourceReads, 0); assert.equal((await db.query("SELECT id FROM report_run_previews WHERE report_id=$1", [report.id])).rows.length, 0);
});
test("100 retained snapshots paginate without exposing body text and the next capture preserves its review", async () => {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic capacity owner',$3,'owner')", [id, owner.org_id, `capacity.${id}@example.test`]);
  const person = { ...owner, id }, credential = await session(person), report = await saved(definition("workforce"), person, credential);
  for (let n = 0; n < 100; n++) {
    const preview = await prepareReportSnapshot(db, person, credential.hash, report.id, { version: 1 });
    await captureReportSnapshot(db, person, credential.hash, report.id, command(preview));
  }
  const first = await listReportSnapshots(db, person, credential.hash, report.id), second = await listReportSnapshots(db, person, credential.hash, report.id, { offset: first.nextOffset });
  assert.equal(first.rows.length, 50); assert.equal(first.nextOffset, 50); assert.equal(second.rows.length, 50); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.rows, ...second.rows].map(r => r.id)).size, 100);
  assert.ok(!JSON.stringify(first).includes("employee_name"));
  const preview = await prepareReportSnapshot(db, person, credential.hash, report.id, { version: 1 });
  await assert.rejects(captureReportSnapshot(db, person, credential.hash, report.id, command(preview)), (e: any) => e.status === 409 && e.message.includes("capacity"));
  assert.equal((await db.query("SELECT id FROM report_run_snapshots WHERE user_id=$1", [id])).rows.length, 100);
  assert.equal((await db.query("SELECT id FROM report_run_previews WHERE id=$1", [preview.id])).rows.length, 1);
});
