import AttendanceReports from "./AttendanceReports";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type FormEvent,
} from "react";
import { DateTime } from "luxon";
import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  LockKeyhole,
  RefreshCw,
  Users,
} from "lucide-react";
import { api, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import RollCall from "./RollCall";
type Props = {
  unitId: string;
  yearId: string;
  sections: any[];
  office: boolean;
  timezone: string;
  notify: (text: string, error?: boolean) => void;
  initialSection?: string;
  onDirty: (dirty: boolean) => void;
};
const statusLabels: Record<string, string> = {
  not_started: "Not started",
  draft: "Draft",
  submitted: "Submitted",
  roster_changed: "Roster changed",
  no_students: "No students",
};
export default function Attendance({
  unitId,
  yearId,
  sections,
  office,
  timezone,
  notify,
  initialSection,
  onDirty,
}: Props) {
  const [policy, setPolicy] = useState<any>(null),
    [day, setDay] = useState(DateTime.now().setZone(timezone).toISODate()!),
    [period, setPeriod] = useState(""),
    [mode, setMode] = useState(office && !initialSection ? "office" : "roll"),
    [sectionId, setSectionId] = useState(
      initialSection ?? sections[0]?.id ?? "",
    ),
    [overview, setOverview] = useState<any>(null),
    [record, setRecord] = useState<any>(null),
    [recordKey, setRecordKey] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<"close" | "reopen" | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    let current = true;
    void api("/school/attendance/config?unitId=" + unitId)
      .then((result) => {
        if (current) {
          setPolicy(result);
          setPeriod(result.settings.periods[0] ?? "");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      current = false;
      onDirty(false);
    };
  }, [unitId, onDirty]);
  const query = new URLSearchParams({
    unitId,
    yearId,
    date: day,
    period,
  }).toString();
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const loadOffice = useCallback(async () => {
    if (!office || !yearId || !period) return;
    const result = await api("/school/attendance/overview?" + query);
    if (currentQuery.current !== query) return;
    setOverview(result);
    setError("");
  }, [office, yearId, period, query]);
  useEffect(() => {
    if (mode !== "office") return;
    let current = true;
    setLoading(true);
    loadOffice()
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !dialog)
        void loadOffice().catch((e) => setError(e.message));
    }, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [loadOffice, mode, dialog]);
  async function readSession(sessionId: string) {
    const result = await api("/school/attendance/sessions/" + sessionId);
    setRecord(result);
    setRecordKey((value) => value + 1);
    setDirty(false);
    onDirty(false);
    setError("");
  }
  async function open(section = sectionId) {
    setLoading(true);
    setError("");
    try {
      setSectionId(section);
      const result = await api("/school/attendance/sessions", {
        sectionId: section,
        date: day,
        period,
      });
      await readSession(result.session.id);
      setMode("roll");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function changed(value: boolean) {
    setDirty(value);
    onDirty(value);
  }
  async function closeDay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      if (dialog === "close")
        await api("/school/attendance/closeouts", {
          unitId,
          yearId,
          date: day,
          period,
          fingerprint: overview.fingerprint,
          version: overview.closeout?.version ?? 0,
          reason: form.get("reason"),
          acknowledgeUnexcused: form.get("acknowledge") === "on",
        });
      else
        await api(
          "/school/attendance/closeouts/" + overview.closeout.id + "/reopen",
          { version: overview.closeout.version, reason: form.get("reason") },
        );
      setDialog(null);
      await loadOffice();
      notify(
        dialog === "close"
          ? "Daily attendance review recorded."
          : "Attendance reopened for corrections.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!yearId)
    return (
      <Panel title="Attendance">
        <Empty
          title="Choose a school year"
          detail="Attendance is tied to enrollment and classes in a specific school year."
        />
      </Panel>
    );
  const moveDay = (amount: number) => {
    setDay(DateTime.fromISO(day).plus({ days: amount }).toISODate()!);
    setRecord(null);
  };
  if(mode==="reports")return <div className="attendance-module"><button className="text-link" onClick={()=>setMode(office?"office":"roll")}>Back to daily attendance</button><AttendanceReports key={unitId+yearId} unitId={unitId} yearId={yearId} notify={notify}/></div>;
  return (
    <div className="attendance-module">
      <div className="community-toolbar">
        <div className="attendance-date">
          <button
            className="icon-button"
            aria-label="Previous attendance date"
            disabled={dirty}
            onClick={() => moveDay(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <label>
            Attendance date
            <input
              type="date"
              value={day}
              disabled={dirty}
              onChange={(e) => {
                if (e.target.value) {
                  setDay(e.target.value);
                  setRecord(null);
                }
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="Next attendance date"
            disabled={dirty}
            onClick={() => moveDay(1)}
          >
            <ChevronRight size={18} />
          </button>
          <label>
            Period
            <select
              value={period}
              disabled={dirty}
              onChange={(e) => {
                setPeriod(e.target.value);
                setRecord(null);
              }}
            >
              {policy?.settings.periods.map((value: string) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="button secondary" disabled={dirty} onClick={()=>setMode("reports")}>Attendance trends & reports</button>
        {office && (
          <div className="segmented">
            <button
              className={mode === "office" ? "selected" : ""}
              disabled={dirty}
              onClick={() => setMode("office")}
            >
              Front office
            </button>
            <button
              className={mode === "roll" ? "selected" : ""}
              disabled={dirty}
              onClick={() => setMode("roll")}
            >
              Take attendance
            </button>
          </div>
        )}
      </div>
      {policy && !policy.settings.confirmed && (
        <div className="attendance-notice">
          <ShieldIcon />
          {policy.demo
            ? "Demonstration attendance codes and school days. These are not confirmed STJW policies."
            : "Attendance rules need confirmation in School setup before roll call can open."}
        </div>
      )}
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!policy?.settings.periods.length ? (
        <Panel title="Attendance configuration">
          <Empty
            title="Set up attendance first"
            detail="The school office can add attendance periods, instructional weekdays and codes in School setup."
          />
        </Panel>
      ) : mode === "office" && overview ? (
        <>
          {!overview.instructional && (
            <div className="attendance-notice">
              No instruction is configured for this date
              {overview.dayLabel ? ": " + overview.dayLabel : "."}
            </div>
          )}
          <div className="attendance-metrics">
            {[
              [
                "Attendance reported",
                `${overview.counts.reported} / ${overview.counts.enrolled}`,
                "Reviewed submissions",
              ],
              ["Present", overview.counts.present, "Present codes"],
              ["Absent", overview.counts.absent, "Reported absences"],
              [
                "Tardy / early",
                `${overview.counts.tardy} / ${overview.counts.early}`,
                "Arrival and departure codes",
              ],
            ].map(([label, value, detail]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>
          <Panel
            title="Homeroom submissions"
            detail="Missing roll calls stay separate from absent students. Refreshes while this screen is open."
            action={
              <button
                className="button secondary small"
                disabled={loading}
                onClick={() =>
                  void loadOffice().catch((e) => setError(e.message))
                }
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            }
          >
            <div className="table-wrap">
              <table className="school-table">
                <thead>
                  <tr>
                    <th>Homeroom</th>
                    <th>Expected</th>
                    <th>Marked</th>
                    <th>Submission</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.rows.map((row: any) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name}</strong>
                      </td>
                      <td>{row.expected}</td>
                      <td>{row.marked}</td>
                      <td>
                        <Badge
                          tone={
                            row.status === "submitted"
                              ? "green"
                              : row.status === "roster_changed"
                                ? "warm"
                                : "neutral"
                          }
                        >
                          {statusLabels[row.status]}
                        </Badge>
                      </td>
                      <td>
                        <button
                          className="text-link"
                          disabled={!row.expected || loading}
                          onClick={() => void open(row.id)}
                        >
                          Open roll call
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!overview.rows.length && (
              <Empty
                title="No homerooms configured"
                detail="Create homeroom classes and assign enrolled students to track daily coverage."
              />
            )}
          </Panel>
          <div className="attendance-office-grid">
            <Panel
              title="Absence follow-up"
              detail={`${overview.absences.length} recorded absences`}
            >
              <div className="school-record-list">
                {overview.absences.map((mark: any) => (
                  <div key={mark.student_id}>
                    <div>
                      <strong>{mark.student_name}</strong>
                      <p>
                        {mark.section_name} · {mark.note || "No note entered"}
                      </p>
                    </div>
                    <Badge
                      tone={mark.code_snapshot.excused ? "neutral" : "warm"}
                    >
                      {mark.code_snapshot.excused ? "Excused" : "Unexcused"}
                    </Badge>
                  </div>
                ))}
              </div>
              {!overview.absences.length && (
                <Empty
                  title="No submitted absences"
                  detail="This list uses submitted attendance only."
                />
              )}
            </Panel>
            <Panel
              title="Needs attention"
              detail={`${overview.pending.length} students without a reviewed submission`}
            >
              <div className="school-record-list">
                {overview.unassigned.map((student: any) => (
                  <div key={student.id}>
                    <div>
                      <strong>{student.name}</strong>
                      <p>{student.student_number}</p>
                    </div>
                    <Badge tone="warm">No homeroom</Badge>
                  </div>
                ))}
                {overview.duplicates.map((student: any) => (
                  <div key={student.id}>
                    <div>
                      <strong>{student.name}</strong>
                    </div>
                    <Badge tone="warm">Multiple homerooms</Badge>
                  </div>
                ))}
                {overview.pending
                  .filter(
                    (student: any) =>
                      !overview.unassigned.some(
                        (r: any) => r.id === student.id,
                      ) &&
                      !overview.duplicates.some(
                        (r: any) => r.id === student.id,
                      ),
                  )
                  .map((student: any) => (
                    <div key={student.id}>
                      <div>
                        <strong>{student.name}</strong>
                        <p>{student.student_number}</p>
                      </div>
                      <Badge>Awaiting submission</Badge>
                    </div>
                  ))}
              </div>
              {!overview.pending.length && (
                <Empty
                  title="All students reported"
                  detail="Every expected student has a mark in a submitted homeroom roll call."
                />
              )}
            </Panel>
          </div>
          <Panel
            title="Daily attendance review"
            detail={
              overview.closeout?.closed_at
                ? `Closed ${DateTime.fromISO(overview.closeout.closed_at).setZone(timezone).toFormat("LLL d, h:mm a")}`
                : "Review submission coverage, roster exceptions and absences before closing this period."
            }
            action={
              <button
                className="button secondary small"
                onClick={() =>
                  void download(
                    "/school/attendance/export?" + query,
                    "attendance-" + day + ".csv",
                  ).catch((e) => setError(e.message))
                }
              >
                <Download size={15} />
                Export records
              </button>
            }
          >
            <div className="attendance-closeout">
              <div>
                <Badge tone={overview.closureValid ? "green" : "neutral"}>
                  {overview.closeout?.closed_at
                    ? overview.closureValid
                      ? "Review complete"
                      : "Changes after closeout"
                    : "Open for attendance"}
                </Badge>
                {overview.closeout?.closed_at && !overview.closureValid && (
                  <p className="error">
                    The roster or attendance configuration changed after
                    closeout. Reopen and reconcile this date.
                  </p>
                )}
                <p className="muted">
                  {overview.closeout?.reason ||
                    "The review records who closed the day and preserves the reported data."}
                </p>
              </div>
              <button
                className="button primary"
                disabled={
                  !overview.closeout?.closed_at &&
                  (!overview.instructional ||
                    overview.pending.length > 0 ||
                    overview.counts.enrolled === 0)
                }
                onClick={() =>
                  setDialog(overview.closeout?.closed_at ? "reopen" : "close")
                }
              >
                <LockKeyhole size={17} />
                {overview.closeout?.closed_at
                  ? "Reopen for correction"
                  : "Review & close"}
              </button>
            </div>
          </Panel>
        </>
      ) : mode === "roll" ? (
        <>
          <div className="attendance-class-picker">
            <label>
              Class or group
              <select
                value={sectionId}
                disabled={dirty}
                onChange={(e) => {
                  setSectionId(e.target.value);
                  setRecord(null);
                }}
              >
                <option value="">Choose a class</option>
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              disabled={
                !sectionId || !period || loading || dirty || !policy?.ready
              }
              onClick={() => void open()}
            >
              <Users size={17} />
              {loading ? "Opening…" : "Open roll call"}
            </button>
          </div>
          {record && (
            <RollCall
              key={recordKey}
              record={record}
              policy={policy}
              onDirty={changed}
              onReload={() => readSession(record.session.id)}
              notify={notify}
            />
          )}
        </>
      ) : (
        <p className="community-loading">Loading attendance…</p>
      )}
      {dialog && overview && (
        <Modal
          title={
            dialog === "close"
              ? "Review and close attendance"
              : "Reopen attendance"
          }
          onClose={() => setDialog(null)}
        >
          <form className="community-form" onSubmit={closeDay}>
            <p>
              {DateTime.fromISO(day).toFormat("cccc, LLLL d")} · {period}
            </p>
            {dialog === "close" && (
              <>
                <p>
                  <strong>
                    {overview.counts.reported} of {overview.counts.enrolled}
                  </strong>{" "}
                  enrolled students have reported attendance.{" "}
                  {overview.absences.length} absences are listed.
                </p>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="acknowledge"
                    required={overview.absences.some(
                      (mark: any) => !mark.code_snapshot.excused,
                    )}
                  />
                  <span>
                    I reviewed the listed absences and completed the school’s
                    required follow-up.
                  </span>
                </label>
              </>
            )}
            <label>
              {dialog === "close" ? "Review notes" : "Reason for reopening"}
              <textarea
                name="reason"
                rows={4}
                required
                minLength={10}
                maxLength={1000}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : dialog === "close"
                    ? "Record review & close"
                    : "Reopen attendance"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function ShieldIcon() {
  return <CheckCheck size={18} />;
}
