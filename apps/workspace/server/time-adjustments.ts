import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Express, Request } from 'express';
import type { AppRequest } from './auth';
import type { Database, Queryable, Row } from './db';
import { audit,digest,manages,canReport,orgWide,requireCondition,Problem,type Actor } from './security';
import { recheckReportSession } from './report-source-access';
import { reportBounds } from './reports';
import { allowsTimeScope,canonicalTimeJson,currentTimeActor,noTimeOverlap,preciseTimeSql,timeJobs,timeMicroseconds,timeNow,timeTransaction } from './time-record-access';
import { adjustmentDefinitionHash,adjustmentHistoryBytes,retainedAdjustmentHistory,timeResultHash,timeSourceHash,validateTimeEnvelope } from './time-adjustment-export';
import { proposeTimeAdjustmentInput,reviewTimeAdjustmentInput,cancelTimeAdjustmentInput,timeAdjustmentListInput,timeAdjustmentExportInput,timeAdjustmentSourceInput,timeAdjustmentOptionsInput,openTimeShiftsInput,
  timeSnapshotSchema,timeAdjustmentReceiptSchema,timeAdjustmentDetailSchema,timeAdjustmentSourceSchema,timeAdjustmentOptionsSchema,timeAdjustmentHistorySchema,timeAdjustmentListSchema,openTimeShiftsSchema,timeAdjustmentLimits,
  type TimeSnapshot,type TimeAdjustmentEnvelope,type TimeAdjustmentRequest,type TimeAdjustmentReceipt,type TimeAdjustmentDetail } from '../shared/time-adjustments';

