import { useEffect,useRef,useState } from 'react';
import { ArrowRight,ArrowRightLeft,BriefcaseBusiness,Check,Clock3,Coffee,LogOut,Play,ShieldCheck } from 'lucide-react';
import { api,ApiError } from './api';
import { Badge } from './components';
import './clock-experience.css';
type ClockAction='clock_in'|'clock_out'|'switch_job'|'start_break'|'end_break';
type ClockAttempt={body:Readonly<{action:ClockAction;jobId?:string;commandId:string}>;label:string;uncertain:boolean;confirmed:boolean};
type ClockPhase='ready'|'sending'|'uncertain'|'refreshing'|'refresh-needed';
const actionLabels:Record<ClockAction,string>={clock_in:'Clock in',clock_out:'Clock out',switch_job:'Switch job',start_break:'Start break',end_break:'End break'};
const successMessages:Record<ClockAction,string>={clock_in:'You’re clocked in. Have a good day!',clock_out:'You’re clocked out. Your time is saved.',switch_job:'Your job has been changed.',start_break:'Your break has started.',end_break:'Welcome back. Your break is recorded.'};
export default function ClockCard({state,onChange,notify,onSessionExpired,onPendingChange,large=false}:{state:any;onChange:()=>Promise<void>;notify:(s:string,error?:boolean)=>void;onSessionExpired:()=>void;onPendingChange:(pending:boolean)=>void;large?:boolean}) {
  const [job,setJob]=useState(''),[now,setNow]=useState(Date.now());
  const [phase,setPhase]=useState<ClockPhase>('ready'),[problem,setProblem]=useState(''),[pendingLabel,setPendingLabel]=useState('');
  const attemptRef=useRef<ClockAttempt|null>(null),busyRef=useRef(false),mounted=useRef(true),cardRef=useRef<HTMLElement>(null),recoveryRef=useRef<HTMLButtonElement>(null),hadRecovery=useRef(false);
  const locked=phase!=='ready',busy=phase==='sending'||phase==='refreshing';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(!locked&&state?.jobs?.length)setJob(state.shift?.job_id??state.jobs[0].id);},[state?.shift?.job_id,state?.jobs?.length,locked]);
  useEffect(()=>{
    const active=document.activeElement;
    if(phase==='uncertain'||phase==='refresh-needed'){
      hadRecovery.current=true;
      if(active===document.body||cardRef.current?.contains(active))recoveryRef.current?.focus();
    }else if(phase==='ready'&&hadRecovery.current){
      hadRecovery.current=false;
      if(active===document.body)cardRef.current?.querySelector<HTMLButtonElement>('.clock-actions button:not(:disabled)')?.focus();
    }
  },[phase]);
  function release(){attemptRef.current=null;setPhase('ready');setProblem('');setPendingLabel('');onPendingChange(false);}
  function expired(){attemptRef.current=null;onPendingChange(false);onSessionExpired();}
  async function refreshSaved(attempt:ClockAttempt){
    setPhase('refreshing');setProblem('');
    try{
      await onChange();
      if(!mounted.current||attemptRef.current!==attempt)return;
      release();notify(successMessages[attempt.body.action]);
    }catch(error){
      if(!mounted.current||attemptRef.current!==attempt)return;
      if(error instanceof ApiError&&error.status===401){expired();return;}
      setPhase('refresh-needed');setProblem(error instanceof ApiError?error.message:'The workspace could not refresh. Please try refreshing again.');
    }
  }
  async function send(attempt:ClockAttempt){
    if(busyRef.current)return;
    busyRef.current=true;setPhase('sending');setProblem('');
    try{
      await api('/clock',attempt.body);
      if(!mounted.current||attemptRef.current!==attempt)return;
      attempt.confirmed=true;
      await refreshSaved(attempt);
    }catch(error){
      if(!mounted.current||attemptRef.current!==attempt)return;
      if(error instanceof ApiError&&error.status===401){expired();return;}
      if(error instanceof ApiError&&error.status>=400&&error.status<500&&!attempt.uncertain){release();notify(error.message,true);return;}
      attempt.uncertain=true;setPhase('uncertain');setProblem(error instanceof ApiError?error.message:'The connection or server response was interrupted. Retry this request to confirm its result.');
    }finally{busyRef.current=false;}
  }
  function command(action:ClockAction){
    if(busyRef.current||attemptRef.current)return;
    const selectedJob=state.jobs.find((candidate:any)=>candidate.id===job);
    const attempt:ClockAttempt={body:Object.freeze({action,...(['clock_in','switch_job'].includes(action)?{jobId:job}:{}),commandId:crypto.randomUUID()}),label:actionLabels[action]+(['clock_in','switch_job'].includes(action)&&selectedJob?' · '+selectedJob.title:''),uncertain:false,confirmed:false};
    attemptRef.current=attempt;setPendingLabel(attempt.label);onPendingChange(true);void send(attempt);
  }
  async function recover(){
    const attempt=attemptRef.current;if(!attempt||busyRef.current)return;
    if(!attempt.confirmed){await send(attempt);return;}
    busyRef.current=true;try{await refreshSaved(attempt);}finally{busyRef.current=false;}
  }
  if(!state)return <div className="clock-card clock-experience clock-loading" role="status"><Clock3 size={32}/>Getting your clock ready…</div>;
  const shift=state.shift,onBreak=shift?.kind==='break';
  const elapsed=shift?Math.max(0,Math.floor((now-new Date(shift.started_at).getTime())/1000)):0;
  const time=[Math.floor(elapsed/3600),Math.floor(elapsed%3600/60),elapsed%60].map(x=>String(x).padStart(2,'0')).join(':');
  const selected=state.jobs.find((candidate:any)=>candidate.id===job);
  const currentMinutes=shift?Math.max(0,Math.floor((now-Date.parse(shift.segment_started_at))/60000)):0;
  const segmentTime=currentMinutes<1?'Just started':currentMinutes<60?currentMinutes+' min so far':Math.floor(currentMinutes/60)+' h '+currentMinutes%60+' min so far';
  const status=locked?(phase==='uncertain'?'Confirmation needed':attemptRef.current?.confirmed?'Saved · refresh pending':'Saving…'):shift?onBreak?'On a break':'On the clock':'Clocked out';
  return <section ref={cardRef} className={'clock-card clock-experience '+(large?'large ':'')+(shift?'is-active':'is-ready')+(onBreak?' is-break':'')} aria-label="My time clock">
    <div className="clock-orbit" aria-hidden="true"/><div className="clock-orbit clock-orbit-two" aria-hidden="true"/>
    <header className="clock-experience-header"><span className="clock-eyebrow"><Clock3 size={17}/> YOUR WORKDAY</span><Badge tone="clock-state"><span className={shift&&!locked?'clock-status-dot':''}/>{status}</Badge></header>
    <div className="clock-quick-summary">
      <div className="clock-current-job"><span className="clock-current-icon">{onBreak?<Coffee size={23}/>:<BriefcaseBusiness size={23}/>}</span><div><small>{shift?onBreak?'Returning to':'Working as':'Selected job'}</small><strong>{shift?shift.job_title:selected?.title??'Choose an assigned job'}</strong><span>{shift?shift.unit_name:selected?.unit_name??'Your manager assigns jobs to your account.'}</span></div>{shift&&<Check size={18} aria-label="Current recorded job"/>}</div>
      <div className="clock-elapsed"><span>{shift?'Elapsed shift':'Ready to begin'}</span><strong aria-label={shift?'Elapsed shift '+time:'Not clocked in'}>{shift?time:'00:00:00'}</strong><small>{shift?'Includes breaks':'Choose your job below'}</small></div>
    </div>

    <div className="clock-control-deck"><label className="clock-job">{shift?'Change job':'I’m working as'}<select aria-label="Clock job" value={job} onChange={e=>setJob(e.target.value)} disabled={locked||onBreak}>{!state.jobs.length&&<option value="">No assigned jobs</option>}{state.jobs.map((j:any)=><option key={j.id} value={j.id}>{j.title} · {j.unit_name}</option>)}</select>{shift&&job!==shift.job_id&&!onBreak&&<small className="clock-next-job">Selected: <strong>{selected?.title}</strong>{selected?.unit_name&&<> · {selected.unit_name}</>}</small>}{onBreak&&<small>End your break to change jobs.</small>}</label><div className="clock-actions">{!shift?<button className="button clock-start" onClick={()=>command('clock_in')} disabled={locked||!job}><Play size={21} fill="currentColor"/>Clock in<ArrowRight size={20}/></button>:<><button className="button clock-finish" onClick={()=>command('clock_out')} disabled={locked}><LogOut size={19}/>Clock out</button><button className={'button '+(onBreak?'clock-resume':'clock-pause')} onClick={()=>command(onBreak?'end_break':'start_break')} disabled={locked}>{onBreak?<Play size={19}/>:<Coffee size={19}/>} {onBreak?'End break':'Take a break'}</button>{job!==shift.job_id&&!onBreak&&<button className="button clock-switch" onClick={()=>command('switch_job')} disabled={locked||!job}><ArrowRightLeft size={18}/>Switch job</button>}</>}</div></div>

    {locked&&<div className="clock-recovery" role={phase==='uncertain'?'alert':'status'} aria-atomic="true"><strong>{pendingLabel}</strong><p>{phase==='sending'?'Sending this clock request. Please wait before taking another action.':phase==='uncertain'?'We could not confirm whether this clock request saved. Retry sends the same request; it does not create a new action.':phase==='refreshing'?'Your clock request was saved. Refreshing your workspace…':'Your clock request was saved. Your workspace has not refreshed; refresh before taking another action.'}</p>{problem&&<p>{problem}</p>}{(phase==='uncertain'||phase==='refresh-needed')&&<button ref={recoveryRef} type="button" className="button clock-start" onClick={()=>void recover()} disabled={busy}>{phase==='uncertain'?'Retry clock request':'Refresh clock status'}</button>}</div>}
    <div className="clock-stage">
      <div className="clock-copy"><span className="clock-kicker">{shift?onBreak?'A moment to recharge':'You’re right on time':'Let’s get started'}</span><h2>{shift?onBreak?'Enjoy your break.':'You’re clocked in.':'Your day. Your time.'}</h2><p>{shift?onBreak?'Your break is being recorded. Pick up where you left off when you’re ready.':'Your time is being recorded. Change jobs or take a break without ending your shift.':'Choose the job you’re doing, then tap Clock in. We’ll take it from there.'}</p>
      </div>
      <div className="clock-sculpture" aria-hidden="true"><div className="clock-dial-shadow" aria-hidden="true"/><div className="clock-dial">
        <svg viewBox="0 0 300 300" className="clock-dial-face" aria-hidden="true"><circle cx="150" cy="150" r="139" fill="none" stroke="currentColor" strokeWidth="1" opacity=".24"/>{Array.from({length:60},(_,i)=><line key={i} x1="150" y1={i%5===0?"23":"27"} x2="150" y2={i%5===0?"38":"32"} transform={'rotate('+i*6+' 150 150)'} stroke="currentColor" strokeWidth={i%5===0?2.4:1.2} opacity={i%5===0?.7:.24}/>)}<circle cx="150" cy="150" r="112" fill="none" stroke="currentColor" strokeWidth="1" opacity=".12"/><circle cx="150" cy="22" r="5" fill="currentColor" className="clock-dial-marker" style={{transform:'rotate('+(shift?elapsed%60*6:0)+'deg)'}}/></svg>
        <div className="clock-dial-content">{onBreak?<Coffee size={25}/>:<Clock3 size={25}/>}<span>{shift?'ELAPSED SHIFT':'READY TO BEGIN'}</span><strong>{shift?time:'00:00:00'}</strong><small>{shift?'Includes recorded breaks':'One tap to start your day'}</small></div>
      </div><div className="clock-floating-note"><span className="clock-note-icon">{shift?<Check size={17}/>:<Play size={17}/>}</span><div><strong>{shift?onBreak?'Break in progress':'Shift in progress':'Your next step'}</strong><span>{shift?segmentTime:'Choose your job above'}</span></div></div></div>
    </div>
    {shift&&<ol className="clock-journey" aria-label="Current shift status"><li className="is-complete"><span><Check size={14}/></span><div><strong>Clocked in</strong><small>Shift started</small></div></li><li className="is-current"><span>{onBreak?<Coffee size={15}/>:<BriefcaseBusiness size={15}/>}</span><div><strong>{onBreak?'On your break':'Working now'}</strong><small>{segmentTime}</small></div></li><li><span><LogOut size={15}/></span><div><strong>Finish your shift</strong><small>Clock out when done</small></div></li></ol>}

    {!shift&&!state.jobs.length&&<p className="clock-experience-help">You don’t have an active job assignment yet. Ask a manager to add one before you clock in.</p>}

    <footer className="clock-experience-help"><ShieldCheck size={15}/><span>{large?'Changes save when confirmed. Need to correct a shift? Open Time records to request a review.':'Changes save when the server confirms them.'}</span></footer>
  </section>;
}


