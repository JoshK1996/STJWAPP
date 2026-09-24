import GradeImport from "./GradeImport";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  Check,
  FileCheck2,
  History,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { createPortal } from "react-dom";
import { api, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import GradingPolicy, { gradeUnits, pointText } from "./GradingPolicy";
type Notice = (message: string, error?: boolean) => void;
const statusLabel = (value: string) =>
  ({
    open: "Draft gradebook",
    submitted: "Awaiting office review",
    locked: "Reviewed & locked",
    ungraded: "Not graded",
    scored: "Scored",
    missing: "Missing",
    exempt: "Exempt",
    incomplete: "Incomplete",
  })[value] ?? value;
export default function Gradebook({
  unitId,
  yearId,
  sections,
  office,
  notify,
  onDirty,
}: {
  unitId: string;
  yearId: string;
  sections: any[];
  office: boolean;
  notify: Notice;
  onDirty: (value: boolean) => void;
}) {
  const classes = sections.filter(
      (row) => row.year_id === yearId && !row.archived,
    ),
    [sectionId, setSectionId] = useState(classes[0]?.id ?? ""),
    [termId, setTermId] = useState(""),
    [context, setContext] = useState<any>(null),
    [settings, setSettings] = useState<any>(null),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [dialog, setDialog] = useState<any>(null),
    [dirty, setDirty] = useState(false),
    [report, setReport] = useState<any>(null);
  const generation = useRef(0), accessGeneration = useRef(0);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    let current = true;
    const accessKey = accessGeneration.current;
    void api("/school/grading/settings?unitId=" + unitId)
      .then((result) => {
        if (current && accessKey === accessGeneration.current) setSettings(result);
      })
      .catch((e) => {
        if (current && accessKey === accessGeneration.current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [unitId]);
  useEffect(() => {
    let current = true;
    const accessKey = accessGeneration.current;
    setContext(null);
    setData(null);
    setTermId("");
    if (!sectionId) return;
    setLoading(true);
    void api("/school/gradebooks?sectionId=" + sectionId)
      .then((result) => {
        if (!current || accessKey !== accessGeneration.current) return;
        setContext(result);
        setTermId(result.terms[0]?.id ?? "");
        setSettings(result.settings);
      })
      .catch((e) => {
        if (current && accessKey === accessGeneration.current) setError(e.message);
      })
      .finally(() => {
        if (current && accessKey === accessGeneration.current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [sectionId]);
  const selected = context?.rows.find((row: any) => row.term_id === termId);
  useEffect(() => {
    const revision = ++generation.current;
    setData(null);
    if (!selected) return;
    setLoading(true);
    void api("/school/gradebooks/" + selected.id)
      .then((result) => {
        if (revision === generation.current) setData(result);
      })
      .catch((e) => {
        if (revision === generation.current) setError(e.message);
      })
      .finally(() => {
        if (revision === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [selected?.id]);
  async function refresh() {
    const accessKey = accessGeneration.current, revision = generation.current;
    if (data) {
      const refreshed = await api("/school/gradebooks/" + data.book.id);
      if (accessKey !== accessGeneration.current || revision !== generation.current) return;
      setData(refreshed);
    }
    const result = await api("/school/gradebooks?sectionId=" + sectionId);
    if (accessKey !== accessGeneration.current || revision !== generation.current) return;
    setContext(result);
    setSettings(result.settings);
  }
  async function run(work: () => Promise<void>) {
    const accessKey = accessGeneration.current;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (accessKey !== accessGeneration.current) return;
      setError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      if (accessKey === accessGeneration.current) setBusy(false);
    }
  }
  function clearImportAccess(status: 401 | 403) {
    accessGeneration.current++; generation.current++;
    setData(null); setContext(null); setSettings(null); setReport(null); setDialog(null);
    setDirty(false); setBusy(false); setLoading(false); onDirty(false);
    setError(status === 401
      ? 'Your sign-in expired or changed. Sign in again to open grade records.'
      : 'Your class access could not be verified. Grade records and the import draft have been cleared.');
  }
  function close() {
    if (dirty && !window.confirm("Discard unsaved grade changes?")) return;
    setDirty(false);
    setDialog(null);
    setError("");
  }
  const activeAssignments =
      data?.assignments.filter((row: any) => !row.archived) ?? [],
    editable = data?.book.status === "open",
    pending =
      data?.results.reduce((sum: number, row: any) => sum + row.pending, 0) ??
      0,
    missing =
      data?.results.reduce((sum: number, row: any) => sum + row.missing, 0) ??
      0;
  return (
    <div className="grading-module">
      <div className="community-toolbar">
        <div className="grade-selectors">
          <label>
            Class
            <select
              aria-label="Gradebook class"
              disabled={busy}
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
            >
              <option value="">Choose a class</option>
              {classes.map((row) => (
                <option value={row.id} key={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Term
            <select
              aria-label="Gradebook term"
              disabled={busy}
              value={termId}
              onChange={(e) => setTermId(e.target.value)}
            >
              <option value="">Choose a term</option>
              {context?.terms.map((row: any) => (
                <option value={row.id} key={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {office && (
          <button
            className="button secondary"
            onClick={() => setDialog({ type: "policy" })}
          >
            <Settings2 size={17} />
            Grading policy
          </button>
        )}
      </div>
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="community-loading">Opening gradebook…</p>
      ) : !data ? (
        <Panel
          title="A clear view of every student’s progress"
          detail="Assignments, careful feedback and a traceable record of learning."
        >
          <Empty
            title={
              !classes.length
                ? "Create a classroom first"
                : !context?.terms.length
                  ? "Add a term in School setup"
                  : !settings?.confirmed
                    ? "Grading policy needs confirmation"
                    : "Start this class gradebook"
            }
            detail={
              !settings?.confirmed
                ? "The school office must configure and confirm grading rules before a gradebook can be opened."
                : "Opening a gradebook captures this term’s enrolled students and the confirmed grading policy."
            }
          />
          {sectionId && termId && settings?.confirmed && (
            <div className="grade-empty-action">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/school/gradebooks", { sectionId, termId });
                    await refresh();
                    notify("Class gradebook opened with its confirmed policy.");
                  })
                }
              >
                <BookOpen size={18} />
                Open gradebook
              </button>
            </div>
          )}
        </Panel>
      ) : (
        <>
          <div className="grade-summary">
            <div>
              <Badge tone={data.book.status === "locked" ? "success" : "warm"}>
                {statusLabel(data.book.status)}
              </Badge>
              <h2>{data.section.name}</h2>
              <p>
                {data.term.name} · {data.book.policy.name} · policy version{" "}
                {data.book.policy_version}
              </p>
            </div>
            <div>
              <strong>{data.results.length}</strong>
              <span>Students</span>
            </div>
            <div>
              <strong>{activeAssignments.length}</strong>
              <span>Assignments</span>
            </div>
            <div>
              <strong>{pending}</strong>
              <span>To grade</span>
            </div>
            <div>
              <strong>{missing}</strong>
              <span>Missing</span>
            </div>
          </div>
          {!data.rosterCurrent && (
            <div className="school-notice">
              <strong>Class enrollment has changed.</strong> The captured roster
              is out of date. Previous reviewed results remain historical
              records.
              {office && editable && (
                <button
                  className="button secondary small"
                  onClick={() => setDialog({ type: "reconcile" })}
                >
                  <RefreshCw size={15} />
                  Review roster changes
                </button>
              )}
            </div>
          )}
          <div className="grade-actions">
            <button
              className="button primary"
              disabled={!editable || busy}
              onClick={() =>
                setDialog({
                  type: "assignment",
                  commandId: crypto.randomUUID(),
                })
              }
            >
              <Plus size={17} />
              Add assignment
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  download(
                    "/school/gradebooks/" + data.book.id + "/export",
                    "stjw-class-grades.csv",
                  ),
                )
              }
            >
              <ArrowDownToLine size={17} />
              Export class grades
            </button>
            {editable ? (
              <button
                className="button secondary"
                disabled={busy || pending > 0 || !data.rosterCurrent}
                onClick={() => setDialog({ type: "review", action: "submit" })}
              >
                <Check size={17} />
                Submit for office review
              </button>
            ) : (
              <>
                {office && data.book.status === "submitted" && (
                  <button
                    className="button primary"
                    disabled={busy || !data.rosterCurrent}
                    onClick={() =>
                      setDialog({ type: "review", action: "lock" })
                    }
                  >
                    <FileCheck2 size={17} />
                    Review & lock
                  </button>
                )}
                {office && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setDialog({ type: "review", action: "reopen" })
                    }
                  >
                    Reopen with reason
                  </button>
                )}
              </>
            )}
            <button
              className="button secondary"
              onClick={() => setDialog({ type: "history" })}
            >
              <History size={17} />
              History
            </button>
          </div>
          <Panel
            title="Assignments"
            detail="Open an assignment to enter points, record missing work or review exemptions."
          >
            {data.assignments.length ? (
              <div className="grade-assignment-list">
                {data.assignments.map((assignment: any) => {
                  const scores = data.scores.filter(
                    (row: any) =>
                      row.assignment_id === assignment.id && row.expected,
                  );
                  return (
                    <div
                      key={assignment.id}
                      className={assignment.archived ? "is-archived" : ""}
                    >
                      <button
                        className="grade-assignment-main"
                        onClick={() =>
                          setDialog({ type: "scores", assignment })
                        }
                      >
                        <span className="small-icon">
                          <BookOpen size={20} />
                        </span>
                        <span>
                          <strong>{assignment.title}</strong>
                          <small>
                            {assignment.due_on} ·{" "}
                            {
                              data.book.policy.categories.find(
                                (row: any) => row.id === assignment.category_id,
                              )?.name
                            }{" "}
                            · {pointText(assignment.max_points_units)} points
                          </small>
                        </span>
                        <Badge
                          tone={assignment.archived ? "neutral" : "outline"}
                        >
                          {assignment.archived
                            ? "Archived"
                            : `${scores.filter((row: any) => row.status !== "ungraded" && row.status !== "incomplete").length}/${scores.length} reviewed`}
                        </Badge>
                      </button>
                      {editable && !assignment.archived && (
                        <button
                          className="text-link"
                          disabled={!data.rosterCurrent}
                          onClick={() =>
                            setDialog({ type: "import", assignment })
                          }
                        >
                          Import scores
                        </button>
                      )}
                      {editable && (
                        <button
                          className="text-link"
                          onClick={() =>
                            setDialog({ type: "assignment", assignment })
                          }
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty
                title="Your first assignment starts here"
                detail="Add an assignment, its possible points, category and due date."
              />
            )}
          </Panel>
          <Panel
            title="Student progress"
            detail="Labels use the exact result before display rounding. Provisional results still have work to review."
          >
            <div className="table-scroll">
              <table className="grade-progress-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Calculated grade</th>
                    <th>To grade</th>
                    <th>Missing</th>
                    <th>Progress report</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((row: any) => (
                    <tr key={row.student_id}>
                      <td>
                        <strong>{row.name}</strong>
                        <small className="grade-student-number">
                          {row.student_number}
                        </small>
                        <small className="grade-mobile-status">
                          {row.pending} to grade · {row.missing} missing
                        </small>
                      </td>
                      <td>
                        {row.percentage === null
                          ? "No calculated grade"
                          : `${row.percentage}% ${row.label ?? ""}`}
                        {row.provisional && (
                          <Badge tone="warm">Provisional</Badge>
                        )}
                        {row.incomplete && (
                          <Badge tone="warm">Incomplete</Badge>
                        )}
                      </td>
                      <td>{row.pending}</td>
                      <td>{row.missing}</td>
                      <td>
                        <button
                          className="text-link"
                          onClick={() =>
                            setReport({ data, studentId: row.student_id })
                          }
                        >
                          Open report
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          {data.releases.length > 0 && (
            <Panel
              title="Reviewed results"
              detail="Locked snapshots remain unchanged when a gradebook is reopened or its scores are corrected."
            >
              <div className="grade-release-list">
                {data.releases.map((release: any) => (
                  <button
                    key={release.id}
                    onClick={() =>
                      void run(async () => {
                        const result = await api(
                          "/school/gradebooks/" +
                            data.book.id +
                            "/releases/" +
                            release.id,
                        );
                        setDialog({ type: "release", release: result });
                      })
                    }
                  >
                    <FileCheck2 size={19} />
                    <span>
                      <strong>Reviewed version {release.book_version}</strong>
                      <small>
                        {release.reviewer_name} ·{" "}
                        {new Date(release.created_at).toLocaleString()}
                      </small>
                    </span>
                    <span>View</span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
      {dialog?.type === "policy" && (
        <GradingPolicy
          unitId={unitId}
          settings={settings}
          onClose={close}
          onSaved={async () => {
            setSettings(await api("/school/grading/settings?unitId=" + unitId));
            if (sectionId) await refresh();
            notify(
              "School grading policy saved. Existing gradebooks retain their policy version.",
            );
          }}
        />
      )}
      {data && dialog?.type === "assignment" && (
        <AssignmentForm
          data={data}
          initial={dialog.assignment}
          commandId={dialog.commandId}
          onClose={close}
          onSaved={async () => {
            setDialog(null);
            await refresh();
            notify("Assignment saved with its dated roster.");
          }}
        />
      )}
      {data && dialog?.type === "import" && (
        <GradeImport
          key={dialog.assignment.id}
          assignment={dialog.assignment}
          bookVersion={data.book.version}
          onDirty={setDirty}
          onClose={close}
          onApplied={refresh}
          onAccessDenied={clearImportAccess}
        />
      )}
      {data && dialog?.type === "scores" && (
        <ScoreForm
          key={dialog.assignment.id}
          data={data}
          assignment={dialog.assignment}
          onDirty={setDirty}
          onClose={close}
          onSaved={async () => {
            setDirty(false);
            setDialog(null);
            await refresh();
            notify("Scores and review evidence saved.");
          }}
        />
      )}
      {data && ["review", "reconcile"].includes(dialog?.type) && (
        <Modal
          title={
            dialog.type === "reconcile"
              ? "Reconcile classroom roster"
              : dialog.action === "reopen"
                ? "Reopen gradebook"
                : dialog.action === "lock"
                  ? "Review & lock class results"
                  : "Submit class results"
          }
          onClose={close}
        >
          <form
            className="community-form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void run(async () => {
                const path =
                  "/school/gradebooks/" +
                  data.book.id +
                  "/" +
                  (dialog.type === "reconcile" ? "reconcile" : "review");
                await api(path, {
                  version: data.book.version,
                  reason: values.get("reason"),
                  ...(dialog.type === "review"
                    ? {
                        action: dialog.action,
                        acknowledgeMissing: values.get("missing") === "on",
                        acknowledgeNoGrade: values.get("noGrade") === "on",
                      }
                    : {}),
                });
                setDialog(null);
                await refresh();
                notify("Gradebook review recorded.");
              });
            }}
          >
            <p className="school-notice">
              {dialog.type === "reconcile"
                ? "Refresh enrollment dates and assignment eligibility. Prior scores are preserved; newly eligible students begin ungraded."
                : dialog.action === "reopen"
                  ? "Prior locked results remain unchanged. New corrections create a new review history."
                  : "Review every student’s result against the captured policy. Submission makes the gradebook read-only; office locking creates an immutable result snapshot."}
            </p>
            {dialog.type === "review" && dialog.action !== "reopen" && (
              <>
                <label className="school-toggle">
                  <input name="missing" type="checkbox" />I reviewed recorded
                  missing work and its configured treatment.
                </label>
                <label className="school-toggle">
                  <input name="noGrade" type="checkbox" />I reviewed students
                  without a calculated grade, if any.
                </label>
              </>
            )}
            <label>
              Review reason
              <textarea
                name="reason"
                required
                minLength={10}
                maxLength={2000}
              />
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
                disabled={busy}
                onClick={close}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                Confirm review
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog?.type === "history" && (
        <Modal title="Gradebook history" onClose={close}>
          <div className="grade-history">
            {data.history.map((row: any) => (
              <article key={row.id}>
                <strong>
                  {row.entity_type
                    .replace("gradebook.", "")
                    .replaceAll("_", " ")}
                </strong>
                <span>
                  {row.actor_name} ·{" "}
                  {new Date(row.created_at).toLocaleString()}
                </span>
                <p>
                  {row.snapshot.after?.reason ??
                    "Recorded with the gradebook’s private change history."}
                </p>
              </article>
            ))}
          </div>
        </Modal>
      )}
      {dialog?.type === "release" && (
        <Modal
          title={`Reviewed class results · version ${dialog.release.book_version}`}
          onClose={close}
        >
          <div className="community-form">
            <p className="school-notice">
              Historical snapshot reviewed by {dialog.release.reviewer_name}.{" "}
              {dialog.release.snapshot.reason}
            </p>
            {dialog.release.snapshot.results.map((row: any) => (
              <div className="grade-release-student" key={row.student_id}>
                <strong>{row.name}</strong>
                <span>
                  {row.percentage === null
                    ? "No calculated grade"
                    : `${row.percentage}% ${row.label ?? ""}`}
                </span>
                <button
                  className="text-link"
                  onClick={() => {
                    setReport({
                      data: dialog.release.snapshot,
                      studentId: row.student_id,
                      reviewer: dialog.release.reviewer_name,
                      reviewedAt: dialog.release.created_at,
                    });
                    setDialog(null);
                  }}
                >
                  Open report
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {report && (
        <ProgressReport report={report} onClose={() => setReport(null)} />
      )}
    </div>
  );
}

function AssignmentForm({
  data,
  initial,
  commandId,
  onClose,
  onSaved,
}: {
  data: any;
  initial: any;
  commandId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const command = useRef(commandId ?? crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const values = new FormData(event.currentTarget),
        input = {
          bookVersion: data.book.version,
          title: values.get("title"),
          instructions: values.get("instructions"),
          categoryId: values.get("categoryId"),
          dueOn: values.get("dueOn"),
          maxPointsUnits: gradeUnits(String(values.get("points"))),
        };
      setBusy(true);
      if (initial)
        await api(
          "/school/grade-assignments/" + initial.id,
          {
            ...input,
            version: initial.version,
            archived: values.get("archived") === "on",
            reason: values.get("reason"),
          },
          "PATCH",
        );
      else
        await api("/school/grade-assignments", {
          ...input,
          bookId: data.book.id,
          commandId: command.current,
        });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "Edit assignment" : "New assignment"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="community-form"
        onSubmit={submit}
        onChange={() => {
          command.current = crypto.randomUUID();
        }}
      >
        <label>
          Assignment title
          <input
            name="title"
            required
            minLength={2}
            maxLength={150}
            defaultValue={initial?.title ?? ""}
          />
        </label>
        <label>
          Instructions
          <textarea
            name="instructions"
            maxLength={8000}
            defaultValue={initial?.instructions ?? ""}
          />
        </label>
        <div className="community-form-grid">
          <label>
            Category
            <select
              name="categoryId"
              defaultValue={
                initial?.category_id ?? data.book.policy.categories[0].id
              }
            >
              {data.book.policy.categories.map((row: any) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due date
            <input
              name="dueOn"
              type="date"
              required
              min={data.term.starts_on}
              max={data.term.ends_on}
              defaultValue={initial?.due_on ?? data.term.starts_on}
            />
          </label>
          <label>
            Possible points
            <input
              name="points"
              type="number"
              required
              min="0.01"
              max="10000"
              step="0.01"
              defaultValue={initial ? pointText(initial.max_points_units) : ""}
            />
          </label>
        </div>
        <p className="school-notice">
          Students enrolled on the due date form this assignment’s captured
          roster.{" "}
          {data.book.policy.allowExtraCredit
            ? "This policy permits extra credit."
            : "Scores cannot exceed possible points."}
        </p>
        {initial && (
          <>
            <label className="school-toggle">
              <input
                type="checkbox"
                name="archived"
                defaultChecked={initial.archived}
              />
              Archive this assignment (preserve evidence; exclude from
              calculations)
            </label>
            <label>
              Reason for change
              <textarea
                name="reason"
                required
                minLength={10}
                maxLength={2000}
              />
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
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save assignment
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScoreForm({
  data,
  assignment,
  onDirty,
  onClose,
  onSaved,
}: {
  data: any;
  assignment: any;
  onDirty: (value: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = data.scores
      .filter((row: any) => row.assignment_id === assignment.id && row.expected)
      .map((row: any) => ({
        ...row,
        points: row.points_units === null ? "" : pointText(row.points_units),
      })),
    [rows, setRows] = useState<any[]>(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editable = data.book.status === "open" && !assignment.archived;
  function change(id: string, patch: any) {
    onDirty(true);
    setRows((current) =>
      current.map((row) =>
        row.student_id === id ? { ...row, ...patch } : row,
      ),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const values = new FormData(event.currentTarget),
        scores = rows.map((row) => ({
          studentId: row.student_id,
          status: row.status,
          pointsUnits: row.status === "scored" ? gradeUnits(row.points) : null,
          note: row.note,
        }));
      setBusy(true);
      await api(
        "/school/grade-assignments/" + assignment.id + "/scores",
        {
          version: assignment.version,
          bookVersion: data.book.version,
          scores,
          reason: values.get("reason"),
        },
        "PUT",
      );
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={assignment.title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="community-form grade-score-form" onSubmit={submit}>
        <p className="school-notice">
          {pointText(assignment.max_points_units)} possible points · Due{" "}
          {assignment.due_on}. Missing work{" "}
          {data.book.policy.missing === "zero"
            ? "counts as zero"
            : "is excluded"}
          . Ungraded work remains provisional.
        </p>
        {assignment.instructions && (
          <p className="grade-instructions">{assignment.instructions}</p>
        )}
        <div className="grade-score-rows">
          {rows.map((row) => (
            <fieldset
              className="grade-score-row"
              key={row.student_id}
              disabled={!editable || busy}
            >
              <legend>{row.student_name}</legend>
              <label>
                Result
                <select
                  aria-label={`Result for ${row.student_name}`}
                  value={row.status}
                  onChange={(e) =>
                    change(row.student_id, {
                      status: e.target.value,
                      ...(e.target.value !== "scored" ? { points: "" } : {}),
                    })
                  }
                >
                  {[
                    "ungraded",
                    "scored",
                    "missing",
                    "exempt",
                    "incomplete",
                  ].map((value) => (
                    <option value={value} key={value}>
                      {statusLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Points
                <input
                  aria-label={`Points for ${row.student_name}`}
                  type="number"
                  step="0.01"
                  min="0"
                  max={
                    data.book.policy.allowExtraCredit
                      ? 10000
                      : assignment.max_points_units / 100
                  }
                  disabled={row.status !== "scored"}
                  required={row.status === "scored"}
                  value={row.points}
                  onChange={(e) =>
                    change(row.student_id, { points: e.target.value })
                  }
                />
              </label>
              <label className="grade-score-note">
                Feedback or exemption note
                <input
                  aria-label={`Feedback for ${row.student_name}`}
                  maxLength={1000}
                  minLength={
                    ["exempt", "incomplete"].includes(row.status)
                      ? 3
                      : undefined
                  }
                  required={["exempt", "incomplete"].includes(row.status)}
                  value={row.note}
                  onChange={(e) =>
                    change(row.student_id, { note: e.target.value })
                  }
                />
              </label>
            </fieldset>
          ))}
        </div>
        {editable && (
          <label>
            Reason for this score revision
            <textarea
              name="reason"
              required
              minLength={5}
              maxLength={2000}
              placeholder="Describe the grading or correction you reviewed."
            />
          </label>
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
            disabled={busy}
            onClick={onClose}
          >
            {editable ? "Cancel" : "Close"}
          </button>
          {editable && (
            <button className="button primary" disabled={busy}>
              Save scores
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function ProgressReport({
  report,
  onClose,
}: {
  report: any;
  onClose: () => void;
}) {
  const { data, studentId } = report,
    student = data.results.find((row: any) => row.student_id === studentId),
    assignments = data.assignments.filter((row: any) => !row.archived),
    scores = data.scores.filter(
      (row: any) => row.student_id === studentId && row.expected,
    );
  const content = (
    <article className="class-progress-report">
      <header>
        <span className="eyebrow">STJW · CLASS PROGRESS</span>
        <h2>{student.name}</h2>
        <p>
          {data.section.name} · {data.term.name}
        </p>
        <Badge tone={report.reviewer ? "success" : "warm"}>
          {report.reviewer
            ? "Reviewed historical result"
            : data.book.status === "locked"
              ? "Locked gradebook · current view"
              : "Draft / provisional class report"}
        </Badge>
      </header>
      <div className="grade-report-result">
        <strong>
          {student.percentage === null
            ? "No calculated grade"
            : student.percentage + "%"}
        </strong>
        <span>{student.label ?? ""}</span>
      </div>
      <p>
        {data.book.policy.name} · policy version {data.book.policy_version}.
        Grade labels use exact results before display rounding.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Due</th>
              <th>Result</th>
              <th>Feedback</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((assignment: any) => {
              const score = scores.find(
                (row: any) => row.assignment_id === assignment.id,
              );
              return (
                score && (
                  <tr key={assignment.id}>
                    <td>{assignment.title}</td>
                    <td>{assignment.due_on}</td>
                    <td>
                      {score.status === "scored"
                        ? `${pointText(score.points_units)} / ${pointText(assignment.max_points_units)}`
                        : statusLabel(score.status)}
                    </td>
                    <td>{score.note || "—"}</td>
                  </tr>
                )
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="grade-report-note">
        {report.reviewer
          ? `Reviewed by ${report.reviewer} on ${new Date(report.reviewedAt).toLocaleString()}.`
          : `Gradebook version ${data.book.version}. ${data.rosterCurrent ? "Roster matches current enrollment." : "Roster requires office reconciliation."}`}{" "}
        This is one class’s progress report; cumulative report cards and
        transcripts are separate workflows.
      </p>
      <div className="dialog-actions">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
        <button className="button primary" onClick={() => window.print()}>
          <Printer size={17} />
          Print / save PDF
        </button>
      </div>
    </article>
  );
  return (
    <>
      <Modal title="Class progress report" onClose={onClose}>
        {content}
      </Modal>
      {createPortal(
        <div className="grade-print-root">{content}</div>,
        document.body,
      )}
    </>
  );
}
