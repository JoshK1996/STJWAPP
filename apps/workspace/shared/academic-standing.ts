import { z } from "zod";

/** Pure, per-term calculator only. The future server adapter must establish current
 * authority, confirmed policy, issued-card identity, complete source discovery and
 * captured grading-policy/release hashes. This module does none of those actions. */
export const standingCalculatorVersion = "term-standing-v1" as const;
export const standingLimits = Object.freeze({ cells: 200, terms: 8, policies: 200, decimalIntegerDigits: 16 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(20);
const reason = z.string().trim().min(5).max(1000);
// The length bound is an engineering limit, not a school percentage ceiling.
export const standingDecimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/);
const policyReference = z.object({ hash, version: positive }).strict();
const labelPolicyReference = policyReference.extend({ allowedLabels: z.array(label).min(1).max(20) }).strict();
const courseRule = z.discriminatedUnion("disposition", [
  z.object({ courseId: id, disposition: z.literal("include"), required: z.boolean(), reason }).strict(),
  z.object({ courseId: id, disposition: z.literal("exclude"), reason }).strict(),
]);
const commonPolicy = {
  schemaVersion: z.literal(1), policyId: id, version: positive,
  orgId: id, unitId: id, yearId: id, name: z.string().trim().min(2).max(120),
  termIds: z.array(id).min(1).max(standingLimits.terms),
  gradeLevels: z.array(z.string().min(1).max(30)).min(1).max(50),
  courseRules: z.array(courseRule).min(1).max(standingLimits.cells),
  minimumIncludedCourses: z.number().int().min(1).max(standingLimits.cells),
  missingWork: z.enum(["use_reviewed_grade", "disqualify"]),
};
export const standingPolicySchema = z.discriminatedUnion("basis", [
  z.object({ ...commonPolicy, basis: z.literal("awarded_label"), acceptedGradingPolicies: z.array(labelPolicyReference).min(1).max(standingLimits.policies) }).strict(),
  z.object({ ...commonPolicy, basis: z.literal("recorded_percentage"), acceptedGradingPolicies: z.array(policyReference).min(1).max(standingLimits.policies),
    perCourseMinimum: standingDecimalSchema,
    meanCondition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("equal_weight"), minimum: standingDecimalSchema }).strict(),
    ]),
  }).strict(),
]).superRefine((policy, ctx) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [path], message: "Choose each identity once." });
  };
  unique(policy.termIds, "termIds"); unique(policy.gradeLevels, "gradeLevels");
  unique(policy.courseRules.map(x => x.courseId), "courseRules");
  unique(policy.acceptedGradingPolicies.map(x => x.hash + ":" + x.version), "acceptedGradingPolicies");
  if (policy.basis === "awarded_label") for (const [index, item] of policy.acceptedGradingPolicies.entries()) {
    if (new Set(item.allowedLabels).size !== item.allowedLabels.length)
      ctx.addIssue({ code: "custom", path: ["acceptedGradingPolicies", index, "allowedLabels"], message: "Choose each awarded label once." });
  }
});
export type StandingPolicy = z.infer<typeof standingPolicySchema>;

const identity = z.object({ orgId: id, unitId: id, yearId: id, studentId: id }).strict();
const gradeSchema = z.object({
  percentage: standingDecimalSchema.nullable(), label: label.nullable(),
  pending: z.number().int().min(0).max(10000), missing: z.number().int().min(0).max(10000),
  incomplete: z.boolean(), hasEvidence: z.boolean(), provisional: z.boolean(),
}).strict();
const releaseSchema = z.object({ id, bookId: id, bookVersion: positive, hash, reviewedAt: z.iso.datetime({ offset: true }) }).strict();
const sourceState = z.enum(["matches_issue", "source_changed", "source_unavailable"]);
const cellSchema = z.object({
  sectionId: id, courseId: id.nullable(), termId: id, printedIncluded: z.boolean(), sourceState,
  gradingPolicy: policyReference.nullable(), release: releaseSchema.nullable(), grade: gradeSchema.nullable(),
}).strict();
export const standingSourceSchema = z.object({
  schemaVersion: z.literal(1), identity: identity.extend({ gradeLevel: z.string().min(1).max(30), termId: id }).strict(),
  issue: identity.extend({ id, cardId: id, number: positive, cardVersion: positive, hash, sourceHash: hash,
    termIds: z.array(id).min(1).max(standingLimits.terms),
  }).strict(),
  current: z.object({ cardId: id, cardVersion: positive, latestIssueId: id, cardState: z.enum(["issued", "reopened"]), sourceHash: hash.nullable(), sourceState }).strict(),
  cells: z.array(cellSchema).max(standingLimits.cells),
}).strict().superRefine((source, ctx) => {
  if (new Set(source.issue.termIds).size !== source.issue.termIds.length)
    ctx.addIssue({ code: "custom", path: ["issue", "termIds"], message: "Choose each issued term once." });
});
export type StandingSource = z.infer<typeof standingSourceSchema>;
export const standingInputSchema = z.object({ policy: standingPolicySchema, source: standingSourceSchema }).strict();
export type StandingInput = z.infer<typeof standingInputSchema>;

