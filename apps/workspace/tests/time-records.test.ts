import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff, clockCommand } from "../server/workforce";
import { getReport } from "../server/reports";
import { getAuthorizedPayrollHours } from '../server/payroll-hours';
import { initialDefinition, reportDefinition } from '../shared/report-library';
import { saveReport } from '../server/report-library';
import { prepareReportSnapshot, captureReportSnapshot, readReportSnapshot } from '../server/report-snapshots';
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  proposeCorrection as proposeService,
  reviewCorrection as reviewService,
  timeRecordDetail as detailService,
  adjustTimeRecord,
} from "../server/time-records";
import { listTimeRecords } from "../server/time-record-list";
import { getTimeAdjustmentSource, proposeTimeAdjustment } from '../server/time-adjustments';
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
    200,
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

test('administrators directly adjust completed cards with immutable original segments and stable command receipts', async () => {
  const f=await fixture(), auth=await session(owner);
  const original=(await db.query('SELECT id,started_at,ended_at,revision FROM segments WHERE shift_id=$1 ORDER BY id',[f.shiftId])).rows;
  const result=await adjustTimeRecord(db,owner,f.shiftId,f.input,auth.hash);
  assert.equal(result.status,'approved'); assert.equal(result.original.action,'administrative_adjustment');
  assert.equal(result.proposed_by,owner.id); assert.equal(result.reviewed_by,owner.id); assert.equal(result.resultRevision,2);
  assert.equal(result.original.employee.id,f.actor.id); assert.equal(result.original.employee.name,f.actor.name);
  assert.equal(result.original.editor.id,owner.id); assert.equal(result.original.editor.name,owner.name);
  assert.deepEqual((await db.query('SELECT id,started_at,ended_at,revision FROM segments WHERE shift_id=$1 AND revision=1 ORDER BY id',[f.shiftId])).rows,original);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[f.shiftId])).rows[0].revision,2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='time_correction.adjusted'",[result.id])).rows[0].n,1);
  const next={...f.input,sourceRevision:2,commandId:randomUUID(),segments:f.input.segments.map((s,i)=>i===2?{...s,endedAt:at(280)}:s)};
  await adjustTimeRecord(db,owner,f.shiftId,next,auth.hash);
  const replay=await adjustTimeRecord(db,owner,f.shiftId,f.input,auth.hash);
  assert.equal(replay.id,result.id); assert.equal(replay.resultRevision,2);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[f.shiftId])).rows[0].revision,3);
  await assert.rejects(adjustTimeRecord(db,owner,f.shiftId,{...f.input,reason:'Changed evidence under the same command.'},auth.hash),/different correction/);
  await assert.rejects(adjustTimeRecord(db,owner,f.shiftId,{...f.input,commandId:randomUUID()},auth.hash),/changed/);
  await assert.rejects(db.query("UPDATE time_corrections SET reason='tampered' WHERE id=$1",[result.id]),/immutable/);
  await assert.rejects(db.query("UPDATE time_corrections SET review_note='Attempted terminal decision change' WHERE id=$1",[result.id]),/immutable/);
  await assert.rejects(db.query('DELETE FROM time_corrections WHERE id=$1',[result.id]),/cannot be deleted/);
});

test('cancel retries recover an already-completed response only for the same currently authorized author and exact prior version',async()=>{
  const f=await fixture(), manager=(await person('manager')).actor, auth=await session(manager), ownerAuth=await session(owner);
  const proposal=await proposeCorrection(db,manager,f.input),path='/time-corrections/'+proposal.id+'/cancel';
  // Discarding a committed response represents the retry needed after a client
  // loses that response; this does not claim to inject a real network failure.
  assert.equal((await post(path,{version:1},auth)).status,200);
  const retry=await post(path,{version:1},auth); assert.equal(retry.status,200); assert.deepEqual(retry.body,{ok:true});
  assert.equal((await post(path,{version:2},auth)).status,409);
  assert.equal((await post(path,{version:1},ownerAuth)).status,404);
  await db.query("UPDATE users SET role='finance' WHERE id=$1",[manager.id]);
  assert.equal((await post(path,{version:1},auth)).status,403);
  await db.query("UPDATE users SET role='manager' WHERE id=$1",[manager.id]);
  await db.query('DELETE FROM user_units WHERE user_id=$1',[manager.id]);
  assert.equal((await post(path,{version:1},auth)).status,404);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[manager.org_id,manager.id,manager.unit_ids[0]]);
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[auth.hash]);
  assert.equal((await post(path,{version:1},auth)).status,401);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='time_correction.cancelled'",[proposal.id])).rows[0].n,1);
  assert.deepEqual((await db.query('SELECT status,version FROM time_corrections WHERE id=$1',[proposal.id])).rows[0],{status:'cancelled',version:2});
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[f.shiftId])).rows[0].revision,1);
  const approved=await fixture(), employeeAuth=await session(approved.actor), pending=await proposeCorrection(db,approved.actor,approved.input);
  await reviewCorrection(db,owner,pending.id,approval);
  assert.equal((await post('/time-corrections/'+pending.id+'/cancel',{version:1},employeeAuth)).status,409);
});

