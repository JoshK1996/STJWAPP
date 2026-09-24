import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { openGradebook, reviewGradebook } from "../server/grading";
import {
  gradingPolicySchema,
  calculateGrade,
  type GradingPolicy,
} from "../shared/grading";
let db: Database,
  app: ReturnType<typeof createApp>,
  owner: Actor,
  auth: any,
  units: any[],
  jobs: any[];
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
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "grading.owner@example.test",
  });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  jobs = (await db.query("SELECT * FROM jobs")).rows;
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: "owner",
    mode: "password",
    unit_ids: units.map((row) => row.id),
  };
  auth = await session(owner);
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
});
after(async () => {
  await db?.close();
});
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
  assert.ok(r.status < 300, r.body.error);
  return r.body;
}
function policy(overrides: Partial<GradingPolicy> = {}): GradingPolicy {
  return gradingPolicySchema.parse({
    name: "Explicit synthetic example only",
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
      { label: "B", minimum: 8000 },
      { label: "C", minimum: 0 },
    ],
    ...overrides,
  });
}
function trackedTransactions() {
  const statements: { sql: string; params?: any[] }[] = [];
  const tracked: Database = { ...db, transaction: action => db.transaction(tx => action({
    query: (sql, params) => { statements.push({ sql, params }); return tx.query(sql, params); },
  })) };
  return { statements, db: tracked };
}
function assertRosterLockOrder(statements: { sql: string; params?: any[] }[]) {
  const academic = statements.findIndex(q => q.sql.includes('pg_advisory_xact_lock') && q.params?.[0] === 'academic-timetable:' + owner.org_id);
  const students = statements.findIndex(q => q.sql.includes('FOR SHARE OF s') && q.sql.includes('section_students'));
  const people = statements.findIndex(q => q.sql.includes('school_people') && q.sql.includes('FOR SHARE'));
  const book = statements.findIndex(q => (q.sql.includes('gradebooks') && q.sql.includes('FOR UPDATE')) || q.params?.[0]?.startsWith?.('gradebook:'));
  assert.ok(academic >= 0 && academic < students, 'Academic mutex must precede student locks so a new roster member cannot appear after discovery.');
  assert.ok(students < people && people < book, 'Student and identity source locks must precede book locks, matching enrollment and report-card writers.');
  assert.ok(!statements.some(q => q.sql.includes('UPDATE timetable_revisions')), 'Grade source reads must not advance the timetable revision.');
}

test('opening a gradebook locks its full roster source before the book without changing timetable revision', async () => {
  const f = await fixture(), tracked = trackedTransactions();
  const opened = await openGradebook(tracked.db, owner, { sectionId: f.section.id, termId: f.term.id });
  assert.equal(opened.roster[0].student_id, f.student.id);
  assertRosterLockOrder(tracked.statements);
});

