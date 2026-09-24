import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readConfig } from "../build/config.js";
import { StjwReads, limits } from "../build/api.js";
import { messages } from "../build/errors.js";

// Deliberately public, synthetic test credentials; no real environment is read.
const token = "synthetic_test_token_".padEnd(43, "x");
const privateMarker = "synthetic-upstream-private-diagnostic";
const id = "11111111-1111-4111-8111-111111111111";
const unit = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const query = { start: "2026-09-22", end: "2026-09-23", group: "day" };
const staff = () => ({ rows: [{ id, name: "Synthetic Staff", email: "synthetic@example.test", role: "employee", active: true, unit_ids: [unit], job_ids: [job] }] });
const report = (q = query) => ({ workMs: 3600123, breakMs: 0,
  buckets: [{ key: "2026-09-22T04:00:00.000Z", label: "Sep 22", workMs: 3600123, breakMs: 0 }],
  staff: [{ id, name: "Synthetic Staff", workMs: 3600123, breakMs: 0 }],
  rows: [{ id, kind: "work", started_at: "2026-09-22T12:00:00.000Z", ended_at: "2026-09-22T13:00:00.123Z", revision: 1, shift_id: id, user_id: id, employee_name: "Synthetic Staff", job_id: job, job_title: "Synthetic Job", unit_id: unit, unit_name: "Synthetic Unit", duration_ms: 3600123, duration_seconds: 3600.123 }],
  timezone: "America/New_York", asOf: "2026-09-23T18:00:00.000Z", query: q, notice: "Recorded time; not payroll." });
function json(response, body, status = 200) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); }
async function mock(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization }); handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = readConfig({ STJW_API_ORIGIN: origin, STJW_API_TOKEN: token, STJW_ALLOW_LOOPBACK_HTTP: "1" });
  return { server, origin, config, requests };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code); assert.equal(error.message, messages[code]);
    assert.ok(!String(error).includes(token)); assert.ok(!String(error).includes(privateMarker)); return true;
  });
}

