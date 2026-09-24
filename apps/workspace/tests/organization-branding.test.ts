import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { getOrganizationBranding, publishOrganizationBranding, listOrganizationBrandingHistory,
  canonicalBrandingJson, brandingSettingsHash } from "../server/organization-branding";
import { brandingPaletteIds, unconfiguredBrandingSettings, organizationBrandingCurrentSchema,
  publishOrganizationBrandingSchema, organizationBrandingReceiptSchema, organizationBrandingHistorySchema } from "../shared/organization-branding";
import { palettes } from "../src/appearance";

const origin = "http://localhost:3196";
type Auth = { cookie: string; csrf: string; hash: string; actor: Actor };
let db: Database, owner: Auth, admin: Auth, employee: Auth, ownerEmail: string, password: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: "stjw.org" });
function send(auth: Auth | null, path: string, body?: unknown, database = db, method = "post") {
  const agent = request(app(database));
  const req = body === undefined ? agent.get("/api" + path) : (agent as any)[method]("/api" + path).set("Origin", origin).send(body);
  return auth ? req.set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf) : req;
}
async function login(email: string, credential: string): Promise<Auth> {
  const result = await request(app()).post("/api/auth/login").set("Origin", origin).send({ email, credential, mode: "password" });
  assert.equal(result.status, 200, result.body.error);
  const cookie = (result.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const me = await request(app()).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf("=") + 1)), actor: me.body.actor };
}
async function person(role: string) {
  const email = randomUUID() + "@stjw.org", credential = "Synthetic-" + randomUUID();
  const created = await send(owner, "/staff", { name: "Synthetic appearance reader", email, role, unitIds: owner.actor.unit_ids.slice(0, 1), jobIds: [] });
  assert.equal(created.status, 201, created.body.error);
  const setup = await request(app()).post("/api/auth/setup").set("Origin", origin).send({ token: new URL(created.body.setupUrl).hash.slice(7), password: credential });
  assert.equal(setup.status, 200); return login(email, credential);
}
before(async () => {
  db = await connectDatabase(); await migrate(db); ownerEmail = "branding.owner@example.test"; password = "Synthetic-" + randomUUID();
  await initialize(db, { demo: false, ownerEmail });
  const row = (await db.query("SELECT id,org_id FROM users WHERE email=$1", [ownerEmail])).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, row as Actor));
  assert.equal((await request(app()).post("/api/auth/setup").set("Origin", origin).send({ token, password })).status, 200);
  owner = await login(ownerEmail, password); admin = await person("admin"); employee = await person("employee");
});
after(async () => { await db?.close(); });
const current = () => getOrganizationBranding(db, owner.actor, owner.hash);
async function change(overrides: Row = {}) {
  const value = await current();
  return { commandId: randomUUID(), expectedVersion: value.version, reviewed: true, reason: "Synthetic reviewed appearance change",
    settings: { ...value.settings, subtitle: "Synthetic revision " + randomUUID() }, ...overrides };
}
async function state() {
  return { current: (await db.query("SELECT * FROM organization_branding ORDER BY org_id")).rows,
    history: (await db.query("SELECT * FROM organization_branding_history ORDER BY org_id,version")).rows,
    commands: (await db.query("SELECT * FROM organization_branding_commands ORDER BY org_id,command_id")).rows,
    audits: (await db.query("SELECT * FROM audit_events WHERE action='organization.branding_published' ORDER BY id")).rows };
}
function wrapped(effect: (tx: Queryable, sql: string, params: any[], rows: Row[]) => Promise<Row[] | void>): Database {
  return { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params), rows = await effect(tx, sql, params, result.rows); return { ...result, rows: (rows ?? result.rows) as R[] };
  } })) };
}

test("unconfigured presentation has no seeded row, and named palettes match the existing renderer", async () => {
  const result = await current();
  assert.deepEqual(result.settings, unconfiguredBrandingSettings); assert.equal(result.version, 0); assert.equal(result.configured, false);
  assert.equal(result.updatedAt, null); assert.deepEqual(result.allowedActions, { publish: true, history: true });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM organization_branding_history")).rows[0].n, 0);
  assert.deepEqual(brandingPaletteIds, palettes.map(p => p.id));
  const read = await send(employee, "/organization/branding"); assert.equal(read.status, 200);
  assert.deepEqual(read.body.allowedActions, { publish: false, history: false }); organizationBrandingCurrentSchema.parse(read.body);
});

