import { z } from "zod";
import { standingSourceSchema, type StandingSource } from "./academic-standing";

/** Local pure foundation only. The future service must prove current authority,
 * confirmed policy/catalog labels and exact issued-card/release evidence. This
 * function neither establishes that provenance nor configures school rules. */
export const termGpaCalculatorVersion = "term-gpa-v1" as const;
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(2147483647);
const text = (min: number, max: number) => z.string().min(min).max(max).refine(value => value.trim().length >= min, "Enter meaningful text.");
const label = z.string().min(1).max(20); // Exact awarded label; no trimming/case folding.
export const termGpaDecimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?$/);
const scale = 1_000_000n;
function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"));
}
const weight = termGpaDecimalSchema.refine(value => termGpaDecimalSchema.safeParse(value).success && units(value) > 0n, "Included courses require a positive weight.");
const labelRule = z.discriminatedUnion("kind", [
  z.object({ label, kind: z.literal("points"), points: termGpaDecimalSchema }).strict(),
  z.object({ label, kind: z.literal("unsupported"), reason: text(5, 1000) }).strict(),
]);
const courseRule = z.discriminatedUnion("disposition", [
  z.object({ courseId: id, disposition: z.literal("include"), required: z.boolean(), weight, reason: text(5, 1000) }).strict(),
  z.object({ courseId: id, disposition: z.literal("exclude"), reason: text(5, 1000) }).strict(),
]);
const displayRule = z.object({ decimalPlaces: z.number().int().min(0).max(6), rounding: z.enum(["half_up", "half_even", "truncate"]) }).strict();
const configuration = z.object({
  name: text(2, 120), basis: z.literal("awarded_label"), formula: z.literal("explicit_course_weighted_points"),
  termIds: z.array(id).min(1).max(8), gradeLevels: z.array(z.string().min(1).max(30)).min(1).max(50),
  acceptedGradingPolicies: z.array(z.object({ hash, version, labelRules: z.array(labelRule).min(1).max(20) }).strict()).min(1).max(200),
  courseRules: z.array(courseRule).min(1).max(200), minimumIncludedCourses: z.number().int().min(1).max(200),
  missingWork: z.enum(["use_reviewed_grade", "block_calculation"]), display: displayRule,
}).strict();
function validateConfiguration(value: z.infer<typeof configuration>, ctx: z.RefinementCtx) {
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path, message: "Choose each identity once." });
  };
  unique(value.termIds, ["termIds"]); unique(value.gradeLevels, ["gradeLevels"]);
  unique(value.courseRules.map(rule => rule.courseId), ["courseRules"]);
  unique(value.acceptedGradingPolicies.map(ref => `${ref.hash}:${ref.version}`), ["acceptedGradingPolicies"]);
  value.acceptedGradingPolicies.forEach((ref, i) => unique(ref.labelRules.map(rule => rule.label), ["acceptedGradingPolicies", i, "labelRules"]));
  if (value.courseRules.filter(rule => rule.disposition === "include").length < value.minimumIncludedCourses)
    ctx.addIssue({ code: "custom", path: ["minimumIncludedCourses"], message: "The minimum cannot exceed the configured included courses." });
}
export const termGpaConfigurationSchema = configuration.superRefine(validateConfiguration);
export const termGpaPolicySchema = configuration.extend({
  schemaVersion: z.literal(1), calculatorVersion: z.literal(termGpaCalculatorVersion), policyId: id, version,
  orgId: id, unitId: id, yearId: id,
}).strict().superRefine(validateConfiguration);
export const termGpaInputSchema = z.object({ policy: termGpaPolicySchema, source: standingSourceSchema }).strict();
export type TermGpaConfiguration = z.infer<typeof termGpaConfigurationSchema>;
export type TermGpaPolicy = z.infer<typeof termGpaPolicySchema>;
export type TermGpaSource = StandingSource;
export type TermGpaInput = z.infer<typeof termGpaInputSchema>;

function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }
type Fraction = { numerator: string; denominator: string };
function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString() };
}
const fractionSchema = z.object({ numerator: z.string().regex(/^(?:0|[1-9]\d{0,63})$/), denominator: z.string().regex(/^[1-9]\d{0,63}$/) }).strict()
  .refine(value => /^(?:0|[1-9]\d{0,63})$/.test(value.numerator) && /^[1-9]\d{0,63}$/.test(value.denominator) &&
    gcd(BigInt(value.numerator), BigInt(value.denominator)) === 1n, "Fractions must be reduced; zero is 0/1.");
