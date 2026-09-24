import type { Express, Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import {
  audit,
  digest,
  limitAuth,
  opaqueToken,
  requireCondition,
  verifyPassword,
} from "./security";
import {
  base32,
  decryptFactor,
  encryptFactor,
  matchingCounter,
  mfaKeyAvailable,
} from "./totp";

type Session = { token: string; maxAge: number };
type SessionFactory = (
  tx: Queryable,
  user: { id: string; org_id: string },
  mode: "password" | "pin",
  mfaVerified?: boolean,
) => Promise<Session>;
type SendSession = (res: Response, session: Session, extra?: Row) => void;
const passwordInput = z
  .object({ password: z.string().min(1).max(128) })
  .strict();
const factorProof = passwordInput
  .extend({ code: z.string().trim().min(6).max(40) })
  .strict();
const identity = (factor: Row) =>
  [factor.org_id, factor.user_id, factor.id].join(":");
const recoveryDigest = (userId: string, code: string) =>
  digest(
    "mfa-recovery:" + userId + ":" + code.replaceAll("-", "").toUpperCase(),
  );

// Caller holds the account lock; a password proof never becomes a full session before MFA.
export async function createMfaChallenge(tx: Queryable, user: Row) {
  const current = (await tx.query("SELECT active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2", [user.id, user.org_id])).rows[0];
  requireCondition(current?.active && !current.requires_credential_change, 403, "Replace both temporary credentials before signing in.");
  const factor = (
    await tx.query(
      "SELECT id FROM mfa_factors WHERE user_id=$1 AND org_id=$2 AND enabled_at IS NOT NULL",
      [user.id, user.org_id],
    )
  ).rows[0];
  if (!factor) return null;
  const token = opaqueToken(),
    expiresAt = new Date(Date.now() + 5 * 60_000);
  await tx.query(
    "DELETE FROM mfa_challenges WHERE user_id=$1 AND expires_at<clock_timestamp()",
    [user.id],
  );
  await tx.query(
    "INSERT INTO mfa_challenges(token_hash,user_id,org_id,factor_id,credential_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      digest(token),
      user.id,
      user.org_id,
      factor.id,
      digest(user.password_hash),
      expiresAt,
    ],
  );
  return { challenge: token, expiresAt: expiresAt.toISOString() };
}
async function consumeFactor(tx: Queryable, factor: Row, code: string) {
  if (/^\d{6}$/.test(code)) {
    const counter = matchingCounter(
      decryptFactor(factor.secret_cipher, identity(factor)),
      code,
      Number(factor.last_counter),
    );
    requireCondition(
      counter !== null,
      401,
      "That code is invalid or already used. Wait for the next code, or use a recovery code.",
    );
    await tx.query("UPDATE mfa_factors SET last_counter=$1 WHERE user_id=$2", [
      counter,
      factor.user_id,
    ]);
    return "authenticator";
  }
  requireCondition(
    /^[A-Fa-f0-9-]{32,35}$/.test(code),
    401,
    "That recovery code is invalid or already used.",
  );
  const consumed = await tx.query(
    "UPDATE mfa_recovery_codes SET used_at=clock_timestamp() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash",
    [factor.user_id, recoveryDigest(factor.user_id, code)],
  );
  requireCondition(
    consumed.rows.length === 1,
    401,
    "That recovery code is invalid or already used.",
  );
  return "recovery";
}
async function recoveryCodes(tx: Queryable, userId: string) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").toUpperCase().match(/.{8}/g)!.join("-"),
  );
  await tx.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [userId]);
  for (const code of codes)
    await tx.query(
      "INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)",
      [userId, recoveryDigest(userId, code)],
    );
  return codes;
}
async function revokeCredentials(tx: Queryable, userId: string) {
  await tx.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
  await tx.query("DELETE FROM mfa_challenges WHERE user_id=$1", [userId]);
  await tx.query(
    "UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
    [userId],
  );
}
export function installMfaChallenge(
  app: Express,
  db: Database,
  createSession: SessionFactory,
  sendSession: SendSession,
) {
  app.post("/api/auth/mfa/verify", async (req, res) => {
    const input = z
      .object({
        challenge: z.string().min(32).max(100),
        code: z.string().trim().min(6).max(40),
      })
      .strict()
      .parse(req.body);
    await limitAuth(db, "mfa:address:" + req.socket.remoteAddress, 100);
    const candidate = (
      await db.query(
        "SELECT user_id,org_id FROM mfa_challenges WHERE token_hash=$1",
        [digest(input.challenge)],
      )
    ).rows[0];
    requireCondition(
      candidate,
      401,
      "This sign-in request is invalid or expired. Sign in again.",
    );
    await limitAuth(db, "mfa:verify:" + candidate.user_id, 10);
    const result = await db.transaction(async (tx) => {
      const user = (
        await tx.query(
          "SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [candidate.user_id, candidate.org_id],
        )
      ).rows[0];
      requireCondition(
        user?.active && !user.requires_credential_change,
        401,
        "This sign-in request is invalid or expired. Sign in again.",
      );
      const challenge = (
        await tx.query(
          "SELECT * FROM mfa_challenges WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR UPDATE",
          [digest(input.challenge), user.id],
        )
      ).rows[0];
      requireCondition(
        challenge &&
          challenge.credential_digest === digest(user.password_hash ?? ""),
        401,
        "This sign-in request is invalid or expired. Sign in again.",
      );
      const factor = (
        await tx.query(
          "SELECT * FROM mfa_factors WHERE user_id=$1 AND id=$2 AND enabled_at IS NOT NULL",
          [user.id, challenge.factor_id],
        )
      ).rows[0];
      requireCondition(
        factor,
        401,
        "Authenticator settings changed. Sign in again.",
      );
      const method = await consumeFactor(tx, factor, input.code);
      await tx.query("DELETE FROM mfa_challenges WHERE token_hash=$1", [
        digest(input.challenge),
      ]);
      const session = await createSession(
        tx,
        user as { id: string; org_id: string },
        "password",
        true,
      );
      await audit(
        tx,
        { id: user.id, org_id: user.org_id },
        "auth.signed_in",
        user.id,
        { mode: "password", secondFactor: method },
      );
      return session;
    });
    sendSession(res, result);
  });
}
async function passwordProof(db: Database, req: Request, password: string) {
  const actor = (req as AppRequest).actor;
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to manage your authenticator.",
  );
  await limitAuth(db, "mfa:settings:" + actor.id, 10);
  const user = (
    await db.query(
      "SELECT password_hash FROM users WHERE id=$1 AND org_id=$2",
      [actor.id, actor.org_id],
    )
  ).rows[0];
  requireCondition(
    await verifyPassword(password, user?.password_hash ?? null),
    401,
    "Password verification failed.",
  );
  return user.password_hash as string;
}
async function lockedAccount(
  tx: Queryable,
  req: Request,
  passwordHash?: string,
) {
  const request = req as AppRequest,
    actor = request.actor;
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to manage your authenticator.",
  );
  const user = (
    await tx.query("SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE", [
      actor.id,
      actor.org_id,
    ])
  ).rows[0];
  requireCondition(
    user?.active && !user.requires_credential_change && (!passwordHash || user.password_hash === passwordHash),
    401,
    "Your account changed. Sign in again.",
  );
  const session = (
    await tx.query(
      "SELECT token_hash,mfa_verified FROM sessions WHERE token_hash=$1 AND user_id=$2 AND mode='password' AND expires_at>clock_timestamp() FOR UPDATE",
      [request.sessionHash, actor.id],
    )
  ).rows[0];
  requireCondition(session, 401, "Your session has expired. Sign in again.");
  const factor = (
    await tx.query("SELECT enabled_at FROM mfa_factors WHERE user_id=$1", [
      actor.id,
    ])
  ).rows[0];
  requireCondition(
    !factor?.enabled_at || session.mfa_verified,
    401,
    "Sign in again with your authenticator.",
  );
  return user;
}
export function installMfaSettings(
  app: Express,
  db: Database,
  createSession: SessionFactory,
  sendSession: SendSession,
) {
  app.get("/api/auth/mfa", async (req, res) => {
    const actor = (req as AppRequest).actor;
    const factor = (
      await db.query(
        "SELECT enabled_at FROM mfa_factors WHERE user_id=$1 AND org_id=$2",
        [actor.id, actor.org_id],
      )
    ).rows[0];
    const count = (
      await db.query(
        "SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
        [actor.id],
      )
    ).rows[0].n;
    res.json({
      available: mfaKeyAvailable(),
      enabled: !!factor?.enabled_at,
      enabledAt: factor?.enabled_at ?? null,
      recoveryCodesRemaining: count,
    });
  });
  app.post("/api/auth/mfa/enroll", async (req, res) => {
    const input = passwordInput.parse(req.body),
      proof = await passwordProof(db, req, input.password);
    const result = await db.transaction(async (tx) => {
      const user = await lockedAccount(tx, req, proof);
      const existing = (
        await tx.query("SELECT enabled_at FROM mfa_factors WHERE user_id=$1", [
          user.id,
        ])
      ).rows[0];
      requireCondition(
        !existing?.enabled_at,
        409,
        "An authenticator is already enabled.",
      );
      const secret = randomBytes(20),
        id = randomUUID(),
        factor = { id, org_id: user.org_id, user_id: user.id };
      const cipher = encryptFactor(secret, identity(factor)),
        key = base32(secret),
        expiresAt = new Date(Date.now() + 10 * 60_000);
      const uri =
        "otpauth://totp/STJW:" +
        encodeURIComponent(user.email) +
        "?" +
        new URLSearchParams({
          secret: key,
          issuer: "STJW",
          algorithm: "SHA1",
          digits: "6",
          period: "30",
        });
      await tx.query(
        "INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,secret_cipher=excluded.secret_cipher,credential_digest=excluded.credential_digest,pending_expires_at=excluded.pending_expires_at,last_counter=-1",
        [user.id, user.org_id, id, cipher, digest(proof), expiresAt],
      );
      await audit(
        tx,
        { id: user.id, org_id: user.org_id },
        "auth.mfa_enrollment_started",
        user.id,
      );
      return {
        id,
        secret: key,
        qrDataUrl: await QRCode.toDataURL(uri, { width: 240, margin: 4 }),
        expiresAt: expiresAt.toISOString(),
      };
    });
    res.json(result);
  });
  app.post("/api/auth/mfa/confirm", async (req, res) => {
    const input = z
        .object({ id: z.uuid(), code: z.string().regex(/^\d{6}$/) })
        .strict()
        .parse(req.body),
      actor = (req as AppRequest).actor;
    await limitAuth(db, "mfa:confirm:" + actor.id, 10);
    const result = await db.transaction(async (tx) => {
      const user = await lockedAccount(tx, req);
      const factor = (
        await tx.query(
          "SELECT * FROM mfa_factors WHERE user_id=$1 AND id=$2 AND enabled_at IS NULL AND pending_expires_at>clock_timestamp()",
          [user.id, input.id],
        )
      ).rows[0];
      requireCondition(
        factor && factor.credential_digest === digest(user.password_hash ?? ""),
        409,
        "Authenticator setup changed or expired. Start setup again.",
      );
      await consumeFactor(tx, factor, input.code);
      await tx.query(
        "UPDATE mfa_factors SET enabled_at=clock_timestamp() WHERE user_id=$1",
        [user.id],
      );
      const codes = await recoveryCodes(tx, user.id);
      await revokeCredentials(tx, user.id);
      const session = await createSession(
        tx,
        user as { id: string; org_id: string },
        "password",
        true,
      );
      await audit(tx, actor, "auth.mfa_enabled", user.id);
      return { session, codes };
    });
    sendSession(res, result.session, { recoveryCodes: result.codes });
  });
  for (const action of ["recovery-codes", "disable"] as const)
    app.post("/api/auth/mfa/" + action, async (req, res) => {
      const input = factorProof.parse(req.body),
        proof = await passwordProof(db, req, input.password),
        actor = (req as AppRequest).actor;
      const result = await db.transaction(async (tx) => {
        const user = await lockedAccount(tx, req, proof);
        const factor = (
          await tx.query(
            "SELECT * FROM mfa_factors WHERE user_id=$1 AND enabled_at IS NOT NULL",
            [user.id],
          )
        ).rows[0];
        requireCondition(factor, 409, "No authenticator is enabled.");
        const method = await consumeFactor(tx, factor, input.code);
        const codes =
          action === "recovery-codes" ? await recoveryCodes(tx, user.id) : [];
        if (action === "disable")
          await tx.query("DELETE FROM mfa_factors WHERE user_id=$1", [user.id]);
        await revokeCredentials(tx, user.id);
        const session = await createSession(
          tx,
          user as { id: string; org_id: string },
          "password",
          action !== "disable",
        );
        await audit(
          tx,
          actor,
          action === "disable"
            ? "auth.mfa_disabled"
            : "auth.mfa_recovery_replaced",
          user.id,
          { secondFactor: method },
        );
        return { session, codes };
      });
      sendSession(res, result.session, { recoveryCodes: result.codes });
    });
}
