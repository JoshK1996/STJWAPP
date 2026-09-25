import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, ArrowDownToLine, X } from 'lucide-react';
import { api, ApiError, download } from './api';
import { workbookInspectResultSchema, workbookConvertResultSchemaFor, workbookIssueSchema,
  workbookLimits, type WorkbookInspectResult, type WorkbookConvertResult, type WorkbookIssue, type WorkbookKind } from '../shared/import-workbooks';
import { schoolImportCatalog, type SchoolImportKind } from '../shared/school-imports';
import './workbook-import.css';

type Props = {
  disabled: boolean;
  kind?: WorkbookKind;
  unitId?: string;
  assignmentId?: string;
  userId?: string;
  jobId?: string;
  beforeReplace?: () => boolean;
  onClear: () => void;
  onPending: (value: boolean) => void;
  onApply: (result: WorkbookConvertResult, fileName: string) => void;
  onAccessDenied: (status: 401 | 403) => void;
};

/** File bytes are transient. Each selection invalidates all older async work. */
export default function WorkbookImport({ disabled, kind = 'finance', unitId, assignmentId, userId, jobId, beforeReplace, onClear, onPending, onApply, onAccessDenied }: Props) {
  const grade = kind === 'grade_scores';
  const staff = kind === 'staff';
  const workforce = kind === 'jobs' || kind === 'schedules';
  const compensation = kind === 'compensation_rates';
  const schoolKind = kind.startsWith('school_') ? kind.slice('school_'.length) as SchoolImportKind : null;
  const school = schoolKind ? schoolImportCatalog[schoolKind] : null;
  const scope = kind === 'finance' || staff || workforce ? { kind } : compensation ? { kind, userId, jobId } : grade ? { kind, assignmentId } : { kind, unitId };
  const [fileName, setFileName] = useState(''), [encoded, setEncoded] = useState('');
  const [inspection, setInspection] = useState<WorkbookInspectResult | null>(null);
  const [converted, setConverted] = useState<WorkbookConvertResult | null>(null);
  const [sheet, setSheet] = useState(''), [header, setHeader] = useState('1');
  const [sampleSheet, setSampleSheet] = useState('');
  const [busy, setBusy] = useState(false), [reviewed, setReviewed] = useState(false), [applied, setApplied] = useState(false);
  const [error, setError] = useState(''), [cells, setCells] = useState<WorkbookIssue['cells']>([]);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  function invalidate() {
    generation.current++; controller.current?.abort(); controller.current = null;
    setBusy(false); setError(''); setCells([]); setConverted(null); setReviewed(false); setApplied(false);
    onClear();
    return generation.current;
  }
  function displayError(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || (grade || staff || compensation) && e.status === 404)) {
      invalidate(); onPending(false);
      setFileName(''); setEncoded(''); setInspection(null); setSheet(''); setSampleSheet(''); setHeader('1');
      if (input.current) input.current.value = '';
      onAccessDenied(e.status === 401 ? 401 : 403);
      return;
    }
    setError(e instanceof Error ? e.message : 'Unable to read this workbook. Try again.');
    const issue = workbookIssueSchema.safeParse(e instanceof ApiError ? e.details : undefined);
    setCells(issue.success ? issue.data.cells : []);
  }
  async function inspect(base64: string, selectedSheet: string, version: number) {
    const abort = new AbortController(); controller.current = abort; setBusy(true);
    try {
      const result = workbookInspectResultSchema.parse(await api('/import-workbooks/inspect', {
        ...scope, base64, ...(selectedSheet ? { sheetId: Number(selectedSheet) } : {}),
      }, 'POST', abort.signal));
      if (generation.current !== version) return;
      setInspection(result); setSampleSheet(selectedSheet);
    } catch (e) { if (generation.current === version && !abort.signal.aborted) displayError(e); }
    finally { if (generation.current === version) setBusy(false); }
  }
  async function choose(file?: File) {
    if (!file || disabled || beforeReplace && !beforeReplace()) return;
    const version = invalidate(); onPending(true);
    setFileName(file.name); setEncoded(''); setInspection(null); setSheet(''); setSampleSheet(''); setHeader('1');
    if (file.size < 1 || file.size > workbookLimits.inputBytes || !/\.xlsx$/i.test(file.name)) {
      setError('Choose an .xlsx workbook no larger than 256 KiB. CSV files use the separate picker.'); return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation.current !== version) return;
      let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
      const base64 = btoa(binary); setEncoded(base64);
      await inspect(base64, '', version);
    } catch (e) { if (generation.current === version) { displayError(e); setBusy(false); } }
  }
  function selectSheet(value: string) {
    const version = invalidate(); setSheet(value); setSampleSheet(''); onPending(true);
    if (value) void inspect(encoded, value, version);
  }
  async function convert() {
    if (!inspection || !sheet || sampleSheet !== sheet) return;
    const version = invalidate(); onPending(true); const abort = new AbortController(); controller.current = abort; setBusy(true);
    try {
      const result = workbookConvertResultSchemaFor(kind).parse(await api('/import-workbooks/convert', {
        ...scope, base64: encoded, sheetId: Number(sheet), headerRow: Number(header), expectedWorkbookHash: inspection.workbookHash,
      }, 'POST', abort.signal));
      if (generation.current === version) setConverted(result);
    } catch (e) { if (generation.current === version && !abort.signal.aborted) displayError(e); }
    finally { if (generation.current === version) setBusy(false); }
  }
  function discard() {
    invalidate(); onPending(false); setFileName(''); setEncoded(''); setInspection(null); setSheet(''); setSampleSheet('');
    if (input.current) input.current.value = '';
  }
  async function template() {
    const version = generation.current; setBusy(true); setError(''); setCells([]);
    try {
      if (compensation) {
        const abort = new AbortController(); controller.current = abort;
        const response = await fetch('/api/import-workbooks/template?' + new URLSearchParams({ kind, userId: userId ?? '', jobId: jobId ?? '' }), { credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) { let details: any; try { details = await response.json(); } catch {} throw new ApiError(typeof details?.error === 'string' ? details.error : 'Pay template download failed.', response.status, details); }
        const blob = await response.blob(); if (generation.current !== version) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'stjw-editable-pay-template.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await download('/import-workbooks/template?' + new URLSearchParams({ kind, ...(kind === 'finance' || staff || workforce ? {} : grade ? { assignmentId: assignmentId ?? '' } : { unitId: unitId ?? '' }) }), workforce ? `stjw-${kind}-template.xlsx` : grade ? 'stjw-assignment-scores.xlsx' : staff ? 'stjw-staff-template.xlsx' : schoolKind ? `stjw-${schoolKind}-template.xlsx` : 'financial-report-template.xlsx');
    }
    catch (e) { if (generation.current === version) displayError(e); }
    finally { if (generation.current === version) setBusy(false); }
  }
  const selected = inspection?.sheets.find(s => String(s.sheetId) === sheet);
  return <section className="workbook-import" aria-label="Excel workbook import">
    <div className="workbook-heading"><FileSpreadsheet size={23} aria-hidden="true" /><div><h3>{workforce ? `Excel · New ${kind === 'jobs' ? 'jobs' : 'staff schedules'}` : compensation ? 'Excel · Employee pay rates' : grade ? 'Excel · Assignment scores' : staff ? 'Excel · New staff accounts' : school ? `Excel · ${school.title}` : 'Bring in an Excel report'}</h3>
      <p>{workforce ? 'Download the blank template and keep all headers in order. Up to 100 new records; existing records are never overwritten.' : compensation ? 'Download the current employee/job template. Keep every rate ID, including voided entries, and the record version. Keep all eleven headers; their order may change. Up to 200 rate rows.' : grade ? 'Download this assignment’s current roster. Keep every identity and version as text; edit only status, points and note. Up to 200 student rows.' : staff ? 'Use the blank text-formatted template for new accounts. Keep name, email, role, unitIds and jobIds in that order. Up to 500 staff rows.' : school ? 'Use this import type’s text-formatted template. Keep numbers, IDs, dates and permissions as exact text. Up to 500 data rows.' : 'Use our text-formatted template to preserve line codes and exact amounts. Up to 500 data rows.'}</p></div></div>
    {compensation && <p>Enter amounts, dates, IDs, versions and true/false as text. The converted CSV must fit within 64,000 UTF-8 bytes. A new rate needs an explicit amount, currency, basis and date. Conversion does not save pay records; preview and reviewed save remain required.</p>}
    {staff && <p>Use | between multiple community or job IDs. Passwords and PINs are never imported. Conversion creates no accounts; review each role and assignment in the staff preview before applying.</p>}
    {workforce && <p>Use exact community and job names, and employee email addresses for schedules. Keep every header in order and all cells as text. Up to 100 rows. Conversion creates no records; review the workforce preview before applying.</p>}
    {grade && <p>Enter points as text with up to two decimal places. The CSV must fit within 200,000 bytes. Conversion does not save grades; the score preview and reviewed apply remain required.</p>}
    {school && <p>Dates use YYYY-MM-DD. Permission and archive fields use the words true or false. Worksheet conversion does not save school records; the school preview and reviewed apply remain required.</p>}
    <div className="workbook-actions">
      <label className="button">Choose Excel workbook<input ref={input} type="file" aria-label="Choose Excel workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={disabled}
        onChange={e => void choose(e.target.files?.[0])} /></label>
      <button type="button" className="button ghost" disabled={disabled || busy} onClick={() => void template()}><ArrowDownToLine size={16} />{compensation ? 'Current pay Excel template' : grade ? 'Current scores Excel template' : 'Blank Excel template'}</button>
      {fileName && <button type="button" className="button ghost" disabled={disabled} onClick={discard}><X size={16} />Discard workbook</button>}
    </div>
    {fileName && <p className="workbook-file">{fileName}</p>}
    {busy && <p role="status">Reading workbook…</p>}
    {error && <div role="alert" className="error"><p>{error}</p>{cells.length > 0 && <p>Check {cells.map((c, i) => <span key={i}>{i ? '; ' : ''}{c.sheetId ? `sheet ${c.sheetId}, ` : ''}{c.row ? `row ${c.row}` : ''}{c.column ? ` column ${c.column}` : ''}</span>)}.</p>}
      <p>{workforce ? 'Enter all names, emails and timestamps as text before saving. Schedule times need Z or an explicit UTC offset.' : compensation ? 'Enter every value as text before saving, including amounts, dates, identities and versions.' : grade ? 'Enter every value as text before saving, including points, identities and versions.' : staff ? 'Enter names, emails, roles and assignment IDs as text before saving.' : school ? 'Enter every value as text before saving, including dates, versions and true/false fields.' : 'Enter codes and amounts as text before saving.'} Formatting a rounded number as text cannot restore its original digits. Formulas and linked content are unsupported.</p>
      {encoded && (!inspection || sampleSheet !== sheet) && <button type="button" className="button" disabled={disabled || busy} onClick={() => void inspect(encoded, sheet, generation.current)}>Retry reading workbook</button>}
    </div>}
    {inspection && <>
      <div className="workbook-selection"><label>Worksheet<select aria-label="Workbook worksheet" value={sheet} disabled={disabled} onChange={e => selectSheet(e.target.value)}>
        <option value="">Choose a worksheet</option>{inspection.sheets.map(s => <option key={s.sheetId} value={s.sheetId} disabled={s.state !== 'visible'}>{s.name}{s.state === 'visible' ? '' : ' (hidden)'}</option>)}
      </select></label><label>Header row<select aria-label="Workbook header row" value={header} disabled={disabled || busy} onChange={e => { invalidate(); onPending(true); setHeader(e.target.value); }}>
        {Array.from({ length: 20 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select></label></div>
      {selected && <p>{selected.populatedCells} populated cells; last used row {selected.lastRow}. All data below the chosen header must belong to this report.</p>}
      {sampleSheet === sheet && sheet && <div className="workbook-sample" tabIndex={0} role="region" aria-label="Workbook first twenty rows">
        <table><caption>First 20 rows · first 16 columns · long preview cells are shortened</caption><thead><tr><th>Row</th>{Array.from({ length: Math.min(16, selected?.lastColumn ?? 0) }, (_, i) => <th key={i}>{String.fromCharCode(65 + i)}</th>)}</tr></thead>
          <tbody>{inspection.samples.map(row => <tr key={row.row} className={row.row === Number(header) ? 'workbook-header-row' : ''}><th scope="row">{row.row}</th>{Array.from({ length: Math.min(16, selected?.lastColumn ?? 0) }, (_, i) => {
            const cell = row.cells.find(c => c.column === i + 1); return <td key={i}>{cell?.value}{cell?.shortened && <em>… (preview shortened)</em>}</td>;
          })}</tr>)}</tbody></table>
      </div>}
      <button type="button" className="button" disabled={disabled || busy || !sheet || sampleSheet !== sheet} onClick={() => void convert()}>Review converted rows</button>
    </>}
    {converted && <div className="workbook-review">
      <h4>{converted.rowCount} {workforce ? kind === 'jobs' ? 'job' : 'scheduled shift' : compensation ? 'pay rate' : grade ? 'score' : staff ? 'staff' : school ? 'school import' : 'report'} rows from {converted.sheetName}</h4>
      <p>Columns: {converted.headers.join(', ')}</p>
      <p>Excluded worksheets: {converted.ignoredSheets.length ? converted.ignoredSheets.map(s => s.name).join(', ') : 'none'}.</p>
      <p>Excluded leading rows: {converted.ignoredLeadingRows.count}{converted.ignoredLeadingRows.nonemptyRows.length ? ` (content on rows ${converted.ignoredLeadingRows.nonemptyRows.join(', ')})` : ''}.
        {' '}Skipped empty rows: {converted.emptyRows.length}.</p>
      <details><summary>Worksheet row mapping and fingerprints</summary>
        <p>Converted data rows use worksheet rows {converted.rowMap.map(row => row.worksheetRow).join(', ')}.</p>
        {converted.emptyRows.length > 0 && <p>Empty rows skipped: {converted.emptyRows.join(', ')}.</p>}
        <p>Workbook SHA-256 <code>{converted.workbookHash}</code></p><p>Converted CSV SHA-256 <code>{converted.csvHash}</code></p>
      </details>
      <p>{workforce ? 'The workforce import receipt retains the exact converted CSV.' : compensation ? 'A saved pay change retains the converted CSV in its history.' : grade ? 'The grade import receipt retains the converted CSV.' : staff ? 'The staff import receipt retains the converted CSV.' : school ? 'The school import receipt retains the converted CSV.' : 'The published report retains the converted CSV.'} Keep your original workbook; the app does not store it.</p>
      <label className="finance-check"><input type="checkbox" checked={reviewed} disabled={disabled || applied} onChange={e => setReviewed(e.target.checked)} />I reviewed the selected worksheet, header and excluded rows.</label>
      <button type="button" className="button primary" disabled={disabled || !reviewed || applied} onClick={() => { onApply(converted, fileName); onPending(false); setApplied(true); }}>
        {applied ? 'Rows added to draft' : 'Use converted rows'}</button>
      {applied && <p role="status">{workforce ? 'Rows added. Preview the import and review every destination, employee and time before creating records.' : compensation ? 'Rows added. Enter a reason, preview imported pay rates, then review every amount, currency, basis, date and voided entry before saving.' : grade ? 'Rows added. Enter a reason, then preview and review every score change before applying.' : staff ? 'Rows added. Preview the staff import, then review every account’s role, community and job assignments before creating accounts.' : school ? 'Rows added. Select Preview import, then review every proposed change and its destination before applying.' : 'Complete the report context, then preview and review its amounts before publishing.'}</p>}
    </div>}
  </section>;
}
