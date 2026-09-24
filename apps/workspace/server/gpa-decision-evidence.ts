import { z } from "zod";
import { calculateTermGpa, termGpaConfigurationSchema, termGpaResultSchema, type TermGpaResult } from "../shared/term-gpa";
import { gpaDecisionEnvelopeSchema, gpaDecisionDetailSchema, gpaDecisionLimits, gpaReviewDataSchema,
  exactGpaSummarySchema, type GpaReviewData, type GpaDecisionEnvelope, type GpaDecisionDetail, type ExactGpaSummary } from "../shared/gpa-decisions";
import { digest, Problem } from "./security";
import { canonicalStandingJson as canonical, gradingPolicyEvidenceHash } from "./standing-policy-provenance";
import { gpaPolicyEvidenceHash, validateGpaPolicyEvidence } from "./gpa-policies";
import { renderGpaDecision } from "./gpa-decision-export";

const fail = () => new Problem(422, "The retained GPA evidence is inconsistent or unsupported.");
const valid = (condition: unknown): void => { if (!condition) throw fail(); };
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const unique = (values: string[]) => new Set(values).size === values.length;
const sameIds = (a: string[], b: string[]) => unique(a) && unique(b) && equal([...a].sort(), [...b].sort());
function checked<T>(fn: () => T): T { try { return fn(); } catch { throw fail(); } }

/** Pure internal integrity check, never authorization. Initial source authenticity
 * comes from locked immutable issue/release readback. Full issue/card source and
 * presentation bodies are not retained here; their hashes are cross-bound, not
 * recomputed or advertised as signatures. Issued and current labels can differ. */
