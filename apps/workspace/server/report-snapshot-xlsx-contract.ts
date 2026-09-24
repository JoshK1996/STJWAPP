import { snapshotLimits } from "../shared/report-snapshots";
export const xlsxLimits = Object.freeze({ inputBytes: snapshotLimits.bytes, outputBytes: 32 * 1024 * 1024, cellUnits: 32767, chunkUnits: 16000, metadataRows: 4096, deadlineMs: 15000, heapMb: 192 });
export type SnapshotXlsxInput = { payloadText: string; envelopeText: string; jsonHash: string; csvHash: string };
export type XlsxFailureCode = "unsupported" | "limit" | "invalid";
export class XlsxFailure extends Error {
  constructor(public readonly code: XlsxFailureCode) { super(code); }
}
