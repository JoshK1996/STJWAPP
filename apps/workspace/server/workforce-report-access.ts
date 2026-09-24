import type { Database, Queryable } from "./db";
import { getReport, reportColumns, toCsv, type ReportQuery } from "./reports";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import { audit, Problem, requireCondition, type Actor } from "./security";

export type WorkforceReportProof = { mode: "password" | "api"; hash: string | undefined };
type Query = ReportQuery & { columns?: string };
type Report = Awaited<ReturnType<typeof getReport>>;

async function tokenProof(tx: Queryable, actor: Actor, hash: string) {
  const result = await tx.query(`SELECT t.id,t.scopes FROM api_tokens t
    WHERE t.token_hash=$1 AND t.org_id=$2 AND t.user_id=$3
    AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()
    AND t.scopes @> '["reports:read"]'::jsonb
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=t.user_id AND u.org_id=t.org_id AND u.active AND NOT u.requires_credential_change)
    FOR SHARE OF t`, [hash, actor.org_id, actor.id]);
  requireCondition(result.rows.length === 1, 403, "This API credential cannot read reports under its current access.");
  return result.rows[0];
}

async function currentActor(tx: Queryable, supplied: Actor, proof: WorkforceReportProof): Promise<Actor> {
  requireCondition((proof.mode === "password" || proof.mode === "api") && supplied.mode === proof.mode && typeof proof.hash === "string" && /^[a-f0-9]{64}$/.test(proof.hash),
    401, "A current report credential is required.");
  if (proof.mode === "password") return currentReportActor(tx, supplied, proof.hash);
  // Preserve read-only bearer access, with the same current role/unit limits as
  // its account. Account first matches account/MFA/setup revocation writers.
  const row = (await tx.query(`SELECT id,org_id,name,email,role,active,requires_credential_change FROM users
    WHERE id=$1 AND org_id=$2 FOR SHARE`, [supplied.id, supplied.org_id])).rows[0];
  requireCondition(row?.active && !row.requires_credential_change, 403, "This account cannot read reports under its current access.");
  const token = await tokenProof(tx, supplied, proof.hash);
  const units = (await tx.query("SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 ORDER BY unit_id FOR SHARE",
    [supplied.id, supplied.org_id])).rows.map(item => item.unit_id);
  return { ...supplied, ...row, mode: "api", scopes: token.scopes, unit_ids: units };
}

/** Internal publication boundary shared by versioned report producers. The
 * caller supplies code, never a request-selected SQL query or callback. */
export async function withAuthorizedWorkforceSource<R, T>(db: Database, supplied: Actor, proof: WorkforceReportProof,
  load: (tx: Queryable, actor: Actor) => Promise<R>,
  publish: (tx: Queryable, actor: Actor, report: R) => Promise<T>,
  options: { repeatableRead?: boolean } = {}): Promise<T> {
  try {
    return await reportTransaction(db, async tx => {
      if (options.repeatableRead) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL lock_timeout='5s'");
      await tx.query("SET LOCAL statement_timeout='15s'");
      const actor = await currentActor(tx, supplied, proof);
      const report = await load(tx, actor);
      const result = await publish(tx, actor, report);
      // Natural expiry can occur while query/serialization/audit work holds the
      // proof lock. Deny the response and roll back the export audit together.
      if (proof.mode === "password") await recheckReportSession(tx, actor, proof.hash!);
      else await tokenProof(tx, actor, proof.hash!);
      return result;
    });
  } catch (error: any) {
    if (["55P03", "57014", "40001", "40P01"].includes(error?.code))
      throw new Problem(503, "The report is busy. Please try again.");
    throw error;
  }
}

async function withReport<T>(db: Database, supplied: Actor, proof: WorkforceReportProof, query: Query,
  publish: (tx: Queryable, actor: Actor, report: Report) => Promise<T>): Promise<T> {
  return withAuthorizedWorkforceSource(db, supplied, proof, (tx, actor) => getReport(tx, actor, query), publish);
}

/** Route-facing read; source calculations also remain reusable by guarded reports. */
export function getAuthorizedWorkforceReport(db: Database, actor: Actor, proof: WorkforceReportProof, query: Query) {
  return withReport(db, actor, proof, query, async (_tx, _current, report) => report);
}

export function exportAuthorizedWorkforceReport(db: Database, actor: Actor, proof: WorkforceReportProof, query: Query) {
  return withReport(db, actor, proof, query, async (tx, current, report) => {
    requireCondition(query.columns === undefined || query.columns.length <= 500, 400, "Unsupported report column.");
    const columns = query.columns?.split(",") ?? reportColumns;
    requireCondition(columns.length > 0 && columns.every(column => reportColumns.includes(column)), 400, "Unsupported report column.");
    const csv = toCsv(report.rows, columns);
    await audit(tx, current, "report.exported", null, { query, rowCount: report.rows.length, asOf: report.asOf });
    return csv;
  });
}
