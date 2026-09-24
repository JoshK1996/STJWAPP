import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";

import { currentFinanceActor, financeTransaction } from "../server/finance-access";
import { totpAt } from "../server/totp";

const origin = "http://localhost:3187", reason = "Synthetic finance session verification";
let db: Database, owner: Actor, unitId: string, ownerAuth: Auth;
type Auth = { cookie: string; csrf: string; hash: string };
const application = (database = db) => createApp(database, { origin, production: false, staffDomain: "stjw.org", demo: false });
function send(database: Database, auth: Auth, path: string, body?: unknown) {
  const agent = request(application(database));
  return body === undefined ? agent.get("/api" + path).set("Cookie", auth.cookie)
    : agent.post("/api" + path).set("Cookie", auth.cookie).set("Origin", origin).set("X-CSRF-Token", auth.csrf).send(body as object);
}
async function signIn(email: string, password: string, database = db): Promise<Auth> {
  const r = await request(application(database)).post("/api/auth/login").set("Origin", origin).send({ email, credential: password, mode: "password" });
  assert.equal(r.status, 200); const cookie = (r.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const me = await request(application(database)).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
}
async function staff() {
  const email = randomUUID() + "@stjw.org", password = "Synthetic-" + randomUUID();
  const created = await send(db, ownerAuth, "/staff", { name: "Synthetic finance session user", email, role: "finance", unitIds: [unitId], jobIds: [] });
  assert.equal(created.status, 201);
  const setup = await request(application()).post("/api/auth/setup").set("Origin", origin).send({ token: new URL(created.body.setupUrl).hash.slice(7), password });
  assert.equal(setup.status, 200); return { id: created.body.id as string, email, password };
}
function input() { return { unitId, reportId: randomUUID(), expectedVersion: 0, metadata: { title: "Synthetic financial source", sourceName: "Synthetic",
  currency: "USD", kind: "actual", basis: "period_activity", from: "2026-01-01", to: "2026-01-31", note: "" },
  csv: "lineCode,lineLabel,group,rowKind,amount,note\nA,Synthetic,Example,detail,0.1,", reason }; }
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "finance.session.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  unitId = (await db.query("SELECT id FROM units ORDER BY id")).rows[0].id;
  owner = { id: row.id as string, org_id: row.org_id as string, name: row.name as string, email: row.email as string, role: "owner", mode: "password", unit_ids: [] };
  const password = "Synthetic-" + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  const setup = await request(application()).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  ownerAuth = await signIn(owner.email, password);
});
after(async () => { await db?.close(); });

test("finance denies a normal logout committed after middleware and before the service transaction", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password); let observed = false;
  const wrapper: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; const logout = await send(db, auth, "/auth/logout", {}); assert.equal(logout.status, 200); }
    return db.transaction(fn);
  } };
  const r = await send(wrapper, auth, "/finance/reports?unitId=" + unitId);
  assert.ok(observed); assert.equal(r.status, 401); assert.equal(r.body.rows, undefined);
});

test("finance final natural session expiry after audit rolls back preview creation (accelerated new-session fixture)", async () => {
  const user = await staff(); let expires = 0, inserted = false, auditObserved = false;
  const loginDb: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("INSERT INTO sessions") && params?.[2] === user.id) {
        assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], "password");
        assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
        inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires);
        return tx.query<R>(sql, changed);
      }
      return tx.query<R>(sql, params);
    },
  })) };
  const auth = await signIn(user.email, user.password, loginDb), raw = input(); assert.ok(inserted);
  const boundary: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (sql.startsWith("INSERT INTO audit_events") && params?.[2] === user.id && params[3] === "finance.preview_created") {
        auditObserved = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 35)));
      }
      return result;
    },
  })) };
  const r = await send(boundary, auth, "/finance/previews", raw);
  assert.ok(auditObserved); assert.equal(r.status, 401);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM financial_import_previews WHERE report_id=$1", [raw.reportId])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND action='finance.preview_created'", [user.id])).rows[0].n, 0);
});

