import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { schoolActor, officeUnits, studentById, schoolChange } from "./school";
import { toCsv } from "./reports";
import {
  openReportCardInput,
  saveReportCardInput,
  reconcileReportCardInput,
  issueReportCardInput,
  reopenReportCardInput,
  defaultReportCardPresentation,
  reportCardKey,
} from "../shared/report-cards";

function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const dates =
  "to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on";
async function office(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  lock = false,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to open report cards.",
  );
  const user = (
    await tx.query(
      "SELECT role,active FROM users WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR SHARE" : ""),
      [actor.id, actor.org_id],
    )
  ).rows[0];
  requireCondition(user?.active, 403, "This account is unavailable.");
  if (!["developer", "owner", "admin"].includes(user.role)) {
    const membership = (
      await tx.query(
        "SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 AND unit_id=$3" +
          (lock ? " FOR SHARE" : ""),
        [actor.org_id, actor.id, unitId],
      )
    ).rows;
    const grant = (
      await tx.query(
        "SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3" +
          (lock ? " FOR SHARE" : ""),
        [actor.org_id, actor.id, unitId],
      )
    ).rows;
    requireCondition(
      membership.length && grant.length,
      403,
      "School office access is required for multi-class report cards.",
    );
  }
  requireCondition(
    (await officeUnits(tx, { ...actor, role: user.role })).includes(unitId),
    403,
    "School office access is required for this unit.",
  );
}
async function reportStudent(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  lock = false,
) {
  const identity = (
    await tx.query("SELECT unit_id FROM students WHERE id=$1 AND org_id=$2", [
      studentId,
      actor.org_id,
    ])
  ).rows[0];
  requireCondition(identity, 404, "Student not found.");
  await office(tx, actor, identity.unit_id, lock);
  const student = await studentById(tx, actor, studentId, true, lock);
  const person = (
    await tx.query(
      "SELECT name,version FROM school_people WHERE id=$1" +
        (lock ? " FOR SHARE" : ""),
      [student.person_id],
    )
  ).rows[0];
  return {
    id: student.id,
    name: person.name,
    studentNumber: student.student_number,
    unitId: student.unit_id,
    version: student.version,
    personVersion: person.version,
  };
}
async function cardFor(tx: Queryable, actor: Actor, id: string, lock = false) {
  const initial = (
    await tx.query(
      "SELECT student_id,unit_id FROM report_cards WHERE id=$1 AND org_id=$2",
      [id, actor.org_id],
    )
  ).rows[0];
  requireCondition(initial, 404, "Report card not found.");
  await reportStudent(tx, actor, initial.student_id, lock);
  const card = (
    await tx.query(
      "SELECT * FROM report_cards WHERE id=$1 AND org_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, actor.org_id],
    )
  ).rows[0];
  return card;
}
/** Only this student's reviewed result is selected from each immutable class release. */
async function sourceFor(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof openReportCardInput>,
  prior: Row[] = [],
  lock = false,
) {
  const student = await reportStudent(tx, actor, input.studentId, lock);
  const year = (
    await tx.query(
      `SELECT id,name,version,${dates} FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3` +
        (lock ? " FOR SHARE" : ""),
      [input.yearId, actor.org_id, student.unitId],
    )
  ).rows[0];
  requireCondition(year, 404, "School year not found in this student’s unit.");
  const terms = (
    await tx.query(
      `SELECT id,name,version,${dates} FROM school_terms WHERE id=ANY($1::uuid[]) AND org_id=$2 AND unit_id=$3 AND year_id=$4 ORDER BY school_terms.starts_on,school_terms.id` +
        (lock ? " FOR SHARE" : ""),
      [input.termIds, actor.org_id, student.unitId, year.id],
    )
  ).rows;
  requireCondition(
    terms.length === input.termIds.length,
    400,
    "Every selected term must belong to this school year.",
  );
  const enrollment = (
    await tx.query(
      `SELECT id,version,grade_level,status,${dates} FROM student_enrollments WHERE student_id=$1 AND year_id=$2`,
      [student.id, year.id],
    )
  ).rows[0];
  requireCondition(
    enrollment,
    409,
    "Enroll this student in the selected school year first.",
  );
  const organization = (
    await tx.query(
      "SELECT o.name,u.name AS unit_name FROM organizations o JOIN units u ON u.org_id=o.id WHERE o.id=$1 AND u.id=$2",
      [actor.org_id, student.unitId],
    )
  ).rows[0];
  const candidates = (
    await tx.query(
      `SELECT s.id AS section_id,t.id AS term_id FROM sections s JOIN school_terms t ON t.year_id=s.year_id LEFT JOIN section_students r ON r.section_id=s.id AND r.student_id=$4 LEFT JOIN gradebooks b ON b.section_id=s.id AND b.term_id=t.id WHERE s.org_id=$1 AND s.unit_id=$2 AND s.year_id=$3 AND t.id=ANY($5::uuid[]) AND ((greatest(r.starts_on,$6::date,t.starts_on)<=least(r.ends_on,$7::date,t.ends_on) AND r.student_id IS NOT NULL) OR EXISTS(SELECT 1 FROM gradebook_releases g WHERE g.book_id=b.id AND g.snapshot->'results' @> jsonb_build_array(jsonb_build_object('student_id',$4::text))) OR (s.id::text||':'||t.id::text)=ANY($8::text[])) ORDER BY s.id,t.id`,
      [
        actor.org_id,
        student.unitId,
        year.id,
        student.id,
        input.termIds,
        enrollment.starts_on,
        enrollment.ends_on,
        prior.map((c) => reportCardKey(c as any)),
      ],
    )
  ).rows;
  requireCondition(
    candidates.length <= 200,
    400,
    "Choose fewer terms. A report supports at most 200 class/term results.",
  );
  if (lock && candidates.length) {
    await tx.query(
      "SELECT id FROM sections WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
      [[...new Set(candidates.map((c) => c.section_id))]],
    );
    for (const cell of candidates)
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "gradebook:" + cell.section_id + ":" + cell.term_id,
      ]);
  }
  const cells: Row[] = [];
  for (const candidate of candidates) {
    const term = terms.find((t) => t.id === candidate.term_id)!;
    const section = (
      await tx.query(
        "SELECT s.id,s.name,s.version,s.course_id,s.archived,c.code AS course_code,c.title AS course_title,c.version AS course_version FROM sections s LEFT JOIN courses c ON c.id=s.course_id WHERE s.id=$1",
        [candidate.section_id],
      )
    ).rows[0];
    const roster =
      (
        await tx.query(
          `SELECT version,${dates} FROM section_students WHERE section_id=$1 AND student_id=$2`,
          [section.id, student.id],
        )
      ).rows[0] ?? null;
    const starts = roster
      ? [roster.starts_on, enrollment.starts_on, term.starts_on].sort().at(-1)
      : null;
    const ends = roster
      ? [roster.ends_on, enrollment.ends_on, term.ends_on].sort()[0]
      : null;
    const inClass = !!starts && !!ends && starts <= ends;
    const book =
      (
        await tx.query(
          "SELECT id,version,status,policy_version FROM gradebooks WHERE section_id=$1 AND term_id=$2" +
            (lock ? " FOR SHARE" : ""),
          [section.id, term.id],
        )
      ).rows[0] ?? null;
    const release = book
      ? ((
          await tx.query(
            `SELECT g.id,g.book_version,g.created_at,u.name AS reviewer_name,g.snapshot->'book'->'policy'->>'name' AS policy_name,(SELECT value FROM jsonb_array_elements(g.snapshot->'results') value WHERE value->>'student_id'=$2) AS result FROM gradebook_releases g JOIN users u ON u.id=g.created_by WHERE g.book_id=$1 ORDER BY g.book_version DESC LIMIT 1`,
            [book.id, student.id],
          )
        ).rows[0] ?? null)
      : null;
    // Normalize timestamp representation before hashing across pg, PGlite and JSONB round trips.
    if (release)
      release.created_at = new Date(release.created_at).toISOString();
    let problem: string | null = null;
    if (!book || !release)
      problem = "No office-reviewed class result is available.";
    else if (book.status !== "locked" || book.version !== release.book_version)
      problem = "This gradebook needs office review and locking again.";
    else if (!release.result)
      problem =
        "The latest reviewed class result does not include this student.";
    else if (
      !inClass ||
      release.result.starts_on !== starts ||
      release.result.ends_on !== ends
    )
      problem =
        "The student’s class or enrollment dates changed. Reconcile and review the gradebook.";
    const result = release?.result
      ? {
          percentage: release.result.percentage,
          label: release.result.label,
          missing: release.result.missing,
          pending: release.result.pending,
          incomplete: release.result.incomplete,
          hasEvidence: release.result.hasEvidence,
        }
      : null;
    const releaseSource = release
      ? {
          id: release.id,
          version: release.book_version,
          reviewedAt: release.created_at,
          reviewerName: release.reviewer_name,
          policyName: release.policy_name,
        }
      : null;
    cells.push({
      sectionId: section.id,
      termId: term.id,
      section,
      roster,
      book,
      release: releaseSource,
      result,
      inClass,
      problem,
    });
  }
  cells.sort(
    (a, b) =>
      a.section.name.localeCompare(b.section.name) ||
      a.sectionId.localeCompare(b.sectionId) ||
      terms.findIndex((t) => t.id === a.termId) -
        terms.findIndex((t) => t.id === b.termId),
  );
  return { student, organization, year, terms, enrollment, cells };
}
/** Transaction-only read projection for reviewed source adapters. Starts no
 * transaction and acquires no source row locks. Callers publishing a fresh
 * decision must supply their own reviewed parent-lock and authority protocol.
 * Existing report-card writers continue to use sourceFor with their own locks. */
