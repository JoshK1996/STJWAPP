import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { initialDefinition } from "../shared/report-library";
import { runAttendanceReport } from "../server/attendance-reports";
let db: Database,
  app: ReturnType<typeof createApp>,
  owner: Actor,
  auth: any,
  unit: any,
  year: any,
  a: any,
  b: any,
  childA: any,
  childB: any,
  teacher: any,
  teacherAuth: any,
  present: any,
  absent: any,
  sessionA: any;
const origin = "http://localhost:3000",
  reason = "Synthetic attendance report verification";
async function session(userId: string, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), owner.org_id, userId, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
const get = (path: string, s = auth) =>
  request(app)
    .get("/api" + path)
    .set("Cookie", s.cookie);
const send = (path: string, body: any, s = auth, method = "post") =>
  (request(app) as any)
    [method]("/api" + path)
    .set("Cookie", s.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", s.csrf)
    .send(body);
async function ok(path: string, body: any, s = auth, method = "post") {
  const r = await send(path, body, s, method);
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return r.body;
}
const saveSession = (id: string, body: any) =>
  ok(`/school/attendance/sessions/${id}`, body, auth, "put");
const input = (extra = {}) => ({
  unitId: unit.id,
  yearId: year.id,
  from: "2026-01-05",
  to: "2026-01-06",
  period: "Daily",
  ...extra,
});
const report = (extra = {}, s = auth) =>
  ok("/school/attendance/reports/run", input(extra), s);
async function child(number: string, section: any) {
  const row = await ok("/school/students", {
    unitId: unit.id,
    name: "Synthetic " + number,
    studentNumber: number,
  });
  await ok(`/school/students/${row.id}/enrollments`, {
    enrollment: {
      yearId: year.id,
      gradeLevel: "2",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    },
  });
  await ok(`/school/sections/${section.id}/roster`, {
    studentId: row.id,
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  return row;
}
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "attendance.reports@example.test",
  });
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  const units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  unit = units[0];
  owner = {
    id: u.id,
    org_id: u.org_id,
    name: u.name,
    email: u.email,
    role: u.role,
    mode: "password",
    unit_ids: units.map((x) => x.id),
  };
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
  auth = await session(owner.id);
  year = await ok("/school/years", {
    unitId: unit.id,
    name: "Synthetic reporting year",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  await ok(
    "/school/attendance/config",
    {
      unitId: unit.id,
      weekdays: [1, 2, 3, 4, 5],
      periods: ["Daily", "Afternoon"],
      confirmed: true,
      version: 0,
      reason,
    },
    auth,
    "put",
  );
  present = await ok("/school/attendance/codes", {
    unitId: unit.id,
    code: "P",
    label: "Present at roll call",
    category: "present",
    excused: false,
    reasonRequired: false,
  });
  absent = await ok("/school/attendance/codes", {
    unitId: unit.id,
    code: "AE",
    label: "Excused absence",
    category: "absent",
    excused: true,
    reasonRequired: true,
  });
  teacher = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic Reporting Teacher",
        email: "attendance.teacher@stjw.org",
        role: "employee",
        unitIds: [unit.id],
        jobIds: [],
      },
      "stjw.org",
    ),
  );
  teacherAuth = await session(teacher);
  a = await ok("/school/sections", {
    unitId: unit.id,
    yearId: year.id,
    name: "Synthetic Homeroom A",
    teacherIds: [teacher],
    homeroom: true,
    capacity: 20,
  });
  b = await ok("/school/sections", {
    unitId: unit.id,
    yearId: year.id,
    name: "Synthetic Homeroom B",
    teacherIds: [],
    homeroom: true,
    capacity: 20,
  });
  childA = await child("REPORT-A", a);
  childB = await child("REPORT-B", b);
  const opened = await ok("/school/attendance/sessions", {
    sectionId: a.id,
    date: "2026-01-05",
    period: "Daily",
  });
  sessionA = (
    await saveSession(opened.session.id, {
      version: opened.session.version,
      submit: true,
      marks: [
        {
          studentId: childA.id,
          codeId: absent.id,
          note: "Synthetic family note",
        },
      ],
    })
  ).session;
  const draft = await ok("/school/attendance/sessions", {
    sectionId: b.id,
    date: "2026-01-05",
    period: "Daily",
  });
  await saveSession(draft.session.id, {
    version: draft.session.version,
    submit: false,
    marks: [
      {
        studentId: childB.id,
        codeId: present.id,
        note: "Synthetic draft note",
      },
    ],
  });
});
after(async () => {
  await db?.close();
});

