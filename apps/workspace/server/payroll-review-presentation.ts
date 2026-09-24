import type { PayrollReview } from '../shared/payroll-review';
import { formatReportDecimal,formatReportHours,formatReportValue } from '../shared/report-presentation';
import { toCsv } from './reports';

export function payrollReviewPresentationCsv(value:PayrollReview):string{
  const columns=['Employee','Selected work hours','Previous work hours','Work hours change','Work change (%)','Selected break hours','Previous break hours','Break hours change','Selected open records','Previous open records','Selected period','Previous period','Selected period status','Previous period status','Captured','Time zone','Notes'];
  const period=(side:'current'|'previous')=>`${formatReportValue('date',value.periods[side].start,{timezone:value.timezone})} – ${formatReportValue('date',value.periods[side].end,{timezone:value.timezone})}`;
  const names=new Map<string,number>(),seen=new Map<string,number>();
  for(const employee of value.employees)names.set(employee.name,(names.get(employee.name)??0)+1);
  const rows=value.employees.map(item=>{
    const occurrence=(seen.get(item.name)??0)+1;seen.set(item.name,occurrence);
    return {'Employee':(names.get(item.name)??0)>1?`${item.name} (person ${occurrence})`:item.name,
      'Selected work hours':formatReportHours(item.current.workMicroseconds),'Previous work hours':formatReportHours(item.previous.workMicroseconds),
      'Work hours change':formatReportHours(item.delta.workMicroseconds),'Work change (%)':item.delta.workPercentChange===null?'No previous work baseline':formatReportDecimal(item.delta.workPercentChange),
      'Selected break hours':formatReportHours(item.current.breakMicroseconds),'Previous break hours':formatReportHours(item.previous.breakMicroseconds),'Break hours change':formatReportHours(item.delta.breakMicroseconds),
      'Selected open records':item.current.ongoingSegmentCount,'Previous open records':item.previous.ongoingSegmentCount,
      'Selected period':period('current'),'Previous period':period('previous'),
      'Selected period status':value.periods.current.status.replaceAll('_',' '),'Previous period status':value.periods.previous.status.replaceAll('_',' '),
      'Captured':formatReportValue('captured_at',value.asOf,{timezone:value.timezone}),'Time zone':value.timezone,
      'Notes':'Hours rounded after exact aggregation. No pay calculation or approval. Incomplete periods are not projected. Same-name person numbers apply within this report. Exact evidence remains in JSON.',
    };
  });
  return toCsv(rows,columns);
}
