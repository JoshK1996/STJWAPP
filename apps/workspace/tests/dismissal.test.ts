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
let db: Database, app: ReturnType<typeof createApp>, owner: Actor, auth: any;
const origin = "http://localhost:3000",
  today = () => DateTime.now().setZone("America/New_York").toISODate()!;
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
    ownerEmail: "dismissal.owner@example.test",
  });
  const u = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  owner = {
    id: u.id,
    org_id: u.org_id,
    name: u.name,
    email: u.email,
    role: "owner",
    mode: "password",
    unit_ids: [],
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
async function fixture(open = true) {
  const unitId = randomUUID();
  await db.query(
    "INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,'school')",
    [unitId, owner.org_id, "Synthetic dismissal " + unitId],
  );
  const staffId = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic Dismissal Staff",
          email: randomUUID() + "@stjw.org",
          role: "employee",
          unitIds: [unitId],
          jobIds: [],
        },
        "stjw.org",
      ),
    ),
    staff = { ...owner, id: staffId, role: "employee", unit_ids: [unitId] },
    staffAuth = await session(staff);
  const year = await ok("/school/years", {
      unitId,
      name: "Synthetic dismissal year",
      startsOn: today().slice(0, 4) + "-01-01",
      endsOn: today().slice(0, 4) + "-12-31",
    }),
    children: any[] = [];
  for (let n = 0; n < 2; n++) {
    const child = await ok("/school/students", {
      unitId,
      name: "Synthetic dismissal child " + n,
      studentNumber: randomUUID(),
    });
    const enrollment = await ok(
      "/school/students/" + child.id + "/enrollments",
      {
        enrollment: {
          yearId: year.id,
          gradeLevel: "Sample",
          startsOn: today(),
          endsOn: today(),
        },
      },
    );
    children.push({ ...child, enrollment });
  }
  const contact = await ok("/school/people", {
      unitId,
      name: "Synthetic dismissal collector",
    }),
    contactInput = {
      personId: contact.id,
      relationship: "Permitted adult",
      isGuardian: false,
      canCommunicate: false,
      canPickup: true,
      pickupUntil: today(),
      restrictionNote: "",
    };
  for (const child of children)
    await ok("/school/students/" + child.id + "/contacts", contactInput);
  const policy = {
    unitId,
    version: 0,
    confirmed: true,
    instructions: "Synthetic dismissal instructions only.",
    staffIds: [staffId],
    reason: "Synthetic configuration.",
  };
  await ok("/dismissal/settings", policy, auth, "put");
  const openInput = {
      unitId,
      yearId: year.id,
      day: today(),
      settingsVersion: 1,
      commandId: randomUUID(),
    },
    run = open ? await ok("/dismissal/runs", openInput) : null,
    path = "/dismissal/runs/" + run?.id;
  const detail = async () => {
    const r = await get(path);
    assert.equal(r.status, 200, r.body.error);
    return r.body;
  };
  const entry = async (n = 0) =>
    (await detail()).entries.find((e: any) => e.student_id === children[n].id);
  const action = async (n: number, input: any, a = staffAuth) =>
    ok(
      path + "/entries/" + children[n].id + "/action",
      { version: (await entry(n)).version, commandId: randomUUID(), ...input },
      a,
    );
  const plan = async (
    n: number,
    mode = "pickup",
    busId: string | null = null,
  ) =>
    ok(path + "/plans", {
      entries: [
        { studentId: children[n].id, version: (await entry(n)).version },
      ],
      mode,
      busId,
      reason: "Synthetic reviewed plan.",
    });
  return {
    unitId,
    staff,
    staffAuth,
    year,
    children,
    contact,
    contactInput,
    policy,
    openInput,
    run,
    path,
    detail,
    entry,
    action,
    plan,
  };
}
test("dismissal configuration and current assignments enforce an independent scope with confirmed-day idempotency", async () => {
  const f = await fixture(false),
    other = await fixture(false);
  assert.equal(
    (await get("/dismissal/settings?unitId=" + f.unitId, other.staffAuth))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        "/dismissal/settings",
        { ...f.policy, version: 1 },
        f.staffAuth,
        "put",
      )
    ).status,
    403,
  );
  assert.equal(
    (await send("/dismissal/runs", f.openInput, f.staffAuth)).status,
    403,
  );
  assert.equal(
    (await get("/dismissal/access", await session(f.staff, "pin"))).status,
    403,
  );
  await ok(
    "/dismissal/settings",
    { ...f.policy, version: 1, confirmed: false },
    auth,
    "put",
  );
  assert.equal(
    (await send("/dismissal/runs", { ...f.openInput, settingsVersion: 2 }))
      .status,
    409,
  );
  await ok("/dismissal/settings", { ...f.policy, version: 2 }, auth, "put");
  const input = { ...f.openInput, settingsVersion: 3 };
  const opened = await Promise.all([
    send("/dismissal/runs", input),
    send("/dismissal/runs", input),
  ]);
  assert.deepEqual(
    opened.map((r) => r.status),
    [200, 200],
  );
  assert.equal(opened[0].body.id, opened[1].body.id);
  assert.equal(
    (
      await send("/dismissal/runs", {
        ...input,
        day: DateTime.fromISO(today()).plus({ days: 1 }).toISODate(),
        commandId: randomUUID(),
      })
    ).status,
    400,
  );
  const p = "/dismissal/runs/" + opened[0].body.id;
  assert.equal((await get(p, f.staffAuth)).body.counts.unaccounted, 2);
  assert.equal((await get(p + "/export", f.staffAuth)).status, 403);
  await db.query("DELETE FROM user_units WHERE user_id=$1", [f.staff.id]);
  assert.equal((await get(p, f.staffAuth)).status, 403);
});
test("pickup arrival never releases a child and current restrictions, versions and call identity control handoff", async () => {
  const f = await fixture();
  await f.plan(0);
  assert.equal(
    (
      await send(
        f.path + "/entries/" + f.children[0].id + "/action",
        {
          action: "call",
          version: (await f.entry()).version,
          contactId: f.contact.id,
          arrivalObserved: true,
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    409,
  );
  await f.action(0, { action: "present", observed: true });
  await f.action(0, {
    action: "call",
    contactId: f.contact.id,
    arrivalObserved: true,
  });
  let e = await f.entry();
  assert.equal(e.status, "called");
  assert.equal(e.released_at, null);
  const input = {
      action: "release_pickup",
      version: e.version,
      contactId: f.contact.id,
      contactVersion: 1,
      personVersion: 1,
      identityMethod: "photo_id",
      identityConfirmed: true,
      released: true,
      note: "Synthetic handoff",
      commandId: randomUUID(),
    },
    path = f.path + "/entries/" + f.children[0].id + "/action";
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: true, version: 0, reason: "Synthetic custody review." },
    auth,
    "put",
  );
  assert.equal((await send(path, input, f.staffAuth)).status, 409);
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: false, version: 1, reason: "Office resolved synthetic review." },
    auth,
    "put",
  );
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    version: 1,
    canPickup: false,
    isGuardian: true,
  });
  assert.equal(
    (await send(path, { ...input, contactVersion: 2 }, f.staffAuth)).status,
    409,
  );
  await ok("/school/students/" + f.children[0].id + "/contacts", {
    ...f.contactInput,
    version: 2,
  });
  assert.equal((await send(path, input, f.staffAuth)).status, 409);
  const attempt = { ...input, contactVersion: 3 };
  const releases = await Promise.all([
    send(path, attempt, f.staffAuth),
    send(path, attempt, f.staffAuth),
  ]);
  assert.deepEqual(
    releases.map((r) => r.status),
    [200, 200],
  );
  assert.equal(releases[0].body.released_at, releases[1].body.released_at);
  assert.equal(
    (await send(path, { ...attempt, commandId: randomUUID() }, f.staffAuth))
      .status,
    409,
  );
  await assert.rejects(
    () =>
      db.query(
        "UPDATE dismissal_entries SET release_snapshot='{}' WHERE run_id=$1 AND student_id=$2",
        [f.run.id, f.children[0].id],
      ),
    /cannot be changed/,
  );
  assert.equal(
    JSON.stringify(
      (
        await db.query(
          "SELECT detail FROM audit_events WHERE action='school.dismissal.release_pickup' AND target_id=$1",
          [f.children[0].id],
        )
      ).rows,
    ).includes("collector"),
    false,
  );
});
test("bus boarding requires the office plan and current driver/vehicle arrival; changes invalidate calls and boarded evidence freezes route identity", async () => {
  const f = await fixture(),
    busInput = {
      name: "Synthetic bus A",
      driverName: "Synthetic driver",
      vehicle: "Example bus 10",
      version: 0,
      reason: "Synthetic route.",
    },
    bus = await ok(f.path + "/buses", busInput);
  await f.plan(0, "bus", bus.id);
  await f.action(0, { action: "present", observed: true });
  assert.equal(
    (
      await send(
        f.path + "/entries/" + f.children[0].id + "/action",
        {
          action: "call",
          version: (await f.entry()).version,
          arrivalObserved: true,
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    409,
  );
  const arrival = {
    version: 1,
    identityMethod: "personally_known",
    identityConfirmed: true,
    vehicleConfirmed: true,
    commandId: randomUUID(),
  };
  await ok(f.path + "/buses/" + bus.id + "/arrival", arrival, f.staffAuth);
  await f.action(0, { action: "call", arrivalObserved: true });
  await ok(
    f.path + "/buses/" + bus.id,
    { ...busInput, version: 2, vehicle: "Replacement example bus 11" },
    auth,
    "patch",
  );
  let e = await f.entry();
  assert.equal(
    (
      await send(
        f.path + "/entries/" + f.children[0].id + "/action",
        {
          action: "release_bus",
          version: e.version,
          busVersion: 2,
          boarded: true,
          note: "",
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    409,
  );
  await f.action(0, {
    action: "cancel_call",
    reason: "Vehicle changed, verify again.",
  });
  await ok(
    f.path + "/buses/" + bus.id + "/arrival",
    { ...arrival, version: 3, commandId: randomUUID() },
    f.staffAuth,
  );
  await f.action(0, { action: "call", arrivalObserved: true });
  const released = await f.action(0, {
    action: "release_bus",
    busVersion: 4,
    boarded: true,
    note: "Boarding witnessed.",
  });
  assert.equal(released.release_snapshot.vehicle, "Replacement example bus 11");
  assert.equal(
    (
      await send(
        f.path + "/buses/" + bus.id,
        { ...busInput, version: 4 },
        auth,
        "patch",
      )
    ).status,
    409,
  );
  const csv = await get(f.path + "/export");
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes("Replacement example bus 11"));
});
test("closeout blocks unresolved children and captures immutable snapshots; reopening preserves earlier evidence", async () => {
  const f = await fixture(),
    detail = await f.detail(),
    review = {
      version: detail.run.version,
      action: "close",
      rosterFingerprint: detail.rosterFingerprint,
      reason: "Synthetic reviewed dismissal.",
      reviewed: true,
    };
  assert.equal((await send(f.path + "/review", review)).status, 409);
  assert.equal(
    (
      await send(
        f.path + "/entries/" + f.children[0].id + "/action",
        {
          action: "absent",
          version: 1,
          verified: true,
          reason: "Synthetic confirmed absence.",
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    403,
  );
  for (let n = 0; n < 2; n++)
    await f.action(
      n,
      {
        action: "absent",
        verified: true,
        reason: "Office confirmed not at dismissal.",
      },
      auth,
    );
  let d = await f.detail();
  const attempts = await Promise.all([
    send(f.path + "/review", { ...review, version: d.run.version }),
    send(f.path + "/review", { ...review, version: d.run.version }),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  d = await f.detail();
  assert.equal(d.closures.length, 1);
  const closure = (await get(f.path + "/closures/" + d.closures[0].id)).body;
  await assert.rejects(
    () =>
      db.query("UPDATE dismissal_closures SET snapshot='{}' WHERE id=$1", [
        closure.id,
      ]),
    /append-only/i,
  );
  await ok(f.path + "/review", {
    ...review,
    version: d.run.version,
    action: "reopen",
  });
  await f.action(0, { action: "present", observed: true }, auth);
  assert.equal((await f.detail()).counts.present, 1);
  assert.deepEqual(
    (await get(f.path + "/closures/" + closure.id)).body.snapshot,
    closure.snapshot,
  );
});
test("roster drift cannot hide a present child; office resolution allows reconciliation while removed records persist", async () => {
  const f = await fixture();
  await f.action(0, { action: "present", observed: true });
  const tomorrow = DateTime.fromISO(today()).plus({ days: 1 }).toISODate()!;
  await ok("/school/students/" + f.children[0].id + "/enrollments", {
    enrollment: {
      yearId: f.year.id,
      gradeLevel: "Sample",
      startsOn: tomorrow,
      endsOn: tomorrow,
    },
    version: 1,
  });
  let d = await f.detail();
  assert.equal(d.rosterCurrent, false);
  assert.equal(
    (
      await send(f.path + "/reconcile", {
        version: d.run.version,
        reason: "Enrollment moved.",
      })
    ).status,
    409,
  );
  await f.action(
    0,
    {
      action: "absent",
      verified: true,
      reason: "Office confirms child not at this dismissal.",
    },
    auth,
  );
  d = await f.detail();
  await ok(f.path + "/reconcile", {
    version: d.run.version,
    reason: "Office reviewed removed enrollment.",
  });
  d = await f.detail();
  assert.equal(d.rosterCurrent, true);
  assert.equal(d.counts.expected, 1);
  assert.equal(
    d.entries.find((e: any) => e.student_id === f.children[0].id).expected,
    false,
  );
  assert.equal(d.entries.length, 2);
});
test("childcare and dismissal cannot simultaneously claim physical presence and cross-domain release remains blocked", async () => {
  const f = await fixture(),
    program = await ok("/care/programs", {
      unitId: f.unitId,
      name: "Synthetic child care",
      room: "Example",
      capacity: 10,
      instructions: "Synthetic handoff instructions.",
      confirmed: true,
      archived: false,
      staffIds: [f.staff.id],
      version: 0,
      reason: "Cross-workflow verification.",
    });
  for (const child of f.children)
    await ok("/care/programs/" + program.id + "/enrollments", {
      studentId: child.id,
      startsOn: today(),
      endsOn: today(),
      enabled: true,
      version: 0,
      reason: "Synthetic care enrollment.",
    });
  await f.action(0, { action: "present", observed: true });
  const ci = (n: number) => ({
    programId: program.id,
    programVersion: 1,
    studentId: f.children[n].id,
    arrivalName: "Synthetic adult",
    received: true,
    commandId: randomUUID(),
  });
  assert.equal((await send("/care/check-in", ci(0), f.staffAuth)).status, 409);
  await ok("/care/check-in", ci(1), f.staffAuth);
  assert.equal(
    (
      await send(
        f.path + "/entries/" + f.children[1].id + "/action",
        {
          action: "present",
          version: (await f.entry(1)).version,
          observed: true,
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    409,
  );
});
