import { z } from "zod";

export const calendarExportQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  audience: z.enum(["all", "personal", "unit", "organization"]).default("all"),
}).strict().refine((value) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  return duration > 0 && duration <= 367 * 86400000;
}, "Choose a calendar range of up to 367 days.");
export type CalendarExportQuery = z.infer<typeof calendarExportQuery>;
