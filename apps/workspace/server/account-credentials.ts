import type { Express } from "express";
import { changePasswordInput } from "../shared/account-credentials";
import type { AppRequest } from "./auth";
import type { Database } from "./db";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { audit, digest, hashPassword, limitAuth, opaqueToken, requireCondition, verifyPassword, type Actor } from "./security";

/** Self-service change: account lock precedes session/challenge locks, as in MFA and setup. */
export async function changeOwnPassword(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown) {
  const input = changePasswordInput.parse(raw);
  requireCondition(actor.mode === "password", 403, "Sign in with your password to change it.");
  requireCondition(sessionHash && /^[a-f0-9]{64}$/.test(sessionHash), 401, "Sign in again before changing your password.");
  const proof = await db.transaction(async tx => {
    await currentReportActor(tx, actor, sessionHash);
    return (await tx.query("SELECT password_hash FROM users WHERE id=$1 AND org_id=$2", [actor.id, actor.org_id])).rows[0].password_hash as string;
  });
  requireCondition(await verifyPassword(input.currentPassword, proof), 400, "Your current password is incorrect. Try again.");
  requireCondition(input.newPassword !== input.currentPassword, 400, "Choose a different new password.");
  const passwordHash = await hashPassword(input.newPassword);
  return db.transaction(async tx => {
    const current = await currentReportActor(tx, actor, sessionHash, true);
    const person = (await tx.query("SELECT password_hash FROM users WHERE id=$1 AND org_id=$2", [actor.id, actor.org_id])).rows[0];
    requireCondition(person.password_hash === proof, 401, "Your account changed. Sign in again.");
    const session = (await tx.query(`SELECT expires_at,mfa_verified FROM sessions WHERE token_hash=$1 AND org_id=$2 AND user_id=$3
      AND mode='password' AND expires_at>clock_timestamp() FOR UPDATE`, [sessionHash, actor.org_id, actor.id])).rows[0];
    requireCondition(session, 401, "Your session expired. Sign in again.");
    // The existing authenticated session's MFA assurance and deadline carry forward.
    const token = opaqueToken(), csrf = opaqueToken();
    await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2 AND org_id=$3", [passwordHash, current.id, current.org_id]);
    await tx.query("DELETE FROM sessions WHERE user_id=$1 AND org_id=$2", [current.id, current.org_id]);
    await tx.query("UPDATE setup_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND org_id=$2 AND consumed_at IS NULL", [current.id, current.org_id]);
    await tx.query("DELETE FROM mfa_challenges WHERE user_id=$1 AND org_id=$2", [current.id, current.org_id]);
    await tx.query("DELETE FROM credential_change_challenges WHERE user_id=$1 AND org_id=$2", [current.id, current.org_id]);
    await tx.query("DELETE FROM mfa_factors WHERE user_id=$1 AND org_id=$2 AND enabled_at IS NULL", [current.id, current.org_id]);
    await tx.query("UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL", [current.id, current.org_id]);
    await tx.query(`INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at,mfa_verified) VALUES($1,$2,$3,'password',$4,$5,$6)`,
      [digest(token), current.org_id, current.id, csrf, session.expires_at, session.mfa_verified]);
    await audit(tx, current, "auth.password_changed", current.id, { otherSessionsRevoked: true, apiTokensRevoked: true });
    await recheckReportSession(tx, current, digest(token));
    return { token, csrf, expiresAt: new Date(session.expires_at).getTime() };
  });
}

export function installAccountCredentials(app: Express, db: Database, secure: boolean) {
  app.post("/api/auth/password", async (req, res) => {
    const request = req as AppRequest;
    await limitAuth(db, "password:change:" + request.actor.id, 10);
    const result = await changeOwnPassword(db, request.actor, request.sessionHash, req.body);
    res.cookie(secure ? "__Host-stjw" : "stjw_session", result.token, {
      httpOnly: true, secure, sameSite: "strict", path: "/",
      maxAge: Math.max(0, result.expiresAt - Date.now()),
    });
    res.json({ ok: true, csrf: result.csrf });
  });
}
