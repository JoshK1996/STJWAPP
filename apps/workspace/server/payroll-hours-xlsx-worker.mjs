import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
try {
  const { serializePayrollHoursXlsx } = await tsImport('./payroll-hours-xlsx.ts', import.meta.url);
  const result = await serializePayrollHoursXlsx(workerData.payloadText, workerData.maxBytes, workerData.presentation);
  const bytes = new Uint8Array(result.length); bytes.set(result);
  parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
} catch {
  parentPort.postMessage({ ok: false });
}
