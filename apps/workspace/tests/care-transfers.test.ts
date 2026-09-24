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
import { decideCareTransfer } from "../server/care-transfers";
import type { Queryable } from "../server/db";
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
    ownerEmail: "transfers.owner@example.test",
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

async function careFixture(capacity = 5) {
  const f = await fixture();
  const receivers: { actor: Actor; auth: any }[] = [];
  for (let n = 0; n < 2; n++) {
    const id = await db.transaction((tx) =>
      createStaff(
        tx,
        owner,
        {
          name: "Synthetic receiving staff " + n,
          email: randomUUID() + "@stjw.org",
          role: "employee",
          unitIds: [f.unitId],
          jobIds: [],
        },
        "stjw.org",
      ),
    );
    const actor = { ...owner, id, role: "employee", unit_ids: [f.unitId] };
    receivers.push({ actor, auth: await session(actor) });
  }
  const programInput = {
    unitId: f.unitId,
    name: "Synthetic receiving care",
    room: "Example room",
    capacity,
    instructions: "Synthetic two-person handoff instructions.",
    confirmed: true,
    archived: false,
    staffIds: [f.staff.id, ...receivers.map((r) => r.actor.id)],
    version: 0,
    reason: "Synthetic program setup",
  };
  const program = await ok("/care/programs", programInput);
  for (const child of f.children)
    await ok("/care/programs/" + program.id + "/enrollments", {
      studentId: child.id,
      startsOn: today(),
      endsOn: today(),
      enabled: true,
      version: 0,
      reason: "Synthetic care enrollment",
    });
  await ok(f.path + "/plans", {
    entries: [
      { studentId: f.children[0].id, version: (await f.entry()).version },
    ],
    mode: "care",
    busId: null,
    careProgramId: program.id,
    reason: "Office reviewed care destination",
  });
  await f.action(0, { action: "present", observed: true });
  const path = f.path + "/entries/" + f.children[0].id + "/care-transfer";
  const requestInput = async () => ({
    version: (await f.entry()).version,
    programVersion: (await get("/care/programs/" + program.id)).body.program
      .version,
    observed: true,
    reason: "Child ready for receiving care staff.",
    commandId: randomUUID(),
  });
  const requestTransfer = async () =>
    ok(path, await requestInput(), f.staffAuth);
  const acceptInput = (version = 1) => ({
    action: "accept",
    version: 1,
    programVersion: version,
    received: true,
    note: "Synthetic physical receipt.",
    commandId: randomUUID(),
  });
  const decide = (id: string, input: any, a = receivers[0].auth) =>
    send("/care/transfers/" + id + "/decision", input, a);
  const pending = async () =>
    (
      await get(
        "/care/programs/" + program.id + "/transfers",
        receivers[0].auth,
      )
    ).body;
  return {
    ...f,
    receivers,
    program,
    programInput,
    path,
    requestInput,
    requestTransfer,
    acceptInput,
    decide,
    pending,
  };
}
test("handoff requests keep children in dismissal, expose only the receiving program queue and block conflicting actions", async () => {
  const f = await careFixture(),
    input = await f.requestInput(),
    results = await Promise.all([
      send(f.path, input, f.staffAuth),
      send(f.path, input, f.staffAuth),
    ]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal((await f.entry()).status, "present");
  assert.equal(
    (await get("/care/programs/" + f.program.id)).body.present.length,
    0,
  );
  const queue = await f.pending();
  assert.equal(queue.rows.length, 1);
  assert.equal(queue.rows[0].student_id, f.children[0].id);
  assert.equal(queue.canReceive, true);
  assert.equal(
    (await get("/dismissal/runs/" + f.run.id, f.receivers[0].auth)).status,
    403,
  );
  assert.equal(
    (
      await send(
        "/dismissal/runs/" +
          f.run.id +
          "/entries/" +
          f.children[0].id +
          "/action",
        {
          action: "absent",
          version: (await f.entry()).version,
          verified: true,
          reason: "Must not lose pending handoff",
          commandId: randomUUID(),
        },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send("/dismissal/runs/" + f.run.id + "/plans", {
        entries: [
          { studentId: f.children[0].id, version: (await f.entry()).version },
        ],
        mode: "pickup",
        busId: null,
        reason: "Blocked pending plan change",
      })
    ).status,
    409,
  );
});
test("receipt requires a different assigned care account; owner, PIN and caller-supplied bypasses cannot substitute", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer(),
    input = f.acceptInput();
  assert.equal((await f.decide(t.id, input, f.staffAuth)).status, 403);
  assert.equal((await f.decide(t.id, input, auth)).status, 403);
  assert.equal(
    (await f.decide(t.id, input, await session(f.receivers[0].actor, "pin")))
      .status,
    403,
  );
  assert.equal(
    (await f.decide(t.id, { ...input, received: false })).status,
    400,
  );
  assert.equal(
    (await f.decide(t.id, { ...input, receiverId: owner.id })).status,
    400,
  );
  assert.equal(
    (
      await send(
        "/care/check-in",
        {
          programId: f.program.id,
          programVersion: 1,
          studentId: f.children[0].id,
          arrivalName: "Bypass attempt",
          received: true,
          commandId: randomUUID(),
          origin: { runId: f.run.id },
        },
        f.receivers[0].auth,
      )
    ).status,
    400,
  );
  assert.equal((await f.entry()).status, "present");
});
test("concurrent acceptance retries atomically link one care session and preserve immutable sender/receiver evidence", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer(),
    input = f.acceptInput(),
    results = await Promise.all([f.decide(t.id, input), f.decide(t.id, input)]);
  assert.ok(
    results.every((r) => r.status === 200),
    JSON.stringify(results.map((r) => r.body)),
  );
  assert.equal(results[0].body.careSessionId, results[1].body.careSessionId);
  const entry = await f.entry(),
    care = (await get("/care/programs/" + f.program.id)).body,
    transfer = (
      await db.query("SELECT * FROM care_transfers WHERE id=$1", [t.id])
    ).rows[0];
  assert.equal(entry.status, "released");
  assert.equal(entry.mode, "care");
  assert.equal(care.present.length, 1);
  assert.equal(entry.care_session_id, care.present[0].id);
  assert.equal(entry.release_snapshot.receiverId, f.receivers[0].actor.id);
  assert.equal(entry.release_snapshot.requesterId, f.staff.id);
  assert.equal(
    new Date(entry.released_at).getTime(),
    new Date(care.present[0].checked_in_at).getTime(),
  );
  assert.equal(transfer.status, "accepted");
  assert.equal((await f.detail()).counts.inCare, 1);
  const session = (
    await db.query("SELECT program_snapshot FROM care_sessions WHERE id=$1", [
      entry.care_session_id,
    ])
  ).rows[0];
  assert.equal(session.program_snapshot.dismissalTransfer.transferId, t.id);
  await assert.rejects(
    db.query("UPDATE care_transfers SET status='canceled' WHERE id=$1", [t.id]),
    /cannot be changed/i,
  );
  await assert.rejects(
    db.query(
      "UPDATE dismissal_entries SET care_session_id=NULL WHERE run_id=$1 AND student_id=$2",
      [f.run.id, f.children[0].id],
    ),
    /cannot be changed/i,
  );
  const exported = await get("/dismissal/runs/" + f.run.id + "/export");
  assert.match(exported.text, /care_session_id/);
  assert.ok(exported.text.includes(entry.care_session_id));
});
test("two receiving accounts cannot both accept and cancellation cannot overwrite a completed receipt", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer(),
    results = await Promise.all(
      f.receivers.map((r) => f.decide(t.id, f.acceptInput(), r.auth)),
    );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await get("/care/programs/" + f.program.id)).body.present.length,
    1,
  );
  assert.equal(
    (
      await f.decide(
        t.id,
        {
          action: "cancel",
          version: 1,
          reason: "Too late to cancel receipt",
          commandId: randomUUID(),
        },
        f.staffAuth,
      )
    ).status,
    409,
  );
});
test("capacity and changed program instructions reject acceptance without dropping source accountability", async () => {
  const f = await careFixture(1),
    t = await f.requestTransfer();
  await ok(
    "/care/check-in",
    {
      programId: f.program.id,
      programVersion: 1,
      studentId: f.children[1].id,
      arrivalName: "Synthetic other arrival",
      received: true,
      commandId: randomUUID(),
    },
    f.receivers[0].auth,
  );
  const full = await f.decide(t.id, f.acceptInput());
  assert.equal(full.status, 409);
  assert.match(full.body.error, /capacity/);
  assert.equal((await f.entry()).status, "present");
  assert.equal((await f.pending()).rows.length, 1);
  assert.equal(
    (await get("/care/programs/" + f.program.id)).body.present.length,
    1,
  );
  await ok(
    "/care/programs/" + f.program.id,
    {
      ...f.programInput,
      version: 1,
      capacity: 2,
      reason: "Synthetic reviewed capacity change",
    },
    auth,
    "patch",
  );
  const changed = await f.decide(t.id, f.acceptInput(2));
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /instructions changed/);
  assert.equal((await f.entry()).status, "present");
});
test("holds, care enrollment changes and school roster drift are revalidated at physical receipt", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer();
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: true, version: 0, reason: "Synthetic office review needed" },
    auth,
    "put",
  );
  assert.equal((await f.decide(t.id, f.acceptInput())).status, 409);
  await ok(
    "/care/students/" + f.children[0].id + "/hold",
    { active: false, version: 1, reason: "Synthetic office resolved hold" },
    auth,
    "put",
  );
  await ok("/care/programs/" + f.program.id + "/enrollments", {
    studentId: f.children[0].id,
    startsOn: today(),
    endsOn: today(),
    enabled: false,
    version: 1,
    reason: "Synthetic care enrollment disabled",
  });
  const enrollment = await f.decide(t.id, f.acceptInput());
  assert.equal(enrollment.status, 409);
  assert.match(enrollment.body.error, /care enrollment/i);
  await ok("/care/programs/" + f.program.id + "/enrollments", {
    studentId: f.children[0].id,
    startsOn: today(),
    endsOn: today(),
    enabled: true,
    version: 2,
    reason: "Synthetic care enrollment restored",
  });
  const added = await ok("/school/students", {
    unitId: f.unitId,
    name: "Synthetic later enrollment",
    studentNumber: randomUUID(),
  });
  await ok("/school/students/" + added.id + "/enrollments", {
    enrollment: {
      yearId: f.year.id,
      gradeLevel: "Sample",
      startsOn: today(),
      endsOn: today(),
    },
  });
  const drift = await f.decide(t.id, f.acceptInput());
  assert.equal(drift.status, 409);
  assert.match(drift.body.error, /enrollment changed/i);
  assert.equal(
    (await get("/care/programs/" + f.program.id)).body.present.length,
    0,
  );
  const canceled = await f.decide(
    t.id,
    {
      action: "cancel",
      version: 1,
      reason: "Reconcile roster before transfer",
      commandId: randomUUID(),
    },
    f.staffAuth,
  );
  assert.equal(canceled.status, 200);
  assert.equal((await f.entry()).status, "present");
});
test("revoked receiving assignment blocks receipt and resolved requests remain traceable when a new plan is chosen", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer();
  await ok(
    "/care/programs/" + f.program.id,
    {
      ...f.programInput,
      version: 1,
      staffIds: [f.staff.id, f.receivers[1].actor.id],
      reason: "Synthetic receiving assignment removed",
    },
    auth,
    "patch",
  );
  assert.equal((await f.decide(t.id, f.acceptInput())).status, 404);
  const canceled = await f.decide(
    t.id,
    {
      action: "cancel",
      version: 1,
      reason: "Choose a different reviewed handoff",
      commandId: randomUUID(),
    },
    f.staffAuth,
  );
  assert.equal(canceled.status, 200);
  await ok("/dismissal/runs/" + f.run.id + "/plans", {
    entries: [
      { studentId: f.children[0].id, version: (await f.entry()).version },
    ],
    mode: "pickup",
    busId: null,
    reason: "Office changed destination after cancellation",
  });
  assert.equal((await f.entry()).care_program_id, null);
  assert.equal((await f.detail()).transfers[0].status, "canceled");
  assert.equal((await f.detail()).counts.present, 1);
});
test("crossing local midnight rolls back the newly inserted care session and all transfer evidence", async () => {
  const f = await careFixture(),
    t = await f.requestTransfer(),
    next = DateTime.fromISO(today(), { zone: "America/New_York" }).plus({
      days: 1,
    });
  await ok("/care/programs/" + f.program.id + "/enrollments", {
    studentId: f.children[0].id,
    startsOn: today(),
    endsOn: next.toISODate(),
    enabled: true,
    version: 1,
    reason: "Synthetic overnight boundary enrollment",
  });
  let clockReads = 0;
  const boundary: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql: string, params?: any[]) => {
            const result = await tx.query(sql, params);
            if (
              sql ===
                "SELECT clock_timestamp() AS instant,timezone FROM organizations WHERE id=$1" &&
              ++clockReads === 2
            )
              result.rows[0].instant = next.startOf("day").toJSDate();
            return result;
          },
        } as Queryable),
      ),
  };
  await assert.rejects(
    decideCareTransfer(boundary, f.receivers[0].actor, t.id, f.acceptInput()),
    /day changed/,
  );
  assert.equal((await f.entry()).status, "present");
  assert.equal((await f.pending()).rows.length, 1);
  assert.equal(
    (await get("/care/programs/" + f.program.id)).body.present.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM school_history WHERE entity_type='care.checked_in' AND unit_id=$1",
        [f.unitId],
      )
    ).rows.length,
    0,
  );
});
