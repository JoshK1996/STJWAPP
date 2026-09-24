import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, History, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import {
  standingConfigurationSchema, type StandingConfiguration, type StandingGradingEvidence,
  type StandingPolicyCatalog, type StandingPolicyDetail, type StandingPolicyEvidence,
  type StandingPolicyHistoryPage, type StandingPolicyList, type StandingPolicyMutationResult,
  type StandingPolicyRecord, type StandingPolicyVersion, type StandingPolicyVersionsPage,
} from "../shared/standing-policies";
import "./standing-policies.css";

type Notice = (message: string, error?: boolean) => void;
type RuleDraft = { courseId: string; disposition: "" | "include" | "exclude"; required: "" | "yes" | "no"; reason: string };
type FormDraft = {
  name: string; termIds: string[]; gradeLevels: string; basis: "" | StandingConfiguration["basis"];
  acceptedGradingPolicies: Array<{ hash: string; version: number; allowedLabels: string[] }>;
  courseRules: RuleDraft[]; minimumIncludedCourses: string; missingWork: "" | StandingConfiguration["missingWork"];
  perCourseMinimum: string; meanKind: "" | "none" | "equal_weight"; meanMinimum: string;
};
type Review = { kind: "save"; configuration: StandingConfiguration; evidence: StandingPolicyCatalog; prior: StandingPolicyRecord | null }
  | { kind: "confirm"; detail: StandingPolicyDetail }
  | { kind: "archive"; detail: StandingPolicyDetail; archived: boolean };
type Attempt = { path: string; method: string; body: unknown };
const base = "/school/standing/policies";
const refKey = (item: { hash: string; version: number }) => `${item.hash}:${item.version}`;
const stamp = (value: string) => new Date(value).toLocaleString();
const toggle = (items: string[], value: string) => items.includes(value) ? items.filter(item => item !== value) : [...items, value];
const blank = (): FormDraft => ({ name: "", termIds: [], gradeLevels: "", basis: "", acceptedGradingPolicies: [], courseRules: [], minimumIncludedCourses: "", missingWork: "", perCourseMinimum: "", meanKind: "", meanMinimum: "" });
function formFrom(policy: StandingConfiguration): FormDraft {
  return { name: policy.name, termIds: [...policy.termIds], gradeLevels: policy.gradeLevels.join("\n"), basis: policy.basis,
    acceptedGradingPolicies: policy.acceptedGradingPolicies.map(item => ({ ...item, allowedLabels: "allowedLabels" in item ? [...item.allowedLabels] : [] })),
    courseRules: policy.courseRules.map(rule => ({ ...rule, required: rule.disposition === "include" ? rule.required ? "yes" : "no" : "" })),
    minimumIncludedCourses: String(policy.minimumIncludedCourses), missingWork: policy.missingWork,
    perCourseMinimum: policy.basis === "recorded_percentage" ? policy.perCourseMinimum : "",
    meanKind: policy.basis === "recorded_percentage" ? policy.meanCondition.kind : "",
    meanMinimum: policy.basis === "recorded_percentage" && policy.meanCondition.kind === "equal_weight" ? policy.meanCondition.minimum : "" };
}
function provenance(item: StandingGradingEvidence) {
  return item.provenance.map((source, index) => <li key={index}>{source.kind === "confirmed_settings"
    ? `Confirmed school grading settings · version ${source.version}`
    : <>Historical reviewed class release · book version {source.bookVersion} · {stamp(source.createdAt)}<span className="standing-id">Release {source.releaseId}</span></>}</li>);
}
function Evidence({ evidence }: { evidence: StandingPolicyEvidence }) {
  return <details className="standing-evidence"><summary>Source references retained with this configuration</summary>
    <p>{evidence.unit.name} · {evidence.year.name} · school-year version {evidence.year.version}</p>
    <p className="standing-id">Catalog SHA-256: {evidence.catalogHash}</p>
    {evidence.gradingPolicies.map(item => <section key={refKey(item)}><strong>{item.policy.name} · version {item.version}</strong><span className="standing-id">{item.hash}</span><ul>{provenance(item)}</ul></section>)}
  </details>;
}
function Configuration({ configuration: p, evidence }: { configuration: StandingConfiguration; evidence: StandingPolicyEvidence }) {
  return <div className="standing-summary">
    <dl><div><dt>Policy name</dt><dd>{p.name}</dd></div><div><dt>School / year</dt><dd>{evidence.unit.name} · {evidence.year.name}</dd></div>
      <div><dt>Applies to terms</dt><dd>{p.termIds.map(id => evidence.terms.find(term => term.id === id)?.name ?? id).join(" · ")}</dd></div>
      <div><dt>Exact grade-level values</dt><dd>{p.gradeLevels.map(value => <span className="standing-grade" key={value}>{JSON.stringify(value)}</span>)}</dd></div>
      <div><dt>Grade basis</dt><dd>{p.basis === "awarded_label" ? "Awarded labels" : "Recorded percentages"}</dd></div>
      <div><dt>Minimum included distinct courses</dt><dd>{p.minimumIncludedCourses}</dd></div>
      <div><dt>Recorded missing work</dt><dd>{p.missingWork === "use_reviewed_grade" ? "Use the reviewed grade; keep missing work visible" : "Disqualify when included course work is recorded missing"}</dd></div>
      {p.basis === "recorded_percentage" && <><div><dt>Per-course minimum</dt><dd>{p.perCourseMinimum}%</dd></div><div><dt>Term mean condition</dt><dd>{p.meanCondition.kind === "none" ? "No mean condition" : `Equal-weight mean of recorded percentages: at least ${p.meanCondition.minimum}%`}</dd></div></>}
    </dl>
    <h3>Accepted grading policies</h3><ul className="standing-ref-list">{p.acceptedGradingPolicies.map(item => {
      const source = evidence.gradingPolicies.find(row => refKey(row) === refKey(item));
      return <li key={refKey(item)}><strong>{source?.policy.name ?? "Retained grading policy"} · version {item.version}</strong>{"allowedLabels" in item && <p>Allowed awarded labels: {item.allowedLabels.join(" · ")}</p>}<details className="standing-reference"><summary>Exact grading reference and sources</summary><span className="standing-id">{item.hash}</span>{source && <ul>{provenance(source)}</ul>}</details></li>;
    })}</ul>
    <h3>Explicit course rules</h3><ul className="standing-rule-list">{p.courseRules.map(rule => {
      const course = evidence.courses.find(row => row.id === rule.courseId);
      return <li key={rule.courseId}><div><strong>{course ? `${course.code} · ${course.title}` : rule.courseId}</strong><Badge tone="outline">{rule.disposition === "exclude" ? "Excluded" : rule.required ? "Included · required" : "Included · not required"}</Badge></div><p>{rule.reason}</p></li>;
    })}</ul><p className="panel-note">Unlisted courses are unconfigured. These rules do not change grades, report cards, attendance or employee records.</p>
    <Evidence evidence={evidence} />
  </div>;
}
function ConfirmedCopy({ value }: { value: StandingPolicyVersion }) {
  return <><div className="standing-copy"><Badge tone="good">Confirmed copy {value.version}</Badge><p>Confirmed by {value.confirmedBy.name} · {stamp(value.confirmedAt)} · draft revision {value.draftVersion}</p><p><strong>School source or contact:</strong> {value.sourceDescription}</p><p><strong>Confirmation reason:</strong> {value.reason}</p><details><summary>Immutable copy identity</summary><p className="standing-id">{value.policyVersionId}</p><p className="standing-id">Policy SHA-256: {value.policyHash}</p></details></div><Configuration configuration={value.policy} evidence={value.evidence} /></>;
}

