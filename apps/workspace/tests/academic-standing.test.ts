import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { ZodError } from "zod";
import { calculateGrade, type GradingPolicy } from "../shared/grading";
import { AcademicStandingValidationError, calculateAcademicStanding, standingPolicySchema, standingSourceSchema, standingResultSchema, standingPercentageUnits, type StandingInput, type StandingPolicy, type StandingSource } from "../shared/academic-standing";

// Explicit synthetic rules only; these fixtures do not configure an organization.
const hashA = "a".repeat(64), hashB = "b".repeat(64), hashC = "c".repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
function fixture(percentages = ["90", "90", "90"]): StandingInput {
  const identity = { orgId: randomUUID(), unitId: randomUUID(), yearId: randomUUID(), studentId: randomUUID(), termId: randomUUID(), gradeLevel: "Synthetic" };
  const courses = percentages.map(() => randomUUID()), issueId = randomUUID(), cardId = randomUUID();
  const policy: StandingPolicy = { schemaVersion: 1, policyId: randomUUID(), version: 1,
    orgId: identity.orgId, unitId: identity.unitId, yearId: identity.yearId, name: "Synthetic eligibility policy",
    termIds: [identity.termId], gradeLevels: [identity.gradeLevel], minimumIncludedCourses: Math.max(1, percentages.length), missingWork: "use_reviewed_grade",
    courseRules: courses.map(courseId => ({ courseId, disposition: "include", required: true, reason: "Explicit synthetic included course" })),
    basis: "recorded_percentage", perCourseMinimum: "90", meanCondition: { kind: "equal_weight", minimum: "90" }, acceptedGradingPolicies: [{ hash: hashA, version: 1 }],
  };
  const source: StandingSource = { schemaVersion: 1, identity,
    issue: { id: issueId, cardId, number: 1, cardVersion: 4, hash: hashB, sourceHash: hashC, termIds: [identity.termId], orgId: identity.orgId, unitId: identity.unitId, yearId: identity.yearId, studentId: identity.studentId },
    current: { cardId, cardVersion: 4, latestIssueId: issueId, cardState: "issued", sourceHash: hashC, sourceState: "matches_issue" },
    cells: percentages.map((percentage, index) => ({ sectionId: randomUUID(), courseId: courses[index], termId: identity.termId, printedIncluded: true, sourceState: "matches_issue",
      gradingPolicy: { hash: hashA, version: 1 }, release: { id: randomUUID(), bookId: randomUUID(), bookVersion: 3, hash: hashB, reviewedAt: "2026-01-05T13:00:00.000Z" },
      grade: { percentage, label: "A", pending: 0, missing: 0, incomplete: false, hasEvidence: true, provisional: false },
    })),
  };
  return { policy, source };
}
function numeric(f: StandingInput) { assert.equal(f.policy.basis, "recorded_percentage"); return f.policy as Extract<StandingPolicy, { basis: "recorded_percentage" }>; }
function labelPolicy(f: StandingInput, allowedLabels = ["A"]): StandingPolicy {
  const { perCourseMinimum: _minimum, meanCondition: _mean, ...base } = numeric(f);
  return { ...base, basis: "awarded_label", acceptedGradingPolicies: [{ hash: hashA, version: 1, allowedLabels }] };
}
function calculate(f: StandingInput) { return calculateAcademicStanding(f.policy, f.source); }
function hasBlocker(result: ReturnType<typeof calculate>, code: string) { return result.blockers.some(x => x.code === code); }

