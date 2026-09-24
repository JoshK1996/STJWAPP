import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { calendarExportQuery } from "../shared/calendar-export";

// RFC 5545 sections 3.1 and 3.3.11: escape TEXT before UTF-8 octet folding.
export function calendarText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\ufffd");
}
export function foldCalendarLine(value: string) {
  requireCondition(!/[\r\n]/.test(value), 400, "Calendar content must use escaped line breaks.");
  let result = "", size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > 75) { result += "\r\n "; size = 1; }
    result += character;
    size += bytes;
  }
  return result;
}
export function calendarTimestamp(value: string | Date) {
  const instant = new Date(value);
  requireCondition(Number.isFinite(instant.getTime()), 400, "An event has an invalid date.");
  const iso = instant.toISOString();
  requireCondition(/^\d{4}-/.test(iso), 400, "An event date is outside the calendar format.");
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
export function renderCalendarFile(rows: Row[]) {
  requireCondition(rows.length > 0, 400, "No calendar events are available for that range and audience.");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//STJW//Community Calendar//EN", "CALSCALE:GREGORIAN"];
  for (const row of rows) {
    const eventId = z.uuid().parse(row.id),
      version = z.number().int().min(1).max(2147483647).parse(row.version),
      start = calendarTimestamp(row.starts_at), end = calendarTimestamp(row.ends_at),
      revised = calendarTimestamp(row.updated_at);
    requireCondition(end > start, 400, "An event must last at least one calendar second to export.");
    lines.push("BEGIN:VEVENT", `UID:urn:uuid:${eventId}`, `DTSTAMP:${revised}`,
      `DTSTART:${start}`, `DTEND:${end}`, `LAST-MODIFIED:${revised}`, `SEQUENCE:${version - 1}`,
      "CLASS:PRIVATE", `SUMMARY:${calendarText(row.title)}`,
      `DESCRIPTION:${calendarText(row.description)}`, `LOCATION:${calendarText(row.location)}`,
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldCalendarLine).join("\r\n") + "\r\n";
}
async function activeSession(tx: Queryable, actor: Actor, sessionHash: string) {
  requireCondition((await tx.query(
    "SELECT token_hash FROM sessions WHERE token_hash=$1 AND org_id=$2 AND user_id=$3 AND mode='password' AND expires_at>clock_timestamp() FOR SHARE",
    [sessionHash, actor.org_id, actor.id],
  )).rows.length, 401, "Your session has expired or changed. Sign in again.");
}
export async function exportCalendar(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown) {
  requireCondition(actor.mode === "password", 403, "Password sign-in is required to download calendar events.");
  requireCondition(sessionHash, 401, "Sign in to download calendar events.");
  const query = calendarExportQuery.parse(raw);
  return db.transaction(async (tx) => {
    // Staff changes lock the account before replacing memberships/revoking sessions.
    // Reload under that same boundary instead of trusting request-time role/unit IDs.
    const current = (await tx.query(
      "SELECT id,role,active FROM users WHERE id=$1 AND org_id=$2 FOR SHARE",
      [actor.id, actor.org_id],
    )).rows[0];
    requireCondition(current?.active, 403, "This account is inactive or unavailable.");
    await activeSession(tx, actor, sessionHash);
    const unitIds = (await tx.query(
      "SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 ORDER BY unit_id FOR SHARE",
      [actor.id, actor.org_id],
    )).rows.map((row) => row.unit_id);
    const rows = (await tx.query(
      `SELECT e.id,e.version,e.title,e.description,e.location,e.starts_at,e.ends_at,e.updated_at
       FROM calendar_events e WHERE e.org_id=$1 AND e.cancelled_at IS NULL AND e.starts_at<$2 AND e.ends_at>$3
       AND ($7='all' OR e.audience=$7)
       AND ((e.audience='personal' AND e.creator_id=$4) OR e.audience='organization'
         OR (e.audience='unit' AND ($5::boolean OR e.unit_id=ANY($6::uuid[]))))
       ORDER BY e.starts_at,e.id LIMIT 2001`,
      [actor.org_id, query.to, query.from, actor.id, ["developer", "owner", "admin"].includes(current.role), unitIds, query.audience],
    )).rows;
    requireCondition(rows.length <= 2000, 400, "Choose a shorter range to download all events.");
    const content = renderCalendarFile(rows);
    await activeSession(tx, actor, sessionHash);
    await audit(tx, actor, "calendar.exported", actor.id, {
      ...query, format: "ics", eventCount: rows.length,
      bytes: Buffer.byteLength(content, "utf8"), sha256: digest(content),
    });
    return { content, eventCount: rows.length };
  });
}
