import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { buildPersonPlan, personTemplateRows } from "../server/person-imports";
import { schoolImportCatalog, personImportRowSchema } from "../shared/school-imports";
import { applySchoolImport, previewSchoolImport } from "../server/school-imports";
import { parse } from "csv-parse/sync";

// Synthetic PGlite. All authenticated proofs come from normal HTTP setup/login.
// JavaScript transaction gates and injected lock errors are not real PG waits.
const origin = "http://localhost:3197";
type Auth = { cookie: string; csrf: string; hash: string };
let db: Database, owner: Actor, auth: Auth, unitId: string, otherUnit: string;
const app = (database = db) => createApp(database, { origin, production: false, demo: false, staffDomain: "stjw.org" });
function get(path: string, proof = auth, database = db) {
  return request(app(database)).get("/api" + path).set("Cookie", proof.cookie);
}
function send(path: string, body: unknown, proof = auth, database = db, method: "post" | "patch" = "post") {
  return request(app(database))[method]("/api" + path).set("Cookie", proof.cookie)
    .set("Origin", origin).set("X-CSRF-Token", proof.csrf).send(body as object);
}
async function login(email: string, password: string) {
  const response = await request(app()).post("/api/auth/login").set("Origin", origin).send({ email, credential: password, mode: "password" });
  assert.equal(response.status, 200);
  const cookie = (response.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const me = await request(app()).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { cookie, csrf: me.body.actor.csrf as string, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
}
async function employee(role = "employee", units = [unitId], office = true) {
  const email = randomUUID() + "@stjw.org", password = "Synthetic-" + randomUUID();
  const made = await send("/staff", { name: "Synthetic profile reviewer", email, role, unitIds: units, jobIds: [] });
  assert.equal(made.status, 201);
  const setup = await request(app()).post("/api/auth/setup").set("Origin", origin)
    .send({ token: new URL(made.body.setupUrl).hash.slice(7), password }); assert.equal(setup.status, 200);
  if (office) assert.equal((await send("/school/office-grants", { unitId, userId: made.body.id, enabled: true })).status, 200);
  return { id: made.body.id as string, email, password, auth: await login(email, password) };
}
// Encode ordinary literal CSV input, not the spreadsheet-protected export path.
const csv = (rows: Record<string, unknown>[], columns = schoolImportCatalog.people.columns) =>
  "\uFEFF" + columns.join(",") + "\r\n" + rows.map(row => columns.map(key => '"' + String(row[key] ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
const fresh = (fields: Record<string, unknown> = {}) => ({ personId: "", version: "0", name: "Synthetic person", emailAction: "clear", email: "", phoneAction: "clear", phone: "", ...fields });
const edit = (person: Row, fields: Record<string, unknown> = {}) => fresh({ personId: person.id, version: String(person.version), name: person.name, emailAction: "keep", phoneAction: "keep", ...fields });
const body = (preview: any) => ({ sourceHash: preview.sourceHash, planHash: preview.planHash, reviewed: true });
async function preview(rows: Record<string, unknown>[], proof = auth, targetUnit = unitId, database = db) {
  const response = await send("/school/imports/preview", { context: { kind: "people", unitId: targetUnit }, csv: csv(rows) }, proof, database);
  assert.equal(response.status, 201, response.body.error); return response.body;
}
async function apply(p: any, proof = auth, database = db, status = 200) {
  const response = await send(`/school/imports/${p.id}/apply`, body(p), proof, database);
  assert.equal(response.status, status, response.body.error); return response.body;
}
async function person(fields: Record<string, unknown> = {}) {
  const response = await send("/school/people", { unitId, name: "Synthetic person " + randomUUID().slice(0, 8), email: "person@example.test", phone: "+15550101", ...fields });
  assert.equal(response.status, 201, response.body.error); return response.body as Row;
}
async function stored(id: string) { return (await db.query("SELECT id,unit_id,name,email,phone,version,date_of_birth FROM school_people WHERE id=$1 AND org_id=$2", [id, owner.org_id])).rows[0]; }
async function state() {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM school_people WHERE org_id=$1) AS people,
    (SELECT count(*)::int FROM school_history WHERE org_id=$1) AS history,
    (SELECT count(*)::int FROM audit_events WHERE org_id=$1) AS audits,
    (SELECT count(*)::int FROM school_import_batches WHERE org_id=$1) AS batches,
    (SELECT count(*)::int FROM school_import_batches WHERE org_id=$1 AND applied_at IS NOT NULL) AS applied`, [owner.org_id])).rows[0];
}
function gateBefore(action: () => Promise<void>) {
  let hit = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    if (!hit) { hit = true; await action(); } return db.transaction(fn);
  } };
  return { database, observed: () => hit };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "person.import.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: "owner", unit_ids: [], mode: "password" };
  [unitId, otherUnit] = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(row => row.id as string);
  const password = "Synthetic-" + randomUUID(), token = await db.transaction(tx => issueSetup(tx, owner));
  const setup = await request(app()).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  auth = await login(owner.email, password);
});
after(async () => { await db?.close(); });

test("person CSV creates exact profiles with byte-preserved source, changed-row receipts and idempotent replay", async () => {
  const rows = [fresh({ name: 'Synthetic Zoë "Example"', emailAction: "replace", email: "Case.Keep@example.test", phoneAction: "replace", phone: "+44 1234" }), fresh({ name: "Synthetic second\nline" })];
  const source = csv(rows), p = await preview(rows);
  assert.deepEqual(p.plan.counts, { total: 2, create: 2, update: 0, unchanged: 0, errors: 0 });
  assert.equal(p.sourceHash, digest(source)); assert.equal(p.hasSource, true); assert.equal("originalSource" in p.plan, false);
  const downloaded = await get(`/school/imports/${p.id}/source`).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => done(null, Buffer.concat(chunks)));
  }); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, Buffer.from(source));
  const result = await apply(p), beforeRetry = await state(); assert.deepEqual((await apply(p)).receipt, result.receipt); assert.deepEqual(await state(), beforeRetry);
  assert.equal(result.receipt.records.length, 2);
  for (const [index, record] of result.receipt.records.entries()) {
    assert.deepEqual(Object.keys(record).sort(), ["personId", "row", "version"]); assert.equal(record.row, index + 2); assert.equal(record.version, 1);
    assert.equal((await stored(record.personId)).name, rows[index].name);
  }
  const first = await stored(result.receipt.records[0].personId); assert.equal(first.email, "Case.Keep@example.test"); assert.equal(first.phone, "+44 1234");
  const ids = result.receipt.records.map((record: any) => record.personId);
  for (const table of ["household_members", "student_contacts", "students"])
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE person_id=ANY($1::uuid[])`, [ids])).rows[0].n, 0);
  await assert.rejects(db.query("UPDATE school_import_batches SET plan='{}' WHERE id=$1", [p.id]), /immutable|receipt/);
});

