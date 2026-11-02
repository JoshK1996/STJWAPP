import {useEffect,useRef,useState} from 'react';
import {AlarmClock,ArrowRight,BriefcaseBusiness,CalendarDays,Check,Copy,Info,RefreshCw,ShieldCheck} from 'lucide-react';
import {api,ApiError} from './api';
import type {ClockPolicy} from '../shared/scheduled-clock';
import {clockRulesEqual,normalizeClockRules,openDay,weekdayNames,type ClockDayRule,type ClockRules} from '../shared/clock-rules';
import {copyDayRule,dayRuleProblem,dayRuleSummary,displayRuleTime,weekdayRules} from '../shared/clock-rule-editor';
import './clock-rules.css';

type Job={id:string;title:string;unit_name?:string};
type Props={userId:string;employeeName:string;timezone:string;jobs:Job[];notify:(message:string,error?:boolean)=>void;onDirty?:(dirty:boolean)=>void};
const timeFields=[
  {field:'clockInEarliest',label:'Earliest start',help:'An early tap saves a start for this time.'},
  {field:'clockInLatest',label:'Last clock-in',help:'New clock-ins are blocked after this time.'},
  {field:'clockOutEarliest',label:'Earliest clock-out',help:'Ask a manager to record an earlier departure.'},
  {field:'clockOutLatest',label:'Automatic clock-out',help:'An open shift ends at exactly this time.'},
] as const;

