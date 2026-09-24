import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { Problem } from "./security";
import { workbookConvertResultSchemaFor, workbookKindSchema, workbookInspectResultSchema, workbookIssueCellSchema, workbookIssueCode, workbookIssueSchema, workbookLimits,
  type WorkbookConvertResult, type WorkbookInspectResult, type WorkbookIssue } from "../shared/import-workbooks";

const version = { schemaVersion: z.literal(1), parserVersion: z.literal(1), kind: workbookKindSchema };
const blankTemplateKind = workbookKindSchema.exclude(["grade_scores", "compensation_rates"]);
const gradeRows = z.array(z.array(z.string().max(8192)).length(8)).min(1).max(workbookLimits.gradeDataRows);
const compensationRows = z.array(z.array(z.string().max(8192)).length(11)).min(1).max(workbookLimits.compensationDataRows);
const bytes = z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= workbookLimits.inputBytes);
const id = z.number().int().min(1).max(2147483647);
const taskSchema = z.union([
  z.object({ ...version, action: z.literal("inspect"), bytes, sheetId: id.optional() }).strict(),
  z.object({ ...version, action: z.literal("convert"), bytes, sheetId: id, headerRow: z.number().int().min(1).max(20), expectedWorkbookHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...version, kind: blankTemplateKind, action: z.literal("template") }).strict(),
  z.object({ ...version, kind: z.literal("grade_scores"), action: z.literal("template"), rows: gradeRows }).strict(),
  z.object({ ...version, kind: z.literal("compensation_rates"), action: z.literal("template"), rows: compensationRows }).strict(),
]);
export type WorkbookTask = z.infer<typeof taskSchema>;
export type WorkbookTemplate = { buffer: Buffer; hash: string; bytes: number; formatVersion: 1 };
const failureSchema = z.object({ ok: z.literal(false), code: workbookIssueCode, cells: z.array(workbookIssueCellSchema).max(workbookLimits.issueCells) }).strict();
const successSchema = z.object({ ok: z.literal(true), result: z.unknown() }).strict();
const templateSchema = z.object({ bytes, hash: z.string().regex(/^[a-f0-9]{64}$/), formatVersion: z.literal(1) }).strict();
const messages: Record<WorkbookIssue["code"], string> = {
  invalid_container: "Use an ordinary unencrypted XLSX workbook without unsupported package parts.",
  unsupported_feature: "This workbook contains an unsupported feature. Use plain text cells in the selected template, or use CSV.",
  limit: "This workbook exceeds a supported size or worksheet limit. Use a smaller template or CSV.",
  header_mismatch: "Use the exact columns from the selected template. School and staff columns must remain in their original order.",
  non_text_cell: "Use plain text cells. Re-enter original values as text; formatting an existing number as Text does not restore lost digits.",
  invalid_input: "Choose an available visible worksheet and a supported header row.",
  source_changed: "The workbook fingerprint changed. Inspect the selected file again before converting it.",
};
export class ImportWorkbookProblem extends Problem {
  readonly issue: WorkbookIssue;
  constructor(code: WorkbookIssue["code"], cells: z.infer<typeof workbookIssueCellSchema>[]) {
    super(code === "limit" ? 413 : code === "invalid_input" ? 400 : code === "source_changed" ? 409 : 422, messages[code]);
    this.issue = workbookIssueSchema.parse({ error: messages[code], code, cells });
  }
}
export function assertWorkbookNotAborted(signal?: AbortSignal) { if (signal?.aborted) throw new Problem(499, "Workbook preparation was cancelled."); }
const unavailable = () => new Problem(503, "Workbook preparation could not finish. Try again, or use the CSV template.");
const hashBytes = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Fixed worker, empty environment, transferred standalone bytes; no DB or paths. */
export async function runImportWorkbook(raw: WorkbookTask, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<WorkbookInspectResult | WorkbookConvertResult | WorkbookTemplate> {
  assertWorkbookNotAborted(options.signal);
  const task = taskSchema.parse(raw), deadline = options.deadlineMs ?? workbookLimits.deadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > workbookLimits.deadlineMs) throw unavailable();
  const original = "bytes" in task ? { hash: hashBytes(task.bytes), bytes: task.bytes.byteLength } : null;
  // A caller's pooled buffer must never transfer unrelated backing bytes.
  const transferred = "bytes" in task ? Uint8Array.from(task.bytes) : null;
  const workerTask = transferred ? { ...task, bytes: transferred } : task;
  const worker = new Worker(new URL("./import-workbook-worker.mjs", import.meta.url), {
    workerData: workerTask, ...(transferred ? { transferList: [transferred.buffer] } : {}),
    env: {}, execArgv: [], argv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: workbookLimits.heapMb, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    const result = await new Promise<WorkbookInspectResult | WorkbookConvertResult | WorkbookTemplate>((resolve, reject) => {
      timer = setTimeout(() => reject(new Problem(503, "Workbook preparation timed out. Try a smaller workbook or use CSV.")), deadline);
      abort = () => reject(new Problem(499, "Workbook preparation was cancelled."));
      options.signal?.addEventListener("abort", abort, { once: true });
      let diagnostics = 0;
      const discard = (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > workbookLimits.diagnosticsBytes) reject(unavailable()); };
      worker.stdout?.on("data", discard); worker.stderr?.on("data", discard);
      worker.once("error", () => reject(unavailable())); worker.once("exit", () => reject(unavailable()));
      worker.once("message", (message: unknown) => {
        try {
          const failure = failureSchema.safeParse(message);
          if (failure.success) { reject(new ImportWorkbookProblem(failure.data.code, failure.data.cells)); return; }
          const envelope = successSchema.parse(message);
          if (task.action === "template") {
            const template = templateSchema.parse(envelope.result);
            if (hashBytes(template.bytes) !== template.hash) throw unavailable();
            resolve({ buffer: Buffer.from(template.bytes), hash: template.hash, bytes: template.bytes.byteLength, formatVersion: 1 }); return;
          }
          const serialized = JSON.stringify(envelope.result);
          if (!serialized || Buffer.byteLength(serialized, "utf8") > (task.action === "inspect" ? workbookLimits.inspectBytes : workbookLimits.resultBytes)) throw unavailable();
          if (task.action === "inspect") {
            const inspected = workbookInspectResultSchema.parse(envelope.result);
            if (inspected.workbookHash !== original!.hash || inspected.workbookBytes !== original!.bytes || task.sheetId === undefined && inspected.samples.length || task.sheetId !== undefined && !inspected.sheets.some(sheet => sheet.sheetId === task.sheetId && sheet.state === "visible")) throw unavailable();
            resolve(inspected);
          } else {
            const converted = workbookConvertResultSchemaFor(task.kind).parse(envelope.result);
            if (converted.workbookHash !== original!.hash || converted.workbookBytes !== original!.bytes || converted.workbookHash !== task.expectedWorkbookHash || converted.sheetId !== task.sheetId || converted.headerRow !== task.headerRow || hashBytes(converted.csv) !== converted.csvHash) throw unavailable();
            resolve(converted);
          }
        } catch { reject(unavailable()); }
      });
      if (options.signal?.aborted) abort();
    });
    assertWorkbookNotAborted(options.signal); return result;
  } finally {
    if (timer) clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
