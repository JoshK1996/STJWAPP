import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaffAccount, completeInitialCredentials } from "../server/temporary-credentials";
import { currentReportActor, recheckReportSession } from "../server/report-source-access";
import { createMfaChallenge } from "../server/auth-mfa";
import { audit, digest, hashPassword, issueSetup, opaqueToken, verifyPassword, type Actor } from "../server/security";
import { encryptFactor, totpAt } from "../server/totp";
import { completeCredentialsInput, staffCreateInput } from "../shared/temporary-credentials";

const origin = "http://localhost:3182", tempPassword = "Temp!826", tempPin = "581492", password = "Next!826";
let pin = "697135", nextFixturePin = 697135;
let db: Database, owner: Actor, ownerAuth: Auth, unitId: string, jobId: string, originalOwner: Row;
const priorKey = process.env.MFA_ENCRYPTION_KEY;
type Auth = { hash: string; cookie: string; csrf: string };
const application = (database = db) => createApp(database, { origin, production: false, demo: true, staffDomain: "stjw.org" });
const denied = (error: any) => [401, 403].includes(error.status);
function staff(role: Actor["role"] = "employee") { return { name: "Synthetic temporary credential customer", email: randomUUID() + "@stjw.org", role, unitIds: [unitId], jobIds: [] as string[] }; }
async function session(user: { id: string; org_id: string }, mode = "password"): Promise<Auth> {
  const token = opaqueToken(), hash = digest(token), csrf = opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [hash, user.org_id, user.id, mode, csrf]);
  return { hash, csrf, cookie: "stjw_session=" + token };
}
async function person(role: Actor["role"] = "employee", temporary = true) {
  const input = { ...staff(role), ...(temporary ? { initialCredentials: { password: tempPassword, pin: tempPin } } : {}) };
  const result = await createStaffAccount(db, owner, ownerAuth.hash, input, "stjw.org", origin);
  return { id: result.id, org_id: owner.org_id, email: input.email, name: input.name, role, mode: "password", unit_ids: [unitId] } as Actor;
}
function post(path: string, body: object, auth?: Auth, database = db) {
  return request(application(database)).post("/api" + path).set("Origin", origin).set("Cookie", auth?.cookie ?? "").set("X-CSRF-Token", auth?.csrf ?? "").send(body);
}
async function login(user: Actor, mode = "password", credential = tempPassword, database = db) {
  return post("/auth/login", { email: user.email, mode, credential }, undefined, database);
}
async function challenge(user: Actor, mode = "password") {
  const response = await login(user, mode, mode === "pin" ? tempPin : tempPassword);
  assert.equal(response.status, 200); assert.equal(response.body.requiresCredentialChange, true); assert.equal(response.body.ok, undefined);
  assert.deepEqual(Object.keys(response.body).sort(), ["challenge", "expiresAt", "requiresCredentialChange"]);
  const cookies = response.headers["set-cookie"] as unknown as string[];
  assert.ok(cookies.every(cookie => cookie.startsWith("stjw_session=;") && cookie.includes("Expires=Thu, 01 Jan 1970")));
  return response.body.challenge as string;
}
function wrapped(handler: (tx: Queryable, sql: string, params?: any[]) => Promise<void>) {
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { await handler(tx, sql, params); return tx.query<R>(sql, params); } })) } as Database;
}
async function state(user: Actor) {
  return {
    user: (await db.query("SELECT password_hash,pin_hash,requires_credential_change,active FROM users WHERE id=$1", [user.id])).rows[0],
    challenges: (await db.query("SELECT * FROM credential_change_challenges WHERE user_id=$1", [user.id])).rows,
    sessions: (await db.query("SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY token_hash", [user.id])).rows,
    setup: (await db.query("SELECT token_hash,consumed_at FROM setup_tokens WHERE user_id=$1 ORDER BY token_hash", [user.id])).rows,
    tokens: (await db.query("SELECT id,revoked_at FROM api_tokens WHERE user_id=$1 ORDER BY id", [user.id])).rows,
  };
}
before(async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "temporary.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  unitId = (await db.query("SELECT unit_id FROM user_units WHERE user_id=$1 ORDER BY unit_id", [row.id])).rows[0].unit_id;
  jobId = (await db.query("SELECT id FROM jobs WHERE unit_id=$1", [unitId])).rows[0].id;
  owner = { ...row, mode: "password", unit_ids: [unitId] } as Actor; ownerAuth = await session(owner);
  originalOwner = (await db.query("SELECT password_hash,pin_hash,requires_credential_change FROM users WHERE id=$1", [owner.id])).rows[0];
});
beforeEach(async () => { pin = String(nextFixturePin++); await db.query("DELETE FROM auth_limits"); });
after(async () => { await db?.close(); if (priorKey === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = priorKey; });

test("temporary creation is strict, hashes both values, audits no credentials and leaves owner/default setup intact", async () => {
  assert.ok(staffCreateInput.safeParse({ ...staff(), initialCredentials: { password: tempPassword, pin: tempPin } }).success);
  for (const initialCredentials of [{ password: "short", pin }, { password, pin: "12345" }, { password, pin: "123456789" }, { password, pin, admin: true }])
    assert.equal(staffCreateInput.safeParse({ ...staff(), initialCredentials }).success, false);
  const user = await person(), saved = await state(user);
  assert.equal(saved.user.requires_credential_change, true); assert.ok(await verifyPassword(tempPassword, saved.user.password_hash)); assert.ok(await verifyPassword(tempPin, saved.user.pin_hash));
  assert.equal(saved.setup.length, 0); assert.equal(saved.sessions.length, 0);
  const audits = JSON.stringify((await db.query("SELECT action,detail FROM audit_events WHERE target_id=$1", [user.id])).rows);
  for (const secret of [tempPassword, tempPin, saved.user.password_hash, saved.user.pin_hash]) assert.ok(!audits.includes(secret));
  const normal = await createStaffAccount(db, owner, ownerAuth.hash, staff(), "stjw.org", origin); assert.ok("setupUrl" in normal);
  assert.equal((await db.query("SELECT requires_credential_change FROM users WHERE id=$1", [normal.id])).rows[0].requires_credential_change, false);
  assert.deepEqual((await db.query("SELECT password_hash,pin_hash,requires_credential_change FROM users WHERE id=$1", [owner.id])).rows[0], originalOwner);
});

test("both temporary password and PIN logins create only a latest one-time onboarding proof", async () => {
  const user = await person(), first = await challenge(user), second = await challenge(user, "pin"), saved = await state(user);
  assert.equal(saved.sessions.length, 0); assert.equal(saved.challenges.length, 1); assert.equal(saved.challenges[0].token_hash, digest(second));
  assert.ok(!JSON.stringify(saved).includes(first) && !JSON.stringify(saved).includes(second));
  assert.equal((await post("/auth/credentials/complete", { challenge: first, password, pin })).status, 401);
  assert.equal((await request(application()).get("/api/me")).status, 401);
  assert.equal((await request(application()).get("/api/staff").set("Cookie", "stjw_session=" + second)).status, 401);
});

test("completion rejects either unchanged field and changes both in one transaction before fresh sign-in", async () => {
  const user = await person(), proof = await challenge(user, "pin"), initial = await state(user);
  for (const body of [{ challenge: proof, password: tempPassword, pin }, { challenge: proof, password, pin: tempPin }, { challenge: proof, password }, { challenge: proof, pin }, { challenge: proof, password: "short", pin }]) {
    assert.equal((await post("/auth/credentials/complete", body)).status, 400); assert.deepEqual(await state(user), initial);
  }
  const response = await post("/auth/credentials/complete", { challenge: proof, password, pin });
  assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true, signInRequired: true });
  const saved = await state(user); assert.equal(saved.user.requires_credential_change, false); assert.equal(saved.challenges.length, 0); assert.equal(saved.sessions.length, 0);
  assert.ok(await verifyPassword(password, saved.user.password_hash)); assert.ok(await verifyPassword(pin, saved.user.pin_hash));
  assert.equal((await login(user)).status, 401); assert.equal((await login(user, "pin", tempPin)).status, 401);
  const signed = await login(user, "password", password); assert.equal(signed.status, 200); assert.deepEqual(signed.body, { ok: true });
  const signedPin = await login(user, "pin", pin); assert.equal(signedPin.status, 200);
  assert.equal((await request(application()).get("/api/me").set("Cookie", signed.headers["set-cookie"][0].split(";")[0])).status, 200);
  assert.equal((await request(application()).get("/api/staff").set("Cookie", signedPin.headers["set-cookie"][0].split(";")[0])).status, 403);
});