test("first explicit default confirmation publishes, exact normalized retry survives later changes, and no-op/stale changes reject", async () => {
  const input = await change({ settings: { ...unconfiguredBrandingSettings, shortName: " STJW " }, reason: "  Confirm current app appearance explicitly  " });
  const baseline = (await db.query("SELECT name FROM organizations WHERE id=$1", [owner.actor.org_id])).rows[0];
  const prefs = (await db.query("SELECT id,preferences FROM users ORDER BY id")).rows;
  const first = await send(owner, "/organization/branding", input); assert.equal(first.status, 200, first.body.error);
  const receipt = organizationBrandingReceiptSchema.parse(first.body); assert.equal(receipt.snapshot.version, 1); assert.equal(receipt.snapshot.settings.shortName, "STJW");
  const second = await publishOrganizationBranding(db, owner.actor, owner.hash, await change()); assert.equal(second.snapshot.version, 2);
  const before = await state(), replay = await send(owner, "/organization/branding", input);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, receipt); assert.deepEqual(await state(), before);
  const normalized = publishOrganizationBrandingSchema.parse(input);
  assert.deepEqual(await publishOrganizationBranding(db, owner.actor, owner.hash, normalized), receipt);
  await assert.rejects(publishOrganizationBranding(db, owner.actor, owner.hash, { ...input, reason: "Different command payload evidence" }), (e: any) => e.status === 409);
  await assert.rejects(publishOrganizationBranding(db, owner.actor, owner.hash, { ...input, commandId: randomUUID() }), (e: any) => e.status === 409);
  const now = await current(); await assert.rejects(publishOrganizationBranding(db, owner.actor, owner.hash, await change({ settings: now.settings })), (e: any) => e.status === 409);
  assert.deepEqual((await db.query("SELECT name FROM organizations WHERE id=$1", [owner.actor.org_id])).rows[0], baseline);
  assert.deepEqual((await db.query("SELECT id,preferences FROM users ORDER BY id")).rows, prefs);
  const audit = (await db.query("SELECT detail FROM audit_events WHERE action='organization.branding_published' ORDER BY created_at LIMIT 1")).rows[0].detail;
  assert.deepEqual(Object.keys(audit).sort(), ["changedFields", "commandId", "settingsHash", "version"]);
});

test("installed routes require actual owner authority for history/publication and strict private request boundaries", async () => {
  const input = await change();
  assert.equal((await send(null, "/organization/branding")).status, 401);
  assert.equal((await send(admin, "/organization/branding", input)).status, 403);
  assert.equal((await send(employee, "/organization/branding/history")).status, 403);
  const read = await send(admin, "/organization/branding"); assert.equal(read.status, 200); assert.equal(read.headers["cache-control"], "private, no-store");
  for (const query of ["?unknown=1", "?limit=1&limit=2", "?beforeVersion=2147483648", "?limit=0"])
    assert.equal((await send(owner, "/organization/branding/history" + query)).status, 400, query);
  assert.equal((await send(owner, "/organization/branding?orgId=" + randomUUID())).status, 400);
  assert.equal((await send(owner, "/organization/branding", { ...input, orgId: owner.actor.org_id })).status, 400);
  assert.equal((await request(app()).post("/api/organization/branding").set("Cookie", owner.cookie).set("Origin", origin).send(input)).status, 403);
  assert.equal((await request(app()).post("/api/organization/branding").set("Cookie", owner.cookie).set("Origin", "http://foreign.invalid").set("X-CSRF-Token", owner.csrf).send(input)).status, 403);
  for (const mode of ["pin", "api"] as const) await assert.rejects(getOrganizationBranding(db, { ...owner.actor, mode }, owner.hash), (e: any) => e.status === 403);
  await assert.rejects(getOrganizationBranding(db, owner.actor, undefined), (e: any) => e.status === 401);
  await assert.rejects(publishOrganizationBranding(db, { ...admin.actor, role: "owner" }, admin.hash, input), (e: any) => e.status === 403);
  await assert.rejects(getOrganizationBranding(db, { ...owner.actor, org_id: randomUUID() }, owner.hash), (e: any) => e.status === 403);
});

test("publication validation rejects controls, invalid Unicode and excess values without transforming stored output", async () => {
  const input = await change(), before = await state();
  for (const shortName of ["x\n", "a\u202eb", "a\ud800b", "x".repeat(25), " "])
    assert.equal((await send(owner, "/organization/branding", { ...input, settings: { ...input.settings, shortName } })).status, 400);
  for (const extra of [{ reviewed: false }, { commandId: "bad" }, { expectedVersion: 2147483647 }, { reason: "short" }, { reason: "x".repeat(1001) }])
    assert.equal((await send(owner, "/organization/branding", { ...input, ...extra })).status, 400);
  assert.deepEqual(await state(), before);
  const actual = await publishOrganizationBranding(db, owner.actor, owner.hash, await change({ settings: { ...input.settings, shortName: "教会 🏫", displayName: "<script>literal</script>", subtitle: "" } }));
  assert.equal(actual.snapshot.settings.displayName, "<script>literal</script>"); assert.equal(actual.snapshot.settings.subtitle, "");
});

