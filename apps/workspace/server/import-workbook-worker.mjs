import { parentPort, workerData } from 'node:worker_threads';
import { parseImportWorkbook, ImportWorkbookError } from './import-workbook-parser.mjs';
try {
  const result = await parseImportWorkbook(workerData);
  parentPort.postMessage({ ok: true, result }, result.bytes instanceof Uint8Array ? [result.bytes.buffer] : []);
} catch (error) {
  const known = error instanceof ImportWorkbookError;
  parentPort.postMessage({ ok: false, code: known ? error.code : 'invalid_container', cells: known ? error.cells : [] });
}
