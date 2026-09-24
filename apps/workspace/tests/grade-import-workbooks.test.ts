import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import request from "supertest";
import ExcelJS from "exceljs";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { inspectImportWorkbook, convertImportWorkbook, downloadImportWorkbookTemplate } from "../server/import-workbooks";
import { parseGradeCsv } from "../server/grade-imports";
import { workbookConvertResultSchemaFor } from "../shared/import-workbooks";

const origin = "http://localhost:3000", password = "Synthetic-grade-workbook-" + randomUUID();
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Auth = { actor: Actor; cookie: string; csrf: string; hash: string };
let db: Database, app: ReturnType<typeof createApp>, owner: Auth, teacher: Auth, office: Auth, outsider: Auth;
let unitId: string, teacherEmail: string, section: any, student: any, book: any, assignment: any;
const scope = () => ({ kind: "grade_scores" as const, assignmentId: assignment.id });
async function authenticated(headers: unknown): Promise<Auth> {
  assert.ok(Array.isArray(headers)); const cookie = String(headers[0]).split(";")[0];
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
}
async function send(who: Auth, path: string, body: object, method: "post" | "put" | "patch" = "post") {
  return request(app)[method](path).set("Origin", origin).set("Cookie", who.cookie).set("X-CSRF-Token", who.csrf).send(body);
}
async function ok(who: Auth, path: string, body: object, method: "post" | "put" | "patch" = "post") {
  const response = await send(who, path, body, method); assert.ok(response.status < 300, JSON.stringify(response.body)); return response.body;
}
async function provision(role: "employee" | "finance") {
  const email = randomUUID() + "@example.test";
  const created = await ok(owner, "/api/staff", { name: "Synthetic workbook " + role, email, role, unitIds: [unitId], jobIds: [] });
  const token = new URL(created.setupUrl).hash.slice(7);
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  return { auth: await authenticated(setup.headers["set-cookie"]), email };
}
async function detail() { const response = await request(app).get(`/api/school/gradebooks/${book.id}`).set("Cookie", owner.cookie); assert.equal(response.status, 200); return response.body; }
async function score(pointsUnits: number, note = "=Literal current note\nsecond line") {
  const current = await detail(), item = current.assignments.find((x: any) => x.id === assignment.id);
  return ok(owner, `/api/school/grade-assignments/${assignment.id}/scores`, { version: item.version, bookVersion: current.book.version, scores: [{ studentId: student.id, status: "scored", pointsUnits, note }], reason: "Synthetic workbook source change" }, "put");
}
async function teachers(ids: string[]) {
  const current = (await db.query("SELECT version FROM sections WHERE id=$1", [section.id])).rows[0];
  await ok(owner, `/api/school/sections/${section.id}`, { name: section.name, capacity: 30, teacherIds: ids, version: current.version }, "patch");
}
async function grant(enabled: boolean) { await ok(owner, "/api/school/office-grants", { unitId, userId: office.actor.id, enabled }); }
function wrapped(beforeFinal?: () => Promise<void>, afterQuery?: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  let transactions = 0;
  return { ...db, transaction: async action => {
    transactions++; if (transactions === 2 && beforeFinal) await beforeFinal();
    return db.transaction(tx => action({ query: async<T extends Row>(sql: string, params: any[] = []) => {
      const result = await tx.query<T>(sql, params); if (afterQuery) await afterQuery(tx, sql, params); return result;
    } }));
  } };
}
async function auditCount() { return Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'import.workbook_%'")).rows[0].n); }
async function uploaded(points: string | number = "12.50") {
  const template = await downloadImportWorkbookTemplate(db, teacher.actor, teacher.hash, scope());
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(template.buffer as any);
  workbook.worksheets[0].getCell("G2").value = points;
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, input: { ...scope(), base64: buffer.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(buffer) } };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "synthetic.grade-workbook@example.test" });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: "example.test" });
  const person = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, person as { id: string; org_id: string }));
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  owner = await authenticated(setup.headers["set-cookie"]);
  const me = await request(app).get("/api/me").set("Cookie", owner.cookie); unitId = me.body.units.find((u: any) => u.kind === "school").id;
  const personTeacher = await provision("employee"); teacher = personTeacher.auth; teacherEmail = personTeacher.email;
  office = (await provision("employee")).auth; outsider = (await provision("finance")).auth; await grant(true);
  const year = await ok(owner, "/api/school/years", { unitId, name: "Synthetic workbook year", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const term = await ok(owner, "/api/school/terms", { yearId: year.id, name: "Synthetic term", startsOn: "2026-01-01", endsOn: "2026-06-30" });
  section = await ok(owner, "/api/school/sections", { unitId, yearId: year.id, name: "Synthetic workbook class", homeroom: false, capacity: 30, teacherIds: [teacher.actor.id] });
  student = await ok(owner, "/api/school/students", { unitId, name: '=Captured student, "café"', studentNumber: "000013" });
  await ok(owner, `/api/school/students/${student.id}/enrollments`, { enrollment: { yearId: year.id, gradeLevel: "Explicit synthetic grade", startsOn: "2026-01-01", endsOn: "2026-12-31" } });
  await ok(owner, `/api/school/sections/${section.id}/roster`, { studentId: student.id, startsOn: "2026-01-01", endsOn: "2026-06-30" });
  const config = await request(app).get(`/api/school/grading/settings?unitId=${unitId}`).set("Cookie", owner.cookie), category = randomUUID();
  await ok(owner, "/api/school/grading/settings", { unitId, version: config.body.version, confirmed: true, reason: "Explicit synthetic test rules, not school policy", policy: { name: "Synthetic workbook fixture", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: category, name: "Synthetic", weight: 10000 }], scale: [{ label: "A", minimum: 0 }] } }, "put");
  book = await ok(teacher, "/api/school/gradebooks", { sectionId: section.id, termId: term.id });
  assignment = await ok(teacher, "/api/school/grade-assignments", { bookId: book.id, bookVersion: book.version, commandId: randomUUID(), title: "Synthetic assignment", instructions: "", categoryId: category, dueOn: "2026-03-15", maxPointsUnits: 10000 });
  await score(1025);
});
after(async () => { await db?.close(); });

