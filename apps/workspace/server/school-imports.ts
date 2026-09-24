import { lockAcademics } from "./timetable-engine";
import { buildFamilyPlan, applyFamilyRows, familyTemplateRows, familyIdentityRows } from "./family-imports";
import { buildPersonPlan, applyPersonRows, personTemplateRows } from "./person-imports";
import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { currentReportActor, recheckReportSession, reportTransaction } from "./report-source-access";
import { audit, digest, Problem, requireCondition, type Actor } from "./security";
import { toCsv } from "./reports";
import {
  schoolActor,
  assertOffice,
  createStudentTransaction,
  saveEnrollmentTransaction,
  prepareRosterBatch,
  saveRosterBatchTransaction,
} from "./school";
import { studentInput, enrollmentInput } from "../shared/school";
import {
  schoolImportCatalog,
  schoolImportKinds,
  isFamilyImport,
  isPersonImport,
  schoolImportContext,
  schoolImportRowSchemas,
  previewSchoolImportInput,
  applySchoolImportInput,
  type SchoolImportContext,
} from "../shared/school-imports";

const dateSql =
  "to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on";
type ImportRow = {
  row: number;
  input: Record<string, string>;
  student: Row | null;
  before: Row | null;
  after: Row | null;
  action: "create" | "update" | "unchanged" | "error";
  errors: string[];
  source: Row | null;
};
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** The import receipt is private even to another owner; source permissions are also current. */
async function access(
  tx: Queryable,
  actor: Actor,
  unitId: string,
  sessionHash: string,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to import school records.",
  );
  actor = await currentReportActor(tx, actor, sessionHash);
  if (["developer", "owner", "admin"].includes(actor.role)) {
    requireCondition(
      (
        await tx.query("SELECT id FROM units WHERE id=$1 AND org_id=$2", [
          unitId,
          actor.org_id,
        ])
      ).rows.length,
      404,
      "School unit not found.",
    );
  } else {
    const membership = (
      await tx.query(
        "SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 AND unit_id=$3 FOR SHARE",
        [actor.id, actor.org_id, unitId],
      )
    ).rows;
    const grant = (
      await tx.query(
        "SELECT unit_id FROM school_office_grants WHERE user_id=$1 AND org_id=$2 AND unit_id=$3 FOR SHARE",
        [actor.id, actor.org_id, unitId],
      )
    ).rows;
    requireCondition(
      membership.length && grant.length,
      403,
      "School office access to this unit is required.",
    );
  }
  await assertOffice(tx, actor, unitId);
  return actor;
}
function importSessionHash(value: string | undefined): string {
  requireCondition(value && /^[a-f0-9]{64}$/.test(value), 401, "Your session has expired or changed. Sign in again.");
  return value!;
}
const requestProof = (req: Request) => importSessionHash((req as AppRequest).sessionHash);
export function parseSchoolCsv(
  context: SchoolImportContext,
  csv: string,
): Record<string, string>[] {
  requireCondition(
    Buffer.byteLength(csv, "utf8") <= 400000,
    400,
    "Use a CSV file no larger than 400 KB.",
  );
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 4096,
      relax_column_count: false,
    });
  } catch {
    throw new Error("CSV_INVALID");
  }
  const columns = schoolImportCatalog[context.kind].columns;
  requireCondition(
    records.length > 1 && records.length <= 501,
    400,
    "Import between 1 and 500 rows.",
  );
  requireCondition(
    records[0].length === columns.length &&
      records[0].every((v, i) => v === columns[i]),
    400,
    "Use the exact headers and order from this template.",
  );
  return records
    .slice(1)
    .map((values) =>
      Object.fromEntries(columns.map((key, i) => [key, values[i]])),
    );
}
async function buildPlan(
  tx: Queryable,
  actor: Actor,
  context: SchoolImportContext,
  inputs: Record<string, string>[],
  lock = false,
) {
  // The caller holds current account, session, membership and office authority.
  if(isPersonImport(context)) return buildPersonPlan(tx,actor,context,inputs,lock);
  if(isFamilyImport(context)) return buildFamilyPlan(tx,actor,context,inputs,lock);
  let year: Row | null = null,
    section: Row | null = null;
  if (context.kind === "roster") {
    section = (
      await tx.query(
        "SELECT id,unit_id,year_id,name,version,capacity,homeroom,archived FROM sections WHERE id=$1 AND org_id=$2 AND unit_id=$3",
        [context.sectionId, actor.org_id, context.unitId],
      )
    ).rows[0];
    requireCondition(
      section && !section.archived,
      404,
      "Active class not found in this unit.",
    );
  }
  if (context.kind !== "students") {
    year = (
      await tx.query(
        `SELECT id,name,version,archived,${dateSql} FROM school_years WHERE id=$1 AND org_id=$2 AND unit_id=$3`,
        [
          context.kind === "enrollments" ? context.yearId : section!.year_id,
          actor.org_id,
          context.unitId,
        ],
      )
    ).rows[0];
    requireCondition(
      year && !year.archived,
      404,
      "Active school year not found in this unit.",
    );
  }
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const number = input.studentNumber.trim();
    counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  // Match exact numbers first, then lock identities in a stable order before any class lock.
  const identities = (
    await tx.query(
      "SELECT s.id,s.person_id FROM students s WHERE s.org_id=$1 AND s.unit_id=$2 AND s.student_number=ANY($3::text[]) ORDER BY s.id" +
        (lock ? " FOR UPDATE OF s" : ""),
      [actor.org_id, context.unitId, [...counts.keys()]],
    )
  ).rows;
  if (lock && identities.length)
    await tx.query(
      "SELECT id FROM school_people WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
      [identities.map((s) => s.person_id)],
    );
  const students = (
    await tx.query(
      "SELECT s.id,s.person_id,s.student_number,s.active,s.version,p.name,p.version AS person_version FROM students s JOIN school_people p ON p.id=s.person_id WHERE s.org_id=$1 AND s.unit_id=$2 AND s.student_number=ANY($3::text[])",
      [actor.org_id, context.unitId, [...counts.keys()]],
    )
  ).rows;
  if (lock && context.kind === "roster") {
    section = (
      await tx.query(
        "SELECT id,unit_id,year_id,name,version,capacity,homeroom,archived FROM sections WHERE id=$1 AND org_id=$2 AND unit_id=$3 FOR UPDATE",
        [context.sectionId, actor.org_id, context.unitId],
      )
    ).rows[0];
    requireCondition(
      section && !section.archived,
      409,
      "Class changed. Create a new preview.",
    );
  }
  const rows: ImportRow[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const checked = schoolImportRowSchemas[context.kind].safeParse(inputs[i]);
    const input = (checked.success ? checked.data : inputs[i]) as Record<
      string,
      string
    >;
    const errors = checked.success
      ? []
      : checked.error.issues.map(
          (issue) => (issue.path.join(".") || "row") + ": " + issue.message,
        );
    if ((counts.get(input.studentNumber.trim()) ?? 0) > 1)
      errors.push("Student number appears more than once in this file.");
    const student =
      students.find((s) => s.student_number === input.studentNumber.trim()) ??
      null;
    let before: Row | null = null,
      after: Row | null = null,
      source: Row | null = null;
    if (context.kind === "students") {
      if (student)
        errors.push(
          "This student number already exists. This template only creates new students.",
        );
      if (checked.success)
        after = {
          studentNumber: input.studentNumber,
          name: input.name,
          dateOfBirth: input.dateOfBirth || null,
        };
    } else {
      if (!student?.active)
        errors.push(
          "No active student has this exact number in this unit. Create or reactivate the student first.",
        );
      if (checked.success && student?.active) {
        const enrollment =
          (
            await tx.query(
              `SELECT id,version,grade_level,status,${dateSql} FROM student_enrollments WHERE student_id=$1 AND year_id=$2`,
              [student.id, year!.id],
            )
          ).rows[0] ?? null;
        if (context.kind === "enrollments") {
          source = enrollment;
          before = enrollment
            ? {
                gradeLevel: enrollment.grade_level,
                startsOn: enrollment.starts_on,
                endsOn: enrollment.ends_on,
                status: enrollment.status,
              }
            : null;
          after = {
            gradeLevel: input.gradeLevel,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            status: input.status,
          };
          if (input.startsOn < year!.starts_on || input.endsOn > year!.ends_on)
            errors.push("Dates must fit within the school year.");
        } else {
          const old =
            (
              await tx.query(
                `SELECT version,${dateSql} FROM section_students WHERE section_id=$1 AND student_id=$2`,
                [context.sectionId, student.id],
              )
            ).rows[0] ?? null;
          source = { enrollment, roster: old };
          before = old
            ? { startsOn: old.starts_on, endsOn: old.ends_on }
            : null;
          after = { startsOn: input.startsOn, endsOn: input.endsOn };
        }
      }
    }
    rows.push({
      row: i + 2,
      input,
      student,
      before,
      after,
      source,
      errors,
      action: errors.length
        ? "error"
        : before
          ? canonical(before) === canonical(after)
            ? "unchanged"
            : "update"
          : "create",
    });
  }
  let roster: Row | null = null;
  if (context.kind === "roster") {
    const candidates = rows.filter((row) => !row.errors.length);
    if (candidates.length) {
      const prepared = await prepareRosterBatch(
        tx,
        actor,
        context.sectionId,
        candidates.map((row) => ({
          studentId: row.student!.id,
          startsOn: row.input.startsOn,
          endsOn: row.input.endsOn,
          ...(row.source?.roster ? { version: row.source.roster.version } : {}),
        })),
        lock,
      );
      roster = {
        existing: prepared.existing,
        peak: prepared.peak,
        capacity: prepared.section.capacity,
      };
      prepared.rows.forEach((preparedRow, i) => {
        candidates[i].errors.push(...preparedRow.errors);
        if (candidates[i].errors.length) candidates[i].action = "error";
      });
    }
  }
  return {
    context,
    year,
    section,
    roster,
    rows,
    counts: {
      total: rows.length,
      create: rows.filter((r) => r.action === "create").length,
      update: rows.filter((r) => r.action === "update").length,
      unchanged: rows.filter((r) => r.action === "unchanged").length,
      errors: rows.filter((r) => r.errors.length).length,
    },
  };
}
function present(batch: Row) {
  const {originalSource:_,...plan}=batch.plan;
  return {
    id: batch.id,
    sourceHash: batch.source_hash,
    planHash: batch.plan_hash,
    createdAt: batch.created_at,
    expiresAt: batch.expires_at,
    appliedAt: batch.applied_at,
    receipt: batch.receipt,
    plan,
    hasSource:!!batch.plan.originalSource,
  };
}
function originalSource(batch:Row) {
  const source=batch.plan.originalSource;
  requireCondition(source?.encoding==="base64"&&typeof source.data==="string",404,"Original source text is unavailable for this older preview.");
  const bytes=Buffer.from(source.data,"base64"),csv=bytes.toString("utf8");
  requireCondition(bytes.length===source.bytes&&bytes.equals(Buffer.from(csv,"utf8"))&&digest(csv)===batch.source_hash,409,"Original import source failed its integrity check.");
  return {bytes,csv};
}
export async function previewSchoolImport(
  db: Database,
  actor: Actor,
  raw: unknown,
  sessionHash?: string,
) {
  const proof = importSessionHash(sessionHash);
  const input = previewSchoolImportInput.parse(raw),
    rows = parseSchoolCsv(input.context, input.csv);
  return reportTransaction(db, async (tx) => {
    if(isFamilyImport(input.context) || isPersonImport(input.context)) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const current = await access(tx, actor, input.context.unitId, proof);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),721204)", [
      actor.id,
    ]);
    const recent = (
      await tx.query(
        "SELECT count(*)::integer AS count FROM school_import_batches WHERE org_id=$1 AND actor_id=$2 AND created_at>now()-interval '1 hour'",
        [actor.org_id, actor.id],
      )
    ).rows[0].count;
    requireCondition(
      recent < 60,
      429,
      "You have created 60 previews this hour. Try again later.",
    );
    const plan = {...await buildPlan(tx, current, input.context, rows),originalSource:{encoding:"base64",data:Buffer.from(input.csv,"utf8").toString("base64"),bytes:Buffer.byteLength(input.csv,"utf8")}},
      id = randomUUID(),
      sourceHash = digest(input.csv),
      planHash = digest(canonical(plan));
    const batch = (
      await tx.query(
        "INSERT INTO school_import_batches(id,org_id,unit_id,actor_id,context,source_hash,plan_hash,input_rows,plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          id,
          actor.org_id,
          input.context.unitId,
          actor.id,
          JSON.stringify(input.context),
          sourceHash,
          planHash,
          JSON.stringify(rows),
          JSON.stringify(plan),
        ],
      )
    ).rows[0];
    await audit(tx, current, "school.import.previewed", id, {
      unitId: input.context.unitId,
      kind: input.context.kind,
      sourceHash,
      planHash,
      counts: plan.counts,
    });
    const result = present(batch);
    await recheckReportSession(tx, current, proof);
    return result;
  });
}
export async function applySchoolImport(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
  sessionHash?: string,
) {
  const proof = importSessionHash(sessionHash);
  const input = applySchoolImportInput.parse(raw);
  return reportTransaction(db, async (tx) => {
    await tx.query("SET LOCAL statement_timeout='15s'");
    await tx.query("SET LOCAL lock_timeout='5s'");
    await lockAcademics(tx, actor.org_id);
    const batch = (
      await tx.query(
        "SELECT * FROM school_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3 FOR UPDATE",
        [id, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(
      batch &&
        batch.source_hash === input.sourceHash &&
        batch.plan_hash === input.planHash,
      404,
      "Import preview not found.",
    );
    const current = await access(tx, actor, batch.unit_id, proof);
    if (batch.applied_at) {
      const result = present(batch);
      await recheckReportSession(tx, current, proof);
      return result;
    }
    requireCondition(
      (await tx.query("SELECT id FROM school_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()", [id,current.org_id,current.id])).rows.length,
      409,
      "Preview expired. Create a new preview.",
    );
    requireCondition(
      batch.plan.counts.errors === 0,
      409,
      "Correct every row error and create a new preview.",
    );
    const context = schoolImportContext.parse(batch.context);
    if(batch.plan.originalSource) {
      const source=originalSource(batch);
      requireCondition(canonical(parseSchoolCsv(context,source.csv))===canonical(batch.input_rows),409,"The retained source does not match this preview.");
    }
    const plan = {...await buildPlan(tx, current, context, batch.input_rows, true),...(batch.plan.originalSource?{originalSource:batch.plan.originalSource}:{})};
    requireCondition(
      digest(canonical(plan)) === batch.plan_hash,
      409,
      "School records changed after this preview. Create a new preview before applying.",
    );
    requireCondition(
      plan.counts.errors === 0,
      409,
      "Import no longer passes validation. Create a new preview.",
    );
    const results: Row[] = [];
    const changes: ImportRow[] = plan.rows.filter(
      (row) => row.action === "create" || row.action === "update",
    );
    if(isPersonImport(context)) {
      results.push(...await applyPersonRows(tx,current,context,changes as Parameters<typeof applyPersonRows>[3]));
    } else if(isFamilyImport(context)) {
      results.push(...await applyFamilyRows(tx,current,context,changes as Parameters<typeof applyFamilyRows>[3]));
    } else if (context.kind === "roster" && changes.length) {
      const saved = await saveRosterBatchTransaction(
        tx,
        current,
        context.sectionId,
        changes.map((row) => ({
          studentId: row.student!.id,
          startsOn: row.input.startsOn,
          endsOn: row.input.endsOn,
          ...(row.source?.roster ? { version: row.source.roster.version } : {}),
        })),
      );
      saved.forEach((row, i) =>
        results.push({
          row: changes[i].row,
          studentId: row.student_id,
          sectionId: row.section_id,
          version: row.version,
        }),
      );
    } else
      for (const row of changes) {
        if (context.kind === "students") {
          const created = await createStudentTransaction(
            tx,
            current,
            studentInput.parse({ unitId: context.unitId, ...row.after }),
          );
          results.push({
            row: row.row,
            studentId: created.id,
            version: created.version,
          });
        } else if (context.kind === "enrollments") {
          const saved = await saveEnrollmentTransaction(
            tx,
            current,
            row.student!.id,
            enrollmentInput.parse({ yearId: context.yearId, ...row.after }),
            row.source?.version,
          );
          results.push({
            row: row.row,
            studentId: row.student!.id,
            enrollmentId: saved.id,
            version: saved.version,
          });
        }
      }
    const receipt = { counts: plan.counts, records: results };
    const applied = (
      await tx.query(
        "UPDATE school_import_batches SET applied_at=clock_timestamp(),receipt=$2 WHERE id=$1 RETURNING *",
        [id, JSON.stringify(receipt)],
      )
    ).rows[0];
    await audit(tx, current, "school.import.applied", id, {
      unitId: context.unitId,
      kind: context.kind,
      sourceHash: batch.source_hash,
      planHash: batch.plan_hash,
      counts: plan.counts,
    });
    const result = present(applied);
    JSON.stringify(result);
    await recheckReportSession(tx, current, proof);
    // Check the held batch using the database clock after all intended writes
    // and the real audit. Expiry rolls the whole transaction back. Authorized
    // already-applied receipt replay returns above and is not time-limited.
    requireCondition((await tx.query("SELECT id FROM school_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()", [id,current.org_id,current.id])).rows.length,
      409,"Preview expired before the import finished. Create a new preview.");
    return result;
  }).catch(error => {
    // Person imports acquire the complete target set NOWAIT before any writes.
    // Map outside the aborted transaction; never continue with partial locks.
    if (["55P03", "57014", "40001", "40P01"].includes((error as { code?: string }).code ?? "")) throw new Problem(503,"These records are busy. Retry the same reviewed batch.");
    throw error;
  });
}
export function installSchoolImports(app: Express, db: Database) {
  app.get("/api/school/imports/template/:kind", async (req, res) => {
    const kind = z
        .enum(schoolImportKinds)
        .parse(req.params.kind),
      unitId = z.uuid().parse(req.query.unitId);
    const populated=z.enum(["true","false"]).default("false").parse(req.query.populated)==="true";
    const proof=requestProof(req);
    const csv=await reportTransaction(db,async tx=>{
      const actor=await access(tx,schoolActor(req),unitId,proof);
      let rows: Row[]=[];
      if(populated) {
        requireCondition(["households","household_members","contacts","people"].includes(kind),400,"Current-record templates are available for family and person-profile imports only.");
        const context=schoolImportContext.parse({kind,unitId});
        if(isPersonImport(context)) rows=await personTemplateRows(tx,actor,context);
        else {
          requireCondition(isFamilyImport(context),400,"Choose a family or person-profile template.");
          rows=await familyTemplateRows(tx,actor,context);
        }
      }
      const result=toCsv(rows,schoolImportCatalog[kind].columns);
      await recheckReportSession(tx,actor,proof);
      return result;
    });
    res
      .set("Cache-Control","private, no-store").type("text/csv")
      .attachment("stjw-" + kind + "-template.csv")
      .send(csv);
  });
  app.get("/api/school/imports/identities/export",async(req,res)=>{
    const unitId=z.uuid().parse(req.query.unitId);
    const proof=requestProof(req);
    const csv=await reportTransaction(db,async tx=>{
      const actor=await access(tx,schoolActor(req),unitId,proof);
      const rows=await familyIdentityRows(tx,actor,unitId);
      await audit(tx,actor,"school.import.identities_exported",null,{unitId,rowCount:rows.length});
      const result=toCsv(rows,["recordType","id","studentNumber","name","version","personId","personVersion","studentActive","householdArchived"]);
      await recheckReportSession(tx,actor,proof);
      return result;
    });
    res.set("Cache-Control","private, no-store").type("text/csv").attachment("stjw-family-identities.csv").send(csv);
  });
  app.post("/api/school/imports/preview", async (req, res) =>
    res
      .set("Cache-Control","private, no-store")
      .status(201)
      .json(await previewSchoolImport(db, schoolActor(req), req.body, requestProof(req))),
  );
  app.get("/api/school/imports", async (req, res) => {
    const actor = schoolActor(req),
      unitId = z.uuid().parse(req.query.unitId);
    const proof=requestProof(req);
    const batches=await reportTransaction(db,async tx=>{
      const current=await access(tx,actor,unitId,proof);
      const rows = (await tx.query(
        "SELECT id,context,created_at,expires_at,applied_at,plan->'counts' AS counts FROM school_import_batches WHERE org_id=$1 AND actor_id=$2 AND unit_id=$3 ORDER BY created_at DESC LIMIT 50",
        [actor.org_id, actor.id, unitId],
      )
      ).rows;
      await recheckReportSession(tx,current,proof);
      return rows;
    });
    res.set("Cache-Control","private, no-store").json({ batches });
  });
  app.get("/api/school/imports/:id", async (req, res) => {
    const actor = schoolActor(req),
      id = z.uuid().parse(req.params.id);
    const proof=requestProof(req);
    const result=await reportTransaction(db,async tx=>{
      const batch = (await tx.query(
        "SELECT * FROM school_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3",
        [id, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(batch, 404, "Import preview not found.");
      const current=await access(tx,actor,batch.unit_id,proof);
      const result=present(batch);
      await recheckReportSession(tx,current,proof);
      return result;
    });
    res.set("Cache-Control","private, no-store").json(result);
  });
  app.get("/api/school/imports/:id/source",async(req,res)=>{
    const id=z.uuid().parse(req.params.id),who=schoolActor(req);
    const proof=requestProof(req);
    const source=await reportTransaction(db,async tx=>{
      const batch=(await tx.query("SELECT * FROM school_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3",[id,who.org_id,who.id])).rows[0];
      requireCondition(batch,404,"Import preview not found.");
      const actor=await access(tx,who,batch.unit_id,proof);
      const source=originalSource(batch);
      await audit(tx,actor,"school.import.source_exported",id,{unitId:batch.unit_id,sourceHash:batch.source_hash,bytes:source.bytes.length});
      await recheckReportSession(tx,actor,proof);
      return source.bytes;
    });
    res.set("Cache-Control","private, no-store").type("text/plain").attachment("stjw-school-import-"+id+"-source.txt").send(source);
  });
  app.post("/api/school/imports/:id/apply", async (req, res) =>
    res.set("Cache-Control","private, no-store").json(
      await applySchoolImport(
        db,
        schoolActor(req),
        z.uuid().parse(req.params.id),
        req.body,
        requestProof(req),
      ),
    ),
  );
}
