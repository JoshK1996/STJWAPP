import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { Problem } from "./security";
import { xlsxLimits, type SnapshotXlsxInput } from "./report-snapshot-xlsx-contract";
import { withSpreadsheetSlot } from "./spreadsheet-admission";

/** Admission is deliberately process-local. The slot covers copy, generation and publication. */
export async function withSnapshotXlsxSlot<T>(accountKey: string, action: () => Promise<T>): Promise<T> {
  return withSpreadsheetSlot(accountKey, action, "Another spreadsheet export is being prepared. Try again after it finishes.");
}
const unavailable = () => new Problem(422, "This retained report cannot be represented exactly as XLSX. Download the original JSON or CSV instead.");
export function assertXlsxNotAborted(signal?: AbortSignal) { if (signal?.aborted) throw new Problem(499, "Spreadsheet download was cancelled."); }
export async function generateSnapshotXlsx(input: SnapshotXlsxInput, options: { signal?: AbortSignal; deadlineMs?: number; maxBytes?: number } = {}) {
  assertXlsxNotAborted(options.signal);
  const deadline = options.deadlineMs ?? xlsxLimits.deadlineMs, cap = options.maxBytes ?? xlsxLimits.outputBytes;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > xlsxLimits.deadlineMs || !Number.isSafeInteger(cap) || cap < 1 || cap > xlsxLimits.outputBytes) throw unavailable();
  const worker = new Worker(new URL("./report-snapshot-xlsx-worker.mjs", import.meta.url), {
    workerData: { input, maxBytes: cap }, env: {}, execArgv: [], argv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: xlsxLimits.heapMb, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => reject(new Problem(503, "Spreadsheet generation timed out. Use the original JSON or CSV, or try again.")), deadline);
      abort = () => reject(new Problem(499, "Spreadsheet download was cancelled.")); options.signal?.addEventListener("abort", abort, { once: true });
      let diagnostics = 0;
      const discard = (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 65536) reject(unavailable()); };
      worker.stdout?.on("data", discard); worker.stderr?.on("data", discard);
      worker.once("error", () => reject(unavailable()));
      worker.once("exit", () => reject(unavailable()));
      worker.once("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("ok" in message) || message.ok !== true || !("bytes" in message) || !(message.bytes instanceof Uint8Array) || message.bytes.byteLength < 1 || message.bytes.byteLength > cap) { reject(unavailable()); return; }
        resolve(Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength));
      });
      if (options.signal?.aborted) abort();
    });
    assertXlsxNotAborted(options.signal);
    return { buffer, hash: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length, formatVersion: 2 as const };
  } finally {
    if (timer) clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
