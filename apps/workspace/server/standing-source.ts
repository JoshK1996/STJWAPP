import { z } from "zod";
import type { Queryable, Row } from "./db";
import { digest, Problem, requireCondition, type Actor } from "./security";
import { readReportCardSource } from "./report-cards";
import { reportCardCell, reportCardPresentation, reportCardKey } from "../shared/report-cards";
import { gradingPolicySchema } from "../shared/grading";
import { standingSourceSchema, type StandingSource } from "../shared/academic-standing";
import { standingEvidenceSchema, standingSourceGradeSchema as sourceGrade, standingReleasedGradeSchema as releasedGrade,
  standingSourceYearSchema as sourceYear, standingSourceEnrollmentSchema as sourceEnrollment, standingSourceStudentSchema as sourceStudent,
  studentReleaseEvidenceSchema as releaseProjectionSchema, standingAnchorProblemSchema as problemSchema, standingAnchorSchema as anchorSchema,
  type StandingEvidenceV1, type StandingLabels } from "../shared/standing-evidence";
export { standingEvidenceSchema, standingLabelsSchema } from "../shared/standing-evidence";
export type { StandingEvidenceV1, StandingLabels, StudentReleaseEvidenceV1 } from "../shared/standing-evidence";
import { canonicalStandingJson, gradingPolicyEvidenceHash } from "./standing-policy-provenance";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { lockAcademics } from "./timetable-engine";

/** Internal source adapter only: no routes, transaction creation, persistence or
 * publication. Copies are NOT HTTP response contracts and do not confer access.
 * RR copying must be followed by fresh locked authorization before publication. */
export const standingSourceLimits = Object.freeze({ cells: 200, terms: 8, bytes: 8 * 1024 * 1024 });
const id = z.uuid(), positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.iso.date();
const name = z.string().min(1).max(5000), nullableName = z.string().max(5000).nullable();
const dates = { starts_on: date, ends_on: date };
const sorted = (values: string[]) => [...new Set(values)].sort();
const canonicalHash = (value: unknown) => digest(canonicalStandingJson(value));
const unavailable = () => new Problem(404, "This standing source is unavailable under your current access.");
const integrity = (condition: unknown) => requireCondition(condition, 422, "The reviewed standing source is inconsistent or unsupported.");
const unchanged = (condition: unknown) => requireCondition(condition, 409, "The standing source changed. Prepare and review it again.");
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  integrity(result.success);
  return result.data!;
}
function bounded(value: unknown) {
  requireCondition(Buffer.byteLength(canonicalStandingJson(value), "utf8") <= standingSourceLimits.bytes, 422,
    "This standing source exceeds the supported evidence size. Choose a narrower issued card.");
}

export const standingSourceSelectionSchema = z.object({
  studentId: id, yearId: id, termId: id, reportCardIssueId: id,
}).strict();
export type StandingSourceSelection = z.infer<typeof standingSourceSelectionSchema>;

const sourceSection = z.object({ id, name, version: positive, course_id: id.nullable(), archived: z.boolean(),
  course_code: nullableName, course_title: nullableName, course_version: positive.nullable() }).strict();
const sourceCell = z.object({ sectionId: id, termId: id, section: sourceSection,
  roster: z.object({ version: positive, ...dates }).strict().nullable(),
  book: z.object({ id, version: positive, status: z.enum(["open", "submitted", "locked"]), policy_version: positive }).strict().nullable(),
  release: z.object({ id, version: positive, reviewedAt: z.iso.datetime({ offset: true }), reviewerName: name, policyName: name }).strict().nullable(),
  result: sourceGrade.nullable(), inClass: z.boolean(), problem: z.string().max(1000).nullable(),
}).strict();
const cardSourceSchema = z.object({ student: sourceStudent,
  organization: z.object({ name, unit_name: name }).strict(), year: sourceYear,
  terms: z.array(sourceYear).min(1).max(standingSourceLimits.terms), enrollment: sourceEnrollment,
  cells: z.array(sourceCell).max(standingSourceLimits.cells),
}).strict();
type CardSource = z.infer<typeof cardSourceSchema>;
type CardCell = z.infer<typeof sourceCell>;
const issueSnapshotSchema = z.object({ cardId: id, number: positive, version: positive,
  presentation: reportCardPresentation, cells: z.array(reportCardCell).max(standingSourceLimits.cells),
  source: cardSourceSchema, sourceHash: hash, issuerName: name, reason: z.string().max(2000),
  acknowledgeNoGrade: z.boolean(), acknowledgeMissing: z.boolean(),
}).strict();

