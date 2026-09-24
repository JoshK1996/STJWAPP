import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { standingPolicyCatalog, changeStandingPolicy } from "../server/standing-policies";
import { prepareStanding, retainStanding, getStandingPreview, getStandingDecision, listStandingDecisions, exportStandingDecision, eligibleStandingIssues, standingDecisionCurrentness } from "../server/standing-decisions";
import { prepareStandingInput, retainStandingInput, standingDecisionListInput, standingReviewDataSchema, standingDecisionCursorSchema, type StandingPreview } from "../shared/standing-decisions";

let db: Database, owner: Actor, officer: Actor, second: Actor, unitId: string, otherUnit: string, auth: Auth, officeAuth: Auth, secondAuth: Auth;
const origin = "http://localhost:3181", reason = "Explicit synthetic standing decision review";
type Auth = { hash: string; cookie: string; csrf: string };
const application = (database = db) => createApp(database, { origin, production: false, demo: true, staffDomain: "stjw.org" });
const denied = (e: any) => [401, 403, 404].includes(e.status), conflict = (e: any) => e.status === 409;
async function session(actor: Actor, mode = "password"): Promise<Auth> {
  const token = opaqueToken(), hash = digest(token), csrf = opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [hash, actor.org_id, actor.id, mode, csrf]);
  return { hash, csrf, cookie: "stjw_session=" + token };
}
async function api(path: string, body?: unknown, method = "post", a = auth) {
  const r = body === undefined ? await request(application()).get("/api" + path).set("Cookie", a.cookie)
    : await (request(application()) as any)[method]("/api" + path).set("Cookie", a.cookie).set("Origin", origin).set("X-CSRF-Token", a.csrf).send(body);
  assert.ok(r.status < 300, path + " " + JSON.stringify(r.body)); return r.body;
}
async function person(role: "owner" | "admin" | "employee" | "finance" = "employee") {
  const id = await db.transaction(tx => createStaff(tx, owner, { name: "Synthetic standing reviewer", email: randomUUID() + "@stjw.org", role, unitIds: [unitId], jobIds: [] }, "stjw.org"));
  const user = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE id=$1", [id])).rows[0];
  return { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: user.role, mode: "password", unit_ids: [unitId] } as Actor;
}
async function grant(actor: Actor, enabled = true) { await api("/school/office-grants", { unitId, userId: actor.id, enabled }); }
async function fixture(options: { missingCourse?: boolean; terms?: number } = {}) {
  const tag = randomUUID().slice(0, 8), category = randomUUID(), settings = await api("/school/grading/settings?unitId=" + unitId);
  await api("/school/grading/settings", { unitId, version: settings.version, confirmed: true, reason, policy: { name: "Synthetic decision scale " + tag,
    calculation: "total_points", missing: "exclude", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest",
    categories: [{ id: category, name: "Synthetic", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] } }, "put");
  const year = await api("/school/years", { unitId, name: "Synthetic decisions " + tag, startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const terms: Row[] = [];
  for (let i = 0; i < (options.terms ?? 1); i++) terms.push(await api("/school/terms", { yearId: year.id, name: "Term " + i, startsOn: i ? "2026-07-01" : "2026-01-01", endsOn: i ? "2026-12-31" : "2026-06-30" }));
  const student = await api("/school/students", { unitId, name: "=Synthetic selected " + tag, studentNumber: "+SYN" + tag });
  await api("/school/students/" + student.id + "/enrollments", { enrollment: { yearId: year.id, gradeLevel: "Synthetic", startsOn: "2026-01-01", endsOn: "2026-12-31" } });
  const course = await api("/school/courses", { unitId, code: "S" + tag, title: "Synthetic course " + tag, description: "" });
  const absent = options.missingCourse ? await api("/school/courses", { unitId, code: "M" + tag, title: "Required missing course " + tag, description: "" }) : null;
  const section = await api("/school/sections", { unitId, yearId: year.id, courseId: course.id, name: "Synthetic class " + tag, teacherIds: [], capacity: 20, homeroom: false });
  await api("/school/sections/" + section.id + "/roster", { studentId: student.id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const books: Row[] = [];
  for (const term of terms) {
    const book = await api("/school/gradebooks", { sectionId: section.id, termId: term.id }); books.push(book);
    const assignment = await api("/school/grade-assignments", { bookId: book.id, bookVersion: book.version, commandId: randomUUID(), title: "Synthetic assessment", instructions: "", categoryId: category, dueOn: String(term.starts_on).slice(0, 10), maxPointsUnits: 10000 });
    const current = await api("/school/gradebooks/" + book.id);
    await api("/school/grade-assignments/" + assignment.id + "/scores", { bookVersion: current.book.version, version: assignment.version, scores: [{ studentId: student.id, status: "scored", pointsUnits: 9500, note: "" }], reason }, "put");
    for (const action of ["submit", "lock"]) { const d = await api("/school/gradebooks/" + book.id); await api("/school/gradebooks/" + book.id + "/review", { version: d.book.version, action, reason, acknowledgeMissing: true, acknowledgeNoGrade: true }); }
  }
  const card = await api("/school/report-cards/open", { studentId: student.id, yearId: year.id, termIds: terms.map(t => t.id) });
  await api("/school/report-cards/" + card.id + "/issue", { version: card.version, commandId: randomUUID(), reason, reviewed: true, acknowledgeNoGrade: false, acknowledgeMissing: false });
  const issue = (await db.query("SELECT id FROM report_card_issues WHERE card_id=$1 ORDER BY number DESC LIMIT 1", [card.id])).rows[0];
  const catalog = await standingPolicyCatalog(db, owner, auth.hash, { unitId, yearId: year.id });
  const draft = await changeStandingPolicy(db, owner, auth.hash, "create", { unitId, yearId: year.id, catalogHash: catalog.catalogHash, commandId: randomUUID(), reason,
    configuration: { name: "Synthetic honors " + tag, termIds: terms.map(t => t.id), gradeLevels: ["Synthetic"], courseRules: [course, ...(absent ? [absent] : [])].map(c => ({ courseId: c.id, disposition: "include", required: true, reason })),
      minimumIncludedCourses: 1, missingWork: "disqualify", basis: "awarded_label", acceptedGradingPolicies: catalog.gradingPolicies.map(r => ({ hash: r.hash, version: r.version, allowedLabels: ["A"] })) } });
  const confirmed = await changeStandingPolicy(db, owner, auth.hash, "confirm", { expectedVersion: draft.policy.version, draftHash: draft.policy.draftHash, catalogHash: draft.policy.catalogHash, sourceDescription: "Synthetic signed school source example", reason, reviewed: true, commandId: randomUUID() }, draft.policy.id);
  const input = { policyVersionId: confirmed.confirmed!.policyVersionId, studentId: student.id, yearId: year.id, termId: terms[0].id, reportCardIssueId: issue.id };
  return { year, terms, student, course, absent, section, books, card, issue, confirmed, input, scope: { unitId, studentId: student.id, yearId: year.id, policyId: confirmed.policy.id } };
}
const retainInput = (preview: StandingPreview) => ({ previewId: preview.id, previewHash: preview.previewHash, expectedPolicyVersionId: preview.data.policyVersion.id,
  expectedCardVersion: preview.data.expected.cardVersion, expectedLatestDecisionId: preview.data.expected.latestDecisionId, reviewed: true as const, reason, commandId: randomUUID() });
async function counts(policyId: string) { return (await db.query(`SELECT
  (SELECT count(*)::int FROM standing_decisions WHERE policy_id=$1) AS decisions,(SELECT count(*)::int FROM standing_series WHERE policy_id=$1) AS series,
  (SELECT count(*)::int FROM standing_decision_commands c JOIN standing_decisions d ON d.id=c.decision_id WHERE d.policy_id=$1) AS commands`, [policyId])).rows[0]; }
function wrapped(handler: (tx: Queryable, sql: string, params?: any[]) => Promise<void>) {
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { await handler(tx, sql, params); return tx.query<R>(sql, params); } })) } as Database;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "decisions.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  const units = (await db.query("SELECT id FROM units ORDER BY id")).rows; unitId = units[0].id; otherUnit = units[1].id;
  owner = { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, mode: "password", unit_ids: units.map(r => r.id) } as Actor;
  auth = await session(owner); officer = await person(); second = await person(); officeAuth = await session(officer); secondAuth = await session(second); await grant(officer); await grant(second);
});
after(async () => { await db?.close(); });