export function EmployeeClockPolicy({userId,employeeName,timezone,jobs,notify,onDirty}:Props){
  const [policy,setPolicy]=useState<ClockPolicy|null>(null),[scheduled,setScheduled]=useState(false),[limited,setLimited]=useState(false),[draft,setDraft]=useState<ClockRules>(weekdayRules),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[reload,setReload]=useState(0),[selected,setSelected]=useState(0),[copying,setCopying]=useState(false),[targets,setTargets]=useState<number[]>([]);
  const generation=useRef(0);
  const adopt=(result:ClockPolicy)=>{setPolicy(result);setScheduled(result.noEarlyClockIn);setLimited(!!result.rules);setDraft(result.rules??weekdayRules());setConflict(false);setCopying(false);};
  useEffect(()=>{const ticket=++generation.current,controller=new AbortController();setPolicy(null);setError('');setBusy(false);void api<ClockPolicy>('/staff/'+userId+'/clock-policy',undefined,'GET',controller.signal).then(result=>{if(ticket===generation.current)adopt(result);}).catch(e=>{if(!controller.signal.aborted&&ticket===generation.current)setError(e.message);});return()=>{++generation.current;controller.abort();};},[userId,reload]);
  const effective=limited?normalizeClockRules(draft):null;
  const problems=limited?draft.days.map(dayRuleProblem).filter(Boolean):[];
  const dirty=!!policy&&(scheduled!==policy.noEarlyClockIn||!clockRulesEqual(effective,policy.rules));
  useEffect(()=>{onDirty?.(dirty);return()=>onDirty?.(false);},[dirty,onDirty]);
  const day=draft.days[selected],name=weekdayNames[selected];
  const edit=(patch:Partial<ClockDayRule>)=>setDraft(rules=>({days:rules.days.map((value,index)=>index===selected?{...value,...patch}:value)}));
  const reloadSaved=()=>{if(dirty&&!window.confirm('Discard your unsaved clock rules and load the saved version?'))return;setReload(value=>value+1);};
  const save=async()=>{
    if(!policy||busy||conflict||problems.length)return;
    const ticket=generation.current;setBusy(true);setError('');
    try{const result=await api<ClockPolicy>('/staff/'+userId+'/clock-policy',{noEarlyClockIn:scheduled,rules:effective,expectedVersion:policy.version},'PUT');if(ticket!==generation.current)return;adopt(result);notify('Clock rules saved for '+employeeName+'.');}
    catch(e){if(ticket!==generation.current)return;setError((e as Error).message);if(e instanceof ApiError){if(e.status===409)setConflict(true);if([401,403,404].includes(e.status))setPolicy(null);}}
    finally{if(ticket===generation.current)setBusy(false);}
  };
  return <section className="clock-policy-studio" aria-label="Employee clock rules" aria-busy={busy}>
    <header className="rule-hero"><span className="rule-hero-icon"><CalendarDays size={28}/></span><div><span className="rule-eyebrow">EMPLOYEE TIME CLOCK</span><h3>A clear plan for every workday</h3><p>Choose when {employeeName} can start, finish and work each job.</p></div><span className={'rule-status'+(dirty?' is-dirty':'')}>{dirty?'Unsaved changes':policy?'Saved settings':'Loading'}</span></header>
    {!policy?<div className="rule-load" role={error?'alert':'status'}>{error||'Loading saved clock rules…'}{error&&<button type="button" className="button secondary" onClick={reloadSaved}><RefreshCw size={16}/>Try again</button>}</div>:<>
      <fieldset className="rule-mode" disabled={busy}><legend><span className="rule-step">1</span> Choose how clocking works</legend><div className="rule-mode-options">
        <label className={!limited?'is-selected':''}><input type="radio" name={'clock-mode-'+userId} checked={!limited} onChange={()=>setLimited(false)}/><span><strong>Flexible days & times</strong><small>Any day and time, using assigned jobs.</small></span></label>
        <label className={limited?'is-selected':''}><input type="radio" name={'clock-mode-'+userId} checked={limited} onChange={()=>setLimited(true)}/><span><strong>Set a weekly plan</strong><small>Choose allowed days, time limits and jobs.</small></span></label>
      </div></fieldset>
      {limited&&<div className="rule-week-section"><div className="rule-section-heading"><h4><span className="rule-step">2</span> Build the week</h4><p>Choose a day to edit. Blank times mean no limit.</p></div>
        <div className="rule-week" role="group" aria-label="Choose a weekday">{draft.days.map((value,index)=><button type="button" key={index} disabled={busy} className={'rule-week-day'+(selected===index?' is-selected':'')+(!value.allowed?' is-closed':'')} aria-pressed={selected===index} aria-label={weekdayNames[index]+': '+dayRuleSummary(value)} onClick={()=>{setSelected(index);setCopying(false);}}><strong>{weekdayNames[index].slice(0,3)}</strong><span className="rule-day-dot"/ ><small>{value.allowed?'Allowed':'Blocked'}</small>{!!dayRuleProblem(value,index)&&<span className="rule-day-error">Check times</span>}</button>)}</div>
        <div className="rule-workbench"><fieldset className="rule-day-editor" disabled={busy}><legend>{name}</legend>
          <label className="rule-allow"><input type="checkbox" checked={day.allowed} onChange={e=>edit({allowed:e.target.checked})}/><span><strong>Allow clock-in on {name}</strong><small>{day.allowed?'Set time limits below, or leave them blank.':'No new shift can start. An existing shift can still end.'}</small></span></label>
          {day.allowed&&<><div className="rule-time-grid">{timeFields.map(({field,label,help},index)=><label className="rule-time-field" key={field}><span className="rule-time-label"><AlarmClock size={16}/>{label}</span><input type="time" value={day[field]??''} aria-label={name+' '+label.toLowerCase()} aria-invalid={!!dayRuleProblem(day,selected)} onChange={e=>edit({[field]:e.target.value||null})}/><small>{help}</small>{index===3&&day[field]&&<span className="rule-auto-badge">Automatic at {displayRuleTime(day[field])}</span>}</label>)}</div>
          <fieldset className="rule-job-picker"><legend><BriefcaseBusiness size={17}/> Jobs allowed on {name}</legend><label><input type="radio" name={'rule-jobs-'+userId} checked={!day.jobIds} onChange={()=>edit({jobIds:null})}/><span>All assigned jobs <small>Includes jobs assigned later.</small></span></label><label><input type="radio" name={'rule-jobs-'+userId} checked={!!day.jobIds} disabled={!jobs.length} onChange={()=>edit({jobIds:jobs.map(job=>job.id)})}/><span>Choose specific jobs</span></label>
            {day.jobIds&&<div className="rule-job-options">{jobs.map(job=><label key={job.id}><input type="checkbox" checked={day.jobIds!.includes(job.id)} onChange={e=>edit({jobIds:e.target.checked?[...day.jobIds!,job.id]:day.jobIds!.filter(id=>id!==job.id)})}/><span><strong>{job.title}</strong>{job.unit_name&&<small>{job.unit_name}</small>}</span></label>)}{day.jobIds.some(id=>!jobs.some(job=>job.id===id))&&<p className="error">A selected job is no longer available. Choose the current jobs before saving.</p>}</div>}
            {!jobs.length&&<p>No active jobs are assigned. Use Manage jobs on the employee card to assign jobs first.</p>}
          </fieldset></>}
          <div className="rule-day-tools"><button type="button" className="button secondary small" onClick={()=>{setCopying(!copying);setTargets([]);}}><Copy size={16}/>Copy {name} to…</button><button type="button" className="text-link" onClick={()=>edit({...openDay(),jobIds:null})}>Clear this day’s limits</button></div>
          {copying&&<div className="rule-copy"><strong>Replace these days with {name}’s settings</strong><p>Copies allowed/blocked status, all times and job choices.</p><div>{weekdayNames.map((target,index)=>index!==selected&&<label key={target}><input type="checkbox" checked={targets.includes(index)} onChange={e=>setTargets(current=>e.target.checked?[...current,index]:current.filter(value=>value!==index))}/>{target}</label>)}</div><button type="button" className="text-link" onClick={()=>setTargets([0,1,2,3,4].filter(index=>index!==selected))}>Select other weekdays</button><button type="button" className="button secondary small" disabled={!targets.length} onClick={()=>{setDraft(rules=>copyDayRule(rules,selected,targets));setCopying(false);}}>Apply to {targets.length} {targets.length===1?'day':'days'}<ArrowRight size={16}/></button></div>}
        </fieldset>
        <aside className="rule-preview" aria-label="Weekly plan preview"><span className="rule-eyebrow">PLAN PREVIEW</span><h4>The employee’s week</h4><p className="rule-zone">All times: {timezone.replaceAll('_',' ')}</p><ol>{draft.days.map((value,index)=><li key={index} className={!value.allowed?'is-closed':''}><strong>{weekdayNames[index].slice(0,3)}</strong><div><span>{dayRuleSummary(value)}</span>{value.allowed&&<small>{value.jobIds?value.jobIds.map(id=>jobs.find(job=>job.id===id)?.title??'Unavailable job').join(', ')||'Choose at least one job':'Every assigned job'}</small>}{value.allowed&&value.clockInLatest&&<small>Last clock-in {displayRuleTime(value.clockInLatest)}</small>}{value.allowed&&value.clockOutEarliest&&<small>Clock-out from {displayRuleTime(value.clockOutEarliest)}</small>}</div></li>)}</ol><div className="rule-info"><Info size={18}/><p>Early taps save a pending start. Automatic clock-out ends an open shift at the set time. Overnight time windows are not supported.</p></div></aside></div>
      </div>}
      <details className="rule-schedule-option" open={scheduled||undefined}><summary><CalendarDays size={18}/>Also require an assigned shift {scheduled&&<span className="rule-chip">On</span>}</summary><label className="rule-allow"><input type="checkbox" checked={scheduled} disabled={busy} onChange={e=>setScheduled(e.target.checked)}/><span><strong>Require a matching shift in Schedule</strong><small>Only jobs with a saved shift can start. An early tap waits for its scheduled start{limited?' and the weekly plan’s earliest start':''}. {limited?'The weekly plan still limits days, jobs and times.':''}</small></span></label></details>
      <div className="rule-save-area"><div className="rule-info"><ShieldCheck size={19}/><p>Saving cancels a pending start. Recorded hours stay unchanged. Managers can correct time cards with an audit history.</p></div>
        {(problems.length>0||error)&&<div className="rule-errors" role="alert">{error&&<p>{error}</p>}{problems.map(problem=><p key={problem}>{problem}</p>)}{conflict&&<p>Your draft is preserved. Reload saved rules to review the newer version before saving.</p>}</div>}
        {!limited&&<p className="rule-save-note">{policy.rules?'Saving will remove this employee’s weekly restrictions.':'Clocking is allowed any day and time, using assigned jobs.'}{scheduled?' A matching assigned shift is still required.':''}</p>}
        {limited&&!effective&&<p className="rule-save-note">All days, times and assigned jobs are open. This saves as flexible clocking.</p>}
        <div className="rule-save-actions"><button type="button" className="button secondary" disabled={busy} onClick={reloadSaved}><RefreshCw size={16}/>Reload saved rules</button><button type="button" className="button primary" disabled={busy||!dirty||!!problems.length||conflict} onClick={()=>void save()}><Check size={18}/>{busy?'Saving…':'Save clock rules'}</button></div>
      </div>
    </>}
  </section>;
}