function equalFraction(a: Fraction, b: Fraction) { return a.numerator === b.numerator && a.denominator === b.denominator; }
function displayed(value: Fraction, rule: TermGpaConfiguration["display"]): string {
  const denominator = BigInt(value.denominator), scaled = BigInt(value.numerator) * 10n ** BigInt(rule.decimalPlaces);
  let q = scaled / denominator;
  const twiceRemainder = 2n * (scaled % denominator);
  if ((rule.rounding === "half_up" && twiceRemainder >= denominator) ||
      (rule.rounding === "half_even" && (twiceRemainder > denominator || (twiceRemainder === denominator && q % 2n === 1n)))) q++;
  if (!rule.decimalPlaces) return q.toString();
  const digits = q.toString().padStart(rule.decimalPlaces + 1, "0");
  return `${digits.slice(0, -rule.decimalPlaces)}.${digits.slice(-rule.decimalPlaces)}`;
}
export const termGpaBlockerCodes = [
  "source_changed", "source_unavailable", "card_version_changed", "unmapped_course", "unclassified_course", "missing_required_course",
  "duplicate_course", "missing_release", "missing_grade", "unsupported_grading_policy", "no_evidence", "pending_grade", "incomplete_grade",
  "provisional_grade", "no_awarded_label", "unmapped_awarded_label", "unsupported_awarded_label", "recorded_missing_work", "no_included_courses", "minimum_courses",
] as const;
type BlockerCode = typeof termGpaBlockerCodes[number];
const sourceCell = standingSourceSchema.shape.cells.element;
const rowSchema = z.object({
  sectionId: id, courseId: id.nullable(), printedIncluded: z.boolean(), disposition: z.enum(["include", "exclude", "unclassified"]),
  policyReason: text(5, 1000).nullable(), required: z.boolean().nullable(), outcome: z.enum(["contributes", "excluded", "incomplete", "not_evaluated"]),
  gradingPolicy: sourceCell.shape.gradingPolicy, release: sourceCell.shape.release, grade: sourceCell.shape.grade,
  points: termGpaDecimalSchema.nullable(), weight: weight.nullable(), weightedPoints: fractionSchema.nullable(),
  blockers: z.array(z.enum(termGpaBlockerCodes)).max(termGpaBlockerCodes.length),
}).strict();
const resultBase = z.object({
  schemaVersion: z.literal(1), calculatorVersion: z.literal(termGpaCalculatorVersion),
  policy: z.object({ id, version, basis: z.literal("awarded_label") }).strict(), identity: standingSourceSchema.shape.identity,
  issue: standingSourceSchema.shape.issue.pick({ id: true, cardId: true, number: true, cardVersion: true, hash: true, sourceHash: true }),
  outcome: z.enum(["calculated", "incomplete"]), includedCourseCount: z.number().int().min(0).max(200),
  contributingCourseCount: z.number().int().min(0).max(200), minimumIncludedCourses: z.number().int().min(1).max(200),
  courses: z.array(rowSchema).max(200),
  blockers: z.array(z.object({ code: z.enum(termGpaBlockerCodes), courseId: id.nullable(), sectionId: id.nullable() }).strict()).max(5000),
  totals: z.object({ weightedPoints: fractionSchema, totalWeight: fractionSchema, gpa: fractionSchema,
    display: z.string().regex(/^(?:0|[1-9]\d{0,16})(?:\.\d{1,6})?$/), displayRule,
  }).strict().nullable(),
}).strict();
export const termGpaResultSchema = resultBase.superRefine((value, ctx) => {
  // Regex failures are continuable in Zod; never feed invalid decimal strings to BigInt.
  if (!resultBase.safeParse(value).success) return;
  const invalid = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if ((value.outcome === "calculated") !== (value.totals !== null && value.blockers.length === 0)) invalid(["outcome"], "Only complete evidence has totals.");
  if (value.outcome === "incomplete" && (value.totals !== null || !value.blockers.length)) invalid(["totals"], "Incomplete evidence requires blockers and no totals.");
  if (new Set(value.courses.map(row => row.sectionId)).size !== value.courses.length) invalid(["courses"], "Each section occurs once.");
  const included = value.courses.filter(row => row.disposition === "include");
  const contributing = value.courses.filter(row => row.outcome === "contributes");
  if (new Set(included.map(row => row.courseId)).size !== value.includedCourseCount) invalid(["includedCourseCount"], "Included identity count differs.");
  if (contributing.length !== value.contributingCourseCount || new Set(contributing.map(row => row.courseId)).size !== contributing.length)
    invalid(["contributingCourseCount"], "Contributing identities must be unique and counted exactly.");
  let sum = 0n, weights = 0n;
  value.courses.forEach((row, i) => {
    if ((row.blockers.length > 0) !== (row.outcome === "incomplete")) invalid(["courses", i, "outcome"], "Row blockers and outcome differ.");
    if (row.disposition === "include" ? row.courseId === null || row.required === null || row.weight === null || row.policyReason === null : row.required !== null || row.weight !== null || row.points !== null)
      invalid(["courses", i], "Course configuration and disposition differ.");
    if (row.outcome === "excluded" && row.disposition !== "exclude") invalid(["courses", i, "outcome"], "Only explicitly excluded courses are excluded.");
    if (row.outcome === "not_evaluated" || (row.disposition === "unclassified" && row.outcome !== "incomplete"))
      invalid(["courses", i, "outcome"], "Every discovered course must be explicitly evaluated or blocked.");
    for (const code of row.blockers) if (!value.blockers.some(item => item.code === code && item.courseId === row.courseId && item.sectionId === row.sectionId))
      invalid(["courses", i, "blockers"], "Row blocker is absent from the result.");
    if (row.outcome !== "contributes") {
      if (row.weightedPoints !== null) invalid(["courses", i, "weightedPoints"], "Blocked or excluded rows cannot contribute.");
      return;
    }
    if (row.disposition !== "include" || row.points === null || row.weight === null || row.weightedPoints === null || !row.release || !row.gradingPolicy || !row.grade ||
        !row.grade.hasEvidence || row.grade.pending > 0 || row.grade.provisional || row.grade.incomplete || row.grade.label === null) {
      invalid(["courses", i], "A contribution requires complete included grade evidence."); return;
    }
    const product = units(row.points) * units(row.weight);
    if (!equalFraction(row.weightedPoints, fraction(product, scale * scale))) invalid(["courses", i, "weightedPoints"], "The exact weighted contribution differs.");
    sum += product; weights += units(row.weight);
  });
  if (value.totals) {
    if (!weights || contributing.length < value.minimumIncludedCourses) { invalid(["totals"], "The complete minimum and positive denominator are required."); return; }
    const gpa = fraction(sum, scale * weights);
    if (!equalFraction(value.totals.weightedPoints, fraction(sum, scale * scale)) || !equalFraction(value.totals.totalWeight, fraction(weights, scale)) || !equalFraction(value.totals.gpa, gpa))
      invalid(["totals"], "Totals differ from exact contributions.");
    if (value.totals.display !== displayed(gpa, value.totals.displayRule)) invalid(["totals", "display"], "Display differs from the explicit final rounding rule.");
  }
});
export type TermGpaResult = z.infer<typeof termGpaResultSchema>;

