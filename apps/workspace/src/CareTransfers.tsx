import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRightLeft, RefreshCw } from "lucide-react";
import { DateTime } from "luxon";
import { api } from "./api";
import { Badge, Modal, Panel } from "./components";
export default function CareTransfers({
  programId,
  me,
  onDirty,
  onChanged,
  onPending,
}: {
  programId: string;
  me: any;
  onDirty: (value: boolean) => void;
  onChanged: () => Promise<void>;
  onPending: (ids: string[]) => void;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [received, setReceived] = useState(false),
    [note, setNote] = useState(""),
    [reason, setReason] = useState(""),
    [changed, setChanged] = useState(false);
  const load = useCallback(async () => {
    const result = await api("/care/programs/" + programId + "/transfers");
    setData(result);
    onPending(result.rows.map((r: any) => r.student_id));
    setError("");
  }, [programId, onPending]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api("/care/programs/" + programId + "/transfers")
        .then((r) => {
          if (active) {
            setData(r);
            onPending(r.rows.map((t: any) => t.student_id));
            setError("");
          }
        })
        .catch((e) => {
          if (active) {
            setData(null);
            setError(e.message);
          }
        });
    if (!dialog) void refresh();
    const timer = setInterval(() => {
      if (!dialog) void refresh();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [programId, !!dialog, onPending]);
  useEffect(() => () => onDirty(false), [onDirty]);
  function open(transfer: any, action: string) {
    setDialog({ transfer, action, commandId: crypto.randomUUID() });
    setReceived(false);
    setNote("");
    setReason("");
    setChanged(false);
    setError("");
    onDirty(true);
  }
  function close() {
    if (busy) return;
    if (
      changed &&
      !window.confirm("Discard this unsubmitted handoff confirmation?")
    )
      return;
    setDialog(null);
    onDirty(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const t = dialog.transfer;
      await api("/care/transfers/" + t.id + "/decision", {
        action: dialog.action,
        version: t.version,
        commandId: dialog.commandId,
        ...(dialog.action === "accept"
          ? { programVersion: data.program.version, received, note }
          : { reason }),
      });
      setDialog(null);
      onDirty(false);
      setChanged(false);
      await load();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data && !error) return null;
  return (
    <Panel
      title={`School handoffs${data ? " · " + data.rows.length : ""}`}
      detail="Children stay in dismissal until a different assigned care staff member confirms receipt."
      action={
        <button
          className="button secondary small"
          disabled={!!dialog || busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={14} />
          Refresh handoffs
        </button>
      }
    >
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data?.rows.length === 0 && (
        <p className="panel-note">
          No school handoffs are waiting for this program.
        </p>
      )}
      <div className="care-children">
        {data?.rows.map((t: any) => (
          <article key={t.id}>
            <ArrowRightLeft size={22} />
            <div>
              <strong>{t.student_name}</strong>
              <small>
                {t.student_number} · From {t.requester_name} ·{" "}
                {DateTime.fromISO(t.requested_at)
                  .setZone(me.organization.timezone)
                  .toFormat("LLL d, h:mm a")}
              </small>
              <small>{t.request_reason}</small>
              <Badge tone="amber">Still with dismissal staff</Badge>
              {t.program_version !== data.program.version && (
                <small>
                  Program changed. Cancel and arrange a new reviewed handoff.
                </small>
              )}
              {t.requested_by === me.actor.id && (
                <small>
                  Another assigned staff account must receive your request.
                </small>
              )}
            </div>
            <div className="care-transfer-actions">
              <button
                className="button primary small"
                disabled={
                  !data.canReceive ||
                  t.requested_by === me.actor.id ||
                  t.program_version !== data.program.version ||
                  data.program.archived ||
                  !data.program.confirmed
                }
                onClick={() => open(t, "accept")}
              >
                Confirm receipt
              </button>
              <button className="text-link" onClick={() => open(t, "cancel")}>
                Cancel handoff
              </button>
            </div>
          </article>
        ))}
      </div>
      {data?.rows.length > 0 && !data.canReceive && (
        <p className="panel-note">
          Your account can review this queue. A currently assigned program staff
          member must confirm physical receipt.
        </p>
      )}
      {dialog && (
        <Modal
          title={
            dialog.action === "accept"
              ? "Receive child from dismissal"
              : "Cancel pending handoff"
          }
          onClose={close}
        >
          <form className="care-form" onSubmit={submit}>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <p>
              <strong>{dialog.transfer.student_name}</strong> ·{" "}
              {dialog.transfer.student_number}
            </p>
            <p>
              {dialog.transfer.program_snapshot.name} ·{" "}
              {dialog.transfer.program_snapshot.room}
            </p>
            <p>{dialog.transfer.program_snapshot.instructions}</p>
            <p>
              Requested by {dialog.transfer.requester_name}.{" "}
              {dialog.transfer.request_reason}
            </p>
            {dialog.action === "accept" ? (
              <>
                <p>
                  Receiving as <strong>{me.actor.name}</strong>. Confirm only
                  after you have physically received the child. This records the
                  care arrival and completes the linked dismissal handoff
                  together.
                </p>
                <label className="care-check">
                  <input
                    required
                    type="checkbox"
                    checked={received}
                    disabled={busy}
                    onChange={(e) => {
                      setReceived(e.target.checked);
                      setChanged(true);
                    }}
                  />
                  I have physically received this child into my care.
                </label>
                <label>
                  Receipt note
                  <textarea
                    aria-label="Receipt note"
                    maxLength={1000}
                    value={note}
                    disabled={busy}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setChanged(true);
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <p>
                  The child remains with dismissal staff. Canceling does not
                  record pickup, care arrival, or absence.
                </p>
                <label>
                  Reason for cancellation
                  <textarea
                    aria-label="Reason for cancellation"
                    required
                    minLength={5}
                    maxLength={1000}
                    value={reason}
                    disabled={busy}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setChanged(true);
                    }}
                  />
                </label>
              </>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={close}
              >
                Back
              </button>
              <button
                  className="button primary"
                disabled={busy || (dialog.action === "accept" && !received)}
              >
                {busy
                  ? "Saving…"
                  : dialog.action === "accept"
                    ? "Confirm child received"
                    : "Cancel this handoff"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Panel>
  );
}
