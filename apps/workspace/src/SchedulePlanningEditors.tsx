import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { coverageRuleInput, hoursTargetInput, type CoverageRule, type HoursTarget, type PlanningJob, type PlanningHistory } from '../shared/staff-planning';
import { planningDate, planningError, planningTime, usePlanningAccess, type PlanningAccess } from './SchedulePlanningShared';

type Common = PlanningAccess & { jobs: PlanningJob[]; start: string; zone: string; jobId?: string; onClose: () => void; onSaved: () => Promise<void>; onReload: () => Promise<void>; onDirty: (value: boolean) => void; onBlocked: (value: boolean) => void };
type RuleDraft = Omit<CoverageRule, 'id' | 'version' | 'timezone'> & { reason: string };
type TargetDraft = Omit<HoursTarget, 'id' | 'version'> & { reason: string };
export function PlanningRuleEditor(props: Common & { row?: CoverageRule }) {
  const { row, jobs, start, zone, onClose, onSaved, onDirty } = props;
  const [initial] = useState<RuleDraft>(() => row ? { jobId: row.jobId, label: row.label, startDate: row.startDate, endDate: row.endDate, frequency: row.frequency, interval: row.interval, weekdays: [...row.weekdays], startsLocal: row.startsLocal, endsLocal: row.endsLocal, endDayOffset: row.endDayOffset, staffCount: row.staffCount, active: row.active, reason: '' } : { jobId: props.jobId ?? '', label: '', startDate: start, endDate: null, frequency: 'weekly', interval: 1, weekdays: [1,2,3,4,5], startsLocal: '08:00', endsLocal: '15:00', endDayOffset: 0, staffCount: 1, active: true, reason: '' });
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<ReturnType<typeof coverageRuleInput.parse> | null>(null);
  const [id] = useState(row?.id ?? crypto.randomUUID());
  const access = usePlanningAccess(props), dirty = JSON.stringify(initial) !== JSON.stringify(draft) || Boolean(pending);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => {props.onBlocked(busy || Boolean(pending));return () => props.onBlocked(false);},[busy,pending,props.onBlocked]);
  const update = (change: Partial<RuleDraft>) => { setDraft(value => ({...value,...change})); setError(''); };
  const close = () => { if (!busy && !pending && (!dirty || window.confirm('Discard this unsaved coverage rule?'))) onClose(); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !access.current()) return;
    const checked = coverageRuleInput.safeParse(pending ?? {...draft, expectedVersion: row?.version ?? 0, commandId: crypto.randomUUID()});
    if (!checked.success) { setError(checked.error.issues[0]?.message ?? 'Review the rule fields.'); return; }
    setPending(checked.data); setBusy(true); setError('');
    try { await api(`/schedules/planning/rules/${id}`, checked.data, 'PUT'); if (!access.current()) return; setPending(null); onDirty(false); await onSaved(); if (access.current()) onClose(); }
    catch (cause) { if (access.current() && !access.reject(cause)) { if (cause instanceof ApiError && cause.status < 500) setPending(null); if(cause instanceof ApiError && cause.status === 409) {try {await props.onReload();} catch(refreshCause) {if(access.current() && !access.reject(refreshCause))setError(`Your changes were not saved. ${planningError(refreshCause)} Close the form and refresh before reopening.`);return;}} if(!access.current())return; setError(`${planningError(cause)}${cause instanceof ApiError && cause.status === 409 ? ' Close this form and reopen the latest rule before trying again.' : ''}`); } }
    finally { if (access.current()) setBusy(false); }
  }
  if (access.accessDenied) return null;
  return <Modal title={row ? 'Edit staffing rule' : 'Add staffing rule'} onClose={close}><form className="schedule-planning-editor" onSubmit={save}>
    <p className="planning-help">A rule states how many people a job needs at the same time. It does not assign anyone or change existing shifts. Times use {zone}.</p>
    {!row && <p className="planning-callout">Editable starting point: weekdays, 8:00 AM–3:00 PM, one person. Choose the job and confirm the details before saving.</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {pending && !busy && <p role="status" className="planning-callout">The result could not be confirmed. Retry the same save to safely recover its result; these details are locked until it is confirmed.</p>}
    <fieldset disabled={busy || Boolean(pending)}>
      <label>Job<select aria-label="Rule job" required value={draft.jobId} onChange={e => update({jobId:e.target.value})}><option value="">Choose a job</option>{jobs.filter(job => job.active || job.id === draft.jobId).map(job => <option key={job.id} value={job.id}>{job.title} · {job.unitName}{!job.active ? ' (archived)' : ''}</option>)}</select></label>
      <label>Rule name<input aria-label="Rule name" required minLength={2} maxLength={100} value={draft.label} onChange={e => update({label:e.target.value})} placeholder="For example, weekday morning coverage"/></label>
      <div className="planning-form-grid"><label>Repeats<select aria-label="Rule frequency" value={draft.frequency} onChange={e => { const frequency = e.target.value as RuleDraft['frequency']; update({frequency, weekdays: frequency === 'weekly' ? [1,2,3,4,5] : []}); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
      <label>Every <input aria-label="Repeat interval" type="number" required min={1} max={52} value={draft.interval} onChange={e => update({interval:Number(e.target.value)})}/><span className="planning-help">{({daily:'day(s)',weekly:'week(s)',monthly:'month(s)',yearly:'year(s)'})[draft.frequency]}</span></label></div>
      {draft.frequency === 'weekly' && <fieldset className="planning-weekdays"><legend>Weekdays</legend>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,index) => <label key={day}><input type="checkbox" checked={draft.weekdays.includes(index+1)} onChange={e => update({weekdays:e.target.checked ? [...draft.weekdays,index+1].sort() : draft.weekdays.filter(value => value !== index+1)})}/><span>{day}</span></label>)}</fieldset>}
      <div className="planning-form-grid"><label>First effective date<input aria-label="Rule first date" required type="date" value={draft.startDate} onChange={e => update({startDate:e.target.value})}/></label><label>Last effective date (optional)<input aria-label="Rule last date" type="date" value={draft.endDate ?? ''} onChange={e => update({endDate:e.target.value || null})}/></label></div>
      {['monthly','yearly'].includes(draft.frequency) && <p className="planning-help">The first date determines the day{draft.frequency === 'yearly' ? ' and month' : ''} to repeat. Dates that do not exist and daylight-saving conflicts are shown for review, never moved silently.</p>}
      <div className="planning-form-grid"><label>Starts<input aria-label="Coverage starts" required type="time" value={draft.startsLocal} onChange={e => update({startsLocal:e.target.value})}/></label><label>Ends<input aria-label="Coverage ends" required type="time" value={draft.endsLocal} onChange={e => update({endsLocal:e.target.value})}/></label></div>
      <label className="planning-check"><input type="checkbox" checked={draft.endDayOffset === 1} onChange={e => update({endDayOffset:e.target.checked ? 1 : 0})}/>Ends the following day</label>
      <label>People needed at the same time<input aria-label="People needed" required type="number" min={1} max={100} value={draft.staffCount} onChange={e => update({staffCount:Number(e.target.value)})}/></label>
      {row && <label className="planning-check"><input type="checkbox" checked={draft.active} onChange={e => update({active:e.target.checked})}/>Rule active<span className="planning-help">Clear to archive this rule. Previous assignments and history remain.</span></label>}
      <label>Reason for this change<textarea aria-label="Rule change reason" required minLength={3} maxLength={1000} rows={2} value={draft.reason} onChange={e => update({reason:e.target.value})}/></label>
    </fieldset><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy || Boolean(pending)} onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : pending ? 'Retry same save' : 'Save staffing rule'}</button></div>
  </form></Modal>;
}

