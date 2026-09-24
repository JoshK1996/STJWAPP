import { DateTime } from "luxon";
import type { Queryable, Row } from "./db";
import { requireCondition } from "./security";

// All timetable/teacher/roster/calendar writers acquire this BEFORE domain row locks.
// Reads do not acquire domain locks after this lock, avoiding cycles with report issuance.
export async function lockAcademics(tx: Queryable, orgId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "academic-timetable:" + orgId,
  ]);
  await tx.query(
    "INSERT INTO timetable_revisions(org_id) VALUES($1) ON CONFLICT DO NOTHING",
    [orgId],
  );
  return (
    await tx.query("SELECT version FROM timetable_revisions WHERE org_id=$1", [
      orgId,
    ])
  ).rows[0].version as number;
}
export async function advanceAcademics(tx: Queryable, orgId: string) {
  await tx.query(
    "UPDATE timetable_revisions SET version=version+1 WHERE org_id=$1",
    [orgId],
  );
}
/** Read only while holding lockAcademics; preserve PostgreSQL timestamp precision. */
export async function timetableCalendarMetadata(tx: Queryable, orgId: string) {
  const row = (await tx.query(
    `SELECT version AS revision,to_char(calendar_revised_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revised_at FROM timetable_revisions WHERE org_id=$1`,
    [orgId],
  )).rows[0];
  requireCondition(row, 409, "Timetable revision is unavailable. Refresh the timetable.");
  return { revision: row.revision as number, calendarRevisedAt: row.revised_at as string };
}
export const meetingColumns =
  "m.*,to_char(m.starts_on,'YYYY-MM-DD') AS starts_on,to_char(m.ends_on,'YYYY-MM-DD') AS ends_on,s.year_id,s.name AS section_name,s.archived AS section_archived,r.name AS room_name";