test("current teacher receives populated literal-text XLSX from captured roster and exact source versions", async () => {
  const current = await detail(), before = await db.query("SELECT count(*)::int AS n FROM grade_import_batches");
  const template = await downloadImportWorkbookTemplate(db, teacher.actor, teacher.hash, scope());
  assert.equal(template.hash, sha(template.buffer));
  const result = await convertImportWorkbook(db, teacher.actor, teacher.hash, { ...scope(), base64: template.buffer.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: template.hash });
  workbookConvertResultSchemaFor("grade_scores").parse(result);
  const rows = parseGradeCsv(result.csv); assert.equal(rows.length, 1); assert.equal(rows[0].studentId, student.id); assert.equal(rows[0].studentName, '=Captured student, "café"');
  assert.equal(rows[0].bookVersion, String(current.book.version)); assert.equal(rows[0].points, "10.25"); assert.equal(rows[0].note, "=Literal current note\nsecond line");
  assert.deepEqual((await db.query("SELECT count(*)::int AS n FROM grade_import_batches")).rows, before.rows);
  assert.deepEqual((await detail()).scores, current.scores);
  const event = (await db.query("SELECT detail FROM audit_events WHERE action='import.workbook_template_downloaded' ORDER BY created_at DESC LIMIT 1")).rows[0].detail;
  assert.equal(event.assignmentId, assignment.id); assert.equal(event.bookVersion, current.book.version); assert.match(event.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(event).includes("Captured student") && !JSON.stringify(event).includes("Literal current note"));
});

test("converted scores require the existing explicit all-row CSV preview and apply before any grade changes", async () => {
  const uploadedFile = await uploaded(), before = await detail();
  const result = await convertImportWorkbook(db, teacher.actor, teacher.hash, uploadedFile.input);
  assert.deepEqual((await detail()).scores, before.scores);
  const preview = await ok(teacher, `/api/school/grade-assignments/${assignment.id}/import-previews`, { csv: result.csv, reason: "Reviewed synthetic workbook score" });
  assert.equal(preview.plan.errors, 0); assert.equal(preview.plan.changed, 1);
  const applied = await ok(teacher, `/api/school/grade-imports/${preview.id}/apply`, { sourceHash: preview.sourceHash, planHash: preview.planHash, reviewed: true });
  assert.equal(applied.id, preview.id); assert.equal(applied.assignmentId, assignment.id); assert.equal(applied.changed, 1); assert.ok(applied.bookVersion > applied.beforeBookVersion);
  assert.equal((await detail()).scores.find((s: any) => s.assignment_id === assignment.id).points_units, 1250);
});

test("grade scope requires actual teacher or office authority and a current password session", async () => {
  const file = await uploaded();
  for (const hash of [undefined, "f".repeat(64)]) await assert.rejects(downloadImportWorkbookTemplate(db, teacher.actor, hash, scope()), (e: any) => e.status === 401);
  await assert.rejects(inspectImportWorkbook(db, { ...outsider.actor, role: "owner" }, outsider.hash, { ...scope(), base64: "Zh==" }), (e: any) => [403, 404].includes(e.status));
  await assert.rejects(downloadImportWorkbookTemplate(db, teacher.actor, owner.hash, scope()), (e: any) => e.status === 401);
  await assert.rejects(downloadImportWorkbookTemplate(db, owner.actor, owner.hash, { ...scope(), assignmentId: randomUUID() }), (e: any) => e.status === 404);
  assert.equal((await inspectImportWorkbook(db, office.actor, office.hash, { ...scope(), base64: file.buffer.toString("base64") })).workbookHash, sha(file.buffer));
});

