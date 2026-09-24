import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { digest, requireCondition, type Actor } from "./security";
import {
  assertOffice,
  officeUnits,
  schoolActor,
  schoolChange,
  sectionById,
} from "./school";
import {
  meetingInput,
  timetableSaveInput,
  timetableCancelInput,
  timetableRoomInput,
  type MeetingInput,
} from "../shared/timetable";
import { dateOnly } from "../shared/contracts";
import {
  lockAcademics,
  advanceAcademics,
  timetableModel,
  inspectTimetable,
  timetableIssueMessage,
  timetableCalendarMetadata,
  type TimetableModel,
} from "./timetable-engine";
import { toCsv } from "./reports";
import { exportTimetableCalendar } from "./timetable-export";
import type { AppRequest } from "./auth";

async function scope(tx: Queryable, actor: Actor, unitId: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to view the timetable.",
  );
  const office = (await officeUnits(tx, actor)).includes(unitId);
  const sections = (
    await tx.query(
      "SELECT s.id FROM sections s WHERE s.org_id=$1 AND s.unit_id=$2 AND NOT s.archived AND ($3 OR ($4 AND EXISTS(SELECT 1 FROM section_teachers t WHERE t.section_id=s.id AND t.user_id=$5)))",
      [actor.org_id, unitId, office, actor.unit_ids.includes(unitId), actor.id],
    )
  ).rows.map((x) => x.id as string);
  requireCondition(
    office || sections.length,
    403,
    "School access to this unit is required.",
  );
  return { office, sections };
}
async function candidate(
  tx: Queryable,
  actor: Actor,
  input: MeetingInput,
  model: TimetableModel,
) {
  const section = await sectionById(tx, actor, input.sectionId);
  await assertOffice(tx, actor, section.unit_id);
  requireCondition(!section.archived, 409, "Choose an active class.");
  const year = (
    await tx.query(
      "SELECT archived,to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM school_years WHERE id=$1 AND org_id=$2",
      [section.year_id, actor.org_id],
    )
  ).rows[0];
  requireCondition(
    year &&
      !year.archived &&
      input.startsOn >= year.starts_on &&
      input.endsOn <= year.ends_on,
    400,
    "Meeting dates must fit within the active school year.",
  );
  const old = input.id
    ? model.meetings.find(
        (x) => x.id === input.id && x.section_id === input.sectionId,
      )
    : null;
  requireCondition(
    !input.id || (old && old.version === input.version),
    409,
    "This meeting changed or was canceled. Refresh before editing.",
  );
  const room = input.roomId
    ? (
        await tx.query(
          "SELECT id,name FROM timetable_rooms WHERE id=$1 AND org_id=$2 AND unit_id=$3",
          [input.roomId, actor.org_id, section.unit_id],
        )
      ).rows[0]
    : null;
  requireCondition(
    !input.roomId || room,
    400,
    "Choose a timetable room in this unit.",
  );
  const row: Row = {
    id: input.id ?? randomUUID(),
    org_id: actor.org_id,
    unit_id: section.unit_id,
    section_id: section.id,
    year_id: section.year_id,
    section_name: section.name,
    room_id: room?.id ?? null,
    room_name: room?.name ?? null,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    weekdays: [...input.weekdays].sort(),
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    version: input.version + 1,
    canceled: false,
  };
  model.meetings = [...model.meetings.filter((x) => x.id !== row.id), row];
  requireCondition(
    model.meetings.length <= 2000,
    409,
    "The timetable meeting limit has been reached.",
  );
  return { row, old };
}
async function review(tx: Queryable, actor: Actor, input: MeetingInput) {
  const model = await timetableModel(tx, actor.org_id, [input.sectionId]);
  const { row, old } = await candidate(tx, actor, input, model);
  const checked = inspectTimetable(model),
    offices = await officeUnits(tx, actor);
  const issues = checked.issues.map((issue) => {
    const related = [issue.left, issue.right]
      .filter(Boolean)
      .map((id) => model.meetings.find((x) => x.id === id));
    const names = related.map((x) =>
      x && offices.includes(x.unit_id)
        ? x.section_name
        : "a class outside your office access",
    );
    return {
      kind: issue.kind,
      day: issue.day,
      message: timetableIssueMessage(issue),
      classes: names,
    };
  });
  const occurrences = checked.occurrences.filter((x) => x.meetingId === row.id);
  if (!occurrences.length && !issues.length)
    issues.push({
      kind: "calendar",
      day: "",
      message:
        "There are no instructional meeting dates in this range. Review the weekdays and school calendar.",
      classes: [row.section_name],
    });
  return {
    row,
    old,
    issues,
    count: occurrences.length,
    first: occurrences[0]?.day ?? null,
    last: occurrences.at(-1)?.day ?? null,
    timezone: model.timezone,
    teacherCount: model.teachers.filter((x) => x.section_id === input.sectionId)
      .length,
  };
}
async function priorCommand(
  tx: Queryable,
  actor: Actor,
  id: string,
  fingerprint: string,
) {
  const old = (
    await tx.query(
      "SELECT fingerprint,result FROM timetable_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
      [actor.org_id, actor.id, id],
    )
  ).rows[0];
  requireCondition(
    !old || old.fingerprint === fingerprint,
    409,
    "This command ID was used for a different change.",
  );
  return old?.result;
}
async function receipt(
  tx: Queryable,
  actor: Actor,
  id: string,
  fingerprint: string,
  result: unknown,
) {
  await tx.query(
    "INSERT INTO timetable_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
    [actor.org_id, actor.id, id, fingerprint, JSON.stringify(result)],
  );
}
export async function saveTimetable(db: Database, actor: Actor, raw: unknown) {
  const input = timetableSaveInput.parse(raw),
    fingerprint = digest(JSON.stringify({ action: "save", input }));
  return db.transaction(async (tx) => {
    const revision = await lockAcademics(tx, actor.org_id);
    const section = await sectionById(tx, actor, input.meeting.sectionId);
    await assertOffice(tx, actor, section.unit_id);
    const prior = await priorCommand(tx, actor, input.commandId, fingerprint);
    if (prior) return prior;
    requireCondition(
      input.revision === revision,
      409,
      "Timetable, roster, or school calendar changed. Preview again before saving.",
    );
    const checked = await review(tx, actor, input.meeting);
    requireCondition(
      !checked.issues.length,
      409,
      checked.issues[0]?.message ?? "Timetable conflict.",
    );
    const m = checked.row;
    const saved = (
      await tx.query(
        "INSERT INTO timetable_meetings(id,org_id,unit_id,section_id,room_id,starts_on,ends_on,weekdays,starts_at,ends_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET room_id=EXCLUDED.room_id,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,weekdays=EXCLUDED.weekdays,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,updated_by=EXCLUDED.updated_by,updated_at=now(),version=timetable_meetings.version+1 RETURNING id,version",
        [
          m.id,
          actor.org_id,
          m.unit_id,
          m.section_id,
          m.room_id,
          m.starts_on,
          m.ends_on,
          m.weekdays,
          m.starts_at,
          m.ends_at,
          actor.id,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      m.unit_id,
      "timetable.saved",
      m.id,
      checked.old ?? null,
      { ...m, ...saved, reason: input.meeting.reason },
    );
    await advanceAcademics(tx, actor.org_id);
    const result = { ...saved, revision: revision + 1 };
    await receipt(tx, actor, input.commandId, fingerprint, result);
    return result;
  });
}
export async function timetableView(
  tx: Queryable,
  actor: Actor,
  query: {
    unitId: string;
    yearId: string;
    from: string;
    to: string;
    sectionId?: string;
    teacherId?: string;
    studentNumber?: string;
  },
) {
  const access = await scope(tx, actor, query.unitId);
  requireCondition(
    query.to >= query.from &&
      Date.parse(query.to) - Date.parse(query.from) <= 366 * 86400000,
    400,
    "Choose at most 367 days.",
  );
  const model = await timetableModel(tx, actor.org_id);
  model.meetings = model.meetings.filter(
    (x) =>
      x.unit_id === query.unitId &&
      x.year_id === query.yearId &&
      access.sections.includes(x.section_id) &&
      (!query.sectionId || x.section_id === query.sectionId),
  );
  const year = (
    await tx.query(
      "SELECT id FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3",
      [query.yearId, actor.org_id, query.unitId],
    )
  ).rows[0];
  requireCondition(year, 404, "School year not found in this unit.");
  let studentId: string | undefined;
  if (query.studentNumber) {
    requireCondition(
      access.office,
      403,
      "School office access is required for student timetable searches.",
    );
    const student = (
      await tx.query(
        "SELECT id FROM students WHERE org_id=$1 AND unit_id=$2 AND student_number=$3",
        [actor.org_id, query.unitId, query.studentNumber],
      )
    ).rows[0];
    requireCondition(student, 404, "Student number not found in this unit.");
    studentId = student.id;
  }
  const { occurrences, issues } = inspectTimetable(model, {
    from: query.from,
    to: query.to,
  });
  const teachers = (
    await tx.query(
      "SELECT id,name FROM users WHERE org_id=$1 AND id=ANY($2::uuid[])",
      [actor.org_id, [...new Set(occurrences.flatMap((x) => x.teacherIds))]],
    )
  ).rows;
  const rows = occurrences
    .filter(
      (x) =>
        (!query.teacherId || x.teacherIds.includes(query.teacherId)) &&
        (!studentId || x.studentIds.includes(studentId)),
    )
    .map(({ studentIds, teacherIds, ...row }) => ({
      ...row,
      teachers: teacherIds.map(
        (id) =>
          teachers.find((x) => x.id === id) ?? { id, name: "Assigned staff" },
      ),
      ...(access.office ? { rosterCount: studentIds.length } : {}),
    }));
  return {
    rows,
    timezone: model.timezone,
    issues: issues.map((x) => timetableIssueMessage(x)),
    office: access.office,
  };
}
export function installTimetable(app: Express, db: Database) {
  app.post("/api/school/timetable/export", async (req, res) => {
    const file = await exportTimetableCalendar(db, schoolActor(req), (req as AppRequest).sessionHash, req.body);
    res.set("Cache-Control", "private, no-store")
      .set("X-STJW-Timetable-Revision", String(file.revision))
      .set("X-STJW-Source-SHA256", file.sourceSha256)
      .set("X-STJW-File-SHA256", file.fileSha256)
      .set("X-STJW-Occurrence-Count", String(file.count))
      .type("text/calendar; charset=utf-8").attachment(file.filename).send(file.content);
  });
  app.get("/api/school/timetable/calendar", async (req, res) => {
    const actor = schoolActor(req);
    const query = z
      .object({ from: dateOnly, to: dateOnly })
      .strict()
      .parse(req.query);
    requireCondition(
      query.to >= query.from &&
        Date.parse(query.to) - Date.parse(query.from) <= 42 * 86400000,
      400,
      "Choose at most 43 calendar days.",
    );
    res.json(
      await db.transaction(async (tx) => {
        await lockAcademics(tx, actor.org_id);
        const offices = await officeUnits(tx, actor),
          model = await timetableModel(tx, actor.org_id);
        const assigned = new Set(
          model.teachers
            .filter((x) => x.user_id === actor.id)
            .map((x) => x.section_id),
        );
        model.meetings = model.meetings.filter(
          (x) =>
            offices.includes(x.unit_id) ||
            (actor.unit_ids.includes(x.unit_id) && assigned.has(x.section_id)),
        );
        const result = inspectTimetable(model, query);
        return {
          rows: result.occurrences.map((x) => ({
            id: "timetable-" + x.meetingId + "-" + x.day,
            source: "timetable",
            title: x.title,
            starts_at: x.starts,
            ends_at: x.ends,
            timezone: model.timezone,
            location: x.room ?? "Room unassigned",
            audience: "classes",
            unit_id: x.unitId,
            canEdit: false,
            version: x.version,
            creator_name: "School timetable",
            description:
              "Scheduled class. Open School records → Timetable to review its pattern. Class teachers, roster places, rooms, and instructional days determine this schedule.",
          })),
          issues: result.issues.map(timetableIssueMessage),
        };
      }),
    );
  });
  app.get("/api/school/timetable", async (req, res) => {
    const q = z
      .object({
        unitId: z.uuid(),
        yearId: z.uuid(),
        from: dateOnly,
        to: dateOnly,
        sectionId: z.uuid().optional(),
        teacherId: z.uuid().optional(),
        studentNumber: z.string().trim().min(1).max(40).optional(),
        format: z.enum(["json", "csv"]).optional(),
      })
      .strict()
      .parse(req.query);
    const result = await db.transaction(async (tx) => {
      const actor = schoolActor(req);
      await lockAcademics(tx, actor.org_id);
      const view = await timetableView(tx, actor, q);
      return { ...view, ...await timetableCalendarMetadata(tx, actor.org_id) };
    });
    if (q.format === "csv") {
      res
        .type("text/csv")
        .attachment("class-timetable.csv")
        .send(
          toCsv(
            result.rows.map((x) => ({
              day: x.day,
              start: x.startsAt,
              end: x.endsAt,
              timezone: result.timezone,
              class: x.title,
              room: x.room ?? "",
              teachers: x.teachers.map((t) => t.name).join("; "),
              meeting_id: x.meetingId,
              version: x.version,
            })),
            [
              "day",
              "start",
              "end",
              "timezone",
              "class",
              "room",
              "teachers",
              "meeting_id",
              "version",
            ],
          ),
        );
      return;
    }
    res.json(result);
  });
  app.get("/api/school/timetable/meetings", async (req, res) => {
    const actor = schoolActor(req),
      q = z
        .object({ unitId: z.uuid(), yearId: z.uuid() })
        .strict()
        .parse(req.query);
    await assertOffice(db, actor, q.unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT m.*,to_char(m.starts_on,'YYYY-MM-DD') AS starts_on,to_char(m.ends_on,'YYYY-MM-DD') AS ends_on,s.name AS section_name,r.name AS room_name FROM timetable_meetings m JOIN sections s ON s.id=m.section_id LEFT JOIN timetable_rooms r ON r.id=m.room_id WHERE m.org_id=$1 AND m.unit_id=$2 AND s.year_id=$3 ORDER BY m.canceled,m.starts_on,m.starts_at LIMIT 2001",
          [actor.org_id, q.unitId, q.yearId],
        )
      ).rows,
    });
  });
  app.get("/api/school/timetable/rooms", async (req, res) => {
    const actor = schoolActor(req),
      unitId = z.uuid().parse(req.query.unitId);
    await scope(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT id,name FROM timetable_rooms WHERE org_id=$1 AND unit_id=$2 ORDER BY name",
          [actor.org_id, unitId],
        )
      ).rows,
    });
  });
  app.post("/api/school/timetable/rooms", async (req, res) => {
    const actor = schoolActor(req),
      input = timetableRoomInput.parse(req.body);
    res.status(201).json(
      await db.transaction(async (tx) => {
        await lockAcademics(tx, actor.org_id);
        await assertOffice(tx, actor, input.unitId);
        const row = (
          await tx.query(
            "INSERT INTO timetable_rooms(id,org_id,unit_id,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name",
            [randomUUID(), actor.org_id, input.unitId, input.name, actor.id],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          input.unitId,
          "timetable.room_created",
          row.id,
          null,
          row,
        );
        await advanceAcademics(tx, actor.org_id);
        return row;
      }),
    );
  });
  app.post("/api/school/timetable/preview", async (req, res) => {
    const actor = schoolActor(req),
      input = meetingInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const revision = await lockAcademics(tx, actor.org_id),
          result = await review(tx, actor, input);
        return {
          revision,
          issues: result.issues,
          count: result.count,
          first: result.first,
          last: result.last,
          timezone: result.timezone,
          teacherCount: result.teacherCount,
        };
      }),
    );
  });
  app.post("/api/school/timetable/save", async (req, res) =>
    res.json(await saveTimetable(db, schoolActor(req), req.body)),
  );
  app.post("/api/school/timetable/:id/cancel", async (req, res) => {
    const actor = schoolActor(req),
      id = z.uuid().parse(req.params.id),
      input = timetableCancelInput.parse(req.body),
      fingerprint = digest(JSON.stringify({ action: "cancel", id, input }));
    res.json(
      await db.transaction(async (tx) => {
        await lockAcademics(tx, actor.org_id);
        const old = (
          await tx.query(
            "SELECT * FROM timetable_meetings WHERE id=$1 AND org_id=$2",
            [id, actor.org_id],
          )
        ).rows[0];
        requireCondition(old, 404, "Meeting not found.");
        await assertOffice(tx, actor, old.unit_id);
        const prior = await priorCommand(
          tx,
          actor,
          input.commandId,
          fingerprint,
        );
        if (prior) return prior;
        requireCondition(
          !old.canceled && old.version === input.version,
          409,
          "Meeting changed or was already canceled. Refresh first.",
        );
        const row = (
          await tx.query(
            "UPDATE timetable_meetings SET canceled=true,version=version+1,updated_by=$1,updated_at=now() WHERE id=$2 RETURNING id,version",
            [actor.id, id],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          old.unit_id,
          "timetable.canceled",
          id,
          old,
          { ...row, reason: input.reason },
        );
        await advanceAcademics(tx, actor.org_id);
        await receipt(tx, actor, input.commandId, fingerprint, row);
        return row;
      }),
    );
  });
  app.get("/api/school/timetable/:id/history", async (req, res) => {
    const actor = schoolActor(req),
      id = z.uuid().parse(req.params.id),
      meeting = (
        await db.query(
          "SELECT unit_id FROM timetable_meetings WHERE org_id=$1 AND id=$2",
          [actor.org_id, id],
        )
      ).rows[0];
    requireCondition(meeting, 404, "Meeting not found.");
    await assertOffice(db, actor, meeting.unit_id);
    res.json({
      rows: (
        await db.query(
          "SELECT h.id,h.snapshot,h.created_at,u.name AS actor_name FROM school_history h JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.entity_id=$2 AND h.entity_type IN ('timetable.saved','timetable.canceled') ORDER BY h.created_at DESC LIMIT 100",
          [actor.org_id, id],
        )
      ).rows,
    });
  });
}