const copySchema = z.object({ schemaVersion: z.literal(1), selection: standingSourceSelectionSchema,
  orgId: id, unitId: id, issue: z.object({ id, cardId: id, number: positive, cardVersion: positive, hash, sourceHash: hash,
    termIds: z.array(id).min(1).max(8) }).strict(), issuedSource: cardSourceSchema, currentSource: cardSourceSchema.nullable(),
  presentationCells: z.array(reportCardCell).max(200), evidence: standingEvidenceSchema,
}).strict();
export type StandingSourceCopy = z.infer<typeof copySchema>;

function checkSource(source: CardSource, selection: StandingSourceSelection, unitId: string, termIds: string[]) {
  integrity(source.student.id === selection.studentId && source.student.unitId === unitId && source.year.id === selection.yearId);
  const terms = source.terms.map(term => term.id);
  integrity(new Set(terms).size === terms.length && canonicalStandingJson(sorted(terms)) === canonicalStandingJson(sorted(termIds)));
  const keys = source.cells.map(reportCardKey);
  integrity(new Set(keys).size === keys.length);
  for (const cell of source.cells) integrity(cell.section.id === cell.sectionId && terms.includes(cell.termId) &&
    (!cell.release || cell.book) && (!cell.result || cell.release));
}
function comparisonHash(copy: Pick<StandingSourceCopy, "orgId" | "unitId" | "selection" | "issue" | "presentationCells" | "evidence">) {
  const e = copy.evidence;
  return canonicalHash({ schemaVersion: 1, kind: "standing_source_comparison", orgId: copy.orgId, unitId: copy.unitId,
    selection: copy.selection, issue: copy.issue, presentationCells: copy.presentationCells,
    currentSourceHash: e.currentSourceHash, parents: e.parents, matrix: e.matrix,
    fullCardDependencyUserIds: e.fullCardDependencyUserIds, selectedReleaseHashes: e.selectedReleases.map(release => release.hash).sort() });
}
function validateCopy(copy: StandingSourceCopy) {
  parsed(copySchema, copy); bounded(copy);
  checkSource(copy.issuedSource, copy.selection, copy.unitId, copy.issue.termIds);
  if (copy.currentSource) checkSource(copy.currentSource, copy.selection, copy.unitId, copy.issue.termIds);
  integrity(copy.selection.reportCardIssueId === copy.issue.id && copy.issue.termIds.includes(copy.selection.termId) &&
    canonicalHash(copy.issuedSource) === copy.issue.sourceHash && copy.evidence.issuedSourceHash === copy.issue.sourceHash &&
    copy.evidence.issueHash === copy.issue.hash &&
    (copy.currentSource ? canonicalHash(copy.currentSource) : null) === copy.evidence.currentSourceHash);
  for (const release of copy.evidence.selectedReleases) integrity(canonicalHash(release.projection) === release.hash &&
    gradingPolicyEvidenceHash(release.capturedPolicy) === release.projection.gradingPolicy.hash &&
    release.projection.orgId === copy.orgId && release.projection.unitId === copy.unitId &&
    release.projection.student.id === copy.selection.studentId && release.projection.term.id === copy.selection.termId &&
    release.projection.term.yearId === copy.selection.yearId);
  integrity(comparisonHash(copy) === copy.evidence.comparisonHash);
}
function anchor(cell: CardCell | undefined): z.infer<typeof anchorSchema> | null {
  if (!cell) return null;
  let problem: z.infer<typeof problemSchema> | null = null;
  if (!cell.book || !cell.release) problem = "no_reviewed_result";
  else if (cell.book.status !== "locked" || cell.book.version !== cell.release.version) problem = "review_required";
  else if (!cell.result) problem = "student_result_missing";
  else if (cell.problem) problem = "membership_dates_changed";
  return { section: { id: cell.sectionId, name: cell.section.name, version: cell.section.version, archived: cell.section.archived,
    courseId: cell.section.course_id, courseCode: cell.section.course_code, courseTitle: cell.section.course_title, courseVersion: cell.section.course_version },
  roster: cell.roster && { version: cell.roster.version, startsOn: cell.roster.starts_on, endsOn: cell.roster.ends_on },
  book: cell.book && { id: cell.book.id, version: cell.book.version, status: cell.book.status, policyVersion: cell.book.policy_version },
  release: cell.release && { id: cell.release.id, bookVersion: cell.release.version }, inClass: cell.inClass, problem };
}
async function officeActor(tx: Queryable, actor: Actor, unitId: string, lock: boolean): Promise<Actor> {
  requireCondition(actor.mode === "password", 403, "Password sign-in is required for standing.");
  const user = (await tx.query("SELECT id,org_id,name,email,role,active FROM users WHERE id=$1 AND org_id=$2" + (lock ? " FOR SHARE" : ""), [actor.id, actor.org_id])).rows[0];
  if (!user?.active) throw unavailable();
  const units = (await tx.query("SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id" + (lock ? " FOR SHARE" : ""), [actor.org_id, actor.id])).rows.map(row => row.unit_id);
  if (!["developer", "owner", "admin"].includes(user.role)) {
    if (!units.includes(unitId)) throw unavailable();
    const grant = (await tx.query("SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3" + (lock ? " FOR SHARE" : ""), [actor.org_id, actor.id, unitId])).rows[0];
    if (!grant) throw unavailable();
  }
  return { ...actor, ...user, mode: "password", unit_ids: units };
}

