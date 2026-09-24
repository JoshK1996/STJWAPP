import {z} from 'zod';
import {DateTime} from 'luxon';
import {buildPayrollHoursReport,payrollDecimalHours,payrollHoursLimits} from './payroll-hours';
import {workforceBucketV2Schema,workforceInstantMicroseconds,workforceLocalDateSchema,workforceReportQueryV2Schema,workforceUtcMicrosSchema,workforceV2Limits,type WorkforceReportV2} from './workforce-reports-v2';

export const payrollReviewQuerySchema=workforceReportQueryV2Schema;
export const payrollReviewExportQuerySchema=workforceReportQueryV2Schema.safeExtend({format:z.enum(['csv','json']).default('csv'),presentation:z.enum(['readable','exact']).default('exact')});
export const payrollReviewLimits=Object.freeze({responseBytes:payrollHoursLimits.inputBytes,outputBytes:payrollHoursLimits.outputBytes,employees:workforceV2Limits.staff*2});
const nonnegative=z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const signed=z.string().regex(/^(0|-?[1-9][0-9]{0,20})$/);
const decimal=z.string().regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/);
const signedDecimal=z.string().regex(/^-?(0|[1-9][0-9]{0,30})\.[0-9]{6}$/);
const count=z.number().int().nonnegative().max(workforceV2Limits.rows);
export const payrollReviewAmountsSchema=z.object({
  workMicroseconds:nonnegative,breakMicroseconds:nonnegative,totalMicroseconds:nonnegative,
  workHours:decimal,breakHours:decimal,totalHours:decimal,
  shiftCount:count,segmentCount:count,ongoingSegmentCount:count,employeeCount:count,
}).strict();
export const payrollReviewDeltaSchema=z.object({
  workMicroseconds:signed,breakMicroseconds:signed,totalMicroseconds:signed,
  workHours:signedDecimal,breakHours:signedDecimal,totalHours:signedDecimal,
  workPercentChange:signedDecimal.nullable(),
}).strict();
export const payrollReviewPeriodSchema=z.object({
  start:workforceLocalDateSchema,end:workforceLocalDateSchema,from:workforceUtcMicrosSchema,toExclusive:workforceUtcMicrosSchema,
  status:z.enum(['complete','in_progress','future']),capturedThrough:workforceUtcMicrosSchema.nullable(),calendarDays:z.number().int().min(1).max(workforceV2Limits.days),
}).strict();
export const payrollReviewSchema=z.object({
  schemaVersion:z.literal(1),asOf:workforceUtcMicrosSchema,timezone:z.string().min(1).max(80),query:payrollReviewQuerySchema,
  periods:z.object({current:payrollReviewPeriodSchema,previous:payrollReviewPeriodSchema}).strict(),
  totals:z.object({current:payrollReviewAmountsSchema,previous:payrollReviewAmountsSchema,delta:payrollReviewDeltaSchema}).strict(),
  employees:z.array(z.object({userId:z.uuid(),name:z.string().min(1).max(500),current:payrollReviewAmountsSchema,previous:payrollReviewAmountsSchema,delta:payrollReviewDeltaSchema}).strict()).max(payrollReviewLimits.employees),
  series:z.object({current:z.array(workforceBucketV2Schema).max(workforceV2Limits.buckets),previous:z.array(workforceBucketV2Schema).max(workforceV2Limits.buckets)}).strict(),
  preparation:z.object({status:z.literal('review_required'),openSegmentCount:count,employeesWithOpenSegments:count,
    pendingCorrections:z.object({status:z.literal('not_included'),count:z.null(),notice:z.string().max(1000)}).strict(),
  }).strict(),
  evidence:z.object({sourceSchemaVersion:z.literal(2),precisionVersion:z.literal(2),durationUnit:z.literal('microsecond'),currentSourceRows:count,previousSourceRows:count}).strict(),
  notice:z.string().max(3000),
}).strict();
export type PayrollReview=z.infer<typeof payrollReviewSchema>;
export type PayrollReviewAmounts=z.infer<typeof payrollReviewAmountsSchema>;
export type PayrollReviewDelta=z.infer<typeof payrollReviewDeltaSchema>;
export type PayrollReviewPeriod=z.infer<typeof payrollReviewPeriodSchema>;

