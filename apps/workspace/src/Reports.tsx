import { useCallback, useEffect, useState } from "react";
import Compensation from "./Compensation";
import { DateTime } from "luxon";
import {
  ArrowDownToLine,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { api, download } from "./api";
import { Panel, Empty } from "./components";
import { MiniChart } from "./App";
import ReportLibrary from "./ReportLibrary";
import Finance from "./Finance";
import StaffImport from "./StaffImport";
import {workforceReportV2Schema,type WorkforceReportV2} from '../shared/workforce-reports-v2';
import {ExactWorkforceDuration,ExactWorkforceTimestamp} from './ExactWorkforceTime';
const columnNames: Record<string, string> = {
  employee_name: "Employee",
  unit_name: "Community",
  job_title: "Job",
  kind: "Work / break",
  started_at: "Recorded start (UTC)",
  ended_at: "Recorded end (UTC; blank while open)",
  recorded_duration_microseconds: "Full recorded duration (microseconds; blank while open)",
  clipped_started_at: "Included start (UTC)",
  clipped_ended_at: "Included end (UTC)",
  duration_microseconds: "Included duration (microseconds)",
  shift_id: "Shift ID",
  id: "Segment ID",
  revision: "Shift revision",
};
function HourReports({
  me,
  jobs,
  notify,
  onChange,
  onDirty,
}: {
  me: any;
  jobs: any[];
  notify: (message: string, error?: boolean) => void;
  onChange: () => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const today = DateTime.now().setZone(me.organization.timezone);
  const [start, setStart] = useState(today.startOf("week").toISODate()!),
    [end, setEnd] = useState(today.toISODate()!),
    [group, setGroup] = useState("day"),
    [unit, setUnit] = useState("");
  const [report, setReport] = useState<WorkforceReportV2|null>(null),
    [loadingReport,setLoadingReport]=useState(false),
    [busy, setBusy] = useState(false),
    [columns, setColumns] = useState([
      "employee_name",
      "unit_name",
      "job_title",
      "kind",
      "started_at",
      "ended_at",
      "clipped_started_at",
      "clipped_ended_at",
      "duration_microseconds",
    ]),
    [error, setError] = useState("");
  const query = new URLSearchParams({
    start,
    end,
    group,
    ...(unit ? { unitId: unit } : {}),
  }).toString();
  useEffect(() => {
    let cancelled = false;
    setError("");
    setReport(null);setLoadingReport(true);
    void api("/reports/v2?" + query)
      .then((data) => {
        if (!cancelled) setReport(workforceReportV2Schema.parse(data));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setReport(null);
        }
      }).finally(()=>{if(!cancelled)setLoadingReport(false);});
    return () => {
      cancelled = true;
    };
  }, [query]);
  async function execute(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Panel
        className="exact-workforce-report-panel"
        title="Recorded time"
        detail="Exact work and break durations, with the detail behind every total."
        action={
          <div className="exact-workforce-export-actions">
          <button
            className="button primary small"
            disabled={busy || !report || !columns.length}
            onClick={() =>
              void execute(() =>
                download(
                  `/reports/v2/export?${query}&columns=${columns.join(",")}`,
                  `stjw-time-v2-${start}-${end}.csv`,
                ),
              )
            }
          >
            <ArrowDownToLine size={16} />
            Export CSV
          </button>
          <button className="button secondary small" disabled={busy||!report} onClick={()=>void execute(()=>download(`/reports/v2/export?${query}&format=json`,`stjw-time-v2-evidence-${start}-${end}.json`))}>
            <ArrowDownToLine size={16}/>Download evidence JSON
          </button>
          </div>
        }
      >
        <div className="report-controls">
          <label>
            From
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label>
            Group by
            <select aria-label="Group by" value={group} onChange={(e) => setGroup(e.target.value)}>
              {["hour", "day", "week", "month", "year"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Community
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="">All permitted communities</option>
              {me.units.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="quick-ranges">
          {[
            ["Today", "day"],
            ["This week", "week"],
            ["This month", "month"],
            ["This year", "year"],
          ].map(([label, period]) => (
            <button
              key={period}
              onClick={() => {
                setStart(today.startOf(period as any).toISODate()!);
                setEnd(today.toISODate()!);
                if (period === "year") setGroup("month");
                else setGroup("day");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {loadingReport&&<p role="status" className="panel-note">Loading recorded time…</p>}
        {report && (
          <>
            <div className="report-totals">
              <div>
                <small>Recorded work</small>
                <strong>
                  <ExactWorkforceDuration value={report.workMicroseconds}/>
                </strong>
              </div>
              <div>
                <small>Recorded breaks</small>
                <strong>
                  <ExactWorkforceDuration value={report.breakMicroseconds}/>
                </strong>
              </div>
              <div>
                <small>People in this range</small>
                <strong>{report.staff.length}</strong>
              </div>
              <div>
                <small>Time segments</small>
                <strong>{report.rows.length}</strong>
              </div>
            </div>
            {report.buckets.length ? (
              <>
                <MiniChart buckets={report.buckets} />
                <details className="exact-workforce-periods">
                  <summary>View exact totals by period</summary>
                  <p>Read the same periods shown in the chart, with recorded work and breaks listed separately.</p>
                  <div className="table-scroll" tabIndex={0} role="region" aria-label="Exact recorded time by period">
                    <table>
                      <caption className="sr-only">Exact recorded work and breaks by {report.query.group}, in {report.timezone}</caption>
                      <thead><tr><th scope="col">Period</th><th scope="col">Recorded work</th><th scope="col">Recorded breaks</th></tr></thead>
                      <tbody>{report.buckets.map(bucket => <tr key={bucket.key}>
                        <th scope="row">{bucket.label}</th>
                        <td className="numeric"><ExactWorkforceDuration value={bucket.workMicroseconds}/></td>
                        <td className="numeric"><ExactWorkforceDuration value={bucket.breakMicroseconds}/></td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <Empty
                title="No recorded time in this range"
                detail="Try another date range or community."
              />
            )}
            <p className="panel-note">
              {report.notice} Open shifts contribute only through this report’s captured time:{" "}
              <ExactWorkforceTimestamp value={report.asOf} zone={report.timezone}/>. Durations show hours, minutes and exact seconds; these are recorded time, not calculated pay.
            </p>
            <details className="id-guide"><summary>Report time boundaries and precision</summary><dl>
              <dt>Time zone</dt><dd>{report.timezone}</dd>
              <dt>Captured at (UTC)</dt><dd><code>{report.asOf}</code></dd>
              <dt>Range starts (included, UTC)</dt><dd><code>{report.range.from}</code></dd>
              <dt>Range ends (excluded, UTC)</dt><dd><code>{report.range.toExclusive}</code></dd>
              <dt>Recorded precision</dt><dd>Microseconds · report version 2. One microsecond is one millionth of a second.</dd>
              <dt>Source segments</dt><dd>{report.sourceRowCount}; {report.contributingRowCount} contribute positive duration.</dd>
            </dl></details>
          </>
        )}
      </Panel>
      <div className="two-columns">
        <Panel
          title="People in this report"
          detail="Exact durations are added before formatting; fractional seconds are retained."
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Recorded work</th>
                  <th>Recorded breaks</th>
                </tr>
              </thead>
              <tbody>
                {report?.staff.map((s) => (
                  <tr key={s.userId}>
                    <td>{s.name.replace(" (Demo)", "")}</td>
                    <td className="numeric"><ExactWorkforceDuration value={s.workMicroseconds}/></td>
                    <td className="numeric"><ExactWorkforceDuration value={s.breakMicroseconds}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel
          className="exact-workforce-export-panel"
          title="Build your export"
          detail="Choose the columns that belong in your report."
        >
          <fieldset className="column-options">
            <legend className="sr-only">Export columns</legend>
            {Object.entries(columnNames).map(([key, label]) => (
              <label className="check-label" key={key}>
                <input
                  type="checkbox"
                  checked={columns.includes(key)}
                  onChange={(e) =>
                    setColumns(
                      e.target.checked
                        ? [...columns, key]
                        : columns.filter((x) => x !== key),
                    )
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <p className="panel-note">
            CSV uses your selected columns and exact microsecond integers. JSON includes the complete time range, time zone, captured time and source rows. Each download samples the current authorized records again and is recorded in the activity log; it may differ from the view above.
          </p>
          <p className="panel-note">For an Excel workbook, open Report library, save a reviewed report copy, and choose Download Excel.</p>
        </Panel>
      </div>
      {me.permissions.manage && <StaffImport me={me} jobs={jobs} notify={notify} onChange={onChange} onDirty={onDirty} />}
    </>
  );
}

export default function Reports(props: {
  me: any;
  jobs: any[];
  notify: (message: string, error?: boolean) => void;
  onChange: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const [view, setView] = useState("library"),
    [dirty, setDirty] = useState(false);
  const onDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      props.onDirty(value);
    },
    [props.onDirty],
  );
  return (
    <>
      <div
        className="report-library-tabs"
        role="group"
        aria-label="Report workspace"
      >
        <button
          className={"button " + (view === "library" ? "primary" : "secondary")}
          onClick={() => {
            if (
              dirty &&
              !window.confirm("Discard your unsaved report changes?")
            )
              return;
            setView("library");
          }}
        >
          Report library
        </button>
        <button
          className={"button " + (view === "hours" ? "primary" : "secondary")}
          onClick={() => {
            if (
              dirty &&
              !window.confirm("Discard your unsaved report changes?")
            )
              return;
            setView("hours");
          }}
        >
          Hours & imports
        </button>
        {["developer", "owner", "admin", "finance"].includes(props.me.actor.role) && (
          <button
            className={
              "button " + (view === "finance" ? "primary" : "secondary")
            }
            onClick={() => {
              if (
                dirty &&
                !window.confirm("Discard your unsaved report changes?")
              )
                return;
              setView("finance");
            }}
          >
            Financial reports
          </button>
        )}
        {["developer", "owner", "admin", "finance"].includes(props.me.actor.role) && (
          <button
            className={
              "button " + (view === "compensation" ? "primary" : "secondary")
            }
            onClick={() => {
              if (dirty && !window.confirm("Discard your unsaved changes?"))
                return;
              setView("compensation");
            }}
          >
            Employee pay records
          </button>
        )}
      </div>
      {view === "library" ? (
        <ReportLibrary me={props.me} notify={props.notify} onDirty={onDirty} />
      ) : view === "finance" ? (
        <Finance me={props.me} notify={props.notify} onDirty={onDirty} />
      ) : view === "compensation" ? (
        <Compensation notify={props.notify} onDirty={onDirty} />
      ) : (
        <HourReports {...props} onDirty={onDirty} />
      )}
    </>
  );
}
