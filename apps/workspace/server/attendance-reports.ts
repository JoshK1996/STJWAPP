import type { Express } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { officeUnits, schoolActor } from "./school";
import { toCsv } from "./reports";
import {
  attendanceReportInput,
  attendanceReportScope,
  attendanceReportColumns,
  type AttendanceReportInput,
} from "../shared/attendance-reports";

export async function attendanceReportAccess(
  tx: Queryable,
  actor: Actor,
  raw: unknown,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to review attendance reports.",
  );
  const input = attendanceReportScope.parse(raw),
    offices = await officeUnits(tx, actor),
    office = offices.includes(input.unitId);
  const year = (
    await tx.query(
      "SELECT id,name,unit_id,to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3",
      [input.yearId, actor.org_id, input.unitId],
    )
  ).rows[0];
  requireCondition(year, 404, "School year not found in this unit.");
  const classes = (
    await tx.query(
      "SELECT s.id,s.name,s.homeroom,s.archived FROM sections s WHERE s.org_id=$1 AND s.unit_id=$2 AND s.year_id=$3 AND ($4 OR ($5 AND EXISTS(SELECT 1 FROM section_teachers t WHERE t.section_id=s.id AND t.user_id=$6))) ORDER BY s.name,s.id LIMIT 1001",
      [
        actor.org_id,
        input.unitId,
        input.yearId,
        office,
        actor.unit_ids.includes(input.unitId),
        actor.id,
      ],
    )
  ).rows;
  requireCondition(
    office || classes.length,
    403,
    "School office access or a current teaching assignment is required.",
  );
  requireCondition(
    classes.length <= 1000,
    400,
    "Choose a smaller school reporting scope.",
  );
  requireCondition(
    input.sectionIds.every((id) => classes.some((c) => c.id === id)),
    403,
    "One or more selected classes are outside your current access.",
  );
  return {
    year,
    office,
    classes: input.sectionIds.length
      ? classes.filter((c) => input.sectionIds.includes(c.id))
      : classes,
  };
}
export async function attendanceReportOptions(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  yearId: string,
) {
  const access = await attendanceReportAccess(tx, actor, { unitId, yearId });
  const settings = (
    await tx.query(
      "SELECT weekdays,periods,confirmed,version FROM attendance_settings WHERE org_id=$1 AND unit_id=$2",
      [actor.org_id, unitId],
    )
  ).rows[0] ?? { weekdays: [], periods: [], confirmed: false, version: 0 };
  const historical = (
    await tx.query(
      "SELECT DISTINCT period FROM attendance_sessions WHERE org_id=$1 AND year_id=$2 AND section_id=ANY($3::uuid[]) ORDER BY period",
      [actor.org_id, yearId, access.classes.map((c) => c.id)],
    )
  ).rows.map((x) => x.period);
  const timezone = (
    await tx.query("SELECT timezone FROM organizations WHERE id=$1", [
      actor.org_id,
    ])
  ).rows[0].timezone;
  return {
    ...access,
    settings,
    periods: [...new Set([...settings.periods, ...historical])],
    timezone,
    today: DateTime.now().setZone(timezone).toISODate(),
  };
}
export async function runAttendanceReport(
  db: Database,
  actor: Actor,
  raw: unknown,
  exporting = false,
  now = new Date(),
) {
  const input = attendanceReportInput.parse(raw);
  return db.transaction(async (tx) => {
    // One database snapshot covers current revision pointers, immutable records and
    // the separately identified current-calendar/current-roster coverage projection.
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const { snapshotScope: _scope, ...result } = await attendanceReportSource(tx, actor, input, exporting, now, true);
    return result;
  });
}
export async function attendanceReportSource(
  tx: Queryable, actor: Actor, input: AttendanceReportInput, exporting = false, now = new Date(), auditRead = false,
) {
  input = attendanceReportInput.parse(input);
    const access = await attendanceReportAccess(tx, actor, {
      unitId: input.unitId,
      yearId: input.yearId,
      sectionIds: input.sectionIds,
    });
    const options = await attendanceReportOptions(
      tx,
      actor,
      input.unitId,
      input.yearId,
    );
    requireCondition(
      options.periods.includes(input.period),
      400,
      "Choose a configured or historically recorded attendance period.",
    );
    const today = DateTime.fromJSDate(now, {
      zone: options.timezone,
    }).toISODate()!;
    const from = [input.from, access.year.starts_on].sort().at(-1)!,
      to = [input.to, access.year.ends_on, today].sort()[0];
    requireCondition(
      from <= to,
      400,
      "The selected dates do not overlap this school year through today.",
    );
    const sectionIds = access.classes.map((x) => x.id);
    const sessions = (
      await tx.query(
        "SELECT s.id,s.section_id,s.status,s.version,to_char(s.day,'YYYY-MM-DD') AS day,s.period,s.submitted_at,r.snapshot FROM attendance_sessions s JOIN attendance_revisions r ON r.session_id=s.id AND r.version=s.version WHERE s.org_id=$1 AND s.unit_id=$2 AND s.year_id=$3 AND s.day BETWEEN $4 AND $5 AND s.period=$6 AND s.section_id=ANY($7::uuid[]) ORDER BY s.day,s.section_id LIMIT 20001",
        [
          actor.org_id,
          input.unitId,
          input.yearId,
          from,
          to,
          input.period,
          sectionIds,
        ],
      )
    ).rows;
    requireCondition(
      sessions.length <= 20000,
      400,
      "More than 20,000 sessions match. Narrow the date or class selection.",
    );
    const roster = (
      await tx.query(
        "SELECT r.section_id,s.id AS student_id,s.student_number,p.name AS student_name,to_char(greatest(r.starts_on,e.starts_on),'YYYY-MM-DD') AS starts_on,to_char(least(r.ends_on,e.ends_on),'YYYY-MM-DD') AS ends_on FROM section_students r JOIN sections c ON c.id=r.section_id JOIN students s ON s.id=r.student_id JOIN school_people p ON p.id=s.person_id JOIN student_enrollments e ON e.student_id=s.id AND e.year_id=c.year_id WHERE r.org_id=$1 AND r.section_id=ANY($2::uuid[]) AND NOT c.archived AND greatest(r.starts_on,e.starts_on)<=$4 AND least(r.ends_on,e.ends_on)>=$3 ORDER BY r.section_id,s.id LIMIT 20001",
        [actor.org_id, sectionIds, from, to],
      )
    ).rows;
    requireCondition(
      roster.length <= 20000,
      400,
      "More than 20,000 class places match. Select fewer classes.",
    );
    const days = (
      await tx.query(
        "SELECT to_char(day,'YYYY-MM-DD') AS day,instructional,label,version FROM school_day_overrides WHERE org_id=$1 AND year_id=$2 AND day BETWEEN $3 AND $4",
        [actor.org_id, input.yearId, from, to],
      )
    ).rows;
    const closeouts = (
      await tx.query(
        "SELECT id,to_char(day,'YYYY-MM-DD') AS day,version,closed_at FROM attendance_closeouts WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND day BETWEEN $4 AND $5 AND period=$6",
        [actor.org_id, input.unitId, input.yearId, from, to, input.period],
      )
    ).rows;
    let studentId: string | undefined;
    if (input.studentNumber) {
      const student = (
        await tx.query(
          "SELECT s.id FROM students s WHERE s.org_id=$1 AND s.unit_id=$2 AND s.student_number=$3 AND ($4 OR EXISTS(SELECT 1 FROM section_students r WHERE r.student_id=s.id AND r.section_id=ANY($5::uuid[])) OR EXISTS(SELECT 1 FROM attendance_marks m JOIN attendance_sessions a ON a.id=m.session_id WHERE m.student_id=s.id AND a.section_id=ANY($5::uuid[])))",
          [
            actor.org_id,
            input.unitId,
            input.studentNumber,
            access.office,
            sectionIds,
          ],
        )
      ).rows[0];
      requireCondition(
        student,
        404,
        "Student number not found in your attendance reporting scope.",
      );
      studentId = student.id;
    }
    const report = buildAttendanceReport({
      input,
      from,
      to,
      classes: access.classes,
      sessions,
      roster,
      days,
      settings: options.settings,
      closeouts,
      studentId,
    });
    const provenance = {
      basis:
        "current immutable attendance revisions; coverage uses current dated rosters and instructional calendar",
      sessionVersions: sessions.map((x) => ({ id: x.id, version: x.version })),
      calendarVersion: options.settings.version,
      dayVersions: days.map((x) => ({ day: x.day, version: x.version })),
      closeoutVersions: closeouts.map((x) => ({
        id: x.id,
        version: x.version,
      })),
    };
    const result = {
      ...report,
      range: { from, to },
      requestedRange: { from: input.from, to: input.to },
      period: input.period,
      year: access.year,
      timezone: options.timezone,
      asOf: now.toISOString(),
      policyConfirmed: options.settings.confirmed,
      provenance,
      sourceHash: digest(JSON.stringify({ input, report, provenance })),
    };
    if (auditRead) await audit(
      tx,
      actor,
      exporting ? "attendance.report_exported" : "attendance.report_ran",
      input.yearId,
      {
        unitId: input.unitId,
        from,
        to,
        period: input.period,
        rows: report.rows.length,
        coverage: report.coverage.length,
        sourceHash: result.sourceHash,
      },
    );
    return { ...result, snapshotScope: { unitId: input.unitId, yearId: input.yearId, sectionIds, sessionVersions: provenance.sessionVersions } };
}
export function buildAttendanceReport(data: {
  input: AttendanceReportInput;
  from: string;
  to: string;
  classes: Row[];
  sessions: Row[];
  roster: Row[];
  days: Row[];
  settings: Row;
  closeouts: Row[];
  studentId?: string;
}) {
  const rows: Row[] = [],
    coverage: Row[] = [],
    byDay = new Map(data.days.map((x) => [x.day, x])),
    byClass = new Map(data.classes.map((x) => [x.id, x]));
  const records = new Map(
    data.sessions.map((x) => [x.section_id + ":" + x.day, x]),
  );
  const instructional = (day: string) =>
    byDay.get(day)?.instructional ??
    data.settings.weekdays.includes(
      DateTime.fromISO(day, { zone: "UTC" }).weekday,
    );
  const rosterByClass = new Map<string, Row[]>();
  for (const r of data.roster)
    rosterByClass.set(r.section_id, [
      ...(rosterByClass.get(r.section_id) ?? []),
      r,
    ]);
  const currentRoster = (classId: string, day: string) =>
    (rosterByClass.get(classId) ?? []).filter(
      (x) => x.starts_on <= day && x.ends_on >= day,
    );
  const same = (a: string[], b: string[]) => {
    const sorted = [...b].sort();
    return (
      a.length === b.length && [...a].sort().every((x, i) => x === sorted[i])
    );
  };
  let draftMarks = 0,
    removedMarks = 0;
  function sessionCoverage(
    session: Row | undefined,
    section: Row,
    day: string,
  ) {
    const current = currentRoster(section.id, day),
      marks: Row[] = session?.snapshot.marks ?? [],
      expected = marks.filter((x) => x.expected),
      rosterCurrent =
        !!session &&
        same(
          current.map((x) => x.student_id),
          expected.map((x) => x.student_id),
        );
    const selected = (x: Row) =>
        !data.studentId || x.student_id === data.studentId,
      selectedCurrent = current.filter(selected),
      selectedExpected = expected.filter(selected);
    if (data.studentId && !selectedCurrent.length && !marks.some(selected))
      return;
    const closed = data.closeouts.find((x) => x.day === day);
    coverage.push({
      date: day,
      period: data.input.period,
      section_id: section.id,
      class_name: section.name,
      homeroom: section.homeroom,
      status: session
        ? !rosterCurrent
          ? "roster_changed"
          : session.status
        : "not_started",
      session_status: session?.status ?? "not_started",
      current_expected: selectedCurrent.length,
      captured_expected: selectedExpected.length,
      marked: selectedExpected.filter((x) => x.code_snapshot).length,
      session_id: session?.id ?? null,
      session_version: session?.version ?? null,
      roster_current: rosterCurrent,
      instructional_now: instructional(day),
      closeout_record: closed
        ? closed.closed_at
          ? "closed"
          : "reopened"
        : "none",
      closeout_version: closed?.version ?? null,
    });
    requireCondition(
      coverage.length <= 20000,
      400,
      "More than 20,000 class-day rows match. Narrow the dates or classes.",
    );
    if (!session) return;
    for (const mark of marks.filter(selected)) {
      const status = !mark.expected
        ? "removed"
        : session.status === "submitted"
          ? "recorded"
          : "draft";
      if (status === "draft") draftMarks++;
      if (status === "removed") removedMarks++;
      if (data.input.recordedOnly && status !== "recorded") continue;
      rows.push({
        date: day,
        period: data.input.period,
        section_id: section.id,
        class_name: section.name,
        student_id: mark.student_id,
        student_name: mark.student_name,
        student_number: mark.student_number,
        record_status: status,
        code: mark.code_snapshot?.code ?? null,
        code_label: mark.code_snapshot?.label ?? null,
        category: mark.code_snapshot?.category ?? null,
        excused: mark.code_snapshot?.excused ?? null,
        note: data.input.includeNotes ? mark.note : "",
        session_id: session.id,
        session_version: session.version,
        submitted_at: session.submitted_at
          ? new Date(session.submitted_at).toISOString()
          : null,
        roster_current: rosterCurrent,
        instructional_now: instructional(day),
      });
      requireCondition(
        rows.length <= 20000,
        400,
        "More than 20,000 student marks match. Narrow the dates or classes.",
      );
    }
  }
  for (const session of data.sessions)
    sessionCoverage(session, byClass.get(session.section_id)!, session.day);
  const projectionEnabled =
    data.settings.periods.includes(data.input.period) &&
    data.settings.weekdays.length > 0;
  for (const section of data.classes.filter(
    (x) => projectionEnabled && x.homeroom && !x.archived,
  ))
    for (
      let day = DateTime.fromISO(data.from, { zone: "UTC" });
      day.toISODate()! <= data.to;
      day = day.plus({ days: 1 })
    ) {
      const date = day.toISODate()!;
      if (
        instructional(date) &&
        !records.has(section.id + ":" + date) &&
        currentRoster(section.id, date).some(
          (x) => !data.studentId || x.student_id === data.studentId,
        )
      )
        sessionCoverage(undefined, section, date);
    }
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.class_name.localeCompare(b.class_name) ||
      a.student_name.localeCompare(b.student_name) ||
      a.student_id.localeCompare(b.student_id),
  );
  coverage.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.class_name.localeCompare(b.class_name),
  );
  const summary = {
    recorded: 0,
    present: 0,
    absent: 0,
    tardy: 0,
    early: 0,
    other: 0,
    excusedAbsences: 0,
    draft: draftMarks,
    removed: removedMarks,
    notStarted: coverage.filter((x) => x.status === "not_started").length,
    rosterChanged: coverage.filter((x) => x.status === "roster_changed").length,
  };
  const trends = new Map<string, Row>();
  for (const row of rows) {
    if (row.record_status !== "recorded") continue;
    summary.recorded++;
    if (["present", "absent", "tardy", "early", "other"].includes(row.category))
      summary[row.category as "present"]++;
    if (row.category === "absent" && row.excused) summary.excusedAbsences++;
    const day = trends.get(row.date) ?? {
      date: row.date,
      present: 0,
      absent: 0,
      tardy: 0,
      early: 0,
      other: 0,
      total: 0,
    };
    day.total++;
    if (row.category in day) day[row.category]++;
    trends.set(row.date, day);
  }
  return {
    rows,
    coverage,
    summary,
    projectionEnabled,
    trends: [...trends.values()],
    notice:
      "Recorded counts are class-period marks, not unique absent days or an attendance rate. Drafts, removed records and missing roll calls are not absences. Recorded marks retain their original code snapshot even when the current roster or calendar changes. Missing-session coverage projects current homeroom rosters onto current instructional days; other classes appear only when a session exists. Closeout labels show recorded closure state, not a new validity determination.",
  };
}
export function installAttendanceReports(app: Express, db: Database) {
  app.get("/api/school/attendance/reports/options", async (req, res) => {
    const q = z
      .object({ unitId: z.uuid(), yearId: z.uuid() })
      .strict()
      .parse(req.query);
    res.json(
      await attendanceReportOptions(db, schoolActor(req), q.unitId, q.yearId),
    );
  });
  app.post("/api/school/attendance/reports/run", async (req, res) =>
    res.json(await runAttendanceReport(db, schoolActor(req), req.body)),
  );
  app.post("/api/school/attendance/reports/export", async (req, res) => {
    const q = z
      .object({
        format: z.enum(["csv", "json"]).default("csv"),
        dataset: z.enum(["marks", "coverage"]).default("marks"),
      })
      .strict()
      .parse(req.query);
    const result = await runAttendanceReport(
      db,
      schoolActor(req),
      req.body,
      true,
    );
    if (q.format === "json") {
      res.attachment("attendance-report.json").json(result);
      return;
    }
    const rows = (q.dataset === "coverage" ? result.coverage : result.rows).map(
      (x) => ({ ...x, source_hash: result.sourceHash, as_of: result.asOf }),
    );
    const columns =
      q.dataset === "coverage"
        ? [
            "date",
            "period",
            "class_name",
            "homeroom",
            "status",
            "session_status",
            "current_expected",
            "captured_expected",
            "marked",
            "roster_current",
            "instructional_now",
            "closeout_record",
            "closeout_version",
            "session_id",
            "session_version",
          ]
        : attendanceReportColumns
            .filter(
              (x) =>
                x.key !== "note" ||
                attendanceReportInput.parse(req.body).includeNotes,
            )
            .map((x) => x.key);
    res
      .type("text/csv")
      .attachment("attendance-" + q.dataset + ".csv")
      .send(toCsv(rows, [...columns, "source_hash", "as_of"]));
  });
}
