import { z } from 'zod';
import type { StaffScheduleSnapshot } from './staff-scheduling';

export const planningLimits = { days: 366, rules: 200, targets: 200, occurrences: 5000, slots: 1000, employees: 200, schedules: 20000 } as const;
const date = z.iso.date(), time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(z.uuid()).max(planningLimits.rules).refine(values => new Set(values).size === values.length, 'Do not repeat an identifier.');
const command = { commandId: z.uuid(), reason: z.string().trim().min(3).max(1000) };
const revision = z.number().int().min(0).max(2147483646);
export const planningQuery = z.object({ start: date, end: date, jobId: z.uuid().optional() }).strict()
  .refine(value => Date.parse(value.end) >= Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) < planningLimits.days * 86400000, 'Choose at most 366 calendar days.');
const ruleFields = {
  jobId: z.uuid(), label: z.string().trim().min(2).max(100), startDate: date, endDate: date.nullable(),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']), interval: z.number().int().min(1).max(52),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7), startsLocal: time, endsLocal: time,
  endDayOffset: z.union([z.literal(0), z.literal(1)]), staffCount: z.number().int().min(1).max(100), active: z.boolean(),
};
export const coverageRuleInput = z.object({ ...ruleFields, expectedVersion: revision, ...command }).strict()
  .refine(value => !value.endDate || value.endDate >= value.startDate, 'End date must follow the start date.')
  .refine(value => new Set(value.weekdays).size === value.weekdays.length && (value.frequency === 'weekly' ? value.weekdays.length > 0 : value.weekdays.length === 0), 'Select weekdays only for a weekly rule.')
  .refine(value => { const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3)); const duration = minutes(value.endsLocal) + value.endDayOffset * 1440 - minutes(value.startsLocal); return duration > 0 && duration <= 1440; }, 'A coverage window must be longer than zero and at most 24 wall-clock hours.');
const targetFields = { jobId: z.uuid(), period: z.enum(['day', 'week', 'month', 'year']), hours: z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/), effectiveFrom: date, effectiveThrough: date.nullable(), active: z.boolean() };
export const hoursTargetInput = z.object({ ...targetFields, expectedVersion: revision, ...command }).strict()
  .refine(value => !value.effectiveThrough || value.effectiveThrough >= value.effectiveFrom, 'End date must follow the start date.');
export const planningPreviewInput = z.object({ query: planningQuery, ruleIds: ids.min(1) }).strict();
export const planningApplyInput = z.object({ sourceHash: hash, assignments: z.array(z.object({ slotId: hash, userId: z.uuid() }).strict()).min(1).max(planningLimits.slots), ...command }).strict()
  .refine(value => new Set(value.assignments.map(row => row.slotId)).size === value.assignments.length, 'Choose one employee per open slot.');
export type PlanningQuery = z.infer<typeof planningQuery>;
export type CoverageRuleInput = z.infer<typeof coverageRuleInput>;
export type HoursTargetInput = z.infer<typeof hoursTargetInput>;
export type CoverageRule = Omit<CoverageRuleInput, 'commandId' | 'reason' | 'expectedVersion'> & { id: string; version: number; timezone: string };
export type HoursTarget = Omit<HoursTargetInput, 'commandId' | 'reason' | 'expectedVersion'> & { id: string; version: number };
export type PlanningJob = { id: string; title: string; unitId: string; unitName: string; active: boolean };
export type PlanningEmployee = { id: string; name: string; jobIds: string[]; scheduledMicroseconds: string };
export type CoverageSlice = { startsAt: string; endsAt: string; assigned: number; required: number; missing: number; excess: number; employeeIds: string[] };
export type CoverageOccurrence = { id: string; ruleId: string; date: string; jobId: string; label: string; startsAt: string; endsAt: string; staffCount: number; slices: CoverageSlice[]; requiredMicroseconds: string; filledMicroseconds: string; uncoveredMicroseconds: string; excessMicroseconds: string; conflict: boolean };
export type PlanningWarning = { code: 'SKIPPED_DATE' | 'DST_BLOCKED' | 'RULE_OVERLAP'; message: string; ruleIds: string[]; date: string };
export type TargetPeriod = { targetId: string; jobId: string; period: HoursTarget['period']; start: string; end: string; targetHours: string; targetMicroseconds: string; scheduledMicroseconds: string; deltaMicroseconds: string; partial: boolean; label: string };
export type PlanningWorkspace = { query: PlanningQuery; timezone: string; asOf: string; revision: string; jobs: PlanningJob[]; employees: PlanningEmployee[]; schedules: StaffScheduleSnapshot[]; rules: CoverageRule[]; hoursTargets: HoursTarget[]; occurrences: CoverageOccurrence[]; targetPeriods: TargetPeriod[]; warnings: PlanningWarning[]; totals: { requiredMicroseconds: string; filledMicroseconds: string; uncoveredMicroseconds: string; excessMicroseconds: string }; notice: string };
export type PlanningSlot = { id: string; ruleId: string; occurrenceId: string; date: string; jobId: string; startsAt: string; endsAt: string; position: number };
export type PlanningCandidate = PlanningEmployee & { unavailableSlotIds: string[] };
export type PlanningPreview = { id: string; sourceHash: string; createdAt: string; expiresAt: string; query: PlanningQuery; timezone: string; ruleIds: string[]; slots: PlanningSlot[]; candidates: PlanningCandidate[]; jobs: PlanningJob[]; warnings: PlanningWarning[]; notice: string };
export type PlanningApplied = { id: string; replayed: boolean; schedules: Array<{ id: string; version: number; status: string }>; appliedCount: number };
export type PlanningHistory = { rows: Array<{ version: number; action: string; reason: string; before: unknown; after: unknown; actorName: string; createdAt: string }> };
