import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db';
import { assertUnit, audit, issueSetup, manages, Problem, requireCondition, type Actor } from './security';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { assertManagePerson, validateStaff } from './workforce';
import { staffInput } from '../shared/contracts';
import { acquirePinNamespace } from './pin-auth';
import { staffRecordRevision } from './staff-revision';
import { staffUpdateInput } from '../shared/staff-editing';
export { staffUpdateInput } from '../shared/staff-editing';

export const managedJobInput = z.object({ unitId: z.uuid(), title: z.string().trim().min(2).max(100), description: z.string().trim().max(1000).default('') }).strict();
const proofOf = (value: string | undefined): string => {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 401, 'Your session has expired or changed. Sign in again.');
  return value;
};
const capture = (actor: Actor) => ({ ...actor, id: actor.id.toLowerCase(), org_id: actor.org_id.toLowerCase(), unit_ids: actor.unit_ids.map(id => id.toLowerCase()) });
async function transaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'");
      await tx.query("SET LOCAL lock_timeout='5s'");
      return work(tx);
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (['40001', '40P01'].includes(code ?? '') && attempt < 2) continue;
      if (['55P03', '57014', '40001', '40P01'].includes(code ?? '')) throw new Problem(503, 'Staff management is busy. Refresh the current state before trying again.');
      throw error;
    }
  }
}
async function currentActor(tx: Queryable, supplied: Actor, proof: string, targetId?: string) {
  requireCondition(supplied.mode === 'password', 403, 'Password sign-in is required for staff management.');
  if (targetId) {
    // Lock both existing accounts in a stable order before any session or
    // membership lock. Actor SHARE keeps audit foreign keys compatible; target
    // UPDATE is taken initially, never upgraded from a shared target lock.
    for (const id of [...new Set([supplied.id, targetId])].sort()) {
      const mode = id === targetId ? 'UPDATE' : 'SHARE';
      const found = (await tx.query(`SELECT id FROM users WHERE id=$1 AND org_id=$2 FOR ${mode}`, [id, supplied.org_id])).rows[0];
      requireCondition(found, id === supplied.id ? 403 : 404, id === supplied.id ? 'This account is unavailable.' : 'Staff member not found.');
    }
  }
  const actor = await currentReportActor(tx, supplied, proof);
  requireCondition(manages(actor), 403, 'Staff management access required.');
  return actor;
}
async function publish<T>(tx: Queryable, actor: Actor, proof: string, result: T) {
  JSON.stringify(result);
  await recheckReportSession(tx, actor, proof);
  return result;
}
async function lockAssignments(tx: Queryable, actor: Actor, input: z.infer<typeof staffInput>, targetId: string) {
  const jobs = [...new Set(input.jobIds)].sort();
  const found = (await tx.query('SELECT id,unit_id,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, jobs])).rows;
  const retained=(await tx.query('SELECT job_id FROM user_jobs WHERE org_id=$1 AND user_id=$2',[actor.org_id,targetId])).rows.map(row=>row.job_id);
  requireCondition(found.length === jobs.length && found.every(job => job.active || retained.includes(job.id)), 400, 'New assignments must use active jobs in the assigned units.');
  const units = [...new Set([...input.unitIds, ...found.map(job => job.unit_id as string)])].sort();
  const rows = (await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, units])).rows;
  requireCondition(rows.length === units.length, 400, 'Unknown organizational unit.');
}

