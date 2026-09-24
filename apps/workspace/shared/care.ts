import { z } from "zod";
import { dateOnly } from "./contracts";
const reason = z.string().trim().min(5).max(1000);
export const careProgramInput = z
  .object({
    unitId: z.uuid(),
    name: z.string().trim().min(2).max(100),
    room: z.string().trim().min(1).max(100),
    capacity: z.number().int().min(1).max(200),
    instructions: z.string().trim().min(5).max(3000),
    confirmed: z.boolean(),
    archived: z.boolean(),
    staffIds: z
      .array(z.uuid())
      .max(100)
      .refine((x) => new Set(x).size === x.length),
    version: z.number().int().nonnegative(),
    reason,
  })
  .strict();
export const careEnrollmentInput = z
  .object({
    studentId: z.uuid(),
    startsOn: dateOnly,
    endsOn: dateOnly,
    enabled: z.boolean(),
    version: z.number().int().nonnegative(),
    reason,
  })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, "End date must follow start date.");
export const careCheckinInput = z
  .object({
    programId: z.uuid(),
    programVersion: z.number().int().positive(),
    studentId: z.uuid(),
    arrivalName: z.string().trim().min(2).max(100),
    received: z.literal(true),
    commandId: z.uuid(),
  })
  .strict();
export const careCheckoutInput = z
  .object({
    contactId: z.uuid(),
    contactVersion: z.number().int().positive(),
    personVersion: z.number().int().positive(),
    identityMethod: z.enum(["photo_id", "personally_known"]),
    identityConfirmed: z.literal(true),
    released: z.literal(true),
    note: z.string().trim().max(1000),
    commandId: z.uuid(),
  })
  .strict();
export const careHoldInput = z
  .object({
    active: z.boolean(),
    version: z.number().int().nonnegative(),
    reason,
  })
  .strict();
export const careReportInput = z
  .object({
    programId: z.uuid(),
    from: dateOnly,
    to: dateOnly,
    studentId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (x) =>
      x.to >= x.from && Date.parse(x.to) - Date.parse(x.from) <= 366 * 86400000,
    "Choose a date range of at most 367 days.",
  );
// Clip exact elapsed time to a report window. No rounding of individual sessions.
export function careMilliseconds(
  start: string,
  end: string | null,
  from: string,
  to: string,
  asOf: string,
) {
  const left = Math.max(Date.parse(start), Date.parse(from));
  const right = Math.min(
    Date.parse(end ?? asOf),
    Date.parse(to),
    Date.parse(asOf),
  );
  return Math.max(0, right - left);
}