export class TermGpaValidationError extends Error {
  readonly name = "TermGpaValidationError";
  constructor(readonly code: "scope_mismatch" | "term_not_applicable" | "grade_level_not_applicable" | "issue_not_current" | "source_identity_mismatch", readonly path: string, message: string) { super(message); }
}
function validateScope(policy: TermGpaPolicy, source: TermGpaSource) {
  for (const key of ["orgId", "unitId", "yearId"] as const) if (policy[key] !== source.identity[key])
    throw new TermGpaValidationError("scope_mismatch", `source.identity.${key}`, "The GPA policy does not apply to this source scope.");
  for (const key of ["orgId", "unitId", "yearId", "studentId"] as const) if (source.issue[key] !== source.identity[key])
    throw new TermGpaValidationError("source_identity_mismatch", `source.issue.${key}`, "The issued card and source identity differ.");
  if (!policy.termIds.includes(source.identity.termId) || !source.issue.termIds.includes(source.identity.termId))
    throw new TermGpaValidationError("term_not_applicable", "source.identity.termId", "Choose an applicable term present in the issued card.");
  if (!policy.gradeLevels.includes(source.identity.gradeLevel))
    throw new TermGpaValidationError("grade_level_not_applicable", "source.identity.gradeLevel", "The enrollment grade level is not configured in this policy.");
  if (source.current.cardId !== source.issue.cardId)
    throw new TermGpaValidationError("source_identity_mismatch", "source.current.cardId", "The current and issued card identities differ.");
  if (source.current.cardState !== "issued" || source.current.latestIssueId !== source.issue.id)
    throw new TermGpaValidationError("issue_not_current", "source.current", "Choose the latest issued copy of a currently issued card.");
  const sections = new Set<string>();
  source.cells.forEach((cell, i) => {
    if (cell.termId !== source.identity.termId || sections.has(cell.sectionId))
      throw new TermGpaValidationError("source_identity_mismatch", `source.cells.${i}`, "Every selected-term section must occur exactly once.");
    sections.add(cell.sectionId);
  });
}

/** Only server-normalized, provenance-verified input belongs here. There is no
 * API accepting caller-authored grade evidence; catalog existence is external. */
