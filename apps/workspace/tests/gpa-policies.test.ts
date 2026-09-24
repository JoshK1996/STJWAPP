import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff } from "../server/workforce";
import { digest, opaqueToken, type Actor } from "../server/security";
import { gpaPolicyCatalog, changeGpaPolicy, gpaPolicyDetail, gpaPolicyHistory, gpaPolicyVersions, gpaPolicyVersion, listGpaPolicies } from "../server/gpa-policies";
import { canonicalStandingJson, gradingPolicyEvidenceHash } from "../server/standing-policy-provenance";
import { gpaPolicyEvidenceHash } from "../server/gpa-policies";
import type { TermGpaConfiguration } from "../shared/term-gpa";
import { gpaPolicyCreateInput, gpaPolicyConfirmInput, gpaPolicyHistoryInput, gpaPolicyLimits, type GpaPolicyRecord } from "../shared/gpa-policies";
import type { GradingPolicy } from "../shared/grading";
import { standingPolicyCatalog } from "../server/standing-policies";
import { ZodError } from "zod";

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
  const scope = { unitId, yearId: year.id }, catalog = await gpaPolicyCatalog(db, owner, auth.hash, scope), pair = catalog.gradingPolicies[0];
  const configuration: TermGpaConfiguration = { name: "Synthetic GPA example", termIds: [term.id], gradeLevels: ["Explicit synthetic grade"],
    courseRules: [{ courseId: course.id, disposition: "include", required: true, weight: "1.500000", reason }], minimumIncludedCourses: 1,
    missingWork: "block_calculation", basis: "awarded_label", formula: "explicit_course_weighted_points", display: { decimalPlaces: 3, rounding: "half_even" },
    acceptedGradingPolicies: [{ hash: pair.hash, version: pair.version, labelRules: [{ label: "A", kind: "points", points: "4.000000" }, { label: "B", kind: "points", points: "2.500000" }] }] };
  const input = { ...scope, catalogHash: catalog.catalogHash, configuration, reason, commandId: randomUUID() };
  return { scope, year, term, course, section, grading, catalog, input };
}
const confirmInput = (p: GpaPolicyRecord) => ({ expectedVersion: p.version, draftHash: p.draftHash, catalogHash: p.catalogHash, sourceDescription: "Owner reviewed synthetic configuration only", reason, reviewed: true as const, commandId: randomUUID() });
const updateInput = (p: GpaPolicyRecord, extra = {}) => ({ expectedVersion: p.version, catalogHash: p.catalogHash, configuration: p.configuration, reason, commandId: randomUUID(), ...extra });
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
  assert.equal((await db.query("SELECT count(*)::integer AS count FROM gpa_policies")).rows[0].count, 0, "Migration/initialization must not seed GPA rules");
  const r = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(r => r.id);
  owner = { id: r.id, org_id: r.org_id, name: r.name, email: r.email, role: r.role, mode: "password", unit_ids: units } as Actor; auth = await session(owner);
});
after(async () => { await db?.close(); });

test("configuration requires explicit choices and strict server-owned identity boundaries", async () => {
  const f = await fixture(); assert.ok(gpaPolicyCreateInput.safeParse(f.input).success);
  for (const change of [{ orgId: owner.org_id }, { actorId: owner.id }, { configuration: { ...f.input.configuration, version: 1 } }, { configuration: { ...f.input.configuration, missingWork: undefined } }, { configuration: { ...f.input.configuration, courseRules: [{ courseId: f.course.id, disposition: "include", reason }] } }, { configuration: { ...f.input.configuration, termIds: [f.term.id, f.term.id] } }]) assert.equal(gpaPolicyCreateInput.safeParse({ ...f.input, ...change }).success, false);
  const p = (await changeGpaPolicy(db, owner, auth.hash, "create", f.input)).policy;
  for (const change of [{ reviewed: false }, { reviewed: undefined }, { sourceDescription: "" }, { expectedVersion: "1" }, { reason: "" }]) assert.equal(gpaPolicyConfirmInput.safeParse({ ...confirmInput(p), ...change }).success, false);
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
  const f = await fixture(), created = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const c = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(created.policy), created.policy.id);
  assert.equal(c.policy.version, 2); assert.equal(c.confirmed!.version, 1); assert.equal(c.policy.hasUnconfirmedChanges, false);
  assert.equal(c.confirmed!.policyHash, gpaPolicyEvidenceHash(c.confirmed!.policy));
  const edited = await changeGpaPolicy(db, owner, auth.hash, "update", updateInput(c.policy, { configuration: { ...c.policy.configuration, name: "Changed synthetic policy" } }), c.policy.id);
  assert.equal(edited.policy.hasUnconfirmedChanges, true); assert.equal(edited.policy.activePolicyVersionId, c.confirmed!.policyVersionId);
  assert.deepEqual(await gpaPolicyVersion(db, owner, auth.hash, c.policy.id, c.confirmed!.policyVersionId), c.confirmed);
  const history = await gpaPolicyHistory(db, owner, auth.hash, c.policy.id);
  assert.deepEqual(history.rows.map(r => r.action), ["updated", "confirmed", "created"]);
  assert.deepEqual(history.rows[0].before, c.policy); assert.deepEqual(history.rows[2].after, created.policy);
  const audits = (await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [c.policy.id])).rows;
  assert.equal(audits.length, 3); for (const r of audits) assert.ok(!JSON.stringify(r.detail).includes(reason) && !JSON.stringify(r.detail).includes("configuration"));
  const list = await listGpaPolicies(db, owner, auth.hash, f.scope); assert.equal(list.rows[0].id, c.policy.id);
});

