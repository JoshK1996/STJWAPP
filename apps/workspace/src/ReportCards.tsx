import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  Printer,
  RefreshCw,
  Search,
} from "lucide-react";
import { api, download } from "./api";
import { Avatar, Badge, Empty, Modal, Panel } from "./components";
import { reportCardKey } from "../shared/report-cards";
import "./report-cards.css";
const labelDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
function gradeText(cell: any, presentation: any) {
  if (!cell?.result) return "Awaiting review";
  const values = [];
  if (presentation.showLabel && cell.result.label !== null)
    values.push(cell.result.label);
  if (presentation.showPercentage && cell.result.percentage !== null)
    values.push(cell.result.percentage + "%");
  return values.join(" · ") || "No calculated grade";
}
function ReportPaper({
  snapshot,
  issue,
  latestNumber,
  currentStatus,
}: {
  snapshot: any;
  issue?: any;
  latestNumber?: number;
  currentStatus?: string;
}) {
  const { source, presentation, cells } = snapshot,
    sections: any[] = [
      ...new Map<string, any>(
        source.cells.map((c: any) => [c.sectionId, c.section]),
      ).values(),
    ];
  const termGroups = [];
  for (let i = 0; i < source.terms.length; i += 4)
    termGroups.push(source.terms.slice(i, i + 4));
  const excluded = cells.filter((c: any) => !c.included),
    comments = cells.filter((c: any) => c.included && c.comment);
  return (
    <article className={"report-card-paper " + presentation.layout}>
      <header className="report-paper-heading">
        <div className="report-paper-mark">
          <FileText size={26} />
        </div>
        <div>
          <p>
            {source.organization.name} · {source.organization.unit_name}
          </p>
          <h1>{presentation.title}</h1>
          {presentation.subtitle && <p>{presentation.subtitle}</p>}
        </div>
        <span>{source.year.name}</span>
      </header>
      <div className="report-paper-student">
        <div>
          <small>Student</small>
          <h2>{source.student.name}</h2>
          <p>{source.student.studentNumber}</p>
        </div>
        <div>
          <small>Grade level</small>
          <strong>{source.enrollment.grade_level}</strong>
        </div>
        <div>
          <small>{issue ? "Issued" : "Review status"}</small>
          <strong>
            {issue ? labelDate(issue.issued_at) : "Draft — not issued"}
          </strong>
          {issue && <p>Issued copy {issue.number}</p>}
        </div>
      </div>
      {issue && latestNumber !== issue.number && (
        <p className="report-paper-status">
          Earlier issued copy. A newer issued version is available.
        </p>
      )}
      {issue && latestNumber === issue.number && currentStatus === "draft" && (
        <p className="report-paper-status">
          This is the last issued copy. A revision is being prepared.
        </p>
      )}
      {termGroups.map((terms: any[], index) => (
        <div className="report-paper-table-wrap" key={index}>
          <table>
            <thead>
              <tr>
                <th>Class / subject</th>
                {terms.map((term) => (
                  <th key={term.id}>
                    {term.name}
                    <small>
                      {term.starts_on} – {term.ends_on}
                    </small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                <tr key={section.id}>
                  <th>
                    {section.name}
                    {section.course_code && (
                      <small>
                        {section.course_code} · {section.course_title}
                      </small>
                    )}
                  </th>
                  {terms.map((term) => {
                    const cell = source.cells.find(
                        (c: any) =>
                          c.sectionId === section.id && c.termId === term.id,
                      ),
                      choice = cells.find(
                        (c: any) =>
                          c.sectionId === section.id && c.termId === term.id,
                      );
                    return (
                      <td key={term.id}>
                        {!cell ? (
                          <span className="report-paper-muted">
                            Not in this term
                          </span>
                        ) : !choice?.included ? (
                          <span className="report-paper-muted">Excluded*</span>
                        ) : (
                          <>
                            <strong>{gradeText(cell, presentation)}</strong>
                            {cell.result?.missing > 0 && (
                              <small>
                                Recorded missing work: {cell.result.missing}
                              </small>
                            )}
                            {!issue && cell.problem && (
                              <small className="report-paper-warning">
                                {cell.problem}
                              </small>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {presentation.summary && (
        <section>
          <h3>School comments</h3>
          <p className="report-paper-prose">{presentation.summary}</p>
        </section>
      )}
      {!!comments.length && (
        <section>
          <h3>Class comments</h3>
          {comments.map((cell: any) => (
            <p key={reportCardKey(cell)} className="report-paper-prose">
              <strong>
                {
                  source.cells.find((s: any) => s.sectionId === cell.sectionId)
                    .section.name
                }{" "}
                · {source.terms.find((t: any) => t.id === cell.termId).name}
                :{" "}
              </strong>
              {cell.comment}
            </p>
          ))}
        </section>
      )}
      {!!excluded.length && (
        <section className="report-paper-exclusions">
          <h3>Excluded results</h3>
          {excluded.map((cell: any) => (
            <p key={reportCardKey(cell)}>
              <strong>
                {
                  source.cells.find((s: any) => s.sectionId === cell.sectionId)
                    .section.name
                }{" "}
                · {source.terms.find((t: any) => t.id === cell.termId).name}:
              </strong>{" "}
              {cell.exclusionReason || "Reason not entered"}
            </p>
          ))}
        </section>
      )}
      <footer>
        {presentation.footer && (
          <p className="report-paper-prose">{presentation.footer}</p>
        )}
        <p>
          {issue
            ? "Issued by " + snapshot.issuerName
            : "Preview only. Office review is required before issuance."}
        </p>
        {issue && (
          <small>
            Report reference {issue.id} · copy {issue.number}
          </small>
        )}
      </footer>
    </article>
  );
}
export default function ReportCards({
  unitId,
  yearId,
  terms,
  notify,
  onDirty,
}: {
  unitId: string;
  yearId: string;
  terms: any[];
  notify: (text: string, error?: boolean) => void;
  onDirty: (value: boolean) => void;
}) {
  const [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [list, setList] = useState<any>({
      students: [],
      cards: [],
      hasMore: false,
    }),
    [termIds, setTermIds] = useState<string[]>(
      terms.length <= 8 ? terms.map((t) => t.id) : [],
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [presentation, setPresentation] = useState<any>(null),
    [cells, setCells] = useState<any[]>([]),
    [dirty, setDirty] = useState(false),
    [saveReason, setSaveReason] = useState(""),
    [dialog, setDialog] = useState<string | null>(null),
    [reason, setReason] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [ackNoGrade, setAckNoGrade] = useState(false),
    [ackMissing, setAckMissing] = useState(false),
    [print, setPrint] = useState<any>(null),
    [listVersion, setListVersion] = useState(0);
  const termsInitialized = useRef(terms.length > 0);
  useEffect(() => {
    if (!termsInitialized.current && terms.length) {
      setTermIds(terms.length <= 8 ? terms.map((t) => t.id) : []);
      termsInitialized.current = true;
    }
  }, [terms]);
  useEffect(() => {
    onDirty(dirty || busy);
  }, [dirty, busy, onDirty]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      if (!yearId) return;
      void api(
        "/school/report-cards?unitId=" +
          unitId +
          "&yearId=" +
          yearId +
          "&search=" +
          encodeURIComponent(search) +
          "&offset=" +
          offset,
      )
        .then((result) => {
          if (current) {
            setList(result);
            setError("");
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [unitId, yearId, search, offset, listVersion]);
  function leave() {
    if (dirty && !window.confirm("Discard unsaved report card changes?"))
      return false;
    setDirty(false);
    return true;
  }
  async function load(id: string) {
    const result = await api("/school/report-cards/" + id);
    setDetail(result);
    setPresentation(result.card.presentation);
    setCells(result.card.cells);
    setDirty(false);
    setSaveReason("");
  }
  async function open(studentId: string, id?: string) {
    if (!leave()) return;
    setBusy(true);
    try {
      const card = id
        ? { id }
        : await api("/school/report-cards/open", {
            studentId,
            yearId,
            termIds,
          });
      await load(card.id);
      setListVersion((v) => v + 1);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function changePresentation(key: string, value: any) {
    setPresentation((p: any) => ({ ...p, [key]: value }));
    setDirty(true);
  }
  function changeCell(key: string, value: any) {
    setCells((rows) =>
      rows.map((c) => (reportCardKey(c) === key ? { ...c, ...value } : c)),
    );
    setDirty(true);
  }
  async function save() {
    setBusy(true);
    try {
      await api("/school/report-cards/" + detail.card.id + "/save", {
        version: detail.card.version,
        presentation,
        cells,
        reason: saveReason,
        commandId: crypto.randomUUID(),
      });
      await load(detail.card.id);
      notify("Report card draft saved.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function action(kind: string) {
    setDialog(kind);
    setReason("");
    setReviewed(false);
    setAckNoGrade(false);
    setAckMissing(false);
  }
  async function act() {
    setBusy(true);
    try {
      const input = {
        version: detail.card.version,
        reason,
        commandId: crypto.randomUUID(),
        ...(dialog === "reconcile"
          ? { sourceHash: detail.currentSourceHash }
          : dialog === "issue"
            ? {
                reviewed,
                acknowledgeMissing: ackMissing,
                acknowledgeNoGrade: ackNoGrade,
              }
            : {}),
      };
      await api("/school/report-cards/" + detail.card.id + "/" + dialog, input);
      await load(detail.card.id);
      setDialog(null);
      setListVersion((v) => v + 1);
      notify(
        dialog === "issue"
          ? "Report card issued. A permanent copy is retained."
          : dialog === "reconcile"
            ? "Sources refreshed. Review the updated results before issuing."
            : "A new draft is open. Earlier issued copies are retained.",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function issuedCopy(issueId: string) {
    setBusy(true);
    try {
      setPrint(
        await api(
          "/school/report-cards/" + detail.card.id + "/issues/" + issueId,
        ),
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const source = detail?.card.source_snapshot,
    editable = detail?.card.status === "draft",
    sections: any[] = source
      ? [
          ...new Map<string, any>(
            source.cells.map((c: any) => [c.sectionId, c.section]),
          ).values(),
        ]
      : [];
  const selected = cells.filter((c) => c.included),
    problems =
      source?.cells.filter(
        (c: any) =>
          c.problem &&
          selected.some((s) => reportCardKey(s) === reportCardKey(c)),
      ) ?? [];
  const incompleteReasons = cells.filter(
    (c) => !c.included && c.exclusionReason.trim().length < 10,
  ).length;
  const noGrade =
    source?.cells.filter(
      (c: any) =>
        c.result?.percentage === null &&
        selected.some((s) => reportCardKey(s) === reportCardKey(c)),
    ).length ?? 0;
  const missing =
    source?.cells.filter(
      (c: any) =>
        c.result?.missing > 0 &&
        selected.some((s) => reportCardKey(s) === reportCardKey(c)),
    ).length ?? 0;
  const snapshot = detail
    ? { source, presentation, cells, issuerName: detail.issues[0]?.issuer_name }
    : null;
  if (!yearId)
    return (
      <Empty
        title="Choose a school year"
        detail="Create terms and review classroom grades before preparing report cards."
      />
    );
  return (
    <div className="report-cards">
      {!detail ? (
        <Panel
          title="One school year, one clear view"
          detail="Bring reviewed class results together, with terms side by side."
        >
          <div className="report-cards-body">
            <div className="report-term-heading">
              <h3>Terms to include</h3>
              <button
                className="text-link"
                disabled={terms.length > 8 || busy}
                onClick={() => setTermIds(terms.map((t) => t.id))}
              >
                Select full school year
              </button>
            </div>
            <div className="report-term-choices">
              {terms.map((term) => (
                <label key={term.id}>
                  <input
                    type="checkbox"
                    checked={termIds.includes(term.id)}
                    disabled={
                      busy ||
                      (!termIds.includes(term.id) && termIds.length >= 8)
                    }
                    onChange={(e) =>
                      setTermIds((ids) =>
                        e.target.checked
                          ? [...ids, term.id]
                          : ids.filter((id) => id !== term.id),
                      )
                    }
                  />
                  <span>
                    <strong>{term.name}</strong>
                    <small>
                      {term.starts_on} – {term.ends_on}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            {!terms.length && (
              <p>Add terms in School setup before opening a report card.</p>
            )}
            {terms.length > 8 && (
              <p>
                Select up to eight terms per report. Additional terms can use a
                separate report.
              </p>
            )}
            <label className="report-student-search">
              <Search size={17} />
              <input
                aria-label="Find report card student"
                maxLength={120}
                placeholder="Find a student by name or number"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            {error ? (
              <p role="alert">{error}</p>
            ) : list.students.length ? (
              <div className="report-student-list">
                {list.students.map((student: any) => (
                  <div key={student.id}>
                    <Avatar name={student.name} />
                    <div>
                      <strong>{student.name}</strong>
                      <small>
                        {student.student_number} · {student.grade_level}
                      </small>
                      <div className="report-existing">
                        {list.cards
                          .filter((c: any) => c.student_id === student.id)
                          .map((c: any) => (
                            <button
                              className="text-link"
                              key={c.id}
                              disabled={busy}
                              onClick={() => void open(student.id, c.id)}
                            >
                              {c.status === "issued" ? "Issued" : "Draft"} ·{" "}
                              {c.term_ids.length}{" "}
                              {c.term_ids.length === 1 ? "term" : "terms"}
                              {c.issue_count ? " · copy " + c.issue_count : ""}
                            </button>
                          ))}
                      </div>
                    </div>
                    <button
                      className="button"
                      disabled={busy || !termIds.length}
                      onClick={() => void open(student.id)}
                    >
                      Open report card
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No matching students"
                detail="Students need enrollment in this school year to appear here."
              />
            )}
            <div className="report-card-pagination">
              <button
                className="button"
                disabled={!offset || busy}
                onClick={() => setOffset((v) => Math.max(0, v - 50))}
              >
                Previous students
              </button>
              <span>
                {offset + (list.students.length ? 1 : 0)}–
                {offset + list.students.length}
              </span>
              <button
                className="button"
                disabled={!list.hasMore || busy}
                onClick={() => setOffset((v) => v + 50)}
              >
                Next students
              </button>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <div className="report-card-toolbar">
            <button
              className="text-link"
              disabled={busy}
              onClick={() => {
                if (leave()) setDetail(null);
              }}
            >
              <ArrowLeft size={17} />
              All students
            </button>
            <Badge tone={editable ? "outline" : "neutral"}>
              {editable
                ? detail.card.issue_count
                  ? "Revision in progress"
                  : "Draft"
                : "Issued · copy " + detail.card.issue_count}
            </Badge>
            <button
              className="button"
              disabled={busy || dirty}
              onClick={() =>
                void load(detail.card.id).catch((e) => notify(e.message, true))
              }
            >
              <RefreshCw size={16} />
              Reload
            </button>
          </div>
          <Panel
            title={source.student.name}
            detail={
              source.year.name +
              " · " +
              source.terms.map((t: any) => t.name).join(" · ")
            }
            action={
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  if (!editable && detail.issues[0])
                    void issuedCopy(detail.issues[0].id);
                  else setPrint({ draft: snapshot });
                }}
              >
                <Printer size={17} />
                Preview printable report
              </button>
            }
          >
            <div className="report-cards-body">
              {!detail.sourceCurrent && (
                <div className="report-card-alert">
                  <strong>Source records have changed.</strong>
                  <p>
                    Review the current source results and refresh this draft
                    before issuing. Earlier issued copies are preserved.
                  </p>
                  <button
                    className="button"
                    disabled={busy || dirty || !editable}
                    onClick={() => action("reconcile")}
                  >
                    Review changed sources
                  </button>
                </div>
              )}
              <div className="report-card-summary">
                <span>
                  <strong>{sections.length}</strong> classes
                </span>
                <span>
                  <strong>{source.terms.length}</strong> terms
                </span>
                <span>
                  <strong>{selected.length}</strong> included results
                </span>
                <span>
                  <strong>{problems.length + incompleteReasons}</strong> items
                  to resolve
                </span>
              </div>
              {editable ? (
                <>
                  <details className="report-card-settings">
                    <summary>Report appearance and school comments</summary>
                    <div className="report-card-form-grid">
                      <label>
                        Report title
                        <input
                          aria-label="Report title"
                          value={presentation.title}
                          maxLength={120}
                          onChange={(e) =>
                            changePresentation("title", e.target.value)
                          }
                        />
                      </label>
                      <label>
                        Subtitle
                        <input
                          aria-label="Report subtitle"
                          value={presentation.subtitle}
                          maxLength={200}
                          onChange={(e) =>
                            changePresentation("subtitle", e.target.value)
                          }
                        />
                      </label>
                      <label>
                        Layout
                        <select
                          aria-label="Report card layout"
                          value={presentation.layout}
                          onChange={(e) =>
                            changePresentation("layout", e.target.value)
                          }
                        >
                          <option value="standard">Standard</option>
                          <option value="compact">Compact</option>
                        </select>
                      </label>
                      <div className="report-display-options">
                        <label>
                          <input
                            type="checkbox"
                            checked={presentation.showLabel}
                            onChange={(e) =>
                              changePresentation("showLabel", e.target.checked)
                            }
                          />
                          Show grade labels
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={presentation.showPercentage}
                            onChange={(e) =>
                              changePresentation(
                                "showPercentage",
                                e.target.checked,
                              )
                            }
                          />
                          Show percentages
                        </label>
                      </div>
                      <label className="report-wide">
                        School comments
                        <textarea
                          aria-label="Report school comments"
                          rows={3}
                          value={presentation.summary}
                          maxLength={4000}
                          onChange={(e) =>
                            changePresentation("summary", e.target.value)
                          }
                        />
                      </label>
                      <label className="report-wide">
                        Footer
                        <textarea
                          aria-label="Report footer"
                          rows={2}
                          value={presentation.footer}
                          maxLength={1000}
                          onChange={(e) =>
                            changePresentation("footer", e.target.value)
                          }
                        />
                      </label>
                    </div>
                  </details>
                  <div className="report-class-editor">
                    {sections.map((section) => (
                      <details
                        key={section.id}
                        open={source.cells.some(
                          (c: any) => c.sectionId === section.id && c.problem,
                        )}
                      >
                        <summary>
                          <strong>{section.name}</strong>
                          <span>
                            {source.cells.filter(
                              (c: any) =>
                                c.sectionId === section.id && c.problem,
                            ).length
                              ? "Review needed"
                              : "Reviewed class results"}
                          </span>
                        </summary>
                        <div className="report-cell-grid">
                          {source.cells
                            .filter((c: any) => c.sectionId === section.id)
                            .map((c: any) => {
                              const key = reportCardKey(c),
                                choice = cells.find(
                                  (row) => reportCardKey(row) === key,
                                ),
                                term = source.terms.find(
                                  (t: any) => t.id === c.termId,
                                ),
                                name = section.name + " · " + term.name;
                              return (
                                <section className="report-cell" key={key}>
                                  <h4>{term.name}</h4>
                                  <strong className="report-cell-grade">
                                    {gradeText(c, presentation)}
                                  </strong>
                                  {c.problem ? (
                                    <p className="report-cell-problem">
                                      {c.problem}
                                    </p>
                                  ) : (
                                    <p className="muted">
                                      Office reviewed{" "}
                                      {labelDate(c.release.reviewedAt)} ·{" "}
                                      {c.release.policyName}
                                    </p>
                                  )}
                                  <label className="report-check">
                                    <input
                                      type="checkbox"
                                      aria-label={"Include " + name}
                                      checked={choice.included}
                                      onChange={(e) =>
                                        changeCell(key, {
                                          included: e.target.checked,
                                        })
                                      }
                                    />
                                    Include this result
                                  </label>
                                  {!choice.included && (
                                    <label>
                                      Reason for exclusion
                                      <textarea
                                        aria-label={
                                          "Exclusion reason for " + name
                                        }
                                        value={choice.exclusionReason}
                                        minLength={10}
                                        maxLength={1000}
                                        rows={2}
                                        onChange={(e) =>
                                          changeCell(key, {
                                            exclusionReason: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                  )}
                                  <label>
                                    Office comment
                                    <textarea
                                      aria-label={"Comment for " + name}
                                      value={choice.comment}
                                      maxLength={2000}
                                      rows={2}
                                      onChange={(e) =>
                                        changeCell(key, {
                                          comment: e.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                </section>
                              );
                            })}
                        </div>
                      </details>
                    ))}
                  </div>
                  {!sections.length && (
                    <Empty
                      title="No class results found"
                      detail="Add dated class enrollment, then refresh sources to capture the classes for these terms."
                    />
                  )}
                  <div className="report-save-row">
                    <label>
                      Reason for draft changes
                      <input
                        aria-label="Reason for report draft changes"
                        value={saveReason}
                        maxLength={2000}
                        onChange={(e) => setSaveReason(e.target.value)}
                        placeholder="Explain the comments or presentation changes"
                      />
                    </label>
                    <button
                      className="button"
                      disabled={busy || !dirty || saveReason.trim().length < 10}
                      onClick={() => void save()}
                    >
                      Save draft changes
                    </button>
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        dirty ||
                        !detail.sourceCurrent ||
                        !selected.length ||
                        problems.length > 0 ||
                        incompleteReasons > 0
                      }
                      onClick={() => action("issue")}
                    >
                      <CheckCircle2 size={17} />
                      Review and issue
                    </button>
                  </div>
                </>
              ) : (
                <div className="report-issued-banner">
                  <CheckCircle2 size={24} />
                  <div>
                    <strong>
                      Issued copy {detail.card.issue_count} is retained.
                    </strong>
                    <p>
                      Open the issued copy below to print or export it. Reopen
                      this record to prepare a correction.
                    </p>
                  </div>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => action("reopen")}
                  >
                    Prepare correction
                  </button>
                </div>
              )}
            </div>
          </Panel>
          <Panel
            title="Year at a glance"
            detail={
              editable
                ? "Draft preview. Values come from the captured class reviews."
                : "Current record layout. Open an issued copy for the final dated document."
            }
          >
            <div className="report-cards-body report-paper-screen">
              <ReportPaper
                snapshot={snapshot}
                issue={editable ? undefined : detail.issues[0]}
                latestNumber={detail.card.issue_count}
                currentStatus={detail.card.status}
              />
            </div>
          </Panel>
          <Panel
            title="Issued copies and record history"
            detail="A corrected issue adds a new copy; earlier copies keep their original grades and comments."
          >
            <div className="report-cards-body">
              {detail.issues.length ? (
                <div className="report-issue-list">
                  {detail.issues.map((issue: any) => (
                    <div key={issue.id}>
                      <FileText size={21} />
                      <div>
                        <strong>Issued copy {issue.number}</strong>
                        <small>
                          {labelDate(issue.issued_at)} · {issue.issuer_name}
                        </small>
                        <p>{issue.reason}</p>
                      </div>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void issuedCopy(issue.id)}
                      >
                        Open issued copy {issue.number}
                      </button>
                      <button
                        className="text-link"
                        onClick={() =>
                          void download(
                            "/school/report-cards/" +
                              detail.card.id +
                              "/issues/" +
                              issue.id +
                              "?format=csv",
                            "stjw-report-card-" + issue.number + ".csv",
                          ).catch((e) => notify(e.message, true))
                        }
                      >
                        CSV
                      </button>
                      <button
                        className="text-link"
                        onClick={() =>
                          void download(
                            "/school/report-cards/" +
                              detail.card.id +
                              "/issues/" +
                              issue.id +
                              "?format=json",
                            "stjw-report-card-" + issue.number + ".json",
                          ).catch((e) => notify(e.message, true))
                        }
                      >
                        JSON
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="No issued copies yet"
                  detail="Review every included grade and excluded result, then issue this report card."
                />
              )}
              <details className="report-audit-list">
                <summary>Recent record history</summary>
                {detail.history.map((h: any) => (
                  <p key={h.id}>
                    <strong>
                      {h.entity_type.split(".").at(-1).replaceAll("_", " ")}
                    </strong>{" "}
                    · {h.actor_name} · {new Date(h.created_at).toLocaleString()}
                    {h.snapshot?.after?.reason && (
                      <span> — {h.snapshot.after.reason}</span>
                    )}
                  </p>
                ))}
              </details>
            </div>
          </Panel>
        </>
      )}
      {dialog && (
        <Modal
          title={
            dialog === "issue"
              ? "Issue this report card"
              : dialog === "reconcile"
                ? "Review changed report sources"
                : "Prepare a report card correction"
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="report-action-dialog">
            {dialog === "reconcile" ? (
              <>
                <p>
                  Current identities, enrollment and reviewed class results will
                  replace the draft’s captured sources. Existing comments and
                  exclusions remain attached to the same class and term.
                </p>
                <ul>
                  {detail.currentSource.cells.map((c: any) => (
                    <li key={reportCardKey(c)}>
                      <strong>
                        {c.section.name} ·{" "}
                        {
                          detail.currentSource.terms.find(
                            (t: any) => t.id === c.termId,
                          ).name
                        }
                      </strong>
                      <span>{c.problem ?? gradeText(c, presentation)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : dialog === "issue" ? (
              <>
                <p>
                  This creates a permanent issued copy for {source.student.name}
                  . It does not send a message to families.
                </p>
                <label className="report-check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the student, all terms, included grades, comments,
                  and excluded results.
                </label>
                {noGrade > 0 && (
                  <label className="report-check">
                    <input
                      type="checkbox"
                      checked={ackNoGrade}
                      onChange={(e) => setAckNoGrade(e.target.checked)}
                    />
                    I acknowledge {noGrade} included results without a
                    calculated grade.
                  </label>
                )}
                {missing > 0 && (
                  <label className="report-check">
                    <input
                      type="checkbox"
                      checked={ackMissing}
                      onChange={(e) => setAckMissing(e.target.checked)}
                    />
                    I acknowledge recorded missing work in {missing} included
                    results.
                  </label>
                )}
              </>
            ) : (
              <p>
                The last issued copy remains unchanged. Review and refresh
                changed class results in the new draft, then issue a new copy.
              </p>
            )}
            <label>
              Reason
              <textarea
                aria-label="Reason for report card action"
                rows={3}
                value={reason}
                minLength={10}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  reason.trim().length < 10 ||
                  (dialog === "issue" &&
                    (!reviewed ||
                      (noGrade > 0 && !ackNoGrade) ||
                      (missing > 0 && !ackMissing)))
                }
                onClick={() => void act()}
              >
                {busy
                  ? "Saving…"
                  : dialog === "issue"
                    ? "Issue permanent copy"
                    : dialog === "reconcile"
                      ? "Refresh reviewed sources"
                      : "Open correction draft"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {print && (
        <>
          <Modal
            title={
              print.draft
                ? "Draft print preview"
                : "Issued report card · copy " + print.issue.number
            }
            onClose={() => setPrint(null)}
          >
            <div className="report-print-preview">
              <ReportPaper
                snapshot={print.draft ?? print.issue.snapshot}
                issue={print.issue}
                latestNumber={print.latestNumber}
                currentStatus={print.currentStatus}
              />
              <div className="dialog-actions">
                <button className="button" onClick={() => setPrint(null)}>
                  Close print preview
                </button>
                <button
                  className="button primary"
                  onClick={() => window.print()}
                >
                  <Printer size={17} />
                  Print / save PDF
                </button>
              </div>
            </div>
          </Modal>
          {createPortal(
            <div className="report-card-print-root" aria-hidden="true">
              <ReportPaper
                snapshot={print.draft ?? print.issue.snapshot}
                issue={print.issue}
                latestNumber={print.latestNumber}
                currentStatus={print.currentStatus}
              />
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