test("keep/replace/clear update only chosen profile fields; unchanged rows create no version/history mutations", async () => {
  const a = await person(), b = await person(), before = await state();
  const p = await preview([edit(a, { name: "Synthetic changed", emailAction: "clear", phoneAction: "replace", phone: "  +15550999  " }), edit(b)]);
  assert.deepEqual(p.plan.counts, { total: 2, create: 0, update: 1, unchanged: 1, errors: 0 });
  const r = await apply(p); assert.deepEqual(r.receipt.records, [{ row: 2, personId: a.id, version: 2 }]);
  const changed = await stored(a.id); assert.equal(changed.email, ""); assert.equal(changed.phone, "+15550999"); assert.equal(changed.date_of_birth, null);
  assert.deepEqual(await stored(b.id), { id: b.id, unit_id: b.unit_id, name: b.name, email: b.email, phone: b.phone, version: b.version, date_of_birth: null });
  assert.equal((await state()).history - before.history, 1);
  const noops = await preview([edit(changed)]), beforeNoop = await state(); const noopResult = await apply(noops);
  assert.deepEqual(noopResult.receipt.records, []); assert.equal((await state()).history, beforeNoop.history); assert.equal((await stored(a.id)).version, 2);
});

test("field actions, ID/version combinations and complete domain validation reject whole batches", async () => {
  const existing = await person();
  const bad = [fresh({ version: "1" }), fresh({ emailAction: "keep" }), fresh({ phoneAction: "keep" }),
    fresh({ emailAction: "replace", email: "" }), fresh({ phoneAction: "replace", phone: "  " }), fresh({ email: "hidden@example.test" }),
    fresh({ emailAction: "replace", email: " space@example.test" }), fresh({ phoneAction: "replace", phone: "x".repeat(41) }),
    fresh({ name: " ", phoneAction: "clear" }), fresh({ name: "x".repeat(121) }),
    edit(existing, { version: "0", phone: "+1" })];
  const p = await preview(bad); assert.equal(p.plan.counts.errors, bad.length); const before = await state(); await apply(p, auth, db, 409); assert.deepEqual(await state(), before);
  assert.equal(personImportRowSchema.safeParse({ ...fresh(), role: "guardian" }).success, false);
  assert.equal(personImportRowSchema.safeParse(fresh({ version: "01" })).success, false);
  const extra = await send("/school/imports/preview", { context: { kind: "people", unitId }, csv: csv([fresh({ canPickup: "true" })], [...schoolImportCatalog.people.columns, "canPickup"]) });
  assert.equal(extra.status, 400);
});

