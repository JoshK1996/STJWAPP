import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { assertOffice, officeUnits, schoolActor, schoolChange } from "./school";
import { toCsv } from "./reports";
import {
  careProgramInput,
  careEnrollmentInput,
  careCheckinInput,
  careCheckoutInput,
  careHoldInput,
  careReportInput,
  careMilliseconds,
} from "../shared/care";
const id = (x: unknown) => z.uuid().parse(x);
const dates =
  "to_char(e.starts_on,'YYYY-MM-DD') AS starts_on,to_char(e.ends_on,'YYYY-MM-DD') AS ends_on";
export async function careProgram(
  tx: Queryable,
  actor: Actor,
  programId: string,
  lock = false,
): Promise<Row & { office: boolean }> {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  const row = (
    await tx.query(
      "SELECT * FROM care_programs WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [programId, actor.org_id],
    )
  ).rows[0];
  requireCondition(row, 404, "Care program not found.");
  const office = (await officeUnits(tx, actor)).includes(row.unit_id);
  const assigned =
    actor.unit_ids.includes(row.unit_id) &&
    (
      await tx.query(
        "SELECT user_id FROM care_staff WHERE program_id=$1 AND org_id=$2 AND user_id=$3",
        [row.id, actor.org_id, actor.id],
      )
    ).rows.length > 0;
  requireCondition(office || assigned, 404, "Care program not found.");
  return { ...row, office };
}
async function clockNow(tx: Queryable, actor: Actor) {
  const row = (
    await tx.query(
      "SELECT clock_timestamp() AS instant,timezone FROM organizations WHERE id=$1",
      [actor.org_id],
    )
  ).rows[0];
  const instant = new Date(row.instant).toISOString();
  return {
    instant,
    zone: row.timezone,
    day: DateTime.fromISO(instant).setZone(row.timezone).toISODate()!,
  };
}
async function child(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  unitId: string,
) {
  const row = (
    await tx.query(
      "SELECT s.*,p.name FROM students s JOIN school_people p ON p.id=s.person_id WHERE s.id=$1 AND s.org_id=$2 AND s.unit_id=$3 FOR UPDATE OF s",
      [studentId, actor.org_id, unitId],
    )
  ).rows[0];
  requireCondition(row, 404, "Child not found in this program unit.");
  return row;
}
export async function pickupState(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  day: string,
) {
  const contacts = (
    await tx.query(
      "SELECT c.person_id,c.relationship,c.can_pickup,c.version,c.restriction_note,to_char(c.pickup_until,'YYYY-MM-DD') AS pickup_until,p.name,p.version AS person_version FROM student_contacts c JOIN school_people p ON p.id=c.person_id WHERE c.student_id=$1 AND c.org_id=$2 ORDER BY p.name,c.person_id FOR SHARE OF p",
      [studentId, actor.org_id],
    )
  ).rows;
  const hold = (
    await tx.query(
      "SELECT active,reason,version FROM child_pickup_holds WHERE student_id=$1 AND org_id=$2",
      [studentId, actor.org_id],
    )
  ).rows[0] ?? { active: false, reason: "", version: 0 };
  const restricted = contacts.some((c) => c.restriction_note.trim().length > 0);
  return {
    hold,
    restricted,
    contacts: contacts.map((c): Row & { eligible: boolean } => ({
      ...c,
      eligible:
        !hold.active &&
        !restricted &&
        c.can_pickup &&
        (!c.pickup_until || c.pickup_until >= day),
    })),
  };
}
export async function saveCareProgram(
  db: Database,
  actor: Actor,
  programId: string | null,
  input: z.infer<typeof careProgramInput>,
) {
  return db.transaction(async (tx) => {
    await assertOffice(tx, actor, input.unitId);
    const old = programId
      ? await careProgram(tx, actor, programId, true)
      : null;
    requireCondition(
      !old || old.unit_id === input.unitId,
      400,
      "A program cannot change units.",
    );
    requireCondition(
      (old?.version ?? 0) === input.version,
      409,
      "Program changed. Refresh before saving.",
    );
    const staff = (
      await tx.query(
        "SELECT u.id FROM users u JOIN user_units n ON n.user_id=u.id AND n.org_id=u.org_id WHERE u.org_id=$1 AND u.id=ANY($2::uuid[]) AND u.active AND n.unit_id=$3",
        [actor.org_id, input.staffIds, input.unitId],
      )
    ).rows;
    requireCondition(
      staff.length === input.staffIds.length,
      400,
      "Assign active staff who belong to this unit.",
    );
    const present = old
      ? Number(
          (
            await tx.query(
              "SELECT count(*) AS count FROM care_sessions WHERE program_id=$1 AND checked_out_at IS NULL",
              [old.id],
            )
          ).rows[0].count,
        )
      : 0;
    requireCondition(
      input.capacity >= present,
      409,
      "Capacity cannot be below the number of children currently checked in.",
    );
    requireCondition(
      !input.archived || present === 0,
      409,
      "Check out the children before archiving this program.",
    );
    const program = (
      await tx.query(
        old
          ? "UPDATE care_programs SET name=$4,room=$5,capacity=$6,instructions=$7,confirmed=$8,archived=$9,version=version+1 WHERE id=$1 AND org_id=$2 AND unit_id=$3 RETURNING *"
          : "INSERT INTO care_programs(id,org_id,unit_id,name,room,capacity,instructions,confirmed,archived) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          old?.id ?? randomUUID(),
          actor.org_id,
          input.unitId,
          input.name,
          input.room,
          input.capacity,
          input.instructions,
          input.confirmed,
          input.archived,
        ],
      )
    ).rows[0];
    await tx.query("DELETE FROM care_staff WHERE program_id=$1", [program.id]);
    for (const userId of input.staffIds)
      await tx.query(
        "INSERT INTO care_staff(org_id,unit_id,program_id,user_id) VALUES($1,$2,$3,$4)",
        [actor.org_id, input.unitId, program.id, userId],
      );
    await schoolChange(
      tx,
      actor,
      input.unitId,
      "care.program_saved",
      program.id,
      old,
      { ...program, staffIds: input.staffIds, reason: input.reason },
    );
    return program;
  });
}
export async function saveCareEnrollment(
  db: Database,
  actor: Actor,
  programId: string,
  input: z.infer<typeof careEnrollmentInput>,
) {
  return db.transaction(async (tx) => {
    const program = await careProgram(tx, actor, programId, true);
    await assertOffice(tx, actor, program.unit_id);
    await child(tx, actor, input.studentId, program.unit_id);
    const old = (
      await tx.query(
        "SELECT * FROM care_enrollments WHERE program_id=$1 AND student_id=$2",
        [programId, input.studentId],
      )
    ).rows[0];
    requireCondition(
      (old?.version ?? 0) === input.version,
      409,
      "Enrollment changed. Refresh before saving.",
    );
    const count = Number(
      (
        await tx.query(
          "SELECT count(*) AS count FROM care_enrollments WHERE program_id=$1",
          [programId],
        )
      ).rows[0].count,
    );
    requireCondition(
      !!old || count < 500,
      400,
      "This program has reached its 500-child roster limit.",
    );
    const row = (
      await tx.query(
        "INSERT INTO care_enrollments(org_id,unit_id,program_id,student_id,starts_on,ends_on,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(program_id,student_id) DO UPDATE SET starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,enabled=EXCLUDED.enabled,version=care_enrollments.version+1 RETURNING *",
        [
          actor.org_id,
          program.unit_id,
          programId,
          input.studentId,
          input.startsOn,
          input.endsOn,
          input.enabled,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      program.unit_id,
      "care.enrollment_saved",
      input.studentId,
      old ?? null,
      { ...row, reason: input.reason },
    );
    return row;
  });
}
async function command<T>(
  db: Database,
  actor: Actor,
  commandId: string,
  input: unknown,
  run: (tx: Queryable) => Promise<T>,
  authorize: (tx: Queryable) => Promise<unknown>,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.org_id + actor.id + commandId,
    ]);
    await authorize(tx);
    const fingerprint = digest(JSON.stringify(input)),
      old = (
        await tx.query(
          "SELECT * FROM care_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
          [actor.org_id, actor.id, commandId],
        )
      ).rows[0];
    if (old) {
      requireCondition(
        old.fingerprint === fingerprint,
        409,
        "This command was already used for different information.",
      );
      return old.result as T;
    }
    const result = await run(tx);
    await tx.query(
      "INSERT INTO care_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [actor.org_id, actor.id, commandId, fingerprint, JSON.stringify(result)],
    );
    return result;
  });
}
export type CareTransferOrigin = {
  transferId: string;
  runId: string;
  requesterId: string;
  requesterName: string;
};
// Internal service composition only. Transfer acceptance owns the run/program/child locks
// and validates the pending source before calling this helper; HTTP schemas have no bypass field.
export async function checkInCareTransaction(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof careCheckinInput>,
  origin?: CareTransferOrigin,
) {
  const program = await careProgram(tx, actor, input.programId, true),
    student = await child(tx, actor, input.studentId, program.unit_id),
    now = await clockNow(tx, actor);
  if (origin)
    requireCondition(
      (
        await tx.query(
          "SELECT t.id FROM care_transfers t JOIN dismissal_runs r ON r.id=t.run_id JOIN dismissal_entries e ON e.run_id=t.run_id AND e.student_id=t.student_id JOIN care_staff a ON a.program_id=t.program_id AND a.org_id=t.org_id AND a.user_id=$7 JOIN user_units n ON n.user_id=a.user_id AND n.org_id=a.org_id AND n.unit_id=a.unit_id WHERE t.org_id=$1 AND t.id=$2 AND t.run_id=$3 AND t.student_id=$4 AND t.program_id=$5 AND t.requested_by=$6 AND t.requested_by<>$7 AND t.requester_name=$8 AND t.status='pending' AND r.status='open' AND e.expected AND e.status='present' AND e.mode='care' AND e.care_program_id=t.program_id",
          [
            actor.org_id,
            origin.transferId,
            origin.runId,
            student.id,
            program.id,
            origin.requesterId,
            actor.id,
            origin.requesterName,
          ],
        )
      ).rows.length,
      409,
      "The internal handoff source does not match a pending request for this receiving account.",
    );
  requireCondition(
    program.confirmed && !program.archived,
    409,
    "The office must confirm an active care program before check-in.",
  );
  requireCondition(
    program.version === input.programVersion,
    409,
    "Program instructions changed. Refresh and review them.",
  );
  requireCondition(
    student.active,
    409,
    "An inactive child cannot be checked in.",
  );
  const enrollment = (
    await tx.query(
      "SELECT * FROM care_enrollments WHERE program_id=$1 AND student_id=$2 AND enabled AND $3::date BETWEEN starts_on AND ends_on",
      [program.id, student.id, now.day],
    )
  ).rows[0];
  requireCondition(
    enrollment,
    409,
    "No current care enrollment. Ask the office to update the roster.",
  );
  requireCondition(
    !(
      await tx.query(
        "SELECT id FROM care_sessions WHERE org_id=$1 AND student_id=$2 AND checked_out_at IS NULL",
        [actor.org_id, student.id],
      )
    ).rows.length,
    409,
    "This child is already checked in to a care program.",
  );
  requireCondition(
    !(
      await tx.query(
        "SELECT e.student_id FROM dismissal_entries e JOIN dismissal_runs r ON r.id=e.run_id WHERE e.org_id=$1 AND e.student_id=$2 AND e.expected AND e.status IN ('present','called') AND r.status='open' AND ($3::uuid IS NULL OR e.run_id<>$3)",
        [actor.org_id, student.id, origin?.runId ?? null],
      )
    ).rows.length,
    409,
    "This child is marked present in school dismissal. The office must resolve that handoff before childcare check-in.",
  );
  const count = Number(
    (
      await tx.query(
        "SELECT count(*) AS count FROM care_sessions WHERE program_id=$1 AND checked_out_at IS NULL",
        [program.id],
      )
    ).rows[0].count,
  );
  requireCondition(
    count < program.capacity,
    409,
    "This program is at its configured capacity.",
  );
  const session = (
    await tx.query(
      "INSERT INTO care_sessions(id,org_id,unit_id,program_id,student_id,checked_in_at,entered_by,arrival_name,program_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        randomUUID(),
        actor.org_id,
        program.unit_id,
        program.id,
        student.id,
        now.instant,
        actor.id,
        input.arrivalName,
        JSON.stringify({
          name: program.name,
          room: program.room,
          instructions: program.instructions,
          capacity: program.capacity,
          version: program.version,
          enrollmentVersion: enrollment.version,
          studentName: student.name,
          studentNumber: student.student_number,
          ...(origin ? { dismissalTransfer: origin } : {}),
        }),
      ],
    )
  ).rows[0];
  await schoolChange(
    tx,
    actor,
    program.unit_id,
    "care.checked_in",
    session.id,
    null,
    session,
  );
  return { id: session.id, checkedInAt: now.instant };
}
export async function checkInCare(
  db: Database,
  actor: Actor,
  input: z.infer<typeof careCheckinInput>,
) {
  return command(
    db,
    actor,
    input.commandId,
    { action: "in", ...input },
    (tx) => checkInCareTransaction(tx, actor, input),
    (tx) => careProgram(tx, actor, input.programId, true),
  );
}
async function sessionProgram(tx: Queryable, actor: Actor, sessionId: string) {
  const s = (
    await tx.query(
      "SELECT program_id FROM care_sessions WHERE id=$1 AND org_id=$2",
      [sessionId, actor.org_id],
    )
  ).rows[0];
  requireCondition(s, 404, "Care session not found.");
  return careProgram(tx, actor, s.program_id, true);
}
export async function checkOutCare(
  db: Database,
  actor: Actor,
  sessionId: string,
  input: z.infer<typeof careCheckoutInput>,
) {
  return command(
    db,
    actor,
    input.commandId,
    { action: "out", sessionId, ...input },
    async (tx) => {
      const program = await sessionProgram(tx, actor, sessionId),
        session = (
          await tx.query(
            "SELECT * FROM care_sessions WHERE id=$1 AND org_id=$2 FOR UPDATE",
            [sessionId, actor.org_id],
          )
        ).rows[0];
      await child(tx, actor, session.student_id, program.unit_id);
      const now = await clockNow(tx, actor);
      requireCondition(
        !session.checked_out_at,
        409,
        "This child has already been checked out.",
      );
      const state = await pickupState(tx, actor, session.student_id, now.day);
      requireCondition(
        !state.hold.active && !state.restricted,
        409,
        "Pickup is on hold. Ask the school office to resolve the hold or contact restriction before release.",
      );
      const contact = state.contacts.find(
        (c) => c.person_id === input.contactId,
      );
      requireCondition(
        contact?.eligible,
        409,
        "This person does not have current pickup permission.",
      );
      requireCondition(
        contact.version === input.contactVersion &&
          contact.person_version === input.personVersion,
        409,
        "Pickup permission changed. Refresh and verify the person again.",
      );
      const snapshot = {
        personId: contact.person_id,
        name: contact.name,
        relationship: contact.relationship,
        contactVersion: contact.version,
        personVersion: contact.person_version,
        canPickup: contact.can_pickup,
        pickupUntil: contact.pickup_until,
        identityMethod: input.identityMethod,
        identityConfirmed: true,
        released: true,
      };
      const updated = (
        await tx.query(
          "UPDATE care_sessions SET checked_out_at=$1,released_by=$2,pickup_snapshot=$3,release_note=$4 WHERE id=$5 RETURNING *",
          [
            now.instant,
            actor.id,
            JSON.stringify(snapshot),
            input.note,
            sessionId,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        program.unit_id,
        "care.checked_out",
        session.id,
        session,
        updated,
      );
      return { id: sessionId, checkedOutAt: now.instant };
    },
    (tx) => sessionProgram(tx, actor, sessionId),
  );
}
export async function careTimesheet(
  db: Database,
  actor: Actor,
  input: z.infer<typeof careReportInput>,
  exporting = false,
) {
  return db.transaction(tx => careTimesheetSource(tx, actor, input, { lockProgram: true, auditRead: true, exporting }));
}
export async function careTimesheetSource(
  tx: Queryable, actor: Actor, input: z.infer<typeof careReportInput>,
  options: { lockProgram?: boolean; auditRead?: boolean; exporting?: boolean; now?: Date } = {},
) {
    const program = await careProgram(tx, actor, input.programId, options.lockProgram ?? false);
    await assertOffice(tx, actor, program.unit_id);
    const clock = await clockNow(tx, actor),
      now = options.now ? { ...clock, instant: options.now.toISOString() } : clock,
      from = DateTime.fromISO(input.from, { zone: now.zone })
        .startOf("day")
        .toUTC()
        .toISO()!,
      to = DateTime.fromISO(input.to, { zone: now.zone })
        .plus({ days: 1 })
        .startOf("day")
        .toUTC()
        .toISO()!;
    const rows = (
      await tx.query(
        "SELECT s.*,u.name AS entered_by_name,r.name AS released_by_name FROM care_sessions s JOIN users u ON u.id=s.entered_by LEFT JOIN users r ON r.id=s.released_by WHERE s.org_id=$1 AND s.program_id=$2 AND s.checked_in_at<$3 AND coalesce(s.checked_out_at,$4::timestamptz)>=$5 AND ($6::uuid IS NULL OR s.student_id=$6) ORDER BY s.checked_in_at,s.id LIMIT 5001",
        [
          actor.org_id,
          program.id,
          to,
          now.instant,
          from,
          input.studentId ?? null,
        ],
      )
    ).rows;
    requireCondition(
      rows.length <= 5000,
      400,
      "More than 5,000 sessions match. Narrow the date range or choose one child.",
    );
    const result = rows.map((s) => ({
      id: s.id,
      student_id: s.student_id,
      student_name: s.program_snapshot.studentName,
      student_number: s.program_snapshot.studentNumber,
      program_name: s.program_snapshot.name,
      room: s.program_snapshot.room,
      program_version: s.program_snapshot.version,
      checked_in_at: new Date(s.checked_in_at).toISOString(),
      checked_out_at: s.checked_out_at
        ? new Date(s.checked_out_at).toISOString()
        : null,
      entered_by: s.entered_by_name,
      released_by: s.released_by_name,
      arrival_name: s.arrival_name,
      pickup_name: s.pickup_snapshot?.name ?? "",
      pickup_contact_version: s.pickup_snapshot?.contactVersion ?? "",
      identity_method: s.pickup_snapshot?.identityMethod ?? "",
      release_note: s.release_note ?? "",
      milliseconds_in_range: careMilliseconds(
        new Date(s.checked_in_at).toISOString(),
        s.checked_out_at ? new Date(s.checked_out_at).toISOString() : null,
        from,
        to,
        now.instant,
      ),
      status: s.checked_out_at ? "closed" : "open",
    }));
    if (options.auditRead) await audit(
      tx,
      actor,
      options.exporting
        ? "school.care.timesheets_exported"
        : "school.care.timesheets_viewed",
      program.id,
      {
        unitId: program.unit_id,
        from: input.from,
        to: input.to,
        studentId: input.studentId ?? null,
        rows: result.length,
        asOf: now.instant,
      },
    );
    return {
      program,
      rows: result,
      from: input.from,
      to: input.to,
      timezone: now.zone,
      asOf: now.instant,
      totalMilliseconds: result.reduce(
        (sum, s) => sum + s.milliseconds_in_range,
        0,
      ),
    };
}
export function installCare(app: Express, db: Database) {
  app.get("/api/care/access", async (req, res) => {
    const actor = schoolActor(req),
      offices = await officeUnits(db, actor);
    const programs = (
      await db.query(
        "SELECT p.* FROM care_programs p WHERE p.org_id=$1 AND (p.unit_id=ANY($2::uuid[]) OR (p.unit_id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM care_staff s WHERE s.program_id=p.id AND s.user_id=$4))) ORDER BY p.archived,p.name,p.id",
        [actor.org_id, offices, actor.unit_ids, actor.id],
      )
    ).rows;
    const units = (
      await db.query(
        "SELECT id,name,kind FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY name",
        [actor.org_id, offices],
      )
    ).rows;
    res.json({ programs, officeUnits: offices, units });
  });
  app.post("/api/care/programs", async (req, res) =>
    res
      .status(201)
      .json(
        await saveCareProgram(
          db,
          schoolActor(req),
          null,
          careProgramInput.parse(req.body),
        ),
      ),
  );
  app.patch("/api/care/programs/:id", async (req, res) =>
    res.json(
      await saveCareProgram(
        db,
        schoolActor(req),
        id(req.params.id),
        careProgramInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/care/programs/:id/enrollments", async (req, res) =>
    res.json(
      await saveCareEnrollment(
        db,
        schoolActor(req),
        id(req.params.id),
        careEnrollmentInput.parse(req.body),
      ),
    ),
  );
  app.get("/api/care/programs/:id", async (req, res) =>
    res.json(
      await db.transaction(async (tx) => {
        const actor = schoolActor(req),
          program = await careProgram(tx, actor, id(req.params.id), true),
          now = await clockNow(tx, actor);
        const rows = (
          await tx.query(
            `SELECT e.student_id,s.student_number,s.active,p.name,${dates},e.enabled,e.version,(SELECT h.active FROM child_pickup_holds h WHERE h.student_id=s.id) AS pickup_hold,EXISTS(SELECT 1 FROM student_contacts c WHERE c.student_id=s.id AND length(trim(c.restriction_note))>0) AS restricted FROM care_enrollments e JOIN students s ON s.id=e.student_id JOIN school_people p ON p.id=s.person_id WHERE e.program_id=$1 ORDER BY p.name,e.student_id`,
            [program.id],
          )
        ).rows;
        const present = (
          await tx.query(
            "SELECT s.id,s.student_id,s.checked_in_at,s.arrival_name,p.name,t.student_number FROM care_sessions s JOIN students t ON t.id=s.student_id JOIN school_people p ON p.id=t.person_id WHERE s.program_id=$1 AND s.checked_out_at IS NULL ORDER BY s.checked_in_at,s.id",
            [program.id],
          )
        ).rows;
        const staff = (
          await tx.query(
            "SELECT c.user_id,u.name,u.active FROM care_staff c JOIN users u ON u.id=c.user_id WHERE c.program_id=$1 ORDER BY u.name",
            [program.id],
          )
        ).rows;
        return {
          program,
          rows: rows.filter(
            (r) =>
              program.office ||
              (r.enabled && r.starts_on <= now.day && r.ends_on >= now.day) ||
              present.some((s) => s.student_id === r.student_id),
          ),
          present,
          staff,
          day: now.day,
          asOf: now.instant,
          timezone: now.zone,
        };
      }),
    ),
  );
  app.get("/api/care/sessions/:id/pickup", async (req, res) =>
    res.json(
      await db.transaction(async (tx) => {
        const actor = schoolActor(req),
          sessionId = id(req.params.id),
          program = await sessionProgram(tx, actor, sessionId),
          session = (
            await tx.query(
              "SELECT * FROM care_sessions WHERE id=$1 AND org_id=$2",
              [sessionId, actor.org_id],
            )
          ).rows[0];
        requireCondition(
          !session.checked_out_at,
          409,
          "This session is already closed.",
        );
        const student = await child(
            tx,
            actor,
            session.student_id,
            program.unit_id,
          ),
          now = await clockNow(tx, actor),
          state = await pickupState(tx, actor, student.id, now.day);
        return {
          sessionId,
          student: {
            id: student.id,
            name: student.name,
            number: student.student_number,
          },
          ...state,
          asOf: now.instant,
        };
      }),
    ),
  );
  app.post("/api/care/check-in", async (req, res) =>
    res.json(
      await checkInCare(db, schoolActor(req), careCheckinInput.parse(req.body)),
    ),
  );
  app.post("/api/care/sessions/:id/check-out", async (req, res) =>
    res.json(
      await checkOutCare(
        db,
        schoolActor(req),
        id(req.params.id),
        careCheckoutInput.parse(req.body),
      ),
    ),
  );
  app.get("/api/care/students/:id/hold", async (req, res) => {
    const actor = schoolActor(req),
      studentId = id(req.params.id),
      student = (
        await db.query(
          "SELECT unit_id FROM students WHERE id=$1 AND org_id=$2",
          [studentId, actor.org_id],
        )
      ).rows[0];
    requireCondition(student, 404, "Child not found.");
    await assertOffice(db, actor, student.unit_id);
    res.json(
      (
        await db.query(
          "SELECT active,reason,version FROM child_pickup_holds WHERE student_id=$1",
          [studentId],
        )
      ).rows[0] ?? { active: false, reason: "", version: 0 },
    );
  });
  app.put("/api/care/students/:id/hold", async (req, res) => {
    const actor = schoolActor(req),
      studentId = id(req.params.id),
      input = careHoldInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const student = (
          await tx.query(
            "SELECT * FROM students WHERE id=$1 AND org_id=$2 FOR UPDATE",
            [studentId, actor.org_id],
          )
        ).rows[0];
        requireCondition(student, 404, "Child not found.");
        await assertOffice(tx, actor, student.unit_id);
        const old = (
          await tx.query(
            "SELECT * FROM child_pickup_holds WHERE student_id=$1",
            [studentId],
          )
        ).rows[0];
        requireCondition(
          (old?.version ?? 0) === input.version,
          409,
          "Pickup hold changed. Refresh before saving.",
        );
        const row = (
          await tx.query(
            "INSERT INTO child_pickup_holds(org_id,unit_id,student_id,active,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(student_id) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,version=child_pickup_holds.version+1 RETURNING *",
            [
              actor.org_id,
              student.unit_id,
              studentId,
              input.active,
              input.reason,
            ],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          student.unit_id,
          "care.pickup_hold",
          studentId,
          old ?? null,
          row,
        );
        return row;
      }),
    );
  });
  app.get("/api/care/timesheets", async (req, res) =>
    res.json(
      await careTimesheet(
        db,
        schoolActor(req),
        careReportInput.parse(req.query),
      ),
    ),
  );
  app.get("/api/care/timesheets/export", async (req, res) => {
    const report = await careTimesheet(
      db,
      schoolActor(req),
      careReportInput.parse(req.query),
      true,
    );
    const rows = report.rows.map((r) => ({
      ...r,
      range_from: report.from,
      range_to: report.to,
      timezone: report.timezone,
      as_of: report.asOf,
    }));
    res
      .type("text/csv")
      .attachment("child-care-timesheets.csv")
      .send(
        toCsv(rows, [
          "id",
          "student_id",
          "student_name",
          "student_number",
          "program_name",
          "room",
          "program_version",
          "checked_in_at",
          "checked_out_at",
          "entered_by",
          "released_by",
          "arrival_name",
          "pickup_name",
          "pickup_contact_version",
          "identity_method",
          "release_note",
          "status",
          "milliseconds_in_range",
          "range_from",
          "range_to",
          "timezone",
          "as_of",
        ]),
      );
  });
}
