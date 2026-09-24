import { formatReportValue } from './report-presentation';
import type { WorkforceReportV2 } from './workforce-reports-v2';

export const workforcePresentationLabels:Record<string,string>={
  employee_name:'Employee',unit_name:'Community',job_title:'Job',kind:'Work / break',started_at:'Recorded start',ended_at:'Recorded end',
  recorded_duration_microseconds:'Full recorded hours',clipped_started_at:'Included start',clipped_ended_at:'Included end',duration_microseconds:'Included hours',shift_id:'Shift reference',id:'Segment reference',revision:'Shift revision',
};
export const defaultWorkforcePresentationColumns=['employee_name','unit_name','job_title','kind','clipped_started_at','clipped_ended_at','duration_microseconds'];
export function workforcePresentationValue(key:string,value:unknown,zone:string):string{
  if(value==null)return key==='ended_at'||key==='recorded_duration_microseconds'?'Open record':key.startsWith('clipped_')?'No contribution':'—';
  return formatReportValue(key,value,{timezone:zone,source:'workforce',decimals:2});
}
/** Human-facing view only. Exact report rows and dates are never modified. */
export function workforcePresentationRows(report:WorkforceReportV2,columns:readonly string[]){
  return report.rows.map(row=>Object.fromEntries([
    ...columns.map(column=>[workforcePresentationLabels[column],workforcePresentationValue(column,row[column as keyof typeof row],report.timezone)]),
    ['Time zone',report.timezone],['Period from',formatReportValue('date',report.query.start,{timezone:report.timezone})],
    ['Period through',formatReportValue('date',report.query.end,{timezone:report.timezone})],
    ['Captured',formatReportValue('captured_at',report.asOf,{timezone:report.timezone})],
    ['Report notes','Recorded hours rounded to 2 decimal places for display; not calculated pay. Open records run through capture time. Exact values remain in audit CSV / source JSON.'],
  ]));
}