test('review and reconciliation lock roster identities before gradebook writes and preserve reviewed history', async () => {
  const f = await fixture(), a = await assignment(f);
  await score(f, a);
  const submitted = await ok('/school/gradebooks/' + a.book.id + '/review', { version: 3, action: 'submit', reason: 'Synthetic source locking review' }, f.teacherAuth);
  const tracked = trackedTransactions();
  const locked = await reviewGradebook(tracked.db, owner, a.book.id, { version: submitted.version, action: 'lock', reason: 'Synthetic reviewed source ordering', acknowledgeMissing: false, acknowledgeNoGrade: false });
  assertRosterLockOrder(tracked.statements);
  const before = (await db.query('SELECT snapshot FROM gradebook_releases WHERE book_id=$1', [a.book.id])).rows[0].snapshot;
  const reopened = await ok('/school/gradebooks/' + a.book.id + '/review', { version: locked.version, action: 'reopen', reason: 'Synthetic source reconciliation' });
  tracked.statements.length = 0;
  const scopedApp = createApp(tracked.db, { origin, production: false, staffDomain: 'stjw.org', demo: true });
  const response = await request(scopedApp).post('/api/school/gradebooks/' + a.book.id + '/reconcile').set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf).send({ version: reopened.version, reason: 'Synthetic reconciliation source lock order' });
  assert.equal(response.status, 200, response.body.error);
  assertRosterLockOrder(tracked.statements);
  assert.deepEqual((await db.query('SELECT snapshot FROM gradebook_releases WHERE book_id=$1', [a.book.id])).rows[0].snapshot, before);
});
async function fixture(confirmed = true) {
  const unit = units[0],
    job = jobs.find((row) => row.unit_id === unit.id),
    teacherId = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic grading teacher",
          email: randomUUID() + "@stjw.org",
          role: "employee",
          unitIds: [unit.id],
          jobIds: [job.id],
        },
        "stjw.org",
      ),
    ),
    teacher = {
      ...owner,
      id: teacherId,
      role: "employee",
      unit_ids: [unit.id],
    },
    teacherAuth = await session(teacher),
    year = await ok("/school/years", {
      unitId: unit.id,
      name: "Synthetic grade year " + randomUUID(),
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    }),
    term = await ok("/school/terms", {
      yearId: year.id,
      name: "Synthetic term",
      startsOn: "2026-01-01",
      endsOn: "2026-06-30",
    }),
    section = await ok("/school/sections", {
      unitId: unit.id,
      yearId: year.id,
      name: "Synthetic class " + randomUUID(),
      homeroom: false,
      capacity: 30,
      teacherIds: [teacherId],
    }),
    student = await ok("/school/students", {
      unitId: unit.id,
      name: "Synthetic grading student",
      studentNumber: randomUUID(),
    });
  await ok("/school/students/" + student.id + "/enrollments", {
    enrollment: {
      yearId: year.id,
      gradeLevel: "Example 3",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    },
  });
  await ok("/school/sections/" + section.id + "/roster", {
    studentId: student.id,
    startsOn: "2026-01-01",
    endsOn: "2026-06-30",
  });
  const config = (await get("/school/grading/settings?unitId=" + unit.id)).body,
    rules = policy();
  await ok(
    "/school/grading/settings",
    {
      unitId: unit.id,
      version: config.version,
      confirmed,
      policy: rules,
      reason: "Synthetic fixture policy confirmation, not actual STJW policy.",
    },
    auth,
    "put",
  );
  return { unit, year, term, section, student, teacher, teacherAuth, rules };
}
async function assignment(f: any) {
  const book = await ok(
      "/school/gradebooks",
      { sectionId: f.section.id, termId: f.term.id },
      f.teacherAuth,
    ),
    input = {
      bookId: book.id,
      bookVersion: book.version,
      commandId: randomUUID(),
      title: "Synthetic assignment",
      instructions: "Example directions",
      categoryId: f.rules.categories[0].id,
      dueOn: "2026-03-15",
      maxPointsUnits: 10000,
    },
    assignment = await ok("/school/grade-assignments", input, f.teacherAuth);
  return { book, assignment, input };
}
async function score(
  f: any,
  a: any,
  status = "scored",
  pointsUnits: number | null = 8999,
  note = "",
) {
  const current = (await get("/school/gradebooks/" + a.book.id, f.teacherAuth))
    .body;
  return ok(
    "/school/grade-assignments/" + a.assignment.id + "/scores",
    {
      bookVersion: current.book.version,
      version: current.assignments[0].version,
      scores: [{ studentId: f.student.id, status, pointsUnits, note }],
      reason: "Synthetic grading evidence recorded.",
    },
    f.teacherAuth,
    "put",
  );
}
test("grade calculations compare exact thresholds before display rounding and compose category weights without intermediate rounding", () => {
  const rules = policy({ decimals: 0 }),
    categoryId = rules.categories[0].id;
  const grade = calculateGrade(rules, [
    { categoryId, maxPointsUnits: 10000, status: "scored", pointsUnits: 8999 },
  ]);
  assert.equal(grade.percentage, "90");
  assert.equal(grade.label, "B");
  const weighted = policy({
    calculation: "category_weighted",
    categories: [
      { id: randomUUID(), name: "Practice", weight: 2500 },
      { id: randomUUID(), name: "Assessment", weight: 7500 },
    ],
  });
  assert.equal(
    calculateGrade(weighted, [
      {
        categoryId: weighted.categories[0].id,
        maxPointsUnits: 300,
        status: "scored",
        pointsUnits: 100,
      },
      {
        categoryId: weighted.categories[1].id,
        maxPointsUnits: 700,
        status: "scored",
        pointsUnits: 600,
      },
    ]).percentage,
    "72.62",
  );
  assert.equal(
    calculateGrade({ ...weighted, emptyCategories: "incomplete" }, [
      {
        categoryId: weighted.categories[0].id,
        maxPointsUnits: 300,
        status: "scored",
        pointsUnits: 100,
      },
    ]).percentage,
    null,
  );
  assert.equal(
    calculateGrade(weighted, [
      {
        categoryId: weighted.categories[0].id,
        maxPointsUnits: 300,
        status: "scored",
        pointsUnits: 100,
      },
    ]).percentage,
    "33.33",
  );
});
test("missing, ungraded, exempt, incomplete and extra credit have distinct explicit policy semantics", () => {
  const rules = policy(),
    categoryId = rules.categories[0].id,
    entries = [
      {
        categoryId,
        maxPointsUnits: 10000,
        status: "scored" as const,
        pointsUnits: 8000,
      },
      {
        categoryId,
        maxPointsUnits: 10000,
        status: "missing" as const,
        pointsUnits: null,
      },
    ];
  assert.equal(calculateGrade(rules, entries).percentage, "40.00");
  assert.equal(
    calculateGrade({ ...rules, missing: "exclude" }, entries).percentage,
    "80.00",
  );
  assert.equal(
    calculateGrade(rules, [{ ...entries[1], status: "ungraded" }]).pending,
    1,
  );
  assert.equal(
    calculateGrade(rules, [{ ...entries[1], status: "exempt" }]).percentage,
    null,
  );
  assert.equal(
    calculateGrade(rules, [entries[0], { ...entries[1], status: "incomplete" }])
      .percentage,
    null,
  );
  assert.equal(
    calculateGrade({ ...rules, allowExtraCredit: true }, [
      { ...entries[0], pointsUnits: 12000 },
    ]).percentage,
    "100.00",
  );
  assert.equal(
    calculateGrade({ ...rules, allowExtraCredit: true, capAt100: false }, [
      { ...entries[0], pointsUnits: 12000 },
    ]).percentage,
    "120.00",
  );
  assert.equal(
    gradingPolicySchema.safeParse({
      ...rules,
      scale: [{ label: "A", minimum: 9000 }],
    }).success,
    false,
  );
  assert.equal(
    gradingPolicySchema.safeParse({
      ...rules,
      calculation: "category_weighted",
      categories: [{ ...rules.categories[0], weight: 9000 }],
    }).success,
    false,
  );
});
test("confirmed policy and dated classroom enrollment are required; teacher, PIN and workforce roles remain scoped", async () => {
  const f = await fixture(false);
  assert.equal(
    (
      await send(
        "/school/gradebooks",
        { sectionId: f.section.id, termId: f.term.id },
        f.teacherAuth,
      )
    ).status,
    409,
  );
  const settings = (await get("/school/grading/settings?unitId=" + f.unit.id))
    .body;
  assert.equal(
    (
      await send(
        "/school/grading/settings",
        {
          unitId: f.unit.id,
          version: settings.version,
          confirmed: true,
          policy: f.rules,
          reason: "Teacher cannot approve school grading policy.",
        },
        f.teacherAuth,
        "put",
      )
    ).status,
    403,
  );
  await ok(
    "/school/grading/settings",
    {
      unitId: f.unit.id,
      version: settings.version,
      confirmed: true,
      policy: f.rules,
      reason: "Synthetic authorized policy configuration.",
    },
    auth,
    "put",
  );
  const a = await assignment(f);
  const outsiderId = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Unassigned finance",
        email: randomUUID() + "@stjw.org",
        role: "finance",
        unitIds: [f.unit.id],
        jobIds: [],
      },
      "stjw.org",
    ),
  );
  assert.equal(
    (
      await get(
        "/school/gradebooks/" + a.book.id,
        await session({
          ...owner,
          id: outsiderId,
          role: "finance",
          unit_ids: [f.unit.id],
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await get(
        "/school/gradebooks/" + a.book.id,
        await session(f.teacher, "pin"),
      )
    ).status,
    403,
  );
  await db.query("DELETE FROM section_teachers WHERE section_id=$1", [
    f.section.id,
  ]);
  assert.equal(
    (await get("/school/gradebooks/" + a.book.id, f.teacherAuth)).status,
    404,
  );
});
test("scores and assignment revisions serialize, preserve evidence and reject stale, invalid and unauthorized roster input", async () => {
  const f = await fixture(),
    a = await assignment(f);
  const again = await send("/school/grade-assignments", a.input, f.teacherAuth);
  assert.equal(again.body.id, a.assignment.id);
  assert.equal(
    (
      await send(
        "/school/grade-assignments",
        { ...a.input, title: "Changed retry" },
        f.teacherAuth,
      )
    ).status,
    409,
  );
  const payload = {
    bookVersion: 2,
    version: 1,
    scores: [
      {
        studentId: f.student.id,
        status: "scored",
        pointsUnits: 8000,
        note: "",
      },
    ],
    reason: "Synthetic reviewed score entry.",
  };
  const results = await Promise.all([
    send(
      "/school/grade-assignments/" + a.assignment.id + "/scores",
      payload,
      f.teacherAuth,
      "put",
    ),
    send(
      "/school/grade-assignments/" + a.assignment.id + "/scores",
      payload,
      f.teacherAuth,
      "put",
    ),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = (await get("/school/gradebooks/" + a.book.id, f.teacherAuth))
    .body;
  assert.equal(current.results[0].percentage, "80.00");
  assert.equal(
    (
      await send(
        "/school/grade-assignments/" + a.assignment.id + "/scores",
        {
          ...payload,
          bookVersion: 3,
          version: 2,
          scores: [{ ...payload.scores[0], pointsUnits: 10001 }],
        },
        f.teacherAuth,
        "put",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await send(
        "/school/grade-assignments/" + a.assignment.id + "/scores",
        {
          ...payload,
          bookVersion: 3,
          version: 2,
          scores: [{ ...payload.scores[0], studentId: randomUUID() }],
        },
        f.teacherAuth,
        "put",
      )
    ).status,
    400,
  );
  assert.equal(
    current.history.filter(
      (row: any) => row.entity_type === "gradebook.scores_saved",
    ).length,
    1,
  );
  const generic = (
    await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [
      a.book.id,
    ])
  ).rows;
  assert.ok(!JSON.stringify(generic).includes(f.student.name));
});
test("submission and office locking preserve immutable release; reopening retains signed history and frozen calculation policy", async () => {
  const f = await fixture(),
    a = await assignment(f);
  assert.equal(
    (
      await send(
        "/school/gradebooks/" + a.book.id + "/review",
        {
          version: 2,
          action: "submit",
          reason: "Cannot submit unfinished student grades.",
        },
        f.teacherAuth,
      )
    ).status,
    409,
  );
  await score(f, a);
  const submitted = await ok(
    "/school/gradebooks/" + a.book.id + "/review",
    {
      version: 3,
      action: "submit",
      reason: "Synthetic teacher completed the gradebook.",
    },
    f.teacherAuth,
  );
  assert.equal(
    (
      await send(
        "/school/gradebooks/" + a.book.id + "/review",
        {
          version: submitted.version,
          action: "lock",
          reason: "Teacher cannot lock their submitted grades.",
        },
        f.teacherAuth,
      )
    ).status,
    403,
  );
  const locked = await ok("/school/gradebooks/" + a.book.id + "/review", {
    version: submitted.version,
    action: "lock",
    reason: "Synthetic office reviewed and locked the results.",
  });
  let current = (await get("/school/gradebooks/" + a.book.id)).body;
  assert.equal(current.releases.length, 1);
  const preserved = JSON.stringify(
    (
      await get(
        "/school/gradebooks/" +
          a.book.id +
          "/releases/" +
          current.releases[0].id,
      )
    ).body.snapshot,
  );
  await assert.rejects(
    () =>
      db.query("UPDATE gradebook_releases SET snapshot='{}' WHERE book_id=$1", [
        a.book.id,
      ]),
    /append-only/,
  );
  assert.equal(
    (
      await send(
        "/school/grade-assignments/" + a.assignment.id + "/scores",
        {
          bookVersion: locked.version,
          version: 2,
          scores: [],
          reason: "Cannot change locked scores.",
        },
        f.teacherAuth,
        "put",
      )
    ).status,
    409,
  );
  const settings = (await get("/school/grading/settings?unitId=" + f.unit.id))
    .body;
  await ok(
    "/school/grading/settings",
    {
      unitId: f.unit.id,
      version: settings.version,
      confirmed: true,
      policy: { ...f.rules, decimals: 0 },
      reason: "Synthetic new policy only applies to new gradebooks.",
    },
    auth,
    "put",
  );
  assert.equal(
    (await get("/school/gradebooks/" + a.book.id)).body.results[0].percentage,
    "89.99",
  );
  await ok("/school/gradebooks/" + a.book.id + "/review", {
    version: locked.version,
    action: "reopen",
    reason: "Synthetic office authorizes a documented correction.",
  });
  await score(f, a, "scored", 9500);
  current = (await get("/school/gradebooks/" + a.book.id)).body;
  assert.equal(current.results[0].label, "A");
  assert.equal(
    JSON.stringify(
      (
        await get(
          "/school/gradebooks/" +
            a.book.id +
            "/releases/" +
            current.releases[0].id,
        )
      ).body.snapshot,
    ),
    preserved,
  );
  const exported = await get("/school/gradebooks/" + a.book.id + "/export");
  assert.equal(exported.status, 200);
  assert.ok(exported.text.includes('"roster_current"'));
});
test("roster drift blocks review; office reconciliation retains departed scores and requires new student grading", async () => {
  const f = await fixture(),
    a = await assignment(f);
  await score(f, a, "scored", 8000);
  const student = await ok("/school/students", {
    unitId: f.unit.id,
    name: "Synthetic late enrolled student",
    studentNumber: randomUUID(),
  });
  await ok("/school/students/" + student.id + "/enrollments", {
    enrollment: {
      yearId: f.year.id,
      gradeLevel: "Example 3",
      startsOn: "2026-02-01",
      endsOn: "2026-12-31",
    },
  });
  await ok("/school/sections/" + f.section.id + "/roster", {
    studentId: student.id,
    startsOn: "2026-02-01",
    endsOn: "2026-06-30",
  });
  let data = (await get("/school/gradebooks/" + a.book.id)).body;
  assert.equal(data.rosterCurrent, false);
  assert.equal(
    (
      await send(
        "/school/gradebooks/" + a.book.id + "/review",
        {
          version: 3,
          action: "submit",
          reason: "Stale class roster must be reconciled first.",
        },
        f.teacherAuth,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        "/school/gradebooks/" + a.book.id + "/reconcile",
        { version: 3, reason: "Teacher cannot replace captured roster." },
        f.teacherAuth,
      )
    ).status,
    403,
  );
  await ok("/school/gradebooks/" + a.book.id + "/reconcile", {
    version: 3,
    reason: "Office reviewed late enrollment against the term.",
  });
  data = (await get("/school/gradebooks/" + a.book.id)).body;
  assert.equal(data.results.length, 2);
  assert.equal(
    data.results.find((row: any) => row.student_id === student.id).pending,
    1,
  );
  await ok("/school/sections/" + f.section.id + "/roster", {
    studentId: f.student.id,
    startsOn: "2026-01-01",
    endsOn: "2026-02-28",
    version: 1,
  });
  await ok("/school/gradebooks/" + a.book.id + "/reconcile", {
    version: data.book.version,
    reason: "Office reviewed earlier class end date.",
  });
  data = (await get("/school/gradebooks/" + a.book.id)).body;
  const prior = data.scores.find((row: any) => row.student_id === f.student.id);
  assert.equal(prior.expected, false);
  assert.equal(prior.points_units, 8000);
  const edit={bookVersion:data.book.version,version:data.assignments[0].version,title:'Updated synthetic assignment',instructions:'',categoryId:f.rules.categories[0].id,dueOn:'2026-03-15',maxPointsUnits:5000,archived:false,reason:'Adjust current assignment after departure, retaining historical points.'};
  const updated=await ok('/school/grade-assignments/'+a.assignment.id,edit,f.teacherAuth,'patch');
  assert.equal(updated.max_points_units,5000);
  assert.equal((await send('/school/grade-assignments/'+a.assignment.id,{...edit,version:updated.version,bookVersion:edit.bookVersion+1,dueOn:'2026-01-20'},f.teacherAuth,'patch')).status,409);

});
