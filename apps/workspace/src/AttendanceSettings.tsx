import { useEffect, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
type Props = {
  unitId: string;
  yearId: string;
  notify: (text: string, error?: boolean) => void;
};
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export default function AttendanceSettings({ unitId, yearId, notify }: Props) {
  const [policy, setPolicy] = useState<any>(null),
    [days, setDays] = useState<any[]>([]),
    [dialog, setDialog] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const [settings, dates] = await Promise.all([
      api("/school/attendance/config?unitId=" + unitId),
      yearId
        ? api("/school/attendance/days?unitId=" + unitId + "&yearId=" + yearId)
        : Promise.resolve({ rows: [] }),
    ]);
    setPolicy(settings);
    setDays(dates.rows);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [unitId, yearId]);
  function edit(kind: string, data?: any) {
    setError("");
    setDialog({ kind, data });
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      if (dialog.kind === "settings")
        await api(
          "/school/attendance/config",
          {
            unitId,
            weekdays: form.getAll("weekday").map(Number),
            periods: String(form.get("periods"))
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
            confirmed: form.get("confirmed") === "on",
            version: policy.settings.version,
            reason: form.get("reason"),
          },
          "PUT",
        );
      if (dialog.kind === "code") {
        const body = {
          unitId,
          code: form.get("code"),
          label: form.get("label"),
          category: form.get("category"),
          excused: form.get("excused") === "on",
          reasonRequired: form.get("reasonRequired") === "on",
          active: form.get("active") === "on",
          ...(dialog.data ? { version: dialog.data.version } : {}),
        };
        await api(
          "/school/attendance/codes" +
            (dialog.data ? "/" + dialog.data.id : ""),
          body,
          dialog.data ? "PATCH" : "POST",
        );
      }
      if (dialog.kind === "day")
        await api(
          "/school/attendance/days",
          {
            unitId,
            yearId,
            date: form.get("date"),
            label: form.get("label"),
            instructional: form.get("instructional") === "on",
            version: dialog.data?.version ?? 0,
          },
          "PUT",
        );
      await load();
      setDialog(null);
      notify("Attendance configuration saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!policy)
    return (
      <Panel title="Attendance configuration">
        <p className={error ? "error" : "community-loading"}>
          {error || "Loading attendance settings…"}
        </p>
      </Panel>
    );
  return (
    <div className="attendance-settings">
      <Panel
        title="Attendance rules"
        detail="Configure the school’s actual rules before confirming them."
        action={
          <button
            className="button secondary small"
            onClick={() => edit("settings")}
          >
            Edit rules
          </button>
        }
      >
        <div className="school-panel-action">
          <Badge tone={policy.settings.confirmed ? "green" : "warm"}>
            {policy.settings.confirmed
              ? "Confirmed by the school"
              : "Not confirmed"}
          </Badge>
          <p>
            <strong>Instructional weekdays:</strong>{" "}
            {policy.settings.weekdays
              .map((day: number) => weekdays[day - 1])
              .join(", ") || "Not configured"}
          </p>
          <p>
            <strong>Periods:</strong>{" "}
            {policy.settings.periods.join(", ") || "Not configured"}
          </p>
          {policy.demo && !policy.settings.confirmed && (
            <p className="muted">
              Sample settings are available in this demonstration. They do not
              establish STJW policy.
            </p>
          )}
        </div>
      </Panel>
      <Panel
        title="Attendance codes"
        detail="Edits apply to new marks; recorded marks retain their original code definitions."
        action={
          <button
            className="button secondary small"
            onClick={() => edit("code")}
          >
            <Plus size={15} />
            Add code
          </button>
        }
      >
        <div className="table-wrap">
          <table className="school-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Meaning</th>
                <th>Category</th>
                <th>Rules</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policy.codes.map((code: any) => (
                <tr key={code.id}>
                  <td>
                    <strong>{code.code}</strong>
                  </td>
                  <td>
                    {code.label}
                    {!code.active && <Badge>Inactive</Badge>}
                  </td>
                  <td>{code.category}</td>
                  <td>
                    {[
                      code.excused ? "Excused" : null,
                      code.reason_required ? "Note required" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td>
                    <button
                      className="text-link"
                      onClick={() => edit("code", code)}
                    >
                      Edit code
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!policy.codes.length && (
          <Empty
            title="Add your attendance codes"
            detail="The category determines how each code is counted in the front-office overview."
          />
        )}
      </Panel>
      <Panel
        title="School-day exceptions"
        detail="Override the weekly pattern for holidays, closures or additional instructional days in the selected year."
        action={
          <button
            className="button secondary small"
            disabled={!yearId}
            onClick={() => edit("day")}
          >
            <Plus size={15} />
            Add date
          </button>
        }
      >
        <div className="school-record-list">
          {days.map((day) => (
            <div key={day.day}>
              <div>
                <strong>{day.label}</strong>
                <p>
                  {day.day} ·{" "}
                  {day.instructional ? "Instructional day" : "No instruction"}
                </p>
              </div>
              <button className="text-link" onClick={() => edit("day", day)}>
                Edit date
              </button>
            </div>
          ))}
        </div>
        {!days.length && (
          <Empty
            title="No date exceptions"
            detail={
              yearId
                ? "Attendance follows the configured weekdays."
                : "Choose a school year to manage its calendar dates."
            }
          />
        )}
      </Panel>
      {dialog && (
        <Modal
          title={
            dialog.kind === "settings"
              ? "Attendance rules"
              : dialog.kind === "code"
                ? dialog.data
                  ? "Edit attendance code"
                  : "Add attendance code"
                : dialog.data
                  ? "Edit school-day exception"
                  : "Add school-day exception"
          }
          onClose={() => setDialog(null)}
        >
          <form className="community-form" onSubmit={save}>
            {dialog.kind === "settings" ? (
              <>
                <fieldset className="attendance-weekdays">
                  <legend>Instructional weekdays</legend>
                  {weekdays.map((name, index) => (
                    <label className="school-toggle" key={name}>
                      <input
                        type="checkbox"
                        name="weekday"
                        value={index + 1}
                        defaultChecked={policy.settings.weekdays.includes(
                          index + 1,
                        )}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </fieldset>
                <label>
                  Attendance periods — one per line
                  <textarea
                    name="periods"
                    rows={4}
                    required
                    defaultValue={policy.settings.periods.join("\n")}
                  />
                </label>
                <p className="muted">
                  Daily attendance reviews are separate for each period.
                  Existing records keep their original period names.
                </p>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="confirmed"
                    defaultChecked={policy.settings.confirmed}
                  />
                  <span>
                    The school has reviewed and approved these settings and
                    attendance codes.
                  </span>
                </label>
                <label>
                  Reason for this change
                  <textarea
                    name="reason"
                    required
                    minLength={5}
                    maxLength={1000}
                  />
                </label>
              </>
            ) : dialog.kind === "code" ? (
              <>
                <div className="community-form-grid">
                  <label>
                    Code
                    <input
                      name="code"
                      required
                      maxLength={10}
                      pattern="[A-Za-z0-9_-]+"
                      defaultValue={dialog.data?.code}
                    />
                  </label>
                  <label>
                    Meaning
                    <input
                      name="label"
                      required
                      minLength={2}
                      maxLength={80}
                      defaultValue={dialog.data?.label}
                    />
                  </label>
                </div>
                <label>
                  Category
                  <select
                    name="category"
                    aria-label="Category"
                    defaultValue={dialog.data?.category ?? "present"}
                  >
                    {["present", "absent", "tardy", "early", "other"].map(
                      (value) => (
                        <option key={value} value={value}>
                          {value === "early"
                            ? "Early departure"
                            : value[0].toUpperCase() + value.slice(1)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="excused"
                    defaultChecked={dialog.data?.excused ?? false}
                  />
                  <span>Excused</span>
                </label>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="reasonRequired"
                    defaultChecked={dialog.data?.reason_required ?? false}
                  />
                  <span>Require a note before submission</span>
                </label>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={dialog.data?.active ?? true}
                  />
                  <span>Available for new attendance marks</span>
                </label>
              </>
            ) : (
              <>
                <label>
                  Date
                  <input
                    type="date"
                    name="date"
                    required
                    readOnly={!!dialog.data}
                    defaultValue={dialog.data?.day}
                  />
                </label>
                <label>
                  Description
                  <input
                    name="label"
                    required
                    minLength={3}
                    maxLength={200}
                    defaultValue={dialog.data?.label}
                  />
                </label>
                <label className="school-toggle">
                  <input
                    type="checkbox"
                    name="instructional"
                    defaultChecked={dialog.data?.instructional ?? false}
                  />
                  <span>Instructional day — take attendance</span>
                </label>
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? "Saving…" : "Save configuration"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
