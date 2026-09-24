import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { audit, requireCondition, type Actor } from "./security";
import { lockAcademics, validateAcademicChange } from "./timetable-engine";
import { listPeople, createPerson, updatePerson } from "./school-people";
import {
  schoolYearInput,
  termInput,
  householdInput,
  householdUpdateInput,
  studentInput,
  studentUpdateInput,
  enrollmentInput,
  contactInput,
  courseInput,
  sectionInput,
  sectionUpdateInput,
  rosterInput,
  curriculumInput,
} from "../shared/school";
const id = (value: unknown) => z.uuid().parse(value);
export const schoolAdmin = (actor: Actor) =>
  actor.mode === "password" && ["developer", "owner", "admin"].includes(actor.role);
export const schoolActor = (req: Request) => {
  const actor = (req as AppRequest).actor;
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to open school records.",
  );
  return actor;
};
export async function officeUnits(
  tx: Queryable,
  actor: Actor,
): Promise<string[]> {
  if (actor.mode !== "password") return [];
  if (schoolAdmin(actor))
    return (
      await tx.query("SELECT id FROM units WHERE org_id=$1", [actor.org_id])
    ).rows.map((row) => row.id);
  return (
    await tx.query(
      "SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=ANY($3::uuid[])",
      [actor.org_id, actor.id, actor.unit_ids],
    )
  ).rows.map((row) => row.unit_id);
}
export async function assertOffice(
  tx: Queryable,
  actor: Actor,
  unitId: string,
) {
  requireCondition(
    (await officeUnits(tx, actor)).includes(unitId),
    403,
    "School office access to this unit is required.",
  );
}
export async function schoolChange(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  kind: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.query(
    "INSERT INTO school_history(id,org_id,unit_id,entity_type,entity_id,actor_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      actor.org_id,
      unitId,
      kind,
      entityId,
      actor.id,
      JSON.stringify({ before, after }),
    ],
  );
  await audit(tx, actor, "school." + kind, entityId, { unitId });
}
async function yearById(
  tx: Queryable,
  actor: Actor,
  yearId: string,
  unitId: string,
) {
  const year = (
    await tx.query(
      `SELECT *,${dateSql} FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3`,
      [yearId, actor.org_id, unitId],
    )
  ).rows[0];
  requireCondition(
    year && !year.archived,
    404,
    "Active school year not found in this unit.",
  );
  return year;
}
function insideYear(year: Row, starts: string, ends: string) {
  requireCondition(
    starts >= String(year.starts_on).slice(0, 10) &&
      ends <= String(year.ends_on).slice(0, 10),
    400,
    "Dates must fit within the school year.",
  );
}
const dateSql =
  "to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on";
export function peakRoster(rows: { starts_on: string; ends_on: string }[]) {
  const changes = new Map<number, number>();
  for (const row of rows) {
    const start = Date.parse(row.starts_on + "T00:00:00Z"),
      end = Date.parse(row.ends_on + "T00:00:00Z") + 86400000;
    changes.set(start, (changes.get(start) ?? 0) + 1);
    changes.set(end, (changes.get(end) ?? 0) - 1);
  }
  let current = 0,
    peak = 0;
  for (const [, delta] of [...changes].sort((a, b) => a[0] - b[0])) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}
