import type { Database, Queryable } from "./db";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { Problem, requireCondition, type Actor } from "./security";

/** HTTP-oriented finance work always supplies the actual verified session.
 * Current financial roles remain organization-wide; unit memberships do not
 * narrow that existing policy. Account/session locks precede domain locks. */
export async function currentFinanceActor(tx: Queryable, supplied: Actor, sessionHash: string | undefined): Promise<Actor> {
  requireCondition(typeof sessionHash === "string" && /^[a-f0-9]{64}$/.test(sessionHash), 401, "A verified password session is required.");
  const actor = await currentReportActor(tx, supplied, sessionHash);
  requireCondition(["developer", "owner", "admin", "finance"].includes(actor.role), 403, "Financial report access is required.");
  return actor;
}
export async function financeTransaction<T>(db: Database, supplied: Actor, sessionHash: string | undefined,
  action: (tx: Queryable, current: Actor) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async tx => {
      const actor = await currentFinanceActor(tx, supplied, sessionHash), result = await action(tx, actor);
      // Validate ordinary JSON serialization before final publication proof.
      // File callbacks build their exact existing CSV/source bytes themselves.
      // Keep original service value types and property order unchanged.
      JSON.stringify(result);
      await recheckReportSession(tx, actor, sessionHash!);
      return result;
    });
  } catch (error) {
    if (["55P03", "57014", "40001", "40P01"].includes((error as { code?: string }).code ?? ""))
      throw new Problem(503, "Financial reports are busy. Retry the same request when they are available.");
    throw error;
  }
}