export function calculateTermGpa(raw: unknown): TermGpaResult {
  const { policy, source } = termGpaInputSchema.parse(raw);
  validateScope(policy, source);
  const rules = new Map(policy.courseRules.map(rule => [rule.courseId, rule]));
  const accepted = new Map(policy.acceptedGradingPolicies.map(ref => [`${ref.hash}:${ref.version}`, ref]));
  const blockers: TermGpaResult["blockers"] = [];
  const add = (code: BlockerCode, courseId: string | null = null, sectionId: string | null = null) => blockers.push({ code, courseId, sectionId });
  if (source.current.cardVersion !== source.issue.cardVersion) add("card_version_changed");
  if (source.current.sourceState === "source_unavailable" || source.current.sourceHash === null) add("source_unavailable");
  else if (source.current.sourceState !== "matches_issue" || source.current.sourceHash !== source.issue.sourceHash) add("source_changed");
  const occurrences = new Map<string, number>();
  for (const cell of source.cells) if (cell.courseId && rules.get(cell.courseId)?.disposition === "include")
    occurrences.set(cell.courseId, (occurrences.get(cell.courseId) ?? 0) + 1);
  for (const rule of policy.courseRules) if (rule.disposition === "include" && rule.required && !occurrences.has(rule.courseId)) add("missing_required_course", rule.courseId);
  const courses: TermGpaResult["courses"] = source.cells.map(cell => {
    const rule = cell.courseId ? rules.get(cell.courseId) : undefined;
    const row: TermGpaResult["courses"][number] = {
      sectionId: cell.sectionId, courseId: cell.courseId, printedIncluded: cell.printedIncluded, disposition: rule?.disposition ?? "unclassified",
      policyReason: rule?.reason ?? null, required: rule?.disposition === "include" ? rule.required : null,
      outcome: rule?.disposition === "exclude" ? "excluded" : "not_evaluated", gradingPolicy: cell.gradingPolicy, release: cell.release, grade: cell.grade,
      points: null, weight: rule?.disposition === "include" ? rule.weight : null, weightedPoints: null, blockers: [],
    };
    const block = (code: BlockerCode) => { row.blockers.push(code); add(code, cell.courseId, cell.sectionId); row.outcome = "incomplete"; };
    if (cell.sourceState !== "matches_issue") block(cell.sourceState);
    if (!cell.courseId) block("unmapped_course"); else if (!rule) block("unclassified_course");
    if (rule?.disposition !== "include") return row;
    if ((occurrences.get(rule.courseId) ?? 0) > 1) block("duplicate_course");
    if (!cell.release) block("missing_release");
    const ref = cell.gradingPolicy ? accepted.get(`${cell.gradingPolicy.hash}:${cell.gradingPolicy.version}`) : undefined;
    if (!ref) block("unsupported_grading_policy");
    if (!cell.grade) block("missing_grade");
    else {
      if (!cell.grade.hasEvidence) block("no_evidence");
      if (cell.grade.pending > 0) block("pending_grade");
      if (cell.grade.provisional) block("provisional_grade");
      if (cell.grade.incomplete) block("incomplete_grade");
      if (policy.missingWork === "block_calculation" && cell.grade.missing > 0) block("recorded_missing_work");
      if (cell.grade.label === null) block("no_awarded_label");
      else if (ref) {
        const mapping = ref.labelRules.find(item => item.label === cell.grade!.label);
        if (!mapping) block("unmapped_awarded_label");
        else if (mapping.kind === "unsupported") block("unsupported_awarded_label");
        else row.points = mapping.points;
      }
    }
    if (!row.blockers.length) {
      row.outcome = "contributes";
      row.weightedPoints = fraction(units(row.points!) * units(rule.weight), scale * scale);
    }
    return row;
  });
  const contributors = courses.filter(row => row.outcome === "contributes");
  if (!contributors.length) add("no_included_courses");
  if (contributors.length < policy.minimumIncludedCourses) add("minimum_courses");
  const result: TermGpaResult = {
    schemaVersion: 1, calculatorVersion: termGpaCalculatorVersion, policy: { id: policy.policyId, version: policy.version, basis: policy.basis },
    identity: source.identity, issue: { id: source.issue.id, cardId: source.issue.cardId, number: source.issue.number, cardVersion: source.issue.cardVersion, hash: source.issue.hash, sourceHash: source.issue.sourceHash },
    outcome: "incomplete", includedCourseCount: occurrences.size, contributingCourseCount: contributors.length,
    minimumIncludedCourses: policy.minimumIncludedCourses, courses, blockers, totals: null,
  };
  if (!blockers.length) {
    let sum = 0n, weights = 0n;
    for (const row of contributors) { sum += units(row.points!) * units(row.weight!); weights += units(row.weight!); }
    const gpa = fraction(sum, scale * weights);
    result.totals = { weightedPoints: fraction(sum, scale * scale), totalWeight: fraction(weights, scale), gpa, display: displayed(gpa, policy.display), displayRule: policy.display };
    result.outcome = "calculated";
  }
  return termGpaResultSchema.parse(result);
}
