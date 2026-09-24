import { z } from "zod";
import { dateOnly } from "./contracts";
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const meetingInput = z
  .object({
    id: z.uuid().optional(),
    version: z.number().int().nonnegative().default(0),
    sectionId: z.uuid(),
    roomId: z.uuid().nullable(),
    startsOn: dateOnly,
    endsOn: dateOnly,
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((x) => new Set(x).size === x.length, "Choose each weekday once."),
    startsAt: clock,
    endsAt: clock,
    reason: z.string().trim().min(5).max(1000),
  })
  .strict()
  .refine(
    (x) =>
      x.endsOn >= x.startsOn &&
      (Date.parse(x.endsOn) - Date.parse(x.startsOn)) / 86400000 < 367,
    "Choose a date range of at most 367 days.",
  )
  .refine(
    (x) => x.endsAt > x.startsAt,
    "End time must follow start on the same day.",
  )
  .refine(
    (x) => !!x.id === x.version > 0,
    "Use the current version when editing a meeting.",
  );
export const timetableSaveInput = z
  .object({
    meeting: meetingInput,
    revision: z.number().int().nonnegative(),
    reviewed: z.literal(true),
    commandId: z.uuid(),
  })
  .strict();
export const timetableCancelInput = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().min(5).max(1000),
    commandId: z.uuid(),
  })
  .strict();
export const timetableRoomInput = z
  .object({ unitId: z.uuid(), name: z.string().trim().min(2).max(100) })
  .strict();
export type MeetingInput = z.infer<typeof meetingInput>;
