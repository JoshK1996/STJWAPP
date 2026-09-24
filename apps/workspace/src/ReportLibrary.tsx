import "./attendance-reports.css";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  BookOpen,
  Download,
  FileBarChart2,
  Play,
  Plus,
  Printer,
  Save,
} from "lucide-react";
import { DateTime } from "luxon";
import { api, download } from "./api";
import { Panel, Badge, Empty } from "./components";
import ReportSnapshots from "./ReportSnapshots";
import { ExactWorkforceCell, ExactWorkforceDuration, WorkforcePrecisionEvidence, workforceColumnLabel } from './ExactWorkforceTime';
import { workforceBarPercent, workforceChartScale } from '../shared/workforce-display';
import {
  initialDefinition,
  initialWorkforceDefinitionV2,
  workforceV2Catalog,
  outputColumns,
  reportDefinition,
  reportSources,
  sourceCatalog,
  type ReportDefinition,
  type ReportSource,
} from "../shared/report-library";
import "./report-library.css";
type Props = {
  me: any;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
};
type Editor = {
  id: string;
  version: number;
  name: string;
  description: string;
  definition: ReportDefinition;
  archived: boolean;
};
const fresh = (source: ReportSource = "workforce"): Editor => ({
  id: crypto.randomUUID(),
  version: 0,
  name: "",
  description: "",
  definition: source === 'workforce' ? initialWorkforceDefinitionV2() : initialDefinition(source),
  archived: false,
});
const editorFrom = (row: any): Editor => ({
  id: row.id,
  version: row.version,
  name: row.name,
  description: row.description,
  definition: row.definition,
  archived: row.archived,
});
const display = (value: any) =>
  value === null || value === undefined
    ? "—"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);
const definitionSignature = (value: ReportDefinition) => {
  const parsed = reportDefinition.safeParse(value);
  return JSON.stringify(parsed.success ? parsed.data : value);
};

