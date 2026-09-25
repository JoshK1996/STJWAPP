import { createHash, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Database, Queryable, Row } from "./db";
import { digest, limitAuth, Problem, requireCondition, verifyPassword } from "./security";

export const PIN_LEGACY_LIMIT = 128;
export const PIN_LOOKUP_DEADLINE_MS = 20_000;
const incorrect = "The PIN is unavailable or incorrect. If it is a shared temporary PIN, sign in with your email and password to replace it.";
let scanning = false;
const failureBucket = (address:string) => "pin-login:failures:" + address;
export async function admitPinLogin(db: Database, address: string) {
  // A shared school clock must not consume the password sign-in address budget.
  // Successes count only against this separate generous finite admission cap.
  await limitAuth(db, "pin-login:total:" + address, 600);
  const row = (await db.query("SELECT attempts FROM auth_limits WHERE bucket=$1 AND resets_at>clock_timestamp()", [digest(failureBucket(address))])).rows[0];
  requireCondition(!row || row.attempts < 20, 429, "Too many incorrect PIN attempts. Use email and password, or try again in 15 minutes.");
}
export async function recordPinFailure(db: Database, address: string) {
  await limitAuth(db, failureBucket(address), 20);
}

/** Every PIN writer and account active-state writer takes this BEFORE accounts.
 * This global namespace matches identifier-free login, including across orgs.
 * Do not wait for a KDF scan while holding an account/session/domain lock. */
export async function acquirePinNamespace(tx: Queryable) {
  const result = (await tx.query("SELECT pg_try_advisory_xact_lock(78239133) AS acquired")).rows[0];
  requireCondition(result?.acquired === true, 429, "PIN sign-in or account changes are busy. Try again shortly.");
}

function lookup(pin: string): {lookup: string; keyId: string} {
  const key = process.env.STJW_PIN_LOOKUP_SECRET;
  requireCondition(typeof key === "string" && /^[a-f0-9]{64}$/i.test(key), 503,
    "PIN sign-in is temporarily unavailable. Use your email and password.");
  const bytes = Buffer.from(key, "hex");
  return {lookup:createHmac("sha256", bytes).update("stjw-pin-lookup-v1\0" + pin).digest("hex"),
    keyId:createHash("sha256").update("stjw-pin-key-id-v1\0").update(bytes).digest("hex")};
}

/** At most two scrypt operations run concurrently. A deadline never releases
 * admission while a submitted KDF is still running. No raw PIN/hash in errors. */
async function matches(pin: string, candidates: Row[]) {
  requireCondition(!scanning, 429, "PIN verification is busy. Try again shortly.");
  scanning = true;
  const deadline = performance.now() + PIN_LOOKUP_DEADLINE_MS;
  const found: Row[] = [];
  let next = 0, expired = false;
  try {
    const worker = async () => {
      while (next < candidates.length) {
        if (performance.now() >= deadline) { expired = true; return; }
        const candidate = candidates[next++];
        if (await verifyPassword(pin, candidate.pin_hash)) found.push(candidate);
        if (performance.now() >= deadline) { expired = true; return; }
      }
    };
    // allSettled is intentional: never abandon the other admitted KDF on error.
    const settled = await Promise.allSettled([worker(), worker()]);
    requireCondition(!expired, 503, "PIN verification took too long. Use your email and password, or try again later.");
    if (settled.some(result => result.status === "rejected")) throw new Problem(503, "PIN verification is temporarily unavailable.");
    return found;
  } finally { scanning = false; }
}

async function candidates(tx: Queryable, key: {lookup:string;keyId:string}, exceptId?: string) {
  // A different configured key must not hide existing indexed PIN duplicates.
  const mismatch = (await tx.query("SELECT id FROM users WHERE active AND pin_lookup IS NOT NULL AND pin_lookup_key_id IS DISTINCT FROM $1 LIMIT 1", [key.keyId])).rows;
  requireCondition(mismatch.length === 0, 503, "PIN configuration has changed. Use your email and password while an administrator restores it.");
  const legacy = (await tx.query(`SELECT id,org_id,pin_hash,pin_lookup,pin_lookup_key_id,requires_credential_change FROM users
    WHERE active AND pin_hash IS NOT NULL AND pin_lookup IS NULL AND ($1::uuid IS NULL OR id<>$1)
    ORDER BY id LIMIT 129`, [exceptId ?? null])).rows;
  requireCondition(legacy.length <= PIN_LEGACY_LIMIT, 503,
    "PIN sign-in requires account enrollment before this workspace can use it. Use your email and password.");
  const indexed = (await tx.query(`SELECT id,org_id,pin_hash,pin_lookup,pin_lookup_key_id,requires_credential_change FROM users
    WHERE active AND pin_lookup=$1 AND ($2::uuid IS NULL OR id<>$2) ORDER BY id LIMIT 2`, [key.lookup, exceptId ?? null])).rows;
  // A PIN awaiting replacement remains unindexed. A permanent PIN may already
  // be indexed while the account still requires its password to be changed.
  requireCondition(indexed.length <= 1, 401, incorrect);
  return [...indexed, ...legacy];
}

/** Caller holds namespace, then locks the returned account and compares this
 * exact hash before creating any proof/session. This copy is never an HTTP DTO. */
export async function resolvePinAccount(tx: Queryable, pin: string): Promise<Row & {lookup: string;keyId:string}> {
  const key = lookup(pin), rows = await candidates(tx, key);
  const found = await matches(pin, rows.length ? rows : [{ pin_hash: null }]);
  requireCondition(found.length === 1 && found[0].id, 401, incorrect);
  return { ...found[0], ...key };
}

/** Caller holds namespace before any account lock. Checks every active legacy
 * hash as well as the index: the index alone cannot detect old duplicate PINs. */
export async function uniquePermanentPin(tx: Queryable, userId: string, pin: string): Promise<{lookup:string;keyId:string}> {
  const key = lookup(pin), rows = await candidates(tx, key, userId);
  const found = await matches(pin, rows);
  requireCondition(found.length === 0, 409, "Choose a different PIN. This PIN is already in use.");
  return key;
}