const unique=(values:string[])=>[...new Set(values)].sort();
const identity=(actor:Actor)=>({id:actor.id,name:actor.name});
const mayApplyDirect=(actor:Actor,employeeId:string)=>actor.id!==employeeId&&['admin','owner','developer'].includes(actor.role);
const requestProjection=`r.*,${preciseTimeSql('r.created_at')} AS created_at,${preciseTimeSql('r.resolved_at')} AS resolved_at`;
const historyProjection=`h.*,encode(convert_to(h.snapshot_text,'UTF8'),'base64') AS snapshot_base64,encode(convert_to(h.json_text,'UTF8'),'base64') AS json_base64,encode(convert_to(h.csv_text,'UTF8'),'base64') AS csv_base64`;
const unavailable=()=>new Problem(404,'Time adjustment not found under your current access.');
async function timezone(tx:Queryable,actor:Actor) {return (await tx.query('SELECT timezone FROM organizations WHERE id=$1',[actor.org_id])).rows[0].timezone as string;}
async function requestRow(tx:Queryable,actor:Actor,id:string,lock=false) {
  const row=(await tx.query(`SELECT ${requestProjection} FROM time_adjustment_requests r WHERE r.id=$1 AND r.org_id=$2${lock?' FOR UPDATE OF r':''}`,[id,actor.org_id])).rows[0];
  if(!row)throw unavailable();return row;
}
function envelopeFor(row:Row):TimeAdjustmentEnvelope {
  const request:TimeAdjustmentRequest={schemaVersion:1,id:row.id,orgId:row.org_id,kind:row.kind,employee:row.proposed_snapshot.employee,proposedBy:{id:row.proposed_by,name:row.proposer_name},createdAt:row.created_at,reason:row.reason,
    source:row.source_snapshot,sourceHash:row.source_hash,proposed:row.proposed_snapshot,scope:row.scope_snapshot,status:row.status,version:row.version,
    resolvedBy:row.resolved_by?{id:row.resolved_by,name:row.resolver_name}:null,resolutionNote:row.resolution_note,resolvedAt:row.resolved_at,resultShiftId:row.result_shift_id,resultRevision:row.result_revision};
  return validateTimeEnvelope({request,requestHash:row.request_hash,result:row.result_snapshot,resultHash:row.result_hash});
}
async function authorizeEvidence(tx:Queryable,actor:Actor,envelope:TimeAdjustmentEnvelope,management=false) {
  const {request,result}=envelope,ids=unique([...request.scope.jobIds,...(result?.segments.map(row=>row.jobId)??[])]);
  const jobs=await timeJobs(tx,actor,ids);
  requireCondition(allowsTimeScope(actor,request.employee.id,jobs,[...request.scope.unitIds,...(result?.segments.map(row=>row.unitId)??[])],management),404,'Time adjustment not found under your current access.');
  return jobs;
}
async function assignedJobs(tx:Queryable,actor:Actor,employeeId:string) {
  return (await tx.query(`SELECT j.id FROM user_jobs a JOIN jobs j ON j.org_id=a.org_id AND j.id=a.job_id
    JOIN user_units m ON m.org_id=a.org_id AND m.user_id=a.user_id AND m.unit_id=j.unit_id WHERE a.org_id=$1 AND a.user_id=$2 AND j.active ORDER BY j.id`,[actor.org_id,employeeId])).rows.map(row=>row.id);
}
function totals(snapshot:TimeSnapshot) {
  if(snapshot.shift.endedAt===null)return null;
  let work=0n,rest=0n;
  for(const segment of snapshot.segments) {requireCondition(segment.endedAt!==null,422,'A completed shift contains an open segment.');const duration=timeMicroseconds(segment.endedAt)-timeMicroseconds(segment.startedAt);requireCondition(duration>=0n,422,'Recorded segment ends before it starts.');if(segment.kind==='work')work+=duration;else rest+=duration;}
  return {workMicroseconds:work.toString(),breakMicroseconds:rest.toString(),totalMicroseconds:(work+rest).toString()};
}
function validateRanges(snapshot:TimeSnapshot,now?:string) {
  for(let i=0;i<snapshot.segments.length;i++) {
    const segment=snapshot.segments[i],start=timeMicroseconds(segment.startedAt),end=segment.endedAt===null?null:timeMicroseconds(segment.endedAt);
    requireCondition(start===(i?timeMicroseconds(snapshot.segments[i-1].endedAt!):timeMicroseconds(snapshot.shift.startedAt)) && (end===null?i===snapshot.segments.length-1:end>=start),422,'Recorded segments must be ordered and contiguous with only a final open end.');
    if(now)requireCondition(start<=timeMicroseconds(now) && (end===null || end<=timeMicroseconds(now)),400,'Use completed time ranges without future timestamps.');
  }
  const last=snapshot.segments.at(-1)!;
  requireCondition((last.endedAt===null)===(snapshot.shift.endedAt===null) && (last.endedAt===null || timeMicroseconds(last.endedAt)===timeMicroseconds(snapshot.shift.endedAt!)),422,'Recorded shift boundaries do not match its segments.');
}
async function sourceFor(tx:Queryable,actor:Actor,shiftId:string,lock=false):Promise<TimeSnapshot> {
  const shift=(await tx.query(`SELECT s.*,u.name AS employee_name,${preciseTimeSql('s.started_at')} AS precise_start,${preciseTimeSql('s.ended_at')} AS precise_end FROM shifts s JOIN users u ON u.org_id=s.org_id AND u.id=s.user_id WHERE s.org_id=$1 AND s.id=$2${lock?' FOR UPDATE OF s':''}`,[actor.org_id,shiftId])).rows[0];
  requireCondition(shift,404,'Time record not found.');
  const rows=(await tx.query(`SELECT id,job_id,kind,${preciseTimeSql('started_at')} AS started_at,${preciseTimeSql('ended_at')} AS ended_at FROM segments WHERE org_id=$1 AND shift_id=$2 AND revision=$3 ORDER BY started_at,ended_at,id LIMIT 201`,[actor.org_id,shiftId,shift.revision])).rows;
  requireCondition(rows.length>0 && rows.length<=timeAdjustmentLimits.segments,422,'This time record exceeds the supported review size or contains no segments.');
  const jobs=await timeJobs(tx,actor,rows.map(row=>row.job_id));
  requireCondition(allowsTimeScope(actor,shift.user_id,jobs),404,'Time record not found.');
  const snapshot:TimeSnapshot={schemaVersion:1,orgId:actor.org_id,employee:{id:shift.user_id,name:shift.employee_name},shift:{id:shift.id,revision:shift.revision,startedAt:shift.precise_start,endedAt:shift.precise_end},segments:rows.map(row=>{const job=jobs.find(job=>job.id===row.job_id)!;return {id:row.id,jobId:row.job_id,jobTitle:job.title,unitId:job.unit_id,unitName:job.unit_name,kind:row.kind,startedAt:row.started_at,endedAt:row.ended_at};}),totals:null};
  validateRanges(snapshot);snapshot.totals=totals(snapshot);return timeSnapshotSchema.parse(snapshot);
}
async function shiftEmployee(tx:Queryable,actor:Actor,shiftId:string) {
  const row=(await tx.query('SELECT user_id FROM shifts WHERE org_id=$1 AND id=$2',[actor.org_id,shiftId])).rows[0];requireCondition(row,404,'Time record not found.');return row.user_id as string;
}
async function historyAt(tx:Queryable,actor:Actor,id:string,version:number) {
  const row=(await tx.query(`SELECT ${historyProjection} FROM time_adjustment_history h WHERE h.org_id=$1 AND h.request_id=$2 AND h.version=$3`,[actor.org_id,id,version])).rows[0];
  requireCondition(row,422,'Retained time history is unavailable.');return retainedAdjustmentHistory(row);
}
async function saveHistory(tx:Queryable,actor:Actor,envelope:TimeAdjustmentEnvelope,reason:string,at:string) {
  const bytes=adjustmentHistoryBytes(envelope,identity(actor),reason,at);
  requireCondition(bytes.bytes<=timeAdjustmentLimits.evidenceBytes,422,'This time evidence exceeds the supported retained size.');
  await tx.query(`INSERT INTO time_adjustment_history(org_id,request_id,version,action,actor_id,actor_name,reason,created_at,snapshot_text,snapshot_hash,json_text,json_hash,csv_text,csv_hash,bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[actor.org_id,envelope.request.id,envelope.request.version,bytes.entry.action,actor.id,actor.name,reason,at,bytes.snapshotText,bytes.snapshotHash,bytes.json,bytes.jsonHash,bytes.csv,bytes.csvHash,bytes.bytes]);
  return bytes.snapshotHash;
}
async function commandLock(tx:Queryable,actor:Actor,commandId:string) {
  // This namespace is always first: no account, request, shift or job lock precedes it.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('time-adjustment-command:'||$1||':'||$2||':'||$3,0))",[actor.org_id,actor.id,commandId]);
  return (await tx.query('SELECT * FROM time_adjustment_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3',[actor.org_id,actor.id,commandId])).rows[0];
}
async function replay(tx:Queryable,actor:Actor,sessionHash:string,command:Row,fingerprint:string,action:string) {
  const history=await historyAt(tx,actor,command.request_id,command.result_version);
  await authorizeEvidence(tx,actor,history.entry.snapshot,action!=='read');
  const request=history.entry.snapshot.request;
  requireCondition(action==='direct'?mayApplyDirect(actor,request.employee.id):action==='propose'?request.employee.id===actor.id||manages(actor):action==='review'?manages(actor)&&request.employee.id!==actor.id&&request.proposedBy.id!==actor.id:request.proposedBy.id===actor.id&&(request.employee.id===actor.id||manages(actor)),403,'Current management or employee authority is required for this command.');
  requireCondition(command.action===action && command.fingerprint===fingerprint,409,'This command identifier was used for a different time adjustment.');
  requireCondition(digest(command.result_text)===command.result_hash,422,'Retained command evidence failed its integrity check.');
  const result=timeAdjustmentReceiptSchema.parse(JSON.parse(command.result_text));
  requireCondition(result.requestId===command.request_id && result.version===command.result_version && result.historyHash===history.entry.snapshotHash && result.status===request.status && result.resultShiftId===request.resultShiftId && result.resultRevision===request.resultRevision,422,'Retained command identities are inconsistent.');
  await recheckReportSession(tx,actor,sessionHash);return {result,replayed:true};
}
async function saveCommand(tx:Queryable,actor:Actor,sessionHash:string,action:string,commandId:string,fingerprint:string,envelope:TimeAdjustmentEnvelope,reason:string,at:string) {
  const historyHash=await saveHistory(tx,actor,envelope,reason,at),request=envelope.request;
  const result=timeAdjustmentReceiptSchema.parse({requestId:request.id,version:request.version,status:request.status,resultShiftId:request.resultShiftId,resultRevision:request.resultRevision,historyHash});
  const resultText=canonicalTimeJson(result);
  await tx.query('INSERT INTO time_adjustment_commands(org_id,actor_id,command_id,action,fingerprint,request_id,result_version,result_text,result_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[actor.org_id,actor.id,commandId,action,fingerprint,request.id,request.version,resultText,digest(resultText),at]);
  await audit(tx,actor,'time_adjustment.'+(request.status==='pending'?'proposed':request.status),request.id,{kind:request.kind,version:request.version,requestHash:envelope.requestHash,sourceHash:request.sourceHash,resultHash:envelope.resultHash,resultShiftId:request.resultShiftId,resultRevision:request.resultRevision,historyHash});
  await recheckReportSession(tx,actor,sessionHash);return {result,replayed:false};
}
async function missingCandidate(tx:Queryable,actor:Actor,input:Extract<z.infer<typeof proposeTimeAdjustmentInput>,{kind:'missing_shift'}>,now:string) {
  const jobs=await timeJobs(tx,actor,input.segments.map(row=>row.jobId)),assigned=await assignedJobs(tx,actor,input.employeeId);
  requireCondition(allowsTimeScope(actor,input.employeeId,jobs,[],true),403,'Management access to every proposed unit is required.');
  requireCondition(jobs.every(job=>job.active && assigned.includes(job.id)),409,'Each missing-shift job must be active and currently assigned to the employee in its explicit unit.');
  const user=(await tx.query('SELECT name FROM users WHERE org_id=$1 AND id=$2',[actor.org_id,input.employeeId])).rows[0];
  const proposed:TimeSnapshot={schemaVersion:1,orgId:actor.org_id,employee:{id:input.employeeId,name:user.name},shift:{id:null,revision:null,startedAt:input.segments[0].startedAt,endedAt:input.segments.at(-1)!.endedAt},segments:input.segments.map(segment=>{const job=jobs.find(row=>row.id===segment.jobId)!;return {...segment,id:null,jobTitle:job.title,unitId:job.unit_id,unitName:job.unit_name};}),totals:null};
  validateRanges(proposed,now);requireCondition(timeMicroseconds(proposed.shift.endedAt!)>timeMicroseconds(proposed.shift.startedAt),400,'A missing shift must contain a positive recorded duration.');proposed.totals=totals(proposed);return proposed;
}

async function createTimeAdjustment(db:Database,supplied:Actor,sessionHash:string,raw:unknown,action:'propose'|'direct') {
  const input=proposeTimeAdjustmentInput.parse(raw),fingerprint=digest(canonicalTimeJson({action,input}));
  return timeTransaction(db,async tx=>{
    const command=await commandLock(tx,supplied,input.commandId);
    const employeeId=command?(await requestRow(tx,supplied,command.request_id)).user_id:input.kind==='missing_shift'?input.employeeId:await shiftEmployee(tx,supplied,input.shiftId);
    const actor=await currentTimeActor(tx,supplied,sessionHash,employeeId,true);
    if(command)return replay(tx,actor,sessionHash,command,fingerprint,action);
    requireCondition(action==='direct'?mayApplyDirect(actor,employeeId):employeeId===actor.id || manages(actor),403,action==='direct'?'Only an administrator, owner or developer may directly adjust another employee’s time. Use a review request for your own time.':'Only the employee or a scoped manager may propose time adjustments.');
    let source:TimeSnapshot|null=null,proposed:TimeSnapshot;
    if(input.kind==='close_open_shift') {
      source=await sourceFor(tx,actor,input.shiftId,true);
      requireCondition(source.shift.endedAt===null,409,'This shift is no longer open.');
      requireCondition(timeSourceHash(source)===input.sourceHash,409,'The recorded source changed. Reload it before proposing a closure.');
      requireCondition(allowsTimeScope(actor,employeeId,[],source.segments.map(row=>row.unitId),true),403,'Management access to every recorded unit is required.');
      proposed=structuredClone(source);proposed.shift.revision=source.shift.revision!+1;proposed.shift.endedAt=input.endedAt;
      proposed.segments=proposed.segments.map((row,index)=>({...row,id:null,endedAt:index===proposed.segments.length-1?input.endedAt:row.endedAt}));
      validateRanges(proposed,await timeNow(tx));proposed.totals=totals(proposed);
    } else proposed=await missingCandidate(tx,actor,input,await timeNow(tx));
    requireCondition(await noTimeOverlap(tx,actor.org_id,employeeId,proposed.shift.startedAt,proposed.shift.endedAt,source?.shift.id??null),409,'The proposed time overlaps another recorded shift.');
    const at=await timeNow(tx),request:TimeAdjustmentRequest={schemaVersion:1,id:randomUUID(),orgId:actor.org_id,kind:input.kind,employee:proposed.employee,proposedBy:identity(actor),createdAt:at,reason:input.reason,source,sourceHash:source?timeSourceHash(source):null,proposed,
      scope:{jobIds:unique(proposed.segments.map(row=>row.jobId)),unitIds:unique(proposed.segments.map(row=>row.unitId))},status:'pending',version:1,resolvedBy:null,resolutionNote:null,resolvedAt:null,resultShiftId:null,resultRevision:null};
    const envelope:TimeAdjustmentEnvelope={request,requestHash:'0'.repeat(64),result:null,resultHash:null};envelope.requestHash=adjustmentDefinitionHash(envelope);validateTimeEnvelope(envelope);
    if(action==='direct') {
      envelope.result=await applyTime(tx,actor,envelope);envelope.resultHash=timeResultHash(envelope.result);
      Object.assign(request,{status:'applied',resolvedBy:identity(actor),resolutionNote:input.reason,resolvedAt:at,resultShiftId:envelope.result.shift.id,resultRevision:envelope.result.shift.revision});
      validateTimeEnvelope(envelope);
    }
    await tx.query(`INSERT INTO time_adjustment_requests(id,org_id,user_id,kind,source_shift_id,source_revision,source_hash,source_snapshot,proposed_snapshot,scope_snapshot,request_hash,starts_at,ends_at,reason,proposed_by,proposer_name,created_at,status,resolved_by,resolver_name,resolution_note,resolved_at,result_shift_id,result_revision,result_snapshot,result_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,[request.id,actor.org_id,employeeId,input.kind,source?.shift.id??null,source?.shift.revision??null,request.sourceHash,source?JSON.stringify(source):null,JSON.stringify(proposed),JSON.stringify(request.scope),envelope.requestHash,proposed.shift.startedAt,proposed.shift.endedAt,input.reason,actor.id,actor.name,at,request.status,request.resolvedBy?.id??null,request.resolvedBy?.name??null,request.resolutionNote,request.resolvedAt,request.resultShiftId,request.resultRevision,envelope.result?JSON.stringify(envelope.result):null,envelope.resultHash]);
    return saveCommand(tx,actor,sessionHash,action,input.commandId,fingerprint,envelope,input.reason,at);
  });
}
export const proposeTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,raw:unknown)=>createTimeAdjustment(db,actor,sessionHash,raw,'propose');
export const applyDirectTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,raw:unknown)=>createTimeAdjustment(db,actor,sessionHash,raw,'direct');

