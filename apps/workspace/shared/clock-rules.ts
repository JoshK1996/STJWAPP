import {z} from 'zod';
import {DateTime} from 'luxon';

/** Per-employee clock rules. Days are ISO weekdays: index 0 is Monday, index 6 is Sunday. Times are organization-local 24-hour HH:MM on the same calendar day. */
const clockTime=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/,'Use a 24-hour time such as 07:30.');
export const clockDayRule=z.object({
  allowed:z.boolean(),
  clockInEarliest:clockTime.nullable(),
  clockInLatest:clockTime.nullable(),
  clockOutEarliest:clockTime.nullable(),
  clockOutLatest:clockTime.nullable(),
}).strict().superRefine((day,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  if(day.clockInEarliest&&day.clockInLatest&&day.clockInEarliest>day.clockInLatest)fail('Earliest clock-in must not be after the latest clock-in.');
  if(day.clockOutEarliest&&day.clockOutLatest&&day.clockOutEarliest>day.clockOutLatest)fail('Earliest clock-out must not be after the latest clock-out.');
  if(day.clockOutLatest&&day.clockInEarliest&&day.clockInEarliest>=day.clockOutLatest)fail('The latest clock-out must be after the earliest clock-in.');
  if(day.clockOutLatest&&day.clockInLatest&&day.clockInLatest>=day.clockOutLatest)fail('The latest clock-in must be before the latest clock-out.');
});
export const clockRulesSchema=z.object({days:z.array(clockDayRule).length(7)}).strict();
export type ClockDayRule=z.infer<typeof clockDayRule>;
export type ClockRules=z.infer<typeof clockRulesSchema>;
export const weekdayNames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] as const;

export const openDay=():ClockDayRule=>({allowed:true,clockInEarliest:null,clockInLatest:null,clockOutEarliest:null,clockOutLatest:null});
export const openRules=():ClockRules=>({days:Array.from({length:7},openDay)});
const isOpen=(day:ClockDayRule)=>day.allowed&&!day.clockInEarliest&&!day.clockInLatest&&!day.clockOutEarliest&&!day.clockOutLatest;
/** A rule set with no restriction is stored as no rules, so employees without limits behave exactly as before. */
export function normalizeClockRules(rules:ClockRules|null|undefined):ClockRules|null{
  if(!rules||rules.days.every(isOpen))return null;
  return rules;
}
export const clockRulesEqual=(a:ClockRules|null|undefined,b:ClockRules|null|undefined)=>JSON.stringify(normalizeClockRules(a)??null)===JSON.stringify(normalizeClockRules(b)??null);

const at=(day:DateTime,time:string)=>{const [hour,minute]=time.split(':').map(Number);return day.startOf('day').set({hour,minute,second:0,millisecond:0});};
const shown=(day:DateTime,time:string)=>at(day,time).setLocale('en-US').toFormat('h:mm a');

export type ClockInDecision=
  |{kind:'allow'}
  |{kind:'blocked';message:string}
  /** Too early: save a pending start that begins automatically at startsAt. endsAt closes the pending window. */
  |{kind:'wait';startsAt:string;endsAt:string;message:string};
export function evaluateClockIn(rules:ClockRules|null|undefined,timezone:string,nowIso:string):ClockInDecision{
  if(!rules)return {kind:'allow'};
  const now=DateTime.fromISO(nowIso,{zone:timezone,locale:'en-US'}),rule=rules.days[now.weekday-1];
  if(!rule.allowed)return {kind:'blocked',message:`Clocking in is not allowed on ${now.weekdayLong}s. Ask a manager if this is a mistake.`};
  if(rule.clockInLatest&&now>at(now,rule.clockInLatest))return {kind:'blocked',message:`The clock-in window closed at ${shown(now,rule.clockInLatest)}. Ask a manager to add your time.`};
  if(rule.clockOutLatest&&now>=at(now,rule.clockOutLatest))return {kind:'blocked',message:`Your work day ended at ${shown(now,rule.clockOutLatest)}. Ask a manager to add your time.`};
  if(rule.clockInEarliest&&now<at(now,rule.clockInEarliest)){
    const startsAt=at(now,rule.clockInEarliest),endsAt=rule.clockOutLatest?at(now,rule.clockOutLatest):now.startOf('day').plus({days:1});
    return {kind:'wait',startsAt:startsAt.toUTC().toISO()!,endsAt:endsAt.toUTC().toISO()!,message:`You can't start before ${shown(now,rule.clockInEarliest)}. Your time will start automatically then.`};
  }
  return {kind:'allow'};
}

/** The latest permitted clock-out instant for a shift, from the rule of the local day it began. Null when there is no usable cutoff. */
export function clockOutCutoff(rules:ClockRules|null|undefined,timezone:string,shiftStartIso:string):string|null{
  if(!rules)return null;
  const start=DateTime.fromISO(shiftStartIso,{zone:timezone}),rule=rules.days[start.weekday-1];
  if(!rule.clockOutLatest)return null;
  const cutoff=at(start,rule.clockOutLatest);
  return cutoff>start?cutoff.toUTC().toISO():null;
}
export type ClockOutDecision={kind:'allow'}|{kind:'blocked';message:string}|{kind:'cap';at:string};
export function evaluateClockOut(rules:ClockRules|null|undefined,timezone:string,shiftStartIso:string,nowIso:string):ClockOutDecision{
  if(!rules)return {kind:'allow'};
  const start=DateTime.fromISO(shiftStartIso,{zone:timezone}),now=DateTime.fromISO(nowIso,{zone:timezone,locale:'en-US'}),rule=rules.days[start.weekday-1];
  const cutoff=clockOutCutoff(rules,timezone,shiftStartIso);
  if(cutoff&&now>=DateTime.fromISO(cutoff))return {kind:'cap',at:cutoff};
  if(rule.clockOutEarliest&&now.hasSame(start,'day')&&now<at(now,rule.clockOutEarliest))
    return {kind:'blocked',message:`You can't clock out before ${shown(now,rule.clockOutEarliest)}. Ask a manager if you need to leave early.`};
  return {kind:'allow'};
}

/** Short employee-facing summary of today's limits, or null when nothing is restricted. */
export function describeToday(rules:ClockRules|null|undefined,timezone:string,nowIso:string):string|null{
  if(!rules)return null;
  const now=DateTime.fromISO(nowIso,{zone:timezone,locale:'en-US'}),rule=rules.days[now.weekday-1];
  if(!rule.allowed)return `Clocking in is not allowed on ${now.weekdayLong}s.`;
  const parts:string[]=[];
  if(rule.clockInEarliest)parts.push(`clock in from ${shown(now,rule.clockInEarliest)}`);
  if(rule.clockInLatest)parts.push(`clock in by ${shown(now,rule.clockInLatest)}`);
  if(rule.clockOutEarliest)parts.push(`clock out from ${shown(now,rule.clockOutEarliest)}`);
  if(rule.clockOutLatest)parts.push(`clock out by ${shown(now,rule.clockOutLatest)} (you are clocked out automatically then)`);
  return parts.length?`Today you can ${parts.join(', ')}.`:null;
}
