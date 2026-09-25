import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, FileSpreadsheet, Sparkles, Upload } from 'lucide-react';
import { DateTime } from 'luxon';
import { api, ApiError, download } from './api';
import { Badge, Empty, Panel } from './components';
import WorkbookImport from './WorkbookImport';
import type { WorkbookConvertResult } from '../shared/import-workbooks';
import { staffImportColumns, staffImportDetailSchema, staffImportListSchema, staffImportReceiptSchema,
  type StaffImportDetail, type StaffImportReceipt, type StaffImportSummary } from '../shared/staff-imports';
import './staff-import.css';

const roles: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', finance: 'Finance', employee: 'Employee' };
const when = (value: string) => DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED);
const connectionMessage = (e: unknown) => e instanceof ApiError ? e.message : 'The connection was interrupted. Try again.';

export default function StaffImport({ me, jobs, notify, onChange, onDirty }: {
  me: any; jobs: any[]; notify: (message: string, error?: boolean) => void;
  onChange: () => Promise<void>; onDirty: (value: boolean) => void;
}) {
  const [csv, setCsv] = useState(''), [fileName, setFileName] = useState('');
  const [detail, setDetail] = useState<StaffImportDetail | null>(null), [reviewed, setReviewed] = useState(false);
  const [rows, setRows] = useState<StaffImportSummary[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false), [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState('');
  const [error, setError] = useState(''), [accessError, setAccessError] = useState(''), [busy, setBusy] = useState('');
  const [uncertain, setUncertain] = useState(false), [page, setPage] = useState(0), [advice, setAdvice] = useState<any>(null), [manualHeaders, setManualHeaders] = useState('');
  const [workbookPending, setWorkbookPending] = useState(false), [workbookReset, setWorkbookReset] = useState(0);
  const [workbookSource, setWorkbookSource] = useState<WorkbookConvertResult | null>(null);
  const mounted = useRef(true), epoch = useRef(0), generation = useRef(0), operation = useRef(0), historyGeneration = useRef(0), busyRef = useRef(false);
  const input = useRef<HTMLInputElement>(null), attempt = useRef<{ id: string; body: { sourceHash: string } } | null>(null);
  const context = JSON.stringify([me.actor.id, me.organization.id]), contextRef = useRef(context);
  const sourceDirty = !!csv || workbookPending;
  const unfinished = sourceDirty || uncertain || !!manualHeaders;
  const sourceLocked = !!busy || uncertain;
  const current = (key: number) => mounted.current && epoch.current === key;
  function working(value: string) { busyRef.current = !!value; setBusy(value); }
  function clearWorkbook() { setWorkbookPending(false); setWorkbookSource(null); setWorkbookReset(value => value + 1); }
  function changed() {
    generation.current++; attempt.current = null; setUncertain(false); setDetail(null); setReviewed(false); setPage(0); setAdvice(null); setError('');
  }
  function clearSource() { changed(); setCsv(''); setFileName(''); setWorkbookSource(null); if (input.current) input.current.value = ''; }
  function clearPrivate(status: number) {
    epoch.current++; generation.current++; operation.current++; historyGeneration.current++; attempt.current = null;
    setCsv(''); setFileName(''); setDetail(null); setReviewed(false); setRows([]); setNextCursor(null); setHistoryLoaded(false);
    setHistoryBusy(false); setHistoryError(''); setError(''); setAdvice(null); setManualHeaders(''); setUncertain(false); setPage(0); working(''); clearWorkbook();
    if (input.current) input.current.value = '';
    setAccessError(status === 401 ? 'Your sign-in expired or changed. Sign in again before opening staff imports.' : 'Staff import access could not be verified. Reopen this workspace after your access is restored.');
    onDirty(false);
  }
  function denied(e: unknown) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { clearPrivate(e.status); return true; }
    return false;
  }
  useEffect(() => { mounted.current = true; void loadHistory(); return () => { mounted.current = false; epoch.current++; operation.current++; historyGeneration.current++; }; }, []);
  useEffect(() => { onDirty(unfinished || !!busy); return () => onDirty(false); }, [unfinished, busy, onDirty]);
  useEffect(() => { if (contextRef.current !== context) { contextRef.current = context; clearPrivate(401); } }, [context]);

  async function loadHistory(append = false) {
    const key = epoch.current, request = ++historyGeneration.current, cursor = append ? nextCursor : null;
    setHistoryBusy(true); setHistoryError('');
    try {
      const result = staffImportListSchema.parse(await api('/imports/staff?' + new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })));
      if (!current(key) || request !== historyGeneration.current) return;
      setRows(previous => append ? [...previous, ...result.rows] : result.rows); setNextCursor(result.nextCursor); setHistoryLoaded(true);
    } catch (e) {
      if (!current(key) || request !== historyGeneration.current || denied(e)) return;
      if (e instanceof ApiError && e.status === 409) { setRows([]); setNextCursor(null); setHistoryLoaded(false); setHistoryError('Import history changed. Reload it before continuing; the earlier page has been cleared.'); }
      else setHistoryError('Import history could not load. ' + connectionMessage(e));
    } finally { if (current(key) && request === historyGeneration.current) setHistoryBusy(false); }
  }
  async function run(label: string, work: (key: number) => Promise<void>) {
    if (busyRef.current || accessError) return;
    const key = epoch.current, request = ++operation.current;
    working(label); setError('');
    try { await work(key); }
    catch (e) { if (current(key) && request === operation.current && !denied(e)) setError(connectionMessage(e)); }
    finally { if (current(key) && request === operation.current) working(''); }
  }
  function confirmReplace() { return !sourceDirty || window.confirm('Discard the current staff import source and review?'); }
  async function choose(file?: File) {
    if (!file || sourceLocked || !confirmReplace()) return;
    clearSource(); clearWorkbook(); const version = generation.current;
    await run('Reading CSV…', async key => {
      if (file.size > 400000) throw new ApiError('Choose a CSV smaller than 400,000 bytes.', 400);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
      catch { throw new ApiError('Could not read this file as UTF-8 CSV. Save a UTF-8 copy before importing.', 400); }
      if (current(key) && version === generation.current) { setCsv(text); setFileName(file.name); }
    });
  }
  async function prepare(key: number) {
    const version = generation.current;
    const result = staffImportDetailSchema.parse(await api('/imports/staff/preview', { csv }));
    if (!current(key) || version !== generation.current) return;
    setDetail(result); setReviewed(false); setPage(0); await loadHistory();
  }
  async function apply(key: number) {
    if (!detail) return;
    const frozen = attempt.current ?? { id: detail.id, body: { sourceHash: detail.sourceHash } };
    attempt.current = frozen;
    try {
      const receipt: StaffImportReceipt = staffImportReceiptSchema.parse(await api(`/imports/staff/${frozen.id}/apply`, frozen.body));
      if (receipt.batchId !== frozen.id || receipt.sourceHash !== frozen.body.sourceHash) throw new Error('The response did not identify this exact reviewed import.');
      if (!current(key)) return;
      attempt.current = null; setUncertain(false); setReviewed(false); setCsv(''); setFileName(''); clearWorkbook();
      setDetail(previous => previous && previous.id === receipt.batchId ? { ...previous, appliedAt: receipt.appliedAt, receiptState: 'retained', receipt } : previous);
      notify(`${receipt.created} accounts created. Issue individual private setup links from Employees & jobs.`);
      try { await onChange(); }
      catch (e) { if (current(key) && !denied(e)) setError('Accounts were created, but the staff directory could not refresh. ' + connectionMessage(e)); }
      if (current(key)) await loadHistory();
    } catch (e) {
      if (!current(key) || denied(e)) return;
      if (!(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429) {
        setUncertain(true); setError('The creation response was not confirmed. These accounts may already exist. Retry this same reviewed import to recover its receipt; do not create another import.');
      } else { attempt.current = null; setUncertain(false); setReviewed(false); setError(connectionMessage(e)); }
    }
  }
  function openHistory(id: string) {
    if (sourceLocked || !confirmReplace()) return;
    clearSource(); clearWorkbook();
    void run('Opening import…', async key => {
      const result = staffImportDetailSchema.parse(await api(`/imports/staff/${id}`));
      if (current(key)) { setDetail(result); setReviewed(false); setPage(0); }
    });
  }
  const expired = detail && new Date(detail.expiresAt).getTime() <= Date.now();
  const pages = detail ? Math.ceil(detail.count / 25) : 0;
  return <Panel title="Bring your staff together" detail="New accounts only. Review each role, community and job assignment before creating accounts.">
    <div className="staff-import" aria-label="Staff account imports">
      {accessError ? <div className="error" role="alert">{accessError}</div> : <>
        <p>Accounts are created without passwords or PINs. Issue each person an individual private setup link from Employees &amp; jobs afterward.</p>
        {error && <div className="error" role="alert">{error}</div>}
        {busy && <p role="status">{busy}</p>}
        {uncertain && <div className="staff-import-uncertain" role="status"><strong>Creation needs confirmation</strong><p>Keep this workspace open and use the same-import retry. Changing files would not undo any accounts already created.</p>
          <button type="button" className="button primary" disabled={!!busy} onClick={() => void run('Recovering import receipt…', apply)}>Retry same reviewed staff import</button></div>}
        <WorkbookImport key={workbookReset} kind="staff" disabled={sourceLocked} beforeReplace={confirmReplace} onClear={clearSource}
          onPending={setWorkbookPending} onAccessDenied={clearPrivate} onApply={(result, name) => { changed(); setCsv(result.csv); setFileName(name); setWorkbookSource(result); }} />
        <div className="staff-import-csv">
          <h3><FileSpreadsheet size={19} aria-hidden="true" /> Use a staff CSV</h3>
          <p>Required ordered headers: {staffImportColumns.join(', ')}. Use | between multiple IDs. Up to 500 new accounts.</p>
          <div className="staff-import-actions">
            <button type="button" className="button secondary" disabled={sourceLocked} onClick={() => void run('Downloading CSV template…', async () => download('/imports/staff/template', 'stjw-staff-template.csv'))}><ArrowDownToLine size={16} />Download blank staff CSV</button>
            <label className="button secondary file-input"><Upload size={16} />Choose staff CSV<input ref={input} aria-label="Choose staff CSV" type="file" accept=".csv,text/csv" disabled={sourceLocked} onChange={e => void choose(e.target.files?.[0])} /></label>
            {(csv || workbookPending) && <button type="button" className="button ghost" disabled={sourceLocked} onClick={() => { if (confirmReplace()) { clearSource(); clearWorkbook(); } }}>Discard staff draft</button>}
          </div>
          {fileName && <p className="staff-import-file">Source: {fileName}</p>}
          <button type="button" className="button primary" disabled={sourceLocked || !csv} onClick={() => void run('Preparing staff preview…', prepare)}>Preview staff accounts</button>
        </div>
        <details className="staff-import-guide"><summary>Community and job IDs for your template</summary>
          <p>These are current directory labels. The IDs identify the exact assignments; choosing a parent community does not assign its subgroups.</p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Current staff assignment identifiers"><table><thead><tr><th>Kind</th><th>Current label</th><th>Exact ID</th></tr></thead><tbody>
            {me.units.map((unit: any) => <tr key={unit.id}><td>Community</td><td>{unit.name}</td><td><code>{unit.id}</code></td></tr>)}
            {jobs.map(job => <tr key={job.id}><td>Job</td><td>{job.title} · {job.unit_name}</td><td><code>{job.id}</code></td></tr>)}
          </tbody></table></div>
        </details>
        {detail && <section className="staff-import-review" aria-label="Staff import review">
          <div className="staff-import-heading"><div><h3>{detail.appliedAt ? 'Created accounts' : `Review ${detail.count} new accounts`}</h3><p>{detail.appliedAt ? `Applied ${when(detail.appliedAt)}` : `No accounts have been created by this preview. Expires ${when(detail.expiresAt)}.`}</p></div><Badge tone={detail.appliedAt ? 'green' : 'warm'}>{detail.appliedAt ? 'Applied' : 'Review required'}</Badge></div>
          <p>Validated template: staff directory. Every role and assignment ID below belongs to this retained preview. Readable community/job labels come from the current directory; unavailable labels do not change the saved IDs.</p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Staff roles and assignments"><table><thead><tr><th scope="col">Source row</th><th scope="col">Name and email</th><th scope="col">Role</th><th scope="col">Communities</th><th scope="col">Jobs</th>{detail.receipt && <th scope="col">Created account</th>}</tr></thead><tbody>
            {detail.rows.slice(page * 25, page * 25 + 25).map((row, offset) => { const index = page * 25 + offset, mapping = workbookSource?.rowMap[index]; return <tr key={row.email}>
              <td>CSV row {index + 2}{mapping && <small>Worksheet row {mapping.worksheetRow}</small>}</td><td><strong>{row.name}</strong><span>{row.email}</span></td><td>{roles[row.role] ?? row.role}</td>
              <td>{row.unitIds.map(id => <div key={id}>{me.units.find((unit: any) => unit.id === id)?.name ?? 'Current label unavailable'}<code>{id}</code></div>)}</td>
              <td>{row.jobIds.length ? row.jobIds.map(id => <div key={id}>{jobs.find(job => job.id === id)?.title ?? 'Current label unavailable'}<code>{id}</code></div>) : 'No jobs assigned'}</td>
              {detail.receipt && <td><code>{detail.receipt.accounts.find(account => account.row === index + 2)?.userId}</code></td>}
            </tr>; })}
          </tbody></table></div>
          {pages > 1 && <nav className="staff-import-actions" aria-label="Staff preview pages"><button type="button" className="button secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous rows</button><span>Page {page + 1} of {pages}</span><button type="button" className="button secondary" disabled={page + 1 === pages} onClick={() => setPage(value => value + 1)}>Next rows</button></nav>}
          <details><summary>Retained source evidence</summary><p>Preview <code>{detail.id}</code></p><p>CSV SHA-256 <code>{detail.sourceHash}</code></p><p>Created <code>{detail.createdAt}</code></p>{detail.appliedAt && <p>Applied <code>{detail.appliedAt}</code></p>}
            {detail.sourceAvailable ? <button type="button" className="button secondary" disabled={!!busy} onClick={() => void run('Downloading retained source…', async () => download(`/imports/staff/${detail.id}/source`, `staff-import-${detail.id}.txt`))}>Download retained CSV source</button> : <p>The original CSV was not retained for this older import.</p>}
          </details>
          {detail.receiptState === 'legacy_unavailable' ? <p role="status">This older import was already applied, but its account receipt was not retained. Do not import it again to recover evidence. Review the existing accounts in Employees &amp; jobs.</p> : detail.receipt ? <p role="status">{detail.receipt.created} accounts created. No credentials were imported. Issue individual private setup links from Employees &amp; jobs.</p> : <>
            {expired && <p className="error">{uncertain ? 'The preview period ended, but the original creation may already be saved. Retry the same reviewed import to recover its receipt.' : 'This preview expired. Prepare a fresh preview before creating accounts.'}</p>}
            <label className="staff-import-check"><input type="checkbox" checked={reviewed} disabled={sourceLocked || !!expired} onChange={e => setReviewed(e.target.checked)} />I reviewed every name, email, role, community and job assignment.</label>
            {!uncertain && <button type="button" className="button primary" disabled={!!busy || !reviewed || !!expired} onClick={() => void run('Creating reviewed accounts…', apply)}><Check size={16} />Create {detail.count} reviewed accounts</button>}
          </>}
        </section>}
        <details className="staff-import-advice"><summary>Optional advice for other column labels</summary><p>Enter column labels only, one per line, then review them before asking Jev. Do not enter names, email addresses, IDs or other row values. This field is never populated from your file. Advice does not change a template, create accounts or approve assignments.</p>
          <label>Column labels for optional advice<textarea aria-label="Column labels for optional advice" rows={4} maxLength={3240} value={manualHeaders} disabled={sourceLocked} onChange={e => { setManualHeaders(e.target.value); setAdvice(null); }} /></label>
          <p>Up to 40 labels, each 1–80 characters. Letters, numbers, spaces and _ . / ( ) % : - are supported.</p>
          <div className="staff-import-actions"><button type="button" className="button secondary" disabled={sourceLocked || !manualHeaders.trim()} onClick={() => void run('Requesting header advice…', async key => {
            const headers = manualHeaders.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
            if (!headers.length || headers.length > 40 || headers.some(value => value.length > 80 || !/^[a-zA-Z0-9 _./()%:-]+$/.test(value))) throw new ApiError('Enter 1–40 column labels using the supported characters, with at most 80 characters per label.', 400);
            const result = await api('/imports/suggest', { headers }); if (current(key)) setAdvice(result);
          })}><Sparkles size={15} />Ask Jev about these headers</button><button type="button" className="button ghost" disabled={sourceLocked || !manualHeaders} onClick={() => { setManualHeaders(''); setAdvice(null); }}>Clear advice</button></div>
          {advice && <p>Suggested category: <strong>{advice.category}</strong>. Confidence: {Math.round(advice.confidence * 100)}%. Context sufficiency: {Math.round(advice.sufficient * 100)}%. Human review remains required.</p>}
        </details>
        <section className="staff-import-history" aria-label="Your staff import history"><div className="staff-import-heading"><div><h3>Your import history</h3><p>Only imports created by this account. Opening a record does not create accounts.</p></div><button type="button" className="button secondary" disabled={historyBusy || sourceLocked} onClick={() => void loadHistory()}>Reload import history</button></div>
          {historyError && <p className="error" role="alert">{historyError}</p>}{historyBusy && <p role="status">Loading import history…</p>}
          {historyLoaded && !historyBusy && !historyError && rows.length === 0 && <Empty title="No retained staff imports" detail="Your new previews and receipts will appear here." />}
          {rows.map(row => <article key={row.id} className="staff-import-history-row"><div><strong>{row.count} {row.appliedAt ? 'created accounts' : 'proposed accounts'}</strong><p>{when(row.createdAt)} · {row.receiptState === 'legacy_unavailable' ? 'Older applied import · receipt unavailable' : row.appliedAt ? 'Receipt retained' : 'Preview'}</p><code>{row.id}</code></div><button type="button" className="button secondary" disabled={sourceLocked} onClick={() => openHistory(row.id)}>Open {row.appliedAt ? 'receipt' : 'preview'}</button></article>)}
          {nextCursor && <button type="button" className="button secondary" disabled={historyBusy || sourceLocked} onClick={() => void loadHistory(true)}>Load older imports</button>}
        </section>
        <p>School and family imports are in School records. Assignment-score imports are in Gradebooks. Employee pay workbook imports are in Employee pay records.</p>
      </>}
    </div>
  </Panel>;
}