async function readiness(tx:Queryable,actor:Actor,envelope:TimeAdjustmentEnvelope):Promise<TimeAdjustmentDetail['readiness']> {
  const {request}=envelope;if(request.status!=='pending')return {state:'resolved',issues:[]};
  const issues:TimeAdjustmentDetail['readiness']['issues']=[];
  if(request.source) {
    let current:TimeSnapshot;
    try { current=await sourceFor(tx,actor,request.source.shift.id!,true); }
    catch(error) {if(error instanceof Problem && error.status===422)return {state:'blocked',issues:[{code:'invalid_source',message:'The current source cannot be safely represented by this editor. The retained proposal can still be declined or cancelled.'}]};throw error;}
    if(current.shift.endedAt!==null)issues.push({code:'source_not_open',message:'The source shift is no longer open.'});
    else if(timeSourceHash(current)!==request.sourceHash)issues.push({code:'source_changed',message:'Recorded events changed after this request was prepared.'});
  } else {
    const assigned=await assignedJobs(tx,actor,request.employee.id);
    if(!request.scope.jobIds.every(id=>assigned.includes(id)))issues.push({code:'jobs_unavailable',message:'A proposed job is no longer active and assigned in its explicit unit.'});
  }
  if(timeMicroseconds(request.proposed.shift.endedAt!)>timeMicroseconds(await timeNow(tx)))issues.push({code:'future_end',message:'The proposed end is later than the current server time.'});
  if(!await noTimeOverlap(tx,actor.org_id,request.employee.id,request.proposed.shift.startedAt,request.proposed.shift.endedAt,request.source?.shift.id??null))issues.push({code:'overlap',message:'The proposed time overlaps another recorded shift.'});
  return {state:issues.some(row=>['source_changed','source_not_open'].includes(row.code))?'stale':issues.length?'blocked':'ready',issues};
}
async function applyTime(tx:Queryable,actor:Actor,envelope:TimeAdjustmentEnvelope):Promise<TimeSnapshot> {
  const {request}=envelope,shiftId=request.source?.shift.id??randomUUID(),revision=request.source?request.source.shift.revision!+1:1;
  // SQL readers order tied zero-duration events by UUID. Allocate sorted IDs in
  // reviewed order so copying a revision cannot reorder those recorded events.
  const segmentIds=request.proposed.segments.map(()=>randomUUID()).sort();
  if(request.source) {
    // SQL copies recorded timestamps without passing them through a Date parser.
    for(const [index,segment] of request.source.segments.entries()) await tx.query(`INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision)
      SELECT $1,org_id,shift_id,job_id,kind,started_at,coalesce(ended_at,$2::timestamptz),$3 FROM segments WHERE org_id=$4 AND shift_id=$5 AND revision=$6 AND id=$7`,[segmentIds[index],request.proposed.shift.endedAt,revision,actor.org_id,shiftId,request.source.shift.revision,segment.id]);
    await tx.query('UPDATE shifts SET ended_at=$1,revision=$2 WHERE org_id=$3 AND id=$4',[request.proposed.shift.endedAt,revision,actor.org_id,shiftId]);
  } else {
    await tx.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,1)',[shiftId,actor.org_id,request.employee.id,request.proposed.shift.startedAt,request.proposed.shift.endedAt]);
    for(const [index,segment] of request.proposed.segments.entries())await tx.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)',[segmentIds[index],actor.org_id,shiftId,segment.jobId,segment.kind,segment.startedAt,segment.endedAt]);
  }
  return sourceFor(tx,actor,shiftId);
}
async function resolveTimeAdjustment(db:Database,supplied:Actor,sessionHash:string,id:string,raw:unknown,action:'review'|'cancel') {
  z.uuid().parse(id);const input=action==='review'?reviewTimeAdjustmentInput.parse(raw):cancelTimeAdjustmentInput.parse(raw),fingerprint=digest(canonicalTimeJson({action,id,input}));
  return timeTransaction(db,async tx=>{
    const command=await commandLock(tx,supplied,input.commandId),observed=await requestRow(tx,supplied,command?.request_id??id);
    const actor=await currentTimeActor(tx,supplied,sessionHash,observed.user_id,true);
    if(command)return replay(tx,actor,sessionHash,command,fingerprint,action);
    const row=await requestRow(tx,actor,id,true),envelope=envelopeFor(row),request=envelope.request;
    if(action==='review')requireCondition(manages(actor) && actor.id!==request.employee.id && actor.id!==request.proposedBy.id,403,'A different scoped manager must review this request.');
    else requireCondition(actor.id===request.proposedBy.id && (actor.id===request.employee.id || manages(actor)),403,'Only the currently authorized proposer may cancel this request.');
    await authorizeEvidence(tx,actor,envelope,true);
    requireCondition(request.status==='pending' && request.version===input.version && envelope.requestHash===input.requestHash,409,'This request was already resolved or changed. Refresh the review.');
    const status=action==='cancel'?'cancelled':(input as z.infer<typeof reviewTimeAdjustmentInput>).status,note='note' in input?input.note:input.reason;
    if(status==='approved') {const current=await readiness(tx,actor,envelope);requireCondition(current.state==='ready',409,current.issues.map(issue=>issue.message).join(' '));envelope.result=await applyTime(tx,actor,envelope);envelope.resultHash=timeResultHash(envelope.result);}
    const at=await timeNow(tx);Object.assign(request,{version:2,status,resolvedBy:identity(actor),resolutionNote:note,resolvedAt:at,resultShiftId:envelope.result?.shift.id??null,resultRevision:envelope.result?.shift.revision??null});validateTimeEnvelope(envelope);
    await tx.query(`UPDATE time_adjustment_requests SET status=$1,version=2,resolved_by=$2,resolver_name=$3,resolution_note=$4,resolved_at=$5,result_shift_id=$6,result_revision=$7,result_snapshot=$8,result_hash=$9 WHERE org_id=$10 AND id=$11`,[status,actor.id,actor.name,note,at,request.resultShiftId,request.resultRevision,envelope.result?JSON.stringify(envelope.result):null,envelope.resultHash,actor.org_id,id]);
    return saveCommand(tx,actor,sessionHash,action,input.commandId,fingerprint,envelope,note,at);
  });
}
export const reviewTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,id:string,raw:unknown)=>resolveTimeAdjustment(db,actor,sessionHash,id,raw,'review');
export const cancelTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,id:string,raw:unknown)=>resolveTimeAdjustment(db,actor,sessionHash,id,raw,'cancel');