test("fabricated grading pairs, labels and cross-scope identities are rejected", async () => {
  const f = await fixture(), cfg = f.input.configuration;
  for (const configuration of [
    { ...cfg, termIds: [randomUUID()] }, { ...cfg, courseRules: [{ courseId: randomUUID(), disposition: "include", required: true, weight: "1", reason }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], hash: "0".repeat(64) }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], version: 99999 }] },
    { ...cfg, acceptedGradingPolicies: [{ ...cfg.acceptedGradingPolicies[0], labelRules: [{ label: "Made up label", kind: "points", points: "4" }] }] },
  ]) await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, configuration, commandId: randomUUID() }), (e: any) => e.status === 422);
  await assert.rejects(gpaPolicyCatalog(db, owner, auth.hash, { ...f.scope, unitId: units[1] }), (e: any) => e.status === 404);
  await setting(f.scope.unitId, f.grading, false);
  assert.equal((await gpaPolicyCatalog(db, owner, auth.hash, f.scope)).gradingPolicies.length, 0);
});

test("same-pair reviewed release does not stale the catalog or replace originally reviewed provenance", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const releaseId = await release(f), catalog = await gpaPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(catalog.catalogHash, f.catalog.catalogHash);
  assert.ok(catalog.gradingPolicies[0].provenance.some(p => p.kind === "reviewed_release" && p.releaseId === releaseId));
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  assert.deepEqual(done.confirmed!.evidence, draft.policy.evidence);
  assert.equal(done.confirmed!.evidence.gradingPolicies[0].provenance.length, 1);
  await setting(f.scope.unitId, { ...f.grading, name: "Replacement synthetic grading" });
  const updated = await gpaPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(updated.gradingPolicies.length, 2); assert.ok(updated.gradingPolicies.some(r => r.hash === f.catalog.gradingPolicies[0].hash));
  const original = await gpaPolicyVersion(db, owner, auth.hash, draft.policy.id, done.confirmed!.policyVersionId); assert.deepEqual(original, done.confirmed);
});

test("source changes force explicit refreshed draft and current hash review", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  await setting(f.scope.unitId, { ...f.grading, decimals: 1 });
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id), conflict);
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "update", updateInput(draft.policy), draft.policy.id), conflict);
  const catalog = await gpaPolicyCatalog(db, owner, auth.hash, f.scope), ref = catalog.gradingPolicies[0];
  const configuration = { ...draft.policy.configuration, acceptedGradingPolicies: [{ hash: ref.hash, version: ref.version, labelRules: [{ label: "A", kind: "points", points: "4" }, { label: "B", kind: "points", points: "2.5" }] }] };
  const revised = await changeGpaPolicy(db, owner, auth.hash, "update", updateInput(draft.policy, { catalogHash: catalog.catalogHash, configuration }), draft.policy.id);
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "confirm", { ...confirmInput(revised.policy), draftHash: draft.policy.draftHash }, revised.policy.id), conflict);
  assert.equal((await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(revised.policy), revised.policy.id)).confirmed!.version, 1);
});

