import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { standingSourceSchema } from "../shared/academic-standing";
import {
  calculateTermGpa, termGpaCalculatorVersion, termGpaConfigurationSchema, termGpaDecimalSchema,
  termGpaInputSchema, termGpaPolicySchema, termGpaResultSchema, TermGpaValidationError,
  type TermGpaInput, type TermGpaResult,
} from "../shared/term-gpa";

// All values are synthetic test choices, not configured school policy.
const hashA = "a".repeat(64), hashB = "b".repeat(64), hashC = "c".repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
function fixture(entries = [{ points: "3.25", weight: "1.5" }, { points: "4.1", weight: "0.5" }]): TermGpaInput {
  const identity = { orgId: randomUUID(), unitId: randomUUID(), yearId: randomUUID(), studentId: randomUUID(), termId: randomUUID(), gradeLevel: "Synthetic" };
  const issueId = randomUUID(), cardId = randomUUID(), courses = entries.map(() => randomUUID());
  return {
    policy: {
      schemaVersion: 1, calculatorVersion: termGpaCalculatorVersion, policyId: randomUUID(), version: 1,
      orgId: identity.orgId, unitId: identity.unitId, yearId: identity.yearId, name: "Synthetic GPA policy",
      basis: "awarded_label", formula: "explicit_course_weighted_points", termIds: [identity.termId], gradeLevels: [identity.gradeLevel],
      minimumIncludedCourses: Math.max(1, entries.length), missingWork: "use_reviewed_grade", display: { decimalPlaces: 4, rounding: "half_even" },
      acceptedGradingPolicies: [{ hash: hashA, version: 1, labelRules: entries.map((item, i) => ({ label: `Label${i}`, kind: "points", points: item.points })) }],
      courseRules: entries.map((item, i) => ({ courseId: courses[i], disposition: "include", required: true, weight: item.weight, reason: "Explicit synthetic course" })),
    },
    source: {
      schemaVersion: 1, identity,
      issue: { id: issueId, cardId, number: 1, cardVersion: 4, hash: hashB, sourceHash: hashC, termIds: [identity.termId], orgId: identity.orgId, unitId: identity.unitId, yearId: identity.yearId, studentId: identity.studentId },
      current: { cardId, cardVersion: 4, latestIssueId: issueId, cardState: "issued", sourceHash: hashC, sourceState: "matches_issue" },
      cells: entries.map((_, i) => ({ sectionId: randomUUID(), courseId: courses[i], termId: identity.termId, printedIncluded: true, sourceState: "matches_issue",
        gradingPolicy: { hash: hashA, version: 1 }, release: { id: randomUUID(), bookId: randomUUID(), bookVersion: 3, hash: hashB, reviewedAt: "2026-01-05T13:00:00.000Z" },
        grade: { percentage: "90", label: `Label${i}`, pending: 0, missing: 0, incomplete: false, hasEvidence: true, provisional: false },
      })),
    },
  };
}
const one = (points = "4", weight = "1") => fixture([{ points, weight }]);
function include(f: TermGpaInput, i = 0) {
  const rule = f.policy.courseRules[i]; assert.equal(rule.disposition, "include");
  return rule as Extract<typeof rule, { disposition: "include" }>;
}
function block(f: TermGpaInput, code: string) {
  const result = calculateTermGpa(f);
  assert.equal(result.outcome, "incomplete"); assert.equal(result.totals, null);
  assert.ok(result.blockers.some(item => item.code === code), `${code}: ${JSON.stringify(result.blockers)}`);
  return result;
}

