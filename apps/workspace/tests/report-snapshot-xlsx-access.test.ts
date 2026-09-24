import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { initializeSchoolDemo } from "../server/school-seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { initialDefinition, initialWorkforceDefinitionV2, reportDefinition, type ReportDefinition, type ReportSource } from "../shared/report-library";
import { saveReport } from "../server/report-library";
import { prepareReportSnapshot, captureReportSnapshot, readReportSnapshot, exportReportSnapshotXlsx } from "../server/report-snapshots";
import { previewFinancialReport, publishFinancialReport } from "../server/finance";
import { previewCompensation, saveCompensation } from "../server/compensation";

let db: Database, app: ReturnType<typeof createApp>, owner: Actor, teacher: Actor, auth: Auth, teacherAuth: Auth;
let unit: Row, section: Row, book: Row, program: Row, finance: Row;
type Auth = { cookie: string; hash: string; csrf: string };
const origin = "http://localhost:3000", year = new Date().getUTCFullYear(), day = `${year}-01-05`, password = "Synthetic-Xlsx-" + randomUUID(), sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const options = { origin, production: false, staffDomain: "stjw.org", demo: true };
async function setup(person: Row): Promise<{ actor: Actor; auth: Auth }> {
  const token = await db.transaction(tx => issueSetup(tx, { id: person.id, org_id: person.org_id }));
  const response = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(response.status, 200);
  return authenticated(response.headers["set-cookie"]);
}
async function authenticated(cookies: unknown): Promise<{ actor: Actor; auth: Auth }> {
  assert.ok(Array.isArray(cookies)); const cookie = String(cookies[0]).split(";")[0], token = cookie.slice(cookie.indexOf("=") + 1);
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, auth: { cookie, hash: digest(token), csrf: me.body.actor.csrf } };
}
async function loginOwner() {
  const response = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: owner.email, mode: "password", credential: password }); assert.equal(response.status, 200);
  auth = (await authenticated(response.headers["set-cookie"])).auth;
}
async function ok(path: string, body: unknown, method = "post") {
  const response = await (request(app) as any)[method]("/api" + path).set("Cookie", auth.cookie).set("Origin", origin).set("X-CSRF-Token", auth.csrf).send(body);
  assert.ok(response.status < 300, `Synthetic fixture failed at ${path}: ${response.status}`); return response.body;
}
function def(source: ReportSource, precise = false): ReportDefinition {
  const result: any = precise ? initialWorkforceDefinitionV2() : initialDefinition(source);
  if (source === "care") result.programId = program.id;
  if (source === "grades") result.bookId = book.id;
  if (source === "finance") Object.assign(result, { unitId: unit.id, financialReportId: finance.reportId, financialVersion: 1 });
  if (source === "attendance") Object.assign(result, { unitId: unit.id, yearId: section.year_id, period: "Daily", range: { preset: "custom", from: day, to: day } });
  return reportDefinition.parse(result);
}
async function captured(definition = def("workforce"), actor = owner, credential = auth) {
  const report = await saveReport(db, actor, credential.hash, { id: randomUUID(), version: 0, name: "Synthetic XLSX retained report", description: "Synthetic evidence", definition, archived: false, reason: "Create isolated workbook fixture" });
  const preview = await prepareReportSnapshot(db, actor, credential.hash, report.id, { version: 1 });
  const result = await captureReportSnapshot(db, actor, credential.hash, report.id, { version: 1, previewId: preview.id, payloadHash: preview.payloadHash, commandId: randomUUID(), reviewed: true, reason: "Reviewed synthetic retained evidence" });
  return { report, id: result.snapshot.id };
}
function wrapped(beforeSecond?: () => Promise<void>, queryHook?: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  let calls = 0;
  return { ...db, transaction: async action => {
    calls++; if (calls === 2 && beforeSecond) await beforeSecond();
    return db.transaction(tx => action({ query: async<T extends Row>(sql: string, params: any[] = []) => {
      const result = await tx.query<T>(sql, params); if (queryHook) await queryHook(tx, sql, params); return result;
    } }));
  } };
}
async function auditCount(id: string) { return Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE target_id=$1 AND action='report_snapshot.exported' AND detail->>'format'='xlsx'", [id])).rows[0].n); }
const frozen = new Map<ReportSource, Awaited<ReturnType<typeof captured>>>();
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: true, ownerEmail: "xlsx.owner@example.test" }); await initializeSchoolDemo(db, true); app = createApp(db, options);
  const person = (await db.query("SELECT id,org_id,email FROM users WHERE role='owner'")).rows[0], first = await setup(person); owner = first.actor; auth = first.auth;
  await ok("/auth/pin", { password, pin: "7391286" });
  unit = (await db.query("SELECT * FROM units WHERE kind='school'")).rows[0]; section = (await db.query("SELECT * FROM sections WHERE unit_id=$1 ORDER BY name", [unit.id])).rows[0];
  const t = (await db.query("SELECT u.id,u.org_id,u.email FROM section_teachers a JOIN users u ON u.id=a.user_id WHERE a.section_id=$1", [section.id])).rows[0], second = await setup(t); teacher = second.actor; teacherAuth = second.auth;
  program = await ok("/care/programs", { unitId: unit.id, name: "Synthetic XLSX care", room: "Room", capacity: 30, instructions: "Synthetic instruction", confirmed: true, archived: false, staffIds: [teacher.id], version: 0, reason: "Synthetic care fixture" });
  const student = (await db.query("SELECT student_id FROM section_students WHERE section_id=$1 LIMIT 1", [section.id])).rows[0].student_id;
  await ok(`/care/programs/${program.id}/enrollments`, { studentId: student, startsOn: `${year}-01-01`, endsOn: `${year}-12-31`, enabled: true, version: 0, reason: "Synthetic enrollment" });
  await ok("/care/check-in", { programId: program.id, programVersion: program.version, studentId: student, arrivalName: "Synthetic arrival", received: true, commandId: randomUUID() });
  await ok("/school/grading/settings", { unitId: unit.id, version: 0, confirmed: true, policy: { name: "Synthetic policy", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: randomUUID(), name: "Practice", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] }, reason: "Synthetic grading policy" }, "put");
  const term = await ok("/school/terms", { yearId: section.year_id, name: "Synthetic XLSX term", startsOn: `${year}-01-01`, endsOn: `${year}-12-31` }); book = await ok("/school/gradebooks", { sectionId: section.id, termId: term.id });
  await ok("/school/attendance/config", { unitId: unit.id, weekdays: [1, 2, 3, 4, 5, 6, 7], periods: ["Daily"], confirmed: true, version: 0, reason: "Synthetic attendance policy" }, "put");
  const code = await ok("/school/attendance/codes", { unitId: unit.id, code: "XLS", label: "Synthetic present", category: "present", excused: false, reasonRequired: false });
  const opened = await ok("/school/attendance/sessions", { sectionId: section.id, date: day, period: "Daily" });
  await ok(`/school/attendance/sessions/${opened.session.id}`, { version: opened.session.version, submit: true, marks: opened.marks.map((m: any) => ({ studentId: m.student_id, codeId: code.id, note: "Synthetic note" })) }, "put");
  const preview = await previewFinancialReport(db, owner, auth.hash, { unitId: unit.id, reportId: randomUUID(), expectedVersion: 0, metadata: { title: "Synthetic XLSX finances", sourceName: "Synthetic CSV", currency: "USD", kind: "actual", basis: "period_activity", from: day, to: day, note: "" }, csv: "lineCode,lineLabel,group,rowKind,amount,note\nA,=Literal label,Operations,detail,0.1,\nB,Other,Operations,detail,0.2,", reason: "Synthetic financial source" });
  finance = await publishFinancialReport(db, owner, auth.hash, preview.id, { sourceHash: preview.sourceHash, fingerprint: preview.fingerprint, reviewed: true });
  const job = (await db.query("SELECT job_id FROM user_jobs WHERE user_id=$1 LIMIT 1", [teacher.id])).rows[0].job_id;
  const pay = { userId: teacher.id, jobId: job, expectedVersion: 0, rates: [{ id: randomUUID(), startsOn: `${year}-01-01`, endsOn: null, amount: "18.125", currency: "USD", basis: "hour", voided: false, note: "Synthetic pay" }], reason: "Synthetic pay evidence" };
  const pp = await previewCompensation(db, owner, pay, auth.hash); await saveCompensation(db, owner, { ...pay, previewHash: pp.previewHash, reviewed: true, commandId: randomUUID() }, auth.hash);
  for (const source of ["workforce", "care", "grades", "attendance", "finance", "compensation"] as const) frozen.set(source, await captured(def(source)));
});
after(async () => { await db?.close(); });

