import { z } from "zod";
import { financeColumns } from "./finance";
import { schoolImportCatalog } from "./school-imports";
import { gradeImportColumns } from "./grade-imports";
import { staffImportColumns } from "./staff-imports";
import { compensationCsvColumns } from "./compensation";

export const schoolWorkbookKinds = ["school_students", "school_enrollments", "school_roster", "school_households", "school_household_members", "school_contacts"] as const;
export const workbookKinds = ["finance", ...schoolWorkbookKinds, "grade_scores", "staff", "compensation_rates"] as const;
export const workbookKindSchema = z.enum(workbookKinds);
export type WorkbookKind = z.infer<typeof workbookKindSchema>;
const schoolKind = z.enum(schoolWorkbookKinds);
export function workbookColumnsFor(kind: WorkbookKind): readonly string[] {
  return kind === "finance" ? financeColumns : kind === "grade_scores" ? gradeImportColumns : kind === "staff" ? staffImportColumns : kind === "compensation_rates" ? compensationCsvColumns : schoolImportCatalog[kind.slice(7) as keyof typeof schoolImportCatalog].columns;
}

export const workbookLimits = {
  inputBytes: 256 * 1024, base64Characters: 349528, inspectBytes: 128 * 1024,
  resultBytes: 512 * 1024, csvBytes: 200000, deadlineMs: 15000, heapMb: 192,
  diagnosticsBytes: 16 * 1024, sheets: 8, rows: 2000, columns: 64, cells: 20000,
  dataRows: 500, gradeDataRows: 200, compensationDataRows: 200, compensationCsvBytes: 64000, issueCells: 50,
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sheetId = z.number().int().min(1).max(2147483647);
const rowNumber = z.number().int().min(1).max(workbookLimits.rows);
const columnNumber = z.number().int().min(1).max(workbookLimits.columns);
const name = z.string().min(1).max(128); // Raw text, never trim labels.
const state = z.enum(["visible", "hidden", "veryHidden"]);
const base64 = z.string().min(4).max(workbookLimits.base64Characters)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Use canonical base64 workbook bytes.");
const inspectFields = { base64, sheetId: sheetId.optional() };
const convertFields = { base64, sheetId, headerRow: z.number().int().min(1).max(20), expectedWorkbookHash: hash };
export const workbookInspectInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finance"), ...inspectFields }).strict(),
  z.object({ kind: z.literal("staff"), ...inspectFields }).strict(),
  z.object({ kind: schoolKind, unitId: z.uuid(), ...inspectFields }).strict(),
  z.object({ kind: z.literal("grade_scores"), assignmentId: z.uuid(), ...inspectFields }).strict(),
  z.object({ kind: z.literal("compensation_rates"), userId: z.uuid(), jobId: z.uuid(), ...inspectFields }).strict(),
]);
export const workbookConvertInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finance"), ...convertFields }).strict(),
  z.object({ kind: z.literal("staff"), ...convertFields }).strict(),
  z.object({ kind: schoolKind, unitId: z.uuid(), ...convertFields }).strict(),
  z.object({ kind: z.literal("grade_scores"), assignmentId: z.uuid(), ...convertFields }).strict(),
  z.object({ kind: z.literal("compensation_rates"), userId: z.uuid(), jobId: z.uuid(), ...convertFields }).strict(),
]);
export const workbookTemplateInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finance") }).strict(),
  z.object({ kind: z.literal("staff") }).strict(),
  z.object({ kind: schoolKind, unitId: z.uuid() }).strict(),
  z.object({ kind: z.literal("grade_scores"), assignmentId: z.uuid() }).strict(),
  z.object({ kind: z.literal("compensation_rates"), userId: z.uuid(), jobId: z.uuid() }).strict(),
]);
export type WorkbookInspectInput = z.infer<typeof workbookInspectInput>;
export type WorkbookConvertInput = z.infer<typeof workbookConvertInput>;
export type WorkbookTemplateInput = z.infer<typeof workbookTemplateInput>;

export const workbookSheetSchema = z.object({ sheetId, name, state,
  lastRow: z.number().int().min(0).max(workbookLimits.rows), lastColumn: z.number().int().min(0).max(workbookLimits.columns),
  populatedCells: z.number().int().min(0).max(workbookLimits.cells) }).strict();
const sample = z.object({ row: rowNumber, cells: z.array(z.object({ column: columnNumber,
  value: z.string().max(256).refine(value => [...value].length <= 128), shortened: z.boolean() }).strict()).max(16) }).strict();