async function prepared(auth: Auth, database = db) {
  const raw = input(), response = await send(database, auth, "/finance/previews", raw); assert.equal(response.status, 201);
  return { raw, preview: response.body, body: { sourceHash: response.body.sourceHash, fingerprint: response.body.fingerprint, reviewed: true } };
}
function beforeTransaction(action: () => Promise<void>) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!observed) { observed = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => observed };
}
async function shortSession(user: Awaited<ReturnType<typeof staff>>) {
  let expires = 0, inserted = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("INSERT INTO sessions") && params?.[2] === user.id) {
        assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[3], "password");
        assert.ok(new Date(params[5]).getTime() > Date.now() + 470 * 60_000);
        inserted = true; expires = Date.now() + 1500; const changed = [...params]; changed[5] = new Date(expires);
        return tx.query<R>(sql, changed);
      }
      return tx.query<R>(sql, params);
    },
  })) };
  const auth = await signIn(user.email, user.password, database); assert.ok(inserted); return { auth, expires };
}
function afterAudit(userId: string, action: string, expires: number) {
  let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (sql.startsWith("INSERT INTO audit_events") && params?.[2] === userId && params[3] === action) {
        observed = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 35)));
      }
      return result;
    },
  })) };
  return { database, observed: () => observed };
}
async function count(sql: string, params: unknown[]) { return (await db.query(sql, params)).rows[0].n as number; }

test("each direct finance read/export and finance-options rejects committed post-middleware logout", async () => {
  const user = await staff(), initial = await signIn(user.email, user.password), fixture = await prepared(initial);
  assert.equal((await send(db, initial, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body)).status, 200);
  const paths = ["/finance/template", "/finance/reports?unitId=" + unitId, "/finance/previews/" + fixture.preview.id,
    "/finance/reports/" + fixture.raw.reportId, "/finance/reports/" + fixture.raw.reportId + "/history",
    "/finance/reports/" + fixture.raw.reportId + "/versions/1?format=source", "/report-library/finance-options?unitId=" + unitId];
  for (const path of paths) {
    const auth = await signIn(user.email, user.password), gate = beforeTransaction(async () => {
      assert.equal((await send(db, auth, "/auth/logout", {})).status, 200);
    });
    const response = await send(gate.database, auth, path); assert.ok(gate.observed()); assert.equal(response.status, 401, path);
    assert.equal(response.headers["x-source-hash"], undefined); assert.equal(response.headers["content-disposition"], undefined);
  }
});

test("finance mutation and comparison routes deny committed logout including an applied receipt", async () => {
  const user = await staff(), initial = await signIn(user.email, user.password), fixture = await prepared(initial);
  assert.equal((await send(db, initial, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body)).status, 200);
  const comparison = { leftId: fixture.raw.reportId, leftVersion: 1, rightId: fixture.raw.reportId, rightVersion: 1 };
  const attempts: [string, unknown][] = [["/finance/previews", input()], ["/finance/previews/" + fixture.preview.id + "/publish", fixture.body],
    ["/finance/reports/" + fixture.raw.reportId + "/archive", { stateVersion: 1, archived: true, reason }],
    ["/finance/compare", comparison], ["/finance/compare/export?format=csv", comparison]];
  for (const [path, body] of attempts) {
    const auth = await signIn(user.email, user.password), gate = beforeTransaction(async () => {
      assert.equal((await send(db, auth, "/auth/logout", {})).status, 200);
    });
    const response = await send(gate.database, auth, path, body); assert.ok(gate.observed()); assert.equal(response.status, 401, path);
  }
  assert.equal((await db.query("SELECT archived FROM financial_reports WHERE id=$1", [fixture.raw.reportId])).rows[0].archived, false);
});

