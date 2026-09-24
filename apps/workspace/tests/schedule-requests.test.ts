import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createSchedule, updateSchedule, scheduleHistory, prepareStaffScheduleChange } from "../server/staff-scheduling";
import { createScheduleRequest, reviewScheduleRequest, withdrawScheduleRequest, getScheduleRequest, scheduleRequestHistory, listScheduleRequests } from "../server/schedule-requests";
import { scheduleRequestQuery, type ScheduleRequestCreated, type ScheduleRequestCreate } from "../shared/schedule-requests";
import { assertRuntimeAccess, runtimeGrantsSql } from "../server/runtime-access";

let db: Database, owner: Actor, units: string[], app: ReturnType<typeof createApp>;
const origin = "http://localhost:3000";
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: user.role, unit_ids: [], mode: "password" };
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(x => x.id);
  app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
});
after(async () => { await db?.close(); });
async function person(role = "employee", unitIds = [units[0]]) {
  const id = randomUUID(), name = "Synthetic request employee";
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)", [id, owner.org_id, name, id + "@stjw.org", role]);
  for (const unitId of unitIds) await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [owner.org_id, id, unitId]);
  return { ...owner, id, name, role, unit_ids: unitIds };
}
async function job(employee: Actor, unitId = units[0]) {
  const id = randomUUID();
  await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic request job')", [id, owner.org_id, unitId]);
  await db.query("INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)", [owner.org_id, employee.id, id]);
  return id;
}
async function fixture(role = "employee") {
  const employee = await person(role, units), jobId = await job(employee);
  const input = { userId: employee.id, jobId, startsAt: "2026-11-01T05:30:00.000Z", endsAt: "2026-11-01T07:30:00.000Z", note: "Administrative note stays", reason: "Synthetic assignment", commandId: randomUUID() };
  const schedule = await createSchedule(db, owner, input);
  const proposal: ScheduleRequestCreate = { scheduleId: schedule.id, expectedScheduleVersion: 1, action: "update", proposal: { jobId, startsAt: "2026-11-01T06:30:00.000Z", endsAt: "2026-11-01T08:30:00.000Z" }, reason: "Private employee explanation", commandId: randomUUID() };
  return { employee, jobId, input, schedule, proposal };
}
const review = (created: ScheduleRequestCreated, decision: "approved" | "declined" = "approved") => ({ expectedRequestVersion: 1, proposalHash: created.proposalHash, decision, note: "Private reviewer explanation", reviewed: true as const, commandId: randomUUID() });
const withdraw = (created: ScheduleRequestCreated) => ({ expectedRequestVersion: 1, proposalHash: created.proposalHash, reason: "Withdraw old proposal", commandId: randomUUID() });
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(), csrf = opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [digest(token), actor.org_id, actor.id, mode, csrf]);
  return { cookie: "stjw_session=" + token, csrf };
}
function wrap(intercept: (tx: Queryable, sql: string, params?: any[]) => Promise<void>): Database {
  return { ...db, transaction: fn => db.transaction(tx => fn({ query: async (sql, params) => { await intercept(tx, sql, params); return tx.query(sql, params); } })) };
}

