import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function connectDatabase(
  url?: string,
  localPath?: string,
): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    return {
      query: (sql, params) => pool.query(sql, params),
      transaction: async (fn) => {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          const result = await fn(tx);
          await tx.query("COMMIT");
          return result;
        } catch (error) {
          await tx.query("ROLLBACK");
          throw error;
        } finally {
          tx.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("Production requires DATABASE_URL.");
  if (localPath) await mkdir(dirname(localPath), { recursive: true });
  const db = new PGlite(localPath);
  await db.waitReady;
  return {
    query: async (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn(tx as Queryable)),
    close: () => db.close(),
  };
}
export async function migrationFiles() {
  const directory = new URL("./migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = files.map((name) => Number(name.slice(0, 3)));
  if (new Set(versions).size !== versions.length)
    throw new Error("Duplicate migration version.");
  return { directory, files, versions };
}
export async function verifySchema(db: Queryable) {
  const { versions } = await migrationFiles();
  const applied = (
    await db.query("SELECT version FROM schema_migrations ORDER BY version")
  ).rows.map((r) => r.version);
  if (JSON.stringify(applied) !== JSON.stringify(versions))
    throw new Error(
      "Database schema does not match this release. Run the reviewed maintenance migration before starting the web application.",
    );
  return versions.at(-1) ?? 0;
}
export async function migrate(db: Database) {
  const { directory, files, versions } = await migrationFiles();
  // Serialized, versioned migration; app replicas cannot race schema changes.
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(78239101)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await tx.query("SELECT version FROM schema_migrations")).rows.map(
        (row) => row.version,
      ),
    );
    for (let index = 0; index < files.length; index++) {
      if (applied.has(versions[index])) continue;
      const sql = await readFile(new URL(files[index], directory), "utf8");
      // Migration files use ordinary DDL and $$ function bodies; no semicolons inside quoted literals.
      const statements =
        sql.match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? [];
      for (const statement of statements) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        versions[index],
      ]);
    }
  });
}
