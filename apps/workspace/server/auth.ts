import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { Database, Queryable } from "./db";
import {
  audit,
  digest,
  hashPassword,
  limitAuth,
  opaqueToken,
  requireCondition,
  verifyPassword,
  type Actor,
} from "./security";
import { loginInput, passwordSchema } from "../shared/contracts";
import { completeInitialCredentials, createCredentialChangeChallenge } from "./temporary-credentials";
import { completeCredentialsInput } from "../shared/temporary-credentials";
import { acquirePinNamespace, admitPinLogin, recordPinFailure, resolvePinAccount, uniquePermanentPin } from "./pin-auth";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import {
  createMfaChallenge,
  installMfaChallenge,
  installMfaSettings,
} from "./auth-mfa";
export type AppRequest = Request & { actor: Actor; sessionHash?: string };
export function installAuth(app: Express, db: Database, secure: boolean) {
  const cookieName = secure ? "__Host-stjw" : "stjw_session";
  const options = {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
  };
  async function createSession(
    tx: Queryable,
    user: { id: string; org_id: string },
    mode: "password" | "pin",
    mfaVerified = false,
  ) {
    const current = (await tx.query("SELECT active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2", [user.id, user.org_id])).rows[0];
    requireCondition(current?.active && !current.requires_credential_change, 403, "Replace both temporary credentials before signing in.");
    const token = opaqueToken(),
      csrf = opaqueToken(),
      maxAge = (mode === "pin" ? 5 : 480) * 60 * 1000;
    await tx.query(
      "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at,mfa_verified) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        digest(token),
        user.org_id,
        user.id,
        mode,
        csrf,
        new Date(Date.now() + maxAge),
        mfaVerified,
      ],
    );
    return { token, maxAge };
  }
  function sendSession(
    res: Response,
    session: { token: string; maxAge: number },
    extra: Record<string, unknown> = {},
  ) {
    res.cookie(cookieName, session.token, {
      ...options,
      maxAge: session.maxAge,
    });
    res.json({ ok: true, ...extra });
  }
  installMfaChallenge(app, db, createSession, sendSession);
  app.post("/api/auth/login", async (req, res) => {
    const input = loginInput.parse(req.body);
    if (input.mode === "pin" && !input.email) {
      const address = req.socket.remoteAddress ?? "unknown";
      await admitPinLogin(db, address);
      // No PIN-derived rate-limit key: six-digit PINs must not become offline
      // enumerable SHA-256 values in auth_limits.
      let result;
      try { result = await db.transaction(async tx => {
        await acquirePinNamespace(tx);
        const proof = await resolvePinAccount(tx, input.credential);
        const current = (await tx.query("SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE", [proof.id, proof.org_id])).rows[0];
        requireCondition(current?.active && current.pin_hash === proof.pin_hash && current.pin_lookup === proof.pin_lookup && current.pin_lookup_key_id === proof.pin_lookup_key_id,
          401, "The PIN is unavailable or incorrect. Use your email and password.");
        const onboarding = current.requires_credential_change ? await createCredentialChangeChallenge(tx, current) : null;
        if (!onboarding && !current.pin_lookup) await tx.query("UPDATE users SET pin_lookup=$1,pin_lookup_key_id=$4 WHERE id=$2 AND org_id=$3", [proof.lookup, current.id, current.org_id, proof.keyId]);
        const session = onboarding ?? await createSession(tx, current as {id:string;org_id:string}, "pin");
        await audit(tx, current as {id:string;org_id:string}, onboarding ? "auth.initial_credentials_challenge_created" : "auth.signed_in", current.id, {mode:"pin"});
        return session;
      }); } catch(error) {
        if (error instanceof Error && "status" in error && error.status === 401) await recordPinFailure(db, address);
        throw error;
      }
      res.set("Cache-Control", "private, no-store");
      if ("requiresCredentialChange" in result) { res.clearCookie(cookieName, options); res.json(result); }
      else sendSession(res, result);
      return;
    }
    // Legacy email+PIN clients remain supported; the new clock UI sends no email.
    const email = input.email!;
    await limitAuth(db, "login:address:" + req.socket.remoteAddress, 100);
    await limitAuth(db, "login:account:" + email, 10);
    const user = (
      await db.query("SELECT * FROM users WHERE email=$1", [email])
    ).rows[0];
    const credentialField = input.mode === "pin" ? "pin_hash" : "password_hash";
    const valid = await verifyPassword(
      input.credential,
      user?.[credentialField] ?? null,
    );
    requireCondition(
      valid && user?.active,
      401,
      "The email or sign-in credential is incorrect.",
    );
    const session = await db.transaction(async (tx) => {
      // Hashing runs outside the lock; a reset or deactivation invalidates that proof.
      const current = (
        await tx.query(
          "SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [user.id, user.org_id],
        )
      ).rows[0];
      requireCondition(
        current?.active &&
          current.email === email &&
          current[credentialField] === user[credentialField],
        401,
        "The email or sign-in credential is incorrect.",
      );
      const credentialChange = current.requires_credential_change ? await createCredentialChangeChallenge(tx, current) : null;
      const challenge =
        !credentialChange && input.mode === "password"
          ? await createMfaChallenge(tx, current)
          : null;
      const session =
        credentialChange ?? challenge ??
        (await createSession(
          tx,
          current as { id: string; org_id: string },
          input.mode,
        ));
      await tx.query("DELETE FROM auth_limits WHERE bucket=$1", [
        digest("login:account:" + email),
      ]);
      await audit(
        tx,
        { id: user.id, org_id: user.org_id },
        credentialChange ? "auth.initial_credentials_challenge_created" : challenge ? "auth.mfa_challenge_created" : "auth.signed_in",
        user.id,
        { mode: input.mode },
      );
      return session;
    });
    if ("requiresCredentialChange" in session) { res.clearCookie(cookieName, options); res.json(session); }
    else if ("challenge" in session) res.json(session);
    else sendSession(res, session);
  });
  app.post("/api/auth/setup", async (req, res) => {
    const input = z
      .object({ token: z.string().min(32).max(100), password: passwordSchema })
      .strict()
      .parse(req.body);
    await limitAuth(db, "setup:address:" + req.socket.remoteAddress, 20);
    const passwordHash = await hashPassword(input.password);
    const session = await db.transaction(async (tx) => {
      await acquirePinNamespace(tx);
      const invalidLink =
        "This setup link is invalid or expired. Ask an administrator for a new one.";
      const candidate = (
        await tx.query(
          "SELECT user_id,org_id FROM setup_tokens WHERE token_hash=$1",
          [digest(input.token)],
        )
      ).rows[0];
      requireCondition(candidate, 400, invalidLink);
      // All setup issuance/consumption locks the account before token rows.
      const person = (
        await tx.query(
          "SELECT id,org_id,active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [candidate.user_id, candidate.org_id],
        )
      ).rows[0];
      requireCondition(person?.active, 403, "This account is inactive.");
      requireCondition(!person.requires_credential_change, 403, "Sign in with a temporary credential and replace both credentials before using a setup link.");
      const token = (
        await tx.query(
          "SELECT token_hash FROM setup_tokens WHERE token_hash=$1 AND user_id=$2 AND org_id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
          [digest(input.token), person.id, person.org_id],
        )
      ).rows[0];
      requireCondition(token, 400, invalidLink);
      await tx.query(
        "UPDATE users SET password_hash=$1,pin_hash=NULL,pin_lookup=NULL,pin_lookup_key_id=NULL WHERE id=$2",
        [passwordHash, person.id],
      );
      await tx.query(
        "UPDATE setup_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
        [person.id],
      );
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [person.id]);
      await tx.query("DELETE FROM mfa_challenges WHERE user_id=$1", [
        person.id,
      ]);
      await tx.query(
        "UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [person.id],
      );
      const challenge = await createMfaChallenge(tx, {
        ...person,
        password_hash: passwordHash,
      });
      const session =
        challenge ??
        (await createSession(
          tx,
          person as { id: string; org_id: string },
          "password",
        ));
      await audit(
        tx,
        { id: person.id, org_id: person.org_id },
        "auth.password_set",
        person.id,
      );
      return session;
    });
    if ("challenge" in session) res.json(session);
    else sendSession(res, session);
  });
  app.post("/api/auth/credentials/complete", async (req, res) => {
    const input = completeCredentialsInput.parse(req.body);
    await limitAuth(db, "credentials:complete:address:" + req.socket.remoteAddress, 30);
    await limitAuth(db, "credentials:complete:proof:" + digest(input.challenge), 10);
    const result = await completeInitialCredentials(db, input);
    res.clearCookie(cookieName, options); res.json(result);
  });
  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    const bearer = req.get("authorization");
    let result;
    if (bearer) {
      requireCondition(
        bearer.startsWith("Bearer ") && bearer.length < 200,
        401,
        "Invalid API authorization.",
      );
      requireCondition(
        req.method === "GET",
        403,
        "Agent API tokens are read-only in this release.",
      );
      result = (
        await db.query(
          `SELECT u.*,t.scopes,'api' AS mode FROM api_tokens t JOIN users u ON u.id=t.user_id AND u.org_id=t.org_id
        WHERE t.token_hash=$1 AND t.expires_at>now() AND t.revoked_at IS NULL AND u.active=true AND u.requires_credential_change=false`,
          [digest(bearer.slice(7))],
        )
      ).rows[0];
      const payrollRead = ["/payroll/hours", "/payroll/hours/export", "/payroll/review", "/payroll/review/export", "/payroll/views"].includes(req.path)
        || /^\/payroll\/views\/[0-9a-f-]{36}\/resolve$/i.test(req.path);
      const needed = (req.path.startsWith("/reports") || payrollRead)
        ? "reports:read"
        : req.path === "/staff"
          ? "staff:read"
          : null;
      requireCondition(
        result && needed && result.scopes.includes(needed),
        403,
        "This token cannot access this endpoint.",
      );
    } else {
      const token = req.cookies[cookieName];
      requireCondition(
        typeof token === "string" && token.length < 100,
        401,
        "Sign in to continue.",
      );
      (req as AppRequest).sessionHash = digest(token);
      result = (
        await db.query(
          `SELECT u.*,s.mode,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true AND u.requires_credential_change=false
        AND (s.mode='pin' OR s.mfa_verified OR NOT EXISTS(SELECT 1 FROM mfa_factors f WHERE f.user_id=u.id AND f.enabled_at IS NOT NULL))`,
          [digest(token)],
        )
      ).rows[0];
      requireCondition(result, 401, "Your session has expired. Sign in again.");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
        requireCondition(
          req.get("x-csrf-token") === result.csrf,
          403,
          "Refresh the page before trying again.",
        );
    }
    const units = (
      await db.query(
        "SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2",
        [result.id, result.org_id],
      )
    ).rows.map((x) => x.unit_id);
    const actor: Actor = {
      id: result.id,
      org_id: result.org_id,
      name: result.name,
      email: result.email,
      role: result.role,
      unit_ids: units,
      mode: result.mode,
      csrf: result.csrf,
      scopes: result.scopes,
      preferences: result.preferences,
    };
    (req as AppRequest).actor = actor;
    if (actor.mode === "pin")
      requireCondition(
        ["/me", "/clock", "/auth/logout"].includes(req.path),
        403,
        "Sign in with your password to open this area.",
      );
    next();
  });
  app.post("/api/auth/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      (req as AppRequest).sessionHash,
    ]);
    res.clearCookie(cookieName, options);
    res.json({ ok: true });
  });
  installMfaSettings(app, db, createSession, sendSession);
  app.post("/api/auth/pin", async (req, res) => {
    const actor = (req as AppRequest).actor;
    const input = z
      .object({
        password: z.string().max(128),
        pin: z.string().regex(/^\d{6,8}$/),
      })
      .strict()
      .parse(req.body);
    await limitAuth(db, "pin:change:" + actor.id, 10);
    const user = (
      await db.query(
        "SELECT password_hash FROM users WHERE id=$1 AND org_id=$2",
        [actor.id, actor.org_id],
      )
    ).rows[0];
    requireCondition(
      await verifyPassword(input.password, user?.password_hash ?? null),
      401,
      "Password verification failed.",
    );
    const hash = await hashPassword(input.pin);
    await db.transaction(async (tx) => {
      await acquirePinNamespace(tx);
      const current = (
        await tx.query(
          "SELECT active,password_hash,requires_credential_change FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [actor.id, actor.org_id],
        )
      ).rows[0];
      requireCondition(
        current?.active && !current.requires_credential_change && current.password_hash === user.password_hash,
        401,
        "Password verification failed. Sign in again.",
      );
      const authorized = await currentReportActor(tx, actor, (req as AppRequest).sessionHash);
      const session = (
        await tx.query(
          "SELECT token_hash FROM sessions WHERE token_hash=$1 AND org_id=$2 AND user_id=$3 AND mode='password' AND expires_at>clock_timestamp() FOR UPDATE",
          [(req as AppRequest).sessionHash, actor.org_id, actor.id],
        )
      ).rows[0];
      requireCondition(
        session,
        401,
        "Your session has expired. Sign in again.",
      );
      const lookup = await uniquePermanentPin(tx, actor.id, input.pin);
      await tx.query("UPDATE users SET pin_hash=$1,pin_lookup=$3,pin_lookup_key_id=$4 WHERE id=$2", [
        hash,
        actor.id,
        lookup.lookup,
        lookup.keyId,
      ]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1 AND mode='pin'", [
        actor.id,
      ]);
      await audit(tx, actor, "auth.pin_changed", actor.id);
      await recheckReportSession(tx, authorized, (req as AppRequest).sessionHash!);
    });
    res.json({ ok: true });
  });
}
