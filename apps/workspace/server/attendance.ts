import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import {
  schoolActor,
  officeUnits,
  assertOffice,
  sectionById,
  schoolChange,
} from "./school";
import { toCsv } from "./reports";
import { lockAcademics, validateAcademicChange } from "./timetable-engine";
import {
  attendanceSettingsInput,
  attendanceCodeInput,
  attendanceDayInput,
  attendanceOpenInput,
  attendanceSaveInput,
  attendanceOverviewInput,
  attendanceCloseInput,
} from "../shared/attendance";
const uuid = (value: unknown) => z.uuid().parse(value);
const date = (value: any) => String(value).slice(0, 10);
async function schoolScope(tx: Queryable, actor: Actor, unitId: string) {
  const office = (await officeUnits(tx, actor)).includes(unitId);
  const teacher =
    actor.mode === "password" &&
    actor.unit_ids.includes(unitId) &&
    (
      await tx.query(
        "SELECT section_id FROM section_teachers WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
        [actor.org_id, unitId, actor.id],
      )
    ).rows.length > 0;
  requireCondition(
    office || teacher,
    403,
    "School access to this unit is required.",
  );
}
export async function attendancePolicy(
  tx: Queryable,
  actor: Actor,
  unitId: string,
) {
  await schoolScope(tx, actor, unitId);
  const organization = (
    await tx.query("SELECT timezone,demo FROM organizations WHERE id=$1", [
      actor.org_id,
    ])
  ).rows[0];
  const settings = (
    await tx.query(
      "SELECT * FROM attendance_settings WHERE org_id=$1 AND unit_id=$2",
      [actor.org_id, unitId],
    )
  ).rows[0] ?? {
    unit_id: unitId,
    weekdays: [],
    periods: [],
    confirmed: false,
    version: 0,
  };
  const codes = (
    await tx.query(
      "SELECT * FROM attendance_codes WHERE org_id=$1 AND unit_id=$2 ORDER BY code",
      [actor.org_id, unitId],
    )
  ).rows;
  return {
    settings,
    codes,
    timezone: organization.timezone,
    demo: organization.demo,
    ready:
      settings.weekdays.length > 0 &&
      settings.periods.length > 0 &&
      codes.some((code) => code.active) &&
      (settings.confirmed || organization.demo),
  };
}
async function instructionDay(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  yearId: string,
  day: string,
  period: string,
  writing = true,
) {
  const policy = await attendancePolicy(tx, actor, unitId);
  if (writing) {
    requireCondition(
      policy.ready,
      409,
      "Attendance configuration needs review before roll call can open.",
    );
    requireCondition(
      policy.settings.periods.includes(period),
      400,
      "Choose a configured attendance period.",
    );
  }
  const year = (
    await tx.query(
      "SELECT to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on,archived FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3",
      [yearId, actor.org_id, unitId],
    )
  ).rows[0];
  requireCondition(
    year &&
      (!writing || !year.archived) &&
      day >= year.starts_on &&
      day <= year.ends_on,
    400,
    "Choose a date in an active school year.",
  );
  const override = (
    await tx.query(
      "SELECT instructional,label FROM school_day_overrides WHERE year_id=$1 AND day=$2 AND org_id=$3",
      [yearId, day, actor.org_id],
    )
  ).rows[0];
  const instructional = override
    ? override.instructional
    : policy.settings.weekdays.includes(DateTime.fromISO(day).weekday);
  return { ...policy, instructional, dayLabel: override?.label ?? "" };
}
const lockDay = (
  tx: Queryable,
  actor: Actor,
  unitId: string,
  day: string,
  period: string,
) =>
  tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "attendance:" + actor.org_id + ":" + unitId + ":" + day + ":" + period,
  ]);
