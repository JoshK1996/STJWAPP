import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectDatabase, migrate } from "../../../server/db.ts";
import { createApp } from "../../../server/app.ts";
import { digest, opaqueToken } from "../../../server/security.ts";
import { messages } from "../build/errors.js";

// Optional workspace acceptance harness, not part of the standalone mock suite.
// This process receives a scrubbed environment from scripts/test-workspace.mjs.
// No database URL or storage path is ever supplied; all credentials and records
// are generated here and remain in process memory / the in-memory PGlite fixture.
let db, server, client, diagnostics = "", phase = "isolated fixture startup", passed = 0;
const secrets = [];
const org = randomUUID(), foreignOrg = randomUUID(), owner = randomUUID();
const employeeA = randomUUID(), employeeB = randomUUID(), foreignUser = randomUUID();
const unitA = randomUUID(), unitB = randomUUID(), foreignUnit = randomUUID();
const jobA = randomUUID(), jobB = randomUUID(), foreignJob = randomUUID();
const longUnitName = "Synthetic school unit ".padEnd(120, "u");
const query = { start: "2020-03-08", end: "2020-03-08", group: "hour" };
const sourceRows = [];

async function check(name, action) {
  phase = name;
  await action();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false);
}
async function read(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  noSecrets(result);
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
async function denied(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  noSecrets(result);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `FORBIDDEN: ${messages.FORBIDDEN}`);
}
async function addShift(user, unit, job, segments, organization = org) {
  const shift = randomUUID();
  await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)", [shift, organization, user, segments[0][1], segments.at(-1)[2]]);
  for (const [kind, start, end] of segments) {
    const id = randomUUID();
    await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, organization, shift, job, kind, start, end]);
    sourceRows.push({ id, user, unit, job, organization, kind, start, end, duration: Date.parse(end) - Date.parse(start) });
  }
}