test("a committed normal logout after middleware invalidates both new publication and exact receipt reads", async () => {
  const input = await change(), result = await publishOrganizationBranding(db, owner.actor, owner.hash, input), before = await state();
  let called = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!called) { called = true; assert.equal((await send(owner, "/auth/logout", {})).status, 200); } return db.transaction(fn);
  } };
  const rejected = await send(owner, "/organization/branding", input, database); assert.equal(rejected.status, 401); assert.ok(called);
  assert.deepEqual(await state(), before); owner = await login(ownerEmail, password);
  assert.deepEqual(await publishOrganizationBranding(db, owner.actor, owner.hash, input), result);
});

test("command serialization precedes account proof and exact receipts bypass changed current version", async () => {
  const input = await change(), trace: string[] = [];
  const database = wrapped(async (_tx, sql) => { trace.push(sql); });
  const result = await publishOrganizationBranding(database, owner.actor, owner.hash, input);
  const command = trace.findIndex(sql => sql.includes("pg_advisory_xact_lock")), account = trace.findIndex(sql => sql.includes("FROM users WHERE id=$1 AND org_id=$2 FOR SHARE"));
  const session = trace.findIndex(sql => sql.includes("SELECT s.token_hash")), currentIndex = trace.findIndex(sql => sql.includes("FROM organization_branding b"));
  assert.ok(command >= 0 && command < account && account < session && session < currentIndex);
  trace.length = 0; assert.deepEqual(await publishOrganizationBranding(database, owner.actor, owner.hash, input), result);
  assert.equal(trace.some(sql => sql.includes("FROM organization_branding b")), false);
  assert.ok(trace.at(-1)?.includes("SELECT s.token_hash"));
});

test("UUID spelling normalizes before command locks, fingerprints and immutable receipts", async () => {
  const input = { ...await change(), commandId: randomUUID().toUpperCase() };
  const actor = { ...owner.actor, id: owner.actor.id.toUpperCase(), org_id: owner.actor.org_id.toUpperCase() };
  const namespaces: string[] = [], database = wrapped(async (_tx, sql, params) => { if (sql.includes("pg_advisory_xact_lock")) namespaces.push(params[0]); });
  const first = await publishOrganizationBranding(database, actor, owner.hash, input);
  const retry = await publishOrganizationBranding(db, owner.actor, owner.hash, { ...input, commandId: input.commandId.toLowerCase() });
  assert.deepEqual(first, retry); assert.equal(first.commandId, input.commandId.toLowerCase());
  assert.ok(namespaces.every(value => value === value.toLowerCase()));
});

