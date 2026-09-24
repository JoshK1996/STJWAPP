import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { BarChart3, Download, Printer, RefreshCw } from "lucide-react";
import { api, downloadPost } from "./api";
import { Badge, Empty, Panel } from "./components";
import "./attendance-reports.css";
const label = (value: string) => value.replaceAll("_", " ");
const date = (value: string) =>
  DateTime.fromISO(value, { zone: "UTC" }).toFormat("LLL d, yyyy");
function Trend({ result }: { result: any }) {
  const rows = result.trends,
    max = Math.max(1, ...rows.map((x: any) => x.total)),
    start = DateTime.fromISO(result.range.from, { zone: "UTC" }),
    days = Math.max(
      1,
      DateTime.fromISO(result.range.to, { zone: "UTC" }).diff(start, "days")
        .days,
    );
  const x = (day: string) =>
      48 +
      (DateTime.fromISO(day, { zone: "UTC" }).diff(start, "days").days / days) *
        570,
    y = (value: number) => 188 - (value / max) * 145;
  return (
    <div className="attendance-trend">
      <div className="attendance-trend-legend">
        <span>
          <i />
          Recorded marks
        </span>
        <span>
          <i />
          Absence marks
        </span>
      </div>
      <svg
        role="img"
        aria-label="Recorded class-period attendance marks over time"
        viewBox="0 0 650 230"
      >
        <title>
          Recorded class-period marks and absence marks; missing roll calls are
          excluded
        </title>
        {[0, Math.ceil(max / 2), max]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((v) => (
            <g key={v}>
              <line x1="45" x2="620" y1={y(v)} y2={y(v)} />
              <text x="38" y={y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
        {["total", "absent"].map((metric) => (
          <g key={metric} className={"attendance-series " + metric}>
            <polyline
              points={rows
                .map((r: any) => `${x(r.date)},${y(r[metric])}`)
                .join(" ")}
            />
            {rows.map((r: any) => (
              <circle key={r.date} cx={x(r.date)} cy={y(r[metric])} r="3">
                <title>
                  {r.date}: {r[metric]}{" "}
                  {metric === "total" ? "recorded marks" : "absence marks"}
                </title>
              </circle>
            ))}
          </g>
        ))}
        <text x="48" y="214">
          {date(result.range.from)}
        </text>
        <text x="620" y="214" textAnchor="end">
          {date(result.range.to)}
        </text>
      </svg>
      <p>
        Counts refer to the selected attendance period in each class. Lines
        connect dates with submitted marks.
      </p>
    </div>
  );
}
export default function AttendanceReports({
  unitId,
  yearId,
  notify,
}: {
  unitId: string;
  yearId: string;
  notify: (text: string, error?: boolean) => void;
}) {
  const [options, setOptions] = useState<any>(null),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [period, setPeriod] = useState(""),
    [sectionIds, setSections] = useState<string[]>([]),
    [studentNumber, setStudentNumber] = useState(""),
    [includeNotes, setNotes] = useState(false),
    [recordedOnly, setRecordedOnly] = useState(true),
    [result, setResult] = useState<any>(null),
    [signature, setSignature] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tab, setTab] = useState("overview"),
    [page, setPage] = useState(0);
  const input = {
      unitId,
      yearId,
      from,
      to,
      period,
      sectionIds,
      studentNumber,
      includeNotes,
      recordedOnly,
    },
    currentSignature = JSON.stringify(input),
    stale = signature !== currentSignature;
  useEffect(() => {
    let active = true;
    void api(
      "/school/attendance/reports/options?" +
        new URLSearchParams({ unitId, yearId }),
    )
      .then((data) => {
        if (!active) return;
        setOptions(data);
        const end = [data.today, data.year.ends_on].sort()[0],
          begin = [
            DateTime.fromISO(end).startOf("month").toISODate()!,
            data.year.starts_on,
          ]
            .sort()
            .at(-1)!;
        setFrom(begin);
        setTo(end);
        setPeriod(data.periods[0] ?? "");
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [unitId, yearId]);
  async function run() {
    setBusy(true);
    setError("");
    try {
      const data = await api("/school/attendance/reports/run", input);
      setResult(data);
      setSignature(currentSignature);
      setPage(0);
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function exportData(dataset = "marks", format = "csv") {
    setBusy(true);
    try {
      await downloadPost(
        "/school/attendance/reports/export?" +
          new URLSearchParams({ dataset, format }),
        input,
        `attendance-${dataset}.${format}`,
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const rows = result
      ? tab === "coverage"
        ? result.coverage
        : result.rows
      : [],
    shown = rows.slice(page * 50, page * 50 + 50);
  return (
    <div className="attendance-reports">
      <div className="attendance-report-title">
        <div>
          <h2>
            <BarChart3 size={24} />
            Attendance, over time
          </h2>
          <p>
            Review recorded marks, changes in attendance, and the roll calls
            that still need attention.
          </p>
        </div>
        <Badge tone="outline">Class-period records</Badge>
      </div>
      <form
        className="attendance-report-filters attendance-report-no-print"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          From
          <input
            aria-label="Attendance report from"
            type="date"
            required
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          Through
          <input
            aria-label="Attendance report through"
            type="date"
            required
            value={to}
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Attendance period
          <select
            aria-label="Attendance report period"
            required
            value={period}
            disabled={busy}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="">Choose a period</option>
            {options?.periods.map((p: string) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Student number (optional)
          <input
            aria-label="Attendance report student number"
            maxLength={40}
            value={studentNumber}
            disabled={busy}
            onChange={(e) => setStudentNumber(e.target.value)}
          />
        </label>
        <details className="attendance-report-class-picker">
          <summary>
            {sectionIds.length
              ? sectionIds.length + " selected classes"
              : "All permitted classes"}
          </summary>
          <p>
            Choose a class group, or leave all unchecked for every permitted
            class.
          </p>
          {options?.classes.map((c: any) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={sectionIds.includes(c.id)}
                disabled={busy}
                onChange={(e) =>
                  setSections(
                    e.target.checked
                      ? [...sectionIds, c.id]
                      : sectionIds.filter((id) => id !== c.id),
                  )
                }
              />
              {c.name}
              {c.archived ? " (archived)" : ""}
            </label>
          ))}
        </details>
        <div className="attendance-report-toggles">
          <label>
            <input
              type="checkbox"
              checked={!recordedOnly}
              disabled={busy}
              onChange={(e) => setRecordedOnly(!e.target.checked)}
            />
            Include draft and removed rows
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeNotes}
              disabled={busy}
              onChange={(e) => setNotes(e.target.checked)}
            />
            Include attendance notes
          </label>
        </div>
        <button
          className="button primary"
          disabled={busy || !period || !yearId}
        >
          <RefreshCw size={16} />
          {busy ? "Preparing…" : "Run attendance report"}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!result ? (
        <Empty
          title="Choose the dates you want to understand"
          detail="Run a report to see submitted marks, class coverage and daily trends. Actual instructional dates remain under School setup."
        />
      ) : (
        <>
          {stale && (
            <p className="attendance-report-stale" role="status">
              Filters changed. Run the report again to apply them. The results
              below retain the previous filters.
            </p>
          )}
          <div className="attendance-report-result-heading">
            <div>
              <h3>
                {result.year.name} · {date(result.range.from)} –{" "}
                {date(result.range.to)}
              </h3>
              <p>
                {result.period} · {result.timezone} · Generated{" "}
                {new Date(result.asOf).toLocaleString()}
              </p>
              {(result.range.from !== result.requestedRange.from ||
                result.range.to !== result.requestedRange.to) && (
                <p>The range was limited to this school year through today.</p>
              )}
            </div>
            <div className="attendance-report-downloads attendance-report-no-print">
              <button
                className="button secondary"
                disabled={busy || stale}
                onClick={() => void exportData()}
              >
                <Download size={16} />
                Marks CSV
              </button>
              <button
                className="button secondary"
                disabled={busy || stale}
                onClick={() => void exportData("coverage")}
              >
                <Download size={16} />
                Coverage CSV
              </button>
              <button
                className="button secondary"
                disabled={busy || stale}
                onClick={() => void exportData("marks", "json")}
              >
                JSON
              </button>
              <button
                className="button secondary"
                disabled={busy || stale}
                onClick={() => window.print()}
              >
                <Printer size={16} />
                Print view
              </button>
            </div>
          </div>
          {!result.projectionEnabled && (
            <p className="attendance-report-stale">
              This period is not currently configured for coverage checks.
              Historical marks are retained; no missing roll calls are inferred.
            </p>
          )}
          {!result.policyConfirmed && (
            <p className="attendance-report-stale">
              Instructional configuration is unconfirmed. Coverage is a
              projection of that configuration.
            </p>
          )}
          <div className="attendance-report-metrics">
            {[
              ["Recorded marks", result.summary.recorded],
              ["Absence marks", result.summary.absent],
              [
                "Tardy / early",
                `${result.summary.tardy} / ${result.summary.early}`,
              ],
              ["Draft marks", result.summary.draft],
              ["Missing roll calls", result.summary.notStarted],
              ["Changed rosters", result.summary.rosterChanged],
            ].map(([name, value]) => (
              <div key={name}>
                <span>{name}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="attendance-report-method">{result.notice}</p>
          <nav
            className="segmented attendance-report-no-print"
            aria-label="Attendance report views"
          >
            {[
              ["overview", "Overview"],
              ["marks", "Student marks"],
              ["coverage", "Class coverage"],
            ].map(([key, name]) => (
              <button
                key={key}
                className={tab === key ? "selected" : ""}
                onClick={() => {
                  setTab(key);
                  setPage(0);
                }}
              >
                {name}
              </button>
            ))}
          </nav>
          {tab === "overview" ? (
            <Panel
              title="Daily recorded attendance"
              detail="Original code categories from submitted records; corrections use the newest retained revision."
            >
              {result.trends.length ? (
                <Trend result={result} />
              ) : (
                <Empty
                  title="No submitted marks in this selection"
                  detail="Missing and draft roll calls remain visible in Class coverage."
                />
              )}
              <div className="attendance-category-counts">
                {["present", "absent", "tardy", "early", "other"].map(
                  (category) => (
                    <div key={category}>
                      <span>{label(category)}</span>
                      <strong>{result.summary[category]}</strong>
                    </div>
                  ),
                )}
              </div>
              <p className="muted">
                {result.summary.excusedAbsences} excused absence marks ·{" "}
                {result.summary.removed} removed records excluded from recorded
                totals
              </p>
            </Panel>
          ) : (
            <Panel
              title={
                tab === "coverage"
                  ? "Class-period coverage"
                  : "Captured student marks"
              }
              detail={
                tab === "coverage"
                  ? "Missing-session rows use today’s dated homeroom roster and calendar. A recorded closeout does not by itself confirm that today’s sources still match."
                  : "Names and codes are captured values. Draft and removed rows never count as recorded absences."
              }
            >
              <p className="muted">
                Showing {rows.length ? page * 50 + 1 : 0}–
                {Math.min((page + 1) * 50, rows.length)} of {rows.length} rows.
                Printing includes this page; CSV and JSON include the complete
                selected result.
              </p>
              <div className="table-wrap">
                <table className="school-table attendance-report-table">
                  <thead>
                    <tr>
                      {(tab === "coverage"
                        ? [
                            "Date",
                            "Class",
                            "Status",
                            "Current / captured roster",
                            "Marked",
                            "Closeout record",
                            "Source",
                          ]
                        : [
                            "Date",
                            "Student",
                            "Class",
                            "Recorded code",
                            "Category",
                            "Status",
                            "Source",
                            ...(includeNotes ? ["Note"] : []),
                          ]
                      ).map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row: any, i: number) => (
                      <tr key={row.session_id + ":" + (row.student_id ?? i)}>
                        <td>{row.date}</td>
                        {tab === "coverage" ? (
                          <>
                            <td>{row.class_name}</td>
                            <td>
                              <Badge tone="outline">{label(row.status)}</Badge>
                              {!row.instructional_now && (
                                <small>Not currently instructional</small>
                              )}
                            </td>
                            <td>
                              {row.current_expected} / {row.captured_expected}
                            </td>
                            <td>{row.marked}</td>
                            <td>
                              {label(row.closeout_record)}
                              {row.closeout_version
                                ? " · v" + row.closeout_version
                                : ""}
                            </td>
                            <td>
                              {row.session_version
                                ? "Revision " + row.session_version
                                : "No session"}
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              <strong>{row.student_name}</strong>
                              <small>{row.student_number}</small>
                            </td>
                            <td>{row.class_name}</td>
                            <td>
                              {row.code ?? "Unmarked"}
                              <small>
                                {row.code_label ?? ""}
                                {row.excused ? " · Excused" : ""}
                              </small>
                            </td>
                            <td>{row.category ?? "—"}</td>
                            <td>
                              <Badge tone="outline">
                                {label(row.record_status)}
                              </Badge>
                            </td>
                            <td>
                              Revision {row.session_version}
                              {!row.roster_current && (
                                <small>Roster changed</small>
                              )}
                              {!row.instructional_now && (
                                <small>Calendar changed</small>
                              )}
                            </td>
                            {includeNotes && <td>{row.note}</td>}
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!rows.length && (
                <Empty
                  title="No rows match this selection"
                  detail="Check the period, class group, student number and date range."
                />
              )}
              <div className="attendance-report-pagination attendance-report-no-print">
                <button
                  className="button secondary"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous page
                </button>
                <span>
                  Page {page + 1} of {Math.max(1, Math.ceil(rows.length / 50))}
                </span>
                <button
                  className="button secondary"
                  disabled={(page + 1) * 50 >= rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next page
                </button>
              </div>
            </Panel>
          )}
          <p className="attendance-report-provenance">
            Source fingerprint: <code>{result.sourceHash}</code>
          </p>
        </>
      )}
    </div>
  );
}
