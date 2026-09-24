import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DateTime } from 'luxon';
import { ArrowRight, BarChart3, ChartNoAxesCombined, Clock3, Coffee, Layers3, RefreshCw, Users, Wallet, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, ApiError } from './api';
import { workforceReportQueryV2Schema, workforceReportV2Schema, type WorkforceReportV2 } from '../shared/workforce-reports-v2';
import { compactWorkDuration, decimalWorkHours, exactDescending, visualRatio, workforceMix, workforceDonutSlices } from '../shared/workforce-visuals';
import { formatWorkforceDuration, exactWorkforceTimestamp } from '../shared/workforce-display';
import './workforce-dashboard.css';
import {LiveTeam,type TeamBoardState} from './WorkspaceTools';

type Target = 'clock' | 'time-records' | 'payroll' | 'staff' | 'requests';
type Props = { me: any; board: any[]; boardState?:TeamBoardState; onNavigate: (target: Target) => void };
const colours = ['#8b5cf6', '#12b8a6', '#f48455', '#3e9ce8', '#db60ad', '#d2a224', '#608aef', '#849398'];
type ChartKind = 'area' | 'line' | 'bar';
const groups = ['hour', 'day', 'week', 'month', 'year'] as const;
function Exact({ value }: { value: string }) { return <span>{formatWorkforceDuration(value)}</span>; }

