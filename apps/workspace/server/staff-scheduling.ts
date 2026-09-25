import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { currentTimeActor } from "./time-record-access";
import { recheckReportSession } from "./report-source-access";
import {
  staffScheduleCreateInput, staffScheduleUpdateInput, staffScheduleCancelInput,
  staffScheduleQuery, staffScheduleHistoryQuery,
  type StaffScheduleCreate, type StaffScheduleUpdate, type StaffScheduleCancel, type StaffScheduleSnapshot,
} from "../shared/staff-scheduling";

const scheduleSelect = `SELECT s.*,e.name AS employee_name,j.title AS job_title,j.unit_id,u.name AS unit_name
 FROM schedules s JOIN users e ON e.org_id=s.org_id AND e.id=s.user_id
 JOIN jobs j ON j.org_id=s.org_id AND j.id=s.job_id JOIN units u ON u.org_id=s.org_id AND u.id=j.unit_id`;
const wide = (actor: Actor) => ["developer", "owner", "admin", "finance"].includes(actor.role);
const manager = (actor: Actor) => ["developer", "owner", "admin", "manager"].includes(actor.role);
const within = (actor: Actor, unitId: string) => wide(actor) || actor.unit_ids.includes(unitId);
const view = (actor: Actor, row: Row) => row.user_id === actor.id || wide(actor) || (actor.role === "manager" && within(actor, row.unit_id));

