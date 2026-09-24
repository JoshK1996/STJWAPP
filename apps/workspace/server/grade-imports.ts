import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import {
  audit,
  digest,
  limitAuth,
  requireCondition,
  type Actor,
} from "./security";
import { schoolActor } from "./school";
import { lockAcademics } from "./timetable-engine";
import { detail, saveGradeScoresTransaction } from "./grading";
import { gradeScoreInput, gradeScoresInput } from "../shared/grading";
import {
  gradeImportColumns,
  gradeImportPreviewInput,
  gradeImportApplyInput,
} from "../shared/grade-imports";
import { toCsv } from "./reports";

// All operations lock academics before account, grants and gradebook. This keeps
// teacher/roster changes stable without reversing the academic writer lock order.
async function context(tx: Queryable, actor: Actor, assignmentId: string, sessionHash: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in is required.",
  );
  await lockAcademics(tx, actor.org_id);
  const current = await currentReportActor(tx, actor, sessionHash);
  const lookup = (
    await tx.query(
      "SELECT book_id,unit_id FROM grade_assignments WHERE id=$1 AND org_id=$2",
      [assignmentId, actor.org_id],
    )
  ).rows[0];
  requireCondition(lookup, 404, "Assignment not found.");
  // Lock an existing office grant against revocation; teacher assignments are
  // protected by the academic lock. No workforce role implicitly grants access.
  await tx.query(
    "SELECT unit_id FROM school_office_grants WHERE user_id=$1 AND org_id=$2 AND unit_id=$3 FOR SHARE",
    [actor.id, actor.org_id, lookup.unit_id],
  );
  const data = await detail(tx, current, lookup.book_id);
  const assignment = data.assignments.find((x) => x.id === assignmentId)!;
  return { actor: current, data, assignment };
}
function importSessionHash(value: string | undefined): string {
  requireCondition(value && /^[a-f0-9]{64}$/.test(value), 401, "Your session has expired or changed. Sign in again.");
  return value!;
}
const requestProof = (req: Request) => importSessionHash((req as AppRequest).sessionHash);
function editable(data: Awaited<ReturnType<typeof detail>>, assignment: Row) {
  requireCondition(
    data.book.status === "open" &&
      !data.section.archived &&
      !data.term.locked_at &&
      !assignment.archived,
    409,
    "Open an active assignment in a draft gradebook before importing.",
  );
  requireCondition(
    data.rosterCurrent,
    409,
    "The class roster changed. Reconcile the gradebook and download a fresh template.",
  );
}
const safeText = (value: string) =>
  /^[\s]*[=+@\-\t\r\0]/.test(value) ? "'" + value : value;
const pointsText = (value: number | null) =>
  value === null ? "" : String(value / 100);
