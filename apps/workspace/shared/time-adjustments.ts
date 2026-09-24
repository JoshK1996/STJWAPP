import { z } from "zod";
import { dateOnly } from "./contracts";

export const timeAdjustmentLimits = Object.freeze({ segments: 200, page: 50, evidenceBytes: 1024 * 1024 });
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().max(2147483647);
const name = z.string().min(1).max(200), reason = z.string().trim().min(10).max(2000), text = z.string().min(1).max(500);
export const enteredTimeInstant = z.iso.datetime().refine(value => (value.match(/\.(\d+)Z$/)?.[1].length ?? 0) <= 3, "Use a UTC instant with no more than millisecond precision.").transform(value => new Date(value).toISOString());
export const recordedTimeInstant = z.iso.datetime().refine(value => (value.match(/\.(\d+)Z$/)?.[1].length ?? 0) <= 6, "Unsupported recorded timestamp precision.");
export const completedTimeSegment = z.object({ jobId: id, kind: z.enum(["work", "break"]), startedAt: enteredTimeInstant, endedAt: enteredTimeInstant }).strict();
export const proposeTimeAdjustmentInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing_shift"), employeeId: id, segments: z.array(completedTimeSegment).min(1).max(timeAdjustmentLimits.segments), reason, commandId: id }).strict(),
  z.object({ kind: z.literal("close_open_shift"), shiftId: id, sourceHash: hash, endedAt: enteredTimeInstant, reason, commandId: id }).strict(),
]);
export const reviewTimeAdjustmentInput = z.object({ version: z.literal(1), requestHash: hash, status: z.enum(["approved", "declined"]), note: reason, commandId: id }).strict();
export const cancelTimeAdjustmentInput = z.object({ version: z.literal(1), requestHash: hash, reason, commandId: id }).strict();
export const timeAdjustmentListInput = z.object({ start: dateOnly.optional(), end: dateOnly.optional(), employeeId: id.optional(), kind: z.enum(["missing_shift", "close_open_shift"]).optional(),
  sourceShiftId: id.optional(), status: z.enum(["pending", "approved", "declined", "cancelled"]).optional(), cursor: z.string().min(1).max(400).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict()
  .refine(value => Boolean(value.start) === Boolean(value.end) && (Boolean(value.start) || Boolean(value.sourceShiftId)), "Supply both start/end dates, or an exact sourceShiftId.");
export const timeAdjustmentExportInput = z.object({ format: z.enum(["json", "csv"]), version: z.enum(["1", "2"]).optional() }).strict();
export const timeAdjustmentSourceInput = z.object({ shiftId: id }).strict();
export const timeAdjustmentOptionsInput = z.object({ employeeId: id }).strict();
export const openTimeShiftsInput = z.object({ employeeId: id.optional(), cursor: z.string().min(1).max(400).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const identity = z.object({ id, name }).strict();
export const timeEvidenceSegmentSchema = z.object({ id: id.nullable(), jobId: id, jobTitle: name, unitId: id, unitName: name,
  kind: z.enum(["work", "break"]), startedAt: recordedTimeInstant, endedAt: recordedTimeInstant.nullable() }).strict();
export const timeSnapshotSchema = z.object({ schemaVersion: z.literal(1), orgId: id, employee: identity,
  shift: z.object({ id: id.nullable(), revision: positive.nullable(), startedAt: recordedTimeInstant, endedAt: recordedTimeInstant.nullable() }).strict(),
  segments: z.array(timeEvidenceSegmentSchema).min(1).max(timeAdjustmentLimits.segments),
  totals: z.object({ workMicroseconds: z.string().regex(/^\d+$/), breakMicroseconds: z.string().regex(/^\d+$/), totalMicroseconds: z.string().regex(/^\d+$/) }).strict().nullable(),
}).strict();
export const timeAdjustmentScopeSchema = z.object({ jobIds: z.array(id).min(1).max(timeAdjustmentLimits.segments), unitIds: z.array(id).min(1).max(timeAdjustmentLimits.segments) }).strict();
export const timeAdjustmentRequestSchema = z.object({ schemaVersion: z.literal(1), id, orgId: id, kind: z.enum(["missing_shift", "close_open_shift"]), employee: identity,
  proposedBy: identity, createdAt: recordedTimeInstant, reason, source: timeSnapshotSchema.nullable(), sourceHash: hash.nullable(), proposed: timeSnapshotSchema,
  scope: timeAdjustmentScopeSchema, status: z.enum(["pending", "approved", "declined", "cancelled"]), version: z.union([z.literal(1), z.literal(2)]),
  resolvedBy: identity.nullable(), resolutionNote: z.string().min(10).max(2000).nullable(), resolvedAt: recordedTimeInstant.nullable(), resultShiftId: id.nullable(), resultRevision: positive.nullable(),
}).strict();
export const timeAdjustmentEnvelopeSchema = z.object({ request: timeAdjustmentRequestSchema, requestHash: hash, result: timeSnapshotSchema.nullable(), resultHash: hash.nullable() }).strict();
export const timeAdjustmentReceiptSchema = z.object({ requestId: id, version: z.union([z.literal(1), z.literal(2)]), status: z.enum(["pending", "approved", "declined", "cancelled"]),
  resultShiftId: id.nullable(), resultRevision: positive.nullable(), historyHash: hash }).strict();
export const timeAdjustmentReadinessSchema = z.object({ state: z.enum(["ready", "blocked", "stale", "resolved"]), issues: z.array(z.object({
  code: z.enum(["source_changed", "source_not_open", "overlap", "jobs_unavailable", "invalid_source", "future_end"]), message: text }).strict()).max(6) }).strict();
export const timeAdjustmentDetailSchema = timeAdjustmentEnvelopeSchema.extend({ readiness: timeAdjustmentReadinessSchema,
  allowedActions: z.object({ approve: z.boolean(), decline: z.boolean(), cancel: z.boolean() }).strict() }).strict();
export const timeAdjustmentSourceSchema = z.object({ source: timeSnapshotSchema, sourceHash: hash, observedAt: recordedTimeInstant, timezone: z.string().min(1).max(100),
  allowedActions: z.object({ propose: z.boolean() }).strict() }).strict();
export const timeAdjustmentOptionsSchema = z.object({ employee: identity.extend({ active: z.boolean() }).strict(), timezone: z.string().min(1).max(100),
  jobs: z.array(z.object({ id, title: name, unitId: id, unitName: name }).strict()).max(200), allowedActions: z.object({ proposeMissing: z.boolean() }).strict() }).strict();
export const timeAdjustmentHistoryEntrySchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), action: z.enum(["proposed", "approved", "declined", "cancelled"]),
  actor: identity, reason: z.string().min(10).max(2000), createdAt: recordedTimeInstant, snapshot: timeAdjustmentEnvelopeSchema, snapshotHash: hash }).strict();
export const timeAdjustmentHistorySchema = z.object({ items: z.array(timeAdjustmentHistoryEntrySchema).min(1).max(2) }).strict();
export const timeAdjustmentSummarySchema = z.object({ id, kind: z.enum(["missing_shift", "close_open_shift"]), employee: identity, proposedBy: identity,
  createdAt: recordedTimeInstant, startedAt: recordedTimeInstant, endedAt: recordedTimeInstant, version: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(["pending", "approved", "declined", "cancelled"]), requestHash: hash, sourceShiftId: id.nullable(), resultShiftId: id.nullable(), resultRevision: positive.nullable() }).strict();
export const timeAdjustmentListSchema = z.object({ items: z.array(timeAdjustmentSummarySchema).max(timeAdjustmentLimits.page), nextCursor: z.string().max(400).nullable(), timezone: z.string().min(1).max(100) }).strict();
export const openTimeShiftsSchema = z.object({ items: z.array(z.object({ shiftId: id, employee: identity, startedAt: recordedTimeInstant, revision: positive,
  pendingRequests: z.number().int().min(0).max(2147483647) }).strict()).max(timeAdjustmentLimits.page), nextCursor: z.string().max(400).nullable(),
  timezone: z.string().min(1).max(100), observedAt: recordedTimeInstant }).strict();
export type TimeSnapshot = z.infer<typeof timeSnapshotSchema>;
export type TimeAdjustmentRequest = z.infer<typeof timeAdjustmentRequestSchema>;
export type TimeAdjustmentEnvelope = z.infer<typeof timeAdjustmentEnvelopeSchema>;
export type TimeAdjustmentReceipt = z.infer<typeof timeAdjustmentReceiptSchema>;
export type TimeAdjustmentDetail = z.infer<typeof timeAdjustmentDetailSchema>;
export type TimeAdjustmentSource = z.infer<typeof timeAdjustmentSourceSchema>;
export type TimeAdjustmentOptions = z.infer<typeof timeAdjustmentOptionsSchema>;
export type TimeAdjustmentHistory = z.infer<typeof timeAdjustmentHistorySchema>;
export type TimeAdjustmentList = z.infer<typeof timeAdjustmentListSchema>;
export type OpenTimeShifts = z.infer<typeof openTimeShiftsSchema>;