test("normal private setup sessions export all six retained sources with content-safe audit and untouched files", async () => {
  for (const [source, value] of frozen) {
    const json = await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "json"), csv = await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "csv");
    const result = await exportReportSnapshotXlsx(db, owner, auth.hash, value.report.id, value.id);
    assert.ok(result.bytes > 100); assert.equal(result.payloadHash, json.payloadHash); assert.equal(sha256(result.buffer), result.hash);
    assert.equal((await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "json")).content, json.content);
    assert.equal((await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "csv")).content, csv.content);
    const audit = (await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND detail->>'format'='xlsx' ORDER BY created_at DESC LIMIT 1", [value.id])).rows[0].detail;
    assert.equal(audit.exportHash, result.hash); assert.equal(audit.bytes, result.bytes); assert.deepEqual(Object.keys(audit).sort(), ["bytes", "csvHash", "exportFormatVersion", "exportHash", "format", "jsonHash", "payloadHash", "reportId"].sort(), source);
  }
});
test("same private layout can retain and export both legacy and v2 after archive", async () => {
  const old = frozen.get("workforce")!, legacy = await readReportSnapshot(db, owner, auth.hash, old.report.id, old.id, "json");
  const changed = await saveReport(db, owner, auth.hash, { id: old.report.id, version: 1, name: old.report.name, description: "V2 amendment", definition: initialWorkforceDefinitionV2(), archived: false, reason: "Explicit precision change" });
  const preview = await prepareReportSnapshot(db, owner, auth.hash, changed.id, { version: 2 });
  const result = await captureReportSnapshot(db, owner, auth.hash, changed.id, { version: 2, previewId: preview.id, payloadHash: preview.payloadHash, commandId: randomUUID(), reviewed: true, reason: "Reviewed precise evidence" });
  await saveReport(db, owner, auth.hash, { id: changed.id, version: 2, name: changed.name, description: "Archived", definition: changed.definition, archived: true, reason: "Retain old evidence" });
  for (const id of [old.id, result.snapshot.id]) assert.ok((await exportReportSnapshotXlsx(db, owner, auth.hash, changed.id, id)).bytes > 100);
  assert.equal((await readReportSnapshot(db, owner, auth.hash, old.report.id, old.id, "json")).content, legacy.content);
});
test("current role revocation after worker generation denies every full-source export without audit", async () => {
  for (const value of frozen.values()) {
    const count = await auditCount(value.id);
    try { await assert.rejects(exportReportSnapshotXlsx(wrapped(async () => { await db.query("UPDATE users SET role='employee' WHERE id=$1", [owner.id]); }), owner, auth.hash, value.report.id, value.id), (e: any) => e.status === 404); }
    finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
    assert.equal(await auditCount(value.id), count);
  }
});
test("teacher membership and assignment revocation between copy and publication denies frozen grade data", async () => {
  const value = await captured(def("grades"), teacher, teacherAuth);
  for (const table of ["user_units", "section_teachers"]) {
    const where = table === "user_units" ? "unit_id" : "section_id", id = table === "user_units" ? unit.id : section.id;
    try { await assert.rejects(exportReportSnapshotXlsx(wrapped(async () => { await db.query(`DELETE FROM ${table} WHERE user_id=$1 AND ${where}=$2`, [teacher.id, id]); }), teacher, teacherAuth.hash, value.report.id, value.id), (e: any) => e.status === 404); }
    finally {
      if (table === "section_teachers") await db.query("INSERT INTO section_teachers(org_id,user_id,section_id,unit_id) VALUES($1,$2,$3,$4)", [teacher.org_id, teacher.id, id, unit.id]);
      else await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [teacher.org_id, teacher.id, id]);
    }
  }
  assert.equal(await auditCount(value.id), 0);
});
test("current proof revocation after generation denies cached actor and permits later normal login", async () => {
  const value = frozen.get("finance")!, before = await auditCount(value.id);
  await assert.rejects(exportReportSnapshotXlsx(wrapped(async () => { await db.query("DELETE FROM sessions WHERE token_hash=$1", [auth.hash]); }), owner, auth.hash, value.report.id, value.id), (e: any) => e.status === 401);
  assert.equal(await auditCount(value.id), before); await loginOwner(); assert.ok((await exportReportSnapshotXlsx(db, owner, auth.hash, value.report.id, value.id)).bytes);
});
test("new enabled-factor state after generation rejects an ordinary password proof", async () => {
  const value = frozen.get("finance")!, before = await auditCount(value.id);
  // Controlled negative state in the isolated database; not a factor-enrollment acceptance claim.
  try {
    await assert.rejects(exportReportSnapshotXlsx(wrapped(async () => {
      await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic-unused-digest',clock_timestamp(),clock_timestamp())", [owner.id, owner.org_id, randomUUID()]);
    }), owner, auth.hash, value.report.id, value.id), (e: any) => e.status === 401);
  } finally { await db.query("DELETE FROM mfa_factors WHERE user_id=$1 AND org_id=$2", [owner.id, owner.org_id]); }
  assert.equal(await auditCount(value.id), before);
});
test("export audit failure and controlled final expiry roll back audit and leave retained history unchanged", async () => {
  const value = frozen.get("workforce")!, before = await auditCount(value.id), json = await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "json");
  for (const expiry of [false, true]) {
    const fail = wrapped(undefined, async (tx, sql, params) => {
      if (sql.startsWith("INSERT INTO audit_events") && params[3] === "report_snapshot.exported") {
        if (!expiry) throw new Error("Synthetic audit rollback");
        await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [auth.hash]);
      }
    });
    await assert.rejects(exportReportSnapshotXlsx(fail, owner, auth.hash, value.report.id, value.id), (e: any) => expiry ? e.status === 401 : e.message === "Synthetic audit rollback");
    assert.equal(await auditCount(value.id), before); assert.equal((await readReportSnapshot(db, owner, auth.hash, value.report.id, value.id, "json")).content, json.content);
  }
});
test("client cancellation after export audit rolls that audit back before publication", async () => {
  const value = frozen.get("finance")!, before = await auditCount(value.id), controller = new AbortController();
  const cancel = wrapped(undefined, async (_tx, sql, params) => { if (sql.startsWith("INSERT INTO audit_events") && params[3] === "report_snapshot.exported") controller.abort(); });
  await assert.rejects(exportReportSnapshotXlsx(cancel, owner, auth.hash, value.report.id, value.id, controller.signal), (e: any) => e.status === 499);
  assert.equal(await auditCount(value.id), before);
  assert.ok((await exportReportSnapshotXlsx(db, owner, auth.hash, value.report.id, value.id)).bytes);
});
test("other private account organization and changed onboarding state cannot export", async () => {
  const value = frozen.get("finance")!;
  await assert.rejects(exportReportSnapshotXlsx(db, teacher, teacherAuth.hash, value.report.id, value.id), (e: any) => e.status === 404);
  await assert.rejects(exportReportSnapshotXlsx(db, { ...owner, org_id: randomUUID() }, auth.hash, value.report.id, value.id), (e: any) => e.status === 403);
  try { await assert.rejects(exportReportSnapshotXlsx(wrapped(async () => { await db.query("UPDATE users SET requires_credential_change=true WHERE id=$1", [owner.id]); }), owner, auth.hash, value.report.id, value.id), (e: any) => e.status === 403); }
  finally { await db.query("UPDATE users SET requires_credential_change=false WHERE id=$1", [owner.id]); }
});
test("HTTP XLSX download has independent byte/source hashes and private MIME response", async () => {
  const value = frozen.get("finance")!, path = `/api/report-library/${value.report.id}/snapshots/${value.id}/export?format=xlsx`;
  const response = await request(app).get(path).set("Cookie", auth.cookie).buffer(true).parse((res, callback) => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => callback(null, Buffer.concat(chunks))); });
  assert.equal(response.status, 200); assert.equal(response.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers["x-export-sha256"], digest(response.body)); assert.equal(Number(response.headers["content-length"]), response.body.length); assert.equal(response.headers["x-export-format-version"], "1");
  assert.match(response.headers["content-disposition"], new RegExp(`stjw-snapshot-${value.id}\\.xlsx`)); assert.equal(response.headers["cache-control"], "private, no-store"); assert.equal(response.headers["x-snapshot-sha256"], undefined);
  assert.equal((await request(app).get(path)).status, 401);
  const pin = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: owner.email, mode: "pin", credential: "7391286" }); assert.equal(pin.status, 200);
  const pinCookie = String(pin.headers["set-cookie"][0]).split(";")[0]; assert.equal((await request(app).get(path).set("Cookie", pinCookie)).status, 403);
  await assert.rejects(exportReportSnapshotXlsx(db, { ...owner, mode: "pin" }, auth.hash, value.report.id, value.id), (e: any) => e.status === 403);
  const token = await ok("/tokens", { name: "Synthetic read token", scopes: ["reports:read"], days: 1 }); assert.equal((await request(app).get(path).set("Authorization", "Bearer " + token.token)).status, 403);
  assert.equal((await request(app).get(path + "&extra=true").set("Cookie", auth.cookie)).status, 400);
});
test("unsupported source text returns actionable 422 and no successful XLSX audit", async () => {
  const row = await saveReport(db, owner, auth.hash, { id: randomUUID(), version: 0, name: "Unsupported _x0041_ text", description: "Synthetic", definition: initialDefinition("workforce"), archived: false, reason: "Synthetic representability case" });
  const preview = await prepareReportSnapshot(db, owner, auth.hash, row.id, { version: 1 }), result = await captureReportSnapshot(db, owner, auth.hash, row.id, { version: 1, previewId: preview.id, payloadHash: preview.payloadHash, commandId: randomUUID(), reviewed: true, reason: "Reviewed synthetic case" });
  const response = await request(app).get(`/api/report-library/${row.id}/snapshots/${result.snapshot.id}/export?format=xlsx`).set("Cookie", auth.cookie);
  assert.equal(response.status, 422); assert.match(JSON.stringify(response.body), /original JSON or CSV/); assert.equal(response.headers["x-export-sha256"], undefined); assert.equal(await auditCount(result.snapshot.id), 0);
  assert.ok((await readReportSnapshot(db, owner, auth.hash, row.id, result.snapshot.id, "json")).content!.includes("_x0041_"));
});