test("exact reviewed proposal applies once with linked evidence, immutable names, unchanged administrative note, and no private finance disclosure", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
  assert.deepEqual(await createScheduleRequest(db, f.employee, f.proposal), created);
  const original = await getScheduleRequest(db, owner, created.id);
  assert.equal(original.allowedActions.approve, true);
  await db.query("UPDATE users SET name='Later employee name' WHERE id=$1", [f.employee.id]);
  await db.query("UPDATE jobs SET title='Later job title' WHERE id=$1", [f.jobId]);
  const command = review(created), result = await reviewScheduleRequest(db, owner, created.id, command);
  assert.deepEqual(result.appliedSchedule, { id: f.schedule.id, version: 2, status: "scheduled" });
  const detail = await getScheduleRequest(db, f.employee, created.id), history = await scheduleRequestHistory(db, f.employee, created.id);
  assert.equal(detail.source.employeeName, "Synthetic request employee"); assert.equal(detail.source.jobTitle, "Synthetic request job");
  assert.equal(detail.current.employeeName, "Later employee name"); assert.equal(detail.current.note, f.input.note);
  assert.equal(detail.current.startsAt, f.proposal.action === "update" ? f.proposal.proposal.startsAt : "");
  assert.deepEqual(history.rows.map(x => x.action), ["submitted", "approved"]);
  assert.equal(history.rows[0].actor.nameSnapshot, "Synthetic request employee");
  assert.equal(history.rows[1].reason, command.note);
  const finance = await person("finance"), publicHistory = await scheduleHistory(db, finance, f.schedule.id);
  assert.match(publicHistory.rows[0].reason, /^Approved linked schedule request /);
  assert.equal(JSON.stringify(publicHistory).includes("Private"), false);
  await assert.rejects(getScheduleRequest(db, finance, created.id), /outside your access/);
  await assert.rejects(scheduleRequestHistory(db, finance, created.id), /outside your access/);
  await updateSchedule(db, owner, f.schedule.id, { jobId: f.jobId, startsAt: detail.current.startsAt, endsAt: detail.current.endsAt, note: "Later note", expectedVersion: 2, reason: "Later schedule edit", commandId: randomUUID() });
  assert.deepEqual(await reviewScheduleRequest(db, owner, created.id, command), result);
  assert.deepEqual(await createScheduleRequest(db, f.employee, f.proposal), created);
  assert.equal((await scheduleHistory(db, owner, f.schedule.id)).current.version, 3);
  const audits = (await db.query("SELECT detail FROM audit_events WHERE target_id=ANY($1::text[])", [[created.id, f.schedule.id]])).rows;
  assert.equal(JSON.stringify(audits).includes("Private"), false);
});

test("own requests, password sessions, exact unit scope, current roles, self-review and hash are enforced", async () => {
  const f = await fixture("manager"), other = await person(), finance = await person("finance");
  await assert.rejects(createScheduleRequest(db, other, f.proposal), /own scheduled shift/);
  await assert.rejects(createScheduleRequest(db, { ...f.employee, mode: "pin" }, f.proposal), /password/);
  await assert.rejects(createScheduleRequest(db, { ...f.employee, org_id: randomUUID() }, f.proposal), /not found/);
  const targetJob = await job(f.employee, units[1]);
  assert.equal(f.proposal.action, "update");
  const created = await createScheduleRequest(db, f.employee, { ...f.proposal, action: "update", proposal: { jobId: targetJob, startsAt: f.input.startsAt, endsAt: f.input.endsAt } });
  await assert.rejects(reviewScheduleRequest(db, f.employee, created.id, review(created)), /own schedule request/);
  await assert.rejects(reviewScheduleRequest(db, finance, created.id, review(created)), /management access/);
  const sourceManager = await person("manager", [units[0]]), targetManager = await person("manager", [units[1]]), full = await person("manager", [units[0], units[1]]);
  await assert.rejects(getScheduleRequest(db, sourceManager, created.id), /outside your access/);
  await assert.rejects(getScheduleRequest(db, targetManager, created.id), /outside your access/);
  await assert.rejects(reviewScheduleRequest(db, sourceManager, created.id, review(created)), /scope/);
  await assert.rejects(reviewScheduleRequest(db, targetManager, created.id, review(created)), /scope/);
  assert.equal((await listScheduleRequests(db, sourceManager, scheduleRequestQuery.parse({ view: "team" }))).rows.some(r => r.id === created.id), false);
  await assert.rejects(reviewScheduleRequest(db, full, created.id, { ...review(created), proposalHash: "a".repeat(64) }), /does not match/);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [full.id]);
  await assert.rejects(reviewScheduleRequest(db, full, created.id, review(created)), /management access/);
  await assert.rejects(getScheduleRequest(db, full, created.id), /outside your access/);
  await reviewScheduleRequest(db, owner, created.id, review(created));
});

