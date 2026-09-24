import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

// Explicitly resolve the existing workspace loader. Never install dependencies,
// inherit application credentials, or load the application's process entrypoint.
try {
  const rootRequire = createRequire(new URL("../../../package.json", import.meta.url));
  const loader = pathToFileURL(rootRequire.resolve("tsx")).href;
  const fixture = fileURLToPath(new URL("../tests/workspace-acceptance.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", loader, fixture], {
    env: { ...getDefaultEnvironment(), NODE_ENV: "test", TZ: "UTC" },
    stdio: "inherit", windowsHide: true,
  });
  child.once("error", () => { process.stderr.write("FAIL workspace harness could not start.\n"); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write("FAIL workspace harness requires installed root runtime dependencies.\n");
  process.exitCode = 1;
}
