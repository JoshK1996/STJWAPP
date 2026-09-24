import { z } from "zod";
import { staffInput } from "./contracts";

export const staffImportColumns = ["name", "email", "role", "unitIds", "jobIds"] as const;
export const staffImportLimits = { characters: 400000, sourceBytes: 1600000, rows: 500, recordCharacters: 4096,
  defaultSourceBudgetBytes: 64 * 1024 * 1024, minimumSourceBudgetBytes: 1024 * 1024, maximumSourceBudgetBytes: 1024 * 1024 * 1024 } as const;
export const staffImportHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
export const staffImportRowsSchema = z.array(staffInput).min(1).max(staffImportLimits.rows);
export const staffImportPreviewInput = z.object({ csv: z.string().min(1).max(staffImportLimits.characters) }).strict();
export const staffImportApplyInput = z.object({ sourceHash: staffImportHashSchema }).strict();
export const staffImportReceiptSchema = z.object({ schemaVersion: z.literal(1), batchId: z.uuid(), sourceHash: staffImportHashSchema,
  created: z.number().int().min(1).max(staffImportLimits.rows), appliedAt: instant,
  accounts: z.array(z.object({ row: z.number().int().min(2).max(staffImportLimits.rows + 1), userId: z.uuid() }).strict()).min(1).max(staffImportLimits.rows),
  notice: z.literal("Accounts were created without credentials. Issue individual private setup links from Staff."),
}).strict().superRefine((value, ctx) => {
  if (value.accounts.length !== value.created || value.accounts.some((account, index) => account.row !== index + 2) || new Set(value.accounts.map(account => account.userId)).size !== value.created)
    ctx.addIssue({ code: "custom", message: "Staff import receipt identities are inconsistent." });
});
export type StaffImportReceipt = z.infer<typeof staffImportReceiptSchema>;
const summaryFields = { id: z.uuid(), sourceHash: staffImportHashSchema, count: z.number().int().min(1).max(staffImportLimits.rows),
  evidenceVersion: z.union([z.literal(1), z.literal(2)]), createdAt: instant, expiresAt: instant, appliedAt: instant.nullable(),
  sourceAvailable: z.boolean(), receiptState: z.enum(["pending", "retained", "legacy_unavailable"]) };
export const staffImportSummarySchema = z.object(summaryFields).strict().superRefine((value, ctx) => {
  if ((value.appliedAt === null) !== (value.receiptState === "pending") || value.sourceAvailable !== (value.evidenceVersion === 2) || value.evidenceVersion === 2 && value.receiptState === "legacy_unavailable")
    ctx.addIssue({ code: "custom", message: "Staff import evidence state is inconsistent." });
});
export const staffImportDetailSchema = z.object({ ...summaryFields, rows: staffImportRowsSchema, receipt: staffImportReceiptSchema.nullable() }).strict().superRefine((value, ctx) => {
  if (!staffImportSummarySchema.safeParse(Object.fromEntries(Object.keys(summaryFields).map(key => [key, value[key as keyof typeof value]]))).success || value.rows.length !== value.count || (value.receipt !== null) !== (value.receiptState === "retained") || value.receipt && (value.receipt.batchId !== value.id || value.receipt.sourceHash !== value.sourceHash || value.receipt.created !== value.count || value.receipt.appliedAt !== value.appliedAt))
    ctx.addIssue({ code: "custom", message: "Staff import retained evidence is inconsistent." });
});
export const staffImportPreviewSchema = staffImportDetailSchema;
export const staffImportListQuery = z.object({ limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(), cursor: z.string().min(1).max(640).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
export const staffImportCursorSchema = z.object({ version: z.literal(1), createdAt: instant, id: z.uuid(), revision: staffImportHashSchema, authorityHash: staffImportHashSchema }).strict();
export const staffImportListSchema = z.object({ rows: z.array(staffImportSummarySchema).max(50), nextCursor: z.string().min(1).max(640).nullable() }).strict();
export type StaffImportDetail = z.infer<typeof staffImportDetailSchema>;
export type StaffImportPreview = StaffImportDetail;
export type StaffImportSummary = z.infer<typeof staffImportSummarySchema>;
export type StaffImportList = z.infer<typeof staffImportListSchema>;
