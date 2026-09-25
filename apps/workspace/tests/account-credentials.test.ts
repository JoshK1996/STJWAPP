import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { changeOwnPassword } from "../server/account-credentials";
import { digest, hashPassword, issueSetup, opaqueToken, verifyPassword, type Actor } from "../server/security";

const origin = "http://localhost:3000", password = "Before!8", nextPassword = "After!88";
let db: Database, app: ReturnType<typeof createApp>, orgId: string, passwordHash: string;
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  orgId = (await db.query("SELECT id FROM organizations")).rows[0].id;
  passwordHash = await hashPassword(password);
  app = createApp(db, { origin, production: false, staffDomain: "stjw.org", demo: false });
});
after(async () => { await db?.close(); });
async function session(id: string, mode = "password", mfaVerified = false) {
  const token = opaqueToken(), csrf = opaqueToken(), expiresAt = new Date(Date.now() + 600_000);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at,mfa_verified) VALUES($1,$2,$3,$4,$5,$6,$7)", [digest(token), orgId, id, mode, csrf, expiresAt, mfaVerified]);
  return { cookie: "stjw_session=" + token, hash: digest(token), csrf, expiresAt };
}
async function person() {
  const id = randomUUID(), email = id + "@stjw.org";
  await db.query("INSERT INTO users(id,org_id,name,email,role,password_hash,pin_hash) VALUES($1,$2,'Synthetic password change',$3,'employee',$4,$5)", [id, orgId, email, passwordHash, passwordHash]);
  const actor: Actor = { id, org_id: orgId, name: "Synthetic password change", email, role: "employee", unit_ids: [], mode: "password" };
  return { actor, auth: await session(id) };
}
const input = { currentPassword: password, newPassword: nextPassword };
function post(auth: { cookie: string; csrf: string }, body: object = input) {
  return request(app).post("/api/auth/password").set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(body);
}
test("self-service accepts eight characters, rotates session/CSRF without extending expiry, and revokes old credentials", async () => {
  const { actor, auth } = await person();
  const other = await session(actor.id), pin = await session(actor.id, "pin");
  const setup = await db.transaction(tx => issueSetup(tx, actor));
  const apiToken = opaqueToken();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,'Synthetic token',$4,$5,now()+interval '1 day')", [randomUUID(), orgId, actor.id, digest(apiToken), JSON.stringify(["staff:read"])]);
  const response = await post(auth);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body).sort(), ["csrf", "ok"]);
  assert.notEqual(response.body.csrf, auth.csrf);
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(cookie, auth.cookie);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
  assert.match(response.headers["set-cookie"][0], /SameSite=Strict/);
  for (const old of [auth, other, pin]) assert.equal((await request(app).get("/api/me").set("Cookie", old.cookie)).status, 401);
  assert.equal((await request(app).get("/api/me").set("Cookie", cookie)).status, 200);
  const fresh = (await db.query("SELECT * FROM sessions WHERE user_id=$1", [actor.id])).rows;
  assert.equal(fresh.length, 1); assert.equal(new Date(fresh[0].expires_at).getTime(), auth.expiresAt.getTime());
  const user = (await db.query("SELECT password_hash,pin_hash FROM users WHERE id=$1", [actor.id])).rows[0];
  assert.equal(await verifyPassword(nextPassword, user.password_hash), true);
  assert.equal(await verifyPassword(password, user.password_hash), false);
  assert.equal(user.pin_hash, passwordHash);
  assert.ok((await db.query("SELECT consumed_at FROM setup_tokens WHERE token_hash=$1", [digest(setup)])).rows[0].consumed_at);
  assert.ok((await db.query("SELECT revoked_at FROM api_tokens WHERE token_hash=$1", [digest(apiToken)])).rows[0].revoked_at);
  const audit = (await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='auth.password_changed'", [actor.id])).rows;
  assert.deepEqual(audit.map(row => row.detail), [{ otherSessionsRevoked: true, apiTokensRevoked: true }]);
});
test("bad password, short password, unknown fields, CSRF, PIN, and forged/missing session proofs cannot mutate credentials", async () => {
  const { actor, auth } = await person();
  assert.equal((await post(auth, { ...input, currentPassword: "wrong" })).status, 400);
  assert.equal((await post(auth, { ...input, newPassword: "short" })).status, 400);
  assert.equal((await post(auth, { ...input, userId: randomUUID() })).status, 400);
  assert.equal((await post({ ...auth, csrf: "wrong" })).status, 403);
  assert.equal((await post(await session(actor.id, "pin"))).status, 403);
  await assert.rejects(changeOwnPassword(db, actor, undefined, input), { status: 401 });
  const stranger = await person();
  await assert.rejects(changeOwnPassword(db, actor, stranger.auth.hash, input), { status: 401 });
  await assert.rejects(changeOwnPassword(db, { ...actor, mode: "api" }, auth.hash, input), { status: 403 });
  const user = (await db.query("SELECT password_hash FROM users WHERE id=$1", [actor.id])).rows[0];
  assert.equal(user.password_hash, passwordHash);
  assert.equal((await db.query("SELECT * FROM audit_events WHERE actor_id=$1 AND action='auth.password_changed'", [actor.id])).rows.length, 0);
});
test("fresh authorization rejects deactivated, temporary-credential, expired, cross-org and MFA-unverified sessions", async () => {
  for (const state of ["inactive", "temporary", "expired", "mfa", "cross-org"]) {
    const { actor, auth } = await person();
    if (state === "inactive") await db.query("UPDATE users SET active=false WHERE id=$1", [actor.id]);
    if (state === "temporary") await db.query("UPDATE users SET requires_credential_change=true WHERE id=$1", [actor.id]);
    if (state === "expired") await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [auth.hash]);
    if (state === "mfa") await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic', $4,now(),now())", [actor.id, orgId, randomUUID(), digest(passwordHash)]);
    await assert.rejects(changeOwnPassword(db, state === "cross-org" ? { ...actor, org_id: randomUUID() } : actor, auth.hash, input), (error: any) => [401, 403].includes(error.status));
    assert.equal((await db.query("SELECT password_hash FROM users WHERE id=$1", [actor.id])).rows[0].password_hash, passwordHash);
  }
});
test("enabled MFA proof is retained, pending sign-in challenges are revoked", async () => {
  const { actor } = await person(), auth = await session(actor.id, "password", true), factorId = randomUUID();
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic',$4,now(),now())", [actor.id, orgId, factorId, digest(passwordHash)]);
  await db.query("INSERT INTO mfa_challenges(token_hash,user_id,org_id,factor_id,credential_digest,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')", [digest(opaqueToken()), actor.id, orgId, factorId, digest(passwordHash)]);
  const result = await changeOwnPassword(db, actor, auth.hash, input);
  assert.equal((await db.query("SELECT mfa_verified FROM sessions WHERE token_hash=$1", [digest(result.token)])).rows[0].mfa_verified, true);
  assert.equal((await db.query("SELECT * FROM mfa_challenges WHERE user_id=$1", [actor.id])).rows.length, 0);
  assert.equal((await db.query("SELECT id FROM mfa_factors WHERE user_id=$1", [actor.id])).rows[0].id, factorId);
});
test("concurrent changes succeed once and preserve a single valid session and audit", async () => {
  const { actor, auth } = await person();
  const outcomes = await Promise.allSettled([changeOwnPassword(db, actor, auth.hash, input), changeOwnPassword(db, actor, auth.hash, { ...input, newPassword: "Other!88" })]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  assert.equal((await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [actor.id])).rows.length, 1);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='auth.password_changed'", [actor.id])).rows.length, 1);
});
test("password/session/account invalidation during password hashing is checked again before any write", async () => {
  for (const state of ["password", "expired", "inactive", "mfa"]) {
    const { actor, auth } = await person(); let transactions = 0;
    const wrapped: Database = { ...db, transaction: async callback => {
      if (++transactions === 2) {
        if (state === "password") await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", ["synthetic-concurrent-reset", actor.id]);
        if (state === "expired") await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [auth.hash]);
        if (state === "inactive") await db.query("UPDATE users SET active=false WHERE id=$1", [actor.id]);
        if (state === "mfa") await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic',$4,now(),now())", [actor.id, orgId, randomUUID(), digest(passwordHash)]);
      }
      return db.transaction(callback);
    } };
    await assert.rejects(changeOwnPassword(wrapped, actor, auth.hash, input), (error: any) => [401, 403].includes(error.status));
    assert.equal((await db.query("SELECT password_hash FROM users WHERE id=$1", [actor.id])).rows[0].password_hash, state === "password" ? "synthetic-concurrent-reset" : passwordHash);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='auth.password_changed'", [actor.id])).rows.length, 0);
  }
});
test("failed audit rolls back password, revocations and session rotation together", async () => {
  const { actor, auth } = await person(), setup = await db.transaction(tx => issueSetup(tx, actor));
  const wrapped: Database = { ...db, transaction: callback => db.transaction(tx => callback({ query: ((sql: string, params?: any[]) => {
    if (sql.includes("INSERT INTO audit_events")) throw Error("Synthetic audit failure");
    return tx.query(sql, params);
  }) as Queryable["query"] })) };
  await assert.rejects(changeOwnPassword(wrapped, actor, auth.hash, input), /Synthetic audit failure/);
  assert.equal((await db.query("SELECT password_hash FROM users WHERE id=$1", [actor.id])).rows[0].password_hash, passwordHash);
  assert.equal((await db.query("SELECT token_hash FROM sessions WHERE user_id=$1", [actor.id])).rows[0].token_hash, auth.hash);
  assert.equal((await db.query("SELECT consumed_at FROM setup_tokens WHERE token_hash=$1", [digest(setup)])).rows[0].consumed_at, null);
});
