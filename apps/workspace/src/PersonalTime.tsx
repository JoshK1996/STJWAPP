import {useEffect,useRef,useState} from 'react';
import type {CSSProperties} from 'react';
import {ArrowLeft,ArrowRight,CalendarDays,ChartColumn,ChevronLeft,ChevronRight,Clock3,Coffee,History,RefreshCw} from 'lucide-react';
import {DateTime} from 'luxon';
import {api,ApiError} from './api';
import type {PersonalTimeReport} from '../shared/personal-time';
import {personalTimeReportSchema} from '../shared/personal-time';
import {movePersonalTimeAnchor,personalTimeCustomError,personalTimeDuration,personalTimeCommunities} from '../shared/personal-time-view';
import type {PersonalTimeCalendarPeriod} from '../shared/personal-time-view';
import {formatWorkforceDuration,workforceBarPercent} from '../shared/workforce-display';
import {decimalWorkHours} from '../shared/workforce-visuals';
import './personal-time.css';

type Period=PersonalTimeCalendarPeriod|'custom'|'all';
type Selection={period:Period;anchor:string;from:string;to:string;offset:number};
const periods:{value:Period;label:string}[]=[{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'year',label:'Year'},{value:'custom',label:'Custom'},{value:'all',label:'All time'}];
const calendarPeriods=new Set<Period>(['day','week','month','year']);
const colors=['var(--accent)','var(--info)','#8961c5','var(--warning)','#bd5874'];

function requestFor(selection:Selection){
 const query=new URLSearchParams({period:selection.period,offset:String(selection.offset)});
 if(selection.period==='custom'){query.set('from',selection.from);query.set('to',selection.to);}
 else if(selection.period!=='all')query.set('anchor',selection.anchor);
 return `/clock/history?${query}`;
}
function Duration({value}:{value:string}){
 return <span title={formatWorkforceDuration(value,true)} aria-label={formatWorkforceDuration(value,true)}>{personalTimeDuration(value)}</span>;
}
function Stamp({value,timezone,full=false}:{value:string;timezone:string;full?:boolean}){
 const local=DateTime.fromISO(value).setZone(timezone);
 return <time dateTime={value} title={`${local.toFormat('ccc, LLL d, yyyy · h:mm:ss a ZZZZ')} · ${value}`}>{local.toFormat(full?'LLL d, yyyy · h:mm a':'h:mm a')}</time>;
}
function dateLabel(date:string,format='LLL d, yyyy'){return DateTime.fromISO(date,{zone:'UTC'}).toFormat(format);}

