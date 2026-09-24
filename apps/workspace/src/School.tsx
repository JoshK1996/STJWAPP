import Timetable from "./Timetable";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ClipboardList,
  GraduationCap,
  Home,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api } from "./api";
import { Avatar, Badge, Empty, Modal, Panel } from "./components";
import Attendance from "./Attendance";
import AttendanceSettings from "./AttendanceSettings";
import Admissions from "./Admissions";
import Gradebook from "./Gradebook";
import SchoolImports from "./SchoolImports";
import ReportCards from "./ReportCards";
import StandingPolicies from "./StandingPolicies";
import StandingDecisions from "./StandingDecisions";
import GpaPolicies from "./GpaPolicies";
import GpaReviews from "./GpaReviews";
type Notice = (text: string, error?: boolean) => void;
type SchoolData = {
  years: any[];
  students: any[];
  households: any[];
  people: any[];
  courses: any[];
  staff: any[];
  sections: any[];
  terms: any[];
  grants: any[];
  hasMore: boolean;
};
const blank: SchoolData = {
  years: [],
  students: [],
  households: [],
  people: [],
  courses: [],
  staff: [],
  sections: [],
  terms: [],
  grants: [],
  hasMore: false,
};
const day = (value: string) => value?.slice(0, 10) ?? "";
const dateLabel = (value: string) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(day(value) + "T12:00:00Z"))
    : "Not entered";