test("reports distinguish submitted snapshots, drafts and missing homeroom sessions without inventing absences", async () => {
  const result = await report();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].note, "");
  assert.equal(result.summary.absent, 1);
  assert.equal(result.summary.excusedAbsences, 1);
  assert.equal(result.summary.present, 0);
  assert.equal(result.summary.draft, 1);
  assert.equal(result.summary.notStarted, 2);
  assert.equal(result.coverage.length, 4);
  assert.equal(result.rows[0].session_version, sessionA.version);
  assert.equal(result.rows[0].category, "absent");
  const full = await report({ recordedOnly: false, includeNotes: true });
  assert.equal(full.rows.length, 2);
  assert.equal(
    full.rows.find((x: any) => x.record_status === "draft").note,
    "Synthetic draft note",
  );
  assert.equal(full.summary.present, 0);
  assert.equal(full.trends[0].absent, 1);
  assert.match(full.notice, /not unique absent days/);
});
test("teachers see only current assigned classes and scoped student searches; PIN and arbitrary class IDs fail", async () => {
  const result = await report({}, teacherAuth);
  assert.equal(result.rows.length, 1);
  assert.equal(result.coverage.length, 2);
  assert.ok(!JSON.stringify(result).includes(childB.id));
  assert.ok(!JSON.stringify(result).includes(childB.student_number));
  assert.ok(!JSON.stringify(result).includes(b.name));
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ sectionIds: [b.id] }),
        teacherAuth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ studentNumber: childB.student_number }),
        teacherAuth,
      )
    ).status,
    404,
  );
  assert.equal(
    (await report({ studentNumber: childA.student_number }, teacherAuth)).rows
      .length,
    1,
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input(),
        await session(teacher, "pin"),
      )
    ).status,
    403,
  );
  const outsider = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic Finance",
        email: "attendance.finance@stjw.org",
        role: "finance",
        unitIds: [unit.id],
        jobIds: [],
      },
      "stjw.org",
    ),
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input(),
        await session(outsider),
      )
    ).status,
    403,
  );
});
test("exports omit notes unless requested and include source hash, revision and distinct coverage semantics", async () => {
  const csv = await send(
    "/school/attendance/reports/export?format=csv",
    input(),
  );
  assert.equal(csv.status, 200);
  assert.match(csv.text, /source_hash/);
  assert.match(csv.text, /session_version/);
  assert.ok(!csv.text.includes('"note"'));
  assert.ok(!csv.text.includes("Synthetic family note"));
  const notes = await send(
    "/school/attendance/reports/export?format=csv",
    input({ includeNotes: true }),
  );
  assert.match(notes.text, /Synthetic family note/);
  const coverage = await send(
    "/school/attendance/reports/export?dataset=coverage",
    input(),
  );
  assert.match(coverage.text, /not_started/);
  assert.match(coverage.text, /current_expected/);
  const json = await send(
    "/school/attendance/reports/export?format=json",
    input(),
  );
  assert.equal(json.body.rows.length, 1);
  assert.match(json.body.sourceHash, /^[a-f0-9]{64}$/);
});
test("attendance report-library templates count submitted marks, retain privacy and recheck current teaching access", async () => {
  const def = {
    ...initialDefinition("attendance"),
    unitId: unit.id,
    yearId: year.id,
    period: "Daily",
    sectionIds: [a.id],
    studentNumber: "",
    range: { preset: "custom", from: "2026-01-05", to: "2026-01-06" },
    layout: "summary",
    groupBy: "category",
    sort: { key: "group_name", direction: "asc" },
  };
  const summary = await ok("/report-library/preview", def, teacherAuth);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].group_name, "absent");
  assert.equal(summary.rows[0].record_count, 1);
  assert.ok(!summary.columns.some((c: any) => c.key === "duration_ms"));
  const id = randomUUID();
  await ok(
    "/report-library",
    {
      id,
      version: 0,
      name: "Synthetic attendance template",
      description: "Submitted attendance only",
      definition: def,
      archived: false,
      reason,
    },
    teacherAuth,
  );
  assert.equal(
    (await get(`/report-library/${id}/run?version=1`, teacherAuth)).status,
    200,
  );
  assert.equal((await get(`/report-library/${id}/run?version=1`)).status, 404);
  await ok(
    `/school/sections/${a.id}`,
    {
      name: a.name,
      room: a.room ?? "",
      capacity: 20,
      teacherIds: [],
      version: a.version,
    },
    auth,
    "patch",
  );
  assert.equal(
    (await get(`/report-library/${id}/run?version=1`, teacherAuth)).status,
    403,
  );
  const options = await get("/report-library/options", teacherAuth);
  assert.ok(!options.body.attendanceYears.some((y: any) => y.id === year.id));
  await ok(
    `/school/sections/${a.id}`,
    {
      name: a.name,
      room: a.room ?? "",
      capacity: 20,
      teacherIds: [teacher],
      version: a.version + 1,
    },
    auth,
    "patch",
  );
});
test("current roster and instructional changes flag historical records while their captured category and identity remain", async () => {
  await ok(`/school/sections/${a.id}/roster`, {
    studentId: childA.id,
    startsOn: "2026-01-01",
    endsOn: "2026-01-04",
    version: 1,
  });
  await ok(
    "/school/attendance/days",
    {
      unitId: unit.id,
      yearId: year.id,
      date: "2026-01-05",
      instructional: false,
      label: "Synthetic calendar correction",
      version: 0,
    },
    auth,
    "put",
  );
  const result = await report();
  assert.equal(result.summary.absent, 1);
  assert.equal(result.rows[0].roster_current, false);
  assert.equal(result.rows[0].instructional_now, false);
  assert.equal(result.rows[0].student_name, "Synthetic REPORT-A");
  assert.equal(result.summary.rosterChanged, 1);
  assert.equal(
    result.coverage.filter(
      (x: any) => x.status === "not_started" && x.section_id === a.id,
    ).length,
    0,
  );
  await ok(`/school/sections/${a.id}/roster`, {
    studentId: childA.id,
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
    version: 2,
  });
  await ok(
    "/school/attendance/days",
    {
      unitId: unit.id,
      yearId: year.id,
      date: "2026-01-05",
      instructional: true,
      label: "Synthetic instructional date restored",
      version: 1,
    },
    auth,
    "put",
  );
});
test("an office correction uses the new revision while preserving the previous submitted snapshot", async () => {
  const original = (
    await db.query(
      "SELECT snapshot FROM attendance_revisions WHERE session_id=$1 AND version=$2",
      [sessionA.id, sessionA.version],
    )
  ).rows[0].snapshot;
  sessionA = (
    await saveSession(sessionA.id, {
      version: sessionA.version,
      submit: true,
      reason,
      marks: [
        {
          studentId: childA.id,
          codeId: present.id,
          note: "Synthetic reviewed correction",
        },
      ],
    })
  ).session;
  const result = await report({ includeNotes: true });
  assert.equal(result.summary.absent, 0);
  assert.equal(result.summary.present, 1);
  assert.equal(result.rows[0].session_version, sessionA.version);
  assert.equal(result.rows[0].note, "Synthetic reviewed correction");
  assert.deepEqual(
    (
      await db.query(
        "SELECT snapshot FROM attendance_revisions WHERE session_id=$1 AND version=$2",
        [sessionA.id, sessionA.version - 1],
      )
    ).rows[0].snapshot,
    original,
  );
});
test("range bounds reject arbitrary inputs and the reporting window clips to school-year dates and today", async () => {
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ sql: "select secret" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ from: "2024-01-01", to: "2026-01-06" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ period: "Unknown period" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await send(
        "/school/attendance/reports/run",
        input({ includeNotes: "true" }),
      )
    ).status,
    400,
  );
  const result = await runAttendanceReport(
    db,
    owner,
    input({ from: "2025-12-15", to: "2026-02-01" }),
    false,
    new Date("2026-01-06T18:00:00Z"),
  );
  assert.deepEqual(result.range, { from: "2026-01-01", to: "2026-01-06" });
  assert.ok(result.coverage.every((x: any) => x.date <= "2026-01-06"));
  assert.deepEqual(result.requestedRange, {
    from: "2025-12-15",
    to: "2026-02-01",
  });
});