test('pending correction source and command evidence cannot be rewritten or deleted before independent review',async()=>{
  const f=await fixture(), proposal=await proposeCorrection(db,f.actor,f.input);
  await assert.rejects(db.query("UPDATE time_corrections SET original=jsonb_set(original,'{shift,revision}','99'::jsonb) WHERE id=$1",[proposal.id]),/immutable/);
  await assert.rejects(db.query("UPDATE time_corrections SET proposed='[]'::jsonb WHERE id=$1",[proposal.id]),/immutable/);
  await assert.rejects(db.query('UPDATE time_corrections SET command_id=$1 WHERE id=$2',[randomUUID(),proposal.id]),/immutable/);
  await assert.rejects(db.query('DELETE FROM time_corrections WHERE id=$1',[proposal.id]),/cannot be deleted/);
  const saved=(await db.query('SELECT original,proposed,command_id,status FROM time_corrections WHERE id=$1',[proposal.id])).rows[0];
  assert.deepEqual(saved.original,proposal.original); assert.deepEqual(saved.proposed,proposal.proposed); assert.equal(saved.command_id,proposal.command_id); assert.equal(saved.status,'pending');
  await reviewCorrection(db,owner,proposal.id,approval);
  assert.equal((await db.query('SELECT status FROM time_corrections WHERE id=$1',[proposal.id])).rows[0].status,'approved');
});

test('direct corrections enforce current administrator role, password session, other-employee access and path identity',async()=>{
  const f=await fixture(), admin=(await person('admin')).actor, auth=await session(admin);
  const own=(await detailService(db,f.actor,f.shiftId,await hashFor(f.actor))); assert.equal(own.canAdjust,false);
  assert.equal((await detailService(db,admin,f.shiftId,auth.hash)).canAdjust,true);
  for(const role of ['manager','finance','employee']) {
    const actor=(await person(role)).actor;
    await assert.rejects(adjustTimeRecord(db,actor,f.shiftId,f.input,await hashFor(actor)),(e:any)=>e.status===403);
  }
  await db.query("UPDATE users SET role='admin' WHERE id=$1",[f.actor.id]);
  await assert.rejects(adjustTimeRecord(db,{...f.actor,role:'admin'},f.shiftId,f.input,await hashFor(f.actor)),/own corrections/);
  await assert.rejects(adjustTimeRecord(db,admin,randomUUID(),f.input,auth.hash),/must match/);
  await assert.rejects(adjustTimeRecord(db,{...admin,mode:'pin'},f.shiftId,f.input,auth.hash),(e:any)=>e.status===403);
  const result=await adjustTimeRecord(db,admin,f.shiftId,f.input,auth.hash);
  await db.query("UPDATE users SET role='manager' WHERE id=$1",[admin.id]);
  await assert.rejects(adjustTimeRecord(db,admin,f.shiftId,f.input,auth.hash),(e:any)=>e.status===403);
  await db.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[auth.hash]);
  await assert.rejects(adjustTimeRecord(db,admin,f.shiftId,f.input,auth.hash),(e:any)=>e.status===401);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM time_corrections WHERE id=$1',[result.id])).rows[0].n,1);
});

