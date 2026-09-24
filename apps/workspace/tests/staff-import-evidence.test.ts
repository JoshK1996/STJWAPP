import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { connectDatabase, migrate, migrationFiles, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { issueSetup, digest, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { previewStaffImport, applyStaffImport, getStaffImport, getStaffImportSource, listStaffImports, staffImportSourceBudget } from "../server/imports";
import { staffImportColumns, staffImportReceiptSchema, staffImportDetailSchema, staffImportLimits } from "../shared/staff-imports";

let db: Database, app: ReturnType<typeof createApp>, owner: Actor, unitId: string, jobId: string, cookie: string, csrf: string, hash: string;
let legacyPending: string, legacyApplied: string, legacyAppliedHash: string, legacyBefore: Row[];
const origin = "http://localhost:3000", domain = "example.test";
const row = (name = "Synthetic employee", email = randomUUID() + "@" + domain) => ({ name, email, role: "employee" as const, unitIds: [unitId], jobIds: [jobId] });
function csv(values = [row()]) { return "\uFEFF" + staffImportColumns.join(",") + "\r\n" + values.map(value => [value.name, value.email, value.role, value.unitIds.join("|"), value.jobIds.join("|")].map(cell => '"' + cell.replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n"; }
const preview = (text = csv(), options?: { sourceBudgetBytes: number }) => previewStaffImport(db, owner, text, domain, hash, options);
const apply = (value: { id: string; sourceHash: string }) => applyStaffImport(db, owner, value.id, value.sourceHash, domain, hash);
function projected(change: (sql: string, result: Row[]) => Row[]): Database {
  return { ...db, transaction: action => db.transaction(tx => action({ query: async<T extends Row>(sql: string, params?: any[]) => {
    const result = await tx.query<T>(sql, params); return { ...result, rows: change(sql, result.rows) as T[] };
  } })) };
}
before(async () => {
  db = await connectDatabase(); const { directory, files } = await migrationFiles();
  await db.query("CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of files.filter(file => Number(file.slice(0, 3)) < 30)) {
    const source = await readFile(new URL(file, directory), "utf8");
    for (const statement of source.match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await db.query(statement);
    await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [Number(file.slice(0, 3))]);
  }
  await initialize(db, { demo: false, ownerEmail: "synthetic.staff-evidence@example.test" });
  const account = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const job = (await db.query("SELECT id,unit_id FROM jobs WHERE org_id=$1 ORDER BY id LIMIT 1", [account.org_id])).rows[0]; jobId = job.id; unitId = job.unit_id;
  legacyPending = randomUUID(); legacyApplied = randomUUID(); legacyAppliedHash = digest("unretained legacy source");
  // Capture genuine pre-030 rows before upgrading; current auth needs the full current schema.
  await db.query("INSERT INTO import_batches(id,org_id,actor_id,source_hash,rows) VALUES($1,$2,$3,$4,$5)", [legacyPending, account.org_id, account.id, digest("pending original was not retained"), JSON.stringify([row()])]);
  await db.query("INSERT INTO import_batches(id,org_id,actor_id,source_hash,rows,applied_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())", [legacyApplied, account.org_id, account.id, legacyAppliedHash, JSON.stringify([row()])]);
  legacyBefore = (await db.query("SELECT id,org_id,actor_id,source_hash,rows,created_at,applied_at FROM import_batches ORDER BY id")).rows;
  await migrate(db);
  app = createApp(db, { origin, production: false, demo: false, staffDomain: domain });
  const token = await db.transaction(tx => issueSetup(tx, account as { id: string; org_id: string }));
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password: "Synthetic-evidence-" + randomUUID() }); assert.equal(setup.status, 200);
  cookie = String(setup.headers["set-cookie"][0]).split(";")[0]; hash = digest(cookie.slice(cookie.indexOf("=") + 1));
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200); owner = me.body.actor; csrf = owner.csrf!;
});
after(async () => { await db?.close(); });

test("030 retains legacy bytes/status without fabricating original source or receipts", async () => {
  assert.deepEqual((await db.query("SELECT id,org_id,actor_id,source_hash,rows,created_at,applied_at FROM import_batches ORDER BY id")).rows, legacyBefore);
  const applied = await getStaffImport(db, owner, hash, legacyApplied);
  assert.equal(applied.evidenceVersion, 1); assert.equal(applied.receiptState, "legacy_unavailable"); assert.equal(applied.receipt, null); assert.equal(applied.sourceAvailable, false);
  await assert.rejects(applyStaffImport(db, owner, legacyApplied, legacyAppliedHash, domain, hash), (e: any) => e.status === 409 && /no creation receipt/.test(e.message));
  await assert.rejects(getStaffImportSource(db, owner, hash, legacyApplied), (e: any) => e.status === 404);
  const pending = await getStaffImport(db, owner, hash, legacyPending), receipt = await apply(pending);
  assert.equal(receipt.created, 1); assert.deepEqual(await apply(pending), receipt);
  const retained = await getStaffImport(db, owner, hash, legacyPending); assert.equal(retained.sourceAvailable, false); assert.equal(retained.receiptState, "retained");
});

test("new previews retain literal Unicode/BOM/CRLF and genuine credential-free account identities", async () => {
  const values = [row('=Literal café, "name"'), row("Second\nline")], text = csv(values), value = await preview(text);
  staffImportDetailSchema.parse(value); assert.equal(value.sourceHash, digest(text)); assert.equal(value.evidenceVersion, 2);
  const source = await getStaffImportSource(db, owner, hash, value.id); assert.equal(source.csv, text); assert.equal(source.bytes, Buffer.byteLength(text));
  const receipt = staffImportReceiptSchema.parse(await apply(value)); assert.deepEqual(await apply(value), receipt);
  for (const [index, account] of receipt.accounts.entries()) {
    assert.equal(account.row, index + 2);
    const actual = (await db.query("SELECT name,email,password_hash,pin_hash,requires_credential_change FROM users WHERE org_id=$1 AND id=$2", [owner.org_id, account.userId])).rows[0];
    assert.equal(actual.email, values[index].email); assert.equal(actual.name, values[index].name); assert.equal(actual.password_hash, null); assert.equal(actual.pin_hash, null); assert.equal(actual.requires_credential_change, false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM setup_tokens WHERE user_id=$1", [account.userId])).rows[0].n, 0);
  }
  const raw = await request(app).get(`/api/imports/staff/${value.id}/source`).set("Cookie", cookie).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => done(null, Buffer.concat(chunks))); });
  assert.equal(raw.status, 200); assert.equal(raw.headers["x-stjw-source-sha256"], digest(text)); assert.equal(raw.headers["cache-control"], "private, no-store"); assert.match(raw.headers["content-disposition"], /source\.txt/); assert.deepEqual(raw.body, Buffer.from(text));
});

