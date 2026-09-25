import {randomUUID} from 'node:crypto';
import type {Express,Request} from 'express';
import {z} from 'zod';
import type {AppRequest} from './auth';
import type {Database,Queryable,Row} from './db';
import {audit,digest,requireCondition,type Actor} from './security';
import {clockState,clockTransition,assertManagePerson} from './workforce';
import {currentClockActor,recheckClockSession} from './clock-session-access';
import {currentTimeActor,noTimeOverlap,preciseTimeSql,timeMicroseconds,timeNow,timeTransaction} from './time-record-access';
import {recheckReportSession} from './report-source-access';
import {clockPolicyInput,cancelPreclockInput,type ClockPolicy,type PreclockIntent,type PreclockState} from '../shared/scheduled-clock';
import type {clockInput} from '../shared/contracts';

const instantColumns=`${preciseTimeSql('starts_at')} AS starts_at,${preciseTimeSql('ends_at')} AS ends_at,${preciseTimeSql('created_at')} AS created_at,${preciseTimeSql('processed_at')} AS processed_at`;
const intentSelect=`SELECT *,${instantColumns} FROM clock_intents`;
function intentView(row:Row):PreclockIntent{return {id:row.id,version:row.version,status:row.status,jobId:row.job_id,jobTitle:row.job_title,unitName:row.unit_name,scheduleId:row.schedule_id,scheduleVersion:row.schedule_version,startsAt:row.starts_at,endsAt:row.ends_at,createdAt:row.created_at,processedAt:row.processed_at,reason:row.reason,shiftId:row.shift_id};}
async function policy(tx:Queryable,orgId:string,userId:string):Promise<ClockPolicy>{
  const row=(await tx.query('SELECT no_early_clock_in,version FROM clock_employee_policies WHERE org_id=$1 AND user_id=$2',[orgId,userId])).rows[0];
  return row?{noEarlyClockIn:row.no_early_clock_in,version:row.version}:{noEarlyClockIn:false,version:0};
}
async function matchingSchedules(tx:Queryable,actor:Actor,now:string){
  const rows=(await tx.query(`SELECT s.*,j.title AS job_title,j.unit_id,u.name AS unit_name,${preciseTimeSql('s.starts_at')} AS starts_at,${preciseTimeSql('s.ends_at')} AS ends_at,
    s.starts_at<=$3::timestamptz AS current FROM schedules s JOIN jobs j ON j.org_id=s.org_id AND j.id=s.job_id
    JOIN units u ON u.org_id=j.org_id AND u.id=j.unit_id JOIN organizations o ON o.id=s.org_id
    WHERE s.org_id=$1 AND s.user_id=$2 AND s.status='scheduled' AND s.ends_at>$3::timestamptz AND j.active
      AND (s.starts_at<=$3::timestamptz OR (s.starts_at AT TIME ZONE o.timezone)::date=($3::timestamptz AT TIME ZONE o.timezone)::date)
      AND j.unit_id=ANY($4::uuid[]) AND EXISTS(SELECT 1 FROM user_jobs uj WHERE uj.org_id=s.org_id AND uj.user_id=s.user_id AND uj.job_id=s.job_id)
    ORDER BY s.starts_at,s.id LIMIT 101`,[actor.org_id,actor.id,now,actor.unit_ids])).rows;
  requireCondition(rows.length<=100,409,'Too many matching shifts. Ask a manager to review your schedule.');return rows;
}
export async function readPreclockState(tx:Queryable,actor:Actor):Promise<PreclockState>{
  const settings=await policy(tx,actor.org_id,actor.id),now=await timeNow(tx);
  const pending=(await tx.query(intentSelect+" WHERE org_id=$1 AND user_id=$2 AND status='pending'",[actor.org_id,actor.id])).rows[0];
  const latest=(await tx.query(intentSelect+" WHERE org_id=$1 AND user_id=$2 AND status<>'pending' ORDER BY clock_intents.created_at DESC,id DESC LIMIT 1",[actor.org_id,actor.id])).rows[0];
  const schedules=settings.noEarlyClockIn?await matchingSchedules(tx,actor,now):[];
  const timezone=(await tx.query('SELECT timezone FROM organizations WHERE id=$1',[actor.org_id])).rows[0].timezone;
  return {policy:settings,pending:pending?intentView(pending):null,latest:latest?intentView(latest):null,timezone,schedules:schedules.map(row=>({scheduleId:row.id,scheduleVersion:row.version,jobId:row.job_id,startsAt:row.starts_at,endsAt:row.ends_at,phase:row.current?'current':'upcoming'}))};
}
export async function clockStateWithPreclock(tx:Queryable,actor:Actor){return {...await clockState(tx,actor),preclock:await readPreclockState(tx,actor)};}
async function event(tx:Queryable,actor:Actor,row:Row,action:'queued'|'executed'|'cancelled'|'blocked',detail:Record<string,unknown>={}){
  await tx.query('INSERT INTO clock_intent_events(id,org_id,intent_id,actor_id,action,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.org_id,row.id,actor.id,action,JSON.stringify(intentView(row))]);
  await audit(tx,actor,'clock.preclock_'+action,row.id,{...detail,scheduleId:row.schedule_id,scheduleVersion:row.schedule_version,targetStart:row.starts_at,processedAt:row.processed_at,reason:row.reason,shiftId:row.shift_id});
}
async function finish(tx:Queryable,actor:Actor,row:Row,status:'executed'|'cancelled'|'blocked',reason:string,now:string,shiftId:string|null=null){
  const saved=(await tx.query(`UPDATE clock_intents SET status=$3,reason=$4,processed_at=$5,checked_at=$5,shift_id=$6,version=2 WHERE org_id=$1 AND id=$2 AND status='pending' RETURNING *,${instantColumns}`,[actor.org_id,row.id,status,reason,now,shiftId])).rows[0];
  requireCondition(saved,409,'This pending start changed. Refresh your clock.');await event(tx,actor,saved,status,{processor:status==='cancelled'?'authenticated_request':'scheduled_worker'});return saved;
}
/** Account already locked. Returns null for ordinary immediate entry; never accepts a client-supplied scheduled timestamp. */
export async function interceptScheduledClockIn(tx:Queryable,actor:Actor,input:z.infer<typeof clockInput>){
  if(input.action!=='clock_in')return null;
  const fingerprint=digest(JSON.stringify({action:input.action,jobId:input.jobId??null}));
  const receipt=(await tx.query('SELECT fingerprint,result FROM clock_commands WHERE user_id=$1 AND command_id=$2',[actor.id,input.commandId])).rows[0];
  if(receipt){requireCondition(receipt.fingerprint===fingerprint,409,'This command identifier was already used for another action.');return receipt.result;}
  const settings=await policy(tx,actor.org_id,actor.id);if(!settings.noEarlyClockIn)return null;
  const now=await timeNow(tx),state=await clockState(tx,actor);requireCondition(!state.shift,409,'You are already clocked in.');
  requireCondition(input.jobId&&state.jobs.some(job=>job.id===input.jobId),403,'Choose one of your assigned jobs.');
  let chosen=(await matchingSchedules(tx,actor,now)).find(row=>row.job_id===input.jobId);
  requireCondition(chosen,409,'No matching shift is scheduled for this job today. Ask a manager to update your schedule or your No early clock-in setting.');
  await tx.query('SELECT id FROM schedules WHERE org_id=$1 AND id=$2 FOR SHARE',[actor.org_id,chosen.id]);
  await tx.query('SELECT id FROM jobs WHERE org_id=$1 AND id=$2 FOR SHARE',[actor.org_id,input.jobId]);
  chosen=(await matchingSchedules(tx,actor,now)).find(row=>row.id===chosen!.id&&row.job_id===input.jobId);
  requireCondition(chosen,409,'Your job or scheduled shift changed. Refresh your clock before trying again.');
  const pending=(await tx.query(intentSelect+" WHERE org_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",[actor.org_id,actor.id])).rows[0];
  if(chosen.current){if(pending)await finish(tx,actor,pending,'cancelled','You clocked in directly for a current scheduled shift.',now);return null;}
  if(pending)requireCondition(pending.schedule_id===chosen.id&&pending.schedule_version===chosen.version,409,'Cancel your pending start before selecting another scheduled shift.');
  if(!pending){
    const authority=(await tx.query('SELECT clock_authority_version FROM users WHERE org_id=$1 AND id=$2',[actor.org_id,actor.id])).rows[0].clock_authority_version;
    const created=(await tx.query(`INSERT INTO clock_intents(id,org_id,user_id,schedule_id,schedule_version,job_id,unit_id,job_title,unit_name,starts_at,ends_at,policy_version,authority_version,authentication,execution_command_id,created_at,checked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *,${instantColumns}`,[randomUUID(),actor.org_id,actor.id,chosen.id,chosen.version,chosen.job_id,chosen.unit_id,chosen.job_title,chosen.unit_name,chosen.starts_at,chosen.ends_at,settings.version,authority,actor.mode,randomUUID(),now])).rows[0];
    await event(tx,actor,created,'queued',{authentication:actor.mode});
  }
  const result=await clockStateWithPreclock(tx,actor);await tx.query('INSERT INTO clock_commands(org_id,user_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[actor.org_id,actor.id,input.commandId,fingerprint,JSON.stringify(result)]);return result;
}
export async function cancelPreclock(db:Database,supplied:Actor,sessionHash:string,id:string,raw:unknown){
  const input=cancelPreclockInput.parse(raw);z.uuid().parse(id);
  return timeTransaction(db,async tx=>{
    const actor=await currentClockActor(tx,supplied,sessionHash,true),fingerprint=digest(JSON.stringify({id,...input}));
    const previous=(await tx.query('SELECT fingerprint,result FROM clock_intent_commands WHERE org_id=$1 AND user_id=$2 AND command_id=$3',[actor.org_id,actor.id,input.commandId])).rows[0];
    if(previous){requireCondition(previous.fingerprint===fingerprint,409,'This command identifier was already used.');await recheckClockSession(tx,actor,sessionHash);return previous.result;}
    const row=(await tx.query(intentSelect+' WHERE org_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE',[actor.org_id,actor.id,id])).rows[0];
    requireCondition(row,404,'Pending start not found.');requireCondition(row.version===input.version&&row.status==='pending',409,'This start already changed. Refresh your clock; an active shift must be clocked out.');
    await finish(tx,actor,row,'cancelled','You cancelled this pending start.',await timeNow(tx));
    const result=await clockStateWithPreclock(tx,actor);await tx.query('INSERT INTO clock_intent_commands(org_id,user_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[actor.org_id,actor.id,input.commandId,fingerprint,JSON.stringify(result)]);
    await recheckClockSession(tx,actor,sessionHash);return result;
  });
}
export async function getEmployeeClockPolicy(db:Database,supplied:Actor,sessionHash:string,userId:string){
  z.uuid().parse(userId);return timeTransaction(db,async tx=>{const actor=await currentTimeActor(tx,supplied,sessionHash,userId,true);await assertManagePerson(tx,actor,userId);const result=await policy(tx,actor.org_id,userId);await recheckReportSession(tx,actor,sessionHash);return result;});
}
export async function saveEmployeeClockPolicy(db:Database,supplied:Actor,sessionHash:string,userId:string,raw:unknown){
  const input=clockPolicyInput.parse(raw);z.uuid().parse(userId);
  return timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash,userId,true);await assertManagePerson(tx,actor,userId);
    const before=await policy(tx,actor.org_id,userId);requireCondition(before.version===input.expectedVersion,409,'This clock setting changed. Reload it before saving.');
    if(before.version&&before.noEarlyClockIn===input.noEarlyClockIn){await recheckReportSession(tx,actor,sessionHash);return before;}
    const row=(await tx.query(`INSERT INTO clock_employee_policies(org_id,user_id,no_early_clock_in,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET no_early_clock_in=excluded.no_early_clock_in,version=clock_employee_policies.version+1,updated_by=excluded.updated_by,updated_at=clock_timestamp() RETURNING version`,[actor.org_id,userId,input.noEarlyClockIn,actor.id])).rows[0];
    const after={noEarlyClockIn:input.noEarlyClockIn,version:row.version};
    const pending=(await tx.query(intentSelect+" WHERE org_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",[actor.org_id,userId])).rows[0];
    if(pending)await finish(tx,actor,pending,'cancelled','A manager changed your clock setting. Review the new setting before clocking in.',await timeNow(tx));
    await audit(tx,actor,'staff.clock_policy_changed',userId,{before,after});await recheckReportSession(tx,actor,sessionHash);return after;
  });
}
/** Independent durable executor. Browser/session expiry is not revocation of a submitted intent; account/credential/policy/assignment changes are. */
export async function processPreclockIntent(db:Database,id:string){
  z.uuid().parse(id);return timeTransaction(db,async tx=>{
    const identity=(await tx.query('SELECT org_id,user_id FROM clock_intents WHERE id=$1',[id])).rows[0];if(!identity)return 'missing';
    const user=(await tx.query('SELECT id,org_id,name,email,role,active,requires_credential_change,clock_authority_version FROM users WHERE org_id=$1 AND id=$2 FOR UPDATE',[identity.org_id,identity.user_id])).rows[0];
    const initial=(await tx.query(intentSelect+' WHERE org_id=$1 AND id=$2',[identity.org_id,id])).rows[0];if(initial.status!=='pending')return initial.status;
    const schedule=(await tx.query(`SELECT *,${preciseTimeSql('starts_at')} AS starts_at,${preciseTimeSql('ends_at')} AS ends_at FROM schedules WHERE org_id=$1 AND id=$2 FOR SHARE`,[identity.org_id,initial.schedule_id])).rows[0];
    const job=(await tx.query('SELECT id,unit_id,active FROM jobs WHERE org_id=$1 AND id=$2 FOR SHARE',[identity.org_id,initial.job_id])).rows[0];
    const row=(await tx.query(intentSelect+' WHERE org_id=$1 AND id=$2 FOR UPDATE',[identity.org_id,id])).rows[0];if(row.status!=='pending')return row.status;
    const now=await timeNow(tx),settings=await policy(tx,user.org_id,user.id);
    const actor:Actor={id:user.id,org_id:user.org_id,name:user.name,email:user.email,role:user.role,mode:row.authentication,unit_ids:(await tx.query('SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2',[user.org_id,user.id])).rows.map(r=>r.unit_id)};
    let reason='';
    if(!user.active||user.requires_credential_change||String(user.clock_authority_version)!==String(row.authority_version))reason='Your account or sign-in credentials changed before this start. Sign in again and review your clock.';
    else if(!settings.noEarlyClockIn||settings.version!==row.policy_version)reason='Your No early clock-in setting changed. Review your clock before starting.';
    else if(!schedule||schedule.user_id!==user.id||schedule.status!=='scheduled'||schedule.version!==row.schedule_version||schedule.job_id!==row.job_id||schedule.starts_at!==row.starts_at||schedule.ends_at!==row.ends_at)reason='Your scheduled shift changed or was cancelled. Review the updated schedule and clock in again.';
    else if(!job?.active||job.unit_id!==row.unit_id||!actor.unit_ids.includes(row.unit_id)||!(await tx.query('SELECT job_id FROM user_jobs WHERE org_id=$1 AND user_id=$2 AND job_id=$3',[actor.org_id,actor.id,row.job_id])).rows.length)reason='This job or community is no longer assigned and available to you. Ask a manager to review it.';
    else if(timeMicroseconds(now)>=timeMicroseconds(row.ends_at))reason='The scheduled shift ended before this start could be processed. No shift was created; ask a manager to review your time record.';
    else if((await clockState(tx,actor)).shift)reason='You already have an open time record. This pending start was not applied.';
    else if(timeMicroseconds(now)>=timeMicroseconds(row.starts_at)&&!await noTimeOverlap(tx,actor.org_id,actor.id,row.starts_at,null))reason='Another recorded shift overlaps this scheduled start. No new shift was created; ask a manager to review your time record.';
    if(reason){await finish(tx,actor,row,'blocked',reason,now);return 'blocked';}
    if(timeMicroseconds(now)<timeMicroseconds(row.starts_at)){await tx.query('UPDATE clock_intents SET checked_at=$3 WHERE org_id=$1 AND id=$2',[actor.org_id,id,now]);return 'pending';}
    // All checks and the actual shift, segment, command receipt and two audits commit together.
    const result=await clockTransition(tx,actor,{action:'clock_in',jobId:row.job_id,commandId:row.execution_command_id},row.starts_at,{intentId:row.id,scheduleId:row.schedule_id,scheduleVersion:row.schedule_version,requestedAt:row.created_at,processedAt:now});
    await finish(tx,actor,row,'executed','Started automatically from your confirmed pending start. Clock out when your work ends.',now,result.shift.id);return 'executed';
  });
}
export async function processScheduledClockIntents(db:Database,limit=50,onError?:(error:unknown)=>void){
  requireCondition(Number.isInteger(limit)&&limit>0&&limit<=200,400,'Use a bounded pending-start batch.');
  const candidates=(await db.query(`SELECT id FROM clock_intents WHERE status='pending' AND (starts_at<=clock_timestamp() OR checked_at<clock_timestamp()-interval '15 seconds')
    ORDER BY CASE WHEN starts_at<=clock_timestamp() THEN 0 ELSE 1 END,starts_at,checked_at,id LIMIT $1`,[limit])).rows;
  const counts={checked:0,executed:0,blocked:0,failed:0};
  for(const row of candidates){try{const status=await processPreclockIntent(db,row.id);counts.checked++;if(status==='executed')counts.executed++;if(status==='blocked')counts.blocked++;}catch(error){counts.failed++;onError?.(error);}}return counts;
}
export function startScheduledClockWorker(db:Database,onError:(error:unknown)=>void=()=>console.warn('Pending clock starts could not be processed; retrying.')){
  let stopping=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve();
  const tick=()=>{running=(async()=>{try{await processScheduledClockIntents(db,50,onError);}catch(error){onError(error);}finally{if(!stopping){timer=setTimeout(tick,1000);timer.unref();}}})();};tick();
  return async()=>{stopping=true;if(timer)clearTimeout(timer);await running;};
}
export function installScheduledClockRoutes(app:Express,db:Database){
  const reqState=(req:Request)=>{const current=req as unknown as AppRequest;requireCondition(current.actor,401,'Sign in to continue.');return {actor:current.actor,hash:current.sessionHash!};};
  app.post('/api/clock/preclock/:id/cancel',async(req,res)=>{const {actor,hash}=reqState(req);res.set('Cache-Control','private, no-store').json(await cancelPreclock(db,actor,hash,z.uuid().parse(req.params.id),req.body));});
  app.get('/api/staff/:id/clock-policy',async(req,res)=>{const {actor,hash}=reqState(req);res.set('Cache-Control','private, no-store').json(await getEmployeeClockPolicy(db,actor,hash,z.uuid().parse(req.params.id)));});
  app.put('/api/staff/:id/clock-policy',async(req,res)=>{const {actor,hash}=reqState(req);res.set('Cache-Control','private, no-store').json(await saveEmployeeClockPolicy(db,actor,hash,z.uuid().parse(req.params.id),req.body));});
}
