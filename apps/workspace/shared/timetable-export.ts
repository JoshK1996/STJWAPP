import { z } from "zod";
import { dateOnly } from "./contracts";

export const timetableExportLimits = { occurrences: 2000, bytes: 5 * 1024 * 1024 } as const;
export const timetableCalendarExportInput = z.object({
  unitId: z.uuid(), yearId: z.uuid(), from: dateOnly, to: dateOnly,
  sectionId: z.uuid().optional(), teacherId: z.uuid().optional(),
  studentNumber: z.string().trim().min(1).max(40).optional(),
  expectedRevision: z.number().int().min(0).max(2147483647),
}).strict().refine(x => x.to >= x.from && Date.parse(x.to) - Date.parse(x.from) <= 366 * 86400000,
  "Choose an inclusive range of at most 367 calendar days.");
export type TimetableCalendarExportInput = z.infer<typeof timetableCalendarExportInput>;
export type TimetableCalendarMetadata = { revision: number; calendarRevisedAt: string };