export function verifyGpaReviewData(raw: unknown): GpaReviewData {
  return checked(() => {
    const data = gpaReviewDataSchema.parse(raw), { policy, policyVersion: version, policyConfirmation: confirmation, source, evidence, labels, expected } = data;
    const { schemaVersion: _s, calculatorVersion: _c, policyId: _i, version: _v, orgId: _o, unitId: _u, yearId: _y, ...configurationRaw } = policy;
    const configuration = termGpaConfigurationSchema.parse(configurationRaw);
    valid(version.policyId === policy.policyId && version.version === policy.version && version.hash === gpaPolicyEvidenceHash(policy));
    valid(version.configurationHash === digest(canonical({ schemaVersion: 1, kind: "term_gpa_configuration", configuration })));
    validateGpaPolicyEvidence(configuration, confirmation.evidence, policy.unitId, policy.yearId);
    valid(sameIds(confirmation.evidence.courses.map(c => c.id), policy.courseRules.map(c => c.courseId)) &&
      sameIds(confirmation.evidence.terms.map(t => t.id), policy.termIds) &&
      sameIds(confirmation.evidence.gradingPolicies.map(p => `${p.hash}:${p.version}`), policy.acceptedGradingPolicies.map(p => `${p.hash}:${p.version}`)));
    valid(expected.policyVersionId === version.id && expected.policyHash === version.hash &&
      (expected.latestDecisionId === null) === (expected.latestDecisionNumber === 0));
    for (const key of ["orgId", "unitId", "yearId"] as const) valid(policy[key] === source.identity[key]);
    for (const key of ["orgId", "unitId", "yearId", "studentId"] as const) valid(source.identity[key] === source.issue[key]);
    valid(source.issue.id === expected.issueId && source.issue.hash === expected.issueHash && evidence.issueHash === expected.issueHash &&
      source.issue.sourceHash === evidence.issuedSourceHash && source.issue.cardId === expected.cardId && source.current.cardId === expected.cardId &&
      source.current.cardVersion === expected.cardVersion && source.current.sourceHash === expected.currentSourceHash &&
      evidence.currentSourceHash === expected.currentSourceHash && evidence.comparisonHash === expected.comparisonHash);
    const parents = evidence.parents, identity = source.identity;
    valid(parents.organization.id === identity.orgId && parents.unit.id === identity.unitId && parents.student.id === identity.studentId &&
      parents.card.id === expected.cardId && parents.card.version === expected.cardVersion && parents.card.latestIssueId === source.current.latestIssueId);
    valid(parents.issued.student.id === identity.studentId && parents.issued.student.unitId === identity.unitId && parents.issued.year.id === identity.yearId &&
      parents.issued.enrollment.grade_level === identity.gradeLevel && sameIds(parents.issued.terms.map(t => t.id), source.issue.termIds));
    const term = parents.issued.terms.find(t => t.id === identity.termId); valid(term);
    valid(labels.studentName === parents.issued.student.name && labels.studentNumber === parents.issued.student.studentNumber &&
      labels.yearName === parents.issued.year.name && labels.termName === term!.name);
    valid((parents.current === null) === (evidence.currentSourceHash === null));
    if (parents.current) valid(parents.current.student.id === identity.studentId && parents.current.student.unitId === identity.unitId &&
      parents.current.year.id === identity.yearId && sameIds(parents.current.terms.map(t => t.id), source.issue.termIds));
    const globalState = evidence.currentSourceHash === null ? "source_unavailable" : evidence.currentSourceHash === evidence.issuedSourceHash ? "matches_issue" : "source_changed";
    valid(source.current.sourceState === globalState);
    if (globalState === "matches_issue") valid(equal(parents.issued, parents.current));
    valid(unique(evidence.matrix.map(c => `${c.sectionId}:${c.termId}`)) && unique(evidence.fullCardDependencyUserIds));
    for (const cell of evidence.matrix) {
      valid(source.issue.termIds.includes(cell.termId) && (cell.issued || cell.current));
      for (const anchor of [cell.issued, cell.current]) if (anchor) valid(anchor.section.id === cell.sectionId);
      if (!parents.current) valid(cell.current === null);
      if (globalState === "matches_issue") valid(equal(cell.issued, cell.current));
    }
    const matrix = evidence.matrix.filter(c => c.termId === identity.termId);
    valid(equal(matrix.map(c => c.sectionId), source.cells.map(c => c.sectionId)) && equal(source.cells.map(c => c.sectionId), labels.courses.map(c => c.sectionId)));
    valid(unique(evidence.selectedReleases.map(r => r.projection.releaseId)));
    for (const release of evidence.selectedReleases) {
      const p = release.projection, cell = matrix.find(c => c.sectionId === p.section.id), anchor = cell?.issued;
      valid(digest(canonical(p)) === release.hash && gradingPolicyEvidenceHash(release.capturedPolicy) === p.gradingPolicy.hash);
      valid(p.orgId === identity.orgId && p.unitId === identity.unitId && p.student.id === identity.studentId && p.term.id === identity.termId && p.term.yearId === identity.yearId);
      valid(anchor && anchor.book && anchor.release && anchor.release.id === p.releaseId && anchor.release.bookVersion === p.bookVersion &&
        anchor.book.id === p.bookId && anchor.book.policyVersion === p.gradingPolicy.version && anchor.section.courseId === p.section.courseId &&
        evidence.fullCardDependencyUserIds.includes(p.createdBy));
      if (anchor!.inClass && !anchor!.problem) {
        valid(anchor!.roster && p.student.startsOn === [anchor!.roster!.startsOn, parents.issued.enrollment.starts_on, term!.starts_on].sort().at(-1) &&
          p.student.endsOn === [anchor!.roster!.endsOn, parents.issued.enrollment.ends_on, term!.ends_on].sort()[0]);
      }
    }
    for (let i = 0; i < matrix.length; i++) {
      const anchor = matrix[i], cell = source.cells[i], label = labels.courses[i], section = (anchor.issued ?? anchor.current)!.section;
      const rawRelease = evidence.selectedReleases.find(r => r.projection.releaseId === anchor.issued?.release?.id);
      const released = anchor.issued && !anchor.issued.problem ? rawRelease : undefined;
      if (anchor.issued && !anchor.issued.problem) valid(anchor.issued.book?.status === "locked" && anchor.issued.release &&
        anchor.issued.book.version === anchor.issued.release.bookVersion && released);
      const sourceState = !anchor.current ? "source_unavailable" : !anchor.issued || !equal(anchor.issued, anchor.current) ? "source_changed" : "matches_issue";
      valid(cell.termId === identity.termId && cell.courseId === section.courseId && cell.sourceState === sourceState);
      valid(label.courseId === section.courseId && label.sectionName === section.name && label.courseCode === section.courseCode && label.courseTitle === section.courseTitle);
      valid(cell.printedIncluded === (label.printDisposition === "included") && (label.printDisposition === "not_in_issue") === (anchor.issued === null) &&
        (label.printedExclusionReason !== null) === (label.printDisposition === "excluded"));
      // Critical: a recomputed GPA over tampered normalized grades cannot bypass
      // the independently retained raw release projection, including all flags.
      valid(equal(cell.grade, released?.projection.grade ?? null) && equal(cell.gradingPolicy, released?.projection.gradingPolicy ?? null));
      valid(equal(cell.release, released ? { id: released.projection.releaseId, bookId: released.projection.bookId,
        bookVersion: released.projection.bookVersion, hash: released.hash, reviewedAt: released.projection.reviewedAt } : null));
    }
    valid(equal(calculateTermGpa({ policy, source }), data.result));
    return data;
  });
}