test("stale proposals never overwrite direct edits and can still be declined or withdrawn", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
  await updateSchedule(db, owner, f.schedule.id, { jobId: f.jobId, startsAt: f.input.startsAt, endsAt: f.input.endsAt, note: "Direct edited note", expectedVersion: 1, reason: "Direct schedule adjustment", commandId: randomUUID() });
  const detail = await getScheduleRequest(db, owner, created.id);
  assert.equal(detail.allowedActions.approve, false); assert.equal(detail.allowedActions.decline, true);
  assert.equal(detail.blockers.some(x => x.code === "SCHEDULE_CHANGED"), true);
  await assert.rejects(reviewScheduleRequest(db, owner, created.id, review(created)), /changed after/);
  const result = await withdrawScheduleRequest(db, f.employee, created.id, withdraw(created));
  assert.equal(result.status, "withdrawn"); assert.equal(result.appliedSchedule, null);
  const again = await createScheduleRequest(db, f.employee, { ...f.proposal, expectedScheduleVersion: 2, commandId: randomUUID() });
  assert.equal((await reviewScheduleRequest(db, owner, again.id, review(again, "declined"))).status, "declined");
  assert.equal((await scheduleHistory(db, owner, f.schedule.id)).current.version, 2);
});

test("overlap introduced after submission blocks approval while adjacent boundaries remain usable", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
  await createSchedule(db, owner, { ...f.input, startsAt: f.input.endsAt, endsAt: "2026-11-01T09:30:00.000Z", commandId: randomUUID() });
  const detail = await getScheduleRequest(db, owner, created.id);
  assert.equal(detail.blockers.some(x => x.code === "OVERLAP"), true);
  await assert.rejects(reviewScheduleRequest(db, owner, created.id, review(created)), /overlap/);
  await withdrawScheduleRequest(db, f.employee, created.id, withdraw(created));
  const adjacent = await createScheduleRequest(db, f.employee, { ...f.proposal, action: "update", proposal: { jobId: f.jobId, startsAt: "2026-11-01T04:30:00.000Z", endsAt: f.input.endsAt }, commandId: randomUUID() });
  await reviewScheduleRequest(db, owner, adjacent.id, review(adjacent));
});

test("cancel retains historical unassigned shifts and can be approved after employee deactivation", async () => {
  const f = await fixture();
  await db.query("DELETE FROM user_jobs WHERE user_id=$1", [f.employee.id]);
  await db.query("DELETE FROM user_units WHERE user_id=$1", [f.employee.id]);
  await db.query("UPDATE jobs SET active=false WHERE id=$1", [f.jobId]);
  await assert.rejects(createScheduleRequest(db, f.employee, f.proposal), /inactive|assigned/);
  const created = await createScheduleRequest(db, f.employee, { scheduleId: f.schedule.id, expectedScheduleVersion: 1, action: "cancel", reason: "Cancel historical assignment", commandId: randomUUID() });
  await db.query("UPDATE users SET active=false WHERE id=$1", [f.employee.id]);
  await assert.rejects(withdrawScheduleRequest(db, f.employee, created.id, withdraw(created)), /inactive/);
  const result = await reviewScheduleRequest(db, owner, created.id, review(created));
  assert.equal(result.appliedSchedule?.status, "cancelled");
  assert.equal((await scheduleHistory(db, owner, f.schedule.id)).rows.length, 2);
});

test("current source and target job units cannot be rebased and scope is rechecked for retained receipts", async () => {
  const f = await fixture(), target = await job(f.employee, units[1]), manager = await person("manager", units);
  const created = await createScheduleRequest(db, f.employee, { ...f.proposal, action: "update", proposal: { jobId: target, startsAt: f.input.startsAt, endsAt: f.input.endsAt } });
  await db.query("UPDATE jobs SET unit_id=$1 WHERE id=$2", [units[0], target]);
  assert.equal((await getScheduleRequest(db, owner, created.id)).blockers.some(x => x.code === "TARGET_UNIT_CHANGED"), true);
  await assert.rejects(reviewScheduleRequest(db, owner, created.id, review(created)), /moved/);
  await db.query("UPDATE jobs SET unit_id=$1 WHERE id=$2", [units[1], target]);
  const command = review(created), result = await reviewScheduleRequest(db, manager, created.id, command);
  assert.deepEqual(await reviewScheduleRequest(db, manager, created.id, command), result);
  await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [manager.id, units[0]]);
  await assert.rejects(reviewScheduleRequest(db, manager, created.id, command), /access|scope/);
  await assert.rejects(getScheduleRequest(db, manager, created.id), /outside your access/);
});