test("strict decision input rejects client results, actor claims and truthy latestOnly coercion", () => {
  const input = { policyVersionId: randomUUID(), studentId: randomUUID(), yearId: randomUUID(), termId: randomUUID(), reportCardIssueId: randomUUID() };
  assert.ok(prepareStandingInput.safeParse(input).success);
  for (const extra of [{ orgId: randomUUID() }, { result: { outcome: "qualifies" } }, { source: {} }, { actorId: randomUUID() }]) assert.equal(prepareStandingInput.safeParse({ ...input, ...extra }).success, false);
  assert.equal(retainStandingInput.safeParse({ reviewed: false }).success, false);
  const scope = { unitId: randomUUID(), studentId: randomUUID(), yearId: randomUUID() };
  assert.equal(standingDecisionListInput.parse({ ...scope, latestOnly: "false" }).latestOnly, false);
  assert.equal(standingDecisionListInput.parse({ ...scope, latestOnly: "true" }).latestOnly, true);
  for (const latestOnly of [true, "1", "yes", ["true"]]) assert.equal(standingDecisionListInput.safeParse({ ...scope, latestOnly }).success, false);
});

test("review, retain, institutional history and fixed exports preserve exact bytes and confirmation provenance", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input);
  assert.equal(preview.data.result.outcome, "qualifies"); assert.ok(standingReviewDataSchema.safeParse(preview.data).success);
  assert.deepEqual(preview.data.policyConfirmation.confirmedBy, f.confirmed.confirmed!.confirmedBy);
  assert.equal(preview.data.policyConfirmation.sourceDescription, f.confirmed.confirmed!.sourceDescription);
  const saved = await retainStanding(db, officer, officeAuth.hash, retainInput(preview)); assert.equal(saved.replayed, false); assert.equal(saved.decision.number, 1);
  const detail = await getStandingDecision(db, second, secondAuth.hash, saved.decision.id); assert.equal(detail.decision.data.result.outcome, "qualifies");
  assert.deepEqual(detail.decision.data, preview.data);
  const json = await exportStandingDecision(db, second, secondAuth.hash, saved.decision.id, { format: "json" });
  const csv = await exportStandingDecision(db, second, secondAuth.hash, saved.decision.id, { format: "csv" });
  assert.equal(digest(json.content), saved.decision.jsonHash); assert.equal(digest(csv.content), saved.decision.csvHash);
  assert.ok(json.content.endsWith("\n") && !json.content.startsWith("\uFEFF")); assert.ok(csv.content.startsWith("\uFEFF") && csv.content.includes("\r\n"));
  assert.ok(csv.content.includes("'" + preview.data.labels.studentName) && csv.content.includes("'" + preview.data.labels.studentNumber));
  for (const label of ["policy_source_description", "policy_confirmation_reason", "policy_confirmed_by_id", "policy_confirmed_at", preview.data.policyConfirmation.sourceDescription, preview.data.policyConfirmation.confirmedAt]) assert.ok(csv.content.includes(label), label);
  const listed = await listStandingDecisions(db, second, secondAuth.hash, { ...f.scope, latestOnly: "true" }); assert.equal(listed.items[0].id, saved.decision.id); assert.equal(listed.nextCursor, null);
  assert.equal((await standingDecisionCurrentness(db, second, secondAuth.hash, saved.decision.id)).state, "matches_current_sources");
  const audits = (await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [saved.decision.id])).rows;
  const text = JSON.stringify(audits); assert.ok(!text.includes(f.student.id) && !text.includes("qualifies") && !text.includes(reason));
});