test("actual teacher and office grant removals after parsing prevent private result and coordinate-error publication", async () => {
  const good = await uploaded(), bad = await uploaded(12.5);
  for (const file of [good, bad]) {
    const before = await auditCount();
    try { await assert.rejects(convertImportWorkbook(wrapped(async () => teachers([])), teacher.actor, teacher.hash, file.input), (e: any) => [403, 404].includes(e.status)); assert.equal(await auditCount(), before); }
    finally { await teachers([teacher.actor.id]); }
  }
  const before = await auditCount();
  try { await assert.rejects(downloadImportWorkbookTemplate(wrapped(async () => grant(false)), office.actor, office.hash, scope()), (e: any) => [403, 404].includes(e.status)); assert.equal(await auditCount(), before); }
  finally { await grant(true); }
});

test("populated template rejects source changes during generation while uploaded versions remain business-preview authority", async () => {
  const before = await auditCount();
  await assert.rejects(downloadImportWorkbookTemplate(wrapped(async () => { await score(1400); }), teacher.actor, teacher.hash, scope()), (e: any) => e.status === 409 && /changed/.test(e.message));
  assert.equal(await auditCount(), before);
  const old = await uploaded(); await score(1500);
  const result = await convertImportWorkbook(db, teacher.actor, teacher.hash, old.input); assert.equal(result.workbookHash, sha(old.buffer));
  const preview = await ok(teacher, `/api/school/grade-assignments/${assignment.id}/import-previews`, { csv: result.csv, reason: "Synthetic stale workbook validation" });
  assert.ok(preview.plan.errors > 0); assert.ok(preview.plan.rows[0].errors.some((e: string) => /out of date/.test(e)));
});

test("normal logout between worker and publication prevents template delivery and audit", async () => {
  const before = await auditCount(), current = teacher;
  await assert.rejects(downloadImportWorkbookTemplate(wrapped(async () => { await ok(current, "/api/auth/logout", {}); }), current.actor, current.hash, scope()), (e: any) => e.status === 401);
  assert.equal(await auditCount(), before);
  const response = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: teacherEmail, mode: "password", credential: password }); assert.equal(response.status, 200); teacher = await authenticated(response.headers["set-cookie"]);
});

test("academic lock precedes account proof on both sides of the worker and audit failure rolls back publication", async () => {
  const phases: string[][] = [], source: Database = { ...db, transaction: async action => db.transaction(tx => {
    const statements: string[] = []; phases.push(statements);
    return action({ query: async<T extends Row>(sql: string, params: any[] = []) => { statements.push(sql); return tx.query<T>(sql, params); } });
  }) };
  await downloadImportWorkbookTemplate(source, teacher.actor, teacher.hash, scope());
  assert.equal(phases.length, 2);
  for (const phase of phases) { assert.match(phase[0], /pg_advisory_xact_lock/); const user = phase.findIndex(sql => /FROM users.*FOR SHARE/.test(sql)); assert.ok(user > 0); }
  const before = await auditCount();
  await assert.rejects(downloadImportWorkbookTemplate(wrapped(undefined, async (_tx, sql, params) => { if (sql.startsWith("INSERT INTO audit_events") && params[3] === "import.workbook_template_downloaded") throw new Error("Synthetic final publication rollback"); }), teacher.actor, teacher.hash, scope()), /Synthetic final publication rollback/);
  assert.equal(await auditCount(), before);
});

test("HTTP grade workbook endpoint rejects invented context and returns private hashed XLSX bytes", async () => {
  const query = `/api/import-workbooks/template?kind=grade_scores&assignmentId=${assignment.id}`;
  assert.equal((await request(app).get(query)).status, 401);
  for (const suffix of [`&unitId=${unitId}`, `&assignmentId=${assignment.id}`, "&rows=anything"])
    assert.equal((await request(app).get(query + suffix).set("Cookie", teacher.cookie)).status, 400);
  const response = await request(app).get(query).set("Cookie", teacher.cookie).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => done(null, Buffer.concat(chunks))); });
  assert.equal(response.status, 200); assert.equal(response.headers["x-workbook-sha256"], sha(response.body)); assert.equal(response.headers["cache-control"], "private, no-store"); assert.match(response.headers["content-disposition"], /stjw-assignment-scores-template\.xlsx/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(response.body); assert.equal(workbook.worksheets[0].getCell("A2").value, assignment.id);
});
