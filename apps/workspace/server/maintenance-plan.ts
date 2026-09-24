import { readFile } from "node:fs/promises";
import { migrationFiles } from "./db";
import { runtimeGrantsSql } from "./runtime-access";

// Generates SQL/psql input only. Execution requires the separately authenticated
// PostgreSQL maintenance connection; no database credential is read here.
export async function maintenanceSql() {
  const { directory, files, versions } = await migrationFiles();
  const statements = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout='15s';",
    "SELECT pg_advisory_xact_lock(78239101);",
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
  ];
  statements.push(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.schema_migrations WHERE version NOT IN (${versions.join(",")})) THEN RAISE EXCEPTION 'Database contains migrations outside this release'; END IF; END $$;`,
  );
  for (let i = 0; i < files.length; i++) {
    statements.push(
      `SELECT NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=${versions[i]}) AS apply_migration \\gset`,
      "\\if :apply_migration",
      await readFile(new URL(files[i], directory), "utf8"),
      `INSERT INTO public.schema_migrations(version) VALUES(${versions[i]});`,
      "\\endif",
    );
  }
  statements.push(
    runtimeGrantsSql(),
    "COMMIT;",
    `SELECT 'maintenance_complete' AS status,max(version) AS schema_version FROM public.schema_migrations;`,
  );
  return statements.join("\n") + "\n";
}
