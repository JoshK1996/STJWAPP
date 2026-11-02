import {clockDayRule,openDay,weekdayNames,type ClockDayRule,type ClockRules} from './clock-rules';

export const ruleTimeFields=['clockInEarliest','clockInLatest','clockOutEarliest','clockOutLatest'] as const;
export function displayRuleTime(time:string|null):string{
  if(!time)return 'No limit';
  const [hour,minute]=time.split(':').map(Number);
  return `${hour%12||12}:${String(minute).padStart(2,'0')} ${hour<12?'AM':'PM'}`;
}
export function dayRuleSummary(day:ClockDayRule):string{
  if(!day.allowed)return 'Clock-in blocked';
  const start=day.clockInEarliest?displayRuleTime(day.clockInEarliest):'Any time';
  const end=day.clockOutLatest?` → ${displayRuleTime(day.clockOutLatest)}`:'';
  return start+end+(day.jobIds?` · ${day.jobIds.length} job${day.jobIds.length===1?'':'s'}`:' · All jobs');
}
/** New setup starts without inventing time limits; weekends are explicitly closed. */
export const weekdayRules=():ClockRules=>({days:Array.from({length:7},(_,index)=>({...openDay(),allowed:index<5}))});
export function copyDayRule(rules:ClockRules,source:number,targets:number[]):ClockRules{
  return {days:rules.days.map((day,index)=>targets.includes(index)?{...rules.days[source],...(rules.days[source].jobIds?{jobIds:[...rules.days[source].jobIds!]}:{})}:day)};
}
export function dayRuleProblem(day:ClockDayRule,index:number):string{
  const result=clockDayRule.safeParse(day);
  return result.success?'':`${weekdayNames[index]}: ${result.error.issues[0].message}`;
}
