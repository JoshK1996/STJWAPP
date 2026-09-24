import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readConfig } from "./config.js";
import { createBridge } from "./server.js";
import { safeError } from "./errors.js";

// stdout belongs exclusively to the MCP transport. Never log config, requests,
// upstream bodies or exception objects; each diagnostic is a fixed safe message.
try {
  const config = readConfig(process.env);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 });
  const server = serveStdio(() => createBridge(config), {
    transport, legacy: "serve", maxSubscriptions: 0,
    onerror: () => { process.stderr.write("STJW MCP transport error.\n"); },
  });
  process.once("SIGINT", () => { void server.close(); });
  process.once("SIGTERM", () => { void server.close(); });
  process.once("uncaughtException", () => { process.stderr.write("STJW MCP stopped after an internal error.\n"); process.exit(1); });
  process.once("unhandledRejection", () => { process.stderr.write("STJW MCP stopped after an internal error.\n"); process.exit(1); });
} catch (error) {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
}
