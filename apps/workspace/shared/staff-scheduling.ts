import { z } from "zod";

const fields = {
  jobId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  note: z.string().trim().max(500).default(""),
};
const command = {
  reason: z.string().trim().min(3).max(1000),
  commandId: z.uuid(),
};
const version = z.number().int().positive().max(2147483646);
function validRange(input: { startsAt: string; endsAt: string }) {
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt);
  return duration > 0 && duration <= 24 * 60 * 60 * 1000;
}
export const staffScheduleCreateInput = z.object({ userId: z.uuid(), ...fields, ...command }).strict()
  .refine(validRange, "A scheduled shift must last more than zero and no longer than 24 hours.");
export const staffScheduleUpdateInput = z.object({ ...fields, expectedVersion: version, ...command }).strict()
  .refine(validRange, "A scheduled shift must last more than zero and no longer than 24 hours.");
export const staffScheduleCancelInput = z.object({ expectedVersion: version, ...command }).strict();
export const staffScheduleQuery = z.object({
  start: z.iso.datetime(), end: z.iso.datetime(),
  includeCancelled: z.enum(["true", "false"]).default("false").transform(x => x === "true"),
}).strict().refine(x => Date.parse(x.end) > Date.parse(x.start) && Date.parse(x.end) - Date.parse(x.start) <= 32 * 86400000,
  "Choose a schedule range of at most 31 calendar days.");
export const staffScheduleHistoryQuery = z.object({ beforeVersion: z.coerce.number().int().positive().max(2147483647).optional() }).strict();
export type StaffScheduleCreate = z.infer<typeof staffScheduleCreateInput>;
export type StaffScheduleUpdate = z.infer<typeof staffScheduleUpdateInput>;
export type StaffScheduleCancel = z.infer<typeof staffScheduleCancelInput>;
export type StaffScheduleStatus = "scheduled" | "cancelled";
export type StaffScheduleSnapshot = {
  id: string; userId: string; employeeName: string; jobId: string; jobTitle: string;
  unitId: string; unitName: string; startsAt: string; endsAt: string; note: string;
  version: number; status: StaffScheduleStatus; updatedAt: string; cancelledAt: string | null;
};
