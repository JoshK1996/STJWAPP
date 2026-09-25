import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { planningApplyInput, type CoverageRule, type PlanningApplied, type PlanningPreview, type PlanningQuery, type PlanningSlot } from '../shared/staff-planning';
import { planningDate, planningError, planningOverlap, planningTime, staffHours, usePlanningAccess, type PlanningAccess } from './SchedulePlanningShared';

type Props = PlanningAccess & { query:PlanningQuery; rules:CoverageRule[]; onClose:()=>void; onDirty:(value:boolean)=>void; onBlocked:(value:boolean)=>void; onSaved:(count:number)=>Promise<void> };
export function PlanningAssignmentPreview(props:Props) {
  const [ruleIds,setRuleIds] = useState(props.rules.filter(row => row.active).map(row => row.id));
  const [preview,setPreview] = useState<PlanningPreview|null>(null), [choices,setChoices] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [reason,setReason] = useState('');
  const [pattern,setPattern] = useState(''), [person,setPerson] = useState(''), [feedback,setFeedback] = useState(''), [shown,setShown] = useState(40);
  const [review,setReview] = useState<ReturnType<typeof planningApplyInput.parse>|null>(null), [uncertain,setUncertain] = useState(false);
  const access = usePlanningAccess(props);
  const selected = Object.values(choices).filter(Boolean).length;
  const dirty = selected > 0 || Boolean(reason) || Boolean(review);
  useEffect(() => {props.onDirty(dirty || busy || uncertain);return () => props.onDirty(false);},[dirty,busy,uncertain,props.onDirty]);
  useEffect(() => {props.onBlocked(busy || uncertain);return () => props.onBlocked(false);},[busy,uncertain,props.onBlocked]);
  const close = () => {if (!busy && !uncertain && (!dirty || window.confirm('Discard these unsaved employee selections?')))props.onClose();};
  const slots = preview?.slots ?? [];
  const patternKey = (slot:PlanningSlot) => `${slot.ruleId}/${slot.position}`;
  const patterns = useMemo(() => Array.from(new Map(slots.map(slot => [patternKey(slot),{id:patternKey(slot),name:`${props.rules.find(rule => rule.id === slot.ruleId)?.label ?? 'Staffing rule'} · place ${slot.position}`}])).values()),[preview,props.rules]);
  const shownSlots = slots.filter(slot => !pattern || patternKey(slot) === pattern);
  const candidateIndex = useMemo(() => new Map((preview?.candidates??[]).map(candidate=>[candidate.id,{...candidate,unavailable:new Set(candidate.unavailableSlotIds),jobs:new Set(candidate.jobIds)}])),[preview]);
  const slotIndex = useMemo(() => new Map(slots.map(slot=>[slot.id,slot])),[preview]);
  const selectedIntervals = useMemo(()=>{const index = new Map<string,PlanningSlot[]>();for(const [id,userId] of Object.entries(choices)){const slot=slotIndex.get(id);if(userId&&slot)index.set(userId,[...(index.get(userId)??[]),slot]);}return index;},[choices,slotIndex]);
  function eligible(userId:string,slot:PlanningSlot,intervals=selectedIntervals) {
    const candidate=candidateIndex.get(userId);
    return Boolean(candidate?.jobs.has(slot.jobId) && !candidate.unavailable.has(slot.id) && !(intervals.get(userId)??[]).some(other=>other.id!==slot.id&&planningOverlap(other,slot)));
  }
  async function build() {
    if (busy || !access.current() || !ruleIds.length || uncertain) return;
    if (dirty && !window.confirm('Replace this preview and discard its employee selections?')) return;
    setBusy(true);setError('');setPreview(null);setChoices({});setReview(null);setReason('');setPattern('');setPerson('');setFeedback('');
    try {const result = await api<PlanningPreview>('/schedules/planning/preview',{query:props.query,ruleIds});if(access.current())setPreview(result);}
    catch(cause) {if(access.current() && !access.reject(cause))setError(planningError(cause));}
    finally {if(access.current())setBusy(false);}
  }
  function bulkFill() {
    if(!preview || !person || review)return;
    const next = {...choices}, intervals = new Map(selectedIntervals);intervals.set(person,[...(intervals.get(person)??[])]);let added = 0;
    for(const slot of shownSlots)if(!next[slot.id] && eligible(person,slot,intervals)){next[slot.id]=person;intervals.get(person)!.push(slot);added+=1;}
    setChoices(next);setFeedback(`${added} open ${added === 1 ? 'place filled' : 'places filled'} for ${preview.candidates.find(row => row.id === person)?.name}. Existing choices were kept; conflicting or unavailable places remain open.`);setError('');
  }
  function prepare(event:FormEvent) {
    event.preventDefault();if(!preview)return;
    const result=planningApplyInput.safeParse({sourceHash:preview.sourceHash,assignments:Object.entries(choices).filter(([,id])=>Boolean(id)).map(([slotId,userId])=>({slotId,userId})),commandId:crypto.randomUUID(),reason});
    if(!result.success){setError(result.error.issues[0]?.message ?? 'Choose employees and a reason.');return;}
    if(result.data.assignments.some(row => !eligible(row.userId,slotIndex.get(row.slotId)!))){setError('Some selected shifts overlap or are unavailable. Review the highlighted choices.');return;}
    setReview(result.data);setError('');
  }
  async function apply() {
    if(!preview || !review || busy || !access.current())return;
    setBusy(true);setError('');
    try {const result=await api<PlanningApplied>(`/schedules/planning/${preview.id}/apply`,review);if(!access.current())return;setUncertain(false);props.onDirty(false);await props.onSaved(result.appliedCount);if(access.current())props.onClose();}
    catch(cause){if(access.current() && !access.reject(cause)){setUncertain(!(cause instanceof ApiError) || cause.status >= 500);setError(`${planningError(cause)}${cause instanceof ApiError && cause.status === 409 ? ' Build a fresh preview before assigning these shifts.' : ''}`);}}
    finally {if(access.current())setBusy(false);}
  }
  if(access.accessDenied)return null;
  return <Modal title="Review and assign coverage" onClose={close}><div className="schedule-planning-preview">
    <p className="planning-help">{planningDate(props.query.start)}–{planningDate(props.query.end)}. Choose employees, then review before saving. Only selected shifts are assigned. Up to 1,000 places per preview.</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!preview && <><fieldset disabled={busy}><legend>Staffing rules to review</legend>{props.rules.filter(row=>row.active).map(row=><label key={row.id} className="planning-check"><input type="checkbox" checked={ruleIds.includes(row.id)} onChange={e=>setRuleIds(value=>e.target.checked?[...value,row.id]:value.filter(id=>id!==row.id))}/><span>{row.label}</span></label>)}</fieldset><p className="planning-help">Overlapping staffing rules and ambiguous daylight-saving times must be resolved before their openings can be assigned.</p><button className="button primary" disabled={busy || !ruleIds.length} onClick={()=>void build()}>{busy?'Building preview…':'Find open places'}</button></>}
    {preview && <>
      <div className="planning-preview-summary"><div><strong>{slots.length}</strong><span>Open places</span></div><div><strong>{selected}</strong><span>Chosen shifts</span></div><div><strong>{slots.length-selected}</strong><span>Still unassigned</span></div></div>
      <p className="planning-help">{preview.timezone} · Preview expires {planningTime(preview.expiresAt,preview.timezone)}.</p>
      <details className="planning-callout"><summary>How coverage is calculated</summary><p>{preview.notice}</p></details>
      {preview.warnings.length>0 && <details className="planning-callout"><summary>{preview.warnings.length} planning {preview.warnings.length===1?'notice':'notices'}</summary>{preview.warnings.map((warning,index)=><p key={index}>{planningDate(warning.date)} · {warning.message}</p>)}</details>}
      {!slots.length && <p role="status" className="planning-callout">No assignable openings were found. Review any notices and the coverage board.</p>}
      {review ? <>
        <h3>Confirm {review.assignments.length} employee shifts</h3><p className="planning-help">These become actual scheduled shifts and contribute to employee scheduled-hours allowances. Existing shifts remain unchanged. {slots.length-selected} places will stay unassigned.</p><p><strong>Reason:</strong> {review.reason}</p>
        <div className="planning-review-list">{review.assignments.slice(0,100).map(choice=>{const slot=slotIndex.get(choice.slotId)!;return <article key={choice.slotId}><strong>{preview.candidates.find(row=>row.id===choice.userId)?.name}</strong><span>{preview.jobs.find(job=>job.id===slot.jobId)?.title}</span><span>{planningTime(slot.startsAt,preview.timezone)}–{planningTime(slot.endsAt,preview.timezone)}</span></article>;})}</div>
        {review.assignments.length>100 && <p>The first 100 are shown here; all {review.assignments.length} explicit selections will be saved. Return to selections to inspect any date.</p>}
        {uncertain && <p role="status" className="planning-callout">The response was interrupted. Retry this exact action to recover the result safely. Do not create a second set of shifts.</p>}
        <div className="dialog-actions"><button className="button secondary" disabled={busy||uncertain} onClick={()=>{setReview(null);setError('');}}>Back to selections</button><button className="button primary" disabled={busy} onClick={()=>void apply()}>{busy?'Saving shifts…':uncertain?'Retry same assignment':`Assign ${review.assignments.length} shifts`}</button></div>
      </> : <form onSubmit={prepare}>
        <fieldset disabled={busy}>
          {slots.length>0 && <><div className="planning-bulk"><h3>Fill repeating places faster</h3><label>Recurring place<select aria-label="Recurring place" value={pattern} onChange={e=>{setPattern(e.target.value);setShown(40);setPerson('');setFeedback('');}}><option value="">All open places</option>{patterns.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>Employee to use<select aria-label="Employee for repeating places" value={person} onChange={e=>setPerson(e.target.value)}><option value="">Choose an employee</option>{preview.candidates.filter(candidate=>shownSlots.some(slot=>!choices[slot.id]&&eligible(candidate.id,slot))).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.name} · {staffHours(candidate.scheduledMicroseconds)} h already scheduled</option>)}</select></label>
          <button type="button" className="button secondary" disabled={!person} onClick={bulkFill}>Fill available places with this employee</button><p className="planning-help">Fills only blank, non-overlapping places in the selected pattern. It keeps your other choices. Choose another employee to fill additional places.</p>{feedback&&<p role="status">{feedback}</p>}</div>
          <div className="planning-slot-list">{shownSlots.slice(0,shown).map(slot=>{const job=preview.jobs.find(row=>row.id===slot.jobId), chosen=choices[slot.id]??'';return <article key={slot.id}><div><strong>{planningTime(slot.startsAt,preview.timezone)}–{planningTime(slot.endsAt,preview.timezone)}</strong><span>{job?.title} · {job?.unitName} · place {slot.position}</span></div><label>Employee<select aria-label={`Employee for ${planningTime(slot.startsAt,preview.timezone)}, ${job?.title}, place ${slot.position}`} value={chosen} onChange={e=>{setChoices(value=>({...value,[slot.id]:e.target.value}));setFeedback('');setError('');}}><option value="">Leave unassigned</option>{preview.candidates.filter(candidate=>candidate.id===chosen||eligible(candidate.id,slot)).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label></article>;})}</div>
          {shownSlots.length>shown && <button type="button" className="button secondary" onClick={()=>setShown(value=>value+100)}>Show more places ({shownSlots.length-shown} remaining)</button>}
          <label>Reason for assigning these shifts<textarea aria-label="Assignment reason" required minLength={3} maxLength={1000} rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label></>}
        </fieldset><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>void build()}>Build fresh preview</button><button className="button primary" disabled={busy||!selected}>Review {selected||''} selected shifts</button></div>
      </form>}
    </>}
  </div></Modal>;
}