export function PlanningTargetEditor(props: Common & { row?: HoursTarget }) {
  const { row,jobs,start,onClose,onSaved,onDirty } = props;
  const [initial] = useState<TargetDraft>(() => row ? {jobId:row.jobId,period:row.period,hours:row.hours,effectiveFrom:row.effectiveFrom,effectiveThrough:row.effectiveThrough,active:row.active,reason:''} : {jobId:props.jobId ?? '',period:'week',hours:'',effectiveFrom:start,effectiveThrough:null,active:true,reason:''});
  const [draft,setDraft] = useState(initial), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [pending,setPending] = useState<ReturnType<typeof hoursTargetInput.parse> | null>(null);
  const [id] = useState(row?.id ?? crypto.randomUUID()), access = usePlanningAccess(props);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft) || Boolean(pending);
  useEffect(() => {onDirty(dirty || busy);return () => onDirty(false);},[dirty,busy,onDirty]);
  useEffect(() => {props.onBlocked(busy || Boolean(pending));return () => props.onBlocked(false);},[busy,pending,props.onBlocked]);
  const update = (change:Partial<TargetDraft>) => {setDraft(value => ({...value,...change}));setError('');};
  const close = () => {if (!busy && !pending && (!dirty || window.confirm('Discard this unsaved hours target?'))) onClose();};
  async function save(event:FormEvent) {
    event.preventDefault(); if (busy || !access.current()) return;
    const checked = hoursTargetInput.safeParse(pending ?? {...draft,expectedVersion:row?.version ?? 0,commandId:crypto.randomUUID()});
    if (!checked.success) {setError(checked.error.issues[0]?.message ?? 'Review the target fields.');return;}
    setPending(checked.data);setBusy(true);setError('');
    try {await api(`/schedules/planning/targets/${id}`,checked.data,'PUT');if (!access.current()) return;setPending(null);onDirty(false);await onSaved();if (access.current()) onClose();}
    catch(cause) {if (access.current() && !access.reject(cause)) {if(cause instanceof ApiError && cause.status < 500)setPending(null);if(cause instanceof ApiError && cause.status === 409){try{await props.onReload();}catch(refreshCause){if(access.current() && !access.reject(refreshCause))setError(`Your changes were not saved. ${planningError(refreshCause)} Close the form and refresh before reopening.`);return;}}if(!access.current())return;setError(`${planningError(cause)}${cause instanceof ApiError && cause.status === 409 ? ' Close and reopen the latest target before trying again.' : ''}`);}}
    finally {if (access.current())setBusy(false);}
  }
  if(access.accessDenied)return null;
  return <Modal title={row ? 'Edit job hours target' : 'Add job hours target'} onClose={close}><form className="schedule-planning-editor" onSubmit={save}>
    <p className="planning-help">A planning target for all employees assigned to this job. It does not set an employee’s allowed clock hours or replace staffing requirements. Weeks run Monday–Sunday.</p>
    {error && <p role="alert" className="form-error">{error}</p>}{pending && !busy && <p role="status" className="planning-callout">Retry the same save to confirm the result. The details remain locked.</p>}
    <fieldset disabled={busy || Boolean(pending)}><label>Job<select aria-label="Target job" required value={draft.jobId} onChange={e => update({jobId:e.target.value})}><option value="">Choose a job</option>{jobs.filter(job => job.active || job.id === draft.jobId).map(job => <option key={job.id} value={job.id}>{job.title} · {job.unitName}</option>)}</select></label>
      <div className="planning-form-grid"><label>Hours target<input aria-label="Target hours" required inputMode="decimal" pattern="(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?" value={draft.hours} onChange={e => update({hours:e.target.value})} placeholder="Enter hours"/></label><label>For each<select aria-label="Target period" value={draft.period} onChange={e => update({period:e.target.value as TargetDraft['period']})}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></label></div>
      <div className="planning-form-grid"><label>Effective from<input aria-label="Target first date" type="date" required value={draft.effectiveFrom} onChange={e => update({effectiveFrom:e.target.value})}/></label><label>Effective through (optional)<input aria-label="Target last date" type="date" value={draft.effectiveThrough ?? ''} onChange={e => update({effectiveThrough:e.target.value || null})}/></label></div>
      <p className="planning-help">Targets apply to full calendar periods; partial periods are labeled and are not prorated. Overlapping targets for the same job and period must be resolved before saving.</p>
      {row && <label className="planning-check"><input type="checkbox" checked={draft.active} onChange={e => update({active:e.target.checked})}/>Target active<span className="planning-help">Clear to archive while retaining its history.</span></label>}
      <label>Reason for this change<textarea aria-label="Target change reason" required minLength={3} maxLength={1000} rows={2} value={draft.reason} onChange={e => update({reason:e.target.value})}/></label>
    </fieldset><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy || Boolean(pending)} onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : pending ? 'Retry same save' : 'Save hours target'}</button></div>
  </form></Modal>;
}

