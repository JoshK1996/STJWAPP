import { useEffect, useRef, useState } from "react";
import { Download, History, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { api, ApiError, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import type { EligibleGpaIssues, PrepareGpa, RetainGpa, GpaDecisionCurrentness, GpaDecisionDetail, GpaDecisionList, GpaDecisionSummary, GpaPreview } from "../shared/gpa-decisions";
import type { GpaPolicyRecord, GpaPolicyVersion } from "../shared/gpa-policies";
import { eligibleGpaIssuesSchema, gpaDecisionCurrentnessSchema, gpaDecisionDetailSchema, gpaDecisionListSchema, gpaPreviewSchema, gpaRetainResultSchema, retainGpaInput, type GpaReviewData, type ExactGpaSummary } from "../shared/gpa-decisions";
import { gpaPolicyDetailSchema, gpaPolicyListSchema } from "../shared/gpa-policies";
import type { TermGpaResult, TermGpaConfiguration } from "../shared/term-gpa";
import "./gpa-reviews.css";

type Student = { id: string; name: string; student_number: string; active: boolean };
type Term = { id: string; name: string; starts_on: string; ends_on: string };
type Editor = { termId: string; termName: string; issues: EligibleGpaIssues; issueId: string; policy: GpaPolicyVersion; preview: GpaPreview | null };
type Saved = { detail: GpaDecisionDetail; currentness: GpaDecisionCurrentness | null; currentnessError: string };
type LoadState = "idle" | "loading" | "complete" | "error";
const base = "/school/gpa";
const denied = (cause: unknown) => cause instanceof ApiError && [401, 403, 404].includes(cause.status);
const message = (cause: unknown) => cause instanceof ApiError ? cause.message : cause instanceof Error && cause.name === "ZodError" ? "The response could not be verified. Reload this view or retry the exact pending save." : cause instanceof TypeError ? "The connection did not provide a confirmed response. Try again when it is available." : cause instanceof Error ? cause.message : "The request could not be completed.";
const query = (values: Record<string, string>) => "?" + new URLSearchParams(values).toString();
const gpaStamp = (value: string) => new Date(value).toLocaleString();
const gpaOutcome: Record<TermGpaResult["outcome"], string> = { calculated: "Calculated term GPA", incomplete: "Incomplete — GPA unavailable" };
const rounding = { half_up: "round half up", half_even: "round half to even", truncate: "truncate" };
const displayRuleText = (value: TermGpaConfiguration["display"]) => `${value.decimalPlaces} decimal places · ${rounding[value.rounding]}`;
const fractionText = (value: { numerator: string; denominator: string }) => `${value.numerator} / ${value.denominator}`;
function GpaSummary({ value }: { value: ExactGpaSummary | null }) {
  return value ? <div className="gpa-review-number"><p className="gpa-review-points">{value.display}</p><p>Configured display: {displayRuleText(value.displayRule)}.</p><details><summary>Exact term GPA</summary><p>{fractionText(value)}</p><p>The displayed value follows the confirmed rounding rule. The saved fraction retains the full value.</p></details></div> : <p>No numerical GPA is available. This is not a zero GPA.</p>;
}
function GpaPolicySource({ value }: { value: GpaPolicyVersion }) {
  return <section className="gpa-review-source"><h3>{value.policy.name} · confirmed copy {value.version}</h3>
    <p><strong>School source or contact:</strong> {value.sourceDescription}</p><p>Confirmed by {value.confirmedBy.name} · {gpaStamp(value.confirmedAt)}</p>
    <p>Recorded awarded labels map to explicit points; included course weights control the calculation. Final display: {displayRuleText(value.policy.display)}.</p>
    <details><summary>Confirmation and exact source references</summary><p>{value.reason}</p><p className="gpa-review-id">Copy {value.policyVersionId}<br />Policy SHA-256 {value.policyHash}<br />Configuration SHA-256 {value.configurationHash}</p>
      <p>These references were captured with the confirmed policy; they are not today's grading settings.</p>
      {value.evidence.gradingPolicies.map(ref => <div key={ref.hash + ref.version}><strong>{ref.policy.name} · version {ref.version}</strong><p>{ref.provenance.map(source => source.kind === "confirmed_settings" ? `Confirmed school settings revision ${source.version}` : `Reviewed class release · book revision ${source.bookVersion}`).join("; ")}</p><p className="gpa-review-id">{ref.hash}</p></div>)}
    </details></section>;
}
type BlockerCode = TermGpaResult["blockers"][number]["code"];
const blockerText: Record<BlockerCode, string> = {
  source_changed: "The current sources differ from the issued report-card copy.", source_unavailable: "A required current source could not be checked.",
  card_version_changed: "The report-card revision has changed since this issued copy.", unmapped_course: "This class has no identified course.",
  unclassified_course: "The policy does not explicitly include or exclude this course.", missing_required_course: "A course required by the policy is missing.",
  duplicate_course: "More than one class supplies this included course.", missing_release: "A reviewed class result is missing.", missing_grade: "The student's reviewed grade is missing.",
  unsupported_grading_policy: "The class grading policy is not accepted by this GPA policy.", no_evidence: "No reviewed grading evidence is available for this course.",
  pending_grade: "The grade has pending work.", incomplete_grade: "The grade is recorded as incomplete.", provisional_grade: "The grade remains provisional.",
  no_awarded_label: "The awarded label required by this policy is missing.", unmapped_awarded_label: "The exact awarded label has no configured mapping.",
  unsupported_awarded_label: "The confirmed policy explicitly marks this awarded label unsupported.", recorded_missing_work: "Recorded missing work blocks calculation under this policy.",
  no_included_courses: "No complete included course can contribute.", minimum_courses: "Fewer complete distinct contributing courses are available than this policy requires.",
};
const explain = (code: string) => blockerText[code as BlockerCode] ?? `Additional blocker (${code}). Its explanation is unavailable; do not infer a GPA from missing explanatory text.`;
function GpaReviewEvidence({ data }: { data: GpaReviewData }) {
  const { result, policy, labels, policyConfirmation: confirmation } = data;
  const courseName = (courseId: string | null, sectionId: string | null) => {
    if (!courseId && !sectionId) return "Whole term";
    const row = labels.courses.find(value => sectionId ? value.sectionId === sectionId : value.courseId === courseId);
    const course = confirmation.evidence.courses.find(value => value.id === courseId);
    return row ? `${row.courseTitle ?? row.sectionName}${sectionId && row.courseTitle ? ` · ${row.sectionName}` : ""}` : course ? `${course.code} · ${course.title}` : sectionId ? "Retained class" : "Retained course";
  };
  return <div className="gpa-review-evidence"><div className={`gpa-review-outcome ${result.outcome}`}><Badge tone={result.outcome === "calculated" ? "good" : "outline"}>{result.outcome === "calculated" ? "One-term result" : "Incomplete evidence"}</Badge>
    <h3>{gpaOutcome[result.outcome]}</h3><p>{labels.studentName} · {labels.studentNumber} · {labels.yearName} · {labels.termName}</p><p>{labels.unitName} · {labels.organizationName}</p>
    <GpaSummary value={result.totals ? { ...result.totals.gpa, display: result.totals.display, displayRule: result.totals.displayRule } : null} />
    <p>This result covers one term. No yearly or cumulative GPA is calculated.</p></div>
    <section className="gpa-review-source"><h3>{policy.name} · confirmed copy {data.policyVersion.version}</h3><p><strong>School source or contact:</strong> {confirmation.sourceDescription}</p>
      <p>Confirmed by {confirmation.confirmedBy.name} · {gpaStamp(confirmation.confirmedAt)}</p><details><summary>Captured confirmation references</summary><p>{confirmation.reason}</p><p className="gpa-review-id">Copy {data.policyVersion.id}<br />Policy SHA-256 {data.policyVersion.hash}<br />Configuration SHA-256 {data.policyVersion.configurationHash}</p></details></section>
    <dl className="gpa-review-facts"><div><dt>Grade basis</dt><dd>Recorded awarded label; recorded percentages do not determine these points.</dd></div><div><dt>Formula</dt><dd>Sum of exact points × explicit course weight, divided by total contributing weight.</dd></div>
      <div><dt>Complete contributing courses</dt><dd>{result.contributingCourseCount} · minimum {result.minimumIncludedCourses} · {result.includedCourseCount} included course identities</dd></div><div><dt>Recorded missing work</dt><dd>{policy.missingWork === "block_calculation" ? "Blocks calculation" : "Use the reviewed grade"}</dd></div>
      <div><dt>Configured display</dt><dd>{displayRuleText(policy.display)}</dd></div>
      {result.totals && <><div><dt>Exact weighted point total</dt><dd className="gpa-review-number">{fractionText(result.totals.weightedPoints)}</dd></div><div><dt>Exact contributing weight total</dt><dd className="gpa-review-number">{fractionText(result.totals.totalWeight)}</dd></div></>}
    </dl>
    {!!result.blockers.length && <section className="gpa-review-problems"><h3>Evidence still needed</h3><p>Complete course contributions below are retained as evidence; they do not create a partial overall GPA.</p><ul>{result.blockers.map((item, i) => <li key={i}><strong>{courseName(item.courseId, item.sectionId)}:</strong> {explain(item.code)}</li>)}</ul></section>}
    <h3>Course contributions and exclusions</h3>{!result.courses.length && <p>No course rows were available. This does not imply a zero grade or GPA.</p>}
    <div className="gpa-review-courses">{result.courses.map(row => {
      const label = labels.courses.find(value => value.sectionId === row.sectionId);
      const mapping = policy.acceptedGradingPolicies.find(value => value.hash === row.gradingPolicy?.hash && value.version === row.gradingPolicy?.version);
      const labelRule = mapping?.labelRules.find(value => value.label === row.grade?.label);
      const grading = confirmation.evidence.gradingPolicies.find(value => value.hash === row.gradingPolicy?.hash && value.version === row.gradingPolicy?.version);
      return <article key={row.sectionId}><h4>{courseName(row.courseId, row.sectionId)}</h4><p><Badge tone="outline">{row.disposition === "include" ? row.required ? "Included · required" : "Included · not required" : row.disposition === "exclude" ? "Excluded by policy" : "Not configured"}</Badge> <Badge>{row.outcome === "contributes" ? "Contributes" : row.outcome.replaceAll("_", " ")}</Badge></p>
        <p>{row.policyReason ?? "No course rule is configured."}</p><p><strong>Printed report card:</strong> {label?.printDisposition === "included" ? "Included" : label?.printDisposition === "excluded" ? `Excluded · ${label.printedExclusionReason ?? "No retained reason"}` : "Not in the issued copy"}. Print choices do not determine GPA inclusion.</p>
        <dl className="gpa-review-facts"><div><dt>Exact awarded label</dt><dd className="gpa-review-label">{row.grade?.label == null ? "Not recorded" : JSON.stringify(row.grade.label)}</dd></div><div><dt>Mapped points</dt><dd className="gpa-review-number">{row.points ?? "Unavailable; no contribution inferred"}</dd></div>
          <div><dt>Explicit course weight</dt><dd className="gpa-review-number">{row.weight ?? "Not included"}</dd></div><div><dt>Exact weighted contribution</dt><dd className="gpa-review-number">{row.weightedPoints ? fractionText(row.weightedPoints) : "No contribution"}</dd></div>
          <div><dt>Recorded percentage (context only)</dt><dd>{row.grade?.percentage == null ? "Not recorded" : `${row.grade.percentage}%`}</dd></div><div><dt>Missing / pending work</dt><dd>{row.grade ? `${row.grade.missing} missing · ${row.grade.pending} pending` : "Not recorded"}</dd></div>
          <div><dt>Grade evidence</dt><dd>{row.grade ? `${row.grade.hasEvidence ? "Evidence present" : "No evidence"} · ${row.grade.provisional ? "Provisional" : "Not provisional"} · ${row.grade.incomplete ? "Incomplete" : "Not marked incomplete"}` : "No grade record"}</dd></div>
          <div><dt>Grading policy</dt><dd>{grading ? `${grading.policy.name} · version ${grading.version}` : row.gradingPolicy ? `Retained grading policy · version ${row.gradingPolicy.version}` : "Unavailable"}</dd></div></dl>
        {labelRule?.kind === "unsupported" && <p><strong>Configured unsupported-label reason:</strong> {labelRule.reason}</p>}
        {!!row.blockers.length && <ul>{row.blockers.map(code => <li key={code}>{explain(code)}</li>)}</ul>}
        {row.release && <details><summary>Reviewed release reference</summary><p>Book revision {row.release.bookVersion} · reviewed {gpaStamp(row.release.reviewedAt)}</p><p className="gpa-review-id">{row.release.id}<br />{row.release.hash}</p></details>}
      </article>;
    })}</div>
    <details className="gpa-review-source"><summary>All configured course and label rules</summary><p>Exact grade levels: {policy.gradeLevels.map(value => JSON.stringify(value)).join(", ")}. Applies to: {policy.termIds.map(id => confirmation.evidence.terms.find(value => value.id === id)?.name ?? `Retained term ${id}`).join(", ")}.</p>
      <ul>{policy.courseRules.map(rule => <li key={rule.courseId}><strong>{courseName(rule.courseId, null)}:</strong> {rule.disposition}{rule.disposition === "include" ? ` · ${rule.required ? "required" : "not required"} · weight ${rule.weight}` : ""} · {rule.reason}</li>)}</ul>
      {policy.acceptedGradingPolicies.map(ref => <section key={ref.hash + ref.version}><h4>{confirmation.evidence.gradingPolicies.find(value => value.hash === ref.hash && value.version === ref.version)?.policy.name ?? "Retained grading policy"} · version {ref.version}</h4><ul>{ref.labelRules.map(rule => <li key={rule.label}><span className="gpa-review-label">{JSON.stringify(rule.label)}</span>: {rule.kind === "points" ? `${rule.points} points` : `Unsupported · ${rule.reason}`}</li>)}</ul><details><summary>Exact grading reference</summary><span className="gpa-review-id">{ref.hash}</span></details></section>)}
      <details><summary>Original owner-confirmation catalog evidence</summary><pre>{JSON.stringify(confirmation.evidence, null, 2)}</pre></details>
    </details>
    <details className="gpa-review-source"><summary>Whole issued-card freshness and source evidence</summary><p>Source comparison covers every term in the issued copy. A change in another covered term can stale this one-term review; excluded courses do not hide changes. No annual GPA is calculated.</p>
      <p>Source comparison: {data.source.current.sourceState.replaceAll("_", " ")} · issued card revision {data.source.issue.cardVersion} · checked card revision {data.source.current.cardVersion}.</p>
      <p className="gpa-review-id">Issued copy {data.source.issue.id}<br />Issue SHA-256 {data.source.issue.hash}<br />Issued source SHA-256 {data.evidence.issuedSourceHash}<br />Checked source SHA-256 {data.evidence.currentSourceHash ?? "Unavailable"}<br />Comparison SHA-256 {data.evidence.comparisonHash}</p>
      <details><summary>Captured source matrix and student releases</summary><pre>{JSON.stringify(data.evidence, null, 2)}</pre></details></details>
  </div>;
}

export default function GpaReviews({ unitId, yearId, terms, notify, onDirty }: {
  unitId: string; yearId: string; terms: Term[]; notify: (message: string, error?: boolean) => void; onDirty: (value: boolean) => void;
}) {
  const [search, setSearch] = useState(""), [students, setStudents] = useState<Student[]>([]), [studentMore, setStudentMore] = useState(false),
    [studentOffset, setStudentOffset] = useState(0), [searched, setSearched] = useState(false), [student, setStudent] = useState<Student | null>(null),
    [policies, setPolicies] = useState<GpaPolicyRecord[]>([]), [policiesLoaded, setPoliciesLoaded] = useState(false),
    [policyId, setPolicyId] = useState(""), [confirmation, setConfirmation] = useState<GpaPolicyVersion | null>(null),
    [annual, setAnnual] = useState<GpaDecisionList["items"]>([]), [annualState, setAnnualState] = useState<LoadState>("idle"),
    [editor, setEditor] = useState<Editor | null>(null), [saved, setSaved] = useState<Saved | null>(null),
    [history, setHistory] = useState<{ termId: string; termName: string; page: GpaDecisionList; stale: boolean } | null>(null),
    [reason, setReason] = useState(""), [reviewed, setReviewed] = useState(false), [attempt, setAttempt] = useState<RetainGpa | null>(null),
    [stale, setStale] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [receipt, setReceipt] = useState<GpaDecisionSummary | null>(null), [now, setNow] = useState(Date.now());
  const alive = useRef(true), generation = useRef(0), busyRef = useRef(false), attemptRef = useRef<RetainGpa | null>(null), opener = useRef<HTMLButtonElement | null>(null);
  const selectedPolicy = policies.find(item => item.id === policyId);
  const dirty = Boolean(editor?.preview || reason || attempt || busy);
  const fresh = (ticket: number) => alive.current && ticket === generation.current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; onDirty(false); }; }, [onDirty]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { if (!editor?.preview) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [editor?.preview?.id]);
  function resetEditor() { setEditor(null); setReason(""); setReviewed(false); setAttempt(null); attemptRef.current = null; setStale(false); }
  function clearPrivate() {
    generation.current++; resetEditor(); setStudents([]); setStudent(null); setSearched(false); setStudentMore(false); setSearch(""); setPolicies([]); setPoliciesLoaded(false);
    setPolicyId(""); setConfirmation(null); setAnnual([]); setAnnualState("idle"); setSaved(null); setHistory(null); setReceipt(null);
  }
  function fail(cause: unknown) {
    if (!alive.current) return;
    if (denied(cause)) { clearPrivate(); setError("Your access or session changed. Private GPA records have been cleared. Reload when access is available."); }
    else setError(message(cause));
  }
  async function run(work: () => Promise<void>, trigger?: HTMLButtonElement) {
    if (busyRef.current) return;
    if (trigger) opener.current = trigger;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) { fail(cause); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function restoreFocus() {
    const target = opener.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (alive.current && target?.isConnected && !target.disabled && !document.querySelector("dialog[open]") && (document.activeElement === document.body || document.activeElement?.id === "workspace-main")) target.focus({ preventScroll: true });
    }));
  }
  function closeDialog() {
    if (busyRef.current) return;
    if ((editor?.preview || reason || attemptRef.current) && !window.confirm(attemptRef.current ? "This save may already have completed. Closing discards the exact retry. Check saved reviews before preparing another. Close anyway?" : "Discard this unsaved GPA review?")) return;
    resetEditor(); setSaved(null); setHistory(null); setError(""); restoreFocus();
  }
  async function loadPolicies() {
    const ticket = generation.current, rows: GpaPolicyRecord[] = [], cursors = new Set<string>(); let beforeId: string | null = null;
    setPoliciesLoaded(false); setPolicies([]);
    do {
      const result = gpaPolicyListSchema.parse(await api(base + "/policies" + query({ unitId, yearId, ...(beforeId ? { beforeId } : {}) })));
      if (!fresh(ticket)) return;
      rows.push(...result.rows); beforeId = result.nextBeforeId;
      if (beforeId && cursors.has(beforeId)) throw new Error("Policy paging could not finish. Reload before choosing a policy.");
      if (beforeId) cursors.add(beforeId);
    } while (beforeId);
    if (fresh(ticket)) { setPolicies(rows); setPoliciesLoaded(true); }
  }
  useEffect(() => { if (unitId && yearId) void run(loadPolicies); }, [unitId, yearId]);
  async function searchStudents(offset = 0) {
    const ticket = generation.current, result = await api<{ rows: Student[]; hasMore: boolean }>("/school/students" + query({ unitId, search, offset: String(offset) }));
    if (fresh(ticket)) { setStudents(result.rows); setStudentMore(result.hasMore); setStudentOffset(offset); setSearched(true); }
  }
  async function loadAnnual(personId: string, chosenPolicyId: string) {
    const ticket = generation.current, rows: GpaDecisionList["items"] = [], cursors = new Set<string>(); let cursor: string | null = null;
    setAnnualState("loading"); setAnnual([]);
    try {
      do {
        const page = gpaDecisionListSchema.parse(await api(base + "/decisions" + query({ unitId, yearId, studentId: personId, policyId: chosenPolicyId, latestOnly: "true", ...(cursor ? { cursor } : {}) })));
        if (!fresh(ticket)) return;
        rows.push(...page.items); cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("Saved-review paging could not finish. Refresh to check all terms.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (fresh(ticket)) { setAnnual(rows); setAnnualState("complete"); }
    } catch (cause) { if (fresh(ticket)) setAnnualState("error"); throw cause; }
  }
  async function choosePolicy(id: string) {
    generation.current++; setPolicyId(id); setConfirmation(null); setAnnual([]); setAnnualState("idle"); setReceipt(null);
    if (!id) return;
    const ticket = generation.current;
    // Historical decisions stay reachable even if current confirmation references cannot load.
    const results = await Promise.allSettled([
      api(`${base}/policies/${id}`).then(value => gpaPolicyDetailSchema.parse(value)),
      student ? loadAnnual(student.id, id) : Promise.resolve(),
    ]);
    if (!fresh(ticket)) return;
    for (const result of results) if (result.status === "rejected" && denied(result.reason)) throw result.reason;
    if (results[0].status === "fulfilled") {
      const detail = results[0].value;
      setConfirmation(detail.confirmed); setPolicies(old => old.map(item => item.id === id ? detail.policy : item));
    }
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  async function chooseStudent(value: Student) {
    generation.current++; setStudent(value); setAnnual([]); setAnnualState("idle"); setReceipt(null);
    if (policyId) await loadAnnual(value.id, policyId);
  }
  async function beginReview(term: { id: string; name: string }) {
    if (!student || !selectedPolicy || !confirmation || selectedPolicy.archived) return;
    const ticket = generation.current;
    const issues = eligibleGpaIssuesSchema.parse(await api(base + "/eligible-issues" + query({ unitId, yearId, studentId: student.id, termId: term.id })));
    if (fresh(ticket)) { resetEditor(); setEditor({ termId: term.id, termName: term.name, issues, issueId: "", policy: confirmation, preview: null }); setNow(Date.now()); }
  }
  async function prepare() {
    if (!editor || !student || !editor.issueId || attemptRef.current) return;
    const ticket = generation.current, body: PrepareGpa = { policyVersionId: editor.policy.policyVersionId, studentId: student.id, yearId, termId: editor.termId, reportCardIssueId: editor.issueId };
    const preview = gpaPreviewSchema.parse(await api(base + "/previews", body));
    if (fresh(ticket)) { setEditor({ ...editor, preview }); setReviewed(false); setStale(false); setNow(Date.now()); }
  }
  async function refreshReview() {
    if (!editor || !student || attemptRef.current) return;
    const ticket = generation.current;
    const policiesResult = gpaPolicyDetailSchema.parse(await api(`${base}/policies/${policyId}`));
    if (!fresh(ticket)) return;
    setPolicies(old => old.map(item => item.id === policyId ? policiesResult.policy : item)); setConfirmation(policiesResult.confirmed);
    if (policiesResult.policy.archived || !policiesResult.confirmed || !policiesResult.confirmed.policy.termIds.includes(editor.termId)) throw new Error("This term is no longer covered by an active confirmed policy. Your explanation is preserved; close this review and choose an applicable policy.");
    const issues = eligibleGpaIssuesSchema.parse(await api(base + "/eligible-issues" + query({ unitId, yearId, studentId: student.id, termId: editor.termId })));
    if (fresh(ticket)) { setEditor({ ...editor, policy: policiesResult.confirmed, issues, issueId: "", preview: null }); setReviewed(false); setStale(false); }
  }
  async function retain() {
    if (!editor?.preview) return;
    const ticket = generation.current;
    const body = attemptRef.current ?? retainGpaInput.parse({ previewId: editor.preview.id, previewHash: editor.preview.previewHash,
      expectedPolicyVersionId: editor.preview.data.expected.policyVersionId, expectedCardVersion: editor.preview.data.expected.cardVersion,
      expectedLatestDecisionId: editor.preview.data.expected.latestDecisionId, reviewed: true as const, reason: reason.trim(), commandId: crypto.randomUUID() });
    attemptRef.current = body; setAttempt(body);
    let result: GpaDecisionSummary;
    try {
      result = gpaRetainResultSchema.parse(await api(base + "/decisions", body)).decision;
    } catch (cause) {
      if (!fresh(ticket)) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429) {
        attemptRef.current = null; setAttempt(null);
        if (cause.status === 409) { setStale(true); setReviewed(false); }
      }
      throw cause;
    }
    if (!fresh(ticket)) return;
    resetEditor(); setReceipt(result); notify("Reviewed term result saved. Grades were not changed."); restoreFocus();
    if (student) await loadAnnual(student.id, policyId);
  }
  async function openSaved(id: string) {
    const ticket = generation.current, detail = gpaDecisionDetailSchema.parse(await api(`${base}/decisions/${id}`));
    if (fresh(ticket)) { setSaved({ detail, currentness: null, currentnessError: "" }); setHistory(null); }
  }
  async function checkCurrentness() {
    if (!saved) return;
    const ticket = generation.current;
    try {
      const result = gpaDecisionCurrentnessSchema.parse(await api(`${base}/decisions/${saved.detail.decision.id}/currentness`));
      if (fresh(ticket)) setSaved({ ...saved, currentness: result, currentnessError: "" });
    } catch (cause) {
      if (denied(cause)) throw cause;
      if (fresh(ticket)) setSaved({ ...saved, currentness: null, currentnessError: message(cause) });
    }
  }
  async function loadHistory(term: { id: string; name: string }, cursor?: string) {
    if (!student) return;
    const ticket = generation.current;
    try {
      const page = gpaDecisionListSchema.parse(await api(base + "/decisions" + query({ unitId, yearId, studentId: student.id, policyId, termId: term.id, ...(cursor ? { cursor } : {}) })));
      if (fresh(ticket)) setHistory(old => ({ termId: term.id, termName: term.name, stale: false, page: { ...page, items: cursor && old ? [...old.page.items, ...page.items] : page.items } }));
    } catch (cause) {
      if (fresh(ticket) && cause instanceof ApiError && cause.status === 409) setHistory({ termId: term.id, termName: term.name, stale: true, page: { items: [], nextCursor: null } });
      throw cause;
    }
  }
  const yearTerms = [...terms.map(term => ({ id: term.id, name: term.name, starts: term.starts_on, historical: false }))].sort((a, b) => a.starts.localeCompare(b.starts));
  for (const term of confirmation?.evidence.terms ?? []) if (!yearTerms.some(item => item.id === term.id)) yearTerms.push({ id: term.id, name: term.name, starts: term.startsOn, historical: true });
  for (const row of annual) if (!yearTerms.some(term => term.id === row.termId)) yearTerms.push({ id: row.termId, name: "Historical term", starts: "", historical: true });
  const expired = Boolean(editor?.preview && Date.parse(editor.preview.expiresAt) <= now);
  if (!yearId) return <Empty title="Choose a school year" detail="Term GPA reviews use an explicitly selected school year and confirmed policy." />;
  return <div className="gpa-reviews" aria-busy={busy}>
    <Panel title="Term GPA reviews" detail="Review configured rules against an issued report-card copy. Saving retains the reviewed term result; it does not change grades."
      action={<button className="button" disabled={busy || !!editor} onClick={() => void run(async () => { await loadPolicies(); if (policyId) await choosePolicy(policyId); })}><RefreshCw size={16} />Reload records</button>}>
      <div className="gpa-review-selectors"><div><form onSubmit={event => { event.preventDefault(); void run(() => searchStudents()); }}>
        <label><span>Find a student by name or number</span><input aria-label="Find a student by name or number" value={search} onChange={event => { setSearch(event.target.value); setSearched(false); setStudents([]); setStudentMore(false); }} disabled={busy} /></label>
        <div className="gpa-review-actions"><button className="button" disabled={busy}><Search size={16} />Search students</button></div></form>
        <div className="gpa-review-students">{students.map(value => <button key={value.id} className="button" disabled={busy} onClick={() => void run(() => chooseStudent(value))}>{value.name} · {value.student_number}{!value.active ? " · inactive" : ""}</button>)}</div>
        {searched && !students.length && <p>No matching students in this page.</p>}
        {(studentOffset > 0 || studentMore) && <div className="gpa-review-actions"><button className="button" disabled={busy || studentOffset === 0} onClick={() => void run(() => searchStudents(Math.max(0, studentOffset - 100)))}>Previous students</button><button className="button" disabled={busy || !studentMore} onClick={() => void run(() => searchStudents(studentOffset + 100))}>More students</button></div>}
        {student && <p className="gpa-review-selection"><strong>Selected student:</strong> {student.name} · {student.student_number}</p>}
      </div><div><label><span>GPA policy</span><select aria-label="GPA policy" disabled={busy || !policiesLoaded} value={policyId} onChange={event => void run(() => choosePolicy(event.target.value))}><option value="">Choose a policy explicitly</option>{policies.map(item => <option key={item.id} value={item.id}>{item.configuration.name} · {item.archived ? "archived" : item.activePolicyVersionId ? `confirmed copy ${item.confirmedVersion}` : "no confirmed copy"}</option>)}</select></label>
        {!policiesLoaded && <p>Policy choices have not loaded.</p>}{policiesLoaded && !policies.length && <p>No GPA policies are configured for this school year.</p>}
        {selectedPolicy?.hasUnconfirmedChanges && <p>Unconfirmed draft changes exist. New reviews use the confirmed copy shown below.</p>}
        {selectedPolicy?.archived && <p>This policy is archived. Its saved reviews remain available; new reviews are disabled.</p>}
        {confirmation && <GpaPolicySource value={confirmation} />}
      </div></div>
    </Panel>
    {error && !editor && !saved && !history && <div className="gpa-review-error" role="alert">{error}</div>}
    {receipt && <div className="gpa-review-receipt" role="status"><strong>Saved review {receipt.number}</strong> · {gpaOutcome[receipt.outcome]} · {gpaStamp(receipt.capturedAt)}<GpaSummary value={receipt.gpa} /><div className="gpa-review-actions"><button className="button" disabled={busy} onClick={event => void run(() => openSaved(receipt.id), event.currentTarget)}>Open saved receipt</button></div></div>}
    {student && policyId ? <Panel title="Full school year" detail="Each term is independent. No annual GPA, average, credit or ranking is calculated.">
      {annualState !== "complete" && <p className="gpa-review-note" role="status">{annualState === "loading" ? "Loading all saved term decisions…" : annualState === "error" ? "Saved term decisions could not be fully loaded. Their status is unknown; refresh before relying on this view." : "Saved term decisions have not been checked."}</p>}
      <div className="gpa-review-year">{yearTerms.map(term => {
        const row = annual.find(item => item.termId === term.id), canPrepare = !!confirmation && !selectedPolicy?.archived && confirmation.policy.termIds.includes(term.id);
        return <article className="gpa-review-term" key={term.id}><h3>{term.name}</h3>{term.historical && <p>Retained historical term. Open its saved review for the captured term name.</p>}
          {annualState === "complete" ? row ? <><Badge tone="outline">Saved review {row.number}</Badge><p><strong>{gpaOutcome[row.outcome]}</strong></p><GpaSummary value={row.gpa} /><p>Policy confirmation {row.policyVersion} · {gpaStamp(row.capturedAt)}</p><button className="button" disabled={busy} onClick={event => void run(() => openSaved(row.id), event.currentTarget)}>Open saved review</button></> : <p>No decision recorded.</p> : <p>Saved status not yet verified.</p>}
          {canPrepare ? <button className="button primary" disabled={busy || annualState !== "complete"} onClick={event => void run(() => beginReview(term), event.currentTarget)}><ShieldCheck size={16} />{row ? "Prepare another review" : "Prepare review for this term"}</button> : <p>New reviews require an active confirmation covering this term.</p>}
          <button className="button" disabled={busy} onClick={event => void run(() => loadHistory(term), event.currentTarget)}><History size={16} />Review history</button>
        </article>;
      })}</div>{!yearTerms.length && annualState === "complete" && <Empty title="No terms to display" detail="No configured or retained historical terms were found for this selection." />}
    </Panel> : <Empty title="Choose a student and policy" detail="The school year opens with separate term reviews once both exact records are selected." />}
    {editor && <Modal title={editor.preview ? "Review one-term GPA" : `Choose issued copy · ${editor.termName}`} onClose={closeDialog}><div className="gpa-review-dialog">
      {error && <div className="gpa-review-error" role="alert">{error}</div>}
      {!editor.preview ? <><GpaPolicySource value={editor.policy} /><p>Choose a currently issued report-card copy containing {editor.termName}. Older or reopened cards are not substituted.</p>
        <label><span>Issued report-card copy</span><select autoFocus aria-label="Issued report-card copy" value={editor.issueId} disabled={busy} onChange={event => setEditor({ ...editor, issueId: event.target.value })}><option value="">Choose an issued copy explicitly</option>{editor.issues.items.map(item => <option key={item.issueId} value={item.issueId}>Copy {item.issueNumber} · {gpaStamp(item.issuedAt)} · card revision {item.cardVersion}</option>)}</select></label>
        {editor.issues.items.filter(item => item.issueId === editor.issueId).map(item => <div key={item.issueId}><p>Covered terms: {item.termIds.map(id => terms.find(term => term.id === id)?.name ?? "Historical term").join(", ")}</p><details><summary>Exact issued-copy reference</summary><p className="gpa-review-id">{item.issueId}<br />SHA-256 {item.issueHash}</p></details></div>)}
        {!editor.issues.items.length && <p>No eligible issued copy is available. Issue a reviewed report card containing this term in Report cards, then refresh this selection.</p>}
        <div className="gpa-review-actions"><button className="button" disabled={busy} onClick={() => void run(refreshReview)}>Refresh sources</button><button className="button primary" disabled={busy || !editor.issueId} onClick={() => void run(prepare)}>Prepare one-term review</button></div>
      </> : <><GpaReviewEvidence data={editor.preview.data} /><p>Private preview expires {gpaStamp(editor.preview.expiresAt)}. The server checks the source again before a new save.</p>
        {attempt ? <p className="gpa-review-note" role="status">The previous response was not confirmed. This review may already be saved. Retry sends exactly the same reviewed values and command, even after the preview expires.</p> : (expired || stale) && <p className="gpa-review-note" role="status">{stale ? "The source or prior saved review changed." : "This preview has expired."} Refresh the source choices and review a new preview. Your explanation is preserved.</p>}
        <label><span>Review explanation (10–2,000 characters)</span><textarea aria-label="Review explanation" value={reason} minLength={10} maxLength={2000} disabled={busy || !!attempt} onChange={event => setReason(event.target.value)} /></label>
        <label className="gpa-review-check"><input type="checkbox" aria-label="I reviewed the policy source, issued copy and one-term evidence" checked={reviewed} disabled={busy || !!attempt || stale} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the policy source, issued copy and one-term evidence. Saving retains this term GPA or incomplete review; it does not change grades.</span></label>
        <div className="gpa-review-actions">{!attempt && <button className="button" disabled={busy} onClick={() => void run(refreshReview)}>Refresh and prepare again</button>}<button className="button primary" disabled={busy || (!attempt && (!reviewed || reason.trim().length < 10 || expired || stale))} onClick={() => void run(retain)}>{busy ? "Saving…" : attempt ? "Retry exact save" : editor.preview.data.result.outcome === "incomplete" ? "Save incomplete review" : "Save reviewed GPA"}</button></div>
      </>}
    </div></Modal>}
    {saved && <Modal title={`Saved GPA review ${saved.detail.decision.number}`} onClose={closeDialog}><div className="gpa-review-dialog">
      {error && <div className="gpa-review-error" role="alert">{error}</div>}
      <p>Immutable institutional copy · reviewed by {saved.detail.decision.reviewedBy.name} · {gpaStamp(saved.detail.decision.capturedAt)}</p><p><strong>Recorded explanation:</strong> {saved.detail.decision.reason}</p>
      {saved.detail.decision.supersedesId && <p>This copy follows an earlier saved review. Earlier evidence remains in Review history.</p>}
      <GpaReviewEvidence data={saved.detail.decision.data} />
      <section className="gpa-review-currentness"><h3>Separate current-source check</h3><p>This optional check does not change the saved outcome or downloaded evidence.</p>
        {saved.currentness ? <><p><strong>{saved.currentness.state === "matches_current_sources" ? "Matches current sources" : saved.currentness.state === "source_changed" ? "Sources have changed" : "Current sources could not be fully checked"}</strong> · checked {gpaStamp(saved.currentness.checkedAt)}</p><p>Policy: {saved.currentness.policyState} · report card: {saved.currentness.cardState}</p></> : <p>{saved.currentnessError ? `Currentness unavailable: ${saved.currentnessError}` : "Current sources have not been checked from this screen."}</p>}
        <button className="button" disabled={busy} onClick={() => void run(checkCurrentness)}>Check current sources</button>
      </section>
      <div className="gpa-review-actions">{(["json", "csv"] as const).map(format => <button className="button" key={format} disabled={busy} onClick={() => void run(() => download(`${base}/decisions/${saved.detail.decision.id}/export?format=${format}`, `gpa-decision-${saved.detail.decision.id}-v1.${format}`))}><Download size={16} />Download saved {format.toUpperCase()}</button>)}</div>
      <details><summary>Saved identities and file checksums</summary><p className="gpa-review-id">Decision {saved.detail.decision.id}<br />Snapshot SHA-256 {saved.detail.snapshotHash}<br />JSON SHA-256 {saved.detail.jsonHash} · {saved.detail.jsonBytes} bytes<br />CSV SHA-256 {saved.detail.csvHash} · {saved.detail.csvBytes} bytes</p></details>
    </div></Modal>}
    {history && <Modal title={`Saved review history · ${history.termName}`} onClose={closeDialog}><div className="gpa-review-dialog">
      {error && <div className="gpa-review-error" role="alert">{error}</div>}
      <p>Each saved copy preserves the reviewed evidence and explanation. The latest series pointer identifies the current retained copy; previous copies remain readable.</p>
      {history.stale ? <p role="status">Saved reviews changed while paging. The partial list has been cleared; reload the history before relying on it.</p> : !history.page.items.length && <p>No saved reviews were found for this exact term and policy.</p>}
      <ul className="gpa-review-history">{history.page.items.map(row => <li key={row.id}><Badge>{row.latest ? "Latest saved copy" : "Earlier saved copy"}</Badge><p><strong>Review {row.number} · {gpaOutcome[row.outcome]}</strong></p><GpaSummary value={row.gpa} /><p>Policy confirmation {row.policyVersion} · {gpaStamp(row.capturedAt)}</p><button className="button" disabled={busy} onClick={() => void run(() => openSaved(row.id))}>Open review {row.number}</button></li>)}</ul>
      {history.page.nextCursor && <button className="button" disabled={busy} onClick={() => void run(() => loadHistory({ id: history.termId, name: history.termName }, history.page.nextCursor!))}>Load earlier reviews</button>}
      {history.stale && <button className="button" disabled={busy} onClick={() => void run(() => loadHistory({ id: history.termId, name: history.termName }))}>Reload history</button>}
    </div></Modal>}
  </div>;
}
