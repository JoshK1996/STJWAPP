import {DateTime} from 'luxon';
import {z} from 'zod';
import type {Database,Queryable} from './db';
import {canReport,orgWide,requireCondition,type Actor} from './security';
import {withAuthorizedWorkforceSource,type WorkforceReportProof} from './workforce-report-access';
import {readWorkforceReportSourceV2,workforceReportBoundsV2} from './reports-v2';
import {workforceInstantMicroseconds as micros,workforceFloorDivide,workforceUtcMicrosSchema,type WorkforceReportV2} from '../shared/workforce-reports-v2';
import {allowancePeriodSchema,workforceOverviewSchema,workforceOverviewQuerySchema,type AllowanceMetrics,type AllowancePeriod,type WorkforceOverviewQuery} from '../shared/workforce-overview';

export const allowanceScheduleSchema=z.object({id:z.uuid(),version:z.number().int().positive(),userId:z.uuid(),employeeName:z.string(),jobId:z.uuid(),jobTitle:z.string(),unitId:z.uuid(),unitName:z.string(),startsAt:workforceUtcMicrosSchema,endsAt:workforceUtcMicrosSchema}).strict();
export type AllowanceSchedule=z.infer<typeof allowanceScheduleSchema>;
const zero=():AllowanceMetrics=>({workMicroseconds:'0',breakMicroseconds:'0',scheduledMicroseconds:'0',aboveScheduledMicroseconds:'0',belowScheduledMicroseconds:'0',unscheduledWorkMicroseconds:'0'});
const min=(a:bigint,b:bigint)=>a<b?a:b,max=(a:bigint,b:bigint)=>a>b?a:b;
const metricKeys=Object.keys(zero()) as (keyof AllowanceMetrics)[];
function add(target:AllowanceMetrics,source:AllowanceMetrics){for(const key of metricKeys)target[key]=(BigInt(target[key])+BigInt(source[key])).toString();}
function localDate(instant:bigint,zone:string){return DateTime.fromMillis(Number(workforceFloorDivide(instant,1000n)),{zone});}
type Identity={userId:string;employeeName:string;jobId:string;jobTitle:string;unitId:string;unitName:string};
type Cell={identity:Identity;date:string;work:bigint;rest:bigint;scheduled:bigint;outside:bigint};
/** Exact, pure comparison. Overages accrue per employee/local day across all jobs; a shorter day never cancels an earlier flag. */
export function aggregateAllowance(report:WorkforceReportV2,rawSchedules:AllowanceSchedule[]):AllowancePeriod{
  const {group:_,...query}=report.query,{start,end}=workforceReportBoundsV2(report.query,report.timezone);
  requireCondition(rawSchedules.length<=20_000,400,'Choose a shorter period: too many scheduled shifts.');
  const schedules=rawSchedules.map(value=>allowanceScheduleSchema.parse(value));
  const jobIdentities=new Map<string,Identity>();
  const seen=new Set<string>(),byJob=new Map<string,Array<[bigint,bigint]>>(),cells=new Map<string,Cell>();
  const pair=(userId:string,jobId:string)=>userId+':'+jobId;
  const cell=(identity:Identity,date:string)=>{const key=pair(identity.userId,identity.jobId)+':'+date;let value=cells.get(key);if(!value){value={identity,date,work:0n,rest:0n,scheduled:0n,outside:0n};cells.set(key,value);requireCondition(cells.size<=40_000,400,'Choose a shorter period or one employee.');}else requireCondition(JSON.stringify(value.identity)===JSON.stringify(identity),422,'The source contains inconsistent employee or job labels.');return value;};
  function split(left:bigint,right:bigint,visit:(date:string,left:bigint,right:bigint)=>void){
    for(let cursor=left;cursor<right;){const local=localDate(cursor,report.timezone),boundary=min(BigInt(local.startOf('day').plus({days:1}).toMillis())*1000n,right);requireCondition(boundary>cursor,422,'Unsupported local date boundary.');visit(local.toISODate()!,cursor,boundary);cursor=boundary;}
  }
  for(const schedule of schedules){
    requireCondition(!seen.has(schedule.id),422,'Duplicate scheduled shift in report source.');seen.add(schedule.id);
    const from=micros(schedule.startsAt),to=micros(schedule.endsAt);requireCondition(to>from,422,'A scheduled shift has invalid boundaries.');
    const left=max(from,start),right=min(to,end);if(right<=left)continue;
    const {id:_,version:__,startsAt:___,endsAt:____,...identity}=schedule,key=pair(identity.userId,identity.jobId);
    const intervals=byJob.get(key)??[];intervals.push([left,right]);byJob.set(key,intervals);
    const prior=jobIdentities.get(key);requireCondition(!prior||JSON.stringify(prior)===JSON.stringify(identity),422,"Inconsistent schedule labels.");jobIdentities.set(key,identity);
  }
  // Membership is the union, so overlapping legacy schedules cannot count the same work twice.
  for(const [key,intervals] of byJob){intervals.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);const merged:Array<[bigint,bigint]>=[];
    for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=max(last[1],interval[1]);else merged.push([...interval]);}byJob.set(key,merged);for(const [left,right] of merged)split(left,right,(date,a,b)=>{cell(jobIdentities.get(key)!,date).scheduled+=b-a;});
  }
  for(const row of report.rows){
    if(!row.clipped_started_at||!row.clipped_ended_at)continue;
    const identity={userId:row.user_id,employeeName:row.employee_name,jobId:row.job_id,jobTitle:row.job_title,unitId:row.unit_id,unitName:row.unit_name};
    split(micros(row.clipped_started_at),micros(row.clipped_ended_at),(date,left,right)=>{const item=cell(identity,date);if(row.kind==='break'){item.rest+=right-left;return;}
      item.work+=right-left;let inside=0n;for(const [a,b] of byJob.get(pair(row.user_id,row.job_id))??[]){if(a>=right)break;if(b<=left)continue;inside+=min(right,b)-max(left,a);}item.outside+=right-left-inside;
    });
  }
  const employeeDays=new Map<string,{userId:string;date:string;work:bigint;scheduled:bigint}>();
  const totals=zero(),people=new Map<string,AllowancePeriod['people'][number]>(),jobs=new Map<string,Identity&AllowanceMetrics>(),days=new Map<string,AllowancePeriod['days'][number]>();
  for(let date=DateTime.fromISO(query.start,{zone:report.timezone});date.toISODate()!<=query.end;date=date.plus({days:1}))days.set(date.toISODate()!,{date:date.toISODate()!,label:date.toFormat('LLL d'),...zero()});
  for(const item of cells.values()){
    const value:AllowanceMetrics={workMicroseconds:item.work.toString(),breakMicroseconds:item.rest.toString(),scheduledMicroseconds:item.scheduled.toString(),aboveScheduledMicroseconds:'0',belowScheduledMicroseconds:'0',unscheduledWorkMicroseconds:item.outside.toString()};
    const dayKey=item.identity.userId+':'+item.date,employeeDay=employeeDays.get(dayKey)??{userId:item.identity.userId,date:item.date,work:0n,scheduled:0n};employeeDay.work+=item.work;employeeDay.scheduled+=item.scheduled;employeeDays.set(dayKey,employeeDay);
    add(totals,value);const p=people.get(item.identity.userId)??{userId:item.identity.userId,name:item.identity.employeeName,...zero()};add(p,value);people.set(p.userId,p);
    const key=pair(item.identity.userId,item.identity.jobId),j=jobs.get(key)??{...item.identity,...zero()};add(j,value);jobs.set(key,j);add(days.get(item.date)!,value);
  }
  for(const item of employeeDays.values()){const over=max(0n,item.work-item.scheduled),under=max(0n,item.scheduled-item.work);for(const value of [totals,people.get(item.userId)!,days.get(item.date)!]){value.aboveScheduledMicroseconds=(BigInt(value.aboveScheduledMicroseconds)+over).toString();value.belowScheduledMicroseconds=(BigInt(value.belowScheduledMicroseconds)+under).toString();}}
  requireCondition(totals.workMicroseconds===report.workMicroseconds&&totals.breakMicroseconds===report.breakMicroseconds,422,'Scheduled comparison does not reconcile to the recorded time source.');
  return allowancePeriodSchema.parse({query,totals,people:[...people.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.userId.localeCompare(b.userId)),jobs:[...jobs.values()].map(({aboveScheduledMicroseconds:_,belowScheduledMicroseconds:__,...job})=>job).sort((a,b)=>a.employeeName.localeCompare(b.employeeName)||a.unitName.localeCompare(b.unitName)||a.jobTitle.localeCompare(b.jobTitle)||a.jobId.localeCompare(b.jobId)),days:[...days.values()],notice:'Scheduled shifts are the allowance, including future scheduled time in this period. Hours over schedule compare each employee’s total work across all jobs with all scheduled hours for that local day, without offsetting excess against shorter days. Job changes within that daily allowance do not create an overage. Job breakdowns show work, scheduled time and outside-schedule intervals without allocating the employee’s overage to a job. Outside-schedule hours show work outside matching scheduled intervals. Breaks are separate. These are recorded durations, not overtime or pay calculations. Current schedules and corrected time records can change this view; saved reviews retain their captured evidence.'});
}
const exact=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function readAllowanceSource(tx:Queryable,actor:Actor,query:WorkforceOverviewQuery,asOf:string){
  const report=await readWorkforceReportSourceV2(tx,actor,{...query,group:'day'},{asOf});
  const rows=(await tx.query(`SELECT s.id,s.version,s.user_id AS "userId",u.name AS "employeeName",j.id AS "jobId",j.title AS "jobTitle",n.id AS "unitId",n.name AS "unitName",${exact('s.starts_at')} AS "startsAt",${exact('s.ends_at')} AS "endsAt"
    FROM schedules s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id JOIN units n ON n.id=j.unit_id AND n.org_id=j.org_id
    WHERE s.org_id=$1 AND s.status='scheduled' AND s.starts_at<$3::timestamptz AND s.ends_at>$2::timestamptz
    AND ($4::boolean OR n.id=ANY($5::uuid[])) AND ($6::uuid IS NULL OR n.id=$6) AND ($7::uuid IS NULL OR s.user_id=$7)
    ORDER BY s.starts_at,s.id LIMIT 20001`,[actor.org_id,report.range.from,report.range.toExclusive,orgWide(actor),actor.unit_ids,query.unitId??null,query.userId??null])).rows.map(row=>allowanceScheduleSchema.parse(row));
  return {period:aggregateAllowance(report,rows),report,schedules:rows};
}
export async function getWorkforceOverview(db:Database,supplied:Actor,proof:WorkforceReportProof,raw:unknown){
  const query=workforceOverviewQuerySchema.parse(raw);
  return withAuthorizedWorkforceSource(db,supplied,proof,async(tx,actor)=>{
    requireCondition(canReport(actor),403,'Workforce reporting access required.');
    const meta=(await tx.query(`SELECT name,timezone,${exact('clock_timestamp()')} AS as_of FROM organizations WHERE id=$1`,[actor.org_id])).rows[0];requireCondition(meta,404,'Organization unavailable.');
    const current=DateTime.fromISO(meta.as_of,{zone:meta.timezone}),scope=query.unitId?{unitId:query.unitId}:{};
    const todayQuery={start:current.toISODate()!,end:current.toISODate()!,...scope},weekQuery={start:current.startOf('week').toISODate()!,end:current.endOf('week').toISODate()!,...scope};
    const today=await readAllowanceSource(tx,actor,todayQuery,meta.as_of),week=await readAllowanceSource(tx,actor,weekQuery,meta.as_of),selected=await readAllowanceSource(tx,actor,query,meta.as_of);
    return workforceOverviewSchema.parse({asOf:meta.as_of,timezone:meta.timezone,organizationName:meta.name,today:today.period,week:week.period,selected:selected.period});
  },async(_tx,_actor,result)=>result,{repeatableRead:true});
}
export async function getWorkforceBoard(db:Database,supplied:Actor,proof:WorkforceReportProof){
  return withAuthorizedWorkforceSource(db,supplied,proof,async(tx,actor)=>{
    requireCondition(canReport(actor),403,'Workforce reporting access required.');
    const asOf=(await tx.query(`SELECT ${exact('clock_timestamp()')} AS value`)).rows[0].value;
    const rows=(await tx.query(`SELECT u.id AS user_id,u.name,j.id AS job_id,j.title AS job_title,n.name AS unit_name,n.id AS unit_id,g.kind,${exact('s.started_at')} AS started_at,${exact('g.started_at')} AS segment_started_at
      FROM shifts s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id JOIN segments g ON g.shift_id=s.id AND g.org_id=s.org_id AND g.revision=s.revision AND g.ended_at IS NULL
      JOIN jobs j ON j.id=g.job_id AND j.org_id=g.org_id JOIN units n ON n.id=j.unit_id AND n.org_id=j.org_id
      WHERE s.org_id=$1 AND s.ended_at IS NULL AND ($2::boolean OR n.id=ANY($3::uuid[])) ORDER BY u.name,u.id`,[actor.org_id,orgWide(actor),actor.unit_ids])).rows;
    return {rows,asOf};
  },async(_tx,_actor,result)=>result,{repeatableRead:true});
}