test("injected ordinary sessions, bearer tokens and setup/MFA proof cannot bypass pending replacements", async () => {
  const user = await person("admin"), a = await session(user), pinAuth = await session(user, "pin"), rawToken = opaqueToken(), setup = opaqueToken();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic blocked bearer',$5,now()+interval '1 hour')", [randomUUID(), user.org_id, user.id, digest(rawToken), JSON.stringify(["staff:read"])]);
  await db.query("INSERT INTO setup_tokens(token_hash,org_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [digest(setup), user.org_id, user.id]);
  for (const auth of [a, pinAuth]) {
    for (const path of ["/me", "/clock", "/staff"]) assert.equal((await request(application()).get("/api" + path).set("Cookie", auth.cookie)).status, 401);
    assert.equal((await post("/auth/pin", { password: tempPassword, pin }, auth)).status, 401);
  }
  assert.equal((await request(application()).get("/api/staff").set("Authorization", "Bearer " + rawToken)).status, 403);
  assert.equal((await post("/auth/setup", { token: setup, password })).status, 403);
  await assert.rejects(db.transaction(tx => issueSetup(tx, user)), denied);
  await assert.rejects(db.transaction(tx => currentReportActor(tx, user, a.hash)), denied);
  await assert.rejects(db.transaction(tx => recheckReportSession(tx, user, a.hash)), denied);
  await assert.rejects(db.transaction(tx => createMfaChallenge(tx, user)), denied);
  const proof = await challenge(user); await completeInitialCredentials(db, { challenge: proof, password, pin });
  const final = await state(user); assert.equal(final.sessions.length, 0); assert.ok(final.tokens.every(t => t.revoked_at)); assert.ok(final.setup.every(t => t.consumed_at));
});

test("MFA survives replacements and cannot issue a password session until new password plus existing second factor", async () => {
  const user = await person(), factor = randomUUID(), secret = randomBytes(20), staleMfa = opaqueToken();
  const oldHash = (await state(user)).user.password_hash;
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now())", [user.id, user.org_id, factor, encryptFactor(secret, [user.org_id, user.id, factor].join(":")), digest(oldHash)]);
  await db.query("INSERT INTO mfa_challenges(token_hash,user_id,org_id,factor_id,credential_digest,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')", [digest(staleMfa), user.id, user.org_id, factor, digest(oldHash)]);
  assert.equal((await post("/auth/mfa/verify", { challenge: staleMfa, code: totpAt(secret, Date.now()) })).status, 401);
  const proof = await challenge(user, "pin"); await completeInitialCredentials(db, { challenge: proof, password, pin });
  assert.equal((await db.query("SELECT id FROM mfa_factors WHERE user_id=$1 AND enabled_at IS NOT NULL", [user.id])).rows[0].id, factor);
  const loginResponse = await login(user, "password", password); assert.equal(loginResponse.status, 200); assert.ok(loginResponse.body.challenge); assert.equal(loginResponse.headers["set-cookie"], undefined);
  assert.equal((await state(user)).sessions.length, 0);
  const verified = await post("/auth/mfa/verify", { challenge: loginResponse.body.challenge, code: totpAt(secret, Date.now()) });
  assert.equal(verified.status, 200); assert.ok(verified.headers["set-cookie"]); assert.equal((await state(user)).sessions.length, 1);
});

