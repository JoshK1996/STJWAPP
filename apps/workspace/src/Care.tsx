import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  Clock3,
  DoorOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  Settings2,
  Download,
} from "lucide-react";
import { api, download } from "./api";
import { Avatar, Badge, Empty, Modal, Panel, hours } from "./components";
import { WorkspaceArt } from "./WorkspaceArt";
import CareTransfers from "./CareTransfers";
type Notice = (text: string, error?: boolean) => void;
export default function Care({
  me,
  notify,
  onDirty,
}: {
  me: any;
  notify: Notice;
  onDirty: (dirty: boolean) => void;
}) {
  const [access, setAccess] = useState<any>(null),
    [programId, setProgramId] = useState(""),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("today"),
    [dialog, setDialog] = useState<any>(null),
    [dirty, setDirty] = useState(false),
    [search, setSearch] = useState("");
  const [pendingTransfers, setPendingTransfers] = useState<string[]>([]);
  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  const loadAccess = useCallback(async () => {
    const result = await api("/care/access");
    setAccess(result);
    return result;
  }, []);
  useEffect(() => {
    let active = true;
    void api("/care/access")
      .then((result) => {
        if (!active) return;
        setAccess(result);
        setProgramId(
          result.programs.find((p: any) => !p.archived)?.id ??
            result.programs[0]?.id ??
            "",
        );
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!programId) return;
    const result = await api("/care/programs/" + programId);
    setData(result);
    setError("");
  }, [programId]);
  useEffect(() => {
    let active = true;
    setError("");
    if (!programId) return;
    const load = () =>
      api("/care/programs/" + programId)
        .then((result) => {
          if (active) {
            setData(result);
            setError("");
          }
        })
        .catch((e) => {
          if (active) {
            setData(null);
            setError(e.message);
          }
        });
    if (!dialog) void load();
    const timer = setInterval(() => {
      if (!dialog) void load();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [programId, !!dialog]);
  function close() {
    if (dirty && !window.confirm("Discard unsaved childcare changes?")) return;
    markDirty(false);
    setDialog(null);
  }
  async function saved(result?: any) {
    markDirty(false);
    setDialog(null);
    await loadAccess();
    if (dialog?.kind === "program" && !dialog.initial) {
      setProgramId(result.id);
    } else await refresh();
    notify("Childcare record saved.");
  }
  const program = data?.program,
    office = program?.office,
    present = data?.present ?? [],
    eligible = (data?.rows ?? []).filter(
      (r: any) =>
        r.active &&
        r.enabled &&
        r.starts_on <= data.day &&
        r.ends_on >= data.day,
    ),
    inside = new Set(present.map((s: any) => s.student_id));
  const matches = (row: any) =>
    !search ||
    (row.name + " " + row.student_number)
      .toLowerCase()
      .includes(search.toLowerCase());
  const stamp = (value: string) =>
    DateTime.fromISO(value)
      .setZone(data?.timezone ?? me.organization.timezone)
      .toFormat("LLL d, h:mm a");
  return (
    <div className="care-module">
      <div className="care-hero">
        <div>
          <span className="eyebrow">EVERY CHILD, ACCOUNTED FOR</span>
          <h2>
            A warm welcome.
            <br />A thoughtful handoff.
          </h2>
          <p>Check children in, see who is here, and verify each pickup.</p>
        </div>
        <WorkspaceArt scene="day" />
      </div>
      <div className="care-toolbar">
        <label>
          Care program
          <select
            aria-label="Care program"
            value={programId}
            onChange={(e) => {
              setProgramId(e.target.value);
              setData(null);
              setSearch("");
              setTab("today");
            }}
          >
            <option value="">Choose a program</option>
            {access?.programs.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? " · Archived" : ""}
              </option>
            ))}
          </select>
        </label>
        {!!access?.units.length && (
          <button
            className="button secondary"
            onClick={() => setDialog({ kind: "program" })}
          >
            <Plus size={16} />
            New program
          </button>
        )}
        {programId && (
          <button
            className="button secondary"
            onClick={() => void refresh().catch((e) => notify(e.message, true))}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!access && !error && (
        <p className="community-loading">Checking program access…</p>
      )}
      {access && !programId && (
        <Panel title="Childcare programs">
          <Empty
            title="No program selected"
            detail={
              access.units.length
                ? "Create a program, confirm its instructions, assign staff, and enroll children to begin."
                : "The school office can assign you to a care program. Classroom or workforce access alone does not grant pickup access."
            }
          />
        </Panel>
      )}
      {program && (
        <>
          <div className="care-stats">
            <div>
              <DoorOpen />
              <strong>{present.length}</strong>
              <span>Here now</span>
            </div>
            <div>
              <Users />
              <strong>{program.capacity - present.length}</strong>
              <span>Spaces available</span>
            </div>
            <div>
              <Clock3 />
              <strong>{eligible.length}</strong>
              <span>On today’s roster</span>
            </div>
          </div>
          <div className="care-instructions">
            <ShieldCheck size={22} />
            <div>
              <strong>
                {program.room} · {program.name}
              </strong>
              <p>{program.instructions}</p>
              <small>
                Assigned staff are not a live staff headcount. Capacity does not
                verify staffing ratios.
              </small>
            </div>
            <Badge
              tone={program.confirmed && !program.archived ? "green" : "amber"}
            >
              {program.archived
                ? "Archived"
                : program.confirmed
                  ? "Instructions confirmed"
                  : "Needs confirmation"}
            </Badge>
          </div>
          <nav className="school-tabs" aria-label="Childcare views">
            {[
              ["today", "Here & arriving"],
              ...(office
                ? [
                    ["roster", "Roster & setup"],
                    ["timesheets", "Child timesheets"],
                  ]
                : []),
            ].map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === "today" && (
            <>
              <CareTransfers
                key={programId}
                programId={programId}
                me={me}
                onDirty={markDirty}
                onChanged={refresh}
                onPending={setPendingTransfers}
              />
              <label className="care-search">
                Find a child
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name or student number"
                />
              </label>
              <div className="care-columns">
                <Panel
                  title={`Here now · ${present.length}`}
                  detail={`Updated ${stamp(data.asOf)} · refreshes every 15 seconds`}
                >
                  <div className="care-children">
                    {present.filter(matches).map((s: any) => {
                      const roster = data.rows.find(
                        (r: any) => r.student_id === s.student_id,
                      );
                      return (
                        <article key={s.id}>
                          <Avatar name={s.name} />
                          <div>
                            <strong>{s.name}</strong>
                            <small>
                              {s.student_number} · In {stamp(s.checked_in_at)}
                            </small>
                            {(roster?.pickup_hold || roster?.restricted) && (
                              <Badge tone="amber">Office review needed</Badge>
                            )}
                          </div>
                          <button
                            className="button small"
                            onClick={() =>
                              setDialog({ kind: "out", session: s })
                            }
                          >
                            Check out
                          </button>
                        </article>
                      );
                    })}
                    {!present.filter(matches).length && (
                      <Empty
                        title="No children shown"
                        detail="Children appear here as staff check them in."
                      />
                    )}
                  </div>
                </Panel>
                <Panel
                  title="Ready to arrive"
                  detail="Children currently enrolled in this care program."
                >
                  <div className="care-children">
                    {eligible
                      .filter(
                        (r: any) =>
                          !inside.has(r.student_id) &&
                          !pendingTransfers.includes(r.student_id) &&
                          matches(r),
                      )
                      .map((r: any) => (
                        <article key={r.student_id}>
                          <Avatar name={r.name} />
                          <div>
                            <strong>{r.name}</strong>
                            <small>{r.student_number}</small>
                          </div>
                          <button
                            className="button secondary small"
                            disabled={
                              !program.confirmed ||
                              program.archived ||
                              present.length >= program.capacity
                            }
                            onClick={() =>
                              setDialog({ kind: "in", student: r })
                            }
                          >
                            Check in
                          </button>
                        </article>
                      ))}
                    {!eligible.filter(
                      (r: any) => !inside.has(r.student_id) && matches(r),
                    ).length && (
                      <Empty
                        title="No children waiting"
                        detail="The office maintains dated enrollment in Roster & setup."
                      />
                    )}
                  </div>
                </Panel>
              </div>
            </>
          )}
          {tab === "roster" && office && (
            <Panel
              title="Program roster"
              detail="Dated care enrollment is separate from classroom enrollment."
              action={
                <div className="care-actions">
                  <button
                    className="button secondary"
                    onClick={() =>
                      setDialog({ kind: "program", initial: program })
                    }
                  >
                    <Settings2 size={16} />
                    Program settings
                  </button>
                  <button
                    className="button"
                    onClick={() => setDialog({ kind: "enrollment" })}
                  >
                    <Plus size={16} />
                    Enroll a child
                  </button>
                </div>
              }
            >
              <div className="care-staff">
                <strong>Assigned care staff</strong>
                <p>
                  {data.staff
                    .map((s: any) => s.name + (s.active ? "" : " (inactive)"))
                    .join(", ") ||
                    "No staff assigned. School office staff can operate the program."}
                </p>
              </div>
              <div className="care-children">
                {data.rows.map((r: any) => (
                  <article key={r.student_id}>
                    <Avatar name={r.name} />
                    <div>
                      <strong>{r.name}</strong>
                      <small>
                        {r.student_number} · {r.starts_on} through {r.ends_on} ·{" "}
                        {r.enabled ? "Enabled" : "Disabled"}
                      </small>
                      {(r.pickup_hold || r.restricted) && (
                        <Badge tone="amber">Pickup review needed</Badge>
                      )}
                    </div>
                    <div className="care-actions">
                      <button
                        className="button secondary small"
                        onClick={() => setDialog({ kind: "hold", student: r })}
                      >
                        Pickup hold
                      </button>
                      <button
                        className="button secondary small"
                        onClick={() =>
                          setDialog({ kind: "enrollment", student: r })
                        }
                      >
                        Edit
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </Panel>
          )}
          {tab === "timesheets" && office && (
            <CareTimesheets
              key={programId}
              programId={programId}
              data={data}
              notify={notify}
            />
          )}
        </>
      )}
      {dialog && (
        <CareDialog
          key={dialog.kind + String(dialog.student?.student_id ?? "")}
          dialog={dialog}
          data={data}
          access={access}
          onClose={close}
          onDirty={markDirty}
          onSaved={saved}
          notify={notify}
        />
      )}
    </div>
  );
}
function CareDialog({
  dialog,
  data,
  access,
  onClose,
  onDirty,
  onSaved,
  notify,
}: {
  dialog: any;
  data: any;
  access: any;
  onClose: () => void;
  onDirty: (value: boolean) => void;
  onSaved: (result: any) => Promise<void>;
  notify: Notice;
}) {
  const kind = dialog.kind,
    initial = dialog.initial,
    child = dialog.student;
  const [form, setForm] = useState<any>({
    unitId:
      initial?.unit_id ?? data?.program.unit_id ?? access.units[0]?.id ?? "",
    name: initial?.name ?? "",
    room: initial?.room ?? "",
    capacity: initial?.capacity ?? "",
    instructions: initial?.instructions ?? "",
    confirmed: false,
    archived: initial?.archived ?? false,
    staffIds: initial ? data.staff.map((s: any) => s.user_id) : [],
    reason: "",
    startsOn: child?.starts_on ?? data?.day ?? "",
    endsOn: child?.ends_on ?? "",
    enabled: child?.enabled ?? true,
    studentId: child?.student_id ?? "",
    arrivalName: "",
    received: false,
    contactId: "",
    identityMethod: "",
    identityConfirmed: false,
    released: false,
    note: "",
    active: false,
  });
  const [staff, setStaff] = useState<any[]>([]),
    [students, setStudents] = useState<any[]>([]),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [hasMore, setHasMore] = useState(false),
    [pickup, setPickup] = useState<any>(null),
    [hold, setHold] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [commandId] = useState(() => crypto.randomUUID());
  const set = (key: string, value: any) => {
    setForm((f: any) => ({ ...f, [key]: value }));
    onDirty(true);
  };
  useEffect(() => {
    let active = true;
    setLoadError("");
    if (kind === "program")
      void api("/school/staff?unitId=" + form.unitId)
        .then((r) => {
          if (active) setStaff(r.rows);
        })
        .catch((e) => {
          if (active) setLoadError(e.message);
        });
    return () => {
      active = false;
    };
  }, [kind, form.unitId]);
  useEffect(() => {
    let active = true;
    if (kind === "enrollment" && !child) {
      const timer = setTimeout(
        () =>
          void api(
            "/school/students?unitId=" +
              data.program.unit_id +
              "&search=" +
              encodeURIComponent(query) +
              "&offset=" +
              offset,
          )
            .then((r) => {
              if (active) {
                setStudents(r.rows);
                setHasMore(r.hasMore);
              }
            })
            .catch((e) => {
              if (active) setLoadError(e.message);
            }),
        200,
      );
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }
  }, [kind, query, offset]);
  useEffect(() => {
    let active = true;
    if (kind === "out")
      void api("/care/sessions/" + dialog.session.id + "/pickup")
        .then((r) => {
          if (active) setPickup(r);
        })
        .catch((e) => {
          if (active) setLoadError(e.message);
        });
    if (kind === "hold")
      void api("/care/students/" + child.student_id + "/hold")
        .then((r) => {
          if (active) {
            setHold(r);
            setForm((f: any) => ({ ...f, active: r.active }));
          }
        })
        .catch((e) => {
          if (active) setLoadError(e.message);
        });
    return () => {
      active = false;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let result;
      if (kind === "program")
        result = await api(
          "/care/programs" + (initial ? "/" + initial.id : ""),
          {
            unitId: form.unitId,
            name: form.name,
            room: form.room,
            capacity: Number(form.capacity),
            instructions: form.instructions,
            confirmed: form.confirmed,
            archived: form.archived,
            staffIds: form.staffIds,
            version: initial?.version ?? 0,
            reason: form.reason,
          },
          initial ? "PATCH" : "POST",
        );
      if (kind === "enrollment")
        result = await api(
          "/care/programs/" + data.program.id + "/enrollments",
          {
            studentId: form.studentId,
            startsOn: form.startsOn,
            endsOn: form.endsOn,
            enabled: form.enabled,
            version: child?.version ?? 0,
            reason: form.reason,
          },
        );
      if (kind === "hold")
        result = await api(
          "/care/students/" + child.student_id + "/hold",
          { active: form.active, reason: form.reason, version: hold.version },
          "PUT",
        );
      if (kind === "in")
        result = await api("/care/check-in", {
          programId: data.program.id,
          programVersion: data.program.version,
          studentId: child.student_id,
          arrivalName: form.arrivalName,
          received: form.received,
          commandId,
        });
      if (kind === "out") {
        const contact = pickup.contacts.find(
          (c: any) => c.person_id === form.contactId,
        );
        result = await api(
          "/care/sessions/" + dialog.session.id + "/check-out",
          {
            contactId: form.contactId,
            contactVersion: contact?.version,
            personVersion: contact?.person_version,
            identityMethod: form.identityMethod,
            identityConfirmed: form.identityConfirmed,
            released: form.released,
            note: form.note,
            commandId,
          },
        );
      }
      await onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const titles: any = {
    program: initial ? "Program settings" : "New care program",
    enrollment: child ? "Edit care enrollment" : "Enroll a child",
    in: "Welcome " + child?.name,
    out: "Verify pickup · " + dialog.session?.name,
    hold: "Pickup hold · " + child?.name,
  };
  const blocked = pickup && (pickup.hold.active || pickup.restricted);
  return (
    <Modal
      title={titles[kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="care-form" onSubmit={submit}>
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {kind === "program" && (
          <>
            <label>
              School or program unit
              <select
                aria-label="Program unit"
                disabled={!!initial}
                value={form.unitId}
                onChange={(e) => {
                  set("unitId", e.target.value);
                  set("staffIds", []);
                }}
              >
                {access.units.map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Program name
              <input
                required
                minLength={2}
                maxLength={100}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <div className="care-fields">
              <label>
                Room
                <input
                  required
                  maxLength={100}
                  value={form.room}
                  onChange={(e) => set("room", e.target.value)}
                />
              </label>
              <label>
                Maximum children present
                <input
                  required
                  type="number"
                  min="1"
                  max="200"
                  value={form.capacity}
                  onChange={(e) => set("capacity", e.target.value)}
                />
              </label>
            </div>
            <label>
              Care and handoff instructions
              <textarea
                required
                minLength={5}
                maxLength={3000}
                value={form.instructions}
                onChange={(e) => set("instructions", e.target.value)}
              />
            </label>
            <fieldset>
              <legend>Staff with care access</legend>
              <p>
                Selected staff can check children in and verify pickups in this
                program.
              </p>
              {staff.map((s) => (
                <label className="care-check" key={s.id}>
                  <input
                    type="checkbox"
                    checked={form.staffIds.includes(s.id)}
                    onChange={(e) =>
                      set(
                        "staffIds",
                        e.target.checked
                          ? [...form.staffIds, s.id]
                          : form.staffIds.filter((id: string) => id !== s.id),
                      )
                    }
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
            <label className="care-check">
              <input
                type="checkbox"
                checked={form.confirmed}
                onChange={(e) => set("confirmed", e.target.checked)}
              />
              I have confirmed this program’s capacity and handoff instructions
              for use.
            </label>
            {initial && (
              <label className="care-check">
                <input
                  type="checkbox"
                  checked={form.archived}
                  onChange={(e) => set("archived", e.target.checked)}
                />
                Archive this program
              </label>
            )}
          </>
        )}
        {kind === "enrollment" && (
          <>
            {child ? (
              <p>
                <strong>{child.name}</strong> · {child.student_number}
              </p>
            ) : (
              <>
                <label>
                  Search school records
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label>
                  Child
                  <select
                    required
                    aria-label="Child to enroll"
                    value={form.studentId}
                    onChange={(e) => set("studentId", e.target.value)}
                  >
                    <option value="">Select a child</option>
                    {students.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.student_number}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mail-pagination">
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - 100))}
                  >
                    Previous
                  </button>
                  <span>
                    Records {offset + 1}–{offset + students.length}
                  </span>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!hasMore}
                    onClick={() => setOffset(offset + 100)}
                  >
                    Next
                  </button>
                </div>
              </>
            )}
            <div className="care-fields">
              <label>
                Starts on
                <input
                  required
                  type="date"
                  value={form.startsOn}
                  onChange={(e) => set("startsOn", e.target.value)}
                />
              </label>
              <label>
                Ends on
                <input
                  required
                  type="date"
                  min={form.startsOn}
                  value={form.endsOn}
                  onChange={(e) => set("endsOn", e.target.value)}
                />
              </label>
            </div>
            <label className="care-check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Enrollment enabled
            </label>
          </>
        )}
        {kind === "hold" && (
          <>
            <p>
              A hold blocks pickup in every care program for this child.
              Existing contact restrictions also block release and must be
              resolved in School records.
            </p>
            <label className="care-check">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
              />
              Place this child’s pickup on hold
            </label>
            {hold?.reason && <p>Current record: {hold.reason}</p>}
          </>
        )}
        {["program", "enrollment", "hold"].includes(kind) && (
          <label>
            Reason for this record
            <textarea
              required
              minLength={5}
              maxLength={1000}
              value={form.reason}
              onChange={(e) => set("reason", e.target.value)}
            />
          </label>
        )}
        {kind === "in" && (
          <>
            <p>
              {data.program.name} · {data.program.room}
              <br />
              The check-in time is recorded when you submit.
            </p>
            <label>
              Adult handing the child over
              <input
                required
                minLength={2}
                maxLength={100}
                placeholder="Full name"
                value={form.arrivalName}
                onChange={(e) => set("arrivalName", e.target.value)}
              />
            </label>
            <label className="care-check">
              <input
                required
                type="checkbox"
                checked={form.received}
                onChange={(e) => set("received", e.target.checked)}
              />
              I have received this child into the program.
            </label>
          </>
        )}
        {kind === "out" && (
          <>
            {!pickup && !loadError && (
              <p>Checking current pickup permissions…</p>
            )}
            {pickup && (
              <>
                {blocked && (
                  <div className="care-block" role="alert">
                    <ShieldCheck />
                    <div>
                      <strong>Stop — office review required</strong>
                      <p>
                        {pickup.hold.active
                          ? pickup.hold.reason
                          : "A contact restriction is recorded for this child."}
                      </p>
                      <p>
                        Keep the child with staff. The office must resolve the
                        record before checkout.
                      </p>
                    </div>
                  </div>
                )}
                <div className="care-permissions">
                  {pickup.contacts.map((c: any) => (
                    <div key={c.person_id}>
                      <strong>{c.name}</strong>
                      <span>
                        {c.relationship} ·{" "}
                        {c.eligible
                          ? "Pickup permitted"
                          : c.can_pickup
                            ? "Not currently cleared"
                            : "No pickup permission"}
                      </span>
                      {c.pickup_until && (
                        <small>Permission through {c.pickup_until}</small>
                      )}
                      {c.restriction_note && (
                        <p className="error">{c.restriction_note}</p>
                      )}
                    </div>
                  ))}
                </div>
                {!blocked && (
                  <>
                    <label>
                      Person collecting the child
                      <select
                        required
                        aria-label="Pickup person"
                        value={form.contactId}
                        onChange={(e) => {
                          set("contactId", e.target.value);
                          set("identityConfirmed", false);
                          set("released", false);
                        }}
                      >
                        <option value="">Choose an authorized person</option>
                        {pickup.contacts
                          .filter((c: any) => c.eligible)
                          .map((c: any) => (
                            <option key={c.person_id} value={c.person_id}>
                              {c.name} · {c.relationship}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      How was identity verified?
                      <select
                        required
                        aria-label="Identity verification"
                        value={form.identityMethod}
                        onChange={(e) => set("identityMethod", e.target.value)}
                      >
                        <option value="">
                          Choose how you verified identity
                        </option>
                        <option value="photo_id">Photo ID checked</option>
                        <option value="personally_known">
                          Personally known to me
                        </option>
                      </select>
                    </label>
                    <label className="care-check">
                      <input
                        required
                        type="checkbox"
                        checked={form.identityConfirmed}
                        onChange={(e) =>
                          set("identityConfirmed", e.target.checked)
                        }
                      />
                      I verified this person’s identity and current pickup
                      permission.
                    </label>
                    <label className="care-check">
                      <input
                        required
                        type="checkbox"
                        checked={form.released}
                        onChange={(e) => set("released", e.target.checked)}
                      />
                      I am handing this child to the verified person now.
                    </label>
                    <label>
                      Handoff note (optional)
                      <textarea
                        maxLength={1000}
                        value={form.note}
                        onChange={(e) => set("note", e.target.value)}
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </>
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
          <button
            className="button"
            disabled={
              busy ||
              !!loadError ||
              (kind === "out" && (!pickup || blocked)) ||
              (kind === "hold" && !hold)
            }
          >
            {busy
              ? "Saving…"
              : kind === "in"
                ? "Confirm check-in"
                : kind === "out"
                  ? "Confirm checkout"
                  : "Save record"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CareTimesheets({
  programId,
  data,
  notify,
}: {
  programId: string;
  data: any;
  notify: Notice;
}) {
  const [from, setFrom] = useState(data.day),
    [to, setTo] = useState(data.day),
    [student, setStudent] = useState(""),
    [report, setReport] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const suffix =
    "?programId=" +
    programId +
    "&from=" +
    from +
    "&to=" +
    to +
    (student ? "&studentId=" + student : "");
  async function load(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setReport(null);
    try {
      setReport(await api("/care/timesheets" + suffix));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Child timesheets"
      detail="Exact attendance time clipped to the selected dates. Open sessions run through the report timestamp; totals are not billing charges."
    >
      <form className="care-toolbar" onSubmit={load}>
        <label>
          From
          <input
            required
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setReport(null);
            }}
          />
        </label>
        <label>
          Through
          <input
            required
            type="date"
            min={from}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setReport(null);
            }}
          />
        </label>
        <label>
          Child
          <select
            aria-label="Timesheet child"
            value={student}
            onChange={(e) => {
              setStudent(e.target.value);
              setReport(null);
            }}
          >
            <option value="">All enrolled children</option>
            {data.rows.map((r: any) => (
              <option key={r.student_id} value={r.student_id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Loading…" : "Run report"}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <div className="care-report-summary">
            <div>
              <strong>{hours(report.totalMilliseconds)} hours</strong>
              <small>
                {report.rows.length} sessions · {report.timezone}
                <br />
                As of{" "}
                {DateTime.fromISO(report.asOf)
                  .setZone(report.timezone)
                  .toFormat("LLL d, h:mm:ss a")}
              </small>
            </div>
            <button
              className="button secondary"
              onClick={() =>
                void download(
                  "/care/timesheets/export" + suffix,
                  "child-care-timesheets.csv",
                ).catch((e) => notify(e.message, true))
              }
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Child</th>
                  <th>Check-in</th>
                  <th>Checkout / pickup</th>
                  <th>Hours in range</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((s: any) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.student_name}</strong>
                      <small>{s.student_number}</small>
                    </td>
                    <td>
                      {DateTime.fromISO(s.checked_in_at)
                        .setZone(report.timezone)
                        .toFormat("LLL d, h:mm a")}
                      <small>{s.entered_by}</small>
                    </td>
                    <td>
                      {s.checked_out_at
                        ? DateTime.fromISO(s.checked_out_at)
                            .setZone(report.timezone)
                            .toFormat("LLL d, h:mm a")
                        : "Still here"}
                      <small>
                        {s.pickup_name || "—"}
                        {s.released_by ? " · Recorded by " + s.released_by : ""}
                      </small>
                    </td>
                    <td>{hours(s.milliseconds_in_range)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!report.rows.length && (
            <Empty
              title="No sessions in this range"
              detail="Try different dates or another child."
            />
          )}
        </>
      )}
    </Panel>
  );
}