test("private preview access differs from institutional decision access and expiry/consumption", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input);
  assert.deepEqual(await getStandingPreview(db, officer, officeAuth.hash, preview.id), preview);
  await assert.rejects(getStandingPreview(db, second, secondAuth.hash, preview.id), denied);
  const saved = await retainStanding(db, officer, officeAuth.hash, retainInput(preview));
  await assert.rejects(getStandingPreview(db, officer, officeAuth.hash, preview.id), denied);
  assert.equal((await getStandingDecision(db, second, secondAuth.hash, saved.decision.id)).decision.id, saved.decision.id);
});

test("committed retry survives consumed/purged preview and source/policy changes before busy retry", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input), input = retainInput(preview);
  const saved = await retainStanding(db, officer, officeAuth.hash, input);
  await db.query("DELETE FROM standing_previews WHERE id=$1", [preview.id]);
  await changeStandingPolicy(db, owner, auth.hash, "archive", { expectedVersion: f.confirmed.policy.version, archived: true, commandId: randomUUID(), reason }, f.confirmed.policy.id);
  await db.query("UPDATE school_people SET name='Renamed synthetic student',version=version+1 WHERE id=(SELECT person_id FROM students WHERE id=$1)", [f.student.id]);
  const timed = wrapped(async (_tx, sql) => { if (sql.startsWith("SELECT * FROM standing_decision_commands")) throw Object.assign(new Error("synthetic wait"), { code: "55P03" }); });
  await assert.rejects(retainStanding(timed, officer, officeAuth.hash, input), (e: any) => e.status === 503);
  const retried = await retainStanding(db, officer, officeAuth.hash, input); assert.equal(retried.replayed, true); assert.deepEqual(retried.decision, saved.decision);
  assert.deepEqual(await counts(f.confirmed.policy.id), { decisions: 1, series: 1, commands: 1 });
  await assert.rejects(retainStanding(db, officer, officeAuth.hash, { ...input, reason: "Different synthetic reason" }), conflict);
});