export default function StandingPolicies({ unitId, yearId, actorRole, notify, onDirty }: {
  unitId: string; yearId: string; actorRole: string; notify: Notice; onDirty: (value: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<StandingPolicyCatalog | null>(null), [list, setList] = useState<StandingPolicyList>({ rows: [], nextBeforeId: null }),
    [detail, setDetail] = useState<StandingPolicyDetail | null>(null), [form, setForm] = useState<FormDraft | null>(null),
    [review, setReview] = useState<Review | null>(null), [history, setHistory] = useState<StandingPolicyHistoryPage | null>(null),
    [versions, setVersions] = useState<StandingPolicyVersionsPage | null>(null), [copy, setCopy] = useState<StandingPolicyVersion | null>(null),
    [attempt, setAttempt] = useState<Attempt | null>(null), [reason, setReason] = useState(""), [sourceDescription, setSourceDescription] = useState(""),
    [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""), [catalogError, setCatalogError] = useState(""), [stale, setStale] = useState(false), [receipt, setReceipt] = useState(""), [issues, setIssues] = useState<string[]>([]);
  const busyRef = useRef(false), attemptRef = useRef<Attempt | null>(null), alive = useRef(true), generation = useRef(0), opener = useRef<HTMLButtonElement | null>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null), returnFromEditor = useRef(false);
  const query = `?unitId=${encodeURIComponent(unitId)}&yearId=${encodeURIComponent(yearId)}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; onDirty(false); }; }, [onDirty]);
  useEffect(() => { onDirty(Boolean(form || review || attempt || busy)); }, [form, review, attempt, busy, onDirty]);
  useEffect(() => {
    if (form || busy || !returnFromEditor.current) return;
    returnFromEditor.current = false;
    requestAnimationFrame(() => {
      const target = editorTrigger.current;
      if (!alive.current || !target?.isConnected || target.disabled || document.querySelector("dialog[open]")) return;
      if (document.activeElement === document.body || document.activeElement?.id === "workspace-main") target.focus({ preventScroll: true });
    });
  }, [form, busy]);
  const fresh = (ticket: number) => alive.current && ticket === generation.current;
  function resetReview() { setReview(null); setAttempt(null); attemptRef.current = null; setReason(""); setSourceDescription(""); setReviewed(false); }
  function clearPrivate() {
    generation.current++; setCatalog(null); setCatalogError(""); setList({ rows: [], nextBeforeId: null }); setDetail(null); setForm(null); setHistory(null); setVersions(null); setCopy(null); setReceipt(""); setIssues([]); setLoaded(false); setStale(false); resetReview();
  }
  function fail(cause: unknown) {
    if (!alive.current) return;
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      clearPrivate(); setError("Your access or session changed. Private policy records have been cleared. Reload when access is available.");
    } else setError(cause instanceof Error ? cause.message : "The request could not be completed.");
  }
  async function run(work: () => Promise<void>, trigger?: HTMLButtonElement) {
    if (busyRef.current) return;
    if (trigger) opener.current = trigger;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) { fail(cause); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function loadList(beforeId?: string) {
    const ticket = generation.current, result = await api<StandingPolicyList>(base + query + (beforeId ? `&beforeId=${beforeId}` : ""));
    if (fresh(ticket)) { setList(old => beforeId ? { ...result, rows: [...old.rows, ...result.rows.filter(row => !old.rows.some(item => item.id === row.id))] } : result); setLoaded(true); }
  }
  async function loadAll(keepDraft = false) {
    const ticket = generation.current, id = detail?.policy.id;
    const [nextCatalog, nextList, nextDetail] = await Promise.allSettled([
      api<StandingPolicyCatalog>(base + "/catalog" + query), api<StandingPolicyList>(base + query),
      id ? api<StandingPolicyDetail>(`${base}/${id}`) : Promise.resolve(null),
    ]);
    if (!fresh(ticket)) return;
    // A bounded/malformed current catalog must not hide retained policy evidence.
    // Authorization loss on any participating read still clears every private cache.
    for (const result of [nextCatalog, nextList, nextDetail]) if (result.status === "rejected" && result.reason instanceof ApiError && [401, 403, 404].includes(result.reason.status)) throw result.reason;
    if (nextCatalog.status === "fulfilled") { setCatalog(nextCatalog.value); setCatalogError(""); }
    else { setCatalog(null); setCatalogError(`Configuration references are unavailable: ${nextCatalog.reason instanceof Error ? nextCatalog.reason.message : "Could not load the current catalog."} Retained policy records and confirmed copies remain available under current access.`); }
    if (nextList.status === "fulfilled") { setList(nextList.value); setLoaded(true); }
    if (nextDetail.status === "fulfilled") setDetail(nextDetail.value);
    if (nextList.status === "rejected") throw nextList.reason;
    if (nextDetail.status === "rejected") throw nextDetail.reason;
    setStale(false);
    if (keepDraft) { resetReview(); setIssues([]); setReceipt("References refreshed. Your entered draft is preserved; compare it with the current saved revision before reviewing again."); }
  }
  useEffect(() => { if (unitId && yearId) void run(() => loadAll()); }, [unitId, yearId]);
  async function openRecord(id: string) {
    const ticket = generation.current, result = await api<StandingPolicyDetail>(`${base}/${id}`);
    if (fresh(ticket)) { setDetail(result); setForm(null); setIssues([]); setStale(false); setReceipt(""); }
  }
  function change<K extends keyof FormDraft>(key: K, value: FormDraft[K]) { setForm(old => old ? { ...old, [key]: value } : old); setIssues([]); }
  function changeRule(index: number, patch: Partial<RuleDraft>) { if (form) change("courseRules", form.courseRules.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  function restoreFocus() {
    const target = opener.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!alive.current || !target?.isConnected || target.disabled || target.closest("[inert]") || !target.getClientRects().length || document.querySelector("dialog[open]")) return;
      if (document.activeElement === document.body || document.activeElement?.id === "workspace-main") target.focus({ preventScroll: true });
    }));
  }
  function closeDialog() {
    if (busyRef.current) return;
    if (attemptRef.current && !window.confirm("A previous request may already have saved. Leave this review and reload the record before making another change?")) return;
    if (attemptRef.current) { resetReview(); setForm(null); setHistory(null); setVersions(null); setCopy(null); void run(() => loadAll()); }
    else { resetReview(); setHistory(null); setVersions(null); setCopy(null); setError(""); }
    restoreFocus();
  }
  function leaveEditor() {
    if (busyRef.current || !window.confirm("Discard this unsaved policy draft?")) return;
    returnFromEditor.current = true;
    setForm(null); setIssues([]); setError(""); setStale(false);
  }
  function beginReview(event: FormEvent) {
    event.preventDefault(); if (!form || !catalog || busyRef.current || stale) return;
    const errors: string[] = [];
    const configuration = {
      name: form.name, termIds: form.termIds, gradeLevels: form.gradeLevels.split(/\r?\n/).filter(value => value.length > 0), basis: form.basis,
      acceptedGradingPolicies: form.acceptedGradingPolicies.map(item => form.basis === "awarded_label" ? item : { hash: item.hash, version: item.version }),
      courseRules: form.courseRules.map(rule => ({ courseId: rule.courseId, disposition: rule.disposition, reason: rule.reason, ...(rule.disposition === "include" ? { required: rule.required === "" ? undefined : rule.required === "yes" } : {}) })),
      minimumIncludedCourses: /^\d+$/.test(form.minimumIncludedCourses) ? Number(form.minimumIncludedCourses) : NaN, missingWork: form.missingWork,
      ...(form.basis === "recorded_percentage" ? { perCourseMinimum: form.perCourseMinimum, meanCondition: { kind: form.meanKind, ...(form.meanKind === "equal_weight" ? { minimum: form.meanMinimum } : {}) } } : {}),
    };
    const parsed = standingConfigurationSchema.safeParse(configuration);
    if (!parsed.success) errors.push(...parsed.error.issues.map(issue => `${issue.path.join(" → ") || "Policy"}: ${issue.message}`));
    if (configuration.gradeLevels.some(value => !value.trim())) errors.push("Grade levels: enter a nonblank exact value on each used line.");
    if (form.termIds.some(id => !catalog.terms.some(term => term.id === id))) errors.push("Terms: a selected term is no longer in the current catalog. Remove it and review the remaining terms.");
    if (form.courseRules.some(rule => !catalog.courses.some(course => course.id === rule.courseId))) errors.push("Courses: a retained course is unavailable. Remove or replace that rule explicitly.");
    for (const item of form.acceptedGradingPolicies) {
      const source = catalog.gradingPolicies.find(row => refKey(row) === refKey(item));
      if (!source) errors.push(`Grading policies: version ${item.version} (${item.hash.slice(0,12)}) is unavailable in the current catalog. Choose an available reference.`);
      else if (form.basis === "awarded_label" && item.allowedLabels.some(label => !source.policy.scale.some(row => row.label === label))) errors.push(`Allowed labels for ${source.policy.name}: choose labels from this exact scale.`);
    }
    if (!parsed.success || errors.length) { setIssues(errors); return; }
    setIssues([]); setReason(""); setReviewed(false); setReview({ kind: "save", configuration: parsed.data, evidence: structuredClone(catalog), prior: detail?.policy ?? null });
  }
  function startConfirm() {
    if (!detail || !catalog || busyRef.current) return;
    setReason(""); setSourceDescription(""); setReviewed(false); setReview({ kind: "confirm", detail: structuredClone(detail) });
  }
  async function mutate() {
    if (!review || reason.trim().length < 10 || (review.kind === "confirm" && (!reviewed || sourceDescription.trim().length < 10))) return;
    let command = attemptRef.current;
    if (!command) {
      const common = { commandId: crypto.randomUUID(), reason: reason.trim() };
      command = review.kind === "save" ? {
        path: review.prior ? `${base}/${review.prior.id}` : base, method: review.prior ? "PATCH" : "POST",
        body: { ...common, ...(review.prior ? { expectedVersion: review.prior.version } : { unitId, yearId }), configuration: review.configuration, catalogHash: review.evidence.catalogHash },
      } : review.kind === "confirm" ? {
        path: `${base}/${review.detail.policy.id}/confirm`, method: "POST", body: { ...common, expectedVersion: review.detail.policy.version, draftHash: review.detail.policy.draftHash, catalogHash: review.detail.policy.catalogHash, sourceDescription: sourceDescription.trim(), reviewed: true },
      } : { path: `${base}/${review.detail.policy.id}/archive`, method: "POST", body: { ...common, expectedVersion: review.detail.policy.version, archived: review.archived } };
      attemptRef.current = command; setAttempt(command);
    }
    let result: StandingPolicyMutationResult;
    try { result = await api<StandingPolicyMutationResult>(command.path, command.body, command.method); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) {
        attemptRef.current = null; setAttempt(null);
        if (cause.status === 409) { setStale(true); setReviewed(false); }
      }
      throw cause;
    }
    if (!alive.current) return;
    returnFromEditor.current = Boolean(form);
    resetReview(); setForm(null); setStale(false); setReceipt(`Saved policy record revision ${result.policy.version}. ${result.confirmed ? `Confirmed copy ${result.confirmed.version} is retained.` : "This draft has not been owner-confirmed."}`);
    setDetail({ ...result, allowedActions: { edit: false, confirm: false, archive: false, restore: false }, catalogFreshness: "compare_with_current_catalog" });
    notify("Policy change saved. No student standing decisions were created."); restoreFocus();
    const ticket = generation.current;
    const [nextDetail, nextList] = await Promise.all([api<StandingPolicyDetail>(`${base}/${result.policy.id}`), api<StandingPolicyList>(base + query)]);
    if (fresh(ticket)) { setDetail(nextDetail); setList(nextList); }
  }
  async function loadHistory(beforeVersion?: number) {
    if (!detail) return; const ticket = generation.current;
    const result = await api<StandingPolicyHistoryPage>(`${base}/${detail.policy.id}/history${beforeVersion ? `?beforeVersion=${beforeVersion}` : ""}`);
    if (fresh(ticket)) setHistory(old => beforeVersion && old ? { ...result, rows: [...old.rows, ...result.rows] } : result);
  }
  async function loadVersions(beforeVersion?: number) {
    if (!detail) return; const ticket = generation.current;
    const result = await api<StandingPolicyVersionsPage>(`${base}/${detail.policy.id}/versions${beforeVersion ? `?beforeVersion=${beforeVersion}` : ""}`);
    if (fresh(ticket)) setVersions(old => beforeVersion && old ? { ...result, rows: [...old.rows, ...result.rows] } : result);
  }
  async function openCopy(id: string) {
    if (!detail) return; const ticket = generation.current;
    const result = await api<StandingPolicyVersion>(`${base}/${detail.policy.id}/versions/${id}`);
    if (fresh(ticket)) setCopy(result);
  }
  const catalogChanged = Boolean(detail && catalog && detail.policy.catalogHash !== catalog.catalogHash);
  const dialogOpen = Boolean(review || history || versions || copy), fieldDisabled = busy || Boolean(attempt);
  if (!yearId) return <Empty title="Choose a school year" detail="Standing policies are configured separately for an exact school and year." />;
  return <div className="standing-module" aria-busy={busy}>
    <Panel title="Standing policies" detail="Explicit school rules, reviewed and confirmed by the owner." action={<Badge tone="outline"><ShieldCheck size={14} /> Configuration only</Badge>}>
      <p className="standing-notice">Configure school rules first. No student standing decisions, honor-roll awards, class rankings or notifications are created here.</p>
      <div className="standing-actions"><button type="button" className="button secondary small" disabled={busy || Boolean(form) || dialogOpen} onClick={() => void run(() => loadAll())}><RefreshCw size={15} />Reload policy records</button>
        {!detail && <button ref={editorTrigger} type="button" className="button primary" disabled={busy || !catalog || Boolean(form) || dialogOpen} onClick={() => { setForm(blank()); setIssues([]); setReceipt(""); }}><Plus size={16} />Prepare a policy</button>}
        {detail && !form && <button type="button" className="button secondary small" disabled={busy || dialogOpen} onClick={() => { setDetail(null); setReceipt(""); setStale(false); }}>All policies</button>}
      </div>
      {!dialogOpen && error && <p className="form-error" role="alert">{error}</p>}
      {catalogError && <p className="standing-notice" role="status">{catalogError} Preparing, editing and confirming policies requires current references.</p>}
      {receipt && <p className="standing-notice" role="status">{receipt}</p>}
      {!loaded && !busy && !error && <p className="panel-note">Load the school’s current policy records to begin.</p>}
      {!detail && !form && loaded && (list.rows.length ? <ul className="standing-list">{list.rows.map(row => <li key={row.id}><div><strong>{row.configuration.name}</strong><p>Draft revision {row.version} · {row.archived ? "Archived" : row.confirmedVersion ? `Confirmed copy ${row.confirmedVersion}${row.hasUnconfirmedChanges ? " · unconfirmed draft changes" : ""}` : "Not owner-confirmed"}</p><small>Updated {stamp(row.updatedAt)}</small></div><button type="button" className="button secondary small" disabled={busy} onClick={event => void run(() => openRecord(row.id), event.currentTarget)} aria-label={`Open policy ${row.configuration.name}`}>Open policy</button></li>)}</ul>
        : <Empty title="No standing policies configured" detail="Prepare explicit rules from an authorized school source. No thresholds or calculation choices are assumed." />)}
      {!detail && !form && list.nextBeforeId && <button type="button" className="button secondary small" disabled={busy} onClick={() => void run(() => loadList(list.nextBeforeId!))}>Load more policies</button>}
    </Panel>

    {detail && !form && <Panel title={detail.policy.configuration.name} detail={`Draft revision ${detail.policy.version} · ${detail.policy.archived ? "Archived" : "Active record"}`}>
      <div className="standing-actions">
        {detail.allowedActions.edit && <button ref={editorTrigger} type="button" className="button primary" disabled={busy || !catalog} onClick={() => { setForm(formFrom(detail.policy.configuration)); setIssues([]); setReceipt(""); }}>Edit draft</button>}
        {["developer", "owner"].includes(actorRole) && detail.allowedActions.confirm && <button type="button" className="button primary" disabled={busy || !catalog || catalogChanged} onClick={event => { opener.current = event.currentTarget; startConfirm(); }}><CheckCircle2 size={16} />Review owner confirmation</button>}
        <button type="button" className="button secondary" disabled={busy} onClick={event => void run(() => loadHistory(), event.currentTarget)}><History size={16} />Policy history</button>
        <button type="button" className="button secondary" disabled={busy} onClick={event => void run(() => loadVersions(), event.currentTarget)}>Confirmed copies</button>
        {(detail.allowedActions.archive || detail.allowedActions.restore) && <button type="button" className="button secondary" disabled={busy} onClick={event => { opener.current = event.currentTarget; setReason(""); setReview({ kind: "archive", detail: structuredClone(detail), archived: !detail.policy.archived }); }}>{detail.policy.archived ? "Restore policy" : "Archive policy"}</button>}
      </div>
      {!["developer", "owner"].includes(actorRole) && <p className="panel-note">School-office staff prepare drafts. The current organization owner or developer confirms the exact reviewed policy and its school source.</p>}
      <p className="standing-notice">{detail.confirmed ? `Confirmed copy ${detail.confirmed.version} remains unchanged.${detail.policy.hasUnconfirmedChanges ? " This draft contains changes awaiting owner confirmation." : ""}` : "This is a draft. No school policy has been owner-confirmed for this record."}</p>
      {catalogChanged && <p className="standing-notice">Current source references have changed since this draft was saved. Edit and review the draft against the refreshed catalog before owner confirmation. The retained evidence below is unchanged.</p>}
      <Configuration configuration={detail.policy.configuration} evidence={detail.policy.evidence} />
    </Panel>}

    {form && catalog && <Panel title={detail ? "Prepare a policy revision" : "Prepare a new policy"} detail={`${catalog.unit.name} · ${catalog.year.name}`}>
      <form className="standing-form" onSubmit={beginReview}>
        {issues.length > 0 && <div className="form-error" role="alert"><strong>Review these fields:</strong><ul>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
        {stale && <p className="standing-notice">The saved revision or source catalog changed. Your draft is preserved. Refresh the references and compare before trying again.</p>}
        <fieldset disabled={busy || stale}><legend>Policy and applicability</legend>
          <label>Policy name<input autoFocus value={form.name} onChange={event => change("name", event.target.value)} required minLength={2} maxLength={120} /></label>
          <fieldset><legend>Applicable terms — choose explicitly</legend><div className="standing-choices">{catalog.terms.map(term => <label className="standing-choice" key={term.id}><input type="checkbox" checked={form.termIds.includes(term.id)} onChange={() => change("termIds", toggle(form.termIds, term.id))} /><span>{term.name}<small>{term.startsOn} through {term.endsOn}{term.locked ? " · term locked" : ""}</small></span></label>)}</div>{!catalog.terms.length && <p className="panel-note">Add school terms in School setup before configuring a policy.</p>}
            {form.termIds.filter(id => !catalog.terms.some(term => term.id === id)).map(id => <p key={id} className="form-error">Unavailable selected term {id} <button type="button" className="text-link" onClick={() => change("termIds", form.termIds.filter(item => item !== id))}>Remove term</button></p>)}
          </fieldset>
          <label>Exact grade-level values<textarea aria-label="Exact grade-level values" value={form.gradeLevels} onChange={event => change("gradeLevels", event.target.value)} required rows={3} aria-describedby="standing-grade-help" /></label><p className="panel-note" id="standing-grade-help">Enter one actual enrollment grade-level value per line. Case and spaces are preserved. No grade levels are inferred or preselected.</p>
        </fieldset>
        <fieldset disabled={busy || stale}><legend>What a grade means</legend>
          <label>Grade basis<select aria-label="Grade basis" value={form.basis} required onChange={event => change("basis", event.target.value as FormDraft["basis"])}><option value="">Choose the school’s intended basis</option><option value="awarded_label">Awarded labels</option><option value="recorded_percentage">Recorded percentages</option></select></label>
          <p className="standing-notice">A displayed percentage can be rounded differently from its awarded label. Use the school’s explicit choice; old scores are never recalculated or converted from label text.</p>
          <fieldset><legend>Accepted grading policies</legend><p className="panel-note">Choose each exact version and hash. Historical reviewed class policies can differ from the school’s current settings.</p>
            {catalog.gradingPolicies.map(item => { const selected = form.acceptedGradingPolicies.find(row => refKey(row) === refKey(item)); return <section className="standing-source-card" key={refKey(item)}>
              <label className="standing-choice"><input type="checkbox" aria-label={`Accept ${item.policy.name} version ${item.version} ${item.hash.slice(0,8)}`} checked={Boolean(selected)} onChange={() => change("acceptedGradingPolicies", selected ? form.acceptedGradingPolicies.filter(row => refKey(row) !== refKey(item)) : [...form.acceptedGradingPolicies, { hash: item.hash, version: item.version, allowedLabels: [] }])} /><span>{item.policy.name} · version {item.version}</span></label>
              <details className="standing-reference"><summary>Grading policy source details</summary><span className="standing-id">{item.hash}</span><ul>{provenance(item)}</ul></details><p className="panel-note">Scale: {item.policy.scale.map(row => `${row.label} (minimum ${row.minimum / 100}%)`).join(" · ") || "No awarded-label scale"}</p>
              {selected && form.basis === "awarded_label" && <fieldset><legend>Allowed labels for {item.policy.name} · v{item.version}</legend><div className="standing-choices">{item.policy.scale.map(row => <label className="standing-choice" key={row.label}><input type="checkbox" checked={selected.allowedLabels.includes(row.label)} onChange={() => change("acceptedGradingPolicies", form.acceptedGradingPolicies.map(value => refKey(value) === refKey(item) ? { ...value, allowedLabels: toggle(value.allowedLabels, row.label) } : value))} /><span>{row.label}</span></label>)}</div></fieldset>}
            </section>; })}
            {!catalog.gradingPolicies.length && <p className="panel-note">No confirmed current grading policy or reviewed class policy is available for this school year. Configure actual grading rules or review the relevant gradebooks first.</p>}
            {form.acceptedGradingPolicies.filter(item => !catalog.gradingPolicies.some(row => refKey(row) === refKey(item))).map(item => <p className="form-error standing-id" key={refKey(item)}>Unavailable reference v{item.version} · {item.hash} <button type="button" className="text-link" onClick={() => change("acceptedGradingPolicies", form.acceptedGradingPolicies.filter(row => refKey(row) !== refKey(item)))}>Remove reference</button></p>)}
          </fieldset>
        </fieldset>
        <fieldset disabled={busy || stale}><legend>Explicit course rules</legend><p className="panel-note">Choose exact courses and a reason for each rule. Unlisted courses remain unconfigured; they are not silently excluded. Required included courses must have a usable result in a future standing review.</p>
          <label>Add a course rule<select aria-label="Add a course rule" value="" onChange={event => { if (event.target.value) change("courseRules", [...form.courseRules, { courseId: event.target.value, disposition: "", required: "", reason: "" }]); }}><option value="">Choose a course</option>{catalog.courses.filter(course => !form.courseRules.some(rule => rule.courseId === course.id)).map(course => <option key={course.id} value={course.id}>{course.code} · {course.title}{course.archived ? " · archived" : ""}{course.offeredInYear ? " · offered this year" : " · not offered this year"}</option>)}</select></label>
          {form.courseRules.map((rule, index) => { const course = catalog.courses.find(row => row.id === rule.courseId); return <fieldset className="standing-course-rule" key={rule.courseId}><legend>{course ? `${course.code} · ${course.title}` : `Unavailable course ${rule.courseId}`}</legend>
            <div className="standing-grid"><label>Course treatment<select aria-label={`Course treatment ${index + 1}`} value={rule.disposition} required onChange={event => changeRule(index, { disposition: event.target.value as RuleDraft["disposition"] })}><option value="">Choose a treatment</option><option value="include">Include</option><option value="exclude">Exclude</option></select></label>
              {rule.disposition === "include" && <label>Required course<select aria-label={`Required course ${index + 1}`} value={rule.required} required onChange={event => changeRule(index, { required: event.target.value as RuleDraft["required"] })}><option value="">Choose explicitly</option><option value="yes">Required</option><option value="no">Not required</option></select></label>}
            </div><label>Reason for this course rule<textarea aria-label={`Course rule reason ${index + 1}`} value={rule.reason} minLength={5} maxLength={1000} required rows={2} onChange={event => changeRule(index, { reason: event.target.value })} /></label>
            <button type="button" className="button secondary small" onClick={() => change("courseRules", form.courseRules.filter((_, i) => i !== index))}><Trash2 size={14} />Remove course rule</button>
          </fieldset>; })}
        </fieldset>
        <fieldset disabled={busy || stale}><legend>Conditions</legend><div className="standing-grid">
          <label>Minimum included distinct courses<input type="text" inputMode="numeric" value={form.minimumIncludedCourses} required pattern="[0-9]+" onChange={event => change("minimumIncludedCourses", event.target.value)} /></label>
          <label>Recorded missing work<select aria-label="Recorded missing work" value={form.missingWork} required onChange={event => change("missingWork", event.target.value as FormDraft["missingWork"])}><option value="">Choose how to treat missing work</option><option value="use_reviewed_grade">Use the reviewed grade</option><option value="disqualify">Disqualify for recorded missing work</option></select></label>
        </div><p className="panel-note">Recorded missing work remains visible in either case. This does not change a gradebook’s missing-work scoring rule.</p>
          {form.basis === "recorded_percentage" && <><label>Minimum recorded percentage for every included course<input type="text" inputMode="decimal" value={form.perCourseMinimum} required onChange={event => change("perCourseMinimum", event.target.value)} /></label>
            <label>Term mean condition<select aria-label="Term mean condition" value={form.meanKind} required onChange={event => change("meanKind", event.target.value as FormDraft["meanKind"])}><option value="">Choose explicitly</option><option value="none">No mean condition</option><option value="equal_weight">Require an equal-weight term mean</option></select></label>
            {form.meanKind === "equal_weight" && <label>Minimum equal-weight term mean<input type="text" inputMode="decimal" required value={form.meanMinimum} onChange={event => change("meanMinimum", event.target.value)} /></label>}
            <p className="panel-note">Use exact nonnegative decimal percentages with at most two decimal places. An optional mean uses recorded percentages in one term, with equal course weight. It is not an annual average, credit calculation or GPA.</p></>}
        </fieldset>
        {detail && <details className="standing-evidence"><summary>Compare with current saved draft revision {detail.policy.version}</summary><Configuration configuration={detail.policy.configuration} evidence={detail.policy.evidence} /></details>}
        <div className="standing-actions"><button type="submit" className="button primary" disabled={busy || stale}>Review policy draft</button><button type="button" className="button secondary" disabled={busy} onClick={leaveEditor}><ArrowLeft size={16} />Discard draft</button>{stale && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => loadAll(true))}>Refresh references and preserve draft</button>}</div>
      </form>
    </Panel>}

    {review && <Modal title={review.kind === "save" ? "Review policy draft" : review.kind === "confirm" ? "Owner policy confirmation" : review.archived ? "Archive standing policy" : "Restore standing policy"} onClose={closeDialog}>
      <div className="standing-dialog" aria-busy={busy}>{error && <p className="form-error" role="alert">{error}</p>}
        {review.kind === "save" ? <>{review.prior && <details className="standing-evidence"><summary>Before — saved draft revision {review.prior.version}</summary><Configuration configuration={review.prior.configuration} evidence={review.prior.evidence} /></details>}<h3>Proposed draft</h3><Configuration configuration={review.configuration} evidence={review.evidence} /></>
          : <><p className="standing-notice">Exact saved draft revision {review.detail.policy.version}. {review.kind === "confirm" ? "Confirmation retains these rules and their original source evidence; it creates no student standing results." : "Existing confirmed copies and history remain retained."}</p><Configuration configuration={review.detail.policy.configuration} evidence={review.detail.policy.evidence} /></>}
        {stale && <p className="standing-notice">This review is stale. Refresh the saved record and source references, then review again. Entered policy fields are preserved.</p>}
        {attempt && !busy && <p className="standing-notice" role="status">The response was not confirmed. The original request is fixed. Retry sends the same command and reviewed fields, so it can recover a completed save.</p>}
        <form onSubmit={event => { event.preventDefault(); if (!busyRef.current && !stale) void run(mutate); }}>
          {review.kind === "confirm" && <><label>School source or authorized contact description<textarea aria-label="School source or authorized contact description" value={sourceDescription} minLength={10} maxLength={2000} required disabled={fieldDisabled || stale} onChange={event => setSourceDescription(event.target.value)} placeholder="Identify the document or school contact confirming these rules" /></label><label className="standing-choice"><input type="checkbox" checked={reviewed} required disabled={fieldDisabled || stale} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed this exact saved policy and its school source.</span></label></>}
          <label>Reason for this change<textarea aria-label="Reason for this change" value={reason} minLength={10} maxLength={2000} required disabled={fieldDisabled || stale} onChange={event => setReason(event.target.value)} /></label>
          <div className="standing-actions"><button type="submit" className="button primary" disabled={busy || stale || (!attempt && (reason.trim().length < 10 || (review.kind === "confirm" && (!reviewed || sourceDescription.trim().length < 10))))}>{busy ? "Saving…" : attempt ? "Retry same request" : review.kind === "save" ? "Save reviewed draft" : review.kind === "confirm" ? "Confirm reviewed policy" : review.archived ? "Archive policy" : "Restore policy"}</button><button type="button" className="button secondary" disabled={busy} onClick={closeDialog}>{attempt ? "Leave review and reload" : "Back"}</button>
            {stale && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => loadAll(true))}>Refresh references and review again</button>}</div>
        </form>
      </div>
    </Modal>}

    {(history || versions || copy) && <Modal title={copy ? `Confirmed policy copy ${copy.version}` : history ? "Policy change history" : "Confirmed policy copies"} onClose={closeDialog}>
      <div className="standing-dialog" aria-busy={busy}>{error && <p className="form-error" role="alert">{error}</p>}
        {copy ? <><ConfirmedCopy value={copy} /><button type="button" className="button secondary" disabled={busy} onClick={() => setCopy(null)}>Back to confirmed copies</button></> : history ? <>
          {history.rows.map(row => <article className="standing-history" key={row.version}><h3>Revision {row.version} · {row.action}</h3><p>{row.actor.name} · {stamp(row.createdAt)}</p><p><strong>Reason:</strong> {row.reason}</p>{row.before && <details><summary>Before this change</summary><Configuration configuration={row.before.configuration} evidence={row.before.evidence} /></details>}<details><summary>After this change</summary><p>{row.after.archived ? "Archived" : "Active record"} · confirmed copy {row.after.confirmedVersion || "none"}</p><Configuration configuration={row.after.configuration} evidence={row.after.evidence} /></details></article>)}
          {history.nextBeforeVersion && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => loadHistory(history.nextBeforeVersion!))}>Load older history</button>}
        </> : versions && <>{!versions.rows.length && <Empty title="No confirmed copies yet" detail="An owner must review and confirm an explicit saved draft first." />}<ul className="standing-list">{versions.rows.map(value => <li key={value.policyVersionId}><div><strong>Confirmed copy {value.version} · {value.policy.name}</strong><p>{value.confirmedBy.name} · {stamp(value.confirmedAt)}</p><p>{value.sourceDescription}</p></div><button type="button" className="button secondary small" disabled={busy} onClick={() => void run(() => openCopy(value.policyVersionId))}>Open copy {value.version}</button></li>)}</ul>{versions.nextBeforeVersion && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => loadVersions(versions.nextBeforeVersion!))}>Load older confirmed copies</button>}</>}
        <div className="standing-actions"><button type="button" className="button secondary" disabled={busy} onClick={closeDialog}>Close</button></div>
      </div>
    </Modal>}
  </div>;
}
