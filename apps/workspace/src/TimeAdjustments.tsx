import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import { ArrowLeft, Download, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import {
  proposeTimeAdjustmentInput, timeAdjustmentReceiptSchema,
  type OpenTimeShifts, type TimeAdjustmentDetail, type TimeAdjustmentHistory,
  type TimeAdjustmentList, type TimeAdjustmentOptions, type TimeAdjustmentSource, type TimeSnapshot,
} from "../shared/time-adjustments";
import { AdjustmentTimeField, TimeEvidence, localTime, resolveEnteredTime, snapshotTotals, timeLabel } from "./TimeAdjustmentEvidence";
import "./time-adjustments.css";

export type AdjustmentTarget = { kind: "missing_shift"; employeeId?: string } | { kind: "close_open_shift"; shiftId: string } | { kind: "request"; requestId: string } | { kind: "shift_requests"; shiftId: string };
type View = "records" | "open" | "requests";
type Row = { key: string; jobId: string; kind: "work" | "break"; start: string; end: string; startOffset: number | null; endOffset: number | null };
type Attempt = { path: string; body: Record<string, unknown>; message: string };
type ProposalReview = { body: Record<string, unknown>; snapshot: TimeSnapshot; direct: boolean };
const blankRow = (): Row => ({ key: crypto.randomUUID(), jobId: "", kind: "work", start: "", end: "", startOffset: null, endOffset: null });
const kindLabel = (kind: string) => kind === "missing_shift" ? "Missing time card" : "Clock-out correction";
const statusLabel = (status: string) => status === "applied" ? "Saved by administrator" : status;
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
export default function TimeAdjustments({ me, view, onView, target, onTargetConsumed, onChanged, onDirty, onPendingChange, notify }: {
  me: any; view: View; onView(view: View): void; target: AdjustmentTarget | null; onTargetConsumed(): void;
  onChanged(): Promise<void>; onDirty(dirty: boolean): void; onPendingChange?(pending: boolean): void; notify(message: string, error?: boolean): void;
}) {
  const zone = me.organization.timezone, today = DateTime.now().setZone(zone), currentId = me.actor.id;
  const [start, setStart] = useState(today.startOf("week").toISODate()!), [end, setEnd] = useState(today.toISODate()!);
  const [mine, setMine] = useState(!me.permissions.report), [kind, setKind] = useState(""), [status, setStatus] = useState(""), [shiftFilter, setShiftFilter] = useState("");
  const [list, setList] = useState<TimeAdjustmentList | null>(null), [openList, setOpenList] = useState<OpenTimeShifts | null>(null);
  const [detail, setDetail] = useState<TimeAdjustmentDetail | null>(null), [history, setHistory] = useState<TimeAdjustmentHistory | null>(null);
  const [source, setSource] = useState<TimeAdjustmentSource | null>(null), [options, setOptions] = useState<TimeAdjustmentOptions | null>(null);
  const [closureShiftId, setClosureShiftId] = useState("");
  const [compose, setCompose] = useState<"missing" | "closure" | null>(null), [employeeId, setEmployeeId] = useState(currentId), [staff, setStaff] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([blankRow()]), [proposedEnd, setProposedEnd] = useState(""), [endOffset, setEndOffset] = useState<number | null>(null), [reason, setReason] = useState("");
  const [proposalReview, setProposalReview] = useState<ProposalReview | null>(null), [decision, setDecision] = useState<"approved" | "declined" | "cancelled" | null>(null), [note, setNote] = useState("");
  const [uncertain, setUncertain] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [accessLost, setAccessLost] = useState(false), [reload, setReload] = useState(0);
  const attemptRef = useRef<Attempt | null>(null), busyRef = useRef(false), epoch = useRef(0), listEpoch = useRef(0), optionsEpoch = useRef(0), detailEpoch = useRef(0), sourceEpoch = useRef(0), opener = useRef<HTMLElement | null>(null);
  const dirty = Boolean(compose || decision || uncertain);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { onPendingChange?.((busy && Boolean(attemptRef.current)) || uncertain); return () => onPendingChange?.(false); }, [busy, uncertain, onPendingChange]);
  useEffect(() => () => { epoch.current++; listEpoch.current++; optionsEpoch.current++; }, []);
  const clearPrivate = useCallback(() => {
    epoch.current++; listEpoch.current++; optionsEpoch.current++;
    setList(null); setOpenList(null); setDetail(null); setHistory(null); setSource(null); setOptions(null); setStaff([]);
    setCompose(null); setProposalReview(null); setDecision(null); setRows([blankRow()]); setReason(""); setNote(""); setProposedEnd(""); setClosureShiftId(""); setShiftFilter(""); setEmployeeId(currentId); setLoading(false);
    attemptRef.current = null; setUncertain(false); setAccessLost(true); setError("These private time records are no longer available with your current access. Sign in again or refresh after access is restored.");
  }, [currentId]);
  function fail(error: unknown) { if (denied(error)) clearPrivate(); else setError((error as Error).message); }
  const query = useCallback((cursor?: string) => new URLSearchParams({ ...(shiftFilter ? { sourceShiftId: shiftFilter } : { start, end }), ...(mine ? { employeeId: currentId } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }), [start, end, mine, currentId, kind, status, shiftFilter]);
  useEffect(() => {
    if (view === "records" || accessLost) return;
    const marker = ++listEpoch.current, lifetime = epoch.current;
    setList(null); setOpenList(null); setLoading(true); setError("");
    const path = view === "open" ? "/time-adjustments/open-shifts?" + new URLSearchParams(mine ? { employeeId: currentId } : {}) : "/time-adjustments?" + query();
    void api(path).then(result => { if (marker !== listEpoch.current || lifetime !== epoch.current) return; if (view === "open") setOpenList(result); else setList(result); })
      .catch(error => { if (marker === listEpoch.current && lifetime === epoch.current) fail(error); })
      .finally(() => { if (marker === listEpoch.current && lifetime === epoch.current) setLoading(false); });
  }, [view, mine, currentId, query, reload, accessLost]);
  async function more() {
    const cursor = view === "open" ? openList?.nextCursor : list?.nextCursor;
    if (!cursor || loading) return;
    const marker = listEpoch.current, lifetime = epoch.current; setLoading(true); setError("");
    try {
      const result = await api(view === "open" ? "/time-adjustments/open-shifts?" + new URLSearchParams({ ...(mine ? { employeeId: currentId } : {}), cursor }) : "/time-adjustments?" + query(cursor));
      if (marker !== listEpoch.current || lifetime !== epoch.current) return;
      if (view === "open") setOpenList(previous => previous ? { ...result, items: [...previous.items, ...result.items] } : null);
      else setList(previous => previous ? { ...result, items: [...previous.items, ...result.items] } : null);
    } catch (error) {
      if (marker !== listEpoch.current || lifetime !== epoch.current) return;
      if (error instanceof ApiError && error.status === 409) { setList(null); setOpenList(null); setError("The list changed while loading. Reload it to see a complete current page sequence."); }
      else fail(error);
    } finally { if (marker === listEpoch.current && lifetime === epoch.current) setLoading(false); }
  }
  function rememberOpener() { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }
  function restoreFocus() { requestAnimationFrame(() => {
    const target = opener.current, active = document.activeElement;
    // The shared dialog may choose the workspace as its fallback after an async
    // opener was disabled. Prefer our explicit opener, without taking focus from
    // another dialog or a control the user deliberately selected.
    if (target?.isConnected && !target.matches(":disabled") && !document.querySelector("dialog[open]") &&
        (active === document.body || active === document.getElementById("workspace-main"))) target.focus({ preventScroll: true });
  }); }
  function mayLeave() { return !busyRef.current && !uncertain && (!dirty || window.confirm("Discard this unsaved time adjustment?")); }
  function closeCompose() {
    if (!mayLeave()) return;
    sourceEpoch.current++; optionsEpoch.current++;
    setCompose(null); setSource(null); setOptions(null); setStaff([]); setReason(""); setProposedEnd(""); setRows([blankRow()]); setProposalReview(null); attemptRef.current = null; setUncertain(false); setLoading(false); setError(""); restoreFocus();
  }
  function closeDetail() {
    if (!mayLeave()) return;
    detailEpoch.current++;
    setDetail(null); setHistory(null); setDecision(null); setNote(""); attemptRef.current = null; setUncertain(false); setLoading(false); setError(""); restoreFocus();
  }
  async function loadOptions(id: string) {
    const marker = ++optionsEpoch.current, lifetime = epoch.current; setOptions(null); setLoading(true); setError("");
    try { const result = await api<TimeAdjustmentOptions>("/time-adjustments/options?" + new URLSearchParams({ employeeId: id })); if (marker === optionsEpoch.current && lifetime === epoch.current) setOptions(result); }
    catch (error) { if (marker === optionsEpoch.current && lifetime === epoch.current) fail(error); }
    finally { if (marker === optionsEpoch.current && lifetime === epoch.current) setLoading(false); }
  }
  async function missing(selectedEmployeeId?: string) {
    if (!mayLeave()) return; const initialEmployee = selectedEmployeeId ?? (['admin', 'owner', 'developer'].includes(me.actor.role) ? "" : currentId);
    rememberOpener(); setAccessLost(false); setCompose("missing"); setDetail(null); setHistory(null); setRows([blankRow()]); setReason(""); setEmployeeId(initialEmployee); setSource(null); setOptions(null); setProposalReview(null); setError("");
    const lifetime = epoch.current;
    await Promise.all([initialEmployee ? loadOptions(initialEmployee) : Promise.resolve(), me.permissions.manage ? api<{ rows: any[] }>("/staff").then(result => { if (lifetime === epoch.current) setStaff(result.rows); }).catch(error => { if (lifetime === epoch.current) fail(error); }) : Promise.resolve()]);
  }
  async function closure(shiftId: string, preserve = false) {
    if (!preserve) { if (!mayLeave()) return; rememberOpener(); setReason(""); setProposedEnd(""); setEndOffset(null); }
    const lifetime = epoch.current, marker = ++sourceEpoch.current; setLoading(true); setSource(null); setClosureShiftId(shiftId); setProposalReview(null); setError(""); setAccessLost(false);
    try {
      const result = await api<TimeAdjustmentSource>("/time-adjustments/closure-source?" + new URLSearchParams({ shiftId }));
      if (lifetime === epoch.current && marker === sourceEpoch.current) { setSource(result); setCompose("closure"); setDetail(null); setHistory(null); if (!preserve) { setProposedEnd(localTime(result.observedAt, result.timezone)); setEndOffset(DateTime.fromISO(result.observedAt).setZone(result.timezone).offset); } }
    } catch (error) { if (lifetime === epoch.current && marker === sourceEpoch.current) fail(error); }
    finally { if (lifetime === epoch.current && marker === sourceEpoch.current) setLoading(false); }
  }
  async function openDetail(id: string, preserve = false) {
    if (!preserve) { if (!mayLeave()) return; rememberOpener(); setDecision(null); setNote(""); }
    const lifetime = epoch.current, marker = ++detailEpoch.current; setLoading(true); setError(""); setHistory(null);
    try { const result = await api<TimeAdjustmentDetail>("/time-adjustments/" + id); if (lifetime === epoch.current && marker === detailEpoch.current) { setDetail(result); setAccessLost(false); } }
    catch (error) { if (lifetime === epoch.current && marker === detailEpoch.current) fail(error); }
    finally { if (lifetime === epoch.current && marker === detailEpoch.current) setLoading(false); }
  }
  const targetKey = target ? JSON.stringify(target) : "";
  useEffect(() => {
    if (!target) return; onTargetConsumed();
    if (target.kind === "missing_shift") void missing(target.employeeId);
    else if (target.kind === "close_open_shift") void closure(target.shiftId);
    else if (target.kind === "request") void openDetail(target.requestId);
    else { setShiftFilter(target.shiftId); onView("requests"); }
  }, [targetKey]);
  function prepare(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      let body: Record<string, unknown>, snapshot: TimeSnapshot;
      if (compose === "missing") {
        if (!options?.allowedActions.proposeMissing) throw Error("Missing-shift proposals are unavailable for this employee.");
        const segments = rows.map((row, index) => {
          const job = options.jobs.find(job => job.id === row.jobId); if (!job) throw Error(`Choose an available job for entry ${index + 1}.`);
          return { id: null, jobId: job.id, jobTitle: job.title, unitId: job.unitId, unitName: job.unitName, kind: row.kind,
            startedAt: resolveEnteredTime(row.start, options.timezone, row.startOffset), endedAt: resolveEnteredTime(row.end, options.timezone, row.endOffset) };
        });
        for (let index = 1; index < segments.length; index++) if (segments[index - 1].endedAt !== segments[index].startedAt) throw Error(`Entry ${index + 1} must start exactly when the preceding entry ends.`);
        const totals = snapshotTotals(segments)!; if (totals.totalMicroseconds === "0") throw Error("A missing shift must have positive overall duration.");
        body = { kind: "missing_shift", employeeId: options.employee.id, segments: segments.map(({ jobId, kind, startedAt, endedAt }) => ({ jobId, kind, startedAt, endedAt })), reason: reason.trim() };
        snapshot = { schemaVersion: 1, orgId: me.organization.id, employee: { id: options.employee.id, name: options.employee.name }, shift: { id: null, revision: null, startedAt: segments[0].startedAt, endedAt: segments.at(-1)!.endedAt }, segments, totals };
      } else {
        if (!source?.allowedActions.propose) throw Error("A reviewed closure is unavailable for this source.");
        const endedAt = resolveEnteredTime(proposedEnd, source.timezone, endOffset), segments = source.source.segments.map(segment => ({ ...segment, endedAt: segment.endedAt ?? endedAt }));
        snapshot = { ...source.source, shift: { ...source.source.shift, endedAt }, segments, totals: snapshotTotals(segments) };
        body = { kind: "close_open_shift", shiftId: source.source.shift.id, sourceHash: source.sourceHash, endedAt, reason: reason.trim() };
      }
      proposeTimeAdjustmentInput.parse({ ...body, commandId: crypto.randomUUID() });
      setProposalReview({ body, snapshot, direct: Boolean(compose === "missing" ? options?.allowedActions.applyDirect : source?.allowedActions.applyDirect) });
      requestAnimationFrame(() => document.getElementById("time-proposal-review-heading")?.focus());
    } catch (error) { setError((error as Error).message); }
  }
  async function send(attempt?: Attempt) {
    if (busyRef.current) return;
    const command = attemptRef.current ?? attempt;
    if (!command) return;
    attemptRef.current = command; busyRef.current = true; setBusy(true); setError(""); const lifetime = epoch.current;
    try {
      const receipt = timeAdjustmentReceiptSchema.parse(await api(command.path, command.body));
      if (lifetime !== epoch.current) return;
      attemptRef.current = null; setUncertain(false); setCompose(null); setProposalReview(null); setSource(null); setOptions(null); setRows([blankRow()]); setReason(""); setDecision(null); setNote("");
      notify(command.message); setReload(value => value + 1);
      await openDetail(receipt.requestId, true);
      try { await onChanged(); } catch { if (lifetime === epoch.current) notify("The time adjustment was saved. Refresh the workspace to update current clock and report views.", true); }
    } catch (error) {
      if (lifetime !== epoch.current) return;
      if (denied(error)) clearPrivate();
      else if (!(error instanceof ApiError) || error.status >= 500) { setUncertain(true); setError("Completion could not be confirmed. Keep this review and retry the exact same request; it may already have been saved."); }
      else { attemptRef.current = null; setUncertain(false); setError((error as Error).message); if (error.status === 409) { setProposalReview(null); setDecision(null); } }
    } finally { busyRef.current = false; setBusy(false); }
  }
  function submitProposal() { if (!proposalReview) return; void send({ path: proposalReview.direct ? "/time-adjustments/direct" : "/time-adjustments", body: { ...proposalReview.body, commandId: crypto.randomUUID() }, message: proposalReview.direct ? "Time card saved. Original times, your reason and your name are retained in the audit history." : "Proposal submitted. Recorded time changes only after independent approval." }); }
  function submitDecision(event: FormEvent) {
    event.preventDefault(); if (!detail || !decision) return;
    const cancel = decision === "cancelled";
    void send({ path: `/time-adjustments/${detail.request.id}/${cancel ? "cancel" : "review"}`, body: { version: 1, requestHash: detail.requestHash, ...(cancel ? { reason: note.trim() } : { status: decision, note: note.trim() }), commandId: crypto.randomUUID() },
      message: decision === "approved" ? "Reviewed adjustment applied. Its original evidence remains in history." : cancel ? "Request cancelled. Recorded time is unchanged." : "Request declined. Recorded time is unchanged." });
  }
  async function loadHistory() {
    if (!detail || loading) return; const lifetime = epoch.current, marker = detailEpoch.current; setLoading(true); setError("");
    try { const result = await api<TimeAdjustmentHistory>(`/time-adjustments/${detail.request.id}/history`); if (lifetime === epoch.current && marker === detailEpoch.current) setHistory(result); }
    catch (error) { if (lifetime === epoch.current && marker === detailEpoch.current) fail(error); } finally { if (lifetime === epoch.current && marker === detailEpoch.current) setLoading(false); }
  }
  async function exportEvidence(format: "json" | "csv", version?: number) {
    if (!detail || busyRef.current) return; busyRef.current = true; setBusy(true); setError("");
    try { await download(`/time-adjustments/${detail.request.id}/export?${new URLSearchParams({ format, ...(version ? { version: String(version) } : {}) })}`, `time-adjustment-${detail.request.id}${version ? `-v${version}` : ""}.${format}`); }
    catch (error) { fail(error); } finally { busyRef.current = false; setBusy(false); }
  }
  const frozen = busy || uncertain;
  const direct = Boolean(compose === "missing" ? options?.allowedActions.applyDirect : source?.allowedActions.applyDirect);
  const retry = uncertain && <div className="adjustment-retry" role="status"><p>The submitted command is preserved. Its fields are locked while completion is uncertain.</p><button type="button" className="button primary" disabled={busy} onClick={() => void send()}>Retry the same request</button></div>;
  return <div className="time-adjustments">
    <div className="adjustment-navigation" aria-label="Time record views">
      {([['records', 'Recorded shifts'], ['open', 'Open shifts'], ['requests', 'Review requests']] as const).map(([value, label]) => <button key={value} type="button" className={`button ${view === value ? "primary" : "secondary"}`} aria-pressed={view === value} disabled={busy} onClick={() => { if (mayLeave()) onView(value); }}>{label}</button>)}
      <button type="button" className="button secondary" disabled={busy || loading || uncertain} onClick={() => void missing()}><Plus size={16} />Add missing time card</button>
    </div>
    {error && !compose && !detail && <p className="error" role="alert">{error}</p>}
    {view !== "records" && <>
      <div className="adjustment-filters">
        {view === "requests" && <>{!shiftFilter && <><label>Work from<input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label>Work through<input type="date" value={end} onChange={event => setEnd(event.target.value)} /></label></>}
          <label>Request type<select value={kind} onChange={event => setKind(event.target.value)}><option value="">All types</option><option value="missing_shift">Missing shift</option><option value="close_open_shift">Reviewed clock-out</option></select></label>
          <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{['pending', 'approved', 'declined', 'cancelled', 'applied'].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label></>}
        {me.permissions.report && <label>People<select value={mine ? "mine" : "team"} onChange={event => setMine(event.target.value === "mine")}><option value="team">My permitted team</option><option value="mine">My records</option></select></label>}
        <button type="button" className="button secondary" disabled={loading || busy} onClick={() => { setAccessLost(false); setReload(value => value + 1); }}><RefreshCw size={16} />Reload {view === "open" ? "open shifts" : "requests"}</button>
      </div>
      {shiftFilter && view === "requests" && <p className="panel-note">Showing requests for the selected shift across all dates. <button type="button" className="text-link" onClick={() => setShiftFilter("")}>Show other shifts</button></p>}
      <Panel title={view === "open" ? "Currently open shifts" : "Adjustment history & requests"} detail={view === "open" ? `All start dates · ${zone}. Open a shift to correct a missed clock-out.` : `Work overlaps these ${shiftFilter ? "selected shift records" : "inclusive dates"} in ${zone}. Administrator saves and independent review requests remain labeled separately.`}>
        {view === "open" ? <div className="adjustment-cards">{openList?.items.map(row => <article key={row.shiftId}><div><strong>{row.employee.name}</strong><p>Started {timeLabel(row.startedAt, zone)}</p><Badge>Revision {row.revision}</Badge>{row.pendingRequests > 0 && <Badge tone="warm">{row.pendingRequests} pending requests</Badge>}</div><div className="adjustment-card-actions"><button type="button" className="button secondary" disabled={loading} onClick={() => void closure(row.shiftId)}>{row.employee.id !== currentId && ['admin', 'owner', 'developer'].includes(me.actor.role) ? "Correct clock-out" : "Request clock-out correction"}</button>{row.pendingRequests > 0 && <button type="button" className="text-link" onClick={() => { setShiftFilter(row.shiftId); onView("requests"); }}>View requests</button>}</div></article>)}</div>
          : <div className="adjustment-cards">{list?.items.map(row => <button type="button" className="adjustment-request-card" key={row.id} disabled={loading} onClick={() => void openDetail(row.id)}><div><strong>{row.employee.name}</strong><p>{kindLabel(row.kind)} · {row.status === "applied" ? "Saved by" : "Proposed by"} {row.proposedBy.name}</p><p>{timeLabel(row.startedAt, zone)} to {timeLabel(row.endedAt, zone)}</p><small>{row.status === "applied" ? "Saved" : "Submitted"} {timeLabel(row.createdAt, zone)}</small></div><Badge tone={['approved', 'applied'].includes(row.status) ? "green" : row.status === "pending" ? "warm" : "neutral"}>{statusLabel(row.status)}</Badge></button>)}</div>}
        {loading && <p className="panel-note" role="status">Loading time records…</p>}
        {!loading && !error && ((view === "open" && openList?.items.length === 0) || (view === "requests" && list?.items.length === 0)) && <Empty title={view === "open" ? "No current open shifts in this scope" : "No requests match these filters"} detail={view === "open" ? "Completed shifts remain in Recorded shifts." : "Change the work dates or filters to find other requests."} />}
        {(view === "open" ? openList?.nextCursor : list?.nextCursor) && <div className="dialog-actions"><button type="button" className="button secondary" disabled={loading} onClick={() => void more()}>Load more</button></div>}
      </Panel>
    </>}
    {compose && <Modal title={compose === "missing" ? "Add missing time card" : direct ? "Correct missed clock-out" : "Request clock-out correction"} onClose={closeCompose}>
      {error && <p className="error" role="alert">{error}</p>}{retry}
      {proposalReview ? <div className="community-form"><h3 id="time-proposal-review-heading" tabIndex={-1}>{proposalReview.direct ? "Review and save time card" : "Review this proposal"}</h3><p className="adjustment-save-mode">{proposalReview.direct ? "Saving updates recorded hours immediately. The original times, your reason and your name remain in the audit history." : "Recorded time remains unchanged until a different authorized manager approves."}</p>
        {source && <TimeEvidence snapshot={source.source} title="Original source — unchanged" zone={source.timezone} />}<TimeEvidence snapshot={proposalReview.snapshot} title="Proposed completed time" zone={source?.timezone ?? options?.timezone ?? zone} />
        <p><strong>Reason</strong><br />{String(proposalReview.body.reason)}</p>
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={frozen} onClick={() => setProposalReview(null)}><ArrowLeft size={16} />Back to editing</button><button type="button" className="button primary" disabled={frozen} onClick={submitProposal}>{busy ? "Saving…" : proposalReview.direct ? "Save time card now" : "Submit for independent review"}</button></div>
      </div> : <form className="community-form" onSubmit={prepare}>
        <p>Dates and times use <strong>{source?.timezone ?? options?.timezone ?? zone}</strong>. New time entries use millisecond precision.</p>
        {compose === "missing" ? <>
          {me.permissions.manage ? <label>Employee<select aria-label="Missing shift employee" required disabled={frozen || loading} value={employeeId} onChange={event => { setEmployeeId(event.target.value); setRows([blankRow()]); void loadOptions(event.target.value); }}>
            <option value="" disabled>Choose an employee</option>
            {!staff.some(person => person.id === currentId) && <option value={currentId}>My account</option>}{staff.map(person => <option key={person.id} value={person.id}>{person.name}{person.active ? "" : " (inactive account)"}</option>)}
          </select></label> : <p><strong>{options?.employee.name ?? "My account"}</strong></p>}
          {options && <p className="adjustment-save-mode">{direct ? "Administrator edit · Save takes effect immediately with audit history." : "Review request · A different authorized manager must approve this time card."}</p>}
          {loading && <p role="status">Loading available jobs…</p>}
          {options && !options.employee.active && <p className="panel-note">This employee account is inactive. The server checks the assignments required for this proposal.</p>}
          {options && (!options.allowedActions.proposeMissing || !options.jobs.length) && <p className="panel-note">No available assigned jobs for a missing-shift proposal.</p>}
          {rows.map((row, index) => <fieldset key={row.key} disabled={frozen}><legend>Entry {index + 1}</legend><div className="adjustment-form-grid">
            <label>Job<select aria-label={`Missing entry ${index + 1} job`} value={row.jobId} required onChange={event => setRows(values => values.map(item => item.key === row.key ? { ...item, jobId: event.target.value } : item))}><option value="" disabled>Choose an assigned job</option>{options?.jobs.map(job => <option key={job.id} value={job.id}>{job.title} · {job.unitName}</option>)}</select></label>
            <label>Type<select aria-label={`Missing entry ${index + 1} type`} value={row.kind} onChange={event => setRows(values => values.map(item => item.key === row.key ? { ...item, kind: event.target.value as Row['kind'] } : item))}><option value="work">Work</option><option value="break">Break</option></select></label>
            <AdjustmentTimeField label={`Missing entry ${index + 1} start`} value={row.start} offset={row.startOffset} zone={options?.timezone ?? zone} onChange={(value, offset) => setRows(values => values.map(item => item.key === row.key ? { ...item, start: value, startOffset: offset } : item))} />
            <AdjustmentTimeField label={`Missing entry ${index + 1} end`} value={row.end} offset={row.endOffset} zone={options?.timezone ?? zone} onChange={(value, offset) => setRows(values => values.map(item => item.key === row.key ? { ...item, end: value, endOffset: offset } : item))} />
          </div>{rows.length > 1 && <button type="button" className="text-link" onClick={() => setRows(values => values.filter(item => item.key !== row.key))}><Trash2 size={15} />Remove entry {index + 1}</button>}</fieldset>)}
          <button type="button" className="button secondary" disabled={frozen || rows.length >= 200} onClick={() => setRows(values => [...values, { ...blankRow(), start: values.at(-1)!.end, startOffset: values.at(-1)!.endOffset }])}><Plus size={16} />Add work or break segment</button>
        </> : <>
          {source && <><div className="adjustment-save-mode"><strong>{source.source.employee.name}</strong><p>Clocked in {timeLabel(source.source.shift.startedAt, source.timezone)}</p><p>{source.source.segments.at(-1)?.jobTitle} · {source.source.segments.at(-1)?.unitName}</p><p>{direct ? "Saving ends this open shift at the clock-out below. All earlier entries and original open times remain in history." : "The clock continues running until a different authorized manager approves. The employee can still clock out normally."}</p></div></>}
          {closureShiftId && <button type="button" className="button secondary" disabled={frozen || loading} onClick={() => void closure(closureShiftId, true)}><RefreshCw size={16} />Refresh current shift</button>}
          <AdjustmentTimeField label="Correct clock-out date and time" value={proposedEnd} offset={endOffset} zone={source?.timezone ?? zone} disabled={frozen} onChange={(value, offset) => { setProposedEnd(value); setEndOffset(offset); }} />
          <p className="muted">Defaults to the current time when this editor opened. Set the actual date and time the employee stopped working.</p>
          {source && <details><summary>Original job and break entries</summary><TimeEvidence snapshot={source.source} title="Captured current source" zone={source.timezone} /></details>}
        </>}
        <label>Reason for adjustment<textarea aria-label="Reason for adjustment" required minLength={10} maxLength={2000} rows={3} disabled={frozen} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={frozen} onClick={closeCompose}>Cancel</button><button className="button primary" disabled={frozen || loading || (compose === "missing" ? !options?.allowedActions.proposeMissing || !options.jobs.length : !source?.allowedActions.propose)}>{direct ? "Review changes" : "Review proposal"}</button></div>
      </form>}
    </Modal>}
    {detail && !compose && <Modal title={`${kindLabel(detail.request.kind)} ${detail.request.status === "applied" ? "saved" : "request"}`} onClose={closeDetail}>
      <div className="community-form"><div className="adjustment-heading"><strong>{detail.request.employee.name}</strong><Badge tone={detail.request.status === "pending" ? "warm" : detail.request.status === "applied" ? "green" : "neutral"}>{statusLabel(detail.request.status)}</Badge></div>
        {error && <p className="error" role="alert">{error}</p>}{retry}
        <p>{detail.request.status === "applied" ? "Entered and saved by" : "Proposed by"} {detail.request.proposedBy.name} · {timeLabel(detail.request.createdAt, zone)}</p><p className="adjustment-reason">{detail.request.reason}</p>
        <section className="adjustment-readiness"><h3>Current readiness</h3><Badge>{detail.readiness.state}</Badge>{detail.readiness.issues.map(issue => <p key={issue.code}>{issue.message || `Review issue: ${issue.code}`}</p>)}<p className="muted">This check describes current sources. It does not change the saved proposal.</p><button type="button" className="button secondary" disabled={frozen || loading} onClick={() => void openDetail(detail.request.id, true)}>Refresh readiness</button></section>
        <div className="adjustment-comparison">{detail.request.source && <TimeEvidence snapshot={detail.request.source} title="Original source" zone={zone} />}<TimeEvidence snapshot={detail.request.proposed} title="Submitted proposal" zone={zone} /></div>
        {detail.result && <TimeEvidence snapshot={detail.result} title={detail.request.status === "applied" ? "Saved time card" : "Recorded approval result"} zone={zone} />}
        {detail.request.resolvedBy && <p><strong>{detail.request.status} by {detail.request.resolvedBy.name}</strong><br />{detail.request.resolvedAt && timeLabel(detail.request.resolvedAt, zone)}<br />{detail.request.resolutionNote}</p>}
        <details><summary>Source and result references</summary><dl><div><dt>Request</dt><dd>{detail.request.id} · Version {detail.request.version}</dd></div><div><dt>Request hash</dt><dd>{detail.requestHash}</dd></div>{detail.request.sourceHash && <div><dt>Source hash</dt><dd>{detail.request.sourceHash}</dd></div>}{detail.resultHash && <div><dt>Result hash</dt><dd>{detail.resultHash}</dd></div>}</dl></details>
        {decision ? <form className="community-form" onSubmit={submitDecision}><h3>{decision === "approved" ? "Confirm independent approval" : decision === "declined" ? "Record a decline" : "Cancel your request"}</h3><p>{decision === "approved" ? "Approval applies the submitted completed time as a new recorded shift or revision. Original entries remain available." : "Recorded time will remain unchanged."}</p><label>{decision === "cancelled" ? "Cancellation reason" : "Decision note"}<textarea aria-label={decision === "cancelled" ? "Cancellation reason" : "Decision note"} required minLength={10} maxLength={2000} value={note} disabled={frozen} onChange={event => setNote(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="button secondary" disabled={frozen} onClick={() => { setDecision(null); setNote(""); }}>Back to evidence</button><button className="button primary" disabled={frozen || (decision === "approved" ? !detail.allowedActions.approve || detail.readiness.state !== "ready" : decision === "declined" ? !detail.allowedActions.decline : !detail.allowedActions.cancel)}>{busy ? "Saving…" : decision === "approved" ? "Apply reviewed adjustment" : decision === "declined" ? "Record decline" : "Confirm cancellation"}</button></div></form>
          : <div className="dialog-actions">{detail.allowedActions.approve && <button type="button" className="button primary" disabled={frozen || loading || detail.readiness.state !== "ready"} onClick={() => setDecision("approved")}>Review approval</button>}{detail.allowedActions.decline && <button type="button" className="button secondary" disabled={frozen || loading} onClick={() => setDecision("declined")}>Decline request</button>}{detail.allowedActions.cancel && <button type="button" className="button secondary" disabled={frozen || loading} onClick={() => setDecision("cancelled")}>Cancel my request</button>}</div>}
        {detail.request.status === "pending" && !detail.allowedActions.approve && !detail.allowedActions.decline && <p className="muted">Approval or decline requires a different authorized manager from the employee and proposer.</p>}
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={frozen || loading} onClick={() => void loadHistory()}>Load immutable history</button>{(['json', 'csv'] as const).map(format => <button type="button" className="button secondary" disabled={frozen} key={format} onClick={() => void exportEvidence(format)}><Download size={15} />Saved {format.toUpperCase()}</button>)}</div>
        {history?.items.map(entry => <details key={entry.version}><summary>Version {entry.version} · {entry.action} · {entry.actor.name}</summary><p>{timeLabel(entry.createdAt, zone)}<br />{entry.reason}</p>{entry.snapshot.request.source && <TimeEvidence snapshot={entry.snapshot.request.source} title="Historical source" zone={zone} />}<TimeEvidence snapshot={entry.snapshot.request.proposed} title="Historical proposal" zone={zone} />{entry.snapshot.result && <TimeEvidence snapshot={entry.snapshot.result} title="Historical result" zone={zone} />}<p className="adjustment-hash">History hash: {entry.snapshotHash}</p><div className="dialog-actions">{(['json', 'csv'] as const).map(format => <button key={format} type="button" className="button secondary" disabled={frozen} onClick={() => void exportEvidence(format, entry.version)}>Version {entry.version} {format.toUpperCase()}</button>)}</div></details>)}
      </div>
    </Modal>}
  </div>;
}