test("changing an attendance code does not relabel earlier captured marks", async () => {
  await ok(
    `/school/attendance/codes/${present.id}`,
    {
      unitId: unit.id,
      code: "P",
      label: "Synthetic new code meaning",
      category: "other",
      excused: true,
      reasonRequired: false,
      active: false,
      version: present.version,
    },
    auth,
    "patch",
  );
  const result = await report();
  assert.equal(result.rows[0].category, "present");
  assert.equal(result.rows[0].code_label, "Present at roll call");
  assert.equal(result.rows[0].excused, false);
  assert.equal(result.summary.present, 1);
  assert.equal(result.summary.other, 0);
});

test("historical periods remain reportable without projecting missing sessions for a removed period", async () => {
  const settings = (await get("/school/attendance/config?unitId=" + unit.id))
    .body.settings;
  await ok(
    "/school/attendance/config",
    {
      unitId: unit.id,
      weekdays: settings.weekdays,
      periods: ["Afternoon"],
      confirmed: true,
      version: settings.version,
      reason,
    },
    auth,
    "put",
  );
  const result = await report();
  assert.equal(result.summary.present, 1);
  assert.equal(result.summary.notStarted, 0);
  assert.equal(result.projectionEnabled, false);
  assert.equal(result.coverage.length, 2);
  const options = await get(
    "/school/attendance/reports/options?" +
      new URLSearchParams({ unitId: unit.id, yearId: year.id }),
  );
  assert.ok(options.body.periods.includes("Daily"));
});
