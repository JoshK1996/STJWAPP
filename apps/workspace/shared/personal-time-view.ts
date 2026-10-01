import {DateTime} from 'luxon';

export type PersonalTimeCalendarPeriod = 'day'|'week'|'month'|'year';

function calendarDate(value:string){
 const date=DateTime.fromISO(value,{zone:'UTC'});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!date.isValid||date.toISODate()!==value||value<'1900-01-01'||value>'9998-12-31')throw new RangeError('Choose a valid calendar date from 1900 through 9998.');
 return date;
}

/** Calendar movement starts at the period boundary, so month ends cannot drift. */
export function movePersonalTimeAnchor(value:string,period:PersonalTimeCalendarPeriod,direction:-1|1):string{
 const date=calendarDate(value).startOf(period);
 const next=date.plus(period==='day'?{days:direction}:period==='week'?{weeks:direction}:period==='month'?{months:direction}:{years:direction});
 if(next.year<1900||next.year>9998)throw new RangeError('Choose a date from 1900 through 9998.');
 return next.toISODate()!;
}

export function personalTimeCustomError(from:string,to:string):string{
 try{
  const start=calendarDate(from),end=calendarDate(to),days=end.diff(start,'days').days;
  if(days<0)return 'The ending date must be on or after the starting date.';
  if(days>365)return 'Choose up to 366 days, or use All time for your complete history.';
  return '';
 }catch{return 'Choose both a valid starting date and ending date.';}
}

/** A readable display only. Source values and aggregation remain whole microseconds. */
export function personalTimeDuration(value:string):string{
 if(!/^(0|[1-9][0-9]*)$/.test(value))throw new RangeError('Expected a nonnegative duration.');
 const amount=BigInt(value),minute=60_000_000n,hour=3_600_000_000n;
 if(amount===0n)return '0 min';
 if(amount<minute)return '<1 min';
 return `${amount%minute?'≈ ':''}${amount>=hour?`${(amount/hour).toLocaleString('en-US')}h `:''}${(amount%hour)/minute}m`;
}

export function personalTimeCommunities(jobs:readonly {unitId:string;unitName:string;workMicroseconds:string;breakMicroseconds:string}[]){
 const groups=new Map<string,{unitId:string;unitName:string;work:bigint;breaks:bigint}>();
 for(const job of jobs){
  const group=groups.get(job.unitId)??{unitId:job.unitId,unitName:job.unitName,work:0n,breaks:0n};
  group.work+=BigInt(job.workMicroseconds);group.breaks+=BigInt(job.breakMicroseconds);groups.set(job.unitId,group);
 }
 return [...groups.values()].sort((a,b)=>a.work>b.work?-1:a.work<b.work?1:a.unitName.localeCompare(b.unitName)).map(({work,breaks,...group})=>({...group,workMicroseconds:work.toString(),breakMicroseconds:breaks.toString()}));
}
