import { z } from "zod";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid YYYY-MM-DD calendar date.");
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
export const staffInputSchema = z.object({}).strict();
export const reportInputSchema = z.object({
  start: day.describe("First local calendar date, inclusive, YYYY-MM-DD."),
  end: day.describe("Last local calendar date, inclusive, YYYY-MM-DD."),
  group: z.enum(["hour", "day", "week", "month", "year"]),
  unitId: z.uuid().optional().describe("Optional exact organization-unit ID already accessible to the token."),
  userId: z.uuid().optional().describe("Optional exact employee ID already accessible to the token."),
}).strict().refine((value) => {
  const days = (Date.parse(value.end) - Date.parse(value.start)) / 86400000 + 1;
  return days > 0 && days <= (value.group === "hour" ? 32 : 367);
}, "Use an inclusive range up to 367 days, or 32 days for hourly grouping.");
export type ReportInput = z.infer<typeof reportInputSchema>;

// Response objects deliberately strip unknown properties. Credential/setup fields
// and future root API additions never become MCP output by default.
export const staffRecordSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(100), email: z.email().max(254),
  role: z.enum(["developer", "owner", "admin", "manager", "finance", "employee"]), active: z.boolean(),
  unit_ids: z.array(z.uuid()).max(250), job_ids: z.array(z.uuid()).max(1000),
});
export const staffOutputSchema = z.object({ rows: z.array(staffRecordSchema).max(2000) });
export const reportOutputSchema = z.object({
  workMs: milliseconds, breakMs: milliseconds,
  buckets: z.array(z.object({ key: instant, label: z.string().max(100), workMs: milliseconds, breakMs: milliseconds })).max(1024),
  staff: z.array(z.object({ id: z.uuid(), name: z.string().max(100), workMs: milliseconds, breakMs: milliseconds })).max(2000),
  rows: z.array(z.object({
    id: z.uuid(), kind: z.enum(["work", "break"]), started_at: instant, ended_at: instant.nullable(),
    revision: z.number().int().positive(), shift_id: z.uuid(), user_id: z.uuid(),
    employee_name: z.string().max(100), job_id: z.uuid(), job_title: z.string().max(100),
    unit_id: z.uuid(), unit_name: z.string().max(120), duration_ms: milliseconds,
    duration_seconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })).max(5000),
  timezone: z.string().min(1).max(80), asOf: instant,
  query: reportInputSchema, notice: z.string().min(1).max(1000),
});
