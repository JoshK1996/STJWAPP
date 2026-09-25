import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db';
import { audit, assertUnit, digest, manages, orgWide, requireCondition, type Actor } from './security';
import { clockInput, requestInput, staffInput } from '../shared/contracts';
import type { z } from 'zod';
import { noTimeOverlap,timeMicroseconds } from './time-record-access';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { staffRecordRevision } from './staff-revision';

export async function clockState(db: Queryable, actor: Actor) {
  const jobs = (await db.query(`SELECT j.*,u.name AS unit_name FROM user_jobs uj JOIN jobs j ON j.id=uj.job_id
    JOIN units u ON u.id=j.unit_id JOIN user_units uu ON uu.user_id=uj.user_id AND uu.unit_id=j.unit_id
    WHERE uj.user_id=$1 AND uj.org_id=$2 AND j.active=true ORDER BY u.name,j.title`, [actor.id,actor.org_id])).rows;
  const shift = (await db.query(`SELECT s.*,g.id AS segment_id,g.kind,g.started_at AS segment_started_at,g.job_id,j.title AS job_title,u.name AS unit_name
    FROM shifts s JOIN segments g ON g.shift_id=s.id AND g.org_id=s.org_id AND g.revision=s.revision AND g.ended_at IS NULL JOIN jobs j ON j.id=g.job_id JOIN units u ON u.id=j.unit_id
    WHERE s.user_id=$1 AND s.org_id=$2 AND s.ended_at IS NULL`, [actor.id,actor.org_id])).rows[0] ?? null;
  return { shift, jobs, serverTime: new Date().toISOString() };
}
/** Internal transition primitive. Caller holds the employee account lock.
 * Public HTTP callers must use clock-session.ts; no session is created here. */
