import type { WorkbookInspectResult, WorkbookConvertResult, WorkbookKind } from '../shared/import-workbooks';
export type WorkbookTemplateResult = { bytes: Uint8Array; hash: string; formatVersion: 1 };
type Base = { schemaVersion: 1; parserVersion: 1; kind: WorkbookKind };
type TemplateTask = { schemaVersion: 1; parserVersion: 1; action: 'template' } & (
  | { kind: 'grade_scores' | 'compensation_rates'; rows: string[][] }
  | { kind: Exclude<WorkbookKind, 'grade_scores' | 'compensation_rates'> }
);
export type WorkbookTask = TemplateTask | Base & (
  | { action: 'inspect'; bytes: Uint8Array; sheetId?: number }
  | { action: 'convert'; bytes: Uint8Array; sheetId: number; headerRow: number; expectedWorkbookHash: string }
);
export declare const financeWorkbookColumns: readonly ['lineCode', 'lineLabel', 'group', 'rowKind', 'amount', 'note'];
export declare const workbookImportColumns: Readonly<Record<WorkbookKind, readonly string[]>>;
export declare const importWorkbookLimits: Readonly<Record<string, number>>;
export declare class ImportWorkbookError extends Error {
  code: string; cells: { sheetId?: number; row?: number; column?: number }[];
  constructor(code: string, cells?: { sheetId?: number; row?: number; column?: number }[]);
}
export declare function parseImportWorkbook(input: Base & { action: 'inspect'; bytes: Uint8Array; sheetId?: number }): Promise<WorkbookInspectResult>;
export declare function parseImportWorkbook(input: Base & { action: 'convert'; bytes: Uint8Array; sheetId: number; headerRow: number; expectedWorkbookHash: string }): Promise<WorkbookConvertResult>;
export declare function parseImportWorkbook(input: TemplateTask): Promise<WorkbookTemplateResult>;
export declare function parseImportWorkbook(input: unknown): Promise<WorkbookInspectResult | WorkbookConvertResult | WorkbookTemplateResult>;
export declare function createFinanceImportTemplate(): Promise<WorkbookTemplateResult>;
export declare function createImportWorkbookTemplate(kind: Exclude<WorkbookKind, 'grade_scores' | 'compensation_rates'>): Promise<WorkbookTemplateResult>;
export declare function createImportWorkbookTemplate(kind: 'grade_scores' | 'compensation_rates', rows: string[][]): Promise<WorkbookTemplateResult>;