test("controlled competing requests yield one version and a shared command yields one immutable receipt", async () => {
  const input = await change(), before = (await current()).version;
  const outcomes = await Promise.allSettled([publishOrganizationBranding(db, owner.actor, owner.hash, input), publishOrganizationBranding(db, owner.actor, owner.hash, { ...input, commandId: randomUUID() })]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1); assert.equal((await current()).version, before + 1);
  assert.equal((outcomes.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status, 409);
  const shared = await change(), pair = await Promise.all([publishOrganizationBranding(db, owner.actor, owner.hash, shared), publishOrganizationBranding(db, owner.actor, owner.hash, shared)]);
  assert.deepEqual(pair[0], pair[1]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM organization_branding_commands WHERE command_id=$1", [shared.commandId])).rows[0].n, 1);
});

test("actual post-audit SQL failure and final proof expiry roll back current, history, command and audit together", async () => {
  for (const mode of ["sql", "expiry"]) {
    const input = await change(), before = await state(); let observed = false;
    const database = wrapped(async (tx, sql, params) => {
      if (sql.startsWith("INSERT INTO audit_events") && params[3] === "organization.branding_published") {
        observed = true;
        if (mode === "sql") await tx.query("SELECT 1/0");
        else await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [owner.hash]);
      }
    });
    await assert.rejects(publishOrganizationBranding(database, owner.actor, owner.hash, input), (e: any) => mode === "sql" ? e.code === "22012" : e.status === 401);
    assert.ok(observed); assert.deepEqual(await state(), before);
    assert.equal((await send(owner, "/organization/branding")).status, 200);
  }
});

test("retained receipt and current snapshots reject tampering even if attacker recomputes a local receipt hash", async () => {
  const input = await change(); await publishOrganizationBranding(db, owner.actor, owner.hash, input);
  const corrupt = wrapped(async (_tx, sql, _params, rows) => {
    if (sql.includes("FROM organization_branding_commands c") && rows.length) {
      const result = JSON.parse(rows[0].result_text); result.snapshot.settings.displayName = "Changed retained identity";
      result.snapshot.settingsHash = brandingSettingsHash(result.snapshot.settings);
      const text = canonicalBrandingJson(result); return [{ ...rows[0], result_text: text, result_hash: digest(text), settings_hash: result.snapshot.settingsHash }];
    }
  });
  await assert.rejects(publishOrganizationBranding(corrupt, owner.actor, owner.hash, input), (e: any) => e.status === 422);
  const invalidCurrent = wrapped(async (_tx, sql, _params, rows) => sql.includes("FROM organization_branding b") && rows.length
    ? [{ ...rows[0], settings: { ...rows[0].settings, displayName: "Tampered current identity" } }] : undefined);
  await assert.rejects(getOrganizationBranding(invalidCurrent, owner.actor, owner.hash), (e: any) => e.status === 422);
});

test("history over fifty versions remains complete across an intervening newer publication", async () => {
  while ((await current()).version < 53) await publishOrganizationBranding(db, owner.actor, owner.hash, await change());
  const first = await listOrganizationBrandingHistory(db, owner.actor, owner.hash, { limit: "50" });
  assert.equal(first.rows.length, 50); assert.ok(first.nextBeforeVersion); const ceiling = first.currentVersion;
  await publishOrganizationBranding(db, owner.actor, owner.hash, await change());
  const second = await listOrganizationBrandingHistory(db, owner.actor, owner.hash, { beforeVersion: String(first.nextBeforeVersion), limit: "50" });
  organizationBrandingHistorySchema.parse(second); assert.equal(second.nextBeforeVersion, null);
  const versions = [...first.rows, ...second.rows].map(r => r.version);
  assert.deepEqual(versions, Array.from({ length: ceiling }, (_, i) => ceiling - i));
  assert.deepEqual(second.rows.at(-1)!.before.settings, unconfiguredBrandingSettings);
});

test("database guards preserve immutable evidence, exact predecessor and current highest-version pointer", async () => {
  for (const sql of ["DELETE FROM organization_branding", "UPDATE organization_branding_history SET reason=reason", "DELETE FROM organization_branding_commands", "UPDATE organization_branding SET version=version+2"])
    await assert.rejects(db.query(sql), /cannot|immutable|advance|deleted|append-only/);
  const before = await state();
  async function invalidNext(mode: "orphan" | "before" | "pointer" | "foreign") {
    await db.transaction(async tx => {
      const previous = (await tx.query("SELECT * FROM organization_branding_history WHERE org_id=$1 ORDER BY version DESC LIMIT 1", [owner.actor.org_id])).rows[0];
      const next = { ...previous.after_state, version: previous.version + 1 }, earlier = structuredClone(previous.after_state);
      if (mode === "before") earlier.settings.shortName = "Wrong predecessor";
      let actorId = owner.actor.id;
      if (mode === "foreign") {
        const otherOrg = randomUUID(); actorId = randomUUID();
        await tx.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic FK-only organization','America/New_York')", [otherOrg]);
        await tx.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic FK-only actor','employee')", [actorId, otherOrg, randomUUID() + "@example.test"]);
      }
      const id = randomUUID();
      await tx.query(`INSERT INTO organization_branding_history(id,org_id,version,command_id,previous_history_id,before_version,before_settings_hash,before_state,after_state,settings_hash,reason,actor_id,actor_name,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,$11,$12,$13)`, [id, owner.actor.org_id, next.version, randomUUID(), previous.id, previous.version, previous.settings_hash,
        JSON.stringify(earlier), JSON.stringify(next), "Synthetic invalid chain mutation", actorId, owner.actor.name, previous.created_at]);
      if (mode !== "orphan") await tx.query("UPDATE organization_branding SET version=$1,history_id=$2,settings=$3 WHERE org_id=$4", [next.version, id,
        JSON.stringify(mode === "pointer" ? { ...next.settings, subtitle: "Wrong current settings" } : next.settings), owner.actor.org_id]);
    });
  }
  for (const mode of ["orphan", "before", "pointer", "foreign"] as const) {
    await assert.rejects(invalidNext(mode), /pointer|predecessor|foreign key/i); assert.deepEqual(await state(), before);
  }
});

test("busy database outcomes are retryable503 and do not change command UUID semantics", async () => {
  const input = await change();
  for (const code of ["55P03", "57014", "40001", "40P01"]) {
    let attempts = 0;
    const failing: Database = { ...db, transaction: async () => { attempts++; throw Object.assign(new Error("synthetic busy"), { code }); } };
    await assert.rejects(publishOrganizationBranding(failing, owner.actor, owner.hash, input), (e: any) => e.status === 503);
    assert.equal(attempts, ["40001", "40P01"].includes(code) ? 3 : 1);
  }
  const result = await publishOrganizationBranding(db, owner.actor, owner.hash, input);
  assert.deepEqual(await publishOrganizationBranding(db, owner.actor, owner.hash, input), result);
});