export function checkedGpaReview(text: string, hash: string): GpaReviewData {
  return checked(() => { valid(typeof text === "string" && Buffer.byteLength(text) <= gpaDecisionLimits.bytes && digest(text) === hash);
    const data = verifyGpaReviewData(JSON.parse(text)); valid(canonical(data) === text); return data; });
}
export function verifyGpaDecisionEnvelope(raw: unknown): GpaDecisionEnvelope {
  return checked(() => {
    const decision = gpaDecisionEnvelopeSchema.parse(raw), data = verifyGpaReviewData(decision.data);
    valid(digest(canonical(data)) === decision.previewHash && decision.number === data.expected.latestDecisionNumber + 1 &&
      decision.supersedesId === data.expected.latestDecisionId && (decision.number === 1) === (decision.supersedesId === null));
    return decision;
  });
}
export function deriveGpaSummary(raw: TermGpaResult): ExactGpaSummary | null {
  const result = termGpaResultSchema.parse(raw);
  return result.totals ? exactGpaSummarySchema.parse({ ...result.totals.gpa, display: result.totals.display, displayRule: result.totals.displayRule }) : null;
}

const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().min(0).max(2147483647);
const storedSchema = z.object({ id, org_id: id, unit_id: id, student_id: id, year_id: id, term_id: id, series_id: id,
  number: integer.positive(), supersedes_id: id.nullable(), preview_id: id, preview_hash: hash, policy_id: id, policy_version_id: id,
  card_id: id, card_version: integer.positive(), issue_id: id, reviewed_by: id, reviewer_name: z.string(), reason: z.string(),
  outcome: z.enum(["calculated", "incomplete"]), gpa_summary: exactGpaSummarySchema.nullable(), captured_at: z.union([z.date(), z.iso.datetime({ precision: 3 })]),
  snapshot_text: z.string().max(gpaDecisionLimits.bytes), snapshot_hash: hash, json_text: z.string().max(gpaDecisionLimits.bytes), json_hash: hash,
  csv_base64: z.string().max(Math.ceil(gpaDecisionLimits.bytes * 4 / 3) + Math.ceil(gpaDecisionLimits.bytes / 50)), csv_hash: hash,
  json_bytes: integer.max(gpaDecisionLimits.bytes), csv_bytes: integer.max(gpaDecisionLimits.bytes), bytes: integer.max(gpaDecisionLimits.bytes),
});

/** Database projection only. Caller supplies SQL base64 of the original CSV,
 * establishes current authority, audits access and checks actual session expiry.
 * No retained row is mutated and no historic file is replaced by regeneration. */
export function checkedGpaDecision(raw: Record<string, unknown>): GpaDecisionDetail {
  return checked(() => {
    const row = storedSchema.parse(raw), decision = verifyGpaDecisionEnvelope(JSON.parse(row.snapshot_text));
    const generated = renderGpaDecision(decision), csvText = Buffer.from(row.csv_base64, "base64").toString("utf8");
    valid(Buffer.from(csvText).toString("base64") === row.csv_base64.replace(/\n/g, ""));
    for (const [actual, expected] of [[row.snapshot_text, generated.snapshotText], [row.snapshot_hash, generated.snapshotHash], [row.json_text, generated.jsonText],
      [row.json_hash, generated.jsonHash], [csvText, generated.csvText], [row.csv_hash, generated.csvHash], [row.json_bytes, generated.jsonBytes],
      [row.csv_bytes, generated.csvBytes], [row.bytes, generated.bytes]]) valid(actual === expected);
    const identity = decision.data.source.identity;
    for (const [key, column] of [["orgId", "org_id"], ["unitId", "unit_id"], ["studentId", "student_id"], ["yearId", "year_id"], ["termId", "term_id"]] as const)
      valid(identity[key] === row[column]);
    valid(decision.id === row.id && decision.seriesId === row.series_id && decision.number === row.number && decision.supersedesId === row.supersedes_id &&
      decision.previewId === row.preview_id && decision.previewHash === row.preview_hash && decision.reviewedBy.id === row.reviewed_by &&
      decision.reviewedBy.name === row.reviewer_name && decision.reason === row.reason && decision.capturedAt === new Date(row.captured_at).toISOString() &&
      decision.data.policyVersion.id === row.policy_version_id && decision.data.policyVersion.policyId === row.policy_id &&
      decision.data.source.issue.cardId === row.card_id && decision.data.source.issue.cardVersion === row.card_version && decision.data.source.issue.id === row.issue_id &&
      decision.data.result.outcome === row.outcome && equal(deriveGpaSummary(decision.data.result), row.gpa_summary));
    return gpaDecisionDetailSchema.parse({ decision, snapshotHash: row.snapshot_hash, jsonHash: row.json_hash, csvHash: row.csv_hash,
      jsonBytes: row.json_bytes, csvBytes: row.csv_bytes });
  });
}
