import {z} from 'zod';

const ruleSchema=z.object({enabled:z.boolean(),afterMinutes:z.number().int().min(0).max(1440)}).strict();
export const attentionRulesSchema=z.object({overSchedule:ruleSchema,outsideSchedule:ruleSchema}).strict();
export type AttentionRules=z.infer<typeof attentionRulesSchema>;
export const defaultAttentionRules:AttentionRules={overSchedule:{enabled:true,afterMinutes:0},outsideSchedule:{enabled:true,afterMinutes:0}};
export const attentionPolicySchema=z.object({version:z.number().int().nonnegative(),rules:attentionRulesSchema,updatedAt:z.string().datetime({offset:true}).nullable(),updatedByName:z.string().nullable()}).strict();
export type AttentionPolicy=z.infer<typeof attentionPolicySchema>;
export const defaultAttentionPolicy=():AttentionPolicy=>({version:0,rules:attentionRulesSchema.parse(defaultAttentionRules),updatedAt:null,updatedByName:null});
export const attentionPolicyResponseSchema=z.object({policy:attentionPolicySchema,canEdit:z.boolean()}).strict();
export const attentionPolicyInput=z.object({expectedVersion:z.number().int().nonnegative(),commandId:z.uuid(),rules:attentionRulesSchema}).strict();
export const attentionPolicySaveResponseSchema=attentionPolicyResponseSchema.extend({replayed:z.boolean()}).strict();
export const attentionCountsSchema=z.object({overScheduleDays:z.number().int().nonnegative(),outsideScheduleDays:z.number().int().nonnegative()}).strict();
export type AttentionCounts=z.infer<typeof attentionCountsSchema>;
export const allowanceAttentionSchema=z.object({policy:attentionPolicySchema,totals:attentionCountsSchema,
  people:z.array(attentionCountsSchema.extend({userId:z.uuid()}).strict()),
  days:z.array(attentionCountsSchema.extend({date:z.iso.date()}).strict()),
}).strict();
/** Exact comparison only. The threshold changes attention, never the recorded duration. */
export function attentionExceeded(microseconds:string|bigint,rule:AttentionRules[keyof AttentionRules]){
  return rule.enabled&&BigInt(microseconds)>BigInt(rule.afterMinutes)*60_000_000n;
}
/** Existing saved reviews have no captured rules; their original highlights used any positive value. */
export function periodAttention(period:{attention?:z.infer<typeof allowanceAttentionSchema>;totals:{aboveScheduledMicroseconds:string;unscheduledWorkMicroseconds:string};people:{userId:string;aboveScheduledMicroseconds:string;unscheduledWorkMicroseconds:string}[];days:{date:string;aboveScheduledMicroseconds:string;unscheduledWorkMicroseconds:string}[]},key?:{userId:string}|{date:string}):AttentionCounts{
  if(period.attention){const found=!key?period.attention.totals:'userId'in key?period.attention.people.find(value=>value.userId===key.userId):period.attention.days.find(value=>value.date===key.date);return {overScheduleDays:found?.overScheduleDays??0,outsideScheduleDays:found?.outsideScheduleDays??0};}
  const value=!key?period.totals:'userId'in key?period.people.find(value=>value.userId===key.userId):period.days.find(value=>value.date===key.date);
  return {overScheduleDays:value&&BigInt(value.aboveScheduledMicroseconds)>0n?1:0,outsideScheduleDays:value&&BigInt(value.unscheduledWorkMicroseconds)>0n?1:0};
}
