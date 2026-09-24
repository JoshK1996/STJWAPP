import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Download, FileCheck2, Printer, RefreshCw } from 'lucide-react';
import { DateTime } from 'luxon';
import { api, ApiError, download } from './api';
import { Badge, Empty, Modal, Panel } from './components';
import { sourceCatalog } from '../shared/report-library';
import { ExactWorkforceCell, WorkforcePrecisionEvidence, workforceColumnLabel } from './ExactWorkforceTime';
import type { SnapshotCapture, SnapshotData, SnapshotDetail, SnapshotList, SnapshotPreview, SnapshotSummary } from '../shared/report-snapshots';
import './report-snapshots.css';
import { formatReportValue, readableReportColumns, reportColumnLabel, reportFilename } from '../shared/report-presentation';

type Props = {
  reportId: string; version: number; archived: boolean; clean: boolean; parentBusy: boolean;
  timezone: string; ownerKey: string; onDirty: (value: boolean) => void;
  notify: (message: string, error?: boolean) => void;
};
type CaptureAttempt = { version: number; previewId: string; payloadHash: string; commandId: string; reviewed: true; reason: string };
const display = (value: unknown) => value == null ? '—' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
const stamp = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat('LLL d, yyyy h:mm:ss a ZZZZ');

function Rows({ data, all = false, auditView = false }: { data: SnapshotData; all?: boolean; auditView?: boolean }) {
  const columns = auditView ? data.columns : readableReportColumns(data.columns);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(data.rows.length / 25));
  const actualPage = Math.min(page, pages - 1);
  const rows = all ? data.rows : data.rows.slice(actualPage * 25, actualPage * 25 + 25);
  if (!data.rows.length) return <p className="panel-note">This report contains no matching records.</p>;
  return <>
    <div className="snapshot-table" role={all ? undefined : 'region'} aria-label={all ? undefined : 'Saved report data; scroll horizontally for more columns'} tabIndex={all ? undefined : 0}>
      <table><thead><tr>{columns.map(column => <th scope="col" key={column.key}>{auditView ? data.schemaVersion === 2 ? workforceColumnLabel(column.label) : column.label : reportColumnLabel(column)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.key}>{auditView ? data.schemaVersion === 2 ? <ExactWorkforceCell column={column.key} value={row[column.key]} zone={data.timezone}/> : display(row[column.key]) : formatReportValue(column.key, row[column.key], {timezone: data.timezone, source: data.source, row, currency: "currency" in data.provenance ? data.provenance.currency : undefined})}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {!all && <nav className="snapshot-pagination" aria-label="Saved report rows">
      <button className="button secondary small" disabled={actualPage === 0} onClick={() => setPage(actualPage - 1)}>Previous rows</button>
      <span aria-live="polite">Rows {actualPage * 25 + 1}–{Math.min(data.rows.length, (actualPage + 1) * 25)} of {data.rows.length}</span>
      <button className="button secondary small" disabled={actualPage + 1 >= pages} onClick={() => setPage(actualPage + 1)}>Next rows</button>
    </nav>}
  </>;
}

function SourceEvidence({ data }: { data: SnapshotData }) {
  return <div className="snapshot-source">
    <div className="snapshot-facts">
      <div><span>Source</span><strong>{sourceCatalog[data.source].label}</strong></div>
      <div><span>Data as of</span><strong>{stamp(data.asOf, data.timezone)}</strong></div>
      <div><span>Results</span><strong>{data.rowCount.toLocaleString()} rows · {data.sourceRowCount.toLocaleString()} source records</strong></div>
      <div><span>Saved layout</span><strong>Version {data.reportVersion}</strong></div>
    </div>
    {data.range && <p className="panel-note">{data.range.from} through {data.range.to} · {data.timezone}</p>}
    <p className="snapshot-notice">{data.notice}</p>
    {data.schemaVersion === 2 && <details className="report-audit-evidence"><summary>Exact source timing and audit evidence</summary><WorkforcePrecisionEvidence asOf={data.asOf} zone={data.timezone} provenance={data.provenance}/></details>}
    {data.schemaVersion === 1 && data.source === 'workforce' && <p className="panel-note">Legacy millisecond report. Its original values and saved files remain unchanged.</p>}
    {data.source === 'grades' && <p className="panel-note">Gradebook: {display(data.provenance.bookStatus)} · version {display(data.provenance.bookVersion)} · policy {display(data.provenance.policyVersion)}. Saving this report does not issue a report card or approve grades.</p>}
    {data.source === 'attendance' && <p className="panel-note">Recorded attendance is preserved as reviewed. Missing or draft attendance is not converted into an absence.</p>}
    {data.source === 'finance' && <p className="panel-note">{display(data.provenance.title)} · published version {display(data.provenance.financialVersion)} · {display(data.provenance.currency)} · {display(data.provenance.sourceName)}</p>}
    {data.source === 'compensation' && <p className="panel-note">These are recorded pay rates, not calculated earnings or approved payroll.</p>}
  </div>;
}

export default function ReportSnapshots({ reportId, version, archived, clean, parentBusy, timezone, ownerKey, onDirty, notify }: Props) {
  const base = `/report-library/${reportId}`;
  const [auditView, setAuditView] = useState(false), currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const [rows, setRows] = useState<SnapshotSummary[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<SnapshotPreview | null>(null), [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [reason, setReason] = useState(''), [reviewed, setReviewed] = useState(false), [attempt, setAttempt] = useState<CaptureAttempt | null>(null);
  const [now, setNow] = useState(Date.now());
  const active = useRef(true), busyRef = useRef(false), attemptRef = useRef<CaptureAttempt | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { onDirty(Boolean(preview) || busy); return () => onDirty(false); }, [preview, busy, onDirty]);
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  useEffect(() => {
    document.body.classList.toggle('report-snapshot-view', Boolean(detail || preview));
    return () => document.body.classList.remove('report-snapshot-view');
  }, [detail, preview]);

  function resetReview() { setPreview(null); setReason(''); setReviewed(false); setAttempt(null); attemptRef.current = null; }
  function fail(cause: unknown) {
    const message = cause instanceof Error ? cause.message : 'The report could not be loaded.';
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      resetReview(); setDetail(null); setRows([]); setLoaded(false); setNextOffset(null);
    }
    setError(message); notify(message, true);
  }
  async function perform(task: () => Promise<void>, opener?: HTMLButtonElement) {
    if (busyRef.current) return;
    if (opener) openerRef.current = opener;
    busyRef.current = true; setBusy(true); setError('');
    try { await task(); } catch (cause) { if (active.current) fail(cause); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  async function load(offset = 0) {
    const result = await api<SnapshotList>(`${base}/snapshots?offset=${offset}`);
    if (!active.current) return;
    setRows(old => offset === 0 ? result.rows : [...old, ...result.rows.filter(row => !old.some(item => item.id === row.id))]);
    setNextOffset(result.nextOffset); setLoaded(true);
  }
  useEffect(() => {
    if (!version) return;
    void perform(() => load());
  }, [reportId, version]);

  async function prepare() {
    const result = await api<SnapshotPreview>(`${base}/snapshot-previews`, { version });
    if (!active.current) return;
    setDetail(null); resetReview(); setPreview(result);
  }
  async function open(id: string) {
    const result = await api<SnapshotDetail>(`${base}/snapshots/${id}`);
    if (active.current) { resetReview(); setDetail(result); }
  }
  async function capture() {
    if (!preview) return;
    // Store the exact reviewed command before sending it. A lost response must
    // retry these bytes, even if the preview subsequently expires.
    const command = attemptRef.current ?? {
      version: preview.data.reportVersion, previewId: preview.id, payloadHash: preview.payloadHash,
      commandId: crypto.randomUUID(), reviewed: true as const, reason: reason.trim(),
    };
    attemptRef.current = command; setAttempt(command);
    const result = await api<SnapshotCapture>(`${base}/snapshots`, command);
    if (!active.current) return;
    resetReview(); notify('Saved the exact report you reviewed.');
    await open(result.snapshot.id);
    await load();
  }
  function close() {
    if (busyRef.current) return;
    if (preview && !window.confirm(attemptRef.current
      ? 'Leave this review? A previous save may have completed. Refresh Saved reports to check before preparing another copy.'
      : 'Discard this unsaved report review?')) return;
    const opener = openerRef.current;
    resetReview(); setDetail(null); setError('');
    // Async loading disables the triggering button before Modal can capture it.
    // Wait for its cleanup, then restore this known opener only if focus has not
    // moved to another control or dialog in the meantime.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!active.current || !opener?.isConnected || opener.disabled || document.querySelector('dialog[open]') ||
          opener.closest('[inert]') || !opener.getClientRects().length || getComputedStyle(opener).visibility === 'hidden') return;
      const focused = document.activeElement;
      if (focused !== document.body && focused?.id !== 'workspace-main') return;
      opener.focus({ preventScroll: true });
    }));
  }
  async function printSaved() {
    if (!detail) return;
    // Recheck current access on explicit printing, just as a download does.
    const latest = await api<SnapshotDetail>(`${base}/snapshots/${detail.snapshot.id}`);
    if (!active.current) return;
    setDetail(latest);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (active.current) window.print();
  }
  async function exportSaved(format: 'csv' | 'json' | 'xlsx') {
    if (!detail) return;
    const expectedOwner = ownerKey;
    await download(`${base}/snapshots/${detail.snapshot.id}/export?format=${format}`, reportFilename(detail.snapshot.data.name, format), () => active.current && currentOwner.current === expectedOwner);
  }
  const expired = Boolean(preview && now >= Date.parse(preview.expiresAt));
  const changed = Boolean(preview && (preview.data.reportVersion !== version || !clean || archived));
  const data = preview?.data ?? detail?.snapshot.data;
  const disabled = busy || parentBusy;
  return <>
    <Panel title="Saved reports" detail="Keep the exact results you reviewed, with their source date and file evidence." className="report-snapshots"
      action={<Badge><Archive size={13} /> Private to your account</Badge>}>
      <p className="panel-note">Saved copies stay unchanged when source records change. Your current source access is checked every time you open or download one. Saving a report does not approve its underlying records.</p>
      <div className="library-actions">
        <button className="button primary" disabled={disabled || !version || archived || !clean || Boolean(preview)} onClick={event => void perform(prepare, event.currentTarget)}><FileCheck2 size={16} /> Review a new saved copy</button>
        <button className="button secondary small" disabled={disabled || !version} onClick={() => void perform(() => load())}><RefreshCw size={15} /> Refresh saved reports</button>
      </div>
      {!version || !clean ? <p className="panel-note">Save your report layout before preparing a copy.</p> : archived ? <p className="panel-note">This layout is archived. Existing saved copies remain available while you retain access to their sources.</p> : null}
      {error && !preview && !detail && <p className="form-error" role="alert">{error}</p>}
      {loaded && rows.length === 0 && <Empty title="No saved copies yet" detail="Review the full result, add a reason, then save an immutable copy for later comparison or download." />}
      {rows.length > 0 && <ul className="snapshot-list">{rows.map(row => <li key={row.id}>
        <div><strong>{row.name}</strong><span>Saved {stamp(row.capturedAt, timezone)}</span><small>Data as of {stamp(row.asOf, timezone)} · layout v{row.reportVersion} · {row.rowCount.toLocaleString()} rows{row.source === 'workforce' ? row.precisionVersion === 2 ? ' · Exact microseconds' : ' · Legacy milliseconds' : ''}</small></div>
        <button className="button secondary small" disabled={disabled} onClick={event => void perform(() => open(row.id), event.currentTarget)} aria-label={`Open ${row.name} saved ${stamp(row.capturedAt, timezone)}`}>Open saved copy</button>
      </li>)}</ul>}
      {nextOffset !== null && <button className="button secondary small" disabled={disabled} onClick={() => void perform(() => load(nextOffset))}>Load older saved copies</button>}
    </Panel>
    {data && <Modal title={preview ? 'Review this report before saving' : 'Saved report'} onClose={close}>
      <div className="snapshot-dialog" aria-busy={busy}>
        <div className="snapshot-title"><FileCheck2 aria-hidden="true" /><div><h3>{data.name}</h3>{data.description && <p>{data.description}</p>}</div></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <SourceEvidence data={data} />
        {detail && <div className="snapshot-receipt"><Badge tone="good">Saved copy</Badge><p>Saved {stamp(detail.snapshot.capturedAt, data.timezone)}</p><p><strong>Reason:</strong> {detail.snapshot.reason}</p></div>}
        {preview && <>
          <p className="snapshot-expiry" role="status">{expired ? 'This review has expired.' : `Review expires ${stamp(preview.expiresAt, data.timezone)}.`}{attempt ? ' You can retry the same save to recover its receipt.' : ' Prepare another copy if you need fresh data.'}</p>
          {changed && <p className="snapshot-notice">The saved layout changed or has unsaved edits. This review still contains its original results. {attempt ? 'Retrying checks the original save only.' : 'Close this review and save the layout before preparing a new copy.'}</p>}
        </>}
        <div className="report-preview-settings"><div><strong>Readable report preview</strong><p>Hours and amounts use 2 decimal places. Original values remain available in the audit view.</p></div><label className="check-label"><input type="checkbox" checked={auditView} onChange={event => setAuditView(event.target.checked)} />Audit view · exact values and IDs</label></div>
        <Rows data={data} auditView={auditView} key={preview?.id ?? detail?.snapshot.id} />
        {preview && <form className="snapshot-confirm" onSubmit={event => { event.preventDefault(); if (!disabled && (attempt || (!expired && !changed && reviewed && reason.trim().length >= 5))) void perform(capture); }}>
          <label>Why are you saving this report?<textarea value={reason} minLength={5} maxLength={500} required disabled={disabled || Boolean(attempt)} onChange={event => setReason(event.target.value)} placeholder="For example: September staffing review" /></label>
          <label className="check-label"><input type="checkbox" checked={reviewed} disabled={disabled || Boolean(attempt)} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the source dates, selected fields, and results shown above.</span></label>
          {attempt && <p className="panel-note">The save request is fixed to this review and reason. Retry uses the same request so a lost response cannot create a second copy.</p>}
          <div className="library-actions"><button type="submit" className="button primary" disabled={disabled || (!attempt && (expired || changed || !reviewed || reason.trim().length < 5))}><Archive size={16} />{busy ? 'Saving…' : attempt ? 'Retry this save' : 'Save reviewed report'}</button><button type="button" className="button secondary" disabled={disabled} onClick={close}>Discard review</button></div>
        </form>}
        {detail && <>
          <div className="library-actions">
            <button className="button secondary" disabled={disabled} onClick={() => void perform(() => exportSaved('csv'))}><Download size={16} />Exact source CSV</button>
            <button className="button secondary" disabled={disabled} onClick={() => void perform(() => exportSaved('json'))}>Source JSON</button>
            <button className="button secondary" disabled={disabled} onClick={() => void perform(() => exportSaved('xlsx'))}>Download formatted Excel</button>
            <button className="button secondary" disabled={disabled || data.rowCount > 1000} onClick={() => void perform(printSaved)}><Printer size={16} />Print saved copy</button>
          </div>
          <p className="panel-note">JSON and CSV are the original saved files. Excel opens with a formatted Report sheet showing names, readable dates and rounded amounts. Data, Provenance and Source JSON retain the exact values and evidence. The audit-view switch changes the on-screen table and print layout; Excel always includes both views. Printing supports up to 1,000 rows.</p>
          <details className="snapshot-files"><summary>File details</summary><dl><dt>Report copy</dt><dd>{detail.snapshot.id}</dd><dt>Reviewed data SHA-256</dt><dd>{detail.payloadHash}</dd><dt>JSON SHA-256</dt><dd>{detail.jsonHash}</dd><dt>CSV SHA-256</dt><dd>{detail.csvHash}</dd><dt>Retained size</dt><dd>{detail.bytes.toLocaleString()} bytes</dd></dl></details>
        </>}
      </div>
    </Modal>}
    {data && createPortal(<section className="library-print-root snapshot-print-root">
      {detail && data.rowCount <= 1000 ? <><h1>{data.name}</h1><p>Saved {stamp(detail.snapshot.capturedAt, data.timezone)} · Data as of {stamp(data.asOf, data.timezone)} · {data.timezone}</p><p>Reason: {detail.snapshot.reason}</p><SourceEvidence data={data} /><Rows data={data} all auditView={auditView} />{auditView && <p>Saved copy {detail.snapshot.id} · reviewed data SHA-256: {detail.payloadHash}</p>}</> : <p>{preview ? 'This review has not been saved. Save the reviewed report to print its retained copy.' : 'This saved report exceeds the 1,000-row printing limit. Download its CSV or JSON instead.'}</p>}
    </section>, document.body)}
  </>;
}
