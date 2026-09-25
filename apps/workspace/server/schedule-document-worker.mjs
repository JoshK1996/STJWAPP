import { parentPort, workerData } from 'node:worker_threads';
import { parseScheduleDocument } from './schedule-document-parser.mjs';
try { parentPort.postMessage({ ok: true, result: await parseScheduleDocument(workerData.format, workerData.bytes) }); }
catch (error) { parentPort.postMessage({ ok: false, error: typeof error?.message === 'string' && error.message.length < 500 ? error.message : 'The document could not be read. Use a plain text, CSV or Excel copy.' }); }
