import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff } from "../server/workforce";
import { digest, opaqueToken, type Actor } from "../server/security";
import { standingPolicyCatalog, changeStandingPolicy, standingPolicyDetail, standingPolicyHistory, standingPolicyVersions, standingPolicyVersion, listStandingPolicies } from "../server/standing-policies";
import { canonicalStandingJson, gradingPolicyEvidenceHash, standingPolicyEvidenceHash } from "../server/standing-policy-provenance";
import { standingPolicyCreateInput, standingPolicyConfirmInput, standingPolicyHistoryInput, standingPolicyLimits, type StandingConfiguration, type StandingPolicyRecord } from "../shared/standing-policies";
import type { GradingPolicy } from "../shared/grading";

let db: Database, owner: Actor, units: string[], auth: Auth;
const origin = "http://localhost:3000", reason = "Explicit synthetic verification only";
type Auth = { hash: string; cookie: string; csrf: string };
const denied = (e: any) => [401, 403, 404].includes(e.status), conflict = (e: any) => e.status === 409;
async function session(actor: Actor, mode = "password"): Promise<Auth> {
  const token = opaqueToken(), csrf = opaqueToken(), hash = digest(token);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [hash, actor.org_id, actor.id, mode, csrf]);
  return { hash, csrf, cookie: "stjw_session=" + token };
}
async function ok(path: string, body: unknown, method = "post") {
  const app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
  const r = await (request(app) as any)[method]("/api" + path).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(body);
  assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body;
}
async function person(role: "owner" | "admin" | "manager" | "finance" | "employee" = "employee", unitIds = [units[0]]) {
  const id = await db.transaction(tx => createStaff(tx, owner, { name: "Synthetic policy staff", email: randomUUID() + "@stjw.org", role, unitIds, jobIds: [] }, "stjw.org"));
  const r = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE id=$1", [id])).rows[0];
  return { id: r.id, org_id: r.org_id, name: r.name, email: r.email, role: r.role, mode: "password", unit_ids: unitIds } as Actor;
}
async function setting(unitId: string, policy: GradingPolicy, confirmed = true) {
  const version = (await db.query("SELECT version FROM grading_settings WHERE unit_id=$1", [unitId])).rows[0]?.version ?? 0;
  return ok("/school/grading/settings", { unitId, policy, confirmed, version, reason }, "put");
}
async function fixture() {
  const unitId = units[0];
  const year = await ok("/school/years", { unitId, name: "Synthetic policy " + randomUUID(), startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const term = await ok("/school/terms", { yearId: year.id, name: "Synthetic term", startsOn: "2026-01-01", endsOn: "2026-06-30" });
  const course = await ok("/school/courses", { unitId, code: randomUUID().slice(0, 8), title: "Synthetic course", description: "" });
  const section = await ok("/school/sections", { unitId, yearId: year.id, courseId: course.id, name: "Synthetic class", teacherIds: [], capacity: 20, homeroom: false });
  const grading: GradingPolicy = { name: "Synthetic explicit grading example", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest", categories: [{ id: randomUUID(), name: "Example", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] };
  await setting(unitId, grading);
  const scope = { unitId, yearId: year.id }, catalog = await standingPolicyCatalog(db, owner, auth.hash, scope), pair = catalog.gradingPolicies[0];
  const configuration: StandingConfiguration = { name: "Synthetic standing example", termIds: [term.id], gradeLevels: ["Explicit synthetic grade"], courseRules: [{ courseId: course.id, disposition: "include", required: true, reason }], minimumIncludedCourses: 1, missingWork: "disqualify", basis: "awarded_label", acceptedGradingPolicies: [{ hash: pair.hash, version: pair.version, allowedLabels: ["A"] }] };
  const input = { ...scope, catalogHash: catalog.catalogHash, configuration, reason, commandId: randomUUID() };
  return { scope, year, term, course, section, grading, catalog, input };
}
const confirmInput = (p: StandingPolicyRecord) => ({ expectedVersion: p.version, draftHash: p.draftHash, catalogHash: p.catalogHash, sourceDescription: "Owner reviewed synthetic configuration only", reason, reviewed: true as const, commandId: randomUUID() });
const updateInput = (p: StandingPolicyRecord, extra = {}) => ({ expectedVersion: p.version, catalogHash: p.catalogHash, configuration: p.configuration, reason, commandId: randomUUID(), ...extra });
async function release(f: Awaited<ReturnType<typeof fixture>>) {
  const student = await ok("/school/students", { unitId: f.scope.unitId, name: "Synthetic evidence student", studentNumber: randomUUID() });
  await ok("/school/students/" + student.id + "/enrollments", { enrollment: { yearId: f.year.id, gradeLevel: "Synthetic", startsOn: "2026-01-01", endsOn: "2026-12-31", status: "enrolled" } });
  await ok("/school/sections/" + f.section.id + "/roster", { studentId: student.id, startsOn: "2026-01-01", endsOn: "2026-06-30" });
  const book = await ok("/school/gradebooks", { sectionId: f.section.id, termId: f.term.id });
  const assignment = await ok("/school/grade-assignments", { bookId: book.id, bookVersion: book.version, commandId: randomUUID(), title: "Synthetic reviewed assignment", instructions: "", categoryId: f.grading.categories[0].id, dueOn: "2026-02-01", maxPointsUnits: 10000 });
  let current = (await db.query("SELECT version FROM gradebooks WHERE id=$1", [book.id])).rows[0].version;
  await ok("/school/grade-assignments/" + assignment.id + "/scores", { version: assignment.version, bookVersion: current, scores: [{ studentId: student.id, status: "scored", pointsUnits: 9500, note: "Synthetic review result" }], reason }, "put");
  current = (await db.query("SELECT version FROM gradebooks WHERE id=$1", [book.id])).rows[0].version;
  await ok("/school/gradebooks/" + book.id + "/review", { version: current, action: "submit", acknowledgeMissing: true, acknowledgeNoGrade: true, reason });
  current = (await db.query("SELECT version FROM gradebooks WHERE id=$1", [book.id])).rows[0].version;
  await ok("/school/gradebooks/" + book.id + "/review", { version: current, action: "lock", acknowledgeMissing: true, acknowledgeNoGrade: true, reason });
  return (await db.query("SELECT id FROM gradebook_releases WHERE book_id=$1", [book.id])).rows[0].id;
}
function wrapped(handler: (tx: Queryable, sql: string, params?: any[]) => Promise<void>) {
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { await handler(tx, sql, params); return tx.query<R>(sql, params); } })) } as Database;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "policy.owner@example.test" });
  const r = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(r => r.id);
  owner = { id: r.id, org_id: r.org_id, name: r.name, email: r.email, role: r.role, mode: "password", unit_ids: units } as Actor; auth = await session(owner);
});
after(async () => { await db?.close(); });

