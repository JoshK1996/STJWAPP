import type {Database,Queryable} from './db';
import {audit,canReport,requireCondition,type Actor} from './security';
import {readWorkforceReportSourceV2} from './reports-v2';
import {toCsv} from './reports';
import {withAuthorizedWorkforceSource,type WorkforceReportProof} from './workforce-report-access';
import {buildPayrollReview,previousPayrollReviewQuery,payrollReviewQuerySchema,payrollReviewExportQuerySchema,payrollReviewLimits,type PayrollReview} from '../shared/payroll-review';

function payload(value:PayrollReview){
  const text=JSON.stringify(value)+'\n';
  requireCondition(Buffer.byteLength(text)<=payrollReviewLimits.responseBytes,413,'This payroll comparison is too large. Choose a shorter range or a single employee/unit.');
  return text;
}
function prepare(raw:unknown){
  const parsed=payrollReviewQuerySchema.safeParse(raw);
  requireCondition(parsed.success,400,'Choose a valid payroll comparison query: at most 367 dates, or 32 hourly dates.');
  try{return {query:parsed.data,previous:previousPayrollReviewQuery(parsed.data).query};}
  catch{requireCondition(false,400,'The preceding comparison period falls outside supported calendar dates.');}
}
async function withReview<T>(db:Database,actor:Actor,proof:WorkforceReportProof,raw:unknown,publish:(value:PayrollReview,tx:Queryable,current:Actor)=>Promise<T>){
  const {query,previous}=prepare(raw);
  return withAuthorizedWorkforceSource(db,actor,proof,async(tx,current)=>{
    requireCondition(canReport(current),403,'A current reporting role is required for payroll preparation.');
    const selected=await readWorkforceReportSourceV2(tx,current,query);
    const prior=await readWorkforceReportSourceV2(tx,current,previous,{asOf:selected.asOf});
    return {selected,prior};
  },async(tx,current,source)=>{const result=buildPayrollReview(source.selected,source.prior);payload(result);return publish(result,tx,current);},{repeatableRead:true});
}
export function getAuthorizedPayrollReview(db:Database,actor:Actor,proof:WorkforceReportProof,raw:unknown){
  return withReview(db,actor,proof,raw,async value=>value);
}
export const payrollReviewCsvColumns=['row_kind','user_id','employee_name','current_work_hours','previous_work_hours','work_delta_hours','work_percent_change','current_break_hours','previous_break_hours','break_delta_hours','current_total_hours','previous_total_hours','total_delta_hours','current_work_microseconds','previous_work_microseconds','work_delta_microseconds','current_break_microseconds','previous_break_microseconds','break_delta_microseconds','current_total_microseconds','previous_total_microseconds','total_delta_microseconds','current_open_segments','previous_open_segments','current_shift_count','previous_shift_count','current_segment_count','previous_segment_count','current_employee_count','previous_employee_count','current_start','current_end','previous_start','previous_end','current_status','previous_status','as_of','timezone','pending_corrections','notice'];
export function payrollReviewCsv(value:PayrollReview):string{
  const evidence={current_start:value.periods.current.start,current_end:value.periods.current.end,previous_start:value.periods.previous.start,previous_end:value.periods.previous.end,current_status:value.periods.current.status,previous_status:value.periods.previous.status,as_of:value.asOf,timezone:value.timezone,pending_corrections:'Not included; review in Time records',notice:value.notice};
  const row=(item:PayrollReview['totals'])=>({
    current_work_hours:item.current.workHours,previous_work_hours:item.previous.workHours,work_delta_hours:item.delta.workHours,work_percent_change:item.delta.workPercentChange??'Not comparable: zero previous work',current_break_hours:item.current.breakHours,previous_break_hours:item.previous.breakHours,break_delta_hours:item.delta.breakHours,current_total_hours:item.current.totalHours,previous_total_hours:item.previous.totalHours,total_delta_hours:item.delta.totalHours,
    current_work_microseconds:item.current.workMicroseconds,previous_work_microseconds:item.previous.workMicroseconds,work_delta_microseconds:item.delta.workMicroseconds,current_break_microseconds:item.current.breakMicroseconds,previous_break_microseconds:item.previous.breakMicroseconds,break_delta_microseconds:item.delta.breakMicroseconds,current_total_microseconds:item.current.totalMicroseconds,previous_total_microseconds:item.previous.totalMicroseconds,total_delta_microseconds:item.delta.totalMicroseconds,
    current_open_segments:item.current.ongoingSegmentCount,previous_open_segments:item.previous.ongoingSegmentCount,current_shift_count:item.current.shiftCount,previous_shift_count:item.previous.shiftCount,current_segment_count:item.current.segmentCount,previous_segment_count:item.previous.segmentCount,current_employee_count:item.current.employeeCount,previous_employee_count:item.previous.employeeCount,
  });
  return toCsv([...value.employees.map(employee=>({row_kind:'employee',user_id:employee.userId,employee_name:employee.name,...row(employee),...evidence})),{row_kind:'total',...row(value.totals),...evidence}],payrollReviewCsvColumns);
}
export function exportAuthorizedPayrollReview(db:Database,actor:Actor,proof:WorkforceReportProof,raw:unknown){
  const {format,...query}=payrollReviewExportQuerySchema.parse(raw);
  return withReview(db,actor,proof,query,async(value,tx,current)=>{
    const body=format==='json'?payload(value):payrollReviewCsv(value);
    requireCondition(Buffer.byteLength(body)<=payrollReviewLimits.outputBytes,413,'This comparison export is too large. Choose a shorter range or a single employee/unit.');
    await audit(tx,current,'payroll.review_exported',null,{query,format,schemaVersion:1,sourceSchemaVersion:2,precisionVersion:2,durationUnit:'microsecond',asOf:value.asOf,currentSourceRows:value.evidence.currentSourceRows,previousSourceRows:value.evidence.previousSourceRows,employeeCount:value.employees.length});
    return {body,format,asOf:value.asOf,query};
  });
}
