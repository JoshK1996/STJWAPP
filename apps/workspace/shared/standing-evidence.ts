import { z } from "zod";
import { gradingPolicySchema } from "./grading";
import { standingDecimalSchema } from "./academic-standing";

/** Serializable evidence contracts only. Parsing validates structure; it does not
 * verify a database hash, authorize source access or approve a determination. */
const id = z.uuid(), positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.iso.date();
const name = z.string().min(1).max(5000), nullableName = z.string().max(5000).nullable();
const dates = { starts_on: date, ends_on: date };

/** Existing policy validation trims strings for configuration use. Captured
 * evidence must retain its original strings for exact hashing, including when
 * nested in a parsed decision envelope. Keep explicit strict fields and apply
 * the original validator as a check, never as the returned transformed value. */
export const standingCapturedGradingPolicySchema = gradingPolicySchema.safeExtend({
  name: z.string(),
  categories: z.array(gradingPolicySchema.shape.categories.element.extend({ name: z.string() })).min(1).max(20),
  scale: z.array(gradingPolicySchema.shape.scale.element.extend({ label: z.string() })).max(20),
}).superRefine((value, ctx) => {
  const validated = gradingPolicySchema.safeParse(value);
  if (!validated.success) for (const issue of validated.error.issues)
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
});

export const standingSourceGradeSchema = z.object({ percentage: standingDecimalSchema.nullable(), label: z.string().min(1).max(20).nullable(),
  missing: z.number().int().min(0).max(10000), pending: z.number().int().min(0).max(10000),
  incomplete: z.boolean(), hasEvidence: z.boolean() }).strict();
export const standingReleasedGradeSchema = standingSourceGradeSchema.extend({ provisional: z.boolean() }).strict();
export const standingSourceYearSchema = z.object({ id, name, version: positive, ...dates }).strict();
export const standingSourceEnrollmentSchema = z.object({ id, version: positive, grade_level: z.string().min(1).max(30),
  status: z.enum(["enrolled", "withdrawn", "completed"]), ...dates }).strict();
export const standingSourceStudentSchema = z.object({ id, name, studentNumber: z.string().min(1).max(40), unitId: id,
  version: positive, personVersion: positive }).strict();

export const studentReleaseEvidenceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("standing_student_release"),
  orgId: id, unitId: id, releaseId: id, bookId: id, bookVersion: positive, createdBy: id,
  reviewedAt: z.iso.datetime({ offset: true }), section: z.object({ id, courseId: id.nullable() }).strict(),
  term: z.object({ id, yearId: id }).strict(), gradingPolicy: z.object({ hash, version: positive }).strict(),
  student: z.object({ id, startsOn: date, endsOn: date }).strict(), grade: standingReleasedGradeSchema,
}).strict();
export type StudentReleaseEvidenceV1 = z.infer<typeof studentReleaseEvidenceSchema>;
const releaseEvidenceSchema = z.object({ hash, projection: studentReleaseEvidenceSchema, capturedPolicy: standingCapturedGradingPolicySchema }).strict();
export const standingAnchorProblemSchema = z.enum(["no_reviewed_result", "review_required", "student_result_missing", "membership_dates_changed"]);
export const standingAnchorSchema = z.object({ section: z.object({ id, name, version: positive, archived: z.boolean(),
  courseId: id.nullable(), courseCode: nullableName, courseTitle: nullableName, courseVersion: positive.nullable() }).strict(),
  roster: z.object({ version: positive, startsOn: date, endsOn: date }).strict().nullable(),
  book: z.object({ id, version: positive, status: z.enum(["open", "submitted", "locked"]), policyVersion: positive }).strict().nullable(),
  release: z.object({ id, bookVersion: positive }).strict().nullable(), inClass: z.boolean(), problem: standingAnchorProblemSchema.nullable(),
}).strict();
const matrixCellSchema = z.object({ sectionId: id, termId: id,
  issued: standingAnchorSchema.nullable(), current: standingAnchorSchema.nullable() }).strict();
const sourceParentsSchema = z.object({ student: standingSourceStudentSchema, year: standingSourceYearSchema,
  terms: z.array(standingSourceYearSchema).max(8), enrollment: standingSourceEnrollmentSchema }).strict();
const parentsSchema = z.object({ student: z.object({ id, personId: id, version: positive, personVersion: positive }).strict(),
  organization: z.object({ id, name }).strict(), unit: z.object({ id, name, version: positive }).strict(),
  card: z.object({ id, version: positive, latestIssueId: id }).strict(),
  issued: sourceParentsSchema, current: sourceParentsSchema.nullable(),
}).strict();
export const standingEvidenceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("standing_evidence"),
  issueHash: hash, issuedSourceHash: hash, currentSourceHash: hash.nullable(), comparisonHash: hash,
  parents: parentsSchema, matrix: z.array(matrixCellSchema).max(400),
  selectedReleases: z.array(releaseEvidenceSchema).max(200), fullCardDependencyUserIds: z.array(id).max(400),
}).strict();
export type StandingEvidenceV1 = z.infer<typeof standingEvidenceSchema>;

export const standingLabelsSchema = z.object({
  studentName: name, studentNumber: z.string().min(1).max(40), yearName: name, termName: name,
  organizationName: name, unitName: name,
  courses: z.array(z.object({ sectionId: id, courseId: id.nullable(), sectionName: name,
    courseCode: nullableName, courseTitle: nullableName,
    printDisposition: z.enum(["included", "excluded", "not_in_issue"]),
    printedExclusionReason: z.string().max(1000).nullable(),
  }).strict()).max(200),
}).strict();
export type StandingLabels = z.infer<typeof standingLabelsSchema>;
