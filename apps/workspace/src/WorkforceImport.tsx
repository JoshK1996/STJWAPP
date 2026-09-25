import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, FileSpreadsheet, Upload } from 'lucide-react';
import { api, ApiError, download } from './api';
import WorkbookImport from './WorkbookImport';
import { workforceImportColumns, workforceImportLimits, workforceImportDetail, workforceImportReceipt, workforceImportList,
  type WorkforceImportKind, type WorkforceImportDetail } from '../shared/workforce-imports';
import './workforce-import.css';

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function WorkforceImport({ kind, onChange, notify, onDirty, isSessionCurrent, onSessionExpired }: {
  kind: WorkforceImportKind; onChange: () => Promise<void>; notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void; isSessionCurrent: () => boolean; onSessionExpired: () => void;
}) {
  const [csv, setCsv] = useState(''), [fileName, setFileName] = useState(''), [detail, setDetail] = useState<WorkforceImportDetail | null>(null);
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [denied, setDenied] = useState(false);
  const [uncertain, setUncertain] = useState(false), [workbookPending, setWorkbookPending] = useState(false), [workbookKey, setWorkbookKey] = useState(0);
  const [history, setHistory] = useState<{ id: string; createdAt: string; count: number; applied: boolean }[]>([]), [historyError, setHistoryError] = useState('');
  const [page, setPage] = useState(0), mounted = useRef(true), generation = useRef(0), writing = useRef(false), input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ id: string; sourceHash: string } | null>(null), historyGeneration = useRef(0);
  const current = (epoch: number) => mounted.current && generation.current === epoch && isSessionCurrent();
  const dirty = !!csv || workbookPending || uncertain, locked = !!busy || uncertain || denied;
  const base = '/imports/workforce/' + kind;
  function clear() { generation.current++; attempt.current = null; setCsv(''); setFileName(''); setDetail(null); setReviewed(false); setUncertain(false); setError(''); setPage(0); setWorkbookPending(false); setWorkbookKey(value => value + 1); if (input.current) input.current.value = ''; }
  function rejectAccess(status: 401 | 403) { clear(); setHistory([]); setDenied(true); onDirty(false); if (status === 401) onSessionExpired(); else setError('Management access changed. Reopen this page after access is restored.'); }
  function failed(cause: unknown) {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { rejectAccess(cause.status); return; }
    setError(cause instanceof Error ? cause.message : 'The request could not finish. Try again.');
  }
  async function loadHistory() {
    const epoch = generation.current, version = ++historyGeneration.current;
    try { const result = workforceImportList.parse(await api(base)); if (current(epoch) && version === historyGeneration.current) { setHistory(result.rows); setHistoryError(''); } }
    catch (cause) { if (!current(epoch) || version !== historyGeneration.current) return; if (cause instanceof ApiError && [401, 403].includes(cause.status)) failed(cause); else setHistoryError('Recent imports could not load. Reload the history to try again.'); }
  }
  useEffect(() => { mounted.current = true; void loadHistory(); return () => { mounted.current = false; generation.current++; historyGeneration.current++; }; }, []);
  useEffect(() => { onDirty(dirty || !!busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  function replace() { return !dirty || window.confirm('Discard this unsaved file and review?'); }
  async function run(label: string, work: (epoch: number) => Promise<void>) {
    if (writing.current || denied) return; writing.current = true; setBusy(label); setError(''); const epoch = generation.current;
    try { await work(epoch); } catch (cause) { if (current(epoch)) failed(cause); }
    finally { writing.current = false; if (mounted.current) setBusy(''); }
  }
  async function choose(file?: File) {
    if (!file || locked || !replace()) return; clear();
    await run('Reading file…', async epoch => {
      if (file.size > workforceImportLimits.bytes) throw Error('Choose a UTF-8 CSV no larger than 800,000 bytes.');
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); } catch { throw Error('Save the file as UTF-8 CSV and try again.'); }
      if (text.length > workforceImportLimits.characters) throw Error('Choose a CSV no longer than 200,000 characters.');
      if (current(epoch)) { setCsv(text); setFileName(file.name); }
    });
  }
  async function preview() {
    await run('Checking rows…', async epoch => {
      const result = workforceImportDetail.parse(await api(base + '/preview', { csv }));
      if (current(epoch)) { setDetail(result); setReviewed(false); setPage(0); await loadHistory(); }
    });
  }
  async function apply() {
    if (!detail || (!reviewed && !uncertain)) return;
    await run('Creating records…', async epoch => {
      const command = attempt.current ?? { id: detail.id, sourceHash: detail.sourceHash }; attempt.current = command;
      try {
        const receipt = workforceImportReceipt.parse(await api(base + '/' + command.id + '/apply', { sourceHash: command.sourceHash }));
        if (receipt.batchId !== command.id || receipt.sourceHash !== command.sourceHash || receipt.kind !== kind) throw Error('The response did not identify the reviewed import.');
        if (!current(epoch)) return;
        attempt.current = null; setUncertain(false); setCsv(''); setFileName(''); setWorkbookPending(false); setWorkbookKey(value => value + 1); setReviewed(false); setDetail(value => value ? { ...value, receipt } : null); if (input.current) input.current.value = '';
        notify(`${receipt.created} ${kind === 'jobs' ? 'jobs' : 'scheduled shifts'} created. The import receipt is saved.`);
        try { await onChange(); } catch { if (current(epoch)) setError('The import saved, but the page could not refresh. Refresh the workspace to view current records.'); }
        if (current(epoch)) await loadHistory();
      } catch (cause) {
        if (!current(epoch)) return;
        if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 408 || cause.status === 429) { setUncertain(true); setError('The result is not confirmed. Retry this same import to recover its receipt; do not upload the file again.'); }
        else { attempt.current = null; setUncertain(false); setReviewed(false); failed(cause); }
      }
    });
  }
  return <section className="workforce-import" aria-label={`Bulk ${kind} import`}>
    <header><span className="small-icon"><FileSpreadsheet size={23} /></span><div><h3>Import {kind === 'jobs' ? 'jobs' : 'staff schedules'}</h3><p>Create up to 100 records from CSV or Excel. Preview every row before applying; existing records stay unchanged.</p></div></header>
    <div className="workforce-import-steps"><span>1 · Download a template</span><span>2 · Fill in and preview</span><span>3 · Review and create</span></div>
    <p>Use exact community and job names from Employees &amp; jobs. {kind === 'jobs' ? 'A job title must be new within its community. Assign the new jobs to employees after import.' : 'Use each employee’s email and an active job already assigned to them. Overlapping shifts are blocked.'}</p>
    {kind === 'schedules' && <p>Enter times as text with an explicit UTC offset, for example <code>2026-10-05T08:00:00-04:00</code>. The offset must match the intended date and time zone. This creates scheduled shifts; it does not clock anyone in. Preview times below use your device’s time zone.</p>}
    <details><summary>Template columns</summary><p className="workforce-import-columns">{workforceImportColumns[kind].join(' · ')}</p><p>Keep these headers in order. Dates, names and emails must be plain text; formulas and Excel numeric dates are rejected. Passwords, PINs and pay rates are not part of these templates.</p></details>
    <div className="workforce-import-actions"><button type="button" className="button secondary" disabled={locked} onClick={() => void run('Downloading…', async epoch => { await download(base + '/template', `stjw-${kind}-template.csv`, () => current(epoch)); })}><ArrowDownToLine size={16} />Blank CSV template</button>
      <label className="button secondary"><Upload size={16} />Choose CSV<input ref={input} type="file" accept=".csv,text/csv" disabled={locked} onChange={event => void choose(event.target.files?.[0])} /></label>
      {dirty && <button type="button" className="button ghost" disabled={locked} onClick={() => { if (replace()) clear(); }}>Clear file</button>}
    </div>
    {fileName && <p role="status">Selected: <strong>{fileName}</strong></p>}
    <WorkbookImport key={workbookKey} kind={kind} disabled={locked} beforeReplace={replace} onClear={() => { generation.current++; attempt.current = null; setCsv(''); setFileName(''); setDetail(null); setReviewed(false); setError(''); }} onPending={setWorkbookPending}
      onApply={(result, name) => { generation.current++; setCsv(result.csv); setFileName(name); setDetail(null); setReviewed(false); setPage(0); }} onAccessDenied={rejectAccess} />
    {!!csv && !uncertain && <button type="button" className="button primary" disabled={locked} onClick={() => void preview()}><FileSpreadsheet size={16} />Preview {kind}</button>}
    {busy && <p role="status">{busy}</p>}{error && <p className="error" role="alert">{error}</p>}
    {detail && <div className="workforce-import-preview"><h4>{detail.receipt ? `${detail.receipt.created} records created` : `Review ${detail.rows.length} proposed ${kind === 'jobs' ? 'jobs' : 'shifts'}`}</h4>
      <p>{detail.receipt ? `Saved ${when(detail.receipt.appliedAt)}. Repeating this import action returns its receipt without creating duplicates.` : `Preview expires ${when(detail.expiresAt)}. Changed assignments or source records require a fresh preview.`}</p>
      <div className="workforce-import-table" tabIndex={0} role="region" aria-label="Rows to import"><table><thead><tr><th>Row</th>{kind === 'schedules' && <th>Employee</th>}<th>Community / job</th>{kind === 'schedules' && <><th>Start</th><th>End</th></>}<th>{kind === 'jobs' ? 'Description' : 'Note'}</th></tr></thead><tbody>{detail.rows.slice(page * 10, page * 10 + 10).map(row => <tr key={row.row}><td>{row.row}</td>{kind === 'schedules' && <td><strong>{row.employee}</strong><small>{row.email}</small></td>}<td><strong>{row.title}</strong><small>{row.community}</small></td>{kind === 'schedules' && <><td title={row.startsAt}>{when(row.startsAt!)}</td><td title={row.endsAt}>{when(row.endsAt!)}</td></>}<td>{row.note || '—'}</td></tr>)}</tbody></table></div>
      {detail.rows.length > 10 && <div className="workforce-import-actions"><button type="button" className="button ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(detail.rows.length / 10)}</span><button type="button" className="button ghost" disabled={(page + 1) * 10 >= detail.rows.length} onClick={() => setPage(value => value + 1)}>Next</button></div>}
      {!detail.receipt && <><label className="finance-check"><input type="checkbox" disabled={locked} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed every row, destination and time.</label><button type="button" className="button primary" disabled={!!busy || denied || (!reviewed && !uncertain)} onClick={() => void apply()}><Check size={16} />{uncertain ? 'Retry same import' : `Create ${detail.rows.length} ${kind === 'jobs' ? 'jobs' : 'shifts'}`}</button></>}
    </div>}
    <details><summary>My recent imports · {history.length}</summary><p>Your latest 20 previews and receipts. Pending previews can be reopened for review.</p><button type="button" className="button ghost" disabled={locked} onClick={() => void loadHistory()}>Reload history</button>{historyError && <p role="alert">{historyError}</p>}
      <ul className="workforce-import-history">{history.map(row => <li key={row.id}><button type="button" className="button secondary" disabled={locked} onClick={() => { if (!replace()) return; clear(); void run('Opening import…', async epoch => { const result = workforceImportDetail.parse(await api(base + '/' + row.id)); if (current(epoch)) { setDetail(result); setPage(0); } }); }}>{when(row.createdAt)} · {row.count} rows · {row.applied ? 'Created' : 'Pending review'}</button></li>)}</ul>
    </details>
  </section>;
}
