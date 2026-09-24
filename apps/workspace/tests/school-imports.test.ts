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
  createStudent,
  saveEnrollment,
  createSection,
  saveRoster,
} from "../server/school";
import { studentInput, sectionInput, enrollmentInput } from "../shared/school";
import { applySchoolImport } from "../server/school-imports";
let db: Database,
  owner: Actor,
  auth: any,
  app: ReturnType<typeof createApp>,
  unit: any,
  other: any,
  year: any;
const origin = "http://localhost:3000",
  start = "2026-01-01",
  end = "2026-12-31";
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf, hash: digest(token) };
}
const get = (path: string, a = auth) =>
  request(app)
    .get("/api" + path)
    .set("Cookie", a.cookie);
const post = (path: string, body: any, a = auth) =>
  request(app)
    .post("/api" + path)
    .set("Cookie", a.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", a.csrf)
    .send(body);
async function ok(path: string, body: any, a = auth) {
  const response = await post(path, body, a);
  assert.ok(response.status < 300, JSON.stringify(response.body));
  return response.body;
}
const context = (kind = "students", extra = {}) => ({
  kind,
  unitId: unit.id,
  ...extra,
});
const applyBody = (p: any) => ({
  sourceHash: p.sourceHash,
  planHash: p.planHash,
  reviewed: true,
});
const preview = (ctx: any, csv: string, a = auth) =>
  ok("/school/imports/preview", { context: ctx, csv }, a);
const apply = (p: any, a = auth) =>
  post("/school/imports/" + p.id + "/apply", applyBody(p), a);
async function student(number = "S" + randomUUID()) {
  const row = await createStudent(
    db,
    owner,
    studentInput.parse({
      unitId: unit.id,
      name: "Synthetic " + number.slice(0, 8),
      studentNumber: number,
    }),
  );
  await saveEnrollment(
    db,
    owner,
    row.id,
    enrollmentInput.parse({
      yearId: year.id,
      gradeLevel: "1",
      startsOn: start,
      endsOn: end,
    }),
  );
  return row;
}
async function section(capacity = 1, homeroom = false) {
  return createSection(
    db,
    owner,
    sectionInput.parse({
      unitId: unit.id,
      yearId: year.id,
      name: "Synthetic " + randomUUID(),
      capacity,
      homeroom,
      teacherIds: [],
    }),
  );
}
async function staff(role = "employee") {
  const email = randomUUID() + "@stjw.org";
  const job = (
    await db.query("SELECT id FROM jobs WHERE unit_id=$1", [unit.id])
  ).rows[0];
  const id = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic Import Staff",
        email,
        role: role as any,
        unitIds: [unit.id],
        jobIds: [job.id],
      },
      "stjw.org",
    ),
  );
  const actor = { ...owner, id, email, role, unit_ids: [unit.id] };
  return { actor, auth: await session(actor) };
}
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "imports.owner@example.test",
  });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  const units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  unit = units[0];
  other = units[1];
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: "owner",
    mode: "password",
    unit_ids: units.map((u) => u.id),
  };
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
  auth = await session(owner);
  year = await ok("/school/years", {
    unitId: unit.id,
    name: "Synthetic import year",
    startsOn: start,
    endsOn: end,
  });
});
after(async () => {
  await db?.close();
});

