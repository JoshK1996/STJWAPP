import { useEffect, useRef, useState } from "react";
import { z } from 'zod';
import { Plus, History, Download, Pencil, ShieldCheck } from "lucide-react";
import { api, ApiError } from "./api";
import { Panel, Badge, Empty, Modal } from "./components";
import {
  compensationRate,
  compensationPreviewInput,
  compensationSaveInput,
  rateBases,
  type CompensationRate,
} from "../shared/compensation";
import "./compensation.css";
import WorkbookImport from './WorkbookImport';
import type { WorkbookConvertResult } from '../shared/import-workbooks';

type Props = {
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
};
const label = (r: CompensationRate) =>
  `${r.amount} ${r.currency} ${rateBases[r.basis].toLowerCase()} · ${r.startsOn} through ${r.endsOn ?? "no recorded end"}${r.voided ? " · VOID" : ""}`;
const saveReceiptSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), previewHash: z.string().regex(/^[a-f0-9]{64}$/), changedEntries: z.number().int().min(1).max(200) }).strict();
type SaveAttempt = z.infer<typeof compensationSaveInput>;
const errorMessage = (cause: unknown) => cause instanceof ApiError ? cause.message : 'The connection was interrupted. Try again when it is ready.';
export default function Compensation({ notify, onDirty }: Props) {
  const [staff, setStaff] = useState<any[]>([]),
    [userId, setUserId] = useState(""),
    [jobs, setJobs] = useState<any[]>([]),
    [jobId, setJobId] = useState(""),
    [record, setRecord] = useState<any>(null),
    [rates, setRates] = useState<CompensationRate[]>([]),
    [baseline, setBaseline] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<CompensationRate | null>(null),
    [preview, setPreview] = useState<any>(null),
    [reviewed, setReviewed] = useState(false),
    [history, setHistory] = useState<any[] | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null),
    [importOpen, setImportOpen] = useState(false),
    [importCsv, setImportCsv] = useState(""),
    [importName, setImportName] = useState(""),
    [importReason, setImportReason] = useState("");
  const [conversion, setConversion] = useState<WorkbookConvertResult | null>(null), [workbookPending, setWorkbookPending] = useState(false), [widgetGeneration, setWidgetGeneration] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false), [uncertainSave, setUncertainSave] = useState(false), [requiresRefresh, setRequiresRefresh] = useState(false);
  const [savedNeedsRefresh, setSavedNeedsRefresh] = useState(false);
  const [receipt, setReceipt] = useState<(z.infer<typeof saveReceiptSchema> & { employeeName: string; jobTitle: string }) | null>(null), [notice, setNotice] = useState('');
  const [accessUnavailable, setAccessUnavailable] = useState(false), [staffLoading, setStaffLoading] = useState(true), [jobsLoading, setJobsLoading] = useState(false);
  const generation = useRef(0), sourceGeneration = useRef(0), active = useRef(true), running = useRef(false), attempt = useRef<SaveAttempt | null>(null);
  const reads = useRef(new Set<AbortController>()), csvInput = useRef<HTMLInputElement>(null);
  const owns = (run: number) => active.current && generation.current === run;
  const dirty =
    record !== null && (JSON.stringify(rates) !== baseline || reason !== "");
  const importedDraft = Boolean(importCsv || importReason || conversion || workbookPending);
  const hasDraft = dirty || draft !== null || importedDraft || preview !== null || uncertainSave;
  const locked = busy || uncertainSave || requiresRefresh;
  useEffect(() => {
    active.current = true; void loadStaff();
    return () => { active.current = false; generation.current++; sourceGeneration.current++; for (const controller of reads.current) controller.abort(); };
  }, []);
  useEffect(() => {
    onDirty(
      hasDraft || busy,
    );
    return () => onDirty(false);
  }, [hasDraft, busy, onDirty]);
  useEffect(() => {
    let active = true;
    setJobs([]);
    setJobsLoading(Boolean(userId && !accessUnavailable));
    const run = generation.current;
    if (userId && !accessUnavailable) {
      setJobsLoading(true);
      void read("/compensation/jobs?" + new URLSearchParams({ userId }), run)
        .then((x) => {
          if (active && owns(run)) setJobs(x.rows);
        })
        .catch((e) => {
          if (active && owns(run) && !accessLost(e)) setError(errorMessage(e));
        }).finally(() => { if (active && owns(run)) setJobsLoading(false); });
    }
    return () => {
      active = false;
    };
  }, [userId, accessUnavailable]);
  useEffect(() => {
    let active = true;
    setRecord(null);
    setRates([]);
    setReason("");
    setBaseline("");
    if (!accessUnavailable) setError("");
    const run = generation.current;
    if (userId && jobId && !accessUnavailable)
      void read("/compensation/record?" + new URLSearchParams({ userId, jobId }), run)
        .then((x) => {
          if (active && owns(run)) load(x);
        })
        .catch((e) => {
          if (active && owns(run) && !accessLost(e)) setError(errorMessage(e));
        });
    return () => {
      active = false;
    };
  }, [userId, jobId, accessUnavailable]);
  async function read(path: string, run: number) {
    const controller = new AbortController(); reads.current.add(controller);
    try { const result = await api(path, undefined, 'GET', controller.signal); if (!owns(run)) throw new Error('Obsolete read'); return result; }
    finally { reads.current.delete(controller); }
  }
  async function loadStaff() {
    const run = generation.current; setStaffLoading(true);
    try { const result = await read('/compensation/staff', run); if (owns(run)) { setStaff(result.rows); setAccessUnavailable(false); setError(''); } }
    catch (cause) { if (owns(run) && !accessLost(cause)) setError(errorMessage(cause)); }
    finally { if (owns(run)) setStaffLoading(false); }
  }
  function clearSource() {
    sourceGeneration.current++; setImportCsv(''); setImportName(''); setConversion(null); setPreview(null); setPreviewOpen(false); setReviewed(false);
  }
  function discardImport() { clearSource(); setImportReason(''); setWorkbookPending(false); setWidgetGeneration(value => value + 1); if (csvInput.current) csvInput.current.value = ''; }
  function clearPair() {
    generation.current++; for (const controller of reads.current) controller.abort(); reads.current.clear(); running.current = false; setBusy(false);
    discardImport(); setImportOpen(false); setRecord(null); setRates([]); setBaseline(''); setReason(''); setDraft(null); setHistory(null); setHistoryCursor(null);
    attempt.current = null; setUncertainSave(false); setRequiresRefresh(false); setSavedNeedsRefresh(false); setReceipt(null); setNotice(''); setError('');
  }
  function accessLost(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403, 404].includes(cause.status)) return false;
    clearPair(); setStaff([]); setJobs([]); setUserId(''); setJobId(''); setStaffLoading(false); setJobsLoading(false); setAccessUnavailable(true); onDirty(false);
    setError('Pay records are unavailable for your current access. Sign in again if your session ended.'); return true;
  }
  function load(x: any) {
    const rows = (x.schedule?.rates ?? []).map((r: unknown) =>
      compensationRate.parse(r),
    );
    setRecord(x);
    setRates(rows);
    setBaseline(JSON.stringify(rows));
    setReason("");
  }
  function discard() {
    if (attempt.current || uncertainSave) { setError('Resolve the saved outcome using Retry same reviewed pay change before changing employees, jobs or source. The change may already be saved.'); return false; }
    return (
      !hasDraft ||
      window.confirm("Discard your unsaved pay-record changes?")
    );
  }
  async function execute(fn: (run: number) => Promise<void>) {
    if (running.current || !active.current) return;
    running.current = true; const run = generation.current;
    setBusy(true);
    setError("");
    try {
      await fn(run);
    } catch (e) {
      if (owns(run) && !accessLost(e)) { setError(errorMessage(e)); notify(errorMessage(e), true); }
    } finally {
      if (owns(run)) { running.current = false; setBusy(false); }
    }
  }
  function applyDraft() {
    const parsed = compensationRate.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((x) => x.message).join(" "));
      return;
    }
    setRates((old) =>
      old.some((r) => r.id === parsed.data.id)
        ? old.map((r) => (r.id === parsed.data.id ? parsed.data : r))
        : [...old, parsed.data],
    );
    setDraft(null);
    setPreview(null); setPreviewOpen(false); setReviewed(false);
    setError("");
  }
  function formInput() {
    return {
      userId,
      jobId,
      expectedVersion: record?.schedule?.version ?? 0,
      rates,
      reason,
    };
  }
  async function review(run: number) {
    const input = compensationPreviewInput.parse(formInput());
    const data = await api("/compensation/preview", input);
    if (!owns(run)) return;
    setPreview({ input, data, commandId: crypto.randomUUID() });
    setReviewed(false); setPreviewOpen(true);
  }
  async function openHistory(run: number, older = false) {
    const query = new URLSearchParams({ userId, jobId });
    if (older && historyCursor)
      query.set("beforeVersion", String(historyCursor));
    const data = await read("/compensation/history?" + query, run);
    if (!owns(run)) return;
    setHistory(older ? [...(history ?? []), ...data.rows] : data.rows);
    setHistoryCursor(data.nextBeforeVersion);
  }
  async function reviewImport(run: number) {
    if (new TextEncoder().encode(importCsv).byteLength > 64000) throw new ApiError('Choose or paste CSV no larger than 64,000 UTF-8 bytes.', 400);
    const source = sourceGeneration.current;
    const data = await api("/compensation/import-preview", {
      userId,
      jobId,
      expectedVersion: record.schedule?.version ?? 0,
      csv: importCsv,
      reason: importReason,
    });
    if (!owns(run) || sourceGeneration.current !== source) return;
    compensationPreviewInput.parse(data.input);
    setPreview({ ...data, commandId: crypto.randomUUID(), conversion });
    setReviewed(false);
    setImportOpen(false); setPreviewOpen(true);
  }
  async function refreshRecord(run: number) {
    const data = await read('/compensation/record?' + new URLSearchParams({ userId, jobId }), run); if (!owns(run)) return;
    if (savedNeedsRefresh) load(data);
    else { const rows = (data.schedule?.rates ?? []).map((rate: unknown) => compensationRate.parse(rate)); setRecord(data); setBaseline(JSON.stringify(rows)); }
    setRequiresRefresh(false); setSavedNeedsRefresh(false); setPreview(null); setPreviewOpen(false); setReviewed(false); setError('');
    setNotice(savedNeedsRefresh ? 'Current saved pay record loaded.' : 'Current record loaded. Your draft remains here; review all rates and source versions before saving.');
  }
  async function save(run: number) {
    if (!attempt.current && (!preview || !reviewed)) return;
    const wasUncertain = Boolean(attempt.current);
    const body = attempt.current ?? compensationSaveInput.parse({ ...preview.input, previewHash: preview.data.previewHash, commandId: preview.commandId, reviewed: true });
    attempt.current = body;
    try {
      const result = saveReceiptSchema.parse(await api('/compensation/save', body)); if (!owns(run)) return;
      if (result.previewHash !== body.previewHash || result.version !== body.expectedVersion + 1) throw new Error('Unexpected pay save receipt');
      setReceipt({ ...result, employeeName: preview?.data.employee.name ?? record.employee.name, jobTitle: preview?.data.job.title ?? record.job.title });
      attempt.current = null; setUncertainSave(false); setPreview(null); setPreviewOpen(false); setReviewed(false); discardImport();
      setRates(body.rates); setBaseline(JSON.stringify(body.rates)); setReason(''); setRequiresRefresh(true); setSavedNeedsRefresh(true);
      setNotice(`Pay record version ${result.version} is saved with its change history. The receipt belongs to this reviewed command; the current record may be newer.`);
      try { const current = await read('/compensation/record?' + new URLSearchParams({ userId: body.userId, jobId: body.jobId }), run); if (owns(run)) { load(current); setRequiresRefresh(false); setSavedNeedsRefresh(false); } }
      catch (cause) { if (owns(run) && !accessLost(cause)) setError('The pay change is saved, but the current record could not refresh. Refresh the saved record; no second save is needed.'); }
    } catch (cause) {
      if (!owns(run) || accessLost(cause)) return;
      if (!(cause instanceof ApiError) || [408, 429].includes(cause.status) || cause.status >= 500 || wasUncertain) {
        setUncertainSave(true); setError(`${errorMessage(cause)} The pay change may already be saved. Retry the same reviewed command. Leaving discards recovery details; it does not undo a saved change.`);
      } else {
        attempt.current = null; setPreview(null); setPreviewOpen(false); setReviewed(false); setRequiresRefresh(true); setSavedNeedsRefresh(false); setError(`${cause.message} Refresh the current record and review your preserved draft again.`);
      }
    }
  }
  async function downloadPay(path: string, name: string, run: number) {
    const controller = new AbortController(); reads.current.add(controller);
    try {
      const response = await fetch('/api' + path, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) { let data: any; try { data = await response.json(); } catch {} throw new ApiError(typeof data?.error === 'string' ? data.error : 'Pay download failed.', response.status); }
      const blob = await response.blob(); if (!owns(run)) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally { reads.current.delete(controller); }
  }
  function replaceImportedSource() {
    if (locked || attempt.current) return false;
    return !(importCsv || conversion || preview) || window.confirm('Replace the current imported pay draft and its review?');
  }
  async function chooseCsv(file: File, run: number) {
    clearSource(); setWidgetGeneration(value => value + 1); setWorkbookPending(false); const source = sourceGeneration.current;
    if (file.size > 64000) throw new ApiError('Choose a CSV no larger than 64,000 bytes.', 400);
    const bytes = await file.arrayBuffer(); if (!owns(run) || sourceGeneration.current !== source) return;
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ApiError('Could not read this file as UTF-8 CSV. Save a UTF-8 copy before importing.', 400); }
    setImportCsv(text); setImportName(file.name);
  }
  const canAdd =
    record?.employee.active && record?.job.active && record?.assigned;
  return (
    <div className="compensation-workspace">
      <Panel
        title="Employee pay records"
        detail="Dated amounts for each employee and job, with a reviewed change history."
        action={
          <span className="compensation-access">
            <ShieldCheck size={18} /> Owner · Admin · Finance
          </span>
        }
      >
        <div className="compensation-controls">
          <label>
            Employee
            <select
              aria-label="Pay record employee"
              value={userId}
              disabled={busy || uncertainSave || accessUnavailable}
              onChange={(e) => {
                if (discard()) {
                  clearPair();
                  setUserId(e.target.value);
                  setJobId("");
                  setDraft(null);
                }
              }}
            >
              <option value="">Choose an employee</option>
              {staff.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? "" : " · inactive"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Job
            <select
              aria-label="Pay record job"
              value={jobId}
              disabled={busy || uncertainSave || !userId || accessUnavailable}
              onChange={(e) => {
                if (discard()) {
                  clearPair();
                  setJobId(e.target.value);
                  setDraft(null);
                }
              }}
            >
              <option value="">Choose a job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title} · {j.unit_name}
                  {j.assigned && j.active ? "" : " · historical record"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="panel-note">
          These records store agreed amounts and effective dates. Earned wages,
          overtime, paid breaks, salary proration and PTO are not calculated
          here. A gap in recorded rates is unconfigured, never a zero pay rate.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="panel-note" role="status">{notice}</p>}
        {staffLoading && <p role="status">Loading permitted pay records…</p>}
        {jobsLoading && <p role="status">Loading this employee’s jobs…</p>}
        {accessUnavailable && <button type="button" className="button secondary" disabled={staffLoading} onClick={() => void loadStaff()}>Check current pay access</button>}
        {uncertainSave && <div className="compensation-recovery" role="region" aria-label="Pay save recovery"><p>The reviewed pay change may already be saved. Editing stays locked until the outcome is resolved.</p><button type="button" className="button primary" disabled={busy} onClick={() => void execute(save)}>{busy ? 'Retrieving saved outcome…' : 'Retry same reviewed pay change'}</button></div>}
        {requiresRefresh && !uncertainSave && <button type="button" className="button secondary" disabled={busy} onClick={() => void execute(refreshRecord)}>Refresh current pay record</button>}
        {receipt && <section className="compensation-receipt" aria-label="Saved pay receipt"><h3>Saved pay record version {receipt.version}</h3><p>{receipt.employeeName} · {receipt.jobTitle} · {receipt.changedEntries} changed entries.</p><details><summary>Exact saved receipt</summary><p>Record ID: <code>{receipt.id}</code></p><p>Reviewed preview SHA-256: <code>{receipt.previewHash}</code></p></details></section>}
        {preview && !previewOpen && !uncertainSave && <button type="button" className="button secondary" disabled={busy} onClick={() => setPreviewOpen(true)}>Reopen pay review</button>}
        {importedDraft && !importOpen && !previewOpen && !uncertainSave && <div className="compensation-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setImportOpen(true)}>Continue pay import</button><button type="button" className="button secondary" disabled={busy} onClick={() => { if (window.confirm('Discard the imported pay draft and its review?')) discardImport(); }}>Discard pay import draft</button></div>}
        {userId && !jobsLoading && jobs.length === 0 && (
          <p className="panel-note">
            No assigned jobs or existing pay records are available for this
            employee.
          </p>
        )}
      </Panel>
      {record && (
        <Panel
          title={`${record.employee.name} · ${record.job.title}`}
          detail={`${record.job.unit_name} · ${record.schedule ? "Record version " + record.schedule.version : "No saved rates"}`}
          action={
            <Badge tone={dirty ? "warm" : "neutral"}>
              {dirty ? "Unsaved changes" : "Saved record"}
            </Badge>
          }
        >
          <div className="compensation-actions">
            <button
              className="button secondary"
              disabled={locked || dirty}
              onClick={() =>
                void execute((run) =>
                  downloadPay(
                    "/compensation/template?" +
                      new URLSearchParams({ userId, jobId }),
                    "stjw-editable-pay-template.csv",
                    run,
                  ),
                )
              }
            >
              Editable CSV template
            </button>
            <button
              className="button secondary"
              disabled={locked || dirty}
              onClick={() => {
                setError("");
                setImportOpen(true);
              }}
            >
              Import pay rates
            </button>
            <button
              className="button primary"
              disabled={locked || importedDraft || !canAdd || rates.length >= 200}
              onClick={() => {
                setError("");
                setPreview(null); setReviewed(false);
                setDraft({
                  id: crypto.randomUUID(),
                  startsOn: "",
                  endsOn: null,
                  amount: "",
                  currency: "",
                  basis: "" as CompensationRate["basis"],
                  voided: false,
                  note: "",
                });
              }}
            >
              <Plus size={16} />
              Add rate
            </button>
            <button
              className="button secondary"
              disabled={busy || uncertainSave || !record.schedule}
              onClick={() => void execute(run => openHistory(run))}
            >
              <History size={16} />
              Pay change history
            </button>
            {(["csv", "json"] as const).map((format) => (
              <button
                className="button secondary"
                key={format}
                disabled={locked || dirty || !record.schedule}
                onClick={() =>
                  void execute((run) =>
                    downloadPay(
                      "/compensation/export?" +
                        new URLSearchParams({ userId, jobId, format }),
                      "stjw-pay-record." + format,
                      run,
                    ),
                  )
                }
              >
                <Download size={16} />
                {format.toUpperCase()}
              </button>
            ))}
          </div>
          {!canAdd && (
            <p className="panel-note">
              This job or employee is inactive or no longer assigned. Existing
              records remain available for review and correction; new entries
              require an active assignment.
            </p>
          )}
          {rates.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Effective dates</th>
                    <th>Amount</th>
                    <th>Basis</th>
                    <th>Status</th>
                    <th>Note</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rates]
                    .sort(
                      (a, b) =>
                        a.startsOn.localeCompare(b.startsOn) ||
                        a.id.localeCompare(b.id),
                    )
                    .map((r) => (
                      <tr key={r.id}>
                        <td>
                          {r.startsOn}
                          <br />
                          <small>through {r.endsOn ?? "no recorded end"}</small>
                        </td>
                        <td>
                          {r.amount} {r.currency}
                        </td>
                        <td>{rateBases[r.basis]}</td>
                        <td>
                          <Badge tone={r.voided ? "warm" : "neutral"}>
                            {r.voided ? "Void" : "Recorded"}
                          </Badge>
                        </td>
                        <td>{r.note || "—"}</td>
                        <td>
                          <button
                            className="button secondary small"
                            aria-label={`Edit rate beginning ${r.startsOn}`}
                            disabled={locked || importedDraft}
                            onClick={() => {
                              setError("");
                              setPreview(null); setReviewed(false);
                              setDraft({ ...r });
                            }}
                          >
                            <Pencil size={14} />
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No rate recorded"
              detail="Add the amount, currency, basis and effective dates provided by the organization."
            />
          )}
          <div className="compensation-review-controls">
            <label>
              Reason for this change
              <textarea
                aria-label="Pay change reason"
                value={reason}
                maxLength={1000}
                disabled={locked || importedDraft}
                onChange={(e) => { setReason(e.target.value); setPreview(null); setReviewed(false); }}
                rows={2}
              />
            </label>
            <button
              className="button primary"
              disabled={
                locked || importedDraft || !rates.length || reason.trim().length < 5 || !dirty
              }
              onClick={() => void execute(review)}
            >
              Preview pay change
            </button>
          </div>
          <p className="panel-note">
            Both the first and last day are included. Rate periods for the same
            employee and job cannot overlap. Keep earlier entries and end their
            dates before adding a new rate; mark incorrect entries void to
            preserve their history.
          </p>
        </Panel>
      )}
      {draft && (
        <Modal
          title="Rate details"
          onClose={() => {
            if (!busy) setDraft(null);
          }}
        >
          <div className="compensation-rate-form">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="compensation-controls">
              <label>
                First effective day
                <input
                  aria-label="First effective day"
                  type="date"
                  value={draft.startsOn}
                  onChange={(e) =>
                    setDraft({ ...draft, startsOn: e.target.value })
                  }
                />
              </label>
              <label>
                Last effective day (optional)
                <input
                  aria-label="Last effective day"
                  type="date"
                  value={draft.endsOn ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, endsOn: e.target.value || null })
                  }
                />
              </label>
              <label>
                Amount
                <input
                  aria-label="Rate amount"
                  inputMode="decimal"
                  value={draft.amount}
                  maxLength={18}
                  onChange={(e) =>
                    setDraft({ ...draft, amount: e.target.value })
                  }
                />
              </label>
              <label>
                Currency
                <input
                  aria-label="Rate currency"
                  placeholder="Three-letter code"
                  value={draft.currency}
                  maxLength={3}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      currency: e.target.value.toUpperCase(),
                    })
                  }
                />
              </label>
              <label>
                Amount basis
                <select
                  aria-label="Amount basis"
                  value={draft.basis}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      basis: e.target.value as CompensationRate["basis"],
                    })
                  }
                >
                  <option value="">Choose a basis</option>
                  {Object.entries(rateBases).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Rate note
              <textarea
                aria-label="Rate note"
                value={draft.note}
                maxLength={1000}
                rows={2}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.voided}
                onChange={(e) =>
                  setDraft({ ...draft, voided: e.target.checked })
                }
              />
              This entry is void; retain it as history only
            </label>
            <div className="compensation-actions">
              <button className="button primary" onClick={applyDraft}>
                Keep in draft
              </button>
              {!(record.schedule?.rates ?? []).some(
                (r: CompensationRate) => r.id === draft.id,
              ) &&
                rates.some((r) => r.id === draft.id) && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setRates(rates.filter((r) => r.id !== draft.id));
                      setDraft(null);
                    }}
                  >
                    Remove unsaved entry
                  </button>
                )}
            </div>
          </div>
        </Modal>
      )}
      {preview && previewOpen && (
        <Modal
          title="Review pay-record changes"
          onClose={() => {
            if (!busy) setPreviewOpen(false);
          }}
        >
          <div className="compensation-preview">
            {error&&<p className="error" role="alert">{error}</p>}
            {preview.sourceHash && (
              <p className="panel-note">
                CSV import · The original source text and its SHA-256 will be
                retained with this version.
              </p>
            )}
            <p>
              {preview.data.employee.name} · {preview.data.job.title} ·{" "}
              {preview.data.job.unit_name}
            </p>
            <p>{preview.input.reason}</p>
            <p>Reviewed record version {preview.input.expectedVersion}. All existing rate identities must remain in the complete schedule.</p>
            <details className="compensation-conversion"><summary>Complete proposed schedule · {preview.input.rates.length} entries</summary><ol>{preview.input.rates.map((rate: CompensationRate) => <li key={rate.id}><p>{label(rate)}</p><p>{rate.note || 'No note'}</p><p>Rate ID: <code>{rate.id}</code></p></li>)}</ol></details>
            {preview.conversion && <details className="compensation-conversion"><summary>Excel worksheet and source evidence</summary><p>{preview.conversion.sheetName} · header row {preview.conversion.headerRow} · {preview.conversion.rowCount} converted rows.</p><p>Excluded worksheets: {preview.conversion.ignoredSheets.map((sheet: any) => sheet.name).join(', ') || 'none'}. Excluded leading rows: {preview.conversion.ignoredLeadingRows.count}. Skipped empty rows: {preview.conversion.emptyRows.join(', ') || 'none'}.</p><p>CSV rows map to worksheet rows: {preview.conversion.rowMap.map((row: any) => `${row.csvRow} → ${row.worksheetRow}`).join('; ')}.</p><p>Converted CSV SHA-256: <code>{preview.conversion.csvHash}</code></p><p>Workbook SHA-256: <code>{preview.conversion.workbookHash}</code></p><p>The saved pay history retains the converted CSV. Keep your original Excel workbook; it is not stored.</p></details>}
            {preview.data.changes.map((c: any) => (
              <div className="compensation-change" key={c.after.id}>
                <p>
                  <strong>Before</strong>
                  <br />
                  {c.before ? label(c.before) : "New entry"}
                </p>
                <p>
                  <strong>After</strong>
                  <br />
                  {label(c.after)}
                </p>
                {(c.before?.note || c.after.note) && (
                  <p>
                    Note: {c.before?.note || "None"} → {c.after.note || "None"}
                  </p>
                )}
              </div>
            ))}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy || uncertainSave}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed the amounts, dates, currency and basis.
            </label>
            <button
              className="button primary"
              disabled={busy || (!uncertainSave && !reviewed)}
              onClick={() => void execute(save)}
            >
              {uncertainSave ? 'Retry same reviewed pay change' : 'Save reviewed pay change'}
            </button>
          </div>
        </Modal>
      )}
      {history && (
        <Modal title="Pay change history" onClose={() => { if (!busy) setHistory(null); }}>
          <div className="compensation-history">
            {history.map((h) => (
              <article key={h.version}>
                <h3>Version {h.version}</h3>
                <p>
                  {h.created_at} · {h.actor_name}
                </p>
                <p>{h.reason}</p>
                {h.has_import_source && (
                  <div className="compensation-source-receipt">
                    <p>Imported source SHA-256: {h.source_hash}</p>
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() =>
                        void execute((run) =>
                          downloadPay(
                            "/compensation/history-source?" +
                              new URLSearchParams({
                                userId,
                                jobId,
                                version: String(h.version),
                              }),
                            "stjw-pay-import-original.txt",
                            run,
                          ),
                        )
                      }
                    >
                      Original source text
                    </button>
                  </div>
                )}
                <p>
                  {h.snapshot.employeeName} · {h.snapshot.jobTitle} ·{" "}
                  {h.snapshot.unitName}
                </p>
                {h.snapshot.changes.map((c: any) => (
                  <div className="compensation-change" key={c.after.id}>
                    <p>Before: {c.before ? label(c.before) : "New entry"}</p>
                    <p>After: {label(c.after)}</p>
                    <p>
                      Note: {c.before?.note || "None"} →{" "}
                      {c.after.note || "None"}
                    </p>
                  </div>
                ))}
              </article>
            ))}
            <p className="panel-note">
              Showing {history.length} saved versions, newest first.
            </p>
            {historyCursor && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void execute(run => openHistory(run, true))}
              >
                Load older pay changes
              </button>
            )}
          </div>
        </Modal>
      )}
      {importOpen && (
        <Modal
          title="Import employee pay rates"
          onClose={() => {
            if (!busy && (!importedDraft || window.confirm('Discard the imported pay draft?'))) { discardImport(); setImportOpen(false); }
          }}
        >
          <div className="compensation-import">
            <p>
              Use the editable template for {record.employee.name} and{" "}
              {record.job.title}. Keep all existing rate IDs and the record
              version. For a new row, leave rateId blank. Use true or false in
              voided. Review the complete date schedule before saving.
            </p>
            <p>Selected record version: {record.schedule?.version ?? 0}. Conversion creates no pay records. A template with no saved rates contains blank fields that you must explicitly complete.</p>
            <WorkbookImport key={`${userId}:${jobId}:${record.schedule?.version ?? 0}:${widgetGeneration}`} kind="compensation_rates" userId={userId} jobId={jobId} disabled={locked}
              beforeReplace={replaceImportedSource} onClear={clearSource} onPending={setWorkbookPending}
              onApply={(result, name) => { sourceGeneration.current++; setImportCsv(result.csv); setImportName(name); setConversion(result); setPreview(null); setReviewed(false); }}
              onAccessDenied={(status) => { accessLost(new ApiError('Pay access changed.', status)); }} />
            <label className="compensation-file">
              Choose CSV file
              <input
                aria-label="Pay CSV file"
                ref={csvInput}
                type="file"
                accept=".csv,text/csv"
                disabled={locked}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file || !replaceImportedSource()) return;
                  void execute(run => chooseCsv(file, run));
                }}
              />
            </label>
            {importName && <p>{importName}</p>}
            <details>
              <summary>Paste CSV instead</summary>
              <textarea
                aria-label="Pay CSV content"
                value={importCsv}
                maxLength={64000}
                rows={8}
                disabled={locked}
                onChange={(e) => {
                  sourceGeneration.current++; setWidgetGeneration(value => value + 1); setWorkbookPending(false); setConversion(null); setPreview(null); setReviewed(false); setImportCsv(e.target.value);
                  setImportName("");
                }}
              />
            </details>
            <label>
              Reason for this import
              <textarea
                aria-label="Pay import reason"
                rows={2}
                maxLength={1000}
                value={importReason}
                disabled={locked}
                onChange={(e) => { setImportReason(e.target.value); setPreview(null); setReviewed(false); }}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button primary"
              disabled={locked || !importCsv || importReason.trim().length < 5}
              onClick={() => void execute(reviewImport)}
            >
              Preview imported pay rates
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
