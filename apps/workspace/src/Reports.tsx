import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Compensation from "./Compensation";
import { formatReportHours } from "../shared/report-presentation";
import { defaultWorkforcePresentationColumns, workforcePresentationLabels, workforcePresentationValue } from "../shared/workforce-presentation";
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
  const [loadedReport, setReport] = useState<{key:string;data:WorkforceReportV2}|null>(null),
    [loadingReport,setLoadingReport]=useState(false),
    [busy, setBusy] = useState(false),
    [columns, setColumns] = useState([...defaultWorkforcePresentationColumns]),
    [presentation,setPresentation]=useState<'readable'|'exact'>('readable'),
    [error, setError] = useState("");
  const actorKey=`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`;
  const active=useRef(true),actorRef=useRef(actorKey);actorRef.current=actorKey;
  useLayoutEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const query = new URLSearchParams({
    start,
    end,
    group,
    ...(unit ? { unitId: unit } : {}),
  }).toString();
  const reportKey=actorKey+query,report=loadedReport?.key===reportKey?loadedReport.data:null;
  useEffect(() => {
    let cancelled = false;
    setError("");
    setReport(null);setLoadingReport(true);
    void api("/reports/v2?" + query)
      .then((data) => {
        if (!cancelled) setReport({key:reportKey,data:workforceReportV2Schema.parse(data)});
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
  }, [query,actorKey]);
  async function execute(fn: () => Promise<unknown>) {
    const owner=actorKey;setBusy(true);
    try {
      await fn();
    } catch (e) {
      if(active.current&&actorRef.current===owner)notify((e as Error).message, true);
    } finally {
      if(active.current&&actorRef.current===owner)setBusy(false);
    }
  }
  return (
    <>
      <Panel
        className="exact-workforce-report-panel"
        title="Recorded time"
        detail="Readable hours and local dates, with exact audit evidence available when needed."
        action={
          <div className="exact-workforce-export-actions">
          <button
            className="button primary small"
            disabled={busy || !report || !columns.length}
            onClick={() =>
              void execute(() =>
                download(
                  `/reports/v2/export?${query}&presentation=${presentation}&columns=${columns.join(",")}`,
                  `stjw-time-${presentation}-${start}-${end}.csv`,
                  ()=>active.current&&actorRef.current===actorKey,
                ),
              )
            }
          >
            <ArrowDownToLine size={16} />
            Export CSV
          </button>
          <button className="button secondary small" disabled={busy||!report} onClick={()=>void execute(()=>download(`/reports/v2/export?${query}&format=json`,`stjw-time-v2-evidence-${start}-${end}.json`,()=>active.current&&actorRef.current===actorKey))}>
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
                  <span title={report.workMicroseconds+" exact microseconds"}>{formatReportHours(report.workMicroseconds)} h</span>
                </strong>
              </div>
              <div>
                <small>Recorded breaks</small>
                <strong>
                  <span title={report.breakMicroseconds+" exact microseconds"}>{formatReportHours(report.breakMicroseconds)} h</span>
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
              <ExactWorkforceTimestamp value={report.asOf} zone={report.timezone}/>. Summary hours use two decimal places; exact values remain in the detail and source JSON. Recorded time is not calculated pay.
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
          detail="Hours rounded to two places after exact aggregation. Hover for the recorded duration."
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
                    <td className="numeric"><span title={s.workMicroseconds+" exact microseconds"}>{formatReportHours(s.workMicroseconds)} h</span></td>
                    <td className="numeric"><span title={s.breakMicroseconds+" exact microseconds"}>{formatReportHours(s.breakMicroseconds)} h</span></td>
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
          <div className="report-readable-tools"><label>Report style<select value={presentation} onChange={event=>setPresentation(event.target.value as 'readable'|'exact')}><option value="readable">Readable report — hours & local dates</option><option value="exact">Audit CSV — exact source values</option></select></label><div><button className="button secondary small" type="button" onClick={()=>{setColumns([...defaultWorkforcePresentationColumns]);setPresentation('readable');}}>Everyday report</button><button className="button secondary small" type="button" onClick={()=>{setColumns(Object.keys(columnNames));setPresentation('exact');}}>All audit columns</button></div></div>
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
                <span>{presentation==='readable'?workforcePresentationLabels[key]:label}</span>
              </label>
            ))}
          </fieldset>
          <p className="panel-note">
            Readable CSV uses your selected columns, two-decimal hours, local dates and clear names. Audit CSV and JSON retain exact source values. Each download captures current permitted data again and is recorded in the activity log; it may differ from this preview.
          </p>
          <p className="panel-note">Use Payroll for an accountant Excel summary, or Report library for a reusable layout and saved report copy.</p>
          {report&&columns.length>0&&<div className="report-readable-preview"><h4>Export preview</h4><p>First {Math.min(5,report.rows.length)} of {report.rows.length.toLocaleString()} records. The readable download also identifies the period, time zone, capture time and display precision.</p><div className="table-scroll" tabIndex={0} role="region" aria-label="Recorded time export preview"><table><thead><tr>{columns.map(column=><th key={column}>{presentation==='readable'?workforcePresentationLabels[column]:columnNames[column]}</th>)}</tr></thead><tbody>{report.rows.slice(0,5).map(row=><tr key={row.id}>{columns.map(column=><td key={column}>{presentation==='readable'?workforcePresentationValue(column,row[column as keyof typeof row],report.timezone):String(row[column as keyof typeof row]??'')}</td>)}</tr>)}</tbody></table></div></div>}
        </Panel>
      </div>
      {me.permissions.manage && <StaffImport me={me} jobs={jobs} notify={notify} onChange={onChange} onDirty={onDirty} />}
    </>
  );
}

function ReportWorkspace(props: {
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


export default function Reports(props:Parameters<typeof ReportWorkspace>[0]){
  const actor=props.me.actor;
  const owner=`${actor.org_id}:${actor.id}:${actor.mode}:${actor.role}:${actor.csrf}:${JSON.stringify(actor.unit_ids??[])}`;
  return <ReportWorkspace key={owner} {...props}/>;
}