test("idempotent receipts survive later edits and catalog changes but remain private under current access", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input), input = confirmInput(draft.policy);
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id);
  await changeGpaPolicy(db, owner, auth.hash, "update", updateInput(done.policy, { configuration: { ...done.policy.configuration, name: "Later revision" } }), draft.policy.id);
  await setting(f.scope.unitId, { ...f.grading, decimals: 0 });
  assert.deepEqual(await changeGpaPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id), done);
  assert.deepEqual(await changeGpaPolicy(db, owner, auth.hash, "create", f.input), draft);
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "confirm", { ...input, reason: "Different command meaning" }, draft.policy.id), conflict);
  await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.id]);
  try { await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "confirm", input, draft.policy.id), denied); }
  finally { await db.query("UPDATE users SET role='owner' WHERE id=$1", [owner.id]); }
});

test("current office and explicit unit access are mandatory for every read, mutation and receipt", async () => {
  const f = await fixture(), office = await person(), a = await session(office);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: true });
  const draft = await changeGpaPolicy(db, office, a.hash, "create", f.input);
  assert.equal((await gpaPolicyDetail(db, office, a.hash, draft.policy.id)).allowedActions.confirm, false);
  await assert.rejects(changeGpaPolicy(db, { ...office, role: "owner" }, a.hash, "confirm", confirmInput(draft.policy), draft.policy.id), denied);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: false });
  for (const run of [() => gpaPolicyDetail(db, office, a.hash, draft.policy.id), () => gpaPolicyHistory(db, office, a.hash, draft.policy.id), () => changeGpaPolicy(db, office, a.hash, "create", f.input), () => gpaPolicyCatalog(db, office, a.hash, f.scope)]) await assert.rejects(run(), denied);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: office.id, enabled: true });
  await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [office.id, f.scope.unitId]);
  await assert.rejects(gpaPolicyDetail(db, office, a.hash, draft.policy.id), denied);
  const finance = await person("finance"), fin = await session(finance); await assert.rejects(listGpaPolicies(db, finance, fin.hash, f.scope), denied);
});

test("password proof is required even for supplied owner; expiry and inactive accounts block reads", async () => {
  const f = await fixture(), user = await person("admin"), a = await session(user), pin = await session(user, "pin");
  for (const h of [undefined, "0".repeat(64), pin.hash]) await assert.rejects(gpaPolicyCatalog(db, user, h, f.scope), denied);
  await assert.rejects(gpaPolicyCatalog(db, { ...user, mode: "pin" }, a.hash, f.scope), denied);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [a.hash]);
  await assert.rejects(gpaPolicyCatalog(db, user, a.hash, f.scope), denied);
  const fresh = await session(user); await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  await assert.rejects(gpaPolicyCatalog(db, user, fresh.hash, f.scope), denied);
});

test("competing confirm, edit and archive use one expected version without losing evidence", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const results = await Promise.allSettled([
    changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id),
    changeGpaPolicy(db, owner, auth.hash, "update", updateInput(draft.policy, { configuration: { ...draft.policy.configuration, name: "Competing change" } }), draft.policy.id),
    changeGpaPolicy(db, owner, auth.hash, "archive", { expectedVersion: draft.policy.version, archived: true, commandId: randomUUID(), reason }, draft.policy.id),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(conflict(r.reason));
  assert.equal((await gpaPolicyHistory(db, owner, auth.hash, draft.policy.id)).rows.length, 2);
});

test("archive and restore retain the current confirmed pointer and immutable versions", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input), done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  const archived = await changeGpaPolicy(db, owner, auth.hash, "archive", { expectedVersion: done.policy.version, archived: true, reason, commandId: randomUUID() }, draft.policy.id);
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "update", updateInput(archived.policy), draft.policy.id), conflict);
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(archived.policy), draft.policy.id), conflict);
  assert.deepEqual((await gpaPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows, [done.confirmed]);
  const restored = await changeGpaPolicy(db, owner, auth.hash, "archive", { expectedVersion: archived.policy.version, archived: false, reason, commandId: randomUUID() }, draft.policy.id);
  assert.equal(restored.policy.activePolicyVersionId, done.confirmed!.policyVersionId); assert.equal(restored.policy.confirmedVersion, 1);
});

test("audit failure and final session expiry roll back policy, immutable evidence and receipt together", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input), input = confirmInput(draft.policy);
  const failed = wrapped(async (_tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) throw new Error("synthetic audit failure"); });
  await assert.rejects(changeGpaPolicy(failed, owner, auth.hash, "confirm", input, draft.policy.id), /synthetic audit failure/);
  const expiring = wrapped(async (tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) await tx.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [auth.hash]); });
  await assert.rejects(changeGpaPolicy(expiring, owner, auth.hash, "confirm", input, draft.policy.id), denied);
  assert.equal((await gpaPolicyDetail(db, owner, auth.hash, draft.policy.id)).policy.version, 1);
  assert.equal((await gpaPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows.length, 0);
  assert.equal((await db.query("SELECT command_id FROM gpa_policy_commands WHERE command_id=$1", [input.commandId])).rows.length, 0);
});