export const standingBlockerCodes = ["source_changed", "source_unavailable", "card_version_changed", "unmapped_course", "unclassified_course", "missing_required_course", "duplicate_course", "missing_release", "missing_grade", "unsupported_grading_policy", "no_evidence", "pending_grade", "incomplete_grade", "no_awarded_label", "no_recorded_percentage", "no_included_courses"] as const;
export const standingFailureCodes = ["label_not_allowed", "below_course_minimum", "recorded_missing_work", "minimum_courses", "below_mean_minimum"] as const;
const blocker = z.object({ code: z.enum(standingBlockerCodes), courseId: id.nullable(), sectionId: id.nullable() }).strict();
const failure = z.object({ code: z.enum(standingFailureCodes), courseId: id.nullable(), sectionId: id.nullable() }).strict();
const rowSchema = z.object({
  sectionId: id, courseId: id.nullable(), printedIncluded: z.boolean(),
  disposition: z.enum(["include", "exclude", "unclassified"]), policyReason: z.string().nullable(), required: z.boolean().nullable(),
  outcome: z.enum(["excluded", "incomplete", "not_evaluated", "passes", "fails"]),
  gradingPolicy: policyReference.nullable(), release: releaseSchema.nullable(), grade: gradeSchema.nullable(),
  blockers: z.array(z.enum(standingBlockerCodes)), failures: z.array(z.enum(standingFailureCodes)),
}).strict();
export const standingResultSchema = z.object({
  schemaVersion: z.literal(1), calculatorVersion: z.literal(standingCalculatorVersion),
  policy: z.object({ id, version: positive, basis: z.enum(["awarded_label", "recorded_percentage"]) }).strict(),
  identity: identity.extend({ gradeLevel: z.string(), termId: id }).strict(),
  issue: z.object({ id, cardId: id, number: positive, cardVersion: positive, hash, sourceHash: hash }).strict(),
  outcome: z.enum(["qualifies", "does_not_qualify", "incomplete"]),
  includedCourseCount: z.number().int().min(0).max(standingLimits.cells), minimumIncludedCourses: z.number().int().positive(),
  courses: z.array(rowSchema).max(standingLimits.cells), blockers: z.array(blocker), failures: z.array(failure),
  mean: z.object({ numerator: z.string().regex(/^\d+$/), denominator: z.string().regex(/^[1-9]\d*$/), unit: z.literal("percentage_points"),
    display: z.string().regex(/^\d+\.\d{2}$/), displayRule: z.literal("half_up_2dp"), minimum: standingDecimalSchema.nullable(), meetsMinimum: z.boolean().nullable(),
  }).strict().nullable(),
}).strict();
export type StandingResult = z.infer<typeof standingResultSchema>;
type StandingRow = StandingResult["courses"][number];
type BlockerCode = typeof standingBlockerCodes[number];
type FailureCode = typeof standingFailureCodes[number];

