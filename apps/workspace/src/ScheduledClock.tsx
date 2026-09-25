import {useEffect,useRef,useState} from 'react';
import {AlarmClock,CalendarClock,Check,RefreshCw,X} from 'lucide-react';
import {api,ApiError} from './api';
import type {ClockPolicy,PreclockState} from '../shared/scheduled-clock';
import './scheduled-clock.css';

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
  return <section className="preclock-card" aria-label="Pending scheduled start"><CalendarClock size={24}/><div className="preclock-copy"><strong>Your time starts at {clockTime(pending.startsAt,preclock!.timezone)}</strong><p>Start work then. {pending.jobTitle} · {pending.unitName}</p><span>Your pending start is saved. You can close the app.</span></div><button type="button" className="button secondary small" disabled={busy||saving} onClick={()=>void cancel()}><X size={16}/>{saving?'Cancelling…':'Cancel start'}</button></section>;
}

export function EmployeeClockPolicy({userId,notify,onDirty}:{userId:string;notify:(message:string,error?:boolean)=>void;onDirty?:(dirty:boolean)=>void}){
  const [policy,setPolicy]=useState<ClockPolicy|null>(null),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const generation=useRef(0);
  useEffect(()=>{const ticket=++generation.current,controller=new AbortController();setPolicy(null);setError('');setBusy(false);void api<ClockPolicy>('/staff/'+userId+'/clock-policy',undefined,'GET',controller.signal).then(result=>{if(ticket===generation.current){setPolicy(result);setEnabled(result.noEarlyClockIn);}}).catch(e=>{if(!controller.signal.aborted&&ticket===generation.current)setError(e.message);});return()=>{++generation.current;controller.abort();};},[userId,reload]);
  useEffect(()=>{onDirty?.(!!policy&&enabled!==policy.noEarlyClockIn);return()=>onDirty?.(false);},[enabled,policy,onDirty]);
  const save=async()=>{
    if(!policy||busy)return;const ticket=generation.current;setBusy(true);setError('');
    try{const result=await api<ClockPolicy>('/staff/'+userId+'/clock-policy',{noEarlyClockIn:enabled,expectedVersion:policy.version},'PUT');if(ticket!==generation.current)return;setPolicy(result);setEnabled(result.noEarlyClockIn);notify('Employee clock setting saved.');}
    catch(e){if(ticket!==generation.current)return;setError((e as Error).message);if(e instanceof ApiError&&[401,403,404].includes(e.status))setPolicy(null);}
    finally{if(ticket===generation.current)setBusy(false);}
  };
  return <section className="employee-clock-policy" aria-label="Employee clock setting"><div className="preclock-setting-title"><AlarmClock size={21}/><div><strong>When work time can begin</strong><p>Choose this employee’s clock behavior.</p></div></div>{!policy&&!error?<p role="status">Loading clock setting…</p>:<><label className="preclock-setting-toggle"><input type="checkbox" checked={enabled} disabled={!policy||busy} onChange={e=>setEnabled(e.target.checked)}/><span><strong>No early clock-in</strong><span>Before today’s assigned shift, a tap saves a pending start. Time begins automatically at its scheduled start, even if the app is closed.</span></span></label><p className="preclock-setting-help">Default: off. When enabled, a matching assigned shift is required. Employees see “Start work then.” Changing this setting cancels any pending start; recorded hours stay unchanged.</p>{error&&<p className="error" role="alert">{error}</p>}<div className="preclock-setting-actions"><button type="button" className="button secondary small" disabled={busy} onClick={()=>{if(policy&&enabled!==policy.noEarlyClockIn&&!window.confirm('Discard the unsaved clock setting and reload the saved value?'))return;setReload(value=>value+1);}}><RefreshCw size={15}/>Reload saved setting</button><button type="button" className="button primary small" disabled={!policy||busy||enabled===policy.noEarlyClockIn} onClick={()=>void save()}><Check size={15}/>{busy?'Saving…':'Save clock setting'}</button></div></>}</section>;
}