test("exact identities reject missing, foreign-unit, student and pending-applicant people without guessing adulthood", async () => {
  const childResponse = await send("/school/students", { unitId, name: "Synthetic student", studentNumber: "P-" + randomUUID() }); assert.equal(childResponse.status, 201);
  const child = childResponse.body;
  const year = await send("/school/years", { unitId, name: "Synthetic import year", startsOn: "2026-08-01", endsOn: "2027-07-31" }); assert.equal(year.status, 201);
  const primary = await person();
  const application = await send("/school/admissions", { unitId, yearId: year.body.id, commandId: randomUUID(), name: "Synthetic applicant", gradeLevel: "K", primaryContactId: primary.id });
  assert.equal(application.status, 201, application.body.error);
  const applicant = await stored(application.body.applicant_id), foreign = await person({ unitId: otherUnit }), ordinary = await person();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM students WHERE person_id=$1", [applicant.id])).rows[0].n, 0);
  const studentPerson = await stored(child.person_id);
  const p = await preview([edit(studentPerson), edit(applicant), edit(foreign), edit({ id: randomUUID(), version: 1, name: "Unknown" }), edit(primary)]);
  assert.equal(p.plan.counts.errors, 4); assert.equal(p.plan.counts.unchanged, 1);
  assert.equal(p.plan.rows[0].source.studentLinked, true); assert.equal(p.plan.rows[1].source.applicantLinked, true);
  assert.equal(p.plan.rows[2].source, null); assert.equal(p.plan.rows[2].before, null);
  const duplicates = await preview([edit(ordinary), edit(ordinary, { personId: ordinary.id.toUpperCase() })]); assert.equal(duplicates.plan.counts.errors, 2);
  const sameNames = await preview([fresh({ name: ordinary.name, emailAction: "replace", email: ordinary.email }), fresh({ name: ordinary.name, emailAction: "replace", email: ordinary.email })]);
  const result = await apply(sameNames); assert.equal(new Set(result.receipt.records.map((r: any) => r.personId)).size, 2); assert.notEqual(result.receipt.records[0].personId, ordinary.id);
  const template = await get(`/school/imports/template/people?unitId=${unitId}&populated=true`); assert.equal(template.status, 200);
  const ids = new Set(parse(template.text, { bom: true, columns: true, skip_empty_lines: true }).map((r: any) => r.personId));
  assert.ok(ids.has(primary.id)); for (const id of [studentPerson.id, applicant.id, foreign.id]) assert.equal(ids.has(id), false);
});

test("protected CSV exports round-trip exact current text at field limits without unescaping new or changed literals", async () => {
  const original = await person({ name: "=" + "N".repeat(119), phone: "+" + "1".repeat(39), email: "+case@example.test" });
  const template = await get(`/school/imports/template/people?unitId=${unitId}&populated=true`); assert.equal(template.status, 200);
  const p = await send("/school/imports/preview", { context: { kind: "people", unitId }, csv: template.text }); assert.equal(p.status, 201);
  const row = p.body.plan.rows.find((r: any) => r.source?.person.id === original.id); assert.equal(row.action, "unchanged"); assert.equal(row.after.name, original.name); assert.equal(row.after.phone, original.phone); assert.equal(row.after.email, original.email);
  const literal = await preview([fresh({ name: "'=Literal new", phoneAction: "replace", phone: "'+123" }), edit(original, { name: "'=Changed literal", phoneAction: "replace", phone: "'+456" })]);
  assert.equal(literal.plan.counts.errors, 0); const r = await apply(literal);
  assert.equal((await stored(r.receipt.records[0].personId)).name, "'=Literal new"); assert.equal((await stored(original.id)).phone, "'+456");
});

