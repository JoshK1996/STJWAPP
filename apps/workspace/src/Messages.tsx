import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  FilePenLine,
  Inbox,
  Mail,
  Plus,
  Reply,
  Send,
} from "lucide-react";
import { api } from "./api";
import { Avatar, Badge, Empty, Modal } from "./components";
export default function Messages({
  me,
  notify,
}: {
  me: any;
  notify: (text: string, error?: boolean) => void;
}) {
  const [folder, setFolder] = useState("inbox"),
    [offset, setOffset] = useState(0),
    [list, setList] = useState<any>({ rows: [], unread: 0, hasMore: false }),
    [selected, setSelected] = useState<any>(null),
    [compose, setCompose] = useState<any>(null),
    [people, setPeople] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async () =>
      setList(
        await api(
          "/messages?" +
            new URLSearchParams({ folder, offset: String(offset) }),
        ),
      ),
    [folder, offset],
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    setSelected(null);
    api("/messages?" + new URLSearchParams({ folder, offset: String(offset) }))
      .then((data) => {
        if (active) setList(data);
      })
      .catch((e) => notify(e.message, true))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [folder, offset, notify]);
  useEffect(() => {
    void api("/messages/directory")
      .then((data) => setPeople(data.rows))
      .catch((e) => notify(e.message, true));
  }, [notify]);
  useEffect(() => {
    const timer = setInterval(() => {
      void load().catch((e) => notify(e.message, true));
    }, 30000);
    return () => clearInterval(timer);
  }, [load, notify]);
  const when = (value: string) =>
    DateTime.fromISO(value)
      .setZone(me.organization.timezone)
      .toFormat("LLL d, h:mm a");
  async function open(messageId: string) {
    setBusy(true);
    try {
      const message = await api("/messages/" + messageId);
      if (!message.sent_at) {
        setCompose(message);
        return;
      }
      setSelected(message);
      if (message.sender_id !== me.actor.id) {
        await api("/messages/" + messageId + "/state", { read: true }, "PATCH");
        await load();
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function state(input: any) {
    setBusy(true);
    try {
      await api("/messages/" + selected.id + "/state", input, "PATCH");
      setSelected(null);
      await load();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="community-module">
      <div className="community-toolbar">
        <p className="muted">
          <Mail size={17} /> Internal messages · visible to the sender and
          recipients
        </p>
        <button className="button primary" onClick={() => setCompose({})}>
          <Plus size={17} />
          New message
        </button>
      </div>
      <div className="mail-layout">
        <nav className="mail-folders" aria-label="Message folders">
          {[
            ["inbox", "Inbox", Inbox],
            ["sent", "Sent", Send],
            ["drafts", "Drafts", FilePenLine],
            ["archive", "Archive", Archive],
          ].map(([value, label, Icon]: any) => (
            <button
              key={value}
              className={folder === value ? "active" : ""}
              aria-current={folder === value ? "page" : undefined}
              onClick={() => {
                setFolder(value);
                setOffset(0);
              }}
            >
              <Icon size={18} />
              {label}
              {value === "inbox" && list.unread > 0 && (
                <Badge>{list.unread}</Badge>
              )}
            </button>
          ))}
          <p>Your STJW conversations, together in one place.</p>
        </nav>
        <section
          className={`mail-list ${selected ? "has-selection" : ""}`}
          aria-label="Messages"
          aria-busy={loading}
        >
          <div className="mail-list-heading">
            <strong>{folder[0].toUpperCase() + folder.slice(1)}</strong>
            <button
              className="text-link"
              onClick={() => void load().catch((e) => notify(e.message, true))}
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <p className="community-loading">Loading messages…</p>
          ) : list.rows.length ? (
            list.rows.map((message: any) => (
              <button
                key={message.id}
                className={`mail-row ${selected?.id === message.id ? "selected" : ""} ${folder === "inbox" && !message.read_at ? "unread" : ""}`}
                disabled={busy}
                onClick={() => void open(message.id)}
              >
                <Avatar name={message.sender_name} />
                <span>
                  <strong>
                    {folder === "drafts" ? "Draft" : message.sender_name}
                  </strong>
                  <b>{message.subject}</b>
                  <small>{when(message.sent_at ?? message.updated_at)}</small>
                </span>
                {folder === "inbox" && !message.read_at && (
                  <i aria-label="Unread" />
                )}
              </button>
            ))
          ) : (
            <Empty
              title={
                folder === "inbox" ? "You’re all caught up" : "Nothing here yet"
              }
              detail={
                folder === "drafts"
                  ? "Saved messages will appear here."
                  : "Your messages will appear here."
              }
            />
          )}
          <div className="mail-pagination">
            <button
              className="icon-button"
              aria-label="Previous messages"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              <ArrowLeft size={16} />
            </button>
            <span>
              {list.rows.length
                ? `${offset + 1}–${offset + list.rows.length}`
                : "0"}{" "}
              messages
            </span>
            <button
              className="icon-button"
              aria-label="Next messages"
              disabled={!list.hasMore}
              onClick={() => setOffset(offset + 50)}
            >
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
        <section
          className={`mail-reader ${selected ? "open" : ""}`}
          aria-label="Message content"
        >
          {selected ? (
            <>
              <button
                className="text-link mail-back"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={17} />
                Back to messages
              </button>
              <div className="message-subject">
                <Badge>Internal message</Badge>
                <h2>{selected.subject}</h2>
              </div>
              <div className="message-sender">
                <Avatar name={selected.sender_name} />
                <div>
                  <strong>{selected.sender_name}</strong>
                  <p>{when(selected.sent_at)}</p>
                </div>
              </div>
              <p className="message-recipients">
                To: {selected.recipients.map((p: any) => p.name).join(", ")}
              </p>
              <div className="message-body">{selected.body}</div>
              {selected.sender_id === me.actor.id && (
                <div className="message-receipts">
                  <CheckCheck size={17} />
                  {
                    selected.recipients.filter((p: any) => p.read_at).length
                  } of {selected.recipients.length} recipients have read this
                  message.
                </div>
              )}
              <div className="community-tools">
                <button
                  className="button primary"
                  onClick={() =>
                    setCompose({
                      subject:
                        (selected.subject.startsWith("Re: ") ? "" : "Re: ") +
                        selected.subject,
                      body: "",
                      reply_to: selected.id,
                      recipients:
                        selected.sender_id === me.actor.id
                          ? selected.recipients
                          : [
                              {
                                id: selected.sender_id,
                                name: selected.sender_name,
                              },
                            ],
                    })
                  }
                >
                  <Reply size={17} />
                  Reply
                </button>
                {selected.sender_id !== me.actor.id && (
                  <>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void state({ archived: folder !== "archive" })
                      }
                    >
                      <Archive size={17} />
                      {folder === "archive" ? "Move to inbox" : "Archive"}
                    </button>
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() => void state({ read: false })}
                    >
                      Mark unread
                    </button>
                  </>
                )}
              </div>
              {selected.reply_to && (
                <button
                  className="text-link"
                  onClick={() => void open(selected.reply_to)}
                >
                  Read original message
                </button>
              )}
            </>
          ) : (
            <Empty
              title="Space for a conversation"
              detail="Open a message, or start one with a colleague."
            />
          )}
        </section>
      </div>
      {compose && (
        <Composer
          initial={compose}
          people={people}
          onClose={() => setCompose(null)}
          onSaved={async (sent) => {
            setCompose(null);
            await load();
            notify(sent ? "Message delivered in the app." : "Draft saved.");
          }}
        />
      )}
    </div>
  );
}
function Composer({
  initial,
  people,
  onClose,
  onSaved,
}: {
  initial: any;
  people: any[];
  onClose: () => void;
  onSaved: (sent: boolean) => Promise<void>;
}) {
  const [recipients, setRecipients] = useState<string[]>(
      (initial.recipients ?? []).map((p: any) => p.id),
    ),
    [search, setSearch] = useState(""),
    [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const intent =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "send";
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const message = {
        subject: form.get("subject"),
        body: form.get("body"),
        recipientIds: recipients,
        replyTo: initial.reply_to ?? null,
      };
      const saved = await api(
        "/messages" + (draft.id ? "/" + draft.id : ""),
        draft.id ? { message, version: draft.version } : message,
        draft.id ? "PATCH" : "POST",
      );
      setDraft(saved);
      if (intent)
        await api("/messages/" + saved.id + "/send", {
          version: saved.version,
        });
      await onSaved(intent);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        initial.reply_to
          ? "Write a reply"
          : initial.id
            ? "Continue your draft"
            : "Start a conversation"
      }
      onClose={onClose}
    >
      <form className="community-form" onSubmit={submit}>
        <fieldset className="recipient-picker">
          <legend>Recipients · {recipients.length} selected</legend>
          <input
            aria-label="Find a recipient"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a colleague…"
          />
          <div className="recipient-options">
            {people
              .filter((person) =>
                person.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={recipients.includes(person.id)}
                    onChange={(e) =>
                      setRecipients(
                        e.target.checked
                          ? [...recipients, person.id]
                          : recipients.filter((value) => value !== person.id),
                      )
                    }
                  />
                  {person.name}
                </label>
              ))}
            {people.length === 0 && (
              <p>No colleagues are available in your current scope.</p>
            )}
          </div>
          {recipients.some((value) => !people.some((p) => p.id === value)) && (
            <p className="error">
              A previous recipient is no longer available.{" "}
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setRecipients(
                    recipients.filter((value) =>
                      people.some((p) => p.id === value),
                    ),
                  )
                }
              >
                Remove unavailable recipients
              </button>
            </p>
          )}
        </fieldset>
        <label>
          Subject
          <input
            name="subject"
            defaultValue={initial.subject ?? ""}
            minLength={2}
            maxLength={160}
            required
          />
        </label>
        <label>
          Message
          <textarea
            name="body"
            rows={7}
            maxLength={12000}
            defaultValue={initial.body ?? ""}
            placeholder="What would you like to share?"
            required
          />
        </label>
        <p className="muted">
          This sends an internal STJW message. Email delivery is not connected.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="submit"
            value="draft"
            className="button secondary"
            disabled={busy || !recipients.length}
          >
            Save draft
          </button>
          <button
            type="submit"
            value="send"
            className="button primary"
            disabled={busy || !recipients.length}
          >
            <Send size={16} />
            {busy ? "Saving…" : `Send to ${recipients.length}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
