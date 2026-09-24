import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { getReport, toCsv, reportColumns } from "../server/reports";
import { getAuthorizedWorkforceReport, exportAuthorizedWorkforceReport } from "../server/workforce-report-access";

let db: Database, org: string, unit: string, otherUnit: string, worker: string, otherWorker: string;
const origin = "http://localhost:3197", query = { start: "2026-09-20", end: "2026-09-20", group: "day" as const };
const path = "/api/reports?start=2026-09-20&end=2026-09-20";
const application = (database = db) => createApp(database, { origin, production: false, demo: true, staffDomain: "stjw.org" });
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "report-access.owner@example.test" });
  org = (await db.query("SELECT id FROM organizations")).rows[0].id;
  const jobs = (await db.query("SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2")).rows;
  unit = jobs[0].unit_id; otherUnit = jobs[1].unit_id;
  const people = [];
  for (const job of jobs) {
    const id = randomUUID(), shift = randomUUID(); people.push(id);
    await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic report worker','employee')", [id, org, id + "@stjw.org"]);
    await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-09-20T14:00:00Z','2026-09-20T15:00:00Z')", [shift, org, id]);
    await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work','2026-09-20T14:00:00Z','2026-09-20T15:00:00Z')", [randomUUID(), org, shift, job.id]);
  }
  [worker, otherWorker] = people;
});
after(async () => { await db?.close(); });

async function reader(role = "admin", mode: "password" | "api" = "password") {
  const id = randomUUID(), raw = opaqueToken(), hash = digest(raw), csrf = opaqueToken();
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic report reader',$4)", [id, org, id + "@stjw.org", role]);
  await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [org, id, unit]);
  if (mode === "password") await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')", [hash, org, id, csrf]);
  else await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic report token','[\"reports:read\"]',now()+interval '1 hour')", [randomUUID(), org, id, hash]);
  return { actor: { id, org_id: org, name: "Synthetic report reader", email: id + "@stjw.org", role, mode, unit_ids: [unit], scopes: ["reports:read"] } as Actor,
    proof: { mode, hash }, raw, cookie: "stjw_session=" + raw };
}

