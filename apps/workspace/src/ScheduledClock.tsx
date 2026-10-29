import {useEffect,useRef,useState} from 'react';
import {AlarmClock,CalendarClock,Check,RefreshCw,X} from 'lucide-react';
import {api,ApiError} from './api';
import type {ClockPolicy,PreclockState} from '../shared/scheduled-clock';
import {clockRulesEqual,clockRulesSchema,normalizeClockRules,openRules,weekdayNames,type ClockDayRule,type ClockRules} from '../shared/clock-rules';
import './scheduled-clock.css';
import './clock-rules.css';

const clockTime=(value:string,timezone:string)=>new Intl.DateTimeFormat(undefined,{timeZone:timezone,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));
export function PendingClockCard({preclock,busy=false,onChanged,notify,onPendingChange}:{preclock?:PreclockState;busy?:boolean;onChanged:(clock:any)=>void;notify:(message:string,error?:boolean)=>void;onPendingChange?:(pending:boolean)=>void}){
  const [saving,setSaving]=useState(false),receipt=useRef<{id:string;commandId:string}|null>(null),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;onPendingChange?.(false);};},[]);
  const pending=preclock?.pending;
  if(!pending){
    if(preclock?.latest?.status!=='blocked')return null;
    return <div className="preclock-notice" role="status"><AlarmClock size={20}/><div><strong>Pending start needs attention</strong><p>{preclock.latest.reason}</p></div></div>;
  }
  const cancel=async()=>{
    if(!receipt.current||receipt.current.id!==pending.id)receipt.current={id:pending.id,commandId:crypto.randomUUID()};
    setSaving(true);onPendingChange?.(true);
    try{const result=await api('/clock/preclock/'+pending.id+'/cancel',{version:pending.version,commandId:receipt.current.commandId});if(!live.current)return;receipt.current=null;onChanged(result);notify('Pending start cancelled. No work time was added.');}
    catch(error){if(!live.current)return;notify((error as Error).message,true);if(error instanceof ApiError&&error.status===409)receipt.current=null;}
    finally{if(live.current){setSaving(false);onPendingChange?.(false);}}
  };
  const byRule=pending.source==='rule',startsAt=clockTime(pending.startsAt,preclock!.timezone);
  return <section className="preclock-card" aria-label="Pending scheduled start"><CalendarClock size={24}/><div className="preclock-copy">{byRule?<strong>You will be clocked in automatically at {startsAt}</strong>:<strong>Your time starts at {startsAt}</strong>}<p>{byRule?'It is before your allowed start time. ':'Start work then. '}{pending.jobTitle} · {pending.unitName}</p><span>Your pending start is saved. You can close the app.</span></div><button type="button" className="button secondary small" disabled={busy||saving} onClick={()=>void cancel()}><X size={16}/>{saving?'Cancelling…':'Cancel start'}</button></section>;
}

