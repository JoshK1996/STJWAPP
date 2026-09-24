import { readableReportCsv, reportFilename } from "../shared/report-presentation";
import { financeTransaction } from "./finance-access";
import { reportLayoutTransaction } from "./report-layout-access";
import { lockLayoutSchoolSource } from "./report-layout-source-access";
import {
  attendanceReportAccess,
  runAttendanceReport,
  attendanceReportSource,
} from "./attendance-reports";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { reportTransaction, currentReportActor, recheckReportSession, authorizeReportManifest, buildReportManifest, lockReportExtraction } from "./report-source-access";
import {
  audit,
  assertUnit,
  digest,
  orgWide,
  requireCondition,
  type Actor,
} from "./security";
import { schoolActor, officeUnits, assertOffice, sectionById } from "./school";
import { careProgram, careTimesheet, careTimesheetSource } from "./care";
import { detail as gradebookDetail, gradebookReportSource } from "./grading";
import { getReport, toCsv } from "./reports";
import { readWorkforceReportSourceV2 } from "./reports-v2";
import { workforceMicrosecondsSchema } from "../shared/workforce-reports-v2";
import {
  reportDefinition,
  saveReportInput,
  outputColumns,
  sourceCatalog,
  workforceV2Catalog,
  type ReportDefinition,
} from "../shared/report-library";
import { careReportInput } from "../shared/care";
import { financialReportSource, financialReportOptions } from "./finance";
import { compensationReportAccess, compensationReportSource } from "./compensation";
import { amountUnits, amountText, reportAmountUnits } from "./finance-engine";