function templateRows(data: Awaited<ReturnType<typeof detail>>, assignment: Row) {
  const rows = data.scores
    .filter((x) => x.assignment_id === assignment.id && x.expected)
    .map((x) => ({
      assignmentId: String(assignment.id),
      bookVersion: String(data.book.version),
      assignmentVersion: String(assignment.version),
      studentId: String(x.student_id),
      studentName: String(x.student_name),
      status: String(x.status),
      points: pointsText(x.points_units),
      note: String(x.note),
    }));
  requireCondition(rows.length > 0 && rows.length <= 200, 409, "Template requires 1–200 captured students.");
  return rows;
}
// Transaction-only helper. Call before taking any account/domain locks and
// recheck the actual session immediately before publishing the caller's result.
// Cells remain literal text; CSV escaping belongs only to CSV serialization.
export async function gradeImportWorkbookContext(tx: Queryable, supplied: Actor, sessionHash: string | undefined, assignmentId: string) {
  const proof = importSessionHash(sessionHash);
  const { actor, data, assignment } = await context(tx, supplied, assignmentId, proof);
  editable(data, assignment);
  const rows = templateRows(data, assignment).map(row => gradeImportColumns.map(column => row[column]));
  const bookId: string = data.book.id, bookVersion: number = data.book.version, assignmentVersion: number = assignment.version;
  const sourceHash = digest(JSON.stringify({ bookId, bookVersion, assignmentId, assignmentVersion, rosterFingerprint: data.book.roster_fingerprint, rows }));
  return { actor, rows, sourceHash, bookId, bookVersion, assignmentVersion };
}
export function parseGradeCsv(csv: string): Record<string, string>[] {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 20000,
    });
  } catch {
    throw new Error(
      "CSV could not be read. Check quotes and use the downloaded template.",
    );
  }
  const [headers, ...rows] = records;
  requireCondition(
    headers?.length === gradeImportColumns.length &&
      new Set(headers).size === headers.length &&
      gradeImportColumns.every((x) => headers.includes(x)),
    400,
    "Use the exact downloaded grade import columns.",
  );
  requireCondition(
    rows.length > 0 && rows.length <= 200,
    400,
    "Include 1–200 students from this assignment’s captured roster.",
  );
  return rows.map((row) =>
    Object.fromEntries(headers.map((key, i) => [key, row[i]])),
  );
}
function planFor(
  data: Awaited<ReturnType<typeof detail>>,
  assignment: Row,
  inputRows: Record<string, string>[],
) {
  const expected = data.scores.filter(
    (x) => x.assignment_id === assignment.id && x.expected,
  );
  const seen = new Set<string>();
  const rows = inputRows.map((input, index) => {
    const errors: string[] = [];
    const old = expected.find((x) => x.student_id === input.studentId);
    if (input.assignmentId !== assignment.id)
      errors.push("Assignment identity does not match.");
    if (
      input.bookVersion !== String(data.book.version) ||
      input.assignmentVersion !== String(assignment.version)
    )
      errors.push("This template is out of date. Download a fresh copy.");
    if (seen.has(input.studentId))
      errors.push("Student appears more than once.");
    seen.add(input.studentId);
    if (!old)
      errors.push("Student is not in this assignment’s captured roster.");
    if (
      old &&
      input.studentName !== old.student_name &&
      input.studentName !== safeText(old.student_name)
    )
      errors.push("Student name does not match the captured student identity.");
    let pointsUnits: number | null = null;
    if (input.points !== "") {
      if (!/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(input.points))
        errors.push(
          "Points must be a nonnegative decimal with at most two decimal places.",
        );
      else {
        const [whole, fraction = ""] = input.points.split(".");
        pointsUnits = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
      }
    }
    // Preserve an unchanged formula-protected note when round-tripping the
    // template. New note text is never evaluated and remains literal.
    const note =
      old && input.note === safeText(old.note) ? old.note : input.note;
    const parsed = gradeScoreInput.safeParse({
      studentId: input.studentId,
      status: input.status,
      pointsUnits,
      note,
    });
    if (!parsed.success)
      errors.push(...parsed.error.issues.map((x) => x.message));
    if (parsed.success) {
      if (
        !data.book.policy.allowExtraCredit &&
        pointsUnits !== null &&
        pointsUnits > assignment.max_points_units
      )
        errors.push("Points exceed the assignment maximum under this policy.");
      if (
        ["exempt", "incomplete"].includes(parsed.data.status) &&
        parsed.data.note.length < 3
      )
        errors.push("Exempt or incomplete work needs an explanatory note.");
    }
    const before = old
      ? {
          studentId: old.student_id,
          status: old.status,
          pointsUnits: old.points_units,
          note: old.note,
        }
      : null;
    const after = parsed.success ? parsed.data : null;
    return {
      row: index + 2,
      studentId: input.studentId,
      studentName: old?.student_name ?? "Unmatched student",
      before,
      after,
      errors,
      changed:
        !!before && !!after && JSON.stringify(before) !== JSON.stringify(after),
    };
  });
  const missing = expected
    .filter((x) => !seen.has(x.student_id))
    .map((x) => ({ studentId: x.student_id, studentName: x.student_name }));
  return {
    assignmentId: assignment.id,
    assignmentTitle: assignment.title,
    bookId: data.book.id,
    bookVersion: data.book.version,
    assignmentVersion: assignment.version,
    sectionName: data.section.name,
    termName: data.term.name,
    rosterFingerprint: data.book.roster_fingerprint,
    maxPointsUnits: assignment.max_points_units,
    rows,
    missing,
    errors: rows.reduce((n, x) => n + x.errors.length, 0) + missing.length,
    changed: rows.filter((x) => x.changed && !x.errors.length).length,
  };
}
function view(row: Row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    sourceHash: row.source_hash,
    planHash: row.plan_hash,
    plan: row.plan,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    appliedAt: row.applied_at,
    receipt: row.receipt,
  };
}
async function owned(tx: Queryable, actor: Actor, id: string, lock = false) {
  const row = (
    await tx.query(
      "SELECT * FROM grade_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3" +
        (lock ? " FOR UPDATE" : ""),
      [id, actor.org_id, actor.id],
    )
  ).rows[0];
  requireCondition(row, 404, "Private grade preview not found.");
  return row;
}
export async function previewGradeImport(
  db: Database,
  actor: Actor,
  assignmentId: string,
  input: z.infer<typeof gradeImportPreviewInput>,
  sessionHash?: string,
) {
  const proof = importSessionHash(sessionHash);
  let rows: Record<string, string>[];
  try {
    rows = parseGradeCsv(input.csv);
  } catch (error) {
    requireCondition(false, 400, (error as Error).message);
  }
  return reportTransaction(db, async (tx) => {
    const {
      data,
      assignment,
      actor: current,
    } = await context(tx, actor, assignmentId, proof);
    editable(data, assignment);
    const plan = planFor(data, assignment, rows),
      sourceHash = digest(input.csv),
      planHash = digest(JSON.stringify(plan));
    const row = (
      await tx.query(
        "INSERT INTO grade_import_batches(id,org_id,unit_id,actor_id,book_id,assignment_id,source_base64,source_hash,plan_hash,plan,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          randomUUID(),
          current.org_id,
          data.book.unit_id,
          current.id,
          data.book.id,
          assignmentId,
          Buffer.from(input.csv, "utf-8").toString("base64"),
          sourceHash,
          planHash,
          JSON.stringify(plan),
          input.reason,
        ],
      )
    ).rows[0];
    await audit(tx, current, "grading.import_previewed", row.id, {
      assignmentId,
      sourceHash,
      planHash,
      rows: rows.length,
      errors: plan.errors,
    });
    const result = view(row);
    JSON.stringify(result);
    await recheckReportSession(tx, current, proof);
    return result;
  });
}
export async function applyGradeImport(
  db: Database,
  actor: Actor,
  id: string,
  input: z.infer<typeof gradeImportApplyInput>,
  sessionHash?: string,
) {
  const proof = importSessionHash(sessionHash);
  return reportTransaction(db, async (tx) => {
    const lookup = await owned(tx, actor, id);
    const {
      data,
      assignment,
      actor: current,
    } = await context(tx, actor, lookup.assignment_id, proof);
    const row = await owned(tx, actor, id, true);
    requireCondition(
      input.sourceHash === row.source_hash &&
        input.planHash === row.plan_hash &&
        input.reviewed === true,
      409,
      "Review this exact preview before applying it.",
    );
    if (row.applied_at) {
      JSON.stringify(row.receipt);
      await recheckReportSession(tx, current, proof);
      return row.receipt;
    }
    requireCondition(
      (
        await tx.query(
          "SELECT expires_at>clock_timestamp() AS valid FROM grade_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0].valid,
      409,
      "Preview expired. Download a fresh template.",
    );
    editable(data, assignment);
    const plan = planFor(
      data,
      assignment,
      parseGradeCsv(Buffer.from(row.source_base64, "base64").toString("utf-8")),
    );
    requireCondition(
      !row.plan.errors &&
        !plan.errors &&
        plan.changed > 0 &&
        digest(JSON.stringify(plan)) === row.plan_hash,
      409,
      "Scores or roster changed, or this preview has errors or no changes. Review a fresh template.",
    );
    const result = await saveGradeScoresTransaction(
      tx,
      current,
      assignment.id,
      gradeScoresInput.parse({
        bookVersion: plan.bookVersion,
        version: plan.assignmentVersion,
        scores: plan.rows.map((x) => x.after),
        reason: row.reason,
      }),
    );
    const receipt = {
      id,
      assignmentId: assignment.id,
      bookId: data.book.id,
      beforeBookVersion: data.book.version,
      bookVersion: result.bookVersion,
      changed: plan.changed,
      sourceHash: row.source_hash,
      planHash: row.plan_hash,
    };
    await tx.query(
      "UPDATE grade_import_batches SET applied_at=clock_timestamp(),receipt=$1 WHERE id=$2",
      [JSON.stringify(receipt), id],
    );
    await audit(tx, current, "grading.import_applied", id, receipt);
    JSON.stringify(receipt);
    await recheckReportSession(tx, current, proof);
    return receipt;
  });
}
export function installGradeImports(app: Express, db: Database) {
  const uuid = (x: unknown) => z.uuid().parse(x);
  app.use(["/api/school/grade-imports", "/api/school/grade-assignments/:id/import-template", "/api/school/grade-assignments/:id/import-previews"], (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  app.get(
    "/api/school/grade-assignments/:id/import-template",
    async (req, res) => {
      const actor = schoolActor(req),
        assignmentId = uuid(req.params.id), proof = requestProof(req);
      const csv = await reportTransaction(db, async (tx) => {
        const {
          data,
          assignment,
          actor: current,
        } = await context(tx, actor, assignmentId, proof);
        editable(data, assignment);
        const rows = templateRows(data, assignment);
        await audit(
          tx,
          current,
          "grading.import_template_exported",
          assignmentId,
          { bookVersion: data.book.version, rows: rows.length },
        );
        const result = toCsv(rows, [...gradeImportColumns]);
        await recheckReportSession(tx, current, proof);
        return result;
      });
      res.type("text/csv").attachment("stjw-assignment-scores.csv").send(csv);
    },
  );
  app.post(
    "/api/school/grade-assignments/:id/import-previews",
    async (req, res) => {
      const actor = schoolActor(req);
      await limitAuth(db, "grade-import:" + actor.id, 30);
      res.json(
        await previewGradeImport(
          db,
          actor,
          uuid(req.params.id),
          gradeImportPreviewInput.parse(req.body),
          requestProof(req),
        ),
      );
    },
  );
  app.get(
    "/api/school/grade-assignments/:id/import-previews",
    async (req, res) => {
      const actor = schoolActor(req),
        assignmentId = uuid(req.params.id), proof = requestProof(req);
      res.json(
        await reportTransaction(db, async (tx) => {
          const { actor: current } = await context(tx, actor, assignmentId, proof);
          const result = {
            rows: (
              await tx.query(
                "SELECT id,created_at,expires_at,applied_at,receipt,source_hash,plan_hash FROM grade_import_batches WHERE org_id=$1 AND actor_id=$2 AND assignment_id=$3 ORDER BY created_at DESC,id LIMIT 50",
                [current.org_id, current.id, assignmentId],
              )
            ).rows,
          };
          JSON.stringify(result);
          await recheckReportSession(tx, current, proof);
          return result;
        }),
      );
    },
  );
  app.get("/api/school/grade-imports/:id", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id), proof = requestProof(req);
    res.json(
      await reportTransaction(db, async (tx) => {
        const row = await owned(tx, actor, id);
        const { actor: current } = await context(tx, actor, row.assignment_id, proof);
        await audit(tx, current, "grading.import_read", id, {});
        const result = view(row);
        JSON.stringify(result);
        await recheckReportSession(tx, current, proof);
        return result;
      }),
    );
  });
  app.get("/api/school/grade-imports/:id/source", async (req, res) => {
    const actor = schoolActor(req),
      id = uuid(req.params.id), proof = requestProof(req);
    const source = await reportTransaction(db, async (tx) => {
      const row = await owned(tx, actor, id);
      const { actor: current } = await context(tx, actor, row.assignment_id, proof);
      await audit(tx, current, "grading.import_source_exported", id, {
        sourceHash: row.source_hash,
      });
      const result = Buffer.from(row.source_base64, "base64").toString("utf-8");
      await recheckReportSession(tx, current, proof);
      return result;
    });
    res
      .type("text/plain")
      .attachment("stjw-grade-import-source.txt")
      .send(source);
  });
  app.post("/api/school/grade-imports/:id/apply", async (req, res) =>
    res.json(
      await applyGradeImport(
        db,
        schoolActor(req),
        uuid(req.params.id),
        gradeImportApplyInput.parse(req.body),
        requestProof(req),
      ),
    ),
  );
}
