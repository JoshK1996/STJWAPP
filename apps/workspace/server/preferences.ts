import type { Database } from "./db";
import { audit, canReport, Problem, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { normalizePreferences, preferencesPatchSchema, preferencesSchema } from "../shared/preferences";

/** Preserve partial preference merging, with mandatory actual proof and account UPDATE first. */
export async function savePersonalPreferences(db: Database, suppliedActor: Actor, sessionHash: string | undefined, raw: unknown) {
  requireCondition(typeof sessionHash === "string" && /^[a-f0-9]{64}$/.test(sessionHash), 401, "Your session has expired or changed. Sign in again.");
  const hash = sessionHash, input = preferencesPatchSchema.parse(raw), identity = { ...suppliedActor, unit_ids: [...suppliedActor.unit_ids] };
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
      const actor = await currentReportActor(tx, identity, hash, true);
      if (input.home === "reports") requireCondition(canReport(actor), 403, "Choose a home page available to your role.");
      const user = (await tx.query("SELECT preferences FROM users WHERE id=$1 AND org_id=$2", [actor.id, actor.org_id])).rows[0];
      const preferences = preferencesSchema.parse({ ...normalizePreferences(user.preferences), ...input });
      await tx.query("UPDATE users SET preferences=$1 WHERE id=$2 AND org_id=$3", [JSON.stringify(preferences), actor.id, actor.org_id]);
      await audit(tx, actor, "preferences.updated", actor.id, { fields: Object.keys(input) });
      const result = { ok: true as const, preferences }; JSON.stringify(result);
      await recheckReportSession(tx, actor, hash); return result;
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (["40001", "40P01"].includes(code ?? "") && attempt < 2) continue;
      if (["55P03", "57014", "40001", "40P01"].includes(code ?? "")) throw new Problem(503, "Personal preferences are busy. Refresh the saved values before retrying your changes.");
      throw error;
    }
  }
}