/** Parameterized JSON projection deliberately excludes full book roster, scores,
 * assignments, results arrays, classmates and private grade notes. */
async function releasedEvidence(tx: Queryable, actor: Actor, selection: StandingSourceSelection, unitId: string, cell: CardCell) {
  if (!cell.release) { integrity(!cell.result); return null; }
  integrity(cell.book);
  const row = (await tx.query(`SELECT g.id,g.org_id,g.unit_id,g.book_id,g.book_version,g.created_by,g.created_at,
    g.snapshot->'book'->>'id' AS captured_book_id,g.snapshot->'book'->>'org_id' AS captured_org_id,
    g.snapshot->'book'->>'unit_id' AS captured_unit_id,g.snapshot->'book'->'version' AS captured_version,
    g.snapshot->'book'->>'status' AS captured_status,g.snapshot->'book'->'policy_version' AS policy_version,
    CASE WHEN octet_length((g.snapshot->'book'->'policy')::text)<=$5 THEN g.snapshot->'book'->'policy' ELSE NULL END AS policy,
    g.snapshot->'section'->>'id' AS section_id,
    g.snapshot->'section'->>'courseId' AS course_id,g.snapshot->'term'->>'id' AS term_id,
    g.snapshot->'term'->>'year_id' AS year_id,
    (SELECT count(*)::integer FROM jsonb_array_elements(g.snapshot->'results') r WHERE r->>'student_id'=$4) AS result_count,
    (SELECT jsonb_build_object('student_id',r->'student_id','starts_on',r->'starts_on','ends_on',r->'ends_on',
      'percentage',r->'percentage','label',r->'label','pending',r->'pending','missing',r->'missing',
      'incomplete',r->'incomplete','hasEvidence',r->'hasEvidence','provisional',r->'provisional')
      FROM jsonb_array_elements(g.snapshot->'results') r WHERE r->>'student_id'=$4 LIMIT 1) AS result
    FROM gradebook_releases g WHERE g.id=$1 AND g.org_id=$2 AND g.unit_id=$3`,
  [cell.release.id, actor.org_id, unitId, selection.studentId, standingSourceLimits.bytes])).rows[0];
  // An actually missing reviewed result remains incomplete; a contradictory
  // claimed issued result is integrity failure, never a silently replaced grade.
  if (!row) { integrity(!cell.result); return null; }
  integrity(row.book_id === cell.book!.id && row.book_version === cell.release.version && row.captured_book_id === row.book_id &&
    row.captured_org_id === actor.org_id && row.captured_unit_id === unitId && row.captured_version === row.book_version && row.captured_status === "locked" &&
    row.section_id === cell.sectionId && row.course_id === cell.section.course_id && row.term_id === cell.termId && row.year_id === selection.yearId &&
    row.policy_version === cell.book!.policy_version && row.result_count <= 1);
  parsed(gradingPolicySchema, row.policy);
  integrity(row.policy.name === cell.release.policyName);
  const policyHash = gradingPolicyEvidenceHash(row.policy);
  if (!row.result_count) { integrity(!cell.result); return null; }
  const result = parsed(z.object({ student_id: id, ...dates, ...releasedGrade.shape }).strict(), row.result);
  const { student_id, starts_on, ends_on, provisional, ...cardGrade } = result;
  integrity(student_id === selection.studentId && canonicalStandingJson(cardGrade) === canonicalStandingJson(cell.result));
  const reviewedAt = new Date(row.created_at).toISOString();
  integrity(reviewedAt === cell.release.reviewedAt);
  // Issued cells that already disclosed a dates/readiness problem stay incomplete.
  // If the card claimed valid membership, prove the actual captured intersection.
  const projection = parsed(releaseProjectionSchema, { schemaVersion: 1, kind: "standing_student_release", orgId: actor.org_id, unitId,
    releaseId: row.id, bookId: row.book_id, bookVersion: row.book_version, createdBy: row.created_by, reviewedAt,
    section: { id: row.section_id, courseId: row.course_id }, term: { id: row.term_id, yearId: row.year_id },
    gradingPolicy: { hash: policyHash, version: row.policy_version }, student: { id: student_id, startsOn: starts_on, endsOn: ends_on },
    grade: { ...cardGrade, provisional } });
  // Preserve exact validated policy bytes rather than a parser's trim transform.
  return { hash: canonicalHash(projection), projection, capturedPolicy: row.policy as z.infer<typeof gradingPolicySchema> };
}