test("two reviewers cannot both replace the same predecessor and later decision retains chain", async () => {
  const f = await fixture(), a = await prepareStanding(db, officer, officeAuth.hash, f.input), b = await prepareStanding(db, second, secondAuth.hash, f.input);
  const results = await Promise.allSettled([retainStanding(db, officer, officeAuth.hash, retainInput(a)), retainStanding(db, second, secondAuth.hash, retainInput(b))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); for (const r of results) if (r.status === "rejected") assert.ok(conflict(r.reason));
  const first = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof retainStanding>>>).value.decision;
  const next = await prepareStanding(db, second, secondAuth.hash, f.input); assert.equal(next.data.expected.latestDecisionId, first.id);
  const saved = await retainStanding(db, second, secondAuth.hash, retainInput(next)); assert.equal(saved.decision.number, 2); assert.equal(saved.decision.supersedesId, first.id);
  const history = await listStandingDecisions(db, second, secondAuth.hash, f.scope); assert.equal(history.items.length, 2);
  assert.deepEqual(history.items.filter(r => r.latest).map(r => r.id), [saved.decision.id]);
});

test("required absent course is incomplete and carries readable immutable course labels", async () => {
  const f = await fixture({ missingCourse: true }), preview = await prepareStanding(db, officer, officeAuth.hash, f.input);
  assert.equal(preview.data.result.outcome, "incomplete");
  assert.ok(preview.data.result.blockers.some(r => r.code === "missing_required_course" && r.courseId === f.absent!.id));
  const saved = await retainStanding(db, officer, officeAuth.hash, retainInput(preview));
  const csv = await exportStandingDecision(db, officer, officeAuth.hash, saved.decision.id, { format: "csv" });
  assert.ok(csv.content.includes(f.absent!.title) && csv.content.includes(f.absent!.code) && csv.content.includes('"blocker"'));
});

test("changed source after preview is rejected while earlier immutable decision remains downloadable", async () => {
  const f = await fixture(), first = await prepareStanding(db, officer, officeAuth.hash, f.input), saved = await retainStanding(db, officer, officeAuth.hash, retainInput(first));
  const before = await exportStandingDecision(db, officer, officeAuth.hash, saved.decision.id, { format: "json" });
  const preview = await prepareStanding(db, officer, officeAuth.hash, f.input);
  await db.query("UPDATE school_people SET name='Synthetic changed name',version=version+1 WHERE id=(SELECT person_id FROM students WHERE id=$1)", [f.student.id]);
  await assert.rejects(retainStanding(db, officer, officeAuth.hash, retainInput(preview)), conflict);
  assert.equal((await standingDecisionCurrentness(db, officer, officeAuth.hash, saved.decision.id)).state, "source_changed");
  assert.deepEqual(await exportStandingDecision(db, officer, officeAuth.hash, saved.decision.id, { format: "json" }), before);
});

test("current role, explicit membership, office grant, MFA and session still protect receipts and history", async () => {
  const f = await fixture(), user = await person(), a = await session(user); await grant(user);
  const preview = await prepareStanding(db, user, a.hash, f.input), input = retainInput(preview), saved = await retainStanding(db, user, a.hash, input);
  await grant(user, false);
  await assert.rejects(retainStanding(db, { ...user, role: "owner" }, a.hash, input), denied);
  await assert.rejects(getStandingDecision(db, user, a.hash, saved.decision.id), denied);
  await grant(user); await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [user.id, unitId]);
  await assert.rejects(listStandingDecisions(db, user, a.hash, f.scope), denied);
  await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [user.org_id, user.id, unitId]);
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused','synthetic-unused',now(),now())", [user.id, user.org_id, randomUUID()]);
  await assert.rejects(retainStanding(db, user, a.hash, input), denied);
  await db.query("UPDATE sessions SET mfa_verified=true WHERE token_hash=$1", [a.hash]); assert.equal((await retainStanding(db, user, a.hash, input)).replayed, true);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [a.hash]); await assert.rejects(getStandingDecision(db, user, a.hash, saved.decision.id), denied);
  const finance = await person("finance"), fin = await session(finance); await assert.rejects(eligibleStandingIssues(db, finance, fin.hash, { unitId, studentId: f.student.id, yearId: f.year.id, termId: f.terms[0].id }), denied);
});

