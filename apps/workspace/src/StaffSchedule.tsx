import { useEffect, useRef, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import { ChevronLeft, ChevronRight, History, Pencil, Plus, RefreshCw, XCircle } from "lucide-react";
import { api, ApiError } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import { ScheduleRequestComposer } from "./ScheduleRequests";
import type { StaffScheduleSnapshot } from "../shared/staff-scheduling";
import "./staff-schedule.css";

type Shift = {
  id: string; user_id: string; job_id: string; starts_at: string; ends_at: string;
  note: string; employee_name: string; job_title: string; unit_name: string; unit_id: string;
  version: number; status: "scheduled" | "cancelled"; updated_at: string; cancelled_at: string | null;
};
type Draft = { userId: string; jobId: string; startsLocal: string; endsLocal: string; startOffset: string; endOffset: string; note: string; reason: string };
type Editor = { kind: "create" | "edit" | "cancel"; shift?: Shift; initial: Draft };
type Review = { input: Record<string, unknown>; startsAt: string; endsAt: string; jobTitle: string; unitName: string; employeeName: string };
type HistoryEntry = { version: number; action: string; reason: string; before_snapshot: StaffScheduleSnapshot | null; after_snapshot: StaffScheduleSnapshot; actor_name: string; created_at: string };
const localFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS";
const localTime = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat(localFormat);
const timeLabel = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat("ccc, LLL d, yyyy · h:mm a ZZZZ");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The schedule could not be updated. Please try again.";

function offsetChoices(value: string, zone: string) {
  const date = DateTime.fromISO(value, { zone });
  return date.isValid ? date.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis()) : [];
}
function exactInstant(value: string, offset: string, zone: string) {
  const date = DateTime.fromISO(value, { zone });
  const entered = DateTime.fromISO(value, { zone: "UTC" });
  if (!date.isValid || !entered.isValid || date.toFormat(localFormat) !== entered.toFormat(localFormat))
    throw new Error("A selected local time does not exist because of the daylight-saving change. Choose a valid time.");
  const choices = offsetChoices(value, zone);
  if (choices.length > 1) {
    const chosen = choices.find(choice => String(choice.offset) === offset);
    if (!chosen) throw new Error("Choose the occurrence for each repeated daylight-saving time.");
    return chosen.toUTC().toISO()!;
  }
  return date.toUTC().toISO()!;
}

