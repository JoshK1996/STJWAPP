export declare const importWorkbookLimits: Readonly<Record<string, number>>;
export declare class ImportWorkbookError extends Error {
  code: string; cells: { sheetId?: number; row?: number; column?: number }[];
}
export declare function workbookCrc32(bytes: Uint8Array): number;
export declare function readImportWorkbookZip(bytes: Uint8Array): Map<string, Buffer>;