test("configuration requires explicit choices and strict server-owned identity boundaries", async () => {
  const f = await fixture(); assert.ok(standingPolicyCreateInput.safeParse(f.input).success);
  for (const change of [{ orgId: owner.org_id }, { actorId: owner.id }, { configuration: { ...f.input.configuration, version: 1 } }, { configuration: { ...f.input.configuration, missingWork: undefined } }, { configuration: { ...f.input.configuration, courseRules: [{ courseId: f.course.id, disposition: "include", reason }] } }, { configuration: { ...f.input.configuration, termIds: [f.term.id, f.term.id] } }]) assert.equal(standingPolicyCreateInput.safeParse({ ...f.input, ...change }).success, false);
  const p = (await changeStandingPolicy(db, owner, auth.hash, "create", f.input)).policy;
  for (const change of [{ reviewed: false }, { reviewed: undefined }, { sourceDescription: "" }, { expectedVersion: "1" }, { reason: "" }]) assert.equal(standingPolicyConfirmInput.safeParse({ ...confirmInput(p), ...change }).success, false);
});

test("canonical evidence hashes preserve actual captured values and array order", async () => {
  const f = await fixture(), reversed = Object.fromEntries(Object.entries(f.grading).reverse());
  assert.equal(gradingPolicyEvidenceHash(f.grading), gradingPolicyEvidenceHash(reversed));
  assert.notEqual(gradingPolicyEvidenceHash(f.grading), gradingPolicyEvidenceHash({ ...f.grading, name: " " + f.grading.name + " " }));
  assert.notEqual(canonicalStandingJson([1, 2]), canonicalStandingJson([2, 1]));
  for (const value of [undefined, NaN, new Date(), { secret: undefined }]) assert.throws(() => canonicalStandingJson(value));
  assert.throws(() => gradingPolicyEvidenceHash({ ...f.grading, imaginary: true }));
});

