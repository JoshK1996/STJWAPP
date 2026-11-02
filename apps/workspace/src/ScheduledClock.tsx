import {useEffect,useRef,useState} from 'react';
import {AlarmClock,CalendarClock,X} from 'lucide-react';
import {api,ApiError} from './api';
import type {PreclockState} from '../shared/scheduled-clock';
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
  const byRule=pending.source==='rule',startsAt=clockTime(pending.startsAt,preclock!.timezone);
  return <section className="preclock-card" aria-label="Pending scheduled start"><CalendarClock size={24}/><div className="preclock-copy">{byRule?<strong>You will be clocked in automatically at {startsAt}</strong>:<strong>Your time starts at {startsAt}</strong>}<p>{byRule?'It is before your allowed start time. ':'Start work then. '}{pending.jobTitle} · {pending.unitName}</p><span>Your pending start is saved. You can close the app.</span></div><button type="button" className="button secondary small" disabled={busy||saving} onClick={()=>void cancel()}><X size={16}/>{saving?'Cancelling…':'Cancel start'}</button></section>;
}