/** Dates are calendar labels; UTC arithmetic here avoids treating DST days as 24 elapsed hours. */
export function previousPayrollReviewQuery(raw:unknown){
  const query=payrollReviewQuerySchema.parse(raw);
  const days=Number((workforceInstantMicroseconds(query.end+'T00:00:00Z')-workforceInstantMicroseconds(query.start+'T00:00:00Z'))/86_400_000_000n)+1;
  const first=DateTime.fromISO(query.start,{zone:'UTC'});
  const previous=payrollReviewQuerySchema.parse({...query,start:first.minus({days}).toISODate(),end:first.minus({days:1}).toISODate()});
  return {query:previous,days};
}
const zero=():PayrollReviewAmounts=>({workMicroseconds:'0',breakMicroseconds:'0',totalMicroseconds:'0',workHours:'0.000000',breakHours:'0.000000',totalHours:'0.000000',shiftCount:0,segmentCount:0,ongoingSegmentCount:0,employeeCount:0});
const signedHours=(value:bigint)=>{const hours=payrollDecimalHours(value<0n?-value:value);return value<0n&&hours!=='0.000000'?'-'+hours:hours;};
/** Exact integer ratios; percent is a display value rounded half-up to six places. */
function percentChange(current:bigint,previous:bigint):string|null{
  if(previous===0n)return null;
  const delta=current-previous,magnitude=delta<0n?-delta:delta;
  const scaled=(magnitude*100_000_000n+previous/2n)/previous;
  return (delta<0n&&scaled>0n?'-':'')+`${scaled/1_000_000n}.${(scaled%1_000_000n).toString().padStart(6,'0')}`;
}
export function payrollReviewDelta(current:PayrollReviewAmounts,previous:PayrollReviewAmounts):PayrollReviewDelta{
  const work=BigInt(current.workMicroseconds)-BigInt(previous.workMicroseconds),rest=BigInt(current.breakMicroseconds)-BigInt(previous.breakMicroseconds),total=work+rest;
  return {workMicroseconds:String(work),breakMicroseconds:String(rest),totalMicroseconds:String(total),workHours:signedHours(work),breakHours:signedHours(rest),totalHours:signedHours(total),workPercentChange:percentChange(BigInt(current.workMicroseconds),BigInt(previous.workMicroseconds))};
}
function period(report:WorkforceReportV2,calendarDays:number):PayrollReviewPeriod{
  const now=workforceInstantMicroseconds(report.asOf),from=workforceInstantMicroseconds(report.range.from),end=workforceInstantMicroseconds(report.range.toExclusive);
  return {start:report.query.start,end:report.query.end,...report.range,calendarDays,status:now<from?'future':now<end?'in_progress':'complete',capturedThrough:now<from?null:now<end?report.asOf:report.range.toExclusive};
}
const amounts=(row:PayrollReviewAmounts|Omit<PayrollReviewAmounts,'employeeCount'>,employeeCount:number):PayrollReviewAmounts=>({
  workMicroseconds:row.workMicroseconds,breakMicroseconds:row.breakMicroseconds,totalMicroseconds:row.totalMicroseconds,workHours:row.workHours,breakHours:row.breakHours,totalHours:row.totalHours,
  shiftCount:row.shiftCount,segmentCount:row.segmentCount,ongoingSegmentCount:row.ongoingSegmentCount,employeeCount,
});
/** Pure comparison of complete, already-authorized report sources captured together. */
export function buildPayrollReview(currentSource:WorkforceReportV2,previousSource:WorkforceReportV2):PayrollReview{
  const current=buildPayrollHoursReport(currentSource),previous=buildPayrollHoursReport(previousSource),expected=previousPayrollReviewQuery(current.report.query);
  if(current.report.asOf!==previous.report.asOf||current.report.timezone!==previous.report.timezone)throw new RangeError('Payroll comparison requires the same capture instant and timezone.');
  for(const key of ['start','end','group','userId','unitId'] as const)if(previous.report.query[key]!==expected.query[key])throw new RangeError('Payroll comparison requires adjacent equally sized calendar periods and identical filters.');
  const currentById=new Map(current.employees.map(row=>[row.userId,row])),previousById=new Map(previous.employees.map(row=>[row.userId,row]));
  const employees=[...new Set([...currentById.keys(),...previousById.keys()])].map(userId=>{
    const now=currentById.get(userId),before=previousById.get(userId);
    if(now&&before&&now.name!==before.name)throw new RangeError('Payroll comparison source identity labels differ.');
    const a=now?amounts(now,1):zero(),b=before?amounts(before,1):zero();
    return {userId,name:(now??before)!.name,current:a,previous:b,delta:payrollReviewDelta(a,b)};
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.userId.localeCompare(b.userId));
  const currentAmounts=amounts(current.totals,current.totals.employeeCount),previousAmounts=amounts(previous.totals,previous.totals.employeeCount);
  return payrollReviewSchema.parse({schemaVersion:1,asOf:current.report.asOf,timezone:current.report.timezone,query:current.report.query,
    periods:{current:period(current.report,expected.days),previous:period(previous.report,expected.days)},
    totals:{current:currentAmounts,previous:previousAmounts,delta:payrollReviewDelta(currentAmounts,previousAmounts)},employees,
    series:{current:current.report.buckets,previous:previous.report.buckets},
    preparation:{status:'review_required',openSegmentCount:current.totals.ongoingSegmentCount,employeesWithOpenSegments:current.employees.filter(row=>row.ongoingSegmentCount>0).length,
      pendingCorrections:{status:'not_included',count:null,notice:'Pending corrections are not counted in this summary. Open Time records to review requests under their separate whole-shift access rules.'}},
    evidence:{sourceSchemaVersion:2,precisionVersion:2,durationUnit:'microsecond',currentSourceRows:current.report.sourceRowCount,previousSourceRows:previous.report.sourceRowCount},
    notice:'Preparation evidence, not approved, calculated or certified payroll. Equal calendar-day periods can contain different elapsed hours across daylight saving time. An in-progress period is compared as captured, not projected or normalized to a complete period. Exact signed microseconds are authoritative; display hours and percentages round half-up to six places after aggregation. A zero previous work total has no percentage comparison. Open counts are source segments with no recorded end in the selected range, not whole-shift status. Counts include zero-contribution sources. Pay, overtime, paid-break, leave and tax policies are not calculated.',
  });
}