test("duplicate submissions and competing terminal decisions produce one pending request and one terminal outcome", async () => {
  const f = await fixture();
  const submits = await Promise.allSettled([createScheduleRequest(db, f.employee, f.proposal), createScheduleRequest(db, f.employee, { ...f.proposal, commandId: randomUUID() })]);
  assert.equal(submits.filter(x => x.status === "fulfilled").length, 1);
  const created = (submits.find(x => x.status === "fulfilled") as PromiseFulfilledResult<ScheduleRequestCreated>).value;
  const outcomes = await Promise.allSettled([reviewScheduleRequest(db, owner, created.id, review(created)), withdrawScheduleRequest(db, f.employee, created.id, withdraw(created))]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await scheduleRequestHistory(db, owner, created.id)).rows.length, 2);
  assert.equal((await scheduleHistory(db, owner, f.schedule.id)).current.version, 2);
  await assert.rejects(createScheduleRequest(db, f.employee, { ...f.proposal, reason: "Different command content" }), /identifier/);
});

test("fresh role, account, unit and assignment values are read after sorted account locks", async () => {
  const f = await fixture(), manager = await person("manager"), created = await createScheduleRequest(db, f.employee, f.proposal);
  const changed = (sql: string, values: any[]) => {
    let once = false;
    return wrap(async (tx, statement) => { if (!once && statement.includes("FROM users") && statement.includes("FOR NO KEY UPDATE")) { once = true; await tx.query(sql, values); } });
  };
  await assert.rejects(reviewScheduleRequest(changed("UPDATE users SET role='employee' WHERE id=$1", [manager.id]), manager, created.id, review(created)), /management access/);
  await assert.rejects(reviewScheduleRequest(changed("DELETE FROM user_units WHERE user_id=$1", [manager.id]), manager, created.id, review(created)), /scope/);
  await assert.rejects(reviewScheduleRequest(changed("DELETE FROM user_jobs WHERE user_id=$1", [f.employee.id]), owner, created.id, review(created)), /assigned/);
  await assert.rejects(reviewScheduleRequest(changed("UPDATE users SET active=false WHERE id=$1", [f.employee.id]), owner, created.id, review(created)), /inactive/);
  const another = await fixture();
  await assert.rejects(createScheduleRequest(changed("UPDATE users SET active=false WHERE id=$1", [another.employee.id]), another.employee, another.proposal), /inactive/);
  await assert.rejects(createScheduleRequest(changed("DELETE FROM user_units WHERE user_id=$1", [another.employee.id]), another.employee, another.proposal), /assigned/);
});

test("late request audit failure rolls back schedule, both histories, state and both receipt tables", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal), command = review(created);
  const fail = wrap(async (_tx, sql, values) => { if (sql.includes("INSERT INTO audit_events") && values?.[3] === "schedule_request.approved") throw Error("Synthetic final request audit failure"); });
  await assert.rejects(reviewScheduleRequest(fail, owner, created.id, command), /Synthetic final/);
  assert.equal((await getScheduleRequest(db, owner, created.id)).status, "pending");
  assert.equal((await scheduleHistory(db, owner, f.schedule.id)).rows.length, 1);
  assert.equal((await scheduleRequestHistory(db, owner, created.id)).rows.length, 1);
  const internal = (await db.query("SELECT schedule_command_id FROM staff_schedule_requests WHERE id=$1", [created.id])).rows[0];
  assert.equal((await db.query("SELECT 1 FROM staff_schedule_commands WHERE command_id=$1", [internal.schedule_command_id])).rows.length, 0);
  assert.equal((await db.query("SELECT 1 FROM staff_schedule_request_commands WHERE command_id=$1", [command.commandId])).rows.length, 0);
  await reviewScheduleRequest(db, owner, created.id, command);
  const second = await fixture(), submitFail = wrap(async (_tx, sql, values) => { if (sql.includes("INSERT INTO audit_events") && values?.[3] === "schedule_request.submitted") throw Error("Synthetic submit audit failure"); });
  await assert.rejects(createScheduleRequest(submitFail, second.employee, second.proposal), /Synthetic submit/);
  assert.equal((await db.query("SELECT 1 FROM staff_schedule_requests WHERE schedule_id=$1", [second.schedule.id])).rows.length, 0);
});

