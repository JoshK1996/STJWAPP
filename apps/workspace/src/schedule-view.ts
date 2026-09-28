import { DateTime } from 'luxon';
import { scheduleViewPreferencesSchema, type ScheduleViewPreferences } from '../shared/preferences';
import { planningInstant } from './SchedulePlanningShared';

type ScheduledRow = {id:string;user_id:string;starts_at:string;ends_at:string;status:'scheduled'|'cancelled'};
export function scheduleWindowSummary(rows:ScheduledRow[],range:{start:string;end:string},zone:string) {
  const start=DateTime.fromISO(range.start,{zone}).startOf('day'),end=DateTime.fromISO(range.end,{zone}).startOf('day').plus({days:1});
  if(!start.isValid||!end.isValid||end<=start) return {shifts:0,employees:0,microseconds:0n};
  const first=planningInstant(start.toUTC().toISO()!),last=planningInstant(end.toUTC().toISO()!);
  const employees=new Set<string>(),shifts=new Set<string>();let microseconds=0n;
  for(const row of rows) {
    if(row.status==='cancelled'||shifts.has(row.id))continue;
    const starts=planningInstant(row.starts_at),ends=planningInstant(row.ends_at),left=starts>first?starts:first,right=ends<last?ends:last;
    if(right<=left)continue;
    shifts.add(row.id);employees.add(row.user_id);microseconds+=right-left;
  }
  return {shifts:shifts.size,employees:employees.size,microseconds};
}
export function scheduledTime(microseconds:bigint) {
  const minutes=(microseconds+30_000_000n)/60_000_000n,hours=minutes/60n,remainder=minutes%60n;
  if(microseconds>0n&&minutes===0n)return '<1 min';
  return hours?`${hours.toLocaleString('en-US')}h${remainder?` ${remainder}m`:''}`:`${minutes} min`;
}
export function scheduleDayBar(row:Pick<ScheduledRow,'starts_at'|'ends_at'>,day:string,zone:string) {
  const start=DateTime.fromISO(day,{zone}).startOf('day'),end=start.plus({days:1});
  const duration=end.toMillis()-start.toMillis();
  if(!start.isValid||duration<=0)return {left:0,width:0};
  const left=Math.max(start.toMillis(),Date.parse(row.starts_at)),right=Math.min(end.toMillis(),Date.parse(row.ends_at));
  return {left:Math.max(0,Math.min(100,(left-start.toMillis())/duration*100)),width:Math.max(0,Math.min(100,(right-left)/duration*100))};
}

export function initialScheduleSelection(raw:unknown,target:{mode?:ScheduleViewPreferences['view'];jobId?:string;unitId?:string;userId?:string}|null|undefined,today:string,employees:{id:string}[],jobs:{id:string;unit_id:string}[]) {
  const parsed=scheduleViewPreferencesSchema.safeParse(raw),saved=parsed.success?parsed.data:scheduleViewPreferencesSchema.parse({});
  const chosen={view:target?.mode??(target?'assigned':saved.view),period:saved.period,jobId:target?.jobId??(target?'':saved.jobId??''),unitId:target?.unitId??(target?'':saved.unitId??''),userId:target?.userId??(target?'':saved.employeeId??'')};
  const removed:string[]=[];
  if(!target){
    if(chosen.jobId&&!jobs.some(job=>job.id===chosen.jobId)){chosen.jobId='';removed.push('job');}
    if(chosen.unitId&&!jobs.some(job=>job.unit_id===chosen.unitId)){chosen.unitId='';removed.push('community');}
    if(chosen.userId&&!employees.some(person=>person.id===chosen.userId)){chosen.userId='';removed.push('employee');}
    if(chosen.jobId&&chosen.unitId&&!jobs.some(job=>job.id===chosen.jobId&&job.unit_id===chosen.unitId)){chosen.jobId='';removed.push('job');}
  }
  return {...chosen,anchor:today,notice:removed.length?`Your saved ${removed.join(', ')} filter is no longer available. It has been cleared for this view; save your defaults to update it.`:''};
}