test('simultaneous administrator edits require one current revision and rejected writes leave no new segments',async()=>{
  const f=await fixture(), auth=await session(owner);
  const results=await Promise.allSettled([adjustTimeRecord(db,owner,f.shiftId,f.input,auth.hash),adjustTimeRecord(db,owner,f.shiftId,{...f.input,commandId:randomUUID(),segments:f.input.segments.map((s,i)=>i===2?{...s,endedAt:at(290)}:s)},auth.hash)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM segments WHERE shift_id=$1',[f.shiftId])).rows[0].n,6);
  const unchanged=(await db.query('SELECT revision FROM shifts WHERE id=$1',[f.shiftId])).rows[0].revision;
  await assert.rejects(adjustTimeRecord(db,owner,f.shiftId,{...f.input,sourceRevision:unchanged,commandId:randomUUID(),segments:[{...f.input.segments[0],endedAt:at(120)},{...f.input.segments[1],startedAt:at(121)},f.input.segments[2]]},auth.hash),/contiguous/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM segments WHERE shift_id=$1',[f.shiftId])).rows[0].n,6);
});

test('time-card list distinguishes worked time and breaks, retains historical inactive employees and supports server filters',async()=>{
  const f=await fixture(), auth=await session(owner);
  await db.query("UPDATE users SET name='Archive Alice',active=false WHERE id=$1",[f.actor.id]);
  const input={start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id};
  const result=await listTimeRecords(db,owner,auth.hash,input);
  assert.equal(result.summary.shiftCount,1); assert.equal(result.summary.employeeCount,1);
  assert.equal(result.summary.workMicroseconds,String(210n*60000000n)); assert.equal(result.summary.breakMicroseconds,String(30n*60000000n));
  assert.equal(result.rows[0].workMicroseconds,String(210n*60000000n)); assert.equal(result.rows[0].jobs[0].title,f.job.title);
  assert.equal(result.rows[0].canAdjust,true); assert.equal(result.options.employees.find(e=>e.id===f.actor.id)?.active,false);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,search:'archive ali',jobId:f.job.id,unitId:f.job.unit_id,status:'completed'})).summary.shiftCount,1);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,search:'does not exist'})).summary.shiftCount,0);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,status:'open'})).summary.shiftCount,0);
  await adjustTimeRecord(db,owner,f.shiftId,f.input,auth.hash);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,status:'revised'})).summary.shiftCount,1);
});

test('time-card summary clips overnight microseconds to organization calendar dates without rounding segments',async()=>{
  const {actor,job}=await person(), auth=await session(owner);
  const midnight=base.startOf('day').plus({days:1}), before=midnight.minus({milliseconds:1}).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")+'123Z';
  const after=midnight.plus({milliseconds:1}).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")+'456Z';
  const shiftId=randomUUID();
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)',[shiftId,actor.org_id,actor.id,before,after]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work',$5,$6)",[randomUUID(),actor.org_id,shiftId,job.id,before,after]);
  const result=await listTimeRecords(db,owner,auth.hash,{start:midnight.toISODate()!,end:midnight.toISODate()!,userId:actor.id});
  assert.equal(result.rows[0].started_at,before); assert.equal(result.rows[0].workMicroseconds,'2333');
  assert.equal(result.summary.workMicroseconds,'1456'); assert.equal(result.summary.cardWorkMicroseconds,'2333');
  assert.equal(result.rows[0].periodWorkMicroseconds,'1456'); assert.equal(result.summary.jobs[0].workMicroseconds,'1456');
});

test('time-card all-range summaries and search are not limited to the first 100 rows',async()=>{
  const {actor,job}=await person(), auth=await session(owner), date=base.minus({days:10}).toISODate()!;
  await db.transaction(async tx=>{
    for(let i=0;i<105;i++) {
      const id=randomUUID(),from=base.minus({days:10}).startOf('day').plus({minutes:i*2}).toUTC().toISO()!,until=base.minus({days:10}).startOf('day').plus({minutes:i*2+1}).toUTC().toISO()!;
      await tx.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)',[id,actor.org_id,actor.id,from,until]);
      await tx.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work',$5,$6)",[randomUUID(),actor.org_id,id,job.id,from,until]);
    }
  });
  const input={start:date,end:date,userId:actor.id,sort:'oldest'};
  const first=await listTimeRecords(db,owner,auth.hash,input),second=await listTimeRecords(db,owner,auth.hash,{...input,offset:100});
  assert.equal(first.rows.length,100); assert.equal(first.hasMore,true); assert.equal(second.rows.length,5); assert.equal(second.hasMore,false);
  assert.equal(first.summary.shiftCount,105); assert.equal(second.summary.shiftCount,105); assert.equal(first.summary.workMicroseconds,String(105n*60000000n));
  assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,105);
});

