import type { Database, Queryable, Row } from "./db";
import { audit, digest, hashPassword, issueSetup, limitAuth, opaqueToken, requireCondition, verifyPassword, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { createStaff } from "./workforce";
import { completeCredentialsInput, credentialChangeChallengeSchema, staffCreateInput, staffCreateResultSchema } from "../shared/temporary-credentials";
import { acquirePinNamespace, uniquePermanentPin } from "./pin-auth";

const invalid = "This credential-change request is expired or changed. Sign in again; if you already saved new credentials, use those.";
// Retain the legacy digest for the legacy both-required policy so existing
// short-lived challenges remain valid through the additive migration.
const credentialDigest = (user: Row) => digest(JSON.stringify(user.require_password_change && user.require_pin_change
  ? ["initial-credentials-v1", user.password_hash, user.pin_hash]
  : ["initial-credentials-v2", user.password_hash, user.pin_hash, user.require_password_change, user.require_pin_change]));
const requirements = (user: Row) => ({ requirePasswordChange: user.require_password_change, requirePinChange: user.require_pin_change });

/** Public staff creation boundary. Never log or audit the optional credentials. */
export async function createStaffAccount(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown, staffDomain: string, origin: string) {
  const input = staffCreateInput.parse(raw);
  requireCondition(sessionHash, 401, "A verified password session is required.");
  if (input.initialCredentials) {
    requireCondition(supplied.mode === "password" && ["developer", "owner", "admin"].includes(supplied.role), 403, "Only owners and administrators can create temporary onboarding credentials.");
    await limitAuth(db, "staff:temporary:create:" + supplied.id, 20);
  }
  const hashes = input.initialCredentials ? await Promise.all([hashPassword(input.initialCredentials.password), hashPassword(input.initialCredentials.pin)]) : null;
  return db.transaction(async tx => {
    if (hashes) await acquirePinNamespace(tx);
    const actor = await currentReportActor(tx, supplied, sessionHash);
    if (hashes) requireCondition(["developer", "owner", "admin"].includes(actor.role), 403, "Only owners and administrators can create temporary onboarding credentials.");
    const { initialCredentials: _credentials, ...staff } = input;
    const id = await createStaff(tx, actor, staff, staffDomain);
    let result;
    if (hashes && input.initialCredentials) {
      const { requirePasswordChange, requirePinChange, pin } = input.initialCredentials;
      const pending = requirePasswordChange || requirePinChange;
      const pinLookup = requirePinChange ? null : await uniquePermanentPin(tx, id, pin);
      await tx.query("UPDATE users SET password_hash=$1,pin_hash=$2,requires_credential_change=$5,require_password_change=$6,require_pin_change=$7,pin_lookup=$8,pin_lookup_key_id=$9 WHERE id=$3 AND org_id=$4", [...hashes, id, actor.org_id, pending, requirePasswordChange, requirePinChange, pinLookup?.lookup ?? null, pinLookup?.keyId ?? null]);
      await audit(tx, actor, "staff.temporary_credentials_issued", id, { requiresCredentialChange: pending, requirePasswordChange, requirePinChange });
      result = { id, requiresCredentialChange: pending, requirePasswordChange, requirePinChange };
    } else {
      const token = await issueSetup(tx, { id, org_id: actor.org_id });
      result = { id, setupUrl: origin + "/#setup=" + token };
    }
    await recheckReportSession(tx, actor, sessionHash);
    return staffCreateResultSchema.parse(result);
  });
}

/** Login holds the current account FOR UPDATE and verified its credential proof. */
export async function createCredentialChangeChallenge(tx: Queryable, user: Row) {
  requireCondition(user.active && user.requires_credential_change && user.password_hash && user.pin_hash, 401, invalid);
  const challenge = opaqueToken();
  const created = (await tx.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const createdAt = new Date(created).toISOString(), expiresAt = new Date(new Date(createdAt).valueOf() + 600000).toISOString();
  // A second temporary sign-in invalidates the prior challenge; its raw value
  // never appears in a URL, cookie, session, audit or database column.
  await tx.query("DELETE FROM credential_change_challenges WHERE user_id=$1", [user.id]);
  await tx.query("INSERT INTO credential_change_challenges(token_hash,org_id,user_id,credential_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [digest(challenge), user.org_id, user.id, credentialDigest(user), createdAt, expiresAt]);
  return credentialChangeChallengeSchema.parse({ requiresCredentialChange: true, challenge, expiresAt, ...requirements(user) });
}

export async function completeInitialCredentials(db: Database, raw: unknown) {
  const input = completeCredentialsInput.parse(raw), tokenHash = digest(input.challenge);
  const candidate = (await db.query(`SELECT u.id,u.org_id,u.active,u.requires_credential_change,u.require_password_change,u.require_pin_change,u.password_hash,u.pin_hash,c.credential_digest
    FROM credential_change_challenges c JOIN users u ON u.id=c.user_id AND u.org_id=c.org_id
    WHERE c.token_hash=$1 AND c.expires_at>clock_timestamp()`, [tokenHash])).rows[0];
  requireCondition(candidate?.active && candidate.requires_credential_change && credentialDigest(candidate) === candidate.credential_digest, 401, invalid);
  requireCondition(Boolean(candidate.require_password_change) === (input.password !== undefined), 400, candidate.require_password_change ? 'Enter the new password required for this account.' : 'This account does not require a password change. Leave the existing password unchanged.');
  requireCondition(Boolean(candidate.require_pin_change) === (input.pin !== undefined), 400, candidate.require_pin_change ? 'Enter the new PIN required for this account.' : 'This account does not require a PIN change. Leave the existing PIN unchanged.');
  const [samePassword, samePin] = await Promise.all([input.password === undefined ? false : verifyPassword(input.password, candidate.password_hash), input.pin === undefined ? false : verifyPassword(input.pin, candidate.pin_hash)]);
  requireCondition(!samePassword, 400, "Choose a new password different from the temporary password.");
  requireCondition(!samePin, 400, "Choose a new PIN different from the temporary PIN.");
  const [passwordHash, pinHash] = await Promise.all([input.password === undefined ? candidate.password_hash : hashPassword(input.password), input.pin === undefined ? candidate.pin_hash : hashPassword(input.pin)]);
  return db.transaction(async tx => {
    await acquirePinNamespace(tx);
    // Every auth writer locks account before proof/session rows. The expensive
    // hashes are outside the lock; compare their original evidence after waiting.
    const user = (await tx.query("SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE", [candidate.id, candidate.org_id])).rows[0];
    requireCondition(user?.active && user.requires_credential_change && credentialDigest(user) === candidate.credential_digest, 401, invalid);
    const challenge = (await tx.query("SELECT token_hash,credential_digest FROM credential_change_challenges WHERE token_hash=$1 AND user_id=$2 AND org_id=$3 AND expires_at>clock_timestamp() FOR UPDATE", [tokenHash, user.id, user.org_id])).rows[0];
    requireCondition(challenge?.credential_digest === candidate.credential_digest, 401, invalid);
    const pinLookup = input.pin === undefined ? { lookup: user.pin_lookup, keyId: user.pin_lookup_key_id } : await uniquePermanentPin(tx, user.id, input.pin);
    await tx.query("UPDATE users SET password_hash=$1,pin_hash=$2,requires_credential_change=false,require_password_change=false,require_pin_change=false,pin_lookup=$4,pin_lookup_key_id=$5 WHERE id=$3", [passwordHash, pinHash, user.id, pinLookup.lookup, pinLookup.keyId]);
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
    await tx.query("UPDATE setup_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL", [user.id]);
    await tx.query("DELETE FROM mfa_challenges WHERE user_id=$1", [user.id]);
    await tx.query("UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL", [user.id]);
    await audit(tx, { id: user.id, org_id: user.org_id }, "auth.initial_credentials_replaced", user.id, { passwordReplaced: input.password !== undefined, pinReplaced: input.pin !== undefined });
    // A wait/audit delay may outlast the proof. Keep this final wall-clock check
    // inside the same transaction so no hashes change after proof expiry.
    const consumed = await tx.query("DELETE FROM credential_change_challenges WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() RETURNING token_hash", [tokenHash, user.id]);
    requireCondition(consumed.rows.length === 1, 401, invalid);
    return { ok: true as const, signInRequired: true as const };
  });
}
