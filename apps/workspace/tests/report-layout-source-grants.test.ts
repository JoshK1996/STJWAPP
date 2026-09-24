import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { initialDefinition, type ReportDefinition } from "../shared/report-library";
import { saveReport } from "../server/report-library";

const origin = "http://localhost:3000", options = { origin, production: false, staffDomain: "stjw.org", demo: true };
const password = "Synthetic-grant-" + randomUUID();
type Auth = { cookie: string; hash: string; csrf: string; actor: Actor };
let db: Database, app: ReturnType<typeof createApp>, owner: Auth, unit: Row, year: Row, term: Row, student: Row;
function send(target: ReturnType<typeof createApp>, auth: Auth, path: string, body?: unknown, method = "post") {
  return (request(target) as any)[method]("/api" + path).set("Cookie", auth.cookie).set("Origin", origin).set("X-CSRF-Token", auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = owner, method = "post") {
  const response = await send(app, auth, path, body, method);
  assert.ok(response.status < 300, `Synthetic source fixture ${path}: ${response.status}`); return response.body;
}
async function authenticated(response: any): Promise<Auth> {
  assert.equal(response.status, 200); const cookie = String(response.headers["set-cookie"][0]).split(";")[0];
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { cookie, hash: digest(cookie.slice(cookie.indexOf("=") + 1)), csrf: me.body.actor.csrf, actor: me.body.actor };
}
async function person() {
  const email = randomUUID() + "@stjw.org", created = await ok("/staff", { name: "Synthetic source reviewer", email, role: "employee", unitIds: [unit.id], jobIds: [] });
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token: new URL(created.setupUrl).hash.slice(7), password }); assert.equal(setup.status, 200);
  return authenticated(await request(app).post("/api/auth/login").set("Origin", origin).send({ email, mode: "password", credential: password }));
}
const input = (definition: ReportDefinition) => ({ id: randomUUID(), version: 0, name: "Synthetic authorized layout", description: "Isolated synthetic grant evidence", definition, archived: false, reason: "Synthetic reviewed source layout" });
const attendance = (sectionIds: string[] = [], yearId = year.id): ReportDefinition => ({ ...initialDefinition("attendance"), unitId: unit.id, yearId, sectionIds, period: "Daily" }) as ReportDefinition;
const grades = (bookId: string): ReportDefinition => ({ ...initialDefinition("grades"), bookId }) as ReportDefinition;
const care = (programId: string): ReportDefinition => ({ ...initialDefinition("care"), programId }) as ReportDefinition;
async function office(auth: Auth, enabled = true) { await ok("/school/office-grants", { unitId: unit.id, userId: auth.actor.id, enabled }); }
async function section(auth?: Auth, yearId = year.id) {
  return ok("/school/sections", { unitId: unit.id, yearId, courseId: null, name: "Synthetic class " + randomUUID(), homeroom: false, capacity: 20, room: "", teacherIds: auth ? [auth.actor.id] : [] });
}
async function teachers(row: Row, ids: string[]) {
  return ok(`/school/sections/${row.id}`, { name: row.name, room: row.room, capacity: row.capacity, version: row.version, teacherIds: ids }, owner, "patch");
}
async function teacherFixture() {
  const auth = await person(), row = await section(auth);
  await ok(`/school/sections/${row.id}/roster`, { studentId: student.id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const book = await ok("/school/gradebooks", { sectionId: row.id, termId: term.id }, auth);
  return { auth, section: row, book };
}
async function program(staffIds: string[] = []) {
  return ok("/care/programs", { unitId: unit.id, name: "Synthetic source program", room: "Synthetic room", capacity: 20, instructions: "Synthetic source-only instructions", confirmed: true, archived: false, staffIds, version: 0, reason: "Synthetic source grant fixture" });
}
async function counts(id: string) {
  return (await db.query(`SELECT (SELECT count(*)::int FROM saved_reports WHERE id=$1) AS reports,
    (SELECT count(*)::int FROM saved_report_history WHERE report_id=$1) AS history,
    (SELECT count(*)::int FROM audit_events WHERE target_id=$1::text AND action='report_library.saved') AS audits`, [id])).rows[0];
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "grant.layout.owner@example.test" }); app = createApp(db, options);
  const row = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0], token = await db.transaction(tx => issueSetup(tx, row as { id: string; org_id: string }));
  owner = await authenticated(await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }));
  unit = (await db.query("SELECT id FROM units WHERE kind='school' ORDER BY id LIMIT 1")).rows[0];
  year = await ok("/school/years", { unitId: unit.id, name: "Synthetic grant year", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  term = await ok("/school/terms", { yearId: year.id, name: "Synthetic grant term", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  student = await ok("/school/students", { unitId: unit.id, name: "Synthetic grant student", studentNumber: "SYNTHETIC-GRANT" });
  await ok(`/school/students/${student.id}/enrollments`, { enrollment: { yearId: year.id, gradeLevel: "Synthetic", startsOn: "2026-01-01", endsOn: "2026-12-31", status: "enrolled" } });
  await ok("/school/grading/settings", { unitId: unit.id, version: 0, confirmed: true, policy: { name: "Synthetic grant-only grading", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: randomUUID(), name: "Practice", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] }, reason: "Synthetic source fixture, no school policy" }, owner, "put");
});
after(async () => { await db?.close(); });

// Controlled faults exercise whole-attempt handling, not independent PostgreSQL
// row blocking. Each actor and proof still comes from ordinary setup/sign-in.
function controlled(hook: (sql: string, values: any[], attempt: number, after: boolean) => Promise<void>, afterRollback?: (attempt: number) => Promise<void>) {
  let attempts = 0; const sqls: string[] = [];
  const wrapped: Database = { ...db, transaction: async fn => {
    const attempt = ++attempts;
    try { return await db.transaction(tx => fn({ query: async <T extends Row = Row>(sql: string, values: any[] = []) => {
      sqls.push(sql); await hook(sql, values, attempt, false); const result = await tx.query<T>(sql, values); await hook(sql, values, attempt, true); return result;
    } })); } catch (error) { await afterRollback?.(attempt); throw error; }
  } };
  return { db: wrapped, app: createApp(wrapped, options), attempts: () => attempts, sqls };
}
const failure = (code: string) => Object.assign(new Error("Synthetic controlled database contention"), { code });
const grantSql = (sql: string) => sql.includes("NOWAIT");

test("normal-auth teacher grades and attendance lock exact grants after account UPDATE, with no source parent locks", async () => {
  const f = await teacherFixture(), trace = controlled(async () => {});
  for (const definition of [grades(f.book.id), attendance([f.section.id])]) {
    const response = await send(trace.app, f.auth, "/report-library", input(definition)); assert.equal(response.status, 200);
  }
  const grants = trace.sqls.filter(grantSql); assert.ok(grants.some(sql => sql.includes("FROM section_teachers"))); assert.ok(grants.every(sql => sql.includes("FOR SHARE") && sql.includes("NOWAIT")));
  assert.match(trace.sqls.find(sql => sql.includes("FROM users") && sql.includes("FOR "))!, /FOR UPDATE$/);
  assert.ok(!trace.sqls.some(sql => sql.includes("pg_advisory") || /FROM (sections|gradebooks|care_programs).*FOR (UPDATE|SHARE)/s.test(sql)));
});
test("normal-auth teacher removal denies active grade save and restore while preserving archived custody", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id)); assert.equal((await send(app, f.auth, "/report-library", value)).status, 200);
  await teachers(f.section, []);
  assert.equal((await send(app, f.auth, "/report-library", { ...value, version: 1 })).status, 404);
  const noGrants = controlled(async sql => { if (grantSql(sql)) throw new Error("Archived metadata must not acquire source grants"); });
  assert.equal((await send(noGrants.app, f.auth, "/report-library", { ...value, version: 1, archived: true })).status, 200);
  assert.equal((await send(noGrants.app, f.auth, "/report-library", undefined, "get")).status, 200);
  assert.equal((await send(noGrants.app, f.auth, `/report-library/${value.id}/history`, undefined, "get")).status, 200);
  assert.equal((await send(app, f.auth, "/report-library", { ...value, version: 2 })).status, 404);
  assert.deepEqual(await counts(value.id), { reports: 1, history: 2, audits: 2 });
});
test("normal-auth care staff alone cannot save care reports; office without care assignment can", async () => {
  const assigned = await person(), officeOnly = await person(), row = await program([assigned.actor.id]);
  assert.equal((await send(app, assigned, "/report-library", input(care(row.id)))).status, 403);
  await office(officeOnly); const trace = controlled(async () => {}), value = input(care(row.id));
  assert.equal((await send(trace.app, officeOnly, "/report-library", value)).status, 200);
  assert.ok(trace.sqls.some(sql => sql.includes("school_office_grants") && grantSql(sql))); assert.ok(!trace.sqls.some(sql => sql.includes("care_staff")));
  await office(officeOnly, false); assert.equal((await send(app, officeOnly, "/report-library", { ...value, version: 1 })).status, 404);
});
test("normal-auth office authorizes unassigned grades and attendance; teacher fallback survives office loss", async () => {
  const f = await teacherFixture(), reviewer = await person(); await office(reviewer);
  for (const definition of [grades(f.book.id), attendance([f.section.id])]) assert.equal((await send(app, reviewer, "/report-library", input(definition))).status, 200);
  await office(reviewer, false);
  assert.equal((await send(app, reviewer, "/report-library", input(grades(f.book.id)))).status, 404);
  assert.equal((await send(app, reviewer, "/report-library", input(attendance([f.section.id])))).status, 403);
  await office(f.auth); await office(f.auth, false);
  assert.equal((await send(app, f.auth, "/report-library", input(grades(f.book.id)))).status, 200);
});
test("normal-auth empty attendance selector stays dynamic and never authorizes an unassigned explicit class", async () => {
  const auth = await person(), a = await section(auth), other = await section(), value = input(attendance());
  assert.equal((await send(app, auth, "/report-library", value)).status, 200);
  await section(auth); const changed = await send(app, auth, "/report-library", { ...value, version: 1 }); assert.equal(changed.status, 200); assert.deepEqual(changed.body.definition.sectionIds, []);
  assert.equal((await send(app, auth, "/report-library", input(attendance([a.id, other.id])))).status, 403);
  assert.equal((await send(app, auth, "/report-library", input(attendance([], randomUUID())))).status, 404);
});
test("normal-auth empty attendance year is allowed to office but not an unassigned teacher", async () => {
  const auth = await person(), empty = await ok("/school/years", { unitId: unit.id, name: "Synthetic empty year", startsOn: "2027-01-01", endsOn: "2027-12-31" });
  assert.equal((await send(app, auth, "/report-library", input(attendance([], empty.id)))).status, 403);
  await office(auth); assert.equal((await send(app, auth, "/report-library", input(attendance([], empty.id)))).status, 200);
});
test("normal-auth teacher attendance discovers1000 grants, preserves50 IDs and rejects1001 without partial save", async () => {
  const auth = await person(), bulkYear = await ok("/school/years", { unitId: unit.id, name: "Synthetic boundary year", startsOn: "2028-01-01", endsOn: "2028-12-31" });
  // Bulk synthetic domain fixtures only; session/authentication remains normal.
  const ids = Array.from({ length: 1000 }, () => randomUUID());
  await db.transaction(async tx => {
    await tx.query("INSERT INTO sections(id,org_id,unit_id,year_id,name,homeroom,capacity,room) SELECT id,$2,$3,$4,'Synthetic class '||id::text,false,20,'' FROM unnest($1::uuid[]) AS id", [ids, owner.actor.org_id, unit.id, bulkYear.id]);
    await tx.query("INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) SELECT $2,$3,id,$4 FROM unnest($1::uuid[]) AS id", [ids, owner.actor.org_id, unit.id, auth.actor.id]);
  });
  const chosen = input(attendance(ids.slice(0, 50), bulkYear.id)), result = await send(app, auth, "/report-library", chosen); assert.equal(result.status, 200); assert.deepEqual(result.body.definition.sectionIds, ids.slice(0, 50));
  assert.equal((await send(app, auth, "/report-library", input(attendance(ids.slice(0, 51), bulkYear.id)))).status, 400);
  await section(auth, bulkYear.id); const tooMany = input(attendance([], bulkYear.id)); assert.equal((await send(app, auth, "/report-library", tooMany)).status, 400); assert.deepEqual(await counts(tooMany.id), { reports: 0, history: 0, audits: 0 });
});
test("controlled grant contention retries full normal-auth attempt twice then commits once", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, _values, attempt, after) => { if (!after && grantSql(sql) && attempt < 3) throw failure("55P03"); });
  assert.equal((await send(fault.app, f.auth, "/report-library", value)).status, 200); assert.equal(fault.attempts(), 3);
  assert.equal(fault.sqls.filter(sql => sql.includes("FROM users") && sql.endsWith("FOR UPDATE")).length, 3);
  assert.deepEqual(await counts(value.id), { reports: 1, history: 1, audits: 1 });
});
test("controlled persistent grant contention returns503 after exactly3 complete attempts", async () => {
  const auth = await person(), row = await program(); await office(auth); const value = input(care(row.id));
  const fault = controlled(async (sql, _values, _attempt, after) => { if (!after && grantSql(sql)) throw failure("55P03"); });
  const response = await send(fault.app, auth, "/report-library", value); assert.equal(response.status, 503); assert.match(response.body.error, /Retry this save/); assert.equal(fault.attempts(), 3);
  assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
test("controlled serialization and grant contention share one3-attempt budget", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, _values, attempt, after) => {
    if (!after && attempt === 1 && sql.includes("FROM saved_reports")) throw failure("40001");
    if (!after && attempt > 1 && grantSql(sql)) throw failure("55P03");
  });
  assert.equal((await send(fault.app, f.auth, "/report-library", value)).status, 503); assert.equal(fault.attempts(), 3); assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
test("controlled non-grant55P03 is neither tagged nor retried", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, _values, _attempt, after) => { if (!after && sql.includes("FROM saved_reports")) throw failure("55P03"); });
  await assert.rejects(saveReport(fault.db, f.auth.actor, f.auth.hash, value), error => (error as any).code === "55P03"); assert.equal(fault.attempts(), 1);
});
test("normal-auth teacher removal after controlled rollback is re-read on retry", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, _values, attempt, after) => { if (after && attempt === 1 && sql.includes("FROM section_teachers") && grantSql(sql)) throw failure("55P03"); }, async attempt => { if (attempt === 1) await teachers(f.section, []); });
  assert.equal((await send(fault.app, f.auth, "/report-library", value)).status, 404); assert.equal(fault.attempts(), 2); assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
