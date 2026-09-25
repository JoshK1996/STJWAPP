import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Plus, ScanText } from 'lucide-react';
import { api, ApiError } from './api';
import { scheduleDocumentResult, scheduleDocumentLimits, scheduleDraftCsv, type ScheduleDocumentResult, type ScheduleImportContext, type ScheduleDraftRow, type ScheduleDateFormat } from '../shared/schedule-documents';
import './schedule-document-import.css';

const fields = ['employee', 'community', 'job', 'date', 'start', 'endDate', 'end', 'note'] as const;
type Mapping = Record<typeof fields[number], number>;
const emptyMapping = (): Mapping => ({ employee: -1, community: -1, job: -1, date: -1, start: -1, endDate: -1, end: -1, note: -1 });
const labels = { employee: 'Employee name or email', community: 'Community', job: 'Job title', date: 'Start date', start: 'Start time / date-time', endDate: 'End date (optional)', end: 'End time / date-time', note: 'Note' };
const aliases: Record<typeof fields[number], string[]> = { employee: ['employee', 'employeeemail', 'name', 'email', 'staff', 'staffname', 'employeename'], community: ['community', 'department', 'unit'], job: ['job', 'jobtitle', 'role', 'position'], date: ['date', 'startdate', 'shiftdate'], start: ['start', 'starttime', 'startsat', 'clockin'], endDate: ['enddate'], end: ['end', 'endtime', 'endsat', 'clockout'], note: ['note', 'notes', 'comment'] };
const key = (value: string) => value.trim().toLowerCase();
const blank = (): ScheduleDraftRow => ({ source: 'Manual row', include: true, userId: '', jobId: '', start: '', end: '', note: '' });
export default function ScheduleDocumentImport({ context, disabled, onPrepared, onEdit, onDirty, onAccessDenied, isSessionCurrent }: {
  context: ScheduleImportContext; disabled: boolean; onPrepared: (csv: string, filename: string) => void; onEdit: () => void;
  onDirty: (dirty: boolean) => void; onAccessDenied: (status: 401 | 403) => void; isSessionCurrent: () => boolean;
}) {
  const [source, setSource] = useState<ScheduleDocumentResult | null>(null), [filename, setFilename] = useState(''), [sheetId, setSheetId] = useState(0);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping), [header, setHeader] = useState(1), [hasHeader, setHasHeader] = useState(true);
  const [rows, setRows] = useState<ScheduleDraftRow[]>([]), [format, setFormat] = useState<ScheduleDateFormat>('iso'), [defaultDate, setDefaultDate] = useState(''), [defaultJob, setDefaultJob] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(0), [checked, setChecked] = useState(false), [denied, setDenied] = useState(false);
  const live = useRef(true), generation = useRef(0), controller = useRef<AbortController | null>(null), gate = useRef(false);
  const catalogSignature = JSON.stringify(context), previousCatalog = useRef(catalogSignature);
  const locked = disabled || busy || denied, zone = source?.timezone ?? context.timezone, effectiveContext = useMemo(() => ({ ...context, timezone: zone }), [context, zone]);
  const sheet = source?.sheets.find(value => value.id === sheetId), columns = Math.max(0, ...sheet?.rows.map(row => row.cells.length) ?? []), headerCells = sheet?.rows.find(row => row.row === header)?.cells ?? [];
  const dirty = !!source || rows.length > 0 || busy;
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; controller.current?.abort(); onDirty(false); }; }, []);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { if (previousCatalog.current !== catalogSignature) { previousCatalog.current = catalogSignature; setChecked(false); onEdit(); if (rows.length) setError('Employee, job or community details changed. Review these rows again before final preview.'); } }, [catalogSignature]);
  const valid = (epoch: number) => live.current && generation.current === epoch && isSessionCurrent();
  function changed() { setChecked(false); setError(''); onEdit(); }
  function suggest(value: ScheduleDocumentResult['sheets'][number], rowNumber = 1) {
    const row = value.rows.find(row => row.row === rowNumber), next = emptyMapping();
    for (const field of fields) { const matches = row?.cells.map((cell, i) => aliases[field].includes(cell.toLowerCase().replace(/[^a-z]/g, '')) ? i : -1).filter(i => i >= 0) ?? []; if (matches.length === 1) next[field] = matches[0]; }
    setMapping(next);
  }
  async function choose(file?: File) {
    if (!file || locked || gate.current || !isSessionCurrent()) return;
    if (dirty && !window.confirm('Replace this document and its unsaved draft rows?')) return;
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    if (!['csv', 'xlsx', 'pdf', 'docx'].includes(extension ?? '')) { setError('Choose CSV, XLSX, text-based PDF or DOCX. Scans and legacy .doc files need a text or spreadsheet copy.'); return; }
    if (file.size > scheduleDocumentLimits.bytes) { setError('Choose a file no larger than 2 MiB.'); return; }
    changed(); generation.current++; controller.current?.abort(); controller.current = new AbortController(); const epoch = generation.current;
    gate.current = true; setBusy(true); setSource(null); setRows([]); setFilename(file.name); setPage(0);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      if (!valid(epoch)) return;
      const result = scheduleDocumentResult.parse(await api('/schedule-documents/inspect', { format: extension, base64: btoa(binary) }, 'POST', controller.current.signal));
      if (!valid(epoch)) return;
      setSource(result); const first = result.sheets[0]; setSheetId(first?.id ?? 0); setHeader(1); setHasHeader(true); if (first) suggest(first); setChecked(false);
    } catch (cause) {
      if (!valid(epoch)) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { setSource(null); setRows([]); setFilename(''); setDenied(true); onAccessDenied(cause.status); }
      else setError(cause instanceof Error ? cause.message : 'The document could not be read. Enter rows manually or use a text/spreadsheet copy.');
    } finally { gate.current = false; if (live.current) setBusy(false); }
  }
  function mapRows() {
    if (!sheet || locked) return; changed();
    const used = new Set(rows.map(row => row.source)), next = sheet.rows.filter(row => row.row >= header + (hasHeader ? 1 : 0)).filter(row => !used.has(`${sheet.name} · row ${row.row}`)).map(row => {
      const value = (field: typeof fields[number]) => mapping[field] >= 0 ? row.cells[mapping[field]]?.trim() ?? '' : '';
      const people = context.staff.filter(person => person.active !== false && (key(person.email) === key(value('employee')) || key(person.name) === key(value('employee'))));
      const person = people.length === 1 ? people[0] : undefined;
      const community = value('community'), jobName = value('job');
      const jobs = context.jobs.filter(job => job.active !== false && (!jobName ? job.id === defaultJob : key(job.title) === key(jobName)) && (!community || context.units.some(unit => unit.id === job.unit_id && key(unit.name) === key(community))) && (!person || person.job_ids.includes(job.id) && person.unit_ids.includes(job.unit_id)));
      const date = value('date').split('T')[0] || defaultDate, endDate = value('endDate').split('T')[0] || date;
      const combine = (date: string, time: string) => /^\d{4}-\d{2}-\d{2}[ T]|^\d{1,2}\/\d{1,2}\/\d{4}[ T]/.test(time) ? time : `${date} ${time}`.trim();
      return { source: `${sheet.name} · row ${row.row}`, include: true, userId: person?.id ?? '', jobId: jobs.length === 1 ? jobs[0].id : '', start: combine(date, value('start')), end: combine(endDate, value('end')), note: value('note') };
    });
    if (rows.length + next.length > 2000) { setError('Keep no more than 2,000 draft rows; apply up to 1,000 included shifts per batch.'); return; }
    setRows([...rows, ...next]); if (!next.length) setError('These source rows are already in the draft, or there are no rows after the selected header.');
  }
  const review = useMemo(() => { try { return scheduleDraftCsv(rows, effectiveContext, format); } catch (cause) { return { csv: '', errors: [], message: cause instanceof Error ? cause.message : 'Check the draft.' }; } }, [rows, effectiveContext, format]);
  function update(index: number, patch: Partial<ScheduleDraftRow>) { changed(); setRows(value => value.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  function prepare() { if (!checked || locked || review.errors.length || 'message' in review || !isSessionCurrent()) return; onPrepared(review.csv, filename ? `Reviewed ${filename}` : 'Reviewed manual schedule'); }
  return <section className="schedule-document-import" aria-label="Guided schedule document import">
    <header><ScanText size={24} /><div><h4>Bring your existing schedule</h4><p>Read a spreadsheet or document, match the columns, then edit the proposed shifts.</p></div></header>
    <p>CSV, XLSX, text-based PDF or DOCX · up to 2 MiB · up to 1,000 included shifts per import. Documents are read locally by this app; no document text is sent to AI services.</p>
    <div className="schedule-document-actions"><label className="button secondary"><FileUp size={16} />Choose schedule file<input type="file" accept=".csv,.xlsx,.pdf,.docx" disabled={locked} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} /></label><button type="button" className="button secondary" disabled={locked || rows.length >= 2000} onClick={() => { changed(); setRows(value => [...value, blank()]); setPage(Math.floor(rows.length / 10)); }}><Plus size={16} />Add manual row</button>{rows.length > 0 && <button type="button" className="button ghost" disabled={locked} onClick={() => { if (window.confirm('Discard the unsaved draft rows? The source file stays available for mapping again.')) { changed(); setRows([]); setPage(0); } }}>Clear draft rows</button>}</div>
    {busy && <p role="status">Reading document…</p>}{error && <p className="error" role="alert">{error}</p>}
    <p><strong>Schedule time zone: {zone}</strong>. Use complete dates and times. Ambiguous daylight-saving times need an explicit offset. Scans/images need manual entry or a text copy; OCR is not available.</p>
    {!!source && <><p><strong>{filename}</strong> · {source.sheets.length} worksheet(s)/page(s). Map each needed worksheet/page and add its rows; unselected pages are excluded.</p><ul>{source.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
      <div className="schedule-document-grid"><label>Worksheet / page<select disabled={locked} value={sheetId} onChange={event => { changed(); const id = Number(event.target.value); setSheetId(id); const next = source.sheets.find(value => value.id === id); setHeader(next?.rows[0]?.row ?? 1); if (next) suggest(next, next.rows[0]?.row ?? 1); }}>{source.sheets.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name} · {sheet.rows.length} rows</option>)}</select></label>
        <label>First row / header row<input type="number" min="1" max="2000" value={header} disabled={locked} onChange={event => { changed(); const n = Number(event.target.value); setHeader(n); if (sheet) suggest(sheet, n); }} /></label></div>
      <label className="finance-check"><input type="checkbox" checked={hasHeader} disabled={locked} onChange={event => { changed(); setHasHeader(event.target.checked); }} />This row contains column headings; exclude it from shifts</label>
      <details><summary>Extracted source rows</summary><div className="schedule-document-source" tabIndex={0}><table><tbody>{sheet?.rows.slice(0, 12).map(row => <tr key={row.row}><th>{row.row}</th>{row.cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table></div><p>First 12 source rows shown here. All mapped rows appear in the editable draft below.</p></details>
      <div className="schedule-document-grid">{fields.map(field => <label key={field}>{labels[field]}<select disabled={locked} value={mapping[field]} onChange={event => { changed(); setMapping(value => ({ ...value, [field]: Number(event.target.value) })); }}><option value={-1}>Set in each row / use default</option>{Array.from({ length: columns }, (_, index) => <option key={index} value={index}>Column {index + 1}{headerCells[index] ? ` · ${headerCells[index].slice(0, 60)}` : ''}</option>)}</select></label>)}</div>
      <div className="schedule-document-grid"><label>Default date<input type="date" value={defaultDate} disabled={locked} onChange={event => { changed(); setDefaultDate(event.target.value); }} /></label><label>Default job<select value={defaultJob} disabled={locked} onChange={event => { changed(); setDefaultJob(event.target.value); }}><option value="">Choose in each row</option>{context.jobs.filter(job => job.active !== false).map(job => <option key={job.id} value={job.id}>{job.title} · {context.units.find(unit => unit.id === job.unit_id)?.name}</option>)}</select></label></div>
      <button type="button" className="button secondary" disabled={locked || !sheet?.rows.length} onClick={mapRows}>Add mapped rows to draft</button></>}
    {rows.length > 0 && <><div className="schedule-document-grid"><label>Imported date order<select value={format} disabled={locked} onChange={event => { changed(); setFormat(event.target.value as ScheduleDateFormat); }}><option value="iso">Year-month-day (2026-10-05)</option><option value="mdy">Month/day/year (10/05/2026)</option><option value="dmy">Day/month/year (05/10/2026)</option></select></label><p>{rows.filter(row => row.include).length} included · {rows.filter(row => !row.include).length} excluded · {review.errors.length} row(s) need attention</p></div>
      <div className="schedule-document-cards">{rows.slice(page * 10, page * 10 + 10).map((row, offset) => { const index = page * 10 + offset, person = context.staff.find(person => person.id === row.userId), issue = review.errors.find(error => error.index === index); return <article key={index} className={!row.include ? 'excluded' : ''} aria-label={`Draft shift ${index + 1}`}><header><strong>Shift {index + 1} · {row.source}</strong><label className="finance-check"><input type="checkbox" checked={row.include} disabled={locked} onChange={event => update(index, { include: event.target.checked })} />Include</label></header>
        <div className="schedule-document-grid"><label>Employee<select value={row.userId} disabled={locked || !row.include} onChange={event => update(index, { userId: event.target.value, jobId: '' })}><option value="">Choose employee</option>{context.staff.filter(person => person.active !== false).map(person => <option key={person.id} value={person.id}>{person.name} · {person.email}</option>)}</select></label>
          <label>Assigned job<select value={row.jobId} disabled={locked || !row.include} onChange={event => update(index, { jobId: event.target.value })}><option value="">Choose assigned job</option>{context.jobs.filter(job => job.active !== false && person?.job_ids.includes(job.id) && person.unit_ids.includes(job.unit_id)).map(job => <option key={job.id} value={job.id}>{job.title} · {context.units.find(unit => unit.id === job.unit_id)?.name}</option>)}</select></label>
          <label>Start date and time<input value={row.start} maxLength={80} disabled={locked || !row.include} placeholder="2026-10-05 08:00" onChange={event => update(index, { start: event.target.value })} /></label><label>End date and time<input value={row.end} maxLength={80} disabled={locked || !row.include} placeholder="2026-10-05 16:00" onChange={event => update(index, { end: event.target.value })} /></label>
          <label className="wide">Note<input value={row.note} maxLength={500} disabled={locked || !row.include} onChange={event => update(index, { note: event.target.value })} /></label></div>{issue && <p className="error" role="alert">{issue.message}</p>}</article>; })}</div>
      {rows.length > 10 && <div className="schedule-document-actions"><button type="button" className="button secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous rows</button><span>Page {page + 1} of {Math.ceil(rows.length / 10)}</span><button type="button" className="button secondary" disabled={(page + 1) * 10 >= rows.length} onClick={() => setPage(value => value + 1)}>Next rows</button></div>}
      {'message' in review && <p className="error" role="alert">{review.message}</p>}<label className="finance-check"><input type="checkbox" checked={checked} disabled={locked || !!review.errors.length || 'message' in review} onChange={event => setChecked(event.target.checked)} />I checked the included rows, excluded pages/rows, assignments, dates and time zone.</label>
      <button type="button" className="button primary" disabled={locked || !checked || !!review.errors.length || 'message' in review} onClick={prepare}>Use reviewed rows for final preview</button>
      <p>The original file is not retained. The final reviewed CSV and import receipt are retained after preview. Nothing is scheduled until you approve the final preview.</p></>}
  </section>;
}