test("source drift invalidates reviewed changes and unchanged rows, while applied receipts retain original evidence", async () => {
  const original = await person(), pending = await preview([edit(original)]);
  assert.equal((await send("/school/people/" + original.id, { version: 1, name: "Synthetic later", email: original.email, phone: original.phone }, auth, db, "patch")).status, 200);
  const before = await state(); await apply(pending, auth, db, 409); assert.deepEqual(await state(), before);
  const current = await stored(original.id), committed = await preview([edit(current, { phoneAction: "clear" })]); const result = await apply(committed);
  assert.equal((await send("/school/people/" + original.id, { version: 3, name: "Synthetic latest", email: "latest@example.test", phone: "+1777" }, auth, db, "patch")).status, 200);
  const later = await state(), replay = await apply(committed); assert.deepEqual(replay.receipt, result.receipt); assert.deepEqual(replay.plan, result.plan); assert.deepEqual(await state(), later);
});

test("profile edits preserve relationship, contact and pickup permissions and invalidate pending family source versions", async () => {
  const adult = await person(), household = await send("/school/households", { unitId, name: "Synthetic household", address: "" }); assert.equal(household.status, 201);
  assert.equal((await send(`/school/households/${household.body.id}/members`, { personId: adult.id, role: "guardian", remove: false })).status, 200);
  const student = await send("/school/students", { unitId, name: "Synthetic child", studentNumber: "LINK-" + randomUUID().slice(0, 30) }); assert.equal(student.status, 201);
  assert.equal((await send(`/school/students/${student.body.id}/contacts`, { personId: adult.id, relationship: "Synthetic contact", isGuardian: false, canCommunicate: true, canPickup: false, pickupUntil: null, emergencyPriority: 1, restrictionNote: "Synthetic restriction" })).status, 200);
  const links = async () => ({ members: (await db.query("SELECT * FROM household_members WHERE person_id=$1 ORDER BY household_id", [adult.id])).rows, contacts: (await db.query("SELECT * FROM student_contacts WHERE person_id=$1 ORDER BY student_id", [adult.id])).rows });
  const before = await links();
  const familyCsv = csv([{ householdId: household.body.id, householdVersion: "1", personId: adult.id, personVersion: "1", role: "other", remove: "false" }], schoolImportCatalog.household_members.columns);
  const family = await send("/school/imports/preview", { context: { kind: "household_members", unitId }, csv: familyCsv }); assert.equal(family.status, 201); assert.equal(family.body.plan.counts.errors, 0);
  await apply(await preview([edit(adult, { name: "Synthetic renamed contact" })])); assert.deepEqual(await links(), before);
  const denied = await send(`/school/imports/${family.body.id}/apply`, body(family.body)); assert.equal(denied.status, 409); assert.deepEqual(await links(), before);
});

test("uppercase UUID inputs preserve canonical identities and complete NOWAIT locks precede mutations", async () => {
  const a = await person(), b = await person(); const p = await preview([edit(b, { personId: b.id.toUpperCase(), name: "Synthetic B" }), edit(a, { personId: a.id.toUpperCase(), name: "Synthetic A" })]);
  assert.equal(p.plan.counts.errors, 0);
  const trace: Array<{ sql: string; params?: unknown[] }> = [];
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async (sql, params) => { trace.push({ sql, params }); return tx.query(sql, params); } })) };
  await apply(p, auth, database);
  const lockIndex = trace.findIndex(item => item.sql.includes("FROM school_people") && item.sql.includes("FOR UPDATE NOWAIT")); assert.ok(lockIndex > 0);
  assert.deepEqual(trace[lockIndex].params?.[2], [a.id, b.id].sort());
  assert.ok(trace.findIndex(item => /UPDATE school_people|INSERT INTO school_people/.test(item.sql)) > lockIndex);
  assert.ok(trace.filter(item => /FROM students|FROM admission_applications/.test(item.sql)).every(item => !/FOR UPDATE|FOR SHARE/.test(item.sql)));
  assert.equal(trace.some(item => /FROM households.*FOR|FROM students.*FOR|FROM admission_applications.*FOR/.test(item.sql)), false);
});

test("a missing target cannot appear through an unlocked post-prelock requery", async () => {
  const absent = randomUUID(), queries: Array<{ sql: string; params?: unknown[] }> = [];
  const tx: Queryable = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  const plan = await buildPersonPlan(tx, owner, { kind: "people", unitId }, [edit({ id: absent, version: 1, name: "Missing" }) as Record<string, string>], true);
  assert.equal(plan.counts.errors, 1); assert.equal(plan.rows[0].source, null);
  assert.equal(queries.length, 3); assert.match(queries[0].sql, /ORDER BY id FOR UPDATE NOWAIT/);
  assert.deepEqual(queries[1].params?.[1], []); assert.deepEqual(queries[2].params?.[1], []);
});

