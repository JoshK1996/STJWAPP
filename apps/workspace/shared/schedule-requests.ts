import { z } from "zod";
import type { StaffScheduleSnapshot } from "./staff-scheduling";

const version = z.number().int().positive().max(2147483646);
const reason = z.string().trim().min(3).max(1000);
const proposal = z.object({ jobId: z.uuid(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).strict()
  .refine(x => Date.parse(x.endsAt) > Date.parse(x.startsAt) && Date.parse(x.endsAt) - Date.parse(x.startsAt) <= 86400000,
    "A scheduled shift must last more than zero and no longer than 24 hours.");
const submission = { scheduleId: z.uuid(), expectedScheduleVersion: version, reason, commandId: z.uuid() };
export const scheduleRequestCreateInput = z.discriminatedUnion("action", [
  z.object({ ...submission, action: z.literal("update"), proposal }).strict(),
  z.object({ ...submission, action: z.literal("cancel") }).strict(),
]);
const decision = { expectedRequestVersion: version, proposalHash: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.uuid() };
export const scheduleRequestReviewInput = z.object({ ...decision, decision: z.enum(["approved", "declined"]), note: reason, reviewed: z.literal(true) }).strict();
export const scheduleRequestWithdrawInput = z.object({ ...decision, reason }).strict();
export const scheduleRequestQuery = z.object({
  view: z.enum(["own", "team"]).default("own"),
  status: z.enum(["pending", "approved", "declined", "withdrawn", "all"]).default("pending"),
  scheduleId: z.uuid().optional(), cursor: z.string().min(1).max(500).optional(),
}).strict();
export type ScheduleRequestCreate = z.infer<typeof scheduleRequestCreateInput>;
export type ScheduleRequestReview = z.infer<typeof scheduleRequestReviewInput>;
export type ScheduleRequestWithdraw = z.infer<typeof scheduleRequestWithdrawInput>;
export type ScheduleRequestQuery = z.infer<typeof scheduleRequestQuery>;
export type ScheduleRequestStatus = "pending" | "approved" | "declined" | "withdrawn";
export type ScheduleRequestProposal = {
  jobId: string; jobTitle: string; unitId: string; unitName: string; startsAt: string; endsAt: string;
};
export type AppliedSchedule = { id: string; version: number; status: "scheduled" | "cancelled" };
export type ScheduleRequestSummary = {
  id: string; version: 1 | 2; status: ScheduleRequestStatus; action: "update" | "cancel";
  requester: { id: string; nameSnapshot: string }; submittedAt: string; decidedAt: string | null;
  source: StaffScheduleSnapshot; proposal: ScheduleRequestProposal | null; appliedSchedule: AppliedSchedule | null;
};
export type ScheduleRequestBlocker = {
  code: "SCHEDULE_CHANGED" | "SCHEDULE_CANCELLED" | "EMPLOYEE_INACTIVE" | "SOURCE_UNIT_CHANGED" | "TARGET_UNIT_CHANGED"
    | "TARGET_JOB_INACTIVE" | "TARGET_JOB_UNASSIGNED" | "OVERLAP" | "NO_FIELD_CHANGE";
  message: string;
};
export type ScheduleRequestDetail = ScheduleRequestSummary & {
  reason: string; proposalHash: string; current: StaffScheduleSnapshot;
  decision: null | { actor: { id: string; nameSnapshot: string }; note: string; at: string };
  allowedActions: { approve: boolean; decline: boolean; withdraw: boolean }; blockers: ScheduleRequestBlocker[];
};
export type ScheduleRequestHistoryRow = {
  id: string; requestVersion: 1 | 2; action: "submitted" | "approved" | "declined" | "withdrawn";
  actor: { id: string; nameSnapshot: string; roleSnapshot: string }; at: string; reason: string;
  before: null | { version: number; status: ScheduleRequestStatus }; after: { version: number; status: ScheduleRequestStatus };
  appliedSchedule: AppliedSchedule | null;
};
export type ScheduleRequestCreated = { id: string; version: 1; status: "pending"; proposalHash: string };
export type ScheduleRequestDecided = { id: string; version: 2; status: Exclude<ScheduleRequestStatus, "pending">; appliedSchedule: AppliedSchedule | null };
export type ScheduleRequestList = { rows: ScheduleRequestSummary[]; nextCursor: string | null };