try {
  assert.equal(process.env.NODE_ENV, "test");
  db = await connectDatabase(); // Undefined URL + undefined path => memory only.
  await migrate(db);
  for (const [id, name] of [[org, "Synthetic MCP acceptance"], [foreignOrg, "Synthetic foreign organization"]])
    await db.query("INSERT INTO organizations(id,name,timezone,demo) VALUES($1,$2,'America/New_York',true)", [id, name]);
  for (const [id, organization, name] of [[unitA, org, longUnitName], [unitB, org, "Synthetic second unit"], [foreignUnit, foreignOrg, "Synthetic foreign unit"]])
    await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,'school')", [id, organization, name]);
  for (const [id, organization, unit] of [[jobA, org, unitA], [jobB, org, unitB], [foreignJob, foreignOrg, foreignUnit]])
    await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic role')", [id, organization, unit]);
  for (const [id, organization, name, role, unit, job] of [[owner, org, "Synthetic Connector Owner", "owner", unitA, jobA], [employeeA, org, "Synthetic Employee A", "employee", unitA, jobA], [employeeB, org, "Synthetic Employee B", "employee", unitB, jobB], [foreignUser, foreignOrg, "Synthetic Foreign Employee", "employee", foreignUnit, foreignJob]]) {
    await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)", [id, organization, name, `${id}@example.test`, role]);
    await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [organization, id, unit]);
    await db.query("INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)", [organization, id, job]);
  }
  await addShift(employeeA, unitA, jobA, [
    ["work", "2020-03-08T06:59:59.123Z", "2020-03-08T07:00:00.456Z"],
    ["break", "2020-03-08T07:00:00.456Z", "2020-03-08T07:15:00.789Z"],
    ["work", "2020-03-08T07:15:00.789Z", "2020-03-08T08:00:00.999Z"],
  ]);
  await addShift(employeeB, unitB, jobB, [["work", "2020-03-08T15:00:00.001Z", "2020-03-08T16:00:00.999Z"]]);
  await addShift(owner, unitA, jobA, [["work", "2020-03-08T10:00:00.111Z", "2020-03-08T10:00:01.222Z"]]);
  await addShift(employeeA, unitA, jobA, [["work", "2020-03-09T12:00:00.123400Z", "2020-03-09T12:00:00.123456Z"]]);
  await addShift(foreignUser, foreignUnit, foreignJob, [["work", "2020-03-08T10:00:00.000Z", "2020-03-08T11:00:00.000Z"]], foreignOrg);
  const session = opaqueToken(), csrf = opaqueToken(); secrets.push(session, csrf);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')", [digest(session), org, owner, csrf]);

  server = http.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  server.on("request", createApp(db, { origin, production: false, staffDomain: "stjw.org", demo: true }));
  async function ownerPost(path, body) {
    const response = await fetch(new URL(path, origin), { method: "POST", redirect: "error", headers: { Origin: origin, Cookie: `stjw_session=${session}`, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); return response.json();
  }
  let issued;
  await check("real owner endpoint issues the synthetic scoped token and audit record", async () => {
    issued = await ownerPost("/api/tokens", { name: "Synthetic MCP workspace acceptance", scopes: ["staff:read", "reports:read"], days: 1 });
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/); secrets.push(issued.token);
    const stored = (await db.query("SELECT token_hash,scopes FROM api_tokens WHERE id=$1", [issued.id])).rows[0];
    assert.equal(stored.token_hash, digest(issued.token)); assert.deepEqual(stored.scopes, ["staff:read", "reports:read"]);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='api_token.created' AND target_id=$1", [issued.id])).rows.length, 1);
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../build/index.js", import.meta.url))], stderr: "pipe", env: { STJW_API_ORIGIN: origin, STJW_API_TOKEN: issued.token, STJW_ALLOW_LOOPBACK_HTTP: "1", NODE_ENV: "test" } });
  transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
  client = new Client({ name: "stjw-actual-app-synthetic-acceptance", version: "1.0.0" });
  await client.connect(transport);
  await check("actual app staff response crosses stdio with other organization and setup fields excluded", async () => {
    const result = await read("stjw_list_staff");
    assert.deepEqual(result.rows.map((row) => row.id).sort(), [owner, employeeA, employeeB].sort());
    for (const row of result.rows) assert.deepEqual(Object.keys(row).sort(), ["id", "name", "email", "role", "active", "unit_ids", "job_ids"].sort());
  });
  await check("real report preserves every source timestamp and exact duration including 120-character unit", async () => {
    const result = await read("stjw_workforce_report", query);
    assert.equal(result.workMs, 6303652); assert.equal(result.breakMs, 900333); assert.equal(result.rows.length, 5);
    for (const row of result.rows) {
      const expected = sourceRows.find((entry) => entry.id === row.id);
      assert.equal(expected.organization, org); assert.equal(row.started_at, expected.start); assert.equal(row.ended_at, expected.end);
      assert.equal(row.duration_ms, expected.duration); assert.equal(row.duration_seconds, expected.duration / 1000);
      if (row.unit_id === unitA) assert.equal(row.unit_name, longUnitName);
    }
  });
  await check("user filter and spring DST hourly buckets follow the real report service", async () => {
    const result = await read("stjw_workforce_report", { ...query, userId: employeeA });
    assert.equal(result.workMs, 2701543); assert.equal(result.breakMs, 900333); assert.equal(result.rows.length, 3);
    assert.ok(result.rows.every((row) => row.user_id === employeeA));
    assert.equal(result.buckets.find((bucket) => bucket.key === "2020-03-08T01:00:00.000-05:00").workMs, 877);
    assert.equal(result.buckets.find((bucket) => bucket.key === "2020-03-08T03:00:00.000-04:00").workMs, 2699667);
    assert.ok(result.buckets.every((bucket) => !bucket.key.startsWith("2020-03-08T02:")));
  });
  await check("unit and combined identity filters are applied by the real endpoint", async () => {
    const result = await read("stjw_workforce_report", { ...query, unitId: unitB }); assert.equal(result.workMs, 3600998); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].user_id, employeeB);
    const empty = await read("stjw_workforce_report", { ...query, unitId: unitB, userId: employeeA }); assert.equal(empty.rows.length, 0); assert.equal(empty.workMs, 0);
    const foreign = await read("stjw_workforce_report", { ...query, userId: foreignUser }); assert.equal(foreign.rows.length, 0);
  });
  await check("v2 real endpoint and stdio preserve sub-millisecond source and totals", async () => {
    const exactQuery = { start: "2020-03-09", end: "2020-03-09", group: "day" };
    const exact = await read("stjw_workforce_report_v2", exactQuery);
    assert.equal(exact.schemaVersion, 2); assert.equal(exact.precisionVersion, 2); assert.equal(exact.durationUnit, "microsecond");
    assert.equal(exact.workMicroseconds, "56"); assert.equal(exact.breakMicroseconds, "0"); assert.equal(exact.rows.length, 1);
    assert.equal(exact.rows[0].started_at, "2020-03-09T12:00:00.123400Z"); assert.equal(exact.rows[0].ended_at, "2020-03-09T12:00:00.123456Z");
    assert.equal(exact.rows[0].duration_microseconds, "56"); assert.equal(exact.staff[0].workMicroseconds, "56"); assert.equal(exact.buckets[0].workMicroseconds, "56");
    assert.equal((await read("stjw_workforce_report", exactQuery)).workMs, 0);
  });
  await check("v2 DST bucket identities and scope filters cross actual stdio", async () => {
    const exact = await read("stjw_workforce_report_v2", { ...query, userId: employeeA });
    assert.equal(exact.workMicroseconds, "2701543000"); assert.equal(exact.breakMicroseconds, "900333000");
    assert.equal(exact.buckets.find(bucket => bucket.key === "2020-03-08T06:00:00.000000Z").workMicroseconds, "877000");
    assert.equal(exact.buckets.find(bucket => bucket.key === "2020-03-08T07:00:00.000000Z").workMicroseconds, "2699667000");
    assert.equal((await read("stjw_workforce_report_v2", { ...query, unitId: unitB, userId: employeeA })).rows.length, 0);
    assert.equal((await read("stjw_workforce_report_v2", { ...query, userId: foreignUser })).rows.length, 0);
  });
  await check("removing staff scope denies the next staff read while report access remains", async () => {
    await db.query("UPDATE api_tokens SET scopes=$2 WHERE id=$1", [issued.id, JSON.stringify(["reports:read"])]);
    await denied("stjw_list_staff"); assert.equal((await read("stjw_workforce_report", query)).rows.length, 5);
  });
  await check("removing report scope denies the next report read while staff access remains", async () => {
    await db.query("UPDATE api_tokens SET scopes=$2 WHERE id=$1", [issued.id, JSON.stringify(["staff:read"])]);
    await denied("stjw_workforce_report", query); await denied("stjw_workforce_report_v2", query); assert.equal((await read("stjw_list_staff")).rows.length, 3);
    await db.query("UPDATE api_tokens SET scopes=$2 WHERE id=$1", [issued.id, JSON.stringify(["staff:read", "reports:read"])]);
  });
  await check("manager downgrade immediately restricts staff and time records to the assigned unit", async () => {
    await db.query("UPDATE users SET role='manager' WHERE id=$1", [owner]);
    const directory = await read("stjw_list_staff"); assert.deepEqual(directory.rows.map((row) => row.id).sort(), [owner, employeeA].sort());
    const result = await read("stjw_workforce_report", query); assert.equal(result.rows.length, 4); assert.ok(result.rows.every((row) => row.unit_id === unitA));
    assert.equal((await read("stjw_workforce_report", { ...query, unitId: unitB })).rows.length, 0);
  });
  await check("manager unit revocation applies on the next request without restarting the bridge", async () => {
    await db.query("DELETE FROM user_units WHERE user_id=$1", [owner]);
    assert.equal((await read("stjw_list_staff")).rows.length, 0);
    const result = await read("stjw_workforce_report", query); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].user_id, owner);
  });
  await check("employee downgrade denies staff directory and keeps only the employee's own time", async () => {
    await db.query("UPDATE users SET role='employee' WHERE id=$1", [owner]);
    await denied("stjw_list_staff"); const result = await read("stjw_workforce_report", query); assert.equal(result.workMs, 1111); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].user_id, owner);
    assert.equal((await read("stjw_workforce_report", { ...query, userId: employeeA })).rows.length, 0);
    await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner]);
  });
  await check("inactive account blocks both tools through actual bearer middleware", async () => {
    await db.query("UPDATE users SET active=false WHERE id=$1", [owner]); await denied("stjw_list_staff"); await denied("stjw_workforce_report", query);
    await db.query("UPDATE users SET active=true WHERE id=$1", [owner]);
  });
  await check("expired token blocks both tools after previous successful calls", async () => {
    await db.query("UPDATE api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [issued.id]); await denied("stjw_list_staff"); await denied("stjw_workforce_report", query);
    await db.query("UPDATE api_tokens SET expires_at=now()+interval '1 hour' WHERE id=$1", [issued.id]);
    assert.equal((await read("stjw_list_staff")).rows.length, 3);
  });
  await check("actual owner revocation endpoint blocks the unchanged running bridge token", async () => {
    await ownerPost(`/api/tokens/${issued.id}/revoke`, {}); await denied("stjw_list_staff"); await denied("stjw_workforce_report", query);
    assert.notEqual((await db.query("SELECT revoked_at FROM api_tokens WHERE id=$1", [issued.id])).rows[0].revoked_at, null);
  });
  await check("MCP diagnostics contain no generated credentials", async () => { await client.close(); client = undefined; noSecrets(diagnostics); });
  process.stdout.write(`PASS workspace acceptance: ${passed} checks\n`);
} catch {
  // Never print assertion objects, HTTP bodies, token values or raw exceptions.
  process.stderr.write(`FAIL workspace acceptance: ${phase}\n`); process.exitCode = 1;
} finally {
  try { await client?.close(); } catch { process.stderr.write("FAIL workspace client cleanup\n"); process.exitCode = 1; }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  try { await db?.close(); } catch { process.stderr.write("FAIL workspace database cleanup\n"); process.exitCode = 1; }
}