export default function School({
  me,
  notify,
  onDirty,
}: {
  me: any;
  notify: Notice;
  onDirty: (value: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const attendanceDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  function leaveAttendance() {
    if (dirty && !window.confirm("Discard unsaved school record changes?"))
      return false;
    attendanceDirty(false);
    return true;
  }
  const [access, setAccess] = useState<any>(null),
    [unitId, setUnitId] = useState(""),
    [yearId, setYearId] = useState(""),
    [tab, setTab] = useState("classes"),
    [data, setData] = useState<SchoolData>(blank),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [retry, setRetry] = useState(0),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [view, setView] = useState<any>(null),
    [dialog, setDialog] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<any[] | null>(null),
    [importsReadyFor, setImportsReadyFor] = useState("");
  const office = !!access?.officeUnits.includes(unitId);
  useEffect(() => {
    let current = true;
    setLoadError("");
    void api("/school/access")
      .then((result) => {
        if (!current) return;
        setAccess(result);
        const unit =
          result.units.find((u: any) => u.kind === "school") ?? result.units[0];
        setUnitId(unit?.id ?? "");
        if (result.officeUnits.includes(unit?.id)) setTab("students");
        if (!unit) setLoading(false);
      })
      .catch((e) => {
        if (current) setLoadError(e.message);
      });
    return () => {
      current = false;
    };
  }, [notify, retry]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timeout);
  }, [search]);
  const load = useCallback(async () => {
    if (!unitId || !access) return;
    const suffix = "?unitId=" + unitId,
      parts = await Promise.all([
        api("/school/years" + suffix),
        api("/school/sections" + suffix + (yearId ? "&yearId=" + yearId : "")),
        ...(office
          ? [
              api(
                "/school/students" +
                  suffix +
                  "&search=" +
                  encodeURIComponent(query) +
                  "&offset=" +
                  offset,
              ),
              api("/school/households" + suffix),
              api("/school/people" + suffix),
              api("/school/courses" + suffix),
              api("/school/staff" + suffix),
              yearId
                ? api("/school/terms" + suffix + "&yearId=" + yearId)
                : Promise.resolve({ rows: [] }),
              access.admin
                ? api("/school/office-grants")
                : Promise.resolve({ rows: [] }),
            ]
          : []),
      ]);
    return {
      years: parts[0].rows,
      sections: parts[1].rows,
      students: parts[2]?.rows ?? [],
      households: parts[3]?.rows ?? [],
      people: parts[4]?.rows ?? [],
      courses: parts[5]?.rows ?? [],
      staff: parts[6]?.rows ?? [],
      terms: parts[7]?.rows ?? [],
      grants: parts[8]?.rows ?? [],
      hasMore: parts[2]?.hasMore ?? false,
    } as SchoolData;
  }, [unitId, yearId, office, access, query, offset]);
  useEffect(() => {
    let current = true;
    if (!unitId) return;
    setLoading(true);
    void load()
      .then((result) => {
        if (!current || !result) return;
        setData(result);
        if (!yearId && result.years.length) setYearId(result.years[0].id);
        // Latch completed scope metadata, not transient loading. Later directory
        // refreshes must keep an existing import and unresolved save mounted.
        else setImportsReadyFor(JSON.stringify([unitId, yearId]));
      })
      .catch((e) => {
        if (current) setLoadError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load, unitId, yearId, notify, retry]);
  async function open(type: string, recordId: string) {
    setBusy(true);
    try {
      const record = await api(
        "/school/" +
          (type === "student"
            ? "students"
            : type === "household"
              ? "households"
              : "sections") +
          "/" +
          recordId,
      );
      setView({ type, id: recordId, record });
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = await load();
    if (result) setData(result);
    if (view) await open(view.type, view.id);
  }
  async function saved(kind: string, result: any) {
    setDialog(null);
    await refresh();
    if (kind === "student" && !dialog.data) await open("student", result.id);
    if (kind === "household" && !dialog.data)
      await open("household", result.id);
    if (kind === "section" && !dialog.data) await open("section", result.id);
    notify("School records saved.");
  }
  const edit = (kind: string, initial?: any, target?: string) =>
    setDialog({ kind, data: initial, target });
  async function showHistory(recordId: string) {
    try {
      setHistory((await api("/school/history/" + recordId)).rows);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  if (loadError)
    return (
      <Panel
        title="School records could not load"
        action={
          <button
            className="button secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        }
      >
        <p className="error school-panel-action" role="alert">
          {loadError}
        </p>
      </Panel>
    );
  if (!access)
    return (
      <Panel title="Opening school records">
        <p className="community-loading">
          Checking your classroom and office access…
        </p>
      </Panel>
    );
  if (!access.units.length)
    return (
      <Panel title="Your school workspace">
        <Empty
          title="No classes assigned yet"
          detail="An administrator can assign you to a class or grant school office access. Your staff account alone does not expose student records."
        />
      </Panel>
    );
  const changeUnit = (value: string) => {
    if (!leaveAttendance()) return;
    setUnitId(value);
    setYearId("");
    setView(null);
    setData(blank);
    setOffset(0);
    setSearch("");
    setTab(access.officeUnits.includes(value) ? "students" : "classes");
  };
  return (
    <div className="school-module">
      <div className="school-scope">
        <label>
          School or program
          <select value={unitId} onChange={(e) => changeUnit(e.target.value)}>
            {access.units.map((unit: any) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          School year
          <select
            value={yearId}
            onChange={(e) => {
              if (!leaveAttendance()) return;
              setYearId(e.target.value);
              setView(null);
            }}
          >
            <option value="">
              {data.years.length
                ? "Choose a school year"
                : "No school year configured"}
            </option>
            {data.years.map((year) => (
              <option key={year.id} value={year.id}>
                {year.name}
              </option>
            ))}
          </select>
        </label>
        <Badge tone="outline">
          {office ? "School office" : "Assigned classrooms"}
        </Badge>
      </div>
      <nav className="school-tabs" aria-label="School areas">
        {(office
          ? [
              ["students", "Students", GraduationCap],
              ["admissions", "Admissions", ClipboardList],
              ["families", "Families & contacts", Home],
              ["classes", "Classrooms", BookOpen],
              ["attendance", "Attendance", Check],
              ["timetable", "Timetable", CalendarDays],
              ["grades", "Gradebooks", GraduationCap],
              ["report-cards", "Report cards", GraduationCap],
              ["standing-policies", "Standing policies", ShieldCheck],
              ["standing-reviews", "Standing reviews", ShieldCheck],
              ["gpa-policies", "GPA policies", ShieldCheck],
              ["gpa-reviews", "Term GPA reviews", ShieldCheck],
              ["imports", "Import records", ClipboardList],
              ["setup", "School setup", Settings2],
            ]
          : [
              ["classes", "My classrooms", BookOpen],
              ["attendance", "Attendance", Check],
              ["timetable", "Timetable", CalendarDays],
              ["grades", "Gradebooks", GraduationCap],
            ]
        ).map(([key, label, Icon]: any) => (
          <button
            key={key}
            aria-current={tab === key ? "page" : undefined}
            className={tab === key ? "active" : ""}
            onClick={() => {
              if (key === tab && !view) return;
              if (!leaveAttendance()) return;
              setTab(key);
              setView(null);
            }}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </nav>
      {tab === "timetable" && <Timetable key={unitId+yearId} unitId={unitId} yearId={yearId} years={data.years} sections={data.sections} staff={data.staff} office={office} notify={notify} onDirty={attendanceDirty} />}
      {tab === "grades" && <Gradebook key={unitId+yearId} unitId={unitId} yearId={yearId} sections={data.sections} office={office} notify={notify} onDirty={attendanceDirty} />}
      {tab === "report-cards" && office && <ReportCards key={unitId+yearId} unitId={unitId} yearId={yearId} terms={data.terms} notify={notify} onDirty={attendanceDirty} />}
      {tab === "standing-policies" && office && <StandingPolicies key={unitId+yearId} unitId={unitId} yearId={yearId} actorRole={me.actor.role} notify={notify} onDirty={attendanceDirty} />}
      {tab === "standing-reviews" && office && <StandingDecisions key={unitId+yearId} unitId={unitId} yearId={yearId} terms={data.terms} notify={notify} onDirty={attendanceDirty} />}
      {tab === "gpa-policies" && office && <GpaPolicies key={unitId+yearId} unitId={unitId} yearId={yearId} actorRole={me.actor.role} notify={notify} onDirty={attendanceDirty} />}
      {tab === "gpa-reviews" && office && <GpaReviews key={unitId+yearId} unitId={unitId} yearId={yearId} terms={data.terms} notify={notify} onDirty={attendanceDirty} />}
      {tab === "imports" && office && (importsReadyFor === JSON.stringify([unitId, yearId])
        ? <SchoolImports key={unitId+yearId} unitId={unitId} yearId={yearId} years={data.years} sections={data.sections} notify={notify} onDirty={attendanceDirty} onApplied={refresh} />
        : <Panel title="Opening school imports"><p className="community-loading" role="status">Loading this school unit and its school-year selection before you choose a file…</p></Panel>)}
      {view ? (
        <>
          <button className="text-link" onClick={() => setView(null)}>
            <ArrowLeft size={17} />
            Back to{" "}
            {tab === "families"
              ? "families"
              : tab === "classes"
                ? "classrooms"
                : "students"}
          </button>
          {view.type === "student" ? (
            <StudentRecord
              data={view.record}
              edit={edit}
              open={open}
              history={showHistory}
            />
          ) : view.type === "household" ? (
            <HouseholdRecord
              data={view.record}
              edit={edit}
              open={open}
              history={showHistory}
            />
          ) : (
            <Classroom
              data={view.record}
              edit={edit}
              open={open}
              history={showHistory}
            />
          )}
        </>
      ) : (
        <>
          {tab === "students" && office && (
            <Panel
              title="Every student, accounted for"
              detail="Student profiles and year-by-year enrollment."
              action={
                <button
                  className="button primary"
                  onClick={() => edit("student")}
                >
                  <Plus size={16} />
                  Add student
                </button>
              }
            >
              <div className="school-list-tools">
                <label className="school-search">
                  <Search size={17} />
                  <input
                    aria-label="Find a student"
                    placeholder="Search by name or student ID…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <span>
                  {loading ? "Loading…" : `${data.students.length} shown`}
                </span>
              </div>
              {data.students.length ? (
                <div className="table-wrap">
                  <table className="school-table">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Student ID</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.students.map((student, index) => (
                        <tr key={student.id}>
                          <td>
                            <button
                              className="school-person"
                              disabled={busy}
                              onClick={() => void open("student", student.id)}
                            >
                              <Avatar name={student.name} index={index} />
                              <strong>{student.name}</strong>
                            </button>
                          </td>
                          <td>{student.student_number}</td>
                          <td>
                            <Badge tone={student.active ? "green" : "neutral"}>
                              {student.active ? "Active" : "Inactive"}
                            </Badge>
                          </td>
                          <td>
                            <button
                              className="text-link"
                              onClick={() => void open("student", student.id)}
                            >
                              Open record
                              <ArrowRight size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                !loading && (
                  <Empty
                    title="Your students start here"
                    detail="Add a student, then enroll them in a school year and a class."
                  />
                )
              )}
              <div className="mail-pagination">
                <button
                  className="button secondary small"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  Previous
                </button>
                <span>
                  {offset + 1}–{offset + data.students.length}
                </span>
                <button
                  className="button secondary small"
                  disabled={!data.hasMore}
                  onClick={() => setOffset(offset + 100)}
                >
                  Next
                </button>
              </div>
            </Panel>
          )}
          {tab === "families" && office && (
            <>
              <Panel
                title="Families, connected"
                detail="Households organize relationships. Student contact permissions are assigned separately."
                action={
                  <button
                    className="button primary"
                    onClick={() => edit("household")}
                  >
                    <Plus size={16} />
                    Add household
                  </button>
                }
              >
                <div className="school-card-grid">
                  {data.households.map((household) => (
                    <button
                      className="household-card"
                      key={household.id}
                      onClick={() => void open("household", household.id)}
                    >
                      <span className="school-card-icon">
                        <Home size={22} />
                      </span>
                      <strong>{household.name}</strong>
                      <span>
                        {household.members} members
                        {household.archived ? " · Archived" : ""}
                      </span>
                      <ArrowRight size={17} />
                    </button>
                  ))}
                </div>
                {!data.households.length && !loading && (
                  <Empty
                    title="A place for every family"
                    detail="Create a household and link students and contacts."
                  />
                )}
              </Panel>
              <Panel
                title="Contact directory"
                detail="Creating a contact does not grant student access or pickup permission."
                action={
                  <button
                    className="button secondary"
                    onClick={() => edit("person")}
                  >
                    <Plus size={16} />
                    Add contact
                  </button>
                }
              >
                <div className="table-wrap">
                  <table className="school-table">
                    <thead>
                      <tr>
                        <th>Contact</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.people
                        .filter((person) => !person.student_id)
                        .map((person) => (
                          <tr key={person.id}>
                            <td>{person.name}</td>
                            <td>{person.email || "—"}</td>
                            <td>{person.phone || "—"}</td>
                            <td>
                              <button
                                className="text-link"
                                onClick={() => edit("person", person)}
                              >
                                Edit contact
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}
          {tab === "classes" && (
            <>
              <div className="community-toolbar">
                <p className="muted">
                  {data.sections.length} classrooms ·{" "}
                  {office
                    ? "Manage teachers, rosters and curriculum."
                    : "Your assigned classes and learning plans."}
                </p>
                {office && (
                  <button
                    className="button primary"
                    disabled={!data.years.length}
                    onClick={() => edit("section")}
                  >
                    <Plus size={16} />
                    Create class
                  </button>
                )}
              </div>
              <div className="classroom-grid">
                {data.sections.map((section, index) => (
                  <button
                    key={section.id}
                    className="classroom-card"
                    onClick={() => void open("section", section.id)}
                  >
                    <div
                      className={`classroom-card-top class-tone-${index % 3}`}
                    >
                      <BookOpen size={24} />
                      <Badge>{section.homeroom ? "Homeroom" : "Class"}</Badge>
                    </div>
                    <div className="classroom-card-body">
                      <h2>{section.name}</h2>
                      <p>{section.course_title || "No linked course"}</p>
                      <div className="classroom-card-facts">
                        <span>
                          <Users size={16} />
                          {section.roster_count} on roster · capacity{" "}
                          {section.capacity}
                        </span>
                        <span>
                          <MapPin size={16} />
                          {section.room || "Room not entered"}
                        </span>
                      </div>
                      <div className="classroom-teachers">
                        {section.teachers.length ? (
                          section.teachers.map((teacher: any) => (
                            <span key={teacher.id}>
                              <Avatar name={teacher.name} />
                              {teacher.name}
                            </span>
                          ))
                        ) : (
                          <span>No teacher assigned</span>
                        )}
                      </div>
                      <span className="text-link">
                        Open classroom
                        <ArrowRight size={16} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {!data.sections.length && !loading && (
                <Panel title="Classrooms">
                  <Empty
                    title="Ready for a new class"
                    detail={
                      office
                        ? "Create a school year in School setup, then add your classes and teaching assignments."
                        : "Your assigned classrooms will appear here."
                    }
                  />
                </Panel>
              )}
            </>
          )}
          {tab === "setup" && office && (
            <>
              <SchoolSetup
                data={data}
                yearId={yearId}
                unitId={unitId}
                admin={access.admin}
                edit={edit}
              />
              <AttendanceSettings
                key={unitId + yearId}
                unitId={unitId}
                yearId={yearId}
                notify={notify}
              />
            </>
          )}
          {tab === "attendance" && (
            <Attendance
              key={unitId + yearId}
              unitId={unitId}
              yearId={yearId}
              sections={data.sections}
              office={office}
              timezone={me.organization.timezone}
              notify={notify}
              onDirty={attendanceDirty}
            />
          )}
          {tab === "admissions" && office && (
            <Admissions
              key={unitId + yearId}
              unitId={unitId}
              yearId={yearId}
              years={data.years}
              people={data.people}
              households={data.households}
              timezone={me.organization.timezone}
              notify={notify}
              onRefresh={refresh}
              onStudent={(id) => {
                setTab("students");
                void open("student", id);
              }}
            />
          )}
        </>
      )}
      {dialog && (
        <SchoolDialog
          dialog={dialog}
          unitId={unitId}
          yearId={yearId}
          data={data}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {history && (
        <Modal title="School record history" onClose={() => setHistory(null)}>
          <div className="community-dialog">
            {history.length ? (
              history.map((row, index) => (
                <details className="school-history" key={index}>
                  <summary>
                    {row.entity_type.replaceAll(".", " · ")} ·{" "}
                    {new Date(row.created_at).toLocaleString()}
                  </summary>
                  <HistoryChanges snapshot={row.snapshot} staff={data.staff} />
                </details>
              ))
            ) : (
              <p>No recorded changes.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function StudentRecord({
  data,
  edit,
  open,
  history,
}: {
  data: any;
  edit: (kind: string, initial?: any, target?: string) => void;
  open: (kind: string, id: string) => Promise<void>;
  history: (id: string) => Promise<void>;
}) {
  const s = data.student;
  return (
    <>
      <div className="school-record-heading">
        <Avatar name={s.name} />
        <div>
          <h2>{s.name}</h2>
          <p>Student ID · {s.student_number}</p>
        </div>
        {s.office && (
          <button
            className="button secondary"
            onClick={() => edit("student", s)}
          >
            Edit profile
          </button>
        )}
      </div>
      <div className="school-detail-grid">
        <div className="school-detail-sidebar">
          <Panel title="Student profile">
            <dl className="school-facts">
              <dt>Record status</dt>
              <dd>
                {s.active === undefined
                  ? "Assigned student"
                  : s.active
                    ? "Active"
                    : "Inactive"}
              </dd>
              {s.office && (
                <>
                  <dt>Date of birth</dt>
                  <dd>{dateLabel(s.date_of_birth)}</dd>
                  <dt>Households</dt>
                  <dd>
                    {data.households.length
                      ? data.households.map((household: any) => (
                          <button
                            className="text-link"
                            key={household.id}
                            onClick={() => void open("household", household.id)}
                          >
                            {household.name}
                          </button>
                        ))
                      : "No household linked"}
                  </dd>
                </>
              )}
            </dl>
            {s.office && (
              <button
                className="text-link school-panel-action"
                onClick={() => void history(s.id)}
              >
                View record history
              </button>
            )}
          </Panel>
        </div>
        <div className="school-detail-main">
          <Panel
            title="Enrollment"
            detail="Keep each school year and grade level in the student’s history."
            action={
              s.office && (
                <button
                  className="button secondary small"
                  onClick={() => edit("enrollment", undefined, s.id)}
                >
                  <Plus size={15} />
                  Enroll
                </button>
              )
            }
          >
            {data.enrollments.length ? (
              <div className="school-record-list">
                {data.enrollments.map((enrollment: any, index: number) => (
                  <div key={enrollment.id ?? index}>
                    <span className="school-card-icon">
                      <GraduationCap size={20} />
                    </span>
                    <div>
                      <strong>{enrollment.year_name}</strong>
                      <p>
                        Grade {enrollment.grade_level}
                        {enrollment.starts_on
                          ? ` · ${dateLabel(enrollment.starts_on)}–${dateLabel(enrollment.ends_on)}`
                          : ""}
                      </p>
                    </div>
                    {enrollment.status && <Badge>{enrollment.status}</Badge>}
                    {s.office && (
                      <button
                        className="text-link"
                        onClick={() => edit("enrollment", enrollment, s.id)}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No enrollment yet"
                detail="Enroll this student in a school year before adding them to a class."
              />
            )}
          </Panel>
          <Panel
            title="Student contacts"
            detail={
              s.office
                ? "Guardian, communication and pickup permissions are independent."
                : "Contacts approved for school communication."
            }
            action={
              s.office && (
                <button
                  className="button secondary small"
                  onClick={() => edit("contact", undefined, s.id)}
                >
                  <Plus size={15} />
                  Link contact
                </button>
              )
            }
          >
            <div className="contact-card-list">
              {data.contacts.map((contact: any, index: number) => (
                <div className="contact-card" key={contact.person_id ?? index}>
                  <div className="contact-card-heading">
                    <Avatar name={contact.name} />
                    <div>
                      <strong>{contact.name}</strong>
                      <p>{contact.relationship}</p>
                    </div>
                    {s.office && (
                      <button
                        className="text-link"
                        onClick={() => edit("contact", contact, s.id)}
                      >
                        Permissions
                      </button>
                    )}
                  </div>
                  {contact.email && (
                    <p>
                      <Mail size={15} />
                      {contact.email}
                    </p>
                  )}
                  {contact.phone && (
                    <p>
                      <Phone size={15} />
                      {contact.phone}
                    </p>
                  )}
                  {s.office && (
                    <>
                      <div className="contact-permissions">
                        <Badge>
                          {contact.is_guardian ? "Guardian" : "Contact"}
                        </Badge>
                        <Badge
                          tone={contact.can_communicate ? "green" : "neutral"}
                        >
                          {contact.can_communicate
                            ? "Communication allowed"
                            : "No communication permission"}
                        </Badge>
                        <Badge tone={contact.can_pickup ? "warm" : "neutral"}>
                          {contact.can_pickup
                            ? "Pickup permission recorded"
                            : "No pickup permission"}
                        </Badge>
                      </div>
                      {contact.pickup_until && (
                        <p>
                          Pickup authorization ends{" "}
                          {dateLabel(contact.pickup_until)}.
                        </p>
                      )}
                      {contact.restriction_note && (
                        <div className="school-restriction">
                          <ShieldCheck size={17} />
                          {contact.restriction_note}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            {!data.contacts.length && (
              <Empty
                title="No contacts linked"
                detail={
                  s.office
                    ? "Link an existing contact and record their specific permissions."
                    : "No contacts have been approved for your view."
                }
              />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
function HouseholdRecord({
  data,
  edit,
  open,
  history,
}: {
  data: any;
  edit: (kind: string, initial?: any, target?: string) => void;
  open: (kind: string, id: string) => Promise<void>;
  history: (id: string) => Promise<void>;
}) {
  const h = data.household;
  return (
    <>
      <div className="school-record-heading">
        <span className="school-card-icon">
          <Home size={25} />
        </span>
        <div>
          <h2>{h.name}</h2>
          <p>{h.address || "No address entered"}</p>
        </div>
        <button
          className="button secondary"
          onClick={() => edit("household", h)}
        >
          Edit household
        </button>
      </div>
      <Panel
        title="Household members"
        detail="Household membership does not grant record access, communication or pickup permission."
        action={
          <button
            className="button primary"
            onClick={() => edit("member", undefined, h.id)}
          >
            <Plus size={16} />
            Link person
          </button>
        }
      >
        <div className="school-record-list">
          {data.members.map((member: any) => (
            <div key={member.id}>
              <Avatar name={member.name} />
              <div>
                <strong>{member.name}</strong>
                <p>
                  {member.email || member.phone || "No contact details entered"}
                </p>
              </div>
              <Badge>{member.role}</Badge>
              {member.student_id && (
                <button
                  className="text-link"
                  onClick={() => void open("student", member.student_id)}
                >
                  Student record
                </button>
              )}
              <button
                className="text-link"
                onClick={() => edit("member", member, h.id)}
              >
                Edit membership
              </button>
            </div>
          ))}
        </div>
        {!data.members.length && (
          <Empty
            title="A household ready to connect"
            detail="Add students or contacts to the directory, then link them here."
          />
        )}
        <button
          className="text-link school-panel-action"
          onClick={() => void history(h.id)}
        >
          View household history
        </button>
      </Panel>
    </>
  );
}
function Classroom({
  data,
  edit,
  open,
  history,
}: {
  data: any;
  edit: (kind: string, initial?: any, target?: string) => void;
  open: (kind: string, id: string) => Promise<void>;
  history: (id: string) => Promise<void>;
}) {
  const s = data.section;
  return (
    <>
      <div className="school-record-heading">
        <span className="school-card-icon">
          <BookOpen size={25} />
        </span>
        <div>
          <h2>{s.name}</h2>
          <p>
            {data.teachers.map((teacher: any) => teacher.name).join(" · ") ||
              "No teacher assigned"}{" "}
            · {s.room || "Room not entered"}
          </p>
        </div>
        {s.office && (
          <button
            className="button secondary"
            onClick={() =>
              edit("section", {
                ...s,
                teacherIds: data.teachers.map((t: any) => t.id),
              })
            }
          >
            Edit class
          </button>
        )}
      </div>
      <div className="school-detail-grid">
        <Panel
          title="Class roster"
          detail={`${data.roster.length} records · capacity ${s.capacity}`}
          action={
            s.office && (
              <button
                className="button secondary small"
                onClick={() => edit("roster", undefined, s.id)}
              >
                <Plus size={15} />
                Add student
              </button>
            )
          }
        >
          <div className="school-record-list">
            {data.roster.map((student: any, index: number) => (
              <div key={student.id}>
                <Avatar name={student.name} index={index} />
                <div>
                  <button
                    className="text-link"
                    onClick={() => void open("student", student.id)}
                  >
                    {student.name}
                  </button>
                  <p>
                    Grade {student.grade_level} · {student.student_number}
                  </p>
                  {s.office && (
                    <p>
                      {dateLabel(student.starts_on)}–
                      {dateLabel(student.ends_on)}
                    </p>
                  )}
                </div>
                {s.office && (
                  <button
                    className="text-link"
                    onClick={() => edit("roster", student, s.id)}
                  >
                    Dates
                  </button>
                )}
              </div>
            ))}
          </div>
          {!data.roster.length && (
            <Empty
              title="No students enrolled"
              detail="Students need an enrollment in this school year before joining the class."
            />
          )}
          {s.office && (
            <button
              className="text-link school-panel-action"
              onClick={() => void history(s.id)}
            >
              View class history
            </button>
          )}
        </Panel>
        <Panel
          title="Curriculum & learning plans"
          detail="Keep goals, resources and classroom plans together."
          action={
            <button
              className="button primary small"
              onClick={() => edit("curriculum", undefined, s.id)}
            >
              <Plus size={15} />
              Add unit
            </button>
          }
        >
          <div className="curriculum-list">
            {data.curriculum.map((item: any, index: number) => (
              <article key={item.id}>
                <div>
                  <span className="curriculum-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{item.title}</h3>
                  <button
                    className="text-link"
                    onClick={() => edit("curriculum", item, s.id)}
                  >
                    Edit
                  </button>
                </div>
                <p>{item.content}</p>
              </article>
            ))}
          </div>
          {!data.curriculum.length && (
            <Empty
              title="Make room for learning"
              detail="Add your first curriculum unit or learning plan."
            />
          )}
        </Panel>
      </div>
    </>
  );
}
function SchoolSetup({
  data,
  yearId,
  unitId,
  admin,
  edit,
}: {
  data: SchoolData;
  yearId: string;
  unitId: string;
  admin: boolean;
  edit: (kind: string, initial?: any, target?: string) => void;
}) {
  return (
    <div className="school-setup-grid">
      <Panel
        title="School years"
        detail="Use dates approved by your school. Synthetic example dates are labeled."
        action={
          <button
            className="button secondary small"
            onClick={() => edit("year")}
          >
            <Plus size={15} />
            Add year
          </button>
        }
      >
        <div className="school-record-list">
          {data.years.map((year) => (
            <div key={year.id}>
              <CalendarDays size={22} />
              <div>
                <strong>{year.name}</strong>
                <p>
                  {dateLabel(year.starts_on)}–{dateLabel(year.ends_on)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title="Terms"
        detail="Terms belong to the selected school year."
        action={
          <button
            className="button secondary small"
            disabled={!yearId}
            onClick={() => edit("term")}
          >
            <Plus size={15} />
            Add term
          </button>
        }
      >
        <div className="school-record-list">
          {data.terms.map((term) => (
            <div key={term.id}>
              <div>
                <strong>{term.name}</strong>
                <p>
                  {dateLabel(term.starts_on)}–{dateLabel(term.ends_on)}
                </p>
              </div>
              <Badge>{term.locked_at ? "Locked" : "Open"}</Badge>
            </div>
          ))}
        </div>
        {!data.terms.length && (
          <Empty
            title="No terms configured"
            detail="Enter your school’s term names and dates."
          />
        )}
      </Panel>
      <Panel
        title="Course catalog"
        detail="Courses describe what is taught; classes hold teachers and students."
        action={
          <button
            className="button secondary small"
            onClick={() => edit("course")}
          >
            <Plus size={15} />
            Add course
          </button>
        }
      >
        <div className="school-record-list">
          {data.courses.map((course) => (
            <div key={course.id}>
              <BookOpen size={22} />
              <div>
                <strong>{course.title}</strong>
                <p>
                  {course.code} · {course.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
      {admin && (
        <Panel
          title="School office access"
          detail="Grant access to school records for a specific unit. Teacher access comes from class assignments."
          action={
            <button
              className="button secondary small"
              onClick={() => edit("grant")}
            >
              <Plus size={15} />
              Manage access
            </button>
          }
        >
          <div className="school-record-list">
            {data.grants
              .filter((grant) => grant.unit_id === unitId)
              .map((grant) => (
                <div key={grant.user_id}>
                  <ShieldCheck size={22} />
                  <div>
                    <strong>{grant.name}</strong>
                    <p>{grant.unit_name}</p>
                  </div>
                  <button
                    className="text-link"
                    onClick={() => edit("grant", grant)}
                  >
                    Change
                  </button>
                </div>
              ))}
          </div>
          {!data.grants.some((grant) => grant.unit_id === unitId) && (
            <p className="school-panel-action muted">
              Owners and administrators already have office access. No
              additional grants for this unit.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
function SchoolDialog({
  dialog,
  unitId,
  yearId,
  data,
  onClose,
  onSaved,
}: {
  dialog: any;
  unitId: string;
  yearId: string;
  data: SchoolData;
  onClose: () => void;
  onSaved: (kind: string, result: any) => Promise<void>;
}) {
  const { kind, target } = dialog,
    initial = dialog.data ?? {},
    editing = !!dialog.data;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [chosenYear, setChosenYear] = useState(
      initial.year_id ?? yearId ?? data.years[0]?.id ?? "",
    ),
    [studentSearch, setStudentSearch] = useState(""),
    [studentOptions, setStudentOptions] = useState(data.students);
  const year = data.years.find((value) => value.id === chosenYear),
    titles: Record<string, string> = {
      student: editing ? "Edit student profile" : "Add a student",
      household: editing ? "Edit household" : "Add a household",
      person: editing ? "Edit contact" : "Create a contact",
      year: "Create a school year",
      term: "Add a term",
      course: "Add a course",
      section: editing ? "Edit classroom" : "Create a classroom",
      enrollment: editing ? "Update enrollment" : "Enroll in a school year",
      contact: "Student contact permissions",
      member: editing ? "Edit household membership" : "Link a household member",
      roster: editing ? "Update class dates" : "Add a student to this class",
      curriculum: editing ? "Edit curriculum unit" : "Add a curriculum unit",
      grant: "School office access",
    };
  useEffect(() => {
    if (kind !== "roster" || editing) return;
    let current = true;
    const timeout = setTimeout(() => {
      void api(
        "/school/students?unitId=" +
          unitId +
          "&search=" +
          encodeURIComponent(studentSearch),
      )
        .then((result) => {
          if (current) setStudentOptions(result.rows);
        })
        .catch((e) => setError(e.message));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [kind, editing, unitId, studentSearch]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget),
      text = (key: string) => String(f.get(key) ?? ""),
      number = (key: string) => Number(f.get(key)),
      checked = (key: string) => f.get(key) === "on";
    let path = "",
      body: any = {},
      method = "POST";
    try {
      if (kind === "student") {
        path = "/school/students" + (editing ? "/" + initial.id : "");
        method = editing ? "PATCH" : "POST";
        body = {
          name: text("name"),
          studentNumber: text("studentNumber"),
          dateOfBirth: text("dateOfBirth") || null,
          ...(editing
            ? { active: checked("active"), version: initial.version }
            : { unitId, householdId: text("householdId") || null }),
        };
      }
      if (kind === "household") {
        path = "/school/households" + (editing ? "/" + initial.id : "");
        method = editing ? "PATCH" : "POST";
        body = {
          name: text("name"),
          address: text("address"),
          ...(editing
            ? { archived: checked("archived"), version: initial.version }
            : { unitId }),
        };
      }
      if (kind === "person") {
        path = "/school/people" + (editing ? "/" + initial.id : "");
        method = editing ? "PATCH" : "POST";
        body = {
          name: text("name"),
          email: text("email"),
          phone: text("phone"),
          ...(editing ? { version: initial.version } : { unitId }),
        };
      }
      if (kind === "year") {
        path = "/school/years";
        body = {
          unitId,
          name: text("name"),
          startsOn: text("startsOn"),
          endsOn: text("endsOn"),
        };
      }
      if (kind === "term") {
        path = "/school/terms";
        body = {
          yearId: chosenYear,
          name: text("name"),
          startsOn: text("startsOn"),
          endsOn: text("endsOn"),
        };
      }
      if (kind === "course") {
        path = "/school/courses";
        body = {
          unitId,
          code: text("code"),
          title: text("name"),
          description: text("description"),
        };
      }
      if (kind === "section") {
        path = "/school/sections" + (editing ? "/" + initial.id : "");
        method = editing ? "PATCH" : "POST";
        body = {
          name: text("name"),
          room: text("room"),
          capacity: number("capacity"),
          teacherIds: f.getAll("teacherIds"),
          ...(editing
            ? { version: initial.version }
            : {
                unitId,
                yearId: chosenYear,
                courseId: text("courseId") || null,
                homeroom: checked("homeroom"),
              }),
        };
      }
      if (kind === "enrollment") {
        path = "/school/students/" + target + "/enrollments";
        body = {
          enrollment: {
            yearId: chosenYear,
            gradeLevel: text("gradeLevel"),
            startsOn: text("startsOn"),
            endsOn: text("endsOn"),
            status: text("status"),
          },
          ...(editing ? { version: initial.version } : {}),
        };
      }
      if (kind === "contact") {
        path = "/school/students/" + target + "/contacts";
        body = {
          personId: editing ? initial.person_id : text("personId"),
          relationship: text("relationship"),
          isGuardian: checked("isGuardian"),
          canCommunicate: checked("canCommunicate"),
          canPickup: checked("canPickup"),
          pickupUntil: text("pickupUntil") || null,
          emergencyPriority: text("emergencyPriority")
            ? number("emergencyPriority")
            : null,
          restrictionNote: text("restrictionNote"),
          ...(editing ? { version: initial.version } : {}),
        };
      }
      if (kind === "member") {
        path = "/school/households/" + target + "/members";
        body = {
          personId: editing ? initial.id : text("personId"),
          role: text("role"),
          remove: checked("remove"),
        };
      }
      if (kind === "roster") {
        path = "/school/sections/" + target + "/roster";
        body = {
          studentId: editing ? initial.id : text("studentId"),
          startsOn: text("startsOn"),
          endsOn: text("endsOn"),
          ...(editing ? { version: initial.version } : {}),
        };
      }
      if (kind === "curriculum") {
        path = editing
          ? "/school/curriculum/" + initial.id
          : "/school/sections/" + target + "/curriculum";
        method = editing ? "PATCH" : "POST";
        body = {
          title: text("name"),
          content: text("content"),
          sortOrder: number("sortOrder"),
          ...(editing
            ? { version: initial.version, archived: checked("archived") }
            : {}),
        };
      }
      if (kind === "grant") {
        path = "/school/office-grants";
        body = {
          unitId,
          userId: editing ? initial.user_id : text("userId"),
          enabled: checked("enabled"),
        };
      }
      const result = await api(path, body, method);
      await onSaved(kind, result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectYear = (
    <label>
      School year
      <select
        value={chosenYear}
        disabled={editing && kind === "enrollment"}
        onChange={(e) => setChosenYear(e.target.value)}
        required
      >
        <option value="">Choose a year</option>
        {data.years.map((year) => (
          <option key={year.id} value={year.id}>
            {year.name}
          </option>
        ))}
      </select>
    </label>
  );
  const dates = (
    <div className="community-form-grid" key={chosenYear}>
      <Field
        label="Start date"
        name="startsOn"
        type="date"
        value={day(initial.starts_on) || year?.starts_on || ""}
      />
      <Field
        label="End date"
        name="endsOn"
        type="date"
        value={day(initial.ends_on) || year?.ends_on || ""}
      />
    </div>
  );
  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <form className="community-form" onSubmit={submit}>
        {kind === "student" && (
          <>
            <Field
              label="Student’s full name"
              name="name"
              value={initial.name}
              minLength={2}
              maxLength={120}
            />
            <div className="community-form-grid">
              <Field
                label="Student ID"
                name="studentNumber"
                value={initial.student_number}
                maxLength={40}
              />
              <Field
                label="Date of birth (optional)"
                name="dateOfBirth"
                type="date"
                value={day(initial.date_of_birth)}
                required={false}
              />
            </div>
            {editing ? (
              <Toggle name="active" checked={initial.active}>
                Active student record
              </Toggle>
            ) : (
              <label>
                Household (optional)
                <select name="householdId" defaultValue="">
                  <option value="">Link later</option>
                  {data.households
                    .filter((h) => !h.archived)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <p className="muted">
              After creating the profile, add an enrollment and a class
              assignment.
            </p>
          </>
        )}
        {kind === "household" && (
          <>
            <Field
              label="Household name"
              name="name"
              value={initial.name}
              minLength={2}
            />
            <label>
              Mailing address
              <textarea
                name="address"
                rows={3}
                maxLength={500}
                defaultValue={initial.address ?? ""}
              />
            </label>
            {editing && (
              <Toggle name="archived" checked={initial.archived}>
                Archive this household
              </Toggle>
            )}
          </>
        )}
        {kind === "person" && (
          <>
            <Field
              label="Contact’s full name"
              name="name"
              value={initial.name}
              minLength={2}
            />
            <Field
              label="Email (optional)"
              name="email"
              type="email"
              value={initial.email}
              required={false}
            />
            <Field
              label="Phone (optional)"
              name="phone"
              type="tel"
              value={initial.phone}
              maxLength={40}
              required={false}
            />
            <p className="muted">
              This creates a contact record. Login, communication and pickup
              access are managed separately.
            </p>
          </>
        )}
        {kind === "year" && (
          <>
            <Field
              label="School year name"
              name="name"
              placeholder="Use your school’s year label"
              minLength={2}
            />
            <div className="community-form-grid">
              <Field label="Start date" name="startsOn" type="date" />
              <Field label="End date" name="endsOn" type="date" />
            </div>
          </>
        )}
        {kind === "term" && (
          <>
            {selectYear}
            <Field label="Term name" name="name" minLength={2} />
            {dates}
            <p className="muted">
              Term dates must fit within the selected school year.
            </p>
          </>
        )}
        {kind === "course" && (
          <>
            <Field label="Course code" name="code" maxLength={30} />
            <Field label="Course title" name="name" minLength={2} />
            <label>
              Course description
              <textarea name="description" rows={4} maxLength={2000} />
            </label>
          </>
        )}
        {kind === "section" && (
          <>
            <Field
              label="Class name"
              name="name"
              value={initial.name}
              minLength={2}
            />
            {!editing && (
              <>
                {selectYear}
                <label>
                  Course (optional)
                  <select name="courseId" defaultValue="">
                    <option value="">No linked course</option>
                    {data.courses
                      .filter((c) => !c.archived)
                      .map((course) => (
                        <option key={course.id} value={course.id}>
                          {course.title} · {course.code}
                        </option>
                      ))}
                  </select>
                </label>
                <Toggle name="homeroom" checked={false}>
                  This is a homeroom class
                </Toggle>
              </>
            )}
            <div className="community-form-grid">
              <Field
                label="Room (optional)"
                name="room"
                value={initial.room}
                required={false}
                maxLength={100}
              />
              <Field
                label="Class capacity"
                name="capacity"
                type="number"
                value={initial.capacity}
                min={1}
                max={200}
              />
            </div>
            <fieldset className="recipient-picker">
              <legend>Assigned teachers</legend>
              <div className="recipient-options">
                {data.staff.map((teacher) => (
                  <label key={teacher.id}>
                    <input
                      type="checkbox"
                      name="teacherIds"
                      value={teacher.id}
                      defaultChecked={(initial.teacherIds ?? []).includes(
                        teacher.id,
                      )}
                    />
                    {teacher.name}
                  </label>
                ))}
              </div>
              <p className="muted">
                Only active staff assigned to this unit can teach this class.
              </p>
            </fieldset>
          </>
        )}
        {kind === "enrollment" && (
          <>
            {selectYear}
            <Field
              label="Grade level"
              name="gradeLevel"
              value={initial.grade_level}
              maxLength={30}
              placeholder="Use your school’s grade label"
            />
            {dates}
            <label>
              Enrollment status
              <select name="status" defaultValue={initial.status ?? "enrolled"}>
                <option value="enrolled">Enrolled</option>
                <option value="withdrawn">Withdrawn</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            <p className="muted">
              For a withdrawal, set the end date to the student’s last enrolled
              day. Historical records are retained.
            </p>
          </>
        )}
        {kind === "contact" && (
          <>
            {editing ? (
              <p>
                <strong>{initial.name}</strong>
              </p>
            ) : (
              <label>
                Contact person
                <select name="personId" required defaultValue="">
                  <option value="">Choose an existing contact</option>
                  {data.people
                    .filter((p) => !p.student_id)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                </select>
                <small>Add new contacts in Families & contacts first.</small>
              </label>
            )}
            <Field
              label="Relationship to student"
              name="relationship"
              value={initial.relationship}
              minLength={2}
              maxLength={80}
            />
            <div className="school-permission-choices">
              <Toggle name="isGuardian" checked={initial.is_guardian}>
                Recorded legal guardian
              </Toggle>
              <Toggle name="canCommunicate" checked={initial.can_communicate}>
                May receive school communications
              </Toggle>
              <Toggle name="canPickup" checked={initial.can_pickup}>
                Pickup authorization is documented
              </Toggle>
            </div>
            <div className="community-form-grid">
              <Field
                label="Pickup authorization ends (optional)"
                name="pickupUntil"
                type="date"
                value={day(initial.pickup_until)}
                required={false}
              />
              <Field
                label="Emergency contact priority (optional)"
                name="emergencyPriority"
                type="number"
                value={initial.emergency_priority}
                min={1}
                max={20}
                required={false}
              />
            </div>
            <label>
              Office-only restrictions and notes
              <textarea
                name="restrictionNote"
                rows={4}
                maxLength={2000}
                defaultValue={initial.restriction_note ?? ""}
              />
            </label>
            <p className="muted">
              Record only permissions confirmed by the school. Linking a person
              does not prove identity or authorize a release.
            </p>
          </>
        )}
        {kind === "member" && (
          <>
            {editing ? (
              <p>
                <strong>{initial.name}</strong>
              </p>
            ) : (
              <label>
                Person
                <select name="personId" required defaultValue="">
                  <option value="">Choose a student or contact</option>
                  {data.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.student_id ? " · Student" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Household role
              <select name="role" defaultValue={initial.role ?? "other"}>
                <option value="student">Student</option>
                <option value="guardian">Guardian</option>
                <option value="other">Other household member</option>
              </select>
            </label>
            {editing && (
              <Toggle name="remove" checked={false}>
                Remove this household membership
              </Toggle>
            )}
            <p className="muted">
              This changes household organization. Student communication and
              pickup permissions remain on the student contact record.
            </p>
          </>
        )}
        {kind === "roster" && (
          <>
            {editing ? (
              <p>
                <strong>{initial.name}</strong>
              </p>
            ) : (
              <>
                <label>
                  Find an enrolled student
                  <input
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                    placeholder="Search name or student ID…"
                  />
                </label>
                <label>
                  Student
                  <select name="studentId" required defaultValue="">
                    <option value="">Choose a student</option>
                    {studentOptions
                      .filter((s) => s.active)
                      .map((student) => (
                        <option key={student.id} value={student.id}>
                          {student.name} · {student.student_number}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            {dates}
            <p className="muted">
              Dates must fit the student’s enrollment in this class’s school
              year. Students can have one homeroom at a time.
            </p>
          </>
        )}
        {kind === "curriculum" && (
          <>
            <Field
              label="Unit title"
              name="name"
              value={initial.title}
              minLength={2}
            />
            <label>
              Learning plan
              <textarea
                name="content"
                rows={10}
                maxLength={20000}
                defaultValue={initial.content ?? ""}
                placeholder="Goals, resources, activities and assessments…"
                required
              />
            </label>
            <Field
              label="Display order"
              name="sortOrder"
              type="number"
              value={initial.sort_order ?? 0}
              min={0}
              max={10000}
            />
            {editing && (
              <Toggle name="archived" checked={initial.archived}>
                Archive this curriculum unit
              </Toggle>
            )}
          </>
        )}
        {kind === "grant" && (
          <>
            {editing ? (
              <p>
                <strong>{initial.name}</strong>
              </p>
            ) : (
              <label>
                Staff member
                <select name="userId" required defaultValue="">
                  <option value="">Choose a staff member</option>
                  {data.staff.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Toggle name="enabled" checked={editing}>
              School office access enabled for this unit
            </Toggle>
            <p className="muted">
              Office access includes student and household records, contact
              permissions, classes and enrollment. Teacher access should
              normally come from class assignments.
            </p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy
              ? "Saving…"
              : kind === "contact"
                ? "Save permissions"
                : "Save record"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Field({
  label,
  name,
  value = "",
  type = "text",
  required = true,
  ...props
}: {
  label: string;
  name: string;
  value?: any;
  type?: string;
  required?: boolean;
  [key: string]: any;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={value ?? ""}
        required={required}
        {...props}
      />
    </label>
  );
}
function Toggle({
  name,
  checked,
  children,
}: {
  name: string;
  checked: boolean;
  children: ReactNode;
}) {
  return (
    <label className="school-toggle">
      <input name={name} type="checkbox" defaultChecked={!!checked} />
      <span>{children}</span>
    </label>
  );
}

function HistoryChanges({ snapshot, staff }: { snapshot: any; staff: any[] }) {
  const labels: Record<string, string> = {
    name: "Name",
    student_number: "Student ID",
    studentNumber: "Student ID",
    date_of_birth: "Date of birth",
    dateOfBirth: "Date of birth",
    email: "Email",
    phone: "Phone",
    address: "Address",
    grade_level: "Grade level",
    starts_on: "Start date",
    ends_on: "End date",
    status: "Status",
    active: "Active",
    archived: "Archived",
    title: "Title",
    content: "Learning plan",
    room: "Room",
    capacity: "Capacity",
    homeroom: "Homeroom",
    relationship: "Relationship",
    is_guardian: "Guardian",
    can_communicate: "Communication permitted",
    can_pickup: "Pickup permission recorded",
    pickup_until: "Pickup authorization ends",
    emergency_priority: "Emergency priority",
    restriction_note: "Office-only note",
    role: "Household role",
    remove: "Membership removed",
    teacherIds: "Assigned teachers",
  };
  const before = snapshot.before ?? {},
    after = snapshot.after ?? {};
  const format = (value: any, key: string) =>
    value === undefined || value === null || value === ""
      ? "Not entered"
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : key === "teacherIds"
          ? (value as string[])
              .map(
                (id) =>
                  staff.find((person) => person.id === id)?.name ??
                  "Previously assigned staff",
              )
              .join(", ")
          : String(value);
  const keys = Object.keys(labels).filter(
    (key) =>
      (key in before || key in after) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return (
    <dl className="history-changes">
      {keys.map((key) => (
        <div key={key}>
          <dt>{labels[key]}</dt>
          <dd>
            {before[key] !== undefined && (
              <span>{format(before[key], key)} → </span>
            )}
            {format(after[key], key)}
          </dd>
        </div>
      ))}
      {!keys.length && <p>Relationship or record configuration updated.</p>}
    </dl>
  );
}
