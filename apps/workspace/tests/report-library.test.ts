import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { initializeSchoolDemo } from "../server/school-seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  reportDefinition,
  initialDefinition,
  type ReportDefinition,
} from "../shared/report-library";
import {
  resolveReportRange,
  shapeReportRows,
  runReport,
} from "../server/report-library";
let db: Database,
  app: ReturnType<typeof createApp>,
  owner: Actor,
  teacher: Actor,
  auth: any,
  teacherAuth: any,
  unit: any,
  section: any,
  term: any,
  program: any,
  book: any;
const origin = "http://localhost:3000";
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
const get = (path: string, a = auth) =>
  request(app)
    .get("/api" + path)
    .set("Cookie", a.cookie);
const send = (path: string, body: any, a = auth, method = "post") =>
  (request(app) as any)
    [method]("/api" + path)
    .set("Cookie", a.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", a.csrf)
    .send(body);
async function ok(path: string, body: any, a = auth, method = "post") {
  const r = await send(path, body, a, method);
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return r.body;
}
const input = (
  definition: ReportDefinition = initialDefinition("workforce"),
) => ({
  id: randomUUID(),
  version: 0,
  name: "Synthetic personal report",
  description: "Synthetic test definition",
  definition,
  archived: false,
  reason: "Synthetic initial definition",
});
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: true,
    ownerEmail: "reports.owner@example.test",
  });
  await initializeSchoolDemo(db, true);
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  unit = (await db.query("SELECT * FROM units WHERE kind='school'")).rows[0];
  section = (
    await db.query("SELECT * FROM sections WHERE unit_id=$1 ORDER BY name", [
      unit.id,
    ])
  ).rows[0];
  term = (
    await db.query(
      "SELECT * FROM school_terms WHERE year_id=$1 ORDER BY starts_on",
      [section.year_id],
    )
  ).rows[0];
  const t = (
    await db.query(
      "SELECT u.* FROM section_teachers a JOIN users u ON u.id=a.user_id WHERE a.section_id=$1",
      [section.id],
    )
  ).rows[0];
  const actor = (u: any): Actor => ({
    id: u.id,
    org_id: u.org_id,
    name: u.name,
    email: u.email,
    role: u.role,
    mode: "password",
    unit_ids: [unit.id],
  });
  owner = actor(u);
  teacher = actor(t);
  auth = await session(owner);
  teacherAuth = await session(teacher);
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
  program = await ok("/care/programs", {
    unitId: unit.id,
    name: "Synthetic report program",
    room: "Example room",
    capacity: 30,
    instructions: "Synthetic report test instructions.",
    confirmed: true,
    archived: false,
    staffIds: [teacher.id],
    version: 0,
    reason: "Synthetic report fixture",
  });
  const config = (await get("/school/grading/settings?unitId=" + unit.id)).body;
  await ok(
    "/school/grading/settings",
    {
      unitId: unit.id,
      version: config.version,
      confirmed: true,
      policy: {
        name: "Synthetic report grading policy",
        calculation: "total_points",
        missing: "zero",
        emptyCategories: "renormalize",
        allowExtraCredit: false,
        capAt100: true,
        decimals: 2,
        rounding: "nearest",
        categories: [{ id: randomUUID(), name: "Practice", weight: 10000 }],
        scale: [
          { label: "A", minimum: 9000 },
          { label: "B", minimum: 0 },
        ],
      },
      reason: "Synthetic report policy only.",
    },
    auth,
    "put",
  );
  term = await ok("/school/terms", {
    yearId: section.year_id,
    name: "Synthetic report term",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  book = await ok(
    "/school/gradebooks",
    { sectionId: section.id, termId: term.id },
    teacherAuth,
  );
});
after(async () => {
  await db?.close();
});

