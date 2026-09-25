import { z } from "zod";
import { dateOnly } from "./contracts";
export const financeColumns = [
  "lineCode",
  "lineLabel",
  "group",
  "rowKind",
  "amount",
  "note",
] as const;
export const financeAmount = z
  .string()
  .trim()
  .regex(
    /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/,
    "Use a decimal amount with up to 12 whole digits and 4 decimal places, without commas or currency symbols.",
  );
export const financeLine = z
  .object({
    lineCode: z.string().trim().min(1).max(50),
    lineLabel: z.string().trim().min(1).max(160),
    group: z.string().trim().max(100),
    rowKind: z.enum(["detail", "subtotal", "total"]),
    amount: financeAmount,
    note: z.string().trim().max(1000),
  })
  .strict();
export type FinanceLine = z.infer<typeof financeLine>;
// Internal revision input, not a spreadsheet export: retain exact source strings.
export function financeRevisionCsv(lines:FinanceLine[]):string {
  const quote=(value:string)=>/[,"\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
  return [financeColumns.map(quote).join(','),...lines.map(line=>financeColumns.map(column=>quote(line[column])).join(','))].join('\n');
}

export const financeMetadata = z
  .object({
    title: z.string().trim().min(2).max(160),
    sourceName: z.string().trim().min(2).max(160),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "Enter an explicit three-letter currency code."),
    kind: z.enum(["actual", "budget", "forecast", "other"]),
    basis: z.enum(["period_activity", "as_of_balance", "other"]),
    from: dateOnly,
    to: dateOnly,
    note: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine((x) => x.to >= x.from, "Report end must follow its start.");
export type FinanceMetadata = z.infer<typeof financeMetadata>;
export const financePreviewInput = z
  .object({
    unitId: z.uuid(),
    reportId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    metadata: financeMetadata,
    csv: z.string().min(1).max(400000),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
export const financePublishInput = z
  .object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewed: z.literal(true),
  })
  .strict();
export const financeComparisonInput = z
  .object({
    leftId: z.uuid(),
    leftVersion: z.number().int().min(1),
    rightId: z.uuid(),
    rightVersion: z.number().int().min(1),
    differentPeriodsReviewed: z.boolean().default(false),
  })
  .strict();
export type FinanceSnapshot = {
  metadata: FinanceMetadata;
  lines: FinanceLine[];
  sourceHash: string;
};
