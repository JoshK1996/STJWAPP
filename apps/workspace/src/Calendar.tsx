import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  MapPin,
  Plus,
  Repeat2,
  Users,
} from "lucide-react";
import { api, download } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
type Props = { me: any; notify: (text: string, error?: boolean) => void };
export default function Calendar({ me, notify }: Props) {
  const zone = me.organization.timezone,
    today = DateTime.now().setZone(zone);
  const [month, setMonth] = useState(today.startOf("month").toISODate()!),
    [selected, setSelected] = useState(today.toISODate()!),
    [rows, setRows] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [scope, setScope] = useState("all"),
    [editor, setEditor] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [history, setHistory] = useState<any[] | null>(null),
    [exportOpen, setExportOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const start = DateTime.fromISO(month, { zone }),
    gridStart = start.minus({ days: start.weekday % 7 }),
    from = gridStart.toUTC().toISO()!,
    to = gridStart.plus({ days: 42 }).toUTC().toISO()!;
  const calendarFrom = gridStart.toISODate()!,
    calendarTo = gridStart.plus({ days: 41 }).toISODate()!;
  const fetchRows = useCallback(async () => {
    const [events, classes] = await Promise.all([
      api("/calendar/events?" + new URLSearchParams({ from, to })),
      api(
        "/school/timetable/calendar?" +
          new URLSearchParams({ from: calendarFrom, to: calendarTo }),
      ),
    ]);
    const rows = [...events.rows, ...classes.rows].sort((a, b) =>
      a.starts_at.localeCompare(b.starts_at),
    );
    if (classes.issues.length) notify(classes.issues[0], true);
    return rows;
  }, [from, to, calendarFrom, calendarTo, notify]);
  const load = useCallback(async () => setRows(await fetchRows()), [fetchRows]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetchRows()
      .then((rows) => {
        if (active) setRows(rows);
      })
      .catch((e) => {
        if (active) notify(e.message, true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchRows, notify]);
  const visible = rows.filter(
      (row) => scope === "all" || row.audience === scope,
    ),
    onDate = (date: DateTime) =>
      visible.filter(
        (row) =>
          DateTime.fromISO(row.starts_at) < date.plus({ days: 1 }) &&
          DateTime.fromISO(row.ends_at) > date,
      );
  const selectedDate = DateTime.fromISO(selected, { zone }),
    agenda = onDate(selectedDate);
  function move(amount: number) {
    const next = start.plus({ months: amount });
    setMonth(next.toISODate()!);
    setSelected(next.toISODate()!);
  }
  async function cancel() {
    setBusy(true);
    try {
      await api("/calendar/events/" + detail.id + "/cancel", {
        version: detail.version,
      });
      setDetail(null);
      await load();
      notify("This occurrence was cancelled. Its history is retained.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="community-module">
      <div className="community-toolbar">
        <div className="calendar-month">
          <button
            className="icon-button"
            aria-label="Previous month"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={19} />
          </button>
          <h2>{start.toFormat("LLLL yyyy")}</h2>
          <button
            className="icon-button"
            aria-label="Next month"
            onClick={() => move(1)}
          >
            <ChevronRight size={19} />
          </button>
          <button
            className="button secondary"
            onClick={() => {
              setMonth(today.startOf("month").toISODate()!);
              setSelected(today.toISODate()!);
            }}
          >
            Today
          </button>
        </div>
        <div className="community-tools">
          <label className="sr-only" htmlFor="calendar-scope">
            Calendar audience
          </label>
          <select
            id="calendar-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">All my calendars</option>
            <option value="organization">Community</option>
            <option value="unit">My units</option>
            <option value="personal">Only me</option>
            <option value="classes">Classes</option>
          </select>
          <button className="button secondary" disabled={loading || scope === "classes"}
            title={scope === "classes" ? "Class timetable export is not available." : "Download calendar events as an .ics file"}
            onClick={() => setExportOpen(true)}>
            <Download size={17} /> Download events
          </button>
          <button className="button primary" onClick={() => setEditor({})}>
            <Plus size={17} />
            New event
          </button>
        </div>
      </div>
      {scope === "classes" && <p className="muted">Downloads are available for personal, unit and community events. Class timetable entries are not included.</p>}
      <div className="calendar-layout">
        <section
          className="calendar-panel"
          aria-label="Monthly calendar"
          aria-busy={loading}
        >
          <div className="calendar-weekdays">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {Array.from({ length: 42 }, (_, index) => {
              const date = gridStart.plus({ days: index }),
                iso = date.toISODate()!,
                events = onDate(date);
              return (
                <div
                  key={iso}
                  className={`calendar-day ${date.month !== start.month ? "outside" : ""} ${iso === selected ? "selected" : ""}`}
                >
                  <button
                    className={`calendar-date ${iso === today.toISODate() ? "today" : ""}`}
                    aria-label={date.toFormat("cccc, LLLL d, yyyy")}
                    aria-pressed={iso === selected}
                    onClick={() => setSelected(iso)}
                  >
                    {date.day}
                    <span className="mobile-event-count">
                      {events.length > 0 ? ` · ${events.length}` : ""}
                    </span>
                  </button>
                  <div className="calendar-day-events">
                    {events.slice(0, 3).map((event) => (
                      <button
                        key={event.id}
                        className={`calendar-chip audience-${event.audience}`}
                        onClick={() => {
                          setDetail(event);
                          setHistory(null);
                        }}
                        title={event.title}
                      >
                        {DateTime.fromISO(event.starts_at)
                          .setZone(zone)
                          .toFormat("h:mm a")}{" "}
                        <strong>{event.title}</strong>
                      </button>
                    ))}
                    {events.length > 3 && (
                      <button
                        className="text-link"
                        onClick={() => setSelected(iso)}
                      >
                        +{events.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="calendar-legend">
            <span>
              <i className="audience-organization" />
              Community
            </span>
            <span>
              <i className="audience-unit" />
              Unit
            </span>
            <span>
              <i className="audience-personal" />
              Only me
            </span>
            <span>
              <i className="audience-classes" />
              Classes
            </span>
            <small>{zone}</small>
          </div>
        </section>
        <Panel
          title={selectedDate.toFormat("cccc, LLL d")}
          detail={`${agenda.length} event${agenda.length === 1 ? "" : "s"} · ${zone}`}
          className="day-agenda"
        >
          <label className="agenda-date">
            Jump to date
            <input
              aria-label="Jump to date"
              type="date"
              value={selected}
              onChange={(e) => {
                if (e.target.value) {
                  setSelected(e.target.value);
                  setMonth(
                    DateTime.fromISO(e.target.value, { zone })
                      .startOf("month")
                      .toISODate()!,
                  );
                }
              }}
            />
          </label>
          {loading ? (
            <p className="community-loading">Loading events…</p>
          ) : agenda.length ? (
            agenda.map((event) => (
              <button
                key={event.id}
                className="agenda-event"
                onClick={() => {
                  setDetail(event);
                  setHistory(null);
                }}
              >
                <span className="agenda-time">
                  {DateTime.fromISO(event.starts_at)
                    .setZone(zone)
                    .toFormat("h:mm a")}
                </span>
                <strong>{event.title}</strong>
                <span>{event.location || "No location added"}</span>
                <Badge>
                  {event.audience === "classes"
                    ? "Class"
                    : event.audience === "personal"
                      ? "Only me"
                      : event.audience === "organization"
                        ? "Community"
                        : (me.units.find((u: any) => u.id === event.unit_id)
                            ?.name ?? "Unit")}
                </Badge>
              </button>
            ))
          ) : (
            <Empty
              title="Room in your day"
              detail="Choose another date or add an event."
            />
          )}
        </Panel>
      </div>
      {editor && (
        <EventEditor
          me={me}
          existing={editor}
          date={selected}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await load();
            notify(editor.id ? "Event updated." : "Your calendar is updated.");
          }}
        />
      )}
      {exportOpen && <CalendarExportDialog zone={zone} from={calendarFrom} to={calendarTo}
        audience={scope} onClose={() => setExportOpen(false)}
        onSaved={() => { setExportOpen(false); notify("Your calendar event file is ready."); }} />}
      {detail && (
        <Modal title={detail.title} onClose={() => setDetail(null)}>
          <div className="community-dialog">
            <Badge>
              {detail.audience === "classes"
                ? "Scheduled class"
                : detail.audience === "personal"
                  ? "Only me"
                  : detail.audience === "organization"
                    ? "Community event"
                    : "Unit event"}
            </Badge>
            <p>
              <Clock3 size={17} />{" "}
              {DateTime.fromISO(detail.starts_at)
                .setZone(detail.timezone)
                .toFormat("ccc, LLL d · h:mm a")}{" "}
              –{" "}
              {DateTime.fromISO(detail.ends_at)
                .setZone(detail.timezone)
                .toFormat("ccc, LLL d · h:mm a")}
              <br />
              {detail.timezone}
            </p>
            {detail.location && (
              <p>
                <MapPin size={17} /> {detail.location}
              </p>
            )}
            <p className="preserve-lines">
              {detail.description || "No additional details."}
            </p>
            <p className="muted">Added by {detail.creator_name}</p>
            {detail.source !== "timetable" && (
              <button
                className="text-link"
                onClick={() =>
                  void api("/calendar/events/" + detail.id + "/history")
                    .then((data) => setHistory(data.rows))
                    .catch((e) => notify(e.message, true))
                }
              >
                View change history
              </button>
            )}
            {history && (
              <ol className="event-history">
                {history.map((row) => (
                  <li key={row.version}>
                    Version {row.version} ·{" "}
                    {DateTime.fromISO(row.changed_at)
                      .setZone(zone)
                      .toFormat("LLL d, h:mm a")}
                    <br />
                    {row.snapshot.title} ·{" "}
                    {DateTime.fromISO(row.snapshot.starts_at)
                      .setZone(zone)
                      .toFormat("LLL d, h:mm a")}
                    {row.snapshot.cancelled_at ? " · Cancelled" : ""}
                  </li>
                ))}
              </ol>
            )}
            <div className="dialog-actions">
              <button
                className="button secondary"
                onClick={() => setDetail(null)}
              >
                Close
              </button>
              {detail.canEdit && (
                <>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    Cancel occurrence
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      setEditor(detail);
                      setDetail(null);
                    }}
                  >
                    Edit occurrence
                  </button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CalendarExportDialog({ zone, from, to, audience, onClose, onSaved }: {
  zone: string; from: string; to: string; audience: string; onClose: () => void; onSaved: () => void;
}) {
  const [first, setFirst] = useState(from), [last, setLast] = useState(to),
    [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const start = DateTime.fromISO(first, { zone }).startOf("day"),
        end = DateTime.fromISO(last, { zone }).startOf("day").plus({ days: 1 });
      if (!start.isValid || !end.isValid || end <= start)
        throw new Error("Choose a valid start and end date.");
      await download("/calendar/export?" + new URLSearchParams({
        from: start.toUTC().toISO()!, to: end.toUTC().toISO()!, audience,
      }), `stjw-calendar-${first}-to-${last}.ics`);
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title="Download calendar events" onClose={() => { if (!busy) onClose(); }}>
    <form className="community-dialog" onSubmit={save}>
      <p>Save {audience === "personal" ? "your personal" : audience === "unit" ? "your unit" : audience === "organization" ? "community" : "your accessible"} events as an .ics file to open in another calendar.</p>
      <div className="community-form-grid">
        <label>From<input type="date" aria-label="Calendar export from" required value={first}
          disabled={busy} onChange={(e) => setFirst(e.target.value)} /></label>
        <label>Through<input type="date" aria-label="Calendar export through" required value={last}
          disabled={busy} onChange={(e) => setLast(e.target.value)} /></label>
      </div>
      <p className="muted">Dates use {zone}. Calendar events only; class timetable entries are not included. Repeated events download as separate occurrences.</p>
      <p className="muted">This file contains event titles, details and locations. It is a snapshot: later changes and cancellations will not update the downloaded copy.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy}><Download size={17} />{busy ? "Preparing…" : "Download .ics"}</button>
      </div>
    </form>
  </Modal>;
}
function EventEditor({
  me,
  existing,
  date,
  onClose,
  onSaved,
}: {
  me: any;
  existing: any;
  date: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const zone = existing.timezone ?? me.organization.timezone,
    [audience, setAudience] = useState(existing.audience ?? "personal"),
    [repeat, setRepeat] = useState("none"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const format = (value: string) =>
    DateTime.fromISO(value).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const asUtc = (key: string) => {
        const raw = String(form.get(key)),
          value = DateTime.fromISO(raw, { zone });
        if (!value.isValid || value.toFormat("yyyy-MM-dd'T'HH:mm") !== raw)
          throw Error(
            "This local time does not exist. Choose a time outside the daylight-saving change.",
          );
        return value.toUTC().toISO();
      };
      const event = {
        title: form.get("title"),
        description: form.get("description"),
        location: form.get("location"),
        startsAt: asUtc("start"),
        endsAt: asUtc("end"),
        timezone: zone,
        audience,
        unitId: audience === "unit" ? form.get("unit") : null,
      };
      if (existing.id)
        await api(
          "/calendar/events/" + existing.id,
          { event, version: existing.version },
          "PATCH",
        );
      else
        await api("/calendar/events", {
          event,
          repeat: {
            frequency: repeat,
            interval: Number(form.get("interval") ?? 1),
            count: Number(form.get("count") ?? 1),
          },
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
      title={
        existing.id ? "Edit this occurrence" : "Make time for what matters"
      }
      onClose={onClose}
    >
      <form className="community-form" onSubmit={submit}>
        <label>
          Event name
          <input
            name="title"
            defaultValue={existing.title}
            minLength={2}
            maxLength={140}
            placeholder="e.g. Staff planning meeting"
            required
            autoFocus
          />
        </label>
        <div className="community-form-grid">
          <label>
            Starts · {zone}
            <input
              name="start"
              type="datetime-local"
              defaultValue={
                existing.starts_at
                  ? format(existing.starts_at)
                  : date + "T09:00"
              }
              required
            />
          </label>
          <label>
            Ends · {zone}
            <input
              name="end"
              type="datetime-local"
              defaultValue={
                existing.ends_at ? format(existing.ends_at) : date + "T10:00"
              }
              required
            />
          </label>
        </div>
        <label>
          Location
          <input
            name="location"
            defaultValue={existing.location ?? ""}
            maxLength={200}
            placeholder="Room, building, or meeting address"
          />
        </label>
        <div className="community-form-grid">
          <label>
            Who can see this?
            <select
              value={audience}
              disabled={!!existing.id}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="personal">Only me</option>
              <option value="classes">Classes</option>
              {me.permissions.manage && (
                <option value="unit">An organizational unit</option>
              )}
              {["developer", "owner", "admin"].includes(me.actor.role) && (
                <option value="organization">Everyone in STJW</option>
              )}
            </select>
          </label>
          {audience === "unit" && (
            <label>
              Unit
              <select
                name="unit"
                defaultValue={existing.unit_id ?? me.units[0]?.id}
                disabled={!!existing.id}
              >
                {me.units.map((unit: any) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
              {existing.id && (
                <input type="hidden" name="unit" value={existing.unit_id} />
              )}
            </label>
          )}
        </div>
        <label>
          Details
          <textarea
            name="description"
            rows={4}
            maxLength={6000}
            defaultValue={existing.description ?? ""}
            placeholder="Help people arrive prepared."
          />
        </label>
        {!existing.id && (
          <div className="community-form-grid">
            <label>
              Repeat
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {repeat !== "none" && (
              <>
                <label>
                  Every
                  <input
                    name="interval"
                    type="number"
                    min={1}
                    max={12}
                    defaultValue={1}
                    required
                  />
                  <small>{repeat === "daily" ? "days" : "weeks"}</small>
                </label>
                <label>
                  Total occurrences
                  <input
                    name="count"
                    type="number"
                    min={2}
                    max={52}
                    defaultValue={4}
                    required
                  />
                </label>
              </>
            )}
          </div>
        )}
        {existing.id && (
          <p className="muted">
            Changes apply to this occurrence. The audience stays the same to
            protect its history.
          </p>
        )}
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
            {busy ? "Saving…" : existing.id ? "Save changes" : "Create event"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