test("source identity validation uses the existing settings mutex and academic-first authority order", async () => {
  const f = await fixture(), statements: Array<{ sql: string; params?: any[] }> = [];
  const tracked = wrapped(async (_tx, sql, params) => { statements.push({ sql, params }); });
  await changeGpaPolicy(tracked, owner, auth.hash, "create", f.input);
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
  const f = await fixture(), raw = structuredClone(f.input), pending = changeGpaPolicy(db, owner, auth.hash, "create", raw);
  raw.configuration.name = "Mutated after invocation"; raw.configuration.courseRules.length = 0;
  const draft = await pending; assert.equal(draft.policy.configuration.name, f.input.configuration.name); assert.equal(draft.policy.configuration.courseRules.length, 1);
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  for (const table of ["gpa_policy_versions", "gpa_policy_history", "gpa_policy_commands"])
    for (const action of ["DELETE FROM " + table + " WHERE policy_id=$1", "UPDATE " + table + " SET org_id=org_id WHERE policy_id=$1"]) await assert.rejects(db.query(action, [draft.policy.id]), /append-only/i);
  await assert.rejects(db.query("DELETE FROM gpa_policies WHERE id=$1", [draft.policy.id]), /cannot be deleted/);
  await assert.rejects(db.query("UPDATE gpa_policies SET version=version+1,unit_id=$2 WHERE id=$1", [draft.policy.id, units[1]]), /identity is immutable/);
  assert.equal((await gpaPolicyDetail(db, owner, auth.hash, draft.policy.id)).confirmed!.policyVersionId, done.confirmed!.policyVersionId);
});

test("confirmation preserves exact decimal encodings and explicit unsupported scale mappings", async () => {
  const f = await fixture(); f.input.configuration.acceptedGradingPolicies[0].labelRules[1] = { label: "B", kind: "unsupported", reason: "Synthetic mapping requires further school instruction" };
  const draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  assert.equal(done.confirmed!.policy.basis, "awarded_label");
  assert.deepEqual(done.confirmed!.policy.acceptedGradingPolicies[0].labelRules, f.input.configuration.acceptedGradingPolicies[0].labelRules);
  assert.equal((done.confirmed!.policy.courseRules[0] as { weight: string }).weight, "1.500000");
  assert.deepEqual(done.confirmed!.policy.display, { decimalPlaces: 3, rounding: "half_even" });
});

test("enabled authenticator requires current verified password session on policy reads and receipts", async () => {
  const f = await fixture(), user = await person("admin"), a = await session(user);
  const draft = await changeGpaPolicy(db, user, a.hash, "create", f.input);
  // Synthetic factor metadata only. No real secret or authenticator enrollment.
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic-unused-digest',now(),now())", [user.id, user.org_id, randomUUID()]);
  await assert.rejects(gpaPolicyDetail(db, user, a.hash, draft.policy.id), denied);
  await assert.rejects(changeGpaPolicy(db, user, a.hash, "create", f.input), denied);
  await db.query("UPDATE sessions SET mfa_verified=true WHERE token_hash=$1", [a.hash]);
  assert.deepEqual(await changeGpaPolicy(db, user, a.hash, "create", f.input), draft);
});

test("historical confirmations remain readable after their current-only catalog pair disappears", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input), done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  await setting(f.scope.unitId, { ...f.grading, name: "New synthetic catalog with no prior releases" });
  const catalog = await gpaPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.ok(!catalog.gradingPolicies.some(r => r.hash === f.catalog.gradingPolicies[0].hash));
  assert.deepEqual((await gpaPolicyDetail(db, owner, auth.hash, draft.policy.id)).confirmed, done.confirmed);
  assert.deepEqual((await gpaPolicyVersions(db, owner, auth.hash, draft.policy.id)).rows, [done.confirmed]);
  assert.equal((await gpaPolicyHistory(db, owner, auth.hash, draft.policy.id)).rows.length, 2);
});