test("GPA schemas require explicit choices and do not add school defaults", () => {
  const f = one();
  for (const field of ["basis", "formula", "termIds", "gradeLevels", "acceptedGradingPolicies", "courseRules", "minimumIncludedCourses", "missingWork", "display", "calculatorVersion"]) {
    const raw: any = clone(f.policy); delete raw[field]; assert.throws(() => termGpaPolicySchema.parse(raw), ZodError, field);
  }
  const { schemaVersion: _schema, calculatorVersion: _calculator, policyId: _id, version: _version, orgId: _org, unitId: _unit, yearId: _year, ...configuration } = f.policy;
  assert.deepEqual(termGpaConfigurationSchema.parse(configuration), configuration);
  assert.throws(() => termGpaConfigurationSchema.parse(f.policy), ZodError);
  for (const raw of [{ ...f, actor: "owner" }, { ...f, policy: { ...f.policy, credits: 1 } }, { ...f, policy: { ...f.policy, basis: "recorded_percentage" } },
    { ...f, policy: { ...f.policy, display: { decimalPlaces: 2 } } }, { ...f, policy: { ...f.policy, display: { decimalPlaces: 2, rounding: "bankers" } } }])
    assert.throws(() => calculateTermGpa(raw), ZodError);
});

test("decimal validation rejects unsupported syntax and keeps zero points distinct from positive weights", () => {
  for (const value of ["-1", "+1", "01", ".5", "1.", "1e3", "NaN", "Infinity", " 1", "1 ", "0.0000001", "10000000000000000", "", "garbage"])
    assert.equal(termGpaDecimalSchema.safeParse(value).success, false, value);
  for (const value of ["0", "0.000000", "1.000000", "9999999999999999.999999"]) assert.equal(termGpaDecimalSchema.parse(value), value);
  for (const value of ["0", "0.000000", "-1", "not a number", "1e4"]) {
    const f = one(); (include(f) as any).weight = value; assert.throws(() => calculateTermGpa(f), ZodError, value);
  }
  assert.equal(calculateTermGpa(one("0", "0.000001")).totals!.gpa.numerator, "0");
});

test("policy uniqueness, engineering bounds and inclusion minimum are enforced", () => {
  const changes: Array<(f: TermGpaInput) => void> = [
    f => f.policy.termIds.push(f.policy.termIds[0]), f => f.policy.gradeLevels.push(f.policy.gradeLevels[0]),
    f => f.policy.courseRules.push(clone(f.policy.courseRules[0])), f => f.policy.acceptedGradingPolicies.push(clone(f.policy.acceptedGradingPolicies[0])),
    f => f.policy.acceptedGradingPolicies[0].labelRules.push(clone(f.policy.acceptedGradingPolicies[0].labelRules[0])),
    f => f.policy.minimumIncludedCourses = 2, f => f.policy.version = 2147483648,
    f => f.policy.display.decimalPlaces = 7, f => f.policy.display.decimalPlaces = 0.5,
    f => f.policy.courseRules[0] = { courseId: f.policy.courseRules[0].courseId, disposition: "exclude", reason: "Explicit synthetic exclusion" },
    f => f.policy.acceptedGradingPolicies[0].labelRules = Array.from({ length: 21 }, (_, i) => ({ label: `Label${i}`, kind: "points", points: "1" })),
  ];
  for (const change of changes) { const f = one(); change(f); assert.throws(() => calculateTermGpa(f), ZodError); }
});

test("weighted GPA uses exact rational products, sums, denominator and final display", () => {
  const result = calculateTermGpa(fixture());
  assert.equal(result.outcome, "calculated"); assert.equal(result.includedCourseCount, 2); assert.equal(result.contributingCourseCount, 2);
  assert.deepEqual(result.totals, { weightedPoints: { numerator: "277", denominator: "40" }, totalWeight: { numerator: "2", denominator: "1" },
    gpa: { numerator: "277", denominator: "80" }, display: "3.4625", displayRule: { decimalPlaces: 4, rounding: "half_even" } });
  assert.deepEqual(result.courses.map(row => row.weightedPoints), [{ numerator: "39", denominator: "8" }, { numerator: "41", denominator: "20" }]);
});

