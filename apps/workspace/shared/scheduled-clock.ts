import { z } from 'zod';

export const clockPolicyInput=z.object({noEarlyClockIn:z.boolean(),expectedVersion:z.number().int().min(0).max(2147483646)}).strict();
export const cancelPreclockInput=z.object({version:z.number().int().positive(),commandId:z.uuid()}).strict();
export type ClockPolicy={noEarlyClockIn:boolean;version:number};
export type PreclockIntent={
  id:string;version:number;status:'pending'|'executed'|'cancelled'|'blocked';
  jobId:string;jobTitle:string;unitName:string;scheduleId:string;scheduleVersion:number;
  startsAt:string;endsAt:string;createdAt:string;processedAt:string|null;reason:string;shiftId:string|null;
};
export type PreclockSchedule={scheduleId:string;scheduleVersion:number;jobId:string;startsAt:string;endsAt:string;phase:'current'|'upcoming'};
export type PreclockState={policy:ClockPolicy;pending:PreclockIntent|null;latest:PreclockIntent|null;schedules:PreclockSchedule[];timezone:string};