export default function StaffSchedule({ me, staff, jobs, rows, week, zone, onWeek, onChanged, notify, onDirty, onRequests, isSessionCurrent, onSessionExpired, range, filters, onManageEmployeeJobs, onBlocked }: {
  me: any; staff: any[]; jobs: any[]; rows: Shift[]; week: string; zone: string;
  onWeek: (value: string) => void; onChanged: () => Promise<void>;
  notify: (message: string, error?: boolean) => void; onDirty: (dirty: boolean) => void;
  onRequests: (scheduleId: string, requestId?: string) => void;
  isSessionCurrent?: () => boolean; onSessionExpired?: () => void;
  range?: { start: string; end: string }; filters?: { unitId?: string; jobId?: string; userId?: string; search?: string };
  onManageEmployeeJobs?: (person: any) => void; onBlocked?: (value:boolean) => void;
}) {
  const canManage = ["developer", "owner", "admin", "manager"].includes(me.actor.role) && me.actor.mode === "password";
  const canManageShift = (shift: Shift) => canManage && (me.actor.role !== "manager" || me.actor.unit_ids.includes(shift.unit_id));
  const [showCancelled, setShowCancelled] = useState(false), [unitId, setUnitId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<Review | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [requestEditor, setRequestEditor] = useState<{ shift: Shift; action: "update" | "cancel" } | null>(null), [requestDirty, setRequestDirty] = useState(false);
  const [historyShift, setHistoryShift] = useState<Shift | null>(null), [historyRows, setHistoryRows] = useState<HistoryEntry[]>([]);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null), [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const historyRequest = useRef(0), mounted = useRef(true), denied = useRef(false);
  const owner = JSON.stringify([me.actor.id, me.actor.role, me.actor.mode, me.actor.unit_ids]);
  const authority = useRef({ owner, isSessionCurrent }); authority.current = { owner, isSessionCurrent };
  const mayPublish = () => mounted.current && !denied.current && authority.current.owner === owner && (authority.current.isSessionCurrent?.() ?? true);
  const [page, setPage] = useState(1);
  function handleDenied(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status)) return false;
    denied.current = true; setEditor(null); setDraft(null); setReview(null); setHistoryRows([]); setHistoryShift(null); setRequestEditor(null);
    onDirty(false); onSessionExpired?.(); return true;
  }
  const dirty = Boolean(editor && draft && (review || JSON.stringify(draft) !== JSON.stringify(editor.initial)));
  useEffect(() => { onBlocked?.(busy); return () => onBlocked?.(false); },[busy,onBlocked]);
  useEffect(() => { onDirty(dirty || busy || requestDirty); return () => onDirty(false); }, [dirty, busy, requestDirty, onDirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; historyRequest.current += 1; }; }, []);
  useEffect(() => setPage(1), [range?.start, range?.end, filters?.unitId, filters?.jobId, filters?.userId, filters?.search, unitId, showCancelled]);

  const visible = rows.filter(row => (showCancelled || row.status !== "cancelled") && (!(filters?.unitId || unitId) || row.unit_id === (filters?.unitId || unitId)) && (!filters?.jobId || row.job_id === filters.jobId) && (!filters?.userId || row.user_id === filters.userId) && (!filters?.search || `${row.employee_name} ${row.job_title} ${row.unit_name} ${row.note}`.toLowerCase().includes(filters.search.toLowerCase())));
  const units = Array.from(new Map([...jobs.map(row => [row.unit_id, row.unit_name] as [string,string]), ...rows.map(row => [row.unit_id, row.unit_name] as [string,string])]).entries());
  const firstDay = DateTime.fromISO(range?.start ?? week, { zone });
  const dayCount = range ? Math.round(DateTime.fromISO(range.end, { zone }).diff(firstDay, "days").days) + 1 : 7;
  const days = Array.from({length: Math.min(366, Math.max(1, dayCount))}, (_, i) => firstDay.plus({days:i})).filter(date => dayCount <= 7 || visible.some(shift => Date.parse(shift.starts_at) < date.plus({days:1}).toMillis() && Date.parse(shift.ends_at) > date.toMillis()));
  const activeStaff = staff.filter(person => person.active);
  const assignedJobs = draft ? jobs.filter(job => job.active !== false &&
    (staff.find(person => person.id === draft.userId)?.job_ids ?? []).includes(job.id)) : [];
  const selectedShift = editor?.shift;
  const stale = Boolean(selectedShift && rows.find(row => row.id === selectedShift.id)?.version !== undefined &&
    rows.find(row => row.id === selectedShift.id)?.version !== selectedShift.version);

  function openEditor(kind: Editor["kind"], shift?: Shift) {
    if (!mayPublish()) return;
    const person = shift?.user_id ?? filters?.userId ?? "";
    const initial: Draft = {
      userId: person, jobId: shift?.job_id ?? "", startsLocal: shift ? localTime(shift.starts_at, zone) : "",
      endsLocal: shift ? localTime(shift.ends_at, zone) : "", startOffset: shift ? String(DateTime.fromISO(shift.starts_at).setZone(zone).offset) : "",
      endOffset: shift ? String(DateTime.fromISO(shift.ends_at).setZone(zone).offset) : "", note: shift?.note ?? "", reason: "",
    };
    setEditor({ kind, shift, initial }); setDraft(initial); setReview(null); setError("");
  }
  function closeEditor() {
    if (busy || (dirty && !window.confirm("Discard your unsaved schedule changes?"))) return;
    setEditor(null); setDraft(null); setReview(null); setError("");
  }
  function updateDraft(changes: Partial<Draft>) { setDraft(current => current ? { ...current, ...changes } : current); setReview(null); setError(""); }
  async function refreshList() {
    if (refreshing || !mayPublish()) return;
    setRefreshing(true);
    try { await onChanged(); }
    catch (cause) { if (mayPublish() && !handleDenied(cause)) { if (editor) setError(errorMessage(cause)); else notify(errorMessage(cause), true); } }
    finally { if (mayPublish()) setRefreshing(false); }
  }
  function reviewShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !editor) return;
    setError("");
    try {
      const reason = draft.reason.trim();
      if (reason.length < 3) throw new Error("Enter a reason of at least 3 characters.");
      if (stale) throw new Error("This shift changed after you opened it. Close this draft and reopen the current shift before saving.");
      if (editor.kind === "cancel") {
        if (!editor.shift) return;
        setReview({ input: { expectedVersion: editor.shift.version, reason, commandId: crypto.randomUUID() }, startsAt: editor.shift.starts_at,
          endsAt: editor.shift.ends_at, jobTitle: editor.shift.job_title, unitName: editor.shift.unit_name, employeeName: editor.shift.employee_name });
        return;
      }
      const startsAt = exactInstant(draft.startsLocal, draft.startOffset, zone), endsAt = exactInstant(draft.endsLocal, draft.endOffset, zone);
      const duration = Date.parse(endsAt) - Date.parse(startsAt);
      if (duration <= 0 || duration > 86400000) throw new Error("The end must be after the start, with a duration of no more than 24 hours.");
      const job = assignedJobs.find(row => row.id === draft.jobId);
      if (!job) throw new Error("Select a current job assigned to this employee.");
      setReview({ input: { ...(editor.kind === "create" ? { userId: draft.userId } : { expectedVersion: editor.shift!.version }), jobId: draft.jobId,
        startsAt, endsAt, note: draft.note, reason, commandId: crypto.randomUUID() }, startsAt, endsAt, jobTitle: job.title, unitName: job.unit_name,
        employeeName: editor.shift?.employee_name ?? staff.find(person => person.id === draft.userId)?.name ?? "" });
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function saveShift() {
    if (!review || !editor || busy || stale || !mayPublish()) return;
    setBusy(true); setError("");
    try {
      await api(editor.kind === "create" ? "/schedules" : `/schedules/${editor.shift!.id}${editor.kind === "cancel" ? "/cancel" : ""}`,
        review.input, editor.kind === "edit" ? "PATCH" : "POST");
      if (!mayPublish()) return;
      const message = editor.kind === "cancel" ? "Shift cancelled. Its history has been retained." : editor.kind === "edit" ? "Scheduled shift updated." : "Scheduled shift created.";
      setEditor(null); setDraft(null); setReview(null); onDirty(false); notify(message);
      try { await onChanged(); } catch (cause) { if (mayPublish() && !handleDenied(cause)) notify(`Your change was saved, but the list could not refresh: ${errorMessage(cause)}`, true); }
    } catch (cause) { if (mayPublish() && !handleDenied(cause)) setError(errorMessage(cause)); }
    finally { if (mayPublish()) setBusy(false); }
  }
  async function loadHistory(shift: Shift, before?: number) {
    if (!mayPublish()) return;
    const request = ++historyRequest.current;
    if (!before) { setHistoryShift(shift); setHistoryRows([]); setHistoryBefore(null); }
    setHistoryError(""); setHistoryLoading(true);
    try {
      const result = await api<{ rows: HistoryEntry[]; nextBeforeVersion?: number | null }>(`/schedules/${shift.id}/history${before ? `?beforeVersion=${before}` : ""}`);
      if (request !== historyRequest.current || !mayPublish()) return;
      setHistoryRows(current => before ? [...current, ...result.rows] : result.rows); setHistoryBefore(result.nextBeforeVersion ?? null);
    } catch (cause) { if (request === historyRequest.current && mayPublish() && !handleDenied(cause)) setHistoryError(errorMessage(cause)); }
    finally { if (request === historyRequest.current && mayPublish()) setHistoryLoading(false); }
  }
  function closeHistory() { historyRequest.current += 1; setHistoryShift(null); setHistoryLoading(false); }

  return <>
    <Panel title={me.permissions.report ? "Team schedule" : "My schedule"} detail={`All dates and times use ${zone}.`} className="staff-schedule"
      action={canManage ? <button className="button primary" onClick={() => openEditor("create")}><Plus size={17}/>Add shift</button> : undefined}>
      <div className="staff-schedule-toolbar">
        {!range && <><div className="week-control">
          <button className="icon-button" aria-label="Previous week" onClick={() => onWeek(DateTime.fromISO(week).minus({ weeks: 1 }).toISODate()!)}><ChevronLeft size={18}/></button>
          <span>{DateTime.fromISO(week).toFormat("LLL d, yyyy")} – {DateTime.fromISO(week).plus({ days: 6 }).toFormat("LLL d, yyyy")}</span>
          <button className="icon-button" aria-label="Next week" onClick={() => onWeek(DateTime.fromISO(week).plus({ weeks: 1 }).toISODate()!)}><ChevronRight size={18}/></button>
        </div>
        <label>Week containing<input aria-label="Week containing" type="date" value={week} onChange={event => { if (event.target.value) onWeek(DateTime.fromISO(event.target.value).startOf("week").toISODate()!); }}/></label></>}
        {me.permissions.report && !range && <label>Community<select value={unitId} onChange={event => setUnitId(event.target.value)}><option value="">All permitted communities</option>{units.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
        <label className="staff-schedule-check"><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)}/>Show cancelled shifts</label>
        <button className="button secondary small" disabled={refreshing} onClick={() => void refreshList()}><RefreshCw size={15}/>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="staff-schedule-guidance">Linked shift requests change the selected shift when a different authorized reviewer approves them. General requests record a decision only. Schedule edits never change clock history.</p>
      {!visible.length && <Empty title="No shifts in this view" detail={showCancelled ? "Choose another week or community to review scheduled shifts." : "Choose another week or include cancelled shifts to see retained records."}/>}
      <div className={`calendar-grid staff-schedule-grid ${dayCount > 7 ? "staff-schedule-agenda" : ""}`}>
        {days.slice(0, page * 28).map(date => {
          const end = date.plus({ days: 1 });
          const items = visible.filter(shift => Date.parse(shift.starts_at) < end.toMillis() && Date.parse(shift.ends_at) > date.toMillis());
          return <section key={date.toISODate()} className={date.hasSame(DateTime.now().setZone(zone), "day") ? "today" : ""} aria-label={date.toFormat("cccc, LLLL d")}>
            <header><span>{date.toFormat("ccc")}</span><strong>{date.toFormat("LLL d")}</strong></header>
            {items.map(shift => <article key={shift.id} className={`schedule-card staff-shift-card ${shift.status === "cancelled" ? "staff-shift-cancelled" : ""}`}>
              <strong>{shift.employee_name}</strong>
              <span>{DateTime.fromISO(shift.starts_at).setZone(zone).toFormat("LLL d, h:mm a")} – {DateTime.fromISO(shift.ends_at).setZone(zone).toFormat("LLL d, h:mm a")}</span>
              {Date.parse(shift.starts_at) < date.toMillis() && <small>Continues from previous day</small>}
              <small>{shift.job_title}</small><Badge>{shift.unit_name}</Badge>
              {shift.status === "cancelled" && <Badge tone="warning">Cancelled</Badge>}
              {shift.note && <p className="staff-shift-note">{shift.note}</p>}
              <small>Version {shift.version}</small>
              <div className="staff-shift-actions">
                <button className="button secondary small" aria-label={`History for ${shift.employee_name}, ${timeLabel(shift.starts_at, zone)}`} onClick={() => void loadHistory(shift)}><History size={14}/>History</button>
                {me.actor.mode === "password" && shift.user_id === me.actor.id && <>
                  {shift.status === "scheduled" && <><button className="button secondary small" aria-label={`Request a change for ${timeLabel(shift.starts_at, zone)}`} onClick={() => setRequestEditor({ shift, action: "update" })}>Request a change</button>
                    <button className="button secondary small" aria-label={`Request cancellation for ${timeLabel(shift.starts_at, zone)}`} onClick={() => setRequestEditor({ shift, action: "cancel" })}>Request cancellation</button></>}
                  <button className="button secondary small" aria-label={`View requests for ${timeLabel(shift.starts_at, zone)}`} onClick={() => onRequests(shift.id)}>View requests</button>
                </>}
                {canManageShift(shift) && shift.status !== "cancelled" && <>
                  <button className="button secondary small" aria-label={`Edit shift for ${shift.employee_name}, ${timeLabel(shift.starts_at, zone)}`} onClick={() => openEditor("edit", shift)}><Pencil size={14}/>Edit</button>
                  <button className="button secondary small" aria-label={`Cancel shift for ${shift.employee_name}, ${timeLabel(shift.starts_at, zone)}`} onClick={() => openEditor("cancel", shift)}><XCircle size={14}/>Cancel shift</button>
                </>}
              </div>
            </article>)}
            {!items.length && <span className="calendar-empty">No shifts</span>}
          </section>;
        })}
      </div>
      {days.length > page * 28 && <button className="button secondary" onClick={() => setPage(value => value + 1)}>Show more scheduled days</button>}
    </Panel>
    {requestEditor && <ScheduleRequestComposer shift={{ id: requestEditor.shift.id, userId: requestEditor.shift.user_id, employeeName: requestEditor.shift.employee_name,
      jobId: requestEditor.shift.job_id, jobTitle: requestEditor.shift.job_title, unitId: requestEditor.shift.unit_id, unitName: requestEditor.shift.unit_name,
      startsAt: requestEditor.shift.starts_at, endsAt: requestEditor.shift.ends_at, note: requestEditor.shift.note, version: requestEditor.shift.version,
      status: requestEditor.shift.status, updatedAt: requestEditor.shift.updated_at, cancelledAt: requestEditor.shift.cancelled_at }} action={requestEditor.action}
      zone={zone} onChanged={onChanged} notify={notify} onDirty={setRequestDirty} onClose={() => setRequestEditor(null)}
      onCreated={id => { const shiftId = requestEditor.shift.id; setRequestEditor(null); setRequestDirty(false); onDirty(false); onRequests(shiftId, id); }}/>}
    {editor && draft && <Modal title={editor.kind === "create" ? "Add a scheduled shift" : editor.kind === "edit" ? "Edit scheduled shift" : "Cancel scheduled shift"} onClose={closeEditor}>
      <div className="staff-shift-editor">
        <p className="panel-note">{zone} · Schedule changes retain earlier versions and do not change clock history.</p>
        {error && <div><p role="alert" className="form-error">{error}</p><button type="button" className="button secondary small" disabled={busy || refreshing} onClick={() => void refreshList()}>{refreshing ? "Refreshing…" : "Refresh current schedule"}</button></div>}
        {stale && <p role="alert" className="form-error">A newer version of this shift is available. Your draft has been kept. Close it and reopen the refreshed shift before saving.</p>}
        {review ? <>
          <div className="review-summary"><h3>{editor.kind === "cancel" ? "Review cancellation" : "Review scheduled shift"}</h3>
            <strong>{review.employeeName}</strong><p>{review.jobTitle} · {review.unitName}</p>
            <dl className="staff-shift-summary"><dt>Starts</dt><dd>{timeLabel(review.startsAt, zone)}</dd><dt>Ends</dt><dd>{timeLabel(review.endsAt, zone)}</dd>
              {editor.shift && <><dt>Based on</dt><dd>Version {editor.shift.version}</dd></>}
              <dt>Reason</dt><dd>{draft.reason.trim()}</dd><dt>Note</dt><dd>{draft.note || "No note"}</dd></dl>
            {editor.kind === "cancel" && <p>This shift will be marked cancelled. Its earlier versions remain available in History.</p>}
          </div>
          {editor.kind === "edit" && editor.shift && <details><summary>Previous scheduled shift</summary><ShiftSnapshot snapshot={editor.shift} zone={zone}/></details>}
          <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => { setReview(null); setError(""); }}>Back to details</button>
            <button className="button primary" disabled={busy || stale} onClick={() => void saveShift()}>{busy ? "Saving…" : editor.kind === "cancel" ? "Confirm cancellation" : "Save scheduled shift"}</button></div>
        </> : <form onSubmit={reviewShift}>
          {editor.kind === "create" ? <label>Employee<select aria-label="Employee" value={draft.userId} onChange={event => updateDraft({ userId: event.target.value, jobId: "" })} required><option value="">Select an employee</option>{activeStaff.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label> : <div className="review-summary"><strong>{editor.shift?.employee_name}</strong><p>Version {editor.shift?.version}{editor.kind === "edit" ? " · The employee is fixed for this shift." : ""}</p></div>}
          {editor.kind === "cancel" ? <ShiftSnapshot snapshot={editor.shift!} zone={zone}/> : <>
            <label>Assigned job<select aria-label="Assigned job" value={draft.jobId} required onChange={event => updateDraft({ jobId: event.target.value })}><option value="">Select a job</option>{assignedJobs.map(job => <option key={job.id} value={job.id}>{job.title} · {job.unit_name}</option>)}</select></label>
            {draft.userId && !assignedJobs.length && <p role="status" className="panel-note">This employee has no current job assignments available to you. A manager with the required access must update assignments before scheduling.</p>}
            {draft.userId && onManageEmployeeJobs && <button type="button" className="button secondary" onClick={() => { if (dirty && !window.confirm("Discard this shift draft and manage employee jobs?")) return; const person = staff.find(row => row.id === draft.userId); setEditor(null); setDraft(null); setReview(null); onDirty(false); if (person) onManageEmployeeJobs(person); }}>Manage this employee’s jobs</button>}
            <div className="form-row"><label>Starts ({zone})<input aria-label="Shift starts" type="datetime-local" step="0.001" value={draft.startsLocal} required onChange={event => updateDraft({ startsLocal: event.target.value, startOffset: "" })}/></label>
              <label>Ends ({zone})<input aria-label="Shift ends" type="datetime-local" step="0.001" value={draft.endsLocal} required onChange={event => updateDraft({ endsLocal: event.target.value, endOffset: "" })}/></label></div>
            <OffsetPicker label="Start occurrence" value={draft.startsLocal} offset={draft.startOffset} zone={zone} onChange={startOffset => updateDraft({ startOffset })}/>
            <OffsetPicker label="End occurrence" value={draft.endsLocal} offset={draft.endOffset} zone={zone} onChange={endOffset => updateDraft({ endOffset })}/>
            <label>Shift note (optional)<textarea aria-label="Shift note" value={draft.note} maxLength={500} rows={2} onChange={event => updateDraft({ note: event.target.value })}/></label>
          </>}
          <label>{editor.kind === "cancel" ? "Reason for cancellation" : "Reason for this schedule change"}<textarea aria-label="Schedule change reason" value={draft.reason} required minLength={3} maxLength={1000} rows={3} onChange={event => updateDraft({ reason: event.target.value })}/></label>
          <div className="dialog-actions"><button type="button" className="button secondary" onClick={closeEditor}>Discard</button><button className="button primary" disabled={stale}>{editor.kind === "cancel" ? "Review cancellation" : "Review shift"}</button></div>
        </form>}
      </div>
    </Modal>}
    {historyShift && <Modal title="Scheduled shift history" onClose={closeHistory}>
      <div className="staff-shift-history"><p><strong>{historyShift.employee_name}</strong> · {zone}</p><p className="panel-note">Earlier versions remain unchanged. This is schedule history; clock records are managed separately.</p>
        {historyError && <p role="alert" className="form-error">{historyError}</p>}
        {historyLoading && <p role="status">Loading history…</p>}
        {!historyLoading && !historyRows.length && !historyError && <p>No history is available.</p>}
        {historyRows.map(row => <article key={row.version} className="staff-history-entry"><header><strong>Version {row.version}</strong><Badge tone={row.action === "cancelled" ? "warning" : "neutral"}>{historyAction(row.action)}</Badge></header>
          <p>{row.actor_name || "Recorded actor"} · {timeLabel(row.created_at, zone)}</p><p className="staff-shift-reason">{row.reason}</p>
          <details open={row.version === historyRows[0]?.version}><summary>Recorded shift</summary><ShiftSnapshot snapshot={row.after_snapshot} zone={zone}/></details>
          {row.before_snapshot && <details><summary>Before this change</summary><ShiftSnapshot snapshot={row.before_snapshot} zone={zone}/></details>}
        </article>)}
        {historyBefore !== null && <button className="button secondary" disabled={historyLoading} onClick={() => void loadHistory(historyShift, historyBefore)}>Load older versions</button>}
        {historyError && <button className="button secondary" disabled={historyLoading} onClick={() => void loadHistory(historyShift)}>Retry history</button>}
        <div className="dialog-actions"><button className="button secondary" onClick={closeHistory}>Close history</button></div>
      </div>
    </Modal>}
  </>;
}