test("audit failure and final-session expiry roll back decision, pointer, consumption and receipt", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input), input = retainInput(preview);
  const auditFailure = wrapped(async (_tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) throw new Error("synthetic late audit failure"); });
  await assert.rejects(retainStanding(auditFailure, officer, officeAuth.hash, input), /synthetic late audit failure/);
  const expiry = wrapped(async (tx, sql) => { if (sql.startsWith("INSERT INTO audit_events")) await tx.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [officeAuth.hash]); });
  await assert.rejects(retainStanding(expiry, officer, officeAuth.hash, input), denied);
  assert.deepEqual(await counts(f.confirmed.policy.id), { decisions: 0, series: 0, commands: 0 });
  assert.deepEqual(await getStandingPreview(db, officer, officeAuth.hash, preview.id), preview);
});

test("HTTP decision routes enforce current sessions, strict queries, CSRF and exact attachment protocol", async () => {
  const f = await fixture(), app = application(), base = "/api/school/standing";
  const issueQuery = { unitId, studentId: f.student.id, yearId: f.year.id, termId: f.terms[0].id };
  assert.equal((await request(app).get(base + "/eligible-issues").query(issueQuery)).status, 401);
  const pin = await session(officer, "pin");
  assert.equal((await request(app).get(base + "/eligible-issues").query(issueQuery).set("Cookie", pin.cookie)).status, 403);
  const token = await api("/tokens", { name: "Synthetic decision read denial", days: 1, scopes: ["reports:read"] });
  assert.equal((await request(app).get(base + "/eligible-issues").query(issueQuery).set("Authorization", "Bearer " + token.token)).status, 403);
  const available = await request(app).get(base + "/eligible-issues").query(issueQuery).set("Cookie", officeAuth.cookie);
  assert.equal(available.status, 200); assert.equal(available.headers["cache-control"], "private, no-store"); assert.equal(available.body.items[0].issueId, f.issue.id);
  const post = (path: string, body: object) => request(app).post(base + path).set("Cookie", officeAuth.cookie).set("Origin", origin).set("X-CSRF-Token", officeAuth.csrf).send(body);
  assert.equal((await request(app).post(base + "/previews").set("Cookie", officeAuth.cookie).set("Origin", origin).send(f.input)).status, 403);
  assert.equal((await request(app).post(base + "/previews").set("Cookie", officeAuth.cookie).set("Origin", "https://foreign.example.test").set("X-CSRF-Token", officeAuth.csrf).send(f.input)).status, 403);
  assert.equal((await post("/previews", { ...f.input, policyVersionId: "invalid" })).status, 400);
  assert.equal((await post("/previews", { ...f.input, result: { outcome: "qualifies" } })).status, 400);
  const prepared = await post("/previews", f.input); assert.equal(prepared.status, 201); assert.equal(prepared.headers["cache-control"], "private, no-store");
  const command = retainInput(prepared.body);
  assert.equal((await post("/decisions", { ...command, actor: { role: "owner" } })).status, 400);
  assert.equal((await post("/decisions", { ...command, commandId: "not-a-uuid" })).status, 400);
  const saved = await post("/decisions", command), replay = await post("/decisions", command);
  assert.equal(saved.status, 201); assert.equal(replay.status, 200); assert.deepEqual(replay.body, saved.body);
  assert.equal(saved.headers["cache-control"], "private, no-store"); assert.equal(saved.body.replayed, undefined);
  const next = await prepareStanding(db, officer, officeAuth.hash, f.input); await retainStanding(db, officer, officeAuth.hash, retainInput(next));
  const history = await request(app).get(base + "/decisions").query({ ...f.scope, latestOnly: "false" }).set("Cookie", officeAuth.cookie);
  const latest = await request(app).get(base + "/decisions").query({ ...f.scope, latestOnly: "true" }).set("Cookie", officeAuth.cookie);
  assert.equal(history.body.items.length, 2); assert.equal(latest.body.items.length, 1);
  for (const suffix of ["&latestOnly=true&latestOnly=false", "&latestOnly[enabled]=true", "&termId[]=a&termId[]=b", "&latestOnly=yes"])
    assert.equal((await request(app).get(base + "/decisions?" + new URLSearchParams(f.scope).toString() + suffix).set("Cookie", officeAuth.cookie)).status, 400);
  for (const format of ["json", "csv"] as const) {
    const expected = await exportStandingDecision(db, officer, officeAuth.hash, saved.body.id, { format });
    const file = await request(app).get(base + "/decisions/" + saved.body.id + "/export").query({ format }).set("Cookie", officeAuth.cookie).buffer(true)
      .parse((response, callback) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => callback(null, Buffer.concat(chunks))); });
    assert.equal(file.status, 200); assert.equal(file.headers["cache-control"], "private, no-store");
    assert.match(file.headers["content-disposition"], /^attachment; filename="standing-decision-/);
    assert.equal(file.headers["x-stjw-file-sha256"], expected.fileHash); assert.deepEqual(file.body, Buffer.from(expected.content));
    assert.equal(digest(file.body.toString("utf8")), expected.fileHash);
  }
  const user = await person(), a = await session(user); await grant(user);
  assert.equal((await request(app).get(base + "/decisions/" + saved.body.id).set("Cookie", a.cookie)).status, 200);
  await grant(user, false);
  assert.equal((await request(app).get(base + "/decisions/" + saved.body.id).set("Cookie", a.cookie)).status, 404);
});