/** Call within a caller-owned source transaction. No source data may be sent to
 * a client until a separate fresh authority/parents/comparison phase succeeds. */
export async function copyStandingSource(tx: Queryable, suppliedActor: Actor, raw: StandingSourceSelection): Promise<StandingSourceCopy> {
  const selection = standingSourceSelectionSchema.parse(raw);
  const lookup = (await tx.query(`SELECT i.unit_id,c.student_id,c.year_id FROM report_card_issues i
    JOIN report_cards c ON c.id=i.card_id AND c.org_id=i.org_id AND c.unit_id=i.unit_id
    WHERE i.id=$1 AND i.org_id=$2`, [selection.reportCardIssueId, suppliedActor.org_id])).rows[0];
  if (!lookup || lookup.student_id !== selection.studentId || lookup.year_id !== selection.yearId) throw unavailable();
  // Scope before loading any educational snapshot, not just before returning it.
  const actor = await officeActor(tx, suppliedActor, lookup.unit_id, false);
  const row = (await tx.query(`SELECT i.id,i.org_id,i.unit_id,i.card_id,i.number,i.card_version,i.snapshot_hash,
    CASE WHEN octet_length(i.snapshot::text)<=$3 THEN i.snapshot ELSE NULL END AS snapshot,
    c.student_id,c.year_id,c.term_ids,c.version,c.status,c.issue_count,c.source_hash,
    CASE WHEN octet_length(c.source_snapshot::text)<=$3 THEN c.source_snapshot ELSE NULL END AS source_snapshot,
    c.presentation,c.cells,s.person_id,s.version AS student_version,p.version AS person_version,
    o.name AS organization_name,n.name AS unit_name,n.version AS unit_version,
    (SELECT x.id FROM report_card_issues x WHERE x.card_id=c.id ORDER BY x.number DESC LIMIT 1) AS latest_issue_id
    FROM report_card_issues i JOIN report_cards c ON c.id=i.card_id AND c.org_id=i.org_id AND c.unit_id=i.unit_id
    JOIN students s ON s.id=c.student_id AND s.org_id=c.org_id AND s.unit_id=c.unit_id
    JOIN school_people p ON p.id=s.person_id JOIN organizations o ON o.id=c.org_id JOIN units n ON n.id=c.unit_id AND n.org_id=c.org_id
    WHERE i.id=$1 AND i.org_id=$2`, [selection.reportCardIssueId, suppliedActor.org_id, standingSourceLimits.bytes])).rows[0];
  if (!row || row.student_id !== selection.studentId || row.year_id !== selection.yearId) throw unavailable();
  integrity(row.unit_id === lookup.unit_id);
  unchanged(row.status === "issued" && row.latest_issue_id === row.id && row.issue_count === row.number && row.version === row.card_version);
  integrity(row.snapshot && row.source_snapshot);
  const snapshot = parsed(issueSnapshotSchema, row.snapshot);
  integrity(canonicalHash(row.snapshot) === row.snapshot_hash && canonicalHash(row.snapshot.source) === snapshot.sourceHash &&
    canonicalHash(row.source_snapshot) === row.source_hash && row.source_hash === snapshot.sourceHash &&
    canonicalStandingJson(row.source_snapshot) === canonicalStandingJson(row.snapshot.source) &&
    canonicalStandingJson(row.presentation) === canonicalStandingJson(row.snapshot.presentation) && canonicalStandingJson(row.cells) === canonicalStandingJson(row.snapshot.cells));
  integrity(snapshot.cardId === row.card_id && snapshot.number === row.number && snapshot.version === row.card_version);
  const termIds = parsed(z.array(id).min(1).max(8), row.term_ids);
  integrity(new Set(termIds).size === termIds.length && termIds.includes(selection.termId));
  checkSource(snapshot.source, selection, row.unit_id, termIds);
  const issuedKeys = snapshot.source.cells.map(reportCardKey), printedKeys = snapshot.cells.map(reportCardKey);
  integrity(new Set(printedKeys).size === printedKeys.length && canonicalStandingJson(sorted(issuedKeys)) === canonicalStandingJson(sorted(printedKeys)));
  const selectedReleases: StandingEvidenceV1["selectedReleases"] = [];
  // Validate referenced released values BEFORE current discovery (whose SQL
  // scalar result would otherwise reject duplicate result rows less explicitly).
  for (const cell of snapshot.source.cells.filter(cell => cell.termId === selection.termId)) {
    const evidence = await releasedEvidence(tx, actor, selection, row.unit_id, cell);
    if (evidence) {
      const term = snapshot.source.terms.find(term => term.id === cell.termId)!;
      if (cell.inClass && !cell.problem) integrity(cell.roster &&
        evidence.projection.student.startsOn === [cell.roster.starts_on, snapshot.source.enrollment.starts_on, term.starts_on].sort().at(-1) &&
        evidence.projection.student.endsOn === [cell.roster.ends_on, snapshot.source.enrollment.ends_on, term.ends_on].sort()[0]);
      selectedReleases.push(evidence);
    }
  }
  let currentSource: CardSource | null;
  try {
    currentSource = parsed(cardSourceSchema, await readReportCardSource(tx, actor,
      { studentId: selection.studentId, yearId: selection.yearId, termIds }, snapshot.source.cells));
    checkSource(currentSource, selection, row.unit_id, termIds);
  } catch (error) {
    if (error instanceof Problem && [404, 409].includes(error.status)) currentSource = null;
    else if ((error as { code?: string }).code === "21000") throw new Problem(422, "The reviewed standing source is inconsistent or unsupported.");
    else throw error;
  }
  const allKeys = sorted([...issuedKeys, ...(currentSource?.cells.map(reportCardKey) ?? [])]);
  requireCondition(allKeys.filter(key => key.endsWith(":" + selection.termId)).length <= standingSourceLimits.cells, 422,
    "The selected term exceeds the supported class matrix. Refresh or narrow the issued card.");
  const matrix = allKeys.map(key => {
    const [sectionId, termId] = key.split(":");
    return { sectionId, termId, issued: anchor(snapshot.source.cells.find(cell => reportCardKey(cell) === key)),
      current: anchor(currentSource?.cells.find(cell => reportCardKey(cell) === key)) };
  });
  const releaseIds = sorted([...snapshot.source.cells, ...(currentSource?.cells ?? [])].flatMap(cell => cell.release ? [cell.release.id] : []));
  const dependencies = releaseIds.length ? (await tx.query("SELECT id,created_by FROM gradebook_releases WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id", [actor.org_id, row.unit_id, releaseIds])).rows : [];
  integrity(dependencies.length === releaseIds.length);
  const parentSource = (source: CardSource) => ({ student: source.student, year: source.year, terms: source.terms, enrollment: source.enrollment });
  const parents = { student: { id: selection.studentId, personId: row.person_id, version: row.student_version, personVersion: row.person_version },
    organization: { id: actor.org_id, name: row.organization_name }, unit: { id: row.unit_id, name: row.unit_name, version: row.unit_version },
    card: { id: row.card_id, version: row.version, latestIssueId: row.latest_issue_id }, issued: parentSource(snapshot.source), current: currentSource && parentSource(currentSource) };
  const issue = { id: row.id, cardId: row.card_id, number: row.number, cardVersion: row.card_version, hash: row.snapshot_hash, sourceHash: snapshot.sourceHash, termIds };
  const currentSourceHash = currentSource && canonicalHash(currentSource), fullCardDependencyUserIds = sorted(dependencies.map(row => row.created_by));
  const evidence: StandingEvidenceV1 = { schemaVersion: 1, kind: "standing_evidence", issueHash: issue.hash, issuedSourceHash: issue.sourceHash,
    currentSourceHash, comparisonHash: "0".repeat(64), parents, matrix, selectedReleases, fullCardDependencyUserIds };
  const copy = { schemaVersion: 1 as const, selection, orgId: actor.org_id, unitId: row.unit_id, issue,
    issuedSource: snapshot.source, currentSource, presentationCells: snapshot.cells, evidence };
  copy.evidence.comparisonHash = comparisonHash(copy);
  validateCopy(copy);
  // Do not return parsed(copySchema)'s transformed captured grading-policy JSON.
  return copy;
}

