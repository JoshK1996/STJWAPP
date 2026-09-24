import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Building2,
  ChevronRight,
  History,
  Layers3,
  Pencil,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import { unitKinds, unitKindLabels } from "../shared/organization";
import "./organization.css";
const kindLabel = (kind: keyof typeof unitKindLabels) => unitKindLabels[kind];
export default function Organization({
  timezone,
  onChange,
  notify,
}: {
  timezone: string;
  onChange: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<any>(null),
    [selectedId, setSelectedId] = useState(""),
    [search, setSearch] = useState(""),
    [dialog, setDialog] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [error, setError] = useState("");
  async function refresh(id?: string) {
    const result = await api("/organization/structure");
    setData(result);
    if (id) setSelectedId(id);
    else setSelectedId((current) => current || result.units[0]?.id || "");
  }
  useEffect(() => {
    let active = true;
    void api("/organization/structure")
      .then((result) => {
        if (active) {
          setData(result);
          setSelectedId(result.units[0]?.id || "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const selected = data?.units.find((x: any) => x.id === selectedId),
    units = data?.units ?? [];
  const ordered: any[] = [];
  function branch(parent: string | null) {
    for (const row of units.filter((x: any) => x.parent_id === parent)) {
      ordered.push(row);
      branch(row.id);
    }
  }
  branch(null);
  const visible = ordered.filter((x) =>
    x.path.join(" / ").toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <Panel
      title="Schools, programs & teams"
      detail="A clear home for every part of your organization."
      className="organization-panel"
      action={
        <button
          className="button primary"
          disabled={!data}
          onClick={() =>
            setDialog({ type: "edit", initial: null, parentId: null })
          }
        >
          <Plus size={17} />
          Add unit
        </button>
      }
    >
      <div className="organization-intro">
        <span className="organization-mark" aria-hidden="true">
          <Building2 size={31} />
          <Layers3 size={23} />
        </span>
        <div>
          <h3>One community. Clearly organized.</h3>
          <p>
            Build schools, programs and departments into a structure your staff
            can follow.
          </p>
          <p className="organization-permission">
            <ShieldCheck size={16} />
            Manager access requires an explicit assignment to each unit and
            subgroup.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p className="padded-form">Loading organization structure…</p>
      ) : (
        <div className="organization-workspace">
          <div className="organization-directory">
            <label>
              Find a school or team
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the structure"
              />
            </label>
            <nav aria-label="Organization units">
              {visible.map((row) => (
                <button
                  key={row.id}
                  aria-current={selectedId === row.id ? "true" : undefined}
                  onClick={() => setSelectedId(row.id)}
                  style={{
                    paddingInlineStart: `${12 + Math.min(row.path.length - 1, 4) * 13}px`,
                  }}
                >
                  <Building2 size={17} />
                  <span>
                    <strong>{row.name}</strong>
                    <small>
                      {kindLabel(row.kind)}
                      {row.path.length > 1
                        ? ` · Level ${row.path.length}`
                        : " · Top level"}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </nav>
            {!visible.length && <p>No matching units.</p>}
          </div>
          {selected ? (
            <div className="organization-detail">
              <p className="organization-path">{selected.path.join(" / ")}</p>
              <Badge tone="outline">{kindLabel(selected.kind)}</Badge>
              <h3>{selected.name}</h3>
              <p>
                {selected.description ||
                  "Add a description to help staff understand this unit’s purpose."}
              </p>
              <div className="organization-counts">
                <div>
                  <strong>{selected.staff_count}</strong>
                  <span>directly assigned active staff</span>
                </div>
                <div>
                  <strong>{selected.job_count}</strong>
                  <span>active jobs in this unit</span>
                </div>
                <div>
                  <strong>
                    {
                      units.filter((x: any) => x.parent_id === selected.id)
                        .length
                    }
                  </strong>
                  <span>direct subgroups</span>
                </div>
              </div>
              <div className="organization-actions">
                <button
                  className="button secondary"
                  onClick={() => setDialog({ type: "edit", initial: selected })}
                >
                  <Pencil size={16} />
                  Edit unit
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    setDialog({
                      type: "edit",
                      initial: null,
                      parentId: selected.id,
                    })
                  }
                >
                  <Plus size={16} />
                  Add subgroup
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setError("");
                    void api(`/organization/units/${selected.id}/history`)
                      .then((result) => {
                        setHistory(result.rows);
                        setDialog({ type: "history", name: selected.name });
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  <History size={16} />
                  Unit history
                </button>
              </div>
              <p className="school-notice">
                Assign accounts and jobs in People & jobs. School-office,
                classroom, care and dismissal permissions are configured
                separately. Creating or moving a unit grants no access.
              </p>
              <small>
                Uses the organization time zone: {timezone}. Unit version{" "}
                {selected.version}.
              </small>
            </div>
          ) : (
            <Empty
              title="Choose a unit"
              detail="Select a school, program or team to review its place in the organization."
            />
          )}
        </div>
      )}
      {dialog?.type === "edit" && (
        <UnitForm
          initial={dialog.initial}
          parentId={dialog.parentId}
          units={units}
          timezone={timezone}
          onClose={() => setDialog(null)}
          onSaved={async (id) => {
            setDialog(null);
            await refresh(id);
            await onChange();
            notify(
              "Organization structure saved. Explicit account assignments are unchanged.",
            );
          }}
        />
      )}
      {dialog?.type === "history" && (
        <Modal
          title={`Unit history · ${dialog.name}`}
          onClose={() => setDialog(null)}
        >
          <div className="organization-history">
            <p>
              Latest 100 retained changes. Historical reports may display
              today’s unit name; these records preserve the original labels and
              hierarchy.
            </p>
            {history.length ? (
              history.map((row) => (
                <article key={row.id}>
                  <h3>Unit version {row.unit_version}</h3>
                  <small>
                    {row.actor_name} ·{" "}
                    {new Date(row.created_at).toLocaleString()}
                  </small>
                  <p>{row.snapshot.reason}</p>
                  <dl>
                    <dt>Previous name / parent</dt>
                    <dd>
                      {row.snapshot.before?.name ?? "New unit"} /{" "}
                      {row.snapshot.beforePath?.join(" / ") ?? "New unit"}
                    </dd>
                    <dt>Saved name / parent</dt>
                    <dd>
                      {row.snapshot.after.name} /{" "}
                      {row.snapshot.afterPath.join(" / ")}
                    </dd>
                    <dt>Description</dt>
                    <dd>
                      {row.snapshot.before?.description || "None"} →{" "}
                      {row.snapshot.after.description || "None"}
                    </dd>
                    <dt>Kind</dt>
                    <dd>
                      {row.snapshot.before
                        ? kindLabel(row.snapshot.before.kind)
                        : "New unit"}{" "}
                      → {kindLabel(row.snapshot.after.kind)}
                    </dd>
                  </dl>
                </article>
              ))
            ) : (
              <p>No edits have been recorded for this original unit.</p>
            )}
          </div>
        </Modal>
      )}
    </Panel>
  );
}
function UnitForm({
  initial,
  parentId,
  units,
  timezone,
  onClose,
  onSaved,
}: {
  initial: any;
  parentId?: string | null;
  units: any[];
  timezone: string;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [id] = useState(initial?.id ?? crypto.randomUUID()),
    [name, setName] = useState(initial?.name ?? ""),
    [kind, setKind] = useState(initial?.kind ?? ""),
    [parent, setParent] = useState(initial?.parent_id ?? parentId ?? ""),
    [description, setDescription] = useState(initial?.description ?? ""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const command = useRef(crypto.randomUUID()),
    generation = useRef(0);
  const input = {
    id,
    expectedVersion: initial?.version ?? 0,
    name,
    kind,
    parentId: parent || null,
    description,
    reason,
  };
  function change(fn: () => void) {
    fn();
    setDirty(true);
    setPreview(null);
    setReviewed(false);
    command.current = crypto.randomUUID();
    generation.current++;
  }
  function close() {
    if (
      !busy &&
      (!dirty || window.confirm("Discard unsaved organization changes?"))
    )
      onClose();
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const key = generation.current;
    await run(async () => {
      const result = await api("/organization/units/preview", input);
      if (key === generation.current) {
        setPreview(result);
        setReviewed(false);
      }
    });
  }
  return (
    <Modal
      title={
        initial
          ? "Edit organization unit"
          : parentId
            ? "Add subgroup"
            : "Add organization unit"
      }
      onClose={close}
    >
      <form className="community-form organization-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Unit name
            <input
              aria-label="Unit name"
              value={name}
              required
              minLength={2}
              maxLength={120}
              disabled={busy}
              onChange={(e) => change(() => setName(e.target.value))}
            />
          </label>
          <label>
            Unit kind
            <select
              aria-label="Unit kind"
              value={kind}
              required
              disabled={busy}
              onChange={(e) => change(() => setKind(e.target.value))}
            >
              <option value="">Choose a kind</option>
              {unitKinds.map((x) => (
                <option key={x} value={x}>
                  {unitKindLabels[x]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Parent unit
          <select
            aria-label="Parent unit"
            value={parent}
            disabled={busy}
            onChange={(e) => change(() => setParent(e.target.value))}
          >
            <option value="">Top level in the organization</option>
            {units
              .filter((x) => !initial || !x.path.includes(initial.name))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.path.join(" / ")}
                </option>
              ))}
          </select>
        </label>
        <label>
          Purpose or description
          <textarea
            aria-label="Purpose or description"
            value={description}
            maxLength={1000}
            disabled={busy}
            onChange={(e) => change(() => setDescription(e.target.value))}
          />
        </label>
        <label>
          Reason for this structure change
          <textarea
            aria-label="Reason for this structure change"
            required
            minLength={5}
            maxLength={1000}
            value={reason}
            disabled={busy}
            onChange={(e) => change(() => setReason(e.target.value))}
          />
        </label>
        <p className="school-notice">
          Every subgroup requires explicit manager assignment. This does not
          move employees, jobs, students, classes or financial records. Time
          zone: {timezone}.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button secondary" disabled={busy}>
          Preview structure change
        </button>
        {preview && (
          <section
            className="organization-preview"
            aria-label="Organization change review"
          >
            <h3>Review the proposed structure</h3>
            <dl>
              <dt>Name</dt>
              <dd>
                {preview.before?.name ?? "New unit"} → {preview.after.name}
              </dd>
              <dt>Kind</dt>
              <dd>
                {preview.before ? kindLabel(preview.before.kind) : "New unit"} →{" "}
                {kindLabel(preview.after.kind)}
              </dd>
              <dt>Description</dt>
              <dd>{preview.after.description || "None"}</dd>
            </dl>
            {preview.affected.length ? (
              <ul>
                {preview.affected.map((x: any) => (
                  <li key={x.id}>
                    <span>{x.beforePath?.join(" / ") ?? "New unit"}</span>
                    <strong>{x.afterPath.join(" / ")}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>The unit’s position in the hierarchy stays the same.</p>
            )}
            <p>
              Account assignments and permissions stay explicit for every unit.
            </p>
            <label className="school-toggle">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed the names, subgroup paths and unchanged access
              assignments.
            </label>
            <button
              type="button"
              className="button primary"
              disabled={!reviewed || busy}
              onClick={() =>
                void run(async () => {
                  const result = await api("/organization/units/save", {
                    ...input,
                    structureVersion: preview.structureVersion,
                    previewHash: preview.previewHash,
                    commandId: command.current,
                    reviewed: true,
                  });
                  setDirty(false);
                  await onSaved(result.unit.id);
                })
              }
            >
              Save reviewed structure
            </button>
          </section>
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
        </div>
      </form>
    </Modal>
  );
}