test("report definitions reject arbitrary columns, unknown input, duplicate columns and unsupported grouping", () => {
  const def = initialDefinition("workforce");
  assert.equal(
    reportDefinition.safeParse({ ...def, columns: ["password_hash"] }).success,
    false,
  );
  assert.equal(
    reportDefinition.safeParse({ ...def, sql: "SELECT * FROM users" }).success,
    false,
  );
  assert.equal(
    reportDefinition.safeParse({
      ...def,
      columns: ["employee_name", "employee_name"],
    }).success,
    false,
  );
  assert.equal(
    reportDefinition.safeParse({ ...def, groupBy: "email" }).success,
    false,
  );
  assert.equal(
    reportDefinition.safeParse({
      ...def,
      sort: { key: "password_hash", direction: "asc" },
    }).success,
    false,
  );
});
test("relative dates follow local calendar boundaries and grouped durations retain exact milliseconds and separate equal names", () => {
  const def = initialDefinition("workforce") as Extract<
    ReportDefinition,
    { source: "workforce" }
  >;
  assert.deepEqual(
    resolveReportRange(
      { ...def, range: { preset: "last_month" } },
      "America/New_York",
      new Date("2026-03-01T04:30:00Z"),
    ),
    { from: "2026-01-01", to: "2026-01-31" },
  );
  assert.deepEqual(
    resolveReportRange(
      { ...def, range: { preset: "this_week" } },
      "America/New_York",
      new Date("2026-11-01T06:30:00Z"),
    ),
    { from: "2026-10-26", to: "2026-11-01" },
  );
  const summary = {
    ...def,
    layout: "summary" as const,
    groupBy: "employee",
    sort: { key: "group_name", direction: "asc" as const },
  };
  const rows = shapeReportRows(summary, [
    {
      user_id: "a",
      employee_name: "Same name",
      kind: "work",
      duration_ms: 1001,
    },
    {
      user_id: "a",
      employee_name: "Same name",
      kind: "break",
      duration_ms: 999,
    },
    {
      user_id: "b",
      employee_name: "Same name",
      kind: "work",
      duration_ms: 2001,
    },
  ]).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    group_name: "Same name",
    group_id: "a",
    record_count: 2,
    duration_ms: 2000,
    work_ms: 1001,
    break_ms: 999,
  });
  const grades = {
    ...initialDefinition("grades"),
    bookId: randomUUID(),
    columns: ["percentage"],
    sort: { key: "percentage", direction: "asc" as const },
  } as ReportDefinition;
  assert.deepEqual(
    shapeReportRows(grades, [
      { percentage: "9.9" },
      { percentage: "9.80" },
    ]).rows.map((r) => r.percentage),
    ["9.80", "9.9"],
  );
});
test("saved reports are private, retry safely, reject competing revisions and retain immutable definition history", async () => {
  const body = input(),
    created = await ok("/report-library", body);
  assert.equal(created.version, 1);
  assert.equal((await ok("/report-library", body)).version, 1);
  assert.equal(
    (await get(`/report-library/${created.id}/run?version=1`, teacherAuth))
      .status,
    404,
  );
  assert.equal(
    (await get(`/report-library/${created.id}/history`, teacherAuth)).status,
    404,
  );
  assert.equal(
    (
      await send(
        "/report-library",
        { ...body, name: "Attempted takeover" },
        teacherAuth,
      )
    ).status,
    409,
  );
  const changed = {
    ...body,
    version: 1,
    name: "Revised layout",
    reason: "Synthetic revision reason",
  };
  const competing = await Promise.all([
    send("/report-library", changed),
    send("/report-library", { ...changed, name: "Other revision" }),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await get(`/report-library/${created.id}/run?version=1`)).status,
    409,
  );
  const history = (await get(`/report-library/${created.id}/history`)).body
    .rows;
  assert.equal(history.length, 2);
  assert.equal(history[1].snapshot.name, body.name);
  await assert.rejects(
    db.query(
      "UPDATE saved_report_history SET reason='rewrite' WHERE report_id=$1",
      [created.id],
    ),
    /append-only/i,
  );
});
test("employee reports retain self scope and exports preserve selected order and source metadata", async () => {
  const def = initialDefinition("workforce") as Extract<
    ReportDefinition,
    { source: "workforce" }
  >;
  def.range = { preset: "this_year" };
  def.columns = ["revision", "employee_name", "id"];
  def.sort = { key: "employee_name", direction: "asc" };
  const row = await ok("/report-library", input(def), teacherAuth),
    data = (await get(`/report-library/${row.id}/run?version=1`, teacherAuth))
      .body;
  assert.ok(data.rows.length > 0);
  assert.ok(data.rows.every((r: any) => r.employee_name === teacher.name));
  assert.deepEqual(
    data.columns.map((c: any) => c.key),
    def.columns,
  );
  const csv = await get(
    `/report-library/${row.id}/export?version=1`,
    teacherAuth,
  );
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^\uFEFF?"revision","employee_name","id","report_id"/);
  assert.match(csv.text, /report_as_of/);
  const json = await get(
    `/report-library/${row.id}/export?version=1&format=json`,
    teacherAuth,
  );
  assert.equal(json.body.reportVersion, 1);
  assert.equal(json.body.reportId, row.id);
  const a = await session(teacher, "pin");
  assert.equal((await get("/report-library", a)).status, 403);
  await assert.rejects(
    runReport(db, { ...teacher, mode: "api" }, def),
    /password/i,
  );
});
test("school access is independent from workforce roles and saved care reports lose access when office grants are revoked", async () => {
  const def = {
    ...initialDefinition("care"),
    source: "care",
    programId: program.id,
    range: { preset: "today" },
  } as ReportDefinition;
  assert.equal(
    (await send("/report-library/preview", def, teacherAuth)).status,
    403,
  );
  await db.query(
    "INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)",
    [owner.org_id, unit.id, teacher.id, owner.id],
  );
  const row = await ok("/report-library", input(def), teacherAuth);
  assert.equal(
    (await get(`/report-library/${row.id}/run?version=1`, teacherAuth)).status,
    200,
  );
  assert.equal(
    (
      await send(
        "/report-library/preview",
        {
          ...def,
          range: { preset: "custom", from: "2020-01-01", to: "2026-12-31" },
        },
        teacherAuth,
      )
    ).status,
    400,
  );
  await db.query("DELETE FROM school_office_grants WHERE user_id=$1", [
    teacher.id,
  ]);
  assert.equal(
    (await get(`/report-library/${row.id}/export?version=1`, teacherAuth))
      .status,
    403,
  );
  assert.equal(
    (await get("/report-library/options", teacherAuth)).body.programs.length,
    0,
  );
  const archived = await ok(
    "/report-library",
    {
      ...input(def),
      id: row.id,
      version: 1,
      archived: true,
      reason: "Archive inaccessible care report",
    },
    teacherAuth,
  );
  assert.equal(archived.archived, true);
  assert.equal(
    (await get(`/report-library/${row.id}/run?version=2`, teacherAuth)).status,
    409,
  );
  assert.equal(
    (
      await send(
        "/report-library",
        { ...input(def), id: row.id, version: 2, archived: false },
        teacherAuth,
      )
    ).status,
    403,
  );
});
test("class reports include roster and grading provenance; removal from a class blocks saved reports and catalog entries", async () => {
  const def = {
    ...initialDefinition("grades"),
    source: "grades",
    bookId: book.id,
  } as ReportDefinition;
  const row = await ok("/report-library", input(def), teacherAuth),
    data = (await get(`/report-library/${row.id}/run?version=1`, teacherAuth))
      .body;
  assert.ok(data.rows.length > 0);
  assert.equal(data.provenance.bookId, book.id);
  assert.equal(data.provenance.bookStatus, "open");
  assert.equal(data.provenance.rosterCurrent, true);
  assert.ok(
    (await get("/report-library/options", teacherAuth)).body.books.some(
      (b: any) => b.id === book.id,
    ),
  );
  await db.query(
    "DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2",
    [section.id, teacher.id],
  );
  assert.equal(
    (await get(`/report-library/${row.id}/run?version=1`, teacherAuth)).status,
    404,
  );
  assert.equal(
    (await get("/report-library/options", teacherAuth)).body.books.some(
      (b: any) => b.id === book.id,
    ),
    false,
  );
  assert.equal(
    (await get(`/report-library/${row.id}/run?version=1`)).status,
    404,
  );
});