test("each rounding mode handles ties, carries, zero places and six places exactly", () => {
  const vectors = [
    ["0.005", 2, "half_up", "0.01"], ["0.005", 2, "half_even", "0.00"], ["0.005", 2, "truncate", "0.00"],
    ["0.015", 2, "half_even", "0.02"], ["0.025", 2, "half_even", "0.02"], ["0.025001", 2, "half_even", "0.03"],
    ["9.999999", 2, "half_up", "10.00"], ["2.5", 0, "half_even", "2"], ["3.5", 0, "half_even", "4"],
    ["2.5", 0, "half_up", "3"], ["0.000001", 6, "truncate", "0.000001"], ["0", 0, "half_even", "0"],
  ] as const;
  for (const [points, decimalPlaces, rounding, expected] of vectors) {
    const f = one(points); f.policy.display = { decimalPlaces, rounding }; assert.equal(calculateTermGpa(f).totals!.display, expected);
  }
});

test("no per-course rounding occurs before aggregation", () => {
  const f = fixture([{ points: "0.004", weight: "1" }, { points: "0.005", weight: "1" }]);
  f.policy.display = { decimalPlaces: 2, rounding: "half_up" };
  const result = calculateTermGpa(f);
  assert.deepEqual(result.totals!.gpa, { numerator: "9", denominator: "2000" }); assert.equal(result.totals!.display, "0.00");
  assert.deepEqual(result.courses.map(row => row.points), ["0.004", "0.005"]);
});

test("disparate six-place weights retain exact small contributions beyond Number precision", () => {
  const f = fixture([{ points: "1", weight: "9999999999999999.999999" }, { points: "2", weight: "0.000001" }]);
  const result = calculateTermGpa(f);
  assert.deepEqual(result.totals!.gpa, { numerator: "10000000000000000000001", denominator: "10000000000000000000000" });
  assert.deepEqual(result.totals!.totalWeight, { numerator: "10000000000000000", denominator: "1" });
});

test("200 maximum-sized contributors stay exact with bounded output and no overflow", () => {
  const f = one("9999999999999999.999999", "9999999999999999.999999");
  const baseRule = include(f), baseCell = f.source.cells[0];
  f.policy.courseRules = []; f.source.cells = []; f.policy.minimumIncludedCourses = 200;
  for (let i = 0; i < 200; i++) {
    const courseId = randomUUID(); f.policy.courseRules.push({ ...baseRule, courseId });
    f.source.cells.push({ ...clone(baseCell), courseId, sectionId: randomUUID() });
  }
  f.policy.display = { decimalPlaces: 0, rounding: "half_up" };
  const result = calculateTermGpa(f);
  assert.equal(result.contributingCourseCount, 200); assert.deepEqual(result.totals!.gpa, { numerator: "9999999999999999999999", denominator: "1000000" });
  assert.equal(result.totals!.display, "10000000000000000"); assert.ok(result.totals!.weightedPoints.numerator.length <= 64);
  f.source.cells.push({ ...clone(baseCell), sectionId: randomUUID() }); assert.throws(() => calculateTermGpa(f), ZodError);
});

test("zero points produce calculated 0/1 with a positive denominator, not incomplete", () => {
  const result = calculateTermGpa(one("0.000000", "2.500000"));
  assert.equal(result.outcome, "calculated"); assert.deepEqual(result.totals!.gpa, { numerator: "0", denominator: "1" });
  assert.deepEqual(result.totals!.weightedPoints, { numerator: "0", denominator: "1" }); assert.equal(result.totals!.display, "0.0000");
  assert.equal(result.courses[0].points, "0.000000"); assert.equal(result.courses[0].weight, "2.500000");
});

test("equivalent decimal encodings and permuted rows preserve math without rewriting captured text", () => {
  const f = fixture(), before = clone(f), result = calculateTermGpa(f);
  const reverse = clone(f); reverse.source.cells.reverse(); reverse.policy.courseRules.reverse();
  assert.deepEqual(calculateTermGpa(reverse).totals, result.totals); assert.deepEqual(f, before);
  assert.deepEqual(calculateTermGpa(one("1", "1")).totals, calculateTermGpa(one("1.000000", "1.000000")).totals);
  result.courses[0].grade!.label = "changed"; assert.deepEqual(f, before, "parsed result cannot mutate source evidence");
});