// Every assignment writer locks the employee row. Lock all affected user rows in a
// stable order before inspecting current role, units, job assignments or schedules.
// NO KEY UPDATE still excludes assignment edits, but allows audit foreign-key
// KEY SHARE checks from older staff writers that lock only the target employee.
export async function lockStaffScheduleActors(tx: Queryable, actor: Actor, userId?: string, write = false) {
  requireCondition(actor.mode === "password", 403, "Staff schedules require password sign-in.");
  const ids = [...new Set([actor.id, ...(userId ? [userId] : [])])];
  const users = (await tx.query(`SELECT id,name,role,active FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${write ? "NO KEY UPDATE" : "SHARE"}`, [actor.org_id, ids])).rows;
  const current = users.find(x => x.id === actor.id);
  requireCondition(current?.active, 403, "Account is inactive.");
  const unitIds = (await tx.query("SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id", [actor.org_id, actor.id])).rows.map(x => x.unit_id);
  const verified: Actor = { ...actor, role: current.role, name: current.name, unit_ids: unitIds };
  const target = userId ? users.find(x => x.id === userId) : undefined;
  if (userId) requireCondition(target, 404, "Staff member not found.");
  return { actor: verified, target };
}
export function staffScheduleSnapshot(row: Row): StaffScheduleSnapshot {
  return {
    id: row.id, userId: row.user_id, employeeName: row.employee_name,
    jobId: row.job_id, jobTitle: row.job_title, unitId: row.unit_id, unitName: row.unit_name,
    startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
    note: row.note, version: row.version, status: row.status,
    updatedAt: new Date(row.updated_at).toISOString(), cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
  };
}
export async function readStaffSchedule(tx: Queryable, orgId: string, id: string) {
  const row = (await tx.query(scheduleSelect + " WHERE s.org_id=$1 AND s.id=$2", [orgId, id])).rows[0];
  requireCondition(row, 404, "Scheduled shift not found.");
  return row;
}
async function recordHistory(tx: Queryable, actor: Pick<Actor, "id" | "org_id">, after: StaffScheduleSnapshot, action: string, reason: string, before: StaffScheduleSnapshot | null) {
  await tx.query(`INSERT INTO staff_schedule_history(org_id,schedule_id,version,action,before_snapshot,after_snapshot,reason,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.org_id, after.id, after.version, action, before ? JSON.stringify(before) : null, JSON.stringify(after), reason, actor.id]);
}
// Provisioning only: records synthetic examples inserted by initialize(). Runtime
// routes always use the versioned service below rather than this helper.
export async function recordSeedSchedule(tx: Queryable, actor: Pick<Actor, "id" | "org_id">, id: string) {
  await recordHistory(tx, actor, staffScheduleSnapshot(await readStaffSchedule(tx, actor.org_id, id)), "created", "Initial synthetic demonstration schedule.", null);
}
export type StaffScheduleChange = { action: "created"; input: StaffScheduleCreate } | { action: "updated"; id: string; input: StaffScheduleUpdate } | { action: "cancelled"; id: string; input: StaffScheduleCancel };
const changeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("created"), input: staffScheduleCreateInput }).strict(),
  z.object({ action: z.literal("updated"), id: z.uuid(), input: staffScheduleUpdateInput }).strict(),
  z.object({ action: z.literal("cancelled"), id: z.uuid(), input: staffScheduleCancelInput }).strict(),
]);
// Transaction-scoped domain locks shared by direct schedule commands and linked
// requests. A context alone never grants authority to mutate a schedule.
export async function lockStaffScheduleContext(tx: Queryable, suppliedActor: Actor, identity: { id: string } | { userId: string }, extraJobIds: string[] = [], write = true) {
  const initial = "id" in identity ? await readStaffSchedule(tx, suppliedActor.org_id, identity.id) : null;
  const userId = initial ? initial.user_id as string : (identity as { userId: string }).userId;
  const { actor, target } = await lockStaffScheduleActors(tx, suppliedActor, userId, write);
  let before: StaffScheduleSnapshot | null = null;
  if (initial) {
    await tx.query(`SELECT id FROM schedules WHERE org_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`, [actor.org_id, initial.id]);
    const current = await readStaffSchedule(tx, actor.org_id, initial.id);
    requireCondition(current.user_id === userId, 409, "The scheduled employee changed. Reload the schedule.");
    before = staffScheduleSnapshot(current);
  }
  const jobIds = [...new Set([...(before ? [before.jobId] : []), ...extraJobIds])];
  const jobs = (await tx.query("SELECT id,unit_id,active,title FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [actor.org_id, jobIds])).rows;
  const units = (await tx.query("SELECT id,name FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [actor.org_id, jobs.map(j => j.unit_id)])).rows;
  if (before) {
    requireCondition(jobs.find(j => j.id === before!.jobId)?.unit_id === before.unitId, 409, "The original job moved to another unit. Reload the schedule.");
    before = staffScheduleSnapshot(await readStaffSchedule(tx, actor.org_id, before.id));
  }
  return { actor, target, userId, before, jobs, units };
}
export type StaffScheduleContext = Awaited<ReturnType<typeof lockStaffScheduleContext>>;
// Management-only application capability. Callers may validate other locked
// evidence before apply(), but cannot skip current schedule authority checks.
// The caller owns ONE transaction for these locks, application and linked data.
export async function prepareStaffScheduleChange(tx: Queryable, suppliedActor: Actor, suppliedChange: StaffScheduleChange, additionalJobIds: string[] = []) {
    // Zod returns a private, validated copy: callers cannot change executable
    // fields between scope/lock validation and application through their input.
    const change = changeInput.parse(suppliedChange);
    const input = change.input;
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", ["staff-schedule:" + suppliedActor.org_id + ":" + suppliedActor.id, input.commandId]);
    const context = await lockStaffScheduleContext(tx, suppliedActor,
      change.action === "created" ? { userId: change.input.userId } : { id: change.id },
      [...z.array(z.uuid()).parse(additionalJobIds), ...(change.action === "cancelled" ? [] : [change.input.jobId])]);
    const { actor, target, userId, before, jobs } = context;
    requireCondition(manager(actor), 403, "Schedule management access required.");
    if (before) requireCondition(within(actor, before.unitId), 403, "The original scheduled job is outside your management scope.");
    let targetJob: Row | undefined;
    if (change.action !== "cancelled") {
      targetJob = jobs.find(j => j.id === change.input.jobId);
      requireCondition(targetJob, 400, "This job is not assigned to the staff member.");
      requireCondition(within(actor, targetJob.unit_id), 403, "The selected job is outside your management scope.");
    }
    const apply = async () => {
    const fingerprint = digest(JSON.stringify(change));
    const previous = (await tx.query("SELECT fingerprint,result FROM staff_schedule_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3", [actor.org_id, actor.id, input.commandId])).rows[0];
    if (previous) {
      requireCondition(previous.fingerprint === fingerprint, 409, "This command identifier was already used for another schedule change.");
      // Creates have no source until their receipt is found. Verify the resulting
      // record's current scope too, in case a later administrator moved it.
      const recorded = await readStaffSchedule(tx, actor.org_id, previous.result.id);
      requireCondition(within(actor, recorded.unit_id), 403, "The scheduled job is outside your management scope.");
      return previous.result as { id: string; version: number; status: string };
    }
    if (change.action !== "created") {
      requireCondition(before!.version === change.input.expectedVersion, 409, "This schedule changed. Reload it before saving.");
      requireCondition(before!.status === "scheduled", 409, "This schedule is already cancelled. Create a new shift if needed.");
    }
    if (change.action !== "cancelled") {
      requireCondition(target?.active, 409, "The staff account is inactive. Existing shifts may still be cancelled.");
      const assigned = (await tx.query(`SELECT uj.job_id FROM user_jobs uj JOIN user_units uu ON uu.org_id=uj.org_id AND uu.user_id=uj.user_id
        WHERE uj.org_id=$1 AND uj.user_id=$2 AND uj.job_id=$3 AND uu.unit_id=$4`, [actor.org_id, userId, change.input.jobId, targetJob!.unit_id])).rows.length;
      requireCondition(targetJob!.active && assigned, 400, "This job is not assigned to the staff member or is inactive.");
      const overlap = (await tx.query(`SELECT id FROM schedules WHERE org_id=$1 AND user_id=$2 AND status='scheduled'
        AND starts_at<$4 AND ends_at>$3 AND ($5::uuid IS NULL OR id<>$5) LIMIT 1`, [actor.org_id, userId, change.input.startsAt, change.input.endsAt, before?.id ?? null])).rows.length;
      requireCondition(!overlap, 409, "This employee already has a shift during that time.");
    }
    const id = before?.id ?? randomUUID();
    if (change.action === "created") {
      await tx.query("INSERT INTO schedules(id,org_id,user_id,job_id,starts_at,ends_at,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, actor.org_id, userId, change.input.jobId, change.input.startsAt, change.input.endsAt, change.input.note, actor.id]);
    } else if (change.action === "updated") {
      requireCondition(before!.jobId !== change.input.jobId || before!.startsAt !== new Date(change.input.startsAt).toISOString() || before!.endsAt !== new Date(change.input.endsAt).toISOString() || before!.note !== change.input.note, 400, "Change a schedule field before saving.");
      await tx.query("UPDATE schedules SET job_id=$1,starts_at=$2,ends_at=$3,note=$4,version=version+1,updated_at=now() WHERE org_id=$5 AND id=$6", [change.input.jobId, change.input.startsAt, change.input.endsAt, change.input.note, actor.org_id, id]);
    } else {
      await tx.query("UPDATE schedules SET status='cancelled',cancelled_at=now(),updated_at=now(),version=version+1 WHERE org_id=$1 AND id=$2", [actor.org_id, id]);
    }
    const after = staffScheduleSnapshot(await readStaffSchedule(tx, actor.org_id, id));
    await recordHistory(tx, actor, after, change.action, input.reason, before);
    const result = { id, version: after.version, status: after.status };
    await audit(tx, actor, "schedule." + change.action, id, { version: after.version, previousVersion: before?.version ?? null, commandId: input.commandId, snapshotHash: digest(JSON.stringify(after)) });
    await tx.query("INSERT INTO staff_schedule_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)", [actor.org_id, actor.id, input.commandId, fingerprint, JSON.stringify(result)]);
    return result;
  };
  return { ...context, apply };
}
async function changeSchedule(db: Database, actor: Actor, change: StaffScheduleChange) {
  return db.transaction(async tx => (await prepareStaffScheduleChange(tx, actor, change)).apply());
}
export const createSchedule = (db: Database, actor: Actor, input: StaffScheduleCreate) => changeSchedule(db, actor, { action: "created", input: staffScheduleCreateInput.parse(input) });
export const updateSchedule = (db: Database, actor: Actor, id: string, input: StaffScheduleUpdate) => changeSchedule(db, actor, { action: "updated", id: z.uuid().parse(id), input: staffScheduleUpdateInput.parse(input) });
export const cancelSchedule = (db: Database, actor: Actor, id: string, input: StaffScheduleCancel) => changeSchedule(db, actor, { action: "cancelled", id: z.uuid().parse(id), input: staffScheduleCancelInput.parse(input) });
export async function listSchedules(db: Database, suppliedActor: Actor, query: z.infer<typeof staffScheduleQuery>) {
  return db.transaction(async tx => {
    const { actor } = await lockStaffScheduleActors(tx, suppliedActor);
    const rows = (await tx.query(scheduleSelect + ` WHERE s.org_id=$1 AND s.starts_at<$3 AND s.ends_at>$2
      AND ($4::boolean OR s.status='scheduled') AND (s.user_id=$5 OR $6::boolean OR ($7::boolean AND j.unit_id=ANY($8::uuid[])))
      ORDER BY s.starts_at,s.id LIMIT 2001`, [actor.org_id, query.start, query.end, query.includeCancelled, actor.id, wide(actor), actor.role === "manager", actor.unit_ids])).rows;
    requireCondition(rows.length <= 2000, 400, "More than 2,000 schedules match. Choose a shorter date range.");
    return { rows };
  });
}
export async function scheduleHistory(db: Database, suppliedActor: Actor, id: string, beforeVersion?: number) {
  return db.transaction(async tx => {
    const initial = await readStaffSchedule(tx, suppliedActor.org_id, id);
    const { actor } = await lockStaffScheduleActors(tx, suppliedActor, initial.user_id);
    // Hold the schedule while reading its current state and history. Writers
    // always take employee/actor locks before this row lock.
    await tx.query("SELECT id FROM schedules WHERE org_id=$1 AND id=$2 FOR SHARE", [actor.org_id, id]);
    const current = await readStaffSchedule(tx, actor.org_id, id);
    requireCondition(view(actor, current), 403, "This schedule is outside your access.");
    if (actor.role === "manager" && current.user_id !== actor.id) {
      const outside = (await tx.query(`SELECT version FROM staff_schedule_history WHERE org_id=$1 AND schedule_id=$2
        AND (NOT ((after_snapshot->>'unitId')::uuid=ANY($3::uuid[]))
        OR (before_snapshot IS NOT NULL AND NOT ((before_snapshot->>'unitId')::uuid=ANY($3::uuid[])))) LIMIT 1`, [actor.org_id, id, actor.unit_ids])).rows.length;
      requireCondition(!outside, 403, "This schedule's earlier history includes a unit outside your current access.");
    }
    const rows = (await tx.query(`SELECT h.version,h.action,h.reason,h.before_snapshot,h.after_snapshot,h.created_at,
      coalesce(e.name,'System baseline') AS actor_name FROM staff_schedule_history h
      LEFT JOIN users e ON e.org_id=h.org_id AND e.id=h.actor_id
      WHERE h.org_id=$1 AND h.schedule_id=$2 AND ($3::integer IS NULL OR h.version<$3) ORDER BY h.version DESC LIMIT 21`, [actor.org_id, id, beforeVersion ?? null])).rows;
    return { current: staffScheduleSnapshot(current), rows: rows.slice(0, 20), nextBeforeVersion: rows.length > 20 ? rows[19].version : null };
  });
}
export function installStaffScheduling(app: Express, db: Database) {
  const actor = (req: Request) => (req as AppRequest).actor;
  const authenticated = (req: Request) => authenticatedScheduleDatabase(db, actor(req), (req as AppRequest).sessionHash);
  app.get("/api/schedules", async (req, res) => res.set('Cache-Control','private, no-store').json(await listSchedules(authenticated(req), actor(req), staffScheduleQuery.parse(req.query))));
  app.post("/api/schedules", async (req, res) => res.set('Cache-Control','private, no-store').status(201).json(await createSchedule(authenticated(req), actor(req), staffScheduleCreateInput.parse(req.body))));
  app.patch("/api/schedules/:id", async (req, res) => res.set('Cache-Control','private, no-store').json(await updateSchedule(authenticated(req), actor(req), z.uuid().parse(req.params.id), staffScheduleUpdateInput.parse(req.body))));
  app.post("/api/schedules/:id/cancel", async (req, res) => res.set('Cache-Control','private, no-store').json(await cancelSchedule(authenticated(req), actor(req), z.uuid().parse(req.params.id), staffScheduleCancelInput.parse(req.body))));
  app.get("/api/schedules/:id/history", async (req, res) => res.set('Cache-Control','private, no-store').json(await scheduleHistory(authenticated(req), actor(req), z.uuid().parse(req.params.id), staffScheduleHistoryQuery.parse(req.query).beforeVersion)));
}

/** HTTP boundary only. Keep the trusted transaction helper usable by imports and
 * reviewed plans; original actor/employee lock ordering runs before proof locks. */
export function authenticatedScheduleDatabase(db: Database, actor: Actor, sessionHash: string | undefined): Database {
  requireCondition(actor.mode === 'password',403,'Staff schedules require password sign-in.');
  requireCondition(typeof sessionHash === 'string' && /^[a-f0-9]{64}$/.test(sessionHash),401,'A current password session is required.');
  return { ...db, transaction: operation => db.transaction(async tx => {
    // Existing service functions lock their sorted actor/employee accounts first.
    // A failed final proof rolls the entire service operation and audit back.
    const result = await operation(tx);
    const current = await currentTimeActor(tx,actor,sessionHash);
    await recheckReportSession(tx,current,sessionHash);
    return result;
  }) };
}
