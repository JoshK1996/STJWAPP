import { timeAdjustmentEnvelopeSchema, timeAdjustmentHistoryEntrySchema, type TimeAdjustmentEnvelope } from '../shared/time-adjustments';
import { canonicalTimeJson, timeMicroseconds } from './time-record-access';
import { digest, requireCondition } from './security';
import { toCsv } from './reports';
import type { Row } from './db';

export function adjustmentDefinitionHash(envelope: TimeAdjustmentEnvelope) {
  const {status,version,resolvedBy,resolutionNote,resolvedAt,resultShiftId,resultRevision,...definition} = envelope.request;
  return digest(canonicalTimeJson({schemaVersion:1,kind:'time_adjustment_definition',definition}));
}
export const timeSourceHash = (source: unknown) => digest(canonicalTimeJson({schemaVersion:1,kind:'recorded_time_source',source}));
export const timeResultHash = (result: unknown) => digest(canonicalTimeJson({schemaVersion:1,kind:'recorded_time_result',result}));

export function validateTimeEnvelope(raw: unknown): TimeAdjustmentEnvelope {
  const value = timeAdjustmentEnvelopeSchema.parse(raw), request = value.request;
  requireCondition(adjustmentDefinitionHash(value)===value.requestHash,422,'Time request evidence failed its integrity check.');
  requireCondition(request.kind==='missing_shift' ? request.source===null && request.sourceHash===null : request.source!==null && request.sourceHash!==null && request.source.shift.endedAt===null,422,'Time source evidence is inconsistent.');
  if(request.source) requireCondition(request.sourceHash===timeSourceHash(request.source),422,'Time source evidence failed its integrity check.');
  requireCondition(['approved','applied'].includes(request.status) ? value.result!==null && value.resultHash!==null : value.result===null && value.resultHash===null && request.resultShiftId===null && request.resultRevision===null,422,'Time result evidence is inconsistent.');
  if(value.result) requireCondition(value.resultHash===timeResultHash(value.result) && request.resultShiftId===value.result.shift.id && request.resultRevision===value.result.shift.revision,422,'Time result evidence failed its integrity check.');
  requireCondition(request.status==='pending' ? request.version===1 && request.resolvedBy===null && request.resolvedAt===null && request.resolutionNote===null : request.version===(request.status==='applied'?1:2) && request.resolvedBy!==null && request.resolvedAt!==null && request.resolutionNote!==null,422,'Time decision evidence is inconsistent.');
  if(request.status==='applied')requireCondition(request.resolvedBy!.id===request.proposedBy.id && request.resolvedBy!.id!==request.employee.id,422,'A direct adjustment requires the same administrator to enter and save another employee’s time.');
  if(value.result)requireCondition(value.result.segments.length===request.proposed.segments.length && value.result.segments.every((row,index)=>{const expected=request.proposed.segments[index];return row.jobId===expected.jobId && row.kind===expected.kind && timeMicroseconds(row.startedAt)===timeMicroseconds(expected.startedAt) && row.endedAt!==null && expected.endedAt!==null && timeMicroseconds(row.endedAt)===timeMicroseconds(expected.endedAt);}),422,'Applied time evidence differs from the reviewed proposal.');
  for(const snapshot of [request.source,request.proposed,value.result].filter(Boolean)) {
    requireCondition(snapshot!.orgId===request.orgId && snapshot!.employee.id===request.employee.id,422,'Time evidence identities are inconsistent.');
    let work=0n,rest=0n;
    for(let i=0;i<snapshot!.segments.length;i++) {
      const segment=snapshot!.segments[i],start=timeMicroseconds(segment.startedAt),end=segment.endedAt===null?null:timeMicroseconds(segment.endedAt);
      requireCondition((i===0?timeMicroseconds(snapshot!.shift.startedAt):timeMicroseconds(snapshot!.segments[i-1].endedAt!))===start && (end===null?i===snapshot!.segments.length-1:end>=start),422,'Time evidence is not contiguous.');
      if(end!==null) {if(segment.kind==='work')work+=end-start;else rest+=end-start;}
    }
    const last=snapshot!.segments.at(-1)!;
    requireCondition((snapshot!.shift.endedAt===null)===(last.endedAt===null),422,'Time evidence end is inconsistent.');
    if(last.endedAt!==null) requireCondition(timeMicroseconds(last.endedAt)===timeMicroseconds(snapshot!.shift.endedAt!) && snapshot!.totals?.workMicroseconds===work.toString() && snapshot!.totals?.breakMicroseconds===rest.toString() && snapshot!.totals?.totalMicroseconds===(work+rest).toString(),422,'Time evidence totals are inconsistent.');
    else requireCondition(snapshot!.totals===null,422,'An open source cannot have a completed duration.');
  }
  const jobs=[...new Set([request.source,request.proposed].filter(Boolean).flatMap(s=>s!.segments.map(g=>g.jobId)))].sort(),units=[...new Set([request.source,request.proposed].filter(Boolean).flatMap(s=>s!.segments.map(g=>g.unitId)))].sort();
  requireCondition(canonicalTimeJson(jobs)===canonicalTimeJson(request.scope.jobIds) && canonicalTimeJson(units)===canonicalTimeJson(request.scope.unitIds),422,'Time evidence scope is inconsistent.');
  return value;
}