test("CSV templates preserve exact identifiers and provide all row errors without business writes", async () => {
  const template = await get(
    "/school/imports/template/students?unitId=" + unit.id,
  );
  assert.equal(template.status, 200);
  assert.match(template.text, /studentNumber/);
  const bad = await preview(
    context(),
    "studentNumber,name,dateOfBirth\n00123,Synthetic Example,2026-02-30\n00123,Synthetic Duplicate,\n00987,X,\n",
  );
  assert.equal(bad.plan.counts.errors, 3);
  assert.ok(bad.plan.rows[0].errors.length >= 2);
  assert.equal((await apply(bad)).status, 409);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM students WHERE student_number IN ('00123','00987')",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await post("/school/imports/preview", {
        context: context(),
        csv: "name,studentNumber,dateOfBirth\nExample,123,",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/school/imports/preview", {
        context: context(),
        csv: "studentNumber,name,dateOfBirth\n123,Example",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/school/imports/preview", {
        context: context(),
        csv:
          "studentNumber,name,dateOfBirth\n" +
          Array.from({ length: 501 }, (_, i) => `${i},Example,`).join("\n"),
      })
    ).status,
    400,
  );
  const p = await preview(
    context(),
    '\uFEFFstudentNumber,name,dateOfBirth\r\n00123,"Synthetic, Example",2019-02-28\r\n',
  );
  assert.equal(p.plan.rows[0].input.studentNumber, "00123");
  assert.equal(p.plan.counts.create, 1);
  const saved = await apply(p);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.receipt.records.length, 1);
  assert.equal(
    (await db.query("SELECT count(*)::integer AS n FROM student_contacts"))
      .rows[0].n,
    0,
  );
  const duplicate = await preview(
    context(),
    "studentNumber,name,dateOfBirth\n00123,Replacement Name,\n",
  );
  assert.equal(duplicate.plan.counts.errors, 1);
  assert.match(duplicate.plan.rows[0].errors[0], /already exists/);
});
test("imports require current office access, password sessions, actor ownership and exact context", async () => {
  const person = await staff(),
    admin = await staff("admin");
  assert.equal(
    (
      await post(
        "/school/imports/preview",
        {
          context: context(),
          csv: "studentNumber,name,dateOfBirth\nPRIVATE,Example,",
        },
        person.auth,
      )
    ).status,
    403,
  );
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: person.actor.id,
    enabled: true,
  });
  const p = await preview(
    context(),
    "studentNumber,name,dateOfBirth\nPRIVATE,Example,",
    person.auth,
  );
  assert.equal((await apply(p, admin.auth)).status, 404);
  assert.equal((await get("/school/imports/" + p.id, admin.auth)).status, 404);
  assert.equal(
    (await apply(p, await session(person.actor, "pin"))).status,
    403,
  );
  assert.equal(
    (await get("/school/imports?unitId=" + other.id, person.auth)).status,
    403,
  );
  await ok("/school/office-grants", {
    unitId: unit.id,
    userId: person.actor.id,
    enabled: false,
  });
  assert.equal((await apply(p, person.auth)).status, 403);
  assert.equal((await get("/school/imports/" + p.id, person.auth)).status, 403);
  const wrong = await post("/school/imports/preview", {
    context: { kind: "enrollments", unitId: other.id, yearId: year.id },
    csv: "studentNumber,gradeLevel,startsOn,endsOn,status\nPRIVATE,1,2026-01-01,2026-12-31,enrolled",
  });
  assert.equal(wrong.status, 404);
  const own = await preview(
    context(),
    "studentNumber,name,dateOfBirth\nOWN,Example,",
  );
  assert.equal(
    (
      await post("/school/imports/" + own.id + "/apply", {
        ...applyBody(own),
        reviewed: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/school/imports/" + own.id + "/apply", {
        ...applyBody(own),
        planHash: "0".repeat(64),
      })
    ).status,
    404,
  );
});
test("enrollment preview shows changes, unchanged rows do not increment versions, and stale identities are rejected", async () => {
  const one = await student(),
    two = await student();
  const ctx = context("enrollments", { yearId: year.id });
  const csv = `studentNumber,gradeLevel,startsOn,endsOn,status\n${one.student_number},2,${start},${end},enrolled\n${two.student_number},1,${start},${end},enrolled`;
  const p = await preview(ctx, csv);
  assert.equal(p.plan.counts.update, 1);
  assert.equal(p.plan.counts.unchanged, 1);
  assert.equal(p.plan.rows[0].before.gradeLevel, "1");
  assert.equal(p.plan.rows[0].after.gradeLevel, "2");
  const result = await apply(p);
  assert.equal(result.status, 200);
  assert.equal(result.body.receipt.records.length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT version FROM student_enrollments WHERE student_id=$1",
        [two.id],
      )
    ).rows[0].version,
    1,
  );
  const stale = await preview(ctx, csv.replace(",2,", ",3,"));
  await saveEnrollment(
    db,
    owner,
    one.id,
    enrollmentInput.parse({
      yearId: year.id,
      gradeLevel: "4",
      startsOn: start,
      endsOn: end,
    }),
    2,
  );
  assert.equal((await apply(stale)).status, 409);
  const missing = await preview(
    ctx,
    "studentNumber,gradeLevel,startsOn,endsOn,status\nNONEXISTENT,1,2026-01-01,2026-12-31,enrolled",
  );
  assert.equal(missing.plan.counts.errors, 1);
  const dates = await preview(
    ctx,
    `studentNumber,gradeLevel,startsOn,endsOn,status\n${two.student_number},1,2025-12-31,2026-12-31,enrolled`,
  );
  assert.equal(dates.plan.counts.errors, 1);
});
test("a roster batch checks final dated capacity, preserves omitted students and uses inclusive boundaries", async () => {
  const one = await student(),
    two = await student(),
    three = await student(),
    room = await section(1);
  await saveRoster(db, owner, room.id, {
    studentId: one.id,
    startsOn: start,
    endsOn: "2026-06-30",
  });
  await saveRoster(db, owner, room.id, {
    studentId: two.id,
    startsOn: "2026-07-01",
    endsOn: end,
  });
  const ctx = context("roster", { sectionId: room.id });
  const p = await preview(
    ctx,
    `studentNumber,startsOn,endsOn\n${one.student_number},2026-07-01,2026-12-31\n${two.student_number},2026-01-01,2026-06-30`,
  );
  assert.equal(p.plan.counts.errors, 0);
  assert.equal(p.plan.roster.peak, 1);
  assert.equal((await apply(p)).status, 200);
  const overlap = await preview(
    ctx,
    `studentNumber,startsOn,endsOn\n${three.student_number},2026-06-30,2026-07-01`,
  );
  assert.equal(overlap.plan.counts.errors, 1);
  assert.equal(overlap.plan.roster.peak, 2);
  const unchanged = await preview(
    ctx,
    `studentNumber,startsOn,endsOn\n${one.student_number},2026-07-01,2026-12-31`,
  );
  assert.equal(unchanged.plan.counts.unchanged, 1);
  assert.equal((await apply(unchanged)).status, 200);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM section_students WHERE section_id=$1",
        [room.id],
      )
    ).rows[0].n,
    2,
  );
});
test("competing roster previews cannot overfill, and homeroom, enrollment and source changes force review", async () => {
  const one = await student(),
    two = await student(),
    room = await section(1, true),
    second = await section(2, true),
    ctx = context("roster", { sectionId: room.id });
  const a = await preview(
      ctx,
      `studentNumber,startsOn,endsOn\n${one.student_number},${start},${end}`,
    ),
    b = await preview(
      ctx,
      `studentNumber,startsOn,endsOn\n${two.student_number},${start},${end}`,
    );
  const results = await Promise.all([apply(a), apply(b)]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  const selected = (
    await db.query(
      "SELECT s.student_number,s.id FROM section_students r JOIN students s ON s.id=r.student_id WHERE r.section_id=$1",
      [room.id],
    )
  ).rows[0];
  const conflict = await preview(
    context("roster", { sectionId: second.id }),
    `studentNumber,startsOn,endsOn\n${selected.student_number},${start},${end}`,
  );
  assert.match(conflict.plan.rows[0].errors.join(" "), /homeroom/);
  const loose = await section(5),
    ctx2 = context("roster", { sectionId: loose.id }),
    p = await preview(
      ctx2,
      `studentNumber,startsOn,endsOn\n${selected.student_number},${start},${end}`,
    );
  await saveEnrollment(
    db,
    owner,
    selected.id,
    enrollmentInput.parse({
      yearId: year.id,
      gradeLevel: "1",
      startsOn: start,
      endsOn: "2026-06-30",
    }),
    1,
  );
  assert.equal((await apply(p)).status, 409);
  const dates = await preview(
    ctx2,
    `studentNumber,startsOn,endsOn\n${selected.student_number},${start},${end}`,
  );
  assert.match(dates.plan.rows[0].errors.join(" "), /enrollment/);
});
test("concurrent retry returns one immutable receipt and one set of business and audit writes", async () => {
  const number = "RETRY" + randomUUID().slice(0, 8),
    p = await preview(
      context(),
      `studentNumber,name,dateOfBirth\n${number},Synthetic Retry,`,
    );
  const [a, b] = await Promise.all([apply(p), apply(p)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.appliedAt, b.body.appliedAt);
  assert.deepEqual(a.body.receipt, b.body.receipt);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM students WHERE student_number=$1",
        [number],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM audit_events WHERE target_id=$1 AND action='school.import.applied'",
        [p.id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    () =>
      db.query("UPDATE school_import_batches SET plan='{}' WHERE id=$1", [
        p.id,
      ]),
    /Only an unapplied import/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM school_import_batches WHERE id=$1", [p.id]),
    /immutable/,
  );
  const history = await get("/school/imports?unitId=" + unit.id);
  assert.ok(
    history.body.batches.some((r: any) => r.id === p.id && r.applied_at),
  );
});
test("failed business writes roll back the entire batch, while an expired preview never applies", async () => {
  const suffix = randomUUID().slice(0, 8),
    n1 = "ROLLA" + suffix,
    n2 = "ROLLB" + suffix,
    p = await preview(
      context(),
      `studentNumber,name,dateOfBirth\n${n1},Synthetic Rollback A,\n${n2},Synthetic Rollback B,`,
    );
  const faulty: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO students(") && params?.includes(n2))
              throw new Error("Synthetic write fault");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    () => applySchoolImport(faulty, owner, p.id, applyBody(p), auth.hash),
    /Synthetic write fault/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM students WHERE student_number=ANY($1::text[])",
        [[n1, n2]],
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await get("/school/imports/" + p.id)).body.appliedAt, null);
  const expired = randomUUID();
  await db.query(
    "INSERT INTO school_import_batches(id,org_id,unit_id,actor_id,context,source_hash,plan_hash,input_rows,plan,created_at,expires_at) SELECT $2,org_id,unit_id,actor_id,context,source_hash,plan_hash,input_rows,plan,now()-interval '2 days',now()-interval '1 day' FROM school_import_batches WHERE id=$1",
    [p.id, expired],
  );
  assert.equal((await apply({ ...p, id: expired })).status, 409);
  assert.equal((await apply(p)).status, 200);
});