export async function clockTransition(tx: Queryable, actor: Actor, raw: z.infer<typeof clockInput>, injectedNow?: Date|string, scheduled?: {intentId:string;scheduleId:string;scheduleVersion:number;requestedAt:string;processedAt:string}, decorate?: (result:Awaited<ReturnType<typeof clockState>>)=>Promise<any>) {
  const input = clockInput.parse(raw);
    const fingerprint = digest(JSON.stringify({ action: input.action, jobId: input.jobId ?? null }));
    const previous = (await tx.query('SELECT fingerprint,result FROM clock_commands WHERE user_id=$1 AND command_id=$2',[actor.id,input.commandId])).rows[0];
    if (previous) { requireCondition(previous.fingerprint===fingerprint,409,'This command identifier was already used for another action.'); return previous.result; }
    // Production time is sampled after waiting for the shared employee lock.
    // Explicit test instants are still checked against exact database bounds.
    const now = typeof injectedNow==='string'?injectedNow:injectedNow ? new Date(injectedNow) : new Date();
    if(typeof now==='string')timeMicroseconds(now);
    else requireCondition(Number.isFinite(now.valueOf()),400,'Use a valid clock instant.');
    // Serialize new use with job edits/archiving while the account lock is held.
    if ((input.action==='clock_in'||input.action==='switch_job') && input.jobId)
      await tx.query('SELECT id FROM jobs WHERE org_id=$1 AND id=$2 FOR SHARE',[actor.org_id,input.jobId]);
    const state = await clockState(tx,actor);
    const current = state.shift;
    let shiftId = current?.id;
    let jobId = current?.job_id;
    let kind = 'work';
    if (input.action==='clock_in') {
      requireCondition(!current,409,'You are already clocked in.');
      requireCondition(input.jobId && state.jobs.some(j=>j.id===input.jobId),403,'Choose one of your assigned jobs.');
      requireCondition(await noTimeOverlap(tx,actor.org_id,actor.id,now,null),409,'This clock-in overlaps another recorded shift. Refresh the current time record.');
      shiftId=randomUUID(); jobId=input.jobId;
      await tx.query('INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,$4)',[shiftId,actor.org_id,actor.id,now]);
    } else {
      requireCondition(current,409,'Clock in before performing this action.');
      const ordered = (await tx.query('SELECT $1::timestamptz>=started_at AS valid FROM segments WHERE id=$2 AND org_id=$3 AND shift_id=$4 AND revision=$5',[now,current.segment_id,actor.org_id,current.id,current.revision])).rows[0];
      requireCondition(ordered?.valid,409,'Server time precedes the current record.');
      if (input.action==='switch_job') {
        requireCondition(current.kind==='work',409,'End your break before switching jobs.');
        requireCondition(input.jobId && state.jobs.some(j=>j.id===input.jobId),403,'Choose one of your assigned jobs.');
        requireCondition(input.jobId!==current.job_id,409,'You are already working this job.'); jobId=input.jobId;
      }
      if (input.action==='start_break') { requireCondition(current.kind==='work',409,'You are already on a break.'); kind='break'; }
      if (input.action==='end_break') requireCondition(current.kind==='break',409,'There is no active break.');
      await tx.query('UPDATE segments SET ended_at=$1 WHERE id=$2 AND org_id=$3 AND shift_id=$4 AND revision=$5 AND ended_at IS NULL',[now,current.segment_id,actor.org_id,current.id,current.revision]);
    }
    if (input.action==='clock_out') await tx.query('UPDATE shifts SET ended_at=$1 WHERE id=$2 AND org_id=$3',[now,shiftId,actor.org_id]);
    else await tx.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.org_id,shiftId,jobId,kind,now,current?.revision??1]);
    await audit(tx,actor,`clock.${input.action}`,shiftId,{ jobId, at:typeof now==='string'?now:now.toISOString(), commandId:input.commandId, authentication:actor.mode,...(scheduled?{scheduled}: {}) });
    const stateAfter = await clockState(tx,actor),result=decorate?await decorate(stateAfter):stateAfter;
    await tx.query('INSERT INTO clock_commands(org_id,user_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[actor.org_id,actor.id,input.commandId,fingerprint,JSON.stringify(result)]);
    return result;
}
/** Trusted local-fixture compatibility. Never install this wrapper on an HTTP route. */
export async function clockCommand(db: Database, actor: Actor, raw: z.infer<typeof clockInput>, injectedNow?: Date) {
  const input = clockInput.parse(raw);
  return db.transaction(async tx => {
    const person = (await tx.query('SELECT active FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE',[actor.id,actor.org_id])).rows[0];
    requireCondition(person?.active,403,'Account is inactive.');
    return clockTransition(tx,actor,input,injectedNow);
  });
}
export async function listStaff(db: Queryable, actor: Actor) {
  return (await db.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.created_at,
    coalesce((SELECT jsonb_agg(uu.unit_id) FROM user_units uu WHERE uu.user_id=u.id),'[]') AS unit_ids,
    coalesce((SELECT jsonb_agg(uj.job_id) FROM user_jobs uj WHERE uj.user_id=u.id),'[]') AS job_ids,
    (u.password_hash IS NOT NULL AND NOT u.requires_credential_change) AS setup_complete,u.requires_credential_change,u.require_password_change,u.require_pin_change FROM users u WHERE u.org_id=$1
    AND ($2::boolean OR EXISTS(SELECT 1 FROM user_units uu WHERE uu.user_id=u.id AND uu.unit_id=ANY($3::uuid[]))) ORDER BY u.name`,[actor.org_id,orgWide(actor),actor.unit_ids])).rows.map(row => ({ ...row, revision: staffRecordRevision(actor.org_id, { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active, unit_ids: row.unit_ids, job_ids: row.job_ids }) }));
}
export async function validateStaff(tx: Queryable, actor: Actor, input: z.infer<typeof staffInput>, staffDomain: string,
  existing?: { role: string; email: string; retainedJobIds?: string[] }) {
  requireCondition(manages(actor),403,'Staff management access required.');
  // Only the already-locked existing highest-role identity may retain that role.
  // New developer/owner provisioning never enters ordinary staff/import creation.
  requireCondition(!['developer','owner'].includes(input.role) ||
    actor.role==='developer' && existing?.role===input.role,403,'Developer and owner provisioning requires a separate reviewed procedure.');
  if (actor.role==='manager') requireCondition(input.role==='employee',403,'Managers can provision employee accounts only.');
  if (actor.role==='admin') requireCondition(input.role!=='admin',403,'Only the owner can grant administrator access.');
  requireCondition(input.email.split('@')[1]===staffDomain || actor.role==='developer' && existing !== undefined &&
    ['developer','owner'].includes(existing.role) && input.email===existing.email,400,`Staff accounts must use @${staffDomain}.`);
  const units = (await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[])',[actor.org_id,input.unitIds])).rows;
  requireCondition(units.length===new Set(input.unitIds).size,400,'Unknown organizational unit.');
  input.unitIds.forEach(id=>assertUnit(actor,id));
  const jobs = (await tx.query('SELECT id,unit_id FROM jobs WHERE org_id=$1 AND (active=true OR id=ANY($3::uuid[])) AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[actor.org_id,input.jobIds,existing?.retainedJobIds??[]])).rows;
  requireCondition(jobs.length===new Set(input.jobIds).size && jobs.every(j=>input.unitIds.includes(j.unit_id)),400,'Jobs must belong to the assigned units.');
}
export async function createStaff(tx: Queryable, actor: Actor, input: z.infer<typeof staffInput>, staffDomain: string) {
  await validateStaff(tx,actor,input,staffDomain);
  const id=randomUUID();
  await tx.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[id,actor.org_id,input.email,input.name,input.role]);
  for (const unitId of new Set(input.unitIds)) await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[actor.org_id,id,unitId]);
  for (const jobId of new Set(input.jobIds)) await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[actor.org_id,id,jobId]);
  await audit(tx,actor,'staff.created',id,{name:input.name,email:input.email,role:input.role,unitIds:input.unitIds,jobIds:input.jobIds});
  return id;
}
export async function assertManagePerson(tx: Queryable, actor: Actor, id: string) {
  requireCondition(manages(actor),403,'Staff management access required.');
  const target=(await tx.query('SELECT id,role FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.org_id])).rows[0];
  requireCondition(target,404,'Staff member not found.');
  requireCondition(id!==actor.id && (!['developer','owner'].includes(target.role) || actor.role==='developer'),403,'This account cannot be changed here.');
  if (actor.role==='manager') {
    const units=(await tx.query('SELECT unit_id FROM user_units WHERE user_id=$1',[id])).rows;
    requireCondition(target.role==='employee' && units.length && units.every(x=>actor.unit_ids.includes(x.unit_id)),403,'This account is outside your management scope.');
  }
  if (actor.role==='admin') requireCondition(target.role!=='admin',403,'Only the owner can manage administrators.');
  return target;
}
export async function listRequests(db: Queryable, actor: Actor) {
  const reviewer=manages(actor);
  return (await db.query(`SELECT r.*,u.name AS employee_name,n.name AS unit_name FROM requests r JOIN users u ON u.id=r.user_id JOIN units n ON n.id=r.unit_id
    WHERE r.org_id=$1 AND (r.user_id=$2 OR ($3::boolean AND ($4::boolean OR r.unit_id=ANY($5::uuid[])))) ORDER BY r.created_at DESC LIMIT 300`,[actor.org_id,actor.id,reviewer,orgWide(actor),actor.unit_ids])).rows;
}
async function currentRequestActor(tx: Queryable, actor: Actor): Promise<Actor> {
  requireCondition(actor.mode==='password',403,'Sign in with your password to submit or review requests.');
  // Account before request locks: staff role/assignment writers lock this account.
  // SHARE permits audit foreign-key checks but excludes revocation until commit.
  const current=(await tx.query('SELECT role,active FROM users WHERE id=$1 AND org_id=$2 FOR SHARE',[actor.id,actor.org_id])).rows[0];
  requireCondition(current?.active,403,'This account is inactive or unavailable.');
  const units=(await tx.query('SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 ORDER BY unit_id FOR SHARE',[actor.id,actor.org_id])).rows.map(row=>row.unit_id);
  return {...actor,role:current.role,unit_ids:units};
}
export async function createRequest(db: Database, actor: Actor, input: z.infer<typeof requestInput>) {
  return db.transaction(async tx=>{
    actor=await currentRequestActor(tx,actor);
    requireCondition(actor.unit_ids.includes(input.unitId),403,'Select one of your assigned units.');
    const id=randomUUID();
    await tx.query('INSERT INTO requests(id,org_id,user_id,unit_id,kind,starts_on,ends_on,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,actor.org_id,actor.id,input.unitId,input.kind,input.startsOn,input.endsOn,input.note]);
    await audit(tx,actor,'request.created',id,{ kind:input.kind, startsOn:input.startsOn, endsOn:input.endsOn }); return { id };
  });
}
async function recordRequestReview(tx: Queryable, actor: Actor, id: string, status: string, note: string, expectedVersion?: number) {
    requireCondition(manages(actor),403,'Request review access required.');
    const row=(await tx.query('SELECT * FROM requests WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.org_id])).rows[0];
    requireCondition(row,404,'Request not found.'); assertUnit(actor,row.unit_id);
    requireCondition(row.user_id!==actor.id,403,'A different manager must review your request.');
    requireCondition(row.status==='pending',409,'This request has already been reviewed.');
    requireCondition(expectedVersion===undefined?row.version===1:row.version===expectedVersion,409,'This request changed. Reload it before reviewing the current details.');
    await tx.query('UPDATE requests SET status=$1,review_note=$2,reviewer_id=$3,reviewed_at=now(),version=version+1 WHERE id=$4',[status,note,actor.id,id]);
    await audit(tx,actor,`request.${status}`,id,{ note }); return { id,status };
}
/** Public review boundary: verify the actual password session before locking the request and again before commit. */
export async function reviewAuthenticatedRequest(db: Database, supplied: Actor, sessionHash: string | undefined, id: string, status: string, note: string, expectedVersion?: number) {
  requireCondition(typeof sessionHash==='string' && /^[a-f0-9]{64}$/.test(sessionHash),401,'A current password session is required to review requests.');
  return db.transaction(async tx=>{
    const actor=await currentReportActor(tx,supplied,sessionHash);
    const result=await recordRequestReview(tx,actor,id,status,note,expectedVersion);
    await recheckReportSession(tx,actor,sessionHash);
    return result;
  });
}
/** Trusted local-fixture compatibility only. HTTP routes must use reviewAuthenticatedRequest. */
export async function reviewRequest(db: Database, actor: Actor, id: string, status: string, note: string, expectedVersion?: number) {
  return db.transaction(async tx=>recordRequestReview(tx,await currentRequestActor(tx,actor),id,status,note,expectedVersion));
}
export { createSchedule } from './staff-scheduling';
