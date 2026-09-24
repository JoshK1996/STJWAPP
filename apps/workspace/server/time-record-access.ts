import type { Database, Queryable, Row } from "./db";
import { canReport, manages, orgWide, Problem, requireCondition, type Actor } from "./security";
import { recheckReportSession } from "./report-source-access";

export const preciseTimeSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function timeNow(tx: Queryable): Promise<string> { return (await tx.query(`SELECT ${preciseTimeSql("clock_timestamp()")} AS instant`)).rows[0].instant; }
export function timeMicroseconds(value: string): bigint {
  const match = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/);
  requireCondition(match && Number.isFinite(Date.parse(match[1] + "Z")), 422, "Recorded time precision is unsupported.");
  return BigInt(Date.parse(match[1] + "Z")) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function canonicalTimeJson(value: any): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalTimeJson).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalTimeJson(value[key])).join(",") + "}";
  throw new Problem(422, "Time evidence must contain only supported JSON values.");
}
export async function timeTransaction<T>(db: Database, operation: (tx: Queryable) => Promise<T>, repeatable = false): Promise<T> {
  for (let attempt = 0; ; attempt++) try {
    return await db.transaction(async tx => {
      if (repeatable) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
      return operation(tx);
    });
  } catch (error: any) {
    if (["40001", "40P01"].includes(error.code) && attempt < 1) continue;
    if (["40001", "40P01", "55P03", "57014"].includes(error.code)) throw new Problem(503, "Time records are busy. Retry the same command when available.");
    throw error;
  }
}

/** Every writer locks exactly actor/affected employees before domain rows. */
export async function currentTimeActor(tx: Queryable, supplied: Actor, sessionHash: string | undefined, employeeId?: string | string[], write = false): Promise<Actor> {
  requireCondition(supplied.mode === "password", 403, "Sign in with your password to open time records.");
  requireCondition(sessionHash, 401, "A verified password session is required.");
  const employees = employeeId ? (Array.isArray(employeeId) ? employeeId : [employeeId]) : [];
  requireCondition(employees.length <= 50, 422, "This time-record page contains too many employees.");
  const ids = [...new Set([supplied.id, ...employees])].sort();
  const rows = (await tx.query(`SELECT id,name,role,active,requires_credential_change FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${write ? "NO KEY UPDATE" : "SHARE"}`, [supplied.org_id, ids])).rows;
  const user = rows.find(row => row.id === supplied.id);
  requireCondition(user?.active && !user.requires_credential_change, 403, "This account is inactive or must finish credential setup.");
  requireCondition(employees.every(id => rows.some(row => row.id === id)), 404, "Employee not found.");
  const unitIds = (await tx.query("SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id FOR SHARE", [supplied.org_id, supplied.id])).rows.map(row => row.unit_id);
  const actor = { ...supplied, name: user.name, role: user.role, unit_ids: unitIds };
  await recheckReportSession(tx, actor, sessionHash);
  return actor;
}
export async function timeJobs(tx: Queryable, actor: Actor, jobIds: string[], lock = true): Promise<Row[]> {
  const ids = [...new Set(jobIds)].sort();
  const jobs = (await tx.query(`SELECT id,unit_id,title,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? " FOR SHARE" : ""}`, [actor.org_id, ids])).rows;
  requireCondition(jobs.length === ids.length, 404, "A referenced time-record job is unavailable.");
  const unitIds = [...new Set(jobs.map(row => row.unit_id))].sort();
  const units = (await tx.query(`SELECT id,name FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? " FOR SHARE" : ""}`, [actor.org_id, unitIds])).rows;
  requireCondition(units.length === unitIds.length, 404, "A referenced organizational unit is unavailable.");
  return jobs.map(job => ({ ...job, unit_name: units.find(unit => unit.id === job.unit_id)!.name }));
}
export function allowsTimeScope(actor: Actor, employeeId: string, jobs: Row[], capturedUnitIds: string[] = [], management = false) {
  return employeeId === actor.id || ((management ? manages(actor) : canReport(actor)) && (orgWide(actor) || [...capturedUnitIds, ...jobs.map(job => job.unit_id)].every(unitId => actor.unit_ids.includes(unitId))));
}
export async function noTimeOverlap(tx: Queryable, orgId: string, employeeId: string, startedAt: string | Date, endedAt: string | Date | null, excludeShiftId: string | null = null) {
  return !(await tx.query("SELECT id FROM shifts WHERE org_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR id<>$3) AND started_at<coalesce($5::timestamptz,'infinity'::timestamptz) AND coalesce(ended_at,'infinity'::timestamptz)>$4::timestamptz LIMIT 1",
    [orgId, employeeId, excludeShiftId, startedAt, endedAt])).rows.length;
}
