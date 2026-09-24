import type { Database, Queryable } from "./db";
import { Problem, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";

// Only the save-only grant locker creates this tag. Other 55P03 errors are not
// treated as grant contention, and no retry continues an aborted transaction.
export class LayoutGrantContention extends Error {}

// Layout custody is separate from source authority. Callers decide whether a
// current source is needed; every path still requires the actual live session.
export async function reportLayoutTransaction<T>(
  db: Database,
  supplied: Actor,
  sessionHash: string | undefined,
  write: boolean,
  action: (tx: Queryable, actor: Actor) => Promise<T>,
): Promise<T> {
  requireCondition(sessionHash, 401, "Your session has expired or changed. Sign in again.");
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async tx => {
        // Writes take UPDATE on the first account lock, without a SHARE upgrade.
        const actor = await currentReportActor(tx, supplied, sessionHash, write);
        const result = await action(tx, actor);
        await recheckReportSession(tx, actor, sessionHash);
        return result;
      });
    } catch (error: any) {
      const contention = error instanceof LayoutGrantContention;
      if (!contention && !["40001", "40P01"].includes(error.code)) throw error;
      if (attempt >= 2) {
        if (contention) throw new Problem(503, "Report access is changing. Retry this save.");
        throw error;
      }
      // The transaction has rolled back; let its competing writer progress.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}
