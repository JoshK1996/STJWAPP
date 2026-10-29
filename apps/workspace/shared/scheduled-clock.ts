import { z } from 'zod';
import { clockRulesSchema, type ClockRules } from './clock-rules';

/** `rules` is optional so existing clients that only send the early-clock-in choice leave saved rules unchanged; null clears them. */
export const clockPolicyInput=z.object({noEarlyClockIn:z.boolean(),rules:clockRulesSchema.nullable().optional(),expectedVersion:z.number().int().min(0).max(2147483646)}).strict();
export const cancelPreclockInput=z.object({version:z.number().int().positive(),commandId:z.uuid()}).strict();
export type ClockPolicy={noEarlyClockIn:boolean;rules:ClockRules|null;version:number};
export type PreclockIntent={
  id:string;version:number;status:'pending'|'executed'|'cancelled'|'blocked';source:'schedule'|'rule';
  jobId:string;jobTitle:string;unitName:string;scheduleId:string|null;scheduleVersion:number|null;
  startsAt:string;endsAt:string;createdAt:string;processedAt:string|null;reason:string;shiftId:string|null;
};
export type PreclockSchedule={scheduleId:string;scheduleVersion:number;jobId:string;startsAt:string;endsAt:string;phase:'current'|'upcoming'};
export type PreclockState={policy:ClockPolicy;pending:PreclockIntent|null;latest:PreclockIntent|null;schedules:PreclockSchedule[];timezone:string;/** Today's limits in plain words, or null when this employee has none. */todayRules:string|null};
