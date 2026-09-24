import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { exportCalendar } from "./calendar-export";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import {
  audit,
  limitAuth,
  manages,
  requireCondition,
  type Actor,
} from "./security";
import {
  eventCreateInput,
  eventInput,
  eventUpdateInput,
  messageInput,
  messageUpdateInput,
} from "../shared/community";

const admin = (actor: Actor) => ["developer", "owner", "admin"].includes(actor.role);
const session = (req: Request) => {
  const actor = (req as AppRequest).actor;
  requireCondition(
    actor.mode === "password",
    403,
    "Use your password to open this area.",
  );
  return actor;
};
const id = (value: unknown) => z.uuid().parse(value);
const canSeeEvent = (actor: Actor, event: Row) =>
  event.org_id === actor.org_id &&
  (event.audience === "personal"
    ? event.creator_id === actor.id
    : event.audience === "organization" ||
      admin(actor) ||
      actor.unit_ids.includes(event.unit_id));
const canEditEvent = (actor: Actor, event: Row) =>
  actor.mode === "password" &&
  canSeeEvent(actor, event) &&
  (event.audience === "personal"
    ? event.creator_id === actor.id
    : manages(actor) && (event.audience !== "organization" || admin(actor)));
async function validateAudience(
  tx: Queryable,
  actor: Actor,
  event: z.infer<typeof eventInput>,
) {
  requireCondition(
    IANAZone.isValidZone(event.timezone),
    400,
    "Choose a valid time zone.",
  );
  requireCondition(
    new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime() <=
      31 * 86400000,
    400,
    "An event can span at most 31 days.",
  );
  if (event.audience !== "personal")
    requireCondition(
      manages(actor),
      403,
      "Shared events require manager access.",
    );
  if (event.audience === "organization")
    requireCondition(
      admin(actor),
      403,
      "Organization events require administrator access.",
    );
  if (event.unitId) {
    requireCondition(
      admin(actor) || actor.unit_ids.includes(event.unitId),
      403,
      "This unit is outside your access.",
    );
    requireCondition(
      (
        await tx.query("SELECT id FROM units WHERE id=$1 AND org_id=$2", [
          event.unitId,
          actor.org_id,
        ])
      ).rows.length,
      404,
      "Unit not found.",
    );
  }
}
async function eventById(
  tx: Queryable,
  actor: Actor,
  eventId: string,
  lock = false,
) {
  const event = (
    await tx.query(
      "SELECT * FROM calendar_events WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [eventId, actor.org_id],
    )
  ).rows[0];
  requireCondition(event && canSeeEvent(actor, event), 404, "Event not found.");
  return event;
}
async function eventRevision(
  tx: Queryable,
  actor: Actor,
  event: Row,
  action: string,
) {
  await tx.query(
    "INSERT INTO calendar_revisions(org_id,event_id,version,actor_id,snapshot) VALUES($1,$2,$3,$4,$5)",
    [actor.org_id, event.id, event.version, actor.id, JSON.stringify(event)],
  );
  // General audit contains identifiers only: personal calendar content keeps the event's own access boundary.
  await audit(tx, actor, action, event.id, {
    version: event.version,
    seriesId: event.series_id,
  });
}
export async function createEvents(
  db: Database,
  actor: Actor,
  input: z.infer<typeof eventCreateInput>,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  return db.transaction(async (tx) => {
    await validateAudience(tx, actor, input.event);
    const { event, repeat } = input,
      series = randomUUID(),
      rows: Row[] = [];
    const start = DateTime.fromISO(event.startsAt, { zone: event.timezone }),
      duration = new Date(event.endsAt).getTime() - start.toMillis();
    for (
      let index = 0;
      index < (repeat.frequency === "none" ? 1 : repeat.count);
      index++
    ) {
      const at = start.plus(
        repeat.frequency === "weekly"
          ? { weeks: index * repeat.interval }
          : { days: index * repeat.interval },
      );
      requireCondition(
        at.hour === start.hour && at.minute === start.minute,
        400,
        "A recurring time does not exist during a daylight-saving change. Choose another time.",
      );
      requireCondition(
        at.diff(start, "days").days <= 366,
        400,
        "A recurring series must fit within 366 days.",
      );
      const row = (
        await tx.query(
          `INSERT INTO calendar_events(id,org_id,creator_id,series_id,unit_id,audience,title,description,location,starts_at,ends_at,timezone)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            randomUUID(),
            actor.org_id,
            actor.id,
            series,
            event.unitId,
            event.audience,
            event.title,
            event.description,
            event.location,
            at.toUTC().toISO(),
            at.plus({ milliseconds: duration }).toUTC().toISO(),
            event.timezone,
          ],
        )
      ).rows[0];
      await eventRevision(tx, actor, row, "calendar.created");
      rows.push(row);
    }
    return { rows };
  });
}
export async function updateEvent(
  db: Database,
  actor: Actor,
  eventId: string,
  input: z.infer<typeof eventUpdateInput>,
) {
  return db.transaction(async (tx) => {
    const old = await eventById(tx, actor, eventId, true);
    requireCondition(
      canEditEvent(actor, old),
      403,
      "You cannot edit this event.",
    );
    requireCondition(!old.cancelled_at, 409, "This event is cancelled.");
    requireCondition(
      old.version === input.version,
      409,
      "This event changed. Refresh before editing.",
    );
    const e = input.event;
    await validateAudience(tx, actor, e);
    // Historical versions must never become visible to a new audience through an edit.
    requireCondition(
      e.audience === old.audience && e.unitId === old.unit_id,
      400,
      "Keep the audience unchanged. Create a separate event to share it elsewhere.",
    );
    const row = (
      await tx.query(
        `UPDATE calendar_events SET title=$1,description=$2,location=$3,starts_at=$4,ends_at=$5,timezone=$6,audience=$7,unit_id=$8,version=version+1,updated_at=now() WHERE id=$9 AND org_id=$10 RETURNING *`,
        [
          e.title,
          e.description,
          e.location,
          e.startsAt,
          e.endsAt,
          e.timezone,
          e.audience,
          e.unitId,
          eventId,
          actor.org_id,
        ],
      )
    ).rows[0];
    await eventRevision(tx, actor, row, "calendar.updated");
    return row;
  });
}
export async function cancelEvent(
  db: Database,
  actor: Actor,
  eventId: string,
  version: number,
) {
  return db.transaction(async (tx) => {
    const old = await eventById(tx, actor, eventId, true);
    requireCondition(
      canEditEvent(actor, old),
      403,
      "You cannot cancel this event.",
    );
    requireCondition(
      old.version === version,
      409,
      "This event changed. Refresh before cancelling.",
    );
    if (old.cancelled_at) return old;
    const row = (
      await tx.query(
        "UPDATE calendar_events SET cancelled_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *",
        [eventId, actor.org_id],
      )
    ).rows[0];
    await eventRevision(tx, actor, row, "calendar.cancelled");
    return row;
  });
}
async function directory(tx: Queryable, actor: Actor) {
  return (
    await tx.query(
      `SELECT u.id,u.name FROM users u WHERE u.org_id=$1 AND u.active AND u.id<>$2 AND ($3::boolean OR u.role IN ('developer','owner','admin') OR EXISTS(SELECT 1 FROM user_units n WHERE n.org_id=u.org_id AND n.user_id=u.id AND n.unit_id=ANY($4::uuid[]))) ORDER BY u.name`,
      [actor.org_id, actor.id, admin(actor), actor.unit_ids],
    )
  ).rows;
}
async function validateMessage(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof messageInput>,
) {
  const allowed = new Set((await directory(tx, actor)).map((row) => row.id));
  requireCondition(
    input.recipientIds.every((value) => allowed.has(value)),
    403,
    "One or more recipients are outside your current access or inactive.",
  );
  if (input.replyTo) {
    const original = (
      await tx.query(
        `SELECT m.id FROM messages m WHERE m.id=$1 AND m.org_id=$2 AND m.sent_at IS NOT NULL AND (m.sender_id=$3 OR EXISTS(SELECT 1 FROM message_recipients r WHERE r.message_id=m.id AND r.user_id=$3))`,
        [input.replyTo, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(original, 404, "Original message not found.");
  }
}
export async function saveMessage(
  db: Database,
  actor: Actor,
  input: z.infer<typeof messageInput>,
  messageId?: string,
  version?: number,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  return db.transaction(async (tx) => {
    await validateMessage(tx, actor, input);
    let row: Row;
    if (messageId) {
      const old = (
        await tx.query(
          "SELECT * FROM messages WHERE id=$1 AND org_id=$2 AND sender_id=$3 FOR UPDATE",
          [messageId, actor.org_id, actor.id],
        )
      ).rows[0];
      requireCondition(old, 404, "Draft not found.");
      requireCondition(!old.sent_at, 409, "Sent messages cannot be edited.");
      requireCondition(
        old.version === version,
        409,
        "This draft changed. Reopen it before editing.",
      );
      row = (
        await tx.query(
          "UPDATE messages SET subject=$1,body=$2,reply_to=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *",
          [input.subject, input.body, input.replyTo, messageId],
        )
      ).rows[0];
      await tx.query("DELETE FROM message_recipients WHERE message_id=$1", [
        messageId,
      ]);
    } else
      row = (
        await tx.query(
          "INSERT INTO messages(id,org_id,sender_id,subject,body,reply_to) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            actor.id,
            input.subject,
            input.body,
            input.replyTo,
          ],
        )
      ).rows[0];
    for (const recipient of input.recipientIds)
      await tx.query(
        "INSERT INTO message_recipients(org_id,message_id,user_id) VALUES($1,$2,$3)",
        [actor.org_id, row.id, recipient],
      );
    await audit(
      tx,
      actor,
      messageId ? "message.draft_updated" : "message.draft_created",
      row.id,
      { version: row.version, recipientCount: input.recipientIds.length },
    );
    return row;
  });
}
export async function sendMessage(
  db: Database,
  actor: Actor,
  messageId: string,
  version: number,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  return db.transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM messages WHERE id=$1 AND org_id=$2 AND sender_id=$3 FOR UPDATE",
        [messageId, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(row, 404, "Draft not found.");
    requireCondition(
      row.version === version,
      409,
      "This draft changed. Review the current version before sending.",
    );
    if (row.sent_at) return row;
    const recipientIds = (
      await tx.query(
        "SELECT user_id FROM message_recipients WHERE message_id=$1",
        [messageId],
      )
    ).rows.map((r) => r.user_id);
    await validateMessage(tx, actor, {
      subject: row.subject,
      body: row.body,
      replyTo: row.reply_to,
      recipientIds,
    });
    const sent = (
      await tx.query(
        "UPDATE messages SET sent_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [messageId],
      )
    ).rows[0];
    await audit(tx, actor, "message.sent", messageId, {
      version: row.version,
      recipientCount: recipientIds.length,
    });
    return sent;
  });
}
export function installCommunity(app: Express, db: Database) {
  app.get("/api/calendar/export", async (req, res) => {
    const result = await exportCalendar(db, session(req), (req as AppRequest).sessionHash, req.query);
    res.set("Cache-Control", "private, no-store")
      .set("Content-Type", "text/calendar; charset=utf-8")
      .set("Content-Disposition", 'attachment; filename="stjw-calendar.ics"')
      .send(result.content);
  });
  app.get("/api/calendar/events", async (req, res) => {
    const actor = session(req),
      query = z
        .object({ from: z.iso.datetime(), to: z.iso.datetime() })
        .strict()
        .parse(req.query);
    const duration =
      new Date(query.to).getTime() - new Date(query.from).getTime();
    requireCondition(
      duration > 0 && duration <= 367 * 86400000,
      400,
      "Choose a calendar range of up to 367 days.",
    );
    const rows = (
      await db.query(
        `SELECT e.*,u.name AS creator_name FROM calendar_events e JOIN users u ON u.id=e.creator_id WHERE e.org_id=$1 AND e.cancelled_at IS NULL AND e.starts_at<$2 AND e.ends_at>$3 AND ((e.audience='personal' AND e.creator_id=$4) OR e.audience='organization' OR (e.audience='unit' AND ($5::boolean OR e.unit_id=ANY($6::uuid[])))) ORDER BY e.starts_at,e.id LIMIT 2001`,
        [
          actor.org_id,
          query.to,
          query.from,
          actor.id,
          admin(actor),
          actor.unit_ids,
        ],
      )
    ).rows;
    requireCondition(
      rows.length <= 2000,
      400,
      "Choose a shorter range to view all events.",
    );
    res.json({
      rows: rows.map((row) => ({ ...row, canEdit: canEditEvent(actor, row) })),
    });
  });
  app.post("/api/calendar/events", async (req, res) => {
    const actor = session(req);
    await limitAuth(db, "calendar:create:" + actor.id, 60);
    res
      .status(201)
      .json(await createEvents(db, actor, eventCreateInput.parse(req.body)));
  });
  app.patch("/api/calendar/events/:id", async (req, res) =>
    res.json(
      await updateEvent(
        db,
        session(req),
        id(req.params.id),
        eventUpdateInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/calendar/events/:id/cancel", async (req, res) =>
    res.json(
      await cancelEvent(
        db,
        session(req),
        id(req.params.id),
        z
          .object({ version: z.number().int().positive() })
          .strict()
          .parse(req.body).version,
      ),
    ),
  );
  app.get("/api/calendar/events/:id/history", async (req, res) => {
    const actor = session(req),
      eventId = id(req.params.id);
    await eventById(db, actor, eventId);
    res.json({
      rows: (
        await db.query(
          "SELECT version,snapshot,changed_at FROM calendar_revisions WHERE event_id=$1 AND org_id=$2 ORDER BY version DESC",
          [eventId, actor.org_id],
        )
      ).rows,
    });
  });
  app.get("/api/messages/directory", async (req, res) =>
    res.json({ rows: await directory(db, session(req)) }),
  );
  app.get("/api/messages", async (req, res) => {
    const actor = session(req),
      query = z
        .object({
          folder: z
            .enum(["inbox", "sent", "drafts", "archive"])
            .default("inbox"),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .strict()
        .parse(req.query);
    const clause =
      query.folder === "sent"
        ? "m.sender_id=$2 AND m.sent_at IS NOT NULL"
        : query.folder === "drafts"
          ? "m.sender_id=$2 AND m.sent_at IS NULL"
          : `m.sent_at IS NOT NULL AND r.user_id=$2 AND r.archived_at IS ${query.folder === "archive" ? "NOT " : ""}NULL`;
    const rows = (
      await db.query(
        `SELECT m.id,m.subject,m.sent_at,m.updated_at,m.version,m.sender_id,u.name AS sender_name,r.read_at,r.archived_at FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN message_recipients r ON r.message_id=m.id AND r.user_id=$2 WHERE m.org_id=$1 AND (${clause}) ORDER BY COALESCE(m.sent_at,m.updated_at) DESC,m.id LIMIT 51 OFFSET $3`,
        [actor.org_id, actor.id, query.offset],
      )
    ).rows;
    const unread = (
      await db.query(
        "SELECT count(*)::integer AS count FROM message_recipients r JOIN messages m ON m.id=r.message_id WHERE r.org_id=$1 AND r.user_id=$2 AND m.sent_at IS NOT NULL AND r.read_at IS NULL AND r.archived_at IS NULL",
        [actor.org_id, actor.id],
      )
    ).rows[0].count;
    res.json({ rows: rows.slice(0, 50), hasMore: rows.length > 50, unread });
  });
  app.get("/api/messages/:id", async (req, res) => {
    const actor = session(req),
      messageId = id(req.params.id);
    const row = (
      await db.query(
        `SELECT m.*,u.name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1 AND m.org_id=$2 AND (m.sender_id=$3 OR (m.sent_at IS NOT NULL AND EXISTS(SELECT 1 FROM message_recipients r WHERE r.message_id=m.id AND r.user_id=$3)))`,
        [messageId, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(row, 404, "Message not found.");
    const recipients = (
      await db.query(
        "SELECT u.id,u.name,r.read_at FROM message_recipients r JOIN users u ON u.id=r.user_id WHERE r.message_id=$1 AND r.org_id=$2",
        [messageId, actor.org_id],
      )
    ).rows;
    res.json({
      ...row,
      recipients: recipients.map((r) => ({
        id: r.id,
        name: r.name,
        ...(actor.id === row.sender_id ? { read_at: r.read_at } : {}),
      })),
    });
  });
  app.post("/api/messages", async (req, res) => {
    const actor = session(req);
    await limitAuth(db, "message:draft:" + actor.id, 60);
    res
      .status(201)
      .json(await saveMessage(db, actor, messageInput.parse(req.body)));
  });
  app.patch("/api/messages/:id", async (req, res) => {
    const input = messageUpdateInput.parse(req.body);
    res.json(
      await saveMessage(
        db,
        session(req),
        input.message,
        id(req.params.id),
        input.version,
      ),
    );
  });
  app.post("/api/messages/:id/send", async (req, res) => {
    const actor = session(req);
    await limitAuth(db, "message:send:" + actor.id, 60);
    res.json(
      await sendMessage(
        db,
        actor,
        id(req.params.id),
        z
          .object({ version: z.number().int().positive() })
          .strict()
          .parse(req.body).version,
      ),
    );
  });
  app.patch("/api/messages/:id/state", async (req, res) => {
    const actor = session(req),
      messageId = id(req.params.id),
      input = z
        .object({
          read: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0)
        .parse(req.body);
    await db.transaction(async (tx) => {
      const own = (
        await tx.query(
          "SELECT r.user_id FROM message_recipients r JOIN messages m ON m.id=r.message_id WHERE r.message_id=$1 AND r.org_id=$2 AND r.user_id=$3 AND m.sent_at IS NOT NULL FOR UPDATE OF r",
          [messageId, actor.org_id, actor.id],
        )
      ).rows[0];
      requireCondition(own, 404, "Delivered message not found.");
      if (input.read !== undefined)
        await tx.query(
          "UPDATE message_recipients SET read_at=CASE WHEN $1 THEN COALESCE(read_at,now()) ELSE NULL END WHERE message_id=$2 AND user_id=$3",
          [input.read, messageId, actor.id],
        );
      if (input.archived !== undefined)
        await tx.query(
          "UPDATE message_recipients SET archived_at=CASE WHEN $1 THEN COALESCE(archived_at,now()) ELSE NULL END WHERE message_id=$2 AND user_id=$3",
          [input.archived, messageId, actor.id],
        );
      await audit(tx, actor, "message.state_changed", messageId, input);
    });
    res.json({ ok: true });
  });
}
