import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { inspectTimetable } from "../server/timetable-engine";
import { saveTimetable } from "../server/timetable";
let db: Database,
  owner: Actor,
  app: ReturnType<typeof createApp>,
  auth: any,
  unit: any,
  other: any,
  year: any;
const origin = "http://localhost:3000",
  from = "2026-09-21",
  to = "2026-09-25";
async function session(id: string, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), owner.org_id, id, mode, csrf],
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
async function teacher(unitId = unit.id) {
  const id = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic Timetable Staff",
        email: randomUUID() + "@stjw.org",
        role: "employee",
        unitIds: [unitId],
        jobIds: [],
      },
      "stjw.org",
    ),
  );
  return { id, auth: await session(id) };
}
async function section(
  teacherIds: string[] = [],
  unitId = unit.id,
  yearId = year.id,
) {
  return ok("/school/sections", {
    unitId,
    yearId,
    name: "Synthetic Class " + randomUUID().slice(0, 8),
    teacherIds,
    capacity: 30,
    homeroom: false,
  });
}
async function student() {
  const row = await ok("/school/students", {
    unitId: unit.id,
    name: "Synthetic Timetable Student",
    studentNumber: randomUUID(),
  });
  await ok(`/school/students/${row.id}/enrollments`, {
    enrollment: {
      yearId: year.id,
      gradeLevel: "2",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    },
  });
  return row;
}
const meeting = (s: any, extra = {}) => ({
  sectionId: s.id,
  roomId: null,
  startsOn: from,
  endsOn: from,
  weekdays: [1],
  startsAt: "09:00",
  endsAt: "10:00",
  reason: "Synthetic timetable verification",
  ...extra,
});
async function preview(m: any) {
  return ok("/school/timetable/preview", m);
}
async function save(m: any) {
  const p = await preview(m);
  assert.deepEqual(p.issues, []);
  const body = {
    meeting: m,
    revision: p.revision,
    reviewed: true,
    commandId: randomUUID(),
  };
  return { row: await ok("/school/timetable/save", body), body };
}
const query = (extra = {}) =>
  "/school/timetable?" +
  new URLSearchParams({ unitId: unit.id, yearId: year.id, from, to, ...extra });
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "timetable.owner@example.test",
  });
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  const units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  unit = units[0];
  other = units[1];
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
    name: "Synthetic timetable year",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  await ok(
    "/school/attendance/config",
    {
      unitId: unit.id,
      weekdays: [1, 2],
      periods: ["Daily"],
      confirmed: true,
      version: 0,
      reason: "Synthetic instructional calendar",
    },
    auth,
    "put",
  );
});
after(async () => {
  await db?.close();
});

test("cross-unit teacher conflicts redact the inaccessible class and current office grants govern reads and retries", async () => {
  const teacherId = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic Shared Teacher",
        email: randomUUID() + "@stjw.org",
        role: "employee",
        unitIds: [unit.id, other.id],
        jobIds: [],
      },
      "stjw.org",
    ),
  );
  const otherYear = await ok("/school/years", {
    unitId: other.id,
    name: "Synthetic second unit",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  await ok(
    "/school/attendance/config",
    {
      unitId: other.id,
      weekdays: [1, 2],
      periods: ["Daily"],
      confirmed: true,
      version: 0,
      reason: "Synthetic second unit calendar",
    },
    auth,
    "put",
  );
  const hidden = await section([teacherId], other.id, otherYear.id),
    visible = await section([teacherId]);
  await save(meeting(hidden));
  const clerk = await teacher();
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: clerk.id,
    enabled: true,
  });
  const review = await ok(
    "/school/timetable/preview",
    meeting(visible),
    clerk.auth,
  );
  assert.ok(review.issues.some((x: any) => x.kind === "teacher"));
  assert.ok(!JSON.stringify(review).includes(hidden.name));
  assert.ok(JSON.stringify(review).includes("outside your office access"));
  const m = meeting(visible, { startsAt: "10:00", endsAt: "11:00" }),
    p = await ok("/school/timetable/preview", m, clerk.auth),
    body = {
      meeting: m,
      revision: p.revision,
      reviewed: true,
      commandId: randomUUID(),
    };
  await ok("/school/timetable/save", body, clerk.auth);
  const feed = await get(
    "/school/timetable/calendar?from=" + from + "&to=" + to,
    clerk.auth,
  );
  assert.equal(feed.status, 200);
  assert.ok(!JSON.stringify(feed.body).includes(hidden.name));
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: clerk.id,
    enabled: false,
  });
  assert.equal(
    (await send("/school/timetable/save", body, clerk.auth)).status,
    404,
  );
  assert.equal((await get(query(), clerk.auth)).status, 403);
  assert.deepEqual(
    (
      await get(
        "/school/timetable/calendar?from=" + from + "&to=" + to,
        clerk.auth,
      )
    ).body.rows,
    [],
  );
});