test("draft confirmation retains immutable full configuration, provenance and private evidence", async () => {
  const f = await fixture(), created = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  const c = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(created.policy), created.policy.id);
  assert.equal(c.policy.version, 2); assert.equal(c.confirmed!.version, 1); assert.equal(c.policy.hasUnconfirmedChanges, false);
  assert.equal(c.confirmed!.policyHash, standingPolicyEvidenceHash(c.confirmed!.policy));
  const edited = await changeStandingPolicy(db, owner, auth.hash, "update", updateInput(c.policy, { configuration: { ...c.policy.configuration, name: "Changed synthetic policy" } }), c.policy.id);
  assert.equal(edited.policy.hasUnconfirmedChanges, true); assert.equal(edited.policy.activePolicyVersionId, c.confirmed!.policyVersionId);
  assert.deepEqual(await standingPolicyVersion(db, owner, auth.hash, c.policy.id, c.confirmed!.policyVersionId), c.confirmed);
  const history = await standingPolicyHistory(db, owner, auth.hash, c.policy.id);
  assert.deepEqual(history.rows.map(r => r.action), ["updated", "confirmed", "created"]);
  assert.deepEqual(history.rows[0].before, c.policy); assert.deepEqual(history.rows[2].after, created.policy);
  const audits = (await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [c.policy.id])).rows;
  assert.equal(audits.length, 3); for (const r of audits) assert.ok(!JSON.stringify(r.detail).includes(reason) && !JSON.stringify(r.detail).includes("configuration"));
  const list = await listStandingPolicies(db, owner, auth.hash, f.scope); assert.equal(list.rows[0].id, c.policy.id);
});

test("fabricated grading pairs, labels and cross-scope identities are rejected", async () => {
  const f = await fixture(), cfg = f.input.configuration;
  for (const configuration of [
    { ...cfg, termIds: [randomUUID()] }, { ...cfg, courseRules: [{ courseId: randomUUID(), disposition: "exclude", reason }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], hash: "0".repeat(64) }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], version: 99999 }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], allowedLabels: ["Made up label"] }] },
  ]) await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "create", { ...f.input, configuration, commandId: randomUUID() }), (e: any) => e.status === 422);
  await assert.rejects(standingPolicyCatalog(db, owner, auth.hash, { ...f.scope, unitId: units[1] }), (e: any) => e.status === 404);
  await setting(f.scope.unitId, f.grading, false);
  assert.equal((await standingPolicyCatalog(db, owner, auth.hash, f.scope)).gradingPolicies.length, 0);
});

test("same-pair reviewed release does not stale the catalog or replace originally reviewed provenance", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  const releaseId = await release(f), catalog = await standingPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(catalog.catalogHash, f.catalog.catalogHash);
  assert.ok(catalog.gradingPolicies[0].provenance.some(p => p.kind === "reviewed_release" && p.releaseId === releaseId));
  const done = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  assert.deepEqual(done.confirmed!.evidence, draft.policy.evidence);
  assert.equal(done.confirmed!.evidence.gradingPolicies[0].provenance.length, 1);
  await setting(f.scope.unitId, { ...f.grading, name: "Replacement synthetic grading" });
  const updated = await standingPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(updated.gradingPolicies.length, 2); assert.ok(updated.gradingPolicies.some(r => r.hash === f.catalog.gradingPolicies[0].hash));
  const original = await standingPolicyVersion(db, owner, auth.hash, draft.policy.id, done.confirmed!.policyVersionId); assert.deepEqual(original, done.confirmed);
});

test("source changes force explicit refreshed draft and current hash review", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  await setting(f.scope.unitId, { ...f.grading, decimals: 1 });
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id), conflict);
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "update", updateInput(draft.policy), draft.policy.id), conflict);
  const catalog = await standingPolicyCatalog(db, owner, auth.hash, f.scope), ref = catalog.gradingPolicies[0];
  const configuration = { ...draft.policy.configuration, acceptedGradingPolicies: [{ hash: ref.hash, version: ref.version, allowedLabels: ["A"] }] };
  const revised = await changeStandingPolicy(db, owner, auth.hash, "update", updateInput(draft.policy, { catalogHash: catalog.catalogHash, configuration }), draft.policy.id);
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "confirm", { ...confirmInput(revised.policy), draftHash: draft.policy.draftHash }, revised.policy.id), conflict);
  assert.equal((await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(revised.policy), revised.policy.id)).confirmed!.version, 1);
});