test("awarded label controls GPA even when rounded percentage suggests a different scale entry", () => {
  const f = one("2.7"); f.source.cells[0].grade!.percentage = "100.00";
  const result = calculateTermGpa(f); assert.deepEqual(result.totals!.gpa, { numerator: "27", denominator: "10" });
  f.source.cells[0].grade!.percentage = null; assert.deepEqual(calculateTermGpa(f).totals, result.totals);
  f.source.cells[0].grade!.label = null; block(f, "no_awarded_label");
});

test("captured label strings and policy hash/version are exact, without trim or cross-policy fallback", () => {
  const f = one(); f.policy.acceptedGradingPolicies[0].labelRules[0].label = " Label0 "; f.source.cells[0].grade!.label = " Label0 ";
  assert.equal(calculateTermGpa(f).outcome, "calculated");
  f.source.cells[0].grade!.label = "Label0"; block(f, "unmapped_awarded_label");
  f.source.cells[0].grade!.label = " Label0 "; f.source.cells[0].gradingPolicy!.version = 2; block(f, "unsupported_grading_policy");
  f.policy.acceptedGradingPolicies.push({ hash: hashA, version: 2, labelRules: [{ label: " Label0 ", kind: "points", points: "1" }] });
  assert.equal(calculateTermGpa(f).totals!.display, "1.0000");
  f.source.cells[0].gradingPolicy!.hash = hashB; block(f, "unsupported_grading_policy");
});

test("explicit unsupported and absent label mappings never become zero or denominator exclusions", () => {
  const f = fixture(); f.policy.acceptedGradingPolicies[0].labelRules[0] = { label: "Label0", kind: "unsupported", reason: "Synthetic unsupported result" };
  const result = block(f, "unsupported_awarded_label"); assert.equal(result.courses[0].points, null); assert.equal(result.contributingCourseCount, 1);
  f.policy.acceptedGradingPolicies[0].labelRules.splice(0, 1); block(f, "unmapped_awarded_label");
});

test("missing, pending, provisional and incomplete grade evidence blocks a partial overall GPA", () => {
  const cases: Array<[string, (f: TermGpaInput) => void]> = [
    ["missing_release", f => f.source.cells[0].release = null], ["missing_grade", f => f.source.cells[0].grade = null],
    ["unsupported_grading_policy", f => f.source.cells[0].gradingPolicy = null], ["no_evidence", f => f.source.cells[0].grade!.hasEvidence = false],
    ["pending_grade", f => f.source.cells[0].grade!.pending = 1], ["provisional_grade", f => f.source.cells[0].grade!.provisional = true],
    ["incomplete_grade", f => f.source.cells[0].grade!.incomplete = true],
  ];
  for (const [code, change] of cases) {
    const f = fixture(); change(f); const result = block(f, code);
    assert.equal(result.contributingCourseCount, 1); assert.equal(result.courses[0].weightedPoints, null); assert.equal(result.courses[1].outcome, "contributes");
  }
});

test("recorded missing work follows only the explicitly selected behavior", () => {
  const f = one(); f.source.cells[0].grade!.missing = 3;
  assert.equal(calculateTermGpa(f).outcome, "calculated");
  f.policy.missingWork = "block_calculation"; block(f, "recorded_missing_work");
});

test("required missing courses block and absent optional courses neither add weight nor invent zeros", () => {
  const f = fixture(); f.policy.minimumIncludedCourses = 1; f.source.cells.pop();
  block(f, "missing_required_course"); include(f, 1).required = false;
  const result = calculateTermGpa(f); assert.equal(result.outcome, "calculated"); assert.equal(result.includedCourseCount, 1);
  assert.deepEqual(result.totals!.gpa, { numerator: "13", denominator: "4" });
  f.policy.minimumIncludedCourses = 2; block(f, "minimum_courses");
});