test("source, normalized rows, captured scope and terminal receipts cannot be changed or deleted", async () => {
  const value = await preview();
  for (const update of ["source_hash='" + "a".repeat(64) + "'", "rows='[]'", "created_at=created_at+interval '1 second'", "source_base64=NULL", "evidence_version=1", "actor_id=gen_random_uuid()"])
    await assert.rejects(db.query(`UPDATE import_batches SET ${update} WHERE id=$1`, [value.id]));
  await assert.rejects(db.query("DELETE FROM import_batches WHERE id=$1", [value.id]), /retained/);
  await assert.rejects(db.query("UPDATE import_batches SET applied_at=clock_timestamp() WHERE id=$1", [value.id]), /require a retained receipt/);
  await assert.rejects(db.query("UPDATE import_batches SET applied_at=clock_timestamp(),receipt='{}' WHERE id=$1", [value.id]), /does not match/);
  const receipt = await apply(value);
  await assert.rejects(db.query("UPDATE import_batches SET receipt=receipt WHERE id=$1", [value.id]), /only one/);
  assert.deepEqual(await apply(value), receipt);
});

test("old version-only apply SQL remains valid only for legacy previews and cannot partly create new evidence", async () => {
  const legacyId = randomUUID();
  await db.query("INSERT INTO import_batches(id,org_id,actor_id,source_hash,rows) VALUES($1,$2,$3,$4,$5)", [legacyId, owner.org_id, owner.id, digest("old process"), JSON.stringify([row()])]);
  await db.query("UPDATE import_batches SET applied_at=now() WHERE id=$1", [legacyId]);
  assert.equal((await getStaffImport(db, owner, hash, legacyId)).receiptState, "legacy_unavailable");
  const value = await preview(), proposed = value.rows[0];
  await assert.rejects(db.transaction(async tx => { await createStaff(tx, owner, proposed, domain); await tx.query("UPDATE import_batches SET applied_at=now() WHERE id=$1", [value.id]); }), /require a retained receipt/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE email=$1", [proposed.email])).rows[0].n, 0);
  assert.equal((await getStaffImport(db, owner, hash, value.id)).receiptState, "pending");
});

test("same-batch competition returns one receipt and different batches cannot create duplicate emails", async () => {
  const value = await preview(), before = Number((await db.query("SELECT count(*) AS n FROM users")).rows[0].n);
  const [one, two] = await Promise.all([apply(value), apply(value)]); assert.deepEqual(one, two);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM users")).rows[0].n), before + 1);
  const text = csv(), left = await preview(text), right = await preview(text); await apply(left);
  await assert.rejects(apply(right), (e: any) => e.status === 409 && /already has an account/.test(e.message));
  assert.equal((await getStaffImport(db, owner, hash, right.id)).receiptState, "pending");
});

test("history pages reject changed cohorts and source scope uses fixed evidence rather than mutable jobs", async () => {
  const first = await listStaffImports(db, owner, hash, { limit: "2" }); assert.equal(first.rows.length, 2); assert.ok(first.nextCursor);
  const second = await listStaffImports(db, owner, hash, { limit: "2", cursor: first.nextCursor }); assert.ok(second.rows.every(row => !first.rows.some(other => other.id === row.id)));
  await preview(); await assert.rejects(listStaffImports(db, owner, hash, { limit: "2", cursor: first.nextCursor }), (e: any) => e.status === 409);
  const freshPage = await listStaffImports(db, owner, hash, { limit: "2" }), pending = await preview();
  const beforeApply = await listStaffImports(db, owner, hash, { limit: "2" }); await apply(pending);
  await assert.rejects(listStaffImports(db, owner, hash, { limit: "2", cursor: beforeApply.nextCursor }), (e: any) => e.status === 409);
  await assert.rejects(listStaffImports(db, owner, hash, { limit: "3", cursor: freshPage.nextCursor }), (e: any) => e.status === 409);
});

test("retained source and receipt decoders reject corruption without publishing invented evidence", async () => {
  const value = await preview(), original = await apply(value);
  const changes: Array<(row: Row) => Row> = [r => ({ ...r, source_base64: Buffer.from("different").toString("base64") }), r => ({ ...r, receipt: { ...r.receipt, created: 2 } }), r => ({ ...r, rows: [{ ...r.rows[0], name: "changed" }] })];
  for (const tamper of changes) {
    const source = projected((sql, rows) => sql.startsWith("SELECT b.*") ? rows.map(tamper) : rows);
    await assert.rejects(getStaffImport(source, owner, hash, value.id), (e: any) => e.status === 422);
  }
  assert.deepEqual(await apply(value), original);
});

test("Unicode validation and configurable source capacity use exact serialized-source bytes with no unlimited option", async () => {
  assert.equal(staffImportSourceBudget(String(64 * 1024 * 1024)), staffImportLimits.defaultSourceBudgetBytes);
  for (const invalid of [0, -1, 1048575, 1073741825, Infinity, "", "0", "unlimited", "1e9", "1048576.0", " 1048576", "01048576"])
    assert.throws(() => staffImportSourceBudget(invalid), /must be an integer/);
  assert.equal(staffImportSourceBudget("1048576"), 1048576); assert.equal(staffImportSourceBudget(1073741824), 1073741824);
  await assert.rejects(preview(csv([row("invalid\ud800")])), (e: any) => e.status === 400 && /Unicode/.test(e.message));
  const source = csv(Array.from({ length: 100 }, () => row(" ".repeat(3450) + "Employee")));
  const budget = { sourceBudgetBytes: 1048576 }, before = Number((await db.query("SELECT coalesce(sum(octet_length(source_base64)),0) AS n FROM import_batches WHERE org_id=$1", [owner.org_id])).rows[0].n);
  const saved = await preview(source, budget); await preview(source, budget);
  const used = Number((await db.query("SELECT coalesce(sum(octet_length(source_base64)),0) AS n FROM import_batches WHERE org_id=$1", [owner.org_id])).rows[0].n);
  assert.equal(used - before, Buffer.byteLength(Buffer.from(source).toString("base64"), "ascii") * 2);
  const count = Number((await db.query("SELECT count(*) AS n FROM import_batches")).rows[0].n);
  await assert.rejects(preview(source, budget), (e: any) => e.status === 409 && /budget is full/.test(e.message));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM import_batches")).rows[0].n), count);
  assert.equal((await getStaffImportSource(db, owner, hash, saved.id)).csv, source);
});

test("quota namespace precedes actor locks and apply/history never acquire it", async () => {
  const traces: string[][] = [], instrumented: Database = { ...db, transaction: action => db.transaction(tx => {
    const trace: string[] = []; traces.push(trace);
    return action({ query: async<T extends Row>(sql: string, params?: any[]) => { trace.push(sql + " " + (sql.includes("advisory") ? params?.[0] : "")); return tx.query<T>(sql, params); } });
  }) };
  const value = await previewStaffImport(instrumented, owner, csv(), domain, hash);
  const first = traces[0], quota = first.findIndex(sql => sql.includes("staff-import-source:")), actor = first.findIndex(sql => /FROM users.*FOR SHARE/.test(sql)); assert.ok(quota >= 0 && actor > quota);
  await applyStaffImport(instrumented, owner, value.id, value.sourceHash, domain, hash); await listStaffImports(instrumented, owner, hash, {});
  assert.ok(traces.slice(1).every(trace => trace.every(sql => !sql.includes("staff-import-source:"))));
});
