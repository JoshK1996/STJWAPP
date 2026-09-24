import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { payrollHoursLimits } from '../shared/payroll-hours';
import { Problem } from './security';

const unavailable = () => new Problem(422, 'This hours report cannot be represented exactly as Excel. Download JSON or CSV instead.');
export async function generatePayrollHoursXlsx(payloadText: string, options: { signal?: AbortSignal; deadlineMs?: number; maxBytes?: number } = {}) {
  if (options.signal?.aborted) throw new Problem(499, 'Spreadsheet download was cancelled.');
  if (typeof payloadText !== 'string' || Buffer.byteLength(payloadText) > payrollHoursLimits.inputBytes) throw new Problem(413, 'Choose a smaller hours report.');
  const deadline = options.deadlineMs ?? payrollHoursLimits.deadlineMs, cap = options.maxBytes ?? payrollHoursLimits.outputBytes;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > payrollHoursLimits.deadlineMs || !Number.isSafeInteger(cap) || cap < 1 || cap > payrollHoursLimits.outputBytes) throw unavailable();
  // Fixed entry and explicitly resolved loader; no inherited application arguments or secrets.
  const worker = new Worker(new URL('./payroll-hours-xlsx-worker.mjs', import.meta.url), {
    workerData: { payloadText, maxBytes: cap }, env: {}, execArgv: [], argv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: payrollHoursLimits.heapMb, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => reject(new Problem(503, 'Spreadsheet generation timed out. Choose a smaller report or download JSON/CSV.')), deadline);
      abort = () => reject(new Problem(499, 'Spreadsheet download was cancelled.')); options.signal?.addEventListener('abort', abort, { once: true });
      let diagnostics = 0;
      const discard = (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 65536) reject(unavailable()); };
      worker.stdout?.on('data', discard); worker.stderr?.on('data', discard);
      worker.once('error', () => reject(unavailable())); worker.once('exit', () => reject(unavailable()));
      worker.once('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('ok' in message) || message.ok !== true || !('bytes' in message) || !(message.bytes instanceof Uint8Array) || message.bytes.byteLength < 1 || message.bytes.byteLength > cap) { reject(unavailable()); return; }
        resolve(Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength));
      });
      if (options.signal?.aborted) abort();
    });
    if (options.signal?.aborted) throw new Problem(499, 'Spreadsheet download was cancelled.');
    return { buffer, bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
  } finally {
    if (timer) clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
