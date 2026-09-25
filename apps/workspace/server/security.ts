import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import type { Database, Queryable, Row } from "./db";
const derive = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      value,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const opaqueToken = () => randomBytes(32).toString("base64url");
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireCondition(
  value: unknown,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new Problem(status, message);
}
export async function hashPassword(value: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(value, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(value: string, encoded: string | null) {
  const [, salt, expected] = (encoded ?? "").split("$");
  // Always perform the expensive derivation; missing users don't take a fast path.
  const actual = await derive(
    value,
    salt || "00000000000000000000000000000000",
  );
  const target = Buffer.from(expected || "00".repeat(64), "hex");
  return (
    !!encoded &&
    actual.length === target.length &&
    timingSafeEqual(actual, target)
  );
}
export type Actor = {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: string;
  unit_ids: string[];
  mode: "password" | "pin" | "api";
  scopes?: string[];
  csrf?: string;
  preferences?: Row;
};
export const orgWide = (actor: Actor) =>
  ["developer", "owner", "admin", "finance"].includes(actor.role);
export const manages = (actor: Actor) =>
  actor.mode === "password" &&
  ["developer", "owner", "admin", "manager"].includes(actor.role);
export const canReport = (actor: Actor) =>
  actor.mode !== "pin" &&
  ["developer", "owner", "admin", "manager", "finance"].includes(actor.role);
export function assertUnit(actor: Actor, unitId: string) {
  requireCondition(
    orgWide(actor) || actor.unit_ids.includes(unitId),
    403,
    "This organizational unit is outside your access.",
  );
}
export async function audit(
  tx: Queryable,
  actor: Pick<Actor, "org_id" | "id">,
  action: string,
  targetId: string | null,
  detail: Row = {},
) {
  await tx.query(
    "INSERT INTO audit_events(id,org_id,actor_id,action,target_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      actor.org_id,
      actor.id,
      action,
      targetId,
      JSON.stringify(detail),
    ],
  );
}
export async function limitAuth(db: Database, key: string, limit: number) {
  const result = await db.query(
    `INSERT INTO auth_limits(bucket,attempts,resets_at) VALUES($1,1,now()+interval '15 minutes')
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN auth_limits.resets_at < now() THEN 1 ELSE auth_limits.attempts+1 END,
    resets_at=CASE WHEN auth_limits.resets_at < now() THEN now()+interval '15 minutes' ELSE auth_limits.resets_at END RETURNING attempts`,
    [digest(key)],
  );
  requireCondition(
    result.rows[0].attempts <= limit,
    429,
    "Too many attempts. Try again in 15 minutes.",
  );
}
export async function issueSetup(
  tx: Queryable,
  actor: Pick<Actor, "id" | "org_id">,
) {
  const user = (
    await tx.query(
      "SELECT active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE",
      [actor.id, actor.org_id],
    )
  ).rows[0];
  requireCondition(
    user?.active,
    403,
    "An active account is required to issue a setup link.",
  );
  requireCondition(!user.requires_credential_change, 403, "Complete the required credential changes at sign-in; a setup link cannot bypass them.");
  const token = opaqueToken();
  await tx.query(
    "UPDATE setup_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
    [actor.id],
  );
  await tx.query(
    `INSERT INTO setup_tokens(token_hash,org_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')`,
    [digest(token), actor.org_id, actor.id],
  );
  return token;
}