test("publication session expiry after actual audit rolls back parent, version, receipt and audit", async () => {
  const user = await staff(), initial = await signIn(user.email, user.password), fixture = await prepared(initial), short = await shortSession(user);
  const gate = afterAudit(user.id, "finance.report_published", short.expires);
  const response = await send(gate.database, short.auth, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body);
  assert.ok(gate.observed()); assert.equal(response.status, 401);
  assert.equal(await count("SELECT count(*)::int n FROM financial_reports WHERE id=$1", [fixture.raw.reportId]), 0);
  assert.equal(await count("SELECT count(*)::int n FROM financial_report_versions WHERE report_id=$1", [fixture.raw.reportId]), 0);
  const preview = (await db.query("SELECT applied_at,receipt FROM financial_import_previews WHERE id=$1", [fixture.preview.id])).rows[0];
  assert.equal(preview.applied_at, null); assert.equal(preview.receipt, null);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action='finance.report_published'", [user.id]), 0);
});

test("archive and byte exports final expiry roll back actual audit/history and publish no files", async () => {
  const user = await staff(), initial = await signIn(user.email, user.password), fixture = await prepared(initial);
  assert.equal((await send(db, initial, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body)).status, 200);
  const comparison = { leftId: fixture.raw.reportId, leftVersion: 1, rightId: fixture.raw.reportId, rightVersion: 1 };
  const attempts: [string, string, unknown?][] = [
    ["finance.archive_changed", "/finance/reports/" + fixture.raw.reportId + "/archive", { stateVersion: 1, archived: true, reason }],
    ["finance.report_read", "/finance/reports/" + fixture.raw.reportId + "/versions/1?format=csv"],
    ["finance.reports_compared", "/finance/compare/export?format=json", comparison],
  ];
  for (const [action, path, body] of attempts) {
    const short = await shortSession(user), gate = afterAudit(user.id, action, short.expires);
    const response = await send(gate.database, short.auth, path, body); assert.ok(gate.observed()); assert.equal(response.status, 401);
    assert.equal(response.headers["content-disposition"], undefined); assert.equal(response.headers["x-source-hash"], undefined);
    assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action=$2", [user.id, action]), 0);
  }
  assert.deepEqual((await db.query("SELECT archived,state_version FROM financial_reports WHERE id=$1", [fixture.raw.reportId])).rows[0], { archived: false, state_version: 1 });
  assert.equal(await count("SELECT count(*)::int n FROM financial_report_events WHERE report_id=$1", [fixture.raw.reportId]), 0);
});

async function shortPreview(auth: Auth) {
  let inserted = false, expires = 0;
  const raw = input(), database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("INSERT INTO financial_import_previews") && params?.[4] === raw.reportId) {
        assert.equal(inserted, false); assert.equal(params[1], owner.org_id); assert.equal(params[2], unitId);
        inserted = true; expires = Date.now() + 1500;
        // Accelerated lifetime of this newly created isolated preview only; no retained row update.
        return tx.query<R>(sql.replace("reason) VALUES", "reason,expires_at) VALUES").replace("$12) RETURNING", "$12,$13) RETURNING"), [...params, new Date(expires)]);
      }
      return tx.query<R>(sql, params);
    },
  })) };
  const response = await send(database, auth, "/finance/previews", raw); assert.equal(response.status, 201); assert.ok(inserted);
  return { raw, preview: response.body, expires, body: { sourceHash: response.body.sourceHash, fingerprint: response.body.fingerprint, reviewed: true } };
}

test("preview natural expiry after publication audit fails final DB-clock consumption atomically", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password), fixture = await shortPreview(auth);
  const gate = afterAudit(user.id, "finance.report_published", fixture.expires);
  const response = await send(gate.database, auth, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body);
  assert.ok(gate.observed()); assert.equal(response.status, 409);
  assert.equal(await count("SELECT count(*)::int n FROM financial_reports WHERE id=$1", [fixture.raw.reportId]), 0);
  assert.equal(await count("SELECT count(*)::int n FROM financial_report_versions WHERE report_id=$1", [fixture.raw.reportId]), 0);
  assert.equal((await db.query("SELECT applied_at FROM financial_import_previews WHERE id=$1", [fixture.preview.id])).rows[0].applied_at, null);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action='finance.report_published'", [user.id]), 0);
});