function OffsetPicker({ label, value, offset, zone, onChange }: { label: string; value: string; offset: string; zone: string; onChange: (value: string) => void }) {
  const choices = offsetChoices(value, zone);
  if (choices.length < 2) return null;
  return <label>{label} — this local time occurs twice<select aria-label={label} value={offset} required onChange={event => onChange(event.target.value)}><option value="">Choose which occurrence</option>{choices.map((choice, index) => <option key={choice.offset} value={String(choice.offset)}>{index === 0 ? "First" : "Second"} occurrence · {choice.toFormat("ZZZZ 'UTC'ZZ")}</option>)}</select></label>;
}
function historyAction(action: string) { return ({ created: "Created", updated: "Edited", cancelled: "Cancelled", baseline: "Retained original" } as Record<string, string>)[action] ?? action; }
function ShiftSnapshot({ snapshot, zone }: { snapshot: Record<string, any>; zone: string }) {
  const startsAt = snapshot.starts_at ?? snapshot.startsAt, endsAt = snapshot.ends_at ?? snapshot.endsAt;
  return <dl className="staff-shift-summary"><dt>Employee</dt><dd>{snapshot.employee_name ?? snapshot.employeeName ?? "Retained employee"}</dd>
    <dt>Job</dt><dd>{snapshot.job_title ?? snapshot.jobTitle ?? "Retained job"}</dd>
    <dt>Community</dt><dd>{snapshot.unit_name ?? snapshot.unitName ?? "Retained community"}</dd>
    <dt>Starts</dt><dd>{startsAt ? timeLabel(startsAt, zone) : "Unavailable"}</dd><dt>Ends</dt><dd>{endsAt ? timeLabel(endsAt, zone) : "Unavailable"}</dd>
    <dt>Status</dt><dd>{snapshot.status === "cancelled" ? "Cancelled" : "Scheduled"}</dd><dt>Note</dt><dd>{snapshot.note || "No note"}</dd></dl>;
}
