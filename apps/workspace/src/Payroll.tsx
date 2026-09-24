import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { ArrowDownToLine, ArrowRight, ArrowRightLeft, Bookmark, ChartNoAxesCombined, CheckCircle2, ChevronDown, ChevronRight, Clock3, FileSpreadsheet, Fingerprint, Info, Layers3, Pencil, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, Users, Wallet } from 'lucide-react';
import { api, download } from './api';
import Compensation from './Compensation';
import { Modal } from './components';
import { payrollHoursReportSchema, type PayrollHoursReport } from '../shared/payroll-hours';
import { createPayrollViewSchema, payrollViewListSchema, resolvedPayrollViewSchema, savedPayrollViewSchema, updatePayrollViewSchema, type PayrollViewFilters, type SavedPayrollView } from '../shared/payroll-views';
import { payrollReviewSchema, type PayrollReview } from '../shared/payroll-review';
import { formatWorkforceDuration, workforceBarPercent } from '../shared/workforce-display';
import './payroll.css';
import './payroll-preparation.css';

const displayHours = (value: string) => {
  const hundredths = (BigInt(value) * 100n + 1_800_000_000n) / 3_600_000_000n;
  return `${(hundredths / 100n).toLocaleString()}.${String(hundredths % 100n).padStart(2,'0')}`;
};
type Props = { me:any; staff:any[]; notify:(message:string,error?:boolean)=>void; onDirty:(value:boolean)=>void; onNavigateRecords:()=>void };
type ViewEditor = { owner:string; id:string; revision?:number; name:string; filters:PayrollViewFilters; baseline:string };
const periodNames:Record<PayrollViewFilters['period'],string> = {this_week:'This week',last_week:'Last week',last_14_days:'Last 14 days',this_month:'This month',custom:'Custom dates'};
const viewSummary=(filters:PayrollViewFilters)=>`${filters.period==='custom'?`${filters.start} through ${filters.end}`:periodNames[filters.period]} · ${filters.group} groups${filters.unitId?' · selected community':''}${filters.userId?' · selected employee':''}${filters.comparePrevious?' · previous-period comparison':''}`;
const editorSnapshot=(value:Pick<ViewEditor,'name'|'filters'>)=>JSON.stringify({name:value.name,filters:value.filters});
export default function Payroll({ me, staff, notify, onDirty, onNavigateRecords }: Props) {
  const zone=me.organization.timezone, today=DateTime.now().setZone(zone);
  const [start,setStart]=useState(today.startOf('week').toISODate()!),[end,setEnd]=useState(today.toISODate()!),[unit,setUnit]=useState(''),[person,setPerson]=useState('');
  const [view,setView]=useState<'hours'|'rates'>('hours'),[dirty,setDirty]=useState(false),[search,setSearch]=useState(''),[order,setOrder]=useState<'name'|'hours'|'breaks'>('hours');
  const [expanded,setExpanded]=useState<string[]>([]),[version,setVersion]=useState(0),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[page,setPage]=useState(0);
  const [loaded,setLoaded]=useState<{key:string;data:PayrollHoursReport}|null>(null),[loading,setLoading]=useState(true);
  const [reviewLoaded,setReviewLoaded]=useState<{key:string;data:PayrollReview}|null>(null),[reviewLoading,setReviewLoading]=useState(true),[reviewError,setReviewError]=useState('');
  const [period,setPeriod]=useState<PayrollViewFilters['period']>('this_week'),[group,setGroup]=useState<PayrollViewFilters['group']>('day'),[comparePrevious,setComparePrevious]=useState(false);
  const [viewLibrary,setViewLibrary]=useState(false),[viewsVersion,setViewsVersion]=useState(0),[viewsLoading,setViewsLoading]=useState(true);
  const [savedViews,setSavedViews]=useState<{owner:string;views:SavedPayrollView[];limit:number}|null>(null),[viewsError,setViewsError]=useState<{owner:string;message:string}|null>(null);
  const [selectedView,setSelectedView]=useState(''),[viewTask,setViewTask]=useState<string|null>(null),[editor,setEditor]=useState<ViewEditor|null>(null),[editorError,setEditorError]=useState('');
  const generation=useRef(0),mounted=useRef(true);
  const actorKey=`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`;
  const actorRef=useRef(actorKey),viewGeneration=useRef(0),resolveGeneration=useRef(0),viewTaskRef=useRef<string|null>(null),viewOperation=useRef(0);
  actorRef.current=actorKey;
  const query=new URLSearchParams({start,end,group,...(unit?{unitId:unit}:{}),...(person?{userId:person}:{})}).toString();
  const key=`${actorKey}:${query}:${version}`,data=loaded?.key===key?loaded.data:null;
  const review=reviewLoaded?.key===key?reviewLoaded.data:null;
  const views=savedViews?.owner===actorKey?savedViews.views:[],viewError=viewsError?.owner===actorKey?viewsError.message:'';
  const ownedEditor=editor?.owner===actorKey?editor:null,editorDirty=Boolean(ownedEditor&&editorSnapshot(ownedEditor)!==ownedEditor.baseline);
  const filters:PayrollViewFilters={period,group,comparePrevious,...(period==='custom'?{start,end}:{}),...(unit?{unitId:unit}:{}),...(person?{userId:person}:{})};
  const canPay=['developer','owner','admin','finance'].includes(me.actor.role);
  // Invalidate pending publications during unmount, before passive cleanup.
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;viewGeneration.current++;resolveGeneration.current++;};},[]);
  useEffect(()=>{setEditor(null);setEditorError('');setSelectedView('');setViewTask(null);setBusy(null);setDirty(false);viewTaskRef.current=null;viewOperation.current++;resolveGeneration.current++;},[actorKey]);
  useEffect(()=>{
    const current=++viewGeneration.current;setViewsLoading(true);setViewsError(null);setSavedViews(null);
    void api('/payroll/views').then(value=>{
      const result=payrollViewListSchema.parse(value);
      if(mounted.current&&actorRef.current===actorKey&&viewGeneration.current===current)setSavedViews({owner:actorKey,...result});
    }).catch(cause=>{if(mounted.current&&actorRef.current===actorKey&&viewGeneration.current===current)setViewsError({owner:actorKey,message:cause instanceof Error?cause.message:'Saved views could not be loaded.'});})
      .finally(()=>{if(mounted.current&&actorRef.current===actorKey&&viewGeneration.current===current)setViewsLoading(false);});
    return()=>{viewGeneration.current++;};
  },[actorKey,viewsVersion]);
  useEffect(()=>{setPage(0);},[key,search,order]);
  useEffect(()=>{
    const current=++generation.current;setLoading(true);setError('');setLoaded(null);setExpanded([]);setReviewLoading(true);setReviewLoaded(null);setReviewError('');
    void api('/payroll/hours?'+query).then(value=>{
      const result=payrollHoursReportSchema.parse(value);
      if(generation.current===current)setLoaded({key,data:result});
    }).catch(cause=>{if(generation.current===current)setError(cause instanceof Error?cause.message:'Could not load payroll hours.');})
      .finally(()=>{if(generation.current===current)setLoading(false);});
    void api('/payroll/review?'+query).then(value=>{
      const result=payrollReviewSchema.parse(value);
      if(generation.current===current)setReviewLoaded({key,data:result});
    }).catch(cause=>{if(generation.current===current)setReviewError(cause instanceof Error?cause.message:'Could not load preparation evidence.');})
      .finally(()=>{if(generation.current===current)setReviewLoading(false);});
    return()=>{generation.current++;};
  },[key,query]);
  const markDirty=useCallback((value:boolean)=>{setDirty(value);},[]);
  useEffect(()=>{onDirty(dirty||editorDirty||viewTask==='save');},[dirty,editorDirty,viewTask,onDirty]);
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
  function changeFilters(change:()=>void){resolveGeneration.current++;setSelectedView('');change();}
  function preset(next:PayrollViewFilters['period']){
    const date=DateTime.now().setZone(zone);
    changeFilters(()=>{setPeriod(next);setStart(next==='last_week'?date.minus({weeks:1}).startOf('week').toISODate()!:next==='this_week'?date.startOf('week').toISODate()!:next==='this_month'?date.startOf('month').toISODate()!:date.minus({days:13}).toISODate()!);setEnd(next==='last_week'?date.minus({weeks:1}).endOf('week').toISODate()!:date.toISODate()!);});
  }
  function resetFilters(){
    const date=DateTime.now().setZone(zone);
    changeFilters(()=>{setPeriod('this_week');setStart(date.startOf('week').toISODate()!);setEnd(date.toISODate()!);setUnit('');setPerson('');setGroup('day');setComparePrevious(false);});
  }
  function beginViewTask(task:string){if(viewTaskRef.current)return null;viewTaskRef.current=task;setViewTask(task);return ++viewOperation.current;}
  function ownsViewTask(owner:string,operation:number){return mounted.current&&actorRef.current===owner&&viewOperation.current===operation;}
  function endViewTask(owner:string,operation:number){if(ownsViewTask(owner,operation)){viewTaskRef.current=null;setViewTask(null);}}
  async function openSavedView(id:string){
    if(!id)return;const operation=beginViewTask('open:'+id);if(operation===null)return;
    const owner=actorKey,current=++resolveGeneration.current;setViewsError(null);
    try{
      const resolved=resolvedPayrollViewSchema.parse(await api('/payroll/views/'+id+'/resolve'));
      if(!ownsViewTask(owner,operation)||resolveGeneration.current!==current)return;
      if(resolved.view.availability!=='available')throw new Error(resolved.view.unavailableReason||'This saved view is unavailable.');
      const selected=resolved.query;
      setStart(selected.start);setEnd(selected.end);setGroup(selected.group);setUnit(selected.unitId??'');setPerson(selected.userId??'');
      setPeriod(resolved.view.filters.period);setComparePrevious(resolved.view.filters.comparePrevious);setSelectedView(id);setVersion(value=>value+1);
    }catch(cause){if(ownsViewTask(owner,operation)&&resolveGeneration.current===current)setViewsError({owner,message:`Saved view could not open. Your current filters are unchanged. ${cause instanceof Error?cause.message:'Try again.'}`});}
    finally{endViewTask(owner,operation);}
  }
  function editSavedView(saved?:SavedPayrollView,useCurrent=false){
    const draft={owner:actorKey,id:saved?.id??crypto.randomUUID(),revision:saved?.revision,name:saved?.name??'',filters:saved&&!useCurrent?saved.filters:filters};
    setEditor({...draft,baseline:editorSnapshot(saved?{name:saved.name,filters:saved.filters}:draft)});setEditorError('');
  }
  function closeEditor(){if(viewTaskRef.current)return;if(editorDirty&&!window.confirm('Discard unsaved view changes?'))return;setEditor(null);setEditorError('');}
  async function saveView(){
    if(!ownedEditor)return;const operation=beginViewTask('save');if(operation===null)return;
    const owner=actorKey,draft=ownedEditor;setEditorError('');
    try{
      const body=draft.revision===undefined?createPayrollViewSchema.parse({id:draft.id,name:draft.name,filters:draft.filters}):updatePayrollViewSchema.parse({revision:draft.revision,name:draft.name,filters:draft.filters});
      savedPayrollViewSchema.parse(await api('/payroll/views'+(draft.revision===undefined?'':'/'+draft.id),body,draft.revision===undefined?'POST':'PATCH'));
      if(!ownsViewTask(owner,operation))return;
      setEditor(null);setEditorError('');setViewsVersion(value=>value+1);notify('Your payroll view was saved.');
    }catch(cause){if(ownsViewTask(owner,operation))setEditorError(cause instanceof Error?cause.message:'Could not save this view. Check your saved views before trying again.');}
    finally{endViewTask(owner,operation);}
  }
  async function deleteView(saved:SavedPayrollView){
    if(viewTaskRef.current||!window.confirm(`Delete saved view “${saved.name}”? Recorded hours will not change.`))return;const operation=beginViewTask('delete:'+saved.id);if(operation===null)return;
    const owner=actorKey;setViewsError(null);
    try{
      await api('/payroll/views/'+saved.id,{revision:saved.revision},'DELETE');
      if(!ownsViewTask(owner,operation))return;
      if(selectedView===saved.id)setSelectedView('');setViewsVersion(value=>value+1);notify('Saved view deleted. Your current report filters are unchanged.');
    }catch(cause){if(ownsViewTask(owner,operation))setViewsError({owner,message:cause instanceof Error?cause.message:'Could not delete this view.'});}
    finally{endViewTask(owner,operation);}
  }
  async function exportFile(format:'csv'|'xlsx'|'json') {
    if(busy||!data)return;setBusy(format);const owner=actorKey;
    try {const published=await download(`/payroll/hours/export?${query}&format=${format}`,`stjw-payroll-hours-${start}-${end}.${format}`,()=>mounted.current&&actorRef.current===owner);if(published&&mounted.current&&actorRef.current===owner)notify('Payroll hours downloaded.');}
    catch(cause){if(mounted.current&&actorRef.current===owner)notify(cause instanceof Error?cause.message:'Download could not finish.',true);}
    finally{if(mounted.current&&actorRef.current===owner)setBusy(null);}
  }
  async function exportComparison(format:'csv'|'json') {
    if(busy||!review)return;setBusy('review-'+format);const owner=actorKey;
    try {const published=await download(`/payroll/review/export?${query}&format=${format}`,`stjw-payroll-comparison-${start}-${end}.${format}`,()=>mounted.current&&actorRef.current===owner);if(published&&mounted.current&&actorRef.current===owner)notify('Period comparison downloaded.');}
    catch(cause){if(mounted.current&&actorRef.current===owner)notify(cause instanceof Error?cause.message:'Comparison download could not finish.',true);}
    finally{if(mounted.current&&actorRef.current===owner)setBusy(null);}
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
        <div className="payroll-section-title"><div><span className="eyebrow">01 · CHOOSE YOUR PERIOD</span><h3>Which hours are we preparing?</h3></div><div className="payroll-period-actions"><button type="button" className="button secondary small" disabled={loading||!!busy||!!viewTask} onClick={()=>setVersion(v=>v+1)}><RefreshCw size={16}/>Refresh</button><button type="button" className="button secondary small" disabled={!!busy||!!viewTask} onClick={resetFilters}>Reset filters</button></div></div>
        <div className="payroll-saved-tools">
          <span className="payroll-saved-emblem" aria-hidden="true"><Bookmark size={22}/></span>
          <label>My saved views<select aria-label="Open a saved payroll view" value={selectedView} disabled={viewsLoading||!!viewTask||!!busy} onChange={event=>void openSavedView(event.target.value)}><option value="">{viewsLoading?'Loading your views…':'Choose a saved view'}</option>{views.map(saved=><option key={saved.id} value={saved.id} disabled={saved.availability==='unavailable'}>{saved.name}{saved.availability==='unavailable'?' · unavailable':''}</option>)}</select></label>
          <div className="payroll-saved-actions"><button type="button" onClick={()=>editSavedView()} disabled={viewsLoading||!!viewTask||!!busy||!savedViews||views.length>=25}><Plus size={16}/>Save view</button><button type="button" aria-expanded={viewLibrary} aria-controls="payroll-view-library" onClick={()=>setViewLibrary(value=>!value)}><Bookmark size={16}/>{viewLibrary?'Hide views':'Manage views'}</button></div>
        </div>
        {selectedView&&<p className="payroll-saved-current">Using <strong>{views.find(saved=>saved.id===selectedView)?.name??'saved filters'}</strong></p>}
        {viewTask?.startsWith('open:')&&<p className="payroll-capture" role="status">Opening the saved filters using the organization's current calendar…</p>}
        {viewError&&<div className="payroll-view-error" role="alert"><p>{viewError}</p>{!viewLibrary&&<button type="button" disabled={viewsLoading||!!viewTask||!!busy} onClick={()=>setViewsVersion(value=>value+1)}>Refresh saved views</button>}</div>}
        {viewLibrary&&<section id="payroll-view-library" className="payroll-view-library" aria-label="Personal payroll views"><div className="payroll-library-heading"><div><h4>Your reporting shortcuts</h4><p>Only your account sees these views. Available on your other devices when you sign in.</p></div><div className="payroll-library-tools"><span>{views.length} / 25</span><button type="button" disabled={viewsLoading||!!viewTask||!!busy} onClick={()=>setViewsVersion(value=>value+1)}><RefreshCw size={14}/>Refresh saved views</button></div></div>
          {!viewsLoading&&!views.length&&!viewError&&<p className="payroll-capture">Set your filters and choose Save view to keep a useful starting point.</p>}
          <div className="payroll-view-cards">{views.map(saved=><article key={saved.id} className={saved.availability==='unavailable'?'unavailable':''}><div className="payroll-view-card-title"><Bookmark size={17}/><h5>{saved.name}</h5></div><p>{viewSummary(saved.filters)}</p>{saved.availability==='unavailable'&&<p className="payroll-view-unavailable"><Info size={15}/>{saved.unavailableReason??'This view is unavailable. Update its filters before using it.'}</p>}<div className="payroll-view-card-actions"><button type="button" disabled={saved.availability==='unavailable'||!!viewTask||!!busy} onClick={()=>void openSavedView(saved.id)}>Open<ArrowRight size={14}/></button><button type="button" disabled={!!viewTask||!!busy} onClick={()=>editSavedView(saved)} aria-label={`Rename ${saved.name}`}><Pencil size={14}/>Rename</button><button type="button" disabled={!!viewTask||!!busy} onClick={()=>editSavedView(saved,true)}>Use current filters</button><button type="button" disabled={!!viewTask||!!busy} onClick={()=>void deleteView(saved)} aria-label={`Delete ${saved.name}`}><Trash2 size={14}/><span>Delete</span></button></div></article>)}</div>
        </section>}
        <div className="payroll-period-presets">{(['this_week','last_week','last_14_days','this_month'] as const).map(value=><button type="button" key={value} aria-pressed={period===value} disabled={!!busy||!!viewTask} onClick={()=>preset(value)}>{periodNames[value]}</button>)}</div>
        <div className="payroll-filter-grid"><label>From<input type="date" value={start} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>{setPeriod('custom');setStart(event.target.value);})}/></label><label>Through<input type="date" value={end} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>{setPeriod('custom');setEnd(event.target.value);})}/></label><label>Community<select value={unit} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>setUnit(event.target.value))}><option value="">All permitted communities</option>{unit&&!me.units.some((item:any)=>item.id===unit)&&<option value={unit}>Selected community (check access)</option>}{me.units.map((item:any)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Employee<select value={person} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>setPerson(event.target.value))}><option value="">All permitted employees</option>{person&&!staff.some(item=>item.id===person)&&<option value={person}>Selected employee</option>}{staff.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
        <div className="payroll-comparison-controls"><label>Group time by<select value={group} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>setGroup(event.target.value as PayrollViewFilters['group']))}>{['hour','day','week','month','year'].map(value=><option key={value} value={value}>{value[0].toUpperCase()+value.slice(1)}</option>)}</select></label><label className="payroll-compare-toggle"><input type="checkbox" checked={comparePrevious} disabled={!!busy||!!viewTask} onChange={event=>changeFilters(()=>setComparePrevious(event.target.checked))}/><span><strong>Compare with previous period</strong><small>Same number of calendar days, immediately before this range.</small></span><ArrowRightLeft size={21}/></label></div>
        <p className="payroll-capture">Inclusive calendar dates · {zone}{data&&<> · Captured {DateTime.fromISO(data.report.asOf).setZone(zone).toFormat('LLL d, h:mm:ss a')}</>}</p>
      </section>
      {error&&<div className="payroll-error" role="alert"><strong>Hours could not be loaded.</strong><p>{error}</p><button className="button secondary" onClick={()=>setVersion(v=>v+1)}>Try again</button></div>}
      {loading&&<div className="payroll-loading" role="status"><div/><div/><div/><span>Gathering recorded hours…</span></div>}
      {comparePrevious&&<section className="payroll-comparison-shell" aria-label="Period comparison">{reviewLoading&&<p className="payroll-capture" role="status">Comparing two periods from one recorded-time snapshot…</p>}{reviewError&&<div className="payroll-view-error" role="alert"><strong>Comparison could not be loaded.</strong><p>{reviewError}</p><button type="button" onClick={()=>setVersion(value=>value+1)}>Retry comparison</button></div>}{review&&<PayrollComparison key={key} review={review} busy={busy} onExport={exportComparison}/>}</section>}
      {data&&totals&&<>
        <div className="payroll-kpis">
          <article className="payroll-kpi work"><span><Clock3 size={20}/>Work hours</span><strong>{displayHours(totals.workMicroseconds)}<small> h</small></strong><p>Breaks are shown separately</p></article>
          <article className="payroll-kpi breaks"><span><Layers3 size={20}/>Break hours</span><strong>{displayHours(totals.breakMicroseconds)}<small> h</small></strong><p>Paid-break policy not applied</p></article>
          <article className="payroll-kpi people"><span><Users size={20}/>Employees</span><strong>{totals.employeeCount}</strong><p>With records in this period</p></article>
          <article className="payroll-kpi shifts"><span><Fingerprint size={20}/>Recorded shifts</span><strong>{totals.shiftCount}</strong><p>{totals.segmentCount} included time segments</p></article>
        </div>
        <div className="payroll-review-grid">
          <section className="payroll-review-card"><div className="payroll-section-title"><div><span className="eyebrow">02 · CHECK THE DETAILS</span><h3>A quick review before export</h3></div><ShieldCheck size={25}/></div>
            <p className="payroll-preparation-caption"><span><ShieldCheck size={15}/>Review required</span>{review&&<>Evidence captured {DateTime.fromISO(review.asOf).setZone(zone).toFormat('LLL d, h:mm:ss a')}</>}</p>
            {reviewLoading&&<p className="payroll-capture" role="status">Loading preparation evidence…</p>}
            {reviewError&&<div className="payroll-view-error" role="alert"><strong>Preparation evidence is unavailable.</strong><p>{reviewError}</p><button type="button" onClick={()=>setVersion(value=>value+1)}>Retry preparation review</button></div>}
            {review&&<><div className="payroll-check-row"><span className={review.preparation.openSegmentCount?'needs-review':'checked'}><Clock3 size={19}/></span><div><strong>{review.preparation.openSegmentCount?`${review.preparation.openSegmentCount} open time ${review.preparation.openSegmentCount===1?'segment':'segments'}`:'No open segments in this selection'}</strong><p>{review.preparation.openSegmentCount?`${review.preparation.employeesWithOpenSegments} employees have segments without a recorded end in this range. Their hours can change.`:'This source has no segments without a recorded end. It does not establish payroll approval.'}</p></div><button onClick={onNavigateRecords}>Review<ArrowRight size={15}/></button></div>
            <div className="payroll-check-row"><span className="policy"><Info size={19}/></span><div><strong>Corrections need a separate review</strong><p>{review.preparation.pendingCorrections.notice}</p></div><button onClick={onNavigateRecords}>Time records<ArrowRight size={15}/></button></div>
            <div className="payroll-check-row"><span className="checked"><Fingerprint size={19}/></span><div><strong>{review.evidence.currentSourceRows} source segments captured</strong><p>Recorded identities, time evidence and exact microseconds support this snapshot. Exports capture current permitted records again.</p></div></div></>}
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
    {ownedEditor&&<Modal title={ownedEditor.revision===undefined?'Save payroll view':'Edit payroll view'} onClose={closeEditor}><form className="payroll-view-editor" onSubmit={event=>{event.preventDefault();void saveView();}}><p>Save a personal set of filters. Relative periods follow the organization's calendar when opened.</p><label>View name<input autoFocus value={ownedEditor.name} maxLength={80} required disabled={viewTask==='save'} onChange={event=>setEditor(current=>current?{...current,name:event.target.value}:null)}/></label><div className="payroll-editor-summary"><Bookmark size={20}/><div><strong>Filters to save</strong><p>{viewSummary(ownedEditor.filters)}</p></div></div>{editorError&&<div className="payroll-view-error" role="alert">{editorError}<p>Your draft is still here. A revision conflict requires reopening the latest view before editing again.</p></div>}<div className="payroll-editor-actions"><button type="button" className="button secondary" disabled={viewTask==='save'} onClick={closeEditor}>Cancel</button><button type="submit" className="button primary" disabled={viewTask==='save'||!ownedEditor.name.trim()||!editorDirty}><Save size={17}/>{viewTask==='save'?'Saving…':'Save view'}</button></div></form></Modal>}
  </section>;
}


const signedTime=(value:string)=>{const amount=BigInt(value);return (amount<0n?'−':amount>0n?'+':'')+formatWorkforceDuration(String(amount<0n?-amount:amount));};
const signedHours=(value:string)=>{const amount=BigInt(value);return (amount<0n?'−':amount>0n?'+':'')+displayHours(String(amount<0n?-amount:amount));};
const periodState={complete:'Complete period',in_progress:'Period in progress',future:'Future period'} as const;
function PayrollComparison({review,busy,onExport}:{review:PayrollReview;busy:string|null;onExport:(format:'csv'|'json')=>Promise<void>}){
  const [metric,setMetric]=useState<'work'|'break'>('work'),[selected,setSelected]=useState(''),[inspect,setInspect]=useState<'current'|'previous'>('current'),[find,setFind]=useState(''),[page,setPage]=useState(0);
  const employee=review.employees.find(row=>row.userId===selected),values=employee??review.totals,field=metric==='work'?'workMicroseconds':'breakMicroseconds';
  const current=values.current[field],previous=values.previous[field],maximum=BigInt(current)>BigInt(previous)?current:previous;
  const people=review.employees.filter(row=>row.name.toLocaleLowerCase().includes(find.trim().toLocaleLowerCase()));
  const greatest=review.employees.reduce((max,row)=>{const a=BigInt(row.current[field]),b=BigInt(row.previous[field]);return [max,a,b].reduce((largest,value)=>value>largest?value:largest);},0n).toString();
  const pages=Math.max(1,Math.ceil(people.length/8)),currentPage=Math.min(page,pages-1);
  const percent=values.delta.workPercentChange,percentText=percent===null?'No previous work baseline':(percent.startsWith('-')?'':BigInt(values.delta.workMicroseconds)>0n?'+':'')+percent.replace(/\.?0+$/,'')+'% work change';
  const partial=review.periods.current.status!=='complete'||review.periods.previous.status!=='complete';
  const range=(side:'current'|'previous')=>`${DateTime.fromISO(review.periods[side].start).toFormat('LLL d, yyyy')} – ${DateTime.fromISO(review.periods[side].end).toFormat('LLL d, yyyy')}`;
  return <>
    <div className="payroll-compare-heading"><span className="payroll-compare-symbol" aria-hidden="true"><ChartNoAxesCombined size={26}/></span><div><span className="eyebrow">SEE WHAT CHANGED</span><h3>Two periods. One clear comparison.</h3><p>{review.periods.current.calendarDays} calendar days each · {review.timezone}</p></div></div>
    <div className="payroll-compare-periods">{(['current','previous'] as const).map(side=><div key={side} className={side}><span>{side==='current'?'Selected period':'Previous period'}</span><strong>{range(side)}</strong><small className={'period-state '+review.periods[side].status}>{periodState[review.periods[side].status]}</small></div>)}</div>
    {partial&&<div className="payroll-compare-warning" role="note"><Info size={19}/><p>One or both periods are incomplete or in the future. Hours are shown as captured, without projecting or adjusting them to a full period. Compare the dates and period labels before interpreting the change.</p></div>}
    <div className="payroll-compare-selection"><label>Comparison focus<select aria-label="Comparison focus" value={selected} onChange={event=>setSelected(event.target.value)}><option value="">All employees across both periods</option>{review.employees.map(row=><option key={row.userId} value={row.userId}>{row.name}{row.current.segmentCount===0?' · previous period only':''}</option>)}</select></label><div className="payroll-compare-metric" role="group" aria-label="Comparison chart metric"><button type="button" aria-pressed={metric==='work'} onClick={()=>setMetric('work')}>Work</button><button type="button" aria-pressed={metric==='break'} onClick={()=>setMetric('break')}>Breaks</button></div></div>
    <h4 className="payroll-compare-person">{employee?.name??'All employees'}{employee&&<button type="button" onClick={()=>setSelected('')}>Show everyone</button>}</h4>
    <div className="payroll-compare-stat-grid"><article className="current"><span>Selected work hours</span><strong>{displayHours(values.current.workMicroseconds)}<small> h</small></strong></article><article className="previous"><span>Previous work hours</span><strong>{displayHours(values.previous.workMicroseconds)}<small> h</small></strong></article><article className="change"><span>Recorded work difference</span><strong title={signedTime(values.delta.workMicroseconds)}>{signedHours(values.delta.workMicroseconds)}<small> h</small></strong><p>{percentText}</p></article></div>
    <div className="payroll-paired-chart" role="group" aria-label={`${metric==='work'?'Work':'Break'} hours comparison chart`}>{(['current','previous'] as const).map(side=>{const value=values[side][field],label=side==='current'?'Selected period':'Previous period';return <button type="button" key={side} className={side+(inspect===side?' inspected':'')} aria-pressed={inspect===side} aria-label={`${label} ${metric} hours`} title={`${label}: ${formatWorkforceDuration(value)}`} onClick={()=>setInspect(side)} onMouseEnter={()=>setInspect(side)} onFocus={()=>setInspect(side)}><span>{label}</span><i><b style={{width:workforceBarPercent(value,maximum)+'%'}}/></i><strong>{displayHours(value)} h</strong></button>;})}</div>
    <p className="payroll-chart-inspection" role="status"><span className={'payroll-chart-key '+inspect}/><strong>{inspect==='current'?'Selected period':'Previous period'} {metric==='work'?'work':'breaks'}:</strong> {formatWorkforceDuration(values[inspect][field])}</p>
    <details className="payroll-comparison-exact"><summary>Exact comparison values</summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Exact period comparison"><table><caption>{employee?.name??'All employees'} · exact recorded duration</caption><thead><tr><th>Recorded time</th><th>Selected period</th><th>Previous period</th><th>Change</th></tr></thead><tbody>{(['work','break','total'] as const).map(kind=><tr key={kind}><th>{kind==='work'?'Work':kind==='break'?'Breaks':'Work + breaks'}</th><td>{formatWorkforceDuration(values.current[`${kind}Microseconds`])}</td><td>{formatWorkforceDuration(values.previous[`${kind}Microseconds`])}</td><td>{signedTime(values.delta[`${kind}Microseconds`])}</td></tr>)}<tr><th>Recorded shifts</th><td>{values.current.shiftCount}</td><td>{values.previous.shiftCount}</td><td>{values.current.shiftCount-values.previous.shiftCount}</td></tr></tbody></table></div></details>
    <div className="payroll-union-heading"><div><h4>People across both periods</h4><p>Includes employees with records only in the previous period. Select a person to explore.</p></div><span>{review.employees.length} people</span></div>
    <label className="payroll-union-search"><Search size={17}/><input aria-label="Find a comparison employee" placeholder="Find someone across both periods…" value={find} onChange={event=>{setFind(event.target.value);setPage(0);}}/></label>
    <div className="payroll-comparison-people">{people.slice(currentPage*8,(currentPage+1)*8).map(row=><button type="button" key={row.userId} className={'payroll-comparison-person'+(row.userId===selected?' selected':'')} aria-label={`Compare ${row.name}`} aria-pressed={row.userId===selected} onClick={()=>setSelected(row.userId)}><span className="payroll-comparison-identity"><strong>{row.name}</strong><small>{row.current.segmentCount===0?'Previous period only':row.previous.segmentCount===0?'Selected period only':'Recorded in both periods'}</small></span><span className="payroll-employee-pair" aria-hidden="true"><i className="current"><b style={{width:workforceBarPercent(row.current[field],greatest)+'%'}}/></i><i className="previous"><b style={{width:workforceBarPercent(row.previous[field],greatest)+'%'}}/></i></span><span className="payroll-pair-values"><strong>Selected {displayHours(row.current[field])} h</strong><small>Previous {displayHours(row.previous[field])} h</small></span></button>)}</div>
    {!people.length&&<p className="payroll-capture">{review.employees.length?'No names match this search.':'Neither period has recorded employees in this selection.'}</p>}
    {pages>1&&<div className="payroll-comparison-pagination"><button type="button" disabled={currentPage===0} onClick={()=>setPage(value=>value-1)}>Previous people</button><span>Page {currentPage+1} of {pages}</span><button type="button" disabled={currentPage+1>=pages} onClick={()=>setPage(value=>value+1)}>Next people</button></div>}
    <p className="payroll-comparison-footnote">Chart hours are rounded to two places; percentages to six. Exact durations remain available above. Chart focus and name search do not change export filters. Both periods were captured together at {DateTime.fromISO(review.asOf).setZone(review.timezone).toFormat('LLL d, h:mm:ss a')}; payroll-hours downloads take a fresh capture.</p>
    <div className="payroll-comparison-downloads"><button type="button" disabled={!!busy} onClick={()=>void onExport('csv')}><ArrowDownToLine size={16}/>{busy==='review-csv'?'Preparing…':'Comparison CSV'}</button><button type="button" disabled={!!busy} onClick={()=>void onExport('json')}><ArrowDownToLine size={16}/>{busy==='review-json'?'Preparing…':'Comparison JSON'}</button></div>
    <details className="payroll-comparison-notes"><summary>How to read this comparison</summary><p>{review.notice}</p></details>
  </>;
}