test("competing reviews create one plan and history failures roll back the meeting and revision", async () => {
  const a = await section(),
    b = await section();
  const p = await preview(meeting(a)),
    bodies = [a, b].map((s) => ({
      meeting: meeting(s),
      revision: p.revision,
      reviewed: true as const,
      commandId: randomUUID(),
    }));
  const results = await Promise.all(
    bodies.map((body) => send("/school/timetable/save", body)),
  );
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  const c = await section(),
    review = await preview(meeting(c)),
    body = {
      meeting: meeting(c),
      revision: review.revision,
      reviewed: true,
      commandId: randomUUID(),
    };
  const failing: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO school_history"))
              throw new Error("synthetic audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    () => saveTimetable(failing, owner, body),
    /synthetic audit failure/,
  );
  assert.equal(
    (
      await db.query("SELECT 1 FROM timetable_meetings WHERE section_id=$1", [
        c.id,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT version FROM timetable_revisions WHERE org_id=$1",
        [owner.org_id],
      )
    ).rows[0].version,
    review.revision,
  );
  assert.equal(
    (
      await db.query("SELECT 1 FROM timetable_commands WHERE command_id=$1", [
        body.commandId,
      ])
    ).rows.length,
    0,
  );
});

test("teacher overlap blocks, touching boundaries work, previews become stale and retries keep one change", async () => {
  const t = await teacher(),
    a = await section([t.id]),
    b = await section([t.id]);
  const p = await preview(meeting(a));
  const first = await save(meeting(a));
  assert.equal(
    (
      await send("/school/timetable/save", {
        meeting: meeting(b, { startsAt: "10:00", endsAt: "11:00" }),
        revision: p.revision,
        reviewed: true,
        commandId: randomUUID(),
      })
    ).status,
    409,
  );
  const conflict = await preview(meeting(b));
  assert.ok(conflict.issues.some((x: any) => x.kind === "teacher"));
  assert.equal(
    (
      await send("/school/timetable/save", {
        meeting: meeting(b),
        revision: conflict.revision,
        reviewed: true,
        commandId: randomUUID(),
      })
    ).status,
    409,
  );
  await save(meeting(b, { startsAt: "10:00", endsAt: "11:00" }));
  assert.deepEqual(await ok("/school/timetable/save", first.body), first.row);
  assert.equal(
    (
      await send("/school/timetable/save", {
        ...first.body,
        meeting: meeting(a, { startsAt: "08:00" }),
      })
    ).status,
    409,
  );
  const history = await get(`/school/timetable/${first.row.id}/history`);
  assert.equal(history.body.rows.length, 1);
  await assert.rejects(() =>
    db.query(
      "UPDATE timetable_commands SET fingerprint='tampered' WHERE command_id=$1",
      [first.body.commandId],
    ),
  );
});
test("room and dated student reservations block changes and roster imports roll back atomically", async () => {
  const room = await ok("/school/timetable/rooms", {
    unitId: unit.id,
    name: "Synthetic Room " + randomUUID(),
  });
  const a = await section(),
    b = await section();
  await save(meeting(a, { roomId: room.id }));
  assert.ok(
    (await preview(meeting(b, { roomId: room.id }))).issues.some(
      (x: any) => x.kind === "room",
    ),
  );
  await save(meeting(b));
  const s = await student();
  await ok(`/school/sections/${a.id}/roster`, {
    studentId: s.id,
    startsOn: from,
    endsOn: from,
  });
  const failed = await send(`/school/sections/${b.id}/roster`, {
    studentId: s.id,
    startsOn: from,
    endsOn: from,
  });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /student/);
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM section_students WHERE section_id=$1 AND student_id=$2",
        [b.id, s.id],
      )
    ).rows.length,
    0,
  );
  const c = await section();
  const p = await ok("/school/imports/preview", {
    context: { kind: "roster", unitId: unit.id, sectionId: c.id },
    csv: `studentNumber,startsOn,endsOn\n${s.student_number},${from},${from}`,
  });
  await save(meeting(c));
  const applied = await send(`/school/imports/${p.id}/apply`, {
    sourceHash: p.sourceHash,
    planHash: p.planHash,
    reviewed: true,
  });
  assert.equal(applied.status, 409);
  assert.equal(
    (
      await db.query("SELECT 1 FROM section_students WHERE section_id=$1", [
        c.id,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT applied_at FROM school_import_batches WHERE id=$1",
        [p.id],
      )
    ).rows[0].applied_at,
    null,
  );
  // Ending the first class place before the scheduled day frees that reservation.
  await ok(`/school/sections/${a.id}/roster`, {
    studentId: s.id,
    startsOn: "2026-09-20",
    endsOn: "2026-09-20",
    version: 1,
  });
  await ok(`/school/sections/${b.id}/roster`, {
    studentId: s.id,
    startsOn: from,
    endsOn: from,
  });
});
test("teacher reassignment cannot introduce a conflict and failed updates preserve the class and history", async () => {
  const t = await teacher(),
    a = await section([t.id]),
    b = await section();
  await save(meeting(a));
  await save(meeting(b));
  const result = await send(
    `/school/sections/${b.id}`,
    {
      name: b.name,
      room: b.room ?? "",
      capacity: 30,
      teacherIds: [t.id],
      version: b.version,
    },
    auth,
    "patch",
  );
  assert.equal(result.status, 409);
  assert.match(result.body.error, /teacher/);
  const detail = await get(`/school/sections/${b.id}`);
  assert.equal(detail.body.teachers.length, 0);
  assert.equal(detail.body.section.version, b.version);
});
test("school day and weekday changes cannot activate an overlap; correction makes the day schedulable", async () => {
  const t = await teacher(),
    a = await section([t.id]),
    b = await section([t.id]);
  await save(meeting(a, { endsOn: to, weekdays: [1, 5] }));
  const saved = await save(meeting(b, { endsOn: to, weekdays: [2, 5] }));
  const day = {
    unitId: unit.id,
    yearId: year.id,
    date: to,
    instructional: true,
    label: "Synthetic Friday",
    version: 0,
  };
  assert.equal(
    (await send("/school/attendance/days", day, auth, "put")).status,
    409,
  );
  const config = (await get("/school/attendance/config?unitId=" + unit.id)).body
    .settings;
  assert.equal(
    (
      await send(
        "/school/attendance/config",
        {
          unitId: unit.id,
          weekdays: [1, 2, 5],
          periods: ["Daily"],
          confirmed: true,
          version: config.version,
          reason: "Synthetic weekday extension",
        },
        auth,
        "put",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM school_day_overrides WHERE year_id=$1 AND day=$2",
        [year.id, to],
      )
    ).rows.length,
    0,
  );
  await save(
    meeting(b, {
      id: saved.row.id,
      version: saved.row.version,
      endsOn: to,
      weekdays: [2, 5],
      startsAt: "10:00",
      endsAt: "11:00",
    }),
  );
  await ok("/school/attendance/days", day, auth, "put");
  const result = await get(query({ teacherId: t.id }));
  assert.equal(result.body.rows.filter((x: any) => x.day === to).length, 2);
  assert.equal(
    (
      await send(
        "/school/attendance/config",
        {
          unitId: unit.id,
          weekdays: [1, 2],
          periods: ["Daily"],
          confirmed: false,
          version: config.version,
          reason: "Synthetic unconfirmation",
        },
        auth,
        "put",
      )
    ).status,
    409,
  );
});
test("teachers only see assigned classes; office searches/exports and cancellations retain evidence", async () => {
  const t = await teacher(),
    outsider = await teacher(),
    s = await section([t.id]),
    child = await student();
  await ok(`/school/sections/${s.id}/roster`, {
    studentId: child.id,
    startsOn: from,
    endsOn: from,
  });
  const saved = await save(meeting(s));
  const view = await get(query(), t.auth);
  assert.equal(view.status, 200);
  assert.ok(view.body.rows.every((x: any) => x.sectionId === s.id));
  assert.ok(!JSON.stringify(view.body).includes(child.id));
  assert.ok(!JSON.stringify(view.body).includes(child.student_number));
  assert.equal((await get(query(), outsider.auth)).status, 403);
  assert.equal((await get(query(), await session(t.id, "pin"))).status, 403);
  assert.equal(
    (await get(query({ studentNumber: child.student_number }), t.auth)).status,
    403,
  );
  assert.equal(
    (await send("/school/timetable/preview", meeting(s), t.auth)).status,
    403,
  );
  const own = await get(query({ studentNumber: child.student_number }));
  assert.equal(own.body.rows.length, 1);
  const csv = await get(
    query({ studentNumber: child.student_number, format: "csv" }),
  );
  assert.equal(csv.status, 200);
  assert.match(csv.text, /meeting_id/);
  assert.match(csv.text, new RegExp(saved.row.id));
  const body = {
    version: saved.row.version,
    reason: "Synthetic timetable cancellation",
    commandId: randomUUID(),
  };
  const canceled = await ok(`/school/timetable/${saved.row.id}/cancel`, body);
  assert.deepEqual(
    await ok(`/school/timetable/${saved.row.id}/cancel`, body),
    canceled,
  );
  assert.equal((await get(query({ sectionId: s.id }))).body.rows.length, 0);
  assert.equal(
    (await get(`/school/timetable/${saved.row.id}/history`)).body.rows.length,
    2,
  );
});
test("ambiguous or nonexistent local times reject; ordinary clock changes preserve wall time and exact UTC", () => {
  const base: any = {
    meetings: [],
    teachers: [],
    roster: [],
    settings: [{ unit_id: "u", weekdays: [7], confirmed: true }],
    days: [],
    timezone: "America/New_York",
  };
  const m: any = {
    id: "m",
    section_id: "s",
    unit_id: "u",
    year_id: "y",
    section_name: "Synthetic",
    room_id: null,
    weekdays: [7],
    version: 1,
  };
  for (const [day, start, end] of [
    ["2026-03-08", "02:15", "03:15"],
    ["2026-11-01", "01:15", "02:15"],
  ]) {
    const result = inspectTimetable({
      ...base,
      meetings: [
        { ...m, starts_on: day, ends_on: day, starts_at: start, ends_at: end },
      ],
    });
    assert.equal(result.issues[0].kind, "time");
    assert.equal(result.occurrences.length, 0);
  }
  const result = inspectTimetable({
    ...base,
    meetings: [
      {
        ...m,
        starts_on: "2026-03-01",
        ends_on: "2026-03-08",
        starts_at: "09:00",
        ends_at: "10:00",
      },
    ],
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.occurrences[0].starts, "2026-03-01T14:00:00.000Z");
  assert.equal(result.occurrences[1].starts, "2026-03-08T13:00:00.000Z");
});
