// Fixed ESM entry works with empty execArgv under both `tsx` and plain Node.
// The only TypeScript loader is the explicitly resolved installed tsx API.
import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
try {
  const { serializeSnapshotXlsx } = await tsImport("./report-snapshot-xlsx.ts", import.meta.url);
  const result = await serializeSnapshotXlsx(workerData.input, workerData.maxBytes);
  const bytes = new Uint8Array(result.length); bytes.set(result);
  parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
} catch (error) {
  const code = ["unsupported", "limit", "invalid"].includes(error?.code) ? error.code : "invalid";
  parentPort.postMessage({ ok: false, code });
}