test("configuration permits bare HTTPS and explicit literal loopback, rejects unsafe origins without diagnostics", () => {
  assert.equal(readConfig({ STJW_API_ORIGIN: "https://stjw.example.test", STJW_API_TOKEN: token }).origin, "https://stjw.example.test");
  for (const origin of ["http://example.test", "http://localhost:8000", "http://127.0.0.1.evil.test", "https://user:secret@example.test", "https://example.test/api", "https://example.test/?key=secret", "https://example.test/#secret", "file:///tmp", " https://example.test"]) {
    assert.throws(() => readConfig({ STJW_API_ORIGIN: origin, STJW_API_TOKEN: token, STJW_ALLOW_LOOPBACK_HTTP: "1" }), { code: "CONFIGURATION", message: messages.CONFIGURATION });
  }
  assert.throws(() => readConfig({ STJW_API_ORIGIN: "http://127.0.0.1:8000", STJW_API_TOKEN: token }), { code: "CONFIGURATION" });
  assert.equal(readConfig({ STJW_API_ORIGIN: "http://[::1]:8000", STJW_API_TOKEN: token, STJW_ALLOW_LOOPBACK_HTTP: "1" }).origin, "http://[::1]:8000");
  assert.throws(() => readConfig({ STJW_API_ORIGIN: "https://example.test", STJW_API_TOKEN: token, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), { code: "CONFIGURATION" });
  for (const value of [undefined, "", "too-short", token + "\r\nInjected: true"]) {
    assert.throws(() => readConfig({ STJW_API_ORIGIN: "https://example.test", STJW_API_TOKEN: value }), { code: "CONFIGURATION", message: messages.CONFIGURATION });
  }
});

test("strict input rejects URL/pagination injection and invalid dates before any request", async (t) => {
  const upstream = await mock(t, (_req, res) => json(res, staff())); const api = new StjwReads(upstream.config);
  for (const input of [null, [], { url: "https://untrusted.test" }, { cursor: "next" }, { userId: id }]) await rejectsCode(api.staff(input), "INVALID_INPUT");
  for (const input of [{ ...query, url: "https://untrusted.test" }, { ...query, start: "2026-02-30" }, { ...query, end: "2026-09-21" }, { ...query, userId: "../staff" }, { ...query, group: "pay" }, { ...query, start: "2025-01-01", end: "2026-01-03" }, { ...query, group: "hour", end: "2026-10-24" }]) await rejectsCode(api.report(input), "INVALID_INPUT");
  assert.equal(upstream.requests.length, 0);
});

test("only fixed GET destinations and allowlisted staff/report fields leave the bridge", async (t) => {
  const filtered = { ...query, unitId: unit, userId: id };
  const upstream = await mock(t, (req, res) => {
    if (req.url.startsWith("/api/staff")) { const body = staff(); Object.assign(body.rows[0], { setup_complete: true, password_hash: privateMarker, token, created_at: "2026-09-22" }); return json(res, { ...body, session: privateMarker }); }
    const body = report(filtered); body.rows[0].internal_note = privateMarker; body.staff[0].token = token; return json(res, { ...body, internal_secret: privateMarker });
  });
  const api = new StjwReads(upstream.config);
  assert.deepEqual(await api.staff({}), staff()); assert.deepEqual(await api.report(filtered), report(filtered));
  assert.deepEqual(upstream.requests.map(({ method, path }) => [method, path]), [["GET", "/api/staff"], ["GET", `/api/reports?start=2026-09-22&end=2026-09-23&group=day&unitId=${unit}&userId=${id}`]]);
  assert.ok(upstream.requests.every((request) => request.authorization === `Bearer ${token}`));
});

test("authentication, scope, rate-limit and server errors expose fixed messages only", async (t) => {
  let status = 401;
  const upstream = await mock(t, (_req, res) => json(res, { error: `${token} ${privateMarker}` }, status)); const api = new StjwReads(upstream.config);
  for (const [next, code] of [[401, "UNAUTHENTICATED"], [403, "FORBIDDEN"], [429, "RATE_LIMITED"], [400, "UPSTREAM_REJECTED"], [500, "UNAVAILABLE"]]) { status = next; await rejectsCode(api.staff({}), code); }
});

test("redirects never forward credentials or follow even same-origin locations", async (t) => {
  const destination = await mock(t, (_req, res) => json(res, staff())); let location = destination.origin;
  const upstream = await mock(t, (_req, res) => { res.writeHead(302, { Location: location }); res.end(`${token} ${privateMarker}`); });
  const api = new StjwReads(upstream.config); await rejectsCode(api.staff({}), "REDIRECT_BLOCKED");
  location = "/api/another"; await rejectsCode(api.staff({}), "REDIRECT_BLOCKED");
  assert.equal(destination.requests.length, 0); assert.equal(upstream.requests.length, 2);
});

test("response limits cover declared, streamed and decompressed bytes", async (t) => {
  let mode = "declared";
  const large = Buffer.alloc(limits.responseBytes + 1, " ");
  const upstream = await mock(t, (_req, res) => {
    const headers = { "Content-Type": "application/json" };
    if (mode === "declared") headers["Content-Length"] = large.length;
    if (mode === "gzip") { headers["Content-Encoding"] = "gzip"; const compressed = gzipSync(large); headers["Content-Length"] = compressed.length; res.writeHead(200, headers); return res.end(compressed); }
    res.writeHead(200, headers); res.end(large);
  });
  const api = new StjwReads(upstream.config);
  for (const value of ["declared", "streamed", "gzip"]) { mode = value; await rejectsCode(api.staff({}), "RESPONSE_LIMIT"); }
});

test("invalid UTF-8, JSON, content type, unsafe numbers and schema drift fail closed", async (t) => {
  let mode = "utf8";
  const upstream = await mock(t, (_req, res) => {
    if (mode === "mime") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(privateMarker); }
    if (mode === "utf8") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(Buffer.from([0xc3, 0x28])); }
    if (mode === "json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{invalid" + privateMarker); }
    if (mode === "staff") return json(res, { rows: [{ ...staff().rows[0], role: "superadmin" }] });
    const value = report(); if (mode === "number") value.workMs = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "query") value.query.userId = id;
    json(res, value);
  }); const api = new StjwReads(upstream.config);
  for (const value of ["utf8", "json", "mime", "staff"]) { mode = value; await rejectsCode(api.staff({}), "INVALID_RESPONSE"); }
  for (const value of ["number", "query"]) { mode = value; await rejectsCode(api.report(query), "INVALID_RESPONSE"); }
});

test("valid 120-character unit names pass, while connector array caps return actionable limits", async (t) => {
  let mode = "name";
  const upstream = await mock(t, (_req, res) => {
    if (mode === "directory") return json(res, { rows: Array(2001).fill(staff().rows[0]) });
    const body = report(); body.rows[0].unit_name = "U".repeat(120);
    if (mode === "buckets") body.buckets = Array(1025).fill(body.buckets[0]);
    if (mode === "staff") body.staff = Array(2001).fill(body.staff[0]);
    if (mode === "rows") body.rows = Array(5001).fill(body.rows[0]);
    return json(res, body);
  });
  const api = new StjwReads(upstream.config);
  assert.equal((await api.report(query)).rows[0].unit_name.length, 120);
  for (const value of ["buckets", "staff", "rows"]) { mode = value; await rejectsCode(api.report(query), "RESPONSE_LIMIT"); }
  mode = "directory"; await rejectsCode(api.staff({}), "RESPONSE_LIMIT");
});

