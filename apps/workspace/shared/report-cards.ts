import { z } from "zod";
const uuid = z.uuid(),
  version = z.number().int().positive(),
  reason = z.string().trim().min(10).max(2000);
export const openReportCardInput = z
  .object({
    studentId: uuid,
    yearId: uuid,
    termIds: z
      .array(uuid)
      .min(1)
      .max(8)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each term once.",
      ),
  })
  .strict();
export const reportCardPresentation = z
  .object({
    title: z.string().trim().min(2).max(120),
    subtitle: z.string().trim().max(200),
    layout: z.enum(["standard", "compact"]),
    showPercentage: z.boolean(),
    showLabel: z.boolean(),
    summary: z.string().trim().max(4000),
    footer: z.string().trim().max(1000),
  })
  .strict()
  .refine(
    (x) => x.showPercentage || x.showLabel,
    "Show a percentage, a grade label, or both.",
  );
export const reportCardCell = z
  .object({
    sectionId: uuid,
    termId: uuid,
    included: z.boolean(),
    exclusionReason: z.string().trim().max(1000),
    comment: z.string().trim().max(2000),
  })
  .strict();
export const saveReportCardInput = z
  .object({
    version,
    presentation: reportCardPresentation,
    cells: z.array(reportCardCell).max(200),
    reason,
    commandId: uuid,
  })
  .strict()
  .refine(
    (x) =>
      new Set(x.cells.map((c) => c.sectionId + ":" + c.termId)).size ===
      x.cells.length,
    "Each class and term must appear once.",
  );
export const reconcileReportCardInput = z
  .object({
    version,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason,
    commandId: uuid,
  })
  .strict();
export const issueReportCardInput = z
  .object({
    version,
    reviewed: z.literal(true),
    acknowledgeNoGrade: z.boolean(),
    acknowledgeMissing: z.boolean(),
    reason,
    commandId: uuid,
  })
  .strict();
export const reopenReportCardInput = z
  .object({ version, reason, commandId: uuid })
  .strict();
export const defaultReportCardPresentation = {
  title: "Student report card",
  subtitle: "",
  layout: "standard" as const,
  showPercentage: true,
  showLabel: true,
  summary: "",
  footer: "",
};
export function reportCardKey(cell: { sectionId: string; termId: string }) {
  return cell.sectionId + ":" + cell.termId;
}