test("archived identities remain explicitly labeled historical configuration, with exact cross-unit year FK", async () => {
  const f = await fixture();
  await db.query("UPDATE school_years SET archived=true,version=version+1 WHERE id=$1", [f.year.id]);
  await db.query("UPDATE courses SET archived=true,version=version+1 WHERE id=$1", [f.course.id]);
  const catalog = await gpaPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.equal(catalog.year.archived, true); assert.equal(catalog.courses.find(c => c.id === f.course.id)!.archived, true);
  const draft = await changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, catalogHash: catalog.catalogHash });
  assert.equal(draft.policy.evidence.year.archived, true);
  await assert.rejects(db.query(`INSERT INTO gpa_policies(id,org_id,unit_id,year_id,version,configuration,draft_hash,catalog_hash,evidence,created_by,updated_by)
    VALUES($1,$2,$3,$4,1,'{}',$5,$5,'{}',$6,$6)`, [randomUUID(), owner.org_id, units[1], f.year.id, "0".repeat(64), owner.id]), /foreign key constraint/i);
  for (const value of [2147483648, "999999999999999999999999", -1, 0, "NaN"]) assert.equal(gpaPolicyHistoryInput.safeParse({ beforeVersion: value }).success, false);
  await assert.rejects(gpaPolicyCatalog(db, owner, auth.hash, { ...f.scope, yearId: "invalid" }));
});

test("oversized catalog extraction fails visibly instead of truncating accepted policy choices", async () => {
  const f = await fixture();
  const excessive = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT DISTINCT ON")) return { rows: Array.from({ length: gpaPolicyLimits.catalogPolicies + 1 }, () => ({})) as R[] };
      return tx.query<R>(sql, params);
    },
  })) } as Database;
  await assert.rejects(gpaPolicyCatalog(excessive, owner, auth.hash, f.scope), (e: any) => e.status === 422 && /no entries were truncated/.test(e.message));
  const oversizedTerms = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.includes("locked_at FROM school_terms")) return { rows: Array.from({ length: gpaPolicyLimits.terms + 1 }, () => ({})) as R[] };
      return tx.query<R>(sql, params);
    },
  })) } as Database;
  await assert.rejects(changeGpaPolicy(oversizedTerms, owner, auth.hash, "create", f.input), (e: any) => e.status === 422);
});

test("source settings changed before exact shared mutex read reject the formerly reviewed catalog", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  let changed = false;
  // A committed earlier writer is separately tested via setting(); this narrow
  // wrapper proves validation uses the post-lock database row, not caller state.
  const changedBeforeRead = wrapped(async (tx, sql, params) => {
    if (!changed && sql === "SELECT pg_advisory_xact_lock(hashtext($1))" && params?.[0] === "grading-settings:" + f.scope.unitId) {
      changed = true;
      await tx.query("UPDATE grading_settings SET version=version+1 WHERE unit_id=$1", [f.scope.unitId]);
    }
  });
  await assert.rejects(changeGpaPolicy(changedBeforeRead, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id), conflict);
  assert.ok(changed); assert.equal((await gpaPolicyDetail(db, owner, auth.hash, draft.policy.id)).policy.version, 1);
});

test("HTTP policy installer enforces sessions, CSRF, private responses, version scope and bounded cursors", async () => {
  const f = await fixture(), app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" });
  const base = "/api/school/gpa/policies";
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
  const another = await changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, commandId: randomUUID() });
  assert.equal((await request(app).get(base + "/" + another.policy.id + "/versions/" + versionId).set("Cookie", auth.cookie)).status, 404);
  assert.equal((await request(app).get(base + "/" + created.body.policy.id + "/history?beforeVersion=999999999999999999999").set("Cookie", auth.cookie)).status, 400);
  const pin = await session(owner, "pin");
  assert.equal((await request(app).get(base + "/catalog").query(f.scope).set("Cookie", pin.cookie)).status, 403);
  const token = await ok("/tokens", { name: "Synthetic gpa denial probe", days: 1, scopes: ["reports:read"] });
  assert.equal((await request(app).get(base + "/catalog").query(f.scope).set("Authorization", "Bearer " + token.token)).status, 403);
  const outsider = await person(), outsiderAuth = await session(outsider);
  assert.equal((await request(app).get(base + "/" + created.body.policy.id + "/versions/" + versionId).set("Cookie", outsiderAuth.cookie)).status, 403);
});

