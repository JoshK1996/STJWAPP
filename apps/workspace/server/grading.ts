import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { requireCondition, digest, audit, type Actor } from "./security";
import {
  schoolActor,
  officeUnits,
  assertOffice,
  sectionById,
  schoolChange,
} from "./school";
import { toCsv } from "./reports";
import { lockAcademics } from "./timetable-engine";
import {
  gradingSettingsInput,
  gradebookOpenInput,
  gradeAssignmentInput,
  gradeAssignmentEditInput,
  gradeScoresInput,
  gradebookReviewInput,
  gradebookReconcileInput,
  calculateGrade,
  type GradingPolicy,
} from "../shared/grading";
const uuid = (value: unknown) => z.uuid().parse(value);
const dates =
  "to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on";
async function unitReader(tx: Queryable, actor: Actor, unitId: string) {
  const office = (await officeUnits(tx, actor)).includes(unitId);
  requireCondition(
    office ||
      (actor.unit_ids.includes(unitId) &&
        (
          await tx.query(
            "SELECT section_id FROM section_teachers WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
            [actor.org_id, unitId, actor.id],
          )
        ).rows.length),
    403,
    "School access to this unit is required.",
  );
  return office;
}
async function policyFor(tx: Queryable, actor: Actor, unitId: string) {
  return (
    (
      await tx.query(
        "SELECT * FROM grading_settings WHERE org_id=$1 AND unit_id=$2",
        [actor.org_id, unitId],
      )
    ).rows[0] ?? { unit_id: unitId, version: 0, confirmed: false, policy: null }
  );
}
async function termFor(
  tx: Queryable,
  actor: Actor,
  section: Row,
  termId: string,
) {
  const term = (
    await tx.query(
      `SELECT *,${dates} FROM school_terms WHERE id=$1 AND org_id=$2 AND unit_id=$3 AND year_id=$4`,
      [termId, actor.org_id, section.unit_id, section.year_id],
    )
  ).rows[0];
  requireCondition(term, 404, "Term not found in this class’s school year.");
  return term;
}
async function bookById(tx: Queryable, actor: Actor, id: string, lock = false) {
  const book = (
    await tx.query(
      "SELECT * FROM gradebooks WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, actor.org_id],
    )
  ).rows[0];
  requireCondition(book, 404, "Gradebook not found.");
  const section = await sectionById(tx, actor, book.section_id),
    term = await termFor(tx, actor, section, book.term_id);
  return { book, section, term };
}
async function sourceRoster(tx: Queryable, section: Row, term: Row) {
  return (
    await tx.query(
      "SELECT s.id AS student_id,s.student_number,p.name,to_char(greatest(r.starts_on,e.starts_on,$3::date),'YYYY-MM-DD') AS starts_on,to_char(least(r.ends_on,e.ends_on,$4::date),'YYYY-MM-DD') AS ends_on FROM section_students r JOIN students s ON s.id=r.student_id JOIN school_people p ON p.id=s.person_id JOIN student_enrollments e ON e.student_id=s.id AND e.year_id=$2 WHERE r.section_id=$1 AND greatest(r.starts_on,e.starts_on,$3::date)<=least(r.ends_on,e.ends_on,$4::date) ORDER BY s.id",
      [section.id, section.year_id, term.starts_on, term.ends_on],
    )
  ).rows;
}
/** Freeze every potential roster contributor before taking a gradebook lock.
 * Roster writers use the academic mutex; enrollment/identity writers lock students
 * before people. Taking book locks first would invert report-card issuance.
 * Include out-of-term class members: an enrollment edit could make one eligible.
 */
async function lockGradeRoster(
  tx: Queryable,
  actor: Actor,
  reference: { sectionId: string } | { bookId: string },
) {
  await lockAcademics(tx, actor.org_id);
  const sectionId = 'sectionId' in reference ? reference.sectionId :
    (await tx.query('SELECT section_id FROM gradebooks WHERE id=$1 AND org_id=$2', [reference.bookId, actor.org_id])).rows[0]?.section_id;
  requireCondition(sectionId, 404, 'Gradebook not found.');
  await sectionById(tx, actor, sectionId);
  const students = (await tx.query(
    `SELECT s.id,s.person_id FROM students s JOIN section_students r ON r.student_id=s.id AND r.org_id=s.org_id
     WHERE r.section_id=$1 AND s.org_id=$2 ORDER BY s.id FOR SHARE OF s`,
    [sectionId, actor.org_id],
  )).rows;
  if (students.length) await tx.query(
    'SELECT id FROM school_people WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [actor.org_id, students.map(student => student.person_id)],
  );
}
const rosterHash = (roster: Row[]) => digest(JSON.stringify(roster));
const dueRoster = (roster: Row[], date: string) =>
  roster.filter((row) => row.starts_on <= date && row.ends_on >= date);
