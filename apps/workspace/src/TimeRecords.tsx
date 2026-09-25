import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { DateTime } from 'luxon';
import { ArrowLeft, ArrowRight, ArrowUpRight, BriefcaseBusiness, CalendarDays, Check, Clock3, Coffee, History, Pencil, RefreshCw, Search, SlidersHorizontal, Users, Wallet, X } from 'lucide-react';
import { api, ApiError } from './api';
import { Badge, Empty, Panel, Modal } from './components';
import TimeAdjustments, { type AdjustmentTarget } from './TimeAdjustments';
import TimeCardEditor from './TimeCardEditor';
import { recordDuration as durationLabel, recordSpan as spanMicros, recordTotals as totals, type RecordedSegment as Segment } from './time-record-editor';

type Notice = (message: string, error?: boolean) => void;
type DecisionAttempt = { kind: 'review'; path: string; body: { version: number; status: 'approved' | 'declined'; note: string } } | { kind: 'cancel'; path: string; body: { version: number } };
export type TimeRecordsTarget = { userId?: string; shiftId?: string; edit?: boolean; start?: string; end?: string; unitId?: string; jobId?: string };
const label = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat('LLL d, yyyy h:mm:ss a ZZZZ');
const conciseDate = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat('ccc, LLL d');
const conciseTime = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat('h:mm a');
const recordSegments = (detail: any): Segment[] => detail.segments.map((row: any) => ({ jobId: row.job_id, kind: row.kind, startedAt: row.started_at, endedAt: row.ended_at }));
const clockRange = (row: any, zone: string) => row.ended_at ? `${conciseTime(row.started_at, zone)} → ${conciseDate(row.started_at, zone) !== conciseDate(row.ended_at, zone) ? `${conciseDate(row.ended_at, zone)} · ` : ''}${conciseTime(row.ended_at, zone)}` : `${conciseTime(row.started_at, zone)} → On the clock`;