export async function getTimeAdjustmentOptions(db:Database,supplied:Actor,sessionHash:string,raw:unknown) {
  const input=timeAdjustmentOptionsInput.parse(raw);return timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash,input.employeeId),employee=(await tx.query('SELECT id,name,active FROM users WHERE org_id=$1 AND id=$2',[actor.org_id,input.employeeId])).rows[0];
    const ids=await assignedJobs(tx,actor,input.employeeId);requireCondition(ids.length<=200,422,'This employee has more assigned jobs than this editor supports.');
    const jobs=await timeJobs(tx,actor,ids),visible=jobs.filter(job=>input.employeeId===actor.id || orgWide(actor) || actor.unit_ids.includes(job.unit_id));
    requireCondition(input.employeeId===actor.id || manages(actor) && (orgWide(actor) || visible.length>0),404,'Employee not found under your current access.');
    const result=timeAdjustmentOptionsSchema.parse({employee,timezone:await timezone(tx,actor),jobs:visible.map(job=>({id:job.id,title:job.title,unitId:job.unit_id,unitName:job.unit_name})),allowedActions:{proposeMissing:input.employeeId===actor.id||manages(actor),applyDirect:mayApplyDirect(actor,input.employeeId)}});
    await recheckReportSession(tx,actor,sessionHash);return result;
  });
}
export async function getTimeAdjustmentSource(db:Database,supplied:Actor,sessionHash:string,raw:unknown) {
  const input=timeAdjustmentSourceInput.parse(raw);return timeTransaction(db,async tx=>{
    const employeeId=await shiftEmployee(tx,supplied,input.shiftId),actor=await currentTimeActor(tx,supplied,sessionHash,employeeId),source=await sourceFor(tx,actor,input.shiftId);
    requireCondition(source.shift.endedAt===null,409,'This shift is no longer open.');
    const result=timeAdjustmentSourceSchema.parse({source,sourceHash:timeSourceHash(source),observedAt:await timeNow(tx),timezone:await timezone(tx,actor),allowedActions:{propose:employeeId===actor.id||manages(actor),applyDirect:mayApplyDirect(actor,employeeId)}});
    await recheckReportSession(tx,actor,sessionHash);return result;
  });
}
async function readRequest<T>(db:Database,supplied:Actor,sessionHash:string,id:string,operation:(tx:Queryable,actor:Actor,envelope:TimeAdjustmentEnvelope)=>Promise<T>) {
  z.uuid().parse(id);return timeTransaction(db,async tx=>{
    const observed=await requestRow(tx,supplied,id),actor=await currentTimeActor(tx,supplied,sessionHash,observed.user_id),envelope=envelopeFor(await requestRow(tx,actor,id));
    await authorizeEvidence(tx,actor,envelope);const result=await operation(tx,actor,envelope);await recheckReportSession(tx,actor,sessionHash);return result;
  });
}
export const getTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,id:string)=>readRequest(db,actor,sessionHash,id,async(tx,current,envelope)=>{
  const state=await readiness(tx,current,envelope),request=envelope.request,pending=request.status==='pending',reviewer=manages(current)&&current.id!==request.employee.id&&current.id!==request.proposedBy.id;
  return timeAdjustmentDetailSchema.parse({...envelope,readiness:state,allowedActions:{approve:pending&&reviewer&&state.state==='ready',decline:pending&&reviewer,cancel:pending&&request.proposedBy.id===current.id&&(request.employee.id===current.id||manages(current))}});
});
export const getTimeAdjustmentHistory=(db:Database,actor:Actor,sessionHash:string,id:string)=>readRequest(db,actor,sessionHash,id,async(tx,current,envelope)=>{
  const items=[];for(let version=1;version<=envelope.request.version;version++)items.push((await historyAt(tx,current,id,version)).entry);
  return timeAdjustmentHistorySchema.parse({items});
});
export const exportTimeAdjustment=(db:Database,actor:Actor,sessionHash:string,id:string,raw:unknown)=>readRequest(db,actor,sessionHash,id,async(tx,current,envelope)=>{
  const input=timeAdjustmentExportInput.parse(raw),version=input.version?Number(input.version):envelope.request.version;requireCondition(version<=envelope.request.version,404,'This history version is unavailable.');
  const saved=await historyAt(tx,current,id,version);await authorizeEvidence(tx,current,saved.entry.snapshot);
  const text=input.format==='csv'?saved.csv:saved.json,hash=input.format==='csv'?saved.csvHash:saved.jsonHash;
  await audit(tx,current,'time_adjustment.exported',id,{version,format:input.format,hash});
  return {text,hash,filename:`time-adjustment-${id}-v${version}.${input.format}`,contentType:input.format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8'};
});

const cursorSchema=z.object({scope:z.string().length(64),revision:z.string().length(64),at:z.string(),id:z.uuid()}).strict();
function cursorRead(value:string|undefined) {if(!value)return null;try{return cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}catch{throw new Problem(400,'Invalid time-record page cursor.');}}
const cursorWrite=(value:z.infer<typeof cursorSchema>)=>Buffer.from(canonicalTimeJson(value)).toString('base64url');
// The full captured scope plus current job scope is checked in SQL before counting
// or paging. Missing jobs cannot disappear from a NOT EXISTS authorization proof.
const visibleRequest=`(r.user_id=$2 OR ($3::boolean AND ($4::boolean OR (
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.scope_snapshot->'unitIds') u(id) WHERE NOT u.id::uuid=ANY($5::uuid[]))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.result_snapshot->'segments','[]'::jsonb)) g WHERE NOT (g->>'unitId')::uuid=ANY($5::uuid[]))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.scope_snapshot->'jobIds') ref(id) LEFT JOIN jobs j ON j.org_id=r.org_id AND j.id=ref.id::uuid WHERE j.id IS NULL OR NOT j.unit_id=ANY($5::uuid[]))))))`;
export async function listTimeAdjustments(db:Database,supplied:Actor,sessionHash:string,raw:unknown) {
  const input=timeAdjustmentListInput.parse(raw),cursor=cursorRead(input.cursor);const prepared=await timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash),zone=await timezone(tx,actor),bounds=input.start&&input.end?reportBounds({start:input.start,end:input.end,group:'day'},zone):null;
    const filter={...input,cursor:undefined},scope=digest(canonicalTimeJson({actor:actor.id,role:actor.role,units:unique(actor.unit_ids),filter:Object.fromEntries(Object.entries(filter).filter(([,value])=>value!==undefined))}));
    const args=[actor.org_id,actor.id,canReport(actor),orgWide(actor),actor.unit_ids,bounds?.start.toJSDate()??null,bounds?.end.toJSDate()??null,input.employeeId??null,input.kind??null,input.sourceShiftId??null];
    const where=`r.org_id=$1 AND ${visibleRequest} AND ($6::timestamptz IS NULL OR ((r.starts_at<$7::timestamptz AND r.ends_at>$6::timestamptz) OR (r.starts_at=r.ends_at AND r.starts_at>=$6::timestamptz AND r.starts_at<$7::timestamptz))) AND ($8::uuid IS NULL OR r.user_id=$8) AND ($9::text IS NULL OR r.kind=$9) AND ($10::uuid IS NULL OR r.source_shift_id=$10 OR r.result_shift_id=$10)`;
    const revision=digest(canonicalTimeJson((await tx.query(`SELECT coalesce(string_agg(r.id::text||':'||r.version::text,',' ORDER BY r.id),'') AS identities FROM time_adjustment_requests r WHERE ${where}`,args)).rows[0]));
    if(cursor)requireCondition(cursor.scope===scope&&cursor.revision===revision,409,'Time requests changed. Discard all prior pages and refresh this list.');
    const rows=(await tx.query(`SELECT ${requestProjection} FROM time_adjustment_requests r WHERE ${where} AND ($11::text IS NULL OR r.status=$11) AND ($12::timestamptz IS NULL OR (r.created_at,r.id)<($12::timestamptz,$13::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[...args,input.status??null,cursor?.at??null,cursor?.id??null])).rows;
    const envelopes=rows.slice(0,50).map(envelopeFor);
    await timeJobs(tx,actor,unique(envelopes.flatMap(value=>value.request.scope.jobIds)));
    for(const envelope of envelopes)await authorizeEvidence(tx,actor,envelope);
    const items=envelopes.map(({request,requestHash})=>({id:request.id,kind:request.kind,employee:request.employee,proposedBy:request.proposedBy,createdAt:request.createdAt,startedAt:request.proposed.shift.startedAt,endedAt:request.proposed.shift.endedAt!,version:request.version,status:request.status,requestHash,sourceShiftId:request.source?.shift.id??null,resultShiftId:request.resultShiftId,resultRevision:request.resultRevision}));
    const last=items.at(-1),nextCursor=rows.length>50&&last?cursorWrite({scope,revision,at:last.createdAt,id:last.id}):null;
    await recheckReportSession(tx,actor,sessionHash);return {result:timeAdjustmentListSchema.parse({items,nextCursor,timezone:zone}),envelopes,access:{role:actor.role,units:unique(actor.unit_ids)}};
  },true);
  // Publish from a new snapshot with all selected employees locked in the same
  // sorted account order as writers. Never return a stale RR authorization.
  return timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash,unique(prepared.envelopes.map(value=>value.request.employee.id)));
    requireCondition(canonicalTimeJson(prepared.access)===canonicalTimeJson({role:actor.role,units:unique(actor.unit_ids)}),409,'Your time-record access changed. Refresh this list.');
    await timeJobs(tx,actor,unique(prepared.envelopes.flatMap(value=>value.request.scope.jobIds)));
    for(const value of prepared.envelopes) {await authorizeEvidence(tx,actor,value);const current=await requestRow(tx,actor,value.request.id);requireCondition(current.version===value.request.version,409,'Time requests changed. Discard all prior pages and refresh this list.');}
    await recheckReportSession(tx,actor,sessionHash);return prepared.result;
  });
}
async function openManifest(tx:Queryable,actor:Actor,ids:string[]) {
  const shifts=(await tx.query(`SELECT id,user_id,revision,${preciseTimeSql('started_at')} AS started_at,${preciseTimeSql('ended_at')} AS ended_at FROM shifts WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,[actor.org_id,ids])).rows;
  const segments=(await tx.query(`SELECT g.id,g.shift_id,g.job_id,g.revision,g.kind,${preciseTimeSql('g.started_at')} AS started_at,${preciseTimeSql('g.ended_at')} AS ended_at FROM segments g JOIN shifts s ON s.org_id=g.org_id AND s.id=g.shift_id AND s.revision=g.revision WHERE s.org_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY g.shift_id,g.started_at,g.ended_at,g.id LIMIT 10001`,[actor.org_id,ids])).rows;
  requireCondition(segments.length<=10000,422,'This open-shift page exceeds the supported source size. Filter to an employee.');
  const requests=(await tx.query('SELECT id,version FROM time_adjustment_requests WHERE org_id=$1 AND source_shift_id=ANY($2::uuid[]) ORDER BY id',[actor.org_id,ids])).rows;
  return {shifts,segments,requests};
}
export async function listOpenTimeShifts(db:Database,supplied:Actor,sessionHash:string,raw:unknown) {
  const input=openTimeShiftsInput.parse(raw),cursor=cursorRead(input.cursor);const prepared=await timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash),scope=digest(canonicalTimeJson({actor:actor.id,role:actor.role,units:unique(actor.unit_ids),employeeId:input.employeeId??null}));
    const args=[actor.org_id,actor.id,canReport(actor),orgWide(actor),actor.unit_ids,input.employeeId??null];
    const where=`s.org_id=$1 AND s.ended_at IS NULL AND ($6::uuid IS NULL OR s.user_id=$6) AND EXISTS(SELECT 1 FROM segments g WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision)
      AND (s.user_id=$2 OR ($3::boolean AND ($4::boolean OR NOT EXISTS(SELECT 1 FROM segments g LEFT JOIN jobs j ON j.org_id=g.org_id AND j.id=g.job_id WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision AND (j.id IS NULL OR NOT j.unit_id=ANY($5::uuid[]))))))`;
    // Segment IDs are append-only for ordinary transitions; their maximum count
    // changes for every switch/break, while a clock-out removes its open shift.
    const revision=digest(canonicalTimeJson((await tx.query(`SELECT count(*)::text AS shifts,coalesce(sum(s.revision),0)::text AS revisions,
      coalesce(sum((SELECT count(*) FROM segments g WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision)),0)::text AS segments,
      coalesce(string_agg(s.id::text,',' ORDER BY s.id),'') AS identities,
      coalesce(sum((SELECT count(*) FROM time_adjustment_requests r WHERE r.org_id=s.org_id AND r.source_shift_id=s.id)),0)::text AS requests,
      coalesce(sum((SELECT coalesce(sum(r.version),0) FROM time_adjustment_requests r WHERE r.org_id=s.org_id AND r.source_shift_id=s.id)),0)::text AS request_versions
      FROM shifts s WHERE ${where}`,args)).rows[0]));
    if(cursor)requireCondition(cursor.scope===scope&&cursor.revision===revision,409,'Open time records changed. Discard all prior pages and refresh this list.');
    const rows=(await tx.query(`SELECT s.id AS shift_id,s.user_id,u.name,s.revision,${preciseTimeSql('s.started_at')} AS started_at,
      (SELECT count(*)::int FROM time_adjustment_requests r WHERE r.org_id=s.org_id AND r.source_shift_id=s.id AND r.status='pending' AND ${visibleRequest}) AS pending_requests
      FROM shifts s JOIN users u ON u.org_id=s.org_id AND u.id=s.user_id WHERE ${where} AND ($7::timestamptz IS NULL OR (s.started_at,s.id)<($7::timestamptz,$8::uuid)) ORDER BY s.started_at DESC,s.id DESC LIMIT 51`,[...args,cursor?.at??null,cursor?.id??null])).rows;
    const selected=rows.slice(0,50),jobIds=(await tx.query('SELECT DISTINCT g.job_id FROM segments g JOIN shifts s ON s.org_id=g.org_id AND s.id=g.shift_id AND s.revision=g.revision WHERE s.org_id=$1 AND s.id=ANY($2::uuid[])',[actor.org_id,selected.map(row=>row.shift_id)])).rows.map(row=>row.job_id);
    await timeJobs(tx,actor,jobIds);
    const items=selected.map(row=>({shiftId:row.shift_id,employee:{id:row.user_id,name:row.name},startedAt:row.started_at,revision:row.revision,pendingRequests:row.pending_requests})),last=items.at(-1);
    const result=openTimeShiftsSchema.parse({items,nextCursor:rows.length>50&&last?cursorWrite({scope,revision,at:last.startedAt,id:last.shiftId}):null,timezone:await timezone(tx,actor),observedAt:await timeNow(tx)});
    const manifest=await openManifest(tx,actor,items.map(row=>row.shiftId));
    await recheckReportSession(tx,actor,sessionHash);return {result,manifest,access:{role:actor.role,units:unique(actor.unit_ids)}};
  },true);
  return timeTransaction(db,async tx=>{
    const actor=await currentTimeActor(tx,supplied,sessionHash,unique(prepared.result.items.map(row=>row.employee.id)));
    requireCondition(canonicalTimeJson(prepared.access)===canonicalTimeJson({role:actor.role,units:unique(actor.unit_ids)}),409,'Your time-record access changed. Refresh this list.');
    const current=await openManifest(tx,actor,prepared.result.items.map(row=>row.shiftId)),jobs=await timeJobs(tx,actor,current.segments.map(row=>row.job_id));
    for(const shift of current.shifts)requireCondition(allowsTimeScope(actor,shift.user_id,jobs.filter(job=>current.segments.some(segment=>segment.shift_id===shift.id&&segment.job_id===job.id))),404,'An open time record is unavailable under your current access.');
    requireCondition(canonicalTimeJson(current)===canonicalTimeJson(prepared.manifest),409,'Open time records changed. Discard all prior pages and refresh this list.');
    await recheckReportSession(tx,actor,sessionHash);return prepared.result;
  });
}

