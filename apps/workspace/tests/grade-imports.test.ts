import {
  parseGradeCsv,
  applyGradeImport,
  previewGradeImport,
} from "../server/grade-imports";
import { toCsv } from "../server/reports";
import { gradeImportColumns } from "../shared/grade-imports";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
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
  return { cookie: "stjw_session=" + token, csrf, hash: digest(token) };
}
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "import.owner@example.test",
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
async function template(f: any, a: any) {
  const response = await get(
    `/school/grade-assignments/${a.assignment.id}/import-template`,
    f.teacherAuth,
  );
  assert.equal(response.status, 200, response.text);
  return parseGradeCsv(response.text);
}
const csv = (rows: any[]) => toCsv(rows, [...gradeImportColumns]);
async function preview(f: any, a: any, rows?: any[]) {
  rows ??= (await template(f, a)).map((row) => ({
    ...row,
    status: "scored",
    points: "89.99",
    note: "Reviewed synthetic import",
  }));
  return ok(
    `/school/grade-assignments/${a.assignment.id}/import-previews`,
    { csv: csv(rows), reason: "Synthetic import review" },
    f.teacherAuth,
  );
}
const confirmation = (p: any) => ({
  sourceHash: p.sourceHash,
  planHash: p.planHash,
  reviewed: true as const,
});

