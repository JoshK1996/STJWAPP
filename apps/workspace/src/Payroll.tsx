import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { ArrowDownToLine, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Clock3, FileSpreadsheet, Fingerprint, Layers3, RefreshCw, Search, ShieldCheck, Users, Wallet } from 'lucide-react';
import { api, download } from './api';
import Compensation from './Compensation';
import { payrollHoursReportSchema, type PayrollHoursReport } from '../shared/payroll-hours';
import { formatWorkforceDuration } from '../shared/workforce-display';
import './payroll.css';

const displayHours = (value: string) => {
  const hundredths = (BigInt(value) * 100n + 1_800_000_000n) / 3_600_000_000n;
  return `${(hundredths / 100n).toLocaleString()}.${String(hundredths % 100n).padStart(2,'0')}`;
};
type Props = { me:any; staff:any[]; notify:(message:string,error?:boolean)=>void; onDirty:(value:boolean)=>void; onNavigateRecords:()=>void };
export default function Payroll({ me, staff, notify, onDirty, onNavigateRecords }: Props) {
  const zone=me.organization.timezone, today=DateTime.now().setZone(zone);
  const [start,setStart]=useState(today.startOf('week').toISODate()!),[end,setEnd]=useState(today.toISODate()!),[unit,setUnit]=useState(''),[person,setPerson]=useState('');
  const [view,setView]=useState<'hours'|'rates'>('hours'),[dirty,setDirty]=useState(false),[search,setSearch]=useState(''),[order,setOrder]=useState<'name'|'hours'|'breaks'>('hours');
  const [expanded,setExpanded]=useState<string[]>([]),[version,setVersion]=useState(0),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[page,setPage]=useState(0);
  const [loaded,setLoaded]=useState<{key:string;data:PayrollHoursReport}|null>(null),[loading,setLoading]=useState(true);
  const generation=useRef(0),mounted=useRef(true);
  const query=new URLSearchParams({start,end,group:'day',...(unit?{unitId:unit}:{}),...(person?{userId:person}:{})}).toString();
  const key=`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}:${query}:${version}`,data=loaded?.key===key?loaded.data:null;
  const canPay=['developer','owner','admin','finance'].includes(me.actor.role);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{setPage(0);},[key,search,order]);
  useEffect(()=>{
    const current=++generation.current;setLoading(true);setError('');setLoaded(null);setExpanded([]);
    void api('/payroll/hours?'+query).then(value=>{
      const result=payrollHoursReportSchema.parse(value);
      if(generation.current===current)setLoaded({key,data:result});
    }).catch(cause=>{if(generation.current===current)setError(cause instanceof Error?cause.message:'Could not load payroll hours.');})
      .finally(()=>{if(generation.current===current)setLoading(false);});
    return()=>{generation.current++;};
  },[key,query]);
  const markDirty=useCallback((value:boolean)=>{setDirty(value);onDirty(value);},[onDirty]);
  useEffect(()=>()=>onDirty(false),[onDirty]);
  const employees=useMemo(()=>{
    const rows=(data?.employees??[]).filter(row=>row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    return [...rows].sort((a,b)=>{
      if(order==='name')return a.name.localeCompare(b.name)||a.userId.localeCompare(b.userId);
      const av=BigInt(order==='hours'?a.workMicroseconds:a.breakMicroseconds),bv=BigInt(order==='hours'?b.workMicroseconds:b.breakMicroseconds);
      return av===bv?a.name.localeCompare(b.name):av>bv?-1:1;
    });
  },[data,search,order]);
  const greatestWork=useMemo(()=>(data?.employees??[]).reduce((value,row)=>BigInt(row.workMicroseconds)>value?BigInt(row.workMicroseconds):value,0n),[data]);
  function changeView(next:'hours'|'rates') {
    if(next===view)return;
    if(dirty&&!window.confirm('Discard unsaved pay-record changes?'))return;
    markDirty(false);setView(next);
  }
  async function exportFile(format:'csv'|'xlsx'|'json') {
    if(busy||!data)return;setBusy(format);
    try {await download(`/payroll/hours/export?${query}&format=${format}`,`stjw-payroll-hours-${start}-${end}.${format}`);if(mounted.current)notify('Payroll hours downloaded.');}
    catch(cause){if(mounted.current)notify(cause instanceof Error?cause.message:'Download could not finish.',true);}
    finally{if(mounted.current)setBusy(null);}
  }
  const totals=data?.totals;
  const allHours=totals?BigInt(totals.totalMicroseconds):0n,workRatio=allHours>0n?Number(BigInt(totals!.workMicroseconds)*10000n/allHours)/100:0;
  return <section className="payroll-workspace" aria-label="Payroll workspace">
    <div className="payroll-hero">
      <div><span className="eyebrow"><Wallet size={16}/> HOURS TO HANDOFF</span><h2>Payroll starts with<br/><em>a clear picture.</em></h2><p>See the people, jobs and hours behind every total. Give your accountant a workbook they can use.</p>
        <div className="payroll-hero-links"><button onClick={onNavigateRecords}><Clock3 size={17}/>Review time records<ArrowRight size={16}/></button>{canPay&&<button onClick={()=>changeView('rates')}><Wallet size={17}/>Manage pay rates<ArrowRight size={16}/></button>}</div>
      </div>
      <div className="payroll-sculpture" aria-hidden="true"><div className="payroll-orbit"/><div className="payroll-paper paper-back"/><div className="payroll-paper"><FileSpreadsheet size={39}/><i/><i/><i/><div className="payroll-paper-bars"><b/><b/><b/><b/></div></div><span className="payroll-coin"><CheckCircle2 size={38}/></span><span className="payroll-cube"><Layers3 size={29}/></span></div>
    </div>
    <div className="payroll-view-tabs" role="group" aria-label="Payroll section"><button className={view==='hours'?'active':''} aria-pressed={view==='hours'} onClick={()=>changeView('hours')}><FileSpreadsheet size={18}/>Hours & exports</button>{canPay&&<button className={view==='rates'?'active':''} aria-pressed={view==='rates'} onClick={()=>changeView('rates')}><Wallet size={18}/>Pay records</button>}</div>
    {view==='rates'&&canPay?<Compensation notify={notify} onDirty={markDirty}/>:<>
      <section className="payroll-period" aria-label="Payroll reporting period">
        <div className="payroll-section-title"><div><span className="eyebrow">01 · CHOOSE YOUR PERIOD</span><h3>Which hours are we preparing?</h3></div><button className="button secondary small" disabled={loading||!!busy} onClick={()=>setVersion(v=>v+1)}><RefreshCw size={16}/>Refresh</button></div>
        <div className="payroll-period-presets">{['This week','Last week','Last 14 days','This month'].map(label=><button key={label} disabled={!!busy} onClick={()=>{const date=DateTime.now().setZone(zone);if(label==='Last week'){setStart(date.minus({weeks:1}).startOf('week').toISODate()!);setEnd(date.minus({weeks:1}).endOf('week').toISODate()!);}else{setStart(label==='This week'?date.startOf('week').toISODate()!:label==='This month'?date.startOf('month').toISODate()!:date.minus({days:13}).toISODate()!);setEnd(date.toISODate()!);}}}>{label}</button>)}</div>
        <div className="payroll-filter-grid"><label>From<input type="date" value={start} disabled={!!busy} onChange={e=>setStart(e.target.value)}/></label><label>Through<input type="date" value={end} disabled={!!busy} onChange={e=>setEnd(e.target.value)}/></label><label>Community<select value={unit} disabled={!!busy} onChange={e=>setUnit(e.target.value)}><option value="">All permitted communities</option>{me.units.map((item:any)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Employee<select value={person} disabled={!!busy} onChange={e=>setPerson(e.target.value)}><option value="">All permitted employees</option>{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
        <p className="payroll-capture">Inclusive calendar dates · {zone}{data&&<> · Captured {DateTime.fromISO(data.report.asOf).setZone(zone).toFormat('LLL d, h:mm:ss a')}</>}</p>
      </section>
      {error&&<div className="payroll-error" role="alert"><strong>Hours could not be loaded.</strong><p>{error}</p><button className="button secondary" onClick={()=>setVersion(v=>v+1)}>Try again</button></div>}
      {loading&&<div className="payroll-loading" role="status"><div/><div/><div/><span>Gathering recorded hours…</span></div>}
      {data&&totals&&<>
        <div className="payroll-kpis">
          <article className="payroll-kpi work"><span><Clock3 size={20}/>Work hours</span><strong>{displayHours(totals.workMicroseconds)}<small> h</small></strong><p>Breaks are shown separately</p></article>
          <article className="payroll-kpi breaks"><span><Layers3 size={20}/>Break hours</span><strong>{displayHours(totals.breakMicroseconds)}<small> h</small></strong><p>Paid-break policy not applied</p></article>
          <article className="payroll-kpi people"><span><Users size={20}/>Employees</span><strong>{totals.employeeCount}</strong><p>With records in this period</p></article>
          <article className="payroll-kpi shifts"><span><Fingerprint size={20}/>Recorded shifts</span><strong>{totals.shiftCount}</strong><p>{totals.segmentCount} included time segments</p></article>
        </div>
        <div className="payroll-review-grid">
          <section className="payroll-review-card"><div className="payroll-section-title"><div><span className="eyebrow">02 · CHECK THE DETAILS</span><h3>A quick review before export</h3></div><ShieldCheck size={25}/></div>
            <div className="payroll-check-row"><span className={totals.ongoingSegmentCount?'needs-review':'checked'}><Clock3 size={19}/></span><div><strong>{totals.ongoingSegmentCount?`${totals.ongoingSegmentCount} ongoing time ${totals.ongoingSegmentCount===1?'segment':'segments'}`:'No ongoing segments in this period'}</strong><p>{totals.ongoingSegmentCount?'These hours are measured through the capture time and may change. Review open shifts before payroll.':'Check corrections and unusual shifts before handing the hours to your accountant.'}</p></div><button onClick={onNavigateRecords}>Review<ArrowRight size={15}/></button></div>
            <div className="payroll-check-row"><span className="checked"><Fingerprint size={19}/></span><div><strong>Every total has its source</strong><p>Exact recorded durations, employee/job identities and current shift revisions accompany the export.</p></div></div>
            <div className="payroll-check-row"><span className="policy"><Wallet size={19}/></span><div><strong>Hours and pay rates in one workspace</strong><p>Gross/net pay, overtime, paid breaks, leave, taxes and deductions are not calculated. Confirm the organization’s rules before processing payroll.</p></div>{canPay&&<button onClick={()=>changeView('rates')}>Pay rates<ArrowRight size={15}/></button>}</div>
          </section>
          <section className="payroll-export-card"><span className="eyebrow">03 · SEND TO YOUR ACCOUNTANT</span><h3>One click.<br/>A complete hours workbook.</h3><div className="payroll-export-mix"><div className="payroll-mini-donut" style={{background:`conic-gradient(#887bff 0 ${workRatio}%, #ffba83 ${workRatio}% 100%)`}} aria-hidden="true"><span><FileSpreadsheet size={23}/></span></div><div><strong>{totals.employeeCount} employee summaries</strong><p>Job breakdowns · original segments · source details</p></div></div>
            <button className="payroll-download-main" disabled={!!busy} onClick={()=>void exportFile('xlsx')}><FileSpreadsheet size={20}/>{busy==='xlsx'?'Preparing Excel…':'Download Excel'}<ArrowDownToLine size={18}/></button>
            <div className="payroll-download-more"><button disabled={!!busy} onClick={()=>void exportFile('csv')}>{busy==='csv'?'Preparing…':'Download CSV'}</button><button disabled={!!busy} onClick={()=>void exportFile('json')}>{busy==='json'?'Preparing…':'Source JSON'}</button></div>
            <p className="payroll-export-note">Downloads capture the latest permitted records again. Display filters below do not change the export. Hours are not payroll approval.</p>
          </section>
        </div>
        <section className="payroll-people-card"><div className="payroll-section-title"><div><span className="eyebrow">THE PEOPLE BEHIND THE TOTAL</span><h3>Employee hours</h3><p>Select a person to see their jobs and communities.</p></div><span className="payroll-count">{employees.length} of {data.employees.length}</span></div>
          <div className="payroll-people-controls"><label className="payroll-search"><Search size={17}/><input aria-label="Search displayed employees" placeholder="Find an employee…" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>Sort<select value={order} onChange={e=>setOrder(e.target.value as typeof order)}><option value="hours">Most work hours</option><option value="name">Employee name</option><option value="breaks">Most break hours</option></select></label></div>
          <div className="payroll-employee-heading" aria-hidden="true"><span>Employee / job</span><span>Work hours</span><span>Break hours</span><span>Shifts</span></div>
          {employees.slice(page*50,(page+1)*50).map((employee,index)=>{
            const open=expanded.includes(employee.userId),max=greatestWork;
            const percent=max>0n?Number(BigInt(employee.workMicroseconds)*10000n/max)/100:0;
            return <article className="payroll-employee" key={employee.userId}><button className="payroll-employee-row" aria-expanded={open} onClick={()=>setExpanded(ids=>open?ids.filter(id=>id!==employee.userId):[...ids,employee.userId])}>
              <span className="payroll-employee-identity"><span className={`payroll-avatar tint-${index%4}`}>{employee.name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('')}</span><span><strong>{employee.name}</strong><small>{employee.jobs.length} {employee.jobs.length===1?'job':'jobs'}{employee.ongoingSegmentCount?' · ongoing time included':''}</small><i className="payroll-person-bar"><b style={{width:`${percent}%`}}/></i></span>{open?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</span>
              <span title={formatWorkforceDuration(employee.workMicroseconds)}><small className="payroll-mobile-label">Work </small><strong>{displayHours(employee.workMicroseconds)}</strong><small> h</small></span><span title={formatWorkforceDuration(employee.breakMicroseconds)}><small className="payroll-mobile-label">Break </small>{displayHours(employee.breakMicroseconds)}<small> h</small></span><span><small className="payroll-mobile-label">Shifts </small>{employee.shiftCount}</span>
            </button>{open&&<div className="payroll-job-detail"><div className="table-scroll" tabIndex={0} role="region" aria-label={`${employee.name} job breakdown`}><table><thead><tr><th>Job / community</th><th>Work</th><th>Break</th><th>Included shifts</th></tr></thead><tbody>{employee.jobs.slice(0,100).map(job=><tr key={job.jobId}><th>{job.jobTitle}<small>{job.unitName}</small></th><td title={formatWorkforceDuration(job.workMicroseconds)}>{displayHours(job.workMicroseconds)} h</td><td title={formatWorkforceDuration(job.breakMicroseconds)}>{displayHours(job.breakMicroseconds)} h</td><td>{job.shiftCount}</td></tr>)}</tbody></table></div><p>{employee.jobs.length>100&&<>Showing the first 100 jobs; the export includes all {employee.jobs.length}. </>}Shown to 2 decimal places after aggregation. Excel and CSV include 6-decimal hours and exact microseconds. A shift can include several jobs.</p></div>}</article>;
          })}
          {employees.length>50&&<div className="payroll-pagination"><button className="button secondary small" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Employees {page*50+1}–{Math.min((page+1)*50,employees.length)} of {employees.length}</span><button className="button secondary small" disabled={(page+1)*50>=employees.length} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
          {!employees.length&&<div className="payroll-no-people"><Users size={31}/><h4>{data.employees.length?'No matching employees':'No recorded hours in this period'}</h4><p>{data.employees.length?'Try another name or clear the search.':'Choose a different date range or review your time records.'}</p></div>}
        </section>
      </>}
    </>}
  </section>;
}