export function installTimeAdjustments(app:Express,db:Database) {
  const auth=(req:Request)=>{const value=req as AppRequest;requireCondition(value.actor.mode==='password',403,'Sign in with your password to open time adjustments.');return {actor:value.actor,hash:value.sessionHash!};};
  const get=(path:string,fn:(req:Request,actor:Actor,hash:string)=>Promise<unknown>)=>app.get('/api/time-adjustments'+path,async(req,res)=>{const {actor,hash}=auth(req);res.set('Cache-Control','private, no-store');res.json(await fn(req,actor,hash));});
  get('/options',(req,actor,hash)=>getTimeAdjustmentOptions(db,actor,hash,req.query));
  get('/closure-source',(req,actor,hash)=>getTimeAdjustmentSource(db,actor,hash,req.query));
  get('/open-shifts',(req,actor,hash)=>listOpenTimeShifts(db,actor,hash,req.query));
  get('',(req,actor,hash)=>listTimeAdjustments(db,actor,hash,req.query));
  get('/:id/history',(req,actor,hash)=>getTimeAdjustmentHistory(db,actor,hash,z.uuid().parse(req.params.id)));
  app.get('/api/time-adjustments/:id/export',async(req,res)=>{const {actor,hash}=auth(req),result=await exportTimeAdjustment(db,actor,hash,z.uuid().parse(req.params.id),req.query);res.set({'Cache-Control':'private, no-store','Content-Type':result.contentType,'Content-Disposition':`attachment; filename="${result.filename}"`,'X-Content-SHA256':result.hash});res.send(Buffer.from(result.text,'utf8'));});
  get('/:id',(req,actor,hash)=>getTimeAdjustment(db,actor,hash,z.uuid().parse(req.params.id)));
  app.post('/api/time-adjustments',async(req,res)=>{const {actor,hash}=auth(req),value=await proposeTimeAdjustment(db,actor,hash,req.body);res.set('Cache-Control','private, no-store').status(value.replayed?200:201).json(value.result);});
  app.post('/api/time-adjustments/direct',async(req,res)=>{const {actor,hash}=auth(req),value=await applyDirectTimeAdjustment(db,actor,hash,req.body);res.set('Cache-Control','private, no-store').status(value.replayed?200:201).json(value.result);});
  app.post('/api/time-adjustments/:id/review',async(req,res)=>{const {actor,hash}=auth(req),value=await reviewTimeAdjustment(db,actor,hash,z.uuid().parse(req.params.id),req.body);res.set('Cache-Control','private, no-store').json(value.result);});
  app.post('/api/time-adjustments/:id/cancel',async(req,res)=>{const {actor,hash}=auth(req),value=await cancelTimeAdjustment(db,actor,hash,z.uuid().parse(req.params.id),req.body);res.set('Cache-Control','private, no-store').json(value.result);});
}
