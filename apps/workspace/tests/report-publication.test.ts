import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { initializeSchoolDemo } from "../server/school-seed";
import { createApp } from "../server/app";
import { runReport, saveReport } from "../server/report-library";
import { initialDefinition, reportDefinition } from "../shared/report-library";
import { digest, opaqueToken, type Actor } from "../server/security";

let db: Database, owner: Actor, teacher: Actor, manager: Actor, unit: Row, section: Row, book: Row, program: Row;
let ownerSession: { hash: string; cookie: string; csrf: string }, teacherSession: typeof ownerSession;
const origin = "http://localhost:3000", year = new Date().getUTCFullYear();
async function session(actor: Actor) {
  const token = opaqueToken(), csrf = opaqueToken(), hash = digest(token);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')", [hash, actor.org_id, actor.id, csrf]);
  return { hash, cookie: "stjw_session=" + token, csrf };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: true, ownerEmail: "publication.owner@example.test" }); await initializeSchoolDemo(db, true);
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  unit = (await db.query("SELECT * FROM units WHERE kind='school'")).rows[0];
  owner = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, unit_ids: [unit.id], mode: "password" };
  section = (await db.query("SELECT * FROM sections WHERE unit_id=$1 ORDER BY name", [unit.id])).rows[0];
  const t = (await db.query("SELECT u.id,u.org_id,u.name,u.email,u.role FROM section_teachers a JOIN users u ON u.id=a.user_id WHERE a.section_id=$1", [section.id])).rows[0];
  teacher = { id: t.id, org_id: t.org_id, name: t.name, email: t.email, role: t.role, unit_ids: [unit.id], mode: "password" };
  const managerId = randomUUID(), units = (await db.query("SELECT id FROM units WHERE org_id=$1", [owner.org_id])).rows.map(x => x.id);
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic publication manager',$3,'manager')", [managerId, owner.org_id, managerId + "@stjw.org"]);
  for (const id of units) await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [owner.org_id, managerId, id]);
  manager = { ...owner, id: managerId, role: "manager", unit_ids: units };
  ownerSession = await session(owner); teacherSession = await session(teacher);
  const app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
  const send = async (path: string, body: unknown, method = "post") => {
    const response = await (request(app) as any)[method]("/api" + path).set("Origin", origin).set("Cookie", ownerSession.cookie).set("X-CSRF-Token", ownerSession.csrf).send(body);
    assert.ok(response.status < 300, JSON.stringify(response.body)); return response.body;
  };
  await send("/school/grading/settings", { unitId: unit.id, version: 0, confirmed: true, policy: { name: "Synthetic publication policy", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: randomUUID(), name: "Practice", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] }, reason: "Synthetic grading fixture" }, "put");
  const term = await send("/school/terms", { yearId: section.year_id, name: "Synthetic annual term", startsOn: `${year}-01-01`, endsOn: `${year}-12-31` });
  book = await send("/school/gradebooks", { sectionId: section.id, termId: term.id });
  program = await send("/care/programs", { unitId: unit.id, name: "Synthetic empty reporting care", room: "Room", capacity: 25, instructions: "Synthetic care instruction", confirmed: true, archived: false, staffIds: [teacher.id], version: 0, reason: "Synthetic care fixture" });
});
after(async () => { await db?.close(); });

// A real committed mutation occurs after the source transaction ends and before
// runReport receives its result. PGlite cannot prove cross-connection waits, but
// this deterministically exercises the publication boundary of the real service.
function afterSource(sqlFragment: string, mutation: () => Promise<unknown>) {
  let mutated = false;
  const wrapped: Database = { ...db, transaction: async fn => {
    let sourceRead = false;
    const result = await db.transaction(tx => fn({ query: async <T extends Row = Row>(sql: string, values?: any[]) => {
      const result = await tx.query<T>(sql, values);
      if (sql.includes(sqlFragment)) sourceRead = true;
      return result;
    } }));
    if (sourceRead && !mutated) { mutated = true; await mutation(); }
    return result;
  } };
  return { db: wrapped, wasMutated: () => mutated };
}
const denied = (e: any) => [401, 403, 404].includes(e.status);
const workforce = () => reportDefinition.parse({ ...initialDefinition("workforce"), layout: "summary", groupBy: "kind", sort: { key: "group_name", direction: "asc" } });
const grades = () => reportDefinition.parse({ ...initialDefinition("grades"), bookId: book.id });

