import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff } from "../server/workforce";
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  careMilliseconds,
  careCheckinInput,
  careCheckoutInput,
} from "../shared/care";
let db: Database,
  app: ReturnType<typeof createApp>,
  owner: Actor,
  auth: any,
  units: any[],
  jobs: any[];
const origin = "http://localhost:3000";
const today = () => DateTime.now().setZone("America/New_York").toISODate()!;
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
  await initialize(db, { demo: false, ownerEmail: "care.owner@example.test" });
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  jobs = (await db.query("SELECT * FROM jobs")).rows;
  owner = {
    id: u.id,
    org_id: u.org_id,
    name: u.name,
    email: u.email,
    role: "owner",
    mode: "password",
    unit_ids: units.map((u) => u.id),
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
async function fixture(overrides: any = {}) {
  const unit = units[0],
    staffId = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic Care Staff",
          email: randomUUID() + "@stjw.org",
          role: "employee",
          unitIds: [unit.id],
          jobIds: [jobs.find((j) => j.unit_id === unit.id).id],
        },
        "stjw.org",
      ),
    );
  const staff = {
      ...owner,
      id: staffId,
      role: "employee",
      unit_ids: [unit.id],
    },
    staffAuth = await session(staff);
  const input = {
    unitId: unit.id,
    name: "Synthetic program " + randomUUID(),
    room: "Example room",
    capacity: 10,
    instructions: "Synthetic handoff instructions only.",
    confirmed: true,
    archived: false,
    staffIds: [staffId],
    version: 0,
    reason: "Synthetic program setup",
    ...overrides,
  };
  const program = await ok("/care/programs", input),
    children: any[] = [];
  for (let n = 0; n < 2; n++) {
    const child = await ok("/school/students", {
      unitId: unit.id,
      name: "Synthetic child " + n,
      studentNumber: randomUUID(),
    });
    await ok("/care/programs/" + program.id + "/enrollments", {
      studentId: child.id,
      startsOn: today(),
      endsOn: today(),
      enabled: true,
      version: 0,
      reason: "Synthetic enrollment",
    });
    children.push(child);
  }
  const contact = await ok("/school/people", {
    unitId: unit.id,
    name: "Synthetic collector",
    email: "",
    phone: "",
  });
  const contactInput = {
    personId: contact.id,
    relationship: "Designated adult",
    isGuardian: false,
    canCommunicate: false,
    canPickup: true,
    pickupUntil: today(),
    restrictionNote: "",
  };
  for (const child of children)
    await ok("/school/students/" + child.id + "/contacts", contactInput);
  const checkin = (index = 0) => ({
    programId: program.id,
    programVersion: program.version,
    studentId: children[index].id,
    arrivalName: "Synthetic arriving adult",
    received: true,
    commandId: randomUUID(),
  });
  const checkout = () => ({
    contactId: contact.id,
    contactVersion: 1,
    personVersion: 1,
    identityMethod: "photo_id",
    identityConfirmed: true,
    released: true,
    note: "Synthetic handoff",
    commandId: randomUUID(),
  });
  return {
    unit,
    staff,
    staffAuth,
    input,
    program,
    children,
    contact,
    contactInput,
    checkin,
    checkout,
  };
}
test("care checks require scoped password access and explicit current program staff, independent of classroom or financial roles", async () => {
  const f = await fixture(),
    other = await fixture();
  assert.equal(
    (await get("/care/programs/" + f.program.id, other.staffAuth)).status,
    404,
  );
  assert.equal(
    (await get("/care/programs/" + f.program.id, await session(f.staff, "pin")))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        "/care/programs",
        { ...f.input, name: "Forbidden" },
        f.staffAuth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await get(
        "/care/timesheets?programId=" +
          f.program.id +
          "&from=" +
          today() +
          "&to=" +
          today(),
        f.staffAuth,
      )
    ).status,
    403,
  );
  assert.equal(
    (await get("/school/students/" + f.children[0].id, f.staffAuth)).status,
    404,
  );
  await db.query("UPDATE users SET role='finance' WHERE id=$1", [
    other.staff.id,
  ]);
  assert.equal(
    (await get("/care/programs/" + f.program.id, other.staffAuth)).status,
    404,
  );
  const active = await get("/care/programs/" + f.program.id, f.staffAuth);
  assert.equal(active.status, 200);
  assert.equal(JSON.stringify(active.body).includes("date_of_birth"), false);
  await db.query("DELETE FROM user_units WHERE user_id=$1", [f.staff.id]);
  assert.equal(
    (await get("/care/programs/" + f.program.id, f.staffAuth)).status,
    404,
  );
});
test("confirmed program and enrollment gates, capacity serialization, and actor-bound idempotent check-in", async () => {
  const f = await fixture({ capacity: 1, confirmed: false }),
    input = f.checkin();
  assert.equal((await send("/care/check-in", input, f.staffAuth)).status, 409);
  const p = await ok(
    "/care/programs/" + f.program.id,
    { ...f.input, confirmed: true, version: 1 },
    auth,
    "patch",
  );
  input.programVersion = p.version;
  const same = await Promise.all([
    send("/care/check-in", input, f.staffAuth),
    send("/care/check-in", input, f.staffAuth),
  ]);
  assert.deepEqual(
    same.map((r) => r.status),
    [200, 200],
  );
  assert.equal(same[0].body.id, same[1].body.id);
  assert.equal(
    (
      await send(
        "/care/check-in",
        { ...input, arrivalName: "Different adult" },
        f.staffAuth,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        "/care/check-in",
        { ...f.checkin(1), programVersion: p.version },
        f.staffAuth,
      )
    ).status,
    409,
  );
  assert.equal(
    (await db.query("SELECT id FROM care_sessions WHERE program_id=$1", [p.id]))
      .rows.length,
    1,
  );
  const f2 = await fixture({ capacity: 1 });
  const results = await Promise.all([
    send("/care/check-in", f2.checkin(0), f2.staffAuth),
    send("/care/check-in", f2.checkin(1), f2.staffAuth),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const f3 = await fixture();
  await ok("/care/programs/" + f3.program.id + "/enrollments", {
    studentId: f3.children[0].id,
    startsOn: today(),
    endsOn: today(),
    enabled: false,
    version: 1,
    reason: "Disabled fixture",
  });
  assert.equal(
    (await send("/care/check-in", f3.checkin(), f3.staffAuth)).status,
    409,
  );
});
test("pickup enforces permission rather than guardian flag, date expiry, version, identity confirmation, and child-wide restrictions", async () => {
  const f = await fixture(),
    s = await ok("/care/check-in", f.checkin(), f.staffAuth),
    path = "/care/sessions/" + s.id + "/check-out";
  assert.equal(
    (
      await send(
        path,
        { ...f.checkout(), identityConfirmed: false },
        f.staffAuth,
      )
    ).status,
    400,
  );
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    isGuardian: true,
    canPickup: false,
    version: 1,
  });
  assert.equal((await send(path, f.checkout(), f.staffAuth)).status, 409);
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    pickupUntil: DateTime.fromISO(today()).minus({ days: 1 }).toISODate(),
    version: 2,
  });
  assert.equal(
    (await send(path, { ...f.checkout(), contactVersion: 3 }, f.staffAuth))
      .status,
    409,
  );
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    version: 3,
  });
  assert.equal((await send(path, f.checkout(), f.staffAuth)).status, 409);
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    restrictionNote: "Office review required for this synthetic child.",
    version: 4,
  });
  assert.equal(
    (await send(path, { ...f.checkout(), contactVersion: 5 }, f.staffAuth))
      .status,
    409,
  );
  const state = await get("/care/sessions/" + s.id + "/pickup", f.staffAuth);
  assert.equal(state.body.restricted, true);
  assert.equal(state.body.contacts[0].eligible, false);
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    version: 5,
  });
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: true, version: 0, reason: "Synthetic office hold" },
    auth,
    "put",
  );
  assert.equal(
    (await send(path, { ...f.checkout(), contactVersion: 6 }, f.staffAuth))
      .status,
    409,
  );
  assert.equal(
    (
      await send(
        "/care/students/" + f.children[0].id + "/hold",
        { active: false, version: 1, reason: "Staff override attempt" },
        f.staffAuth,
        "put",
      )
    ).status,
    403,
  );
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: false, version: 1, reason: "Office resolved synthetic hold" },
    auth,
    "put",
  );
  await ok(
    "/school/people/" + f.contact.id,
    { name: "Renamed synthetic collector", email: "", phone: "", version: 1 },
    auth,
    "patch",
  );
  assert.equal(
    (await send(path, { ...f.checkout(), contactVersion: 6 }, f.staffAuth))
      .status,
    409,
  );
  const result = await ok(
    path,
    { ...f.checkout(), contactVersion: 6, personVersion: 2 },
    f.staffAuth,
  );
  assert.ok(result.checkedOutAt);
});
test("simultaneous checkout records one release, retries preserve it, original timestamps and pickup evidence are immutable", async () => {
  const f = await fixture(),
    s = await ok("/care/check-in", f.checkin(), f.staffAuth),
    input = f.checkout(),
    path = "/care/sessions/" + s.id + "/check-out";
  const results = await Promise.all([
    send(path, input, f.staffAuth),
    send(path, input, f.staffAuth),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal((await send(path, f.checkout(), f.staffAuth)).status, 409);
  const row = (
    await db.query("SELECT * FROM care_sessions WHERE id=$1", [s.id])
  ).rows[0];
  assert.equal(row.pickup_snapshot.contactVersion, 1);
  assert.equal(row.program_snapshot.version, 1);
  assert.equal(row.pickup_snapshot.identityConfirmed, true);
  await assert.rejects(
    () =>
      db.query(
        "UPDATE care_sessions SET release_note='replacement' WHERE id=$1",
        [s.id],
      ),
    /cannot be changed/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM care_sessions WHERE id=$1", [s.id]),
    /cannot be deleted/,
  );
  const audit = (
    await db.query(
      "SELECT detail FROM audit_events WHERE target_id=$1 AND action LIKE 'school.care.%'",
      [s.id],
    )
  ).rows;
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes("Synthetic collector"), false);
  const history = (
    await db.query(
      "SELECT snapshot FROM school_history WHERE entity_id=$1 AND entity_type='care.checked_out'",
      [s.id],
    )
  ).rows;
  assert.equal(
    history[0].snapshot.after.pickup_snapshot.name,
    "Synthetic collector",
  );
  await ok(
    "/care/programs/" + f.program.id,
    { ...f.input, version: 1, staffIds: [] },
    auth,
    "patch",
  );
  assert.equal((await send(path, input, f.staffAuth)).status, 404);
});
test("one child cannot check into two programs; program edits retain active departures and reject stale or invalid changes", async () => {
  const f = await fixture(),
    second = await ok("/care/programs", {
      ...f.input,
      name: "Second synthetic room",
    });
  await ok("/care/programs/" + second.id + "/enrollments", {
    studentId: f.children[0].id,
    startsOn: today(),
    endsOn: today(),
    enabled: true,
    version: 0,
    reason: "Alternative program fixture",
  });
  const a = f.checkin(),
    b = { ...f.checkin(), programId: second.id };
  const concurrent = await Promise.all([
    send("/care/check-in", a, f.staffAuth),
    send("/care/check-in", b, f.staffAuth),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const win = concurrent[0].status === 200 ? f.program : second,
    s = concurrent.find((r) => r.status === 200)!.body;
  assert.equal(
    (
      await send(
        "/care/programs/" + win.id,
        { ...f.input, version: 1, archived: true },
        auth,
        "patch",
      )
    ).status,
    409,
  );
  await ok(
    "/care/programs/" + win.id,
    { ...f.input, version: 1, confirmed: false },
    auth,
    "patch",
  );
  assert.equal(
    (
      await send(
        "/care/programs/" + win.id,
        { ...f.input, version: 1 },
        auth,
        "patch",
      )
    ).status,
    409,
  );
  // Unconfirming new arrivals does not strand children who need an authorized departure.
  await ok("/care/sessions/" + s.id + "/check-out", f.checkout(), f.staffAuth);
});
test("child timesheets clip at local dates across DST and retain exact elapsed milliseconds and CSV provenance", async () => {
  assert.equal(
    careMilliseconds(
      "2026-11-01T04:00:00Z",
      "2026-11-02T05:00:00Z",
      "2026-11-01T04:00:00Z",
      "2026-11-02T05:00:00Z",
      "2026-11-03T00:00:00Z",
    ),
    25 * 3600000,
  );
  assert.equal(careCheckinInput.safeParse({ received: false }).success, false);
  assert.equal(
    careCheckoutInput.safeParse({ identityConfirmed: false }).success,
    false,
  );
  const f = await fixture();
  const year = new Date().getUTCFullYear() - 1,
    start = `${year}-03-09T04:30:00.123Z`,
    end = `${year}-03-10T05:30:00.456Z`,
    sid = randomUUID();
  await db.query(
    "INSERT INTO care_sessions(id,org_id,unit_id,program_id,student_id,checked_in_at,entered_by,arrival_name,program_snapshot,checked_out_at,released_by,pickup_snapshot,release_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7,$11,$12)",
    [
      sid,
      owner.org_id,
      f.unit.id,
      f.program.id,
      f.children[0].id,
      start,
      owner.id,
      "=formula",
      JSON.stringify({
        name: f.program.name,
        room: "Original room",
        version: 1,
        studentName: "=SUM(1)",
        studentNumber: "Example",
      }),
      end,
      JSON.stringify({
        name: "Synthetic collector",
        contactVersion: 1,
        identityMethod: "photo_id",
      }),
      "Synthetic historical fixture",
    ],
  );
  const from = `${year}-03-09`,
    to = from,
    path =
      "/care/timesheets?programId=" +
      f.program.id +
      "&from=" +
      from +
      "&to=" +
      to;
  const r = await get(path);
  assert.equal(r.status, 200, r.body.error);
  const left = DateTime.fromISO(from, { zone: "America/New_York" }).startOf(
      "day",
    ),
    right = left.plus({ days: 1 });
  assert.equal(r.body.totalMilliseconds, right.toMillis() - left.toMillis());
  assert.equal(r.body.rows[0].room, "Original room");
  const csv = await get(path.replace("timesheets?", "timesheets/export?"));
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes("'=SUM(1)"));
  assert.ok(csv.text.includes("milliseconds_in_range"));
  assert.ok(csv.text.includes("pickup_contact_version"));
  assert.ok(csv.text.includes("America/New_York"));
  assert.equal(
    (
      await get(
        "/care/timesheets?programId=" +
          f.program.id +
          "&from=2020-01-01&to=2026-01-01",
      )
    ).status,
    400,
  );
});
