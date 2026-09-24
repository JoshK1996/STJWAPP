import { z } from "zod";

export const gradeImportColumns = [
  "assignmentId",
  "bookVersion",
  "assignmentVersion",
  "studentId",
  "studentName",
  "status",
  "points",
  "note",
] as const;
export const gradeImportPreviewInput = z
  .object({
    csv: z.string().min(1).max(400000),
    reason: z.string().trim().min(5).max(2000),
  })
  .strict();
export const gradeImportApplyInput = z
  .object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
  })
  .strict();