async function assignmentsFor(tx: Queryable, bookId: string) {
  return (
    await tx.query(
      "SELECT *,to_char(due_on,'YYYY-MM-DD') AS due_on FROM grade_assignments a WHERE book_id=$1 ORDER BY a.due_on,a.id",
      [bookId],
    )
  ).rows;
}
async function scoresFor(tx: Queryable, bookId: string) {
  return (
    await tx.query(
      "SELECT * FROM grade_scores WHERE book_id=$1 ORDER BY assignment_id,student_id",
      [bookId],
    )
  ).rows;
}
function resultsFor(book: Row, assignments: Row[], scores: Row[]) {
  const active = new Map(
    assignments.filter((row) => !row.archived).map((row) => [row.id, row]),
  );
  return book.roster.map((student: Row) => ({
    ...student,
    ...calculateGrade(
      book.policy as GradingPolicy,
      scores
        .filter(
          (row) =>
            row.student_id === student.student_id &&
            row.expected &&
            active.has(row.assignment_id),
        )
        .map((row) => {
          const assignment = active.get(row.assignment_id)!;
          return {
            categoryId: assignment.category_id,
            maxPointsUnits: assignment.max_points_units,
            status: row.status,
            pointsUnits: row.points_units,
          };
        }),
    ),
  }));
}
function writable(book: Row, section: Row, term: Row, version: number) {
  requireCondition(
    book.version === version,
    409,
    "Gradebook changed. Reload before saving.",
  );
  requireCondition(
    book.status === "open" && !section.archived && !term.locked_at,
    409,
    "This gradebook is not open for changes. Ask the school office to reopen it.",
  );
}
async function advanceVersion(tx: Queryable, id: string) {
  return (
    await tx.query(
      "UPDATE gradebooks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
      [id],
    )
  ).rows[0];
}
async function reconcileAssignment(tx: Queryable, book: Row, assignment: Row) {
  const expected = dueRoster(book.roster, assignment.due_on);
  await tx.query(
    "UPDATE grade_scores SET expected=false WHERE assignment_id=$1",
    [assignment.id],
  );
  for (const student of expected)
    await tx.query(
      "INSERT INTO grade_scores(org_id,unit_id,book_id,assignment_id,student_id,student_name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(assignment_id,student_id) DO UPDATE SET expected=true",
      [
        book.org_id,
        book.unit_id,
        book.id,
        assignment.id,
        student.student_id,
        student.name,
      ],
    );
}
export async function detail(tx: Queryable, actor: Actor, id: string, lock = true) {
  const { book, section, term } = await bookById(tx, actor, id, lock),
    assignments = await assignmentsFor(tx, id),
    scores = await scoresFor(tx, id),
    current = await sourceRoster(tx, section, term),
    releases = (
      await tx.query(
        "SELECT r.id,r.book_version,r.created_at,u.name AS reviewer_name FROM gradebook_releases r JOIN users u ON u.id=r.created_by WHERE r.book_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 50",
        [id],
      )
    ).rows;
  return {
    book,
    section,
    term,
    assignments,
    scores,
    results: resultsFor(book, assignments, scores),
    rosterCurrent: rosterHash(current) === book.roster_fingerprint,
    releases,
    history: (
      await tx.query(
        "SELECT h.*,u.name AS actor_name FROM school_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.entity_id=$2 ORDER BY h.created_at DESC,h.id LIMIT 100",
        [actor.org_id, id],
      )
    ).rows,
  };
}
export const gradebookReportSource = (tx: Queryable, actor: Actor, id: string) => detail(tx, actor, id, false);
export async function openGradebook(
  db: Database,
  actor: Actor,
  input: z.infer<typeof gradebookOpenInput>,
) {
  return db.transaction(async (tx) => {
    await lockGradeRoster(tx, actor, { sectionId: input.sectionId });
    const section = await sectionById(tx, actor, input.sectionId),
      term = await termFor(tx, actor, section, input.termId);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "gradebook:" + section.id + ":" + term.id,
    ]);
    const old = (
      await tx.query(
        "SELECT * FROM gradebooks WHERE section_id=$1 AND term_id=$2",
        [section.id, term.id],
      )
    ).rows[0];
    if (old) return old;
    requireCondition(
      !section.archived && !term.locked_at,
      409,
      "Choose an active class and unlocked term.",
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "grading-settings:" + section.unit_id,
    ]);
    const policy = await policyFor(tx, actor, section.unit_id);
    requireCondition(
      policy.confirmed && policy.policy,
      409,
      "The school office must configure and confirm a grading policy first.",
    );
    const roster = await sourceRoster(tx, section, term);
    requireCondition(
      roster.length > 0 && roster.length <= 200,
      400,
      "A gradebook requires 1–200 enrolled students during this term.",
    );
    const book = (
      await tx.query(
        "INSERT INTO gradebooks(id,org_id,unit_id,section_id,term_id,policy,policy_version,roster,roster_fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          section.unit_id,
          section.id,
          term.id,
          JSON.stringify(policy.policy),
          policy.version,
          JSON.stringify(roster),
          rosterHash(roster),
          actor.id,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      section.unit_id,
      "gradebook.opened",
      book.id,
      null,
      book,
    );
    return book;
  });
}
function assignmentValid(
  book: Row,
  term: Row,
  input: { categoryId: string; dueOn: string; maxPointsUnits: number },
) {
  requireCondition(
    book.policy.categories.some((row: Row) => row.id === input.categoryId),
    400,
    "Choose a category in this gradebook’s policy.",
  );
  requireCondition(
    input.dueOn >= term.starts_on && input.dueOn <= term.ends_on,
    400,
    "The due date must be inside this term.",
  );
  requireCondition(
    dueRoster(book.roster, input.dueOn).length > 0,
    400,
    "No students were enrolled on this due date.",
  );
}
export async function createGradeAssignment(
  db: Database,
  actor: Actor,
  input: z.infer<typeof gradeAssignmentInput>,
) {
  return db.transaction(async (tx) => {
    const { book, section, term } = await bookById(
        tx,
        actor,
        input.bookId,
        true,
      ),
      fingerprint = digest(JSON.stringify(input)),
      prior = (
        await tx.query(
          "SELECT * FROM grade_assignments WHERE book_id=$1 AND command_id=$2",
          [book.id, input.commandId],
        )
      ).rows[0];
    if (prior) {
      requireCondition(
        prior.created_by === actor.id &&
          prior.command_fingerprint === fingerprint,
        409,
        "This assignment command was already used for different details.",
      );
      return prior;
    }
    writable(book, section, term, input.bookVersion);
    assignmentValid(book, term, input);
    requireCondition(
      (await assignmentsFor(tx, book.id)).length < 500,
      400,
      "This gradebook has reached its 500-assignment limit.",
    );
    const row = (
      await tx.query(
        "INSERT INTO grade_assignments(id,org_id,unit_id,book_id,command_id,command_fingerprint,created_by,title,instructions,category_id,due_on,max_points_units) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,to_char(due_on,'YYYY-MM-DD') AS due_on",
        [
          randomUUID(),
          actor.org_id,
          book.unit_id,
          book.id,
          input.commandId,
          fingerprint,
          actor.id,
          input.title,
          input.instructions,
          input.categoryId,
          input.dueOn,
          input.maxPointsUnits,
        ],
      )
    ).rows[0];
    await reconcileAssignment(tx, book, row);
    await advanceVersion(tx, book.id);
    await schoolChange(
      tx,
      actor,
      book.unit_id,
      "gradebook.assignment_created",
      book.id,
      null,
      {
        assignment: row,
        scores: (await scoresFor(tx, book.id)).filter(
          (score) => score.assignment_id === row.id,
        ),
      },
    );
    return row;
  });
}
export async function saveGradeScores(
  db: Database,
  actor: Actor,
  assignmentId: string,
  input: z.infer<typeof gradeScoresInput>,
) {
  return db.transaction((tx) =>
    saveGradeScoresTransaction(tx, actor, assignmentId, input),
  );
}
export async function saveGradeScoresTransaction(
  tx: Queryable,
  actor: Actor,
  assignmentId: string,
  input: z.infer<typeof gradeScoresInput>,
) {
  const lookup = (
    await tx.query(
      "SELECT book_id FROM grade_assignments WHERE id=$1 AND org_id=$2",
      [assignmentId, actor.org_id],
    )
  ).rows[0];
  requireCondition(lookup, 404, "Assignment not found.");
  const { book, section, term } = await bookById(
      tx,
      actor,
      lookup.book_id,
      true,
    ),
    assignment = (await assignmentsFor(tx, book.id)).find(
      (row) => row.id === assignmentId,
    )!;
  writable(book, section, term, input.bookVersion);
  requireCondition(
    !assignment.archived && assignment.version === input.version,
    409,
    "Assignment changed or was archived. Reload first.",
  );
  const old = (await scoresFor(tx, book.id)).filter(
      (row) => row.assignment_id === assignmentId,
    ),
    expected = old.filter((row) => row.expected);
  requireCondition(
    input.scores.length === expected.length &&
      input.scores.every((row) =>
        expected.some((student) => student.student_id === row.studentId),
      ),
    400,
    "Submit exactly the captured assignment roster.",
  );
  for (const row of input.scores) {
    requireCondition(
      book.policy.allowExtraCredit ||
        row.pointsUnits === null ||
        row.pointsUnits <= assignment.max_points_units,
      400,
      "Points cannot exceed the assignment maximum under this policy.",
    );
    requireCondition(
      !["exempt", "incomplete"].includes(row.status) || row.note.length >= 3,
      400,
      "Record a note for exempt or incomplete work.",
    );
    await tx.query(
      "UPDATE grade_scores SET status=$1,points_units=$2,note=$3,version=version+1 WHERE assignment_id=$4 AND student_id=$5",
      [row.status, row.pointsUnits, row.note, assignmentId, row.studentId],
    );
  }
  await tx.query(
    "UPDATE grade_assignments SET version=version+1,updated_at=now() WHERE id=$1",
    [assignmentId],
  );
  const updated = await advanceVersion(tx, book.id);
  await schoolChange(
    tx,
    actor,
    book.unit_id,
    "gradebook.scores_saved",
    book.id,
    { assignmentId, scores: old },
    {
      assignmentId,
      scores: input.scores,
      reason: input.reason,
      bookVersion: updated.version,
    },
  );
  return { ok: true, bookVersion: updated.version };
}
export async function reviewGradebook(
  db: Database,
  actor: Actor,
  id: string,
  input: z.infer<typeof gradebookReviewInput>,
) {
  return db.transaction(async (tx) => {
    await lockGradeRoster(tx, actor, { bookId: id });
    const { book, section, term } = await bookById(tx, actor, id, true);
    requireCondition(
      book.version === input.version,
      409,
      "Gradebook changed. Reload the review.",
    );
    if (input.action === "reopen") {
      await assertOffice(tx, actor, book.unit_id);
      requireCondition(
        book.status !== "open",
        409,
        "This gradebook is already open.",
      );
    } else {
      requireCondition(
        !section.archived && !term.locked_at,
        409,
        "This class or term is closed.",
      );
      requireCondition(
        (input.action === "submit" && book.status === "open") ||
          (input.action === "lock" && book.status === "submitted"),
        409,
        "Submit the open gradebook before office review and locking.",
      );
      if (input.action === "lock") await assertOffice(tx, actor, book.unit_id);
      requireCondition(
        rosterHash(await sourceRoster(tx, section, term)) ===
          book.roster_fingerprint,
        409,
        "Class enrollment changed. Reconcile the gradebook roster first.",
      );
      const assignments = await assignmentsFor(tx, id),
        scores = await scoresFor(tx, id),
        results = resultsFor(book, assignments, scores);
      requireCondition(
        assignments.some((row) => !row.archived),
        409,
        "Add at least one active assignment before review.",
      );
      requireCondition(
        !results.some((row: Row) => row.pending || row.incomplete),
        409,
        "Resolve ungraded or incomplete work before review.",
      );
      requireCondition(
        !results.some((row: Row) => row.missing) || input.acknowledgeMissing,
        409,
        "Explicitly acknowledge recorded missing work.",
      );
      requireCondition(
        !results.some((row: Row) => row.percentage === null) ||
          input.acknowledgeNoGrade,
        409,
        "Explicitly acknowledge students with no calculated grade.",
      );
      if (input.action === "lock") {
        const snapshot = {
          book: { ...book, status: "locked", version: book.version + 1 },
          section: {
            id: section.id,
            name: section.name,
            courseId: section.course_id,
          },
          term,
          assignments,
          scores,
          results,
          reason: input.reason,
          acknowledgeMissing: input.acknowledgeMissing,
          acknowledgeNoGrade: input.acknowledgeNoGrade,
        };
        await tx.query(
          "INSERT INTO gradebook_releases(id,org_id,unit_id,book_id,book_version,snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            actor.org_id,
            book.unit_id,
            id,
            book.version + 1,
            JSON.stringify(snapshot),
            actor.id,
          ],
        );
      }
    }
    const status =
        input.action === "reopen"
          ? "open"
          : input.action === "submit"
            ? "submitted"
            : "locked",
      row = (
        await tx.query(
          "UPDATE gradebooks SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
          [status, id],
        )
      ).rows[0];
    await schoolChange(
      tx,
      actor,
      book.unit_id,
      "gradebook." + input.action,
      id,
      { status: book.status, version: book.version },
      { status, version: row.version, reason: input.reason },
    );
    return row;
  });
}
export function installGrading(app: Express, db: Database) {
  app.get("/api/school/grading/settings", async (req, res) => {
    const actor = schoolActor(req),
      unitId = uuid(req.query.unitId);
    await unitReader(db, actor, unitId);
    res.json(await policyFor(db, actor, unitId));
  });
  app.put("/api/school/grading/settings", async (req, res) => {
    const actor = schoolActor(req),
      input = gradingSettingsInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        await assertOffice(tx, actor, input.unitId);
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "grading-settings:" + input.unitId,
        ]);
        const old = await policyFor(tx, actor, input.unitId);
        requireCondition(
          old.version === input.version,
          409,
          "Grading configuration changed. Reload first.",
        );
        const row = (
          await tx.query(
            "INSERT INTO grading_settings(org_id,unit_id,policy,confirmed,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(unit_id) DO UPDATE SET policy=EXCLUDED.policy,confirmed=EXCLUDED.confirmed,updated_by=EXCLUDED.updated_by,updated_at=now(),version=grading_settings.version+1 RETURNING *",
            [
              actor.org_id,
              input.unitId,
              JSON.stringify(input.policy),
              input.confirmed,
              actor.id,
            ],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          input.unitId,
          "grading.policy_saved",
          input.unitId,
          old,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.get("/api/school/gradebooks", async (req, res) => {
    const actor = schoolActor(req),
      section = await sectionById(db, actor, uuid(req.query.sectionId));
    res.json({
      rows: (
        await db.query(
          "SELECT b.*,t.name AS term_name FROM gradebooks b JOIN school_terms t ON t.id=b.term_id WHERE b.section_id=$1 ORDER BY t.starts_on,b.id",
          [section.id],
        )
      ).rows,
      terms: (
        await db.query(
          `SELECT *,${dates} FROM school_terms WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 ORDER BY school_terms.starts_on`,
          [actor.org_id, section.unit_id, section.year_id],
        )
      ).rows,
      settings: await policyFor(db, actor, section.unit_id),
    });
  });
  app.post("/api/school/gradebooks", async (req, res) =>
    res
      .status(201)
      .json(
        await openGradebook(
          db,
          schoolActor(req),
          gradebookOpenInput.parse(req.body),
        ),
      ),
  );
  app.get("/api/school/gradebooks/:id", async (req, res) =>
    res.json(
      await db.transaction((tx) =>
        detail(tx, schoolActor(req), uuid(req.params.id)),
      ),
    ),
  );
  app.post("/api/school/grade-assignments", async (req, res) =>
    res
      .status(201)
      .json(
        await createGradeAssignment(
          db,
          schoolActor(req),
          gradeAssignmentInput.parse(req.body),
        ),
      ),
  );
  app.put("/api/school/grade-assignments/:id/scores", async (req, res) =>
    res.json(
      await saveGradeScores(
        db,
        schoolActor(req),
        uuid(req.params.id),
        gradeScoresInput.parse(req.body),
      ),
    ),
  );
  app.post("/api/school/gradebooks/:id/review", async (req, res) =>
    res.json(
      await reviewGradebook(
        db,
        schoolActor(req),
        uuid(req.params.id),
        gradebookReviewInput.parse(req.body),
      ),
    ),
  );
  app.patch("/api/school/grade-assignments/:id", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id),
      input = gradeAssignmentEditInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const lookup = (
          await tx.query(
            "SELECT book_id FROM grade_assignments WHERE id=$1 AND org_id=$2",
            [id, actor.org_id],
          )
        ).rows[0];
        requireCondition(lookup, 404, "Assignment not found.");
        const { book, section, term } = await bookById(
            tx,
            actor,
            lookup.book_id,
            true,
          ),
          old = (await assignmentsFor(tx, book.id)).find(
            (row) => row.id === id,
          )!;
        writable(book, section, term, input.bookVersion);
        requireCondition(
          old.version === input.version,
          409,
          "Assignment changed. Reload first.",
        );
        assignmentValid(book, term, input);
        const oldScores = (await scoresFor(tx, book.id)).filter(
          (row) => row.assignment_id === id,
        );
        requireCondition(
          book.policy.allowExtraCredit ||
            !oldScores.some(
              (row) =>
                row.points_units > input.maxPointsUnits &&
                dueRoster(book.roster, input.dueOn).some(
                  (student) => student.student_id === row.student_id,
                ),
            ),
          409,
          "Existing scores exceed the proposed maximum. Correct scores first.",
        );
        const row = (
          await tx.query(
            "UPDATE grade_assignments SET title=$1,instructions=$2,category_id=$3,due_on=$4,max_points_units=$5,archived=$6,version=version+1,updated_at=now() WHERE id=$7 RETURNING *,to_char(due_on,'YYYY-MM-DD') AS due_on",
            [
              input.title,
              input.instructions,
              input.categoryId,
              input.dueOn,
              input.maxPointsUnits,
              input.archived,
              id,
            ],
          )
        ).rows[0];
        await reconcileAssignment(tx, book, row);
        await advanceVersion(tx, book.id);
        await schoolChange(
          tx,
          actor,
          book.unit_id,
          "gradebook.assignment_updated",
          book.id,
          { assignment: old, scores: oldScores },
          {
            assignment: row,
            scores: (await scoresFor(tx, book.id)).filter(
              (score) => score.assignment_id === id,
            ),
            reason: input.reason,
          },
        );
        return row;
      }),
    );
  });
  app.post("/api/school/gradebooks/:id/reconcile", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id),
      input = gradebookReconcileInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        await lockGradeRoster(tx, actor, { bookId: id });
        const { book, section, term } = await bookById(tx, actor, id, true);
        await assertOffice(tx, actor, book.unit_id);
        writable(book, section, term, input.version);
        const roster = await sourceRoster(tx, section, term);
        requireCondition(
          roster.length > 0 && roster.length <= 200,
          400,
          "A gradebook requires 1–200 enrolled students.",
        );
        const oldScores = await scoresFor(tx, id),
          row = (
            await tx.query(
              "UPDATE gradebooks SET roster=$1,roster_fingerprint=$2,version=version+1,updated_at=now() WHERE id=$3 RETURNING *",
              [JSON.stringify(roster), rosterHash(roster), id],
            )
          ).rows[0];
        for (const assignment of await assignmentsFor(tx, id)) {
          await reconcileAssignment(tx, row, assignment);
          await tx.query(
            "UPDATE grade_assignments SET version=version+1 WHERE id=$1",
            [assignment.id],
          );
        }
        await schoolChange(
          tx,
          actor,
          book.unit_id,
          "gradebook.roster_reconciled",
          id,
          { roster: book.roster, scores: oldScores },
          { roster, scores: await scoresFor(tx, id), reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.get(
    "/api/school/gradebooks/:id/releases/:releaseId",
    async (req, res) => {
      const actor = schoolActor(req),
        id = uuid(req.params.id);
      await bookById(db, actor, id);
      const release = (
        await db.query(
          "SELECT r.*,u.name AS reviewer_name FROM gradebook_releases r JOIN users u ON u.id=r.created_by WHERE r.book_id=$1 AND r.id=$2",
          [id, uuid(req.params.releaseId)],
        )
      ).rows[0];
      requireCondition(release, 404, "Reviewed result not found.");
      res.json(release);
    },
  );
  app.get("/api/school/gradebooks/:id/export", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id);
    const data = await db.transaction((tx) => detail(tx, actor, id));
    const rows = data.results.map((row: Row) => ({
      student_id: row.student_id,
      student_number: row.student_number,
      student_name: row.name,
      class_name: data.section.name,
      term: data.term.name,
      percentage: row.percentage,
      grade: row.label,
      pending: row.pending,
      missing: row.missing,
      book_id: id,
      book_version: data.book.version,
      book_status: data.book.status,
      policy_version: data.book.policy_version,
      roster_current: data.rosterCurrent,
    }));
    await audit(db, actor, "grading.exported", id, {
      unitId: data.book.unit_id,
      version: data.book.version,
    });
    res
      .type("text/csv")
      .attachment("stjw-class-grades.csv")
      .send(
        toCsv(rows, [
          "student_id",
          "student_number",
          "student_name",
          "class_name",
          "term",
          "percentage",
          "grade",
          "pending",
          "missing",
          "book_id",
          "book_version",
          "book_status",
          "policy_version",
          "roster_current",
        ]),
      );
  });
}