export function PlanningHistoryDialog(props: PlanningAccess & { kind:'rules'|'targets'; id:string; title:string; zone:string; jobs:PlanningJob[]; onClose:()=>void }) {
  const [rows,setRows] = useState<PlanningHistory['rows']>([]), [error,setError] = useState(''), [loading,setLoading] = useState(true), [retry,setRetry] = useState(0);
  const access = usePlanningAccess(props), accessRef = useRef(access); accessRef.current = access;
  useEffect(() => {const controller = new AbortController();let active = true;setRows([]);setLoading(true);setError('');
    void api<PlanningHistory>(`/schedules/planning/${props.kind}/${props.id}/history`,undefined,'GET',controller.signal).then(value => {if(active && accessRef.current.current())setRows(value.rows);}).catch(cause => {if(active && accessRef.current.current() && !accessRef.current.reject(cause))setError(planningError(cause));}).finally(() => {if(active && accessRef.current.current())setLoading(false);});
    return () => {active = false;controller.abort();};
  },[props.kind,props.id,retry]);
  if(access.accessDenied)return null;
  return <Modal title={`${props.title} history`} onClose={props.onClose}><div className="schedule-planning-editor"><p className="planning-help">Earlier versions are retained. Changing a rule or target does not edit previously assigned employee shifts.</p>{loading && <p role="status">Loading history…</p>}{error && <><p role="alert" className="form-error">{error}</p><button className="button secondary" onClick={() => setRetry(value => value+1)}>Retry history</button></>}
    {rows.map(row => <article key={row.version} className="planning-history-row"><h3>Version {row.version} · {row.action.replaceAll('_',' ')}</h3><p>{row.actorName} · {planningTime(row.createdAt,props.zone)}</p><p>{row.reason}</p><details open={row.version === rows[0]?.version}><summary>Saved details</summary><HistorySnapshot snapshot={row.after} jobs={props.jobs}/></details>{Boolean(row.before) && <details><summary>Before this change</summary><HistorySnapshot snapshot={row.before} jobs={props.jobs}/></details>}</article>)}
    {!loading && !error && !rows.length && <p>No saved revisions are available.</p>}
  </div></Modal>;
}
function HistorySnapshot({snapshot,jobs}:{snapshot:unknown;jobs:PlanningJob[]}) {
  if(!snapshot || typeof snapshot !== 'object')return <p>No earlier configuration.</p>;
  const row = snapshot as Record<string,any>, job = jobs.find(value => value.id === row.jobId);
  return <dl className="planning-summary"><dt>Job</dt><dd>{job ? `${job.title} · ${job.unitName}` : 'Retained job'}</dd><dt>Status</dt><dd>{row.active ? 'Active' : 'Archived'}</dd>
    {row.label && <><dt>Rule</dt><dd>{row.label}</dd><dt>Repeat</dt><dd>Every {row.interval} {String(row.frequency)}{row.frequency === 'weekly' ? ` · ${(row.weekdays ?? []).map((day:number) => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][day-1]).join(', ')}` : ''}</dd><dt>Coverage window</dt><dd>{row.startsLocal}–{row.endsLocal}{row.endDayOffset ? ' next day' : ''} · {row.staffCount} people</dd></>}
    {row.hours !== undefined && <><dt>Hours target</dt><dd>{row.hours} h per {row.period}</dd></>}
    <dt>Effective dates</dt><dd>{planningDate(row.startDate ?? row.effectiveFrom)} – {(row.endDate ?? row.effectiveThrough) ? planningDate(row.endDate ?? row.effectiveThrough) : 'No end date'}</dd>
  </dl>;
}