test("idempotent receipts survive later edits and catalog changes but remain private under current access", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input), input = confirmInput(draft.policy);
  const done = await changeStandingPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id);
  await changeStandingPolicy(db, owner, auth.hash, "update", updateInput(done.policy, { configuration: { ...done.policy.configuration, name: "Later revision" } }), draft.policy.id);
  await setting(f.scope.unitId, { ...f.grading, decimals: 0 });
  assert.deepEqual(await changeStandingPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id), done);
  assert.deepEqual(await changeStandingPolicy(db, owner, auth.hash, "create", f.input), draft);
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "confirm", { ...input, reason: "Different command meaning" }, draft.policy.id), conflict);
  await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.id]);
  try { await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id), denied); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
});

test("current office and explicit unit access are mandatory for every read, mutation and receipt", async () => {
  const f = await fixture(), office = await person(), a = await session(office);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: true });
  const draft = await changeStandingPolicy(db, office, a.hash, "create", f.input);
  assert.equal((await standingPolicyDetail(db, office, a.hash, draft.policy.id)).allowedActions.confirm, false);
  await assert.rejects(changeStandingPolicy(db, { ...office, role: "owner" }, a.hash, "confirm", confirmInput(draft.policy), draft.policy.id), denied);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: false });
  for (const run of [() => standingPolicyDetail(db, office, a.hash, draft.policy.id), () => standingPolicyHistory(db, office, a.hash, draft.policy.id), () => changeStandingPolicy(db, office, a.hash, "create", f.input), () => standingPolicyCatalog(db, office, a.hash, f.scope)]) await assert.rejects(run(), denied);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: true });
  await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [office.id, f.scope.unitId]);
  await assert.rejects(standingPolicyDetail(db, office, a.hash, draft.policy.id), denied);
  const finance = await person("finance"), fin = await session(finance); await assert.rejects(listStandingPolicies(db, finance, fin.hash, f.scope), denied);
});

test("password proof is required even for supplied owner; expiry and inactive accounts block reads", async () => {
  const f = await fixture(), user = await person("admin"), a = await session(user), pin = await session(user, "pin");
  for (const h of [undefined, "0".repeat(64), pin.hash]) await assert.rejects(standingPolicyCatalog(db, user, h, f.scope), denied);
  await assert.rejects(standingPolicyCatalog(db, { ...user, mode: "pin" }, a.hash, f.scope), denied);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [a.hash]);
  await assert.rejects(standingPolicyCatalog(db, user, a.hash, f.scope), denied);
  const fresh = await session(user); await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  await assert.rejects(standingPolicyCatalog(db, user, fresh.hash, f.scope), denied);
});

test("competing confirm, edit and archive use one expected version without losing evidence", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  const results = await Promise.allSettled([
    changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id),
    changeStandingPolicy(db, owner, auth.hash, "update", updateInput(draft.policy, { configuration: { ...draft.policy.configuration, name: "Competing change" } }), draft.policy.id),
    changeStandingPolicy(db, owner, auth.hash, "archive", { expectedVersion: draft.policy.version, archived: true, commandId: randomUUID(), reason }, draft.policy.id),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(conflict(r.reason));
  assert.equal((await standingPolicyHistory(db, owner, auth.hash, draft.policy.id)).rows.length, 2);
});

test("archive and restore retain the current confirmed pointer and immutable versions", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input), done = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  const archived = await changeStandingPolicy(db, owner, auth.hash, "archive", { expectedVersion: done.policy.version, archived: true, reason, commandId: randomUUID() }, draft.policy.id);
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "update", updateInput(archived.policy), draft.policy.id), conflict);
  await assert.rejects(changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(archived.policy), draft.policy.id), conflict);
  assert.deepEqual((await standingPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows, [done.confirmed]);
  const restored = await changeStandingPolicy(db, owner, auth.hash, "archive", { expectedVersion: archived.policy.version, archived: false, reason, commandId: randomUUID() }, draft.policy.id);
  assert.equal(restored.policy.activePolicyVersionId, done.confirmed!.policyVersionId); assert.equal(restored.policy.confirmedVersion, 1);
});