test("duplicate included course sections all block, without selecting a best or first result", () => {
  const f = one(); const second = { ...clone(f.source.cells[0]), sectionId: randomUUID() };
  second.grade!.percentage = "0"; f.source.cells.push(second);
  const result = block(f, "duplicate_course"); assert.equal(result.includedCourseCount, 1); assert.equal(result.contributingCourseCount, 0);
  assert.equal(result.courses.filter(row => row.blockers.includes("duplicate_course")).length, 2);
});

test("unmapped and unclassified discovered courses cannot disappear from the denominator silently", () => {
  const f = fixture(); f.source.cells[0].courseId = null; block(f, "unmapped_course");
  f.source.cells[0].courseId = randomUUID(); block(f, "unclassified_course");
});

test("explicit exclusions retain all occurrences without requiring grades, regardless of printed inclusion", () => {
  const f = fixture(); f.policy.minimumIncludedCourses = 1;
  const courseId = f.policy.courseRules[0].courseId;
  f.policy.courseRules[0] = { courseId, disposition: "exclude", reason: "Explicit synthetic exclusion" };
  f.source.cells[0].grade = null; f.source.cells[0].release = null; f.source.cells[0].gradingPolicy = null;
  f.source.cells.push({ ...clone(f.source.cells[0]), sectionId: randomUUID() }); f.source.cells[1].printedIncluded = false;
  const result = calculateTermGpa(f); assert.equal(result.outcome, "calculated"); assert.equal(result.courses.length, 3);
  assert.equal(result.courses.filter(row => row.outcome === "excluded").length, 2); assert.equal(result.contributingCourseCount, 1);
  assert.deepEqual(result.totals!.gpa, { numerator: "41", denominator: "10" });
});

test("source change remains a blocker even on an excluded course and even with otherwise complete grades", () => {
  const f = fixture(); f.policy.minimumIncludedCourses = 1;
  f.policy.courseRules[0] = { courseId: f.policy.courseRules[0].courseId, disposition: "exclude", reason: "Explicit synthetic exclusion" };
  f.source.cells[0].sourceState = "source_changed";
  const result = block(f, "source_changed"); assert.equal(result.courses[0].outcome, "incomplete");
  f.source.cells[0].sourceState = "source_unavailable"; block(f, "source_unavailable");
});

test("whole-card and version freshness block overall results including changes outside the selected term", () => {
  const cases: Array<[string, (f: TermGpaInput) => void]> = [
    ["card_version_changed", f => f.source.current.cardVersion++], ["source_changed", f => f.source.current.sourceHash = hashB],
    ["source_changed", f => f.source.current.sourceState = "source_changed"], ["source_unavailable", f => f.source.current.sourceHash = null],
    ["source_unavailable", f => f.source.current.sourceState = "source_unavailable"],
  ];
  for (const [code, change] of cases) { const f = one(); f.source.issue.termIds.push(randomUUID()); change(f); block(f, code); }
});

test("an empty source matrix never produces denominator zero or a zero GPA", () => {
  const f = one(); f.source.cells = []; include(f).required = false;
  const result = block(f, "no_included_courses"); assert.equal(result.includedCourseCount, 0); assert.equal(result.contributingCourseCount, 0);
  assert.ok(result.blockers.some(item => item.code === "minimum_courses"));
});

