import { useEffect, useRef, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import { ArrowRight, History, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import type { StaffScheduleSnapshot } from "../shared/staff-scheduling";
import type { ScheduleRequestCreate, ScheduleRequestCreated, ScheduleRequestDecided, ScheduleRequestDetail, ScheduleRequestHistoryRow, ScheduleRequestList, ScheduleRequestProposal, ScheduleRequestSummary } from "../shared/schedule-requests";
import "./schedule-requests.css";

type Job = { id: string; title: string; unit_name: string; unit_id: string; active?: boolean };
type Common = { zone: string; onChanged: () => Promise<void>; notify: (message: string, error?: boolean) => void; onDirty: (dirty: boolean) => void };
type Draft = { jobId: string; startsLocal: string; endsLocal: string; startOffset: string; endOffset: string; reason: string };
type Reviewed = { input: ScheduleRequestCreate; proposal: ScheduleRequestProposal | null };
type ScheduleHistoryRow = { version: number; action: string; actor_name: string; reason: string; created_at: string; after_snapshot: StaffScheduleSnapshot };
const localFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS";
const local = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat(localFormat);
const when = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat("ccc, LLL d, yyyy · h:mm a ZZZZ");
const message = (error: unknown) => error instanceof Error ? error.message : "This request could not be completed. Please try again.";
const effect = "Approval changes only this planned shift. Clock history, pay and PTO are unchanged. This workflow does not send notifications.";
const tone = (status: string) => status === "approved" ? "green" : status === "pending" ? "warm" : "neutral";
function offsets(value: string, zone: string) {
  const date = DateTime.fromISO(value, { zone });
  return date.isValid ? date.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis()) : [];
}
function instant(value: string, offset: string, zone: string) {
  const date = DateTime.fromISO(value, { zone }), entered = DateTime.fromISO(value, { zone: "UTC" });
  if (!date.isValid || !entered.isValid || date.toFormat(localFormat) !== entered.toFormat(localFormat))
    throw new Error("This local time does not exist because of the daylight-saving change. Choose a valid time.");
  const choices = offsets(value, zone);
  if (choices.length > 1) {
    const chosen = choices.find(choice => String(choice.offset) === offset);
    if (!chosen) throw new Error("Choose the occurrence for each repeated daylight-saving time.");
    return chosen.toUTC().toISO()!;
  }
  return date.toUTC().toISO()!;
}
function Occurrence({ label, value, offset, zone, onChange }: { label: string; value: string; offset: string; zone: string; onChange: (value: string) => void }) {
  const choices = offsets(value, zone);
  return choices.length < 2 ? null : <label>{label} — this local time occurs twice<select aria-label={label} required value={offset} onChange={event => onChange(event.target.value)}><option value="">Choose which occurrence</option>{choices.map((choice, index) => <option key={choice.offset} value={String(choice.offset)}>{index === 0 ? "First" : "Second"} occurrence · {choice.toFormat("ZZZZ 'UTC'ZZ")}</option>)}</select></label>;
}
function Snapshot({ title, value, zone, cancelled = false }: { title: string; value: ScheduleRequestProposal | StaffScheduleSnapshot; zone: string; cancelled?: boolean }) {
  return <section className="schedule-request-snapshot"><h3>{title}</h3>{"version" in value && <p>Version {value.version} · {value.status === "cancelled" ? "Cancelled" : "Scheduled"}</p>}
    {cancelled && <Badge tone="warm">Would be cancelled</Badge>}<dl><dt>Job</dt><dd>{value.jobTitle}</dd><dt>Community</dt><dd>{value.unitName}</dd>
      <dt>Starts</dt><dd><time dateTime={value.startsAt}>{when(value.startsAt, zone)}</time><small>{value.startsAt}</small></dd>
      <dt>Ends</dt><dd><time dateTime={value.endsAt}>{when(value.endsAt, zone)}</time><small>{value.endsAt}</small></dd></dl>
  </section>;
}
function Comparison({ source, proposal, action, zone }: { source: StaffScheduleSnapshot; proposal: ScheduleRequestProposal | null; action: "update" | "cancel"; zone: string }) {
  return <><div className="schedule-request-comparison"><Snapshot title="Submitted source shift" value={source} zone={zone}/><Snapshot title={action === "cancel" ? "Requested cancellation" : "Proposed shift"} value={proposal ?? source} zone={zone} cancelled={action === "cancel"}/></div>
    <div className="schedule-request-note"><strong>Preserved schedule note</strong><p>{source.note || "No administrative note"}</p></div></>;
}

export function ScheduleRequestComposer({ shift, action, zone, onClose, onCreated, onChanged, notify, onDirty }: Common & {
  shift: StaffScheduleSnapshot; action: "update" | "cancel"; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [source, setSource] = useState(shift), [current, setCurrent] = useState<StaffScheduleSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({ jobId: shift.jobId, startsLocal: local(shift.startsAt, zone), endsLocal: local(shift.endsAt, zone),
    startOffset: String(DateTime.fromISO(shift.startsAt).setZone(zone).offset), endOffset: String(DateTime.fromISO(shift.endsAt).setZone(zone).offset), reason: "" }));
  const [jobs, setJobs] = useState<Job[]>([]), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [review, setReview] = useState<Reviewed | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ScheduleRequestCreated | null>(null);
  const generation = useRef(0), initial = useRef(JSON.stringify(draft));
  const dirty = !receipt && (Boolean(review) || JSON.stringify(draft) !== initial.current);
  const stale = current !== null && (current.version !== source.version || current.status !== "scheduled");
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { void loadBasis(); return () => { generation.current += 1; }; }, []);
  async function loadBasis() {
    const request = ++generation.current; setLoading(true); setLoadError("");
    try {
      const [history, clock] = await Promise.all([api<{ current: StaffScheduleSnapshot }>(`/schedules/${shift.id}/history`), api<{ jobs: Job[] }>("/clock")]);
      if (request !== generation.current) return;
      setCurrent(history.current); setJobs(clock.jobs.filter(job => job.active !== false));
    } catch (cause) { if (request === generation.current) setLoadError(message(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }
  function close() { if (!busy && (!dirty || window.confirm("Discard your unsent schedule request?"))) onClose(); }
  function update(change: Partial<Draft>) { setDraft(value => ({ ...value, ...change })); setReview(null); setError(""); }
  function prepare(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (stale || loading || loadError) throw new Error("Refresh and review the current shift before submitting.");
      const reason = draft.reason.trim();
      if (reason.length < 3) throw new Error("Enter a reason of at least 3 characters.");
      const base = { scheduleId: source.id, expectedScheduleVersion: source.version, reason, commandId: crypto.randomUUID() };
      if (action === "cancel") { setReview({ input: { ...base, action }, proposal: null }); return; }
      const job = jobs.find(job => job.id === draft.jobId);
      if (!job) throw new Error("Choose one of your current assigned jobs.");
      const startsAt = instant(draft.startsLocal, draft.startOffset, zone), endsAt = instant(draft.endsLocal, draft.endOffset, zone);
      const duration = Date.parse(endsAt) - Date.parse(startsAt);
      if (duration <= 0 || duration > 86400000) throw new Error("The shift must last more than zero and no longer than 24 hours.");
      if (job.id === source.jobId && Date.parse(startsAt) === Date.parse(source.startsAt) && Date.parse(endsAt) === Date.parse(source.endsAt))
        throw new Error("Change the job, start or end time before requesting an update.");
      setReview({ input: { ...base, action, proposal: { jobId: job.id, startsAt, endsAt } },
        proposal: { jobId: job.id, jobTitle: job.title, unitId: job.unit_id, unitName: job.unit_name, startsAt, endsAt } });
    } catch (cause) { setError(message(cause)); }
  }
  async function submit() {
    if (!review || busy || receipt || stale) return;
    setBusy(true); setError("");
    try {
      const result = await api<ScheduleRequestCreated>("/schedule-requests", review.input);
      setReceipt(result); onDirty(false); notify("Schedule request submitted for a different reviewer.");
      try { await onChanged(); } catch (cause) { setError(`Request saved. The schedule list could not refresh: ${message(cause)}`); }
    } catch (cause) { setError(message(cause)); await loadBasis(); }
    finally { setBusy(false); }
  }
  return <Modal title={receipt ? "Schedule request submitted" : action === "cancel" ? "Request shift cancellation" : "Request a schedule change"} onClose={close}>
    <div className="schedule-request-dialog"><p className="panel-note">{zone} · {effect}</p>
      {error && <p role="alert" className="schedule-request-error">{error}</p>}
      {receipt ? <><Badge tone="warm">Pending review</Badge><p>Your schedule stays unchanged until a different authorized reviewer approves this request.</p><p className="schedule-request-reference">Request {receipt.id} · version {receipt.version}</p>
        <Comparison source={source} proposal={review!.proposal} action={action} zone={zone}/><div className="dialog-actions"><button className="button secondary" onClick={close}>Close</button><button className="button primary" onClick={() => onCreated(receipt.id)}>Open submitted request<ArrowRight size={16}/></button></div></> : <>
        {loading && <p role="status">Checking your current shift and job assignments…</p>}
        {loadError && <p role="alert" className="schedule-request-error">{loadError}</p>}
        {(loadError || error || stale) && <button className="button secondary small" disabled={loading || busy} onClick={() => void loadBasis()}><RefreshCw size={15}/>Refresh current basis</button>}
        {stale && <div className="schedule-request-stale" role="status"><p>This shift changed after you opened it. Your proposed values and reason have been kept.</p><Snapshot title="Current shift" value={current!} zone={zone}/>
          {current!.status === "scheduled" ? <button className="button secondary" disabled={busy || loading} onClick={() => { setSource(current!); setReview(null); setError(""); }}>Use version {current!.version} as the new basis</button> : <p>This shift is cancelled; a new request cannot be submitted for it.</p>}</div>}
        {review ? <><Comparison source={source} proposal={review.proposal} action={action} zone={zone}/><div className="schedule-request-note"><strong>Reason for request</strong><p>{review.input.reason}</p></div>
          <p>Submitting records this proposal without changing your shift. The submitted source and proposal cannot be edited.</p><div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => { setReview(null); setError(""); }}>Back to proposal</button><button className="button primary" disabled={busy || stale || loading || Boolean(loadError)} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit schedule request"}</button></div>
        </> : <form onSubmit={prepare}><Snapshot title="Source shift" value={source} zone={zone}/>
          {action === "update" && <><label>Your assigned job<select aria-label="Proposed assigned job" value={draft.jobId} required onChange={event => update({ jobId: event.target.value })}><option value="">Choose an assigned job</option>{!jobs.some(job => job.id === draft.jobId) && draft.jobId && <option value={draft.jobId} disabled>Previous job — choose a current assignment</option>}{jobs.map(job => <option key={job.id} value={job.id}>{job.title} · {job.unit_name}</option>)}</select></label>
            {!loading && !jobs.length && <p role="status">No current job assignments are available. A manager must assign a job before you can propose an update.</p>}
            <div className="schedule-request-fields"><label>Proposed start ({zone})<input aria-label="Proposed start" type="datetime-local" step="0.001" required value={draft.startsLocal} onChange={event => update({ startsLocal: event.target.value, startOffset: "" })}/></label><label>Proposed end ({zone})<input aria-label="Proposed end" type="datetime-local" step="0.001" required value={draft.endsLocal} onChange={event => update({ endsLocal: event.target.value, endOffset: "" })}/></label></div>
            <Occurrence label="Proposed start occurrence" value={draft.startsLocal} offset={draft.startOffset} zone={zone} onChange={startOffset => update({ startOffset })}/><Occurrence label="Proposed end occurrence" value={draft.endsLocal} offset={draft.endOffset} zone={zone} onChange={endOffset => update({ endOffset })}/></>}
          <label>Reason for request<textarea aria-label="Reason for request" required minLength={3} maxLength={1000} rows={3} value={draft.reason} onChange={event => update({ reason: event.target.value })}/></label>
          <p className="panel-note">The administrative shift note is preserved. Your reason is recorded separately.</p><div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>Discard</button><button className="button primary" disabled={loading || Boolean(loadError) || stale}>Review proposal</button></div>
        </form>}
      </>}
    </div>
  </Modal>;
}

export default function ScheduleRequests({ me, zone, target, onSchedule, onChanged, notify, onDirty }: Common & {
  me: any; target: { scheduleId?: string; requestId?: string } | null; onSchedule: (date?: string) => void;
}) {
  const canReview = me.actor.mode === "password" && ["developer", "owner", "admin", "manager"].includes(me.actor.role);
  const [view, setView] = useState("own"), [status, setStatus] = useState("pending"), [scheduleId, setScheduleId] = useState(target?.scheduleId ?? "");
  const [rows, setRows] = useState<ScheduleRequestSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(target?.requestId ?? ""), [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [view, status, scheduleId, revision]);
  async function load(next?: string) {
    const request = ++generation.current; setLoading(true); setError("");
    if (!next) { setRows([]); setCursor(null); }
    const query = new URLSearchParams({ view, status, ...(scheduleId ? { scheduleId } : {}), ...(next ? { cursor: next } : {}) });
    try {
      const result = await api<ScheduleRequestList>(`/schedule-requests?${query}`);
      if (request !== generation.current) return;
      setRows(old => next ? [...old, ...result.rows.filter(row => !old.some(item => item.id === row.id))] : result.rows); setCursor(result.nextCursor);
    } catch (cause) { if (request === generation.current) setError(message(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }
  async function changed() { setRevision(value => value + 1); await onChanged(); }
  return <><Panel title="Scheduled shift requests" detail="Linked proposals change the selected planned shift when a different authorized reviewer approves them." className="schedule-requests"
    action={<button className="button secondary small" onClick={() => onSchedule()}>Request from my schedule<ArrowRight size={16}/></button>}>
    <div className="schedule-request-toolbar"><label>Request view<select aria-label="Schedule request view" value={view} onChange={event => setView(event.target.value)}><option value="own">My requests</option>{canReview && <option value="team">Team requests</option>}</select></label>
      <label>Status<select aria-label="Schedule request status" value={status} onChange={event => setStatus(event.target.value)}><option value="pending">Pending</option><option value="all">All statuses</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="withdrawn">Withdrawn</option></select></label>
      <button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={15}/>Refresh requests</button>
      {scheduleId && <button className="button secondary small" onClick={() => setScheduleId("")}>Clear selected shift filter</button>}
    </div><p className="schedule-request-guidance">{effect}{scheduleId ? " Showing requests for the selected shift." : ""}</p>
    {error && <p role="alert" className="schedule-request-error">{error}</p>}{loading && <p className="schedule-request-guidance" role="status">Loading requests…</p>}
    {!loading && !error && !rows.length && <Empty title="No linked requests in this view" detail="Choose another status, or open one of your scheduled shifts to propose a change."/>}
    <div className="schedule-request-list">{rows.map(row => <article key={row.id} className="schedule-request-card"><div><strong>{row.requester.nameSnapshot}</strong><Badge tone={tone(row.status)}>{row.status}</Badge></div>
      <h3>{row.action === "cancel" ? "Shift cancellation" : "Shift update"}</h3><p>{when(row.source.startsAt, zone)}<br/>{row.source.jobTitle} · {row.source.unitName}</p><p className="muted">Source version {row.source.version} · submitted {when(row.submittedAt, zone)}</p>
      {row.appliedSchedule && <p>Applied as schedule version {row.appliedSchedule.version}</p>}<button className="button secondary small" aria-label={`Open ${row.action === "cancel" ? "cancellation" : "update"} request for ${row.requester.nameSnapshot}, ${when(row.source.startsAt, zone)}`} onClick={() => setSelected(row.id)}>Open request<ArrowRight size={15}/></button></article>)}</div>
    {cursor && <div className="schedule-request-more"><button className="button secondary" disabled={loading} onClick={() => void load(cursor)}>Load older requests</button></div>}
  </Panel>{selected && <RequestDetail key={selected} id={selected} me={me} zone={zone} onClose={() => setSelected("")} onChanged={changed} notify={notify} onDirty={onDirty} onSchedule={onSchedule}/>}</>;
}

function RequestDetail({ id, me, zone, onClose, onChanged, notify, onDirty, onSchedule }: Common & { id: string; me: any; onClose: () => void; onSchedule: (date?: string) => void }) {
  const [detail, setDetail] = useState<ScheduleRequestDetail | null>(null), [history, setHistory] = useState<ScheduleRequestHistoryRow[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [historyError, setHistoryError] = useState("");
  const [action, setAction] = useState(""), [note, setNote] = useState(""), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<ScheduleRequestDecided | null>(null);
  const [showScheduleHistory, setShowScheduleHistory] = useState(false);
  const generation = useRef(0), command = useRef<{ fingerprint: string; id: string } | null>(null);
  const dirty = !result && Boolean(note || reviewed);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, []);
  async function reload() {
    const request = ++generation.current; setLoading(true); setLoadError(""); setHistoryError(""); setReviewed(false);
    const responses = await Promise.allSettled([api<ScheduleRequestDetail>(`/schedule-requests/${id}`), api<{ rows: ScheduleRequestHistoryRow[] }>(`/schedule-requests/${id}/history`)]);
    if (request !== generation.current) return;
    if (responses[0].status === "fulfilled") setDetail(responses[0].value);
    else { setDetail(null); setLoadError(message(responses[0].reason)); }
    if (responses[1].status === "fulfilled") setHistory(responses[1].value.rows);
    else { setHistory([]); setHistoryError(message(responses[1].reason)); }
    setLoading(false);
  }
  function close() { if (!busy && (!dirty || window.confirm("Discard your unsaved decision note?"))) onClose(); }
  const differentReviewer = detail && detail.requester.id !== me.actor.id;
  const allowed = detail ? { approved: detail.allowedActions.approve && differentReviewer, declined: detail.allowedActions.decline && differentReviewer, withdrawn: detail.allowedActions.withdraw } : {};
  const actionable = Boolean(detail && !result && !loading && allowed[action as keyof typeof allowed]);
  async function decide(event: FormEvent) {
    event.preventDefault(); if (!detail || busy || !actionable || !reviewed) return;
    const explanation = note.trim();
    if (explanation.length < 3) { setError("Enter a note of at least 3 characters."); return; }
    const base = { expectedRequestVersion: detail.version, proposalHash: detail.proposalHash };
    const payload = action === "withdrawn" ? { ...base, reason: explanation } : { ...base, decision: action, note: explanation, reviewed: true };
    const fingerprint = JSON.stringify(payload);
    if (command.current?.fingerprint !== fingerprint) command.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const outcome = await api<ScheduleRequestDecided>(`/schedule-requests/${id}/${action === "withdrawn" ? "withdraw" : "review"}`, { ...payload, commandId: command.current.id });
      setResult(outcome); onDirty(false); notify(outcome.status === "approved" ? `Request approved. Schedule version ${outcome.appliedSchedule!.version} is recorded.` : `Request ${outcome.status}. The schedule was not changed by this decision.`);
      await reload();
      try { await onChanged(); } catch (cause) { setError(`Decision saved. The schedule list could not refresh: ${message(cause)}`); }
    } catch (cause) { setError(`${message(cause)} Your decision note has been kept. Review the refreshed basis before continuing.`); await reload(); }
    finally { setBusy(false); }
  }
  return <Modal title="Scheduled shift request" onClose={close}><div className="schedule-request-dialog">
    <p className="panel-note">{zone} · {effect}</p>{error && <p role="alert" className="schedule-request-error">{error}</p>}{loadError && <p role="alert" className="schedule-request-error">{loadError}</p>}
    <button className="button secondary small" disabled={loading || busy} onClick={() => void reload()}><RefreshCw size={15}/>Refresh request and history</button>
    {loading && <p role="status">Loading current access, shift and request history…</p>}
    {result && <p className="schedule-request-saved" role="status">Decision saved: {result.status}.{result.appliedSchedule ? ` Schedule version ${result.appliedSchedule.version} is linked to this request.` : " This decision did not change the schedule."}</p>}
    {detail && <><header className="schedule-request-detail-heading"><h3>{detail.requester.nameSnapshot}</h3><Badge tone={tone(detail.status)}>{detail.status}</Badge></header><p className="schedule-request-reference">Request {detail.id} · version {detail.version} · submitted {when(detail.submittedAt, zone)}</p>
      <Comparison source={detail.source} proposal={detail.proposal} action={detail.action} zone={zone}/><div className="schedule-request-note"><strong>Submitted reason</strong><p>{detail.reason}</p></div>
      <details className="schedule-request-evidence"><summary>Immutable submission reference</summary><p className="schedule-request-reference">Proposal fingerprint: {detail.proposalHash}</p><p>Shift {detail.source.id} · source version {detail.source.version}. Submitted values and reason cannot be edited. Withdraw a pending request and submit a new one if the proposal must change.</p></details>
      <details className="schedule-request-evidence" open={detail.blockers.length > 0}><summary>Current shift — version {detail.current.version}</summary><Snapshot title="Current schedule record" value={detail.current} zone={zone}/><p>Current labels and values are shown separately from the submitted evidence above.</p></details>
      {detail.blockers.length > 0 && <div className="schedule-request-stale" role="status"><strong>Approval is currently blocked</strong><ul>{detail.blockers.map(blocker => <li key={blocker.code}>{blocker.message}</li>)}</ul><p>The submitted proposal stays unchanged. An authorized reviewer may decline it, or the requester may withdraw and submit a new proposal from the current shift.</p></div>}
      {detail.decision && <div className="schedule-request-note"><strong>{detail.status === "withdrawn" ? "Withdrawal" : "Decision"} by {detail.decision.actor.nameSnapshot}</strong><p>{detail.decision.note}</p><small>{when(detail.decision.at, zone)}</small></div>}
      {detail.appliedSchedule && <p className="schedule-request-saved">Approved change recorded as schedule version {detail.appliedSchedule.version} ({detail.appliedSchedule.status}). Later schedule edits remain separate.</p>}
      <div className="schedule-request-links"><button className="button secondary small" disabled={busy} onClick={() => setShowScheduleHistory(true)}><History size={15}/>Scheduled shift history</button><button className="button secondary small" disabled={busy} onClick={() => onSchedule(detail.current.startsAt)}>Open schedule week<ArrowRight size={15}/></button></div>
      <details className="schedule-request-evidence" open><summary>Request history</summary>{historyError && <p role="alert" className="schedule-request-error">{historyError}</p>}{history.map(row => <article className="schedule-request-event" key={row.id}><strong>Version {row.requestVersion} · {row.action}</strong><p>{row.actor.nameSnapshot} · {row.actor.roleSnapshot} · {when(row.at, zone)}</p><p>{row.reason}</p>{row.appliedSchedule && <small>Linked schedule version {row.appliedSchedule.version} · {row.appliedSchedule.status}</small>}</article>)}</details>
      {detail.status === "pending" && !result && <>{!differentReviewer && <p className="panel-note">You cannot approve or decline your own request.</p>}
        {(allowed.approved || allowed.declined || allowed.withdrawn) ? <form className="schedule-request-decision" onSubmit={decide}><h3>Record an action</h3>
          <label>Action<select aria-label="Request action" required disabled={busy || loading} value={action} onChange={event => { setAction(event.target.value); setReviewed(false); setError(""); }}><option value="">Choose an action</option>{action && !allowed[action as keyof typeof allowed] && <option value={action} disabled>Previous action is no longer available</option>}{allowed.approved && <option value="approved">Approve and apply the proposed shift</option>}{allowed.declined && <option value="declined">Decline — leave the schedule unchanged</option>}{allowed.withdrawn && <option value="withdrawn">Withdraw my request</option>}</select></label>
          <label>Decision or withdrawal note<textarea aria-label="Decision or withdrawal note" required minLength={3} maxLength={1000} rows={3} disabled={busy} value={note} onChange={event => { setNote(event.target.value); setReviewed(false); }}/></label>
          <label className="schedule-request-confirm"><input type="checkbox" checked={reviewed} disabled={busy || loading || !actionable} onChange={event => setReviewed(event.target.checked)}/><span>I reviewed the submitted source, proposal and current shift. {action === "approved" ? "I understand approval applies this exact proposal." : "This action leaves the schedule unchanged."}</span></label>
          <div className="dialog-actions"><button className="button primary" disabled={!actionable || !reviewed || busy}>{busy ? "Saving…" : action === "withdrawn" ? "Withdraw request" : action === "approved" ? "Approve and apply shift" : "Record decision"}</button></div>
        </form> : <p className="panel-note">Your current access does not allow an action on this request.</p>}</>}
    </>}
    {note && !result && (!detail || detail.status !== "pending") && <div className="schedule-request-note"><strong>Your unsaved decision note</strong><p>{note}</p><p>The current request cannot accept this draft action.</p></div>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={close}>Close request</button></div>
    {showScheduleHistory && detail && <LinkedScheduleHistory id={detail.source.id} appliedVersion={detail.appliedSchedule?.version} zone={zone} onClose={() => setShowScheduleHistory(false)}/>}
  </div></Modal>;
}

function LinkedScheduleHistory({ id, appliedVersion, zone, onClose }: { id: string; appliedVersion?: number; zone: string; onClose: () => void }) {
  const [rows, setRows] = useState<ScheduleHistoryRow[]>([]), [before, setBefore] = useState<number | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, []);
  async function load(older?: number) {
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const result = await api<{ rows: ScheduleHistoryRow[]; nextBeforeVersion: number | null }>(`/schedules/${id}/history${older ? `?beforeVersion=${older}` : ""}`);
      if (request !== generation.current) return;
      setRows(previous => older ? [...previous, ...result.rows] : result.rows); setBefore(result.nextBeforeVersion);
    } catch (cause) { if (request === generation.current) setError(message(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }
  return <Modal title="Linked scheduled shift history" onClose={onClose}><div className="schedule-request-dialog"><p className="panel-note">Schedule history is separate from clock history.{appliedVersion ? ` This request applied version ${appliedVersion}.` : " This request has not applied a schedule change."}</p>
    {loading && <p role="status">Loading schedule history…</p>}{error && <p role="alert" className="schedule-request-error">{error}</p>}
    {rows.map(row => <article key={row.version} className="schedule-request-event"><strong>Version {row.version} · {row.action}{row.version === appliedVersion ? " · Applied by this request" : ""}</strong><p>{row.actor_name} · {when(row.created_at, zone)}</p><p>{row.reason}</p><Snapshot title="Recorded shift" value={row.after_snapshot} zone={zone}/></article>)}
    {before !== null && <button className="button secondary" disabled={loading} onClick={() => void load(before)}>Load older schedule versions</button>}{error && <button className="button secondary" disabled={loading} onClick={() => void load()}>Retry schedule history</button>}<div className="dialog-actions"><button className="button secondary" onClick={onClose}>Close schedule history</button></div>
  </div></Modal>;
}
