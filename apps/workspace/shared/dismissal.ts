import { z } from "zod";
import { dateOnly } from "./contracts";
const reason = z.string().trim().min(5).max(1000),
  version = z.number().int().positive();
export const dismissalSettingsInput = z
  .object({
    unitId: z.uuid(),
    version: z.number().int().nonnegative(),
    confirmed: z.boolean(),
    instructions: z.string().trim().min(5).max(3000),
    staffIds: z
      .array(z.uuid())
      .max(100)
      .refine((x) => new Set(x).size === x.length),
    reason,
  })
  .strict();
export const dismissalOpenInput = z
  .object({
    unitId: z.uuid(),
    yearId: z.uuid(),
    day: dateOnly,
    settingsVersion: version,
    commandId: z.uuid(),
  })
  .strict();
export const dismissalPlanInput = z
  .object({
    entries: z
      .array(z.object({ studentId: z.uuid(), version }).strict())
      .min(1)
      .max(500)
      .refine((x) => new Set(x.map((r) => r.studentId)).size === x.length),
    mode: z.enum(["pickup", "bus", "care"]),
    busId: z.uuid().nullable(),
    careProgramId: z.uuid().nullable().default(null),
    reason,
  })
  .strict()
  .refine(
    (x) => (x.mode === "bus") === (x.busId !== null),
    "Choose a bus only for bus plans.",
  )
  .refine(
    (x) => (x.mode === "care") === (x.careProgramId !== null),
    "Choose a care program only for care plans.",
  );
export const dismissalBusInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    driverName: z.string().trim().min(2).max(100),
    vehicle: z.string().trim().min(2).max(100),
    version: z.number().int().nonnegative(),
    reason,
  })
  .strict();
export const dismissalBusArrivalInput = z
  .object({
    version,
    identityMethod: z.enum(["photo_id", "personally_known"]),
    identityConfirmed: z.literal(true),
    vehicleConfirmed: z.literal(true),
    commandId: z.uuid(),
  })
  .strict();
export const dismissalEntryInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("present"),
      version,
      observed: z.literal(true),
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("absent"),
      version,
      verified: z.literal(true),
      reason,
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("call"),
      version,
      arrivalObserved: z.literal(true),
      contactId: z.uuid().optional(),
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel_call"),
      version,
      reason,
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release_pickup"),
      version,
      contactId: z.uuid(),
      contactVersion: version,
      personVersion: version,
      identityMethod: z.enum(["photo_id", "personally_known"]),
      identityConfirmed: z.literal(true),
      released: z.literal(true),
      note: z.string().trim().max(1000),
      commandId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release_bus"),
      version,
      busVersion: version,
      boarded: z.literal(true),
      note: z.string().trim().max(1000),
      commandId: z.uuid(),
    })
    .strict(),
]);
export const dismissalReconcileInput = z.object({ version, reason }).strict();
export const dismissalReviewInput = z
  .object({
    version,
    action: z.enum(["close", "reopen"]),
    rosterFingerprint: z.string().length(64),
    reason,
    reviewed: z.literal(true),
  })
  .strict();