test('job and community summaries include only the selected work while edits retain the entire mixed-job card',async()=>{
  const f=await fixture(), auth=await session(owner), other=jobs.find(job=>job.unit_id===units[1].id)!;
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[f.actor.org_id,f.actor.id,other.unit_id]);
  await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[f.actor.org_id,f.actor.id,other.id]);
  await adjustTimeRecord(db,owner,f.shiftId,{...f.input,segments:f.input.segments.map((s,i)=>i===2?{...s,jobId:other.id}:s)},auth.hash);
  const input={start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id};
  const result=await listTimeRecords(db,owner,auth.hash,{...input,jobId:other.id});
  assert.equal(result.summary.workMicroseconds,String(120n*60000000n)); assert.equal(result.summary.breakMicroseconds,'0');
  assert.equal(result.rows[0].workMicroseconds,String(240n*60000000n)); assert.equal(result.rows[0].breakMicroseconds,String(30n*60000000n));
  assert.equal(result.rows[0].jobs.length,2); assert.equal(result.summary.jobs.length,1); assert.equal(result.summary.jobs[0].jobId,other.id);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,unitId:other.unit_id})).summary.workMicroseconds,result.summary.workMicroseconds);
  assert.equal((await listTimeRecords(db,owner,auth.hash,{...input,jobId:other.id,unitId:f.job.unit_id})).rows.length,0);
  const manager=(await person('manager')).actor, scoped=await listTimeRecords(db,manager,await hashFor(manager),input);
  assert.equal(scoped.rows.length,0); assert.equal(scoped.summary.shiftCount,0);
  assert.equal(scoped.options.employees.some(e=>e.id===f.actor.id),false);
});

test('zero-duration time cards remain discoverable on their exact local date',async()=>{
  const {actor,job}=await person(), auth=await session(owner), midnight=base.startOf('day').toUTC().toISO()!, id=randomUUID();
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$4)',[id,actor.org_id,actor.id,midnight]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work',$5,$5)",[randomUUID(),actor.org_id,id,job.id,midnight]);
  const current=await listTimeRecords(db,owner,auth.hash,{start:base.toISODate()!,end:base.toISODate()!,userId:actor.id});
  assert.equal(current.summary.shiftCount,1); assert.equal(current.summary.workMicroseconds,'0');
  const prior=base.minus({days:1}).toISODate()!;
  assert.equal((await listTimeRecords(db,owner,auth.hash,{start:prior,end:prior,userId:actor.id})).summary.shiftCount,0);
});

test('direct edits update exact payroll hours while saved source reports retain their original bytes',async()=>{
  const f=await fixture(), auth=await session(owner), employeeHash=await hashFor(f.actor), query={start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id,group:'day'};
  const before=await getAuthorizedPayrollHours(db,owner,{mode:'password',hash:auth.hash},query);
  assert.equal(before.totals.workMicroseconds,String(210n*60000000n));
  const definition=reportDefinition.parse({...initialDefinition('workforce'),range:{preset:'custom',from:query.start,to:query.end}});
  const report=await saveReport(db,f.actor,employeeHash,{id:randomUUID(),version:0,name:'Synthetic original time card',description:'Before direct adjustment',definition,archived:false,reason:'Retain original employee evidence before correction.'});
  const preview=await prepareReportSnapshot(db,f.actor,employeeHash,report.id,{version:report.version});
  const saved=await captureReportSnapshot(db,f.actor,employeeHash,report.id,{version:report.version,previewId:preview.id,payloadHash:preview.payloadHash,commandId:randomUUID(),reviewed:true,reason:'Reviewed exact original employee time record.'});
  const prior=await readReportSnapshot(db,f.actor,employeeHash,report.id,saved.snapshot.id,'csv');
  await adjustTimeRecord(db,owner,f.shiftId,f.input,auth.hash);
  const after=await getAuthorizedPayrollHours(db,owner,{mode:'password',hash:auth.hash},query);
  assert.equal(after.totals.workMicroseconds,String(240n*60000000n)); assert.equal(after.totals.breakMicroseconds,String(30n*60000000n));
  assert.ok(after.report.rows.every(row=>row.revision===2));
  const retained=await readReportSnapshot(db,f.actor,employeeHash,report.id,saved.snapshot.id,'csv');
  assert.equal(retained.content,prior.content); assert.equal(retained.csvHash,prior.csvHash);
});