test("actual pages above fifty preserve all latest series and reject a newly replaced unseen series", async () => {
  const f = await fixture(), choices = new Map<string, typeof f.input>();
  choices.set(f.confirmed.policy.id, f.input);
  // Real policy/source/retain services keep every cloned parent's constraints,
  // hashes and institutional envelope valid; no mutation protections are disabled.
  for (let i = 0; i < 50; i++) {
    const draft = await changeStandingPolicy(db, owner, auth.hash, "create", { unitId, yearId: f.year.id, catalogHash: f.confirmed.policy.catalogHash,
      configuration: { ...f.confirmed.policy.configuration, name: "Synthetic paging policy " + i }, reason, commandId: randomUUID() });
    const confirmed = await changeStandingPolicy(db, owner, auth.hash, "confirm", { expectedVersion: draft.policy.version, draftHash: draft.policy.draftHash,
      catalogHash: draft.policy.catalogHash, sourceDescription: "Synthetic paging policy source", reason, reviewed: true, commandId: randomUUID() }, draft.policy.id);
    choices.set(draft.policy.id, { ...f.input, policyVersionId: confirmed.confirmed!.policyVersionId });
  }
  for (const input of choices.values()) { const preview = await prepareStanding(db, officer, officeAuth.hash, input); await retainStanding(db, officer, officeAuth.hash, retainInput(preview)); }
  const { policyId: _policyId, ...scope } = f.scope;
  for (const latestOnly of ["false", "true"]) {
    const first = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly });
    assert.equal(first.items.length, 50); assert.ok(first.nextCursor); assert.ok(first.nextCursor.length <= 200);
    assert.equal(standingDecisionCursorSchema.parse(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"))).revision, 51);
    const last = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly, cursor: first.nextCursor });
    assert.equal(last.items.length, 1); assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.items, ...last.items].map(r => r.id)).size, 51);
  }
  const first = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly: "true" });
  const tail = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly: "true", cursor: first.nextCursor! });
  const unseen = tail.items[0], preview = await prepareStanding(db, second, secondAuth.hash, choices.get(unseen.policyId)!);
  const replacement = await retainStanding(db, second, secondAuth.hash, retainInput(preview));
  assert.equal(replacement.decision.supersedesId, unseen.id);
  for (const latestOnly of ["true", "false"]) await assert.rejects(listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly, cursor: first.nextCursor! }), conflict);
  const restarted = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly: "true" });
  const rest = await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, latestOnly: "true", cursor: restarted.nextCursor! });
  assert.equal(restarted.items[0].id, replacement.decision.id); assert.equal(new Set([...restarted.items, ...rest.items].map(r => r.policyId)).size, 51);
  const full = await listStandingDecisions(db, officer, officeAuth.hash, scope);
  assert.equal((await listStandingDecisions(db, officer, officeAuth.hash, { ...scope, cursor: full.nextCursor! })).items.length, 2);
});

test("preview expiry is checked again after authority work and prevents publication/retention", async () => {
  const f = await fixture();
  // Only this synthetic INSERT has a short actual lifetime; the schema's exact
  // ten-minute difference remains intact. This tests elapsed time, not PG locks.
  const short = wrapped(async (_tx, sql, params) => {
    if (sql.startsWith("INSERT INTO standing_previews")) {
      const expiry = Date.now() + 700;
      params![params!.length - 2] = new Date(expiry - 600000).toISOString(); params![params!.length - 1] = new Date(expiry).toISOString();
    }
  });
  const preview = await prepareStanding(short, officer, officeAuth.hash, f.input);
  let waited = false;
  const delayed = wrapped(async (_tx, sql) => {
    if (!waited && sql.startsWith("SELECT id,org_id,name,email,role,active FROM users")) { waited = true; await new Promise(resolve => setTimeout(resolve, 750)); }
  });
  await assert.rejects(getStandingPreview(delayed, officer, officeAuth.hash, preview.id), denied); assert.ok(waited);
  await assert.rejects(retainStanding(db, officer, officeAuth.hash, retainInput(preview)), denied);
  assert.deepEqual(await counts(f.confirmed.policy.id), { decisions: 0, series: 0, commands: 0 });
});

