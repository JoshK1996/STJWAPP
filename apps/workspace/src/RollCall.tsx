import { useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import { CheckCheck, History, RefreshCw, Save, Send } from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";

type Mark = { studentId: string; codeId: string | null; note: string };
type Props = {
  record: any;
  policy: any;
  onDirty: (value: boolean) => void;
  onReload: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
};
export default function RollCall({
  record,
  policy,
  onDirty,
  onReload,
  notify,
}: Props) {
  const { session } = record,
    expected = record.marks.filter((mark: any) => mark.expected),
    removed = record.marks.filter((mark: any) => !mark.expected);
  const [marks, setMarks] = useState<Mark[]>(() =>
      expected.map((mark: any) => ({
        studentId: mark.student_id,
        codeId: mark.code_id,
        note: mark.note,
      })),
    ),
    [dirty, setDirty] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reconcile, setReconcile] = useState(false),
    [history, setHistory] = useState<any[] | null>(null);
  const readOnly =
    record.closed ||
    session.class_archived ||
    (session.status === "submitted" && !session.office);
  const active = policy.codes.filter((code: any) => code.active),
    present = active.filter((code: any) => code.category === "present");
  function codeFor(mark: Mark) {
    const previous = expected.find(
      (row: any) => row.student_id === mark.studentId,
    );
    return previous.code_id === mark.codeId && previous.code_snapshot
      ? previous.code_snapshot
      : active.find((code: any) => code.id === mark.codeId);
  }
  const complete =
    marks.length > 0 &&
    marks.every(
      (mark) =>
        mark.codeId &&
        (!codeFor(mark)?.reason_required || mark.note.trim().length >= 3),
    );
  function change(next: Mark[]) {
    setMarks(next);
    setDirty(true);
    onDirty(true);
  }
  async function save(submit: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        "/school/attendance/sessions/" + session.id,
        { version: session.version, submit, reason, marks },
        "PUT",
      );
      await onReload();
      notify(
        submit
          ? "Attendance submitted to the front office."
          : "Attendance draft saved.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshRoster(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(e.currentTarget);
      await api("/school/attendance/sessions/" + session.id + "/reconcile", {
        version: session.version,
        reason: form.get("reason"),
      });
      await onReload();
      notify("Roster refreshed. Review all students before submitting again.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={session.section_name}
      detail={`${DateTime.fromISO(session.day).toFormat("cccc, LLLL d")} · ${session.period}`}
      action={
        <button
          className="button secondary small"
          disabled={busy}
          onClick={() =>
            void api("/school/attendance/sessions/" + session.id + "/history")
              .then((result) => setHistory(result.rows))
              .catch((e) => setError(e.message))
          }
        >
          <History size={16} />
          History
        </button>
      }
    >
      <div className="roll-call-summary">
        <div>
          <Badge tone={session.status === "submitted" ? "green" : "neutral"}>
            {session.status === "submitted" ? "Submitted" : "Draft"}
          </Badge>
          <span>
            {marks.filter((mark) => mark.codeId).length} of {marks.length}{" "}
            marked
          </span>
          {dirty && <Badge tone="warm">Unsaved changes</Badge>}
        </div>
        <div>
          {!readOnly && present.length === 1 && (
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                change(
                  marks.map((mark) =>
                    mark.codeId ? mark : { ...mark, codeId: present[0].id },
                  ),
                )
              }
            >
              <CheckCheck size={16} />
              Mark remaining present
            </button>
          )}
          {session.office && !readOnly && (
            <button
              className="button secondary small"
              disabled={busy || dirty}
              onClick={() => setReconcile(true)}
            >
              <RefreshCw size={16} />
              Refresh roster
            </button>
          )}
        </div>
      </div>
      {record.closed && (
        <p className="attendance-notice">
          The front office closed this attendance period. Reopen it from the
          daily review before correcting records.
        </p>
      )}
      {session.status === "submitted" && !session.office && (
        <p className="attendance-notice">
          Your attendance is submitted. Contact the front office if a correction
          is needed.
        </p>
      )}
      {record.rosterChanged && (
        <p className="attendance-notice">
          Enrollment changed after this roll call opened. The front office must
          refresh this roster and review it before submission.
        </p>
      )}
      {error && !reconcile && (
        <p className="error school-panel-action" role="alert">
          {error}
        </p>
      )}
      <div className="roll-call-list">
        {marks.map((mark, index) => {
          const student = expected[index],
            old = student.code_snapshot,
            selected = codeFor(mark);
          const choices = active.map((code: any) =>
            old && student.code_id === code.id ? { ...old, id: code.id } : code,
          );
          if (
            old &&
            student.code_id &&
            !choices.some((code: any) => code.id === student.code_id)
          )
            choices.push({ ...old, id: student.code_id });
          return (
            <div className="roll-call-row" key={mark.studentId}>
              <div className="roll-call-student">
                <span className="roster-position">{index + 1}</span>
                <div>
                  <strong>{student.student_name}</strong>
                  <small>{student.student_number}</small>
                </div>
              </div>
              <label>
                <span className="sr-only">
                  Attendance for {student.student_name}
                </span>
                <select
                  aria-label={"Attendance for " + student.student_name}
                  value={mark.codeId ?? ""}
                  disabled={readOnly || busy}
                  onChange={(e) =>
                    change(
                      marks.map((row) =>
                        row.studentId === mark.studentId
                          ? { ...row, codeId: e.target.value || null }
                          : row,
                      ),
                    )
                  }
                >
                  <option value="">Not marked</option>
                  {choices.map((code: any) => (
                    <option key={code.id} value={code.id}>
                      {code.code} · {code.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">Note for {student.student_name}</span>
                <input
                  value={mark.note}
                  disabled={readOnly || busy}
                  maxLength={1000}
                  placeholder={
                    selected?.reason_required
                      ? "Note required"
                      : "Optional note"
                  }
                  aria-required={!!selected?.reason_required}
                  onChange={(e) =>
                    change(
                      marks.map((row) =>
                        row.studentId === mark.studentId
                          ? { ...row, note: e.target.value }
                          : row,
                      ),
                    )
                  }
                />
              </label>
            </div>
          );
        })}
      </div>
      {!marks.length && (
        <Empty
          title="No enrolled students on this date"
          detail="The school office can check the enrollment and class roster dates, then refresh this roll call."
        />
      )}
      {!!removed.length && (
        <details className="school-panel-action">
          <summary>
            {removed.length} previously recorded students outside the current
            roster
          </summary>
          <p className="muted">
            Preserved for history; excluded from the current submission.
          </p>
          {removed.map((mark: any) => (
            <p key={mark.student_id}>
              {mark.student_name} · {mark.code_snapshot?.label ?? "Unmarked"}
              {mark.note ? " · " + mark.note : ""}
            </p>
          ))}
        </details>
      )}
      {!readOnly && (
        <div className="roll-call-footer">
          {session.status === "submitted" && (
            <label>
              Reason for correction
              <input
                value={reason}
                minLength={5}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain the change to this submitted record"
              />
            </label>
          )}
          <p className="muted">
            Review every student before submitting. Attendance codes retain the
            meaning used when they were recorded.
          </p>
          <div className="dialog-actions">
            {dirty && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void onReload().catch((e) => setError(e.message))
                }
              >
                Discard changes & reload
              </button>
            )}
            <button
              className="button secondary"
              disabled={
                busy ||
                !marks.length ||
                (session.status === "submitted" && reason.trim().length < 5)
              }
              onClick={() => void save(false)}
            >
              <Save size={16} />
              Save draft
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !complete ||
                record.rosterChanged ||
                (session.status === "submitted" && reason.trim().length < 5)
              }
              onClick={() => void save(true)}
            >
              <Send size={16} />
              {busy
                ? "Saving…"
                : session.status === "submitted"
                  ? "Submit correction"
                  : "Submit attendance"}
            </button>
          </div>
        </div>
      )}
      {reconcile && (
        <Modal
          title="Refresh this attendance roster"
          onClose={() => setReconcile(false)}
        >
          <form className="community-form" onSubmit={refreshRoster}>
            <p>
              This compares the roster with enrollment on this attendance date.
              New students start unmarked. Earlier marks remain in history. The
              roll call returns to draft for review.
            </p>
            <label>
              Reason for roster refresh
              <textarea name="reason" required minLength={5} maxLength={1000} />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setReconcile(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                Refresh roster
              </button>
            </div>
          </form>
        </Modal>
      )}
      {history && (
        <Modal title="Attendance history" onClose={() => setHistory(null)}>
          <div className="attendance-history">
            {history.map((row) => (
              <article key={row.version}>
                <div>
                  <strong>Version {row.version}</strong>
                  <Badge>
                    {(
                      {
                        opened: "Opened",
                        draft_saved: "Draft saved",
                        submitted: "Submitted",
                        roster_reconciled: "Roster refreshed",
                      } as Record<string, string>
                    )[row.action] ?? row.action}
                  </Badge>
                </div>
                <p>
                  {DateTime.fromISO(row.created_at)
                    .setZone(policy.timezone)
                    .toFormat("LLL d, yyyy · h:mm a")}
                </p>
                {row.reason && <p>{row.reason}</p>}
                <details>
                  <summary>View recorded attendance</summary>
                  {row.snapshot.marks.map((mark: any) => (
                    <p key={mark.student_id}>
                      <strong>{mark.student_name}</strong> ·{" "}
                      {mark.code_snapshot?.label ?? "Unmarked"}
                      {!mark.expected ? " (outside roster)" : ""}
                      {mark.note ? " · " + mark.note : ""}
                    </p>
                  ))}
                </details>
              </article>
            ))}
          </div>
        </Modal>
      )}
    </Panel>
  );
}