test('audit failures and expiry before final publication roll back all immediate card changes',async()=>{
  const f=await fixture(), auth=await session(owner);
  const intercept=(operation:(sql:string,tx:Queryable)=>Promise<void>):Database=>({...db,transaction:fn=>db.transaction(tx=>fn({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{await operation(sql,tx);return tx.query<T>(sql,params);}}))});
  const failure=intercept(async sql=>{if(sql.includes('INSERT INTO audit_events'))throw new Error('Synthetic immediate audit failure');});
  await assert.rejects(adjustTimeRecord(failure,owner,f.shiftId,f.input,auth.hash),/Synthetic immediate audit failure/);
  const expiry=intercept(async(sql,tx)=>{if(sql.includes('INSERT INTO audit_events'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[auth.hash]);});
  await assert.rejects(adjustTimeRecord(expiry,owner,f.shiftId,f.input,auth.hash),(e:any)=>e.status===401);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[f.shiftId])).rows[0].revision,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM segments WHERE shift_id=$1',[f.shiftId])).rows[0].n,3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM time_corrections WHERE shift_id=$1',[f.shiftId])).rows[0].n,0);
});

test('list publication rejects scope, job-community and session changes after its data snapshot',async()=>{
  const f=await fixture(), manager=(await person('manager')).actor, auth=await session(manager);
  const input={start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id};
  const between=(change:()=>Promise<unknown>):Database=>{let count=0;return {...db,transaction:async fn=>{const value=await db.transaction(fn);if(++count===1)await change();return value;}};};
  await assert.rejects(listTimeRecords(between(()=>db.query('DELETE FROM user_units WHERE user_id=$1',[manager.id])),manager,auth.hash,input),/access changed/);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[manager.org_id,manager.id,manager.unit_ids[0]]);
  await assert.rejects(listTimeRecords(between(()=>db.query('UPDATE jobs SET unit_id=$1 WHERE id=$2',[units[1].id,f.job.id])),manager,auth.hash,input),/jobs or communities changed/);
  await db.query('UPDATE jobs SET unit_id=$1 WHERE id=$2',[f.job.unit_id,f.job.id]);
  await assert.rejects(listTimeRecords(between(()=>db.query('DELETE FROM sessions WHERE token_hash=$1',[auth.hash])),manager,auth.hash,input),(e:any)=>e.status===401);
});

test('pending card filters and totals include attached clock-out requests without changing legacy correction counts',async()=>{
  const {actor,job}=await person(), employeeHash=await hashFor(actor), ownerHash=await hashFor(owner);
  const opened=await clockCommand(db,actor,{action:'clock_in',jobId:job.id,commandId:randomUUID()},new Date(at(0)));
  const source=await getTimeAdjustmentSource(db,actor,employeeHash,{shiftId:opened.shift.id});
  await proposeTimeAdjustment(db,actor,employeeHash,{kind:'close_open_shift',shiftId:opened.shift.id,sourceHash:source.sourceHash,endedAt:at(60),reason:'Synthetic missed clock-out for pending card filters.',commandId:randomUUID()});
  const result=await listTimeRecords(db,owner,ownerHash,{start:base.toISODate()!,end:base.toISODate()!,userId:actor.id,status:'pending',sort:'pending'});
  assert.equal(result.summary.shiftCount,1); assert.equal(result.summary.pendingCount,1);
  assert.equal(result.rows[0].pending_corrections,0); assert.equal(result.rows[0].pending_adjustments,1); assert.equal(result.rows[0].pending_count,1);
  await clockCommand(db,actor,{action:'clock_out',commandId:randomUUID()},new Date(at(90)));
});

test('pending historical and proposed job authority is rechecked even when absent from current card segments',async()=>{
  const f=await fixture(), manager=(await person('manager')).actor, auth=await session(manager), second=randomUUID();
  await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic proposed historical job')",[second,owner.org_id,f.job.unit_id]);
  await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[owner.org_id,f.actor.id,second]);
  await proposeCorrection(db,f.actor,{...f.input,segments:f.input.segments.map(s=>({...s,jobId:second}))});
  let count=0;const switched:Database={...db,transaction:async fn=>{const value=await db.transaction(fn);if(++count===1)await db.query('UPDATE jobs SET unit_id=$1 WHERE id=$2',[units[1].id,second]);return value;}};
  await assert.rejects(listTimeRecords(switched,manager,auth.hash,{start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id}),/jobs or communities changed/);
  const result=await listTimeRecords(db,manager,auth.hash,{start:base.toISODate()!,end:base.toISODate()!,userId:f.actor.id});
  assert.equal(result.rows.length,1); assert.equal(result.rows[0].pending_corrections,0); assert.equal(result.summary.pendingCount,0);
  assert.equal(result.options.jobs.some(job=>job.id===second),false);
});
