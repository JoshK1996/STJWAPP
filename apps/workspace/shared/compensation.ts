import { z } from "zod";
import { dateOnly } from "./contracts";
import { financeAmount } from "./finance";

export const rateBases = {
  hour: "Per hour",
  day: "Per day",
  session: "Per session",
  month: "Per month",
  year: "Per year",
} as const;
export const compensationRate = z
  .object({
    id: z.uuid(),
    startsOn: dateOnly,
    endsOn: dateOnly.nullable(),
    amount: financeAmount.refine(
      (x) => !x.startsWith("-"),
      "Enter a nonnegative amount.",
    ),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "Enter an explicit three-letter currency code."),
    basis: z.enum(["hour", "day", "session", "month", "year"]),
    voided: z.boolean(),
    note: z.string().trim().max(1000),
  })
  .strict()
  .refine(
    (x) => x.endsOn === null || x.endsOn >= x.startsOn,
    "The last effective day must follow the first.",
  );
export type CompensationRate = z.infer<typeof compensationRate>;
export const compensationPreviewInput = z
  .object({
    userId: z.uuid(),
    jobId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    rates: z.array(compensationRate).min(1).max(200),
    reason: z.string().trim().min(5).max(1000),
    sourceCsv: z.string().min(1).max(64000).optional(),
  })
  .strict();
export const compensationSaveInput = compensationPreviewInput.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  commandId: z.uuid(),
  reviewed: z.literal(true),
});
export const compensationPair = z
  .object({ userId: z.uuid(), jobId: z.uuid() })
  .strict();
export const compensationImportInput = compensationPair.extend({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(5).max(1000),
  csv: z.string().min(1).max(64000),
});
export const compensationCsvColumns = [
  "userId",
  "jobId",
  "recordVersion",
  "rateId",
  "startsOn",
  "endsOn",
  "amount",
  "currency",
  "basis",
  "voided",
  "note",
] as const;