test("applied receipt remains unchanged after preview expiry/archive under a fresh actual session", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password), fixture = await shortPreview(auth);
  const path = "/finance/previews/" + fixture.preview.id + "/publish", first = await send(db, auth, path, fixture.body); assert.equal(first.status, 200);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, fixture.expires - Date.now() + 35)));
  assert.equal((await send(db, ownerAuth, "/finance/reports/" + fixture.raw.reportId + "/archive", { stateVersion: 1, archived: true, reason })).status, 200);
  const fresh = await signIn(user.email, user.password), second = await send(db, fresh, path, fixture.body);
  assert.equal(second.status, 200); assert.deepEqual(second.body, first.body);
  // Initial response insertion order differs from PostgreSQL JSONB order already in v1; stored receipt bytes retain their existing order.
  assert.equal(second.text, JSON.stringify((await db.query("SELECT receipt FROM financial_import_previews WHERE id=$1", [fixture.preview.id])).rows[0].receipt));
  assert.equal(await count("SELECT count(*)::int n FROM financial_report_versions WHERE report_id=$1", [fixture.raw.reportId]), 1);
  assert.equal(await count("SELECT count(*)::int n FROM audit_events WHERE actor_id=$1 AND action='finance.report_published'", [user.id]), 1);
});

test("current role, active state, actual proof identity/mode and onboarding gate cannot be replaced by cached authority", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password), supplied = { ...owner, id: user.id, email: user.email, role: "owner" } as Actor;
  assert.equal((await financeTransaction(db, supplied, auth.hash, async (_tx, current) => current.role)), "finance");
  await assert.rejects(db.transaction(tx => currentFinanceActor(tx, supplied, undefined)), (e: any) => e.status === 401);
  await assert.rejects(db.transaction(tx => currentFinanceActor(tx, supplied, ownerAuth.hash)), (e: any) => e.status === 401);
  for (const [role, active] of [["employee", true], ["finance", false]] as const) {
    const changed = await request(application()).patch("/api/staff/" + user.id).set("Cookie", ownerAuth.cookie).set("Origin", origin).set("X-CSRF-Token", ownerAuth.csrf)
      .send({ name: "Synthetic finance session user", email: user.email, role, active, unitIds: [unitId], jobIds: [] }); assert.equal(changed.status, 200);
    await assert.rejects(db.transaction(tx => currentFinanceActor(tx, supplied, auth.hash)), (e: any) => [401,403].includes(e.status));
  }
  const temp = await send(db, ownerAuth, "/staff", { name: "Synthetic unfinished credentials", email: randomUUID() + "@stjw.org", role: "finance", unitIds: [unitId], jobIds: [], initialCredentials: { password: "Synthetic-" + randomUUID(), pin: "783915" } }); assert.equal(temp.status, 201);
  await assert.rejects(db.transaction(tx => currentFinanceActor(tx, { ...supplied, id: temp.body.id }, ownerAuth.hash)), (e: any) => e.status === 403 && /temporary credentials/.test(e.message));
  const pinUser = await staff(), password = await signIn(pinUser.email, pinUser.password);
  assert.equal((await send(db, password, "/auth/pin", { password: pinUser.password, pin: "731958" })).status, 200);
  const login = await request(application()).post("/api/auth/login").set("Origin", origin).send({ email: pinUser.email, credential: "731958", mode: "pin" }); assert.equal(login.status, 200);
  const pinCookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0], pinHash = digest(pinCookie.slice(pinCookie.indexOf("=") + 1));
  await assert.rejects(db.transaction(tx => currentFinanceActor(tx, { ...supplied, id: pinUser.id }, pinHash)), (e: any) => e.status === 401);
});