function afterMiddleware(action: () => Promise<unknown>, bearer = false): Database {
  let used = false;
  return { ...db, query: async <T extends Row = Row>(sql: string, params?: any[]) => {
    const result = await db.query<T>(sql, params);
    if (!used && sql.includes(bearer ? "FROM api_tokens t JOIN users u" : "FROM sessions s JOIN users u")) { used = true; await action(); }
    return result;
  } };
}
function afterTransactionQuery(action: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  return { ...db, transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<R>(sql, params); await action(tx, sql, params); return result;
  } })) };
}
const exportAudits = async (id: string) => Number((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND action='report.exported'", [id])).rows[0].n);

test("direct JSON and CSV refresh a role revoked after middleware proof", async () => {
  for (const csv of [false, true]) {
    const r = await reader();
    const wrapped = afterMiddleware(() => db.query("UPDATE users SET role='employee' WHERE id=$1", [r.actor.id]));
    const response = await request(application(wrapped)).get(csv ? path.replace("/reports?", "/reports/export?") : path).set("Cookie", r.cookie);
    assert.equal(response.status, 200);
    if (csv) { assert.equal(response.text, toCsv([], reportColumns)); assert.equal(await exportAudits(r.actor.id), 1); }
    else { assert.deepEqual(response.body.rows, []); assert.equal(response.body.workMs, 0); }
  }
});

test("direct report refreshes exact manager memberships after middleware", async () => {
  const r = await reader("manager");
  const wrapped = afterMiddleware(() => db.query("UPDATE user_units SET unit_id=$1 WHERE user_id=$2 AND unit_id=$3", [otherUnit, r.actor.id, unit]));
  const response = await request(application(wrapped)).get(path).set("Cookie", r.cookie);
  assert.equal(response.status, 200); assert.deepEqual(response.body.rows.map((row: Row) => row.user_id), [otherWorker]);
});

test("direct report denies a session revoked after middleware without an export audit", async () => {
  const r = await reader();
  const wrapped = afterMiddleware(() => db.query("DELETE FROM sessions WHERE token_hash=$1", [r.proof.hash]));
  const response = await request(application(wrapped)).get(path.replace("/reports?", "/reports/export?")).set("Cookie", r.cookie);
  assert.equal(response.status, 401); assert.equal(await exportAudits(r.actor.id), 0); assert.equal(response.headers["content-disposition"], undefined);
});

test("bearer report keeps current account scope and exact read permission", async () => {
  const r = await reader("manager", "api");
  const expected = await getReport(db, r.actor, query);
  const result = await getAuthorizedWorkforceReport(db, r.actor, r.proof, query);
  assert.deepEqual(result.rows, expected.rows); assert.equal(result.workMs, 3600000); assert.equal(result.rows[0].user_id, worker);
  await db.query("UPDATE api_tokens SET scopes='[\"staff:read\"]' WHERE token_hash=$1", [r.proof.hash]);
  await assert.rejects(getAuthorizedWorkforceReport(db, r.actor, r.proof, query), (error: any) => error.status === 403);
});

test("HTTP bearer revocation after middleware blocks both JSON and CSV", async () => {
  for (const csv of [false, true]) {
    const r = await reader("admin", "api");
    const wrapped = afterMiddleware(() => db.query("UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE token_hash=$1", [r.proof.hash]), true);
    const response = await request(application(wrapped)).get(csv ? path.replace("/reports?", "/reports/export?") : path).set("Authorization", "Bearer " + r.raw);
    assert.equal(response.status, 403); assert.equal(await exportAudits(r.actor.id), 0);
  }
});

test("final session/token expiry rejects export and rolls back its audit", async () => {
  for (const mode of ["password", "api"] as const) {
    const r = await reader("admin", mode);
    const wrapped = afterTransactionQuery(async (tx, sql, params) => {
      if (sql.includes("INSERT INTO audit_events") && params[3] === "report.exported")
        await tx.query(`UPDATE ${mode === "password" ? "sessions" : "api_tokens"} SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, [r.proof.hash]);
    });
    await assert.rejects(exportAuthorizedWorkforceReport(wrapped, r.actor, r.proof, query), (error: any) => [401, 403].includes(error.status));
    assert.equal(await exportAudits(r.actor.id), 0);
    assert.equal((await getAuthorizedWorkforceReport(db, r.actor, r.proof, query)).rows.length, 2);
  }
});

test("failed export audit and invalid columns cannot return bytes or retain an audit", async () => {
  const r = await reader();
  const wrapped = afterTransactionQuery(async (_tx, sql, params) => { if (sql.includes("INSERT INTO audit_events") && params[3] === "report.exported") throw Error("Synthetic report audit failure"); });
  await assert.rejects(exportAuthorizedWorkforceReport(wrapped, r.actor, r.proof, query), /Synthetic report audit failure/);
  await assert.rejects(exportAuthorizedWorkforceReport(db, r.actor, r.proof, { ...query, columns: "password_hash" }), (error: any) => error.status === 400);
  assert.equal(await exportAudits(r.actor.id), 0);
  const expected = await getReport(db, r.actor, query);
  assert.equal(await exportAuthorizedWorkforceReport(db, r.actor, r.proof, query), toCsv(expected.rows, reportColumns));
  assert.equal(await exportAudits(r.actor.id), 1);
});

test("report credential must belong to the exact account and allowed mode", async () => {
  const a = await reader(), b = await reader("admin", "api");
  await assert.rejects(getAuthorizedWorkforceReport(db, a.actor, { mode: "password", hash: b.proof.hash }, query), (error: any) => error.status === 401);
  await assert.rejects(getAuthorizedWorkforceReport(db, { ...a.actor, mode: "api" }, b.proof, query), (error: any) => error.status === 403);
  await assert.rejects(getAuthorizedWorkforceReport(db, { ...a.actor, mode: "pin" }, { mode: "pin", hash: a.proof.hash } as any, query), (error: any) => error.status === 401);
});