test("strict synthetic policies have no defaults and reject unsupported policy choices", () => {
  const f = fixture();
  for (const field of ["basis", "termIds", "gradeLevels", "minimumIncludedCourses", "missingWork", "acceptedGradingPolicies", "courseRules"]) {
    const raw: any = clone(f.policy); delete raw[field]; assert.throws(() => standingPolicySchema.parse(raw), ZodError, field);
  }
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, classRank: true }), ZodError);
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, meanCondition: { kind: "credit_weighted", minimum: "90" } }), ZodError);
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, courseRules: [{ courseId: randomUUID(), disposition: "include", reason: "Explicit synthetic course" }] }), ZodError);
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, courseRules: [{ courseId: randomUUID(), disposition: "exclude", required: false, reason: "Explicit synthetic exclusion" }] }), ZodError);
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, acceptedGradingPolicies: [{ hash: hashA, version: 1, allowExtraCredit: true }] }), ZodError);
  assert.throws(() => standingPolicySchema.parse({ ...f.policy, acceptedGradingPolicies: [{ hash: hashA, version: 1 }, { hash: hashA, version: 1 }] }), ZodError);
});
test("equality qualifies and one hundredth below a configured course threshold fails", () => {
  const f = fixture(["90.00"]), equal = calculate(f); assert.equal(equal.outcome, "qualifies");
  assert.deepEqual(equal.mean, { numerator: "9000", denominator: "100", unit: "percentage_points", display: "90.00", displayRule: "half_up_2dp", minimum: "90", meetsMinimum: true });
  f.source.cells[0].grade!.percentage = "89.99";
  const below = calculate(f); assert.equal(below.outcome, "does_not_qualify"); assert.equal(below.courses[0].failures[0], "below_course_minimum");
});
test("the exact mean never uses the rounded displayed summary for eligibility", () => {
  const f = fixture(["89.99", "90"]); numeric(f).perCourseMinimum = "0";
  const result = calculate(f); assert.equal(result.outcome, "does_not_qualify");
  assert.deepEqual(result.mean, { numerator: "17999", denominator: "200", unit: "percentage_points", display: "90.00", displayRule: "half_up_2dp", minimum: "90", meetsMinimum: false });
  assert.deepEqual(result.failures.map(x => x.code), ["below_mean_minimum"]);
  f.source.cells[0].grade!.percentage = "90.00"; assert.equal(calculate(f).outcome, "qualifies");
});
test("repeating means retain rational evidence without rounding inputs", () => {
  const f = fixture(["89.99", "90.00", "90.00"]); numeric(f).perCourseMinimum = "0";
  const result = calculate(f); assert.equal(result.mean!.numerator, "26999"); assert.equal(result.mean!.denominator, "300"); assert.equal(result.mean!.display, "90.00"); assert.equal(result.outcome, "does_not_qualify");
  numeric(f).meanCondition = { kind: "equal_weight", minimum: "89.99" }; assert.equal(calculate(f).outcome, "qualifies");
});
test("recorded percentages and awarded labels deliberately diverge at grade display boundaries", () => {
  const f = fixture(["90"]), categoryId = randomUUID();
  const grading: GradingPolicy = { name: "Synthetic rounded display", calculation: "total_points", missing: "zero", emptyCategories: "renormalize", allowExtraCredit: false, capAt100: true, decimals: 0, rounding: "nearest", categories: [{ id: categoryId, name: "Synthetic", weight: 10000 }], scale: [{ label: "A", minimum: 9000 }, { label: "B", minimum: 0 }] };
  const grade = calculateGrade(grading, [{ categoryId, maxPointsUnits: 10000, pointsUnits: 8999, status: "scored" }]);
  assert.equal(grade.percentage, "90"); assert.equal(grade.label, "B");
  const { percentage, label, pending, missing, incomplete, hasEvidence, provisional } = grade;
  f.source.cells[0].grade = { percentage, label, pending, missing, incomplete, hasEvidence, provisional };
  const capturedHash = createHash("sha256").update(JSON.stringify(grading)).digest("hex");
  f.source.cells[0].gradingPolicy!.hash = capturedHash; numeric(f).acceptedGradingPolicies = [{ hash: capturedHash, version: 1 }];
  assert.equal(calculate(f).outcome, "qualifies");
  const labels = labelPolicy(f); if (labels.basis === "awarded_label") labels.acceptedGradingPolicies = [{ hash: capturedHash, version: 1, allowedLabels: ["A"] }];
  const result = calculateAcademicStanding(labels, f.source); assert.equal(result.outcome, "does_not_qualify"); assert.equal(result.courses[0].failures[0], "label_not_allowed"); assert.equal(result.mean, null);
});
test("accepted labels belong to their exact captured policy hash and version", () => {
  const f = fixture(["90", "90"]); f.policy = labelPolicy(f);
  assert.equal(f.policy.basis, "awarded_label");
  if (f.policy.basis !== "awarded_label") return;
  f.policy.acceptedGradingPolicies.push({ hash: hashB, version: 2, allowedLabels: ["B"] });
  f.source.cells[1].gradingPolicy = { hash: hashB, version: 2 };
  assert.equal(calculate(f).outcome, "does_not_qualify");
  f.source.cells[1].grade!.label = "B"; assert.equal(calculate(f).outcome, "qualifies");
  f.source.cells[1].gradingPolicy.version = 1;
  const unknown = calculate(f); assert.equal(unknown.outcome, "incomplete"); assert.ok(hasBlocker(unknown, "unsupported_grading_policy"));
});
test("completeness blocks all eligibility decisions even when another recorded result fails", () => {
  const f = fixture(["20", "90"]); f.source.cells[1].release = null;
  const result = calculate(f); assert.equal(result.outcome, "incomplete"); assert.equal(result.mean, null); assert.deepEqual(result.failures, []);
  assert.equal(result.courses[0].outcome, "not_evaluated"); assert.equal(result.courses[1].outcome, "incomplete"); assert.ok(hasBlocker(result, "missing_release"));
});
test("missing, provisional, incomplete and evidence flags stay distinct from a recorded zero", () => {
  const changes: [string, (s: StandingSource) => void][] = [
    ["missing_grade", s => { s.cells[0].grade = null; }], ["no_evidence", s => { s.cells[0].grade!.hasEvidence = false; }],
    ["pending_grade", s => { s.cells[0].grade!.pending = 1; }], ["pending_grade", s => { s.cells[0].grade!.provisional = true; }],
    ["incomplete_grade", s => { s.cells[0].grade!.incomplete = true; }], ["no_recorded_percentage", s => { s.cells[0].grade!.percentage = null; }],
  ];
  for (const [code, change] of changes) { const f = fixture(["90"]); change(f.source); const result = calculate(f); assert.equal(result.outcome, "incomplete", code); assert.ok(hasBlocker(result, code), code); }
  const zero = fixture(["0"]); assert.equal(calculate(zero).outcome, "does_not_qualify"); assert.deepEqual(calculate(zero).blockers, []);
  zero.policy = labelPolicy(zero); zero.source.cells[0].grade!.label = null; assert.ok(hasBlocker(calculate(zero), "no_awarded_label"));
});
test("the explicitly selected missing-work rule does not rescore a reviewed grade", () => {
  const f = fixture(["95"]); f.source.cells[0].grade!.missing = 2;
  assert.equal(calculate(f).outcome, "qualifies"); f.policy.missingWork = "disqualify";
  const result = calculate(f); assert.equal(result.outcome, "does_not_qualify"); assert.equal(result.courses[0].grade!.percentage, "95"); assert.equal(result.courses[0].grade!.missing, 2); assert.deepEqual(result.courses[0].failures, ["recorded_missing_work"]);
});
test("print exclusions have no standing authority; policy exclusions retain every row and reason", () => {
  const f = fixture(["90", "20"]); f.policy.minimumIncludedCourses = 1; f.source.cells[1].printedIncluded = false;
  assert.equal(calculate(f).outcome, "does_not_qualify");
  const excludedCourse = f.source.cells[1].courseId!;
  f.policy.courseRules[1] = { courseId: excludedCourse, disposition: "exclude", reason: "Explicit synthetic course exclusion" };
  f.source.cells[1].release = null; f.source.cells[1].grade = null; f.source.cells[1].gradingPolicy = null;
  f.source.cells.push({ ...clone(f.source.cells[1]), sectionId: randomUUID() });
  const result = calculate(f); assert.equal(result.outcome, "qualifies"); assert.equal(result.includedCourseCount, 1); assert.deepEqual(result.courses.slice(1).map(x => x.outcome), ["excluded", "excluded"]);
  assert.ok(result.courses.slice(1).every(x => x.policyReason === "Explicit synthetic course exclusion" && x.required === null));
  f.source.cells[1].sourceState = "source_changed"; assert.equal(calculate(f).outcome, "incomplete");
});
test("included duplicate and unmapped courses are incomplete instead of selecting a class", () => {
  const f = fixture(["90"]); f.source.cells.push({ ...clone(f.source.cells[0]), sectionId: randomUUID() });
  const duplicate = calculate(f); assert.equal(duplicate.outcome, "incomplete"); assert.equal(duplicate.includedCourseCount, 1); assert.equal(duplicate.courses.filter(x => x.blockers.includes("duplicate_course")).length, 2);
  f.source.cells.pop(); f.source.cells[0].courseId = null; assert.ok(hasBlocker(calculate(f), "unmapped_course"));
  f.source.cells[0].courseId = randomUUID(); assert.ok(hasBlocker(calculate(f), "unclassified_course"));
});
test("a required course absent from the entire source blocks, while optional absence respects explicit minimum", () => {
  const f = fixture(["90", "90", "90"]); f.source.cells.pop();
  assert.ok(hasBlocker(calculate(f), "missing_required_course"));
  const rule = f.policy.courseRules[2]; if (rule.disposition === "include") rule.required = false;
  const complete = calculate(f); assert.equal(complete.outcome, "does_not_qualify"); assert.deepEqual(complete.blockers, []); assert.deepEqual(complete.failures.map(x => x.code), ["minimum_courses"]);
  f.policy.minimumIncludedCourses = 2; assert.equal(calculate(f).outcome, "qualifies");
  f.source.cells = []; const empty = calculate(f); assert.equal(empty.outcome, "incomplete"); assert.ok(hasBlocker(empty, "no_included_courses")); assert.equal(empty.mean, null);
});
test("changed card versions, source hashes and unavailable sources are explicit blockers", () => {
  for (const change of [(s: StandingSource) => { s.current.cardVersion++; }, (s: StandingSource) => { s.current.sourceHash = hashA; }, (s: StandingSource) => { s.current.sourceState = "source_changed"; }, (s: StandingSource) => { s.current.sourceHash = null; }, (s: StandingSource) => { s.current.sourceState = "source_unavailable"; }]) {
    const f = fixture(["90"]); change(f.source); const result = calculate(f); assert.equal(result.outcome, "incomplete"); assert.equal(result.mean, null); assert.equal(result.failures.length, 0);
  }
});
test("scope mismatch, older or reopened cards and mixed terms produce structured validation errors", () => {
  const changes: [string, (f: StandingInput) => void][] = [
    ["scope_mismatch", f => { f.policy.unitId = randomUUID(); }], ["source_identity_mismatch", f => { f.source.issue.studentId = randomUUID(); }],
    ["term_not_applicable", f => { f.policy.termIds = [randomUUID()]; }], ["grade_level_not_applicable", f => { f.source.identity.gradeLevel = "Unconfigured"; }],
    ["issue_not_current", f => { f.source.current.latestIssueId = randomUUID(); }], ["issue_not_current", f => { f.source.current.cardState = "reopened"; }],
    ["source_identity_mismatch", f => { f.source.current.cardId = randomUUID(); }], ["source_identity_mismatch", f => { f.source.cells[0].termId = randomUUID(); }],
  ];
  for (const [code, change] of changes) { const f = fixture(["90"]); change(f); assert.throws(() => calculate(f), (error: unknown) => error instanceof AcademicStandingValidationError && error.code === code && !!error.path); }
});
test("decimal parsing rejects coercion, hidden precision and malformed values", () => {
  for (const value of ["-0", "-1", "+90", " 90", "90 ", "090", ".9", "90.", "90.001", "9e1", "NaN", "Infinity", "1,000", "99999999999999999"]) assert.throws(() => standingPercentageUnits(value), ZodError, value);
  for (const value of [90, true, null]) { const f = fixture(["90"]); (f.source.cells[0].grade as any).percentage = value; if (value === null) assert.equal(calculate(f).outcome, "incomplete"); else assert.throws(() => calculate(f), ZodError); }
  assert.equal(standingPercentageUnits("0"), 0n); assert.equal(standingPercentageUnits("0.01"), 1n); assert.equal(standingPercentageUnits("90.1"), 9010n);
});
test("extra credit and large exact decimal values are preserved without caps or floating conversion", () => {
  const f = fixture(["9007199254740993.01", "9007199254740993.03"]);
  numeric(f).perCourseMinimum = "9007199254740993.01"; numeric(f).meanCondition = { kind: "equal_weight", minimum: "9007199254740993.02" };
  const result = calculate(f); assert.equal(result.outcome, "qualifies"); assert.equal(result.mean!.numerator, "1801439850948198604"); assert.equal(result.mean!.denominator, "200"); assert.equal(result.mean!.display, "9007199254740993.02");
  numeric(f).meanCondition = { kind: "equal_weight", minimum: "9007199254740993.03" }; assert.equal(calculate(f).outcome, "does_not_qualify");
  const extra = fixture(["105.25"]); assert.equal(calculate(extra).courses[0].grade!.percentage, "105.25"); assert.equal(calculate(extra).outcome, "qualifies");
});
test("the cell cap is explicit and a complete 200-course source retains every contributor", () => {
  const f = fixture(Array.from({ length: 200 }, (_, n) => n % 2 ? "99.99" : "100.01"));
  numeric(f).meanCondition = { kind: "equal_weight", minimum: "100" };
  const result = calculate(f); assert.equal(result.outcome, "qualifies"); assert.equal(result.includedCourseCount, 200); assert.equal(result.courses.length, 200); assert.equal(result.mean!.numerator, "2000000"); assert.equal(result.mean!.denominator, "20000");
  f.source.cells.push(clone(f.source.cells[0])); assert.throws(() => standingSourceSchema.parse(f.source), ZodError);
});
test("the pure engine is deterministic, JSON-safe and never mutates frozen source or policy", () => {
  const f = fixture(["90", "92"]), original = JSON.stringify(f);
  function freeze(value: any) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
  freeze(f); const a = calculate(f), b = calculate(f); assert.deepEqual(a, b); assert.equal(JSON.stringify(f), original);
  assert.deepEqual(standingResultSchema.parse(JSON.parse(JSON.stringify(a))), a);
  a.courses[0].grade!.percentage = "0"; assert.equal(f.source.cells[0].grade!.percentage, "90");
});
test("no mean condition never introduces an implicit term-average threshold or calculation", () => {
  const f = fixture(["0", "100"]); numeric(f).perCourseMinimum = "0"; numeric(f).meanCondition = { kind: "none" };
  const result = calculate(f); assert.equal(result.outcome, "qualifies"); assert.equal(result.mean, null);
  numeric(f).perCourseMinimum = "1"; assert.equal(calculate(f).outcome, "does_not_qualify");
});
test("each eligibility basis requires its own recorded value without inventing the other one", () => {
  const f = fixture(["90"]); f.source.cells[0].grade!.label = null; assert.equal(calculate(f).outcome, "qualifies");
  f.policy = labelPolicy(f, ["Pass"]); f.source.cells[0].grade!.percentage = null; f.source.cells[0].grade!.label = "Pass";
  assert.equal(calculate(f).outcome, "qualifies");
  f.source.cells[0].grade!.label = "pass"; assert.equal(calculate(f).outcome, "does_not_qualify");
});
test("conflicting class/course identities and unnormalized class-grade payloads cannot become extra courses", () => {
  const f = fixture(["90", "90"]); f.source.cells[1].sectionId = f.source.cells[0].sectionId;
  assert.throws(() => calculate(f), (error: unknown) => error instanceof AcademicStandingValidationError && error.code === "source_identity_mismatch");
  f.source.cells[1].sectionId = randomUUID(); (f.source.cells[0].grade as any).scores = [{ otherStudent: randomUUID() }];
  assert.throws(() => calculate(f), ZodError);
});
test("duplicate identical excluded class cells reject while distinct excluded classes remain valid", () => {
  const f = fixture(["90", "90"]); f.policy.minimumIncludedCourses = 1;
  f.policy.courseRules[1] = { courseId: f.source.cells[1].courseId!, disposition: "exclude", reason: "Explicit synthetic exclusion" };
  f.source.cells.push(clone(f.source.cells[1]));
  assert.throws(() => calculate(f), (error: unknown) => error instanceof AcademicStandingValidationError && error.code === "source_identity_mismatch");
  f.source.cells[2].sectionId = randomUUID();
  const result = calculate(f); assert.equal(result.outcome, "qualifies"); assert.equal(result.courses.filter(x => x.outcome === "excluded").length, 2);
});
