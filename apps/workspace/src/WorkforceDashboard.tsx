import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DateTime } from 'luxon';
import { ArrowRight, BarChart3, ChartNoAxesCombined, Clock3, Coffee, Layers3, RefreshCw, Users, Wallet, ChevronLeft, ChevronRight, Search, CalendarDays, ChevronDown, ArrowUpRight } from 'lucide-react';
import { api, ApiError } from './api';
import { workforceReportQueryV2Schema, workforceReportV2Schema, type WorkforceReportV2 } from '../shared/workforce-reports-v2';
import { compactWorkDuration, decimalWorkHours, exactDescending, visualRatio, workforceMix, workforceDonutSlices, workforceLiveElapsed, workforceClockLabel } from '../shared/workforce-visuals';
import { formatWorkforceDuration, exactWorkforceTimestamp } from '../shared/workforce-display';
import './workforce-dashboard.css';
import type {TeamBoardState} from './WorkspaceTools';
import {Modal} from './components';
import {AllowanceReviewActions,RetainedAllowanceReviews} from './WorkforceAllowanceReview';
import {workforceOverviewSchema,workforceOverviewQuerySchema,type WorkforceOverview,type WorkforceOverviewQuery,type AllowancePeriod,type AllowanceMetrics} from '../shared/workforce-overview';

type Target = 'clock' | 'time-records' | 'payroll' | 'staff' | 'requests' | 'schedule';
type Props = { me: any; board: any[]; boardState?:TeamBoardState; onNavigate: (target: Target) => void; onRefresh?:()=>void };
type DetailsProps=Props&{initialUserId?:string;initialUnitId?:string;initialStart?:string;initialEnd?:string};
const colours = ['#8b5cf6', '#12b8a6', '#f48455', '#3e9ce8', '#db60ad', '#d2a224', '#608aef', '#849398'];
type ChartKind = 'area' | 'line' | 'bar';
const groups = ['hour', 'day', 'week', 'month', 'year'] as const;
function Exact({ value }: { value: string }) { return <span>{formatWorkforceDuration(value)}</span>; }