test("audit failure and final session expiry roll back policy, immutable evidence and receipt together", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input), input = confirmInput(draft.policy);
  const failed = wrapped(async (_tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) throw new Error("synthetic audit failure"); });
  await assert.rejects(changeStandingPolicy(failed, owner, auth.hash, "confirm", input, draft.policy.id), /synthetic audit failure/);
  const expiring = wrapped(async (tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) await tx.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [auth.hash]); });
  await assert.rejects(changeStandingPolicy(expiring, owner, auth.hash, "confirm", input, draft.policy.id), denied);
  assert.equal((await standingPolicyDetail(db, owner, auth.hash, draft.policy.id)).policy.version, 1);
  assert.equal((await standingPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows.length, 0);
  assert.equal((await db.query("SELECT command_id FROM standing_policy_commands WHERE command_id=$1", [input.commandId])).rows.length, 0);
});

test("source identity validation uses the existing settings mutex and academic-first authority order", async () => {
  const f = await fixture(), statements: Array<{ sql: string; params?: any[] }> = [];
  const tracked = wrapped(async (_tx, sql, params) => { statements.push({ sql, params }); });
  await changeStandingPolicy(tracked, owner, auth.hash, "create", f.input);
  assert.equal(statements[0].sql, "SET LOCAL statement_timeout = '15s'");
  assert.equal(statements[1].sql, "SET LOCAL lock_timeout = '5s'");
  const index = (part: string) => statements.findIndex(s => s.sql.includes(part));
  assert.ok(index("timetable:") === -1); // Mutex identity is parameterized, never interpolated.
  const academic = statements.findIndex(s => s.params?.some(p => typeof p === "string" && p.startsWith("academic-timetable:")));
  assert.ok(academic >= 0 && academic < index("SELECT id,org_id,name,email,role,active FROM users"));
  const mutex = statements.find(s => s.params?.[0] === "grading-settings:" + f.scope.unitId)!;
  assert.equal(mutex.sql, "SELECT pg_advisory_xact_lock(hashtext($1))");
  assert.ok(index("FROM organizations") < index("FROM units WHERE org_id=$1 AND id=$2 FOR SHARE"));
  assert.ok(statements.at(-1)!.sql.includes("s.expires_at>clock_timestamp()"));
});

test("validated command is copied before awaits and immutable tables reject mutation/deletion", async () => {
  const f = await fixture(), raw = structuredClone(f.input), pending = changeStandingPolicy(db, owner, auth.hash, "create", raw);
  raw.configuration.name = "Mutated after invocation"; raw.configuration.courseRules.length = 0;
  const draft = await pending; assert.equal(draft.policy.configuration.name, f.input.configuration.name); assert.equal(draft.policy.configuration.courseRules.length, 1);
  const done = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  for (const table of ["standing_policy_versions", "standing_policy_history", "standing_policy_commands"])
    for (const action of ["DELETE FROM " + table + " WHERE policy_id=$1", "UPDATE " + table + " SET org_id=org_id WHERE policy_id=$1"]) await assert.rejects(db.query(action, [draft.policy.id]), /append-only/i);
  await assert.rejects(db.query("DELETE FROM standing_policies WHERE id=$1", [draft.policy.id]), /cannot be deleted/);
  await assert.rejects(db.query("UPDATE standing_policies SET version=version+1,unit_id=$2 WHERE id=$1", [draft.policy.id, units[1]]), /identity is immutable/);
  assert.equal((await standingPolicyDetail(db, owner, auth.hash, draft.policy.id)).confirmed!.policyVersionId, done.confirmed!.policyVersionId);
});

test("recorded-percentage configuration stores exact strings without adding thresholds or annual rules", async () => {
  const f = await fixture(), { basis: _b, acceptedGradingPolicies: refs, ...common } = f.input.configuration;
  const configuration = { ...common, basis: "recorded_percentage", acceptedGradingPolicies: refs.map(({ hash, version }) => ({ hash, version })), perCourseMinimum: "89.99", meanCondition: { kind: "equal_weight", minimum: "90.00" } };
  const draft = await changeStandingPolicy(db, owner, auth.hash, "create", { ...f.input, configuration });
  const done = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  assert.equal(done.confirmed!.policy.basis, "recorded_percentage");
  if (done.confirmed!.policy.basis === "recorded_percentage") { assert.equal(done.confirmed!.policy.perCourseMinimum, "89.99"); assert.deepEqual(done.confirmed!.policy.meanCondition, { kind: "equal_weight", minimum: "90.00" }); }
});

