import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff } from "../server/workforce";
import { createStudent } from "../server/school";
import {
  createApplication,
  advanceApplication,
  enrollApplication,
} from "../server/admissions";
import {
  admissionCreateInput,
  admissionEnrollInput,
} from "../shared/admissions";
import { digest, opaqueToken, type Actor } from "../server/security";
let db: Database,
  owner: Actor,
  units: any[],
  jobs: any[],
  app: ReturnType<typeof createApp>,
  auth: any;
const origin = "http://localhost:3000";
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      digest(token),
      actor.org_id,
      actor.id,
      mode,
      csrf,
      new Date(Date.now() + 600000),
    ],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "admission.owner@example.test",
  });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  jobs = (await db.query("SELECT * FROM jobs ORDER BY title")).rows;
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
async function fixture(confirmed = true, required = true) {
  const unitId = units[0].id,
    settings = (await get("/school/admissions/settings?unitId=" + unitId)).body,
    requirement = {
      id: randomUUID(),
      title: "Synthetic office review",
      required,
    };
  const saved = await send(
    "/school/admissions/settings",
    {
      unitId,
      version: settings.version,
      confirmed,
      reason: "Synthetic test checklist configuration",
      requirements: [requirement],
    },
    auth,
    "put",
  );
  assert.equal(saved.status, 200, saved.body.error);
  const year = (
      await send("/school/years", {
        unitId,
        name: "Synthetic admissions " + randomUUID(),
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
      })
    ).body,
    contact = (
      await send("/school/people", {
        unitId,
        name: "Synthetic application contact",
        email: "example@example.invalid",
        phone: "",
      })
    ).body,
    application = await createApplication(
      db,
      owner,
      admissionCreateInput.parse({
        commandId: randomUUID(),
        unitId,
        yearId: year.id,
        name: "Synthetic applicant",
        dateOfBirth: null,
        primaryContactId: contact.id,
        gradeLevel: "Example 3",
        notes: "Synthetic intake note",
      }),
    );
  return {
    unitId,
    year,
    contact,
    application,
    requirement,
    policy: saved.body,
  };
}
async function move(row: any, status: any) {
  return await advanceApplication(db, owner, row.id, {
    version: row.version,
    status,
    reason: "Synthetic office recorded this stage transition.",
  });
}
async function complete(row: any, itemId: string) {
  const result = await send("/school/admissions/" + row.id + "/checklist", {
    version: row.version,
    itemId,
    status: "complete",
    evidence: "Synthetic item reviewed in the test office.",
  });
  assert.equal(result.status, 200, result.body.error);
  return result.body;
}
async function accepted(f: any) {
  let row = await complete(f.application, f.requirement.id);
  for (const status of ["application", "review", "offered", "accepted"])
    row = await move(row, status);
  return row;
}
const enrollment = (row: any) =>
  admissionEnrollInput.parse({
    version: row.version,
    studentNumber: "ADMIT-" + randomUUID().slice(0, 8),
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
    contactCanCommunicate: true,
    reason: "Synthetic accepted application enrollment reviewed.",
  });