export default function WorkforceDashboard({ me, board, boardState, onNavigate }: Props) {
  const zone = me.organization.timezone as string;
  const today = DateTime.now().setZone(zone);
  const [start, setStart] = useState(today.startOf('week').toISODate()!), [end, setEnd] = useState(today.toISODate()!);
  const [group, setGroup] = useState<typeof groups[number]>('day'), [unit, setUnit] = useState(''), [user, setUser] = useState('');
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

  return <section className="workforce-dashboard" aria-label="Workforce dashboard">
    <header className="wf-hero">
      <div className="wf-hero-copy"><span className="wf-eyebrow">YOUR PEOPLE. YOUR PICTURE.</span><h2>Good work, beautifully clear.</h2><p>See where the hours go. Keep your team moving.</p><div className="wf-hero-actions"><button type="button" onClick={() => onNavigate('time-records')}>Review time <ArrowRight size={16}/></button><button type="button" onClick={() => onNavigate('payroll')}><Wallet size={17}/> Payroll workspace <ArrowRight size={16}/></button></div></div>
      <div className="wf-sculpture" aria-hidden="true"><div className="wf-orbit"/><div className="wf-art-tile wf-art-back"><Layers3/></div><div className="wf-art-tile wf-art-front"><BarChart3/><span>STJW</span></div><span className="wf-art-sphere"/><span className="wf-art-dot"/></div>
    </header>

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

    <LiveTeam rows={board} zone={zone} state={boardState}/>
    <div className="wf-lower-grid"><article className="wf-card"><header className="wf-card-header"><div><span className="wf-eyebrow">EVERY PERSON COUNTS</span><h2>Time by employee</h2></div><button type="button" disabled={!report} onClick={() => openTable('people')}>View all {people.length} <ArrowRight size={15}/></button></header><p className="wf-subcopy">Recorded work, highest first. Select a person to explore their hours.</p><div className="wf-people">{people.slice(0,6).map((person,index) => <button type="button" className="wf-person" key={person.userId} onClick={() => { setUser(person.userId); setJob(''); }}><span className="wf-avatar" style={{'--slice':colours[index]} as CSSProperties}>{person.name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('')}</span><span className="wf-person-identity"><strong>{person.name}</strong><span className="wf-person-track"><i style={{width:visualRatio(person.workMicroseconds,people[0].workMicroseconds)*100+'%',background:colours[index]}}/></span></span><span className="wf-person-total">{compactWorkDuration(person.workMicroseconds)}<small>{decimalWorkHours(person.workMicroseconds)} h · rounded</small></span><ArrowRight size={16}/></button>)}{!loading&&!people.length&&<p className="wf-no-work">No employee time in this selection.</p>}</div></article>
    <article className="wf-payroll-card"><div className="wf-payroll-icon"><Wallet size={34}/></div><span className="wf-eyebrow">FROM HOURS TO THE NEXT STEP</span><h2>Payroll, with the details in reach.</h2><p>{canPay ? 'Review recorded time alongside employee pay information.' : 'Review dated employee hours and payroll reports.'} Hours here are recorded work and breaks; paid-time, overtime and leave rules are separate.</p><button type="button" onClick={() => onNavigate('payroll')}>Open payroll workspace <ArrowRight size={17}/></button><button type="button" onClick={() => onNavigate('requests')}>Review employee requests <ArrowRight size={17}/></button></article></div>

    <section className="wf-card wf-data"><header className="wf-card-header"><div><span className="wf-eyebrow">THE NUMBERS BEHIND THE PICTURE</span><h2>Your loaded data</h2></div><button type="button" aria-expanded={tableOpen} aria-controls={tableId} onClick={() => { setTableOpen(!tableOpen); setPage(0); }}>{tableOpen?'Hide data':'Explore data'} <ArrowRight size={15}/></button></header>
    {tableOpen && <div id={tableId} ref={tableRef} tabIndex={-1} className="wf-table-content"><div className="wf-segmented" aria-label="Loaded data view">{(['periods','people','records'] as const).map(kind=><button type="button" key={kind} aria-pressed={table===kind} onClick={()=>{setTable(kind);setPage(0);}}>{kind==='periods'?'Time periods':kind==='people'?'Employees':'Time records'}</button>)}</div>{job&&<p>Showing records for {report?.rows.find(row=>row.job_id===job)?.job_title ?? 'selected job'}. <button type="button" onClick={()=>{setJob('');setPage(0);}}>Show all jobs</button></p>}<div className="wf-table-scroll" tabIndex={0} role="region" aria-label="Exact recorded-time data"><table><caption>{table==='records'?'Recorded segments and their contribution to the selected range':'Exact recorded work and breaks'} · {tableRows.length} rows</caption><thead><tr>{table==='records'?<><th>Employee / job</th><th>Recorded start / end</th><th>Included time</th><th>Community</th></>:<><th>{table==='people'?'Employee':'Period'}</th><th>Work</th><th>Breaks</th><th>Work hours, rounded</th></>}</tr></thead><tbody>{shownRows.map((item:any,index)=><tr key={item.key??item.id??item.userId??index}>{table==='records'?<><td>{item.employee_name}<small>{item.job_title} · {item.kind}</small></td><td><time dateTime={item.started_at}>{exactWorkforceTimestamp(item.started_at,zone)}</time><small>{item.ended_at ? exactWorkforceTimestamp(item.ended_at,zone):'Open — no recorded end'}</small></td><td><Exact value={item.duration_microseconds}/></td><td>{item.unit_name}</td></>:<><td>{table==='people'?<button type="button" onClick={()=>setUser(item.userId)}>{item.name}</button>:item.label}</td><td><Exact value={item.workMicroseconds}/></td><td><Exact value={item.breakMicroseconds}/></td><td>{decimalWorkHours(item.workMicroseconds)} h</td></>}</tr>)}</tbody></table>{!tableRows.length&&<p className="wf-no-work">No loaded rows.</p>}</div><div className="wf-pagination"><span>Page {currentPage+1} of {lastPage+1}</span><button type="button" aria-label="Previous data page" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={18}/></button><button type="button" aria-label="Next data page" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}><ChevronRight size={18}/></button></div></div>}
    <p className="wf-source-note">{report ? <>Recorded-time snapshot: {exactWorkforceTimestamp(report.asOf,report.timezone)}. {report.notice}</> : 'A report must load before any totals are available.'} Chart positions and decimal hours are display approximations; exact durations remain available in the data and detail controls. Refresh to sample current time.</p></section>
  </section>;
}