test("enabled authenticator requires current verified password session on policy reads and receipts", async () => {
  const f = await fixture(), user = await person("admin"), a = await session(user);
  const draft = await changeStandingPolicy(db, user, a.hash, "create", f.input);
  // Synthetic factor metadata only. No real secret or authenticator enrollment.
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic-unused-digest',now(),now())", [user.id, user.org_id, randomUUID()]);
  await assert.rejects(standingPolicyDetail(db, user, a.hash, draft.policy.id), denied);
  await assert.rejects(changeStandingPolicy(db, user, a.hash, "create", f.input), denied);
  await db.query("UPDATE sessions SET mfa_verified=true WHERE token_hash=$1", [a.hash]);
  assert.deepEqual(await changeStandingPolicy(db, user, a.hash, "create", f.input), draft);
});

test("historical confirmations remain readable after their current-only catalog pair disappears", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input), done = await changeStandingPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  await setting(f.scope.unitId, { ...f.grading, name: "New synthetic catalog with no prior releases" });
  const catalog = await standingPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.ok(!catalog.gradingPolicies.some(r => r.hash === f.catalog.gradingPolicies[0].hash));
  assert.deepEqual((await standingPolicyDetail(db, owner, auth.hash, draft.policy.id)).confirmed, done.confirmed);
  assert.deepEqual((await standingPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows, [done.confirmed]);
  assert.equal((await standingPolicyHistory(db, owner, auth.hash, draft.policy.id)).rows.length, 2);
});

test("archived identities remain explicitly labeled historical configuration, with exact cross-unit year FK", async () => {
  const f = await fixture();
  await db.query("UPDATE school_years SET archived=true,version=version+1 WHERE id=$1", [f.year.id]);
  await db.query("UPDATE courses SET archived=true,version=version+1 WHERE id=$1", [f.course.id]);
  const catalog = await standingPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(catalog.year.archived, true); assert.equal(catalog.courses.find(c => c.id === f.course.id)!.archived, true);
  const draft = await changeStandingPolicy(db, owner, auth.hash, "create", { ...f.input, catalogHash: catalog.catalogHash });
  assert.equal(draft.policy.evidence.year.archived, true);
  await assert.rejects(db.query(`INSERT INTO standing_policies(id,org_id,unit_id,year_id,version,configuration,draft_hash,catalog_hash,evidence,created_by,updated_by)
    VALUES($1,$2,$3,$4,1,'{}',$5,$5,'{}',$6,$6)`, [randomUUID(), owner.org_id, units[1], f.year.id, "0".repeat(64), owner.id]), /foreign key constraint/i);
  for (const value of [2147483648, "999999999999999999999999", -1, 0, "NaN"]) assert.equal(standingPolicyHistoryInput.safeParse({ beforeVersion: value }).success, false);
  await assert.rejects(standingPolicyCatalog(db, owner, auth.hash, { ...f.scope, yearId: "invalid" }));
});

test("oversized catalog extraction fails visibly instead of truncating accepted policy choices", async () => {
  const f = await fixture();
  const excessive = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT DISTINCT ON")) return { rows: Array.from({ length: standingPolicyLimits.catalogPolicies + 1 }, () => ({})) as R[] };
      return tx.query<R>(sql, params);
    },
  })) } as Database;
  await assert.rejects(standingPolicyCatalog(excessive, owner, auth.hash, f.scope), (e: any) => e.status === 422 && /no entries were truncated/.test(e.message));
  const oversizedTerms = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.includes("locked_at FROM school_terms")) return { rows: Array.from({ length: standingPolicyLimits.terms + 1 }, () => ({})) as R[] };
      return tx.query<R>(sql, params);
    },
  })) } as Database;
  await assert.rejects(changeStandingPolicy(oversizedTerms, owner, auth.hash, "create", f.input), (e: any) => e.status === 422);
});