export async function updateStaffAccount(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string, raw: unknown, staffDomain: string) {
  const proof = proofOf(sessionHash), identity = capture(supplied), id = z.uuid().parse(targetId).toLowerCase();
  const { expectedRevision, ...input } = staffUpdateInput.parse(raw);
  return transaction(db, async tx => {
    // Active-state changes participate in identifier-free PIN uniqueness before
    // either actor or target account is locked.
    await acquirePinNamespace(tx);
    const actor = await currentActor(tx, identity, proof, id);
    await assertManagePerson(tx, actor, id);
    const before = (await tx.query('SELECT name,email,role,active FROM users WHERE id=$1 AND org_id=$2', [id, actor.org_id])).rows[0];
    before.unitIds = (await tx.query('SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 ORDER BY unit_id', [id, actor.org_id])).rows.map(row => row.unit_id);
    before.jobIds = (await tx.query('SELECT job_id FROM user_jobs WHERE user_id=$1 AND org_id=$2 ORDER BY job_id', [id, actor.org_id])).rows.map(row => row.job_id);
    const revision = staffRecordRevision(actor.org_id, { id, name: before.name, email: before.email, role: before.role, active: before.active, unit_ids: before.unitIds, job_ids: before.jobIds });
    requireCondition(expectedRevision === revision, 409, 'This employee changed while the editor was open. Reload latest, review the current details and assignments, then save again.');
    await lockAssignments(tx, actor, input, id);
    const retainedJobIds=(await tx.query('SELECT job_id FROM user_jobs WHERE org_id=$1 AND user_id=$2',[actor.org_id,id])).rows.map(row=>row.job_id);
    await validateStaff(tx, actor, input, staffDomain, { role: before.role, email: before.email, retainedJobIds });
    requireCondition(!(await tx.query('SELECT id FROM shifts WHERE user_id=$1 AND org_id=$2 AND ended_at IS NULL', [id, actor.org_id])).rows.length,
      409, 'Clock out before changing this employee’s account or job assignments.');
    // An inactive PIN may now collide with a different active account. Preserve
    // its salted hash but require legacy uniqueness verification after reactivation.
    await tx.query('UPDATE users SET name=$1,email=$2,role=$3,pin_lookup=CASE WHEN NOT active AND $4 THEN NULL ELSE pin_lookup END,pin_lookup_key_id=CASE WHEN NOT active AND $4 THEN NULL ELSE pin_lookup_key_id END,active=$4 WHERE id=$5 AND org_id=$6', [input.name, input.email, input.role, input.active, id, actor.org_id]);
    await tx.query('DELETE FROM user_jobs WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM user_units WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    for (const unitId of [...new Set(input.unitIds)].sort()) await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [actor.org_id, id, unitId]);
    for (const jobId of [...new Set(input.jobIds)].sort()) await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)', [actor.org_id, id, jobId]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, actor.org_id]);
    await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM credential_change_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await audit(tx, actor, 'staff.updated', id, { before, after: input });
    return publish(tx, actor, proof, { ok: true as const });
  });
}

export async function issueManagedStaffSetupLink(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string, origin: string) {
  const proof = proofOf(sessionHash), identity = capture(supplied), id = z.uuid().parse(targetId).toLowerCase();
  return transaction(db, async tx => {
    const actor = await currentActor(tx, identity, proof, id);
    await assertManagePerson(tx, actor, id);
    const token = await issueSetup(tx, { id, org_id: actor.org_id });
    await audit(tx, actor, 'staff.setup_issued', id);
    return publish(tx, actor, proof, { setupUrl: `${origin}/#setup=${token}` });
  });
}

export async function createManagedJob(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const proof = proofOf(sessionHash), identity = capture(supplied), input = managedJobInput.parse(raw);
  return transaction(db, async tx => {
    const actor = await currentActor(tx, identity, proof);
    assertUnit(actor, input.unitId);
    requireCondition((await tx.query('SELECT id FROM units WHERE id=$1 AND org_id=$2 FOR SHARE', [input.unitId, actor.org_id])).rows.length, 404, 'Unit not found.');
    const id = randomUUID();
    await tx.query('INSERT INTO jobs(id,org_id,unit_id,title,description) VALUES($1,$2,$3,$4,$5)', [id, actor.org_id, input.unitId, input.title, input.description]);
    await audit(tx, actor, 'job.created', id, input);
    return publish(tx, actor, proof, { id });
  });
}

