import {z} from 'zod';
import type {Database,Queryable} from './db';
import {audit,digest,manages,orgWide,requireCondition,type Actor} from './security';
import {currentTimeActor,timeTransaction} from './time-record-access';
import {recheckReportSession} from './report-source-access';
import {staffAssignmentsInput,staffAssignmentsSnapshot,type StaffAssignments} from '../shared/staff-assignments';

type Assigned={unitIds:string[];jobIds:string[]};
const sorted=(ids:string[])=>[...ids].sort();
const revision=(orgId:string,userId:string,assigned:Assigned)=>digest(JSON.stringify({orgId,userId,unitIds:sorted(assigned.unitIds),jobIds:sorted(assigned.jobIds)}));
function identity(supplied:Actor,sessionHash:string|undefined,targetId:string){
  requireCondition(typeof sessionHash==='string'&&/^[a-f0-9]{64}$/.test(sessionHash),401,'Your session has expired or changed. Sign in again.');
  return {actor:{...supplied,id:supplied.id.toLowerCase(),org_id:supplied.org_id.toLowerCase()},proof:sessionHash,id:z.uuid().parse(targetId).toLowerCase()};
}
async function assigned(tx:Queryable,orgId:string,userId:string):Promise<Assigned>{
  return {unitIds:(await tx.query('SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id',[orgId,userId])).rows.map(row=>row.unit_id),
    jobIds:(await tx.query('SELECT job_id FROM user_jobs WHERE org_id=$1 AND user_id=$2 ORDER BY job_id',[orgId,userId])).rows.map(row=>row.job_id)};
}
async function authorized(tx:Queryable,actor:Actor,userId:string,current:Assigned){
  requireCondition(manages(actor),403,'Employee assignment management access required.');
  const target=(await tx.query('SELECT id,name,role FROM users WHERE org_id=$1 AND id=$2',[actor.org_id,userId])).rows[0];
  requireCondition(target,404,'Employee not found.');
  if(actor.role==='owner')requireCondition(target.id===actor.id||!['developer','owner'].includes(target.role),403,'These assignments require developer access.');
  if(actor.role==='admin')requireCondition(!['developer','owner'].includes(target.role),403,'Administrators cannot change owner or developer assignments.');
  if(actor.role==='manager'){
    const jobs=(await tx.query('SELECT j.unit_id FROM user_jobs uj JOIN jobs j ON j.org_id=uj.org_id AND j.id=uj.job_id WHERE uj.org_id=$1 AND uj.user_id=$2',[actor.org_id,userId])).rows;
    requireCondition(target.id!==actor.id&&target.role==='employee'&&current.unitIds.length>0&&current.unitIds.every(id=>actor.unit_ids.includes(id))&&jobs.every(job=>actor.unit_ids.includes(job.unit_id)),403,'This employee is outside your assignment-management scope.');
  }
  return target;
}
async function inUse(tx:Queryable,orgId:string,userId:string){
  const rows=(await tx.query(`SELECT g.job_id,j.unit_id FROM shifts s JOIN segments g ON g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision AND g.ended_at IS NULL
    JOIN jobs j ON j.org_id=g.org_id AND j.id=g.job_id WHERE s.org_id=$1 AND s.user_id=$2 AND s.ended_at IS NULL ORDER BY g.job_id`,[orgId,userId])).rows;
  return {lockedJobIds:[...new Set<string>(rows.map(row=>row.job_id))].sort(),lockedUnitIds:[...new Set<string>(rows.map(row=>row.unit_id))].sort()};
}
async function snapshot(tx:Queryable,actor:Actor,userId:string,name:string,current:Assigned,changed:boolean):Promise<StaffAssignments>{
  const units=(await tx.query('SELECT id,name FROM units WHERE org_id=$1 AND ($2::boolean OR id=ANY($3::uuid[])) ORDER BY name,id LIMIT 1001',[actor.org_id,orgWide(actor),actor.unit_ids])).rows;
  const jobs=(await tx.query(`SELECT id,title,unit_id,active FROM jobs WHERE org_id=$1 AND ($2::boolean OR unit_id=ANY($3::uuid[]))
    AND (active OR id=ANY($4::uuid[])) ORDER BY title,id LIMIT 5001`,[actor.org_id,orgWide(actor),actor.unit_ids,current.jobIds])).rows;
  requireCondition(units.length<=1000&&jobs.length<=5000,409,'This assignment catalog is too large to load safely. Contact your administrator.');
  return staffAssignmentsSnapshot.parse({userId,employeeName:name,...current,revision:revision(actor.org_id,userId,current),...await inUse(tx,actor.org_id,userId),units,
    jobs:jobs.map(row=>({id:row.id,title:row.title,unitId:row.unit_id,active:row.active})),changed});
}
async function publish<T>(tx:Queryable,actor:Actor,proof:string,value:T){await recheckReportSession(tx,actor,proof);return value;}