export async function sectionById(
  tx: Queryable,
  actor: Actor,
  sectionId: string,
  lock = false,
): Promise<Row & { office: boolean }> {
  const section = (
    await tx.query(
      "SELECT * FROM sections WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [sectionId, actor.org_id],
    )
  ).rows[0];
  requireCondition(section, 404, "Class not found.");
  const office = (await officeUnits(tx, actor)).includes(section.unit_id);
  const assigned =
    actor.mode === "password" &&
    actor.unit_ids.includes(section.unit_id) &&
    (
      await tx.query(
        "SELECT user_id FROM section_teachers WHERE section_id=$1 AND org_id=$2 AND user_id=$3",
        [sectionId, actor.org_id, actor.id],
      )
    ).rows.length > 0;
  requireCondition(office || assigned, 404, "Class not found.");
  return { ...section, office };
}
export async function studentById(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  officeOnly = false,
  lock = false,
): Promise<Row & { office: boolean }> {
  const student = (
    await tx.query(
      `SELECT s.*,p.name,to_char(p.date_of_birth,'YYYY-MM-DD') AS date_of_birth FROM students s JOIN school_people p ON p.id=s.person_id WHERE s.id=$1 AND s.org_id=$2` +
        (lock ? " FOR UPDATE OF s" : ""),
      [studentId, actor.org_id],
    )
  ).rows[0];
  requireCondition(student, 404, "Student not found.");
  const office = (await officeUnits(tx, actor)).includes(student.unit_id);
  const assigned =
    !officeOnly &&
    student.active &&
    actor.mode === "password" &&
    actor.unit_ids.includes(student.unit_id) &&
    (
      await tx.query(
        `SELECT e.section_id FROM section_students e JOIN section_teachers t ON t.section_id=e.section_id JOIN sections c ON c.id=e.section_id JOIN student_enrollments n ON n.student_id=e.student_id AND n.year_id=c.year_id JOIN organizations o ON o.id=e.org_id WHERE e.student_id=$1 AND e.org_id=$2 AND t.user_id=$3 AND NOT c.archived AND (now() AT TIME ZONE o.timezone)::date BETWEEN e.starts_on AND e.ends_on AND (now() AT TIME ZONE o.timezone)::date BETWEEN n.starts_on AND n.ends_on`,
        [studentId, actor.org_id, actor.id],
      )
    ).rows.length > 0;
  requireCondition(office || assigned, 404, "Student not found.");
  return { ...student, office };
}
async function validateTeachers(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  teacherIds: string[],
) {
  if (!teacherIds.length) return;
  const permitted = (
    await tx.query(
      `SELECT u.id FROM users u WHERE u.org_id=$1 AND u.id=ANY($2::uuid[]) AND u.active AND EXISTS(SELECT 1 FROM user_units n WHERE n.user_id=u.id AND n.org_id=u.org_id AND n.unit_id=$3)`,
      [actor.org_id, teacherIds, unitId],
    )
  ).rows;
  requireCondition(
    permitted.length === teacherIds.length,
    400,
    "Teachers must be active staff assigned to this unit.",
  );
}
export async function createStudent(
  db: Database,
  actor: Actor,
  input: z.infer<typeof studentInput>,
) {
  return db.transaction((tx) => createStudentTransaction(tx, actor, input));
}
export async function createStudentTransaction(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof studentInput>,
) {
  await assertOffice(tx, actor, input.unitId);
  if (input.householdId)
    requireCondition(
      (
        await tx.query(
          "SELECT id FROM households WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND NOT archived",
          [input.householdId, actor.org_id, input.unitId],
        )
      ).rows.length,
      404,
      "Household not found in this unit.",
    );
  const personId = randomUUID(),
    studentId = randomUUID();
  await tx.query(
    "INSERT INTO school_people(id,org_id,unit_id,name,date_of_birth) VALUES($1,$2,$3,$4,$5)",
    [personId, actor.org_id, input.unitId, input.name, input.dateOfBirth],
  );
  const row = (
    await tx.query(
      "INSERT INTO students(id,org_id,unit_id,person_id,student_number) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [studentId, actor.org_id, input.unitId, personId, input.studentNumber],
    )
  ).rows[0];
  if (input.householdId)
    await tx.query(
      "INSERT INTO household_members(org_id,unit_id,household_id,person_id,role) VALUES($1,$2,$3,$4,'student')",
      [actor.org_id, input.unitId, input.householdId, personId],
    );
  await schoolChange(
    tx,
    actor,
    input.unitId,
    "student.created",
    studentId,
    null,
    { ...row, ...input },
  );
  return row;
}
export async function saveEnrollment(
  db: Database,
  actor: Actor,
  studentId: string,
  input: z.infer<typeof enrollmentInput>,
  version?: number,
) {
  return db.transaction((tx) =>
    saveEnrollmentTransaction(tx, actor, studentId, input, version),
  );
}
export async function saveEnrollmentTransaction(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  input: z.infer<typeof enrollmentInput>,
  version?: number,
) {
  const student = await studentById(tx, actor, studentId, true, true);
  requireCondition(
    student.active,
    409,
    "Reactivate this student before enrollment.",
  );
  const year = await yearById(tx, actor, input.yearId, student.unit_id);
  insideYear(year, input.startsOn, input.endsOn);
  const old = (
    await tx.query(
      "SELECT * FROM student_enrollments WHERE student_id=$1 AND year_id=$2 FOR UPDATE",
      [studentId, input.yearId],
    )
  ).rows[0];
  if (old)
    requireCondition(
      old.version === version,
      409,
      "Enrollment changed. Refresh before saving.",
    );
  const row = (
    await tx.query(
      `INSERT INTO student_enrollments(id,org_id,unit_id,student_id,year_id,grade_level,starts_on,ends_on,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(student_id,year_id) DO UPDATE SET grade_level=EXCLUDED.grade_level,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,status=EXCLUDED.status,version=student_enrollments.version+1 RETURNING *`,
      [
        randomUUID(),
        actor.org_id,
        student.unit_id,
        studentId,
        input.yearId,
        input.gradeLevel,
        input.startsOn,
        input.endsOn,
        input.status,
      ],
    )
  ).rows[0];
  await schoolChange(
    tx,
    actor,
    student.unit_id,
    "enrollment.saved",
    row.id,
    old ?? null,
    row,
  );
  return row;
}
export async function createSection(
  db: Database,
  actor: Actor,
  input: z.infer<typeof sectionInput>,
) {
  return db.transaction(async (tx) => {
    await assertOffice(tx, actor, input.unitId);
    await yearById(tx, actor, input.yearId, input.unitId);
    await validateTeachers(tx, actor, input.unitId, input.teacherIds);
    if (input.courseId)
      requireCondition(
        (
          await tx.query(
            "SELECT id FROM courses WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND NOT archived",
            [input.courseId, actor.org_id, input.unitId],
          )
        ).rows.length,
        404,
        "Course not found in this unit.",
      );
    const row = (
      await tx.query(
        "INSERT INTO sections(id,org_id,unit_id,year_id,course_id,name,homeroom,capacity,room) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          input.unitId,
          input.yearId,
          input.courseId,
          input.name,
          input.homeroom,
          input.capacity,
          input.room,
        ],
      )
    ).rows[0];
    for (const teacher of input.teacherIds)
      await tx.query(
        "INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)",
        [actor.org_id, input.unitId, row.id, teacher],
      );
    await schoolChange(
      tx,
      actor,
      input.unitId,
      "section.created",
      row.id,
      null,
      { ...row, teacherIds: input.teacherIds },
    );
    return row;
  });
}
export type RosterInput = z.infer<typeof rosterInput>;
/** Validation is shared by a single-row edit and a complete import. Locks always start with students. */
export async function prepareRosterBatch(
  tx: Queryable,
  actor: Actor,
  sectionId: string,
  inputs: RosterInput[],
  lock = false,
) {
  requireCondition(
    inputs.length > 0 && inputs.length <= 500,
    400,
    "Choose between 1 and 500 roster rows.",
  );
  requireCondition(
    new Set(inputs.map((row) => row.studentId)).size === inputs.length,
    400,
    "Choose each student once.",
  );
  const students = new Map<string, Row>();
  for (const studentId of inputs.map((row) => row.studentId).sort()) {
    students.set(
      studentId,
      await studentById(tx, actor, studentId, true, lock),
    );
  }
  const section = await sectionById(tx, actor, sectionId, lock);
  await assertOffice(tx, actor, section.unit_id);
  requireCondition(!section.archived, 409, "Choose an active class.");
  const existing = (
    await tx.query(
      `SELECT student_id,version,${dateSql} FROM section_students WHERE section_id=$1 ORDER BY student_id`,
      [sectionId],
    )
  ).rows;
  const rows: {
    input: RosterInput;
    student: Row;
    enrollment: Row | null;
    old: Row | null;
    errors: string[];
  }[] = [];
  for (const input of inputs) {
    const student = students.get(input.studentId)!;
    const enrollment =
      (
        await tx.query(
          `SELECT id,version,status,grade_level,${dateSql} FROM student_enrollments WHERE student_id=$1 AND year_id=$2`,
          [input.studentId, section.year_id],
        )
      ).rows[0] ?? null;
    const old =
      existing.find((row) => row.student_id === input.studentId) ?? null;
    const errors: string[] = [];
    if (!student.active || student.unit_id !== section.unit_id)
      errors.push("Choose an active student in this class’s unit.");
    if (!enrollment || enrollment.status !== "enrolled")
      errors.push("Enroll the student in this school year first.");
    else if (
      input.startsOn < enrollment.starts_on ||
      input.endsOn > enrollment.ends_on
    )
      errors.push("Dates must fit within the student’s enrollment.");
    if (old && old.version !== input.version)
      errors.push("Roster changed. Refresh before editing dates.");
    if (
      section.homeroom &&
      (
        await tx.query(
          "SELECT s.id FROM section_students r JOIN sections s ON s.id=r.section_id WHERE r.student_id=$1 AND s.year_id=$2 AND s.homeroom AND NOT s.archived AND s.id<>$3 AND r.starts_on<=$4 AND r.ends_on>=$5",
          [
            input.studentId,
            section.year_id,
            sectionId,
            input.endsOn,
            input.startsOn,
          ],
        )
      ).rows.length
    )
      errors.push("This student already has a homeroom during these dates.");
    rows.push({ input, student, enrollment, old, errors });
  }
  const changed = new Set(inputs.map((row) => row.studentId));
  const finalRoster = [
    ...existing.filter((row) => !changed.has(row.student_id)),
    ...inputs.map((row) => ({ starts_on: row.startsOn, ends_on: row.endsOn })),
  ];
  const peak = peakRoster(
    finalRoster as { starts_on: string; ends_on: string }[],
  );
  if (peak > section.capacity)
    for (const row of rows)
      row.errors.push("This class is at capacity for the selected dates.");
  return { section, rows, existing, peak };
}
export async function saveRosterBatchTransaction(
  tx: Queryable,
  actor: Actor,
  sectionId: string,
  inputs: RosterInput[],
) {
  await lockAcademics(tx, actor.org_id);
  const plan = await prepareRosterBatch(tx, actor, sectionId, inputs, true);
  const error = plan.rows.flatMap((row) => row.errors)[0];
  requireCondition(!error, 409, error ?? "Roster could not be saved.");
  const results: Row[] = [];
  for (const { input, old } of plan.rows) {
    const row = (
      await tx.query(
        "INSERT INTO section_students(org_id,unit_id,section_id,student_id,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(section_id,student_id) DO UPDATE SET starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,version=section_students.version+1 RETURNING *",
        [
          actor.org_id,
          plan.section.unit_id,
          sectionId,
          input.studentId,
          input.startsOn,
          input.endsOn,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      plan.section.unit_id,
      "roster.saved",
      sectionId,
      old,
      row,
    );
    results.push(row);
  }
  await validateAcademicChange(tx, actor.org_id);
  return results;
}
export async function saveRoster(
  db: Database,
  actor: Actor,
  sectionId: string,
  input: RosterInput,
) {
  return db.transaction(
    async (tx) =>
      (await saveRosterBatchTransaction(tx, actor, sectionId, [input]))[0],
  );
}

export async function saveContactTransaction(tx: Queryable, actor: Actor, studentId: string, input: z.infer<typeof contactInput>) {
      const student = await studentById(tx, actor, studentId, true, true);
      const person = (
        await tx.query(
          "SELECT id FROM school_people WHERE id=$1 AND org_id=$2 AND unit_id=$3 FOR SHARE",
          [input.personId, actor.org_id, student.unit_id],
        )
      ).rows[0];
      requireCondition(
        person && person.id !== student.person_id,
        404,
        "Contact person not found in this unit.",
      );
      requireCondition(
        !(
          await tx.query("SELECT id FROM students WHERE person_id=$1", [
            person.id,
          ])
        ).rows.length,
        400,
        "A student cannot be designated as their own or another student’s adult contact.",
      );
      const old = (
        await tx.query(
          "SELECT * FROM student_contacts WHERE student_id=$1 AND person_id=$2",
          [studentId, input.personId],
        )
      ).rows[0];
      if (old)
        requireCondition(
          old.version === input.version,
          409,
          "Contact permissions changed. Refresh before editing.",
        );
      const row = (
        await tx.query(
          `INSERT INTO student_contacts(org_id,unit_id,student_id,person_id,relationship,is_guardian,can_communicate,can_pickup,pickup_until,emergency_priority,restriction_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(student_id,person_id) DO UPDATE SET relationship=EXCLUDED.relationship,is_guardian=EXCLUDED.is_guardian,can_communicate=EXCLUDED.can_communicate,can_pickup=EXCLUDED.can_pickup,pickup_until=EXCLUDED.pickup_until,emergency_priority=EXCLUDED.emergency_priority,restriction_note=EXCLUDED.restriction_note,version=student_contacts.version+1 RETURNING *`,
          [
            actor.org_id,
            student.unit_id,
            studentId,
            input.personId,
            input.relationship,
            input.isGuardian,
            input.canCommunicate,
            input.canPickup,
            input.pickupUntil,
            input.emergencyPriority,
            input.restrictionNote,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        student.unit_id,
        "contact.permissions_saved",
        studentId,
        old ?? null,
        row,
      );
      return row;
}

export async function createHouseholdTransaction(tx: Queryable, actor: Actor, input: z.infer<typeof householdInput>) {
      await assertOffice(tx, actor, input.unitId);
      const created = (
        await tx.query(
          "INSERT INTO households(id,org_id,unit_id,name,address) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [randomUUID(), actor.org_id, input.unitId, input.name, input.address],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "household.created",
        created.id,
        null,
        created,
      );
      return created;
}

export async function updateHouseholdTransaction(tx: Queryable, actor: Actor, householdId: string, input: z.infer<typeof householdUpdateInput>) {
      const old = (
        await tx.query(
          "SELECT * FROM households WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [householdId, actor.org_id],
        )
      ).rows[0];
      requireCondition(old, 404, "Household not found.");
      await assertOffice(tx, actor, old.unit_id);
      requireCondition(
        old.version === input.version,
        409,
        "Household changed. Refresh first.",
      );
      const updated = (
        await tx.query(
          "UPDATE households SET name=$1,address=$2,archived=$3,version=version+1 WHERE id=$4 RETURNING *",
          [input.name, input.address, input.archived, householdId],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        old.unit_id,
        "household.updated",
        householdId,
        old,
        updated,
      );
      return updated;
}

export async function saveHouseholdMemberTransaction(tx: Queryable, actor: Actor, householdId: string, input: {personId:string;role:"student"|"guardian"|"other";remove:boolean}) {
      const household = (
        await tx.query(
          "SELECT * FROM households WHERE id=$1 AND org_id=$2 FOR NO KEY UPDATE",
          [householdId, actor.org_id],
        )
      ).rows[0];
      requireCondition(
        household && !household.archived,
        404,
        "Active household not found.",
      );
      await assertOffice(tx, actor, household.unit_id);
      requireCondition(
        (
          await tx.query(
            "SELECT id FROM school_people WHERE id=$1 AND org_id=$2 AND unit_id=$3 FOR SHARE",
            [input.personId, actor.org_id, household.unit_id],
          )
        ).rows.length,
        404,
        "Person not found in this unit.",
      );
      if (input.remove)
        await tx.query(
          "DELETE FROM household_members WHERE household_id=$1 AND person_id=$2",
          [householdId, input.personId],
        );
      else
        await tx.query(
          "INSERT INTO household_members(org_id,unit_id,household_id,person_id,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(household_id,person_id) DO UPDATE SET role=EXCLUDED.role",
          [
            actor.org_id,
            household.unit_id,
            householdId,
            input.personId,
            input.role,
          ],
        );
      await schoolChange(
        tx,
        actor,
        household.unit_id,
        "household.membership_changed",
        householdId,
        null,
        input,
      );
}

export function installSchool(app: Express, db: Database) {
  app.get("/api/school/access", async (req, res) => {
    const actor = schoolActor(req),
      offices = await officeUnits(db, actor);
    const units = (
      await db.query(
        "SELECT id,name,kind FROM units WHERE org_id=$1 AND (id=ANY($2::uuid[]) OR (id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM section_teachers t WHERE t.unit_id=units.id AND t.user_id=$4))) ORDER BY name",
        [actor.org_id, offices, actor.unit_ids, actor.id],
      )
    ).rows;
    res.json({ officeUnits: offices, units, admin: schoolAdmin(actor) });
  });
  app.get("/api/school/staff", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId);
    await assertOffice(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT u.id,u.name FROM users u JOIN user_units n ON n.user_id=u.id AND n.org_id=u.org_id WHERE u.org_id=$1 AND n.unit_id=$2 AND u.active ORDER BY u.name",
          [actor.org_id, unitId],
        )
      ).rows,
    });
  });
  app.get("/api/school/years", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId);
    const offices = await officeUnits(db, actor);
    requireCondition(
      offices.includes(unitId) ||
        (actor.unit_ids.includes(unitId) &&
          (
            await db.query(
              "SELECT section_id FROM section_teachers WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
              [actor.org_id, unitId, actor.id],
            )
          ).rows.length),
      403,
      "School access required.",
    );
    res.json({
      rows: (
        await db.query(
          `SELECT *,${dateSql} FROM school_years WHERE org_id=$1 AND unit_id=$2 ORDER BY school_years.starts_on DESC`,
          [actor.org_id, unitId],
        )
      ).rows,
    });
  });
  app.post("/api/school/years", async (req, res) => {
    const actor = schoolActor(req),
      input = schoolYearInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      await assertOffice(tx, actor, input.unitId);
      const created = (
        await tx.query(
          "INSERT INTO school_years(id,org_id,unit_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            input.unitId,
            input.name,
            input.startsOn,
            input.endsOn,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "year.created",
        created.id,
        null,
        input,
      );
      return created;
    });
    res.status(201).json(row);
  });
  app.get("/api/school/terms", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId),
      yearId = id(req.query.yearId);
    await assertOffice(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          `SELECT *,${dateSql} FROM school_terms WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 ORDER BY school_terms.starts_on`,
          [actor.org_id, unitId, yearId],
        )
      ).rows,
    });
  });
  app.post("/api/school/terms", async (req, res) => {
    const actor = schoolActor(req),
      input = termInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const year = (
        await tx.query(
          `SELECT *,${dateSql} FROM school_years WHERE id=$1 AND org_id=$2`,
          [input.yearId, actor.org_id],
        )
      ).rows[0];
      requireCondition(year && !year.archived, 404, "Active year not found.");
      await assertOffice(tx, actor, year.unit_id);
      insideYear(year, input.startsOn, input.endsOn);
      const created = (
        await tx.query(
          "INSERT INTO school_terms(id,org_id,unit_id,year_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            year.unit_id,
            year.id,
            input.name,
            input.startsOn,
            input.endsOn,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        year.unit_id,
        "term.created",
        created.id,
        null,
        input,
      );
      return created;
    });
    res.status(201).json(row);
  });
  app.get("/api/school/office-grants", async (req, res) => {
    const actor = schoolActor(req);
    requireCondition(schoolAdmin(actor), 403, "Administrator access required.");
    res.json({
      rows: (
        await db.query(
          "SELECT g.*,u.name,n.name AS unit_name FROM school_office_grants g JOIN users u ON u.id=g.user_id JOIN units n ON n.id=g.unit_id WHERE g.org_id=$1 ORDER BY u.name",
          [actor.org_id],
        )
      ).rows,
    });
  });
  app.post("/api/school/office-grants", async (req, res) => {
    const actor = schoolActor(req);
    requireCondition(schoolAdmin(actor), 403, "Administrator access required.");
    const input = z
      .object({ unitId: z.uuid(), userId: z.uuid(), enabled: z.boolean() })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      if (input.enabled)
        await validateTeachers(tx, actor, input.unitId, [input.userId]);
      if (input.enabled)
        await tx.query(
          "INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT(unit_id,user_id) DO NOTHING",
          [actor.org_id, input.unitId, input.userId, actor.id],
        );
      else
        await tx.query(
          "DELETE FROM school_office_grants WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
          [actor.org_id, input.unitId, input.userId],
        );
      await audit(
        tx,
        actor,
        "school.office_access_changed",
        input.userId,
        input,
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/school/students", async (req, res) => {
    const actor = schoolActor(req),
      query = z
        .object({
          unitId: z.uuid(),
          search: z.string().max(100).default(""),
          offset: z.coerce.number().int().min(0).max(50000).default(0),
        })
        .strict()
        .parse(req.query);
    await assertOffice(db, actor, query.unitId);
    const rows = (
      await db.query(
        `SELECT s.id,s.student_number,s.active,s.version,p.name,to_char(p.date_of_birth,'YYYY-MM-DD') AS date_of_birth FROM students s JOIN school_people p ON p.id=s.person_id WHERE s.org_id=$1 AND s.unit_id=$2 AND (p.name ILIKE $3 OR s.student_number ILIKE $3) ORDER BY p.name,s.id LIMIT 101 OFFSET $4`,
        [
          actor.org_id,
          query.unitId,
          "%" + query.search.replace(/[\\%_]/g, "\\$&") + "%",
          query.offset,
        ],
      )
    ).rows;
    res.json({ rows: rows.slice(0, 100), hasMore: rows.length > 100 });
  });
  app.post("/api/school/students", async (req, res) =>
    res
      .status(201)
      .json(
        await createStudent(db, schoolActor(req), studentInput.parse(req.body)),
      ),
  );
  app.get("/api/school/students/:id", async (req, res) => {
    const actor = schoolActor(req),
      student = await studentById(db, actor, id(req.params.id));
    const contacts = (
      await db.query(
        `SELECT c.*,p.name,p.email,p.phone FROM student_contacts c JOIN school_people p ON p.id=c.person_id WHERE c.student_id=$1 AND c.org_id=$2 AND ($3::boolean OR c.can_communicate) ORDER BY c.emergency_priority NULLS LAST,p.name`,
        [student.id, actor.org_id, student.office],
      )
    ).rows;
    const enrollments = (
      await db.query(
        `SELECT e.*,to_char(e.starts_on,'YYYY-MM-DD') AS starts_on,to_char(e.ends_on,'YYYY-MM-DD') AS ends_on,y.name AS year_name FROM student_enrollments e JOIN school_years y ON y.id=e.year_id WHERE e.student_id=$1 AND e.org_id=$2 ORDER BY e.starts_on DESC`,
        [student.id, actor.org_id],
      )
    ).rows;
    res.json({
      student: student.office
        ? student
        : {
            id: student.id,
            name: student.name,
            student_number: student.student_number,
            unit_id: student.unit_id,
            office: false,
          },
      contacts: student.office
        ? contacts
        : contacts.map((c) => ({
            name: c.name,
            email: c.email,
            phone: c.phone,
            relationship: c.relationship,
          })),
      enrollments: student.office
        ? enrollments
        : enrollments.map((e) => ({
            grade_level: e.grade_level,
            year_name: e.year_name,
          })),
      households: student.office
        ? (
            await db.query(
              "SELECT h.id,h.name FROM household_members m JOIN households h ON h.id=m.household_id WHERE m.person_id=$1 AND m.org_id=$2",
              [student.person_id, actor.org_id],
            )
          ).rows
        : [],
    });
  });
  app.patch("/api/school/students/:id", async (req, res) => {
    const actor = schoolActor(req),
      studentId = id(req.params.id),
      input = studentUpdateInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const old = await studentById(tx, actor, studentId, true, true);
      requireCondition(
        old.version === input.version,
        409,
        "Student record changed. Refresh first.",
      );
      if (!input.active)
        requireCondition(
          !(
            await tx.query(
              "SELECT id FROM student_enrollments WHERE student_id=$1 AND status='enrolled' AND ends_on>=CURRENT_DATE",
              [studentId],
            )
          ).rows.length,
          409,
          "Withdraw or complete current enrollments before making the student inactive.",
        );
      await tx.query(
        "UPDATE school_people SET name=$1,date_of_birth=$2,version=version+1 WHERE id=$3",
        [input.name, input.dateOfBirth, old.person_id],
      );
      const updated = (
        await tx.query(
          "UPDATE students SET student_number=$1,active=$2,version=version+1 WHERE id=$3 RETURNING *",
          [input.studentNumber, input.active, studentId],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        old.unit_id,
        "student.updated",
        studentId,
        old,
        { ...updated, name: input.name, date_of_birth: input.dateOfBirth },
      );
      return updated;
    });
    res.json(row);
  });
  app.post("/api/school/students/:id/enrollments", async (req, res) => {
    const input = z
      .object({
        enrollment: enrollmentInput,
        version: z.number().int().positive().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      await saveEnrollment(
        db,
        schoolActor(req),
        id(req.params.id),
        input.enrollment,
        input.version,
      ),
    );
  });
  app.post("/api/school/students/:id/contacts", async (req, res) => {
    await db.transaction(tx=>saveContactTransaction(tx,schoolActor(req),id(req.params.id),contactInput.parse(req.body)));
    res.json({ok:true});
  });
  app.get("/api/school/households", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId);
    await assertOffice(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT h.*,(SELECT count(*)::integer FROM household_members m WHERE m.household_id=h.id) AS members FROM households h WHERE h.org_id=$1 AND h.unit_id=$2 ORDER BY h.name LIMIT 1000",
          [actor.org_id, unitId],
        )
      ).rows,
    });
  });
  app.post("/api/school/households", async (req,res)=>{
    const row=await db.transaction(tx=>createHouseholdTransaction(tx,schoolActor(req),householdInput.parse(req.body)));
    res.status(201).json(row);
  });
  app.patch("/api/school/households/:id", async (req,res)=>{
    const row=await db.transaction(tx=>updateHouseholdTransaction(tx,schoolActor(req),id(req.params.id),householdUpdateInput.parse(req.body)));
    res.json(row);
  });
  app.get("/api/school/households/:id", async (req, res) => {
    const actor = schoolActor(req),
      householdId = id(req.params.id),
      household = (
        await db.query("SELECT * FROM households WHERE id=$1 AND org_id=$2", [
          householdId,
          actor.org_id,
        ])
      ).rows[0];
    requireCondition(household, 404, "Household not found.");
    await assertOffice(db, actor, household.unit_id);
    res.json({
      household,
      members: (
        await db.query(
          "SELECT p.*,m.role,s.id AS student_id FROM household_members m JOIN school_people p ON p.id=m.person_id LEFT JOIN students s ON s.person_id=p.id WHERE m.household_id=$1 AND m.org_id=$2 ORDER BY p.name",
          [householdId, actor.org_id],
        )
      ).rows,
    });
  });
  app.post("/api/school/households/:id/members",async(req,res)=>{
    const input=z.object({personId:z.uuid(),role:z.enum(["student","guardian","other"]),remove:z.boolean().default(false)}).strict().parse(req.body);
    await db.transaction(tx=>saveHouseholdMemberTransaction(tx,schoolActor(req),id(req.params.id),input));
    res.json({ok:true});
  });
  app.get("/api/school/people", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await listPeople(db, schoolActor(req), req.query.unitId, (req as unknown as AppRequest).sessionHash));
  });
  app.post("/api/school/people", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.status(201).json(await createPerson(db, schoolActor(req), req.body, (req as unknown as AppRequest).sessionHash));
  });
  app.patch("/api/school/people/:id", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await updatePerson(db, schoolActor(req), req.params.id, req.body, (req as unknown as AppRequest).sessionHash));
  });
  app.get("/api/school/courses", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId);
    await assertOffice(db, actor, unitId);
    res.json({
      rows: (
        await db.query(
          "SELECT * FROM courses WHERE org_id=$1 AND unit_id=$2 ORDER BY title",
          [actor.org_id, unitId],
        )
      ).rows,
    });
  });
  app.post("/api/school/courses", async (req, res) => {
    const actor = schoolActor(req),
      input = courseInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      await assertOffice(tx, actor, input.unitId);
      const created = (
        await tx.query(
          "INSERT INTO courses(id,org_id,unit_id,code,title,description) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            input.unitId,
            input.code,
            input.title,
            input.description,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "course.created",
        created.id,
        null,
        created,
      );
      return created;
    });
    res.status(201).json(row);
  });
  app.get("/api/school/sections", async (req, res) => {
    const actor = schoolActor(req),
      query = z
        .object({ unitId: z.uuid(), yearId: z.uuid().optional() })
        .strict()
        .parse(req.query),
      offices = await officeUnits(db, actor);
    res.json({
      rows: (
        await db.query(
          `SELECT s.*,y.name AS year_name,c.title AS course_title,(SELECT count(*)::integer FROM section_students r WHERE r.section_id=s.id) AS roster_count,(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name)),'[]') FROM section_teachers t JOIN users u ON u.id=t.user_id WHERE t.section_id=s.id) AS teachers FROM sections s JOIN school_years y ON y.id=s.year_id LEFT JOIN courses c ON c.id=s.course_id WHERE s.org_id=$1 AND s.unit_id=$2 AND ($3::uuid IS NULL OR s.year_id=$3) AND (s.unit_id=ANY($4::uuid[]) OR (s.unit_id=ANY($5::uuid[]) AND EXISTS(SELECT 1 FROM section_teachers t WHERE t.section_id=s.id AND t.user_id=$6))) ORDER BY s.name`,
          [
            actor.org_id,
            query.unitId,
            query.yearId ?? null,
            offices,
            actor.unit_ids,
            actor.id,
          ],
        )
      ).rows,
    });
  });
  app.post("/api/school/sections", async (req, res) =>
    res
      .status(201)
      .json(
        await createSection(db, schoolActor(req), sectionInput.parse(req.body)),
      ),
  );
  app.patch("/api/school/sections/:id", async (req, res) => {
    const actor = schoolActor(req),
      sectionId = id(req.params.id),
      input = sectionUpdateInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      await lockAcademics(tx, actor.org_id);
      const old = await sectionById(tx, actor, sectionId, true);
      await assertOffice(tx, actor, old.unit_id);
      requireCondition(
        old.version === input.version,
        409,
        "Class changed. Refresh first.",
      );
      await validateTeachers(tx, actor, old.unit_id, input.teacherIds);
      const roster = (
        await tx.query(
          `SELECT ${dateSql} FROM section_students WHERE section_id=$1`,
          [sectionId],
        )
      ).rows;
      requireCondition(
        input.capacity >=
          peakRoster(roster as { starts_on: string; ends_on: string }[]),
        409,
        "Capacity cannot be less than the existing roster.",
      );
      const oldTeachers = (
        await tx.query(
          "SELECT user_id FROM section_teachers WHERE section_id=$1",
          [sectionId],
        )
      ).rows.map((row) => row.user_id);
      const updated = (
        await tx.query(
          "UPDATE sections SET name=$1,room=$2,capacity=$3,version=version+1 WHERE id=$4 RETURNING *",
          [input.name, input.room, input.capacity, sectionId],
        )
      ).rows[0];
      await tx.query("DELETE FROM section_teachers WHERE section_id=$1", [
        sectionId,
      ]);
      for (const teacher of input.teacherIds)
        await tx.query(
          "INSERT INTO section_teachers(org_id,unit_id,section_id,user_id) VALUES($1,$2,$3,$4)",
          [actor.org_id, old.unit_id, sectionId, teacher],
        );
      await schoolChange(
        tx,
        actor,
        old.unit_id,
        "section.updated",
        sectionId,
        { ...old, teacherIds: oldTeachers },
        { ...updated, teacherIds: input.teacherIds },
      );
      await validateAcademicChange(tx, actor.org_id);
      return updated;
    });
    res.json(row);
  });
  app.get("/api/school/sections/:id", async (req, res) => {
    const actor = schoolActor(req),
      section = await sectionById(db, actor, id(req.params.id));
    res.json({
      section,
      roster: (
        await db.query(
          `SELECT s.id,s.student_number,p.name,r.version,r.starts_on::text,r.ends_on::text,e.grade_level,e.status FROM section_students r JOIN students s ON s.id=r.student_id JOIN school_people p ON p.id=s.person_id JOIN student_enrollments e ON e.student_id=s.id AND e.year_id=$3 WHERE r.org_id=$1 AND r.section_id=$2 ORDER BY p.name`,
          [actor.org_id, section.id, section.year_id],
        )
      ).rows,
      teachers: (
        await db.query(
          "SELECT u.id,u.name FROM section_teachers t JOIN users u ON u.id=t.user_id WHERE t.section_id=$1 AND t.org_id=$2",
          [section.id, actor.org_id],
        )
      ).rows,
      curriculum: (
        await db.query(
          "SELECT * FROM curriculum_items WHERE section_id=$1 AND org_id=$2 AND NOT archived ORDER BY sort_order,title",
          [section.id, actor.org_id],
        )
      ).rows,
    });
  });
  app.post("/api/school/sections/:id/roster", async (req, res) =>
    res.json(
      await saveRoster(
        db,
        schoolActor(req),
        id(req.params.id),
        rosterInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/school/sections/:id/curriculum", async (req, res) => {
    const actor = schoolActor(req),
      sectionId = id(req.params.id),
      input = curriculumInput.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const section = await sectionById(tx, actor, sectionId);
      requireCondition(!section.archived, 409, "This class is archived.");
      const created = (
        await tx.query(
          "INSERT INTO curriculum_items(id,org_id,unit_id,section_id,title,content,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            section.unit_id,
            sectionId,
            input.title,
            input.content,
            input.sortOrder,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        section.unit_id,
        "curriculum.created",
        created.id,
        null,
        created,
      );
      return created;
    });
    res.status(201).json(row);
  });
  app.patch("/api/school/curriculum/:id", async (req, res) => {
    const actor = schoolActor(req),
      itemId = id(req.params.id),
      input = curriculumInput
        .extend({ version: z.number().int().positive(), archived: z.boolean() })
        .strict()
        .parse(req.body);
    const row = await db.transaction(async (tx) => {
      const old = (
        await tx.query(
          "SELECT * FROM curriculum_items WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [itemId, actor.org_id],
        )
      ).rows[0];
      requireCondition(old, 404, "Curriculum item not found.");
      const section = await sectionById(tx, actor, old.section_id);
      requireCondition(
        !section.archived && old.version === input.version,
        409,
        "Curriculum changed or class archived. Refresh first.",
      );
      const updated = (
        await tx.query(
          "UPDATE curriculum_items SET title=$1,content=$2,sort_order=$3,archived=$4,version=version+1 WHERE id=$5 RETURNING *",
          [input.title, input.content, input.sortOrder, input.archived, itemId],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        old.unit_id,
        "curriculum.updated",
        itemId,
        old,
        updated,
      );
      return updated;
    });
    res.json(row);
  });
  app.get("/api/school/history/:id", async (req, res) => {
    const actor = schoolActor(req),
      entityId = id(req.params.id),
      offices = await officeUnits(db, actor);
    res.json({
      rows: (
        await db.query(
          "SELECT entity_type,snapshot,created_at FROM school_history WHERE org_id=$1 AND entity_id=$2 AND unit_id=ANY($3::uuid[]) ORDER BY created_at DESC LIMIT 100",
          [actor.org_id, entityId, offices],
        )
      ).rows,
    });
  });
}