test("three private previews and organization capacity reject visibly without eviction or partial retention", async () => {
  const f = await fixture(), user = await person(), a = await session(user); await grant(user);
  const previews: StandingPreview[] = [];
  for (let i = 0; i < 3; i++) previews.push(await prepareStanding(db, user, a.hash, f.input));
  await assert.rejects(prepareStanding(db, user, a.hash, f.input), conflict);
  for (const preview of previews) assert.equal((await getStandingPreview(db, user, a.hash, preview.id)).id, preview.id);
  const capped = (kind: "previewCount" | "previewBytes" | "decisionCount" | "decisionBytes") => ({ ...db,
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT count(*)::int AS count") && sql.includes("FROM standing_previews") && kind.startsWith("preview"))
        return { rows: [{ count: kind === "previewCount" ? 100 : 0, bytes: kind === "previewBytes" ? String(128 * 1024 * 1024) : "0", own: 0 }] as unknown as R[] };
      if (sql.startsWith("SELECT count(*)::int AS count") && sql.includes("FROM standing_decisions") && kind.startsWith("decision"))
        return { rows: [{ count: kind === "decisionCount" ? 1000 : 0, bytes: kind === "decisionBytes" ? String(1024 * 1024 * 1024) : "0" }] as unknown as R[] };
      return tx.query<R>(sql, params);
    } })) } as Database);
  for (const kind of ["previewCount", "previewBytes"] as const) await assert.rejects(prepareStanding(capped(kind), second, secondAuth.hash, f.input), conflict);
  const command = retainInput(previews[0]);
  for (const kind of ["decisionCount", "decisionBytes"] as const) await assert.rejects(retainStanding(capped(kind), user, a.hash, command), conflict);
  assert.deepEqual(await counts(f.confirmed.policy.id), { decisions: 0, series: 0, commands: 0 });
  const saved = await retainStanding(db, user, a.hash, command);
  assert.deepEqual((await retainStanding(capped("decisionCount"), user, a.hash, command)).decision, saved.decision);
});

test("database rejects immutable mutations, premature preview purge and invalid deferred chains", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input);
  await assert.rejects(db.query("DELETE FROM standing_previews WHERE id=$1", [preview.id]), /Only expired or consumed/);
  await assert.rejects(db.query("UPDATE standing_previews SET review_text=review_text WHERE id=$1", [preview.id]), /Only first consumption/);
  const saved = await retainStanding(db, officer, officeAuth.hash, retainInput(preview));
  for (const table of ["standing_decisions", "standing_decision_commands"]) {
    const key = table === "standing_decisions" ? "id" : "decision_id";
    for (const sql of ["UPDATE " + table + " SET org_id=org_id WHERE " + key + "=$1", "DELETE FROM " + table + " WHERE " + key + "=$1"])
      await assert.rejects(db.query(sql, [saved.decision.id]), /append-only/i);
  }
  await assert.rejects(db.query("DELETE FROM standing_series WHERE id=$1", [saved.decision.seriesId]), /cannot be deleted/);
  await assert.rejects(db.query("UPDATE standing_series SET latest_number=latest_number+2 WHERE id=$1", [saved.decision.seriesId]), /next standing decision/);
  await assert.rejects(db.query("UPDATE standing_series SET latest_number=latest_number+1,latest_decision_id=$2 WHERE id=$1", [saved.decision.seriesId, randomUUID()]), /foreign key|final retained chain/i);
  const fresh = await fixture();
  await assert.rejects(db.query("INSERT INTO standing_series(id,org_id,unit_id,student_id,year_id,term_id,policy_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), owner.org_id, unitId, fresh.student.id, fresh.year.id, fresh.terms[0].id, fresh.confirmed.policy.id, owner.id]), /final retained chain/i);
  await assert.rejects(db.query("INSERT INTO standing_series(id,org_id,unit_id,student_id,year_id,term_id,policy_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), owner.org_id, unitId, fresh.student.id, fresh.year.id, f.terms[0].id, fresh.confirmed.policy.id, owner.id]), /foreign key/i);
  assert.deepEqual(await counts(fresh.confirmed.policy.id), { decisions: 0, series: 0, commands: 0 });
  await db.query("DELETE FROM standing_previews WHERE id=$1", [preview.id]);
  assert.equal((await getStandingDecision(db, second, secondAuth.hash, saved.decision.id)).decision.id, saved.decision.id);
});

test("retention serializes command before academics and locks authority and selected parents in source order", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input), command = retainInput(preview), seen: string[] = [];
  const observed = wrapped(async (_tx, sql, params) => { seen.push(sql + " " + (params?.[0] ?? "")); });
  const saved = await retainStanding(observed, officer, officeAuth.hash, command);
  const at = (pattern: string) => { const n = seen.findIndex(s => s.includes(pattern)); assert.ok(n >= 0, pattern); return n; };
  const commandLock = at("standing-decision-command:"), academic = at("academic-timetable:"), accounts = at("ORDER BY id FOR SHARE"), policy = at("FOR SHARE OF p"),
    student = at("SELECT id,person_id FROM students"), person = at("SELECT id FROM school_people"), card = at("SELECT id FROM report_cards"), book = at("gradebook:"), seriesLock = at("standing-series:"), quota = at("standing-decisions-quota:");
  assert.ok(commandLock < academic && academic < accounts && accounts < policy && policy < student && student < person && person < card && card < book && book < seriesLock && seriesLock < quota);
  seen.length = 0; assert.deepEqual((await retainStanding(observed, officer, officeAuth.hash, command)).decision, saved.decision);
  assert.ok(!seen.some(s => s.includes("academic-timetable:") || s.includes("standing_previews") || s.includes("gradebook:") || s.includes("standing-decisions-quota:")));
});