export function adjustmentHistoryBytes(envelope: TimeAdjustmentEnvelope, actor: {id:string;name:string}, reason: string, createdAt: string) {
  validateTimeEnvelope(envelope);
  const body={version:envelope.request.version,action:envelope.request.status==='pending'?'proposed':envelope.request.status,actor,reason,createdAt,snapshot:envelope};
  const snapshotText=canonicalTimeJson(body),snapshotHash=digest(snapshotText),entry=timeAdjustmentHistoryEntrySchema.parse({...body,snapshotHash});
  const json=canonicalTimeJson(entry)+'\n';
  const rows:Row[]=[];
  for(const [label,snapshot] of [['original source',envelope.request.source],['proposal',envelope.request.proposed],['applied result',envelope.result]] as const) if(snapshot) {
    for(const segment of snapshot.segments) rows.push({request_id:envelope.request.id,request_hash:envelope.requestHash,version:body.version,status:envelope.request.status,employee_id:snapshot.employee.id,employee_name:snapshot.employee.name,
      proposed_by:envelope.request.proposedBy.name,proposed_at:envelope.request.createdAt,proposal_reason:envelope.request.reason,decision_by:envelope.request.resolvedBy?.name??'',decision_at:envelope.request.resolvedAt??'',decision_note:envelope.request.resolutionNote??'',
      evidence:label,shift_id:snapshot.shift.id??'',revision:snapshot.shift.revision??'',segment_id:segment.id??'',job_id:segment.jobId,job:segment.jobTitle,unit_id:segment.unitId,unit:segment.unitName,kind:segment.kind,start_utc:segment.startedAt,end_utc:segment.endedAt??'',
      end_state:segment.endedAt===null?'No end recorded in this source':'Recorded end',work_microseconds:snapshot.totals?.workMicroseconds??'',break_microseconds:snapshot.totals?.breakMicroseconds??'',total_microseconds:snapshot.totals?.totalMicroseconds??'',history_hash:snapshotHash});
  }
  const csv=toCsv(rows,Object.keys(rows[0]));
  return {entry,snapshotText,snapshotHash,json,csv,jsonHash:digest(json),csvHash:digest(csv),bytes:Buffer.byteLength(snapshotText)+Buffer.byteLength(json)+Buffer.byteLength(csv)};
}

/** Base64 avoids text-driver BOM normalization. Download the original retained bytes. */
export function retainedAdjustmentHistory(row: Row) {
  const snapshotText=Buffer.from(row.snapshot_base64,'base64').toString('utf8'),json=Buffer.from(row.json_base64,'base64').toString('utf8'),csv=Buffer.from(row.csv_base64,'base64').toString('utf8');
  requireCondition(digest(snapshotText)===row.snapshot_hash && digest(json)===row.json_hash && digest(csv)===row.csv_hash && Buffer.byteLength(snapshotText)+Buffer.byteLength(json)+Buffer.byteLength(csv)===row.bytes,422,'Retained time evidence failed its integrity check.');
  const entry=timeAdjustmentHistoryEntrySchema.parse({...JSON.parse(snapshotText),snapshotHash:row.snapshot_hash});
  validateTimeEnvelope(entry.snapshot);
  requireCondition(entry.snapshot.request.id===row.request_id && entry.snapshot.request.orgId===row.org_id && entry.version===row.version && canonicalTimeJson(entry)+'\n'===json,422,'Retained time history identities are inconsistent.');
  return {entry,json,csv,jsonHash:row.json_hash as string,csvHash:row.csv_hash as string};
}