test("NOWAIT conflict rolls back the transaction and returns retryable503 for the same reviewed batch", async () => {
  const original = await person(), p = await preview([edit(original, { name: "Synthetic retry" })]); let observed = false;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async (sql, params) => {
    if (sql.includes("FOR UPDATE NOWAIT")) { observed = true; throw Object.assign(new Error("synthetic lock unavailable"), { code: "55P03" }); }
    return tx.query(sql, params);
  } })) };
  const before = await state(); await apply(p, auth, database, 503); assert.ok(observed); assert.deepEqual(await state(), before);
  const first = await apply(p), second = await apply(p); assert.deepEqual(first.receipt, second.receipt); assert.equal((await stored(original.id)).version, 2);
});

test("real SQL failure after the second person audit rolls back all changed profiles/history/receipt and permits one retry", async () => {
  const existing = await person(), p = await preview([fresh(), edit(existing, { name: "Synthetic atomic change" })]); let audits = 0;
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith("INSERT INTO audit_events") && ["school.person.created", "school.person.updated"].includes(String(params?.[3])) && ++audits === 2) await tx.query("SELECT 1/0");
    return result;
  } })) };
  const before = await state(); await apply(p, auth, database, 500); assert.equal(audits, 2); assert.deepEqual(await state(), before); assert.equal((await stored(existing.id)).version, 1);
  const retained = (await db.query("SELECT applied_at,receipt FROM school_import_batches WHERE id=$1", [p.id])).rows[0]; assert.deepEqual(retained, { applied_at: null, receipt: null });
  assert.equal((await apply(p)).receipt.records.length, 2);
});

test("concurrent local same-batch requests create one set of people and return the identical retained receipt", async () => {
  const p = await preview([fresh(), fresh()]), before = await state(); const [a, b] = await Promise.all([apply(p), apply(p)]);
  assert.deepEqual(a.receipt, b.receipt); assert.equal((await state()).people - before.people, 2); assert.equal((await state()).applied - before.applied, 1);
});

test("normal office authority is exact-unit, author-private and current for every person import branch", async () => {
  const reviewer = await employee(), manager = await employee("manager", [unitId], false);
  const blocked = await send("/school/imports/preview", { context: { kind: "people", unitId }, csv: csv([fresh()]) }, manager.auth); assert.equal(blocked.status, 403);
  const other = await send("/school/imports/preview", { context: { kind: "people", unitId: otherUnit }, csv: csv([fresh()]) }, reviewer.auth); assert.equal(other.status, 403);
  const p = await preview([fresh()], reviewer.auth), committed = await apply(p, reviewer.auth);
  for (const suffix of ["", "/source"]) assert.equal((await get(`/school/imports/${p.id}${suffix}`, auth)).status, 404);
  assert.equal((await send(`/school/imports/${p.id}/apply`, body(p), auth)).status, 404);
  const revoked = gateBefore(async () => { assert.equal((await send("/school/office-grants", { unitId, userId: reviewer.id, enabled: false })).status, 200); });
  await apply(p, reviewer.auth, revoked.database, 403); assert.ok(revoked.observed());
  for (const path of [`/school/imports?unitId=${unitId}`, `/school/imports/${p.id}`, `/school/imports/${p.id}/source`, `/school/imports/template/people?unitId=${unitId}&populated=true`]) assert.equal((await get(path, reviewer.auth)).status, 403);
  assert.equal((await db.query("SELECT receipt FROM school_import_batches WHERE id=$1", [p.id])).rows[0].receipt.records[0].personId, committed.receipt.records[0].personId);
});