test("ordinary grouped workforce output is denied if the actor loses its privileged role after extraction", async () => {
  const before = await runReport(db, owner, workforce()); assert.ok(before.sourceRowCount > 0);
  const wrapped = afterSource("FROM segments s JOIN shifts", () => db.query("UPDATE users SET role='employee' WHERE id=$1", [owner.id]));
  try { await assert.rejects(runReport(wrapped.db, owner, workforce()), denied); assert.equal(wrapped.wasMutated(), true); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
});

test("ordinary summaries recheck every captured manager unit including a unit hidden by grouping", async () => {
  const before = await runReport(db, manager, workforce()); assert.ok(before.sourceRowCount > before.rowCount);
  const lost = manager.unit_ids[0];
  const wrapped = afterSource("FROM segments s JOIN shifts", () => db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [manager.id, lost]));
  try { await assert.rejects(runReport(wrapped.db, manager, workforce()), denied); assert.equal(wrapped.wasMutated(), true); }
  finally { await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [owner.org_id, manager.id, lost]); }
});

test("ordinary grade results reject a committed teaching-grant removal before publication", async () => {
  const before = await runReport(db, teacher, grades()); assert.ok(before.sourceRowCount > 0);
  const wrapped = afterSource("SELECT * FROM gradebooks", () => db.query("DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2", [section.id, teacher.id]));
  try { await assert.rejects(runReport(wrapped.db, teacher, grades()), denied); assert.equal(wrapped.wasMutated(), true); }
  finally { await db.query("INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, section.id, teacher.id]); }
});

test("empty care results still require current office grant after extraction", async () => {
  await db.query("INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, teacher.id, owner.id]);
  const def = reportDefinition.parse({ ...initialDefinition("care"), programId: program.id });
  const before = await runReport(db, teacher, def); assert.equal(before.sourceRowCount, 0);
  const wrapped = afterSource("FROM care_sessions s JOIN users", () => db.query("DELETE FROM school_office_grants WHERE unit_id=$1 AND user_id=$2", [unit.id, teacher.id]));
  try { await assert.rejects(runReport(wrapped.db, teacher, def), denied); assert.equal(wrapped.wasMutated(), true); }
  finally { await db.query("DELETE FROM school_office_grants WHERE unit_id=$1 AND user_id=$2", [unit.id, teacher.id]); }
  assert.equal((await db.query("SELECT 1 FROM care_staff WHERE program_id=$1 AND user_id=$2", [program.id, teacher.id])).rows.length, 1);
});

test("HTTP preview refuses a session revoked after source extraction instead of returning report bytes", async () => {
  const credential = await session(owner), wrapped = afterSource("FROM segments s JOIN shifts", () => db.query("DELETE FROM sessions WHERE token_hash=$1", [credential.hash]));
  const app = createApp(wrapped.db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
  const response = await request(app).post("/api/report-library/preview").set("Origin", origin).set("Cookie", credential.cookie).set("X-CSRF-Token", credential.csrf).send(workforce());
  assert.equal(wrapped.wasMutated(), true); assert.equal(response.status, 401); assert.equal(response.body.rows, undefined);
});

test("saved report run and CSV export refuse a teacher grant revoked between extraction and delivery", async () => {
  const report = await saveReport(db, teacher, teacherSession.hash, { id: randomUUID(), version: 0, name: "Synthetic class report", description: "Synthetic publication check", definition: grades(), archived: false, reason: "Synthetic saved report fixture" });
  for (const action of ["run", "export"] as const) {
    const wrapped = afterSource("SELECT * FROM gradebooks", () => db.query("DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2", [section.id, teacher.id]));
    const app = createApp(wrapped.db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
    try {
      const response = await request(app).get(`/api/report-library/${report.id}/${action}?version=1&format=csv`).set("Cookie", teacherSession.cookie);
      assert.equal(wrapped.wasMutated(), true); assert.equal(response.status, 404); assert.equal(response.headers["content-disposition"], undefined); assert.equal(response.body.rows, undefined);
    } finally { await db.query("INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)", [owner.org_id, unit.id, section.id, teacher.id]); }
  }
});
