import {z} from 'zod';
import {workforceLocalDateSchema,workforceMicrosecondsSchema,workforceReportQueryV2Schema,workforceUtcMicrosSchema} from './workforce-reports-v2';

export const allowanceMetricsSchema=z.object({
  workMicroseconds:workforceMicrosecondsSchema,breakMicroseconds:workforceMicrosecondsSchema,
  scheduledMicroseconds:workforceMicrosecondsSchema,aboveScheduledMicroseconds:workforceMicrosecondsSchema,
  belowScheduledMicroseconds:workforceMicrosecondsSchema,unscheduledWorkMicroseconds:workforceMicrosecondsSchema,
}).strict();
const metrics=allowanceMetricsSchema.shape;
const jobMetrics={workMicroseconds:metrics.workMicroseconds,breakMicroseconds:metrics.breakMicroseconds,scheduledMicroseconds:metrics.scheduledMicroseconds,unscheduledWorkMicroseconds:metrics.unscheduledWorkMicroseconds};
export const workforceOverviewQuerySchema=z.object({start:workforceLocalDateSchema,end:workforceLocalDateSchema,unitId:z.uuid().optional(),userId:z.uuid().optional()}).strict()
  .refine(value=>workforceReportQueryV2Schema.safeParse({...value,group:'day'}).success,'Choose 1–367 inclusive calendar dates.');
export const allowancePeriodSchema=z.object({
  query:workforceOverviewQuerySchema,totals:allowanceMetricsSchema,
  people:z.array(z.object({userId:z.uuid(),name:z.string(),...metrics}).strict()),
  jobs:z.array(z.object({userId:z.uuid(),employeeName:z.string(),jobId:z.uuid(),jobTitle:z.string(),unitId:z.uuid(),unitName:z.string(),...jobMetrics}).strict()),
  days:z.array(z.object({date:workforceLocalDateSchema,label:z.string(),...metrics}).strict()),
  notice:z.string(),
}).strict();
export const workforceOverviewSchema=z.object({
  asOf:workforceUtcMicrosSchema,timezone:z.string(),organizationName:z.string(),
  today:allowancePeriodSchema,week:allowancePeriodSchema,selected:allowancePeriodSchema,
}).strict();
export type AllowanceMetrics=z.infer<typeof allowanceMetricsSchema>;
export type AllowancePeriod=z.infer<typeof allowancePeriodSchema>;
export type WorkforceOverview=z.infer<typeof workforceOverviewSchema>;
export type WorkforceOverviewQuery=z.infer<typeof workforceOverviewQuerySchema>;

export const allowanceSnapshotInput=z.object({commandId:z.uuid(),query:workforceOverviewQuerySchema}).strict();
export const allowanceSnapshotReceipt=z.object({id:z.uuid(),createdAt:workforceUtcMicrosSchema,replayed:z.boolean()}).strict();
export const allowanceSnapshotSchema=z.object({id:z.uuid(),createdAt:workforceUtcMicrosSchema,createdByName:z.string(),asOf:workforceUtcMicrosSchema,organizationName:z.string(),timezone:z.string(),period:allowancePeriodSchema}).strict();
export const allowanceSnapshotListSchema=z.object({snapshots:z.array(z.object({id:z.uuid(),createdAt:workforceUtcMicrosSchema,createdByName:z.string(),start:workforceLocalDateSchema,end:workforceLocalDateSchema,unitName:z.string().optional(),employeeName:z.string().optional()}).strict())}).strict();