export default function TimeRecords({ me, notify, onChanged, onDirty, onPendingChange, onNavigatePayroll, target, onTargetConsumed }: {
  me: any; notify: Notice; onChanged(): Promise<void>; onDirty?(dirty: boolean): void; onPendingChange?(pending: boolean): void;
  onNavigatePayroll?(): void; target?: TimeRecordsTarget | null; onTargetConsumed?(): void;
}) {
  const zone = me.organization.timezone, today = DateTime.now().setZone(zone);
  const [start, setStart] = useState(today.startOf('week').toISODate()!), [end, setEnd] = useState(today.toISODate()!);
  const [employeeId, setEmployeeId] = useState(me.permissions.report ? '' : me.actor.id), [jobId, setJobId] = useState(''), [unitId, setUnitId] = useState('');
  const [search, setSearch] = useState(''), [querySearch, setQuerySearch] = useState(''), [status, setStatus] = useState('all'), [sort, setSort] = useState('newest'), [offset, setOffset] = useState(0);
  const [list, setList] = useState<any>(null), [listKey, setListKey] = useState(''), [detailData, setDetail] = useState<any>(null), [detailKey, setDetailKey] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false), [accessLost, setAccessLost] = useState(false), [reload, setReload] = useState(0);
  const [editor, setEditor] = useState(false), [editorPending, setEditorPending] = useState(false), [review, setReview] = useState<any>(null);
  const [decisionAttempt, setDecisionAttempt] = useState<DecisionAttempt | null>(null), [decisionStale, setDecisionStale] = useState(false);
  const [view, setView] = useState<'records' | 'open' | 'requests'>('records'), [adjustmentTarget, setAdjustmentTarget] = useState<AdjustmentTarget | null>(null), [adjustmentDirty, setAdjustmentDirty] = useState(false), [adjustmentPending, setAdjustmentPending] = useState(false);
  const [queuedOpen, setQueuedOpen] = useState<{ shiftId: string; edit: boolean } | null>(null);
  const dirty = adjustmentDirty || editor || Boolean(review) || Boolean(decisionAttempt), pending = busy || editorPending || adjustmentPending || Boolean(decisionAttempt);
  const authorityKey = [me.actor.org_id, me.actor.id, me.actor.mode, me.actor.role, me.actor.csrf, me.permissions.report, me.permissions.manage, JSON.stringify(me.actor.unit_ids ?? [])].join('|');
  const contextKey = [authorityKey, start, end, employeeId, jobId, unitId, querySearch, status, sort, offset].join('|');
  const latestContext = useRef(contextKey), mounted = useRef(true), listRequest = useRef(0), detailRequest = useRef(0), busyRef = useRef(false), detailHeading = useRef<HTMLDivElement>(null), previousAuthority = useRef(authorityKey);
  const decisionAttemptRef = useRef<DecisionAttempt | null>(null);
  latestContext.current = contextKey;
  const visibleList = listKey === contextKey && !accessLost ? list : null, detail = detailKey === contextKey && !accessLost ? detailData : null;
  const rows: any[] = visibleList?.rows ?? [], summary = visibleList?.summary, options = visibleList?.options;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current++; detailRequest.current++; }; }, []);
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  useEffect(() => { onPendingChange?.(pending); return () => onPendingChange?.(false); }, [pending, onPendingChange]);
  useEffect(() => { const timer = setTimeout(() => { setQuerySearch(search.trim()); setOffset(0); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (previousAuthority.current === authorityKey) return;
    previousAuthority.current = authorityKey; listRequest.current++; detailRequest.current++; busyRef.current = false; decisionAttemptRef.current = null; setDecisionAttempt(null); setDecisionStale(false); setBusy(false); setDetailLoading(false);
    setList(null); setDetail(null); setEditor(false); setReview(null); setAdjustmentTarget(null); setAdjustmentDirty(false); setAdjustmentPending(false); setEditorPending(false); setAccessLost(false);
    setEmployeeId(me.permissions.report ? '' : me.actor.id); setSearch(''); setQuerySearch(''); setUnitId(''); setJobId(''); setStatus('all'); setOffset(0); setError(''); setQueuedOpen(null);
  }, [authorityKey]);
  function privateFailure(cause: unknown) {
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      listRequest.current++; detailRequest.current++; busyRef.current = false; decisionAttemptRef.current = null; setDecisionAttempt(null); setDecisionStale(false); setBusy(false); setList(null); setDetail(null); setEditor(false); setReview(null); setAdjustmentTarget(null); setAdjustmentDirty(false); setEditorPending(false); setAdjustmentPending(false); setLoading(false); setDetailLoading(false); setAccessLost(true);
      setError('These private time cards are no longer available with your current access. Sign in again or refresh after access is restored.');
      return true;
    }
    return false;
  }
  function changeView(next: typeof view) { if (dirty || pending) { notify('Finish or close the current time-card change first.', true); return; } detailRequest.current++; setDetailLoading(false); setView(next); }
  const load = useCallback(() => api('/time-records?' + new URLSearchParams({ start, end, offset: String(offset), status, sort, ...(employeeId ? { userId: employeeId } : {}), ...(jobId ? { jobId } : {}), ...(unitId ? { unitId } : {}), ...(querySearch ? { search: querySearch } : {}) })), [start, end, offset, employeeId, jobId, unitId, status, sort, querySearch, authorityKey]);
  useEffect(() => {
    if (accessLost) return;
    const key = contextKey, request = ++listRequest.current; setLoading(true); setError('');
    void load().then(result => { if (mounted.current && latestContext.current === key && request === listRequest.current) { setList(result); setListKey(key); } }).catch(cause => { if (mounted.current && latestContext.current === key && request === listRequest.current && !privateFailure(cause)) setError((cause as Error).message); }).finally(() => { if (mounted.current && latestContext.current === key && request === listRequest.current) setLoading(false); });
  }, [load, reload, accessLost]);
  async function open(id: string, edit = false) {
    if (dirty || pending || accessLost) return;
    const request = ++detailRequest.current, key = contextKey; setDetailLoading(true); setError('');
    try {
      const result = await api('/time-records/' + id);
      if (!mounted.current || request !== detailRequest.current || latestContext.current !== key) return;
      setDetail(result); setDetailKey(key);
      if (edit && result.shift.ended_at && (result.canAdjust || result.canPropose)) setEditor(true);
      else if (edit && !result.shift.ended_at && (me.permissions.manage || result.shift.user_id === me.actor.id)) setAdjustmentTarget({ kind: 'close_open_shift', shiftId: result.shift.id });
      else requestAnimationFrame(() => detailHeading.current?.focus());
    } catch (cause) { if (mounted.current && request === detailRequest.current && latestContext.current === key && !privateFailure(cause)) setError((cause as Error).message); }
    finally { if (mounted.current && request === detailRequest.current && latestContext.current === key) setDetailLoading(false); }
  }
  useEffect(() => {
    if (!target || dirty || pending) return;
    setView('records'); setDetail(null); setOffset(0); setSearch(''); setQuerySearch(''); setStatus('all'); setSort('newest');
    setEmployeeId(target.userId ?? (me.permissions.report ? '' : me.actor.id)); setJobId(target.jobId ?? ''); setUnitId(target.unitId ?? '');
    if (target.start) setStart(target.start); if (target.end) setEnd(target.end);
    if (target.shiftId) setQueuedOpen({ shiftId: target.shiftId, edit: target.edit ?? false });
    onTargetConsumed?.();
  }, [target, dirty, pending, onTargetConsumed]);
  useEffect(() => { if (queuedOpen && !dirty && !pending) { const next = queuedOpen; setQueuedOpen(null); void open(next.shiftId, next.edit); } }, [queuedOpen, contextKey, dirty, pending]);
  async function reloadDetail() {
    const key = contextKey, request = ++detailRequest.current;
    const result = await api('/time-records/' + detail.shift.id);
    if (!mounted.current || latestContext.current !== key || request !== detailRequest.current) throw Error('The selected time-card view changed.');
    setDetail(result); setDetailKey(key); return result;
  }
  async function refresh() {
    const key = contextKey;
    try {
      if (detail) await reloadDetail();
      const result = await load(); if (!mounted.current || latestContext.current !== key) return;
      setList(result); setListKey(key); await onChanged();
    } catch (cause) { if (mounted.current && latestContext.current === key) { privateFailure(cause); throw cause; } }
  }
  async function saved(immediate: boolean) {
    const key = contextKey; setEditor(false); setEditorPending(false);
    notify(immediate ? 'Time card saved. Recorded hours and payroll source reports now use the corrected times.' : 'Correction submitted for a different manager to review.');
    try { await refresh(); } catch (cause) { if (mounted.current && latestContext.current === key) setError(`The change was saved, but this view could not refresh. Refresh time cards to see the latest record. ${(cause as Error).message}`); }
  }
  async function sendDecision(next?: DecisionAttempt) {
    if (busyRef.current || decisionStale) return;
    const attempt = decisionAttemptRef.current ?? next;
    if (!attempt) return;
    const key = contextKey; decisionAttemptRef.current = attempt; setDecisionAttempt(attempt); busyRef.current = true; setBusy(true); setError('');
    try {
      await api(attempt.path, attempt.body);
      if (!mounted.current || latestContext.current !== key) return;
      decisionAttemptRef.current = null; setDecisionAttempt(null); setReview(null);
      notify(attempt.kind === 'cancel' ? 'Correction request cancelled.' : attempt.body.status === 'approved' ? 'Reviewed correction applied.' : 'Correction declined; recorded time is unchanged.');
      // A confirmed decision stays confirmed even when refreshing its view fails.
      try { await refresh(); } catch (cause) { if (mounted.current && latestContext.current === key && !privateFailure(cause)) setError(`The decision was saved. Refresh time cards to see the latest record. ${(cause as Error).message}`); }
    } catch (cause) {
      if (!mounted.current || latestContext.current !== key) return;
      if (cause instanceof ApiError && cause.status < 500) {
        decisionAttemptRef.current = null; setDecisionAttempt(null);
        if (privateFailure(cause)) return;
        if (cause.status === 409) setDecisionStale(true);
        setError((cause as Error).message);
      } else setError('The decision may already have been saved. Retry the same decision to recover its result; its original action and details are preserved.');
    }
    finally { if (mounted.current && latestContext.current === key) { busyRef.current = false; setBusy(false); } }
  }
  function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current || decisionStale) return;
    if (decisionAttemptRef.current) { void sendDecision(); return; }
    if (!review) return;
    const form = new FormData(event.currentTarget);
    void sendDecision({ kind: 'review', path: `/time-corrections/${review.row.id}/review`, body: { version: review.row.version, status: review.status, note: String(form.get('note') ?? '').trim() } });
  }
  async function cancel(row: any) {
    if (busyRef.current || decisionAttemptRef.current || decisionStale) return;
    await sendDecision({ kind: 'cancel', path: `/time-corrections/${row.id}/cancel`, body: { version: row.version } });
  }
  async function reloadDecision() {
    if (busyRef.current || decisionAttemptRef.current) return;
    const key = contextKey; busyRef.current = true; setBusy(true); setError('');
    try { await refresh(); if (mounted.current && latestContext.current === key) { setDecisionStale(false); setReview(null); } }
    catch (cause) { if (mounted.current && latestContext.current === key && !privateFailure(cause)) setError((cause as Error).message); }
    finally { if (mounted.current && latestContext.current === key) { busyRef.current = false; setBusy(false); } }
  }
  function period(from: DateTime, through: DateTime) { setStart(from.toISODate()!); setEnd(through.toISODate()!); setOffset(0); }
  const disabled = dirty || pending || decisionStale, decisionLocked = busy || Boolean(decisionAttempt), detailTotals = detail ? totals(recordSegments(detail)) : null;
  const fullRange = summary && (summary.cardWorkMicroseconds !== summary.workMicroseconds || summary.cardBreakMicroseconds !== summary.breakMicroseconds);

  return <div className="time-records-module">
    <header className="records-hero"><div><span className="records-eyebrow"><Clock3 size={15}/> EMPLOYEE TIME CARDS</span><h2>See the hours. Make the correction.</h2><p>Find any employee’s time, edit dates or clock times, and keep a clear history of every change.</p></div><div className="records-hero-art" aria-hidden="true"><div><Clock3 size={30}/><i/><i/><i/></div><span><Check size={18}/></span></div>{onNavigatePayroll && <button type="button" className="button records-payroll" onClick={onNavigatePayroll} disabled={disabled}><Wallet size={18}/>Open payroll<ArrowUpRight size={16}/></button>}</header>
    {!accessLost && <div inert={editor || Boolean(review) || busy || Boolean(decisionAttempt) || decisionStale}><TimeAdjustments key={authorityKey} me={me} view={view} onView={changeView} target={adjustmentTarget} onTargetConsumed={() => setAdjustmentTarget(null)} onChanged={refresh} onDirty={setAdjustmentDirty} onPendingChange={setAdjustmentPending} notify={notify}/></div>}
    {error && !editor && !review && <p className="error" role="alert">{error}</p>}
    {decisionAttempt?.kind === 'cancel' && <div className="time-card-warning" role="status"><p>{busy ? 'Saving the cancellation…' : 'The cancellation may already be saved. Keep this view open and retry the same cancellation to confirm its result.'}</p><button type="button" className="button primary" disabled={busy} onClick={() => void sendDecision()}>Retry same cancellation</button></div>}
    {decisionStale && !review && <div className="time-card-warning" role="status"><p>This request or time card changed. Load the latest card and requests before choosing another action.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reloadDecision()}>Load latest card &amp; requests</button></div>}
    {view === 'records' && (detail ? <>
      <div className="records-detail-nav" ref={detailHeading} tabIndex={-1}><button className="text-link" disabled={disabled} onClick={() => { detailRequest.current++; setDetail(null); setDetailLoading(false); }}><ArrowLeft size={16}/>Back to time cards</button><span><CalendarDays size={15}/>{conciseDate(detail.shift.started_at, zone)} · {zone.replaceAll('_', ' ')}</span></div>
      <Panel title={detail.shift.employee_name} detail={`${clockRange(detail.shift, zone)} · ${detail.shift.ended_at ? 'Completed time card' : 'Still clocked in'}`} action={detail.shift.ended_at && (detail.canAdjust || detail.canPropose) ? <button type="button" className="button primary" disabled={disabled} onClick={() => setEditor(true)}><Pencil size={16}/>{detail.canAdjust ? 'Edit time card' : 'Request correction'}</button> : !detail.shift.ended_at && (me.permissions.manage || detail.shift.user_id === me.actor.id) ? <button type="button" className="button primary" disabled={disabled} onClick={() => setAdjustmentTarget({ kind: 'close_open_shift', shiftId: detail.shift.id })}>Fix missed clock-out</button> : undefined}>
        <div className="records-detail-stats"><div><BriefcaseBusiness size={19}/><span>Recorded work<strong>{durationLabel(detailTotals!.work)}</strong><small>{detail.shift.ended_at ? 'Excludes breaks' : 'Finished entries only; current entry is still running'}</small></span></div><div><Coffee size={19}/><span>Recorded breaks<strong>{durationLabel(detailTotals!.break)}</strong><small>Work and breaks stay separate</small></span></div><div><History size={19}/><span>Completed-card edits<strong>{detail.corrections.length}</strong><small>Revision {detail.shift.revision} · Other history below</small></span></div></div>
        <div className="time-record-summary"><Badge tone={detail.shift.ended_at ? 'neutral' : 'green'}>{detail.shift.ended_at ? 'Completed' : 'On the clock'}</Badge><p>{detail.canAdjust ? 'Save corrections immediately. Original times, reasons and editor names remain below.' : detail.shift.ended_at ? 'Requested corrections require an independent review. Original times remain in history.' : 'Use Fix missed clock-out when an employee forgot to end this shift.'}</p></div>
        <SegmentList segments={recordSegments(detail)} jobs={detail.jobs} zone={zone}/>
      </Panel>
      <Panel title="Changes & audit history" detail="Completed-card edits appear below. Missing-card entries and clock-out corrections are in the linked history. Every change retains its original evidence." action={<button type="button" className="button secondary" disabled={disabled} onClick={() => setAdjustmentTarget({ kind: 'shift_requests', shiftId: detail.shift.id })}><History size={16}/>Missing card &amp; clock-out history</button>}>
        {detail.corrections.length ? <div className="correction-list">{detail.corrections.map((row: any) => <article key={row.id}>
          <div className="correction-heading"><div><strong>{row.original.action === 'administrative_adjustment' ? `Adjusted by ${row.original.editor?.name ?? row.proposer_name}` : row.proposer_name}</strong><p>{label(row.created_at, zone)} · From revision {row.source_revision}{row.original.employee?.name ? ` · ${row.original.employee.name}` : ''}</p></div><Badge tone={row.status === 'approved' ? 'green' : row.status === 'pending' ? 'warm' : 'neutral'}>{row.original.action === 'administrative_adjustment' ? 'Applied directly' : row.status}</Badge></div>
          <p className="correction-reason">{row.reason}</p><CorrectionComparison row={row} jobs={detail.jobs} zone={zone}/>
          {row.reviewed_at && row.original.action !== 'administrative_adjustment' && <p className="correction-review-note"><strong>{row.reviewer_name}</strong> · {label(row.reviewed_at, zone)}<br/>{row.review_note}</p>}
          {row.status === 'pending' && <div className="dialog-actions">{row.proposed_by === me.actor.id && <button className="button secondary" disabled={disabled} onClick={() => void cancel(row)}>Cancel my request</button>}{me.permissions.manage && row.proposed_by !== me.actor.id && row.user_id !== me.actor.id && <><button className="button secondary" disabled={disabled} onClick={() => { setError(''); setReview({ row, status: 'declined' }); }}><X size={16}/>Decline</button><button className="button primary" disabled={disabled || row.source_revision !== detail.shift.revision} onClick={() => { setError(''); setReview({ row, status: 'approved' }); }}><Check size={16}/>Review &amp; apply</button></>}{row.source_revision !== detail.shift.revision && <p className="error">This request refers to an older revision. Start from the current time card for another correction.</p>}</div>}
        </article>)}</div> : <Empty title="No completed-card corrections" detail="Use Missing card & clock-out history to see card creation or clock-out adjustments. Later edits retain their evidence here."/>}
      </Panel>
    </> : <>
      <section className="records-workbench" aria-label="Find employee time cards">
        <div className="records-range-heading"><span><SlidersHorizontal size={17}/> Find employee time</span><small>{zone.replaceAll('_', ' ')}</small></div>
        <div className="records-range-row"><div className="time-record-filters"><label>From<input type="date" value={start} disabled={disabled} onChange={event => { setStart(event.target.value); setOffset(0); }}/></label><label>Through<input type="date" value={end} disabled={disabled} onChange={event => { setEnd(event.target.value); setOffset(0); }}/></label></div><div className="records-date-shortcuts"><button type="button" disabled={disabled} onClick={() => period(today, today)}>Today</button><button type="button" disabled={disabled} onClick={() => period(today.startOf('week'), today)}>This week</button><button type="button" disabled={disabled} onClick={() => period(today.minus({ weeks: 1 }).startOf('week'), today.minus({ weeks: 1 }).endOf('week'))}>Last week</button><button type="button" disabled={disabled} onClick={() => period(today.startOf('month'), today)}>This month</button></div></div>
        <div className="records-local-tools"><label className="records-search"><Search size={17}/><input aria-label="Search employee time cards" type="search" maxLength={100} placeholder="Search employees, jobs or communities…" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)}/></label>
          {me.permissions.report && <label>Employee<select aria-label="Time-card employee" value={employeeId} disabled={disabled} onChange={event => { setEmployeeId(event.target.value); setOffset(0); }}><option value="">All permitted employees</option>{employeeId && !options?.employees.some((person: any) => person.id === employeeId) && <option value={employeeId}>Selected employee</option>}{options?.employees.map((person: any) => <option key={person.id} value={person.id}>{person.name}{person.active === false ? ' (inactive)' : ''}</option>)}</select></label>}
          <label>Community<select aria-label="Time-card community" value={unitId} disabled={disabled} onChange={event => { setUnitId(event.target.value); setOffset(0); }}><option value="">All communities</option>{unitId && !options?.units.some((unit: any) => unit.id === unitId) && <option value={unitId}>Selected community</option>}{options?.units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
          <label>Job<select aria-label="Time-card job" value={jobId} disabled={disabled} onChange={event => { setJobId(event.target.value); setOffset(0); }}><option value="">All jobs</option>{jobId && !options?.jobs.some((job: any) => job.id === jobId) && <option value={jobId}>Selected job</option>}{options?.jobs.map((job: any) => <option key={job.id} value={job.id}>{job.title} · {job.unitName}{job.active === false ? ' (inactive)' : ''}</option>)}</select></label>
          <label>Status<select aria-label="Time-card status" value={status} disabled={disabled} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="all">All time cards</option><option value="open">On the clock</option><option value="completed">Completed</option><option value="pending">Awaiting review</option><option value="revised">Previously revised</option></select></label>
          <label>Sort<select aria-label="Time-card sort" value={sort} disabled={disabled} onChange={event => { setSort(event.target.value); setOffset(0); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Employee name</option><option value="pending">Pending review first</option></select></label>
        </div>
      </section>
      <div className="records-page-stats" aria-label="Totals for all matching time cards in the selected date range">
        <article><span className="records-stat-icon"><BriefcaseBusiness size={21}/></span><div><span>Work in this date range</span><strong className="records-duration" title={summary ? `${summary.workMicroseconds} microseconds` : undefined}>{summary ? durationLabel(summary.workMicroseconds) : '—'}</strong><small>{jobId || unitId ? 'Selected jobs/community only' : 'Breaks excluded'}</small></div></article>
        <article><span className="records-stat-icon peach"><Coffee size={21}/></span><div><span>Breaks in this date range</span><strong className="records-duration">{summary ? durationLabel(summary.breakMicroseconds) : '—'}</strong><small>{jobId || unitId ? 'Selected jobs/community only' : 'Tracked separately'}</small></div></article>
        <article><span className="records-stat-icon blue"><Users size={21}/></span><div><span>Matching time cards</span><strong>{summary?.shiftCount ?? '—'}</strong><small>{summary ? `${summary.employeeCount} employees · ${summary.pendingCount} pending requests` : 'All pages included'}</small></div></article>
        <article><span className="records-stat-icon mint"><Clock3 size={21}/></span><div><span>Still on the clock</span><strong>{summary?.openCount ?? '—'}</strong><small>{visibleList ? `As of ${conciseTime(visibleList.observedAt, zone)}` : 'Current saved snapshot'}</small></div></article>
      </div>
      {summary && <details className="records-job-breakdown"><summary><BriefcaseBusiness size={18}/>Work by job &amp; community<span>{summary.jobs.length} {summary.jobs.length === 1 ? 'job' : 'jobs'}</span></summary><p>Totals and bars use the selected dates, job and community across every page. The cards below retain their complete job and break history for editing.</p><div>{summary.jobs.map((job: any) => { const total = BigInt(summary.workMicroseconds), amount = BigInt(job.workMicroseconds), width = total > 0n ? Number(amount * 10000n / total) / 100 : 0; return <article key={job.jobId}><div><strong>{job.title}</strong><span>{job.unitName}</span></div><strong>{durationLabel(job.workMicroseconds)}</strong><div className="records-job-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, width))}%` }}/></div><small>Breaks {durationLabel(job.breakMicroseconds)}</small></article>; })}</div>{!summary.jobs.length && <p>No recorded jobs match these filters.</p>}</details>}
      <Panel title="Employee time cards" detail="Search and filters cover every matching time card. Edit a completed card directly, or open its history to see the full job and break timeline." action={<button type="button" className="button secondary" disabled={disabled || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/>Refresh</button>}>
        <div className="records-result-count" role="status"><span>{loading ? 'Loading employee time cards…' : detailLoading ? 'Opening time card…' : summary ? `${summary.shiftCount} matching time cards · showing ${rows.length ? offset + 1 : 0}–${offset + rows.length}` : 'Choose a date range'}{fullRange && <small>Each card shows its complete times and jobs; the totals above use only the selected dates, job and community.</small>}</span>{(search || employeeId || unitId || jobId || status !== 'all') && <button type="button" className="text-link" disabled={disabled} onClick={() => { setSearch(''); setQuerySearch(''); setEmployeeId(me.permissions.report ? '' : me.actor.id); setUnitId(''); setJobId(''); setStatus('all'); setOffset(0); }}>Clear filters</button>}</div>
        <div className="time-record-list" aria-busy={loading || detailLoading}>{rows.map(row => <article key={row.id} data-shift-id={row.id} className={`time-record-card ${!row.ended_at ? 'record-is-open' : ''}`}>
          <div className="record-card-main"><div className="record-date-tile" aria-hidden="true"><strong>{DateTime.fromISO(row.started_at).setZone(zone).toFormat('dd')}</strong><span>{DateTime.fromISO(row.started_at).setZone(zone).toFormat('LLL')}</span></div><div className="record-person"><strong>{row.employee_name}</strong>{row.employee_active === false && <Badge>Inactive account</Badge>}<p>{conciseDate(row.started_at, zone)}</p><div className="record-clock-range"><Clock3 size={14}/><span>{clockRange(row, zone)}</span></div></div><div className="record-span"><span>Work</span><strong title={`${row.workMicroseconds} microseconds`}>{durationLabel(row.workMicroseconds)}</strong><small>Breaks {durationLabel(row.breakMicroseconds)}</small></div></div>
          <div className="record-jobs">{row.jobs.map((job: any) => <span key={job.jobId}><BriefcaseBusiness size={14}/><span><strong>{job.title}</strong><small>{job.unitName} · {durationLabel(job.workMicroseconds)} work{BigInt(job.breakMicroseconds) > 0n ? ` · ${durationLabel(job.breakMicroseconds)} break` : ''}</small></span></span>)}</div>
          <div className="record-card-footer"><div className="time-record-tags"><Badge tone={row.ended_at ? 'neutral' : 'green'}>{row.ended_at ? 'Completed' : 'On the clock'}</Badge>{row.pending_count > 0 && <Badge tone="warm">{row.pending_count} awaiting review</Badge>}{row.revision > 1 && <Badge>Revised {row.revision - 1}×</Badge>}</div><div className="record-card-actions"><button type="button" className="button secondary" disabled={loading || search.trim() !== querySearch || detailLoading || disabled} onClick={() => void open(row.id)}><History size={16}/>View card &amp; history</button>{row.ended_at && (row.canAdjust || me.permissions.manage || row.user_id === me.actor.id) && <button type="button" className="button primary" disabled={loading || search.trim() !== querySearch || detailLoading || disabled} onClick={() => void open(row.id, true)}><Pencil size={16}/>{row.canAdjust ? 'Edit time card' : 'Request correction'}</button>}{!row.ended_at && (me.permissions.manage || row.user_id === me.actor.id) && <button type="button" className="button primary" disabled={loading || search.trim() !== querySearch || detailLoading || disabled} onClick={() => setAdjustmentTarget({ kind: 'close_open_shift', shiftId: row.id })}>Fix missed clock-out</button>}</div></div>
        </article>)}</div>
        {!rows.length && <Empty title={loading ? 'Loading time cards…' : 'No time cards match'} detail="Try another employee, date range or filter. Use Add missing time card above if a shift was never recorded."/>}
        <div className="mail-pagination records-pagination"><button className="button secondary" disabled={offset === 0 || loading || disabled} onClick={() => setOffset(value => Math.max(0, value - 100))}><ArrowLeft size={16}/>Previous</button><span>{summary ? `${summary.shiftCount} matching cards` : 'Time cards'}<small>Totals include all matching pages</small></span><button className="button secondary" disabled={!visibleList?.hasMore || loading || disabled} onClick={() => setOffset(value => value + 100)}>Next<ArrowRight size={16}/></button></div>
      </Panel>
    </>)}
    {editor && detail && <TimeCardEditor key={`${authorityKey}|${detail.shift.id}`} detail={detail} zone={zone} authorityKey={authorityKey} onClose={() => setEditor(false)} onSaved={saved} onReload={reloadDetail} onDenied={privateFailure} onPendingChange={setEditorPending}/>}
    {review && detail && <Modal title={review.status === 'approved' ? 'Review and apply correction' : 'Decline correction'} onClose={() => { if (!busyRef.current && !decisionAttemptRef.current) setReview(null); }}><form className="community-form" onSubmit={decide}><p>{review.status === 'approved' ? 'Applying this request changes recorded work and breaks. Original entries remain in history.' : 'The proposed changes will not be applied.'}</p><CorrectionComparison row={review.row} jobs={detail.jobs} zone={zone}/><label>Review note<textarea name="note" required minLength={10} maxLength={2000} rows={3} disabled={decisionLocked || decisionStale}/></label>{error && <p className="error" role="alert">{error}</p>}{decisionAttempt && !busy && <p className="time-card-warning" role="status">The original action, version and note are locked until this decision is confirmed.</p>}{decisionStale && <div className="time-card-warning"><p>This request or time card changed. Load its latest state before deciding again.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reloadDecision()}>Load latest card &amp; requests</button></div>}<div className="dialog-actions"><button type="button" className="button secondary" disabled={decisionLocked} onClick={() => setReview(null)}>Cancel</button><button className="button primary" disabled={busy || decisionStale}>{busy ? 'Saving…' : decisionAttempt ? 'Retry same decision' : review.status === 'approved' ? 'Apply reviewed correction' : 'Record decline'}</button></div></form></Modal>}
  </div>;
}

function SegmentList({ segments, jobs, zone }: { segments: Segment[]; jobs: any[]; zone: string }) {
  return <div className="time-segments" aria-label="Recorded shift timeline">{segments.map((segment, index) => { const job = jobs.find(item => item.id === segment.jobId); return <div key={index} className={`time-segment-event ${segment.kind === 'break' ? 'segment-break' : 'segment-work'}`}><span className="segment-timeline-marker" aria-hidden="true">{segment.kind === 'break' ? <Coffee size={18}/> : <BriefcaseBusiness size={18}/>}</span><div className="segment-event-content"><small className="segment-event-label">{segment.kind === 'break' ? 'RECORDED BREAK' : 'RECORDED WORK'} · ENTRY {index + 1}</small><strong>{job?.title ?? 'Recorded job'}</strong><span>{job?.unit_name ?? 'Recorded community'}</span><p>{conciseDate(segment.startedAt, zone)} · {conciseTime(segment.startedAt, zone)} → {segment.endedAt ? `${conciseDate(segment.startedAt, zone) !== conciseDate(segment.endedAt, zone) ? `${conciseDate(segment.endedAt, zone)} · ` : ''}${conciseTime(segment.endedAt, zone)}` : 'Still open'}</p><details className="segment-exact"><summary>Exact recorded times</summary><p>Start: <code>{segment.startedAt}</code><br/>End: <code>{segment.endedAt ?? 'Still open'}</code>{segment.endedAt && <><br/>Exact duration: <code>{spanMicros(segment.startedAt, segment.endedAt)?.toString()} microseconds</code></>}</p></details></div><span>{durationLabel(spanMicros(segment.startedAt, segment.endedAt))}</span></div>; })}</div>;
}
function CorrectionComparison({ row, jobs, zone }: { row: any; jobs: any[]; zone: string }) {
  const before = totals(row.original.segments), after = totals(row.proposed);
  return <details className="correction-comparison"><summary><History size={15}/>{durationLabel(before.work)} → {durationLabel(after.work)} work · {durationLabel(before.break)} → {durationLabel(after.break)} break</summary><div className="correction-versions"><section><h3>Before · revision {row.source_revision}</h3><SegmentList segments={row.original.segments} jobs={jobs} zone={zone}/></section><section><h3>{row.status === 'approved' ? 'Saved correction' : 'Requested correction'}</h3><SegmentList segments={row.proposed} jobs={jobs} zone={zone}/></section></div></details>;
}
