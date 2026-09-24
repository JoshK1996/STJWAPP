import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { lockStaffScheduleActors, lockStaffScheduleContext, prepareStaffScheduleChange, type StaffScheduleContext, type StaffScheduleChange } from "./staff-scheduling";
import {
  scheduleRequestCreateInput, scheduleRequestReviewInput, scheduleRequestWithdrawInput, scheduleRequestQuery,
  type ScheduleRequestCreate, type ScheduleRequestReview, type ScheduleRequestWithdraw, type ScheduleRequestQuery,
  type ScheduleRequestSummary, type ScheduleRequestDetail, type ScheduleRequestBlocker, type ScheduleRequestHistoryRow,
  type ScheduleRequestCreated, type ScheduleRequestDecided, type ScheduleRequestList, type ScheduleRequestProposal, type AppliedSchedule,
} from "../shared/schedule-requests";

const management = (actor: Actor) => ["developer", "owner", "admin", "manager"].includes(actor.role);
const wide = (actor: Actor) => ["developer", "owner", "admin"].includes(actor.role);
const inUnit = (actor: Actor, id: string) => wide(actor) || actor.unit_ids.includes(id);
const iso = (value: string | Date) => new Date(value).toISOString();
async function requestRow(tx: Queryable, orgId: string, id: string, lock?: "UPDATE" | "SHARE") {
  const row = (await tx.query(`SELECT * FROM staff_schedule_requests WHERE org_id=$1 AND id=$2${lock ? " FOR " + lock : ""}`, [orgId, id])).rows[0];
  requireCondition(row, 404, "Schedule request not found.");
  return row;
}
function managerScope(context: StaffScheduleContext, row: Row) {
  const { actor, before, jobs } = context;
  const source = jobs.find(j => j.id === row.source_job_id), target = row.target_job_id ? jobs.find(j => j.id === row.target_job_id) : null;
  return management(actor) && [row.source_unit_id, row.target_unit_id, before!.unitId, source?.unit_id, target?.unit_id]
    .filter(Boolean).every(id => inUnit(actor, id));
}
function requireRead(context: StaffScheduleContext, row: Row) {
  requireCondition(context.before!.userId === row.requester_id, 409, "The scheduled employee changed.");
  requireCondition(context.actor.id === row.requester_id || managerScope(context, row), 403, "This schedule request is outside your access.");
}
async function contextFor(tx: Queryable, actor: Actor, row: Row, write: boolean) {
  return lockStaffScheduleContext(tx, actor, { id: row.schedule_id }, [row.source_job_id, ...(row.target_job_id ? [row.target_job_id] : [])], write);
}
function summary(row: Row): ScheduleRequestSummary {
  return { id: row.id, version: row.version, status: row.status, action: row.action,
    requester: { id: row.requester_id, nameSnapshot: row.requester_name }, submittedAt: iso(row.submitted_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
    source: row.source_snapshot, proposal: row.proposal, appliedSchedule: row.applied_schedule };
}
async function blockers(tx: Queryable, context: StaffScheduleContext, row: Row): Promise<ScheduleRequestBlocker[]> {
  const { before: current, target: employee, jobs, actor } = context, source = row.source_snapshot;
  const result: ScheduleRequestBlocker[] = [];
  const add = (code: ScheduleRequestBlocker["code"], message: string) => result.push({ code, message });
  if (current!.version !== row.source_version || current!.jobId !== source.jobId || current!.startsAt !== source.startsAt || current!.endsAt !== source.endsAt || current!.note !== source.note)
    add("SCHEDULE_CHANGED", "The scheduled shift changed after this proposal was submitted. Withdraw this request and submit a new proposal.");
  if (current!.status !== "scheduled") add("SCHEDULE_CANCELLED", "The scheduled shift is already cancelled.");
  if (jobs.find(j => j.id === row.source_job_id)?.unit_id !== row.source_unit_id) add("SOURCE_UNIT_CHANGED", "The original job moved to another organizational unit.");
  if (row.action === "update") {
    const proposal = row.proposal as ScheduleRequestProposal, job = jobs.find(j => j.id === proposal.jobId);
    if (!employee?.active) add("EMPLOYEE_INACTIVE", "The employee account is inactive. Historical shifts can still be cancelled.");
    if (job?.unit_id !== row.target_unit_id) add("TARGET_UNIT_CHANGED", "The proposed job moved to another organizational unit.");
    if (!job?.active) add("TARGET_JOB_INACTIVE", "The proposed job is inactive.");
    const assigned = job && (await tx.query(`SELECT 1 FROM user_jobs j JOIN user_units u ON u.org_id=j.org_id AND u.user_id=j.user_id
      WHERE j.org_id=$1 AND j.user_id=$2 AND j.job_id=$3 AND u.unit_id=$4`, [actor.org_id, row.requester_id, proposal.jobId, job.unit_id])).rows.length;
    if (!assigned) add("TARGET_JOB_UNASSIGNED", "The employee is no longer assigned to the proposed job and its organizational unit.");
    if ((await tx.query(`SELECT 1 FROM schedules WHERE org_id=$1 AND user_id=$2 AND status='scheduled' AND id<>$3 AND starts_at<$5 AND ends_at>$4 LIMIT 1`,
      [actor.org_id, row.requester_id, row.schedule_id, proposal.startsAt, proposal.endsAt])).rows.length) add("OVERLAP", "The proposed times overlap another scheduled shift for this employee.");
    if (current!.jobId === proposal.jobId && current!.startsAt === proposal.startsAt && current!.endsAt === proposal.endsAt)
      add("NO_FIELD_CHANGE", "Change the job or scheduled times before submitting a proposal.");
  }
  return result;
}
async function commandLock(tx: Queryable, actor: Actor, commandId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", ["schedule-request:" + actor.org_id + ":" + actor.id, commandId]);
}
async function receipt(tx: Queryable, actor: Actor, commandId: string, fingerprint: string) {
  const previous = (await tx.query("SELECT fingerprint,result FROM staff_schedule_request_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3", [actor.org_id, actor.id, commandId])).rows[0];
  if (previous) requireCondition(previous.fingerprint === fingerprint, 409, "This command identifier was already used for another schedule request action.");
  return previous?.result;
}
async function saveReceipt(tx: Queryable, actor: Actor, commandId: string, fingerprint: string, result: ScheduleRequestCreated | ScheduleRequestDecided) {
  await tx.query("INSERT INTO staff_schedule_request_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)", [actor.org_id, actor.id, commandId, fingerprint, JSON.stringify(result)]);
}
async function history(tx: Queryable, actor: Actor, row: Row, action: ScheduleRequestHistoryRow["action"], reason: string, applied: AppliedSchedule | null) {
  const terminal = action !== "submitted";
  await tx.query(`INSERT INTO staff_schedule_request_history(id,org_id,request_id,request_version,action,actor_id,actor_name,actor_role,reason,before_state,after_state,applied_schedule)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), actor.org_id, row.id, terminal ? 2 : 1, action, actor.id, actor.name, actor.role, reason,
    terminal ? JSON.stringify({ version: 1, status: "pending" }) : null, JSON.stringify({ version: terminal ? 2 : 1, status: terminal ? action : "pending" }), applied ? JSON.stringify(applied) : null]);
}
export async function createScheduleRequest(db: Database, suppliedActor: Actor, raw: ScheduleRequestCreate): Promise<ScheduleRequestCreated> {
  const input = scheduleRequestCreateInput.parse(raw), fingerprint = digest(JSON.stringify({ action: "submit", input }));
  return db.transaction(async tx => {
    await commandLock(tx, suppliedActor, input.commandId);
    const context = await lockStaffScheduleContext(tx, suppliedActor, { id: input.scheduleId }, input.action === "update" ? [input.proposal.jobId] : []);
    const { actor, before: source, jobs, units } = context;
    requireCondition(source!.userId === actor.id, 403, "You may request a change only to your own scheduled shift.");
    const previous = await receipt(tx, actor, input.commandId, fingerprint);
    if (previous) return previous as ScheduleRequestCreated;
    requireCondition(source!.version === input.expectedScheduleVersion, 409, "This schedule changed. Reload it before submitting a request.");
    requireCondition(source!.status === "scheduled", 409, "This schedule is already cancelled.");
    let proposed: ScheduleRequestProposal | null = null;
    if (input.action === "update") {
      const job = jobs.find(j => j.id === input.proposal.jobId), unit = units.find(u => u.id === job?.unit_id);
      requireCondition(job && unit, 400, "This job is not assigned to you.");
      proposed = { jobId: job.id, jobTitle: job.title, unitId: unit.id, unitName: unit.name, startsAt: iso(input.proposal.startsAt), endsAt: iso(input.proposal.endsAt) };
    }
    const row = { id: randomUUID(), schedule_id: source!.id, requester_id: actor.id, source_version: source!.version, source_snapshot: source!, source_job_id: source!.jobId,
      source_unit_id: source!.unitId, action: input.action, proposal: proposed, target_job_id: proposed?.jobId ?? null, target_unit_id: proposed?.unitId ?? null };
    const invalid = await blockers(tx, context, row);
    requireCondition(!invalid.length, 409, invalid[0]?.message ?? "This proposal cannot be submitted.");
    requireCondition(!(await tx.query("SELECT id FROM staff_schedule_requests WHERE org_id=$1 AND schedule_id=$2 AND status='pending'", [actor.org_id, source!.id])).rows.length,
      409, "This shift already has a pending request. Withdraw that request before submitting another.");
    const proposalHash = digest(JSON.stringify({ orgId: actor.org_id, requesterId: actor.id, source, action: input.action, proposal: proposed, reason: input.reason }));
    await tx.query(`INSERT INTO staff_schedule_requests(id,org_id,schedule_id,requester_id,requester_name,source_version,source_snapshot,source_job_id,source_unit_id,
      action,proposal,target_job_id,target_unit_id,reason,proposal_hash,schedule_command_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [row.id, actor.org_id, row.schedule_id, actor.id, actor.name, row.source_version, JSON.stringify(source), row.source_job_id, row.source_unit_id, input.action,
        proposed ? JSON.stringify(proposed) : null, row.target_job_id, row.target_unit_id, input.reason, proposalHash, randomUUID()]);
    await history(tx, actor, row, "submitted", input.reason, null);
    const result: ScheduleRequestCreated = { id: row.id, version: 1, status: "pending", proposalHash };
    await audit(tx, actor, "schedule_request.submitted", row.id, { scheduleId: row.schedule_id, sourceVersion: row.source_version, version: 1, proposalHash, commandId: input.commandId });
    await saveReceipt(tx, actor, input.commandId, fingerprint, result);
    return result;
  });
}
function scheduleChange(row: Row): StaffScheduleChange {
  const common = { expectedVersion: row.source_version, commandId: row.schedule_command_id, reason: "Approved linked schedule request " + row.id };
  return row.action === "cancel" ? { action: "cancelled", id: row.schedule_id, input: common }
    : { action: "updated", id: row.schedule_id, input: { ...common, jobId: row.proposal.jobId, startsAt: row.proposal.startsAt, endsAt: row.proposal.endsAt, note: row.source_snapshot.note } };
}
async function decide(db: Database, suppliedActor: Actor, id: string, input: ScheduleRequestReview | ScheduleRequestWithdraw, withdrawal: boolean): Promise<ScheduleRequestDecided> {
  const fingerprint = digest(JSON.stringify({ action: withdrawal ? "withdraw" : "review", id, input }));
  return db.transaction(async tx => {
    await commandLock(tx, suppliedActor, input.commandId);
    const initial = await requestRow(tx, suppliedActor.org_id, id);
    const approval = !withdrawal && (input as ScheduleRequestReview).decision === "approved";
    // prepare locks the schedule command and sorted domain rows, and always
    // checks management authority. Validation below occurs before apply().
    const prepared = approval ? await prepareStaffScheduleChange(tx, suppliedActor, scheduleChange(initial), [initial.source_job_id]) : null;
    const context = prepared ?? await contextFor(tx, suppliedActor, initial, true);
    const { actor } = context;
    const row = await requestRow(tx, actor.org_id, id, "UPDATE");
    requireRead(context, row);
    if (withdrawal) requireCondition(actor.id === row.requester_id, 403, "Only the employee who submitted this request may withdraw it.");
    else {
      requireCondition(actor.id !== row.requester_id, 403, "You cannot review your own schedule request.");
      requireCondition(managerScope(context, row), 403, "Current management access to every source and target unit is required.");
    }
    const previous = await receipt(tx, actor, input.commandId, fingerprint);
    if (previous) return previous as ScheduleRequestDecided;
    requireCondition(row.status === "pending" && row.version === input.expectedRequestVersion, 409, "This request has already changed. Reload it before deciding.");
    requireCondition(row.proposal_hash === input.proposalHash, 409, "The reviewed proposal does not match this request. Reload it before deciding.");
    let applied: AppliedSchedule | null = null;
    if (approval) {
      const invalid = await blockers(tx, context, row);
      requireCondition(!invalid.length, 409, invalid[0]?.message ?? "This proposal can no longer be approved.");
      applied = await prepared!.apply() as AppliedSchedule;
    }
    const status = withdrawal ? "withdrawn" : (input as ScheduleRequestReview).decision;
    const note = withdrawal ? (input as ScheduleRequestWithdraw).reason : (input as ScheduleRequestReview).note;
    await tx.query(`UPDATE staff_schedule_requests SET version=2,status=$1,decided_by=$2,decided_name=$3,decided_note=$4,decided_at=now(),applied_schedule_version=$5,applied_schedule=$6
      WHERE org_id=$7 AND id=$8`, [status, actor.id, actor.name, note, applied?.version ?? null, applied ? JSON.stringify(applied) : null, actor.org_id, id]);
    await history(tx, actor, row, status, note, applied);
    const result: ScheduleRequestDecided = { id, version: 2, status, appliedSchedule: applied };
    await audit(tx, actor, "schedule_request." + status, id, { scheduleId: row.schedule_id, version: 2, sourceVersion: row.source_version,
      appliedVersion: applied?.version ?? null, proposalHash: row.proposal_hash, commandId: input.commandId });
    await saveReceipt(tx, actor, input.commandId, fingerprint, result);
    return result;
  });
}
export const reviewScheduleRequest = (db: Database, actor: Actor, id: string, input: ScheduleRequestReview) => decide(db, actor, z.uuid().parse(id), scheduleRequestReviewInput.parse(input), false);
export const withdrawScheduleRequest = (db: Database, actor: Actor, id: string, input: ScheduleRequestWithdraw) => decide(db, actor, z.uuid().parse(id), scheduleRequestWithdrawInput.parse(input), true);