export class AcademicStandingValidationError extends Error {
  readonly name = "AcademicStandingValidationError";
  constructor(readonly code: "scope_mismatch" | "term_not_applicable" | "grade_level_not_applicable" | "issue_not_current" | "source_identity_mismatch", readonly path: string, message: string) { super(message); }
}
function scope(policy: StandingPolicy, source: StandingSource) {
  for (const key of ["orgId", "unitId", "yearId"] as const) {
    if (policy[key] !== source.identity[key]) throw new AcademicStandingValidationError("scope_mismatch", "source.identity." + key, "The standing policy does not apply to this source scope.");
  }
  for (const key of ["orgId", "unitId", "yearId", "studentId"] as const) {
    if (source.issue[key] !== source.identity[key]) throw new AcademicStandingValidationError("source_identity_mismatch", "source.issue." + key, "The issued card identity differs from the selected source.");
  }
  if (!policy.termIds.includes(source.identity.termId) || !source.issue.termIds.includes(source.identity.termId))
    throw new AcademicStandingValidationError("term_not_applicable", "source.identity.termId", "Choose an explicitly applicable term present in the issued card.");
  if (!policy.gradeLevels.includes(source.identity.gradeLevel))
    throw new AcademicStandingValidationError("grade_level_not_applicable", "source.identity.gradeLevel", "This enrollment grade level is not explicitly covered by the policy.");
  if (source.current.cardId !== source.issue.cardId)
    throw new AcademicStandingValidationError("source_identity_mismatch", "source.current.cardId", "The current card identity differs from the issued source.");
  if (source.current.cardState !== "issued" || source.current.latestIssueId !== source.issue.id)
    throw new AcademicStandingValidationError("issue_not_current", "source.current", "Choose the latest issued copy of a currently issued card.");
  if (source.cells.some(cell => cell.termId !== source.identity.termId))
    throw new AcademicStandingValidationError("source_identity_mismatch", "source.cells", "All normalized course cells must belong to the selected term.");
  const sections = new Set<string>();
  for (const cell of source.cells) {
    if (sections.has(cell.sectionId))
      throw new AcademicStandingValidationError("source_identity_mismatch", "source.cells", "Choose each expected class once within the selected term.");
    sections.add(cell.sectionId);
  }
}
export function standingPercentageUnits(raw: string): bigint {
  const [whole, fraction = ""] = standingDecimalSchema.parse(raw).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function meanEvidence(sum: bigint, count: bigint, minimum: string | null): NonNullable<StandingResult["mean"]> {
  // One display rounding step, after the exact comparison. This display cannot
  // change eligibility; the fraction remains the authoritative arithmetic evidence.
  const meetsMinimum = minimum === null ? null : sum >= standingPercentageUnits(minimum) * count;
  const displayedHundredths = (2n * sum + count) / (2n * count);
  return { numerator: sum.toString(), denominator: (100n * count).toString(), unit: "percentage_points",
    display: (displayedHundredths / 100n).toString() + "." + (displayedHundredths % 100n).toString().padStart(2, "0"),
    displayRule: "half_up_2dp", minimum, meetsMinimum };
}

/** Accept only server-normalized issue/release evidence; never expose this pure
 * function as an endpoint accepting caller-authored grades or authority claims. */
export function calculateAcademicStanding(rawPolicy: unknown, rawSource: unknown): StandingResult {
  const { policy, source } = standingInputSchema.parse({ policy: rawPolicy, source: rawSource });
  scope(policy, source);
  const rules = new Map(policy.courseRules.map(rule => [rule.courseId, rule]));
  const accepted = new Map(policy.acceptedGradingPolicies.map(ref => [ref.hash + ":" + ref.version, ref]));
  const blockers: StandingResult["blockers"] = [], failures: StandingResult["failures"] = [];
  const addBlocker = (code: BlockerCode, courseId: string | null = null, sectionId: string | null = null) => blockers.push({ code, courseId, sectionId });
  if (source.current.cardVersion !== source.issue.cardVersion) addBlocker("card_version_changed");
  if (source.current.sourceState === "source_unavailable" || source.current.sourceHash === null) addBlocker("source_unavailable");
  else if (source.current.sourceState !== "matches_issue" || source.current.sourceHash !== source.issue.sourceHash) addBlocker("source_changed");

  const included = new Map<string, number>();
  for (const cell of source.cells) if (cell.courseId && rules.get(cell.courseId)?.disposition === "include")
    included.set(cell.courseId, (included.get(cell.courseId) ?? 0) + 1);
  for (const rule of policy.courseRules) if (rule.disposition === "include" && rule.required && !included.has(rule.courseId)) addBlocker("missing_required_course", rule.courseId);
  if (!included.size) addBlocker("no_included_courses");

  // Completeness comes before any course/mean eligibility decision. Explicit
  // exclusion is course-level: every mapped occurrence retains its reason while
  // skipping grade/release/evidence tests, even when multiple classes are present.
  const courses: StandingRow[] = source.cells.map(cell => {
    const rule = cell.courseId ? rules.get(cell.courseId) : undefined;
    const row: StandingRow = { sectionId: cell.sectionId, courseId: cell.courseId, printedIncluded: cell.printedIncluded,
      disposition: rule?.disposition ?? "unclassified", policyReason: rule?.reason ?? null, required: rule?.disposition === "include" ? rule.required : null,
      outcome: rule?.disposition === "exclude" ? "excluded" : "not_evaluated", gradingPolicy: cell.gradingPolicy, release: cell.release, grade: cell.grade, blockers: [], failures: [] };
    const block = (code: BlockerCode) => { row.blockers.push(code); addBlocker(code, cell.courseId, cell.sectionId); row.outcome = "incomplete"; };
    if (cell.sourceState !== "matches_issue") block(cell.sourceState);
    if (!cell.courseId) block("unmapped_course");
    else if (!rule) block("unclassified_course");
    if (rule?.disposition !== "include") return row;
    if ((included.get(rule.courseId) ?? 0) > 1) block("duplicate_course");
    if (!cell.release) block("missing_release");
    if (!cell.gradingPolicy || !accepted.has(cell.gradingPolicy.hash + ":" + cell.gradingPolicy.version)) block("unsupported_grading_policy");
    if (!cell.grade) block("missing_grade");
    else {
      if (!cell.grade.hasEvidence) block("no_evidence");
      if (cell.grade.pending > 0 || cell.grade.provisional) block("pending_grade");
      if (cell.grade.incomplete) block("incomplete_grade");
      if (policy.basis === "awarded_label" && cell.grade.label === null) block("no_awarded_label");
      if (policy.basis === "recorded_percentage" && cell.grade.percentage === null) block("no_recorded_percentage");
    }
    return row;
  });
  const result: StandingResult = { schemaVersion: 1, calculatorVersion: standingCalculatorVersion,
    policy: { id: policy.policyId, version: policy.version, basis: policy.basis }, identity: source.identity,
    issue: { id: source.issue.id, cardId: source.issue.cardId, number: source.issue.number, cardVersion: source.issue.cardVersion, hash: source.issue.hash, sourceHash: source.issue.sourceHash },
    outcome: "incomplete", includedCourseCount: included.size, minimumIncludedCourses: policy.minimumIncludedCourses, courses, blockers, failures, mean: null };
  if (blockers.length) return standingResultSchema.parse(result);

  let sum = 0n;
  for (const row of courses) {
    if (row.disposition !== "include") continue;
    const fail = (code: FailureCode) => { row.failures.push(code); failures.push({ code, courseId: row.courseId, sectionId: row.sectionId }); };
    const grade = row.grade!;
    if (policy.missingWork === "disqualify" && grade.missing > 0) fail("recorded_missing_work");
    if (policy.basis === "awarded_label") {
      const ref = policy.acceptedGradingPolicies.find(ref => ref.hash === row.gradingPolicy!.hash && ref.version === row.gradingPolicy!.version)!;
      if (!ref.allowedLabels.includes(grade.label!)) fail("label_not_allowed");
    } else {
      const amount = standingPercentageUnits(grade.percentage!); sum += amount;
      if (amount < standingPercentageUnits(policy.perCourseMinimum)) fail("below_course_minimum");
    }
    row.outcome = row.failures.length ? "fails" : "passes";
  }
  if (included.size < policy.minimumIncludedCourses) failures.push({ code: "minimum_courses", courseId: null, sectionId: null });
  if (policy.basis === "recorded_percentage" && policy.meanCondition.kind === "equal_weight") {
    result.mean = meanEvidence(sum, BigInt(included.size), policy.meanCondition.minimum);
    if (result.mean.meetsMinimum === false) failures.push({ code: "below_mean_minimum", courseId: null, sectionId: null });
  }
  result.outcome = failures.length ? "does_not_qualify" : "qualifies";
  return standingResultSchema.parse(result);
}
