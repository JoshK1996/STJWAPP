import {useEffect,useRef,useState,type FormEvent} from 'react';
import {BellRing,Check,RefreshCw,ShieldCheck,Users} from 'lucide-react';
import {api,ApiError} from './api';
import {Panel} from './components';
import {attentionPolicyInput,attentionPolicyResponseSchema,attentionPolicySaveResponseSchema,defaultAttentionRules,type AttentionPolicy,type AttentionRules} from '../shared/attention-policy';
import './attention-settings.css';

type RuleKey=keyof AttentionRules;
type Draft=Record<RuleKey,{enabled:boolean;afterMinutes:string}>;
const toDraft=(rules:AttentionRules):Draft=>({overSchedule:{...rules.overSchedule,afterMinutes:String(rules.overSchedule.afterMinutes)},outsideSchedule:{...rules.outsideSchedule,afterMinutes:String(rules.outsideSchedule.afterMinutes)}});
const definitions=[{key:'overSchedule',title:'Hours over the daily schedule',description:'Flag an employee when their total worked hours exceed all of their scheduled hours that day.',example:'With an 8-hour schedule'},{key:'outsideSchedule',title:'Work outside scheduled times',description:'Flag work before or after a matching scheduled shift, or work in a job with no matching shift.',example:'With a 9 AM–5 PM shift'}] as const;
export default function AttentionSettings({me,notify,onDirty,isSessionCurrent,onSessionExpired,onChanged}:{
 me:any;notify:(message:string,error?:boolean)=>void;onDirty?:(value:boolean)=>void;isSessionCurrent?:()=>boolean;onSessionExpired?:()=>void;onChanged?:(policy:AttentionPolicy)=>void;
}){
 const [base,setBase]=useState<AttentionPolicy|null>(null),[draft,setDraft]=useState<Draft|null>(null),[canEdit,setCanEdit]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[pending,setPending]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),running=useRef(false),generation=useRef(0),attempt=useRef<ReturnType<typeof attentionPolicyInput.parse>|null>(null);
 const identity=me.actor.org_id+':'+me.actor.id+':'+me.actor.role+':'+me.actor.mode;
 const current=(run:number)=>alive.current&&generation.current===run&&(isSessionCurrent?.()??true);
 const dirty=Boolean(base&&draft&&JSON.stringify(toDraft(base.rules))!==JSON.stringify(draft))||pending||busy;
 useEffect(()=>{onDirty?.(dirty);return()=>onDirty?.(false);},[dirty,onDirty]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 function deny(problem:unknown){if(problem instanceof ApiError&&[401,403].includes(problem.status)){generation.current++;setBase(null);setDraft(null);setCanEdit(false);setPending(false);attempt.current=null;setLoading(false);setError(problem.message);if(problem.status===401)onSessionExpired?.();return true;}return false;}
 async function load(){
  if(running.current)return;const run=++generation.current;running.current=true;setLoading(true);setError('');
  try{const result=attentionPolicyResponseSchema.parse(await api('/workforce/attention-policy'));if(!current(run))return;setBase(result.policy);setDraft(toDraft(result.policy.rules));setCanEdit(result.canEdit);setConflict(false);setPending(false);attempt.current=null;}
  catch(problem){if(current(run)&&!deny(problem))setError(problem instanceof Error?problem.message:'Shared rules could not be loaded.');}
  finally{running.current=false;if(alive.current)setLoading(false);}
 }
 useEffect(()=>{generation.current++;setBase(null);setDraft(null);setCanEdit(false);setPending(false);attempt.current=null;void load();},[identity]);
 function change(key:RuleKey,patch:Partial<Draft[RuleKey]>){if(busy||pending||!canEdit)return;setDraft(value=>value?{...value,[key]:{...value[key],...patch}}:value);setNotice('');}
 async function save(event:FormEvent){
  event.preventDefault();if(running.current||!base||!draft||!canEdit||conflict)return;
  if(!attempt.current){const rawRules=Object.fromEntries(definitions.map(({key})=>[key,{enabled:draft[key].enabled,afterMinutes:draft[key].afterMinutes.trim()===''?NaN:Number(draft[key].afterMinutes)}]));const parsed=attentionPolicyInput.safeParse({expectedVersion:base.version,commandId:crypto.randomUUID(),rules:rawRules});if(!parsed.success){setError('Choose a whole number of minutes from 0 to 1,440 for each rule.');return;}attempt.current=parsed.data;}
  const run=generation.current;running.current=true;setBusy(true);setPending(true);setError('');setNotice('');
  try{const result=attentionPolicySaveResponseSchema.parse(await api('/workforce/attention-policy',attempt.current,'PUT'));if(!current(run))return;setBase(result.policy);setDraft(toDraft(result.policy.rules));setCanEdit(result.canEdit);setPending(false);attempt.current=null;setNotice('Shared flag rules saved for everyone. Recorded hours have not changed.');notify('Shared flag rules saved.');onChanged?.(result.policy);}
  catch(problem){if(!current(run))return;if(deny(problem))return;if(problem instanceof ApiError&&problem.status<500&&![408,429].includes(problem.status)){setPending(false);attempt.current=null;setConflict(problem.status===409);setError(problem.message);}else setError('The save could not be confirmed. Retry the same save to safely check its result.');}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 return <Panel title="Shared flag rules" detail="Administrators choose what needs attention. These rules apply to everyone in this organization.">
  <div className="attention-settings">
   <div className="attention-intro"><span className="attention-intro-icon"><BellRing size={24}/></span><div><strong>Highlight what matters to your team</strong><p>Choose the exceptions you want to see, and how many minutes to allow before they are flagged.</p></div></div>
   {loading&&<p role="status">Loading shared rules…</p>}
   {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="attention-success" role="status"><Check size={18}/>{notice}</p>}
   {base&&draft&&<form onSubmit={save}>
    {!canEdit&&<p className="panel-note">You can view these rules. An administrator, owner or developer can change them.</p>}
    <div className="attention-rule-grid">{definitions.map(definition=>{const rule=draft[definition.key],minutes=Number(rule.afterMinutes),valid=rule.afterMinutes.trim()!==''&&Number.isInteger(minutes)&&minutes>=0&&minutes<=1440;return <section className={'attention-rule '+(rule.enabled?'is-on':'is-off')} key={definition.key}>
     <label className="attention-rule-toggle"><input type="checkbox" checked={rule.enabled} disabled={!canEdit||busy||pending||loading||conflict} onChange={event=>change(definition.key,{enabled:event.target.checked})}/><span><strong>{definition.title}</strong><small>{rule.enabled?'Flag enabled':'Flag off'}</small></span></label>
     <p>{definition.description}</p>
     <label className="attention-threshold">Flag after more than<div><input aria-label={definition.title+' allowance in minutes'} type="number" inputMode="numeric" min="0" max="1440" step="1" required value={rule.afterMinutes} disabled={!canEdit||!rule.enabled||busy||pending||loading||conflict} onChange={event=>change(definition.key,{afterMinutes:event.target.value})}/><span>minutes</span></div></label>
     <p className="attention-example"><strong>Example</strong>{!rule.enabled?'This exception stays in the detailed totals without an attention highlight.':!valid?'Enter whole minutes to see an example.':definition.key==='overSchedule'?`${definition.example}, ${minutes===0?'any extra work':`up to ${minutes} extra minutes`} ${minutes===0?'is flagged.':`is allowed before a flag appears. More than ${minutes} extra minutes is flagged.`}`:`${definition.example}, ${minutes===0?'any work outside that job’s scheduled time is flagged.':`more than ${minutes} minutes worked outside that job’s scheduled time during the day is flagged.`}`}</p>
    </section>;})}</div>
    <p className="attention-scope"><Users size={17}/>Each employee is checked per calendar day in your organization’s time zone. A shorter day does not erase an earlier flag.</p>
    <p className="attention-boundary"><ShieldCheck size={18}/>These settings only change attention highlights. They do not change time cards, schedules, pay, access permissions or overlap checks.</p>
    <p className="attention-saved">{base.updatedAt?`Last saved by ${base.updatedByName??'an administrator'} · ${new Date(base.updatedAt).toLocaleString()}`:'Current defaults: both flags are on, with no extra minutes allowed.'}</p>
    {canEdit&&<div className="attention-actions"><button type="button" className="button secondary" disabled={busy||pending||loading||conflict} onClick={()=>{setDraft(toDraft(defaultAttentionRules));setNotice('');}}>Use defaults</button><button type="button" className="button secondary" disabled={busy||pending||loading} onClick={()=>{if(!dirty||window.confirm('Discard your unsaved changes and load the current shared rules?'))void load();}}><RefreshCw size={16}/>{conflict?'Load current rules':'Reset changes'}</button><button type="submit" className="button primary" disabled={busy||loading||conflict||(!dirty&&!pending)}>{busy?'Saving…':pending?'Retry same save':'Save shared rules'}</button></div>}
   </form>}
   {!base&&!loading&&<button type="button" className="button secondary" onClick={()=>void load()}><RefreshCw size={16}/>Load shared rules</button>}
  </div>
 </Panel>;
}