export async function getScheduleRequest(db: Database, suppliedActor: Actor, id: string): Promise<ScheduleRequestDetail> {
  return db.transaction(async tx => {
    const initial = await requestRow(tx, suppliedActor.org_id, z.uuid().parse(id));
    const context = await contextFor(tx, suppliedActor, initial, false), row = await requestRow(tx, context.actor.org_id, id, "SHARE");
    requireRead(context, row);
    const invalid = row.status === "pending" ? await blockers(tx, context, row) : [];
    const reviewer = context.actor.id !== row.requester_id && managerScope(context, row), pending = row.status === "pending";
    return { ...summary(row), reason: row.reason, proposalHash: row.proposal_hash, current: context.before!,
      decision: row.decided_at ? { actor: { id: row.decided_by, nameSnapshot: row.decided_name }, note: row.decided_note, at: iso(row.decided_at) } : null,
      allowedActions: { approve: pending && reviewer && !invalid.length, decline: pending && reviewer, withdraw: pending && context.actor.id === row.requester_id }, blockers: invalid };
  });
}
export async function scheduleRequestHistory(db: Database, suppliedActor: Actor, id: string): Promise<{ rows: ScheduleRequestHistoryRow[] }> {
  return db.transaction(async tx => {
    const initial = await requestRow(tx, suppliedActor.org_id, z.uuid().parse(id)), context = await contextFor(tx, suppliedActor, initial, false);
    const row = await requestRow(tx, context.actor.org_id, id, "SHARE"); requireRead(context, row);
    const rows = (await tx.query("SELECT * FROM staff_schedule_request_history WHERE org_id=$1 AND request_id=$2 ORDER BY request_version", [context.actor.org_id, id])).rows;
    return { rows: rows.map(r => ({ id: r.id, requestVersion: r.request_version, action: r.action, actor: { id: r.actor_id, nameSnapshot: r.actor_name, roleSnapshot: r.actor_role },
      at: iso(r.created_at), reason: r.reason, before: r.before_state, after: r.after_state, appliedSchedule: r.applied_schedule })) };
  });
}
const position = z.object({ at: z.iso.datetime(), id: z.uuid() }).strict();
function cursorPosition(cursor?: string) {
  if (!cursor) return null;
  try { return position.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
  catch { requireCondition(false, 400, "Invalid schedule request page cursor."); }
}
export async function listScheduleRequests(db: Database, suppliedActor: Actor, input: ScheduleRequestQuery): Promise<ScheduleRequestList> {
  const after = cursorPosition(input.cursor);
  return db.transaction(async tx => {
    const { actor } = await lockStaffScheduleActors(tx, suppliedActor);
    if (input.view === "team") requireCondition(management(actor), 403, "Schedule request management access required.");
    const rows = (await tx.query(`SELECT r.*,to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM staff_schedule_requests r JOIN schedules s ON s.org_id=r.org_id AND s.id=r.schedule_id
      JOIN jobs cj ON cj.org_id=s.org_id AND cj.id=s.job_id JOIN jobs sj ON sj.org_id=r.org_id AND sj.id=r.source_job_id
      LEFT JOIN jobs tj ON tj.org_id=r.org_id AND tj.id=r.target_job_id
      WHERE r.org_id=$1 AND ($2='all' OR r.status=$2) AND ($3::uuid IS NULL OR r.schedule_id=$3)
      AND ($4::timestamptz IS NULL OR (r.submitted_at,r.id)<($4::timestamptz,$5::uuid))
      AND (($6='own' AND r.requester_id=$7) OR ($6='team' AND ($8::boolean OR
        (r.source_unit_id=ANY($9::uuid[]) AND (r.target_unit_id IS NULL OR r.target_unit_id=ANY($9::uuid[]))
         AND cj.unit_id=ANY($9::uuid[]) AND sj.unit_id=ANY($9::uuid[]) AND (tj.id IS NULL OR tj.unit_id=ANY($9::uuid[]))))))
      ORDER BY r.submitted_at DESC,r.id DESC LIMIT 51`, [actor.org_id, input.status, input.scheduleId ?? null, after?.at ?? null, after?.id ?? null,
        input.view, actor.id, wide(actor), actor.unit_ids])).rows;
    const shown = rows.slice(0, 50), last = shown.at(-1);
    return { rows: shown.map(summary), nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ at: last!.cursor_at, id: last!.id })).toString("base64url") : null };
  });
}
export function installScheduleRequests(app: Express, db: Database) {
  const actor = (req: Request) => (req as AppRequest).actor;
  app.get("/api/schedule-requests", async (req, res) => res.json(await listScheduleRequests(db, actor(req), scheduleRequestQuery.parse(req.query))));
  app.post("/api/schedule-requests", async (req, res) => res.status(201).json(await createScheduleRequest(db, actor(req), scheduleRequestCreateInput.parse(req.body))));
  app.get("/api/schedule-requests/:id", async (req, res) => res.json(await getScheduleRequest(db, actor(req), z.uuid().parse(req.params.id))));
  app.get("/api/schedule-requests/:id/history", async (req, res) => res.json(await scheduleRequestHistory(db, actor(req), z.uuid().parse(req.params.id))));
  app.post("/api/schedule-requests/:id/review", async (req, res) => res.json(await reviewScheduleRequest(db, actor(req), z.uuid().parse(req.params.id), scheduleRequestReviewInput.parse(req.body))));
  app.post("/api/schedule-requests/:id/withdraw", async (req, res) => res.json(await withdrawScheduleRequest(db, actor(req), z.uuid().parse(req.params.id), scheduleRequestWithdrawInput.parse(req.body))));
}
