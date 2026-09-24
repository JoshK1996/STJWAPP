import { digest, requireCondition } from "./security";
import { toCsv } from "./reports";
import { canonicalStandingJson } from "./standing-policy-provenance";
import { standingDecisionEnvelopeSchema, standingDecisionLimits, type StandingDecisionEnvelope } from "../shared/standing-decisions";

export const standingDecisionCsvColumns = ["format_version", "row_kind", "decision_id", "decision_number", "captured_at", "snapshot_sha256",
  "reviewed_by_id", "reviewed_by_name", "review_reason", "student_id", "student_name", "student_number", "year_id", "year_name", "term_id", "term_name",
  "policy_id", "policy_name", "policy_version_id", "policy_version", "policy_sha256", "policy_source_description", "policy_confirmation_reason",
  "policy_confirmed_by_id", "policy_confirmed_by_name", "policy_confirmed_at",
  "report_card_issue_id", "issue_sha256", "outcome", "section_id", "course_id", "course_code", "course_title", "print_disposition",
  "policy_disposition", "course_outcome", "awarded_label", "recorded_percentage", "blocker_code", "failure_code", "required", "missing_count", "pending_count",
  "mean_numerator", "mean_denominator", "mean_unit", "mean_display", "mean_display_rule", "mean_minimum", "mean_meets_minimum"];

/** Fixed v1 long-form export. Existing toCsv owns formula escaping, BOM and CRLF.
 * Calculation and authority happen before this pure serialization boundary. */
export function renderStandingDecision(raw: StandingDecisionEnvelope) {
  const envelope = standingDecisionEnvelopeSchema.parse(raw), d = envelope.data, result = d.result;
  const snapshotText = canonicalStandingJson(envelope), snapshotHash = digest(snapshotText);
  const jsonText = canonicalStandingJson({ schemaVersion: 1, snapshotHash, decision: envelope }) + "\n";
  const base = { format_version: 1, decision_id: envelope.id, decision_number: envelope.number, captured_at: envelope.capturedAt, snapshot_sha256: snapshotHash,
    reviewed_by_id: envelope.reviewedBy.id, reviewed_by_name: envelope.reviewedBy.name, review_reason: envelope.reason,
    student_id: d.source.identity.studentId, student_name: d.labels.studentName, student_number: d.labels.studentNumber, year_id: d.source.identity.yearId,
    year_name: d.labels.yearName, term_id: d.source.identity.termId, term_name: d.labels.termName, policy_id: d.policyVersion.policyId, policy_name: d.policy.name,
    policy_version_id: d.policyVersion.id, policy_version: d.policyVersion.version,
    policy_source_description: d.policyConfirmation.sourceDescription, policy_confirmation_reason: d.policyConfirmation.reason,
    policy_confirmed_by_id: d.policyConfirmation.confirmedBy.id, policy_confirmed_by_name: d.policyConfirmation.confirmedBy.name, policy_confirmed_at: d.policyConfirmation.confirmedAt,
    policy_sha256: d.policyVersion.hash, report_card_issue_id: d.source.issue.id, issue_sha256: d.source.issue.hash, outcome: result.outcome,
    mean_numerator: result.mean?.numerator, mean_denominator: result.mean?.denominator, mean_unit: result.mean?.unit, mean_display: result.mean?.display,
    mean_display_rule: result.mean?.displayRule, mean_minimum: result.mean?.minimum, mean_meets_minimum: result.mean?.meetsMinimum };
  const rows: Record<string, unknown>[] = [{ ...base, row_kind: "evaluation" }];
  for (const course of result.courses) {
    const label = d.labels.courses.find(row => row.sectionId === course.sectionId);
    rows.push({ ...base, row_kind: "course", section_id: course.sectionId, course_id: course.courseId, course_code: label?.courseCode,
      course_title: label?.courseTitle, print_disposition: label?.printDisposition, policy_disposition: course.disposition,
      course_outcome: course.outcome, awarded_label: course.grade?.label, recorded_percentage: course.grade?.percentage, required: course.required,
      missing_count: course.grade?.missing, pending_count: course.grade?.pending, blocker_code: course.blockers.join(";"), failure_code: course.failures.join(";") });
  }
  for (const blocker of result.blockers) {
    const label = d.policyConfirmation.courses.find(c => c.id === blocker.courseId);
    rows.push({ ...base, row_kind: "blocker", section_id: blocker.sectionId, course_id: blocker.courseId, course_code: label?.code, course_title: label?.title, blocker_code: blocker.code });
  }
  for (const failure of result.failures) {
    const label = d.policyConfirmation.courses.find(c => c.id === failure.courseId);
    rows.push({ ...base, row_kind: "failure", section_id: failure.sectionId, course_id: failure.courseId, course_code: label?.code, course_title: label?.title, failure_code: failure.code });
  }
  const csvText = toCsv(rows, standingDecisionCsvColumns), jsonBytes = Buffer.byteLength(jsonText), csvBytes = Buffer.byteLength(csvText);
  const bytes = Buffer.byteLength(snapshotText) + jsonBytes + csvBytes;
  requireCondition(bytes <= standingDecisionLimits.bytes, 422, "This decision exceeds the retained evidence size limit. No decision was recorded.");
  return { snapshotText, snapshotHash, jsonText, jsonHash: digest(jsonText), csvText, csvHash: digest(csvText), jsonBytes, csvBytes, bytes };
}