function decodeBase32(value: string) {
  let n = 0, bits = 0; const bytes: number[] = [];
  for (const c of value) { n = (n << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255); } }
  return Buffer.from(bytes);
}
test("normal MFA enrollment between middleware and finance revokes old proof; verified replacement works", async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const user = await staff(), auth = await signIn(user.email, user.password), enrollment = await send(db, auth, "/auth/mfa/enroll", { password: user.password });
  assert.equal(enrollment.status, 200); let verifiedCookie = "";
  const gate = beforeTransaction(async () => {
    const confirmed = await send(db, auth, "/auth/mfa/confirm", { id: enrollment.body.id, code: totpAt(decodeBase32(enrollment.body.secret), Date.now()) });
    assert.equal(confirmed.status, 200); verifiedCookie = (confirmed.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  });
  assert.equal((await send(gate.database, auth, "/finance/template")).status, 401); assert.ok(gate.observed());
  const available = await request(application()).get("/api/finance/template").set("Cookie", verifiedCookie); assert.equal(available.status, 200);
  delete process.env.MFA_ENCRYPTION_KEY;
});


test("finance account mutation committed after middleware denies waiting work without changing original financial data", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password), fixture = await prepared(auth);
  const gate = beforeTransaction(async () => {
    const changed = await request(application()).patch("/api/staff/" + user.id).set("Cookie", ownerAuth.cookie).set("Origin", origin).set("X-CSRF-Token", ownerAuth.csrf)
      .send({ name: "Synthetic finance session user", email: user.email, role: "employee", active: true, unitIds: [unitId], jobIds: [] }); assert.equal(changed.status, 200);
  });
  assert.equal((await send(gate.database, auth, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body)).status, 401); assert.ok(gate.observed());
  assert.equal(await count("SELECT count(*)::int n FROM financial_reports WHERE id=$1", [fixture.raw.reportId]), 0);
  assert.equal((await db.query("SELECT applied_at FROM financial_import_previews WHERE id=$1", [fixture.preview.id])).rows[0].applied_at, null);
});

test("source/CSV/JSON exports preserve exact source/hash/decimal evidence and do not put financial content in audits", async () => {
  const user = await staff(), auth = await signIn(user.email, user.password), fixture = await prepared(auth);
  assert.equal((await send(db, auth, "/finance/previews/" + fixture.preview.id + "/publish", fixture.body)).status, 200);
  const base = "/finance/reports/" + fixture.raw.reportId + "/versions/1?format=", hash = digest(fixture.raw.csv);
  const source = await send(db, auth, base + "source"); assert.equal(source.status, 200); assert.equal(source.text, fixture.raw.csv); assert.equal(source.headers["x-source-hash"], hash);
  const csv = await send(db, auth, base + "csv"); assert.equal(csv.status, 200); assert.equal(csv.text,
    '\uFEFF"lineCode","lineLabel","group","rowKind","amount","note","currency","report_id","version","source_hash"\r\n' +
    `"A","Synthetic","Example","detail","0.1","","USD","${fixture.raw.reportId}","1","${hash}"`);
  const json = await send(db, auth, base + "json"); assert.equal(json.status, 200); assert.equal(json.headers["x-source-hash"], hash);
  assert.deepEqual(json.body.metadata, fixture.raw.metadata); assert.equal(json.body.lines[0].amount, "0.1"); assert.equal(json.body.totals.detailSum, "0.1");
  assert.equal(json.body.source_text, undefined); assert.equal(json.body.source_hash, hash);
  const comparisons = { leftId: fixture.raw.reportId, leftVersion: 1, rightId: fixture.raw.reportId, rightVersion: 1 };
  for (const format of ["csv", "json"]) {
    const response = await send(db, auth, "/finance/compare/export?format=" + format, comparisons); assert.equal(response.status, 200);
    assert.match(response.headers["content-disposition"], new RegExp("financial-comparison\\." + format));
    if (format === "json") { const result = JSON.parse(response.text); assert.equal(result.rows[0].delta, "0"); assert.equal(result.sourceHash, response.headers["x-source-hash"]); }
  }
  const audits = (await db.query("SELECT action,detail FROM audit_events WHERE actor_id=$1 AND action LIKE 'finance.%'", [user.id])).rows;
  assert.ok(audits.length >= 7); for (const record of audits) { assert.equal(record.detail.lines, undefined); assert.equal(record.detail.source_text, undefined); assert.ok(!JSON.stringify(record.detail).includes(fixture.raw.metadata.title)); }
});
