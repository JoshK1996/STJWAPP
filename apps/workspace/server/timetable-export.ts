import { z } from "zod";
import type { Database, Queryable } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import { calendarText, calendarTimestamp, foldCalendarLine } from "./calendar-export";
import { lockAcademics, timetableCalendarMetadata } from "./timetable-engine";
import { timetableView } from "./timetable";
import { dateOnly } from "../shared/contracts";
import { timetableCalendarExportInput, timetableExportLimits as limits, type TimetableCalendarExportInput } from "../shared/timetable-export";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const eventSchema = z.object({
  meetingId: z.uuid(), sectionId: z.uuid(), day: dateOnly,
  title: z.string(), room: z.string().nullable(), startsAt: clock, endsAt: clock,
  starts: z.iso.datetime(), ends: z.iso.datetime(), version: z.number().int().positive().max(2147483647),
}).strict();
export const timetableCalendarSourceSchema = z.object({
  formatVersion: z.literal(1), orgId: z.uuid(), unitId: z.uuid(), yearId: z.uuid(),
  from: dateOnly, to: dateOnly, timezone: z.string().min(1).max(100),
  revision: z.number().int().nonnegative().max(2147483647), calendarRevisedAt: z.iso.datetime(),
  events: z.array(eventSchema).min(1).max(limits.occurrences),
}).strict();
type Source = z.infer<typeof timetableCalendarSourceSchema>;
type AccessManifest = { orgId: string; unitId: string; yearId: string; sectionIds: string[]; requiresOffice: boolean };

