import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { savePersonalPreferences } from "../server/preferences";
import { preferencesSchema } from "../shared/preferences";
import { totpAt } from "../server/totp";

const origin = "http://localhost:3197";
type Auth = { cookie: string; hash: string; csrf: string; actor: Actor };
type Person = { id: string; email: string; password: string; role: string; units: string[]; auth: Auth };
let db: Database, owner: Auth;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: "stjw.org" });
async function cookieAuth(cookie: string): Promise<Auth> {
  const result = await request(app()).get("/api/me").set("Cookie", cookie); assert.equal(result.status, 200);
  return { cookie, hash: digest(cookie.slice(cookie.indexOf("=") + 1)), csrf: result.body.actor.csrf, actor: result.body.actor };
}
async function login(email: string, password: string) {
  const result = await request(app()).post("/api/auth/login").set("Origin", origin).send({ email, credential: password, mode: "password" }); assert.equal(result.status, 200);
  return cookieAuth((result.headers["set-cookie"] as unknown as string[])[0].split(";")[0]);
}
function send(auth: Auth, path: string, body: unknown, method = "post", database = db) {
  return (request(app(database)) as any)[method]("/api" + path).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(body);
}
async function person(role = "employee"): Promise<Person> {
  const email = randomUUID() + "@stjw.org", password = "Synthetic-" + randomUUID(), units = owner.actor.unit_ids.slice(0, 1);
  const result = await send(owner, "/staff", { name: "Synthetic preference account", email, role, unitIds: units, jobIds: [] }); assert.equal(result.status, 201, result.body.error);
  assert.equal((await request(app()).post("/api/auth/setup").set("Origin", origin).send({ token: new URL(result.body.setupUrl).hash.slice(7), password })).status, 200);
  return { id: result.body.id, email, password, role, units, auth: await login(email, password) };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); const ownerEmail = "preferences.owner@example.test", password = "Synthetic-" + randomUUID();
  await initialize(db, { demo: false, ownerEmail }); const row = (await db.query("SELECT id,org_id FROM users WHERE email=$1", [ownerEmail])).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, row as Actor));
  assert.equal((await request(app()).post("/api/auth/setup").set("Origin", origin).send({ token, password })).status, 200); owner = await login(ownerEmail, password);
});
after(async () => { delete process.env.MFA_ENCRYPTION_KEY; await db?.close(); });
async function state(user: Person) {
  return { preferences: (await db.query("SELECT preferences FROM users WHERE id=$1", [user.id])).rows[0].preferences,
    audits: (await db.query("SELECT id,detail FROM audit_events WHERE actor_id=$1 AND action='preferences.updated' ORDER BY id", [user.id])).rows };
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => observed };
}
function wrapped(effect: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  return { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params); await effect(tx, sql, params); return result;
  } })) };
}

test("partial preferences preserve custom color, accessibility and dashboard layout with the unchanged response", async () => {
  const user = await person();
  const full = preferencesSchema.parse({ theme: "dark", accent: "custom", customColor: "#123456", artwork: "none", depth: false,
    contrast: "high", textSize: "large", compact: true, navigation: "rail", corners: "crisp", reducedMotion: true,
    home: "clock", widgetOrder: ["community", "hours", "requests", "people", "clock", "metrics"], hiddenWidgets: ["people"] });
  const saved = await send(user.auth, "/me/preferences", full, "patch"); assert.equal(saved.status, 200, saved.body.error);
  assert.deepEqual(saved.body, { ok: true, preferences: full }); assert.equal(saved.headers["cache-control"], "private, no-store");
  const patched = await send(user.auth, "/me/preferences", { accent: "forest", artwork: "subtle", depth: true }, "patch"); assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.preferences, { ...full, accent: "forest", artwork: "subtle", depth: true });
  preferencesSchema.parse((await state(user)).preferences);
  const before = await state(user);
  assert.equal((await send(user.auth, "/me/preferences", { organizationBranding: {} }, "patch")).status, 400);
  assert.equal((await send(user.auth, "/me/preferences", { home: "reports" }, "patch")).status, 403);
  assert.deepEqual(await state(user), before);
});

test("installed preference save requires CSRF, origin, actual password proof and account before session lock", async () => {
  const user = await person(), before = await state(user);
  assert.equal((await request(app()).patch("/api/me/preferences").set("Cookie", user.auth.cookie).set("Origin", origin).send({ compact: true })).status, 403);
  assert.equal((await request(app()).patch("/api/me/preferences").set("Cookie", user.auth.cookie).set("Origin", "http://foreign.invalid").set("X-CSRF-Token", user.auth.csrf).send({ compact: true })).status, 403);
  await assert.rejects(savePersonalPreferences(db, user.auth.actor, undefined, { compact: true }), (e: any) => e.status === 401);
  await assert.rejects(savePersonalPreferences(db, user.auth.actor, owner.hash, { compact: true }), (e: any) => e.status === 401);
  for (const mode of ["pin", "api"] as const) await assert.rejects(savePersonalPreferences(db, { ...user.auth.actor, mode }, user.auth.hash, { compact: true }), (e: any) => e.status === 403);
  assert.deepEqual(await state(user), before);
  const trace: string[] = [], database = wrapped(async (_tx, sql) => { trace.push(sql); });
  await savePersonalPreferences(database, user.auth.actor, user.auth.hash, { compact: true });
  const account = trace.findIndex(sql => sql.includes("FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE")), session = trace.findIndex(sql => sql.includes("SELECT s.token_hash"));
  assert.ok(account >= 0 && account < session); assert.ok(trace.at(-1)?.includes("SELECT s.token_hash"));
  assert.equal(trace.some(sql => sql.includes("FROM users WHERE id=$1 AND org_id=$2 FOR SHARE")), false);
});

