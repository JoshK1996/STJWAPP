import type { StandingReviewData } from "../shared/standing-decisions";
import type { StandingPolicyVersion } from "../shared/standing-policies";
import type { StandingResult } from "../shared/academic-standing";
import { Badge } from "./components";

export const standingOutcome: Record<StandingResult["outcome"], string> = {
  qualifies: "Qualifies under these configured rules",
  does_not_qualify: "Does not qualify under these configured rules",
  incomplete: "Incomplete — no standing determination",
};
export const standingStamp = (value: string) => new Date(value).toLocaleString();
type Code = StandingResult["blockers"][number]["code"] | StandingResult["failures"][number]["code"];
const explanations: Record<Code, string> = {
  source_changed: "The current source differs from the issued report-card copy.",
  source_unavailable: "A required current source could not be checked.",
  card_version_changed: "The report-card revision has changed since this issued copy.",
  unmapped_course: "This class does not have an identified course.",
  unclassified_course: "The policy does not explicitly include or exclude this course.",
  missing_required_course: "A course required by the policy is missing.",
  duplicate_course: "More than one class supplies this included course.",
  missing_release: "A reviewed class result is missing.",
  missing_grade: "The student's reviewed grade is missing.",
  unsupported_grading_policy: "The class grading policy is not accepted by this standing policy.",
  no_evidence: "There is no reviewed grading evidence for this course.",
  pending_grade: "This grade has pending work or remains provisional.",
  incomplete_grade: "This grade is recorded as incomplete.",
  no_awarded_label: "The awarded label required by this policy is missing.",
  no_recorded_percentage: "The recorded percentage required by this policy is missing.",
  no_included_courses: "No courses are included in this evaluation.",
  label_not_allowed: "The awarded label is outside the policy's allowed labels.",
  below_course_minimum: "The recorded percentage is below the per-course minimum.",
  recorded_missing_work: "Recorded missing work does not meet this policy's requirement.",
  minimum_courses: "There are fewer included distinct courses than the policy requires.",
  below_mean_minimum: "The term's configured equal-weight mean condition is not met.",
};
const explain = (code: string) => explanations[code as Code] ?? `An additional review condition was reported (${code}). Refresh the application to see its explanation; do not infer an outcome from missing explanatory text.`;
export function StandingPolicySource({ value }: { value: StandingPolicyVersion }) {
  return <section className="standing-review-source"><h3>{value.policy.name} · confirmed copy {value.version}</h3>
    <p><strong>School source or contact:</strong> {value.sourceDescription}</p>
    <p>Confirmed by {value.confirmedBy.name} · {standingStamp(value.confirmedAt)}</p>
    <details><summary>Confirmation and exact source references</summary><p>{value.reason}</p>
      <p className="standing-review-id">Copy {value.policyVersionId}<br />Policy SHA-256 {value.policyHash}</p>
      <p>References were captured when this policy was prepared. Historical grading policies are retained separately from current settings.</p>
      {value.evidence.gradingPolicies.map(ref => <div key={ref.hash + ref.version}><strong>{ref.policy.name} · version {ref.version}</strong>
        <p>{ref.provenance.map(source => source.kind === "confirmed_settings" ? `Confirmed school settings revision ${source.version}` : `Reviewed class release · book revision ${source.bookVersion}`).join("; ")}</p><p className="standing-review-id">{ref.hash}</p></div>)}
    </details>
  </section>;
}
export default function StandingReviewEvidence({ data }: { data: StandingReviewData }) {
  const { result, policy, labels } = data;
  const courseName = (courseId: string | null, sectionId: string | null) => {
    if (!courseId && !sectionId) return "Whole term";
    const label = labels.courses.find(course => sectionId ? course.sectionId === sectionId : course.courseId === courseId);
    const course = data.policyConfirmation.courses.find(course => course.id === courseId);
    return label ? `${label.courseTitle ?? label.sectionName}${sectionId ? ` · ${label.sectionName}` : ""}` : course ? `${course.code} · ${course.title}` : sectionId ? "Retained class" : courseId ? "Retained course" : "Whole term";
  };
  return <div className="standing-review-evidence">
    <div className={`standing-review-outcome ${result.outcome}`}><Badge tone={result.outcome === "qualifies" ? "good" : "outline"}>{result.outcome === "incomplete" ? "Incomplete review" : "One-term determination"}</Badge>
      <h3>{standingOutcome[result.outcome]}</h3><p>{labels.studentName} · {labels.studentNumber} · {labels.yearName} · {labels.termName}</p>
      <p>{labels.unitName} · {labels.organizationName}</p>
    </div>
    <section className="standing-review-source"><h3>{policy.name} · confirmed copy {data.policyVersion.version}</h3>
      <p><strong>School source or contact:</strong> {data.policyConfirmation.sourceDescription}</p>
      <p>Confirmed by {data.policyConfirmation.confirmedBy.name} · {standingStamp(data.policyConfirmation.confirmedAt)}</p>
      <details><summary>Captured confirmation references</summary><p>{data.policyConfirmation.reason}</p><p className="standing-review-id">Copy {data.policyVersion.id}<br />Policy SHA-256 {data.policyVersion.hash}</p></details>
    </section>
    <dl className="standing-review-facts">
      <div><dt>Basis</dt><dd>{policy.basis === "awarded_label" ? "Awarded labels" : "Recorded percentages"}</dd></div>
      <div><dt>Included distinct courses</dt><dd>{result.includedCourseCount} · required minimum {result.minimumIncludedCourses}</dd></div>
      <div><dt>Missing work</dt><dd>{policy.missingWork === "use_reviewed_grade" ? "Use the reviewed grade; preserve recorded missing work" : "Disqualify for recorded missing work in an included course"}</dd></div>
      <div><dt>Issued report card</dt><dd>Copy {data.source.issue.number} · card revision {data.source.issue.cardVersion}</dd></div>
      {policy.basis === "recorded_percentage" && <><div><dt>Per-course minimum</dt><dd>{policy.perCourseMinimum}%</dd></div><div><dt>Term mean rule</dt><dd>{policy.meanCondition.kind === "none" ? "No mean condition" : `Equal-weight recorded percentages · minimum ${policy.meanCondition.minimum}%`}</dd></div></>}
      {result.mean && <div><dt>Recorded term mean</dt><dd>{result.mean.display}% · displayed to two decimals, half up. The exact fraction controls the comparison.</dd></div>}
    </dl>
    {!!result.blockers.length && <section className="standing-review-problems"><h3>Evidence still needed</h3><ul>{result.blockers.map((item, i) => <li key={i}><strong>{courseName(item.courseId, item.sectionId)}:</strong> {explain(item.code)}</li>)}</ul></section>}
    {!!result.failures.length && <section className="standing-review-problems"><h3>Conditions not met</h3><ul>{result.failures.map((item, i) => <li key={i}><strong>{courseName(item.courseId, item.sectionId)}:</strong> {explain(item.code)}</li>)}</ul></section>}
    <h3>Course evidence</h3>
    {!result.courses.length && <p>No course rows were available. This does not imply a zero grade.</p>}
    <div className="standing-review-courses">{result.courses.map(row => {
      const label = labels.courses.find(item => item.sectionId === row.sectionId);
      const grading = data.evidence.selectedReleases.find(item => item.projection.gradingPolicy.hash === row.gradingPolicy?.hash && item.projection.gradingPolicy.version === row.gradingPolicy?.version);
      return <article key={row.sectionId}><h4>{courseName(row.courseId, row.sectionId)}</h4>
        <p><Badge tone="outline">{row.disposition === "include" ? row.required ? "Included · required" : "Included · not required" : row.disposition === "exclude" ? "Excluded by policy" : "Not configured"}</Badge> <Badge>{row.outcome.replaceAll("_", " ")}</Badge></p>
        <p>{row.policyReason ?? "No course rule is configured."}</p>
        <p><strong>Printed report card:</strong> {label?.printDisposition === "included" ? "Included" : label?.printDisposition === "excluded" ? `Excluded · ${label.printedExclusionReason ?? "No retained reason"}` : "Not in the issued copy"}. Printing choices do not determine standing course inclusion.</p>
        <dl className="standing-review-facts"><div><dt>Awarded label</dt><dd>{row.grade?.label ?? "Not recorded"}</dd></div><div><dt>Recorded percentage</dt><dd>{row.grade?.percentage == null ? "Not recorded" : `${row.grade.percentage}%`}</dd></div>
          <div><dt>Missing / pending work</dt><dd>{row.grade ? `${row.grade.missing} missing · ${row.grade.pending} pending` : "Not recorded"}</dd></div>
          <div><dt>Grade evidence</dt><dd>{row.grade ? `${row.grade.hasEvidence ? "Evidence present" : "No evidence"} · ${row.grade.provisional ? "Provisional" : "Not provisional"} · ${row.grade.incomplete ? "Incomplete" : "Not marked incomplete"}` : "No grade record"}</dd></div>
          <div><dt>Grading policy</dt><dd>{grading ? `${grading.capturedPolicy.name} · version ${grading.projection.gradingPolicy.version}` : row.gradingPolicy ? `Retained grading policy · version ${row.gradingPolicy.version}` : "Unavailable"}</dd></div>
        </dl>
        {!!(row.blockers.length + row.failures.length) && <ul>{[...row.blockers, ...row.failures].map(code => <li key={code}>{explain(code)}</li>)}</ul>}
        {row.release && <details><summary>Reviewed release reference</summary><p>Book revision {row.release.bookVersion} · reviewed {standingStamp(row.release.reviewedAt)}</p><p className="standing-review-id">{row.release.id}<br />{row.release.hash}</p></details>}
      </article>;
    })}</div>
    <details className="standing-review-source"><summary>All configured course and grade rules</summary>
      <p>Explicit grade levels: {policy.gradeLevels.map(value => JSON.stringify(value)).join(", ")}. Applies to: {policy.termIds.map(id => data.evidence.parents.issued.terms.find(term => term.id === id)?.name ?? `Retained term ${id}`).join(", ")}.</p>
      <ul>{policy.courseRules.map(rule => <li key={rule.courseId}><strong>{courseName(rule.courseId, null)}:</strong> {rule.disposition}{rule.disposition === "include" ? rule.required ? ", required" : ", not required" : ""} · {rule.reason}</li>)}</ul>
      <ul>{policy.acceptedGradingPolicies.map(ref => <li key={ref.hash + ref.version}>{data.evidence.selectedReleases.find(item => item.projection.gradingPolicy.hash === ref.hash && item.projection.gradingPolicy.version === ref.version)?.capturedPolicy.name ?? "Retained grading policy"} · version {ref.version}{"allowedLabels" in ref ? ` · allowed labels: ${ref.allowedLabels.join(", ")}` : ""}<details><summary>Exact grading reference</summary><span className="standing-review-id">{ref.hash}</span></details></li>)}</ul>
    </details>
    <details className="standing-review-source"><summary>Issued and current source evidence</summary>
      <p>The source comparison covers every term in the issued copy; changes in another covered term can make this one-term review stale. This screen calculates no annual mean.</p>
      <p>Source comparison: {data.source.current.sourceState.replaceAll("_", " ")} · issued card revision {data.source.issue.cardVersion} · checked card revision {data.source.current.cardVersion}.</p>
      {result.mean && <p>Exact term mean: {result.mean.numerator} / {result.mean.denominator} percentage points · {result.mean.displayRule}.</p>}
      <p className="standing-review-id">Issued copy {data.source.issue.id}<br />Issue SHA-256 {data.source.issue.hash}<br />Issued source SHA-256 {data.evidence.issuedSourceHash}<br />Checked source SHA-256 {data.evidence.currentSourceHash ?? "Unavailable"}<br />Comparison SHA-256 {data.evidence.comparisonHash}</p>
      <details><summary>Captured source matrix and student release projections</summary><pre>{JSON.stringify(data.evidence, null, 2)}</pre></details>
    </details>
  </div>;
}