test("prepared schedule command privately captures validated fields and cannot be mutated after locks", async () => {
  const f = await fixture(), otherJob = randomUUID();
  await db.transaction(async tx => {
    const input = { jobId: f.jobId, startsAt: f.input.startsAt, endsAt: f.input.endsAt, note: "Captured note", expectedVersion: 1, reason: "Captured reason", commandId: randomUUID() };
    const prepared = await prepareStaffScheduleChange(tx, owner, { action: "updated", id: f.schedule.id, input });
    input.jobId = otherJob; input.note = "Later mutation"; input.expectedVersion = 999;
    await prepared.apply();
  });
  const result = await scheduleHistory(db, owner, f.schedule.id);
  assert.equal(result.current.jobId, f.jobId); assert.equal(result.current.note, "Captured note");
  await assert.rejects(db.transaction(tx => prepareStaffScheduleChange(tx, owner, { action: "cancelled", id: f.schedule.id, input: { expectedVersion: 2, commandId: randomUUID(), reason: "" } })), /small/);
});

test("request database evidence rejects source rewrites, deletion and terminal rewrites", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
  await assert.rejects(db.query("UPDATE staff_schedule_requests SET reason='Rewrite original reason' WHERE id=$1", [created.id]), /immutable/);
  await assert.rejects(db.query("DELETE FROM staff_schedule_requests WHERE id=$1", [created.id]), /cannot be deleted/);
  await withdrawScheduleRequest(db, f.employee, created.id, withdraw(created));
  await assert.rejects(db.query("UPDATE staff_schedule_requests SET decided_note='Rewrite decision' WHERE id=$1", [created.id]), /immutable/);
  for (const table of ["staff_schedule_request_history", "staff_schedule_request_commands"])
    await assert.rejects(db.query(`DELETE FROM ${table}`), /immutable|audit/i);
});

test("list cursor retains PostgreSQL microsecond ordering and reapplies exact own and team scope", async () => {
  const employee = await person(), jobId = await job(employee), ids: string[] = [];
  for (let index = 0; index < 51; index++) {
    const startsAt = new Date(Date.UTC(2027, 0, 1 + index, 13)).toISOString(), endsAt = new Date(Date.parse(startsAt) + 3600000).toISOString();
    const shift = await createSchedule(db, owner, { userId: employee.id, jobId, startsAt, endsAt, note: "", reason: "Synthetic pagination shift", commandId: randomUUID() });
    // Feed exact synthetic submission instants at insertion; immutable request
    // rows are never rewritten just to create a pagination fixture.
    const clocked: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: (sql, values) => {
      if (sql.startsWith("INSERT INTO staff_schedule_requests(")) return tx.query(sql.replace("schedule_command_id)", "schedule_command_id,submitted_at)").replace("$15,$16)", "$15,$16,$17)"),
        [...values!, "2026-12-01T00:00:00." + String(100000 + index).padStart(6, "0") + "Z"]);
      return tx.query(sql, values);
    } })) };
    ids.push((await createScheduleRequest(clocked, employee, { scheduleId: shift.id, expectedScheduleVersion: 1, action: "cancel", reason: "Synthetic pagination request", commandId: randomUUID() })).id);
  }
  const first = await listScheduleRequests(db, employee, scheduleRequestQuery.parse({}));
  assert.equal(first.rows.length, 50); assert.ok(first.nextCursor);
  const second = await listScheduleRequests(db, employee, scheduleRequestQuery.parse({ cursor: first.nextCursor }));
  assert.equal(second.rows.length, 1); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.rows, ...second.rows].map(x => x.id), ids.reverse());
  const other = await person();
  assert.equal((await listScheduleRequests(db, other, scheduleRequestQuery.parse({ cursor: first.nextCursor }))).rows.length, 0);
  const manager = await person("manager", [units[1]]);
  assert.equal((await listScheduleRequests(db, manager, scheduleRequestQuery.parse({ view: "team", cursor: first.nextCursor }))).rows.some(x => ids.includes(x.id)), false);
});