test("normal logout committed after middleware prevents preference and audit writes", async () => {
  const user = await person(), before = await state(user);
  const gate = beforeTransaction(async () => { assert.equal((await send(user.auth, "/auth/logout", {})).status, 200); });
  assert.equal((await send(user.auth, "/me/preferences", { theme: "dark" }, "patch", gate.database)).status, 401);
  assert.ok(gate.observed()); assert.deepEqual(await state(user), before);
});

test("current downgraded role cannot use a stale administrator actor for reports-home", async () => {
  const user = await person("admin"), stale = user.auth.actor;
  const changed = await send(owner, "/staff/" + user.id, { name: "Synthetic preference account", email: user.email, role: "employee", unitIds: user.units, jobIds: [], active: true }, "patch");
  assert.equal(changed.status, 200); user.auth = await login(user.email, user.password); const before = await state(user);
  await assert.rejects(savePersonalPreferences(db, stale, user.auth.hash, { home: "reports" }), (e: any) => e.status === 403);
  assert.deepEqual(await state(user), before);
  assert.equal((await savePersonalPreferences(db, stale, user.auth.hash, { theme: "dark" })).preferences.theme, "dark");
});

test("actual post-audit database failure and final database-clock expiry roll back preference plus audit", async () => {
  const user = await person();
  for (const mode of ["sql", "expiry"]) {
    const before = await state(user); let observed = false;
    const database = wrapped(async (tx, sql, params) => {
      if (sql.startsWith("INSERT INTO audit_events") && params[3] === "preferences.updated") {
        observed = true;
        if (mode === "sql") await tx.query("SELECT 1/0");
        else await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [user.auth.hash]);
      }
    });
    await assert.rejects(savePersonalPreferences(database, user.auth.actor, user.auth.hash, { accent: "rose" }), (e: any) => mode === "sql" ? e.code === "22012" : e.status === 401);
    assert.ok(observed); assert.deepEqual(await state(user), before);
  }
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test("MFA confirmed through normal APIs invalidates an in-flight unverified preference proof", async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  try {
    const user = await person(), before = await state(user), enrollment = await send(user.auth, "/auth/mfa/enroll", { password: user.password }); assert.equal(enrollment.status, 200);
    let cookie = "";
    const gate = beforeTransaction(async () => {
      const result = await send(user.auth, "/auth/mfa/confirm", { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) });
      assert.equal(result.status, 200); cookie = (result.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    });
    assert.equal((await send(user.auth, "/me/preferences", { textSize: "large" }, "patch", gate.database)).status, 401);
    assert.ok(gate.observed()); assert.deepEqual(await state(user), before);
    const verified = await cookieAuth(cookie); assert.equal((await send(verified, "/me/preferences", { textSize: "large" }, "patch")).status, 200);
  } finally { delete process.env.MFA_ENCRYPTION_KEY; }
});

test("normal PIN, bearer and unfinished temporary credentials cannot save personal preferences", async () => {
  const user = await person(), before = await state(user);
  assert.equal((await send(user.auth, "/auth/pin", { password: user.password, pin: "739125" })).status, 200);
  const login = await request(app()).post("/api/auth/login").set("Origin", origin).send({ email: user.email, credential: "739125", mode: "pin" }); assert.equal(login.status, 200);
  const pin = await cookieAuth((login.headers["set-cookie"] as unknown as string[])[0].split(";")[0]);
  assert.equal((await send(pin, "/me/preferences", { depth: false }, "patch")).status, 403);
  await assert.rejects(savePersonalPreferences(db, user.auth.actor, pin.hash, { depth: false }), (e: any) => e.status === 401);
  const token = await send(owner, "/tokens", { name: "Synthetic preference denial", scopes: ["reports:read"], days: 1 }); assert.equal(token.status, 200);
  assert.equal((await request(app()).patch("/api/me/preferences").set("Origin", origin).set("Authorization", "Bearer " + token.body.token).send({ depth: false })).status, 403);
  const email = randomUUID() + "@stjw.org", password = "Synthetic-" + randomUUID();
  const temporary = await send(owner, "/staff", { name: "Synthetic pending appearance account", email, role: "employee", unitIds: user.units, jobIds: [], initialCredentials: { password, pin: "931724" } }); assert.equal(temporary.status, 201);
  const challenge = await request(app()).post("/api/auth/login").set("Origin", origin).send({ email, credential: password, mode: "password" }); assert.equal(challenge.body.requiresCredentialChange, true);
  await assert.rejects(savePersonalPreferences(db, { ...user.auth.actor, id: temporary.body.id, email }, owner.hash, { depth: false }), (e: any) => e.status === 403);
  assert.deepEqual(await state(user), before);
});

test("busy preference writes return503 instead of inviting an automatic stale-draft retry", async () => {
  const user = await person(), before = await state(user);
  const failing: Database = { ...db, transaction: async () => { throw Object.assign(new Error("synthetic lock wait"), { code: "55P03" }); } };
  await assert.rejects(savePersonalPreferences(failing, user.auth.actor, user.auth.hash, { compact: true }), (e: any) => e.status === 503 && /Refresh/.test(e.message));
  assert.deepEqual(await state(user), before);
});
