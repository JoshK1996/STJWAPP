import { z } from "zod";
import { dateOnly } from "./contracts";
export const attendanceReportScope = z
  .object({
    unitId: z.uuid(),
    yearId: z.uuid(),
    sectionIds: z
      .array(z.uuid())
      .max(50)
      .default([])
      .refine((x) => new Set(x).size === x.length, "Choose each class once."),
  })
  .strict();
export const attendanceReportInput = attendanceReportScope
  .extend({
    from: dateOnly,
    to: dateOnly,
    period: z.string().trim().min(1).max(40),
    studentNumber: z.string().trim().max(40).default(""),
    recordedOnly: z.boolean().default(true),
    includeNotes: z.boolean().default(false),
  })
  .strict()
  .refine(
    (x) =>
      x.to >= x.from && Date.parse(x.to) - Date.parse(x.from) <= 366 * 86400000,
    "Choose at most 367 days.",
  );
export type AttendanceReportInput = z.infer<typeof attendanceReportInput>;
export const attendanceReportColumns = [
  ["date", "Date"],
  ["period", "Period"],
  ["class_name", "Class"],
  ["student_name", "Student"],
  ["student_number", "Student number"],
  ["record_status", "Record status"],
  ["code", "Recorded code"],
  ["category", "Recorded category"],
  ["excused", "Excused"],
  ["code_label", "Recorded code label"],
  ["note", "Attendance note"],
  ["roster_current", "Roster matches today’s source"],
  ["instructional_now", "Currently instructional"],
  ["session_id", "Attendance session ID"],
  ["session_version", "Attendance revision"],
  ["submitted_at", "Submitted at (UTC)"],
  ["student_id", "Student ID"],
  ["section_id", "Class ID"],
].map(([key, label]) => ({ key, label }));