test("inclusive range boundaries and DST dates remain source queries with precise durations", async (t) => {
  const upstream = await mock(t, (req, res) => json(res, report(Object.fromEntries(new URL(req.url, "http://test").searchParams))));
  const api = new StjwReads(upstream.config);
  for (const q of [{ start: "2026-03-01", end: "2026-04-01", group: "hour" }, { start: "2026-11-01", end: "2026-11-02", group: "hour" }, { start: "2026-01-01", end: "2027-01-02", group: "year" }, { start: "2028-02-29", end: "2028-02-29", group: "day" }]) {
    const value = await api.report(q); assert.deepEqual(value.query, q); assert.equal(value.rows[0].duration_ms, 3600123); assert.equal(value.rows[0].duration_seconds, 3600.123);
  }
});

test("timeout covers headers and body, cancellation frees the concurrency slot", async (t) => {
  let mode = "headers";
  const upstream = await mock(t, (_req, res) => { if (mode === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"rows":['); } if (mode === "okay") json(res, staff()); });
  const api = new StjwReads(upstream.config, 80);
  await rejectsCode(api.staff({}), "TIMEOUT"); mode = "body"; await rejectsCode(api.staff({}), "TIMEOUT");
  const controller = new AbortController(); const cancelled = api.staff({}, controller.signal); controller.abort(); await rejectsCode(cancelled, "CANCELLED");
  mode = "okay"; assert.deepEqual(await api.staff({}), staff());
});

test("local concurrency and request-rate bounds apply before additional network calls", async (t) => {
  let mode = "wait";
  const upstream = await mock(t, (_req, res) => { if (mode === "okay") json(res, staff()); });
  const api = new StjwReads(upstream.config);
  const controller = new AbortController(); const pending = Array.from({ length: 4 }, () => api.staff({}, controller.signal));
  await rejectsCode(api.staff({}), "BUSY"); controller.abort(); await Promise.all(pending.map((promise) => rejectsCode(promise, "CANCELLED")));
  mode = "okay"; const rateApi = new StjwReads(upstream.config);
  for (let index = 0; index < 60; index++) await rateApi.staff({});
  const before = upstream.requests.length; await rejectsCode(rateApi.staff({}), "RATE_LIMITED"); assert.equal(upstream.requests.length, before);
});

test("spawned MCP stdio negotiates, advertises strict read tools, validates and scrubs upstream errors", { timeout: 20000 }, async (t) => {
  let status = 200;
  const upstream = await mock(t, (req, res) => { if (status !== 200) return json(res, { error: `${token} ${privateMarker}` }, status); return json(res, req.url.startsWith("/api/staff") ? { ...staff(), token } : report()); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../build/index.js", import.meta.url))], stderr: "pipe", env: { STJW_API_ORIGIN: upstream.origin, STJW_API_TOKEN: token, STJW_ALLOW_LOOPBACK_HTTP: "1" } });
  let diagnostics = ""; transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const client = new Client({ name: "stjw-synthetic-protocol-test", version: "1.0.0" }); t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools(); assert.deepEqual(tools.map((tool) => tool.name).sort(), ["stjw_list_staff", "stjw_workforce_report", "stjw_workforce_report_v2"]);
  for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema.type, "object"); }
  const staffResult = await client.callTool({ name: "stjw_list_staff", arguments: {} });
  assert.deepEqual(staffResult.structuredContent, staff()); assert.deepEqual(JSON.parse(staffResult.content[0].text), staff());
  const hours = await client.callTool({ name: "stjw_workforce_report", arguments: query }); assert.deepEqual(hours.structuredContent, report());
  const before = upstream.requests.length;
  for (const args of [{ name: "stjw_list_staff", arguments: { url: "https://untrusted.test" } }, { name: "stjw_workforce_report", arguments: { ...query, end: "2026-02-30" } }, { name: "stjw_delete_staff", arguments: { id } }]) {
    let failed = false; try { const output = await client.callTool(args); failed = output.isError === true; } catch { failed = true; } assert.equal(failed, true);
  }
  assert.equal(upstream.requests.length, before);
  for (const [next, code] of [[401, "UNAUTHENTICATED"], [403, "FORBIDDEN"]]) { status = next; const output = await client.callTool({ name: "stjw_list_staff", arguments: {} }); assert.equal(output.isError, true); assert.equal(output.content[0].text, `${code}: ${messages[code]}`); assert.ok(!JSON.stringify(output).includes(token)); assert.ok(!JSON.stringify(output).includes(privateMarker)); }
  await client.close(); assert.ok(!diagnostics.includes(token)); assert.ok(!diagnostics.includes(privateMarker));
});

test("startup failure emits no stdout or supplied configuration values", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../build/index.js", import.meta.url))], { env: { STJW_API_ORIGIN: `https://${privateMarker}.test/private`, STJW_API_TOKEN: token }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close"); assert.equal(code, 1); assert.equal(stdout, ""); assert.equal(stderr, `CONFIGURATION: ${messages.CONFIGURATION}\n`); assert.ok(!stderr.includes(token)); assert.ok(!stderr.includes(privateMarker));
});