async function assertOpenDay(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  yearId: string,
  day: string,
  period: string,
) {
  const policy = await instructionDay(tx, actor, unitId, yearId, day, period);
  requireCondition(
    day <= DateTime.now().setZone(policy.timezone).toISODate()!,
    400,
    "Attendance cannot be recorded for a future date.",
  );
  requireCondition(
    policy.instructional,
    409,
    "This is not an instructional day. The school office can configure a calendar exception.",
  );
  const closed = (
    await tx.query(
      "SELECT id FROM attendance_closeouts WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND day=$4 AND period=$5 AND closed_at IS NOT NULL",
      [actor.org_id, unitId, yearId, day, period],
    )
  ).rows[0];
  requireCondition(
    !closed,
    409,
    "This attendance day is closed. The school office must reopen it before making changes.",
  );
  return policy;
}
export async function attendanceRoster(
  tx: Queryable,
  actor: Actor,
  sectionIds: string[],
  day: string,
) {
  return (
    await tx.query(
      `SELECT r.section_id,s.id AS student_id,p.name AS student_name,s.student_number FROM section_students r JOIN sections c ON c.id=r.section_id JOIN students s ON s.id=r.student_id JOIN school_people p ON p.id=s.person_id JOIN student_enrollments e ON e.student_id=s.id AND e.year_id=c.year_id WHERE r.org_id=$1 AND r.section_id=ANY($2::uuid[]) AND NOT c.archived AND $3::date BETWEEN r.starts_on AND r.ends_on AND $3::date BETWEEN e.starts_on AND e.ends_on ORDER BY p.name,s.id`,
      [actor.org_id, sectionIds, day],
    )
  ).rows;
}
async function sessionRecord(
  tx: Queryable,
  actor: Actor,
  sessionId: string,
  lock = false,
) {
  const session = (
    await tx.query(
      "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM attendance_sessions WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [sessionId, actor.org_id],
    )
  ).rows[0];
  requireCondition(session, 404, "Attendance session not found.");
  const section = await sectionById(tx, actor, session.section_id);
  return {
    ...session,
    office: section.office,
    section_name: section.name,
    class_archived: section.archived,
  } as Row;
}
async function sessionMarks(tx: Queryable, actor: Actor, sessionId: string) {
  return (
    await tx.query(
      "SELECT * FROM attendance_marks WHERE session_id=$1 AND org_id=$2 ORDER BY student_name,student_id",
      [sessionId, actor.org_id],
    )
  ).rows;
}
async function recordRevision(
  tx: Queryable,
  actor: Actor,
  session: Row,
  action: string,
  reason = "",
) {
  const marks = await sessionMarks(tx, actor, session.id);
  await tx.query(
    "INSERT INTO attendance_revisions(org_id,unit_id,session_id,version,actor_id,action,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      actor.org_id,
      session.unit_id,
      session.id,
      session.version,
      actor.id,
      action,
      reason,
      JSON.stringify({ session, marks }),
    ],
  );
  await audit(tx, actor, "attendance." + action, session.id, {
    unitId: session.unit_id,
    version: session.version,
    expected: marks.filter((mark) => mark.expected).length,
  });
}
const sameIds = (left: string[], right: string[]) => {
  const sorted = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sorted[index])
  );
};
export async function openAttendance(
  db: Database,
  actor: Actor,
  input: z.infer<typeof attendanceOpenInput>,
) {
  return db.transaction(async (tx) => {
    const section = await sectionById(tx, actor, input.sectionId);
    requireCondition(!section.archived, 409, "This class is archived.");
    await lockDay(tx, actor, section.unit_id, input.date, input.period);
    const existing = (
      await tx.query(
        "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM attendance_sessions WHERE org_id=$1 AND section_id=$2 AND day=$3 AND period=$4",
        [actor.org_id, section.id, input.date, input.period],
      )
    ).rows[0];
    if (existing)
      return {
        session: existing,
        marks: await sessionMarks(tx, actor, existing.id),
      };
    await assertOpenDay(
      tx,
      actor,
      section.unit_id,
      section.year_id,
      input.date,
      input.period,
    );
    const roster = await attendanceRoster(tx, actor, [section.id], input.date);
    requireCondition(
      roster.length,
      409,
      "No students are enrolled in this class on the selected date.",
    );
    const session = (
      await tx.query(
        "INSERT INTO attendance_sessions(id,org_id,unit_id,section_id,year_id,day,period) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          section.unit_id,
          section.id,
          section.year_id,
          input.date,
          input.period,
        ],
      )
    ).rows[0];
    for (const student of roster)
      await tx.query(
        "INSERT INTO attendance_marks(org_id,unit_id,session_id,student_id,student_name,student_number) VALUES($1,$2,$3,$4,$5,$6)",
        [
          actor.org_id,
          section.unit_id,
          session.id,
          student.student_id,
          student.student_name,
          student.student_number,
        ],
      );
    await recordRevision(tx, actor, session, "opened");
    return { session, marks: await sessionMarks(tx, actor, session.id) };
  });
}
export async function saveAttendance(
  db: Database,
  actor: Actor,
  sessionId: string,
  input: z.infer<typeof attendanceSaveInput>,
) {
  return db.transaction(async (tx) => {
    const initial = await sessionRecord(tx, actor, sessionId);
    await lockDay(tx, actor, initial.unit_id, initial.day, initial.period);
    const session = await sessionRecord(tx, actor, sessionId, true);
    requireCondition(
      session.version === input.version,
      409,
      "Attendance changed. Reload before saving.",
    );
    requireCondition(!session.class_archived, 409, "This class is archived.");
    const policy = await assertOpenDay(
      tx,
      actor,
      session.unit_id,
      session.year_id,
      session.day,
      session.period,
    );
    if (session.status === "submitted")
      requireCondition(
        session.office && input.reason.length >= 5,
        403,
        "Only the school office can correct submitted attendance, with a reason.",
      );
    const old = await sessionMarks(tx, actor, sessionId),
      expected = old.filter((mark) => mark.expected);
    requireCondition(
      sameIds(
        expected.map((mark) => mark.student_id),
        input.marks.map((mark) => mark.studentId),
      ),
      400,
      "Submit the complete captured roster, with each student exactly once.",
    );
    if (input.submit) {
      const roster = await attendanceRoster(
        tx,
        actor,
        [session.section_id],
        session.day,
      );
      requireCondition(
        sameIds(
          roster.map((row) => row.student_id),
          expected.map((row) => row.student_id),
        ),
        409,
        "The roster changed. Ask the school office to refresh the captured roster before submission.",
      );
    }
    for (const mark of input.marks) {
      const previous = expected.find(
        (row) => row.student_id === mark.studentId,
      )!;
      const current = mark.codeId
        ? policy.codes.find((code) => code.id === mark.codeId && code.active)
        : null;
      const snapshot =
        mark.codeId === previous.code_id && previous.code_snapshot
          ? previous.code_snapshot
          : current;
      requireCondition(
        !mark.codeId || snapshot,
        400,
        "Choose an active attendance code from this unit.",
      );
      if (input.submit)
        requireCondition(
          mark.codeId,
          400,
          "Mark every student before submitting attendance.",
        );
      if (input.submit && snapshot?.reason_required)
        requireCondition(
          mark.note.length >= 3,
          400,
          "This attendance code requires a note.",
        );
      await tx.query(
        "UPDATE attendance_marks SET code_id=$1,code_snapshot=$2,note=$3 WHERE session_id=$4 AND student_id=$5",
        [
          mark.codeId,
          snapshot ? JSON.stringify(snapshot) : null,
          mark.note,
          sessionId,
          mark.studentId,
        ],
      );
    }
    const next = (
      await tx.query(
        "UPDATE attendance_sessions SET status=$1,version=version+1,submitted_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,submitted_at=CASE WHEN $2 THEN now() ELSE NULL END,updated_at=now() WHERE id=$4 RETURNING *,to_char(day,'YYYY-MM-DD') AS day",
        [
          input.submit ? "submitted" : "draft",
          input.submit,
          actor.id,
          sessionId,
        ],
      )
    ).rows[0];
    await recordRevision(
      tx,
      actor,
      next,
      input.submit ? "submitted" : "draft_saved",
      input.reason,
    );
    return { session: next, marks: await sessionMarks(tx, actor, sessionId) };
  });
}
export async function reconcileAttendance(
  db: Database,
  actor: Actor,
  sessionId: string,
  version: number,
  reason: string,
) {
  return db.transaction(async (tx) => {
    const initial = await sessionRecord(tx, actor, sessionId);
    await assertOffice(tx, actor, initial.unit_id);
    await lockDay(tx, actor, initial.unit_id, initial.day, initial.period);
    const session = await sessionRecord(tx, actor, sessionId, true);
    requireCondition(
      session.version === version,
      409,
      "Attendance changed. Reload first.",
    );
    await assertOpenDay(
      tx,
      actor,
      session.unit_id,
      session.year_id,
      session.day,
      session.period,
    );
    const roster = await attendanceRoster(
      tx,
      actor,
      [session.section_id],
      session.day,
    );
    requireCondition(
      roster.length,
      409,
      "The current roster is empty; reconcile the class enrollment before taking attendance.",
    );
    await tx.query(
      "UPDATE attendance_marks SET expected=false WHERE session_id=$1",
      [sessionId],
    );
    for (const student of roster)
      await tx.query(
        "INSERT INTO attendance_marks(org_id,unit_id,session_id,student_id,student_name,student_number) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,student_id) DO UPDATE SET expected=true",
        [
          actor.org_id,
          session.unit_id,
          sessionId,
          student.student_id,
          student.student_name,
          student.student_number,
        ],
      );
    const next = (
      await tx.query(
        "UPDATE attendance_sessions SET status='draft',submitted_by=NULL,submitted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *,to_char(day,'YYYY-MM-DD') AS day",
        [sessionId],
      )
    ).rows[0];
    await recordRevision(tx, actor, next, "roster_reconciled", reason);
    return { session: next, marks: await sessionMarks(tx, actor, sessionId) };
  });
}
export async function attendanceOverview(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof attendanceOverviewInput>,
) {
  await assertOffice(tx, actor, input.unitId);
  const policy = await instructionDay(
    tx,
    actor,
    input.unitId,
    input.yearId,
    input.date,
    input.period,
    false,
  );
  const classes = (
    await tx.query(
      "SELECT id,name FROM sections WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND homeroom AND NOT archived ORDER BY name",
      [actor.org_id, input.unitId, input.yearId],
    )
  ).rows;
  const roster = await attendanceRoster(
    tx,
    actor,
    classes.map((section) => section.id),
    input.date,
  );
  const sessions = (
    await tx.query(
      "SELECT * FROM attendance_sessions WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND day=$4 AND period=$5",
      [actor.org_id, input.unitId, input.yearId, input.date, input.period],
    )
  ).rows;
  const marks = (
    await tx.query(
      "SELECT m.* FROM attendance_marks m JOIN attendance_sessions s ON s.id=m.session_id WHERE s.org_id=$1 AND s.unit_id=$2 AND s.year_id=$3 AND s.day=$4 AND s.period=$5 AND m.expected",
      [actor.org_id, input.unitId, input.yearId, input.date, input.period],
    )
  ).rows;
  const students = (
    await tx.query(
      "SELECT s.id,p.name,s.student_number FROM student_enrollments e JOIN students s ON s.id=e.student_id JOIN school_people p ON p.id=s.person_id WHERE e.org_id=$1 AND e.unit_id=$2 AND e.year_id=$3 AND $4::date BETWEEN e.starts_on AND e.ends_on ORDER BY p.name",
      [actor.org_id, input.unitId, input.yearId, input.date],
    )
  ).rows;
  const enrolled = new Set(students.map((student) => student.id)),
    seen = new Map<string, number>();
  for (const row of roster)
    seen.set(row.student_id, (seen.get(row.student_id) ?? 0) + 1);
  const duplicateIds = [...seen]
      .filter(([, count]) => count > 1)
      .map(([studentId]) => studentId),
    reported = new Map<string, Row>();
  const rows = classes.map((section) => {
    const expected = roster.filter((row) => row.section_id === section.id),
      session = sessions.find((row) => row.section_id === section.id),
      recorded = session
        ? marks.filter((mark) => mark.session_id === session.id)
        : [];
    const matches =
      !!session &&
      sameIds(
        expected.map((row) => row.student_id),
        recorded.map((row) => row.student_id),
      );
    const status = !expected.length
      ? "no_students"
      : !session
        ? "not_started"
        : !matches
          ? "roster_changed"
          : session.status === "submitted"
            ? "submitted"
            : "draft";
    if (status === "submitted")
      for (const mark of recorded)
        if (
          enrolled.has(mark.student_id) &&
          !duplicateIds.includes(mark.student_id) &&
          mark.code_snapshot
        )
          reported.set(mark.student_id, {
            ...mark,
            section_name: section.name,
          });
    return {
      id: section.id,
      name: section.name,
      expected: expected.length,
      marked: recorded.filter((row) => row.code_id).length,
      status,
      sessionId: session?.id ?? null,
      version: session?.version ?? 0,
      submittedAt: session?.submitted_at ?? null,
    };
  });
  const unassigned = students.filter((student) => !seen.has(student.id)),
    duplicates = students.filter((student) =>
      duplicateIds.includes(student.id),
    );
  const counts = {
    enrolled: students.length,
    reported: reported.size,
    present: 0,
    absent: 0,
    tardy: 0,
    early: 0,
    other: 0,
  };
  for (const mark of reported.values()) {
    const category = mark.code_snapshot.category as
      "present" | "absent" | "tardy" | "early" | "other";
    counts[category]++;
  }
  const absences = [...reported.values()].filter(
    (mark) => mark.code_snapshot.category === "absent",
  );
  const pending = students.filter((student) => !reported.has(student.id));
  const fingerprint = digest(
    JSON.stringify({
      day: input.date,
      period: input.period,
      yearId: input.yearId,
      instructional: policy.instructional,
      settingsVersion: policy.settings.version,
      enrolled: [...enrolled].sort(),
      rows: rows
        .map((row) => ({
          id: row.id,
          status: row.status,
          version: row.version,
          roster: roster
            .filter((r) => r.section_id === row.id)
            .map((r) => r.student_id)
            .sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
  const closeout =
    (
      await tx.query(
        "SELECT id,closed_at,closed_by,reason,fingerprint,version FROM attendance_closeouts WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND day=$4 AND period=$5",
        [actor.org_id, input.unitId, input.yearId, input.date, input.period],
      )
    ).rows[0] ?? null;
  return {
    date: input.date,
    period: input.period,
    instructional: policy.instructional,
    dayLabel: policy.dayLabel,
    timezone: policy.timezone,
    policyConfirmed: policy.settings.confirmed,
    demo: policy.demo,
    rows,
    counts,
    absences,
    unassigned,
    duplicates,
    pending,
    fingerprint,
    closeout,
    closureValid: !!closeout?.closed_at && closeout.fingerprint === fingerprint,
  };
}
export async function closeAttendanceDay(
  db: Database,
  actor: Actor,
  input: z.infer<typeof attendanceCloseInput>,
) {
  return db.transaction(async (tx) => {
    await assertOffice(tx, actor, input.unitId);
    await lockDay(tx, actor, input.unitId, input.date, input.period);
    await instructionDay(
      tx,
      actor,
      input.unitId,
      input.yearId,
      input.date,
      input.period,
    );
    const overview = await attendanceOverview(tx, actor, input);
    requireCondition(
      overview.instructional &&
        input.date <= DateTime.now().setZone(overview.timezone).toISODate()!,
      409,
      "Closeout requires an instructional date that is not in the future.",
    );
    requireCondition(
      input.fingerprint === overview.fingerprint,
      409,
      "Attendance or the roster changed. Refresh and review before closing.",
    );
    requireCondition(
      input.version === (overview.closeout?.version ?? 0),
      409,
      "Closeout status changed. Refresh before continuing.",
    );
    if (overview.closeout?.closed_at && overview.closureValid)
      return overview.closeout;
    requireCondition(
      overview.counts.enrolled > 0 &&
        !overview.unassigned.length &&
        !overview.duplicates.length &&
        !overview.pending.length &&
        overview.rows.every((row) =>
          ["submitted", "no_students"].includes(row.status),
        ),
      409,
      "Resolve missing submissions, unassigned students and roster changes before closing.",
    );
    requireCondition(
      !overview.absences.some((mark) => !mark.code_snapshot.excused) ||
        input.acknowledgeUnexcused,
      400,
      "Acknowledge review of the listed unexcused absences.",
    );
    const row = (
      await tx.query(
        `INSERT INTO attendance_closeouts(id,org_id,unit_id,year_id,day,period,closed_at,closed_by,reason,fingerprint,snapshot) VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10) ON CONFLICT(unit_id,year_id,day,period) DO UPDATE SET closed_at=now(),closed_by=EXCLUDED.closed_by,reason=EXCLUDED.reason,fingerprint=EXCLUDED.fingerprint,snapshot=EXCLUDED.snapshot,version=attendance_closeouts.version+1 RETURNING *`,
        [
          randomUUID(),
          actor.org_id,
          input.unitId,
          input.yearId,
          input.date,
          input.period,
          actor.id,
          input.reason,
          input.fingerprint,
          JSON.stringify(overview),
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      input.unitId,
      "attendance.day_closed",
      row.id,
      overview.closeout,
      { ...row, snapshot: overview },
    );
    return row;
  });
}
export function installAttendance(app: Express, db: Database) {
  app.get("/api/school/attendance/config", async (req, res) =>
    res.json(
      await attendancePolicy(db, schoolActor(req), uuid(req.query.unitId)),
    ),
  );
  app.put("/api/school/attendance/config", async (req, res) => {
    const actor = schoolActor(req),
      input = attendanceSettingsInput.parse(req.body);
    const settings = await db.transaction(async (tx) => {
      await lockAcademics(tx, actor.org_id);
      await assertOffice(tx, actor, input.unitId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "attendance-config:" + input.unitId,
      ]);
      const old = (
        await tx.query(
          "SELECT * FROM attendance_settings WHERE org_id=$1 AND unit_id=$2 FOR UPDATE",
          [actor.org_id, input.unitId],
        )
      ).rows[0];
      requireCondition(
        (old?.version ?? 0) === input.version,
        409,
        "Attendance configuration changed. Reload first.",
      );
      const row = (
        await tx.query(
          "INSERT INTO attendance_settings(org_id,unit_id,weekdays,periods,confirmed,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(unit_id) DO UPDATE SET weekdays=EXCLUDED.weekdays,periods=EXCLUDED.periods,confirmed=EXCLUDED.confirmed,updated_by=EXCLUDED.updated_by,updated_at=now(),version=attendance_settings.version+1 RETURNING *",
          [
            actor.org_id,
            input.unitId,
            input.weekdays,
            JSON.stringify(input.periods),
            input.confirmed,
            actor.id,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "attendance.configuration_saved",
        input.unitId,
        old ?? null,
        { ...row, reason: input.reason },
      );
      await validateAcademicChange(tx, actor.org_id);
      return row;
    });
    res.json(settings);
  });
  app.post("/api/school/attendance/codes", async (req, res) => {
    const actor = schoolActor(req),
      input = attendanceCodeInput.parse(req.body);
    const code = await db.transaction(async (tx) => {
      await assertOffice(tx, actor, input.unitId);
      const row = (
        await tx.query(
          "INSERT INTO attendance_codes(id,org_id,unit_id,code,label,category,excused,reason_required,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            input.unitId,
            input.code,
            input.label,
            input.category,
            input.excused,
            input.reasonRequired,
            input.active,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "attendance.code_created",
        row.id,
        null,
        row,
      );
      return row;
    });
    res.status(201).json(code);
  });
  app.patch("/api/school/attendance/codes/:id", async (req, res) => {
    const actor = schoolActor(req),
      codeId = uuid(req.params.id),
      input = attendanceCodeInput
        .extend({ version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    const code = await db.transaction(async (tx) => {
      await assertOffice(tx, actor, input.unitId);
      const old = (
        await tx.query(
          "SELECT * FROM attendance_codes WHERE id=$1 AND org_id=$2 AND unit_id=$3 FOR UPDATE",
          [codeId, actor.org_id, input.unitId],
        )
      ).rows[0];
      requireCondition(old, 404, "Attendance code not found.");
      requireCondition(
        old.version === input.version,
        409,
        "Attendance code changed. Reload first.",
      );
      const row = (
        await tx.query(
          "UPDATE attendance_codes SET code=$1,label=$2,category=$3,excused=$4,reason_required=$5,active=$6,version=version+1 WHERE id=$7 RETURNING *",
          [
            input.code,
            input.label,
            input.category,
            input.excused,
            input.reasonRequired,
            input.active,
            codeId,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "attendance.code_updated",
        codeId,
        old,
        row,
      );
      return row;
    });
    res.json(code);
  });
  app.get("/api/school/attendance/days", async (req, res) => {
    const actor = schoolActor(req),
      unitId = uuid(req.query.unitId),
      yearId = uuid(req.query.yearId);
    await schoolScope(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM school_day_overrides WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 ORDER BY school_day_overrides.day",
          [actor.org_id, unitId, yearId],
        )
      ).rows,
    });
  });
  app.put("/api/school/attendance/days", async (req, res) => {
    const actor = schoolActor(req),
      input = attendanceDayInput.parse(req.body);
    await db.transaction(async (tx) => {
      await lockAcademics(tx, actor.org_id);
      await assertOffice(tx, actor, input.unitId);
      const year = (
        await tx.query(
          "SELECT to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM school_years WHERE org_id=$1 AND unit_id=$2 AND id=$3",
          [actor.org_id, input.unitId, input.yearId],
        )
      ).rows[0];
      requireCondition(
        year && input.date >= year.starts_on && input.date <= year.ends_on,
        400,
        "Date must fall within this school year.",
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "attendance-day:" + input.yearId + ":" + input.date,
      ]);
      const old = (
        await tx.query(
          "SELECT * FROM school_day_overrides WHERE year_id=$1 AND day=$2",
          [input.yearId, input.date],
        )
      ).rows[0];
      requireCondition(
        (old?.version ?? 0) === input.version,
        409,
        "This calendar date changed. Reload first.",
      );
      const row = (
        await tx.query(
          "INSERT INTO school_day_overrides(org_id,unit_id,year_id,day,instructional,label) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(year_id,day) DO UPDATE SET instructional=EXCLUDED.instructional,label=EXCLUDED.label,version=school_day_overrides.version+1 RETURNING *",
          [
            actor.org_id,
            input.unitId,
            input.yearId,
            input.date,
            input.instructional,
            input.label,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "attendance.day_configured",
        input.yearId,
        old ?? null,
        row,
      );
      await validateAcademicChange(tx, actor.org_id);
    });
    res.json({ ok: true });
  });
  app.post("/api/school/attendance/sessions", async (req, res) =>
    res.json(
      await openAttendance(
        db,
        schoolActor(req),
        attendanceOpenInput.parse(req.body),
      ),
    ),
  );
  app.get("/api/school/attendance/sessions/:id", async (req, res) => {
    const actor = schoolActor(req),
      session = await sessionRecord(db, actor, uuid(req.params.id)),
      marks = await sessionMarks(db, actor, session.id),
      roster = await attendanceRoster(
        db,
        actor,
        [session.section_id],
        session.day,
      );
    const closeout = (
      await db.query(
        "SELECT closed_at FROM attendance_closeouts WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND day=$4 AND period=$5",
        [
          actor.org_id,
          session.unit_id,
          session.year_id,
          session.day,
          session.period,
        ],
      )
    ).rows[0];
    res.json({
      session,
      marks,
      rosterChanged: !sameIds(
        roster.map((row) => row.student_id),
        marks.filter((mark) => mark.expected).map((mark) => mark.student_id),
      ),
      closed: !!closeout?.closed_at,
    });
  });
  app.put("/api/school/attendance/sessions/:id", async (req, res) =>
    res.json(
      await saveAttendance(
        db,
        schoolActor(req),
        uuid(req.params.id),
        attendanceSaveInput.parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/school/attendance/sessions/:id/reconcile",
    async (req, res) => {
      const input = z
        .object({
          version: z.number().int().positive(),
          reason: z.string().trim().min(5).max(1000),
        })
        .strict()
        .parse(req.body);
      res.json(
        await reconcileAttendance(
          db,
          schoolActor(req),
          uuid(req.params.id),
          input.version,
          input.reason,
        ),
      );
    },
  );
  app.get("/api/school/attendance/sessions/:id/history", async (req, res) => {
    const actor = schoolActor(req),
      session = await sessionRecord(db, actor, uuid(req.params.id));
    res.json({
      rows: (
        await db.query(
          "SELECT version,action,reason,snapshot,created_at FROM attendance_revisions WHERE session_id=$1 AND org_id=$2 ORDER BY version DESC",
          [session.id, actor.org_id],
        )
      ).rows,
    });
  });
  app.get("/api/school/attendance/overview", async (req, res) =>
    res.json(
      await attendanceOverview(
        db,
        schoolActor(req),
        attendanceOverviewInput.parse(req.query),
      ),
    ),
  );
  app.get("/api/school/attendance/export", async (req, res) => {
    const actor = schoolActor(req),
      input = attendanceOverviewInput.parse(req.query),
      overview = await attendanceOverview(db, actor, input),
      students = (
        await db.query(
          "SELECT m.student_id,m.student_number,m.student_name,m.code_snapshot,m.note,s.id AS session_id,s.version AS session_version,s.submitted_at,s.section_id,s.period,c.name AS class FROM attendance_marks m JOIN attendance_sessions s ON s.id=m.session_id JOIN sections c ON c.id=s.section_id WHERE m.org_id=$1 AND m.unit_id=$2 AND s.year_id=$3 AND s.day=$4 AND s.period=$5 AND m.expected AND s.status=$6 ORDER BY c.name,m.student_name,m.student_id",
          [
            actor.org_id,
            input.unitId,
            input.yearId,
            input.date,
            input.period,
            "submitted",
          ],
        )
      ).rows;
    const roster = await attendanceRoster(
      db,
      actor,
      [...new Set(students.map((row) => row.section_id))],
      input.date,
    );
    const currentRosters = new Map(
      [...new Set(students.map((row) => row.section_id))].map((sectionId) => [
        sectionId,
        sameIds(
          roster
            .filter((row) => row.section_id === sectionId)
            .map((row) => row.student_id),
          students
            .filter((row) => row.section_id === sectionId)
            .map((row) => row.student_id),
        ),
      ]),
    );
    const rows = students.map((row) => ({
      date: input.date,
      period: row.period,
      class: row.class,
      student_id: row.student_number,
      student: row.student_name,
      code: row.code_snapshot?.code ?? "",
      category: row.code_snapshot?.category ?? "",
      excused: row.code_snapshot?.excused ?? "",
      note: row.note,
      session_id: row.session_id,
      session_version: row.session_version,
      submitted_at: row.submitted_at,
      roster_current: currentRosters.get(row.section_id),
      day_closeout_valid: overview.closureValid,
    }));
    await db.transaction((tx) =>
      audit(tx, actor, "attendance.exported", input.yearId, {
        unitId: input.unitId,
        date: input.date,
        period: input.period,
        rows: rows.length,
      }),
    );
    res
      .attachment("attendance-" + input.date + ".csv")
      .type("text/csv")
      .send(
        toCsv(rows, [
          "date",
          "period",
          "class",
          "student_id",
          "student",
          "code",
          "category",
          "excused",
          "note",
          "session_id",
          "session_version",
          "submitted_at",
          "roster_current",
          "day_closeout_valid",
        ]),
      );
  });
  app.post("/api/school/attendance/closeouts", async (req, res) =>
    res.json(
      await closeAttendanceDay(
        db,
        schoolActor(req),
        attendanceCloseInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/school/attendance/closeouts/:id/reopen", async (req, res) => {
    const actor = schoolActor(req),
      closeoutId = uuid(req.params.id),
      input = z
        .object({
          version: z.number().int().positive(),
          reason: z.string().trim().min(10).max(1000),
        })
        .strict()
        .parse(req.body);
    await db.transaction(async (tx) => {
      const old = (
        await tx.query(
          "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM attendance_closeouts WHERE id=$1 AND org_id=$2",
          [closeoutId, actor.org_id],
        )
      ).rows[0];
      requireCondition(old, 404, "Closeout not found.");
      await assertOffice(tx, actor, old.unit_id);
      await lockDay(tx, actor, old.unit_id, old.day, old.period);
      const row = (
        await tx.query(
          "UPDATE attendance_closeouts SET closed_at=NULL,closed_by=NULL,reason=$1,version=version+1 WHERE id=$2 AND version=$3 AND closed_at IS NOT NULL RETURNING *",
          [input.reason, closeoutId, input.version],
        )
      ).rows[0];
      requireCondition(
        row,
        409,
        "Closeout changed or was already reopened. Refresh first.",
      );
      await schoolChange(
        tx,
        actor,
        old.unit_id,
        "attendance.day_reopened",
        closeoutId,
        old,
        row,
      );
    });
    res.json({ ok: true });
  });
}