export default function PersonalTime({timezone,onSessionExpired,onBack}:{timezone:string;onSessionExpired:()=>void;onBack:()=>void}){
 const today=()=>DateTime.now().setZone(timezone).toISODate()!;
 const [selection,setSelection]=useState<Selection>(()=>({period:'week',anchor:today(),from:DateTime.now().setZone(timezone).startOf('month').toISODate()!,to:today(),offset:0}));
 const [draftFrom,setDraftFrom]=useState(selection.from),[draftTo,setDraftTo]=useState(selection.to),[dateError,setDateError]=useState('');
 const [result,setResult]=useState<{key:string;data:PersonalTimeReport}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
 const [group,setGroup]=useState<'job'|'community'>('job');
 const callback=useRef(onSessionExpired);callback.current=onSessionExpired;
 const requestGeneration=useRef(0);
 const requestPath=requestFor(selection),requestKey=`${requestPath}&refresh=${refresh}`;
 const requestedKey=useRef(requestKey);requestedKey.current=requestKey;
 const report=result?.key===requestKey?result.data:null;
 const error=failure?.key===requestKey?failure.message:'';
 useEffect(()=>{
  const controller=new AbortController(),generation=++requestGeneration.current;
  let active=true;
  setLoading(true);setFailure(null);setResult(null);
  api<unknown>(requestPath,undefined,'GET',controller.signal).then(value=>{
   if(!active||generation!==requestGeneration.current||requestedKey.current!==requestKey)return;
   const parsed=personalTimeReportSchema.safeParse(value);
   if(!parsed.success)throw new Error('Your time records could not be read. Refresh the app and try again.');
   setResult({key:requestKey,data:parsed.data});setLoading(false);
  }).catch(reason=>{
   if(!active||generation!==requestGeneration.current||controller.signal.aborted||requestedKey.current!==requestKey)return;
   setResult(null);setLoading(false);
   if(reason instanceof ApiError&&(reason.status===401||reason.status===403)){setFailure({key:requestKey,message:'Your session has ended. Please sign in again to see your hours.'});callback.current();return;}
   setFailure({key:requestKey,message:reason instanceof Error?reason.message:'Your hours could not be loaded. Please try again.'});
  });
  return()=>{active=false;controller.abort();};
 },[requestPath,requestKey]);

 const choosePeriod=(period:Period)=>{setDateError('');setSelection(current=>({...current,period,offset:0}));};
 const move=(direction:-1|1)=>{
  try{const anchor=movePersonalTimeAnchor(selection.anchor,selection.period as PersonalTimeCalendarPeriod,direction);setSelection(current=>({...current,anchor,offset:0}));setDateError('');}
  catch{setDateError('Choose a date from 1900 through 9998.');}
 };
 const applyCustom=()=>{const problem=personalTimeCustomError(draftFrom,draftTo);setDateError(problem);if(!problem)setSelection(current=>({...current,from:draftFrom,to:draftTo,offset:0}));};
 const customChanged=selection.from!==draftFrom||selection.to!==draftTo;
 const trend=report?.trend.points??[];
 const maximum=trend.reduce((max,point)=>{const total=BigInt(point.workMicroseconds)+BigInt(point.breakMicroseconds);return total>max?total:max;},0n).toString();
 const breakdown=report?(group==='job'?report.jobs.map(job=>({key:`${job.jobId}:${job.unitId}`,title:job.title,subtitle:job.unitName,workMicroseconds:job.workMicroseconds,breakMicroseconds:job.breakMicroseconds})):personalTimeCommunities(report.jobs).map(unit=>({key:unit.unitId,title:unit.unitName,subtitle:'Community',workMicroseconds:unit.workMicroseconds,breakMicroseconds:unit.breakMicroseconds}))):[];

 return <section className="personal-time" aria-label="My hours and clock records">
  <header className="pt-heading">
   <div><span className="pt-eyebrow"><History size={16} aria-hidden="true"/> Your time, at a glance</span><h2>My hours</h2><p>Review your clock records, jobs and breaks.</p></div>
   <button className="pt-button pt-back" onClick={onBack}><ArrowLeft size={17} aria-hidden="true"/>Back to clock</button>
  </header>
  <div className="pt-range-panel">
   <div className="pt-periods" role="group" aria-label="Hours period">{periods.map(period=><button key={period.value} aria-pressed={selection.period===period.value} onClick={()=>choosePeriod(period.value)}>{period.label}</button>)}</div>
   {calendarPeriods.has(selection.period)&&<div className="pt-date-navigation">
    <button className="pt-icon-button" aria-label={`Previous ${selection.period}`} onClick={()=>move(-1)}><ChevronLeft size={20} aria-hidden="true"/></button>
    <label className="pt-anchor">{selection.period==='day'?'Date':`Date in selected ${selection.period}`}<input aria-label={`Date in selected ${selection.period}`} type="date" value={selection.anchor} min="1900-01-01" max="9998-12-31" onChange={event=>{const value=event.target.value;if(value&&/^\d{4}-\d{2}-\d{2}$/.test(value)){setDateError('');setSelection(current=>({...current,anchor:value,offset:0}));}}}/></label>
    <button className="pt-icon-button" aria-label={`Next ${selection.period}`} onClick={()=>move(1)}><ChevronRight size={20} aria-hidden="true"/></button>
    <button className="pt-button pt-today" onClick={()=>{setDateError('');setSelection(current=>({...current,anchor:today(),offset:0}));}}>Today</button>
   </div>}
   {selection.period==='custom'&&<form className="pt-custom-dates" onSubmit={event=>{event.preventDefault();applyCustom();}}>
    <label>From<input type="date" value={draftFrom} min="1900-01-01" max="9998-12-31" required onChange={event=>{setDraftFrom(event.target.value);setDateError('');}}/></label>
    <label>Through<input type="date" value={draftTo} min="1900-01-01" max="9998-12-31" required onChange={event=>{setDraftTo(event.target.value);setDateError('');}}/></label>
    <button className="pt-button pt-primary" type="submit">Apply dates</button>
    <p className="pt-note">{customChanged?'Apply dates to update the results below.':'Choose up to 366 days, including both dates.'}</p>
   </form>}
   {selection.period==='all'&&<p className="pt-note pt-all-note">Your complete recorded history. Large histories may need a smaller date range.</p>}
   {dateError&&<p className="pt-error" role="alert">{dateError}</p>}
  </div>
  <div className="pt-results" aria-busy={loading||(!report&&!error)}>
   {(loading||(!report&&!error))&&<div className="pt-loading" role="status"><Clock3 size={23} aria-hidden="true"/><p>Loading your hours…</p></div>}
   {error&&<div className="pt-error-panel" role="alert"><p>{error}</p><button className="pt-button" onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>}
   {report&&<>
    <div className="pt-range-heading"><div><h3>{report.range.label}</h3><p className="pt-note">{report.timezone} · Weeks begin Monday</p></div><button className="pt-icon-button" aria-label="Refresh my hours" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={18} aria-hidden="true"/></button></div>
    <div className="pt-summary" aria-label="Totals for the entire selected period">
     <div className="pt-stat pt-stat-work"><span><Clock3 size={18} aria-hidden="true"/>Worked</span><strong title={formatWorkforceDuration(report.summary.workMicroseconds,true)}>{decimalWorkHours(report.summary.workMicroseconds)}<small>h</small></strong><span><Duration value={report.summary.workMicroseconds}/></span></div>
     <div className="pt-stat pt-stat-break"><span><Coffee size={18} aria-hidden="true"/>Breaks</span><strong><Duration value={report.summary.breakMicroseconds}/></strong><span>Shown separately</span></div>
     <div className="pt-stat pt-stat-days"><span><CalendarDays size={18} aria-hidden="true"/>Days worked</span><strong>{report.summary.daysWorked.toLocaleString()}</strong><span>{report.summary.shiftCount.toLocaleString()} clock {report.summary.shiftCount===1?'record':'records'}{report.summary.openCount>0?' · clock running':''}</span></div>
    </div>
    <p className="pt-note pt-observation">Updated <Stamp value={report.observedAt} timezone={report.timezone} full/>. {report.summary.openCount>0?'Your open record is included through this time. Refresh to update it.':'Hours reflect your current time cards.'} Display hours use two decimals; exact time is preserved.</p>
    {report.summary.shiftCount===0?<div className="pt-empty"><History size={36} aria-hidden="true"/><h3>No clock records in this period</h3><p>Choose another date or All time to review your history.</p><button className="pt-button" onClick={()=>choosePeriod('all')}>View all time</button></div>:<>
     <section className="pt-panel pt-trend" aria-label="Hours chart">
      <div className="pt-section-heading"><h3><ChartColumn size={19} aria-hidden="true"/>Your hours over time</h3><div className="pt-legend"><span><i className="pt-work-dot"/>Work</span><span><i className="pt-break-dot"/>Break</span></div></div>
      <p className="pt-note">Worked hours appear above each bar. Select a bar to open that {report.trend.group==='month'?'month':'day'}. Only dates with recorded time are shown.{trend.length>7?' Scroll the chart to see more dates.':''}</p>
      <div className="pt-chart-scroll" tabIndex={0} role="group" aria-label="Scrollable hours chart">
       <div className="pt-chart" style={{'--pt-points':Math.max(trend.length,1)} as CSSProperties}>
        {trend.map(point=>{const workHeight=workforceBarPercent(point.workMicroseconds,maximum),breakHeight=workforceBarPercent(point.breakMicroseconds,maximum);return <button key={point.date} className="pt-chart-column" aria-label={`${dateLabel(point.date,report.trend.group==='month'?'LLLL yyyy':'cccc, LLLL d, yyyy')}: ${formatWorkforceDuration(point.workMicroseconds,true)} worked, ${formatWorkforceDuration(point.breakMicroseconds,true)} break. Open ${report.trend.group==='month'?'month':'day'}.`} title={`${dateLabel(point.date)} · ${personalTimeDuration(point.workMicroseconds)} worked · ${personalTimeDuration(point.breakMicroseconds)} break`} onClick={()=>{setDateError('');setSelection(current=>({...current,period:report.trend.group==='month'?'month':'day',anchor:point.date,offset:0}));}}>
         <span className="pt-bar-value" aria-hidden="true">{decimalWorkHours(point.workMicroseconds)}h</span><span className="pt-bar-space" aria-hidden="true"><span className="pt-bar-break" style={{height:`${breakHeight}%`}}/><span className="pt-bar-work" style={{height:`${workHeight}%`}}/></span>
         <span className="pt-bar-label">{dateLabel(point.date,report.trend.group==='month'?'LLL yy':'LLL d')}</span>
        </button>;})}
       </div>
      </div>
     </section>
     <section className="pt-panel" aria-label="Hours by job and community">
      <div className="pt-section-heading"><h3>Where your hours went</h3><div className="pt-group-toggle" role="group" aria-label="Breakdown grouping"><button aria-pressed={group==='job'} onClick={()=>setGroup('job')}>By job</button><button aria-pressed={group==='community'} onClick={()=>setGroup('community')}>By community</button></div></div>
      <ul className="pt-breakdown">{breakdown.map((item,index)=><li key={item.key} style={{'--pt-color':colors[index%colors.length]} as CSSProperties}><div className="pt-breakdown-label"><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><span className="pt-breakdown-time"><Duration value={item.workMicroseconds}/>{BigInt(item.breakMicroseconds)>0n&&<small>Break: <Duration value={item.breakMicroseconds}/></small>}</span></div><div className="pt-meter" aria-hidden="true"><span style={{width:`${workforceBarPercent(item.workMicroseconds,report.summary.workMicroseconds)}%`}}/></div></li>)}</ul>
     </section>
    </>}
    {report.rows.length>0&&<section className="pt-panel pt-records" aria-label="My clock records">
     <div className="pt-section-heading"><div><h3>Clock records</h3><p className="pt-note">Open a record for job changes, breaks and times.</p></div><span className="pt-record-count">{report.offset+1}–{report.offset+report.rows.length} of {report.summary.shiftCount.toLocaleString()}</span></div>
     <div className="pt-card-list">{report.rows.map(row=>{
      const start=DateTime.fromISO(row.startedAt).setZone(report.timezone),end=row.endedAt?DateTime.fromISO(row.endedAt).setZone(report.timezone):null;
      const crossesRange=row.workMicroseconds!==row.periodWorkMicroseconds||row.breakMicroseconds!==row.periodBreakMicroseconds;
      return <details className="pt-record" key={`${row.id}:${row.revision}`}><summary>
       <span className="pt-record-date"><strong>{start.toFormat('ccc, LLL d, yyyy')}</strong><span><Stamp value={row.startedAt} timezone={report.timezone}/>{row.endedAt?<> – <Stamp value={row.endedAt} timezone={report.timezone} full={start.toISODate()!==end?.toISODate()}/></>:' – now'}</span></span>
       <span className="pt-record-total"><strong><Duration value={row.periodWorkMicroseconds}/></strong><small>worked{!row.endedAt?' · open':''}</small></span><ChevronRight size={18} className="pt-record-chevron" aria-hidden="true"/>
      </summary><div className="pt-record-body">
       <div className="pt-record-summary"><span>Work in period: <strong><Duration value={row.periodWorkMicroseconds}/></strong></span><span>Breaks in period: <strong><Duration value={row.periodBreakMicroseconds}/></strong></span></div>
       {crossesRange&&<p className="pt-note">This record crosses the selected dates. Only time inside this period is included above. Whole record: <Duration value={row.workMicroseconds}/> worked · <Duration value={row.breakMicroseconds}/> on break.</p>}
       <ol className="pt-segments">{row.segments.map(segment=>{
        const isBreak=segment.kind==='break',periodDuration=isBreak?segment.periodBreakMicroseconds:segment.periodWorkMicroseconds,wholeDuration=isBreak?segment.breakMicroseconds:segment.workMicroseconds;
        return <li key={segment.id} className={isBreak?'pt-segment-break':'pt-segment-work'}><span className="pt-segment-symbol" aria-hidden="true">{isBreak?<Coffee size={16}/>:<Clock3 size={16}/>}</span><div><div className="pt-segment-title"><strong>{isBreak?'Break':segment.title}</strong><span><Duration value={periodDuration}/></span></div><p>{isBreak?`${segment.title} · `:''}{segment.unitName}</p><p className="pt-segment-dates"><Stamp value={segment.startedAt} timezone={report.timezone} full/> <span>→</span> {segment.endedAt?<Stamp value={segment.endedAt} timezone={report.timezone} full/>:'Ongoing'}</p>{periodDuration!==wholeDuration&&<p className="pt-note">{periodDuration==='0'?'Outside this period. ':''}Full segment: <Duration value={wholeDuration}/></p>}</div></li>;
       })}</ol>
      </div></details>;
     })}</div>
     {(report.offset>0||report.hasMore)&&<nav className="pt-pagination" aria-label="Clock record pages"><button className="pt-button" disabled={report.offset===0} onClick={()=>setSelection(current=>({...current,offset:Math.max(0,report.offset-25)}))}><ArrowLeft size={16} aria-hidden="true"/>Previous</button><span>Page {Math.floor(report.offset/25)+1}</span><button className="pt-button" disabled={!report.hasMore||report.nextOffset===null} onClick={()=>{if(report.nextOffset!==null)setSelection(current=>({...current,offset:report.nextOffset!}));}}>Next<ArrowRight size={16} aria-hidden="true"/></button></nav>}
     <p className="pt-note pt-record-help">Need a correction? Ask your administrator to update your time card.</p>
    </section>}
   </>}
  </div>
 </section>;
}