test("lock and statement timeout errors return retryable unavailability without partial evidence", async () => {
  const f = await fixture();
  for (const code of ["55P03", "57014"]) {
    const failed = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT DISTINCT ON")) throw Object.assign(new Error("synthetic bounded query timeout"), { code }); });
    await assert.rejects(changeGpaPolicy(failed, owner, auth.hash, "create", f.input), (e: any) => e.status === 503 && /Retry the same command/.test(e.message));
    assert.equal((await db.query("SELECT command_id FROM gpa_policy_commands WHERE command_id=$1", [f.input.commandId])).rows.length, 0);
  }
  assert.equal((await listGpaPolicies(db, owner, auth.hash, f.scope)).rows.length, 0);
  const original = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const timedOutRetry = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT fingerprint,result FROM gpa_policy_commands")) throw Object.assign(new Error("synthetic retry timeout"), { code: "55P03" }); });
  await assert.rejects(changeGpaPolicy(timedOutRetry, owner, auth.hash, "create", f.input), (e: any) => e.status === 503);
  assert.deepEqual(await changeGpaPolicy(db, owner, auth.hash, "create", f.input), original);
  assert.equal((await listGpaPolicies(db, owner, auth.hash, f.scope)).rows.length, 1);
});

test("GPA uses the same transaction catalog bytes and hashes without changing standing responses", async () => {
  const f = await fixture();
  const prior = await standingPolicyCatalog(db, owner, auth.hash, f.scope);
  assert.deepEqual(await gpaPolicyCatalog(db, owner, auth.hash, f.scope), prior);
  await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  assert.deepEqual(await standingPolicyCatalog(db, owner, auth.hash, f.scope), prior);
});

test("every actual scale label needs an exact point or unsupported mapping", async () => {
  const f = await fixture(), ref = f.input.configuration.acceptedGradingPolicies[0];
  for (const labelRules of [ref.labelRules.slice(0, 1), [...ref.labelRules, { label: "C", kind: "points", points: "0" }],
    [{ label: "a", kind: "points", points: "4" }, ref.labelRules[1]]]) {
    const configuration = { ...f.input.configuration, acceptedGradingPolicies: [{ ...ref, labelRules }] };
    await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, configuration, commandId: randomUUID() }), (e: any) => e.status === 422);
  }
  await setting(f.scope.unitId, { ...f.grading, scale: [] });
  const empty = await gpaPolicyCatalog(db, owner, auth.hash, f.scope), pair = empty.gradingPolicies[0];
  const configuration = { ...f.input.configuration, acceptedGradingPolicies: [{ ...ref, hash: pair.hash, version: pair.version }] };
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, catalogHash: empty.catalogHash, configuration }), (e: any) => e.status === 422);
});

test("captured historical scale whitespace is preserved and never silently matched to trimmed labels", async () => {
  const f = await fixture(), raw = { ...f.grading, name: "  Synthetic captured original  ", scale: [{ label: " A ", minimum: 9000 }, { label: "B", minimum: 0 }] };
  // Local synthetic older captured row; normal configuration writes trim new labels.
  await db.query("UPDATE grading_settings SET policy=$2,version=version+1 WHERE unit_id=$1", [f.scope.unitId, JSON.stringify(raw)]);
  const catalog = await gpaPolicyCatalog(db, owner, auth.hash, f.scope), ref = catalog.gradingPolicies[0];
  assert.deepEqual(ref.policy, raw); assert.equal(ref.hash, gradingPolicyEvidenceHash(raw));
  const configuration = { ...f.input.configuration, acceptedGradingPolicies: [{ hash: ref.hash, version: ref.version, labelRules: [
    { label: " A ", kind: "points" as const, points: "4.000000" }, { label: "B", kind: "unsupported" as const, reason: "Synthetic unsupported mapping" },
  ] }] };
  const draft = await changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, catalogHash: catalog.catalogHash, configuration });
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  assert.deepEqual(done.confirmed!.evidence.gradingPolicies[0].policy, raw);
  configuration.acceptedGradingPolicies[0].labelRules[0].label = "A";
  await assert.rejects(changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, commandId: randomUUID(), catalogHash: catalog.catalogHash, configuration }), (e: any) => e.status === 422);
});

