import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  Bus,
  ClipboardCheck,
  Download,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api, download } from "./api";
import { Avatar, Badge, Empty, Modal, Panel } from "./components";
import { WorkspaceArt } from "./WorkspaceArt";
type Notice = (text: string, error?: boolean) => void;
const labels: Record<string, string> = {
  unaccounted: "Not yet accounted for",
  present: "Here with staff",
  called: "Called for handoff",
  released: "Released",
  absent: "Not at dismissal",
};
export default function Dismissal({
  me,
  notify,
  onDirty,
}: {
  me: any;
  notify: Notice;
  onDirty: (value: boolean) => void;
}) {
  const [access, setAccess] = useState<any>(null),
    [unitId, setUnitId] = useState(""),
    [runId, setRunId] = useState(""),
    [catalog, setCatalog] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<any>(null),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState("children"),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0);
  const office = !!access?.officeUnits.includes(unitId),
    today = DateTime.now().setZone(me.organization.timezone).toISODate()!,
    markDirty = useCallback(
      (value: boolean) => {
        setDirty(value);
        onDirty(value);
      },
      [onDirty],
    );
  useEffect(() => {
    let active = true;
    void api("/dismissal/access")
      .then((r) => {
        if (active) {
          setAccess(r);
          setUnitId(
            r.units.find((u: any) => u.kind === "school")?.id ??
              r.units[0]?.id ??
              "",
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const loadCatalog = useCallback(async () => {
    if (!unitId) return null;
    const [policy, runs, years, staff] = await Promise.all([
      api("/dismissal/settings?unitId=" + unitId),
      api("/dismissal/runs?unitId=" + unitId + "&offset=" + offset),
      office
        ? api("/school/years?unitId=" + unitId)
        : Promise.resolve({ rows: [] }),
      office
        ? api("/school/staff?unitId=" + unitId)
        : Promise.resolve({ rows: [] }),
    ]);
    return {
      policy,
      runs: runs.rows,
      hasMore: runs.hasMore,
      years: years.rows,
      staff: staff.rows,
    };
  }, [unitId, office, offset]);
  useEffect(() => {
    let active = true;
    setCatalog(null);
    setDetail(null);
    setRunId("");
    setError("");
    void loadCatalog()
      .then((r) => {
        if (active && r) {
          setCatalog(r);
          setRunId(r.runs[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [loadCatalog]);
  const refresh = useCallback(async () => {
    if (runId) {
      const result = await api("/dismissal/runs/" + runId);
      setDetail(result);
      setError("");
    }
  }, [runId]);
  useEffect(() => {
    let active = true;
    if (!runId) return;
    const load = () =>
      api("/dismissal/runs/" + runId)
        .then((r) => {
          if (active) {
            setDetail(r);
            setError("");
          }
        })
        .catch((e) => {
          if (active) {
            setDetail(null);
            setError(e.message);
          }
        });
    if (!dialog) void load();
    const timer = setInterval(() => {
      if (!dialog) void load();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runId, !!dialog]);
  function close() {
    if (dirty && !window.confirm("Discard unsaved dismissal changes?")) return;
    markDirty(false);
    setDialog(null);
  }
  async function saved(result: any) {
    const kind = dialog.kind;
    markDirty(false);
    setDialog(null);
    setSelected([]);
    if (kind === "settings" || kind === "open") {
      const next = await loadCatalog();
      setCatalog(next);
      if (kind === "open") {
        setOffset(0);
        setRunId(result.id);
        setDetail(null);
      } else await refresh();
    } else await refresh();
    notify("Dismissal record saved.");
  }
  async function here(entry: any) {
    setBusy(true);
    try {
      await api(
        "/dismissal/runs/" + runId + "/entries/" + entry.student_id + "/action",
        {
          action: "present",
          version: entry.version,
          observed: true,
          commandId: crypto.randomUUID(),
        },
      );
      await refresh();
      notify("Presence recorded.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const open = detail?.run.status === "open" && detail?.run.day === today,
    rows = (detail?.entries ?? []).filter((e: any) => e.expected),
    visible = rows.filter(
      (e: any) =>
        (!filter || e.status === filter) &&
        (!search ||
          (e.student_name + " " + e.student_number + " " + e.grade_level)
            .toLowerCase()
            .includes(search.toLowerCase())),
    );
  return (
    <div className="dismissal-module">
      <div className="dismissal-hero">
        <div>
          <span className="eyebrow">A GOOD END TO EVERY SCHOOL DAY</span>
          <h2>
            From our care
            <br />
            to their next stop.
          </h2>
          <p>Know who is here, who is waiting, and who has been handed over.</p>
        </div>
        <WorkspaceArt scene="community" />
      </div>
      <div className="care-toolbar">
        <label>
          School or unit
          <select
            aria-label="Dismissal unit"
            value={unitId}
            onChange={(e) => {
              setUnitId(e.target.value);
              setSelected([]);
              setOffset(0);
            }}
          >
            {access?.units.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dismissal day
          <select
            aria-label="Dismissal day"
            value={runId}
            onChange={(e) => {
              setRunId(e.target.value);
              setDetail(null);
              setSelected([]);
            }}
          >
            <option value="">Choose a recorded day</option>
            {catalog?.runs.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.day} ·{" "}
                {(r.id === detail?.run.id ? detail.run.status : r.status) ===
                "closed"
                  ? "Closed"
                  : "Open"}
              </option>
            ))}
          </select>
        </label>
        {office && (
          <button
            className="button secondary"
            onClick={() => setDialog({ kind: "settings" })}
            disabled={!catalog}
          >
            <Settings2 size={16} />
            Dismissal setup
          </button>
        )}
        {office &&
          catalog &&
          !catalog.runs.some((r: any) => r.day === today) && (
            <button
              className="button"
              disabled={!catalog.policy.confirmed}
              onClick={() => setDialog({ kind: "open" })}
            >
              <Plus size={16} />
              Open today
            </button>
          )}
        {runId && (
          <button
            className="button secondary"
            onClick={() => void refresh().catch((e) => notify(e.message, true))}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        )}
      </div>
      {(offset > 0 || catalog?.hasMore) && (
        <div className="mail-pagination">
          <button
            className="button secondary small"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Newer days
          </button>
          <button
            className="button secondary small"
            disabled={!catalog?.hasMore}
            onClick={() => setOffset(offset + 50)}
          >
            Older days
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!access && !error && (
        <p className="community-loading">Checking dismissal access…</p>
      )}
      {access && !access.units.length && (
        <Panel title="School dismissal">
          <Empty
            title="No dismissal assignment"
            detail="The school office can assign staff to a dismissal unit. Classroom and workforce roles do not automatically grant release access."
          />
        </Panel>
      )}
      {catalog && !runId && (
        <Panel title="Prepare for dismissal">
          <Empty
            title={
              catalog.policy.confirmed
                ? "Ready to open a school day"
                : "Dismissal instructions need confirmation"
            }
            detail={
              office
                ? "Use Dismissal setup to confirm the school’s instructions and assign staff. Open today to capture the dated school roster, then review each child’s pickup or bus plan."
                : "The school office opens the day and sets reviewed plans before dismissal begins."
            }
          />
        </Panel>
      )}
      {detail && (
        <>
          <div className="dismissal-stats">
            {[
              ["expected", "Expected"],
              ["unaccounted", "Not accounted for"],
              ["present", "Here"],
              ["called", "Called"],
              ["released", "Handed off"],
              ["absent", "Not at dismissal"],
            ].map(([key, label]) => (
              <div key={key}>
                <strong>{detail.counts[key]}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {detail.counts.inCare > 0 && (
            <p className="panel-note">
              {detail.counts.inCare} of these completed handoffs went to
              childcare. Receiving staff and care-session records are linked
              below.
            </p>
          )}
          <div className="care-instructions">
            <ShieldCheck size={22} />
            <div>
              <strong>Reviewed instructions for {detail.run.day}</strong>
              <p>{detail.run.policy_snapshot.instructions}</p>
              <small>
                Policy version {detail.run.policy_snapshot.version} · Updated{" "}
                {DateTime.fromISO(detail.asOf)
                  .setZone(detail.timezone)
                  .toFormat("h:mm:ss a")}{" "}
                · {detail.timezone}
              </small>
            </div>
            <Badge tone={detail.run.status === "closed" ? "green" : "amber"}>
              {detail.run.status === "closed" ? "Day closed" : "Day open"}
            </Badge>
          </div>
          {!detail.rosterCurrent && (
            <div className="dismissal-warning" role="alert">
              <strong>School enrollment changed</strong>
              <p>
                The expected roster needs office review. Existing handoffs are
                preserved. Children still marked here must be accounted for
                before they can be removed.
              </p>
              {office && open && (
                <button
                  className="button secondary"
                  onClick={() => setDialog({ kind: "reconcile" })}
                >
                  Review roster changes
                </button>
              )}
            </div>
          )}
          <nav className="school-tabs" aria-label="Dismissal views">
            {[
              ["children", "Children & queue"],
              ["buses", "Bus arrivals"],
              ...(office ? [["review", "Office closeout"]] : []),
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
          {tab === "children" && (
            <Panel
              title="Children & queue"
              detail="Use Mark here only when the child is physically with staff. Calling a child does not record a release."
              action={
                office && open ? (
                  <button
                    className="button secondary"
                    disabled={!selected.length || !detail.rosterCurrent}
                    onClick={() =>
                      setDialog({
                        kind: "plan",
                        entries: detail.entries.filter((r: any) =>
                          selected.includes(r.student_id),
                        ),
                      })
                    }
                  >
                    Set plan for {selected.length} selected
                  </button>
                ) : undefined
              }
            >
              <div className="dismissal-filter">
                <label>
                  Find a child
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name, number or grade"
                  />
                </label>
                <label>
                  Status
                  <select
                    aria-label="Dismissal status filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {Object.entries(labels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dismissal-children">
                {visible.map((e: any) => {
                  const bus = detail.buses.find((b: any) => b.id === e.bus_id),
                    care = detail.carePrograms.find(
                      (p: any) => p.id === e.care_program_id,
                    ),
                    transfer = detail.transfers.find(
                      (t: any) =>
                        t.student_id === e.student_id && t.status === "pending",
                    ),
                    canPlan =
                      office &&
                      open &&
                      !transfer &&
                      !["released", "absent"].includes(e.status);
                  return (
                    <article key={e.student_id}>
                      {canPlan && (
                        <input
                          type="checkbox"
                          aria-label={"Select " + e.student_name}
                          checked={selected.includes(e.student_id)}
                          onChange={(ev) =>
                            setSelected((ids) =>
                              ev.target.checked
                                ? [...ids, e.student_id]
                                : ids.filter((id) => id !== e.student_id),
                            )
                          }
                        />
                      )}
                      <Avatar name={e.student_name} />
                      <div className="dismissal-child-name">
                        <strong>{e.student_name}</strong>
                        <small>
                          {e.student_number} · {e.grade_level}
                        </small>
                        <span>
                          {e.mode === "bus" ? (
                            <>
                              <Bus size={13} /> {bus?.name}
                            </>
                          ) : e.mode === "pickup" ? (
                            "Authorized adult pickup"
                          ) : e.mode === "care" ? (
                            `Childcare · ${care?.name ?? e.release_snapshot?.programName ?? "Assigned program"}`
                          ) : (
                            "Plan not set"
                          )}
                        </span>
                        {e.status === "released" && (
                          <small>
                            {e.release_snapshot?.name ??
                              e.release_snapshot?.busName ??
                              e.release_snapshot?.receiverName}{" "}
                            ·{" "}
                            {DateTime.fromISO(e.released_at)
                              .setZone(detail.timezone)
                              .toFormat("h:mm a")}
                          </small>
                        )}
                        {e.status === "absent" && (
                          <small>{e.absence_reason}</small>
                        )}
                        {transfer && (
                          <small>
                            Awaiting care receipt · Requested by{" "}
                            {transfer.requester_name}. Child remains with
                            dismissal staff.
                          </small>
                        )}
                      </div>
                      <Badge
                        tone={
                          e.status === "released"
                            ? "green"
                            : e.status === "unaccounted"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {e.status === "released" && e.mode === "care"
                          ? "Received by care"
                          : labels[e.status]}
                      </Badge>
                      <div className="dismissal-actions">
                        {open && (
                          <>
                            {(e.status === "unaccounted" ||
                              (office && e.status === "absent")) && (
                              <button
                                className="button small"
                                disabled={busy || !detail.rosterCurrent}
                                onClick={() => void here(e)}
                              >
                                Mark here
                              </button>
                            )}
                            {e.status === "present" &&
                              !transfer &&
                              e.mode !== "care" && (
                                <button
                                  className="button small"
                                  disabled={!e.mode || !detail.rosterCurrent}
                                  onClick={() =>
                                    setDialog({ kind: "call", entry: e, bus })
                                  }
                                >
                                  Arrival / call
                                </button>
                              )}
                            {e.status === "present" &&
                              e.mode === "care" &&
                              !transfer && (
                                <button
                                  className="button small"
                                  disabled={
                                    !detail.rosterCurrent ||
                                    !care?.confirmed ||
                                    care.archived
                                  }
                                  onClick={() =>
                                    setDialog({
                                      kind: "care_request",
                                      entry: e,
                                      care,
                                    })
                                  }
                                >
                                  Request care handoff
                                </button>
                              )}
                            {transfer && (
                              <button
                                className="button secondary small"
                                onClick={() =>
                                  setDialog({
                                    kind: "care_cancel",
                                    entry: e,
                                    transfer,
                                  })
                                }
                              >
                                Cancel care request
                              </button>
                            )}
                            {e.status === "called" && (
                              <>
                                <button
                                  className="button small"
                                  disabled={!detail.rosterCurrent}
                                  onClick={() =>
                                    setDialog({
                                      kind: "release",
                                      entry: e,
                                      bus,
                                    })
                                  }
                                >
                                  {e.mode === "bus"
                                    ? "Verify boarding"
                                    : "Verify pickup"}
                                </button>
                                <button
                                  className="button secondary small"
                                  onClick={() =>
                                    setDialog({ kind: "cancel_call", entry: e })
                                  }
                                >
                                  Cancel call
                                </button>
                              </>
                            )}
                            {office &&
                              !transfer &&
                              ["unaccounted", "present"].includes(e.status) && (
                                <button
                                  className="text-link"
                                  onClick={() =>
                                    setDialog({ kind: "absent", entry: e })
                                  }
                                >
                                  Not at dismissal
                                </button>
                              )}
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {!visible.length && (
                <Empty
                  title="No children match this view"
                  detail="Change the search or status filter to see other children."
                />
              )}
            </Panel>
          )}
          {tab === "buses" && (
            <Panel
              title="Bus arrivals & manifests"
              detail="The office records the driver and vehicle. Staff verify the actual arrival before any children are called or boarded."
              action={
                office && open ? (
                  <button
                    className="button"
                    onClick={() => setDialog({ kind: "bus" })}
                  >
                    <Plus size={16} />
                    Add bus
                  </button>
                ) : undefined
              }
            >
              <div className="dismissal-buses">
                {detail.buses.map((b: any) => {
                  const manifest = rows.filter((e: any) => e.bus_id === b.id);
                  return (
                    <article key={b.id}>
                      <div className="dismissal-bus-heading">
                        <Bus />
                        <div>
                          <h3>{b.name}</h3>
                          <p>
                            {b.driver_name} · {b.vehicle}
                          </p>
                        </div>
                        <Badge tone={b.arrived_at ? "green" : "amber"}>
                          {b.arrived_at
                            ? "Arrival verified"
                            : "Awaiting arrival"}
                        </Badge>
                      </div>
                      <p>
                        {
                          manifest.filter((e: any) => e.status === "released")
                            .length
                        }{" "}
                        boarded · {manifest.length} assigned
                      </p>
                      <div className="dismissal-manifest">
                        {manifest.map((e: any) => (
                          <span key={e.student_id}>
                            {e.student_name}
                            <Badge
                              tone={
                                e.status === "released" ? "green" : "neutral"
                              }
                            >
                              {labels[e.status]}
                            </Badge>
                          </span>
                        ))}
                      </div>
                      <div className="care-actions">
                        {open && !b.arrived_at && (
                          <button
                            className="button"
                            onClick={() =>
                              setDialog({ kind: "bus_arrival", bus: b })
                            }
                          >
                            Verify bus arrival
                          </button>
                        )}
                        {office &&
                          open &&
                          !manifest.some(
                            (e: any) => e.status === "released",
                          ) && (
                            <button
                              className="button secondary"
                              onClick={() => setDialog({ kind: "bus", bus: b })}
                            >
                              Edit route
                            </button>
                          )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {!detail.buses.length && (
                <Empty
                  title="No buses recorded"
                  detail="The office can add a route, then assign children’s daily plans from the queue."
                />
              )}
            </Panel>
          )}
          {tab === "review" && office && (
            <Panel
              title="Office closeout"
              detail="A day cannot close while any expected child remains unaccounted for, present, or called."
            >
              <div className="dismissal-review">
                <ClipboardCheck size={28} />
                <div>
                  <h3>
                    {detail.counts.unaccounted +
                      detail.counts.present +
                      detail.counts.called}{" "}
                    children still need resolution
                  </h3>
                  <p>
                    {detail.counts.released} released · {detail.counts.absent}{" "}
                    verified not at dismissal · {detail.counts.expected}{" "}
                    expected.
                  </p>
                  <p>
                    {detail.rosterCurrent
                      ? "School enrollment matches the captured roster."
                      : "School enrollment differs from the captured roster."}
                  </p>
                </div>
              </div>
              <div className="dismissal-review-actions">
                <button
                  className="button"
                  disabled={
                    detail.run.status === "open"
                      ? !detail.rosterCurrent ||
                        detail.counts.unaccounted +
                          detail.counts.present +
                          detail.counts.called >
                          0
                      : detail.run.day !== today
                  }
                  onClick={() =>
                    setDialog({
                      kind: "review",
                      action: detail.run.status === "open" ? "close" : "reopen",
                    })
                  }
                >
                  {detail.run.status === "open"
                    ? "Review & close day"
                    : "Reopen today"}
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    void download(
                      "/dismissal/runs/" + runId + "/export",
                      "school-dismissal.csv",
                    ).catch((e) => notify(e.message, true))
                  }
                >
                  <Download size={16} />
                  Export dismissal
                </button>
              </div>
              <div className="dismissal-closures">
                <h3>Preserved closeouts</h3>
                {detail.closures.map((c: any) => (
                  <button
                    className="button secondary"
                    key={c.id}
                    onClick={() =>
                      setDialog({ kind: "closure", closureId: c.id })
                    }
                  >
                    {DateTime.fromISO(c.created_at)
                      .setZone(detail.timezone)
                      .toFormat("LLL d, h:mm a")}{" "}
                    · version {c.run_version}
                  </button>
                ))}
                {!detail.closures.length && (
                  <p>No closeout has been recorded yet.</p>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
      {dialog && (
        <DismissalDialog
          key={dialog.kind + (dialog.entry?.student_id ?? dialog.bus?.id ?? "")}
          dialog={dialog}
          unitId={unitId}
          catalog={catalog}
          detail={detail}
          today={today}
          onClose={close}
          onDirty={markDirty}
          onSaved={saved}
        />
      )}
    </div>
  );
}
function DismissalDialog({
  dialog,
  unitId,
  catalog,
  detail,
  today,
  onClose,
  onDirty,
  onSaved,
}: {
  dialog: any;
  unitId: string;
  catalog: any;
  detail: any;
  today: string;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onSaved: (result: any) => Promise<void>;
}) {
  const { kind, entry, bus } = dialog,
    policy = catalog?.policy;
  const [form, setForm] = useState<any>({
      instructions: policy?.instructions ?? "",
      staffIds: policy?.staff.map((s: any) => s.user_id) ?? [],
      confirmed: false,
      reason: "",
      yearId:
        catalog?.years.find(
          (y: any) => !y.archived && y.starts_on <= today && y.ends_on >= today,
        )?.id ?? "",
      mode: "",
      busId: "",
      careProgramId: "",
      observed: false,
      name: bus?.name ?? "",
      driverName: bus?.driver_name ?? "",
      vehicle: bus?.vehicle ?? "",
      contactId: kind === "release" ? (entry?.called_contact_id ?? "") : "",
      identityMethod: "",
      identityConfirmed: false,
      vehicleConfirmed: false,
      arrivalObserved: false,
      released: false,
      boarded: false,
      verified: false,
      reviewed: false,
      note: "",
    }),
    [pickup, setPickup] = useState<any>(null),
    [closure, setClosure] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [commandId] = useState(() => crypto.randomUUID());
  const set = (key: string, value: any) => {
      setForm((f: any) => ({ ...f, [key]: value }));
      onDirty(true);
    },
    path = "/dismissal/runs/" + detail?.run.id;
  useEffect(() => {
    let active = true;
    if (["call", "release"].includes(kind))
      void api(path + "/entries/" + entry.student_id + "/pickup")
        .then((r) => {
          if (active) setPickup(r);
        })
        .catch((e) => {
          if (active) setLoadError(e.message);
        });
    if (kind === "closure")
      void api(path + "/closures/" + dialog.closureId)
        .then((r) => {
          if (active) setClosure(r);
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
      if (kind === "settings")
        result = await api(
          "/dismissal/settings",
          {
            unitId,
            version: policy.version,
            confirmed: form.confirmed,
            instructions: form.instructions,
            staffIds: form.staffIds,
            reason: form.reason,
          },
          "PUT",
        );
      if (kind === "open")
        result = await api("/dismissal/runs", {
          unitId,
          yearId: form.yearId,
          day: today,
          settingsVersion: policy.version,
          commandId,
        });
      if (kind === "plan")
        result = await api(path + "/plans", {
          entries: dialog.entries.map((e: any) => ({
            studentId: e.student_id,
            version: e.version,
          })),
          mode: form.mode,
          busId: form.mode === "bus" ? form.busId : null,
          careProgramId: form.mode === "care" ? form.careProgramId : null,
          reason: form.reason,
        });
      if (kind === "care_request")
        result = await api(
          path + "/entries/" + entry.student_id + "/care-transfer",
          {
            version: entry.version,
            programVersion: dialog.care.version,
            observed: form.observed,
            reason: form.reason,
            commandId,
          },
        );
      if (kind === "care_cancel")
        result = await api(
          "/care/transfers/" + dialog.transfer.id + "/decision",
          {
            action: "cancel",
            version: dialog.transfer.version,
            reason: form.reason,
            commandId,
          },
        );
      if (kind === "bus")
        result = await api(
          path + "/buses" + (bus ? "/" + bus.id : ""),
          {
            name: form.name,
            driverName: form.driverName,
            vehicle: form.vehicle,
            version: bus?.version ?? 0,
            reason: form.reason,
          },
          bus ? "PATCH" : "POST",
        );
      if (kind === "bus_arrival")
        result = await api(path + "/buses/" + bus.id + "/arrival", {
          version: bus.version,
          identityMethod: form.identityMethod,
          identityConfirmed: form.identityConfirmed,
          vehicleConfirmed: form.vehicleConfirmed,
          commandId,
        });
      if (kind === "reconcile")
        result = await api(path + "/reconcile", {
          version: detail.run.version,
          reason: form.reason,
        });
      if (kind === "review")
        result = await api(path + "/review", {
          version: detail.run.version,
          action: dialog.action,
          rosterFingerprint: detail.rosterFingerprint,
          reason: form.reason,
          reviewed: form.reviewed,
        });
      if (["call", "release", "cancel_call", "absent"].includes(kind)) {
        let action: any = { action: kind, version: entry.version, commandId };
        if (kind === "call")
          action = {
            ...action,
            arrivalObserved: form.arrivalObserved,
            ...(entry.mode === "pickup" ? { contactId: form.contactId } : {}),
          };
        if (kind === "cancel_call") action = { ...action, reason: form.reason };
        if (kind === "absent")
          action = { ...action, reason: form.reason, verified: form.verified };
        if (kind === "release") {
          if (entry.mode === "pickup") {
            const c = pickup.contacts.find(
              (c: any) => c.person_id === entry.called_contact_id,
            );
            action = {
              ...action,
              action: "release_pickup",
              contactId: c?.person_id,
              contactVersion: c?.version,
              personVersion: c?.person_version,
              identityMethod: form.identityMethod,
              identityConfirmed: form.identityConfirmed,
              released: form.released,
              note: form.note,
            };
          } else
            action = {
              ...action,
              action: "release_bus",
              busVersion: bus.version,
              boarded: form.boarded,
              note: form.note,
            };
        }
        result = await api(
          path + "/entries/" + entry.student_id + "/action",
          action,
        );
      }
      await onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const titles: Record<string, string> = {
    settings: "Dismissal setup",
    open: "Open today’s dismissal",
    plan: "Review selected children’s plans",
    bus: bus ? "Edit bus route" : "Add a bus route",
    bus_arrival: "Verify bus arrival",
    reconcile: "Review enrollment changes",
    review:
      dialog.action === "close"
        ? "Review & close dismissal"
        : "Reopen today’s dismissal",
    call: "Observe arrival & call",
    release:
      entry?.mode === "bus" ? "Verify child boarding" : "Verify child pickup",
    absent: "Confirm child is not at dismissal",
    cancel_call: "Cancel the call",
    closure: "Preserved dismissal closeout",
    care_request: "Request a care handoff",
    care_cancel: "Cancel pending care handoff",
  };
  const blocked = pickup && (pickup.hold.active || pickup.restricted),
    calledContact = pickup?.contacts.find(
      (c: any) => c.person_id === entry?.called_contact_id,
    ),
    busChanged =
      kind === "release" &&
      entry?.mode === "bus" &&
      (!bus?.arrived_at || entry.call_snapshot?.busVersion !== bus.version);
  return (
    <Modal
      title={titles[kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {kind === "closure" ? (
        <div className="care-form">
          {loadError && <p className="error">{loadError}</p>}
          {closure ? (
            <>
              <p>{closure.reason}</p>
              <p>
                Version {closure.run_version} ·{" "}
                {closure.snapshot.counts.expected} expected ·{" "}
                {closure.snapshot.counts.released} released ·{" "}
                {closure.snapshot.counts.absent} not at dismissal.
              </p>
              <div className="dismissal-snapshot">
                {closure.snapshot.entries.map((e: any) => (
                  <div key={e.student_id}>
                    <strong>{e.student_name}</strong>
                    <span>
                      {e.expected
                        ? e.status === "released" && e.mode === "care"
                          ? "Received by care"
                          : labels[e.status]
                        : "Removed from expected roster"}
                    </span>
                    <small>
                      {e.release_snapshot?.name ??
                        e.release_snapshot?.busName ??
                        e.release_snapshot?.programName ??
                        e.absence_reason}
                    </small>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p>Opening preserved evidence…</p>
          )}
          <button className="button secondary" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
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
          {kind === "settings" && (
            <>
              <label>
                Dismissal instructions
                <textarea
                  required
                  minLength={5}
                  maxLength={3000}
                  value={form.instructions}
                  onChange={(e) => set("instructions", e.target.value)}
                />
              </label>
              <fieldset>
                <legend>Staff with dismissal access</legend>
                <p>
                  Selected staff can see the unit’s dismissal roster and record
                  verified handoffs.
                </p>
                {catalog.staff.map((s: any) => (
                  <label key={s.id} className="care-check">
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
                The school has reviewed these instructions and staff
                assignments.
              </label>
              <p>
                New days capture these instructions. Access changes apply to
                existing days immediately.
              </p>
            </>
          )}
          {kind === "open" && (
            <>
              <p>
                Capture all dated school enrollment for {today}. Children start
                unaccounted for; staff must confirm presence or the office must
                resolve why they are not at dismissal.
              </p>
              <label>
                School year
                <select
                  required
                  aria-label="Dismissal school year"
                  value={form.yearId}
                  onChange={(e) => set("yearId", e.target.value)}
                >
                  <option value="">Choose the current school year</option>
                  {catalog.years
                    .filter(
                      (y: any) =>
                        !y.archived &&
                        y.starts_on <= today &&
                        y.ends_on >= today,
                    )
                    .map((y: any) => (
                      <option key={y.id} value={y.id}>
                        {y.name}
                      </option>
                    ))}
                </select>
              </label>
              <p>{policy.instructions}</p>
            </>
          )}
          {kind === "plan" && (
            <>
              <p>
                {dialog.entries.length} selected:{" "}
                {dialog.entries.map((e: any) => e.student_name).join(", ")}
              </p>
              <label>
                Dismissal method
                <select
                  required
                  aria-label="Dismissal method"
                  value={form.mode}
                  onChange={(e) => set("mode", e.target.value)}
                >
                  <option value="">Choose the reviewed plan</option>
                  <option value="pickup">Authorized adult pickup</option>
                  <option value="bus">Assigned school bus</option>
                  <option value="care">Receiving childcare program</option>
                </select>
              </label>
              {form.mode === "bus" && (
                <label>
                  Assigned bus
                  <select
                    required
                    aria-label="Assigned bus"
                    value={form.busId}
                    onChange={(e) => set("busId", e.target.value)}
                  >
                    <option value="">Choose a bus route</option>
                    {detail.buses.map((b: any) => (
                      <option key={b.id} value={b.id}>
                        {b.name} · {b.vehicle}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.mode === "care" && (
                <label>
                  Receiving care program
                  <select
                    required
                    aria-label="Receiving care program"
                    value={form.careProgramId}
                    onChange={(e) => set("careProgramId", e.target.value)}
                  >
                    <option value="">Choose a confirmed program</option>
                    {detail.carePrograms
                      .filter((p: any) => p.confirmed && !p.archived)
                      .map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.room}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {form.mode === "care" && (
                <p>
                  Every selected child needs a current enrollment in this
                  program. Receiving care staff must confirm the handoff in a
                  different account.
                </p>
              )}
              <p>
                Changing a called child’s plan returns them to “Here with
                staff”; arrival must be confirmed again.
              </p>
            </>
          )}
          {kind === "bus" && (
            <>
              <label>
                Bus / route name
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </label>
              <label>
                Approved driver name
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={form.driverName}
                  onChange={(e) => set("driverName", e.target.value)}
                />
              </label>
              <label>
                Vehicle identification
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="School-approved bus number or identifier"
                  value={form.vehicle}
                  onChange={(e) => set("vehicle", e.target.value)}
                />
              </label>
              {bus && (
                <p>
                  Changing this record clears its arrival verification. Staff
                  must verify the new driver and vehicle before boarding.
                </p>
              )}
            </>
          )}
          {kind === "bus_arrival" && (
            <>
              <p>
                <strong>{bus.name}</strong>
                <br />
                {bus.driver_name} · {bus.vehicle}
              </p>
              <IdentityFields form={form} set={set} />
              <label className="care-check">
                <input
                  required
                  type="checkbox"
                  checked={form.vehicleConfirmed}
                  onChange={(e) => set("vehicleConfirmed", e.target.checked)}
                />
                I verified that the arriving vehicle matches this approved bus
                record.
              </label>
            </>
          )}
          {["call", "release"].includes(kind) && (
            <>
              <p>
                <strong>{entry.student_name}</strong> · {entry.student_number}
              </p>
              {!pickup && !loadError && (
                <p>Checking current release restrictions…</p>
              )}
              {blocked && (
                <div className="care-block" role="alert">
                  <ShieldCheck />
                  <div>
                    <strong>Stop — office review required</strong>
                    <p>
                      {pickup.hold.active
                        ? pickup.hold.reason
                        : "A contact restriction is recorded."}
                    </p>
                    {pickup.contacts
                      .filter((c: any) => c.restriction_note)
                      .map((c: any) => (
                        <p key={c.person_id}>
                          {c.name}: {c.restriction_note}
                        </p>
                      ))}
                  </div>
                </div>
              )}
              {pickup && !blocked && (
                <>
                  {entry.mode === "pickup" ? (
                    kind === "call" ? (
                      <label>
                        Arriving pickup person
                        <select
                          required
                          aria-label="Arriving pickup person"
                          value={form.contactId}
                          onChange={(e) => set("contactId", e.target.value)}
                        >
                          <option value="">
                            Choose a currently permitted person
                          </option>
                          {pickup.contacts
                            .filter((c: any) => c.eligible)
                            .map((c: any) => (
                              <option key={c.person_id} value={c.person_id}>
                                {c.name} · {c.relationship}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : (
                      <>
                        <p>
                          Called for:{" "}
                          <strong>
                            {calledContact?.name ??
                              "Contact no longer available"}
                          </strong>
                        </p>
                        {!calledContact?.eligible ? (
                          <p className="error" role="alert">
                            This person is no longer cleared for pickup. Keep
                            the child with staff and contact the office.
                          </p>
                        ) : (
                          <>
                            <IdentityFields form={form} set={set} />
                            <label className="care-check">
                              <input
                                required
                                type="checkbox"
                                checked={form.released}
                                onChange={(e) =>
                                  set("released", e.target.checked)
                                }
                              />
                              I am handing this child to this verified person
                              now.
                            </label>
                          </>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      <p>
                        <strong>{bus?.name}</strong>
                        <br />
                        {bus?.driver_name} · {bus?.vehicle}
                      </p>
                      {!bus?.arrived_at || busChanged ? (
                        <p className="error" role="alert">
                          The bus arrival needs verification or has changed.
                          Cancel any existing call and verify the current bus.
                        </p>
                      ) : (
                        kind === "release" && (
                          <label className="care-check">
                            <input
                              required
                              type="checkbox"
                              checked={form.boarded}
                              onChange={(e) => set("boarded", e.target.checked)}
                            />
                            I witnessed this child board this verified bus.
                          </label>
                        )
                      )}
                    </>
                  )}
                  {kind === "call" && (
                    <label className="care-check">
                      <input
                        required
                        type="checkbox"
                        checked={form.arrivalObserved}
                        onChange={(e) =>
                          set("arrivalObserved", e.target.checked)
                        }
                      />
                      The pickup person or assigned bus has arrived. Call this
                      child for handoff.
                    </label>
                  )}
                </>
              )}
              {kind === "release" && (
                <label>
                  Handoff note (optional)
                  <textarea
                    maxLength={1000}
                    value={form.note}
                    onChange={(e) => set("note", e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          {kind === "absent" && (
            <>
              <p>
                <strong>{entry.student_name}</strong>
              </p>
              <p>
                This records why the child is not part of this dismissal. It
                does not change classroom attendance or record a pickup.
              </p>
              <label className="care-check">
                <input
                  required
                  type="checkbox"
                  checked={form.verified}
                  onChange={(e) => set("verified", e.target.checked)}
                />
                I verified that this child is not waiting with dismissal staff
                and recorded the reason below.
              </label>
            </>
          )}
          {kind === "care_request" && (
            <>
              <p>
                <strong>{entry.student_name}</strong> → {dialog.care.name} ·{" "}
                {dialog.care.room}
              </p>
              <p>{dialog.care.instructions}</p>
              <p>
                This request keeps the child in dismissal. Receiving care staff
                must sign in to Childcare and confirm physical receipt.
              </p>
              <label className="care-check">
                <input
                  required
                  type="checkbox"
                  checked={form.observed}
                  onChange={(e) => set("observed", e.target.checked)}
                />
                The child is here with dismissal staff and ready for this care
                handoff.
              </label>
            </>
          )}
          {kind === "care_cancel" && (
            <p>
              Cancel the request for {entry.student_name}. The child remains
              with dismissal staff; this does not record a pickup or an absence.
            </p>
          )}
          {kind === "cancel_call" && (
            <p>
              Return {entry.student_name} to “Here with staff”. Keep the child
              supervised while the plan is reviewed.
            </p>
          )}
          {kind === "reconcile" && (
            <p>
              Refresh the expected roster from dated school enrollment. New
              children begin unaccounted for. Removed records and all handoff
              evidence stay in the history. Any removed child still marked here
              must be resolved first.
            </p>
          )}
          {kind === "review" && (
            <>
              <p>
                {detail.counts.expected} expected · {detail.counts.released}{" "}
                released · {detail.counts.absent} verified not at dismissal.
              </p>
              <label className="care-check">
                <input
                  required
                  type="checkbox"
                  checked={form.reviewed}
                  onChange={(e) => set("reviewed", e.target.checked)}
                />
                {dialog.action === "close"
                  ? "I reviewed every child and the current school roster before closing."
                  : "I reviewed the reason to reopen today. Earlier handoff and closeout evidence must remain unchanged."}
              </label>
            </>
          )}
          {[
            "settings",
            "plan",
            "bus",
            "absent",
            "cancel_call",
            "reconcile",
            "review",
            "care_request",
            "care_cancel",
          ].includes(kind) && (
            <label>
              Reason for this record
              <textarea
                aria-label="Reason for this record"
                required
                minLength={5}
                maxLength={1000}
                value={form.reason}
                onChange={(e) => set("reason", e.target.value)}
              />
            </label>
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
                (["call", "release"].includes(kind) && (!pickup || blocked)) ||
                (kind === "release" &&
                  entry.mode === "pickup" &&
                  !calledContact?.eligible) ||
                (["call", "release"].includes(kind) &&
                  entry.mode === "bus" &&
                  (!bus?.arrived_at || busChanged))
              }
            >
              {busy
                ? "Saving…"
                : kind === "care_request"
                  ? "Send care request"
                  : kind === "care_cancel"
                    ? "Cancel handoff request"
                    : kind === "call"
                      ? "Call child"
                      : kind === "release"
                        ? "Confirm handoff"
                        : kind === "bus_arrival"
                          ? "Confirm bus arrival"
                          : kind === "open"
                            ? "Open dismissal"
                            : "Save record"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function IdentityFields({
  form,
  set,
}: {
  form: any;
  set: (key: string, value: any) => void;
}) {
  return (
    <>
      <label>
        How did you verify identity?
        <select
          required
          aria-label="Identity verification"
          value={form.identityMethod}
          onChange={(e) => set("identityMethod", e.target.value)}
        >
          <option value="">Choose a verification method</option>
          <option value="photo_id">Photo ID checked</option>
          <option value="personally_known">Personally known to me</option>
        </select>
      </label>
      <label className="care-check">
        <input
          required
          type="checkbox"
          checked={form.identityConfirmed}
          onChange={(e) => set("identityConfirmed", e.target.checked)}
        />
        I verified the identity of this named person.
      </label>
    </>
  );
}