function WorkforceDetails({ me, board, boardState, onNavigate,initialUserId,initialUnitId,initialStart,initialEnd }: DetailsProps) {
  const zone = me.organization.timezone as string;
  const today = DateTime.now().setZone(zone);
  const [start, setStart] = useState(initialStart??today.startOf('week').toISODate()!), [end, setEnd] = useState(initialEnd??today.toISODate()!);
  const [group, setGroup] = useState<typeof groups[number]>('day'), [unit, setUnit] = useState(initialUnitId??''), [user, setUser] = useState(initialUserId??'');
  const [chart, setChart] = useState<ChartKind>('area'), [mixBy, setMixBy] = useState<'job' | 'unit'>('job');
  const [selected, setSelected] = useState(0), [selectedMix, setSelectedMix] = useState('');
  const [table, setTable] = useState<'periods' | 'people' | 'records'>('periods'), [tableOpen, setTableOpen] = useState(false), [page, setPage] = useState(0), [job, setJob] = useState('');
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true), [plotWidth, setPlotWidth] = useState(700);
  const [loaded, setLoaded] = useState<{ key: string; data: WorkforceReportV2 } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [choices, setChoices] = useState<{ key: string; rows: { userId: string; name: string }[] } | null>(null);
  const identity = `${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`;
  const queryObject = { start, end, group, ...(unit ? { unitId: unit } : {}), ...(user ? { userId: user } : {}) };
  const query = new URLSearchParams(queryObject).toString(), key = identity + ':' + query;
  const choiceKey = `${identity}:${start}:${end}:${unit}`;
  const current = useRef(key); current.current = key;
  const request = useRef(0), tableRef = useRef<HTMLDivElement>(null), chartRef = useRef<HTMLDivElement>(null);
  const gradientId = useId().replace(/:/g, ''), tableId = useId();
  const report = loaded?.key === key ? loaded.data : null;
  const error = failure?.key === key ? failure.message : '';
  const allowed = me.actor.mode === 'password' && Boolean(me.permissions?.report);
  const canPay = ['developer', 'owner', 'admin', 'finance'].includes(me.actor.role);
  const canManage = Boolean(me.permissions?.manage);
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const resize = () => setPlotWidth(Math.max(280, Math.floor(element.getBoundingClientRect().width)));
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, [report]);

  useEffect(() => {
    const controller = new AbortController(), generation = ++request.current, capturedKey = key;
    const matches = () => !controller.signal.aborted && request.current === generation && current.current === capturedKey;
    setLoaded(null); setFailure(null); setLoading(true); setSelected(0); setSelectedMix(''); setPage(0);
    if (!allowed) { setLoading(false); setChoices(null); return () => controller.abort(); }
    const validation = workforceReportQueryV2Schema.safeParse(queryObject);
    if (!validation.success) {
      setFailure({ key, message: validation.error.issues[0]?.message ?? 'Choose a valid date range.' }); setLoading(false);
      return () => controller.abort();
    }
    void api('/reports/v2?' + query, undefined, 'GET', controller.signal).then(raw => {
      const value = workforceReportV2Schema.parse(raw);
      if (value.query.start !== start || value.query.end !== end || value.query.group !== group || (value.query.unitId ?? '') !== unit || (value.query.userId ?? '') !== user)
        throw new Error('The returned report does not match the selected filters.');
      if (!matches()) return;
      setLoaded({ key, data: value });
      if (!user) setChoices({ key: choiceKey, rows: value.staff.map(x => ({ userId: x.userId, name: x.name })) });
    }).catch(e => {
      if (!matches()) return;
      setLoaded(null);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setChoices(null);
      setFailure({ key, message: e instanceof ApiError ? e.message : 'The report could not be loaded. Refresh to try again.' });
    }).finally(() => { if (matches()) setLoading(false); });
    return () => controller.abort();
  }, [key, refresh, allowed]); // The key contains every source/account filter; no other request can publish into it.

  const mixes = useMemo(() => report ? workforceMix(report.rows, mixBy) : [], [report, mixBy]);
  const slices = workforceDonutSlices(mixes), mixTotal = mixes.reduce((sum, entry) => sum + BigInt(entry.duration), 0n).toString();
  const activeMix = slices.find(x => x.id === selectedMix);
  const people = useMemo(() => report ? [...report.staff].sort((a, b) => exactDescending(a.workMicroseconds, b.workMicroseconds) || a.name.localeCompare(b.name)) : [], [report]);
  const activeBucket = report?.buckets[Math.min(selected, Math.max(0, report.buckets.length - 1))];
  const maximum = report?.buckets.reduce((max, bucket) => BigInt(bucket.workMicroseconds) > max ? BigInt(bucket.workMicroseconds) : max, 0n) ?? 0n;
  const plotRight = plotWidth - 20, plotSpan = plotWidth - 68;
  const plotX = (index: number) => 48 + (report && report.buckets.length > 1 ? index / (report.buckets.length - 1) * plotSpan : plotSpan / 2);
  const plotY = (value: string) => 218 - visualRatio(value, maximum.toString()) * 176;
  const points = report?.buckets.map((bucket, index) => `${plotX(index)},${plotY(bucket.workMicroseconds)}`).join(' ') ?? '';
  const records = report?.rows.filter(row => !job || row.job_id === job) ?? [];
  const tableRows = table === 'periods' ? report?.buckets ?? [] : table === 'people' ? people : records;
  const lastPage = Math.max(0, Math.ceil(tableRows.length / 25) - 1), currentPage = Math.min(page, lastPage);
  const shownRows = tableRows.slice(currentPage * 25, (currentPage + 1) * 25);
  function preset(period: 'day' | 'week' | 'month' | 'year') {
    const now = DateTime.now().setZone(zone); setStart(now.startOf(period).toISODate()!); setEnd(now.toISODate()!);
    setGroup(period === 'year' ? 'month' : period === 'day' ? 'hour' : 'day'); setUser(''); setJob('');
  }
  function openTable(kind: typeof table, jobId = '') {
    setTable(kind); setTableOpen(true); setJob(jobId); setPage(0);
    requestAnimationFrame(() => tableRef.current?.focus());
  }
  function pointFromPointer(clientX: number) {
    if (!report?.buckets.length || !chartRef.current) return;
    const bounds = chartRef.current.getBoundingClientRect();
    const position = (clientX - bounds.left) / bounds.width * plotWidth;
    setSelected(Math.min(report.buckets.length - 1, Math.max(0, Math.round((position - 48) / plotSpan * (report.buckets.length - 1)))));
  }
  const axisLabel = (instant: string) => DateTime.fromISO(instant).setZone(zone).toFormat(group === 'hour' ? 'h a' : group === 'month' ? 'LLL yyyy' : group === 'year' ? 'yyyy' : 'LLL d');
  if (!allowed) return <section className="workforce-dashboard"><div className="wf-empty"><Clock3/><h2>Your time, one tap away</h2><p>Open your time clock to record work, change jobs or take a break.</p><button className="button primary" onClick={() => onNavigate('clock')}>Open my time clock <ArrowRight size={18}/></button></div></section>;

  return <section className="workforce-dashboard" aria-label="Detailed workforce reports">
    <div className="wf-toolbar"><div className="wf-presets" aria-label="Quick date ranges">{([['Today','day'],['This week','week'],['This month','month'],['This year','year']] as const).map(([label, period]) => <button type="button" key={period} onClick={() => preset(period)}>{label}</button>)}</div><button type="button" className="wf-refresh" onClick={() => setRefresh(x => x + 1)} disabled={loading}><RefreshCw size={16} className={loading ? 'wf-spinning' : ''}/>{loading ? 'Loading' : 'Refresh data'}</button></div>
    <div className="wf-filters">
      <label>From<input type="date" value={start} onChange={e => { setStart(e.target.value); setUser(''); }}/></label>
      <label>Through<input type="date" value={end} onChange={e => { setEnd(e.target.value); setUser(''); }}/></label>
      <label>Community<select aria-label="Community" value={unit} onChange={e => { setUnit(e.target.value); setUser(''); setJob(''); }}><option value="">All permitted communities</option>{(me.units ?? []).map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Employee<select aria-label="Employee" value={user} onChange={e => { setUser(e.target.value); setJob(''); }}><option value="">Everyone with recorded time</option>{(choices?.key === choiceKey ? choices.rows : report?.staff ?? []).map(item => <option key={item.userId} value={item.userId}>{item.name}</option>)}</select></label>
      <label>Group time by<select aria-label="Group time by" value={group} onChange={e => setGroup(e.target.value as typeof group)}>{groups.map(item => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
    </div>
    <p className="wf-scope">Dates use {zone}. Hourly views allow up to 32 days; other views allow up to 367 days. {user && <button type="button" onClick={() => setUser('')}>Clear employee filter</button>}</p>
    {error && <div className="wf-alert" role="alert"><strong>Report unavailable</strong><p>{error}</p><button type="button" onClick={() => setRefresh(x => x + 1)}>Try again</button></div>}
    <div className="wf-kpis" aria-busy={loading}>
      <article className="wf-kpi wf-violet"><span className="wf-kpi-icon"><Clock3/></span><span className="wf-kpi-label">Recorded work</span><strong>{report ? compactWorkDuration(report.workMicroseconds) : '—'}</strong><span>{report ? `${decimalWorkHours(report.workMicroseconds)} hours · rounded display` : 'Selected date range'}</span><details><summary>Exact recorded time</summary>{report ? <Exact value={report.workMicroseconds}/> : 'Load a report to view exact time.'}</details></article>
      <article className="wf-kpi wf-teal"><span className="wf-kpi-icon"><Users/></span><span className="wf-kpi-label">People contributing</span><strong>{report ? people.filter(item => BigInt(item.workMicroseconds) + BigInt(item.breakMicroseconds) > 0n).length : '—'}</strong><span>With recorded time in this range</span><button type="button" disabled={!report} onClick={() => openTable('people')}>Explore people <ArrowRight size={14}/></button></article>
      <article className="wf-kpi wf-peach"><span className="wf-kpi-icon"><Coffee/></span><span className="wf-kpi-label">Recorded breaks</span><strong>{report ? compactWorkDuration(report.breakMicroseconds) : '—'}</strong><span>{report ? `${decimalWorkHours(report.breakMicroseconds)} hours · rounded display` : 'Separate from work time'}</span><details><summary>Exact break time</summary>{report ? <Exact value={report.breakMicroseconds}/> : 'Load a report to view exact time.'}</details></article>
      <article className="wf-kpi wf-blue"><span className="wf-kpi-icon"><ChartNoAxesCombined/></span><span className="wf-kpi-label">On the clock now</span><strong>{report && !boardState?.unavailable && (!boardState || boardState.receivedAt) ? board.length : '—'}</strong><span>Latest team board · all permitted scopes</span><button type="button" onClick={() => onNavigate(canManage ? 'staff' : 'clock')}>{canManage ? 'Open people & jobs' : 'Open my clock'} <ArrowRight size={14}/></button></article>
    </div>

    <div className="wf-chart-grid">
      <article className="wf-card wf-trend"><header className="wf-card-header"><div><span className="wf-eyebrow">THE RHYTHM OF YOUR TEAM</span><h2>Hours over time</h2></div><div className="wf-segmented" aria-label="Chart style">{(['area','line','bar'] as const).map(kind => <button type="button" key={kind} aria-pressed={chart === kind} onClick={() => setChart(kind)}>{kind[0].toUpperCase()+kind.slice(1)}</button>)}</div></header>
      {loading ? <div className="wf-chart-empty" role="status">Loading your recorded hours…</div> : !report?.buckets.length ? <div className="wf-chart-empty">{error ? 'Refresh after resolving the report error.' : 'No time recorded in this range. Choose another date range to explore.'}</div> : <>
        <div className="wf-chart-detail" aria-live="polite"><span>{activeBucket?.label}</span><strong>{activeBucket ? compactWorkDuration(activeBucket.workMicroseconds) : '0s'}</strong><span>Work: {activeBucket && <Exact value={activeBucket.workMicroseconds}/>} · Breaks: {activeBucket && <Exact value={activeBucket.breakMicroseconds}/>}</span></div>
        <div ref={chartRef} className="wf-plot" role="slider" tabIndex={0} aria-label="Recorded work by period. Use left and right arrow keys to explore." aria-valuemin={0} aria-valuemax={Math.max(0, report.buckets.length - 1)} aria-valuenow={selected} aria-valuetext={activeBucket ? `${activeBucket.label}: ${formatWorkforceDuration(activeBucket.workMicroseconds)} work, ${formatWorkforceDuration(activeBucket.breakMicroseconds)} breaks` : ''} onPointerMove={e => { if (e.pointerType === 'mouse' || e.buttons) pointFromPointer(e.clientX); }} onPointerDown={e => { pointFromPointer(e.clientX); e.currentTarget.focus(); }} onKeyDown={e => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return; e.preventDefault(); setSelected(index => e.key === 'Home' ? 0 : e.key === 'End' ? report.buckets.length - 1 : Math.max(0, Math.min(report.buckets.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1)))); }}>
          <svg viewBox={`0 0 ${plotWidth} 264`} aria-hidden="true" preserveAspectRatio="none"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9b79f5" stopOpacity=".5"/><stop offset="100%" stopColor="#9b79f5" stopOpacity=".02"/></linearGradient></defs>
          {[0,1,2,3,4].map(tick => <g key={tick}><line x1="48" x2={plotRight} y1={42+44*tick} y2={42+44*tick} className="wf-gridline"/><text x="4" y={46+44*tick}>{decimalWorkHours((maximum * BigInt(4-tick) / 4n).toString())}h</text></g>)}
          {chart === 'area' && report.buckets.length > 1 && <polygon points={`48,218 ${points} ${plotRight},218`} fill={`url(#${gradientId})`}/>}
          {chart !== 'bar' && <polyline points={points} fill="none" stroke="#8b5cf6" strokeWidth="4" vectorEffect="non-scaling-stroke"/>}
          {chart === 'bar' && report.buckets.map((bucket,index) => <rect key={bucket.key} x={plotX(index)-Math.min(28,plotSpan*.9/report.buckets.length)/2} y={plotY(bucket.workMicroseconds)} width={Math.min(28,plotSpan*.9/report.buckets.length)} height={218-plotY(bucket.workMicroseconds)} rx="3" fill={index===selected?'#b69bf8':'#8354e5'}/>)}
          {activeBucket && <><line x1={plotX(selected)} x2={plotX(selected)} y1="30" y2="218" stroke="#8b5cf6" strokeDasharray="4 5"/><circle cx={plotX(selected)} cy={plotY(activeBucket.workMicroseconds)} r="6" fill="#fff" stroke="#8150e6" strokeWidth="3"/></>}
          <text x="48" y="254">{axisLabel(report.buckets[0].startsAt)}</text><text x={plotRight} y="254" textAnchor="end">{axisLabel(report.buckets.at(-1)!.startsAt)}</text></svg>
        </div><div className="wf-chart-footer"><span>Touch, hover or use arrow keys. Vertical axis: rounded decimal hours.</span><button type="button" onClick={() => openTable('periods')}>View all exact totals <ArrowRight size={15}/></button></div>
      </>}
      </article>
      <article className="wf-card wf-mix"><header className="wf-card-header"><div><span className="wf-eyebrow">WHERE THE WORK HAPPENS</span><h2>Work mix</h2></div><label className="wf-visually-label">Group work mix<select value={mixBy} aria-label="Group work mix" onChange={e => { setMixBy(e.target.value as typeof mixBy); setSelectedMix(''); }}><option value="job">By job</option><option value="unit">By community</option></select></label></header>
        <div className="wf-donut-wrap"><svg viewBox="0 0 220 220" role="img" aria-label={report ? `Recorded work split by ${mixBy}. Exact values and interactive controls follow.` : 'Work mix awaits report data.'}><circle cx="110" cy="110" r="79" fill="none" stroke="var(--border)" strokeWidth="28"/>{(() => { let offset=0; return slices.map((slice,index) => { const share=visualRatio(slice.duration,mixTotal)*100, previous=offset; offset+=share; return <circle key={slice.id} cx="110" cy="110" r="79" fill="none" pathLength="100" stroke={colours[index]} strokeWidth={activeMix?.id===slice.id?34:28} strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-previous} transform="rotate(-90 110 110)" onPointerEnter={()=>setSelectedMix(slice.id)} onPointerDown={()=>setSelectedMix(slice.id)}/>; }); })()}</svg><div className="wf-donut-center"><span>{activeMix ? activeMix.label : 'Recorded work'}</span><strong>{report ? compactWorkDuration(activeMix?.duration ?? mixTotal) : '—'}</strong><span>{activeMix ? 'Selected slice' : 'Selected range'}</span></div></div>
        {!loading && report && !slices.length && <p className="wf-no-work">No recorded work for this selection.</p>}
        <div className="wf-legend">{slices.map((slice,index) => <button type="button" key={slice.id} aria-pressed={selectedMix===slice.id} onClick={() => setSelectedMix(slice.id)} onFocus={() => setSelectedMix(slice.id)} style={{'--slice':colours[index]} as CSSProperties}><i/><span>{slice.label}</span><strong>{compactWorkDuration(slice.duration)}</strong></button>)}</div>
        {activeMix && <div className="wf-slice-detail" aria-live="polite"><strong>{activeMix.label}</strong><span><Exact value={activeMix.duration}/> of recorded work</span>{activeMix.id!=='__other__' && <button type="button" onClick={() => { if (mixBy==='unit') { setUnit(activeMix.id); setUser(''); setJob(''); } else openTable('records',activeMix.id); }}>Explore {mixBy==='job'?'these records':'this community'} <ArrowRight size={14}/></button>}</div>}
      </article>
    </div>

    <div className="wf-lower-grid"><article className="wf-card"><header className="wf-card-header"><div><span className="wf-eyebrow">EVERY PERSON COUNTS</span><h2>Time by employee</h2></div><button type="button" disabled={!report} onClick={() => openTable('people')}>View all {people.length} <ArrowRight size={15}/></button></header><p className="wf-subcopy">Recorded work, highest first. Select a person to explore their hours.</p><div className="wf-people">{people.slice(0,6).map((person,index) => <button type="button" className="wf-person" key={person.userId} onClick={() => { setUser(person.userId); setJob(''); }}><span className="wf-avatar" style={{'--slice':colours[index]} as CSSProperties}>{person.name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('')}</span><span className="wf-person-identity"><strong>{person.name}</strong><span className="wf-person-track"><i style={{width:visualRatio(person.workMicroseconds,people[0].workMicroseconds)*100+'%',background:colours[index]}}/></span></span><span className="wf-person-total">{compactWorkDuration(person.workMicroseconds)}<small>{decimalWorkHours(person.workMicroseconds)} h · rounded</small></span><ArrowRight size={16}/></button>)}{!loading&&!people.length&&<p className="wf-no-work">No employee time in this selection.</p>}</div></article>
    <article className="wf-payroll-card"><div className="wf-payroll-icon"><Wallet size={34}/></div><span className="wf-eyebrow">FROM HOURS TO THE NEXT STEP</span><h2>Payroll, with the details in reach.</h2><p>{canPay ? 'Review recorded time alongside employee pay information.' : 'Review dated employee hours and payroll reports.'} Hours here are recorded work and breaks; paid-time, overtime and leave rules are separate.</p><button type="button" onClick={() => onNavigate('payroll')}>Open payroll workspace <ArrowRight size={17}/></button><button type="button" onClick={() => onNavigate('requests')}>Review employee requests <ArrowRight size={17}/></button></article></div>

    <section className="wf-card wf-data"><header className="wf-card-header"><div><span className="wf-eyebrow">THE NUMBERS BEHIND THE PICTURE</span><h2>Your loaded data</h2></div><button type="button" aria-expanded={tableOpen} aria-controls={tableId} onClick={() => { setTableOpen(!tableOpen); setPage(0); }}>{tableOpen?'Hide data':'Explore data'} <ArrowRight size={15}/></button></header>
    {tableOpen && <div id={tableId} ref={tableRef} tabIndex={-1} className="wf-table-content"><div className="wf-segmented" aria-label="Loaded data view">{(['periods','people','records'] as const).map(kind=><button type="button" key={kind} aria-pressed={table===kind} onClick={()=>{setTable(kind);setPage(0);}}>{kind==='periods'?'Time periods':kind==='people'?'Employees':'Time records'}</button>)}</div>{job&&<p>Showing records for {report?.rows.find(row=>row.job_id===job)?.job_title ?? 'selected job'}. <button type="button" onClick={()=>{setJob('');setPage(0);}}>Show all jobs</button></p>}<div className="wf-table-scroll" tabIndex={0} role="region" aria-label="Exact recorded-time data"><table><caption>{table==='records'?'Recorded segments and their contribution to the selected range':'Exact recorded work and breaks'} · {tableRows.length} rows</caption><thead><tr>{table==='records'?<><th>Employee / job</th><th>Recorded start / end</th><th>Included time</th><th>Community</th></>:<><th>{table==='people'?'Employee':'Period'}</th><th>Work</th><th>Breaks</th><th>Work hours, rounded</th></>}</tr></thead><tbody>{shownRows.map((item:any,index)=><tr key={item.key??item.id??item.userId??index}>{table==='records'?<><td>{item.employee_name}<small>{item.job_title} · {item.kind}</small></td><td><time dateTime={item.started_at}>{exactWorkforceTimestamp(item.started_at,zone)}</time><small>{item.ended_at ? exactWorkforceTimestamp(item.ended_at,zone):'Open — no recorded end'}</small></td><td><Exact value={item.duration_microseconds}/></td><td>{item.unit_name}</td></>:<><td>{table==='people'?<button type="button" onClick={()=>setUser(item.userId)}>{item.name}</button>:item.label}</td><td><Exact value={item.workMicroseconds}/></td><td><Exact value={item.breakMicroseconds}/></td><td>{decimalWorkHours(item.workMicroseconds)} h</td></>}</tr>)}</tbody></table>{!tableRows.length&&<p className="wf-no-work">No loaded rows.</p>}</div><div className="wf-pagination"><span>Page {currentPage+1} of {lastPage+1}</span><button type="button" aria-label="Previous data page" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={18}/></button><button type="button" aria-label="Next data page" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}><ChevronRight size={18}/></button></div></div>}
    <p className="wf-source-note">{report ? <>Recorded-time snapshot: {exactWorkforceTimestamp(report.asOf,report.timezone)}. {report.notice}</> : 'A report must load before any totals are available.'} Chart positions and decimal hours are display approximations; exact durations remain available in the data and detail controls. Refresh to sample current time.</p></section>
  </section>;
}


