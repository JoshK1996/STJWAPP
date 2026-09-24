import { digest, requireCondition } from "./security";
import { toCsv } from "./reports";
import { canonicalStandingJson } from "./standing-policy-provenance";
import { gpaDecisionLimits, type GpaDecisionEnvelope } from "../shared/gpa-decisions";
import { verifyGpaDecisionEnvelope } from "./gpa-decision-evidence";

export const gpaDecisionCsvColumns = [
  "format_version", "calculator_version", "row_kind", "decision_id", "series_id", "decision_number",
  "supersedes_id", "captured_at", "snapshot_sha256", "reviewed_by_id", "reviewed_by_name", "review_reason",
  "org_id", "unit_id", "student_id", "student_name", "student_number", "year_id", "year_name", "term_id", "term_name",
  "policy_id", "policy_name", "policy_version_id", "policy_version", "policy_sha256", "configuration_sha256",
  "policy_source_description", "policy_confirmation_reason", "policy_confirmed_by_id", "policy_confirmed_by_name", "policy_confirmed_at",
  "report_card_issue_id", "issue_sha256", "issued_source_sha256", "comparison_sha256", "outcome", "basis", "formula", "included_course_count",
  "contributing_course_count", "minimum_included_courses", "missing_work_rule", "gpa_numerator", "gpa_denominator", "gpa_display",
  "display_decimal_places", "display_rounding", "weighted_points_numerator", "weighted_points_denominator", "total_weight_numerator",
  "total_weight_denominator", "section_id", "section_name", "course_id", "course_code", "course_title", "print_disposition",
  "printed_exclusion_reason", "policy_disposition", "policy_reason", "required", "course_outcome", "awarded_label", "recorded_percentage",
  "grading_policy_sha256", "grading_policy_version", "release_id", "release_sha256", "points", "weight",
  "course_weighted_points_numerator", "course_weighted_points_denominator", "missing_count", "pending_count", "incomplete", "provisional", "has_evidence", "blocker_codes",
];

/** Fixed GPA format v1 only. Evidence verification never authorizes access.
 * Exact fractions/decimals stay strings; existing CSV owns BOM/CRLF and formula
 * escaping. Historical reads verify this format then serve original stored bytes. */
export function renderGpaDecision(raw: GpaDecisionEnvelope) {
  const envelope = verifyGpaDecisionEnvelope(raw), d = envelope.data, result = d.result, totals = result.totals;
  const snapshotText = canonicalStandingJson(envelope), snapshotHash = digest(snapshotText);
  const jsonText = canonicalStandingJson({ schemaVersion: 1, snapshotHash, decision: envelope }) + "\n";
  const base = { format_version: 1, calculator_version: d.calculatorVersion, decision_id: envelope.id, series_id: envelope.seriesId,
    decision_number: envelope.number, supersedes_id: envelope.supersedesId, captured_at: envelope.capturedAt, snapshot_sha256: snapshotHash,
    reviewed_by_id: envelope.reviewedBy.id, reviewed_by_name: envelope.reviewedBy.name, review_reason: envelope.reason,
    org_id: d.source.identity.orgId, unit_id: d.source.identity.unitId, student_id: d.source.identity.studentId, student_name: d.labels.studentName,
    student_number: d.labels.studentNumber, year_id: d.source.identity.yearId, year_name: d.labels.yearName, term_id: d.source.identity.termId, term_name: d.labels.termName,
    policy_id: d.policyVersion.policyId, policy_name: d.policy.name, policy_version_id: d.policyVersion.id, policy_version: d.policyVersion.version,
    policy_sha256: d.policyVersion.hash, configuration_sha256: d.policyVersion.configurationHash,
    policy_source_description: d.policyConfirmation.sourceDescription, policy_confirmation_reason: d.policyConfirmation.reason,
    policy_confirmed_by_id: d.policyConfirmation.confirmedBy.id, policy_confirmed_by_name: d.policyConfirmation.confirmedBy.name,
    policy_confirmed_at: d.policyConfirmation.confirmedAt, report_card_issue_id: d.source.issue.id, issue_sha256: d.source.issue.hash,
    issued_source_sha256: d.source.issue.sourceHash, comparison_sha256: d.evidence.comparisonHash, outcome: result.outcome,
    basis: d.policy.basis, formula: d.policy.formula, included_course_count: result.includedCourseCount,
    contributing_course_count: result.contributingCourseCount, minimum_included_courses: result.minimumIncludedCourses, missing_work_rule: d.policy.missingWork,
    gpa_numerator: totals?.gpa.numerator, gpa_denominator: totals?.gpa.denominator, gpa_display: totals?.display,
    display_decimal_places: d.policy.display.decimalPlaces, display_rounding: d.policy.display.rounding,
    weighted_points_numerator: totals?.weightedPoints.numerator, weighted_points_denominator: totals?.weightedPoints.denominator,
    total_weight_numerator: totals?.totalWeight.numerator, total_weight_denominator: totals?.totalWeight.denominator };
  const rows: Record<string, unknown>[] = [{ ...base, row_kind: "evaluation" }];
  for (const course of result.courses) {
    const label = d.labels.courses.find(row => row.sectionId === course.sectionId)!;
    rows.push({ ...base, row_kind: "course", section_id: course.sectionId, section_name: label.sectionName, course_id: course.courseId,
      course_code: label.courseCode, course_title: label.courseTitle, print_disposition: label.printDisposition,
      printed_exclusion_reason: label.printedExclusionReason, policy_disposition: course.disposition, policy_reason: course.policyReason,
      required: course.required, course_outcome: course.outcome, awarded_label: course.grade?.label, recorded_percentage: course.grade?.percentage,
      grading_policy_sha256: course.gradingPolicy?.hash, grading_policy_version: course.gradingPolicy?.version,
      release_id: course.release?.id, release_sha256: course.release?.hash, points: course.points, weight: course.weight,
      course_weighted_points_numerator: course.weightedPoints?.numerator, course_weighted_points_denominator: course.weightedPoints?.denominator,
      missing_count: course.grade?.missing, pending_count: course.grade?.pending, incomplete: course.grade?.incomplete,
      provisional: course.grade?.provisional, has_evidence: course.grade?.hasEvidence, blocker_codes: course.blockers.join(";") });
  }
  for (const blocker of result.blockers) {
    const label = d.policyConfirmation.evidence.courses.find(c => c.id === blocker.courseId);
    const section = d.labels.courses.find(c => c.sectionId === blocker.sectionId);
    rows.push({ ...base, row_kind: "blocker", section_id: blocker.sectionId, section_name: section?.sectionName,
      course_id: blocker.courseId, course_code: label?.code, course_title: label?.title, blocker_codes: blocker.code });
  }
  const csvText = toCsv(rows, gpaDecisionCsvColumns), jsonBytes = Buffer.byteLength(jsonText), csvBytes = Buffer.byteLength(csvText);
  const bytes = Buffer.byteLength(snapshotText) + jsonBytes + csvBytes;
  requireCondition(bytes <= gpaDecisionLimits.bytes, 422, "This GPA decision exceeds the retained evidence size limit. No decision was recorded.");
  return { snapshotText, snapshotHash, jsonText, jsonHash: digest(jsonText), csvText, csvHash: digest(csvText), jsonBytes, csvBytes, bytes };
}
