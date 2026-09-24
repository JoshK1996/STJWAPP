import { z } from "zod";
import { reportInputSchema } from "./schemas.js";

const micros = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const instant = z.iso.datetime({ precision: 6 }).refine(value => !value.startsWith("0000-"), "Use a supported UTC year.");
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Keep this an explicit allowlist. Future fields and credential-like properties
// must never pass through the local bridge automatically.
export const reportOutputV2Schema = z.object({
  schemaVersion: z.literal(2), precisionVersion: z.literal(2), durationUnit: z.literal("microsecond"),
  timezone: z.string().min(1).max(80), asOf: instant,
  range: z.object({ from: instant, toExclusive: instant }), query: reportInputSchema,
  workMicroseconds: micros, breakMicroseconds: micros,
  sourceRowCount: z.number().int().nonnegative().max(20000),
  contributingRowCount: z.number().int().nonnegative().max(20000),
  rows: z.array(z.object({
    id: z.uuid(), shift_id: z.uuid(), revision, user_id: z.uuid(),
    employee_name: z.string().max(100), job_id: z.uuid(), job_title: z.string().max(100),
    unit_id: z.uuid(), unit_name: z.string().max(120), kind: z.enum(["work", "break"]),
    started_at: instant, ended_at: instant.nullable(),
    recorded_duration_microseconds: micros.nullable(),
    clipped_started_at: instant.nullable(), clipped_ended_at: instant.nullable(),
    duration_microseconds: micros,
  })).max(5000),
  buckets: z.array(z.object({
    key: instant, startsAt: instant, endsAt: instant, label: z.string().max(100),
    workMicroseconds: micros, breakMicroseconds: micros,
  })).max(1024),
  staff: z.array(z.object({
    userId: z.uuid(), name: z.string().max(100), workMicroseconds: micros, breakMicroseconds: micros,
  })).max(2000),
  notice: z.string().min(1).max(1000),
});