test("normal-auth office revoke after controlled rollback is re-read on retry", async () => {
  const auth = await person(), row = await program(); await office(auth); const value = input(care(row.id));
  const fault = controlled(async (sql, _values, attempt, after) => { if (!after && attempt === 1 && grantSql(sql)) throw failure("55P03"); }, async attempt => { if (attempt === 1) await office(auth, false); });
  assert.equal((await send(fault.app, auth, "/report-library", value)).status, 404); assert.equal(fault.attempts(), 2); assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
test("normal-auth real logout between controlled retries denies the next full attempt", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, _values, attempt, after) => { if (!after && attempt === 1 && grantSql(sql)) throw failure("55P03"); }, async attempt => { if (attempt === 1) await ok("/auth/logout", {}, f.auth); });
  assert.equal((await send(fault.app, f.auth, "/report-library", value)).status, 401); assert.equal(fault.attempts(), 2); assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
test("active exact replay is reauthorized after grant loss and never returns private layout metadata", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id)); const created = await send(app, f.auth, "/report-library", value); assert.equal(created.status, 200);
  await teachers(f.section, []); const denied = await send(app, f.auth, "/report-library", value); assert.equal(denied.status, 404); assert.equal(denied.body.definition, undefined); assert.deepEqual(await counts(value.id), { reports: 1, history: 1, audits: 1 });
});
test("normal-auth source grant save and all history writes roll back on late audit failure", async () => {
  const f = await teacherFixture(), value = input(grades(f.book.id));
  const fault = controlled(async (sql, values, _attempt, after) => { if (after && sql.startsWith("INSERT INTO audit_events") && values[3] === "report_library.saved") throw new Error("Synthetic post-grant audit failure"); });
  await assert.rejects(saveReport(fault.db, f.auth.actor, f.auth.hash, value), /Synthetic post-grant audit failure/); assert.equal(fault.attempts(), 1); assert.deepEqual(await counts(value.id), { reports: 0, history: 0, audits: 0 });
});
