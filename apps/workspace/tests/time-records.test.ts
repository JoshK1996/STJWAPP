import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff, clockCommand } from "../server/workforce";
import { getReport } from "../server/reports";
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  proposeCorrection as proposeService,
  reviewCorrection as reviewService,
  timeRecordDetail as detailService,
} from "../server/time-records";
import { correctionInput } from "../shared/time-records";
let db: Database,
  owner: Actor,
  units: any[],
  jobs: any[],
  app: ReturnType<typeof createApp>;
const origin = "http://localhost:3000",
  base = DateTime.now()
    .setZone("America/New_York")
    .startOf("day")
    .minus({ days: 2 })
    .plus({ hours: 8 }),
  at = (minutes: number) => base.plus({ minutes }).toUTC().toISO()!;
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "time.owner@example.test" });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  jobs = (await db.query("SELECT * FROM jobs ORDER BY title")).rows;
  owner = {
    id: user.id,
    org_id: user.org_id,
    email: user.email,
    name: user.name,
    role: "owner",
    mode: "password",
    unit_ids: units.map((row) => row.id),
  };
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
async function person(role = "employee", unit = units[0]) {
  const job = jobs.find((row) => row.unit_id === unit.id),
    email = randomUUID() + "@stjw.org";
  const id = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic time-record test",
        email,
        role: role as any,
        unitIds: [unit.id],
        jobIds: [job.id],
      },
      "stjw.org",
    ),
  );
  return {
    actor: {
      id,
      org_id: owner.org_id,
      name: "Synthetic time-record test",
      email,
      role,
      mode: "password",
      unit_ids: [unit.id],
    } as Actor,
    job,
  };
}
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
  return { cookie: "stjw_session=" + token, csrf, hash:digest(token) };
}
const sessions = new Map<string,string>();
async function hashFor(actor: Actor) { if (!sessions.has(actor.id)) sessions.set(actor.id,(await session(actor)).hash); return sessions.get(actor.id)!; }
const proposeCorrection = async (db: Database, actor: Actor, input: Parameters<typeof proposeService>[2]) => proposeService(db,actor,input,await hashFor(actor));
const reviewCorrection = async (db: Database, actor: Actor, id: string, input: Parameters<typeof reviewService>[3]) => reviewService(db,actor,id,input,await hashFor(actor));
const timeRecordDetail = async (db: Database, actor: Actor, id: string) => detailService(db,actor,id,await hashFor(actor));
const post = (path: string, body: any, auth: any) =>
  request(app)
    .post("/api" + path)
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send(body);
async function fixture() {
  const { actor, job } = await person();
  const opened = await clockCommand(
    db,
    actor,
    { action: "clock_in", jobId: job.id, commandId: randomUUID() },
    new Date(at(0)),
  );
  await clockCommand(
    db,
    actor,
    { action: "start_break", commandId: randomUUID() },
    new Date(at(120)),
  );
  await clockCommand(
    db,
    actor,
    { action: "end_break", commandId: randomUUID() },
    new Date(at(150)),
  );
  await clockCommand(
    db,
    actor,
    { action: "clock_out", commandId: randomUUID() },
    new Date(at(240)),
  );
  const input = correctionInput.parse({
    shiftId: opened.shift.id,
    sourceRevision: 1,
    commandId: randomUUID(),
    reason: "Synthetic missed thirty minutes on the final punch.",
    segments: [
      { jobId: job.id, kind: "work", startedAt: at(0), endedAt: at(120) },
      { jobId: job.id, kind: "break", startedAt: at(120), endedAt: at(150) },
      { jobId: job.id, kind: "work", startedAt: at(150), endedAt: at(270) },
    ],
  });
  return { actor, job, shiftId: opened.shift.id, input };
}
const approval = {
  version: 1,
  status: "approved" as const,
  note: "Reviewed against the synthetic employee record.",
};
test("time corrections reject stale reviewer roles, units and inactive proposers", async () => {
  const f = await fixture(), manager = (await person('manager')).actor;
  const proposal = await proposeCorrection(db, f.actor, f.input);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [manager.id]);
  await assert.rejects(reviewCorrection(db, manager, proposal.id, approval), (e: any) => e.status === 403);
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [manager.id]);
  await db.query("DELETE FROM user_units WHERE user_id=$1", [manager.id]);
  await assert.rejects(reviewCorrection(db, manager, proposal.id, approval), (e: any) => [403,404].includes(e.status));
  await db.query("UPDATE users SET active=false WHERE id=$1", [f.actor.id]);
  await assert.rejects(proposeCorrection(db, f.actor, { ...f.input, commandId: randomUUID() }), (e: any) => e.status === 403);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1', [f.shiftId])).rows[0].revision, 1);
  assert.equal((await db.query('SELECT status FROM time_corrections WHERE id=$1', [proposal.id])).rows[0].status, 'pending');
});
test("time correction retries never restore revoked reviewer access", async () => {
  const f = await fixture(), manager = (await person('manager')).actor;
  const proposal = await proposeCorrection(db, f.actor, f.input);
  await reviewCorrection(db, manager, proposal.id, approval);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [manager.id]);
  await assert.rejects(reviewCorrection(db, manager, proposal.id, approval), (e: any) => e.status === 403);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1', [f.shiftId])).rows[0].revision, 2);
});
test("time record details cannot use stale financial reporting access", async () => {
  const f = await fixture(), finance = (await person('finance')).actor;
  assert.equal((await timeRecordDetail(db, finance, f.shiftId)).shift.id, f.shiftId);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [finance.id]);
  await assert.rejects(timeRecordDetail(db, finance, f.shiftId), (e: any) => e.status === 404);
});
test("approved correction preserves original segments and reports only the active revision", async () => {
  const f = await fixture(),
    original = (
      await db.query(
        "SELECT * FROM segments WHERE shift_id=$1 ORDER BY started_at",
        [f.shiftId],
      )
    ).rows,
    proposal = await proposeCorrection(db, f.actor, f.input);
  assert.equal(
    (await timeRecordDetail(db, f.actor, f.shiftId)).shift.revision,
    1,
  );
  await reviewCorrection(db, owner, proposal.id, approval);
  const detail = await timeRecordDetail(db, f.actor, f.shiftId);
  assert.equal(detail.shift.revision, 2);
  assert.equal(detail.segments.length, 3);
  assert.equal(detail.corrections[0].status, "approved");
  assert.equal(
    detail.corrections[0].original.segments[2].endedAt,
    new Date(at(240)).toISOString().replace("Z","000Z"),
  );
  const preserved = (
    await db.query(
      "SELECT * FROM segments WHERE shift_id=$1 AND revision=1 ORDER BY started_at",
      [f.shiftId],
    )
  ).rows;
  assert.deepEqual(preserved, original);
  assert.equal(
    (await db.query("SELECT * FROM segments WHERE shift_id=$1", [f.shiftId]))
      .rows.length,
    6,
  );
  const report = await getReport(db, f.actor, {
    start: base.toISODate()!,
    end: base.toISODate()!,
    group: "day",
  });
  assert.equal(report.workMs, 240 * 60000);
  assert.equal(report.breakMs, 30 * 60000);
  assert.equal(report.rows.length, 3);
  await assert.rejects(
    () =>
      db.query("UPDATE time_corrections SET reason='changed' WHERE id=$1", [
        proposal.id,
      ]),
    /immutable/,
  );
  await assert.rejects(
    () => db.query("DELETE FROM time_corrections WHERE id=$1", [proposal.id]),
    /cannot be deleted/,
  );
});
test("proposal and review retries are idempotent while conflicting payloads and stale proposals fail", async () => {
  const f = await fixture(),
    proposals = await Promise.all([
      proposeCorrection(db, f.actor, f.input),
      proposeCorrection(db, f.actor, f.input),
    ]);
  assert.equal(proposals[0].id, proposals[1].id);
  await assert.rejects(
    () =>
      proposeCorrection(db, f.actor, {
        ...f.input,
        reason: "A different synthetic reason.",
      }),
    /identifier/,
  );
  const competing = await proposeCorrection(db, f.actor, {
    ...f.input,
    commandId: randomUUID(),
    reason: "Alternative pending correction proposal.",
  });
  const results = await Promise.all([
    reviewCorrection(db, owner, proposals[0].id, approval),
    reviewCorrection(db, owner, proposals[0].id, approval),
  ]);
  assert.equal(results[0].version, 2);
  assert.equal(results[1].version, 2);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM audit_events WHERE target_id=$1 AND action='time_correction.approved'",
        [proposals[0].id],
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (await db.query("SELECT revision FROM shifts WHERE id=$1", [f.shiftId]))
      .rows[0].revision,
    2,
  );
  await assert.rejects(
    () => reviewCorrection(db, owner, competing.id, approval),
    /Another correction/,
  );
  await reviewCorrection(db, owner, competing.id, {
    ...approval,
    status: "declined",
    note: "Another proposal already updated this shift.",
  });
  await assert.rejects(
    () =>
      proposeCorrection(db, f.actor, { ...f.input, commandId: randomUUID() }),
    /record changed/,
  );
});
test("self-approval, workforce finance writes, PIN access and unrelated employee reads are denied", async () => {
  const f = await fixture(),
    manager = await person("manager"),
    finance = await person("finance"),
    outsider = await person(),
    proposed = await proposeCorrection(db, manager.actor, f.input);
  await assert.rejects(
    () => reviewCorrection(db, manager.actor, proposed.id, approval),
    /different manager/,
  );
  await assert.rejects(
    () => reviewCorrection(db, f.actor, proposed.id, approval),
    /Manager review/,
  );
  await assert.rejects(
    () =>
      proposeCorrection(db, finance.actor, {
        ...f.input,
        commandId: randomUUID(),
      }),
    /Only the employee/,
  );
  await assert.rejects(
    () => timeRecordDetail(db, outsider.actor, f.shiftId),
    /not found/,
  );
  await assert.rejects(
    () => reviewCorrection(db, finance.actor, proposed.id, approval),
    /Manager review/,
  );
  const pin = await session(f.actor, "pin");
  assert.equal(
    (
      await request(app)
        .get("/api/time-records/" + f.shiftId)
        .set("Cookie", pin.cookie)
    ).status,
    403,
  );
  const auth = await session(f.actor);
  assert.equal(
    (
      await request(app)
        .get(
          "/api/time-records?" +
            new URLSearchParams({
              start: base.toISODate()!,
              end: base.toISODate()!,
            }),
        )
        .set("Cookie", auth.cookie)
    ).body.rows.length,
    1,
  );
  await reviewCorrection(db, owner, proposed.id, approval);
});
test("manager scope must cover original and proposed jobs, including a mixed-unit shift", async () => {
  const f = await fixture(),
    manager = await person("manager"),
    other = jobs.find((row) => row.unit_id === units[1].id)!;
  await db.query(
    "INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",
    [f.actor.org_id, f.actor.id, other.unit_id],
  );
  await db.query(
    "INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)",
    [f.actor.org_id, f.actor.id, other.id],
  );
  const mixed = {
      ...f.input,
      segments: f.input.segments.map((segment, index) =>
        index === 2 ? { ...segment, jobId: other.id } : segment,
      ),
    },
    proposal = await proposeCorrection(db, f.actor, mixed);
  await assert.rejects(
    () => reviewCorrection(db, manager.actor, proposal.id, approval),
    /not found|every original/,
  );
  await assert.rejects(
    () =>
      proposeCorrection(db, manager.actor, {
        ...mixed,
        commandId: randomUUID(),
      }),
    /every original/,
  );
  await reviewCorrection(db, owner, proposal.id, approval);
  await assert.rejects(
    () => timeRecordDetail(db, manager.actor, f.shiftId),
    /not found/,
  );
  const auth = await session(manager.actor),
    response = await request(app)
      .get(
        "/api/time-records?" +
          new URLSearchParams({
            start: base.toISODate()!,
            end: base.toISODate()!,
            userId: f.actor.id,
          }),
      )
      .set("Cookie", auth.cookie);
  assert.equal(response.body.rows.length, 0);
});
test("invalid gaps, future times, unassigned jobs, overlapping shifts and unchanged proposals cannot alter reports", async () => {
  const f = await fixture();
  const bad = (segments: any) =>
    proposeCorrection(db, f.actor, {
      ...f.input,
      commandId: randomUUID(),
      segments,
    });
  await assert.rejects(
    () =>
      bad(
        f.input.segments.map((segment, index) =>
          index === 1 ? { ...segment, startedAt: at(121) } : segment,
        ),
      ),
    /contiguous/,
  );
  await assert.rejects(
    () =>
      bad(
        f.input.segments.map((segment, index) =>
          index === 2
            ? {
                ...segment,
                endedAt: new Date(Date.now() + 60000).toISOString(),
              }
            : segment,
        ),
      ),
    /future/,
  );
  await assert.rejects(
    () =>
      bad(
        f.input.segments.map((segment) => ({
          ...segment,
          jobId: randomUUID(),
        })),
      ),
    /assigned|unavailable/,
  );
  const original = f.input.segments.map((segment, index) =>
    index === 2
      ? { ...segment, endedAt: new Date(at(240)).toISOString() }
      : segment,
  );
  await assert.rejects(() => bad(original), /Change at least/);
  await clockCommand(
    db,
    f.actor,
    { action: "clock_in", jobId: f.job.id, commandId: randomUUID() },
    new Date(at(250)),
  );
  await assert.rejects(
    () => proposeCorrection(db, f.actor, f.input),
    /overlaps/,
  );
  await clockCommand(
    db,
    f.actor,
    { action: "clock_out", commandId: randomUUID() },
    new Date(at(300)),
  );
  assert.equal(
    (await timeRecordDetail(db, f.actor, f.shiftId)).shift.revision,
    1,
  );
});
test("cancelled proposals remain immutable and only their author can cancel", async () => {
  const f = await fixture(),
    auth = await session(f.actor),
    ownerAuth = await session(owner),
    proposal = await proposeCorrection(db, f.actor, f.input);
  assert.equal(
    (
      await post(
        "/time-corrections/" + proposal.id + "/cancel",
        { version: 1 },
        ownerAuth,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        "/time-corrections/" + proposal.id + "/cancel",
        { version: 1 },
        auth,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await post(
        "/time-corrections/" + proposal.id + "/cancel",
        { version: 1 },
        auth,
      )
    ).status,
    409,
  );
  await assert.rejects(
    () => reviewCorrection(db, owner, proposal.id, approval),
    /already reviewed/,
  );
  assert.equal(
    (await timeRecordDetail(db, f.actor, f.shiftId)).shift.revision,
    1,
  );
});
