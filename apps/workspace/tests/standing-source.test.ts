import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { readReportCardSource } from "../server/report-cards";
import { copyStandingSource, normalizeStandingSource, lockStandingSourceAuthority, lockStandingSourceParents,
  assertStandingSourceUnchanged, type StandingSourceCopy, type StandingSourceSelection } from "../server/standing-source";
import { canonicalStandingJson, gradingPolicyEvidenceHash } from "../server/standing-policy-provenance";
import { calculateAcademicStanding } from "../shared/academic-standing";

let db: Database, app: ReturnType<typeof createApp>, owner: Actor, teacher: Actor, unitId: string;
let ownerAuth: { cookie: string; csrf: string; hash: string }, officer: Actor, officerAuth: typeof ownerAuth;
let baseline: Awaited<ReturnType<typeof fixture>>;
const origin = "http://localhost:3179", reason = "Synthetic standing source verification only.";
async function session(actor: Actor) {
  const token = opaqueToken(), csrf = opaqueToken(), hash = digest(token);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')", [hash, actor.org_id, actor.id, csrf]);
  return { cookie: "stjw_session=" + token, csrf, hash };
}
async function api(path: string, body?: unknown, method = "post") {
  const r = body === undefined ? await request(app).get("/api" + path).set("Cookie", ownerAuth.cookie)
    : await (request(app) as any)[method]("/api" + path).set("Cookie", ownerAuth.cookie).set("Origin", origin).set("X-CSRF-Token", ownerAuth.csrf).send(body);
  assert.ok(r.status < 300, `Synthetic API ${path} failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}
const cardPath = (id: string) => "/school/report-cards/" + id;
async function fixture() {
  const tag = randomUUID().slice(0, 8), category = randomUUID();
  const settings = await api("/school/grading/settings?unitId=" + unitId);
  await api("/school/grading/settings", { unitId, version: settings.version, confirmed: true, reason,
    policy: { name: "Synthetic standing scale " + tag, calculation: "total_points", missing: "exclude", emptyCategories: "renormalize",
      allowExtraCredit: true, capAt100: false, decimals: 2, rounding: "nearest", categories: [{ id: category, name: "Work", weight: 10000 }],
      scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 8000 }, { label: "C", minimum: 0 }] } }, "put");
  const year = await api("/school/years", { unitId, name: "Synthetic standing " + tag, startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const terms: Row[] = [];
  for (const [name, startsOn, endsOn] of [["Term 1", "2026-01-01", "2026-06-30"], ["Term 2", "2026-07-01", "2026-12-31"]])
    terms.push(await api("/school/terms", { yearId: year.id, name, startsOn, endsOn }));
  const students: Row[] = [];
  for (const name of ["Selected Student " + tag, "SECRET CLASSMATE " + tag]) {
    const student = await api("/school/students", { unitId, name, studentNumber: randomUUID() });
    await api("/school/students/" + student.id + "/enrollments", { enrollment: { yearId: year.id, gradeLevel: "Synthetic 3", startsOn: "2026-01-01", endsOn: "2026-12-31" } });
    students.push(student);
  }
  const sections: Row[] = [], courses: Row[] = [], books: Array<{id: string; termId: string; sectionId: string}> = [];
  for (let courseIndex = 0; courseIndex < 2; courseIndex++) {
    const course = await api("/school/courses", { unitId, code: "S" + tag + courseIndex, title: "Synthetic course " + courseIndex, description: "" });
    const section = await api("/school/sections", { unitId, yearId: year.id, courseId: course.id, name: "Class " + courseIndex + " " + tag,
      homeroom: false, capacity: 20, teacherIds: [teacher.id] });
    courses.push(course); sections.push(section);
    for (const student of students) await api("/school/sections/" + section.id + "/roster", { studentId: student.id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
    for (const term of terms) {
      const book = await api("/school/gradebooks", { sectionId: section.id, termId: term.id });
      const assignment = await api("/school/grade-assignments", { bookId: book.id, bookVersion: book.version, commandId: randomUUID(), title: "Synthetic assessment",
        instructions: "SECRET INSTRUCTIONS", categoryId: category, dueOn: terms.indexOf(term) ? "2026-09-01" : "2026-03-01", maxPointsUnits: 10000 });
      let detail = await api("/school/gradebooks/" + book.id);
      await api("/school/grade-assignments/" + assignment.id + "/scores", { bookVersion: detail.book.version, version: assignment.version, reason,
        scores: students.map((student, index) => ({ studentId: student.id, status: "scored", pointsUnits: index ? 6500 : 9000 + courseIndex * 500, note: index ? "SECRET CLASSMATE NOTE" : "Synthetic recorded grade" })) }, "put");
      for (const action of ["submit", "lock"]) {
        detail = await api("/school/gradebooks/" + book.id);
        await api("/school/gradebooks/" + book.id + "/review", { version: detail.book.version, action, reason, acknowledgeMissing: true, acknowledgeNoGrade: true });
      }
      books.push({ id: book.id, termId: term.id, sectionId: section.id });
    }
  }
  let card = await api("/school/report-cards/open", { studentId: students[0].id, yearId: year.id, termIds: terms.map(term => term.id) });
  const cells = card.cells.map((cell: any) => ({ ...cell, included: cell.sectionId !== sections[1].id, exclusionReason: cell.sectionId === sections[1].id ? "Synthetic print exclusion only." : "" }));
  await api(cardPath(card.id) + "/save", { version: card.version, presentation: card.presentation, cells, reason, commandId: randomUUID() });
  card = (await api(cardPath(card.id))).card;
  const result = await api(cardPath(card.id) + "/issue", { version: card.version, reviewed: true, acknowledgeMissing: false, acknowledgeNoGrade: false, reason, commandId: randomUUID() });
  const issue = (await db.query("SELECT id FROM report_card_issues WHERE card_id=$1 ORDER BY number DESC LIMIT 1", [card.id])).rows[0];
  return { year, terms, students, sections, courses, books, cardId: card.id, issueId: issue.id, result,
    selection: { studentId: students[0].id, yearId: year.id, termId: terms[0].id, reportCardIssueId: issue.id } satisfies StandingSourceSelection };
}
function mapped(tx: Queryable, change: (sql: string, rows: Row[], params: any[]) => Row[]): Queryable {
  return { query: async <T extends Row = Row>(sql: string, params: any[] = []) => {
    const result = await tx.query<T>(sql, params);
    return { ...result, rows: change(sql, structuredClone(result.rows), params) as T[] };
  } };
}
async function copy(f = baseline, actor = owner, change?: Parameters<typeof mapped>[1]) {
  return db.transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return copyStandingSource(change ? mapped(tx, change) : tx, actor, f.selection);
  });
}
function policyFor(value: StandingSourceCopy) {
  const normalized = normalizeStandingSource(value).source;
  const references = normalized.cells.flatMap(cell => cell.gradingPolicy ? [cell.gradingPolicy] : []);
  return { schemaVersion: 1, policyId: randomUUID(), version: 1, orgId: owner.org_id, unitId, yearId: value.selection.yearId,
    name: "Synthetic configured standing", termIds: [value.selection.termId], gradeLevels: ["Synthetic 3"],
    courseRules: normalized.cells.map(cell => ({ courseId: cell.courseId, disposition: "include", required: true, reason: "Synthetic course requirement" })),
    minimumIncludedCourses: 2, missingWork: "use_reviewed_grade", basis: "recorded_percentage", perCourseMinimum: "90",
    meanCondition: { kind: "equal_weight", minimum: "90" }, acceptedGradingPolicies: [...new Map(references.map(reference => [reference.hash, reference])).values()] };
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "standing-source.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  unitId = (await db.query("SELECT id FROM units WHERE kind='school'")).rows[0].id;
  owner = { ...row, mode: "password", unit_ids: [unitId] } as Actor;
  app = createApp(db, { origin, production: false, staffDomain: "stjw.org", demo: true }); ownerAuth = await session(owner);
  for (const [index, name] of ["Synthetic source teacher", "Synthetic source officer"].entries()) {
    const email = randomUUID() + "@stjw.org", id = await db.transaction(tx => createStaff(tx, owner, { name, email, role: "employee", unitIds: [unitId], jobIds: [] }, "stjw.org"));
    const actor = { ...owner, id, email, name, role: "employee" as const };
    if (!index) teacher = actor; else officer = actor;
  }
  await api("/school/office-grants", { userId: officer.id, unitId, enabled: true });
  officerAuth = await session(officer);
  baseline = await fixture();
});
after(async () => { await db?.close(); });

test("standing copy verifies actual immutable issue and released policy while selecting only one student/term", async () => {
  const value = await copy(), normalized = normalizeStandingSource(value);
  assert.equal(normalized.source.cells.length, 2); assert.equal(value.issuedSource.cells.length, 4);
  assert.equal(normalized.source.current.sourceState, "matches_issue");
  assert.equal(normalized.source.cells.filter(cell => !cell.printedIncluded).length, 1);
  assert.equal(normalized.labels.courses.find(course => course.printDisposition === "excluded")?.printedExclusionReason, "Synthetic print exclusion only.");
  assert.equal(calculateAcademicStanding(policyFor(value), normalized.source).outcome, "qualifies");
  for (const release of value.evidence.selectedReleases) {
    assert.equal(release.hash, digest(canonicalStandingJson(release.projection)));
    assert.equal(release.projection.gradingPolicy.hash, gradingPolicyEvidenceHash(release.capturedPolicy));
    assert.equal(release.projection.grade.provisional, false);
  }
  const bytes = JSON.stringify(value);
  for (const secret of [baseline.students[1].id, "SECRET CLASSMATE", "SECRET CLASSMATE NOTE", "SECRET INSTRUCTIONS", "scores", "assignments", "password", "token", "csrf"])
    assert.ok(!bytes.includes(secret), "Source copy must not contain unrelated/private class inputs: " + secret);
});

test("transaction-only card wrapper preserves existing source ordering and hash through JSONB round trips", async () => {
  const value = await copy();
  const again = await db.transaction(tx => readReportCardSource(tx, owner, { studentId: baseline.selection.studentId, yearId: baseline.year.id, termIds: baseline.terms.map(term => term.id) }, value.issuedSource.cells));
  assert.equal(digest(canonicalStandingJson(again)), value.issue.sourceHash);
  assert.deepEqual(value, await copy());
});

test("fresh phase follows academic/account/organization/student SHARE ordering and unchanged proof", async () => {
  const value = await copy();
  const queries: Array<{ sql: string; params: any[] }> = [];
  await db.transaction(async tx => {
    const observed = mapped(tx, (sql, rows, params) => { queries.push({ sql, params }); return rows; });
    const authority = await lockStandingSourceAuthority(observed, owner, ownerAuth.hash, value);
    await lockStandingSourceParents(observed, authority, value, baseline.courses.map(course => course.id));
    const fresh = await copyStandingSource(observed, authority.actor, baseline.selection);
    assertStandingSourceUnchanged(value, fresh, authority);
  });
  const find = (part: string) => queries.findIndex(query => query.sql.includes(part));
  assert.ok(find("pg_advisory_xact_lock") < find("ORDER BY id FOR SHARE"));
  assert.ok(find("FROM organizations WHERE") < find("FROM units WHERE"));
  assert.ok(find("SELECT id,person_id FROM students") < find("SELECT id FROM school_people"));
  assert.ok(find("SELECT id,person_id FROM students") < find("SELECT id FROM gradebooks"));
  assert.ok(!queries.some(query => query.sql.includes("FOR UPDATE")), "adapter must not upgrade student or other parents");
  const users = queries.find(query => query.sql.includes("FROM users") && query.sql.includes("ANY($2"))!.params[1];
  assert.deepEqual(users, [...users].sort());
  assert.ok(queries.some(query => query.params[0] === "gradebook:" + baseline.sections[0].id + ":" + baseline.terms[0].id));
});

for (const [name, change] of [
  ["issue hash", (row: Row) => { row.snapshot_hash = "0".repeat(64); }],
  ["source hash", (row: Row) => { row.snapshot.sourceHash = "0".repeat(64); row.snapshot_hash = digest(canonicalStandingJson(row.snapshot)); }],
  ["source student identity", (row: Row) => { row.snapshot.source.student.id = randomUUID(); row.source_snapshot = row.snapshot.source; row.source_hash = row.snapshot.sourceHash = digest(canonicalStandingJson(row.snapshot.source)); row.snapshot_hash = digest(canonicalStandingJson(row.snapshot)); }],
  ["duplicate presentation cell", (row: Row) => { row.snapshot.cells[1] = row.snapshot.cells[0]; row.cells = row.snapshot.cells; row.snapshot_hash = digest(canonicalStandingJson(row.snapshot)); }],
] as const) test("rejects corrupted " + name + " before returning source", async () => {
  await assert.rejects(copy(baseline, owner, (sql, rows) => {
    if (sql.includes("i.snapshot_hash") && rows[0]) change(rows[0]);
    return rows;
  }), (error: any) => error.status === 422);
});

for (const [name, change] of [
  ["book binding", (row: Row) => { row.captured_book_id = randomUUID(); }],
  ["captured policy version", (row: Row) => { row.policy_version += 1; }],
  ["selected result value", (row: Row) => { row.result.percentage = "99.00"; }],
  ["duplicate selected result", (row: Row) => { row.result_count = 2; }],
  ["missing provisional field", (row: Row) => { delete row.result.provisional; }],
  ["released membership dates", (row: Row) => { row.result.starts_on = "2026-01-02"; }],
] as const) test("rejects contradictory released " + name, async () => {
  await assert.rejects(copy(baseline, owner, (sql, rows) => {
    if (sql.includes("AS captured_book_id") && rows[0]) change(rows[0]); return rows;
  }), (error: any) => error.status === 422);
});

test("password/current office scope is required despite stale supplied role and unit claims", async () => {
  await assert.rejects(copy(baseline, { ...teacher, role: "owner" }), (error: any) => error.status === 404);
  await assert.rejects(copy(baseline, { ...owner, mode: "pin" }), (error: any) => error.status === 403);
  await assert.rejects(copy(baseline, { ...owner, org_id: randomUUID() }), (error: any) => error.status === 404);
  const value = await copy(baseline, officer);
  await api("/school/office-grants", { userId: officer.id, unitId, enabled: false });
  await assert.rejects(db.transaction(tx => lockStandingSourceAuthority(tx, officer, officerAuth.hash, value)), (error: any) => error.status === 404);
  await api("/school/office-grants", { userId: officer.id, unitId, enabled: true });
  const expired = await session(officer);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [expired.hash]);
  await assert.rejects(db.transaction(tx => lockStandingSourceAuthority(tx, officer, expired.hash, value)), (error: any) => error.status === 401);
  await assert.rejects(db.transaction(tx => lockStandingSourceAuthority(tx, officer, "", value)), (error: any) => error.status === 401);
});

test("source comparison rejects changes and an unheld reviewer dependency", async () => {
  const value = await copy();
  await db.transaction(async tx => {
    const authority = await lockStandingSourceAuthority(tx, owner, ownerAuth.hash, value);
    const changed = structuredClone(value); changed.evidence.comparisonHash = "0".repeat(64);
    assert.throws(() => assertStandingSourceUnchanged(value, changed, authority), (error: any) => error.status === 422);
    assert.throws(() => assertStandingSourceUnchanged(value, value, { ...authority, lockedUserIds: [] }), (error: any) => error.status === 409);
  });
});

test("raw captured policy whitespace survives validation/copy/normalization with its exact evidence hash", async () => {
  const value = await copy(baseline, owner, (sql, rows) => {
    if (sql.includes("AS captured_book_id")) for (const row of rows) row.policy.categories[0].name = "  Work  ";
    return rows;
  });
  const normalized = normalizeStandingSource(value);
  for (const release of normalized.evidence.selectedReleases) {
    assert.equal(release.capturedPolicy.categories[0].name, "  Work  ");
    assert.equal(release.projection.gradingPolicy.hash, gradingPolicyEvidenceHash(release.capturedPolicy));
    const trimmed = structuredClone(release.capturedPolicy); trimmed.categories[0].name = "Work";
    assert.notEqual(release.projection.gradingPolicy.hash, gradingPolicyEvidenceHash(trimmed));
  }
});

test("release queries are explicit bounded projections and never return a full class snapshot", async () => {
  let projections = 0;
  await copy(baseline, owner, (sql, rows, params) => {
    if (!sql.includes("AS captured_book_id")) return rows;
    projections++;
    assert.ok(sql.includes("CASE WHEN octet_length((g.snapshot->'book'->'policy')::text)<=$5"));
    assert.ok(sql.includes("WHERE g.id=$1 AND g.org_id=$2 AND g.unit_id=$3"));
    assert.ok(sql.includes("r->>'student_id'=$4 LIMIT 1"));
    assert.equal(params[3], baseline.students[0].id); assert.equal(params[4], 8 * 1024 * 1024);
    assert.ok(rows.length <= 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "org_id", "unit_id", "book_id", "book_version", "created_by", "created_at", "captured_book_id", "captured_org_id", "captured_unit_id", "captured_version", "captured_status", "policy_version", "policy", "section_id", "course_id", "term_id", "year_id", "result_count", "result"].sort());
    assert.deepEqual(Object.keys(rows[0].result).sort(), ["student_id", "starts_on", "ends_on", "percentage", "label", "pending", "missing", "incomplete", "hasEvidence", "provisional"].sort());
    return rows;
  });
  assert.equal(projections, 2);
});

test("a printed exclusion with an already reopened book cannot supply an eligible reviewed grade", async () => {
  const f = await fixture(), book = f.books.find(book => book.sectionId === f.sections[1].id && book.termId === f.terms[0].id)!;
  const detail = await api("/school/gradebooks/" + book.id);
  await api("/school/gradebooks/" + book.id + "/review", { version: detail.book.version, action: "reopen", reason, acknowledgeMissing: true, acknowledgeNoGrade: true });
  let card = await api(cardPath(f.cardId));
  await api(cardPath(f.cardId) + "/reopen", { version: card.card.version, reason, commandId: randomUUID() });
  card = await api(cardPath(f.cardId));
  await api(cardPath(f.cardId) + "/reconcile", { version: card.card.version, sourceHash: card.currentSourceHash, reason, commandId: randomUUID() });
  card = await api(cardPath(f.cardId));
  await api(cardPath(f.cardId) + "/issue", { version: card.card.version, reviewed: true, acknowledgeMissing: false, acknowledgeNoGrade: false, reason, commandId: randomUUID() });
  const issue = (await db.query("SELECT id FROM report_card_issues WHERE card_id=$1 ORDER BY number DESC LIMIT 1", [f.cardId])).rows[0];
  f.selection.reportCardIssueId = issue.id;
  const value = await copy(f), normalized = normalizeStandingSource(value);
  assert.equal(normalized.source.current.sourceState, "matches_issue");
  const excluded = normalized.source.cells.find(cell => cell.sectionId === f.sections[1].id)!;
  assert.equal(excluded.release, null); assert.equal(excluded.grade, null);
  assert.equal(value.evidence.selectedReleases.length, 2, "retain the old actual projection only as evidence");
  const configuration = policyFor(value);
  // policyFor expects accepted refs from available classes; the stale cell has
  // none, so use verified immutable refs to configure this explicit include test.
  configuration.acceptedGradingPolicies = [value.evidence.selectedReleases[0].projection.gradingPolicy];
  const result = calculateAcademicStanding(configuration, normalized.source);
  assert.equal(result.outcome, "incomplete");
  assert.ok(result.blockers.some(blocker => blocker.sectionId === excluded.sectionId && blocker.code === "missing_release"));
});

test("whole-card currentness notices other-term review changes without substituting selected issued grades", async () => {
  const f = await fixture(), original = await copy(f);
  const book = f.books.find(book => book.termId === f.terms[1].id)!;
  const detail = await api("/school/gradebooks/" + book.id);
  await api("/school/gradebooks/" + book.id + "/review", { version: detail.book.version, action: "reopen", reason, acknowledgeMissing: true, acknowledgeNoGrade: true });
  const changed = await copy(f), normalized = normalizeStandingSource(changed);
  assert.equal(normalized.source.current.sourceState, "source_changed");
  assert.deepEqual(normalized.source.cells.map(cell => cell.grade), normalizeStandingSource(original).source.cells.map(cell => cell.grade));
  assert.equal(calculateAcademicStanding(policyFor(changed), normalized.source).outcome, "incomplete");
});

test("new roster classes remain expected current-only cells with no fabricated issued grade", async () => {
  const f = await fixture();
  const section = await api("/school/sections", { unitId, yearId: f.year.id, courseId: f.courses[0].id, name: "New synthetic class " + randomUUID().slice(0, 6), homeroom: false, capacity: 20, teacherIds: [teacher.id] });
  await api("/school/sections/" + section.id + "/roster", { studentId: f.students[0].id, startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const value = await copy(f), normalized = normalizeStandingSource(value);
  const added = normalized.source.cells.find(cell => cell.sectionId === section.id)!;
  assert.equal(added.sourceState, "source_changed"); assert.equal(added.release, null); assert.equal(added.grade, null);
  assert.equal(normalized.labels.courses.find(course => course.sectionId === section.id)!.printDisposition, "not_in_issue");
  await db.transaction(async tx => {
    const authority = await lockStandingSourceAuthority(tx, owner, ownerAuth.hash, value);
    const keys: string[] = [];
    await lockStandingSourceParents(mapped(tx, (sql, rows, params) => { if (sql.includes("pg_advisory_xact_lock") && typeof params[0] === "string") keys.push(params[0]); return rows; }), authority, value);
    assert.ok(keys.includes("gradebook:" + section.id + ":" + f.terms[0].id), "absent book is protected by its parent advisory key");
  });
});

test("reopened or older card entry fails before treating changed draft source as corruption", async () => {
  await assert.rejects(copy(baseline, owner, (sql, rows) => {
    if (sql.includes("i.snapshot_hash") && rows[0]) { rows[0].status = "draft"; rows[0].version += 1; }
    return rows;
  }), (error: any) => error.status === 409);
  await assert.rejects(copy(baseline, owner, (sql, rows) => {
    if (sql.includes("i.snapshot_hash") && rows[0]) rows[0].latest_issue_id = randomUUID();
    return rows;
  }), (error: any) => error.status === 409);
});