test("source settings changed before exact shared mutex read reject the formerly reviewed catalog", async () => {
  const f = await fixture(), draft = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  let changed = false;
  // A committed earlier writer is separately tested via setting(); this narrow
  // wrapper proves validation uses the post-lock database row, not caller state.
  const changedBeforeRead = wrapped(async (tx, sql, params) => {
    if (!changed && sql === "SELECT pg_advisory_xact_lock(hashtext($1))" && params?.[0] === "grading-settings:" + f.scope.unitId) {
      changed = true;
      await tx.query("UPDATE grading_settings SET version=version+1 WHERE unit_id=$1", [f.scope.unitId]);
    }
  });
  await assert.rejects(changeStandingPolicy(changedBeforeRead, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id), conflict);
  assert.ok(changed); assert.equal((await standingPolicyDetail(db, owner, auth.hash, draft.policy.id)).policy.version, 1);
});

test("HTTP policy installer enforces sessions, CSRF, private responses, version scope and bounded cursors", async () => {
  const f = await fixture(), app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
  const base = "/api/school/standing/policies";
  const catalog = await request(app).get(base + "/catalog").query(f.scope).set("Cookie", auth.cookie);
  assert.equal(catalog.status, 200); assert.equal(catalog.headers["cache-control"], "private, no-store");
  assert.deepEqual(catalog.body.gradeLevels, { source: "explicit_configuration_required", values: [] });
  const missing = await request(app).post(base).set("Origin", origin).set("Cookie", auth.cookie).send(f.input); assert.equal(missing.status, 403);
  const created = await request(app).post(base).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(f.input);
  assert.equal(created.status, 201); assert.deepEqual(Object.keys(created.body).sort(), ["confirmed", "policy"]); assert.equal(created.body.confirmed, null);
  assert.equal(created.headers["cache-control"], "private, no-store");
  const result = await request(app).post(base + "/" + created.body.policy.id + "/confirm").set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(confirmInput(created.body.policy));
  assert.equal(result.status, 200); const versionId = result.body.confirmed.policyVersionId;
  const read = await request(app).get(base + "/" + created.body.policy.id + "/versions/" + versionId).set("Cookie", auth.cookie);
  assert.equal(read.status, 200); assert.deepEqual(read.body, result.body.confirmed);
  const another = await changeStandingPolicy(db, owner, auth.hash, "create", { ...f.input, commandId: randomUUID() });
  assert.equal((await request(app).get(base + "/" + another.policy.id + "/versions/" + versionId).set("Cookie", auth.cookie)).status, 404);
  assert.equal((await request(app).get(base + "/" + created.body.policy.id + "/history?beforeVersion=999999999999999999999").set("Cookie", auth.cookie)).status, 400);
  const pin = await session(owner, "pin");
  assert.equal((await request(app).get(base + "/catalog").query(f.scope).set("Cookie", pin.cookie)).status, 403);
  const token = await ok("/tokens", { name: "Synthetic standing denial probe", days: 1, scopes: ["reports:read"] });
  assert.equal((await request(app).get(base + "/catalog").query(f.scope).set("Authorization", "Bearer " + token.token)).status, 403);
  const outsider = await person(), outsiderAuth = await session(outsider);
  assert.equal((await request(app).get(base + "/" + created.body.policy.id + "/versions/" + versionId).set("Cookie", outsiderAuth.cookie)).status, 403);
});

test("lock and statement timeout errors return retryable unavailability without partial evidence", async () => {
  const f = await fixture();
  for (const code of ["55P03", "57014"]) {
    const failed = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT DISTINCT ON")) throw Object.assign(new Error("synthetic bounded query timeout"), { code }); });
    await assert.rejects(changeStandingPolicy(failed, owner, auth.hash, "create", f.input), (e: any) => e.status === 503 && /Retry the same command/.test(e.message));
    assert.equal((await db.query("SELECT command_id FROM standing_policy_commands WHERE command_id=$1", [f.input.commandId])).rows.length, 0);
  }
  assert.equal((await listStandingPolicies(db, owner, auth.hash, f.scope)).rows.length, 0);
  const original = await changeStandingPolicy(db, owner, auth.hash, "create", f.input);
  const timedOutRetry = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT fingerprint,result FROM standing_policy_commands")) throw Object.assign(new Error("synthetic retry timeout"), { code: "55P03" }); });
  await assert.rejects(changeStandingPolicy(timedOutRetry, owner, auth.hash, "create", f.input), (e: any) => e.status === 503);
  assert.deepEqual(await changeStandingPolicy(db, owner, auth.hash, "create", f.input), original);
  assert.equal((await listStandingPolicies(db, owner, auth.hash, f.scope)).rows.length, 1);
});