type RuleField='clockInEarliest'|'clockInLatest'|'clockOutEarliest'|'clockOutLatest';
const ruleFields:{field:RuleField;label:string}[]=[
  {field:'clockInEarliest',label:'Clock in from'},
  {field:'clockInLatest',label:'Clock in by'},
  {field:'clockOutEarliest',label:'Clock out from'},
  {field:'clockOutLatest',label:'Clock out by'},
];
export function EmployeeClockPolicy({userId,notify,onDirty}:{userId:string;notify:(message:string,error?:boolean)=>void;onDirty?:(dirty:boolean)=>void}){
  const [policy,setPolicy]=useState<ClockPolicy|null>(null),[enabled,setEnabled]=useState(false),[limited,setLimited]=useState(false),[draft,setDraft]=useState<ClockRules>(openRules()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const generation=useRef(0);
  const adopt=(result:ClockPolicy)=>{setPolicy(result);setEnabled(result.noEarlyClockIn);setLimited(!!result.rules);setDraft(result.rules??openRules());};
  useEffect(()=>{const ticket=++generation.current,controller=new AbortController();setPolicy(null);setError('');setBusy(false);void api<ClockPolicy>('/staff/'+userId+'/clock-policy',undefined,'GET',controller.signal).then(result=>{if(ticket===generation.current)adopt(result);}).catch(e=>{if(!controller.signal.aborted&&ticket===generation.current)setError(e.message);});return()=>{++generation.current;controller.abort();};},[userId,reload]);
  const effective=limited?normalizeClockRules(draft):null;
  const check=effective?clockRulesSchema.safeParse(effective):null;
  const problem=check&&!check.success?check.error.issues[0].message:'';
  const dirty=!!policy&&(enabled!==policy.noEarlyClockIn||!clockRulesEqual(effective,policy.rules));
  useEffect(()=>{onDirty?.(dirty);return()=>onDirty?.(false);},[dirty,onDirty]);
  const setDay=(index:number,patch:Partial<ClockDayRule>)=>setDraft(rules=>({days:rules.days.map((day,i)=>i===index?{...day,...patch}:day)}));
  const copyMonday=()=>setDraft(rules=>({days:rules.days.map((day,i)=>i>=1&&i<=4?{...rules.days[0]}:day)}));
  const save=async()=>{
    if(!policy||busy||problem)return;const ticket=generation.current;setBusy(true);setError('');
    try{const result=await api<ClockPolicy>('/staff/'+userId+'/clock-policy',{noEarlyClockIn:enabled,rules:effective,expectedVersion:policy.version},'PUT');if(ticket!==generation.current)return;adopt(result);notify('Employee clock setting saved.');}
    catch(e){if(ticket!==generation.current)return;setError((e as Error).message);if(e instanceof ApiError&&[401,403,404].includes(e.status))setPolicy(null);}
    finally{if(ticket===generation.current)setBusy(false);}
  };
  return <section className="employee-clock-policy" aria-label="Employee clock setting"><div className="preclock-setting-title"><AlarmClock size={21}/><div><strong>When work time can begin</strong><p>Choose this employee’s clock behavior.</p></div></div>{!policy&&!error?<p role="status">Loading clock setting…</p>:<>
    <label className="preclock-setting-toggle"><input type="checkbox" checked={enabled} disabled={!policy||busy} onChange={e=>setEnabled(e.target.checked)}/><span><strong>No early clock-in</strong><span>Before today’s assigned shift, a tap saves a pending start. Time begins automatically at its scheduled start, even if the app is closed.</span></span></label>
    <p className="preclock-setting-help">Default: off. When enabled, a matching assigned shift is required. Employees see “Start work then.”</p>
    <label className="preclock-setting-toggle"><input type="checkbox" checked={limited} disabled={!policy||busy} onChange={e=>setLimited(e.target.checked)}/><span><strong>Limit clock-in and clock-out times</strong><span>Set the days and times this employee can clock in or out. Leave a time blank for no limit.</span></span></label>
    {limited&&<div className="clock-rules" role="group" aria-label="Weekly clock rules">
      <p className="preclock-setting-help">Times are in the organization’s time zone. An employee who taps before their “from” time is told they will be clocked in automatically then. At “Clock out by”, an open shift is closed automatically at exactly that time. Manager time-card corrections are not limited by these rules.</p>
      {draft.days.map((day,index)=><fieldset key={index} className={'clock-rules-day'+(day.allowed?'':' is-off')} disabled={!policy||busy}>
        <legend>{weekdayNames[index]}</legend>
        <label className="clock-rules-allowed"><input type="checkbox" checked={day.allowed} onChange={e=>setDay(index,{allowed:e.target.checked})}/><span>Can work</span></label>
        {ruleFields.map(({field,label})=><label key={field} className="clock-rules-time"><span>{label}</span><input type="time" value={day[field]??''} disabled={!day.allowed} onChange={e=>setDay(index,{[field]:e.target.value||null} as Partial<ClockDayRule>)} aria-label={weekdayNames[index]+' '+label.toLowerCase()}/></label>)}
      </fieldset>)}
      <div className="clock-rules-tools"><button type="button" className="button secondary small" disabled={busy} onClick={copyMonday}>Copy Monday to Tuesday–Friday</button><button type="button" className="button secondary small" disabled={busy} onClick={()=>setDraft(openRules())}>Clear all limits</button></div>
    </div>}
    <p className="preclock-setting-help">Changing these settings cancels any pending start; recorded hours stay unchanged.</p>
    {(problem||error)&&<p className="error" role="alert">{problem||error}</p>}
    <div className="preclock-setting-actions"><button type="button" className="button secondary small" disabled={busy} onClick={()=>{if(dirty&&!window.confirm('Discard the unsaved clock setting and reload the saved value?'))return;setReload(value=>value+1);}}><RefreshCw size={15}/>Reload saved setting</button><button type="button" className="button primary small" disabled={!policy||busy||!dirty||!!problem} onClick={()=>void save()}><Check size={15}/>{busy?'Saving…':'Save clock setting'}</button></div></>}</section>;
}
