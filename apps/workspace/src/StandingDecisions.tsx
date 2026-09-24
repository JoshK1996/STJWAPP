import { useEffect, useRef, useState } from "react";
import { Download, History, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { api, ApiError, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import type { EligibleStandingIssues, PrepareStanding, RetainStanding, StandingDecisionCurrentness, StandingDecisionDetail, StandingDecisionList, StandingDecisionSummary, StandingPreview } from "../shared/standing-decisions";
import type { StandingPolicyDetail, StandingPolicyList, StandingPolicyRecord, StandingPolicyVersion } from "../shared/standing-policies";
import StandingReviewEvidence, { StandingPolicySource, standingOutcome, standingStamp } from "./StandingReviewEvidence";
import "./standing-decisions.css";

type Student = { id: string; name: string; student_number: string; active: boolean };
type Term = { id: string; name: string; starts_on: string; ends_on: string };
type Editor = { termId: string; termName: string; issues: EligibleStandingIssues; issueId: string; policy: StandingPolicyVersion; preview: StandingPreview | null };
type Saved = { detail: StandingDecisionDetail; currentness: StandingDecisionCurrentness | null; currentnessError: string };
type LoadState = "idle" | "loading" | "complete" | "error";
const base = "/school/standing";
const denied = (cause: unknown) => cause instanceof ApiError && [401, 403, 404].includes(cause.status);
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request could not be completed.";
const query = (values: Record<string, string>) => "?" + new URLSearchParams(values).toString();

export default function StandingDecisions({ unitId, yearId, terms, notify, onDirty }: {
  unitId: string; yearId: string; terms: Term[]; notify: (message: string, error?: boolean) => void; onDirty: (value: boolean) => void;
}) {
  const [search, setSearch] = useState(""), [students, setStudents] = useState<Student[]>([]), [studentMore, setStudentMore] = useState(false),
    [studentOffset, setStudentOffset] = useState(0), [searched, setSearched] = useState(false), [student, setStudent] = useState<Student | null>(null),
    [policies, setPolicies] = useState<StandingPolicyRecord[]>([]), [policiesLoaded, setPoliciesLoaded] = useState(false),
    [policyId, setPolicyId] = useState(""), [confirmation, setConfirmation] = useState<StandingPolicyVersion | null>(null),
    [annual, setAnnual] = useState<StandingDecisionList["items"]>([]), [annualState, setAnnualState] = useState<LoadState>("idle"),
    [editor, setEditor] = useState<Editor | null>(null), [saved, setSaved] = useState<Saved | null>(null),
    [history, setHistory] = useState<{ termId: string; termName: string; page: StandingDecisionList; stale: boolean } | null>(null),
    [reason, setReason] = useState(""), [reviewed, setReviewed] = useState(false), [attempt, setAttempt] = useState<RetainStanding | null>(null),
    [stale, setStale] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""),
    [receipt, setReceipt] = useState<StandingDecisionSummary | null>(null), [now, setNow] = useState(Date.now());
  const alive = useRef(true), generation = useRef(0), busyRef = useRef(false), attemptRef = useRef<RetainStanding | null>(null), opener = useRef<HTMLButtonElement | null>(null);
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
    if (denied(cause)) { clearPrivate(); setError("Your access or session changed. Private standing records have been cleared. Reload when access is available."); }
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
    if ((editor?.preview || reason || attemptRef.current) && !window.confirm(attemptRef.current ? "This save may already have completed. Closing discards the exact retry. Check saved reviews before preparing another. Close anyway?" : "Discard this unsaved standing review?")) return;
    resetEditor(); setSaved(null); setHistory(null); setError(""); restoreFocus();
  }
  async function loadPolicies() {
    const ticket = generation.current, rows: StandingPolicyRecord[] = [], cursors = new Set<string>(); let beforeId: string | null = null;
    do {
      const result: StandingPolicyList = await api(base + "/policies" + query({ unitId, yearId, ...(beforeId ? { beforeId } : {}) }));
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
    const ticket = generation.current, rows: StandingDecisionList["items"] = [], cursors = new Set<string>(); let cursor: string | null = null;
    setAnnualState("loading"); setAnnual([]);
    try {
      do {
        const page: StandingDecisionList = await api(base + "/decisions" + query({ unitId, yearId, studentId: personId, policyId: chosenPolicyId, latestOnly: "true", ...(cursor ? { cursor } : {}) }));
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
      api<StandingPolicyDetail>(`${base}/policies/${id}`),
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
    const issues = await api<EligibleStandingIssues>(base + "/eligible-issues" + query({ unitId, yearId, studentId: student.id, termId: term.id }));
    if (fresh(ticket)) { resetEditor(); setEditor({ termId: term.id, termName: term.name, issues, issueId: "", policy: confirmation, preview: null }); setNow(Date.now()); }
  }
  async function prepare() {
    if (!editor || !student || !editor.issueId || attemptRef.current) return;
    const ticket = generation.current, body: PrepareStanding = { policyVersionId: editor.policy.policyVersionId, studentId: student.id, yearId, termId: editor.termId, reportCardIssueId: editor.issueId };
    const preview = await api<StandingPreview>(base + "/previews", body);
    if (fresh(ticket)) { setEditor({ ...editor, preview }); setReviewed(false); setStale(false); setNow(Date.now()); }
  }
  async function refreshReview() {
    if (!editor || !student || attemptRef.current) return;
    const ticket = generation.current;
    const policiesResult = await api<{ policy: StandingPolicyRecord; confirmed: StandingPolicyVersion | null }>(`${base}/policies/${policyId}`);
    if (!fresh(ticket)) return;
    setPolicies(old => old.map(item => item.id === policyId ? policiesResult.policy : item)); setConfirmation(policiesResult.confirmed);
    if (policiesResult.policy.archived || !policiesResult.confirmed || !policiesResult.confirmed.policy.termIds.includes(editor.termId)) throw new Error("This term is no longer covered by an active confirmed policy. Your explanation is preserved; close this review and choose an applicable policy.");
    const issues = await api<EligibleStandingIssues>(base + "/eligible-issues" + query({ unitId, yearId, studentId: student.id, termId: editor.termId }));
    if (fresh(ticket)) { setEditor({ ...editor, policy: policiesResult.confirmed, issues, issueId: "", preview: null }); setReviewed(false); setStale(false); }
  }
  async function retain() {
    if (!editor?.preview) return;
    const ticket = generation.current;
    const body = attemptRef.current ?? { previewId: editor.preview.id, previewHash: editor.preview.previewHash,
      expectedPolicyVersionId: editor.preview.data.expected.policyVersionId, expectedCardVersion: editor.preview.data.expected.cardVersion,
      expectedLatestDecisionId: editor.preview.data.expected.latestDecisionId, reviewed: true as const, reason: reason.trim(), commandId: crypto.randomUUID() };
    attemptRef.current = body; setAttempt(body);
    try {
      const result = await api<StandingDecisionSummary>(base + "/decisions", body);
      if (!fresh(ticket)) return;
      resetEditor(); setReceipt(result); notify("Reviewed determination saved. Grades and awards were not changed."); restoreFocus();
      if (student) await loadAnnual(student.id, policyId);
    } catch (cause) {
      if (!fresh(ticket)) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        attemptRef.current = null; setAttempt(null);
        if (cause.status === 409) { setStale(true); setReviewed(false); }
      }
      throw cause;
    }
  }
  async function openSaved(id: string) {
    const ticket = generation.current, detail = await api<StandingDecisionDetail>(`${base}/decisions/${id}`);
    if (fresh(ticket)) { setSaved({ detail, currentness: null, currentnessError: "" }); setHistory(null); }
  }
  async function checkCurrentness() {
    if (!saved) return;
    const ticket = generation.current;
    try {
      const result = await api<StandingDecisionCurrentness>(`${base}/decisions/${saved.detail.decision.id}/currentness`);
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
      const page = await api<StandingDecisionList>(base + "/decisions" + query({ unitId, yearId, studentId: student.id, policyId, termId: term.id, ...(cursor ? { cursor } : {}) }));
      if (fresh(ticket)) setHistory(old => ({ termId: term.id, termName: term.name, stale: false, page: { ...page, items: cursor && old ? [...old.page.items, ...page.items] : page.items } }));
    } catch (cause) {
      if (fresh(ticket) && cause instanceof ApiError && cause.status === 409) setHistory({ termId: term.id, termName: term.name, stale: true, page: { items: [], nextCursor: null } });
      throw cause;
    }
  }
  const yearTerms = [...terms.map(term => ({ id: term.id, name: term.name, starts: term.starts_on, historical: false }))].sort((a, b) => a.starts.localeCompare(b.starts));
  for (const row of annual) if (!yearTerms.some(term => term.id === row.termId)) yearTerms.push({ id: row.termId, name: "Historical term", starts: "", historical: true });
  const expired = Boolean(editor?.preview && Date.parse(editor.preview.expiresAt) <= now);
  if (!yearId) return <Empty title="Choose a school year" detail="Standing reviews use an explicitly selected school year and confirmed policy." />;
  return <div className="standing-reviews" aria-busy={busy}>
    <Panel title="Standing reviews" detail="Review configured rules against an issued report-card copy. Saving a review does not publish an award or change grades."
      action={<button className="button" disabled={busy || !!editor} onClick={() => void run(async () => { await loadPolicies(); if (policyId) await choosePolicy(policyId); })}><RefreshCw size={16} />Reload records</button>}>
      <div className="standing-review-selectors"><div><form onSubmit={event => { event.preventDefault(); void run(() => searchStudents()); }}>
        <label><span>Find a student by name or number</span><input aria-label="Find a student by name or number" value={search} onChange={event => { setSearch(event.target.value); setSearched(false); setStudents([]); setStudentMore(false); }} disabled={busy} /></label>
        <div className="standing-review-actions"><button className="button" disabled={busy}><Search size={16} />Search students</button></div></form>
        <div className="standing-review-students">{students.map(value => <button key={value.id} className="button" disabled={busy} onClick={() => void run(() => chooseStudent(value))}>{value.name} · {value.student_number}{!value.active ? " · inactive" : ""}</button>)}</div>
        {searched && !students.length && <p>No matching students in this page.</p>}
        {(studentOffset > 0 || studentMore) && <div className="standing-review-actions"><button className="button" disabled={busy || studentOffset === 0} onClick={() => void run(() => searchStudents(Math.max(0, studentOffset - 100)))}>Previous students</button><button className="button" disabled={busy || !studentMore} onClick={() => void run(() => searchStudents(studentOffset + 100))}>More students</button></div>}
        {student && <p className="standing-review-selection"><strong>Selected student:</strong> {student.name} · {student.student_number}</p>}
      </div><div><label><span>Standing policy</span><select aria-label="Standing policy" disabled={busy || !policiesLoaded} value={policyId} onChange={event => void run(() => choosePolicy(event.target.value))}><option value="">Choose a policy explicitly</option>{policies.map(item => <option key={item.id} value={item.id}>{item.configuration.name} · {item.archived ? "archived" : item.activePolicyVersionId ? `confirmed copy ${item.confirmedVersion}` : "no confirmed copy"}</option>)}</select></label>
        {!policiesLoaded && <p>Policy choices have not loaded.</p>}{policiesLoaded && !policies.length && <p>No standing policies are configured for this school year.</p>}
        {selectedPolicy?.hasUnconfirmedChanges && <p>Unconfirmed draft changes exist. New reviews use the confirmed copy shown below.</p>}
        {selectedPolicy?.archived && <p>This policy is archived. Its saved reviews remain available; new reviews are disabled.</p>}
        {confirmation && <StandingPolicySource value={confirmation} />}
      </div></div>
    </Panel>
    {error && !editor && !saved && !history && <div className="standing-review-error" role="alert">{error}</div>}
    {receipt && <div className="standing-review-receipt" role="status"><strong>Saved review {receipt.number}</strong> · {standingOutcome[receipt.outcome]} · {standingStamp(receipt.capturedAt)}<div className="standing-review-actions"><button className="button" disabled={busy} onClick={event => void run(() => openSaved(receipt.id), event.currentTarget)}>Open saved receipt</button></div></div>}
    {student && policyId ? <Panel title="Full school year" detail="Each term is independent. No annual average, ranking or year-level award is calculated.">
      {annualState !== "complete" && <p className="standing-review-note" role="status">{annualState === "loading" ? "Loading all saved term decisions…" : annualState === "error" ? "Saved term decisions could not be fully loaded. Their status is unknown; refresh before relying on this view." : "Saved term decisions have not been checked."}</p>}
      <div className="standing-review-year">{yearTerms.map(term => {
        const row = annual.find(item => item.termId === term.id), canPrepare = !!confirmation && !selectedPolicy?.archived && confirmation.policy.termIds.includes(term.id);
        return <article className="standing-review-term" key={term.id}><h3>{term.name}</h3>{term.historical && <p>Retained historical term. Open its saved review for the captured term name.</p>}
          {annualState === "complete" ? row ? <><Badge tone="outline">Saved review {row.number}</Badge><p><strong>{standingOutcome[row.outcome]}</strong></p><p>Policy confirmation {row.policyVersion} · {standingStamp(row.capturedAt)}</p><button className="button" disabled={busy} onClick={event => void run(() => openSaved(row.id), event.currentTarget)}>Open saved review</button></> : <p>No decision recorded.</p> : <p>Saved status not yet verified.</p>}
          {canPrepare ? <button className="button primary" disabled={busy || annualState !== "complete"} onClick={event => void run(() => beginReview(term), event.currentTarget)}><ShieldCheck size={16} />{row ? "Prepare another review" : "Prepare review for this term"}</button> : <p>New reviews require an active confirmation covering this term.</p>}
          <button className="button" disabled={busy} onClick={event => void run(() => loadHistory(term), event.currentTarget)}><History size={16} />Review history</button>
        </article>;
      })}</div>{!yearTerms.length && annualState === "complete" && <Empty title="No terms to display" detail="No configured or retained historical terms were found for this selection." />}
    </Panel> : <Empty title="Choose a student and policy" detail="The school year opens with separate term reviews once both exact records are selected." />}
    {editor && <Modal title={editor.preview ? "Review one-term determination" : `Choose issued copy · ${editor.termName}`} onClose={closeDialog}><div className="standing-review-dialog">
      {error && <div className="standing-review-error" role="alert">{error}</div>}
      {!editor.preview ? <><StandingPolicySource value={editor.policy} /><p>Choose a currently issued report-card copy containing {editor.termName}. Older or reopened cards are not substituted.</p>
        <label><span>Issued report-card copy</span><select autoFocus aria-label="Issued report-card copy" value={editor.issueId} disabled={busy} onChange={event => setEditor({ ...editor, issueId: event.target.value })}><option value="">Choose an issued copy explicitly</option>{editor.issues.items.map(item => <option key={item.issueId} value={item.issueId}>Copy {item.issueNumber} · {standingStamp(item.issuedAt)} · card revision {item.cardVersion}</option>)}</select></label>
        {editor.issues.items.filter(item => item.issueId === editor.issueId).map(item => <div key={item.issueId}><p>Covered terms: {item.termIds.map(id => terms.find(term => term.id === id)?.name ?? "Historical term").join(", ")}</p><details><summary>Exact issued-copy reference</summary><p className="standing-review-id">{item.issueId}<br />SHA-256 {item.issueHash}</p></details></div>)}
        {!editor.issues.items.length && <p>No eligible issued copy is available. Issue a reviewed report card containing this term in Report cards, then refresh this selection.</p>}
        <div className="standing-review-actions"><button className="button" disabled={busy} onClick={() => void run(refreshReview)}>Refresh sources</button><button className="button primary" disabled={busy || !editor.issueId} onClick={() => void run(prepare)}>Prepare one-term review</button></div>
      </> : <><StandingReviewEvidence data={editor.preview.data} /><p>Private preview expires {standingStamp(editor.preview.expiresAt)}. The server checks the source again before a new save.</p>
        {attempt ? <p className="standing-review-note" role="status">The previous response was not confirmed. This review may already be saved. Retry sends exactly the same reviewed values and command, even after the preview expires.</p> : (expired || stale) && <p className="standing-review-note" role="status">{stale ? "The source or prior saved review changed." : "This preview has expired."} Refresh the source choices and review a new preview. Your explanation is preserved.</p>}
        <label><span>Review explanation (10–2,000 characters)</span><textarea aria-label="Review explanation" value={reason} minLength={10} maxLength={2000} disabled={busy || !!attempt} onChange={event => setReason(event.target.value)} /></label>
        <label className="standing-review-check"><input type="checkbox" aria-label="I reviewed the policy source, issued copy and one-term evidence" checked={reviewed} disabled={busy || !!attempt || stale} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the policy source, issued copy and one-term evidence. Saving preserves this determination; it does not announce an award or change grades.</span></label>
        <div className="standing-review-actions">{!attempt && <button className="button" disabled={busy} onClick={() => void run(refreshReview)}>Refresh and prepare again</button>}<button className="button primary" disabled={busy || (!attempt && (!reviewed || reason.trim().length < 10 || expired || stale))} onClick={() => void run(retain)}>{busy ? "Saving…" : attempt ? "Retry exact save" : editor.preview.data.result.outcome === "incomplete" ? "Save incomplete review" : "Save reviewed determination"}</button></div>
      </>}
    </div></Modal>}
    {saved && <Modal title={`Saved standing review ${saved.detail.decision.number}`} onClose={closeDialog}><div className="standing-review-dialog">
      {error && <div className="standing-review-error" role="alert">{error}</div>}
      <p>Immutable institutional copy · reviewed by {saved.detail.decision.reviewedBy.name} · {standingStamp(saved.detail.decision.capturedAt)}</p><p><strong>Recorded explanation:</strong> {saved.detail.decision.reason}</p>
      {saved.detail.decision.supersedesId && <p>This copy follows an earlier saved review. Earlier evidence remains in Review history.</p>}
      <StandingReviewEvidence data={saved.detail.decision.data} />
      <section className="standing-review-currentness"><h3>Separate current-source check</h3><p>This optional check does not change the saved outcome or downloaded evidence.</p>
        {saved.currentness ? <><p><strong>{saved.currentness.state === "matches_current_sources" ? "Matches current sources" : saved.currentness.state === "source_changed" ? "Sources have changed" : "Current sources could not be fully checked"}</strong> · checked {standingStamp(saved.currentness.checkedAt)}</p><p>Policy: {saved.currentness.policyState} · report card: {saved.currentness.cardState}</p></> : <p>{saved.currentnessError ? `Currentness unavailable: ${saved.currentnessError}` : "Current sources have not been checked from this screen."}</p>}
        <button className="button" disabled={busy} onClick={() => void run(checkCurrentness)}>Check current sources</button>
      </section>
      <div className="standing-review-actions">{(["json", "csv"] as const).map(format => <button className="button" key={format} disabled={busy} onClick={() => void run(() => download(`${base}/decisions/${saved.detail.decision.id}/export?format=${format}`, `standing-decision-${saved.detail.decision.id}-v1.${format}`))}><Download size={16} />Download saved {format.toUpperCase()}</button>)}</div>
      <details><summary>Saved identities and file checksums</summary><p className="standing-review-id">Decision {saved.detail.decision.id}<br />Snapshot SHA-256 {saved.detail.snapshotHash}<br />JSON SHA-256 {saved.detail.jsonHash} · {saved.detail.jsonBytes} bytes<br />CSV SHA-256 {saved.detail.csvHash} · {saved.detail.csvBytes} bytes</p></details>
    </div></Modal>}
    {history && <Modal title={`Saved review history · ${history.termName}`} onClose={closeDialog}><div className="standing-review-dialog">
      {error && <div className="standing-review-error" role="alert">{error}</div>}
      <p>Each saved copy preserves the reviewed evidence and explanation. The latest series pointer identifies the current retained copy; previous copies remain readable.</p>
      {history.stale ? <p role="status">Saved reviews changed while paging. The partial list has been cleared; reload the history before relying on it.</p> : !history.page.items.length && <p>No saved reviews were found for this exact term and policy.</p>}
      <ul className="standing-review-history">{history.page.items.map(row => <li key={row.id}><Badge>{row.latest ? "Latest saved copy" : "Earlier saved copy"}</Badge><p><strong>Review {row.number} · {standingOutcome[row.outcome]}</strong></p><p>Policy confirmation {row.policyVersion} · {standingStamp(row.capturedAt)}</p><button className="button" disabled={busy} onClick={() => void run(() => openSaved(row.id))}>Open review {row.number}</button></li>)}</ul>
      {history.page.nextCursor && <button className="button" disabled={busy} onClick={() => void run(() => loadHistory({ id: history.termId, name: history.termName }, history.page.nextCursor!))}>Load earlier reviews</button>}
      {history.stale && <button className="button" disabled={busy} onClick={() => void run(() => loadHistory({ id: history.termId, name: history.termName }))}>Reload history</button>}
    </div></Modal>}
  </div>;
}