export function readReportCardSource(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof openReportCardInput>,
  prior: Row[] = [],
) {
  return sourceFor(tx, actor, input, prior, false);
}
const contextOf = (card: Row) => ({
  studentId: card.student_id,
  yearId: card.year_id,
  termIds: card.term_ids,
});
function defaults(source: Row) {
  return source.cells.map((c: Row) => ({
    sectionId: c.sectionId,
    termId: c.termId,
    included: true,
    exclusionReason: "",
    comment: "",
  }));
}
function exactCells(card: Row, cells: Row[]) {
  const expected = new Set(
    card.source_snapshot.cells.map((c: Row) => reportCardKey(c as any)),
  );
  requireCondition(
    cells.length === expected.size &&
      cells.every((c) => expected.has(reportCardKey(c as any))),
    400,
    "Keep every captured class/term cell. Refresh sources to add or remove source records.",
  );
}
export async function openReportCard(db: Database, actor: Actor, raw: unknown) {
  const input = openReportCardInput.parse(raw),
    termIds = [...input.termIds].sort(),
    termKey = digest(termIds.join(","));
  return db.transaction(async (tx) => {
    await reportStudent(tx, actor, input.studentId, true);
    const old = (
      await tx.query(
        "SELECT * FROM report_cards WHERE student_id=$1 AND year_id=$2 AND term_key=$3 AND org_id=$4",
        [input.studentId, input.yearId, termKey, actor.org_id],
      )
    ).rows[0];
    if (old) return old;
    const source = await sourceFor(tx, actor, { ...input, termIds }, [], true),
      id = randomUUID();
    const card = (
      await tx.query(
        "INSERT INTO report_cards(id,org_id,unit_id,student_id,year_id,term_ids,term_key,presentation,cells,source_snapshot,source_hash,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *",
        [
          id,
          actor.org_id,
          source.student.unitId,
          input.studentId,
          input.yearId,
          termIds,
          termKey,
          JSON.stringify(defaultReportCardPresentation),
          JSON.stringify(defaults(source)),
          JSON.stringify(source),
          digest(canonical(source)),
          actor.id,
        ],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      card.unit_id,
      "report_card.opened",
      id,
      null,
      card,
    );
    return card;
  });
}
export async function reportCardDetail(db: Database, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const card = await cardFor(tx, actor, id),
      source = await sourceFor(
        tx,
        actor,
        contextOf(card),
        card.source_snapshot.cells,
      ),
      sourceHash = digest(canonical(source));
    const issues = (
      await tx.query(
        "SELECT i.id,i.number,i.card_version,i.snapshot_hash,i.issued_at,i.reason,u.name AS issuer_name FROM report_card_issues i JOIN users u ON u.id=i.issued_by WHERE i.card_id=$1 ORDER BY i.number DESC",
        [id],
      )
    ).rows;
    const history = (
      await tx.query(
        "SELECT h.id,h.entity_type,h.created_at,u.name AS actor_name,h.snapshot FROM school_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.entity_id=$2 ORDER BY h.created_at DESC,h.id LIMIT 100",
        [actor.org_id, id],
      )
    ).rows;
    return {
      card,
      currentSource: source,
      currentSourceHash: sourceHash,
      sourceCurrent: sourceHash === card.source_hash,
      issues,
      history,
    };
  });
}
async function command(
  db: Database,
  actor: Actor,
  id: string,
  kind: string,
  input: Row,
  fn: (tx: Queryable, card: Row) => Promise<Row>,
) {
  return db.transaction(async (tx) => {
    const card = await cardFor(tx, actor, id, true),
      fingerprint = digest(canonical({ id, kind, input }));
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),721305)", [
      actor.id + ":" + input.commandId,
    ]);
    const previous = (
      await tx.query(
        "SELECT fingerprint,result FROM report_card_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
        [actor.org_id, actor.id, input.commandId],
      )
    ).rows[0];
    if (previous) {
      requireCondition(
        previous.fingerprint === fingerprint,
        409,
        "This command was already used for different changes.",
      );
      return previous.result;
    }
    requireCondition(
      card.version === input.version,
      409,
      "Report card changed. Reload before saving.",
    );
    const result = await fn(tx, card);
    await tx.query(
      "INSERT INTO report_card_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [
        actor.org_id,
        actor.id,
        input.commandId,
        fingerprint,
        JSON.stringify(result),
      ],
    );
    return result;
  });
}
export async function saveReportCard(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = saveReportCardInput.parse(raw);
  return command(db, actor, id, "save", input, async (tx, card) => {
    requireCondition(
      card.status === "draft",
      409,
      "Reopen the report card before making a new revision.",
    );
    exactCells(card, input.cells);
    const row = (
      await tx.query(
        "UPDATE report_cards SET presentation=$2,cells=$3,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          JSON.stringify(input.presentation),
          JSON.stringify(input.cells),
          actor.id,
        ],
      )
    ).rows[0];
    await schoolChange(tx, actor, card.unit_id, "report_card.saved", id, card, {
      ...row,
      reason: input.reason,
    });
    return { id, version: row.version, status: row.status };
  });
}
export async function reconcileReportCard(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = reconcileReportCardInput.parse(raw);
  return command(db, actor, id, "reconcile", input, async (tx, card) => {
    requireCondition(
      card.status === "draft",
      409,
      "Reopen the report card before refreshing sources.",
    );
    const source = await sourceFor(
        tx,
        actor,
        contextOf(card),
        card.source_snapshot.cells,
        true,
      ),
      hash = digest(canonical(source));
    requireCondition(
      hash === input.sourceHash,
      409,
      "Source records changed again. Reload the source review.",
    );
    const existing = new Map<string, Row>(
      card.cells.map((c: Row) => [reportCardKey(c as any), c]),
    );
    const cells = defaults(source).map(
      (c: Row) => existing.get(reportCardKey(c as any)) ?? c,
    );
    const row = (
      await tx.query(
        "UPDATE report_cards SET source_snapshot=$2,source_hash=$3,cells=$4,version=version+1,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *",
        [id, JSON.stringify(source), hash, JSON.stringify(cells), actor.id],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      card.unit_id,
      "report_card.reconciled",
      id,
      card,
      { ...row, reason: input.reason },
    );
    return { id, version: row.version, status: row.status };
  });
}
export async function issueReportCard(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = issueReportCardInput.parse(raw);
  return command(db, actor, id, "issue", input, async (tx, card) => {
    requireCondition(
      card.status === "draft",
      409,
      "This report card is already issued. Reopen it for a new revision.",
    );
    const source = await sourceFor(
      tx,
      actor,
      contextOf(card),
      card.source_snapshot.cells,
      true,
    );
    requireCondition(
      digest(canonical(source)) === card.source_hash,
      409,
      "Source records changed. Review and refresh sources before issuing.",
    );
    exactCells(card, card.cells);
    const included = card.cells.filter((c: Row) => c.included);
    requireCondition(
      included.length > 0,
      409,
      "Include at least one reviewed class result.",
    );
    requireCondition(
      card.cells.every(
        (c: Row) => c.included || c.exclusionReason.trim().length >= 10,
      ),
      409,
      "Explain every excluded class/term result in at least 10 characters.",
    );
    for (const cell of included) {
      const value = source.cells.find(
        (c: Row) => reportCardKey(c as any) === reportCardKey(cell as any),
      )!;
      requireCondition(
        !value.problem,
        409,
        value.section.name + ": " + value.problem,
      );
      requireCondition(
        !value.result.pending && !value.result.incomplete,
        409,
        "Resolve pending or incomplete class results first.",
      );
      requireCondition(
        value.result.percentage !== null || input.acknowledgeNoGrade,
        409,
        "Acknowledge included results without a calculated grade.",
      );
      requireCondition(
        !value.result.missing || input.acknowledgeMissing,
        409,
        "Acknowledge recorded missing work in included results.",
      );
      requireCondition(
        card.presentation.showPercentage ||
          value.result.percentage === null ||
          value.result.label !== null,
        409,
        "Turn on percentages for a result without a configured grade label.",
      );
    }
    const issueId = randomUUID(),
      number = card.issue_count + 1,
      version = card.version + 1;
    const issuer = (
      await tx.query("SELECT name FROM users WHERE id=$1", [actor.id])
    ).rows[0].name;
    const snapshot = {
      cardId: id,
      number,
      version,
      presentation: card.presentation,
      cells: card.cells,
      source,
      sourceHash: card.source_hash,
      issuerName: issuer,
      reason: input.reason,
      acknowledgeNoGrade: input.acknowledgeNoGrade,
      acknowledgeMissing: input.acknowledgeMissing,
    };
    await tx.query(
      "INSERT INTO report_card_issues(id,org_id,unit_id,card_id,number,card_version,snapshot,snapshot_hash,issued_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        issueId,
        actor.org_id,
        card.unit_id,
        id,
        number,
        version,
        JSON.stringify(snapshot),
        digest(canonical(snapshot)),
        actor.id,
        input.reason,
      ],
    );
    const row = (
      await tx.query(
        "UPDATE report_cards SET status='issued',issue_count=$2,version=$3,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *",
        [id, number, version, actor.id],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      card.unit_id,
      "report_card.issued",
      id,
      card,
      { ...row, issueId, reason: input.reason },
    );
    return { id, version, status: "issued", issueId, number };
  });
}
export async function reopenReportCard(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = reopenReportCardInput.parse(raw);
  return command(db, actor, id, "reopen", input, async (tx, card) => {
    requireCondition(
      card.status === "issued",
      409,
      "This report card is already a draft.",
    );
    const row = (
      await tx.query(
        "UPDATE report_cards SET status='draft',version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [id, actor.id],
      )
    ).rows[0];
    await schoolChange(
      tx,
      actor,
      card.unit_id,
      "report_card.reopened",
      id,
      card,
      { ...row, reason: input.reason },
    );
    return { id, version: row.version, status: "draft" };
  });
}
export function installReportCards(app: Express, db: Database) {
  app.get("/api/school/report-cards", async (req, res) => {
    const actor = schoolActor(req),
      unitId = z.uuid().parse(req.query.unitId),
      yearId = z.uuid().parse(req.query.yearId);
    await office(db, actor, unitId);
    const search = z
        .string()
        .max(120)
        .parse(req.query.search ?? ""),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(req.query.offset ?? 0);
    const students = (
      await db.query(
        "SELECT s.id,s.student_number,p.name,e.grade_level FROM students s JOIN school_people p ON p.id=s.person_id JOIN student_enrollments e ON e.student_id=s.id WHERE s.org_id=$1 AND s.unit_id=$2 AND e.year_id=$3 AND (p.name ILIKE '%'||$4||'%' OR s.student_number ILIKE '%'||$4||'%') ORDER BY p.name,s.id LIMIT 51 OFFSET $5",
        [actor.org_id, unitId, yearId, search, offset],
      )
    ).rows;
    const cards = (
      await db.query(
        "SELECT c.id,c.student_id,c.term_ids,c.version,c.status,c.issue_count,c.updated_at,c.presentation->>'title' AS title FROM report_cards c WHERE c.org_id=$1 AND c.unit_id=$2 AND c.year_id=$3 AND c.student_id=ANY($4::uuid[]) ORDER BY c.updated_at DESC",
        [actor.org_id, unitId, yearId, students.slice(0, 50).map((s) => s.id)],
      )
    ).rows;
    res.json({
      students: students.slice(0, 50),
      hasMore: students.length > 50,
      cards,
    });
  });
  app.post("/api/school/report-cards/open", async (req, res) =>
    res.status(201).json(await openReportCard(db, schoolActor(req), req.body)),
  );
  app.get("/api/school/report-cards/:id", async (req, res) =>
    res.json(
      await reportCardDetail(
        db,
        schoolActor(req),
        z.uuid().parse(req.params.id),
      ),
    ),
  );
  for (const [path, fn] of Object.entries({
    save: saveReportCard,
    reconcile: reconcileReportCard,
    issue: issueReportCard,
    reopen: reopenReportCard,
  }))
    app.post("/api/school/report-cards/:id/" + path, async (req, res) =>
      res.json(
        await fn(db, schoolActor(req), z.uuid().parse(req.params.id), req.body),
      ),
    );
  app.get("/api/school/report-cards/:id/issues/:issueId", async (req, res) => {
    const actor = schoolActor(req),
      id = z.uuid().parse(req.params.id),
      issueId = z.uuid().parse(req.params.issueId);
    const format = z.enum(["csv", "json"]).parse(req.query.format ?? "json");
    const result = await db.transaction(async (tx) => {
      const card = await cardFor(tx, actor, id);
      const issue = (
        await tx.query(
          "SELECT * FROM report_card_issues WHERE id=$1 AND card_id=$2 AND org_id=$3",
          [issueId, id, actor.org_id],
        )
      ).rows[0];
      requireCondition(issue, 404, "Issued report card not found.");
      await audit(tx, actor, "school.report_card.read", id, {
        issueId,
        format,
      });
      return {
        issue,
        latestNumber: card.issue_count,
        currentStatus: card.status,
      };
    });
    if (format === "csv") {
      const snap = result.issue.snapshot;
      const rows = snap.cells.map((c: Row) => {
        const source = snap.source.cells.find(
          (s: Row) => reportCardKey(s as any) === reportCardKey(c as any),
        );
        return {
          student_name: snap.source.student.name,
          student_number: snap.source.student.studentNumber,
          year: snap.source.year.name,
          term: snap.source.terms.find((t: Row) => t.id === c.termId).name,
          class: source.section.name,
          included: c.included,
          percentage: c.included ? source.result?.percentage : null,
          grade_label: c.included ? source.result?.label : null,
          comment: c.comment,
          exclusion_reason: c.exclusionReason,
          release_id: source.release?.id,
          release_version: source.release?.version,
          card_id: id,
          issue_id: issueId,
          issue_number: result.issue.number,
          issued_at: result.issue.issued_at,
          snapshot_hash: result.issue.snapshot_hash,
        };
      });
      res
        .type("text/csv")
        .attachment("stjw-report-card-" + result.issue.number + ".csv")
        .send(
          toCsv(rows, [
            "student_name",
            "student_number",
            "year",
            "term",
            "class",
            "included",
            "percentage",
            "grade_label",
            "comment",
            "exclusion_reason",
            "release_id",
            "release_version",
            "card_id",
            "issue_id",
            "issue_number",
            "issued_at",
            "snapshot_hash",
          ]),
        );
    } else {
      if (req.query.format === "json")
        res.attachment("stjw-report-card-" + result.issue.number + ".json");
      res.json(result);
    }
  });
}
