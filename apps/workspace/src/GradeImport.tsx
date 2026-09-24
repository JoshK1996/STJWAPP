import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import { api, ApiError, download } from "./api";
import WorkbookImport from './WorkbookImport';
import type { WorkbookConvertResult } from '../shared/import-workbooks';
import { Badge, Modal } from "./components";
import { pointText } from "./GradingPolicy";
import "./grade-imports.css";

function Score({ value }: { value: any }) {
  if (!value) return <span className="muted">No valid score</span>;
  return (
    <span>
      <strong>
        {value.status === "scored"
          ? pointText(value.pointsUnits) + " points"
          : value.status}
      </strong>
      {value.note && <small>{value.note}</small>}
    </span>
  );
}
export default function GradeImport({
  assignment,
  bookVersion,
  onClose,
  onDirty,
  onApplied,
  onAccessDenied,
}: {
  assignment: any;
  bookVersion: number;
  onClose: () => void;
  onDirty: (value: boolean) => void;
  onApplied: () => Promise<void>;
  onAccessDenied: (status: 401 | 403) => void;
}) {
  const [csv, setCsv] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [page, setPage] = useState(0),
    [fileName, setFileName] = useState("");
  const [workbookPending, setWorkbookPending] = useState(false), [workbookReset, setWorkbookReset] = useState(0),
    [workbookSource, setWorkbookSource] = useState<WorkbookConvertResult | null>(null),
    [applyUncertain, setApplyUncertain] = useState(false), [savedReceipt, setSavedReceipt] = useState<any>(null);
  const generation = useRef(0), operation = useRef(0), historyGeneration = useRef(0), mounted = useRef(true), busyRef = useRef(false);
  const applyAttempt = useRef<{ id: string; body: { sourceHash: string; planHash: string; reviewed: true } } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const contextKey = JSON.stringify([assignment.id, assignment.version, bookVersion]), contextRef = useRef(contextKey);
  const applied = !!preview?.appliedAt || savedReceipt !== null;
  const sourceLocked = busy || applyUncertain;
  const unfinished = !applied && (!!csv || !!reason || workbookPending);
  function current(key: number) { return mounted.current && key === generation.current; }
  function setWorking(value: boolean) { busyRef.current = value; setBusy(value); }
  function message(e: unknown) { return e instanceof ApiError ? e.message : 'The connection was interrupted. Try again.'; }
  function clearWorkbook() { setWorkbookPending(false); setWorkbookSource(null); setWorkbookReset(value => value + 1); }
  function clearAccess(status: 401 | 403) {
    generation.current++; operation.current++; historyGeneration.current++; applyAttempt.current = null;
    setCsv(''); setReason(''); setFileName(''); setPreview(null); setHistory([]); setSavedReceipt(null);
    setApplyUncertain(false); setReviewed(false); setPage(0); setWorking(false); clearWorkbook();
    if (input.current) input.current.value = '';
    onDirty(false); onAccessDenied(status);
  }
  function accessDenied(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) { clearAccess(e.status === 401 ? 401 : 403); return true; }
    return false;
  }
  async function loadHistory() {
    const key = generation.current, historyKey = ++historyGeneration.current;
    try {
      const result = await api(`/school/grade-assignments/${assignment.id}/import-previews`);
      if (current(key) && historyKey === historyGeneration.current) setHistory(result.rows);
    } catch (e) {
      if (!current(key) || historyKey !== historyGeneration.current || accessDenied(e)) return;
      setError('Import history could not refresh. ' + message(e));
    }
  }
  useEffect(() => {
    mounted.current = true;
    void loadHistory();
    return () => {
      mounted.current = false; generation.current++; operation.current++; historyGeneration.current++;
    };
  }, [assignment.id]);
  useEffect(() => {
    onDirty(unfinished || busy || applyUncertain);
    return () => onDirty(false);
  }, [unfinished, busy, applyUncertain, onDirty]);
  useEffect(() => {
    if (contextRef.current === contextKey) return;
    contextRef.current = contextKey;
    // Keep an unresolved command and a saved receipt intact if the book refreshes.
    if (applyAttempt.current || applied) return;
    changed(); operation.current++; setWorking(false); setCsv(''); setFileName(''); clearWorkbook();
    setError('The gradebook changed. Download its current score template before preparing another import.');
  }, [contextKey]);
  function changed() {
    generation.current++;
    applyAttempt.current = null; setApplyUncertain(false); setSavedReceipt(null);
    setPreview(null);
    setReviewed(false);
    setPage(0);
  }
  function clearSource() { changed(); setCsv(''); setFileName(''); setWorkbookSource(null); setError(''); }
  function confirmReplace() { return !unfinished || window.confirm('Replace the current score file and review?'); }
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    const key = ++operation.current;
    setWorking(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (mounted.current && key === operation.current && !accessDenied(e)) setError(message(e));
    } finally {
      if (mounted.current && key === operation.current) setWorking(false);
    }
  }
  async function apply() {
    const key = generation.current;
    const attempt = applyAttempt.current ?? { id: preview.id, body: { sourceHash: preview.sourceHash, planHash: preview.planHash, reviewed: true as const } };
    applyAttempt.current = attempt;
    try {
      const receipt = await api(`/school/grade-imports/${attempt.id}/apply`, attempt.body);
      if (!current(key)) return;
      applyAttempt.current = null; setApplyUncertain(false); setSavedReceipt(receipt);
      setCsv(''); setFileName(''); setReason(''); setReviewed(false); clearWorkbook(); onDirty(false);
      try { await onApplied(); }
      catch (e) { if (current(key) && !accessDenied(e)) setError('Scores were saved, but the gradebook could not refresh. ' + message(e)); }
      if (current(key)) await loadHistory();
    } catch (e) {
      if (!current(key) || accessDenied(e)) return;
      if (!(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429) {
        setApplyUncertain(true);
        setError('The save response was not confirmed. These scores may already be saved. Retry this same reviewed import to recover its receipt; do not prepare a new import.');
      } else {
        applyAttempt.current = null; setApplyUncertain(false); setReviewed(false); setError(message(e));
      }
    }
  }
  const rows = preview?.plan.rows ?? [],
    expired =
      preview &&
      !applied &&
      new Date(preview.expiresAt).getTime() <= Date.now();
  return (
    <Modal
      title={`Import scores · ${assignment.title}`}
      onClose={() => {
        if (!sourceLocked) onClose();
      }}
    >
      <div className="grade-import-form">
        <div className="grade-import-intro">
          <span className="small-icon">
            <FileSpreadsheet size={25} />
          </span>
          <div>
            <h3>A reviewed path from spreadsheet to gradebook</h3>
            <p>
              Download this assignment’s current roster. Edit status, points and
              note, then review every change. Keep all students and the
              identity/version columns.
            </p>
          </div>
        </div>
        <p className="school-notice">
          Use scored, ungraded, missing, exempt or incomplete. Only scored rows
          have points (up to two decimals). Exempt and incomplete need a note.{" "}
          {pointText(assignment.max_points_units)} possible points; the class
          policy controls extra credit. A template becomes stale whenever its
          gradebook changes.
        </p>
        <button
          className="button secondary"
          disabled={sourceLocked}
          onClick={() =>
            void run(() =>
              download(
                `/school/grade-assignments/${assignment.id}/import-template`,
                "stjw-assignment-scores.csv",
              ),
            )
          }
        >
          <ArrowDownToLine size={17} />
          Download current score CSV template
        </button>
        <label>
          Choose edited CSV
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            disabled={sourceLocked}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(async () => {
                if (file.size > 400000)
                  throw new ApiError("Choose a CSV smaller than 400,000 bytes.", 400);
                const key = ++generation.current;
                const text = await file.text();
                if (key !== generation.current) return;
                if (!confirmReplace()) return;
                changed(); clearWorkbook();
                setCsv(text);
                setFileName(file.name);
              });
            }}
          />
        </label>
        {fileName && <small>{fileName}</small>}
        <WorkbookImport key={contextKey + ':' + workbookReset} kind="grade_scores" assignmentId={assignment.id}
          disabled={sourceLocked} beforeReplace={confirmReplace} onClear={clearSource} onPending={setWorkbookPending}
          onAccessDenied={clearAccess} onApply={(result, name) => {
            clearSource(); setCsv(result.csv); setFileName(name + ' · converted CSV'); setWorkbookSource(result);
          }} />
        <details>
          <summary>Paste CSV instead</summary>
          <label>
            CSV score data
            <textarea
              className="grade-import-csv"
              aria-label="CSV score data"
              value={csv}
              maxLength={400000}
              disabled={sourceLocked}
              onChange={(e) => {
                changed(); clearWorkbook();
                setCsv(e.target.value);
                setFileName("");
              }}
            />
          </label>
        </details>
        <label>
          Reason for importing
          <textarea
            aria-label="Reason for importing"
            value={reason}
            minLength={5}
            maxLength={2000}
            disabled={sourceLocked}
            onChange={(e) => {
              changed();
              setReason(e.target.value);
            }}
          />
        </label>
        <button
          className="button primary"
          disabled={sourceLocked || workbookPending || !csv || reason.trim().length < 5}
          onClick={() =>
            void run(async () => {
              const key = generation.current;
              const result = await api(
                `/school/grade-assignments/${assignment.id}/import-previews`,
                { csv, reason },
              );
              if (key !== generation.current) return;
              setPreview(result);
              setReviewed(false);
              setPage(0);
              await loadHistory();
            })
          }
        >
          <Upload size={17} />
          Preview score changes
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <section
            className="grade-import-review"
            aria-label="Grade import review"
          >
            <div className="grade-import-heading">
              <div>
                <h3>
                  {preview.plan.sectionName} · {preview.plan.termName}
                </h3>
                <p>
                  Gradebook version {preview.plan.bookVersion} ·{" "}
                  {preview.plan.changed} changed · {rows.length} supplied
                </p>
              </div>
              <Badge tone={preview.plan.errors ? "warm" : "success"}>
                {preview.plan.errors
                  ? `${preview.plan.errors} issues`
                  : "Ready for review"}
              </Badge>
            </div>
            <p>Reason: {preview.reason}</p>
            {preview.plan.missing.length > 0 && (
              <p className="error">
                Missing students:{" "}
                {preview.plan.missing.map((x: any) => x.studentName).join(", ")}
                . Keep the complete captured roster.
              </p>
            )}
            <p className="muted">
              Scroll the table sideways on small screens to see every column.
            </p>
            <div
              className="table-scroll"
              role="region"
              aria-label="Grade import changes table"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Student / row</th>
                    <th>Current score</th>
                    <th>Imported score</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(page * 25, (page + 1) * 25).map((row: any) => (
                    <tr key={row.row}>
                      <td>
                        <strong>{row.studentName}</strong>
                        <small>{workbookSource ? `Worksheet row ${workbookSource.rowMap.find(item => item.csvRow === row.row)?.worksheetRow ?? 'unavailable'} · Converted CSV row ${row.row}` : `CSV row ${row.row}`}</small>
                      </td>
                      <td>
                        <Score value={row.before} />
                      </td>
                      <td>
                        <Score value={row.after} />
                      </td>
                      <td>
                        {row.errors.length
                          ? row.errors.join(" ")
                          : row.changed
                            ? "Change"
                            : "Unchanged"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grade-import-pagination">
              <button
                className="button secondary"
                disabled={!page || busy}
                onClick={() => setPage((x) => x - 1)}
              >
                Previous rows
              </button>
              <span>
                {page * 25 + 1}–{Math.min((page + 1) * 25, rows.length)} of{" "}
                {rows.length}
              </span>
              <button
                className="button secondary"
                disabled={(page + 1) * 25 >= rows.length || busy}
                onClick={() => setPage((x) => x + 1)}
              >
                Next rows
              </button>
            </div>
            {applied ? (
              <p className="school-notice" role="status">
                <CheckCircle2 size={18} />
                Applied once: {(savedReceipt ?? preview.receipt).changed} changed scores.
                Gradebook version {(savedReceipt ?? preview.receipt).bookVersion}. The reviewed
                source and receipt are preserved.
              </p>
            ) : (
              <>
                {expired && !applyUncertain && (
                  <p className="error">
                    This preview expired. Download a fresh template.
                  </p>
                )}
                {!preview.plan.changed && !preview.plan.errors && (
                  <p>No score changes were found.</p>
                )}
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    disabled={
                      busy ||
                      applyUncertain ||
                      expired ||
                      !!preview.plan.errors ||
                      !preview.plan.changed
                    }
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the student identities, scores, notes and reason.
                </label>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (!applyUncertain && (!reviewed || expired || !!preview.plan.errors || !preview.plan.changed))
                  }
                  onClick={() => void run(apply)}
                >
                  <CheckCircle2 size={17} />
                  {applyUncertain ? 'Retry same reviewed scores' : 'Apply reviewed scores'}
                </button>
              </>
            )}
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  download(
                    `/school/grade-imports/${preview.id}/source`,
                    "stjw-grade-import-source.txt",
                  ),
                )
              }
            >
              Download retained CSV source
            </button>
            <p className="muted">The source download retains the imported CSV, not the original Excel file or worksheet mapping. Keep your workbook separately.</p>
          </section>
        )}
        {!!history.length && (
          <details>
            <summary>Your recent import previews and receipts</summary>
            <p>
              Private to your account. Current class access is still required.
            </p>
            <div className="grade-import-history">
              {history.map((row) => (
                <button
                  className="button secondary"
                  disabled={sourceLocked}
                  key={row.id}
                  onClick={() => {
                    if (
                      unfinished &&
                      !window.confirm(
                        "Discard the edited CSV and open this saved preview?",
                      )
                    )
                      return;
                    void run(async () => {
                      const key = generation.current;
                      const result = await api(
                        `/school/grade-imports/${row.id}`,
                      );
                      if (!current(key)) return;
                      changed(); clearWorkbook(); setFileName(''); setReason('');
                      setCsv("");
                      setPreview(result);
                    });
                  }}
                >
                  {row.applied_at ? "Applied" : "Preview"} ·{" "}
                  {new Date(row.created_at).toLocaleString()}
                </button>
              ))}
            </div>
          </details>
        )}
        <div className="dialog-actions">
          <button
            className="button secondary"
            disabled={sourceLocked}
            onClick={onClose}
          >
            Close import
          </button>
        </div>
      </div>
    </Modal>
  );
}