/** Fixed schema/key order; no account, search string, teacher or roster data. */
export function renderTimetableCalendar(raw: unknown) {
  const source = timetableCalendarSourceSchema.parse(raw);
  source.events.sort((a, b) => a.starts.localeCompare(b.starts) || a.meetingId.localeCompare(b.meetingId) || a.day.localeCompare(b.day));
  requireCondition(new Set(source.events.map(e => e.meetingId + ":" + e.day)).size === source.events.length,
    409, "Timetable contains duplicate occurrences. Refresh before downloading.");
  const sourceText = JSON.stringify(source);
  requireCondition(Buffer.byteLength(sourceText, "utf8") <= limits.bytes, 400, "Choose a shorter range; this timetable file exceeds the download size limit.");
  const sourceSha256 = digest(sourceText), revised = calendarTimestamp(source.calendarRevisedAt);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//STJW//Instructional Timetable//EN", "CALSCALE:GREGORIAN",
    "X-STJW-FORMAT-VERSION:1", `X-STJW-SOURCE-SHA256:${sourceSha256}`];
  for (const e of source.events) {
    const start = calendarTimestamp(e.starts), end = calendarTimestamp(e.ends);
    requireCondition(e.day >= source.from && e.day <= source.to && e.endsAt > e.startsAt && end > start,
      409, "A timetable occurrence has invalid dates or duration.");
    const description = `Instructional timetable copy. Local date ${e.day}, ${e.startsAt}–${e.endsAt}, timezone ${source.timezone}. Timetable revision ${source.revision}. Later changes do not update this downloaded copy.`;
    lines.push("BEGIN:VEVENT", `UID:stjw-timetable:${source.orgId}:${e.meetingId}:${e.day.replace(/-/g, "")}`,
      `DTSTAMP:${revised}`, `LAST-MODIFIED:${revised}`, `DTSTART:${start}`, `DTEND:${end}`, "CLASS:PRIVATE",
      `SUMMARY:${calendarText(e.title)}`, `DESCRIPTION:${calendarText(description)}`,
      `X-STJW-SOURCE-DATE:${e.day}`, `X-STJW-TIMEZONE:${calendarText(source.timezone)}`,
      `X-STJW-TIMETABLE-REVISION:${source.revision}`, `X-STJW-MEETING-VERSION:${e.version}`);
    if (e.room !== null) lines.push(`LOCATION:${calendarText(e.room)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const content = lines.map(foldCalendarLine).join("\r\n") + "\r\n";
  requireCondition(Buffer.byteLength(content, "utf8") <= limits.bytes, 400, "Choose a shorter range; this timetable file exceeds the download size limit.");
  return { content, sourceSha256, fileSha256: digest(content), count: source.events.length };
}

/** Authority-only: ordinary identity reads precede grant locks; never takes academic/domain locks. */
async function schoolAccess(tx: Queryable, actor: Actor, input: TimetableCalendarExportInput,
  captured?: AccessManifest, lock = true) {
  const year = (await tx.query(`SELECT y.id FROM school_years y JOIN units u ON u.id=y.unit_id AND u.org_id=y.org_id
    WHERE y.id=$1 AND y.org_id=$2 AND y.unit_id=$3`, [input.yearId, actor.org_id, input.unitId])).rows[0];
  requireCondition(year, 404, "School year not found in this unit.");
  requireCondition(!captured || (captured.orgId === actor.org_id && captured.unitId === input.unitId && captured.yearId === input.yearId), 404, "Timetable source is unavailable.");
  const sections = (await tx.query(`SELECT id FROM sections WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND NOT archived
    AND ($4::uuid[] IS NULL OR id=ANY($4::uuid[])) ORDER BY id`,
    [actor.org_id, input.unitId, input.yearId, captured?.sectionIds ?? (input.sectionId ? [input.sectionId] : null)])).rows.map(r => r.id as string);
  requireCondition(!captured || sections.length === captured.sectionIds.length, 404, "A captured class is no longer available.");
  requireCondition(!input.sectionId || sections.includes(input.sectionId), 404, "Class not found in this timetable.");
  const wide = ["developer", "owner", "admin"].includes(actor.role), member = actor.unit_ids.includes(input.unitId);
  const office = wide || (member && (await tx.query(
    "SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3" + (lock ? " FOR SHARE" : ""),
    [actor.org_id, actor.id, input.unitId],
  )).rows.length > 0);
  requireCondition(!(input.studentNumber || captured?.requiresOffice) || office, 403, "School office access is required for student timetable searches.");
  if (office) return;
  requireCondition(member, 403, "School access to this unit is required.");
  const grants = (await tx.query(`SELECT section_id FROM section_teachers WHERE org_id=$1 AND unit_id=$2 AND user_id=$3
    AND section_id=ANY($4::uuid[]) ORDER BY section_id` + (lock ? " FOR SHARE" : ""),
    [actor.org_id, input.unitId, actor.id, sections])).rows.map(r => r.section_id);
  requireCondition(!input.sectionId || grants.includes(input.sectionId), 404, "Class not found in this timetable.");
  requireCondition(captured ? grants.length === captured.sectionIds.length : grants.length > 0,
    403, "Current teaching access to every exported class is required.");
}

export async function exportTimetableCalendar(db: Database, suppliedActor: Actor, sessionHash: string | undefined, raw: unknown) {
  requireCondition(suppliedActor.mode === "password", 403, "Password sign-in is required to download the timetable.");
  requireCondition(sessionHash, 401, "Sign in to download the timetable.");
  const input = timetableCalendarExportInput.parse(raw);
  // Phase 1 completes before the academic mutex: account/session/grant locks cannot nest around it.
  const actor = await reportTransaction(db, async tx => {
    const current = await currentReportActor(tx, suppliedActor, sessionHash);
    await schoolAccess(tx, current, input);
    await recheckReportSession(tx, current, sessionHash);
    return current;
  });
  // Phase 2 owns the academic mutex, but takes no account/session/grant/domain row locks.
  const captured = await reportTransaction(db, async tx => {
    await lockAcademics(tx, actor.org_id);
    const metadata = await timetableCalendarMetadata(tx, actor.org_id);
    requireCondition(metadata.revision === input.expectedRevision, 409, "The timetable changed. Refresh and review before downloading.");
    await schoolAccess(tx, actor, input, undefined, false);
    const view = await timetableView(tx, actor, input);
    requireCondition(!view.issues.length, 409, "Resolve the timetable issues before downloading the complete calendar.");
    requireCondition(view.rows.length > 0, 400, "No instructional occurrences are available for these filters and dates.");
    requireCondition(view.rows.length <= limits.occurrences, 400, "Choose a shorter range to download at most 2,000 complete occurrences.");
    const source: Source = timetableCalendarSourceSchema.parse({
      formatVersion: 1, orgId: actor.org_id, unitId: input.unitId, yearId: input.yearId,
      from: input.from, to: input.to, timezone: view.timezone, ...metadata,
      events: view.rows.map(e => ({ meetingId: e.meetingId, sectionId: e.sectionId, day: e.day,
        title: e.title, room: e.room, startsAt: e.startsAt, endsAt: e.endsAt, starts: e.starts, ends: e.ends, version: e.version })),
    });
    const manifest: AccessManifest = { orgId: actor.org_id, unitId: input.unitId, yearId: input.yearId,
      sectionIds: [...new Set(source.events.map(e => e.sectionId))].sort(), requiresOffice: !!input.studentNumber };
    return { source, manifest };
  });
  // Phase 3 locks current authority through audit; it never reacquires academic or section locks.
  return reportTransaction(db, async tx => {
    const current = await currentReportActor(tx, suppliedActor, sessionHash);
    await schoolAccess(tx, current, input, captured.manifest);
    const file = renderTimetableCalendar(captured.source);
    await audit(tx, current, "school.timetable_exported", input.unitId, {
      unitId: input.unitId, yearId: input.yearId, from: input.from, to: input.to,
      hasSectionFilter: !!input.sectionId, hasTeacherFilter: !!input.teacherId, hasStudentFilter: !!input.studentNumber,
      format: "ics", formatVersion: 1, revision: captured.source.revision, calendarRevisedAt: captured.source.calendarRevisedAt,
      occurrenceCount: file.count, bytes: Buffer.byteLength(file.content, "utf8"), sourceSha256: file.sourceSha256, fileSha256: file.fileSha256,
    });
    await recheckReportSession(tx, current, sessionHash);
    return { ...file, filename: `stjw-timetable-${input.from}-to-${input.to}.ics`, revision: captured.source.revision };
  });
}