export type StandingSourceAuthority = { actor: Actor; orgId: string; unitId: string; lockedUserIds: string[] };
/** FRESH READ COMMITTED transaction only; caller then checks active policy before
 * parents. Acquires academics FIRST and reloads account/session after all waits. */
export async function lockStandingSourceAuthority(tx: Queryable, actor: Actor, sessionHash: string, copy: StandingSourceCopy): Promise<StandingSourceAuthority> {
  requireCondition(typeof sessionHash === "string" && /^[a-f0-9]{64}$/.test(sessionHash), 401, "A verified password session is required.");
  validateCopy(copy);
  if (actor.org_id !== copy.orgId) throw unavailable();
  requireCondition(actor.mode === "password", 403, "Password sign-in is required for standing.");
  await lockAcademics(tx, actor.org_id);
  // Read current candidates before account locks; no data leaves this function.
  // Current discovery may widen compared with the RR copy. Bound it, lock the
  // account union in one sorted order, and still reject any changed source later.
  const reviewers = (await tx.query(`SELECT DISTINCT g.created_by FROM gradebooks b
    JOIN sections s ON s.id=b.section_id JOIN LATERAL
      (SELECT r.created_by,r.snapshot FROM gradebook_releases r WHERE r.book_id=b.id ORDER BY r.book_version DESC LIMIT 1) g ON true
    WHERE b.org_id=$1 AND b.unit_id=$2 AND s.year_id=$3 AND b.term_id=ANY($4::uuid[])
      AND (EXISTS(SELECT 1 FROM section_students r WHERE r.section_id=s.id AND r.student_id=$5)
        OR g.snapshot->'results' @> jsonb_build_array(jsonb_build_object('student_id',$5::text)))
    ORDER BY g.created_by LIMIT 401`, [actor.org_id, copy.unitId, copy.selection.yearId, copy.issue.termIds, copy.selection.studentId])).rows;
  requireCondition(reviewers.length <= 400, 422, "The source exceeds the supported reviewer dependency limit.");
  const lockedUserIds = sorted([actor.id, ...copy.evidence.fullCardDependencyUserIds, ...reviewers.map(row => row.created_by)]);
  const locked = (await tx.query("SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [actor.org_id, lockedUserIds])).rows;
  if (locked.length !== lockedUserIds.length) throw unavailable();
  const current = await currentReportActor(tx, actor, sessionHash);
  const scoped = await officeActor(tx, current, copy.unitId, true);
  if (!(await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [actor.org_id])).rows.length) throw unavailable();
  if (!(await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=$2 FOR SHARE", [actor.org_id, copy.unitId])).rows.length) throw unavailable();
  await recheckReportSession(tx, scoped, sessionHash);
  return { actor: scoped, orgId: actor.org_id, unitId: copy.unitId, lockedUserIds };
}

/** Requires lockStandingSourceAuthority in THIS transaction, then caller's active
 * policy lock. Never upgrades the student to UPDATE or acquires teacher grants. */
export async function lockStandingSourceParents(tx: Queryable, authority: StandingSourceAuthority, copy: StandingSourceCopy, requiredCourseIds: string[] = []): Promise<void> {
  validateCopy(copy);
  if (authority.orgId !== copy.orgId || authority.unitId !== copy.unitId || authority.actor.org_id !== copy.orgId) throw unavailable();
  const student = (await tx.query("SELECT id,person_id FROM students WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR SHARE", [copy.orgId, copy.unitId, copy.selection.studentId])).rows[0];
  if (!student) throw unavailable();
  await tx.query("SELECT id FROM school_people WHERE org_id=$1 AND id=$2 FOR SHARE", [copy.orgId, student.person_id]);
  await tx.query("SELECT id FROM student_enrollments WHERE org_id=$1 AND unit_id=$2 AND student_id=$3 AND year_id=$4 ORDER BY id FOR SHARE", [copy.orgId, copy.unitId, copy.selection.studentId, copy.selection.yearId]);
  if (!(await tx.query("SELECT id FROM report_cards WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR SHARE", [copy.orgId, copy.unitId, copy.issue.cardId])).rows.length) throw unavailable();
  await tx.query("SELECT id FROM school_years WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR SHARE", [copy.orgId, copy.unitId, copy.selection.yearId]);
  await tx.query("SELECT id FROM school_terms WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND id=ANY($4::uuid[]) ORDER BY id FOR SHARE", [copy.orgId, copy.unitId, copy.selection.yearId, copy.issue.termIds]);
  // Under academics + selected student, the fresh relationship set is stable.
  // Include roster links even out of term and released/prior anchors so absent
  // books or future eligibility are represented, not just existing book rows.
  const candidates = (await tx.query(`SELECT DISTINCT s.id AS section_id,t.id AS term_id,s.course_id FROM sections s
    JOIN school_terms t ON t.year_id=s.year_id LEFT JOIN gradebooks b ON b.section_id=s.id AND b.term_id=t.id
    WHERE s.org_id=$1 AND s.unit_id=$2 AND s.year_id=$3 AND t.id=ANY($4::uuid[])
      AND (EXISTS(SELECT 1 FROM section_students r WHERE r.section_id=s.id AND r.student_id=$5)
        OR EXISTS(SELECT 1 FROM gradebook_releases g WHERE g.book_id=b.id AND g.snapshot->'results' @> jsonb_build_array(jsonb_build_object('student_id',$5::text)))
        OR s.id=ANY($6::uuid[])) ORDER BY s.id,t.id LIMIT 1601`,
    [copy.orgId, copy.unitId, copy.selection.yearId, copy.issue.termIds, copy.selection.studentId, sorted(copy.evidence.matrix.map(cell => cell.sectionId))])).rows;
  requireCondition(candidates.length <= 1600, 422, "The source exceeds the supported parent dependency limit.");
  const sectionIds = sorted([...candidates.map(row => row.section_id), ...copy.evidence.matrix.map(cell => cell.sectionId)]);
  const courses = sorted([...parsed(z.array(id).max(200), requiredCourseIds), ...candidates.flatMap(row => row.course_id ? [row.course_id] : []),
    ...copy.evidence.matrix.flatMap(cell => [cell.issued?.section.courseId, cell.current?.section.courseId].filter((value): value is string => !!value))]);
  await tx.query("SELECT id FROM sections WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE", [copy.orgId, copy.unitId, sectionIds]);
  await tx.query("SELECT id FROM courses WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE", [copy.orgId, copy.unitId, courses]);
  const bookKeys = sorted([...candidates.map(row => row.section_id + ":" + row.term_id), ...copy.evidence.matrix.map(reportCardKey)]);
  for (const key of bookKeys) await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["gradebook:" + key]);
  await tx.query("SELECT id FROM gradebooks WHERE org_id=$1 AND unit_id=$2 AND section_id=ANY($3::uuid[]) AND term_id=ANY($4::uuid[]) ORDER BY section_id,term_id FOR SHARE", [copy.orgId, copy.unitId, sectionIds, copy.issue.termIds]);
}

/** Call after a fresh copy made under authority + parents. Also recheck the actual
 * session after subsequent policy/quota waits immediately before publication. */
export function assertStandingSourceUnchanged(original: StandingSourceCopy, fresh: StandingSourceCopy, authority: StandingSourceAuthority): void {
  validateCopy(original); validateCopy(fresh);
  unchanged(authority.orgId === fresh.orgId && authority.unitId === fresh.unitId &&
    fresh.evidence.fullCardDependencyUserIds.every(userId => authority.lockedUserIds.includes(userId)) &&
    canonicalStandingJson(original.selection) === canonicalStandingJson(fresh.selection) &&
    original.evidence.comparisonHash === fresh.evidence.comparisonHash);
}

/** Pure projection of verified internal source. Does not authorize, recalculate
 * grades, confirm a policy, retain or publish a determination. */
export function normalizeStandingSource(copy: StandingSourceCopy): { source: StandingSource; labels: StandingLabels; evidence: StandingEvidenceV1 } {
  validateCopy(copy);
  const term = copy.issuedSource.terms.find(term => term.id === copy.selection.termId)!;
  const globalState = !copy.currentSource ? "source_unavailable" : copy.evidence.currentSourceHash === copy.issue.sourceHash ? "matches_issue" : "source_changed";
  const cells = copy.evidence.matrix.filter(cell => cell.termId === copy.selection.termId).map(cell => {
    const issued = copy.issuedSource.cells.find(value => reportCardKey(value) === reportCardKey(cell));
    const verified = copy.evidence.selectedReleases.find(value => value.projection.releaseId === issued?.release?.id);
    // A printed-excluded cell may have captured an already stale/reopened book.
    // Preserve its old projection in evidence but do not treat that release as
    // eligible current reviewed evidence. Explicit policy exclusions still skip
    // missing-release/grade checks; included courses become incomplete.
    const released = issued && !issued.problem ? verified : undefined;
    const printed = copy.presentationCells.find(value => reportCardKey(value) === reportCardKey(cell));
    const sourceState = !cell.current ? "source_unavailable" : !cell.issued || canonicalStandingJson(cell.issued) !== canonicalStandingJson(cell.current) ? "source_changed" : "matches_issue";
    return { sectionId: cell.sectionId, termId: cell.termId, courseId: (cell.issued ?? cell.current)!.section.courseId,
      printedIncluded: printed?.included ?? false, sourceState,
      gradingPolicy: released?.projection.gradingPolicy ?? null,
      release: released ? { id: released.projection.releaseId, bookId: released.projection.bookId, bookVersion: released.projection.bookVersion,
        hash: released.hash, reviewedAt: released.projection.reviewedAt } : null,
      grade: released?.projection.grade ?? null };
  });
  const source = parsed(standingSourceSchema, { schemaVersion: 1,
    identity: { orgId: copy.orgId, unitId: copy.unitId, yearId: copy.selection.yearId, studentId: copy.selection.studentId,
      gradeLevel: copy.issuedSource.enrollment.grade_level, termId: copy.selection.termId },
    issue: { orgId: copy.orgId, unitId: copy.unitId, yearId: copy.selection.yearId, studentId: copy.selection.studentId, ...copy.issue },
    current: { cardId: copy.issue.cardId, cardVersion: copy.evidence.parents.card.version, latestIssueId: copy.evidence.parents.card.latestIssueId,
      cardState: "issued", sourceHash: copy.evidence.currentSourceHash, sourceState: globalState }, cells });
  const labels: StandingLabels = { studentName: copy.issuedSource.student.name, studentNumber: copy.issuedSource.student.studentNumber,
    yearName: copy.issuedSource.year.name, termName: term.name, organizationName: copy.issuedSource.organization.name,
    unitName: copy.issuedSource.organization.unit_name, courses: cells.map(cell => {
      const entry = copy.evidence.matrix.find(value => value.sectionId === cell.sectionId && value.termId === cell.termId)!;
      const selected = (entry.issued ?? entry.current)!.section, printed = copy.presentationCells.find(value => reportCardKey(value) === reportCardKey(cell));
      return { sectionId: cell.sectionId, courseId: cell.courseId, sectionName: selected.name, courseCode: selected.courseCode,
        courseTitle: selected.courseTitle, printDisposition: !printed ? "not_in_issue" : printed.included ? "included" : "excluded",
        printedExclusionReason: printed && !printed.included ? printed.exclusionReason : null };
    }) };
  return { source, labels, evidence: copy.evidence };
}