test("temporary provisioning checks actual current owner/admin authority and existing role grants", async () => {
  const admin = await person("admin", false), adminAuth = await session(admin), manager = await person("manager", false), managerAuth = await session(manager);
  const input = { ...staff(), initialCredentials: { password: tempPassword, pin: tempPin } };
  const saved = await createStaffAccount(db, admin, adminAuth.hash, input, "stjw.org", origin); assert.ok("requiresCredentialChange" in saved);
  await assert.rejects(createStaffAccount(db, manager, managerAuth.hash, { ...input, email: randomUUID() + "@stjw.org" }, "stjw.org", origin), denied);
  await assert.rejects(createStaffAccount(db, admin, adminAuth.hash, { ...input, ...staff("admin") }, "stjw.org", origin), denied);
  await assert.rejects(createStaffAccount(db, owner, ownerAuth.hash, { ...input, ...staff("owner") }, "stjw.org", origin), denied);
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [admin.id]);
  await assert.rejects(createStaffAccount(db, admin, adminAuth.hash, { ...input, email: randomUUID() + "@stjw.org" }, "stjw.org", origin), denied);
  await assert.rejects(createStaffAccount(db, owner, undefined, input, "stjw.org", origin), denied);
});

test("completion races admit only one result and stale hash/deactivated/expired proofs preserve original values", async () => {
  const user = await person(), proof = await challenge(user), input = { challenge: proof, password, pin };
  const results = await Promise.allSettled([completeInitialCredentials(db, input), completeInitialCredentials(db, input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='auth.initial_credentials_replaced'", [user.id])).rows.length, 1);
  for (const change of ["pin", "active", "expiry"] as const) {
    const target = await person(), token = await challenge(target); let reached = false;
    const altered = wrapped(async (tx, sql) => {
      if (!reached && sql.startsWith("SELECT * FROM users")) {
        reached = true;
        if (change === "pin") await tx.query("UPDATE users SET pin_hash=$1 WHERE id=$2", [await hashPassword("429681"), target.id]);
        if (change === "active") await tx.query("UPDATE users SET active=false WHERE id=$1", [target.id]);
        if (change === "expiry") await tx.query("UPDATE credential_change_challenges SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE user_id=$1", [target.id]);
      }
    });
    const initial = await state(target); await assert.rejects(completeInitialCredentials(altered, { challenge: token, password, pin }), denied);
    assert.ok(reached); assert.deepEqual(await state(target), initial);
  }
});

test("creation, login and completion audit failures roll back account, challenge and both credential replacements", async () => {
  const fail = wrapped(async (_tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) throw new Error("Synthetic credential audit failure"); });
  const input = { ...staff(), initialCredentials: { password: tempPassword, pin: tempPin } };
  await assert.rejects(createStaffAccount(fail, owner, ownerAuth.hash, input, "stjw.org", origin), /Synthetic credential audit failure/);
  assert.equal((await db.query("SELECT id FROM users WHERE email=$1", [input.email])).rows.length, 0);
  const user = await person(); assert.equal((await login(user, "password", tempPassword, fail)).status, 500);
  assert.equal((await state(user)).challenges.length, 0);
  const proof = await challenge(user), initial = await state(user);
  await assert.rejects(completeInitialCredentials(fail, { challenge: proof, password, pin }), /Synthetic credential audit failure/);
  assert.deepEqual(await state(user), initial);
  const lateExpiry = wrapped(async (tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) await tx.query("UPDATE credential_change_challenges SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE user_id=$1", [user.id]); });
  await assert.rejects(completeInitialCredentials(lateExpiry, { challenge: proof, password, pin }), denied); assert.deepEqual(await state(user), initial);
});

test("HTTP completion requires JSON and approved Origin and never accepts role, session or partial input", async () => {
  const user = await person(), proof = await challenge(user), body = { challenge: proof, password, pin };
  assert.equal((await request(application()).post("/api/auth/credentials/complete").set("Origin", "https://foreign.example.test").send(body)).status, 403);
  assert.equal((await request(application()).post("/api/auth/credentials/complete").set("Origin", origin).type("form").send(body)).status, 415);
  for (const extra of [{ role: "owner" }, { mode: "password" }, { userId: owner.id }, { requiresCredentialChange: false }]) {
    assert.equal(completeCredentialsInput.safeParse({ ...body, ...extra }).success, false);
    assert.equal((await post("/auth/credentials/complete", { ...body, ...extra })).status, 400);
  }
  assert.equal((await post("/auth/credentials/complete", { ...body, challenge: "invalid" })).status, 400);
  const response = await post("/auth/credentials/complete", body); assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.status, 200);
  const details = JSON.stringify((await db.query("SELECT action,detail FROM audit_events WHERE target_id=$1", [user.id])).rows);
  for (const secret of [tempPassword, tempPin, password, pin, proof]) assert.ok(!details.includes(secret));
});