test("ordinary logout committed after middleware denies person preview/apply/read/source/template/replay publication", async () => {
  const reviewer = await employee(); let proof = reviewer.auth; const p = await preview([fresh()], proof), applied = await preview([fresh()], proof); await apply(applied, proof);
  for (const [path, payload] of [
    ["/school/imports/preview", { context: { kind: "people", unitId }, csv: csv([fresh()]) }],
    [`/school/imports/${p.id}/apply`, body(p)], [`/school/imports/${applied.id}/apply`, body(applied)],
    [`/school/imports/${p.id}`, undefined], [`/school/imports/${p.id}/source`, undefined],
    [`/school/imports/template/people?unitId=${unitId}`, undefined], [`/school/imports?unitId=${unitId}`, undefined],
  ] as Array<[string, unknown]>) {
    proof = await login(reviewer.email, reviewer.password);
    const gate = gateBefore(async () => { assert.equal((await send("/auth/logout", {}, proof)).status, 200); });
    const before = (await state()).people;
    const response = payload === undefined ? await get(path, proof, gate.database) : await send(path, payload, proof, gate.database);
    assert.equal(response.status, 401); assert.ok(gate.observed()); assert.equal((await state()).people, before);
    assert.equal(response.headers["content-disposition"], undefined);
  }
});

test("new person previews enforce final DB-clock expiry after actual apply audit; applied retries survive expiry", async () => {
  // Accelerated original preview INSERT only. Stored existing evidence is never
  // updated. created/expires both shift together, retaining the24hour interval.
  const database: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async (sql, params) => {
    if (sql.startsWith("INSERT INTO school_import_batches(")) {
      assert.equal(params?.[1], owner.org_id); assert.equal(params?.[2], unitId); assert.equal(params?.[3], owner.id);
      sql = sql.replace("input_rows,plan)", "input_rows,plan,created_at,expires_at)")
        .replace("$8,$9) RETURNING", "$8,$9,transaction_timestamp()-interval '24 hours'+interval '4 seconds',transaction_timestamp()+interval '4 seconds') RETURNING");
    }
    return tx.query(sql, params);
  } })) };
  const p = await preview([fresh()], auth, unitId, database), expires = Date.parse(p.expiresAt); let auditSeen = false;
  const duringApply: Database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.startsWith("INSERT INTO audit_events") && params?.[3] === "school.import.applied") {
      auditSeen = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 80)));
    }
    return result;
  } })) };
  const before = await state(); await apply(p, auth, duringApply, 409); assert.ok(auditSeen); assert.deepEqual(await state(), before);
  assert.deepEqual((await db.query("SELECT applied_at,receipt FROM school_import_batches WHERE id=$1", [p.id])).rows[0], { applied_at: null, receipt: null });
  const q = await preview([fresh()], auth, unitId, database), result = await apply(q); await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(q.expiresAt) - Date.now() + 50)));
  const prior = await state(); assert.deepEqual((await apply(q)).receipt, result.receipt); assert.deepEqual(await state(), prior);
});

test("CSV boundaries and populated-template bounds reject overflow instead of silently truncating profiles", async () => {
  const tooMany = await send("/school/imports/preview", { context: { kind: "people", unitId }, csv: csv(Array.from({ length: 501 }, () => fresh())) }); assert.equal(tooMany.status, 400);
  const oversizedRecord = await send("/school/imports/preview", { context: { kind: "people", unitId }, csv: csv([fresh({ name: "n".repeat(4200) })]) }); assert.equal(oversizedRecord.status, 400);
  // Other unit already contains one normal-API-created foreign profile above.
  const p = await preview(Array.from({ length: 500 }, (_, n) => fresh({ name: "Synthetic bounded profile " + n })), auth, otherUnit);
  assert.equal(p.plan.counts.create, 500); assert.equal((await apply(p)).receipt.records.length, 500);
  const overflow = await get(`/school/imports/template/people?unitId=${otherUnit}&populated=true`); assert.equal(overflow.status, 400); assert.equal(overflow.headers["content-disposition"], undefined);
  const queries: string[] = [], tx: Queryable = { query: async sql => { queries.push(sql); return { rows: [], rowCount: 0 }; } };
  assert.deepEqual(await personTemplateRows(tx, owner, { kind: "people", unitId }), []); assert.match(queries[0], /LIMIT 501/); assert.match(queries[0], /NOT EXISTS.*students/s); assert.match(queries[0], /NOT EXISTS.*admission_applications/s);
});

test("person services reject missing actual proof rather than exposing a direct-call bypass", async () => {
  const p = await preview([fresh()]), before = await state();
  await assert.rejects(previewSchoolImport(db, owner, { context: { kind: "people", unitId }, csv: csv([fresh()]) }), (e: any) => e.status === 401);
  await assert.rejects(applySchoolImport(db, owner, p.id, body(p)), (e: any) => e.status === 401);
  assert.deepEqual(await state(), before);
});