export async function timetableModel(
  tx: Queryable,
  orgId: string,
  extraSections: string[] = [],
) {
  const meetings = (
    await tx.query(
      `SELECT ${meetingColumns} FROM timetable_meetings m JOIN sections s ON s.id=m.section_id LEFT JOIN timetable_rooms r ON r.id=m.room_id WHERE m.org_id=$1 AND NOT m.canceled ORDER BY m.id LIMIT 2001`,
      [orgId],
    )
  ).rows;
  requireCondition(
    meetings.length <= 2000,
    409,
    "Timetable is too large for this review. Contact the developer before adding more meetings.",
  );
  const sectionIds = [
    ...new Set([...meetings.map((x) => x.section_id), ...extraSections]),
  ];
  const teachers = (
    await tx.query(
      "SELECT section_id,user_id FROM section_teachers WHERE org_id=$1 AND section_id=ANY($2::uuid[]) ORDER BY section_id,user_id",
      [orgId, sectionIds],
    )
  ).rows;
  // Dated class places reserve students even when an enrollment/profile is inactive.
  // Withdrawing or deactivating a profile never silently frees a timetable reservation.
  const roster = (
    await tx.query(
      "SELECT section_id,student_id,to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM section_students WHERE org_id=$1 AND section_id=ANY($2::uuid[]) ORDER BY section_id,student_id LIMIT 100001",
      [orgId, sectionIds],
    )
  ).rows;
  requireCondition(
    roster.length <= 100000,
    409,
    "Timetable roster review is too large. Contact the developer.",
  );
  const settings = (
    await tx.query(
      "SELECT unit_id,weekdays,confirmed FROM attendance_settings WHERE org_id=$1",
      [orgId],
    )
  ).rows;
  const days = (
    await tx.query(
      "SELECT year_id,to_char(day,'YYYY-MM-DD') AS day,instructional FROM school_day_overrides WHERE org_id=$1",
      [orgId],
    )
  ).rows;
  const timezone = (
    await tx.query("SELECT timezone FROM organizations WHERE id=$1", [orgId])
  ).rows[0].timezone as string;
  return { meetings, teachers, roster, settings, days, timezone };
}
export type TimetableModel = Awaited<ReturnType<typeof timetableModel>>;
export type TimetableIssue = {
  kind: "calendar" | "time" | "class" | "teacher" | "student" | "room";
  day: string;
  left: string;
  right?: string;
};
export type Occurrence = {
  meetingId: string;
  sectionId: string;
  unitId: string;
  yearId: string;
  title: string;
  roomId: string | null;
  room: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  starts: string;
  ends: string;
  teacherIds: string[];
  studentIds: string[];
  version: number;
};
export function inspectTimetable(
  model: TimetableModel,
  range?: { from: string; to: string },
) {
  const issues: TimetableIssue[] = [],
    occurrences: Occurrence[] = [];
  const teachers = new Map<string, string[]>(),
    roster = new Map<string, Row[]>();
  for (const row of model.teachers)
    teachers.set(row.section_id, [
      ...(teachers.get(row.section_id) ?? []),
      row.user_id,
    ]);
  for (const row of model.roster)
    roster.set(row.section_id, [...(roster.get(row.section_id) ?? []), row]);
  const settings = new Map(model.settings.map((x) => [x.unit_id, x]));
  const days = new Map(
    model.days.map((x) => [x.year_id + ":" + x.day, x.instructional]),
  );
  for (const meeting of model.meetings) {
    const calendar = settings.get(meeting.unit_id);
    if (!calendar?.confirmed || !calendar.weekdays.length) {
      issues.push({ kind: "calendar", day: "", left: meeting.id });
      continue;
    }
    const from =
      range && range.from > meeting.starts_on ? range.from : meeting.starts_on;
    const to = range && range.to < meeting.ends_on ? range.to : meeting.ends_on;
    for (
      let day = DateTime.fromISO(from, { zone: "UTC" });
      day.toISODate()! <= to;
      day = day.plus({ days: 1 })
    ) {
      const date = day.toISODate()!;
      if (
        !meeting.weekdays.includes(day.weekday) ||
        !(
          days.get(meeting.year_id + ":" + date) ??
          calendar.weekdays.includes(day.weekday)
        )
      )
        continue;
      const start = DateTime.fromISO(date + "T" + meeting.starts_at, {
        zone: model.timezone,
      });
      const end = DateTime.fromISO(date + "T" + meeting.ends_at, {
        zone: model.timezone,
      });
      if (
        !start.isValid ||
        !end.isValid ||
        start.toFormat("yyyy-MM-dd'T'HH:mm") !==
          date + "T" + meeting.starts_at ||
        end.toFormat("yyyy-MM-dd'T'HH:mm") !== date + "T" + meeting.ends_at ||
        start.getPossibleOffsets().length !== 1 ||
        end.getPossibleOffsets().length !== 1 ||
        end.toMillis() <= start.toMillis()
      ) {
        issues.push({ kind: "time", day: date, left: meeting.id });
        continue;
      }
      requireCondition(
        occurrences.length < 100000,
        409,
        "Timetable occurrence limit reached. Narrow the scheduling range.",
      );
      occurrences.push({
        meetingId: meeting.id,
        sectionId: meeting.section_id,
        unitId: meeting.unit_id,
        yearId: meeting.year_id,
        title: meeting.section_name,
        roomId: meeting.room_id,
        room: meeting.room_name ?? null,
        day: date,
        startsAt: meeting.starts_at,
        endsAt: meeting.ends_at,
        starts: start.toUTC().toISO()!,
        ends: end.toUTC().toISO()!,
        teacherIds: teachers.get(meeting.section_id) ?? [],
        studentIds: (roster.get(meeting.section_id) ?? [])
          .filter((x) => x.starts_on <= date && x.ends_on >= date)
          .map((x) => x.student_id),
        version: meeting.version,
      });
    }
  }
  occurrences.sort(
    (a, b) =>
      a.starts.localeCompare(b.starts) ||
      a.meetingId.localeCompare(b.meetingId),
  );
  const reservations = new Map<string, Occurrence>();
  const found = new Set<string>();
  for (const item of occurrences) {
    const resources: [TimetableIssue["kind"], string][] = [
      ["class", item.sectionId],
      ...item.teacherIds.map((id) => ["teacher", id] as ["teacher", string]),
      ...item.studentIds.map((id) => ["student", id] as ["student", string]),
    ];
    if (item.roomId) resources.push(["room", item.roomId]);
    for (const [kind, id] of resources) {
      const key = item.day + ":" + kind + ":" + id,
        old = reservations.get(key);
      if (old && old.ends > item.starts) {
        const issueKey = kind + ":" + old.meetingId + ":" + item.meetingId;
        if (!found.has(issueKey) && issues.length < 50) {
          issues.push({
            kind,
            day: item.day,
            left: old.meetingId,
            right: item.meetingId,
          });
          found.add(issueKey);
        }
      }
      if (!old || old.ends < item.ends) reservations.set(key, item);
      requireCondition(
        reservations.size <= 1000000,
        409,
        "Timetable reservation limit reached. Contact the developer.",
      );
    }
  }
  return { issues, occurrences };
}
export function timetableIssueMessage(issue: TimetableIssue) {
  if (issue.kind === "calendar")
    return "Confirm instructional weekdays before scheduling classes or changing calendar confirmation.";
  if (issue.kind === "time")
    return (
      "A class time is missing or ambiguous during the clock change on " +
      issue.day +
      ". Choose a different time or exclude that school day."
    );
  return (
    "This change would double-book a " +
    issue.kind +
    " on " +
    issue.day +
    ". Correct the timetable before saving."
  );
}
export async function validateAcademicChange(tx: Queryable, orgId: string) {
  const { issues } = inspectTimetable(await timetableModel(tx, orgId));
  requireCondition(
    !issues.length,
    409,
    issues[0] ? timetableIssueMessage(issues[0]) : "Timetable conflict.",
  );
  await advanceAcademics(tx, orgId);
}