test("installed staff creation is atomic and lists pending replacements without exposing credentials", async () => {
  const input = { ...staff("admin"), initialCredentials: { password: tempPassword, pin: tempPin } };
  assert.equal((await request(application()).post("/api/staff").set("Origin", origin).set("Cookie", ownerAuth.cookie).send(input)).status, 403);
  assert.equal((await post("/staff", { ...input, initialCredentials: { ...input.initialCredentials, bypass: true } }, ownerAuth)).status, 400);
  const response = await post("/staff", input, ownerAuth);
  assert.equal(response.status, 201); assert.deepEqual(Object.keys(response.body).sort(), ["id", "requiresCredentialChange"]); assert.equal(response.body.requiresCredentialChange, true);
  assert.equal(response.headers["cache-control"], "no-store");
  const directory = await request(application()).get("/api/staff").set("Cookie", ownerAuth.cookie), row = directory.body.rows.find((r: Row) => r.id === response.body.id);
  assert.equal(directory.status, 200); assert.equal(row.requires_credential_change, true); assert.equal(row.setup_complete, false);
  assert.equal(row.password_hash, undefined); assert.equal(row.pin_hash, undefined); assert.ok(!JSON.stringify(row).includes(tempPassword) && !JSON.stringify(row).includes(tempPin));
  const user = { ...owner, id: row.id, email: input.email, role: "admin" as const }, proof = await challenge(user);
  const changed = await request(application()).patch("/api/staff/" + user.id).set("Origin", origin).set("Cookie", ownerAuth.cookie).set("X-CSRF-Token", ownerAuth.csrf)
    .send({ ...staff("admin"), email: input.email, name: "Synthetic changed onboarding identity", active: true });
  assert.equal(changed.status, 200); assert.equal((await post("/auth/credentials/complete", { challenge: proof, password, pin })).status, 401);
  assert.equal((await state(user)).user.requires_credential_change, true);
  const plain = await post("/staff", staff(), ownerAuth); assert.equal(plain.status, 201); assert.ok(plain.body.setupUrl); assert.equal(plain.body.requiresCredentialChange, undefined);
  assert.deepEqual((await db.query("SELECT password_hash,pin_hash,requires_credential_change FROM users WHERE id=$1", [owner.id])).rows[0], originalOwner);
});

test("completion expiration and current authority checks roll back credential issuance after final waits", async () => {
  const input = { ...staff(), initialCredentials: { password: tempPassword, pin: tempPin } };
  const lateSession = wrapped(async (tx, sql) => {
    if (sql.startsWith("INSERT INTO audit_events")) await tx.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [ownerAuth.hash]);
  });
  await assert.rejects(createStaffAccount(lateSession, owner, ownerAuth.hash, input, "stjw.org", origin), denied);
  assert.equal((await db.query("SELECT id FROM users WHERE email=$1", [input.email])).rows.length, 0);
  const user = await person(), proof = await challenge(user); let seen = false;
  const race = wrapped(async (tx, sql) => {
    if (!seen && sql.startsWith("SELECT * FROM users")) {
      seen = true;
      await tx.query("DELETE FROM credential_change_challenges WHERE user_id=$1", [user.id]);
    }
  });
  const before = await state(user); await assert.rejects(completeInitialCredentials(race, { challenge: proof, password, pin }), denied);
  assert.ok(seen); assert.deepEqual(await state(user), before);
});