export const managedJobUpdateInput = managedJobInput.extend({ active: z.boolean(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(1000) });
async function jobHasReferences(tx: Queryable, orgId: string, jobId: string) {
  return (await tx.query(`SELECT
    EXISTS(SELECT 1 FROM user_jobs WHERE org_id=$1 AND job_id=$2) OR
    EXISTS(SELECT 1 FROM segments WHERE org_id=$1 AND job_id=$2) OR
    EXISTS(SELECT 1 FROM schedules WHERE org_id=$1 AND job_id=$2) OR
    EXISTS(SELECT 1 FROM staff_planning_definitions WHERE org_id=$1 AND job_id=$2) OR
    EXISTS(SELECT 1 FROM staff_planning_history WHERE org_id=$1 AND (before_snapshot->>'jobId'=$2::text OR after_snapshot->>'jobId'=$2::text)) OR
    EXISTS(SELECT 1 FROM compensation_schedules WHERE org_id=$1 AND job_id=$2) OR
    EXISTS(SELECT 1 FROM staff_schedule_requests WHERE org_id=$1 AND (source_job_id=$2 OR target_job_id=$2)) OR
    EXISTS(SELECT 1 FROM time_corrections WHERE org_id=$1 AND (proposed @> jsonb_build_array(jsonb_build_object('jobId',$2::text)) OR original->'segments' @> jsonb_build_array(jsonb_build_object('jobId',$2::text)))) OR
    EXISTS(SELECT 1 FROM time_adjustment_requests WHERE org_id=$1 AND scope_snapshot->'jobIds' ? $2::text)
    AS used`, [orgId,jobId])).rows[0].used;
}
export async function updateManagedJob(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string, raw: unknown) {
  const proof=proofOf(sessionHash), identity=capture(supplied), id=z.uuid().parse(targetId).toLowerCase(), input=managedJobUpdateInput.parse(raw);
  return transaction(db,async tx=>{
    const actor=await currentActor(tx,identity,proof);
    // Clock-in/switch and assignment writers hold SHARE on this stable identity.
    const before=(await tx.query('SELECT * FROM jobs WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.org_id])).rows[0];
    requireCondition(before,404,'Job not found.'); assertUnit(actor,before.unit_id); assertUnit(actor,input.unitId);
    requireCondition(before.version===input.expectedVersion,409,'This job changed while you were editing. Close this editor, refresh the directory and review the latest version.');
    requireCondition((await tx.query('SELECT id FROM units WHERE id=$1 AND org_id=$2 FOR SHARE',[input.unitId,actor.org_id])).rows.length,404,'Community not found.');
    if(before.unit_id!==input.unitId) requireCondition(!await jobHasReferences(tx,actor.org_id,id),409,'This job has assignments or retained records, so its community must stay the same. Create a job in the destination community and archive this one when it is no longer needed.');
    if(before.active && !input.active) requireCondition(!(await tx.query(`SELECT 1 FROM segments g JOIN shifts s ON s.id=g.shift_id AND s.org_id=g.org_id
      WHERE g.org_id=$1 AND g.job_id=$2 AND g.revision=s.revision AND g.ended_at IS NULL AND s.ended_at IS NULL LIMIT 1`,[actor.org_id,id])).rows.length,409,'Someone is currently clocked in under this job. They must switch jobs or clock out before it can be archived.');
    const after=(await tx.query('UPDATE jobs SET title=$1,description=$2,unit_id=$3,active=$4,version=version+1 WHERE id=$5 AND org_id=$6 RETURNING id,title,description,unit_id,active,version',[input.title,input.description,input.unitId,input.active,id,actor.org_id])).rows[0];
    await audit(tx,actor,'job.updated',id,{before:{title:before.title,description:before.description,unitId:before.unit_id,active:before.active,version:before.version},after:{title:after.title,description:after.description,unitId:after.unit_id,active:after.active,version:after.version},reason:input.reason});
    return publish(tx,actor,proof,{job:after});
  });
}
export async function managedJobHistory(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string) {
  const proof=proofOf(sessionHash), identity=capture(supplied), id=z.uuid().parse(targetId).toLowerCase();
  return transaction(db,async tx=>{
    const actor=await currentActor(tx,identity,proof), job=(await tx.query('SELECT * FROM jobs WHERE id=$1 AND org_id=$2 FOR SHARE',[id,actor.org_id])).rows[0];
    requireCondition(job,404,'Job not found.');assertUnit(actor,job.unit_id);
    const rows=(await tx.query(`SELECT e.action,e.detail,e.created_at,u.name AS actor_name FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id AND u.org_id=e.org_id
      WHERE e.org_id=$1 AND e.target_id=$2 AND e.action IN('job.created','job.updated') ORDER BY e.created_at DESC,e.id DESC LIMIT 101`,[actor.org_id,id])).rows;
    return publish(tx,actor,proof,{rows:rows.slice(0,100),truncated:rows.length>100,communityLocked:await jobHasReferences(tx,actor.org_id,id)});
  });
}