export async function getStaffAssignments(db:Database,supplied:Actor,sessionHash:string|undefined,targetId:string){
  const {actor:identityActor,proof,id}=identity(supplied,sessionHash,targetId);
  return timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,identityActor,proof,id),current=await assigned(tx,actor.org_id,id),target=await authorized(tx,actor,id,current);
    return publish(tx,actor,proof,await snapshot(tx,actor,id,target.name,current,false));
  });
}
export async function saveStaffAssignments(db:Database,supplied:Actor,sessionHash:string|undefined,targetId:string,raw:unknown){
  const {actor:identityActor,proof,id}=identity(supplied,sessionHash,targetId),input=staffAssignmentsInput.parse(raw);
  return timeTransaction(db,async tx=>{
    // Shared with clocking, scheduling and account writers: sorted accounts first,
    // then sorted job identities, then community identities. No credential writes.
    const actor=await currentTimeActor(tx,identityActor,proof,id,true),before=await assigned(tx,actor.org_id,id),target=await authorized(tx,actor,id,before);
    requireCondition(orgWide(actor)||input.unitIds.every(unitId=>actor.unit_ids.includes(unitId)),403,'Choose only communities explicitly assigned to your management account.');
    const lockedJobs=sorted([...new Set([...before.jobIds,...input.jobIds])]);
    const jobs=(await tx.query('SELECT id,title,unit_id,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[actor.org_id,lockedJobs])).rows;
    const selected=jobs.filter(job=>input.jobIds.includes(job.id));
    requireCondition(selected.length===input.jobIds.length&&selected.every(job=>job.active||before.jobIds.includes(job.id)),400,'New assignments must use available active jobs. Archived jobs can only be retained.');
    requireCondition(selected.every(job=>input.unitIds.includes(job.unit_id)),400,'Select the community for every assigned job.');
    const units=(await tx.query('SELECT id,name FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[actor.org_id,sorted([...new Set([...before.unitIds,...input.unitIds,...jobs.map(job=>job.unit_id)])])])).rows;
    requireCondition(input.unitIds.every(unitId=>units.some(unit=>unit.id===unitId)),400,'Choose communities in this organization.');
    const locked=await inUse(tx,actor.org_id,id);
    requireCondition(locked.lockedJobIds.every(jobId=>input.jobIds.includes(jobId))&&locked.lockedUnitIds.every(unitId=>input.unitIds.includes(unitId)),409,'Keep the job and community currently in use. The employee can switch jobs or clock out before they are removed.');
    const after={unitIds:sorted(input.unitIds),jobIds:sorted(input.jobIds)},beforeRevision=revision(actor.org_id,id,before),afterRevision=revision(actor.org_id,id,after);
    // PUT retries can return the current identical state without repeating writes
    // or audit entries. A different requested state still needs the exact revision.
    if(beforeRevision===afterRevision)return publish(tx,actor,proof,await snapshot(tx,actor,id,target.name,before,false));
    requireCondition(input.expectedRevision===beforeRevision,409,'These assignments changed while you were editing. Reload the saved assignments and review your choices.');
    await tx.query('DELETE FROM user_jobs WHERE org_id=$1 AND user_id=$2 AND NOT(job_id=ANY($3::uuid[]))',[actor.org_id,id,after.jobIds]);
    await tx.query('DELETE FROM user_units WHERE org_id=$1 AND user_id=$2 AND NOT(unit_id=ANY($3::uuid[]))',[actor.org_id,id,after.unitIds]);
    for(const unitId of after.unitIds.filter(unitId=>!before.unitIds.includes(unitId)))await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[actor.org_id,id,unitId]);
    for(const jobId of after.jobIds.filter(jobId=>!before.jobIds.includes(jobId)))await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[actor.org_id,id,jobId]);
    const labels=(value:Assigned)=>({units:units.filter(unit=>value.unitIds.includes(unit.id)).map(unit=>({id:unit.id,name:unit.name})),jobs:jobs.filter(job=>value.jobIds.includes(job.id)).map(job=>({id:job.id,title:job.title,unitId:job.unit_id}))});
    await audit(tx,actor,'staff.assignments_changed',id,{employeeName:target.name,before:{...before,revision:beforeRevision,...labels(before)},after:{...after,revision:afterRevision,...labels(after)}});
    return publish(tx,actor,proof,await snapshot(tx,actor,id,target.name,after,true));
  });
}