test("grade CSV parser bounds source rows and requires the exact unambiguous columns", () => {
  assert.throws(() => parseGradeCsv("studentId,status\nx,scored"), /columns/);
  assert.throws(
    () => parseGradeCsv(gradeImportColumns.join(",") + "\n"),
    /captured roster/,
  );
  const row = Object.fromEntries(gradeImportColumns.map((x) => [x, "x"]));
  assert.throws(
    () => parseGradeCsv(csv(Array.from({ length: 201 }, () => row))),
    /captured roster/,
  );
  assert.throws(
    () => parseGradeCsv(gradeImportColumns.join(",") + '\n"unterminated'),
    /CSV could not/,
  );
});
test("reviewed grade imports are exact, private, immutable and idempotent, with original-source provenance", async () => {
  const f = await fixture(),
    a = await assignment(f),
    p = await preview(f, a);
  assert.equal(p.plan.errors, 0);
  assert.equal(p.plan.rows[0].after.pointsUnits, 8999);
  assert.equal((await get(`/school/grade-imports/${p.id}`)).status, 404);
  assert.equal(
    (await send(`/school/grade-imports/${p.id}/apply`, confirmation(p))).status,
    404,
  );
  assert.equal(
    (
      await send(
        `/school/grade-imports/${p.id}/apply`,
        { ...confirmation(p), sourceHash: "a".repeat(64) },
        f.teacherAuth,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        `/school/grade-imports/${p.id}/apply`,
        { ...confirmation(p), reviewed: false },
        f.teacherAuth,
      )
    ).status,
    400,
  );
  const receipts = await Promise.all(
    [1, 2].map(() =>
      ok(`/school/grade-imports/${p.id}/apply`, confirmation(p), f.teacherAuth),
    ),
  );
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[0].changed, 1);
  const current = (await get(`/school/gradebooks/${a.book.id}`, f.teacherAuth))
    .body;
  assert.equal(current.scores[0].points_units, 8999);
  assert.equal(current.book.version, p.plan.bookVersion + 1);
  assert.equal(
    current.history.filter(
      (x: any) => x.entity_type === "gradebook.scores_saved",
    ).length,
    1,
  );
  const source = await get(
    `/school/grade-imports/${p.id}/source`,
    f.teacherAuth,
  )
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(digest(source.body.toString("utf-8")), p.sourceHash);
  assert.match(source.headers["content-disposition"], /\.txt/);
  await assert.rejects(
    db.query(
      "UPDATE grade_import_batches SET reason='Changed evidence' WHERE id=$1",
      [p.id],
    ),
    /immutable|unapplied/,
  );
  const events = (
    await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [p.id])
  ).rows;
  assert.ok(!JSON.stringify(events).includes("Synthetic grading student"));
});
test("row review rejects invalid decimals, score status, excess points, wrong identities and duplicate students", async () => {
  const f = await fixture(),
    a = await assignment(f),
    [row] = await template(f, a);
  const cases = [
    { points: "1e2", status: "scored" },
    { points: "1.234", status: "scored" },
    { points: "100.01", status: "scored" },
    { points: "-1", status: "scored" },
    { points: "2", status: "missing" },
    { points: "", status: "scored" },
    { points: "", status: "exempt", note: "" },
    { studentId: randomUUID() },
    { assignmentId: randomUUID() },
    { studentName: "Wrong student" },
  ];
  for (const patch of cases) {
    const p = await preview(f, a, [{ ...row, ...patch }]);
    assert.ok(p.plan.errors > 0, JSON.stringify(patch));
    assert.equal(
      (
        await send(
          `/school/grade-imports/${p.id}/apply`,
          confirmation(p),
          f.teacherAuth,
        )
      ).status,
      409,
    );
  }
  const duplicate = await preview(f, a, [row, row]);
  assert.ok(duplicate.plan.errors > 0);
  assert.equal(
    (
      await db.query(
        "SELECT points_units FROM grade_scores WHERE assignment_id=$1",
        [a.assignment.id],
      )
    ).rows[0].points_units,
    null,
  );
});
test("stale spreadsheets and competing distinct previews cannot overwrite saved scores", async () => {
  const f = await fixture(),
    a = await assignment(f),
    rows = await template(f, a);
  const first = await preview(
    f,
    a,
    rows.map((x) => ({ ...x, status: "scored", points: "12.34" })),
  );
  const second = await preview(
    f,
    a,
    rows.map((x) => ({ ...x, status: "scored", points: "55.55" })),
  );
  const result = await Promise.all(
    [first, second].map((p) =>
      send(
        `/school/grade-imports/${p.id}/apply`,
        confirmation(p),
        f.teacherAuth,
      ),
    ),
  );
  assert.deepEqual(result.map((x) => x.status).sort(), [200, 409]);
  const stale = await preview(
    f,
    a,
    rows.map((x) => ({ ...x, status: "scored", points: "90" })),
  );
  assert.ok(stale.plan.errors > 0);
  assert.match(stale.plan.rows[0].errors.join(), /out of date/);
});
test("apply rechecks current teaching, membership and role access, including service calls with stale actors", async () => {
  const f = await fixture(),
    a = await assignment(f),
    p = await preview(f, a);
  await db.query(
    "DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2",
    [f.section.id, f.teacher.id],
  );
  await assert.rejects(
    applyGradeImport(db, f.teacher, p.id, confirmation(p), f.teacherAuth.hash),
    /Class not found/,
  );
  await assert.rejects(
    applyGradeImport(
      db,
      { ...f.teacher, role: "owner" },
      p.id,
      confirmation(p),
      f.teacherAuth.hash,
    ),
    /Class not found/,
  );
  await assert.rejects(
    applyGradeImport(db, { ...f.teacher, mode: "pin" }, p.id, confirmation(p), f.teacherAuth.hash),
    /Password/,
  );
  await db.query(
    "INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)",
    [owner.org_id, f.unit.id, f.section.id, f.teacher.id],
  );
  await db.query("DELETE FROM user_units WHERE user_id=$1", [f.teacher.id]);
  await assert.rejects(
    applyGradeImport(db, f.teacher, p.id, confirmation(p), f.teacherAuth.hash),
    /Class not found/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT applied_at FROM grade_import_batches WHERE id=$1",
        [p.id],
      )
    ).rows[0].applied_at,
    null,
  );
});
test("imports require current captured roster and open gradebooks; no omitted student is silently cleared", async () => {
  const f = await fixture(),
    a = await assignment(f),
    p = await preview(f, a);
  const another = await ok("/school/students", {
    unitId: f.unit.id,
    name: "Second synthetic learner",
    studentNumber: randomUUID(),
  });
  await ok(`/school/students/${another.id}/enrollments`, {
    enrollment: {
      yearId: f.year.id,
      gradeLevel: "Example 3",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    },
  });
  await ok(`/school/sections/${f.section.id}/roster`, {
    studentId: another.id,
    startsOn: "2026-01-01",
    endsOn: "2026-06-30",
  });
  await assert.rejects(
    applyGradeImport(db, f.teacher, p.id, confirmation(p), f.teacherAuth.hash),
    /roster changed/,
  );
  const current = (await get(`/school/gradebooks/${a.book.id}`, f.teacherAuth))
    .body;
  await ok(
    `/school/gradebooks/${a.book.id}/reconcile`,
    {
      version: current.book.version,
      reason: "Reconcile synthetic additional student",
    },
    auth,
  );
  const rows = await template(f, a),
    omitted = await preview(f, a, [rows[0]]);
  assert.equal(omitted.plan.missing.length, 1);
  await db.query("UPDATE gradebooks SET status='submitted' WHERE id=$1", [
    a.book.id,
  ]);
  await assert.rejects(
    applyGradeImport(db, f.teacher, p.id, confirmation(p), f.teacherAuth.hash),
    /draft gradebook/,
  );
});
test("audit failure rolls back scores, versions and import receipt together", async () => {
  const f = await fixture(),
    a = await assignment(f),
    p = await preview(f, a);
  const broken = {
    ...db,
    transaction: (work: any) =>
      db.transaction((tx) =>
        work({
          query: async (sql: string, params?: unknown[]) => {
            if (
              sql.includes("INSERT INTO audit_events") &&
              params?.includes("grading.import_applied")
            )
              throw new Error("Synthetic audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  } as Database;
  await assert.rejects(
    applyGradeImport(broken, f.teacher, p.id, confirmation(p), f.teacherAuth.hash),
    /Synthetic audit failure/,
  );
  const current = (await get(`/school/gradebooks/${a.book.id}`, f.teacherAuth))
    .body;
  assert.equal(current.book.version, p.plan.bookVersion);
  assert.equal(current.scores[0].points_units, null);
  assert.equal(
    (
      await db.query("SELECT receipt FROM grade_import_batches WHERE id=$1", [
        p.id,
      ])
    ).rows[0].receipt,
    null,
  );
});
test("expired previews and unchanged templates cannot be applied; formula-safe notes round-trip without mutation", async () => {
  const f = await fixture(),
    a = await assignment(f),
    p = await preview(f, a);
  const expiredId = randomUUID();
  await db.query(
    "INSERT INTO grade_import_batches SELECT $1,org_id,unit_id,actor_id,book_id,assignment_id,source_base64,source_hash,plan_hash,plan,reason,created_at,now()-interval '1 minute',NULL,NULL FROM grade_import_batches WHERE id=$2",
    [expiredId, p.id],
  );
  await assert.rejects(
    applyGradeImport(db, f.teacher, expiredId, confirmation(p), f.teacherAuth.hash),
    /expired/,
  );
  const unchanged = await preview(f, a, await template(f, a));
  assert.equal(unchanged.plan.changed, 0);
  await assert.rejects(
    applyGradeImport(db, f.teacher, unchanged.id, confirmation(unchanged), f.teacherAuth.hash),
    /no changes/,
  );
  await db.query(
    "UPDATE grade_scores SET note='=literal formula-like note',student_name='=Synthetic learner' WHERE assignment_id=$1",
    [a.assignment.id],
  );
  const rows = await template(f, a);
  assert.equal(rows[0].studentName, "'=Synthetic learner");
  const roundTrip = await preview(f, a, rows);
  assert.equal(roundTrip.plan.changed, 0);
  assert.equal(roundTrip.plan.errors, 0);
});