test("fresh publication sees changed scope/source after extraction and receipts see current owner demotion", async () => {
  const f = await fixture(), user = await person(), a = await session(user); await grant(user);
  let reached = false;
  const revoked = wrapped(async (tx, sql, params) => {
    if (!reached && sql.includes("pg_advisory_xact_lock") && params?.[0] === "academic-timetable:" + owner.org_id) {
      reached = true; await tx.query("DELETE FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3", [owner.org_id, user.id, unitId]);
    }
  });
  await assert.rejects(prepareStanding(revoked, user, a.hash, f.input), denied); assert.ok(reached);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM standing_previews WHERE prepared_by=$1", [user.id])).rows[0].n, 0);
  reached = false;
  const changedAfterCopy = wrapped(async (tx, sql, params) => {
    if (!reached && sql.includes("pg_advisory_xact_lock") && params?.[0] === "academic-timetable:" + owner.org_id) {
      reached = true; await tx.query("UPDATE school_people SET name='Synthetic changed after extraction',version=version+1 WHERE id=(SELECT person_id FROM students WHERE id=$1)", [f.student.id]);
    }
  });
  await assert.rejects(prepareStanding(changedAfterCopy, user, a.hash, f.input), conflict); assert.ok(reached);
  const admin = await person("admin"), adminAuth = await session(admin), preview = await prepareStanding(db, admin, adminAuth.hash, f.input), input = retainInput(preview);
  const saved = await retainStanding(db, admin, adminAuth.hash, input);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [admin.id]);
  await assert.rejects(retainStanding(db, admin, adminAuth.hash, input), denied);
  await assert.rejects(getStandingDecision(db, admin, adminAuth.hash, saved.decision.id), denied);
  await grant(admin); assert.equal((await retainStanding(db, { ...admin, role: "employee" }, adminAuth.hash, input)).replayed, true);
});

test("historical decisions remain after policy archival and student inactivity; currentness stays a separate observation", async () => {
  const f = await fixture(), preview = await prepareStanding(db, officer, officeAuth.hash, f.input), saved = await retainStanding(db, officer, officeAuth.hash, retainInput(preview));
  const before = await exportStandingDecision(db, second, secondAuth.hash, saved.decision.id, { format: "csv" });
  await changeStandingPolicy(db, owner, auth.hash, "archive", { expectedVersion: f.confirmed.policy.version, archived: true, commandId: randomUUID(), reason }, f.confirmed.policy.id);
  await db.query("UPDATE students SET active=false,version=version+1 WHERE id=$1", [f.student.id]);
  assert.equal((await listStandingDecisions(db, second, secondAuth.hash, f.scope)).items[0].id, saved.decision.id);
  const observation = await standingDecisionCurrentness(db, second, secondAuth.hash, saved.decision.id);
  assert.equal(observation.policyState, "archived"); assert.notEqual(observation.state, "matches_current_sources");
  assert.deepEqual(await exportStandingDecision(db, second, secondAuth.hash, saved.decision.id, { format: "csv" }), before);
  await assert.rejects(prepareStanding(db, second, secondAuth.hash, f.input), (error: any) => [404, 409].includes(error.status));
  const illegal = structuredClone(preview.data) as any; illegal.policyConfirmation.confirmedBy.role = "owner";
  assert.equal(standingReviewDataSchema.safeParse(illegal).success, false);
});
