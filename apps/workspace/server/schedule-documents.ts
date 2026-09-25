import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import type { Database, Queryable } from './db';
import type { AppRequest } from './auth';
import { audit, Problem, requireCondition, type Actor } from './security';
import { currentStaffImportActor } from './imports';
import { recheckReportSession } from './report-source-access';
import { withSpreadsheetSlot } from './spreadsheet-admission';
import { scheduleDocumentInput, scheduleDocumentResult, scheduleDocumentLimits as L, type ScheduleDocumentResult } from '../shared/schedule-documents';

function active(signal?: AbortSignal) { if (signal?.aborted) throw new Problem(499, 'Document reading was cancelled.'); }
export async function runScheduleDocument(format: string, bytes: Uint8Array, signal?: AbortSignal, deadlineMs: number = L.deadlineMs): Promise<Omit<ScheduleDocumentResult, 'timezone'>> {
  active(signal); requireCondition(deadlineMs > 0 && deadlineMs <= L.deadlineMs, 400, 'Invalid document deadline.');
  const input = Uint8Array.from(bytes), sourceHash = createHash('sha256').update(bytes).digest('hex'), worker = new Worker(new URL('./schedule-document-worker.mjs', import.meta.url), {
    workerData: { format, bytes: input }, transferList: [input.buffer], env: {}, execArgv: [], argv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: L.heapMb, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Problem(503, 'Document reading timed out. Use a smaller file or enter rows manually.')), deadlineMs);
      abort = () => reject(new Problem(499, 'Document reading was cancelled.')); signal?.addEventListener('abort', abort, { once: true });
      let diagnostics = 0;
      const discard = (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 16384) reject(new Problem(422, 'The document could not be read within the supported limits.')); };
      worker.stdout?.on('data', discard); worker.stderr?.on('data', discard);
      worker.once('error', () => reject(new Problem(422, 'The document could not be read within the supported limits.')));
      worker.once('exit', () => reject(new Problem(422, 'The document reader stopped. Use a smaller file or enter rows manually.')));
      worker.once('message', (message: unknown) => {
        try {
          requireCondition(message && typeof message === 'object', 422, 'Invalid document result.');
          const value = message as { ok?: boolean; error?: string; result?: unknown };
          if (value.ok !== true) throw new Problem(422, typeof value.error === 'string' && value.error.length <= 500 ? value.error : 'Document reading failed.');
          requireCondition(Buffer.byteLength(JSON.stringify(value.result)) <= L.resultBytes, 413, 'The extracted document is too large.');
          const result = scheduleDocumentResult.omit({ timezone: true }).parse(value.result);
          requireCondition(result.sourceHash === sourceHash && result.format === format, 422, 'Document result does not match the uploaded file.'); active(signal); resolve(result);
        } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); await worker.terminate(); }
}
export async function inspectScheduleDocument(db: Database, supplied: Actor, proof: string | undefined, raw: unknown, signal?: AbortSignal) {
  const identity = { ...supplied, unit_ids: [...supplied.unit_ids] };
  async function authorized<T>(fn: (tx: Queryable, actor: Actor) => Promise<T>) {
    return db.transaction(async tx => { active(signal); const actor = await currentStaffImportActor(tx, identity, proof), result = await fn(tx, actor); await recheckReportSession(tx, actor, proof!); active(signal); return result; });
  }
  const actor = await authorized(async (_tx, actor) => actor), input = scheduleDocumentInput.parse(raw);
  const bytes = Buffer.from(input.base64, 'base64'); requireCondition(bytes.length > 0 && bytes.length <= L.bytes && bytes.toString('base64') === input.base64, 413, 'Choose a file no larger than 2 MiB with valid base64 encoding.');
  return withSpreadsheetSlot(`${actor.org_id}:${actor.id}`, async () => {
    let result: Omit<ScheduleDocumentResult, 'timezone'>;
    try { result = await runScheduleDocument(input.format, bytes, signal); }
    catch (error) { await authorized(async () => null); throw error; }
    return authorized(async (tx, current) => {
      const org = (await tx.query('SELECT timezone FROM organizations WHERE id=$1', [current.org_id])).rows[0];
      requireCondition(org, 404, 'Organization not found.');
      await audit(tx, current, 'schedule.document_inspected', null, { format: input.format, sourceHash: result.sourceHash, sourceBytes: bytes.length, sheetCount: result.sheets.length, rowCount: result.sheets.reduce((n, sheet) => n + sheet.rows.length, 0) });
      return scheduleDocumentResult.parse({ ...result, timezone: org.timezone });
    });
  });
}
export function installScheduleDocuments(app: Express, db: Database) {
  app.post('/api/schedule-documents/inspect', async (req, res) => {
    const { actor, sessionHash } = req as AppRequest, controller = new AbortController(), abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort); res.set('Cache-Control', 'private, no-store');
    try { const result = await inspectScheduleDocument(db, actor, sessionHash, req.body, controller.signal); active(controller.signal); res.json(result); }
    finally { req.off('aborted', abort); res.off('close', abort); }
  });
}
