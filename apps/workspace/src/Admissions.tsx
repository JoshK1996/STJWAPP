import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import { admissionStages, admissionTransitions } from "../shared/admissions";
type Notice = (message: string, error?: boolean) => void;
type Props = {
  unitId: string;
  yearId: string;
  years: any[];
  people: any[];
  households: any[];
  timezone: string;
  notify: Notice;
  onRefresh: () => Promise<void>;
  onStudent: (id: string) => void;
};
const names: Record<string, string> = {
  inquiry: "Inquiry",
  application: "Application",
  review: "In review",
  offered: "Offer recorded",
  accepted: "Accepted",
  enrolled: "Enrolled",
  declined: "Declined",
  withdrawn: "Withdrawn",
};
const when = (value: string, zone: string) =>
  DateTime.fromISO(value).setZone(zone).toFormat("LLL d, yyyy · h:mm a");
export default function Admissions({
  unitId,
  yearId,
  years,
  people,
  households,
  timezone,
  notify,
  onRefresh,
  onStudent,
}: Props) {
  const [list, setList] = useState<any>(null),
    [policy, setPolicy] = useState<any>(null),
    [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState<any>(null),
    [dialog, setDialog] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async () => {
    if (!yearId) return;
    return await Promise.all([
      api("/school/admissions/settings?unitId=" + unitId),
      api(
        "/school/admissions?" +
          new URLSearchParams({
            unitId,
            yearId,
            search: query,
            offset: String(offset),
            ...(status ? { status } : {}),
          }),
      ),
    ]);
  }, [unitId, yearId, query, status, offset]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void load()
      .then((result) => {
        if (current && result) {
          setPolicy(result[0]);
          setList(result[1]);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load]);
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      setDetail(await api("/school/admissions/" + id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = await load();
    if (result) {
      setPolicy(result[0]);
      setList(result[1]);
    }
    if (detail) await open(detail.application.id);
    await onRefresh();
  }
  function edit(kind: string, item?: any) {
    setError("");
    setDialog({ kind, item });
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget),
      application = detail.application;
    try {
      if (dialog.kind === "stage")
        await api("/school/admissions/" + application.id + "/stage", {
          version: application.version,
          status: form.get("status"),
          reason: form.get("reason"),
        });
      if (dialog.kind === "checklist")
        await api("/school/admissions/" + application.id + "/checklist", {
          version: application.version,
          itemId: dialog.item.id,
          status: form.get("status"),
          evidence: form.get("evidence"),
        });
      if (dialog.kind === "refresh")
        await api(
          "/school/admissions/" + application.id + "/refresh-checklist",
          {
            version: application.version,
            policyVersion: policy.version,
            reason: form.get("reason"),
          },
        );
      if (dialog.kind === "edit")
        await api(
          "/school/admissions/" + application.id,
          {
            version: application.version,
            gradeLevel: form.get("gradeLevel"),
            primaryContactId: form.get("primaryContactId") || null,
            notes: form.get("notes"),
            reason: form.get("reason"),
          },
          "PATCH",
        );
      if (dialog.kind === "enroll")
        await api("/school/admissions/" + application.id + "/enroll", {
          version: application.version,
          studentNumber: form.get("studentNumber"),
          startsOn: form.get("startsOn"),
          endsOn: form.get("endsOn"),
          householdId: form.get("householdId") || null,
          contactCanCommunicate: form.get("canCommunicate") === "on",
          reason: form.get("reason"),
        });
      setDialog(null);
      await refresh();
      notify(
        dialog.kind === "enroll"
          ? "Application converted into a student enrollment."
          : "Admissions record saved.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!yearId)
    return (
      <Panel title="Admissions">
        <Empty
          title="Choose a school year"
          detail="Applications and their enrollment destinations belong to a specific school year."
        />
      </Panel>
    );
  const application = detail?.application,
    year = years.find((item) => item.id === yearId),
    ready =
      policy?.confirmed &&
      application?.policy_version === policy?.version &&
      application?.checklist.every(
        (item: any) => !item.required || item.status !== "pending",
      );
  return (
    <div className="admissions-module">
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {detail ? (
        <>
          <button className="text-link" onClick={() => setDetail(null)}>
            <ArrowLeft size={16} />
            Back to admissions
          </button>
          <Panel
            title={detail.applicant.name}
            detail={`${application.grade_level} · ${year?.name ?? ""}`}
            action={
              <Badge
                tone={
                  application.status === "enrolled"
                    ? "green"
                    : application.status === "declined"
                      ? "warm"
                      : "neutral"
                }
              >
                {names[application.status]}
              </Badge>
            }
          >
            <div className="admission-profile">
              <div>
                <span>Primary contact</span>
                <strong>{detail.contact?.name ?? "Not linked"}</strong>
                <p>
                  {[detail.contact?.email, detail.contact?.phone]
                    .filter(Boolean)
                    .join(" · ") || "No contact details recorded"}
                </p>
              </div>
              <div>
                <span>Application created</span>
                <strong>{when(application.created_at, timezone)}</strong>
                <p>
                  {detail.student
                    ? "Linked student ID: " + detail.student.student_number
                    : "New prospective student"}
                </p>
              </div>
            </div>
            {application.notes && (
              <p className="admission-notes">{application.notes}</p>
            )}
            <div className="admission-actions">
              {application.status !== "enrolled" && (
                <button
                  className="button secondary"
                  onClick={() => edit("edit")}
                >
                  Edit application
                </button>
              )}
              {admissionTransitions[application.status].length > 0 && (
                <button
                  className="button primary"
                  onClick={() => edit("stage")}
                >
                  Record stage change
                  <ArrowRight size={16} />
                </button>
              )}
              {application.status === "accepted" && (
                <button
                  className="button primary"
                  disabled={!ready}
                  onClick={() => edit("enroll")}
                >
                  <Check size={16} />
                  Review & enroll
                </button>
              )}
              {application.enrolled_student_id && (
                <button
                  className="button primary"
                  onClick={() => onStudent(application.enrolled_student_id)}
                >
                  Open student record
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </Panel>
          <Panel
            title="Application checklist"
            detail={`Saved template version ${application.policy_version}. Record the evidence used for each review.`}
            action={
              application.status !== "enrolled" ? (
                <button
                  className="button secondary small"
                  onClick={() => edit("refresh")}
                >
                  <RefreshCw size={15} />
                  Review current template
                </button>
              ) : undefined
            }
          >
            {!policy?.confirmed && (
              <p className="attendance-notice">
                Confirm the school’s admissions checklist before issuing an
                offer or enrolling.
              </p>
            )}
            {policy &&
              application.policy_version !== policy.version &&
              application.status !== "enrolled" && (
                <p className="attendance-notice">
                  The template changed. Review and refresh this checklist before
                  continuing to an offer, acceptance or enrollment.
                </p>
              )}
            <div className="school-record-list">
              {application.checklist.map((item: any) => (
                <div key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <p>
                      {item.required ? "Required" : "Optional"}
                      {item.evidence ? " · " + item.evidence : ""}
                    </p>
                  </div>
                  <Badge
                    tone={
                      item.status === "complete"
                        ? "green"
                        : item.status === "waived"
                          ? "warm"
                          : "neutral"
                    }
                  >
                    {item.status}
                  </Badge>
                  {application.status !== "enrolled" && (
                    <button
                      className="text-link"
                      onClick={() => edit("checklist", item)}
                    >
                      Review item
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!application.checklist.length && (
              <Empty
                title="No checklist items saved"
                detail="The office can configure its requirements, then apply the reviewed template here."
              />
            )}
            <p className="panel-note">
              Evidence notes identify where staff reviewed a requirement. Files
              are not uploaded through this checklist.
            </p>
          </Panel>
          <Panel
            title="Admissions history"
            detail="Stage decisions, checklist reviews and conversion remain in the private school history."
          >
            <div className="admission-history">
              {detail.history.map((row: any) => (
                <article key={row.id}>
                  <div>
                    <strong>{historyLabel(row)}</strong>
                    <span>{when(row.created_at, timezone)}</span>
                  </div>
                  <p>
                    {row.actor_name ?? "School office"}
                    {row.snapshot.after?.reason
                      ? " · " + row.snapshot.after.reason
                      : ""}
                  </p>
                  {row.entity_type === "admission.checklist_reviewed" &&
                    row.snapshot.after.checklist
                      .filter(
                        (item: any) =>
                          JSON.stringify(item) !==
                          JSON.stringify(
                            row.snapshot.before.checklist.find(
                              (old: any) => old.id === item.id,
                            ),
                          ),
                      )
                      .map((item: any) => (
                        <p key={item.id}>
                          {item.title} · {item.status}
                          {item.evidence ? " · " + item.evidence : ""}
                        </p>
                      ))}
                </article>
              ))}
            </div>
          </Panel>
        </>
      ) : (
        <>
          <div className="community-toolbar">
            <label className="school-search">
              <Search size={17} />
              <input
                placeholder="Find an applicant…"
                aria-label="Find an applicant"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="admission-toolbar-actions">
              <button
                className="button secondary"
                disabled={!policy}
                onClick={() => edit("settings")}
              >
                <Settings2 size={16} />
                Checklist template
              </button>
              <button
                className="button primary"
                disabled={!policy}
                onClick={() => edit("create")}
              >
                <Plus size={17} />
                New inquiry
              </button>
            </div>
          </div>
          <div className="admission-stages">
            <button
              className={!status ? "selected" : ""}
              onClick={() => {
                setStatus("");
                setOffset(0);
              }}
            >
              <strong>
                {list?.counts.reduce(
                  (sum: number, row: any) => sum + row.count,
                  0,
                ) ?? 0}
              </strong>
              <span>All applicants</span>
            </button>
            {admissionStages.map((stage) => (
              <button
                key={stage}
                className={status === stage ? "selected" : ""}
                onClick={() => {
                  setStatus(stage);
                  setOffset(0);
                }}
              >
                <strong>
                  {list?.counts.find((row: any) => row.status === stage)
                    ?.count ?? 0}
                </strong>
                <span>{names[stage]}</span>
              </button>
            ))}
          </div>
          {policy && !policy.confirmed && (
            <p className="attendance-notice">
              <ClipboardList size={18} />
              The admissions checklist is not confirmed. Inquiries can be
              recorded while the school defines its requirements.
            </p>
          )}
          <Panel
            title={status ? names[status] : "Admissions pipeline"}
            detail="Follow an applicant from first inquiry through reviewed enrollment."
          >
            <div className="admission-cards">
              {list?.rows.map((row: any) => (
                <button
                  key={row.id}
                  disabled={busy}
                  onClick={() => void open(row.id)}
                >
                  <div>
                    <strong>{row.applicant_name}</strong>
                    <p>
                      {row.grade_level} ·{" "}
                      {row.contact_name ?? "No contact linked"}
                    </p>
                    <small>
                      {
                        row.checklist.filter(
                          (item: any) => item.status !== "pending",
                        ).length
                      }{" "}
                      of {row.checklist.length} checklist items reviewed
                    </small>
                  </div>
                  <Badge tone={row.status === "enrolled" ? "green" : "neutral"}>
                    {names[row.status]}
                  </Badge>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
            {!list?.rows.length && (
              <Empty
                title={
                  loading
                    ? "Loading applications…"
                    : query
                      ? "No matching applicants"
                      : "No applications in this view"
                }
                detail="Record a new inquiry or choose another stage or school year."
              />
            )}
            <div className="mail-pagination">
              <button
                className="button secondary small"
                disabled={!offset || loading}
                onClick={() => setOffset((value) => Math.max(0, value - 50))}
              >
                Previous
              </button>
              <span>
                {list?.rows.length
                  ? `${offset + 1}–${offset + list.rows.length}`
                  : "0 records"}
              </span>
              <button
                className="button secondary small"
                disabled={!list?.hasMore || loading}
                onClick={() => setOffset((value) => value + 50)}
              >
                Next
              </button>
            </div>
          </Panel>
        </>
      )}
      {dialog?.kind === "settings" && (
        <AdmissionTemplate
          unitId={unitId}
          policy={policy}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await refresh();
            notify(
              "Admissions checklist template saved. Existing applications keep their saved checklist until explicitly refreshed.",
            );
          }}
        />
      )}
      {dialog?.kind === "create" && (
        <AdmissionIntake
          unitId={unitId}
          yearId={yearId}
          people={people}
          onClose={() => setDialog(null)}
          onSaved={async (id) => {
            setDialog(null);
            await refresh();
            await open(id);
            notify("Inquiry recorded.");
          }}
        />
      )}
      {dialog && !["settings", "create"].includes(dialog.kind) && detail && (
        <Modal
          title={
            (
              {
                stage: "Record a stage change",
                checklist: "Review checklist item",
                refresh: "Review current checklist template",
                edit: "Edit application",
                enroll: "Review and enroll student",
              } as Record<string, string>
            )[dialog.kind]
          }
          onClose={() => setDialog(null)}
        >
          <form className="community-form" onSubmit={submit}>
            {dialog.kind === "stage" ? (
              <>
                <p>
                  Current stage: <strong>{names[application.status]}</strong>.
                  This records an office decision; offers and acceptance are
                  separate from enrollment.
                </p>
                <label>
                  New stage
                  <select name="status" aria-label="New stage" required>
                    {admissionTransitions[application.status].map((stage) => (
                      <option key={stage} value={stage}>
                        {names[stage]}
                      </option>
                    ))}
                  </select>
                </label>
                <Reason />
              </>
            ) : dialog.kind === "checklist" ? (
              <>
                <p>
                  <strong>{dialog.item.title}</strong>
                </p>
                <label>
                  Review result
                  <select
                    name="status"
                    aria-label="Review result"
                    defaultValue={dialog.item.status}
                  >
                    <option value="pending">Pending</option>
                    <option value="complete">
                      Complete — reviewed by staff
                    </option>
                    <option value="waived">Waived — reason documented</option>
                  </select>
                </label>
                <label>
                  Evidence reference or waiver reason
                  <textarea
                    name="evidence"
                    defaultValue={dialog.item.evidence}
                    rows={4}
                    maxLength={2000}
                  />
                </label>
                <p className="muted">
                  Record where the requirement was reviewed, such as the office
                  file or meeting record. Completing or waiving an item requires
                  at least five characters of evidence.
                </p>
              </>
            ) : dialog.kind === "refresh" ? (
              <>
                <p>
                  Current template version <strong>{policy.version}</strong>.
                  Unchanged items retain their reviews; new or changed items
                  start pending. Earlier evidence remains in history.
                </p>
                <ul>
                  {policy.requirements.map((item: any) => (
                    <li key={item.id}>
                      {item.title} · {item.required ? "Required" : "Optional"}
                    </li>
                  ))}
                </ul>
                {["offered", "accepted"].includes(application.status) && (
                  <p className="attendance-notice">
                    This application will return to In review so the updated
                    requirements can be checked.
                  </p>
                )}
                <Reason />
              </>
            ) : dialog.kind === "edit" ? (
              <>
                <label>
                  Requested grade or program
                  <input
                    name="gradeLevel"
                    required
                    maxLength={30}
                    defaultValue={application.grade_level}
                  />
                </label>
                <ContactSelect
                  people={people}
                  value={application.primary_contact_id}
                />
                <label>
                  Office notes
                  <textarea
                    name="notes"
                    rows={4}
                    maxLength={4000}
                    defaultValue={application.notes}
                  />
                </label>
                <Reason />
              </>
            ) : (
              <>
                <p>
                  <strong>{detail.applicant.name}</strong> ·{" "}
                  {application.grade_level}
                  <br />
                  {year?.name}
                </p>
                <label>
                  Student ID
                  <input
                    name="studentNumber"
                    required
                    maxLength={40}
                    defaultValue={detail.student?.student_number}
                    readOnly={!!detail.student}
                  />
                </label>
                <div className="community-form-grid">
                  <label>
                    Enrollment starts
                    <input
                      type="date"
                      name="startsOn"
                      required
                      defaultValue={year?.starts_on?.slice(0, 10)}
                    />
                  </label>
                  <label>
                    Enrollment ends
                    <input
                      type="date"
                      name="endsOn"
                      required
                      defaultValue={year?.ends_on?.slice(0, 10)}
                    />
                  </label>
                </div>
                <label>
                  Household (optional)
                  <select name="householdId" aria-label="Household (optional)">
                    <option value="">Do not add a household link</option>
                    {households.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {detail.contact && (
                  <>
                    <label className="school-toggle">
                      <input name="canCommunicate" type="checkbox" />
                      <span>
                        Authorize the new application contact to receive school
                        communications.
                      </span>
                    </label>
                    <p className="muted">
                      Existing student-contact permissions are retained.
                      Enrollment does not grant legal-guardian or pickup
                      authority.
                    </p>
                  </>
                )}
                <Reason />
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
                {busy
                  ? "Saving…"
                  : dialog.kind === "enroll"
                    ? "Create reviewed enrollment"
                    : "Save review"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Reason() {
  return (
    <label>
      Reason or review note
      <textarea
        name="reason"
        required
        minLength={10}
        maxLength={2000}
        rows={3}
      />
    </label>
  );
}
function ContactSelect({ people, value }: { people: any[]; value?: string }) {
  return (
    <label>
      Primary application contact
      <select
        name="primaryContactId"
        aria-label="Primary application contact"
        defaultValue={value ?? ""}
      >
        <option value="">Not linked yet</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {person.email ? " · " + person.email : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
function historyLabel(row: any) {
  const labels: Record<string, string> = {
    "admission.created": "Inquiry recorded",
    "admission.updated": "Application updated",
    "admission.checklist_reviewed": "Checklist reviewed",
    "admission.checklist_refreshed": "Checklist template refreshed",
    "admission.enrolled": "Converted into student enrollment",
  };
  return row.entity_type === "admission.stage_changed"
    ? `${names[row.snapshot.before.status]} → ${names[row.snapshot.after.status]}`
    : (labels[row.entity_type] ?? "Record updated");
}
function AdmissionTemplate({
  unitId,
  policy,
  onClose,
  onSaved,
}: {
  unitId: string;
  policy: any;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [items, setItems] = useState<any[]>(policy.requirements),
    [confirmed, setConfirmed] = useState(policy.confirmed),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = (next: any[]) => {
    setItems(next);
    setConfirmed(false);
  };
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(e.currentTarget);
      await api(
        "/school/admissions/settings",
        {
          unitId,
          version: policy.version,
          requirements: items,
          confirmed,
          reason: form.get("reason"),
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
    <Modal title="Admissions checklist template" onClose={onClose}>
      <form className="community-form" onSubmit={save}>
        <p>
          Define the school’s actual intake requirements. New applications copy
          this list; existing applications require a reviewed refresh when the
          template changes.
        </p>
        <div className="admission-template-items">
          {items.map((item, index) => (
            <div key={item.id}>
              <label>
                Requirement {index + 1}
                <input
                  required
                  minLength={3}
                  maxLength={150}
                  value={item.title}
                  onChange={(e) =>
                    change(
                      items.map((row, i) =>
                        i === index ? { ...row, title: e.target.value } : row,
                      ),
                    )
                  }
                />
              </label>
              <label className="school-toggle">
                <input
                  type="checkbox"
                  checked={item.required}
                  onChange={(e) =>
                    change(
                      items.map((row, i) =>
                        i === index
                          ? { ...row, required: e.target.checked }
                          : row,
                      ),
                    )
                  }
                />
                <span>Required</span>
              </label>
              <button
                className="icon-button"
                type="button"
                aria-label={"Remove requirement " + (index + 1)}
                onClick={() => change(items.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={items.length >= 50}
          onClick={() =>
            change([
              ...items,
              { id: crypto.randomUUID(), title: "", required: true },
            ])
          }
        >
          <Plus size={16} />
          Add requirement
        </button>
        <label className="school-toggle">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            The school has reviewed and confirmed this admissions checklist.
          </span>
        </label>
        <Reason />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save checklist template"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function AdmissionIntake({
  unitId,
  yearId,
  people,
  onClose,
  onSaved,
}: {
  unitId: string;
  yearId: string;
  people: any[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState("new"),
    [contactMode, setContactMode] = useState("existing"),
    [search, setSearch] = useState(""),
    [students, setStudents] = useState<any[]>([]),
    [studentId, setStudentId] = useState(""),
    [commandId, setCommandId] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "existing") return;
    let current = true;
    const timer = setTimeout(() => {
      void api(
        "/school/students?unitId=" +
          unitId +
          "&search=" +
          encodeURIComponent(search),
      )
        .then((result) => {
          if (current) setStudents(result.rows);
        })
        .catch((e) => setError(e.message));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mode, unitId, search]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget),
      student = students.find((row) => row.id === studentId);
    try {
      const row = await api("/school/admissions", {
        unitId,
        yearId,
        commandId,
        existingStudentId: mode === "existing" ? studentId : null,
        name: mode === "existing" ? student?.name : form.get("name"),
        dateOfBirth: mode === "new" ? form.get("dateOfBirth") || null : null,
        primaryContactId:
          contactMode === "existing"
            ? form.get("primaryContactId") || null
            : null,
        newContact:
          contactMode === "new"
            ? {
                name: form.get("contactName"),
                email: form.get("contactEmail") || "",
                phone: form.get("contactPhone") || "",
              }
            : null,
        gradeLevel: form.get("gradeLevel"),
        notes: form.get("notes"),
      });
      await onSaved(row.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Record a new inquiry" onClose={onClose}>
      <form
        className="community-form"
        onSubmit={submit}
        onChange={() => setCommandId(crypto.randomUUID())}
      >
        <label>
          Applicant
          <select
            aria-label="Applicant type"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="new">New prospective student</option>
            <option value="existing">
              Existing student — new year enrollment
            </option>
          </select>
        </label>
        {mode === "new" ? (
          <>
            <label>
              Applicant’s full name
              <input name="name" required minLength={2} maxLength={120} />
            </label>
            <label>
              Date of birth (optional)
              <input name="dateOfBirth" type="date" />
            </label>
          </>
        ) : (
          <>
            <label>
              Find existing student
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setStudentId("");
                }}
                placeholder="Search name or student ID"
              />
            </label>
            <label>
              Existing student
              <select
                aria-label="Existing student"
                required
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              >
                <option value="">Choose the matching student</option>
                {students.map((student) => (
                  <option key={student.id} value={student.id}>
                    {student.name} · {student.student_number}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              Search narrows the first 100 matches. Existing student identity
              and contact permissions are retained.
            </p>
          </>
        )}
        <label>
          Requested grade or program
          <input name="gradeLevel" required maxLength={30} />
        </label>
        <label>
          Contact details
          <select
            aria-label="Contact details"
            value={contactMode}
            onChange={(e) => setContactMode(e.target.value)}
          >
            <option value="existing">Choose an existing person</option>
            <option value="new">Record a new contact person</option>
          </select>
        </label>
        {contactMode === "existing" ? (
          <ContactSelect people={people} />
        ) : (
          <>
            <label>
              Contact name
              <input
                name="contactName"
                required
                minLength={2}
                maxLength={120}
              />
            </label>
            <div className="community-form-grid">
              <label>
                Contact email
                <input name="contactEmail" type="email" maxLength={254} />
              </label>
              <label>
                Contact phone
                <input name="contactPhone" maxLength={40} />
              </label>
            </div>
          </>
        )}
        <label>
          Office notes
          <textarea name="notes" maxLength={4000} rows={3} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Record inquiry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
