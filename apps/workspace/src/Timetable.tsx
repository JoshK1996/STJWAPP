import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { DateTime } from "luxon";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  MapPin,
  Users,
  Download,
  Printer,
  CheckCircle2,
  AlertTriangle,
  History,
} from "lucide-react";
import { api, ApiError, download, downloadPost } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import { timetableExportLimits, type TimetableCalendarExportInput } from "../shared/timetable-export";
import "./timetable.css";
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const clock = (value: string) =>
  DateTime.fromFormat(value, "HH:mm").toFormat("h:mm a");
const dates = (value: string) =>
  DateTime.fromISO(value, { zone: "UTC" }).toFormat("LLL d, yyyy");
type CalendarReview = {
  query: string;
  input: TimetableCalendarExportInput;
  timezone: string;
  revisedAt: string;
  count: number;
  classLabel: string;
  teacherLabel: string;
  yearLabel: string;
};
const accessDenied = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
export default function Timetable({
  unitId,
  yearId,
  years,
  sections,
  staff,
  office,
  notify,
  onDirty,
}: {
  unitId: string;
  yearId: string;
  years: any[];
  sections: any[];
  staff: any[];
  office: boolean;
  notify: (text: string, error?: boolean) => void;
  onDirty: (value: boolean) => void;
}) {
  const year = years.find((x) => x.id === yearId);
  const today = DateTime.now().toISODate()!;
  const first =
    year && today < year.starts_on.slice(0, 10)
      ? year.starts_on.slice(0, 10)
      : year && today > year.ends_on.slice(0, 10)
        ? year.ends_on.slice(0, 10)
        : today;
  const [anchor, setAnchor] = useState(first),
    [sectionId, setSectionId] = useState(""),
    [teacherId, setTeacherId] = useState(""),
    [studentNumber, setStudentNumber] = useState(""),
    [studentSearch, setStudentSearch] = useState("");
  const [view, setView] = useState<any>(null),
    [meetings, setMeetings] = useState<any[]>([]),
    [rooms, setRooms] = useState<any[]>([]),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [editor, setEditor] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [roomName, setRoomName] = useState<string | null>(null),
    [cancel, setCancel] = useState<any>(null),
    [history, setHistory] = useState<any>(null);
  const [loadedCalendar, setLoadedCalendar] = useState<CalendarReview | null>(null),
    [calendarReview, setCalendarReview] = useState<CalendarReview | null>(null),
    [calendarBusy, setCalendarBusy] = useState(false),
    [calendarStale, setCalendarStale] = useState(false),
    [calendarError, setCalendarError] = useState("");
  const calendarBusyRef = useRef(false);
  const start = DateTime.fromISO(anchor, { zone: "UTC" }).startOf("week"),
    from = start.toISODate()!,
    to = start.plus({ days: 6 }).toISODate()!;
  const query = new URLSearchParams({
    unitId,
    yearId,
    from,
    to,
    ...(sectionId ? { sectionId } : {}),
    ...(teacherId ? { teacherId } : {}),
    ...(studentNumber ? { studentNumber } : {}),
  }).toString();
  const loadVersion = useRef(0);
  const clearPrivateTimetable = useCallback(() => {
    setView(null);
    setLoadedCalendar(null);
    setCalendarReview(null);
    setMeetings([]);
    setRooms([]);
    setEditor(null);
    setPreview(null);
    setCancel(null);
    setHistory(null);
    setRoomName(null);
  }, []);
  const load = useCallback(async () => {
    if (!yearId) return;
    const requestVersion = ++loadVersion.current;
    setLoading(true);
    try {
      const [data, roomData, patterns] = await Promise.all([
        api("/school/timetable?" + query),
        api("/school/timetable/rooms?unitId=" + unitId),
        office
          ? api(
              "/school/timetable/meetings?" +
                new URLSearchParams({ unitId, yearId }),
            )
          : Promise.resolve({ rows: [] }),
      ]);
      if (requestVersion === loadVersion.current) {
        setView(data);
        setRooms(roomData.rows);
        setMeetings(patterns.rows);
        const filters = Object.fromEntries(new URLSearchParams(query)) as Omit<TimetableCalendarExportInput, "expectedRevision">;
        const calendar: CalendarReview | null =
          Number.isInteger(data.revision) && data.revision >= 0 &&
          DateTime.fromISO(data.calendarRevisedAt ?? "").isValid
            ? {
                query,
                input: { ...filters, expectedRevision: data.revision },
                timezone: data.timezone,
                revisedAt: data.calendarRevisedAt,
                count: data.rows.length,
                classLabel: "",
                teacherLabel: "",
                yearLabel: "",
              }
            : null;
        setLoadedCalendar(calendar);
        return { calendar, data };
      }
    } catch (e) {
      if (requestVersion === loadVersion.current) {
        setView(null);
        setLoadedCalendar(null);
        if (accessDenied(e)) clearPrivateTimetable();
        notify((e as Error).message, true);
      }
    } finally {
      if (requestVersion === loadVersion.current) setLoading(false);
    }
  }, [query, unitId, yearId, office, notify, clearPrivateTimetable]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);
  useEffect(() => {
    setCalendarReview(null);
    setCalendarStale(false);
    setCalendarError("");
  }, [query, office]);
  useEffect(() => {
    onDirty(!!editor || !!cancel || roomName !== null);
    return () => onDirty(false);
  }, [editor, cancel, roomName, onDirty]);
  function change(patch: any) {
    setEditor((old: any) => ({ ...old, ...patch }));
    setPreview(null);
  }
  function edit(row?: any) {
    setPreview(null);
    setEditor(
      row
        ? {
            id: row.id,
            version: row.version,
            sectionId: row.section_id,
            roomId: row.room_id,
            startsOn: row.starts_on,
            endsOn: row.ends_on,
            weekdays: row.weekdays,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            reason: "",
          }
        : {
            version: 0,
            sectionId: sectionId || "",
            roomId: null,
            startsOn: year?.starts_on.slice(0, 10) ?? "",
            endsOn: year?.ends_on.slice(0, 10) ?? "",
            weekdays: [],
            startsAt: "",
            endsAt: "",
            reason: "",
          },
    );
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      setPreview(await api("/school/timetable/preview", editor));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api("/school/timetable/save", {
        meeting: editor,
        revision: preview.revision,
        reviewed: true,
        commandId: crypto.randomUUID(),
      });
      setEditor(null);
      setPreview(null);
      await load();
      notify(
        "Timetable saved. Teacher, student, room, and class conflicts were checked.",
      );
    } catch (e) {
      setPreview(null);
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function openHistory(row: any) {
    setBusy(true);
    try {
      const data = await api(`/school/timetable/${row.id}/history`);
      setHistory({ ...row, rows: data.rows });
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const calendarUnavailable = !view || loading || loadedCalendar?.query !== query
    ? "Load the selected timetable before downloading its calendar."
    : view.issues.length
      ? "Resolve the timetable issues before downloading its calendar."
      : !view.rows.length
        ? "There are no scheduled class meetings to download for these filters."
        : view.rows.length > timetableExportLimits.occurrences
          ? "Choose a class or shorter date range to download at most 2,000 meetings."
          : "";
  function labelCalendar(calendar: CalendarReview, data = view): CalendarReview {
    return {
      ...calendar,
      yearLabel: year?.name ?? "Selected school year",
      classLabel: calendar.input.sectionId
        ? data?.rows.find((row: any) => row.sectionId === calendar.input.sectionId)?.title ??
          sections.find((row) => row.id === calendar.input.sectionId)?.name ?? "Selected class"
        : "All permitted classes",
      teacherLabel: calendar.input.teacherId
        ? staff.find((row) => row.id === calendar.input.teacherId)?.name ?? "Selected teacher"
        : "All teachers in these classes",
    };
  }
  function openCalendar() {
    if (calendarUnavailable || !loadedCalendar || calendarBusyRef.current) return;
    setCalendarError("");
    setCalendarStale(false);
    setCalendarReview(labelCalendar(loadedCalendar));
  }
  async function refreshCalendar() {
    if (calendarBusyRef.current) return;
    calendarBusyRef.current = true;
    setCalendarBusy(true);
    setCalendarError("");
    try {
      const fresh = await load();
      if (!fresh?.calendar) {
        setCalendarError("The timetable could not be refreshed. Close this review and reload the selected week before downloading.");
        return;
      }
      if (fresh.data.issues.length || !fresh.data.rows.length || fresh.data.rows.length > timetableExportLimits.occurrences) {
        setCalendarReview(null);
        setCalendarError("The refreshed timetable is not available for calendar download. Review its filters and any scheduling issues.");
        return;
      }
      setCalendarReview(labelCalendar(fresh.calendar, fresh.data));
      setCalendarStale(false);
    } finally {
      calendarBusyRef.current = false;
      setCalendarBusy(false);
    }
  }
  async function saveCalendar() {
    if (!calendarReview || calendarStale || calendarBusyRef.current) return;
    calendarBusyRef.current = true;
    setCalendarBusy(true);
    setCalendarError("");
    const selected = calendarReview;
    try {
      await downloadPost("/school/timetable/export", selected.input,
        `stjw-timetable-${selected.input.from}-to-${selected.input.to}.ics`);
      setCalendarReview(null);
      notify("Timetable calendar downloaded. Later schedule changes do not update this copy.");
    } catch (error) {
      if (accessDenied(error)) {
        // Clear both the reviewed copy and underlying private source. ApiError
        // retains status even when an upstream denial contains HTML, not JSON.
        loadVersion.current++;
        clearPrivateTimetable();
        setCalendarError("Your access or session changed. The timetable review has been cleared. Refresh to check your current access.");
      } else {
        if (error instanceof ApiError && error.status === 409) setCalendarStale(true);
        setCalendarError((error as Error).message);
      }
    } finally {
      calendarBusyRef.current = false;
      setCalendarBusy(false);
    }
  }
  if (!yearId)
    return (
      <Empty
        title="Choose a school year"
        detail="Select a school year to plan classes and see the weekly timetable."
      />
    );
  return (
    <div className="timetable-module">
      <div className="timetable-intro">
        <div className="timetable-symbol" aria-hidden="true">
          <CalendarDays size={30} />
        </div>
        <div>
          <h2>A clear view of the school week</h2>
          <p>
            Class times follow your instructional calendar. Conflicts must be
            corrected before a change can be saved.
          </p>
        </div>
        <Badge tone="outline">
          {office ? "School timetable" : "My teaching timetable"}
        </Badge>
      </div>
      <div className="timetable-controls no-timetable-print">
        <div className="timetable-navigation">
          <button
            className="icon-button"
            aria-label="Previous timetable week"
            disabled={loading}
            onClick={() => setAnchor(start.minus({ weeks: 1 }).toISODate()!)}
          >
            <ChevronLeft size={19} />
          </button>
          <label>
            Week containing
            <input
              aria-label="Timetable date"
              type="date"
              value={anchor}
              onChange={(e) => {
                if (e.target.value) setAnchor(e.target.value);
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="Next timetable week"
            disabled={loading}
            onClick={() => setAnchor(start.plus({ weeks: 1 }).toISODate()!)}
          >
            <ChevronRight size={19} />
          </button>
        </div>
        <div className="timetable-actions">
          {office && (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setRoomName("")}
              >
                <Plus size={16} />
                Add room
              </button>
              <button
                className="button primary"
                disabled={busy || !sections.length}
                onClick={() => edit()}
              >
                <Plus size={16} />
                Schedule class
              </button>
            </>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={!!calendarUnavailable || calendarBusy}
            aria-describedby={calendarUnavailable && !loading ? "timetable-calendar-unavailable" : undefined}
            onClick={openCalendar}
          >
            <CalendarDays size={16} />
            Download timetable (.ics)
          </button>
          <button
            className="button secondary"
            disabled={!view || loading}
            onClick={() =>
              download(
                "/school/timetable?" + query + "&format=csv",
                "class-timetable.csv",
              ).catch((e) => notify(e.message, true))
            }
          >
            <Download size={16} />
            CSV
          </button>
          <button
            className="button secondary"
            disabled={!view || loading}
            onClick={() => window.print()}
          >
            <Printer size={16} />
            Print week
          </button>
        </div>
      </div>
      {calendarUnavailable && !loading && (
        <p id="timetable-calendar-unavailable" className="timetable-explainer no-timetable-print">
          {calendarUnavailable}
        </p>
      )}
      {calendarError && !calendarReview && (
        <div className="timetable-calendar-message no-timetable-print" role="alert">
          <p>{calendarError}</p>
          <button type="button" className="button secondary" disabled={loading || calendarBusy}
            onClick={async () => { if (await load()) setCalendarError(""); }}>
            {loading ? "Refreshing…" : "Refresh timetable"}
          </button>
        </div>
      )}
      <form
        className="timetable-filters no-timetable-print"
        onSubmit={(e) => {
          e.preventDefault();
          setStudentNumber(studentSearch.trim());
        }}
      >
        <label>
          Class
          <select
            aria-label="Timetable class filter"
            value={sectionId}
            onChange={(e) => setSectionId(e.target.value)}
          >
            <option value="">All my classes</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {office && (
          <>
            <label>
              Teacher
              <select
                aria-label="Timetable teacher filter"
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
              >
                <option value="">All teachers</option>
                {staff.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Student number
              <input
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Exact student number"
                maxLength={40}
              />
            </label>
            <button className="button secondary" type="submit">
              Find schedule
            </button>
            {studentNumber && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setStudentNumber("");
                  setStudentSearch("");
                }}
              >
                Clear student
              </button>
            )}
          </>
        )}
      </form>
      <div className="timetable-print-heading">
        <h3>
          {dates(from)} – {dates(to)}
        </h3>
        <p>
          {year?.name} · {view?.timezone ?? "Loading timezone…"}
          {studentNumber ? " · Student " + studentNumber : ""}
        </p>
      </div>
      {loading ? (
        <p role="status">Loading timetable…</p>
      ) : view ? (
        <>
          {view.issues.length > 0 && (
            <div className="timetable-warning" role="alert">
              {view.issues.map((x: string, i: number) => (
                <p key={i}>{x}</p>
              ))}
            </div>
          )}
          <div className="timetable-week" aria-label="Weekly class timetable">
            {weekdays.map((day, index) => {
              const date = start.plus({ days: index }).toISODate()!,
                rows = view.rows.filter((x: any) => x.day === date);
              return (
                <section className="timetable-day" key={day}>
                  <header>
                    <span>{day.slice(0, 3)}</span>
                    <strong>{DateTime.fromISO(date).toFormat("d")}</strong>
                    <small>
                      {rows.length} {rows.length === 1 ? "class" : "classes"}
                    </small>
                  </header>
                  <div>
                    {rows.length ? (
                      rows.map((row: any) => (
                        <article
                          className="timetable-meeting"
                          key={row.meetingId}
                        >
                          <span className="timetable-time">
                            {clock(row.startsAt)} – {clock(row.endsAt)}
                          </span>
                          <h4>{row.title}</h4>
                          <p>
                            <MapPin size={14} />
                            {row.room ?? "Room unassigned"}
                          </p>
                          <p>
                            <Users size={14} />
                            {row.teachers.map((t: any) => t.name).join(", ") ||
                              "Teacher unassigned"}
                          </p>
                          {office && (
                            <button
                              className="text-link no-timetable-print"
                              onClick={() => {
                                const m = meetings.find(
                                  (x) => x.id === row.meetingId,
                                );
                                if (m) edit(m);
                              }}
                            >
                              Edit meeting
                            </button>
                          )}
                        </article>
                      ))
                    ) : (
                      <p className="timetable-none">No classes scheduled</p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <Empty
          title="Timetable unavailable"
          detail="Review the selected filters or refresh to try again."
        />
      )}
      <p className="timetable-explainer">
        Dated class places reserve students until their roster dates are
        changed, including withdrawn or inactive profiles. Shared teaching
        assignments reserve every assigned teacher. Only a selected timetable
        room reserves a room.
      </p>
      {office && (
        <details className="timetable-patterns no-timetable-print">
          <summary>
            Manage recurring meetings ·{" "}
            {meetings.filter((x) => !x.canceled).length} active
          </summary>
          <Panel
            title="Meeting patterns"
            detail="Edits change the current plan. Earlier versions and cancellation reasons remain in history."
          >
            {meetings.length ? (
              <div className="timetable-pattern-list">
                {meetings.map((m) => (
                  <article key={m.id}>
                    <div>
                      <strong>{m.section_name}</strong>
                      <p>
                        {m.weekdays
                          .map((x: number) => weekdays[x - 1].slice(0, 3))
                          .join(", ")}{" "}
                        · {clock(m.starts_at)}–{clock(m.ends_at)}
                      </p>
                      <small>
                        {dates(m.starts_on)}–{dates(m.ends_on)} ·{" "}
                        {m.room_name ?? "Room unassigned"} · Version {m.version}
                      </small>
                      {m.canceled && <Badge tone="outline">Canceled</Badge>}
                    </div>
                    <div className="timetable-actions">
                      {!m.canceled && (
                        <>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => edit(m)}
                          >
                            Edit
                          </button>
                          <button
                            className="text-link"
                            disabled={busy}
                            onClick={() => setCancel({ ...m, reason: "" })}
                          >
                            Cancel pattern
                          </button>
                        </>
                      )}
                      <button
                        className="icon-button"
                        aria-label={"History for " + m.section_name}
                        disabled={busy}
                        onClick={() => openHistory(m)}
                      >
                        <History size={18} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                title="No meeting patterns yet"
                detail="Confirm the instructional calendar in Attendance, then schedule a class."
              />
            )}
          </Panel>
        </details>
      )}
      {calendarReview && (
        <Modal title="Download timetable calendar" onClose={() => {
          if (!calendarBusyRef.current) { setCalendarReview(null); setCalendarError(""); }
        }}>
          <div className="timetable-calendar-review no-timetable-print" aria-busy={calendarBusy}>
            <p>This private calendar file contains the scheduled class meetings in the loaded timetable.</p>
            <dl className="timetable-calendar-summary">
              <div><dt>School year</dt><dd>{calendarReview.yearLabel}</dd></div>
              <div><dt>Dates, inclusive</dt><dd>{dates(calendarReview.input.from)} – {dates(calendarReview.input.to)}</dd></div>
              <div><dt>School timezone</dt><dd>{calendarReview.timezone}</dd></div>
              <div><dt>Class filter</dt><dd>{calendarReview.classLabel}</dd></div>
              <div><dt>Teacher filter</dt><dd>{calendarReview.teacherLabel}</dd></div>
              <div><dt>Applied student filter</dt><dd>{calendarReview.input.studentNumber || "No student filter"}</dd></div>
              <div><dt>Scheduled meetings</dt><dd>{calendarReview.count}</dd></div>
              <div><dt>Timetable revision</dt><dd>{calendarReview.input.expectedRevision}</dd></div>
            </dl>
            <p className="timetable-calendar-provenance">Calendar representation recorded {DateTime.fromISO(calendarReview.revisedAt).setZone(calendarReview.timezone).toFormat("LLL d, yyyy · h:mm:ss a ZZZZ")}.</p>
            <p>Configured instructional days and holidays are applied. The file includes class titles, rooms and times. Student identities and teacher contact details are excluded.</p>
            <p>Later changes and cancellations do not update this downloaded copy. This does not connect to Google or send invitations.</p>
            {calendarError && <div className="timetable-calendar-message" role="alert"><p>{calendarError}</p></div>}
            {calendarStale && <p role="status">Refresh this review to see the current timetable, then choose Download calendar file again.</p>}
            {calendarBusy && <p role="status">{calendarStale ? "Refreshing the timetable…" : "Preparing your calendar file…"}</p>}
            <div className="timetable-calendar-actions">
              <button type="button" className="button secondary" disabled={calendarBusy}
                onClick={() => { setCalendarReview(null); setCalendarError(""); }}>Close</button>
              {calendarStale ? (
                <button type="button" className="button primary" disabled={calendarBusy} onClick={() => void refreshCalendar()}>Refresh timetable review</button>
              ) : (
                <button type="button" className="button primary" disabled={calendarBusy} onClick={() => void saveCalendar()}>
                  <Download size={16} /> Download calendar file
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {editor && (
        <Modal
          title={editor.id ? "Edit class meeting" : "Schedule a class"}
          onClose={() => {
            if (!busy) {
              setEditor(null);
              setPreview(null);
            }
          }}
        >
          <form className="timetable-editor" onSubmit={review}>
            <div className="timetable-field-grid">
              <label>
                Class
                <select
                  aria-label="Meeting class"
                  required
                  value={editor.sectionId}
                  disabled={!!editor.id || busy}
                  onChange={(e) => change({ sectionId: e.target.value })}
                >
                  <option value="">Choose a class</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Room
                <select
                  aria-label="Meeting room"
                  value={editor.roomId ?? ""}
                  disabled={busy}
                  onChange={(e) => change({ roomId: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                First possible date
                <input
                  aria-label="Meeting start date"
                  type="date"
                  required
                  value={editor.startsOn}
                  disabled={busy}
                  onChange={(e) => change({ startsOn: e.target.value })}
                />
              </label>
              <label>
                Last possible date
                <input
                  aria-label="Meeting end date"
                  type="date"
                  required
                  value={editor.endsOn}
                  disabled={busy}
                  onChange={(e) => change({ endsOn: e.target.value })}
                />
              </label>
              <label>
                Start time
                <input
                  aria-label="Meeting start time"
                  type="time"
                  required
                  value={editor.startsAt}
                  disabled={busy}
                  onChange={(e) => change({ startsAt: e.target.value })}
                />
              </label>
              <label>
                End time
                <input
                  aria-label="Meeting end time"
                  type="time"
                  required
                  value={editor.endsAt}
                  disabled={busy}
                  onChange={(e) => change({ endsAt: e.target.value })}
                />
              </label>
            </div>
            <fieldset className="timetable-weekdays">
              <legend>Repeat on</legend>
              {weekdays.map((day, i) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={editor.weekdays.includes(i + 1)}
                    disabled={busy}
                    onChange={(e) =>
                      change({
                        weekdays: e.target.checked
                          ? [...editor.weekdays, i + 1].sort()
                          : editor.weekdays.filter((x: number) => x !== i + 1),
                      })
                    }
                  />
                  {day.slice(0, 3)}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              Times use {view?.timezone ?? "the organization timezone"}.
              Holidays are skipped. School-calendar overrides can add
              instructional days.
            </p>
            <label>
              Reason for this plan or change
              <textarea
                aria-label="Meeting change reason"
                minLength={5}
                maxLength={1000}
                required
                value={editor.reason}
                disabled={busy}
                onChange={(e) => change({ reason: e.target.value })}
              />
            </label>
            <button
              className="button secondary"
              disabled={busy || !editor.weekdays.length}
              type="submit"
            >
              {busy ? "Checking…" : "Preview meeting dates & conflicts"}
            </button>
            {preview && (
              <section
                className={
                  "timetable-preview " +
                  (preview.issues.length ? "has-conflicts" : "")
                }
                aria-label="Timetable preview"
                aria-live="polite"
              >
                <h3>
                  {preview.issues.length ? (
                    <>
                      <AlertTriangle size={19} />
                      Changes blocked
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={19} />
                      No scheduling conflicts
                    </>
                  )}
                </h3>
                <p>
                  {preview.count} instructional meeting dates
                  {preview.first
                    ? " · " + dates(preview.first) + " – " + dates(preview.last)
                    : ""}
                </p>
                {preview.issues.map((issue: any, i: number) => (
                  <div className="timetable-conflict" key={i}>
                    <strong>{issue.message}</strong>
                    <p>{issue.classes.join(" / ")}</p>
                  </div>
                ))}
                {!preview.teacherCount && (
                  <p>
                    No teacher is assigned to this class. Assign teaching staff
                    in Classrooms before using this plan.
                  </p>
                )}
                {!editor.roomId && <p>No room is reserved for this meeting.</p>}
                {!preview.issues.length && (
                  <button
                    className="button primary"
                    disabled={busy}
                    type="button"
                    onClick={save}
                  >
                    Confirm & save timetable
                  </button>
                )}
              </section>
            )}
          </form>
        </Modal>
      )}
      {roomName !== null && (
        <Modal
          title="Add a timetable room"
          onClose={() => {
            if (!busy) setRoomName(null);
          }}
        >
          <form
            className="timetable-editor"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("/school/timetable/rooms", {
                  unitId,
                  name: roomName,
                });
                setRoomName(null);
                await load();
                notify("Room added to this unit.");
              } catch (error) {
                notify((error as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              Use a unique name for the physical room. Select this room on
              meetings to prevent double booking.
            </p>
            <label>
              Room name
              <input
                required
                minLength={2}
                maxLength={100}
                value={roomName}
                disabled={busy}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Add room
            </button>
          </form>
        </Modal>
      )}
      {cancel && (
        <Modal
          title="Cancel this meeting pattern"
          onClose={() => {
            if (!busy) setCancel(null);
          }}
        >
          <form
            className="timetable-editor"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(`/school/timetable/${cancel.id}/cancel`, {
                  version: cancel.version,
                  reason: cancel.reason,
                  commandId: crypto.randomUUID(),
                });
                setCancel(null);
                await load();
                notify(
                  "Meeting canceled. Its previous plan remains in history.",
                );
              } catch (error) {
                notify((error as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              {cancel.section_name} · All dates in this recurring pattern will
              leave the current timetable. Attendance already recorded is
              retained.
            </p>
            <label>
              Cancellation reason
              <textarea
                required
                minLength={5}
                maxLength={1000}
                value={cancel.reason}
                disabled={busy}
                onChange={(e) =>
                  setCancel({ ...cancel, reason: e.target.value })
                }
              />
            </label>
            <button className="button primary" disabled={busy}>
              Confirm cancellation
            </button>
          </form>
        </Modal>
      )}
      {history && (
        <Modal
          title={"Timetable history · " + history.section_name}
          onClose={() => setHistory(null)}
        >
          <div className="timetable-history">
            {history.rows.map((row: any) => {
              const after = row.snapshot.after;
              return (
                <article key={row.id}>
                  <strong>
                    Version {after.version} ·{" "}
                    {after.starts_at ? "Meeting saved" : "Meeting canceled"}
                  </strong>
                  <p>
                    {row.actor_name} ·{" "}
                    {new Date(row.created_at).toLocaleString()}
                  </p>
                  {after.starts_at && (
                    <p>
                      {dates(after.starts_on)} – {dates(after.ends_on)} ·{" "}
                      {after.weekdays
                        .map((x: number) => weekdays[x - 1].slice(0, 3))
                        .join(", ")}{" "}
                      · {clock(after.starts_at)}–{clock(after.ends_at)}
                    </p>
                  )}
                  <p>{after.reason}</p>
                </article>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