export const workbookInspectResultSchema = z.object({ schemaVersion: z.literal(1), parserVersion: z.literal(1),
  workbookHash: hash, workbookBytes: z.number().int().min(1).max(workbookLimits.inputBytes),
  sheets: z.array(workbookSheetSchema).min(1).max(workbookLimits.sheets), samples: z.array(sample).max(20),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sheets.map(s => s.sheetId)).size !== value.sheets.length || value.sheets.reduce((n, s) => n + s.populatedCells, 0) > workbookLimits.cells)
    ctx.addIssue({ code: "custom", message: "Workbook sheet identities or cell counts are inconsistent." });
  if (value.samples.some((s, i) => s.row > 20 || i > 0 && s.row <= value.samples[i - 1].row || s.cells.some((c, j) => c.column > 16 || j > 0 && c.column <= s.cells[j - 1].column)))
    ctx.addIssue({ code: "custom", message: "Workbook display samples are inconsistent." });
});
export type WorkbookInspectResult = z.infer<typeof workbookInspectResultSchema>;
export function workbookConvertResultSchemaFor(kind: WorkbookKind) {
  const columns = workbookColumnsFor(workbookKindSchema.parse(kind));
  const rowLimit = kind === "grade_scores" ? workbookLimits.gradeDataRows : kind === "compensation_rates" ? workbookLimits.compensationDataRows : workbookLimits.dataRows;
  const csvLimit = kind === "compensation_rates" ? workbookLimits.compensationCsvBytes : workbookLimits.csvBytes;
  return z.object({ schemaVersion: z.literal(1), parserVersion: z.literal(1),
  workbookHash: hash, workbookBytes: z.number().int().min(1).max(workbookLimits.inputBytes), sheetId, sheetName: name,
  headerRow: z.number().int().min(1).max(20), headers: z.array(z.string().max(8192)).length(columns.length),
  rowCount: z.number().int().min(1).max(rowLimit),
  rowMap: z.array(z.object({ csvRow: z.number().int().min(2).max(rowLimit + 1), worksheetRow: rowNumber }).strict()).min(1).max(rowLimit),
  csv: z.string().min(1).max(csvLimit), csvHash: hash, csvBytes: z.number().int().min(1).max(csvLimit),
  ignoredSheets: z.array(z.object({ sheetId, name, state }).strict()).max(workbookLimits.sheets - 1),
  ignoredLeadingRows: z.object({ count: z.number().int().min(0).max(19), nonemptyRows: z.array(rowNumber).max(19) }).strict(),
  emptyRows: z.array(rowNumber).max(workbookLimits.rows),
}).strict().superRefine((value, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (kind === "compensation_rates") {
    const headers = value.headers.map(header => header.trim());
    if (new Set(headers).size !== columns.length || !headers.every(header => columns.includes(header))) bad("The exact pay template header set is required after trimming header whitespace.");
  } else if (kind === "finance" || kind === "grade_scores") {
    if (new Set(value.headers).size !== columns.length || !value.headers.every(header => columns.includes(header))) bad(kind === "finance" ? "The exact financial header set is required." : "The exact assignment score header set is required.");
  } else if (value.headers.some((header, index) => header !== columns[index])) bad("The exact school or staff template columns are required in their original order.");
  if (value.rowMap.length !== value.rowCount || value.rowMap.some((r, i) => r.csvRow !== i + 2 || r.worksheetRow <= value.headerRow || i > 0 && r.worksheetRow <= value.rowMap[i - 1].worksheetRow)) bad("Workbook row mapping is inconsistent.");
  if (new Set(value.ignoredSheets.map(s => s.sheetId)).size !== value.ignoredSheets.length || value.ignoredSheets.some(s => s.sheetId === value.sheetId)) bad("Excluded sheet identities are inconsistent.");
  if (value.ignoredLeadingRows.count !== value.headerRow - 1 || value.ignoredLeadingRows.nonemptyRows.some((r, i, rows) => r >= value.headerRow || i > 0 && r <= rows[i - 1])) bad("Excluded leading rows are inconsistent.");
  if (value.emptyRows.some((r, i, rows) => r <= value.headerRow || i > 0 && r <= rows[i - 1] || value.rowMap.some(m => m.worksheetRow === r))) bad("Excluded empty rows are inconsistent.");
  if (new TextEncoder().encode(value.csv).byteLength !== value.csvBytes) bad("CSV byte count is inconsistent.");
});
}
// Compatibility: callers that omit an explicit catalog still validate finance.
export const workbookConvertResultSchema = workbookConvertResultSchemaFor("finance");
export type WorkbookConvertResult = z.infer<typeof workbookConvertResultSchema>;
export const workbookIssueCode = z.enum(["invalid_container", "unsupported_feature", "limit", "header_mismatch", "non_text_cell", "invalid_input", "source_changed"]);
export const workbookIssueCellSchema = z.object({ sheetId: sheetId.optional(), row: rowNumber.optional(), column: columnNumber.optional() }).strict();
export const workbookIssueSchema = z.object({ error: z.string().min(1).max(500), code: workbookIssueCode, cells: z.array(workbookIssueCellSchema).max(workbookLimits.issueCells) }).strict();
export type WorkbookIssue = z.infer<typeof workbookIssueSchema>;