function password(actor: Actor) {
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to use saved reports.",
  );
}
export function resolveReportRange(
  def: Extract<ReportDefinition, { range: unknown }>,
  zone: string,
  now = new Date(),
) {
  const current = DateTime.fromJSDate(now, { zone });
  if (def.range.preset === "custom")
    return { from: def.range.from, to: def.range.to };
  const preset = def.range.preset;
  const anchor =
    preset === "last_month" ? current.minus({ months: 1 }) : current;
  const period =
    preset === "this_week"
      ? "week"
      : preset === "this_year"
        ? "year"
        : preset === "today"
          ? "day"
          : "month";
  return {
    from: anchor.startOf(period).toISODate()!,
    to: (preset === "last_month"
      ? anchor.endOf("month")
      : current
    ).toISODate()!,
  };
}
async function sourceAccess(
  tx: Queryable,
  actor: Actor,
  def: ReportDefinition,
) {
  password(actor);
  if (def.source === "compensation") {
    await compensationReportAccess(tx, actor, def.unitId);
    return;
  }
  if (def.source === "finance") {
    const source = await financialReportSource(
      tx,
      actor,
      def.financialReportId,
      def.financialVersion,
    );
    requireCondition(
      source.unit_id === def.unitId,
      404,
      "Financial report not found in this community.",
    );
    return;
  }
  if (def.source === "workforce") {
    if (def.unitId) assertUnit(actor, def.unitId);
    return;
  }
  if (def.source === "care") {
    const program = await careProgram(tx, actor, def.programId);
    await assertOffice(tx, actor, program.unit_id);
    return;
  }
  if (def.source === "attendance") {
    await attendanceReportAccess(tx, actor, {
      unitId: def.unitId,
      yearId: def.yearId,
      sectionIds: def.sectionIds,
    });
    return;
  }
  const book = (
    await tx.query(
      "SELECT section_id FROM gradebooks WHERE id=$1 AND org_id=$2",
      [def.bookId, actor.org_id],
    )
  ).rows[0];
  requireCondition(book, 404, "Gradebook not found.");
  await sectionById(tx, actor, book.section_id);
}
export async function saveReport(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  password(supplied);
  const input = saveReportInput.parse(raw),
    fingerprint = digest(JSON.stringify(input));
  return reportLayoutTransaction(db, supplied, sessionHash, true, async (tx, actor) => {
    const existing = (
      await tx.query(
        "SELECT * FROM saved_reports WHERE id=$1 AND org_id=$2 AND user_id=$3 FOR UPDATE",
        [input.id, actor.org_id, actor.id],
      )
    ).rows[0];
    if (!input.archived) {
      const definition = input.definition;
      if (definition.source === "care" || definition.source === "grades" || definition.source === "attendance")
        await lockLayoutSchoolSource(tx, actor, definition);
      else await sourceAccess(tx, actor, definition);
    }
    if (existing && existing.version > input.version) {
      const committed = (
        await tx.query(
          "SELECT fingerprint FROM saved_report_history WHERE report_id=$1 AND version=$2",
          [input.id, input.version + 1],
        )
      ).rows[0];
      requireCondition(
        committed?.fingerprint === fingerprint,
        409,
        "This report changed. Reload before saving.",
      );
      return existing;
    }
    requireCondition(
      existing ? existing.version === input.version : input.version === 0,
      409,
      "This report changed or is unavailable. Reload before saving.",
    );
    if (!existing) {
      requireCondition(
        !input.archived,
        400,
        "Create a report before archiving it.",
      );
      const count = (
        await tx.query(
          "SELECT count(*)::integer AS n FROM saved_reports WHERE org_id=$1 AND user_id=$2",
          [actor.org_id, actor.id],
        )
      ).rows[0].n;
      requireCondition(
        count < 500,
        400,
        "This account has reached 500 retained reports. Reuse an existing definition.",
      );
    }
    const row = (
      await tx.query(
        existing
          ? "UPDATE saved_reports SET name=$4,description=$5,definition=$6,archived=$7,version=version+1,updated_at=now() WHERE id=$1 AND org_id=$2 AND user_id=$3 RETURNING *"
          : "INSERT INTO saved_reports(id,org_id,user_id,name,description,definition,archived) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *",
        [
          input.id,
          actor.org_id,
          actor.id,
          input.name,
          input.description,
          JSON.stringify(input.definition),
          input.archived,
        ],
      )
    ).rows[0];
    requireCondition(
      row,
      409,
      "This report identifier is unavailable. Start a new report.",
    );
    await tx.query(
      "INSERT INTO saved_report_history(id,org_id,user_id,report_id,version,snapshot,reason,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        actor.org_id,
        actor.id,
        row.id,
        row.version,
        JSON.stringify(row),
        input.reason,
        fingerprint,
      ],
    );
    await audit(tx, actor, "report_library.saved", row.id, {
      version: row.version,
      source: input.definition.source,
      archived: input.archived,
    });
    return row;
  });
}
async function ownReport(tx: Queryable, actor: Actor, id: string) {
  password(actor);
  const row = (
    await tx.query(
      "SELECT * FROM saved_reports WHERE id=$1 AND org_id=$2 AND user_id=$3",
      [id, actor.org_id, actor.id],
    )
  ).rows[0];
  requireCondition(row, 404, "Saved report not found.");
  return row;
}
function groupIdentity(def: ReportDefinition, row: Row): [string, string] {
  if (def.source === "compensation") {
    if(def.groupBy === "employee") return [row.user_id,row.employee_name];
    if(def.groupBy === "unit") return [row.unit_id,row.unit_name];
    if(def.groupBy === "job") return [row.job_id,row.job_title];
    return [row[def.groupBy],row[def.groupBy]];
  }
  if (def.source === "finance")
    return def.groupBy === "line"
      ? [row.line_code, row.line_label]
      : [row.group, row.group || "No source group"];
  if (def.source === "workforce") {
    if (def.groupBy === "employee") return [row.user_id, row.employee_name];
    if (def.groupBy === "unit") return [row.unit_id, row.unit_name];
    if (def.groupBy === "job") return [row.job_id, row.job_title];
    return [row.kind, row.kind === "work" ? "Work" : "Break"];
  }
  if (def.source === "care")
    return def.groupBy === "student"
      ? [row.student_id, row.student_name]
      : [
          row.status,
          row.status === "open" ? "Still in care" : "Closed session",
        ];
  if (def.source === "attendance") {
    if (def.groupBy === "student") return [row.student_id, row.student_name];
    if (def.groupBy === "class") return [row.section_id, row.class_name];
    if (def.groupBy === "date") return [row.date, row.date];
    return [row.category, row.category ?? "No recorded category"];
  }
  if (def.groupBy === "grade")
    return [JSON.stringify(row.grade), row.grade ?? "No grade"];
  const status = row.incomplete
    ? "incomplete"
    : row.provisional
      ? "provisional"
      : row.percentage === null
        ? "no_grade"
        : "complete";
  return [
    status,
    {
      incomplete: "Incomplete",
      provisional: "Provisional",
      no_grade: "No grade",
      complete: "Complete",
    }[status],
  ];
}
export function shapeReportRows(def: ReportDefinition, sourceRows: Row[]) {
  let rows = sourceRows;
  const precise = def.source === "workforce" && "precisionVersion" in def && def.precisionVersion === 2;
  if (def.layout === "summary") {
    const groups = new Map<string, Row>();
    for (const row of rows) {
      const [id, name] = groupIdentity(def, row),
        group = groups.get(id) ?? {
          group_id: id,
          group_name: name,
          record_count: 0,
          ...(precise || ["grades", "attendance", "finance", "compensation"].includes(def.source)
            ? {}
            : { duration_ms: 0 }),
          ...(precise ? {duration_microseconds:"0",work_microseconds:"0",break_microseconds:"0"} : def.source === "workforce" ? { work_ms: 0, break_ms: 0 } : {}),
          ...(def.source === "finance"
            ? { amount: "0", currency: row.currency }
            : {}),
        };
      group.record_count++;
      if (def.source === "finance") {
        requireCondition(
          row.row_kind === "detail" && row.currency === group.currency,
          400,
          "Financial summaries require detail lines in one currency.",
        );
        group.amount = amountText(
          reportAmountUnits(group.amount) + amountUnits(row.amount),
        );
      }
      if (precise) {
        const duration = BigInt(workforceMicrosecondsSchema.parse(row.duration_microseconds));
        group.duration_microseconds = workforceMicrosecondsSchema.parse((BigInt(group.duration_microseconds) + duration).toString());
        const field = row.kind === "work" ? "work_microseconds" : "break_microseconds";
        group[field] = workforceMicrosecondsSchema.parse((BigInt(group[field]) + duration).toString());
      } else if (!["grades", "attendance", "finance", "compensation"].includes(def.source)) {
        group.duration_ms += row.duration_ms;
        requireCondition(
          Number.isSafeInteger(group.duration_ms),
          400,
          "Duration exceeds the exact reporting range.",
        );
      }
      if (def.source === "workforce" && !precise)
        group[row.kind === "work" ? "work_ms" : "break_ms"] += row.duration_ms;
      groups.set(id, group);
    }
    rows = [...groups.values()];
  }
  const columns = outputColumns(def),
    key = def.sort.key,
    collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  rows = [...rows].sort((a, b) => {
    const x = a[key],
      y = b[key];
    let n = 0;
    if (x == null || y == null) n = x == null ? (y == null ? 0 : 1) : -1;
    else if (precise && ["duration_microseconds","recorded_duration_microseconds","work_microseconds","break_microseconds"].includes(key)) {
      const a = BigInt(workforceMicrosecondsSchema.parse(x)), b = BigInt(workforceMicrosecondsSchema.parse(y));
      n = a < b ? -1 : a > b ? 1 : 0;
    } else if (["finance", "compensation"].includes(def.source) && key === "amount") {
      const a = reportAmountUnits(x),
        b = reportAmountUnits(y);
      n = a < b ? -1 : a > b ? 1 : 0;
    } else if (key === "percentage") n = Number(x) - Number(y);
    else if (typeof x === "number" && typeof y === "number") n = x - y;
    else n = collator.compare(String(x), String(y));
    return def.sort.direction === "desc" ? -n : n;
  });
  return {
    columns,
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])),
    ),
  };
}
export async function loadReportSource(
  tx: Queryable, actor: Actor, raw: unknown, now: Date,
  metadata: { id?: string; version?: number; exporting?: boolean; auditSources?: boolean } = {},
) {
  password(actor);
  const def = reportDefinition.parse(raw);
  await sourceAccess(tx, actor, def);
  const zone = (
      await tx.query("SELECT timezone FROM organizations WHERE id=$1", [
        actor.org_id,
      ])
    ).rows[0].timezone;
  let rows: Row[],
    asOf = now.toISOString(),
    range: { from: string; to: string } | null = null,
    notice: string,
    provenance: Row = {}, context: Row = {};
  let sourceAudit: { action: string; entity: string; data: Row } | undefined;
  if (def.source === "compensation") {
    range = resolveReportRange(def,zone,now);
    const data = await compensationReportSource(tx,actor,{...range!,unitId:def.unitId,includeVoided:def.includeVoided},now);
    rows=data.rows;asOf=data.asOf;
    notice="Rate entries whose inclusive effective dates overlap this range, using each pay record’s current reviewed version. Inactive or unassigned records are retained; directory labels and assignment flags describe the current state. Missing rates are not zero pay. Summaries count rate entries, not employees or earnings. Amounts are never summed across rates. This report does not calculate payroll.";
    provenance={sourceHash:data.sourceHash,recordCount:data.recordCount,includeVoided:def.includeVoided,versionSelection:"current reviewed pay records"};
  } else if (def.source === "workforce") {
    range = resolveReportRange(def, zone, now);
    if ("precisionVersion" in def && def.precisionVersion === 2) {
      const data = await readWorkforceReportSourceV2(tx, actor, {start:range.from,end:range.to,group:"day",...(def.unitId?{unitId:def.unitId}:{})});
      rows = data.rows; asOf = data.asOf; notice = data.notice;
      provenance = {sourceSchemaVersion:2,precisionVersion:2,durationUnit:"microsecond",asOf:data.asOf,range:data.range,
        workMicroseconds:data.workMicroseconds,breakMicroseconds:data.breakMicroseconds,sourceRowCount:data.sourceRowCount,contributingRowCount:data.contributingRowCount};
    } else {
    const data = await getReport(
      tx,
      actor,
      { start: range.from, end: range.to, group: "day", unitId: def.unitId },
      now,
    );
    rows = data.rows.map((row) => ({
      ...row,
      started_at: new Date(row.started_at).toISOString(),
      ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    }));
    notice = data.notice;
    }
  } else if (def.source === "care") {
    range = resolveReportRange(def, zone, now);
    const data = await careTimesheetSource(
      tx,
      actor,
      careReportInput.parse({ programId: def.programId, ...range }),
      { exporting: metadata.exporting, auditRead: metadata.auditSources, now },
    );
    context = { programId: data.program.id, unitId: data.program.unit_id };
    sourceAudit = { action: metadata.exporting ? "school.care.timesheets_exported" : "school.care.timesheets_viewed", entity: data.program.id,
      data: { unitId: data.program.unit_id, from: range.from, to: range.to, studentId: null, rows: data.rows.length, asOf: data.asOf } };
    rows = data.rows.map((row) => ({
      ...row,
      duration_ms: row.milliseconds_in_range,
    }));
    asOf = data.asOf;
    notice =
      "Recorded childcare attendance only. These durations do not calculate fees or staffing ratios.";
    provenance = {
      programId: data.program.id,
      programVersion: data.program.version,
    };
  } else if (def.source === "attendance") {
    range = resolveReportRange(def, zone, now);
    const data = await attendanceReportSource(
      tx,
      actor,
      {
        unitId: def.unitId,
        yearId: def.yearId,
        period: def.period,
        sectionIds: def.sectionIds,
        studentNumber: def.studentNumber,
        ...range,
        recordedOnly: true,
        includeNotes: def.columns.includes("note"),
      },
      metadata.exporting,
      now, metadata.auditSources,
    );
    context = data.snapshotScope;
    sourceAudit = { action: metadata.exporting ? "attendance.report_exported" : "attendance.report_ran", entity: def.yearId,
      data: { unitId: def.unitId, from: data.range.from, to: data.range.to, period: def.period, rows: data.rows.length, coverage: data.coverage.length, sourceHash: data.sourceHash } };
    rows = data.rows;
    range = data.range;
    asOf = data.asOf;
    notice = data.notice;
    provenance = {
      ...data.provenance,
      sourceHash: data.sourceHash,
      policyConfirmed: data.policyConfirmed,
    };
  } else if (def.source === "finance") {
    const data = await financialReportSource(tx, actor, def.financialReportId, def.financialVersion);
    context = { unitId: data.unit_id, reportId: data.report_id, version: data.version };
    rows = data.lines
      .filter(
        (line: Row) => def.rowKinds === "all" || line.rowKind === "detail",
      )
      .map((line: Row) => ({
        line_code: line.lineCode,
        line_label: line.lineLabel,
        group: line.group,
        row_kind: line.rowKind,
        amount: line.amount,
        currency: data.metadata.currency,
        report_title: data.metadata.title,
        report_version: data.version,
        period_from: data.metadata.from,
        period_through: data.metadata.to,
        note: line.note,
      }));
    range = { from: data.metadata.from, to: data.metadata.to };
    notice =
      "This report stays on the selected published version. Detail sums exclude imported subtotals and totals; they do not infer profit, account balances or currency conversion.";
    provenance = {
      financialReportId: data.report_id,
      financialVersion: data.version,
      sourceHash: data.source_hash,
      fingerprint: data.fingerprint,
      unitId: data.unit_id,
      sourceName: data.metadata.sourceName,
      title: data.metadata.title,
      currency: data.metadata.currency,
      basis: data.metadata.basis,
      kind: data.metadata.kind,
      sourcePublishedAt: new Date(data.created_at).toISOString(),
      sourceArchived: data.archived,
      rowKinds: def.rowKinds,
      importedLineCount: data.lines.length,
    };
  } else {
    const data = await gradebookReportSource(tx, actor, def.bookId);
    context = { bookId: data.book.id, unitId: data.book.unit_id, sectionId: data.book.section_id, termId: data.book.term_id, bookVersion: data.book.version, sourceHash: digest(JSON.stringify({ book: data.book, assignments: data.assignments, scores: data.scores })) };
    rows = data.results.map((row: Row) => ({
      student_id: row.student_id,
      student_number: row.student_number,
      student_name: row.name,
      class_name: data.section.name,
      term: data.term.name,
      percentage: row.percentage,
      grade: row.label,
      pending: row.pending,
      missing: row.missing,
      incomplete: row.incomplete,
      provisional: row.provisional,
      book_status: data.book.status,
      book_version: data.book.version,
      policy_version: data.book.policy_version,
      roster_current: data.rosterCurrent,
      book_id: data.book.id,
    }));
    notice =
      "Current class and term results. Provisional scores and changed rosters require review; this is not a cumulative report card.";
    provenance = {
      bookId: data.book.id,
      bookVersion: data.book.version,
      bookStatus: data.book.status,
      policyVersion: data.book.policy_version,
      rosterCurrent: data.rosterCurrent,
    };
  }
  const shaped = shapeReportRows(def, rows);
  return { rows, context, sourceAudit, report: {
    ...shaped,
    source: def.source,
    sourceRowCount: rows.length,
    rowCount: shaped.rows.length,
    asOf,
    timezone: zone,
    range,
    notice,
    provenance,
    ...(def.source === "workforce" && "precisionVersion" in def && def.precisionVersion === 2 ? {precisionVersion:2 as const,durationUnit:"microsecond" as const} : {}),
    definition: def,
    reportId: metadata.id ?? null,
    reportVersion: metadata.version ?? null,
  } };
}
/** Internal callers may omit sessionHash; HTTP callers must supply the verified password session hash. */
export async function runReport(db: Database, actor: Actor, raw: unknown, metadata: { id?: string; version?: number; exporting?: boolean; sessionHash?: string } = {}) {
  password(actor);
  const copy = await reportTransaction(db, async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await lockReportExtraction(tx, actor);
    const fresh = await currentReportActor(tx, actor, metadata.sessionHash);
    const data = await loadReportSource(tx, fresh, raw, new Date(), { ...metadata, auditSources: false });
    return { data, access: await buildReportManifest(tx, fresh, data.report.definition, data) };
  });
  return reportTransaction(db, async tx => {
    const fresh = await currentReportActor(tx, actor, metadata.sessionHash);
    await authorizeReportManifest(tx, fresh, copy.access);
    if (metadata.id) {
      const saved = await ownReport(tx, fresh, metadata.id);
      requireCondition(!saved.archived && saved.version === metadata.version, 409, "This report changed. Reload before running or exporting it.");
    }
    if (copy.data.sourceAudit) await audit(tx, fresh, copy.data.sourceAudit.action, copy.data.sourceAudit.entity, copy.data.sourceAudit.data);
    await audit(tx, fresh, metadata.exporting ? "report_library.exported" : "report_library.ran", metadata.id ?? null, {
      source: copy.data.report.source, version: metadata.version ?? null, rowCount: copy.data.report.rowCount, sourceRowCount: copy.data.report.sourceRowCount, asOf: copy.data.report.asOf,
    });
    if (metadata.sessionHash) await recheckReportSession(tx, fresh, metadata.sessionHash);
    return copy.data.report;
  });
}
export function installReportLibrary(app: Express, db: Database) {
  app.get("/api/report-library/finance-options", async (req, res) => {
    const actor = schoolActor(req),
      query = z.object({ unitId: z.uuid() }).strict().parse(req.query);
    res.json({
      rows: await financeTransaction(db, actor, (req as AppRequest).sessionHash, (tx, current) =>
        financialReportOptions(tx, current, query.unitId),
      ),
    });
  });
  app.get("/api/report-library/options", async (req, res) => {
    const actor = schoolActor(req),
      offices = await officeUnits(db, actor);
    const programs = (
      await db.query(
        "SELECT id,name,unit_id,archived FROM care_programs WHERE org_id=$1 AND unit_id=ANY($2::uuid[]) ORDER BY archived,name,id",
        [actor.org_id, offices],
      )
    ).rows;
    const books = (
      await db.query(
        `SELECT b.id,s.name AS class_name,t.name AS term_name,b.status,b.version FROM gradebooks b JOIN sections s ON s.id=b.section_id JOIN school_terms t ON t.id=b.term_id WHERE b.org_id=$1 AND (b.unit_id=ANY($2::uuid[]) OR (b.unit_id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM section_teachers a WHERE a.section_id=b.section_id AND a.org_id=$1 AND a.user_id=$4))) ORDER BY s.name,t.starts_on,b.id LIMIT 1001`,
        [actor.org_id, offices, actor.unit_ids, actor.id],
      )
    ).rows;
    requireCondition(
      books.length <= 1000,
      400,
      "More than 1,000 class gradebooks are available. A narrower catalog is required.",
    );
    const units = (
      await db.query(
        "SELECT id,name FROM units WHERE org_id=$1 AND ($2::boolean OR id=ANY($3::uuid[])) ORDER BY name",
        [actor.org_id, orgWide(actor), actor.unit_ids],
      )
    ).rows;
    const attendanceYears = (
      await db.query(
        `SELECT y.id,y.name,y.unit_id,u.name AS unit_name,to_char(y.starts_on,'YYYY-MM-DD') AS starts_on,to_char(y.ends_on,'YYYY-MM-DD') AS ends_on,COALESCE(a.periods,'[]'::jsonb) AS configured_periods FROM school_years y JOIN units u ON u.id=y.unit_id LEFT JOIN attendance_settings a ON a.unit_id=y.unit_id WHERE y.org_id=$1 AND (y.unit_id=ANY($2::uuid[]) OR (y.unit_id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM sections s JOIN section_teachers t ON t.section_id=s.id WHERE s.year_id=y.id AND t.user_id=$4))) ORDER BY y.starts_on DESC,y.name LIMIT 1001`,
        [actor.org_id, offices, actor.unit_ids, actor.id],
      )
    ).rows;
    requireCondition(
      attendanceYears.length <= 1000,
      400,
      "A narrower school-year catalog is required.",
    );
    res.json({
      sources: sourceCatalog,
      workforceV2: workforceV2Catalog,
      programs,
      books,
      units,
      attendanceYears,
    });
  });
  app.get("/api/report-library", async (req, res) => {
    res.json(await reportLayoutTransaction(db, schoolActor(req), (req as AppRequest).sessionHash, false, async (tx, actor) => ({
      rows: (
        await tx.query(
          "SELECT * FROM saved_reports WHERE org_id=$1 AND user_id=$2 ORDER BY archived,updated_at DESC,id",
          [actor.org_id, actor.id],
        )
      ).rows,
    })));
  });
  app.post("/api/report-library", async (req, res) =>
    res.json(await saveReport(db, schoolActor(req), (req as AppRequest).sessionHash, req.body)),
  );
  app.post("/api/report-library/preview", async (req, res) =>
    res.json(await runReport(db, schoolActor(req), req.body, { sessionHash: (req as AppRequest).sessionHash })),
  );
  app.get("/api/report-library/:id/history", async (req, res) => {
    const actor = schoolActor(req), sessionHash = (req as unknown as AppRequest).sessionHash, id = z.uuid().parse(req.params.id);
    res.json(await reportLayoutTransaction(db, actor, sessionHash, false, async (tx, actor) => {
      const row = await ownReport(tx, actor, id);
      return {
      rows: (
        await tx.query(
          "SELECT version,snapshot,reason,created_at FROM saved_report_history WHERE report_id=$1 ORDER BY version DESC LIMIT 100",
          [row.id],
        )
      ).rows,
      };
    }));
  });
  for (const action of ["run", "export"])
    app.get("/api/report-library/:id/" + action, async (req, res) => {
      const actor = schoolActor(req),
        row = await reportLayoutTransaction(db, actor, (req as AppRequest).sessionHash, false,
          (tx, current) => ownReport(tx, current, z.uuid().parse(req.params.id)));
      const query = z
        .object({
          version: z.coerce.number().int().positive(),
          format: z.enum(["csv", "json"]).default("csv"),
          presentation: z.enum(["exact", "readable"]).default("exact"),
          decimals: z.coerce.number().pipe(z.union([z.literal(2), z.literal(4)])).default(2),
          includeTechnical: z.enum(["true", "false"]).default("false"),
        })
        .strict()
        .parse(req.query);
      requireCondition(
        !row.archived,
        409,
        "Restore this report before running it.",
      );
      requireCondition(
        row.version === query.version,
        409,
        "This report changed. Reload before running or exporting it.",
      );
      const data = await runReport(db, actor, row.definition, {
        id: row.id,
        version: row.version,
        exporting: action === "export",
        sessionHash: (req as AppRequest).sessionHash,
      });
      if (action === "run") return res.json({ ...data, name: row.name });
      if (query.format === "json")
        return res
          .type("application/json")
          .attachment("stjw-saved-report.json")
          .send(JSON.stringify({ ...data, name: row.name }, null, 2));
      if (query.presentation === "readable") return res.type("text/csv").attachment(reportFilename(row.name, "csv")).send(readableReportCsv(data, { decimals: query.decimals, includeTechnical: query.includeTechnical === "true" }));
      const metadata = {
        report_id: row.id,
        report_version: row.version,
        report_source: data.source,
        report_as_of: data.asOf,
        report_timezone: data.timezone,
        report_from: data.range?.from ?? "",
        report_through: data.range?.to ?? "",
        report_source_versions: JSON.stringify(data.provenance),
      };
      res
        .type("text/csv")
        .attachment("stjw-saved-report.csv")
        .send(
          toCsv(
            data.rows.map((r) => ({ ...r, ...metadata })),
            [...data.columns.map((c) => c.key), ...Object.keys(metadata)],
          ),
        );
    });
}