test("identity and applicable-scope contradictions throw instead of returning educational outcomes", () => {
  const cases: Array<[string, (f: TermGpaInput) => void]> = [
    ["scope_mismatch", f => f.policy.orgId = randomUUID()], ["scope_mismatch", f => f.policy.unitId = randomUUID()],
    ["scope_mismatch", f => f.policy.yearId = randomUUID()], ["source_identity_mismatch", f => f.source.issue.studentId = randomUUID()],
    ["source_identity_mismatch", f => f.source.issue.unitId = randomUUID()], ["source_identity_mismatch", f => f.source.current.cardId = randomUUID()],
    ["term_not_applicable", f => f.policy.termIds = [randomUUID()]], ["term_not_applicable", f => f.source.issue.termIds = [randomUUID()]],
    ["grade_level_not_applicable", f => f.source.identity.gradeLevel = "Other"], ["issue_not_current", f => f.source.current.cardState = "reopened"],
    ["issue_not_current", f => f.source.current.latestIssueId = randomUUID()], ["source_identity_mismatch", f => f.source.cells[0].termId = randomUUID()],
    ["source_identity_mismatch", f => f.source.cells.push(clone(f.source.cells[0]))],
  ];
  for (const [code, change] of cases) {
    const f = one(); change(f); assert.throws(() => calculateTermGpa(f), (error: unknown) => error instanceof TermGpaValidationError && error.code === code, code);
  }
});

test("source schema is reused unchanged and source structures remain strict", () => {
  assert.strictEqual(termGpaInputSchema.shape.source, standingSourceSchema);
  const f = one(); assert.deepEqual(termGpaInputSchema.parse(f).source, standingSourceSchema.parse(f.source));
  for (const raw of [{ ...f.source, computedGpa: "4" }, { ...f.source, identity: { ...f.source.identity, actorRole: "owner" } },
    { ...f.source, cells: [{ ...f.source.cells[0], grade: { ...f.source.cells[0].grade, override: true } }] }])
    assert.throws(() => calculateTermGpa({ policy: f.policy, source: raw }), ZodError);
  f.source.issue.termIds.push(f.source.issue.termIds[0]); assert.throws(() => calculateTermGpa(f), ZodError);
});

test("strict result validation rejects malformed fractions, changed arithmetic, display and contradictory totals", () => {
  const good = calculateTermGpa(fixture()); assert.deepEqual(termGpaResultSchema.parse(good), good);
  const changes: Array<(result: TermGpaResult) => void> = [
    r => r.totals!.gpa.numerator = "garbage", r => r.totals!.gpa.denominator = "0", r => r.totals!.gpa.numerator = "01",
    r => r.totals!.gpa = { numerator: "554", denominator: "160" }, r => r.totals!.gpa.numerator = "278",
    r => r.totals!.display = "3.46", r => r.totals!.totalWeight = { numerator: "3", denominator: "1" },
    r => r.totals!.weightedPoints = { numerator: "1", denominator: "1" }, r => r.courses[0].points = "not a decimal",
    r => r.courses[0].weight = "0", r => r.courses[0].weightedPoints!.numerator = "1", r => r.contributingCourseCount = 1,
    r => r.includedCourseCount = 1, r => r.outcome = "incomplete", r => r.totals = null,
    r => r.courses[0].outcome = "not_evaluated", r => r.courses[0].grade!.provisional = true,
  ];
  for (const change of changes) { const bad = clone(good); change(bad); assert.throws(() => termGpaResultSchema.parse(bad), ZodError); }
  const incomplete = one(); incomplete.source.cells[0].grade = null; const blocked = calculateTermGpa(incomplete);
  blocked.totals = good.totals; assert.throws(() => termGpaResultSchema.parse(blocked), ZodError);
});

test("row and blocker order is deterministic while every valid contribution remains visible on incomplete reviews", () => {
  const f = fixture(); f.source.cells[0].grade!.hasEvidence = false; f.source.cells[0].grade!.pending = 1;
  f.source.cells[0].grade!.provisional = true; f.source.cells[0].grade!.incomplete = true;
  const result = calculateTermGpa(f);
  assert.deepEqual(result, calculateTermGpa(clone(f)));
  assert.deepEqual(result.courses.map(row => row.sectionId), f.source.cells.map(cell => cell.sectionId));
  assert.deepEqual(result.courses[0].blockers, ["no_evidence", "pending_grade", "provisional_grade", "incomplete_grade"]);
  assert.deepEqual(result.courses[1].weightedPoints, { numerator: "41", denominator: "20" }); assert.equal(result.totals, null);
});