test("GPA migration binds confirmation scope, active counter and configuration hash without nullable bypass", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  await assert.rejects(db.query("UPDATE gpa_policies SET version=version+1,confirmed_version=confirmed_version+1 WHERE id=$1", [draft.policy.id]), /foreign key constraint/i);
  await assert.rejects(db.query("UPDATE gpa_policies SET version=version+1,confirmed_version=confirmed_version+1,confirmed_configuration_hash=NULL WHERE id=$1", [draft.policy.id]), /check constraint/i);
  await assert.rejects(db.query(`INSERT INTO gpa_policy_versions(id,org_id,policy_id,unit_id,year_id,version,draft_version,policy_hash,configuration_hash,policy,evidence,source_description,reason,confirmed_by,confirmed_name)
    SELECT $2,org_id,policy_id,$3::uuid,year_id,2,draft_version,policy_hash,configuration_hash,jsonb_set(jsonb_set(policy,'{version}','2'),'{unitId}',to_jsonb($3::uuid::text)),evidence,source_description,reason,confirmed_by,confirmed_name
    FROM gpa_policy_versions WHERE id=$1`, [done.confirmed!.policyVersionId, randomUUID(), units[1]]), /foreign key constraint/i);
  for (const field of ["policyId", "orgId", "unitId", "yearId", "version", "calculatorVersion"]) {
    await assert.rejects(db.query(`INSERT INTO gpa_policy_versions(id,org_id,policy_id,unit_id,year_id,version,draft_version,policy_hash,configuration_hash,policy,evidence,source_description,reason,confirmed_by,confirmed_name)
      SELECT $2,org_id,policy_id,unit_id,year_id,2,draft_version,policy_hash,configuration_hash,jsonb_set(jsonb_set(policy,'{version}','2'),ARRAY[$3::text],'null'),evidence,source_description,reason,confirmed_by,confirmed_name
      FROM gpa_policy_versions WHERE id=$1`, [done.confirmed!.policyVersionId, randomUUID(), field]), /check constraint/i);
  }
  assert.deepEqual((await gpaPolicyDetail(db, owner, auth.hash, draft.policy.id)).confirmed, done.confirmed);
});

test("readback integrity detects malformed evidence hashes and receipt scope without publishing it", async () => {
  const f = await fixture(), original = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const injected = (target: "record" | "receipt") => ({ ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      const result = await tx.query<R>(sql, params);
      if (target === "record" && sql.startsWith("SELECT * FROM gpa_policies") && result.rows[0]) (result.rows[0] as Row).draft_hash = "0".repeat(64);
      if (target === "receipt" && sql.startsWith("SELECT fingerprint,result FROM gpa_policy_commands") && result.rows[0]) (result.rows[0] as Row).result.policy.unitId = units[1];
      return result;
    },
  })) } as Database);
  await assert.rejects(gpaPolicyDetail(injected("record"), owner, auth.hash, original.policy.id), (e: any) => e.status === 422);
  await assert.rejects(changeGpaPolicy(injected("receipt"), owner, auth.hash, "create", f.input), (e: any) => e.status === 422);
  assert.deepEqual(await changeGpaPolicy(db, owner, auth.hash, "create", f.input), original);
});

test("current onboarding, session and role proof are rechecked on exact receipts and after simulated waits", async () => {
  const f = await fixture(), user = await person("admin"), a = await session(user);
  const created = await changeGpaPolicy(db, user, a.hash, "create", f.input);
  await db.query("UPDATE users SET password_hash='synthetic-unused-hash',pin_hash='synthetic-unused-hash',requires_credential_change=true WHERE id=$1", [user.id]);
  await assert.rejects(changeGpaPolicy(db, user, a.hash, "create", f.input), denied);
  await db.query("UPDATE users SET requires_credential_change=false WHERE id=$1", [user.id]);
  const roleChanged = wrapped(async (tx, sql) => {
    if (sql.startsWith("SELECT id,org_id,name,email,role,active FROM users")) await tx.query("UPDATE users SET role='employee' WHERE id=$1", [user.id]);
  });
  await assert.rejects(changeGpaPolicy(roleChanged, user, a.hash, "create", f.input), denied);
  const expiredAtReceipt = wrapped(async (tx, sql) => {
    if (sql.startsWith("SELECT fingerprint,result FROM gpa_policy_commands")) await tx.query("DELETE FROM sessions WHERE token_hash=$1", [a.hash]);
  });
  await assert.rejects(changeGpaPolicy(expiredAtReceipt, user, a.hash, "create", f.input), denied);
  assert.deepEqual(await changeGpaPolicy(db, user, a.hash, "create", f.input), created);
});

test("history remains readable when the current catalog exceeds its extraction bound", async () => {
  const f = await fixture(), draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  const done = await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(draft.policy), draft.policy.id);
  const noCatalog = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT DISTINCT ON")) throw new Error("Synthetic catalog should not load"); });
  assert.deepEqual((await gpaPolicyDetail(noCatalog, owner, auth.hash, draft.policy.id)).confirmed, done.confirmed);
  assert.equal((await gpaPolicyHistory(noCatalog, owner, auth.hash, draft.policy.id)).rows.length, 2);
  assert.equal((await gpaPolicyVersions(noCatalog, owner, auth.hash, draft.policy.id)).rows.length, 1);
});