export default function ReportLibrary({ me, notify, onDirty }: Props) {
  const [editor, setEditor] = useState<Editor>(fresh),
    [baseline, setBaseline] = useState(""),
    [saved, setSaved] = useState<any[]>([]),
    [options, setOptions] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [snapshotDirty, setSnapshotDirty] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>(null),
    [resultDefinition, setResultDefinition] = useState(""),
    [page, setPage] = useState(0),
    [showArchived, setShowArchived] = useState(false),
    [reason, setReason] = useState(""),
    [history, setHistory] = useState<any[] | null>(null),
    [metric, setMetric] = useState("record_count");
  const signature = JSON.stringify(editor),
    dirty = baseline !== "" && signature !== baseline;
  useEffect(() => {
    setBaseline(JSON.stringify(editor));
    void Promise.all([api("/report-library"), api("/report-library/options")])
      .then(([list, catalog]) => {
        setSaved(list.rows);
        setOptions(catalog);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    onDirty(dirty || snapshotDirty || busy);
    return () => onDirty(false);
  }, [dirty, snapshotDirty, busy, onDirty]);
  const def = editor.definition,
    exact = def.source === 'workforce' && 'precisionVersion' in def && def.precisionVersion === 2,
    catalog = exact ? workforceV2Catalog : sourceCatalog[def.source],
    columns = outputColumns(def),
    resultStale = resultDefinition !== definitionSignature(def);
  const [attendanceOptions, setAttendanceOptions] = useState<any>(null);
  const [financeOptions, setFinanceOptions] = useState<any[] | null>(null);
  const financeUnit = def.source === "finance" ? def.unitId : "";
  useEffect(() => {
    let active = true;
    setFinanceOptions(null);
    if (financeUnit)
      void api(
        "/report-library/finance-options?" +
          new URLSearchParams({ unitId: financeUnit }),
      )
        .then((data) => {
          if (active) setFinanceOptions(data.rows);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [financeUnit]);
  const attendanceYear = def.source === "attendance" ? def.yearId : "",
    attendanceUnit = def.source === "attendance" ? def.unitId : "";
  useEffect(() => {
    let active = true;
    setAttendanceOptions(null);
    if (attendanceYear && attendanceUnit)
      void api(
        "/school/attendance/reports/options?" +
          new URLSearchParams({
            unitId: attendanceUnit,
            yearId: attendanceYear,
          }),
      )
        .then((data) => {
          if (active) setAttendanceOptions(data);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [attendanceYear, attendanceUnit]);
  async function execute(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function choose(next: Editor) {
    if ((dirty || snapshotDirty) && !window.confirm("Leave this report and discard unsaved changes or an open report review? A submitted save may have completed; check Saved reports before preparing another copy."))
      return;
    setEditor(next);
    setBaseline(JSON.stringify(next));
    setResult(null);
    setHistory(null);
    setReason("");
    setPage(0);
  }
  function updateDef(patch: Record<string, unknown>) {
    setEditor((old) => ({
      ...old,
      definition: { ...old.definition, ...patch } as ReportDefinition,
    }));
  }
  async function persist(archived = editor.archived) {
    const row = await api("/report-library", {
      ...editor,
      archived,
      reason: editor.version ? reason : "Created a personal report definition",
    });
    const next = editorFrom(row);
    setEditor(next);
    setBaseline(JSON.stringify(next));
    setReason("");
    setHistory(null);
    setSaved((await api("/report-library")).rows);
    notify(
      archived
        ? "Report archived. Its history is retained."
        : "Report saved to your library.",
    );
  }
  async function run() {
    const data = await api("/report-library/preview", def);
    setResult({ ...data, name: editor.name || "Untitled report" });
    setResultDefinition(definitionSignature(def));
    setPage(0);
    setMetric("record_count");
  }
  function toggleColumn(key: string) {
    const next = def.columns.includes(key)
      ? def.columns.filter((x) => x !== key)
      : [...def.columns, key];
    updateDef({
      columns: next,
      ...(def.layout === "details" && !next.includes(def.sort.key)
        ? { sort: { ...def.sort, key: next[0] ?? "" } }
        : {}),
    });
  }
  function moveColumn(index: number, step: number) {
    const next = [...def.columns];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    updateDef({ columns: next });
  }
  function changeSource(source: ReportSource) {
    const next = source === 'workforce' ? initialWorkforceDefinitionV2() : initialDefinition(source);
    if (next.source === "care") next.programId = options?.programs[0]?.id ?? "";
    if (next.source === "grades") next.bookId = options?.books[0]?.id ?? "";
    setEditor((old) => ({ ...old, definition: next }));
    setResult(null);
    setHistory(null);
  }
  function changePrecision(nextExact: boolean) {
    if (def.source !== 'workforce') return;
    if (nextExact === exact) return;
    const next = nextExact ? initialWorkforceDefinitionV2() : initialDefinition('workforce');
    setEditor(old => ({...old, definition: {...next, range: def.range, unitId: def.unitId, layout: def.layout, groupBy: def.groupBy, sort: def.layout === 'summary' ? {key:'group_name',direction:'asc'} : next.sort} as ReportDefinition}));
    setResult(null); setResultDefinition(''); setHistory(null); setPage(0); setMetric('record_count');
  }
  const canExport = editor.version > 0 && !dirty && !editor.archived;
  function table(rows: any[]) {
    return (
      <table>
        <thead>
          <tr>
            {result.columns.map((c: any) => (
              <th key={c.key}>{result.precisionVersion === 2 ? workforceColumnLabel(c.label) : c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any, index: number) => (
            <tr key={index}>
              {result.columns.map((c: any) => (
                <td
                  key={c.key}
                  className={typeof row[c.key] === "number" ? "numeric" : ""}
                >
                  {result.precisionVersion === 2 ? <ExactWorkforceCell column={c.key} value={row[c.key]} zone={result.timezone}/> : display(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const chartRows =
      result?.definition.layout === "summary" ? result.rows.slice(0, 30) : [],
    exactMetric = result?.precisionVersion === 2 && metric.endsWith('_microseconds'),
    exactChartMax = exactMetric ? workforceChartScale(chartRows.map((r:any)=>r[metric])).maximum : '1',
    chartMax = exactMetric ? 1 : Math.max(
      metric === "amount" ? 0.0001 : 1,
      ...chartRows.map((r: any) => Math.abs(Number(r[metric] ?? 0))),
    );
  return (
    <div className="report-library">
      <Panel
        title="Your report library"
        detail="Save a reusable layout with the source and fields you need."
        action={
          <button
            className="button primary small"
            onClick={() => choose(fresh())}
            disabled={busy}
          >
            <Plus size={16} />
            New report
          </button>
        }
      >
        <div className="report-source-cards">
          {reportSources.map((source) => (
            <button
              className="report-source-card"
              key={source}
              onClick={() => {
                const next = fresh(source);
                if (next.definition.source === "care")
                  next.definition.programId = options?.programs[0]?.id ?? "";
                if (next.definition.source === "grades")
                  next.definition.bookId = options?.books[0]?.id ?? "";
                choose(next);
              }}
              disabled={busy}
            >
              <span className="small-icon">
                {source === "grades" ? (
                  <BookOpen size={23} />
                ) : (
                  <FileBarChart2 size={23} />
                )}
              </span>
              <strong>{sourceCatalog[source].label}</strong>
              <small>{source === 'workforce' ? workforceV2Catalog.detail : sourceCatalog[source].detail}</small>
              <span>Start with this template →</span>
            </button>
          ))}
        </div>
        <div className="library-list-heading">
          <h3>Saved by you</h3>
          <label className="check-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Include archived
          </label>
        </div>
        {saved.filter((r) => showArchived || !r.archived).length ? (
          <div className="saved-report-list">
            {saved
              .filter((r) => showArchived || !r.archived)
              .map((row) => (
                <button
                  key={row.id}
                  className={editor.id === row.id ? "selected" : ""}
                  onClick={() => choose(editorFrom(row))}
                  disabled={busy}
                >
                  <span>
                    <strong>{row.name}</strong>
                    <small>
                      {
                        sourceCatalog[row.definition.source as ReportSource]
                          .label
                      }{" "}
                      · Version {row.version}
                      {row.definition.source === 'workforce' ? row.definition.precisionVersion === 2 ? ' · Exact microseconds' : ' · Legacy milliseconds' : ''}
                      {row.archived ? " · Archived" : ""}
                    </small>
                  </span>
                  <span>Open →</span>
                </button>
              ))}
          </div>
        ) : (
          <p className="panel-note">
            Your saved layouts will appear here. They are private to your
            account.
          </p>
        )}
      </Panel>
      <Panel
        title={editor.version ? editor.name || "Edit report" : "Build a report"}
        detail="Choose the information and order that work for you."
        action={
          <Badge tone={dirty ? "warm" : "neutral"}>
            {editor.archived
              ? "Archived"
              : dirty
                ? "Unsaved changes"
                : editor.version
                  ? `Version ${editor.version}`
                  : "New definition"}
          </Badge>
        }
      >
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <fieldset
          className="report-editor-fields"
          disabled={busy || editor.archived}
        >
          <div className="report-controls">
            <label>
              Report name
              <input
                aria-label="Report name"
                value={editor.name}
                maxLength={100}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="For example, weekly school hours"
              />
            </label>
            <label>
              Data source
              <select
                aria-label="Data source"
                value={def.source}
                onChange={(e) => changeSource(e.target.value as ReportSource)}
              >
                {reportSources.map((s) => (
                  <option key={s} value={s} disabled={s === "compensation" && !["developer","owner","admin","finance"].includes(me.actor.role)}>
                    {sourceCatalog[s].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {def.source === 'workforce' && <div className="workforce-precision-choice">
            <label>Time precision<select aria-label="Time precision" value={exact?'2':'legacy'} onChange={e=>changePrecision(e.target.value==='2')}><option value="2">Exact microseconds</option><option value="legacy">Legacy milliseconds</option></select></label>
            <p className="panel-note">Changing precision resets selected columns and sorting. Preview and save the changed layout explicitly. Previously saved report copies keep their original precision and files.</p>
          </div>}
          <label>
            Description
            <textarea
              aria-label="Description"
              value={editor.description}
              maxLength={500}
              rows={2}
              onChange={(e) =>
                setEditor({ ...editor, description: e.target.value })
              }
              placeholder="What this report helps you review"
            />
          </label>
          <div className="report-controls">
            {def.source === "finance" && (
              <>
                <label>
                  Financial community
                  <select
                    aria-label="Financial community"
                    value={def.unitId}
                    onChange={(e) =>
                      updateDef({
                        unitId: e.target.value,
                        financialReportId: "",
                        financialVersion: 1,
                      })
                    }
                  >
                    <option value="">Choose a community</option>
                    {options?.units.map((u: any) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Published source
                  <select
                    aria-label="Published source"
                    value={def.financialReportId}
                    disabled={!financeOptions}
                    onChange={(e) => {
                      const source = financeOptions?.find(
                        (r) => r.id === e.target.value,
                      );
                      updateDef({
                        financialReportId: e.target.value,
                        financialVersion: source?.version ?? 1,
                      });
                    }}
                  >
                    <option value="">
                      Choose a published financial report
                    </option>
                    {financeOptions?.map((r: any) => (
                      <option key={r.id} value={r.id}>
                        {r.title} · {r.currency} · latest v{r.version}
                        {r.archived ? " · archived source" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Published version
                  <input
                    aria-label="Published version"
                    type="number"
                    min={1}
                    max={
                      financeOptions?.find(
                        (r) => r.id === def.financialReportId,
                      )?.version
                    }
                    step={1}
                    value={def.financialVersion}
                    onChange={(e) =>
                      updateDef({ financialVersion: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Source rows
                  <select
                    aria-label="Source rows"
                    value={def.rowKinds}
                    onChange={(e) => updateDef({ rowKinds: e.target.value })}
                  >
                    <option value="detail">Detail lines only</option>
                    <option value="all" disabled={def.layout === "summary"}>
                      All lines, including imported totals
                    </option>
                  </select>
                </label>
              </>
            )}
            {(def.source === "workforce" || def.source === "compensation") && (
              <label>
                Community
                <select
                  value={def.unitId ?? ""}
                  onChange={(e) => {
                    const next = { ...def };
                    if (e.target.value) next.unitId = e.target.value;
                    else delete next.unitId;
                    setEditor({ ...editor, definition: next });
                  }}
                >
                  <option value="">All permitted communities</option>
                  {options?.units.map((u: any) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {def.source === "compensation" && (
              <label>
                Rate entries
                <select aria-label="Rate entries" value={def.includeVoided ? "all" : "valid"} onChange={e=>updateDef({includeVoided:e.target.value==="all"})}>
                  <option value="valid">Exclude voided entries</option>
                  <option value="all">Include voided entries</option>
                </select>
              </label>
            )}
            {def.source === "care" && (
              <label>
                Care program
                <select
                  aria-label="Care program"
                  value={def.programId}
                  onChange={(e) => updateDef({ programId: e.target.value })}
                >
                  <option value="">Choose a program</option>
                  {options?.programs.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.archived ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {def.source === "grades" && (
              <label>
                Class and term
                <select
                  aria-label="Class and term"
                  value={def.bookId}
                  onChange={(e) => updateDef({ bookId: e.target.value })}
                >
                  <option value="">Choose a gradebook</option>
                  {options?.books.map((b: any) => (
                    <option key={b.id} value={b.id}>
                      {b.class_name} · {b.term_name} · {b.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {def.source === "attendance" && (
              <>
                <label>
                  School and year
                  <select
                    aria-label="Attendance report school year"
                    value={def.yearId}
                    onChange={(e) => {
                      const y = options?.attendanceYears.find(
                        (x: any) => x.id === e.target.value,
                      );
                      updateDef({
                        yearId: y?.id ?? "",
                        unitId: y?.unit_id ?? "",
                        period: y?.configured_periods[0] ?? "",
                        sectionIds: [],
                      });
                    }}
                  >
                    <option value="">Choose a school year</option>
                    {options?.attendanceYears.map((y: any) => (
                      <option key={y.id} value={y.id}>
                        {y.unit_name} · {y.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Attendance period
                  <select
                    aria-label="Report attendance period"
                    value={def.period}
                    onChange={(e) => updateDef({ period: e.target.value })}
                  >
                    <option value="">Choose a period</option>
                    {attendanceOptions?.periods.map((period: string) => (
                      <option key={period}>{period}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Student number (optional)
                  <input
                    aria-label="Report attendance student number"
                    value={def.studentNumber}
                    maxLength={40}
                    onChange={(e) =>
                      updateDef({ studentNumber: e.target.value })
                    }
                  />
                </label>
                <details className="attendance-report-class-picker">
                  <summary>
                    {def.sectionIds.length
                      ? def.sectionIds.length + " selected classes"
                      : "All permitted classes"}
                  </summary>
                  <p>
                    Choose classes to report on a group, or leave all unchecked
                    for every permitted class.
                  </p>
                  {attendanceOptions?.classes.map((c: any) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={def.sectionIds.includes(c.id)}
                        onChange={(e) =>
                          updateDef({
                            sectionIds: e.target.checked
                              ? [...def.sectionIds, c.id]
                              : def.sectionIds.filter((id) => id !== c.id),
                          })
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </details>
              </>
            )}
            {"range" in def && (
              <label>
                Date range
                <select
                  aria-label="Date range"
                  value={def.range.preset}
                  onChange={(e) =>
                    updateDef({
                      range:
                        e.target.value === "custom"
                          ? {
                              preset: "custom",
                              from: DateTime.now()
                                .setZone(me.organization.timezone)
                                .startOf("month")
                                .toISODate(),
                              to: DateTime.now()
                                .setZone(me.organization.timezone)
                                .toISODate(),
                            }
                          : { preset: e.target.value },
                    })
                  }
                >
                  {[
                    ["today", "Today"],
                    ["this_week", "This week to date"],
                    ["this_month", "This month to date"],
                    ["this_year", "This year to date"],
                    ["last_month", "Last complete month"],
                    ["custom", "Fixed dates"],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {"range" in def && def.range.preset === "custom" && (
              <>
                <label>
                  From
                  <input
                    type="date"
                    value={def.range.from}
                    onChange={(e) =>
                      updateDef({
                        range: { ...def.range, from: e.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Through
                  <input
                    type="date"
                    value={def.range.to}
                    onChange={(e) =>
                      updateDef({ range: { ...def.range, to: e.target.value } })
                    }
                  />
                </label>
              </>
            )}
            <label>
              Layout
              <select
                aria-label="Layout"
                value={def.layout}
                onChange={(e) =>
                  updateDef({
                    layout: e.target.value,
                    ...(def.source === "finance" && e.target.value === "summary"
                      ? { rowKinds: "detail" }
                      : {}),
                    sort: {
                      key:
                        e.target.value === "summary"
                          ? "group_name"
                          : (def.columns[0] ?? ""),
                      direction: "asc",
                    },
                  })
                }
              >
                <option value="details">Detailed rows</option>
                <option value="summary">Grouped summary & chart</option>
              </select>
            </label>
            {def.layout === "summary" && (
              <label>
                Group rows by
                <select
                  aria-label="Group rows by"
                  value={def.groupBy}
                  onChange={(e) => updateDef({ groupBy: e.target.value })}
                >
                  {catalog.groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {def.layout === "details" && (
            <div className="library-columns">
              <fieldset className="column-options">
                <legend>Include columns</legend>
                {catalog.columns.map((c) => (
                  <label className="check-label" key={c.key}>
                    <input
                      type="checkbox"
                      checked={def.columns.includes(c.key)}
                      onChange={() => toggleColumn(c.key)}
                    />
                    {c.label}
                  </label>
                ))}
              </fieldset>
              <div>
                <h3>Column order</h3>
                <ol className="column-order">
                  {def.columns.map((key, index) => (
                    <li key={key}>
                      <span>
                        {catalog.columns.find((c) => c.key === key)?.label}
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${catalog.columns.find((c) => c.key === key)?.label} up`}
                        disabled={index === 0}
                        onClick={() => moveColumn(index, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${catalog.columns.find((c) => c.key === key)?.label} down`}
                        disabled={index === def.columns.length - 1}
                        onClick={() => moveColumn(index, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
          <div className="report-controls">
            <label>
              Sort by
              <select
                aria-label="Sort by"
                value={def.sort.key}
                onChange={(e) =>
                  updateDef({ sort: { ...def.sort, key: e.target.value } })
                }
              >
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order
              <select
                aria-label="Order"
                value={def.sort.direction}
                onChange={(e) =>
                  updateDef({
                    sort: { ...def.sort, direction: e.target.value },
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </div>
        </fieldset>
        {editor.version > 0 && (
          <label>
            Reason for this revision
            <input
              value={reason}
              minLength={5}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain a saved change, archive, or restore"
              disabled={busy}
            />
          </label>
        )}
        <div className="library-actions">
          <button
            className="button primary"
            disabled={busy || editor.archived}
            onClick={() => void execute(run)}
          >
            <Play size={16} />
            Run report
          </button>
          <button
            className="button secondary"
            disabled={
              busy ||
              editor.archived ||
              !editor.name.trim() ||
              (editor.version > 0 && (!dirty || reason.trim().length < 5))
            }
            onClick={() => void execute(() => persist())}
          >
            <Save size={16} />
            Save report
          </button>
          {editor.version > 0 && (
            <>
              <button
                className="button secondary"
                disabled={busy || reason.trim().length < 5 || dirty}
                onClick={() => void execute(() => persist(!editor.archived))}
              >
                <Archive size={16} />
                {editor.archived ? "Restore report" : "Archive report"}
              </button>
              <button
                className="text-link"
                disabled={busy}
                onClick={() =>
                  void execute(async () =>
                    setHistory(
                      (await api(`/report-library/${editor.id}/history`)).rows,
                    ),
                  )
                }
              >
                Revision history
              </button>
            </>
          )}
        </div>
        <p className="panel-note">
          Relative ranges are resolved in {me.organization.timezone} each time
          you run the report. A week begins Monday. Current access is checked on
          every run and download. Saving a layout does not save a copy of its
          results.
        </p>
        {def.source === "finance" && (
          <p className="panel-note">
            Financial sources require current finance, administrator or owner
            access. The source selector shows the latest title; the preview uses
            your selected version’s title, period and amounts. This version
            stays fixed when new versions are published. Summaries always use
            detail lines only.
            {financeOptions?.length === 0
              ? " No published financial reports are available in this community. Publish a reviewed CSV in Finance first."
              : ""}
          </p>
        )}
        {def.source === "compensation" && (
          <p className="panel-note">
            Owner, administrator or finance access is required. Dates select rates effective during any part of the range, using the latest reviewed pay records. A summary counts rate entries; it does not add rates or calculate earnings. Include pay record IDs and versions when tracing entries to their retained history.
          </p>
        )}
        {def.source === "care" && options?.programs.length === 0 && (
          <p className="panel-note">
            No care programs are available with your school-office access.
          </p>
        )}
        {def.source === "grades" && options?.books.length === 0 && (
          <p className="panel-note">
            No gradebooks are available. Create a class gradebook in School, or
            ask the office about your class access.
          </p>
        )}
        {history && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Saved at</th>
                  <th>Reason</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.version}>
                    <td>{h.version}</td>
                    <td>
                      {DateTime.fromISO(h.created_at)
                        .setZone(me.organization.timezone)
                        .toFormat("LLL d, yyyy h:mm a")}
                    </td>
                    <td>{h.reason}</td>
                    <td>
                      <details>
                        <summary>View saved layout</summary>
                        <pre>
                          {JSON.stringify(h.snapshot.definition, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <ReportSnapshots key={editor.id} reportId={editor.id} version={editor.version}
        archived={editor.archived} clean={!dirty} parentBusy={busy}
        timezone={me.organization.timezone} onDirty={setSnapshotDirty} notify={notify} />
      {result && (
        <Panel
          title={result.name}
          detail={`${result.rowCount} report rows from ${result.sourceRowCount} source records · Generated ${DateTime.fromISO(result.asOf).setZone(result.timezone).toFormat("LLL d, yyyy h:mm:ss a ZZZZ")}`}
          action={
            <Badge tone={resultStale ? "warm" : "neutral"}>
              {resultStale ? "Layout changed — run again" : "Live run"}
            </Badge>
          }
        >
          {result.range && (
            <p className="panel-note">
              {result.range.from} through {result.range.to} · {result.timezone}
            </p>
          )}
          {result.source === "grades" && (
            <p className="panel-note">
              Gradebook {result.provenance.bookStatus} · Version{" "}
              {result.provenance.bookVersion} · Policy{" "}
              {result.provenance.policyVersion} · Roster{" "}
              {result.provenance.rosterCurrent
                ? "current"
                : "changed — reconciliation required"}
            </p>
          )}
          {result.source === "finance" && (
            <p className="panel-note financial-library-source">
              <strong>{result.provenance.title}</strong> · Published version{" "}
              {result.provenance.financialVersion} ·{" "}
              {result.provenance.currency} · {result.provenance.sourceName}
              {result.provenance.sourceArchived
                ? " · Archived source retained for historical review"
                : ""}
            </p>
          )}
          <p className="panel-note">{result.notice}</p>
          {result.precisionVersion === 2 && <WorkforcePrecisionEvidence asOf={result.asOf} zone={result.timezone} provenance={result.provenance}/>}
          {result.source === 'workforce' && result.precisionVersion !== 2 && <p className="panel-note">Legacy millisecond report. This layout and its original values remain unchanged.</p>}
          {result.source === "compensation" && <p className="panel-note">
            {result.provenance.recordCount} pay records · {result.sourceRowCount} rate entries · {result.provenance.includeVoided ? "Voided entries included" : "Voided entries excluded"}
          </p>}
          <div className="library-actions">
            <button
              className="button secondary small"
              disabled={busy || !canExport || resultStale}
              onClick={() =>
                void execute(() =>
                  download(
                    `/report-library/${editor.id}/export?version=${editor.version}`,
                    "stjw-saved-report.csv",
                  ),
                )
              }
            >
              <Download size={16} />
              Download current CSV
            </button>
            <button
              className="button secondary small"
              disabled={busy || !canExport || resultStale}
              onClick={() =>
                void execute(() =>
                  download(
                    `/report-library/${editor.id}/export?version=${editor.version}&format=json`,
                    "stjw-saved-report.json",
                  ),
                )
              }
            >
              Download current JSON
            </button>
            <button
              className="button secondary small"
              disabled={busy || resultStale || result.rowCount > 1000}
              onClick={() => window.print()}
            >
              <Printer size={16} />
              Print displayed result
            </button>
          </div>
          <p className="panel-note">
            Save your layout to enable downloads. Downloads rerun it with
            authorized sources and include source/version metadata. Financial
            sources keep the selected published version. Printing uses the
            displayed result, with a 1,000-row limit. Use Saved reports to retain an exact reviewed copy.
          </p>
          {chartRows.length > 0 && (
            <div className="library-chart">
              <label>
                Chart measure
                <select
                  aria-label="Chart measure"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                >
                  <option value="record_count">Record count</option>
                  {!["grades", "attendance", "finance", "compensation"].includes(
                    result.source,
                  ) && <option value={result.precisionVersion === 2 ? 'duration_microseconds' : 'duration_ms'}>{result.precisionVersion === 2 ? 'Recorded duration' : 'Recorded hours'}</option>}
                  {result.source === "finance" && (
                    <option value="amount">Detail amount (magnitude)</option>
                  )}
                </select>
              </label>
              {chartRows.map((r: any) => (
                <div className="library-chart-row" key={r.group_id}>
                  <span>{r.group_name}</span>
                  <div>
                    <i
                      style={{
                        width: `${exactMetric ? workforceBarPercent(r[metric],exactChartMax) : (100 * Math.abs(Number(r[metric] ?? 0))) / chartMax}%`,
                      }}
                    />
                  </div>
                  <strong>
                    {exactMetric ? <ExactWorkforceDuration value={r[metric]}/> : metric === "duration_ms"
                      ? new Intl.NumberFormat("en-US", {
                          maximumFractionDigits: 2,
                        }).format((r[metric] ?? 0) / 3600000)
                      : metric === "amount"
                        ? `${r.amount} ${r.currency}`
                        : r[metric]}
                  </strong>
                </div>
              ))}
              {exactMetric && <p className="panel-note">Bar widths are approximate. Duration labels and exports retain the exact values.</p>}
              {metric === "amount" && (
                <p className="panel-note">
                  Bar lengths show magnitude; labels retain each amount’s sign.
                  Bar widths are approximate; the table and exports retain exact
                  amounts.
                </p>
              )}
              {result.rows.length > 30 && (
                <p className="panel-note">
                  Chart shows the first 30 groups in the selected sort order.
                  The table and exports include all groups.
                </p>
              )}
            </div>
          )}
          {result.rows.length ? (
            <>
              <div className="table-scroll">
                {table(result.rows.slice(page * 25, page * 25 + 25))}
              </div>
              <div className="library-pagination">
                <button
                  className="button secondary small"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Rows {page * 25 + 1}–
                  {Math.min(result.rows.length, (page + 1) * 25)} of{" "}
                  {result.rows.length}
                </span>
                <button
                  className="button secondary small"
                  disabled={(page + 1) * 25 >= result.rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <Empty
              title="No matching records"
              detail="Try another date range or source. Your access also determines which rows are available."
            />
          )}
        </Panel>
      )}
      {result &&
        result.rowCount <= 1000 &&
        createPortal(
          <section className="library-print-root">
            <h1>{result.name}</h1>
            <p>
              {sourceCatalog[result.source as ReportSource].label} ·{" "}
              {result.timezone} · As of {result.asOf}
            </p>
            {result.range && (
              <p>
                {result.range.from} through {result.range.to}
              </p>
            )}
            <p>{result.notice}</p>
            {result.precisionVersion === 2 && <WorkforcePrecisionEvidence asOf={result.asOf} zone={result.timezone} provenance={result.provenance}/>}
            {result.source === "finance" ? (
              <div className="library-print-source">
                <p>
                  <strong>{result.provenance.title}</strong> · Published version{" "}
                  {result.provenance.financialVersion} ·{" "}
                  {result.provenance.currency}
                </p>
                <p>
                  Source: {result.provenance.sourceName} · Published{" "}
                  {result.provenance.sourcePublishedAt}
                  <br />
                  Financial report ID: {result.provenance.financialReportId}
                  <br />
                  Source SHA-256: {result.provenance.sourceHash}
                  <br />
                  Version fingerprint: {result.provenance.fingerprint}
                </p>
                <p>
                  {result.rowCount} report rows / {result.sourceRowCount}{" "}
                  selected source lines ·{" "}
                  {result.provenance.rowKinds === "detail"
                    ? "Detail lines only"
                    : "All imported line kinds"}
                </p>
              </div>
            ) : result.source === "compensation" ? (
              <div className="library-print-source">
                <p>Latest reviewed pay records · {result.provenance.recordCount} pay records · {result.sourceRowCount} rate entries · {result.rowCount} report rows</p>
                <p>{result.provenance.includeVoided ? "Voided entries included" : "Voided entries excluded"}<br />Source SHA-256: {result.provenance.sourceHash}</p>
              </div>
            ) : (
              <p>
                Source versions: {JSON.stringify(result.provenance)} ·{" "}
                {result.rowCount} rows / {result.sourceRowCount} source records
              </p>
            )}
            {table(result.rows)}
          </section>,
          document.body,
        )}
    </div>
  );
}
