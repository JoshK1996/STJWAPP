import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { requireCondition, digest, type Actor } from "./security";
import { schoolActor, assertOffice, schoolChange, studentById } from "./school";
import {
  admissionStages,
  admissionTransitions,
  admissionSettingsInput,
  admissionCreateInput,
  admissionEditInput,
  admissionStageInput,
  admissionChecklistInput,
  admissionEnrollInput,
} from "../shared/admissions";
const uuid = (value: unknown) => z.uuid().parse(value);
export async function admissionSettings(
  tx: Queryable,
  actor: Actor,
  unitId: string,
) {
  await assertOffice(tx, actor, unitId);
  return (
    (
      await tx.query(
        "SELECT * FROM admission_settings WHERE org_id=$1 AND unit_id=$2",
        [actor.org_id, unitId],
      )
    ).rows[0] ?? {
      unit_id: unitId,
      version: 0,
      confirmed: false,
      requirements: [],
    }
  );
}
async function applicationById(
  tx: Queryable,
  actor: Actor,
  id: string,
  lock = false,
) {
  const row = (
    await tx.query(
      "SELECT * FROM admission_applications WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, actor.org_id],
    )
  ).rows[0];
  requireCondition(row, 404, "Application not found.");
  await assertOffice(tx, actor, row.unit_id);
  return row;
}
async function activeYear(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  yearId: string,
) {
  const row = (
    await tx.query(
      "SELECT *,to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND NOT archived",
      [yearId, actor.org_id, unitId],
    )
  ).rows[0];
  requireCondition(row, 404, "Active school year not found in this unit.");
  return row;
}
async function contact(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  personId: string | null,
) {
  if (personId)
    requireCondition(
      (
        await tx.query(
          "SELECT id FROM school_people WHERE id=$1 AND org_id=$2 AND unit_id=$3",
          [personId, actor.org_id, unitId],
        )
      ).rows.length,
      404,
      "Contact person not found in this unit.",
    );
}
async function decisionReady(tx: Queryable, actor: Actor, row: Row) {
  // A policy edit and a decision must commit in a defined order. Hold the
  // same unit lock as the settings writer through the entire decision.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "admission-settings:" + row.unit_id,
  ]);
  const policy = await admissionSettings(tx, actor, row.unit_id);
  requireCondition(
    policy.confirmed,
    409,
    "The school office must confirm its admissions checklist before issuing an offer or enrolling.",
  );
  requireCondition(
    row.policy_version === policy.version,
    409,
    "The admissions checklist template changed. Review and refresh this application checklist first.",
  );
  requireCondition(
    row.checklist.every(
      (item: any) =>
        !item.required || ["complete", "waived"].includes(item.status),
    ),
    409,
    "Complete or explicitly waive every required checklist item first.",
  );
}
export async function createApplication(
  db: Database,
  actor: Actor,
  input: z.infer<typeof admissionCreateInput>,
) {
  return db.transaction(async (tx) => {
    await assertOffice(tx, actor, input.unitId);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "admission-intake:" + actor.id + ":" + input.commandId,
    ]);
    const fingerprint = digest(JSON.stringify(input)),
      previous = (
        await tx.query(
          "SELECT * FROM admission_applications WHERE org_id=$1 AND created_by=$2 AND command_id=$3",
          [actor.org_id, actor.id, input.commandId],
        )
      ).rows[0];
    if (previous) {
      requireCondition(
        previous.fingerprint === fingerprint,
        409,
        "This intake command was used for different details.",
      );
      return previous;
    }
    await activeYear(tx, actor, input.unitId, input.yearId);
    await contact(tx, actor, input.unitId, input.primaryContactId);
    let applicantId: string,
      applicantName = input.name;
    if (input.existingStudentId) {
      const student = await studentById(
        tx,
        actor,
        input.existingStudentId,
        true,
      );
      requireCondition(
        student.unit_id === input.unitId && student.active,
        400,
        "Choose an active existing student in this unit.",
      );
      requireCondition(
        !(
          await tx.query(
            "SELECT id FROM student_enrollments WHERE student_id=$1 AND year_id=$2",
            [student.id, input.yearId],
          )
        ).rows.length,
        409,
        "This student already has an enrollment record for the selected year.",
      );
      applicantId = student.person_id;
      applicantName = student.name;
    } else {
      applicantId = randomUUID();
      await tx.query(
        "INSERT INTO school_people(id,org_id,unit_id,name,date_of_birth) VALUES($1,$2,$3,$4,$5)",
        [
          applicantId,
          actor.org_id,
          input.unitId,
          input.name,
          input.dateOfBirth,
        ],
      );
    }
    requireCondition(
      input.primaryContactId !== applicantId,
      400,
      "Choose a separate primary application contact.",
    );
    let primaryContactId = input.primaryContactId;
    if (input.newContact) {
      primaryContactId = randomUUID();
      await tx.query(
        "INSERT INTO school_people(id,org_id,unit_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)",
        [
          primaryContactId,
          actor.org_id,
          input.unitId,
          input.newContact.name,
          input.newContact.email,
          input.newContact.phone,
        ],
      );
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "person.created_from_admission",
        primaryContactId,
        null,
        input.newContact,
      );
    }
    const settings = await admissionSettings(tx, actor, input.unitId),
      checklist = settings.requirements.map((item: any) => ({
        ...item,
        status: "pending",
        evidence: "",
        reviewedBy: null,
        reviewedAt: null,
      }));
    const row = (
      await tx.query(
        "INSERT INTO admission_applications(id,org_id,unit_id,year_id,applicant_id,primary_contact_id,existing_student_id,grade_level,checklist,policy_version,notes,created_by,command_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          input.unitId,
          input.yearId,
          applicantId,
          primaryContactId,
          input.existingStudentId,
          input.gradeLevel,
          JSON.stringify(checklist),
          settings.version,
          input.notes,
          actor.id,
          input.commandId,
          fingerprint,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      input.unitId,
      "admission.created",
      row.id,
      null,
      { ...row, applicantName },
    );
    return row;
  });
}
export async function advanceApplication(
  db: Database,
  actor: Actor,
  id: string,
  input: z.infer<typeof admissionStageInput>,
) {
  return db.transaction(async (tx) => {
    const old = await applicationById(tx, actor, id, true);
    requireCondition(
      old.version === input.version,
      409,
      "Application changed. Reload before saving.",
    );
    requireCondition(
      admissionTransitions[old.status].includes(input.status),
      409,
      "This stage change is not available. Enrollment uses the separate reviewed conversion.",
    );
    await activeYear(tx, actor, old.unit_id, old.year_id);
    if (input.status === "offered" || input.status === "accepted")
      await decisionReady(tx, actor, old);
    const row = (
      await tx.query(
        "UPDATE admission_applications SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
        [input.status, id],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      old.unit_id,
      "admission.stage_changed",
      id,
      old,
      { ...row, reason: input.reason },
    );
    return row;
  });
}
export async function enrollApplication(
  db: Database,
  actor: Actor,
  id: string,
  input: z.infer<typeof admissionEnrollInput>,
) {
  return db.transaction(async (tx) => {
    const application = await applicationById(tx, actor, id, true);
    requireCondition(
      application.status === "accepted" &&
        application.version === input.version,
      409,
      "Enrollment requires the current accepted application.",
    );
    await decisionReady(tx, actor, application);
    const year = await activeYear(
      tx,
      actor,
      application.unit_id,
      application.year_id,
    );
    requireCondition(
      input.startsOn >= year.starts_on && input.endsOn <= year.ends_on,
      400,
      "Enrollment dates must fit the selected school year.",
    );
    if (input.householdId)
      requireCondition(
        (
          await tx.query(
            "SELECT id FROM households WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND NOT archived",
            [input.householdId, actor.org_id, application.unit_id],
          )
        ).rows.length,
        404,
        "Household not found in this unit.",
      );
    // Serialize applicant-to-student creation, including when no student row exists yet.
    // Existing student edits and report issuance lock student before person.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "admission-student:" + application.applicant_id,
    ]);
    let student = (
      await tx.query(
        "SELECT * FROM students WHERE person_id=$1 AND org_id=$2 FOR UPDATE",
        [application.applicant_id, actor.org_id],
      )
    ).rows[0];
    await tx.query("SELECT id FROM school_people WHERE id=$1 FOR UPDATE", [
      application.applicant_id,
    ]);
    if (student) {
      requireCondition(
        student.active && student.student_number === input.studentNumber,
        409,
        "Use the existing active student and its current student ID.",
      );
      requireCondition(
        !(
          await tx.query(
            "SELECT id FROM student_enrollments WHERE student_id=$1 AND year_id=$2",
            [student.id, application.year_id],
          )
        ).rows.length,
        409,
        "This student already has an enrollment record in this year.",
      );
    } else {
      student = (
        await tx.query(
          "INSERT INTO students(id,org_id,unit_id,person_id,student_number) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            application.unit_id,
            application.applicant_id,
            input.studentNumber,
          ],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        application.unit_id,
        "student.created_from_admission",
        student.id,
        null,
        { ...student, applicationId: id },
      );
    }
    const enrollment = (
      await tx.query(
        "INSERT INTO student_enrollments(id,org_id,unit_id,student_id,year_id,grade_level,starts_on,ends_on,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'enrolled') RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          application.unit_id,
          student.id,
          application.year_id,
          application.grade_level,
          input.startsOn,
          input.endsOn,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      application.unit_id,
      "enrollment.created_from_admission",
      enrollment.id,
      null,
      { ...enrollment, applicationId: id },
    );
    if (input.householdId)
      await tx.query(
        "INSERT INTO household_members(org_id,unit_id,household_id,person_id,role) VALUES($1,$2,$3,$4,'student') ON CONFLICT(household_id,person_id) DO NOTHING",
        [
          actor.org_id,
          application.unit_id,
          input.householdId,
          application.applicant_id,
        ],
      );
    if (application.primary_contact_id) {
      const existing = (
        await tx.query(
          "SELECT * FROM student_contacts WHERE student_id=$1 AND person_id=$2",
          [student.id, application.primary_contact_id],
        )
      ).rows[0];
      if (!existing) {
        const linked = (
          await tx.query(
            "INSERT INTO student_contacts(org_id,unit_id,student_id,person_id,relationship,is_guardian,can_communicate,can_pickup) VALUES($1,$2,$3,$4,'Application contact',false,$5,false) RETURNING *",
            [
              actor.org_id,
              application.unit_id,
              student.id,
              application.primary_contact_id,
              input.contactCanCommunicate,
            ],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          application.unit_id,
          "student.contact_linked_from_admission",
          student.id,
          null,
          linked,
        );
      }
    }
    const row = (
      await tx.query(
        "UPDATE admission_applications SET status='enrolled',enrolled_student_id=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
        [student.id, id],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      application.unit_id,
      "admission.enrolled",
      id,
      application,
      {
        ...row,
        enrollmentId: enrollment.id,
        householdId: input.householdId,
        reason: input.reason,
      },
    );
    return { application: row, student, enrollment };
  });
}
export function installAdmissions(app: Express, db: Database) {
  app.get("/api/school/admissions/settings", async (req, res) =>
    res.json(
      await admissionSettings(db, schoolActor(req), uuid(req.query.unitId)),
    ),
  );
  app.put("/api/school/admissions/settings", async (req, res) => {
    const actor = schoolActor(req),
      input = admissionSettingsInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        await assertOffice(tx, actor, input.unitId);
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "admission-settings:" + input.unitId,
        ]);
        const old = await admissionSettings(tx, actor, input.unitId);
        requireCondition(
          old.version === input.version,
          409,
          "Admissions settings changed. Reload first.",
        );
        const row = (
          await tx.query(
            "INSERT INTO admission_settings(org_id,unit_id,requirements,confirmed,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(unit_id) DO UPDATE SET requirements=EXCLUDED.requirements,confirmed=EXCLUDED.confirmed,updated_by=EXCLUDED.updated_by,updated_at=now(),version=admission_settings.version+1 RETURNING *",
            [
              actor.org_id,
              input.unitId,
              JSON.stringify(input.requirements),
              input.confirmed,
              actor.id,
            ],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          input.unitId,
          "admission.settings_saved",
          input.unitId,
          old,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.get("/api/school/admissions", async (req, res) => {
    const actor = schoolActor(req),
      input = z
        .object({
          unitId: z.uuid(),
          yearId: z.uuid(),
          status: z.enum(admissionStages).optional(),
          search: z.string().trim().max(100).default(""),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict()
        .parse(req.query);
    await assertOffice(db, actor, input.unitId);
    const rows = (
        await db.query(
          "SELECT a.*,p.name AS applicant_name,c.name AS contact_name,c.email AS contact_email FROM admission_applications a JOIN school_people p ON p.id=a.applicant_id LEFT JOIN school_people c ON c.id=a.primary_contact_id WHERE a.org_id=$1 AND a.unit_id=$2 AND a.year_id=$3 AND ($4::text IS NULL OR a.status=$4) AND p.name ILIKE $5 ORDER BY a.created_at DESC,a.id LIMIT 51 OFFSET $6",
          [
            actor.org_id,
            input.unitId,
            input.yearId,
            input.status ?? null,
            "%" + input.search + "%",
            input.offset,
          ],
        )
      ).rows,
      counts = (
        await db.query(
          "SELECT status,count(*)::int AS count FROM admission_applications WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 GROUP BY status",
          [actor.org_id, input.unitId, input.yearId],
        )
      ).rows;
    res.json({ rows: rows.slice(0, 50), hasMore: rows.length > 50, counts });
  });
  app.post("/api/school/admissions", async (req, res) =>
    res
      .status(201)
      .json(
        await createApplication(
          db,
          schoolActor(req),
          admissionCreateInput.parse(req.body),
        ),
      ),
  );
  app.get("/api/school/admissions/:id", async (req, res) => {
    const actor = schoolActor(req),
      application = await applicationById(db, actor, uuid(req.params.id));
    res.json({
      application,
      applicant: (
        await db.query(
          "SELECT *,to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth FROM school_people WHERE id=$1",
          [application.applicant_id],
        )
      ).rows[0],
      contact: application.primary_contact_id
        ? (
            await db.query("SELECT * FROM school_people WHERE id=$1", [
              application.primary_contact_id,
            ])
          ).rows[0]
        : null,
      student:
        application.enrolled_student_id || application.existing_student_id
          ? (
              await db.query(
                "SELECT id,student_number FROM students WHERE id=$1",
                [
                  application.enrolled_student_id ??
                    application.existing_student_id,
                ],
              )
            ).rows[0]
          : null,
      history: (
        await db.query(
          "SELECT h.*,u.name AS actor_name FROM school_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.entity_id=$2 ORDER BY h.created_at DESC,h.id",
          [actor.org_id, application.id],
        )
      ).rows,
    });
  });
  app.patch("/api/school/admissions/:id", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id),
      input = admissionEditInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const old = await applicationById(tx, actor, id, true);
        requireCondition(
          old.status !== "enrolled" && old.version === input.version,
          409,
          "Application changed or was already enrolled.",
        );
        await contact(tx, actor, old.unit_id, input.primaryContactId);
        requireCondition(
          input.primaryContactId !== old.applicant_id,
          400,
          "Choose a separate application contact.",
        );
        const row = (
          await tx.query(
            "UPDATE admission_applications SET grade_level=$1,primary_contact_id=$2,notes=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *",
            [input.gradeLevel, input.primaryContactId, input.notes, id],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          old.unit_id,
          "admission.updated",
          id,
          old,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.post("/api/school/admissions/:id/stage", async (req, res) =>
    res.json(
      await advanceApplication(
        db,
        schoolActor(req),
        uuid(req.params.id),
        admissionStageInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/school/admissions/:id/checklist", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id),
      input = admissionChecklistInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const old = await applicationById(tx, actor, id, true);
        requireCondition(
          old.status !== "enrolled" && old.version === input.version,
          409,
          "Application changed or was already enrolled.",
        );
        requireCondition(
          old.checklist.some((item: any) => item.id === input.itemId),
          404,
          "Checklist item not found.",
        );
        const next = old.checklist.map((item: any) =>
          item.id === input.itemId
            ? {
                ...item,
                status: input.status,
                evidence: input.evidence,
                reviewedBy: actor.id,
                reviewedAt: new Date().toISOString(),
              }
            : item,
        );
        const row = (
          await tx.query(
            "UPDATE admission_applications SET checklist=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
            [JSON.stringify(next), id],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          old.unit_id,
          "admission.checklist_reviewed",
          id,
          old,
          row,
        );
        return row;
      }),
    );
  });
  app.post("/api/school/admissions/:id/refresh-checklist", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id),
      input = z
        .object({
          version: z.number().int().positive(),
          policyVersion: z.number().int().nonnegative(),
          reason: z.string().trim().min(10).max(2000),
        })
        .strict()
        .parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const old = await applicationById(tx, actor, id, true);
        requireCondition(
          old.status !== "enrolled" && old.version === input.version,
          409,
          "Application changed or was already enrolled.",
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "admission-settings:" + old.unit_id,
        ]);
        const settings = await admissionSettings(tx, actor, old.unit_id);
        requireCondition(
          settings.version === input.policyVersion,
          409,
          "The checklist template changed. Reload the preview.",
        );
        const checklist = settings.requirements.map((item: any) => {
          const prior = old.checklist.find(
            (entry: any) =>
              entry.id === item.id &&
              entry.title === item.title &&
              entry.required === item.required,
          );
          return (
            prior ?? {
              ...item,
              status: "pending",
              evidence: "",
              reviewedBy: null,
              reviewedAt: null,
            }
          );
        });
        const status = ["offered", "accepted"].includes(old.status)
            ? "review"
            : old.status,
          row = (
            await tx.query(
              "UPDATE admission_applications SET checklist=$1,policy_version=$2,status=$3,version=version+1,updated_at=now() WHERE id=$4 RETURNING *",
              [JSON.stringify(checklist), settings.version, status, id],
            )
          ).rows[0];
        await schoolChange(
          tx,
          actor,
          old.unit_id,
          "admission.checklist_refreshed",
          id,
          old,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.post("/api/school/admissions/:id/enroll", async (req, res) =>
    res.json(
      await enrollApplication(
        db,
        schoolActor(req),
        uuid(req.params.id),
        admissionEnrollInput.parse(req.body),
      ),
    ),
  );
}