test("strict GPA HTTP inputs reject repeated query arrays, extra fields and unsupported identity claims", async () => {
  const f = await fixture(), app = createApp(db, { origin, production: false, demo: true, staffDomain: "stjw.org" }), base = "/api/school/gpa/policies";
  assert.equal((await request(app).get(base + "/catalog").query(f.scope)).status, 401);
  assert.equal((await request(app).get(base + "/catalog").query({ ...f.scope, unitId: [f.scope.unitId, f.scope.unitId] }).set("Cookie", auth.cookie)).status, 400);
  assert.equal((await request(app).post(base).set("Origin", "http://another.example").set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(f.input)).status, 403);
  const draft = await changeGpaPolicy(db, owner, auth.hash, "create", f.input);
  for (const suffix of ["?beforeVersion=1&beforeVersion=2", "?beforeVersion[]=1", "?beforeVersion=0", "?extra=true"]) {
    assert.equal((await request(app).get(base + "/" + draft.policy.id + "/history" + suffix).set("Cookie", auth.cookie)).status, 400);
  }
  for (const value of [[1], ["1"], "1.0", " 1", true, null]) assert.throws(() => gpaPolicyHistoryInput.parse({ beforeVersion: value }), ZodError);
  const replay = await request(app).post(base).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(f.input);
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, draft);
});

test("policy list, immutable confirmations and history paginate beyond 50 without truncation", async () => {
  const f = await fixture(), created: GpaPolicyRecord[] = [];
  for (let i = 0; i < 51; i++) created.push((await changeGpaPolicy(db, owner, auth.hash, "create", { ...f.input, commandId: randomUUID() })).policy);
  const first = await listGpaPolicies(db, owner, auth.hash, f.scope);
  assert.equal(first.rows.length, 50); assert.ok(first.nextBeforeId);
  const next = await listGpaPolicies(db, owner, auth.hash, { ...f.scope, beforeId: first.nextBeforeId });
  assert.equal(next.rows.length, 1); assert.equal(next.nextBeforeId, null);
  assert.equal(new Set([...first.rows, ...next.rows].map(row => row.id)).size, 51);
  let policy = created[0];
  for (let i = 0; i < 51; i++) policy = (await changeGpaPolicy(db, owner, auth.hash, "confirm", confirmInput(policy), policy.id)).policy;
  const history = await gpaPolicyHistory(db, owner, auth.hash, policy.id), versions = await gpaPolicyVersions(db, owner, auth.hash, policy.id);
  assert.equal(history.rows.length, 50); assert.equal(versions.rows.length, 50);
  const historyRest = await gpaPolicyHistory(db, owner, auth.hash, policy.id, { beforeVersion: history.nextBeforeVersion });
  const versionRest = await gpaPolicyVersions(db, owner, auth.hash, policy.id, { beforeVersion: versions.nextBeforeVersion });
  assert.equal(historyRest.rows.length, 2); assert.equal(versionRest.rows.length, 1);
  assert.equal(historyRest.nextBeforeVersion, null); assert.equal(versionRest.nextBeforeVersion, null);
  assert.deepEqual([...history.rows, ...historyRest.rows].map(row => row.version), Array.from({ length: 52 }, (_, i) => 52 - i));
  assert.deepEqual([...versions.rows, ...versionRest.rows].map(row => row.version), Array.from({ length: 51 }, (_, i) => 51 - i));
});

test("office grant and exact membership are read after authority waits, not from a supplied actor copy", async () => {
  const f = await fixture(), staff = await person(), a = await session(staff);
  await ok("/school/office-grants", { unitId: f.scope.unitId, userId: staff.id, enabled: true });
  const draft = await changeGpaPolicy(db, staff, a.hash, "create", f.input);
  for (const kind of ["office", "membership"] as const) {
    let fired = false;
    const revoked = wrapped(async (tx, sql) => {
      if (kind === "office" && sql.startsWith("SELECT unit_id FROM school_office_grants")) {
        fired = true; await tx.query("DELETE FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3", [staff.org_id, staff.id, f.scope.unitId]);
      }
      if (kind === "membership" && sql.startsWith("SELECT unit_id FROM user_units")) {
        fired = true; await tx.query("DELETE FROM user_units WHERE org_id=$1 AND user_id=$2 AND unit_id=$3", [staff.org_id, staff.id, f.scope.unitId]);
      }
    });
    await assert.rejects(changeGpaPolicy(revoked, staff, a.hash, "create", f.input), denied); assert.ok(fired);
    assert.deepEqual(await changeGpaPolicy(db, staff, a.hash, "create", f.input), draft, "Injected revocation and failed receipt are rolled back locally");
  }
});
