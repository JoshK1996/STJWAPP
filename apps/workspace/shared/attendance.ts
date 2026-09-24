import { z } from "zod";
import { dateOnly } from "./contracts";
export const attendanceSettingsInput = z
  .object({
    unitId: z.uuid(),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine(
        (values) => new Set(values).size === values.length,
        "Choose each weekday once.",
      ),
    periods: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(12)
      .refine(
        (values) =>
          new Set(values.map((value) => value.toLowerCase())).size ===
          values.length,
        "Use unique period names.",
      ),
    confirmed: z.boolean(),
    version: z.number().int().nonnegative(),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export const attendanceCodeInput = z
  .object({
    unitId: z.uuid(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .regex(/^[A-Za-z0-9_-]+$/),
    label: z.string().trim().min(2).max(80),
    category: z.enum(["present", "absent", "tardy", "early", "other"]),
    excused: z.boolean(),
    reasonRequired: z.boolean(),
    active: z.boolean().default(true),
  })
  .strict();
export const attendanceDayInput = z
  .object({
    unitId: z.uuid(),
    yearId: z.uuid(),
    date: dateOnly,
    instructional: z.boolean(),
    label: z.string().trim().min(3).max(200),
    version: z.number().int().nonnegative().default(0),
  })
  .strict();
export const attendanceOpenInput = z
  .object({
    sectionId: z.uuid(),
    date: dateOnly,
    period: z.string().trim().min(1).max(40),
  })
  .strict();
export const attendanceSaveInput = z
  .object({
    version: z.number().int().positive(),
    submit: z.boolean(),
    reason: z.string().trim().max(1000).default(""),
    marks: z
      .array(
        z
          .object({
            studentId: z.uuid(),
            codeId: z.uuid().nullable(),
            note: z.string().trim().max(1000).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .refine(
        (values) =>
          new Set(values.map((value) => value.studentId)).size ===
          values.length,
        "Each student must appear once.",
      ),
  })
  .strict();
export const attendanceOverviewInput = z
  .object({
    unitId: z.uuid(),
    yearId: z.uuid(),
    date: dateOnly,
    period: z.string().trim().min(1).max(40),
  })
  .strict();
export const attendanceCloseInput = attendanceOverviewInput
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(10).max(1000),
    acknowledgeUnexcused: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .strict();