function useOverview(me:any,query:WorkforceOverviewQuery|null,refresh:string){
  const identity=`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`;
  const path=query?new URLSearchParams(query as Record<string,string>).toString():'',key=identity+':'+path;
  const current=useRef(key);current.current=key;
  const [loaded,setLoaded]=useState<{key:string;value:WorkforceOverview}|null>(null),[failure,setFailure]=useState<{key:string;message:string;denied:boolean}|null>(null),[loading,setLoading]=useState(false);
  useEffect(()=>{const controller=new AbortController(),captured=key;const owns=()=>!controller.signal.aborted&&current.current===captured;
    setFailure(null);if(!query){setLoading(false);return()=>controller.abort();}setLoading(true);
    const validated=workforceOverviewQuerySchema.safeParse(query);
    if(!validated.success){setFailure({key,message:'Choose a valid workforce date range.',denied:false});setLoading(false);return()=>controller.abort();}
    void api('/workforce/overview?'+path,undefined,'GET',controller.signal).then(raw=>{
      const value=workforceOverviewSchema.parse(raw),actual=value.selected.query;
      if(actual.start!==query.start||actual.end!==query.end||(actual.unitId??'')!==(query.unitId??'')||(actual.userId??'')!==(query.userId??''))throw new Error('Mismatched workforce selection.');
      if(owns())setLoaded({key,value});
    }).catch(error=>{if(owns()){setLoaded(null);setFailure({key,message:error instanceof ApiError?error.message:'Workforce hours could not load. Please refresh.',denied:error instanceof ApiError&&[401,403,404].includes(error.status)});}}).finally(()=>{if(owns())setLoading(false);});
    return()=>controller.abort();
  },[key,Boolean(query),refresh]);
  return {data:loaded?.key===key?loaded.value:null,error:failure?.key===key?failure.message:'',denied:failure?.key===key&&failure.denied,loading};
}
function ScheduleMeter({metrics,label='Worked against scheduled hours'}:{metrics:Pick<AllowanceMetrics,'workMicroseconds'|'scheduledMicroseconds'>&Partial<Pick<AllowanceMetrics,'aboveScheduledMicroseconds'>>;label?:string}){
  const maximum=BigInt(metrics.workMicroseconds)>BigInt(metrics.scheduledMicroseconds)?metrics.workMicroseconds:metrics.scheduledMicroseconds;
  return <div className="wf-schedule-meter" role="img" aria-label={`${label}: ${formatWorkforceDuration(metrics.workMicroseconds)} worked; ${formatWorkforceDuration(metrics.scheduledMicroseconds)} scheduled.`}><span className="wf-schedule-base" style={{width:visualRatio(metrics.scheduledMicroseconds,maximum)*100+'%'}}/><span className={'wf-schedule-actual '+(BigInt(metrics.aboveScheduledMicroseconds??'0')>0n?'over':'')} style={{width:visualRatio(metrics.workMicroseconds,maximum)*100+'%'}}/></div>;
}
function LiveWorkforce({rows,state,zone,today,onPerson,onRefresh}:{rows:any[];state?:TeamBoardState;zone:string;today:AllowancePeriod|null;onPerson:(id:string,name:string)=>void;onRefresh:()=>void}){
  const [filter,setFilter]=useState<'all'|'work'|'break'>('all'),[all,setAll]=useState(false),[tick,setTick]=useState(0),[online,setOnline]=useState(navigator.onLine);
  const anchor=useRef({receipt:state?.receivedAt,asOf:state?.asOf,at:performance.now()});
  if(anchor.current.receipt!==state?.receivedAt||anchor.current.asOf!==state?.asOf)anchor.current={receipt:state?.receivedAt,asOf:state?.asOf,at:performance.now()};
  useEffect(()=>{const changed=()=>setOnline(navigator.onLine);window.addEventListener('online',changed);window.addEventListener('offline',changed);const timer=window.setInterval(()=>setTick(value=>value+1),1000);return()=>{window.clearInterval(timer);window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
  const age=Math.max(0,performance.now()-anchor.current.at),live=online&&!state?.unavailable&&Boolean(state?.asOf)&&age<120000;
  const visible=rows.filter(row=>filter==='all'||row.kind===filter),shown=all?visible:visible.slice(0,6),working=rows.filter(row=>row.kind==='work').length,breaking=rows.filter(row=>row.kind==='break').length;
  const loading=state&&!state.receivedAt&&!state.unavailable;void tick;
  return <section className="wf-now" aria-label="Current team activity"><header className="wf-now-heading"><div><h2>Clocked in now <span>{state?.unavailable||loading?'—':rows.length}</span></h2><p>{state?.unavailable?'Current team unavailable':loading?'Loading current team…':`${working} working · ${breaking} on break`}</p></div><button type="button" className="wf-refresh" onClick={onRefresh}><RefreshCw size={16}/>Refresh</button></header>
    {state?.unavailable?<div className="wf-alert" role="status">The current team could not refresh. Try again to see who is clocked in.</div>:loading?<p className="wf-no-work" role="status">Loading team activity…</p>:<>
    {rows.length>0&&<div className="wf-now-filters" aria-label="Current team status">{(['all','work','break'] as const).map(value=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setAll(false);}}>{value==='all'?'Everyone':value==='work'?'Working':'On break'}</button>)}</div>}
    <div className="wf-now-grid">{shown.map(row=>{const ownJob=today?.jobs.find(item=>item.userId===row.user_id&&item.jobId===row.job_id),metrics=today?.people.find(item=>item.userId===row.user_id),elapsed=state?.asOf?workforceLiveElapsed(row.segment_started_at,state.asOf,live?age:0):null;
      return <article className={'wf-now-person '+(row.kind==='break'?'break':'work')} key={row.user_id}><div className="wf-now-person-heading"><span className="wf-now-symbol" aria-hidden="true">{row.kind==='break'?<Coffee size={20}/>:<Clock3 size={20}/>}</span><button type="button" className="wf-name-button" onClick={()=>onPerson(row.user_id,row.name)}>{row.name}<ArrowUpRight size={16}/></button><span className="wf-now-status">{row.kind==='break'?'Break':'Working'}</span></div><p className="wf-now-job">{row.job_title}<span>{row.unit_name}</span></p><div className="wf-running-time"><strong aria-live="off">{elapsed===null?'—':workforceClockLabel(elapsed)}</strong><span>{row.kind==='break'?'Current break':'Current work segment'}<small>Since {DateTime.fromISO(row.segment_started_at).setZone(zone).toFormat('h:mm a')}</small></span></div>
      {metrics?<><ScheduleMeter metrics={metrics}/><p className="wf-now-totals"><span>Today across included jobs</span><strong title={formatWorkforceDuration(metrics.workMicroseconds)}>{compactWorkDuration(metrics.workMicroseconds)} worked</strong><span>{BigInt(metrics.scheduledMicroseconds)>0n?compactWorkDuration(metrics.scheduledMicroseconds)+' scheduled':'No scheduled hours today'}</span>{ownJob&&<span>This job: {compactWorkDuration(ownJob.workMicroseconds)} worked</span>}</p>{BigInt(metrics.aboveScheduledMicroseconds)>0n&&<span className="wf-excess">{compactWorkDuration(metrics.aboveScheduledMicroseconds)} over daily schedule</span>}</>:<p className="wf-now-totals">Today’s totals {today?'have not appeared in this snapshot yet.':'are loading separately.'}</p>}</article>;
    })}</div>
    {!visible.length&&<p className="wf-no-work">{rows.length?'No one matches this status.':'No one is currently clocked in.'}</p>}{visible.length>6&&<button type="button" className="wf-show-team" onClick={()=>setAll(!all)}>{all?'Show fewer people':`Show all ${visible.length} people`}</button>}
    <p className="wf-live-note">{live?'Running clocks are display estimates.':!online?'Offline · clocks paused at the last confirmed time.':'Snapshot · refresh to update clocks.'}{state?.asOf&&<> Last confirmed {DateTime.fromISO(state.asOf).setZone(zone).toFormat('h:mm:ss a')}.</>} Worked totals include work only; breaks stay separate.</p></>}
  </section>;
}
function PeriodSummary({title,period,onChoose,selected}:{title:string;period:AllowancePeriod|null;onChoose:()=>void;selected:boolean}){
  return <button type="button" className={'wf-period-summary '+(selected?'selected':'')} onClick={onChoose} aria-pressed={selected}><span><CalendarDays size={17}/>{title}</span><strong>{period?compactWorkDuration(period.totals.workMicroseconds):'—'}</strong><span>Worked <i>·</i> {period?compactWorkDuration(period.totals.scheduledMicroseconds):'—'} scheduled</span>{period&&<ScheduleMeter metrics={period.totals}/>}<small>{period?BigInt(period.totals.aboveScheduledMicroseconds)>0n?compactWorkDuration(period.totals.aboveScheduledMicroseconds)+' over schedule':'No hours over schedule in this snapshot':'Loading totals…'}</small></button>;
}
function PersonOverview({period,name,zone,onExact}:{period:AllowancePeriod;name:string;zone:string;onExact:()=>void}){
  const totals=period.totals,maximum=period.days.reduce((max,row)=>{const next=BigInt(row.workMicroseconds)>BigInt(row.scheduledMicroseconds)?BigInt(row.workMicroseconds):BigInt(row.scheduledMicroseconds);return next>max?next:max;},0n).toString();
  return <div className="workforce-dashboard wf-person-overview"><p>{DateTime.fromISO(period.query.start).toFormat('MMM d, yyyy')} – {DateTime.fromISO(period.query.end).toFormat('MMM d, yyyy')} · {zone}</p><div className="wf-detail-metrics">{[['Worked',totals.workMicroseconds],['Scheduled',totals.scheduledMicroseconds],['Over schedule',totals.aboveScheduledMicroseconds],['Below scheduled totals',totals.belowScheduledMicroseconds],['Outside scheduled times',totals.unscheduledWorkMicroseconds]].map(([label,value])=><article key={label}><span>{label}</span><strong title={formatWorkforceDuration(value)}>{compactWorkDuration(value)}</strong></article>)}</div>
    <h3>Jobs & communities</h3>{period.jobs.map(job=><article className="wf-detail-job" key={job.jobId}><strong>{job.jobTitle}</strong><span>{job.unitName}</span><ScheduleMeter metrics={job}/><p>{compactWorkDuration(job.workMicroseconds)} worked · {compactWorkDuration(job.scheduledMicroseconds)} scheduled</p>{BigInt(job.unscheduledWorkMicroseconds)>0n&&<span>{compactWorkDuration(job.unscheduledWorkMicroseconds)} outside this job’s scheduled times</span>}</article>)}{!period.jobs.length&&<p>No work or scheduled hours for this selection.</p>}
    <h3>Day by day</h3><div className="wf-daily-comparison" aria-label={'Daily worked and scheduled hours for '+name}>{period.days.map(day=><div key={day.date}><strong>{day.label}</strong><div className="wf-day-track"><i style={{width:visualRatio(day.scheduledMicroseconds,maximum)*100+'%'}}/><b style={{width:visualRatio(day.workMicroseconds,maximum)*100+'%'}}/></div><span>{compactWorkDuration(day.workMicroseconds)} worked / {compactWorkDuration(day.scheduledMicroseconds)} scheduled</span>{BigInt(day.aboveScheduledMicroseconds)>0n&&<small className="wf-excess">{compactWorkDuration(day.aboveScheduledMicroseconds)} over</small>}</div>)}</div><p className="wf-live-note">{period.notice} Below scheduled totals include future scheduled time in this period.</p><button type="button" className="button primary" onClick={onExact}>View exact time records <ArrowRight size={16}/></button>
  </div>;
}
export default function WorkforceDashboard({me,board,boardState,onNavigate,onRefresh}:Props){
  const identity=`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`,allowed=me.actor.mode==='password'&&Boolean(me.permissions?.report),zone=me.organization.timezone;
  const [unit,setUnit]=useState(''),[period,setPeriod]=useState<'today'|'week'>('week'),[search,setSearch]=useState(''),[refresh,setRefresh]=useState(0),[showAll,setShowAll]=useState(false),[advanced,setAdvanced]=useState(false),[savedRevision,setSavedRevision]=useState(0),[exportDenied,setExportDenied]=useState(false);
  const [person,setPerson]=useState<{id:string;name:string;identity:string}|null>(null),[detail,setDetail]=useState<{userId:string;unitId:string;start:string;end:string}|null>(null),detailsRef=useRef<HTMLElement>(null);
  const now=DateTime.now().setZone(zone),query={start:now.startOf('week').toISODate()!,end:now.endOf('week').toISODate()!,...(unit?{unitId:unit}:{})};
  const refreshKey=String(refresh)+':'+(boardState?.receivedAt??''),overview=useOverview(me,allowed?query:null,refreshKey),selectedPeriod=overview.data?.[period]??null;
  const activePerson=person?.identity===identity?person:null,personQuery=activePerson&&selectedPeriod?{...selectedPeriod.query,userId:activePerson.id}:null,personReport=useOverview(me,personQuery,refreshKey);
  const people=(selectedPeriod?.people??[]).filter(row=>row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)),shown=showAll?people:people.slice(0,8),currentBoard=board.filter(row=>!unit||row.unit_id===unit);
  useEffect(()=>{setPerson(null);setDetail(null);setUnit('');setSearch('');setAdvanced(false);setExportDenied(false);},[identity]);
  useEffect(()=>{setShowAll(false);},[unit,period,search]);
  useEffect(()=>{if(advanced&&detail)requestAnimationFrame(()=>{detailsRef.current?.scrollIntoView({block:'start'});detailsRef.current?.focus({preventScroll:true});});},[advanced,detail]);
  function refreshAll(){setRefresh(value=>value+1);onRefresh?.();}
  function openPerson(id:string,name:string){setPerson({id,name,identity});}
  function exactPerson(){if(!activePerson||!selectedPeriod)return;setDetail({userId:activePerson.id,unitId:unit,start:selectedPeriod.query.start,end:selectedPeriod.query.end});setPerson(null);setAdvanced(true);}
  if(!allowed)return <section className="workforce-dashboard"><div className="wf-empty"><Clock3/><h2>Your time clock</h2><p>Clock in, change jobs or take a break.</p><button className="button primary" onClick={()=>onNavigate('clock')}>Open my time clock <ArrowRight size={18}/></button></div></section>;
  if(overview.denied||personReport.denied||exportDenied)return <section className="workforce-dashboard"><div className="wf-alert" role="alert"><h2>Workforce access changed</h2><p>Refresh your session to load the hours you are permitted to view.</p><button type="button" onClick={()=>window.location.reload()}>Refresh access</button></div></section>;
  return <section className="workforce-dashboard wf-simple" aria-label="Workforce dashboard"><header className="wf-simple-heading"><div><h1 id="workforce-heading">Team & hours</h1><p>{me.organization.name} · {unit?(me.units??[]).find((item:any)=>item.id===unit)?.name:'All permitted communities'}</p></div><button type="button" className="wf-primary-payroll" onClick={()=>onNavigate('payroll')}><Wallet size={20}/>Review payroll<ArrowRight size={17}/></button></header>
    <div className="wf-simple-scope"><label>Community<select aria-label="Dashboard community" value={unit} onChange={event=>{setUnit(event.target.value);setPerson(null);setDetail(null);setAdvanced(false);}}><option value="">All permitted communities</option>{(me.units??[]).map((item:any)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button type="button" onClick={()=>onNavigate('time-records')}>Review time records <ArrowRight size={15}/></button></div>
    <div className="wf-period-summaries" aria-label="Worked and scheduled hours" aria-busy={overview.loading}><PeriodSummary title="Today" period={overview.data?.today??null} selected={period==='today'} onChoose={()=>setPeriod('today')}/><PeriodSummary title="This week" period={overview.data?.week??null} selected={period==='week'} onChoose={()=>setPeriod('week')}/></div>
    <LiveWorkforce rows={currentBoard} state={boardState} zone={zone} today={overview.data?.today??null} onPerson={openPerson} onRefresh={refreshAll}/>
    {overview.error&&<div className="wf-alert" role="alert"><strong>Hours unavailable</strong><p>{overview.error}</p><button type="button" onClick={refreshAll}>Retry hours</button></div>}
    <AllowanceReviewActions me={me} period={selectedPeriod} label={period==='today'?'Today':'This week'} onSaved={()=>setSavedRevision(value=>value+1)} onDenied={()=>setExportDenied(true)}/>
    <section className="wf-card wf-schedule-review" aria-label="Employee schedule comparison"><header className="wf-card-header"><div><h2>{period==='today'?'Today':'This week'} by employee</h2><p>{selectedPeriod?`${DateTime.fromISO(selectedPeriod.query.start).toFormat('MMM d')} – ${DateTime.fromISO(selectedPeriod.query.end).toFormat('MMM d, yyyy')}`:'Loading scheduled and worked hours…'}</p></div>{Boolean(me.permissions?.manage)&&<button type="button" onClick={()=>onNavigate('schedule')}><CalendarDays size={16}/>Edit schedules</button>}</header><label className="wf-employee-search"><Search size={17}/><span className="visually-hidden">Find an employee in the hours overview</span><input aria-label="Find an employee in the hours overview" placeholder="Find an employee" value={search} onChange={event=>setSearch(event.target.value)}/></label>
    <div className="wf-scheduled-people">{shown.map(row=>{const jobs=selectedPeriod?.jobs.filter(job=>job.userId===row.userId)??[];return <button type="button" className="wf-scheduled-person" key={row.userId} onClick={()=>openPerson(row.userId,row.name)}><div><strong>{row.name}</strong><span>{[...new Set(jobs.map(job=>job.jobTitle+' · '+job.unitName))].join(' / ')}</span></div><div className="wf-hours-pair"><strong title={formatWorkforceDuration(row.workMicroseconds)}>{compactWorkDuration(row.workMicroseconds)}<small>worked</small></strong><span title={formatWorkforceDuration(row.scheduledMicroseconds)}>{compactWorkDuration(row.scheduledMicroseconds)}<small>scheduled</small></span></div><ScheduleMeter metrics={row}/><div className="wf-scheduled-tags">{BigInt(row.aboveScheduledMicroseconds)>0n?<span className="wf-excess">{compactWorkDuration(row.aboveScheduledMicroseconds)} over schedule</span>:<span>{BigInt(row.scheduledMicroseconds)>0n?'No hours over schedule':'No scheduled hours'}</span>}{BigInt(row.belowScheduledMicroseconds)>0n&&<span>{compactWorkDuration(row.belowScheduledMicroseconds)} below scheduled totals</span>}{BigInt(row.unscheduledWorkMicroseconds)>0n&&<span>{compactWorkDuration(row.unscheduledWorkMicroseconds)} outside scheduled times</span>}<span>Details <ArrowUpRight size={14}/></span></div></button>;})}</div>{!overview.loading&&!people.length&&<p className="wf-no-work">{search?'No matching employees.':overview.error?'Reload the hours to see this comparison.':'No work or scheduled hours in this selection.'}</p>}{people.length>8&&<button type="button" className="wf-show-team" onClick={()=>setShowAll(!showAll)}>{showAll?'Show fewer employees':`Show all ${people.length} employees`}</button>}
    <details className="wf-hours-help"><summary>How scheduled hours are compared</summary><p>{selectedPeriod?.notice??'Scheduled shift hours are the allowance. Worked hours exclude breaks. Hours over schedule compare each employee’s total work across jobs with their daily scheduled allowance; a shorter day does not erase another day’s excess. Job details identify work outside that job’s scheduled times separately. Future scheduled time is included in the selected calendar period. These planning comparisons do not calculate paid overtime.'} Below scheduled totals include future scheduled time in this period.</p></details>{overview.data&&<p className="wf-live-note">Hours refreshed {DateTime.fromISO(overview.data.asOf).setZone(zone).toFormat('h:mm:ss a')} · {zone}.</p>}
    </section>
    <section className="wf-more-reports" ref={detailsRef} tabIndex={-1}><button type="button" aria-expanded={advanced} className="wf-details-toggle" onClick={()=>{setAdvanced(!advanced);if(advanced)setDetail(null);}}><BarChart3 size={20}/><span><strong>{advanced?'Hide detailed reports':'Detailed reports & charts'}</strong><small>Choose dates, explore charts and review exact records</small></span><ChevronDown size={19}/></button>{advanced&&<><RetainedAllowanceReviews me={me} refresh={savedRevision} onDenied={()=>setExportDenied(true)}/><WorkforceDetails key={JSON.stringify(detail)+':'+unit} me={me} board={board} boardState={boardState} onNavigate={onNavigate} initialUserId={detail?.userId} initialUnitId={detail?.unitId??unit} initialStart={detail?.start} initialEnd={detail?.end}/></>}</section>
    {activePerson&&<Modal title={activePerson.name+' · hours'} onClose={()=>setPerson(null)}>{personReport.error?<p role="alert">{personReport.error}</p>:!personReport.data?<p role="status">Loading this employee’s hours…</p>:<PersonOverview name={activePerson.name} period={personReport.data.selected} zone={zone} onExact={exactPerson}/>}</Modal>}
  </section>;
}