test("submit, approve, decline and withdrawal do not alter actual time, compensation or generic requests", async () => {
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of ["shifts", "segments", "compensation_schedules", "compensation_history", "requests"])
      result[table] = Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    return result;
  };
  const before = await counts();
  for (const action of ["approved", "declined", "withdrawn"] as const) {
    const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
    if (action === "withdrawn") await withdrawScheduleRequest(db, f.employee, created.id, withdraw(created));
    else await reviewScheduleRequest(db, owner, created.id, review(created, action));
  }
  assert.deepEqual(await counts(), before);
});

test("HTTP contracts reject unreviewed/malformed actions, CSRF and PIN; own read remains separate from team", async () => {
  const f = await fixture(), auth = await session(f.employee), pin = await session(f.employee, "pin"), manager = await session(owner);
  const post = (path: string, body: any, actor = auth) => request(app).post("/api/schedule-requests" + path).set("Origin", origin).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
  await request(app).post("/api/schedule-requests").set("Origin", origin).set("Cookie", auth.cookie).send(f.proposal).expect(403);
  await post("", f.proposal, pin).expect(403);
  await post("", { ...f.proposal, userId: owner.id }).expect(400);
  await post("", { ...f.proposal, reason: "" }).expect(400);
  const response = await post("", f.proposal).expect(201), created = response.body;
  await request(app).get("/api/schedule-requests?view=team").set("Cookie", auth.cookie).expect(403);
  const list = await request(app).get("/api/schedule-requests").set("Cookie", auth.cookie).expect(200);
  assert.deepEqual(list.body.rows.map((x: any) => x.id), [created.id]);
  await post(`/${created.id}/review`, { ...review(created), reviewed: false }, manager).expect(400);
  await post(`/${created.id}/review`, { ...review(created), proposal: { jobId: f.jobId } }, manager).expect(400);
  await post(`/${created.id}/review`, review(created), manager).expect(200);
  await request(app).get(`/api/schedule-requests/${created.id}/history`).set("Cookie", auth.cookie).expect(200);
  await request(app).get("/api/schedule-requests?cursor=not-a-cursor").set("Cookie", auth.cookie).expect(400);
});

test("restricted runtime can approve requests but cannot remove evidence or bypass transition protection", async () => {
  const f = await fixture(), created = await createScheduleRequest(db, f.employee, f.proposal);
  const maintenance = (await db.query("SELECT session_user AS name")).rows[0].name;
  for (const sql of runtimeGrantsSql().match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await db.query(sql);
  await db.query("SET SESSION AUTHORIZATION stjw_runtime");
  try {
    await assertRuntimeAccess(db); await reviewScheduleRequest(db, owner, created.id, review(created));
    for (const table of ["staff_schedule_requests", "staff_schedule_request_history", "staff_schedule_request_commands"])
      await assert.rejects(db.query(`DELETE FROM ${table}`), /permission denied/);
    await assert.rejects(db.query("UPDATE staff_schedule_requests SET reason='Bad edit' WHERE id=$1", [created.id]), /immutable/);
  } finally { await db.query('SET SESSION AUTHORIZATION "' + maintenance.replaceAll('"', '""') + '"'); }
  await db.query("GRANT DELETE ON staff_schedule_requests TO stjw_runtime");
  await db.query("SET SESSION AUTHORIZATION stjw_runtime");
  try { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }
  finally { await db.query('SET SESSION AUTHORIZATION "' + maintenance.replaceAll('"', '""') + '"'); }
  await db.query("REVOKE DELETE ON staff_schedule_requests FROM stjw_runtime");
  await db.query("ALTER TABLE staff_schedule_requests DISABLE TRIGGER protected_staff_schedule_request");
  await db.query("SET SESSION AUTHORIZATION stjw_runtime");
  try { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }
  finally { await db.query('SET SESSION AUTHORIZATION "' + maintenance.replaceAll('"', '""') + '"'); }
  await db.query("ALTER TABLE staff_schedule_requests ENABLE TRIGGER protected_staff_schedule_request");
});