test("concurrent re-enrollment across years preserves one existing student identity", async () => {
  const f = await fixture();
  const student = await createStudent(db, owner, {
    unitId: f.unitId,
    name: "Synthetic concurrent returning student",
    studentNumber: "RETURN-" + randomUUID().slice(0, 8),
    dateOfBirth: null,
    householdId: null,
  });
  const secondYear = (
    await send("/school/years", {
      unitId: f.unitId,
      name: "Synthetic second return year " + randomUUID(),
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    })
  ).body;
  const applications = [];
  for (const year of [f.year, secondYear]) {
    const application = await createApplication(
      db,
      owner,
      admissionCreateInput.parse({
        unitId: f.unitId,
        yearId: year.id,
        commandId: randomUUID(),
        existingStudentId: student.id,
        name: "Synthetic concurrent returning student",
        gradeLevel: "Example 4",
      }),
    );
    applications.push(await accepted({ ...f, application }));
  }
  const results = await Promise.all(
    applications.map((row) =>
      enrollApplication(db, owner, row.id, {
        ...enrollment(row),
        studentNumber: student.student_number,
        contactCanCommunicate: false,
      }),
    ),
  );
  assert.ok(results.every((result) => result.student.id === student.id));
  assert.equal(
    (
      await db.query("SELECT id FROM students WHERE person_id=$1", [
        student.person_id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM student_enrollments WHERE student_id=$1", [
        student.id,
      ])
    ).rows.length,
    2,
  );
});
test("confirmed complete admissions conversion reuses applicant identity and grants no pickup or guardian authority", async () => {
  const f = await fixture(),
    row = await accepted(f),
    countBefore = (
      await db.query("SELECT count(*)::int AS n FROM school_people")
    ).rows[0].n,
    result = await enrollApplication(db, owner, row.id, enrollment(row));
  assert.equal(result.application.status, "enrolled");
  assert.equal(result.student.person_id, f.application.applicant_id);
  assert.equal(result.enrollment.year_id, f.year.id);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM school_people")).rows[0].n,
    countBefore,
  );
  const contact = (
    await db.query("SELECT * FROM student_contacts WHERE student_id=$1", [
      result.student.id,
    ])
  ).rows[0];
  assert.equal(contact.is_guardian, false);
  assert.equal(contact.can_pickup, false);
  assert.equal(contact.can_communicate, true);
  await assert.rejects(
    () => enrollApplication(db, owner, row.id, enrollment(row)),
    /current accepted/,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM student_enrollments WHERE student_id=$1", [
        result.student.id,
      ])
    ).rows.length,
    1,
  );
  const history = (await get("/school/admissions/" + row.id)).body.history;
  assert.ok(
    history.some((entry: any) => entry.entity_type === "admission.enrolled"),
  );
  await assert.rejects(
    () => db.query("DELETE FROM school_history WHERE entity_id=$1", [row.id]),
    /append-only/,
  );
  const audit = (
    await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [
      row.id,
    ])
  ).rows;
  assert.ok(audit.length);
  assert.ok(!JSON.stringify(audit).includes("Synthetic applicant"));
});
test("unconfirmed policies, incomplete required items and illegal stage changes are denied", async () => {
  const f = await fixture(false),
    application = await move(f.application, "application"),
    review = await move(application, "review");
  await assert.rejects(() => move(review, "offered"), /confirm/);
  const settings = await send(
    "/school/admissions/settings",
    {
      unitId: f.unitId,
      version: f.policy.version,
      confirmed: true,
      requirements: [f.requirement],
      reason: "Synthetic checklist confirmed by the office.",
    },
    auth,
    "put",
  );
  assert.equal(settings.status, 200);
  await assert.rejects(() => move(review, "offered"), /template changed/);
  const refreshed = await send(
    "/school/admissions/" + review.id + "/refresh-checklist",
    {
      version: review.version,
      policyVersion: settings.body.version,
      reason: "Reviewed the current synthetic checklist template.",
    },
  );
  assert.equal(refreshed.status, 200);
  await assert.rejects(
    () => move(refreshed.body, "offered"),
    /required checklist/,
  );
  const badEvidence = await send(
    "/school/admissions/" + review.id + "/checklist",
    {
      version: refreshed.body.version,
      itemId: f.requirement.id,
      status: "waived",
      evidence: "",
    },
  );
  assert.equal(badEvidence.status, 400);
  const waived = await send("/school/admissions/" + review.id + "/checklist", {
    version: refreshed.body.version,
    itemId: f.requirement.id,
    status: "waived",
    evidence: "Synthetic office documented why this item is waived.",
  });
  assert.equal(waived.status, 200);
  const offered = await move(waived.body, "offered");
  assert.equal(offered.status, "offered");
  await assert.rejects(
    () => move(offered, "enrolled"),
    /separate reviewed conversion/,
  );
});
test("template replacement requires reviewed version and returns accepted applications to review", async () => {
  const f = await fixture(),
    row = await accepted(f),
    requirement = {
      id: randomUUID(),
      title: "Additional synthetic review",
      required: true,
    };
  const settings = await send(
    "/school/admissions/settings",
    {
      unitId: f.unitId,
      version: f.policy.version,
      confirmed: true,
      requirements: [f.requirement, requirement],
      reason: "Synthetic additional review requirement added.",
    },
    auth,
    "put",
  );
  assert.equal(settings.status, 200);
  await assert.rejects(
    () => enrollApplication(db, owner, row.id, enrollment(row)),
    /template changed/,
  );
  const stale = await send(
    "/school/admissions/" + row.id + "/refresh-checklist",
    {
      version: row.version,
      policyVersion: f.policy.version,
      reason: "Trying an obsolete template preview.",
    },
  );
  assert.equal(stale.status, 409);
  const refreshed = await send(
    "/school/admissions/" + row.id + "/refresh-checklist",
    {
      version: row.version,
      policyVersion: settings.body.version,
      reason: "Reviewed the added synthetic checklist item.",
    },
  );
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.status, "review");
  assert.equal(
    refreshed.body.checklist.find((item: any) => item.id === f.requirement.id)
      .status,
    "complete",
  );
  assert.equal(
    refreshed.body.checklist.find((item: any) => item.id === requirement.id)
      .status,
    "pending",
  );
  assert.equal(
    (await get("/school/admissions/" + row.id)).body.history.some(
      (entry: any) => entry.entity_type === "admission.checklist_refreshed",
    ),
    true,
  );
});
test("reenrollment preserves existing student identity and independent contact permissions", async () => {
  const f = await fixture(),
    student = await createStudent(db, owner, {
      unitId: f.unitId,
      name: "Existing synthetic student",
      studentNumber: "EXIST-" + randomUUID().slice(0, 8),
      dateOfBirth: null,
      householdId: null,
    });
  await send("/school/students/" + student.id + "/contacts", {
    personId: f.contact.id,
    relationship: "Verified synthetic contact",
    isGuardian: true,
    canCommunicate: false,
    canPickup: true,
  });
  const application = await createApplication(
    db,
    owner,
    admissionCreateInput.parse({
      commandId: randomUUID(),
      unitId: f.unitId,
      yearId: f.year.id,
      existingStudentId: student.id,
      name: "Ignored supplied name",
      primaryContactId: f.contact.id,
      gradeLevel: "Example 4",
    }),
  );
  const row = await accepted({ ...f, application }),
    result = await enrollApplication(db, owner, row.id, {
      ...enrollment(row),
      studentNumber: student.student_number,
    });
  assert.equal(result.student.id, student.id);
  const contact = (
    await db.query(
      "SELECT * FROM student_contacts WHERE student_id=$1 AND person_id=$2",
      [student.id, f.contact.id],
    )
  ).rows[0];
  assert.equal(contact.is_guardian, true);
  assert.equal(contact.can_communicate, false);
  assert.equal(contact.can_pickup, true);
  const history = (await get("/school/admissions/" + row.id)).body.history.find(
    (entry: any) => entry.entity_type === "admission.created",
  );
  assert.equal(
    history.snapshot.after.applicantName,
    "Existing synthetic student",
  );
  await assert.rejects(
    () =>
      createApplication(
        db,
        owner,
        admissionCreateInput.parse({
          commandId: randomUUID(),
          unitId: f.unitId,
          yearId: f.year.id,
          existingStudentId: student.id,
          name: "Existing student",
          gradeLevel: "Example 4",
        }),
      ),
    /already has an enrollment/,
  );
});
test("office grants and tenant/unit checks protect intake, policy, checklist and conversion endpoints", async () => {
  const f = await fixture(),
    job = jobs.find((row) => row.unit_id === units[1].id),
    email = randomUUID() + "@stjw.org",
    id = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic other-unit manager",
          email,
          role: "manager",
          unitIds: [units[1].id],
          jobIds: [job.id],
        },
        "stjw.org",
      ),
    ),
    actor = { ...owner, id, email, role: "manager", unit_ids: [units[1].id] },
    other = await session(actor);
  await send("/school/office-grants", {
    unitId: units[1].id,
    userId: id,
    enabled: true,
  });
  assert.equal(
    (await get("/school/admissions/" + f.application.id, other)).status,
    403,
  );
  assert.equal(
    (await get("/school/admissions/settings?unitId=" + f.unitId, other)).status,
    403,
  );
  assert.equal(
    (
      await send(
        "/school/admissions/" + f.application.id + "/stage",
        {
          version: 1,
          status: "application",
          reason: "Outside-unit unauthorized transition attempt.",
        },
        other,
      )
    ).status,
    403,
  );
  const pin = await session(owner, "pin");
  assert.equal(
    (await get("/school/admissions/" + f.application.id, pin)).status,
    403,
  );
  const contact = (
    await send("/school/people", {
      unitId: units[1].id,
      name: "Outside contact",
    })
  ).body;
  await assert.rejects(
    () =>
      createApplication(
        db,
        owner,
        admissionCreateInput.parse({
          commandId: randomUUID(),
          unitId: f.unitId,
          yearId: f.year.id,
          name: "Synthetic foreign contact attempt",
          primaryContactId: contact.id,
          gradeLevel: "Example",
        }),
      ),
    /Contact person/,
  );
  await assert.rejects(
    () =>
      createApplication(
        db,
        owner,
        admissionCreateInput.parse({
          commandId: randomUUID(),
          unitId: units[1].id,
          yearId: f.year.id,
          name: "Synthetic foreign year attempt",
          gradeLevel: "Example",
        }),
      ),
    /school year/,
  );
});
test("concurrent conversion creates one enrollment and invalid dates roll back atomically", async () => {
  const f = await fixture(),
    row = await accepted(f),
    input = enrollment(row);
  await assert.rejects(
    () =>
      enrollApplication(db, owner, row.id, {
        ...input,
        startsOn: "2025-12-31",
      }),
    /school year/,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM students WHERE person_id=$1", [
        f.application.applicant_id,
      ])
    ).rows.length,
    0,
  );
  const results = await Promise.allSettled([
    enrollApplication(db, owner, row.id, input),
    enrollApplication(db, owner, row.id, input),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM students WHERE person_id=$1", [
        f.application.applicant_id,
      ])
    ).rows.length,
    1,
  );
  const application = (await get("/school/admissions/" + row.id)).body
    .application;
  assert.equal(application.status, "enrolled");
  const changed = await send("/school/admissions/" + row.id + "/checklist", {
    version: application.version,
    itemId: f.requirement.id,
    status: "pending",
    evidence: "",
  });
  assert.equal(changed.status, 409);
});
test("intake retries create one applicant and contact, and changed payloads cannot reuse the command", async () => {
  const f = await fixture(),
    before = (await db.query("SELECT count(*)::int AS n FROM school_people"))
      .rows[0].n,
    input = admissionCreateInput.parse({
      commandId: randomUUID(),
      unitId: f.unitId,
      yearId: f.year.id,
      name: "Synthetic retry applicant",
      gradeLevel: "Example",
      newContact: {
        name: "Synthetic new contact",
        email: "contact@example.invalid",
        phone: "",
      },
    });
  const rows = await Promise.all([
    createApplication(db, owner, input),
    createApplication(db, owner, input),
  ]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM school_people")).rows[0].n,
    before + 2,
  );
  await assert.rejects(
    () =>
      createApplication(db, owner, {
        ...input,
        notes: "Changed intake data with reused command",
      }),
    /different details/,
  );
});
