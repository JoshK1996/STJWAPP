import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const release = process.argv[2];
const { maintenanceSql } = await import(
  release
    ? pathToFileURL(resolve(release, "server/maintenance-plan.ts")).href
    : "../server/maintenance-plan"
);
process.stdout.write(await maintenanceSql());
