import { z } from "zod";
import { dateOnly } from "./contracts";
import { recordedTimeInstant } from "./time-adjustments";
export const timeSegmentInput = z
  .object({
    jobId: z.uuid(),
    kind: z.enum(["work", "break"]),
    // Higher precision is only accepted by the service when it exactly matches
    // a boundary in the locked original source. Edited values use milliseconds.
    startedAt: recordedTimeInstant,
    endedAt: recordedTimeInstant,
  })
  .strict();
export const correctionInput = z
  .object({
    shiftId: z.uuid(),
    sourceRevision: z.number().int().positive(),
    commandId: z.uuid(),
    reason: z.string().trim().min(10).max(2000),
    segments: z.array(timeSegmentInput).min(1).max(200),
  })
  .strict();
export const correctionReviewInput = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(["approved", "declined"]),
    note: z.string().trim().min(10).max(2000),
  })
  .strict();
export const timeRecordsQuery = z
  .object({
    start: dateOnly,
    end: dateOnly,
    userId: z.uuid().optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
