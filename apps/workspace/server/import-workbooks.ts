import type { Express, Request, Response } from "express";
import type { Database, Queryable } from "./db";
import type { AppRequest } from "./auth";
import { audit, Problem, requireCondition, type Actor } from "./security";
import { currentFinanceActor } from "./finance-access";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { gradeImportWorkbookContext } from "./grade-imports";
import { currentStaffImportActor } from "./imports";
import { compensationImportWorkbookContext } from "./compensation";
import { withSpreadsheetSlot } from "./spreadsheet-admission";
import { assertWorkbookNotAborted, ImportWorkbookProblem, runImportWorkbook, type WorkbookTask, type WorkbookTemplate } from "./import-workbook-runtime";
import { workbookConvertInput, workbookConvertResultSchemaFor, workbookInspectInput, workbookInspectResultSchema, workbookLimits, workbookTemplateInput,
  type WorkbookConvertResult, type WorkbookTemplateInput } from "../shared/import-workbooks";

type GradeContext = Awaited<ReturnType<typeof gradeImportWorkbookContext>>;
type CompensationContext = Awaited<ReturnType<typeof compensationImportWorkbookContext>>;
async function currentWorkbookActor(tx: Queryable, supplied: Actor, sessionHash: string | undefined, scope: Exclude<WorkbookTemplateInput, { kind: "grade_scores" | "compensation_rates" }>) {
  if (scope.kind === "finance") return currentFinanceActor(tx, supplied, sessionHash);
  if (scope.kind === "staff") return currentStaffImportActor(tx, supplied, sessionHash);
  requireCondition(typeof sessionHash === "string" && /^[a-f0-9]{64}$/.test(sessionHash), 401, "A verified password session is required.");
  // No academic/domain parents are acquired here. Account/session/memberships
  // precede the terminal office-grant lock, matching current grant revocation.
  const actor = await currentReportActor(tx, supplied, sessionHash);
  requireCondition((await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=$2", [actor.org_id, scope.unitId])).rows.length, 404, "School unit not found.");
  if (!["developer", "owner", "admin"].includes(actor.role)) {
    requireCondition(actor.unit_ids.includes(scope.unitId), 403, "School office access is required for this unit.");
    requireCondition((await tx.query("SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE",
      [actor.org_id, actor.id, scope.unitId])).rows.length, 403, "School office access is required for this unit.");
  }
  return actor;
}
async function authorized<T>(db: Database, supplied: Actor, sessionHash: string | undefined, scope: WorkbookTemplateInput, signal: AbortSignal | undefined, action: (tx: Queryable, actor: Actor, grade?: GradeContext, compensation?: CompensationContext) => Promise<T>) {
  try {
    return await db.transaction(async tx => {
      assertWorkbookNotAborted(signal);
      // Grade authority owns academic-first locking. Never acquire the generic
      // account/session locks before entering that domain's source helper.
      let actor: Actor, grade: GradeContext | undefined, compensation: CompensationContext | undefined;
      if (scope.kind === "grade_scores") { grade = await gradeImportWorkbookContext(tx, supplied, sessionHash, scope.assignmentId); actor = grade.actor; }
      else if (scope.kind === "compensation_rates") {
        // Compensation's pair mutex must precede its sorted actor/target account
        // locks. Do not enter the generic actor-only path first.
        await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
        compensation = await compensationImportWorkbookContext(tx, supplied, sessionHash, { userId: scope.userId, jobId: scope.jobId }); actor = compensation.actor;
      }
      else actor = await currentWorkbookActor(tx, supplied, sessionHash, scope);
      const result = await action(tx, actor, grade, compensation);
      await recheckReportSession(tx, actor, sessionHash!); assertWorkbookNotAborted(signal);
      return result;
    });
  } catch (error) {
    if (["55P03", "57014", "40001", "40P01"].includes((error as { code?: string }).code ?? ""))
      throw new Problem(503, "Workbook access is busy. Try the same request again.");
    throw error;
  }
}
function oversized(raw: unknown) {
  if (raw && typeof raw === "object" && "base64" in raw && typeof raw.base64 === "string" && raw.base64.length > workbookLimits.base64Characters)
    throw new Problem(413, "Choose an XLSX workbook of at most 256 KiB.");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > workbookLimits.inputBytes) throw new Problem(413, "Choose an XLSX workbook of at most 256 KiB.");
  if (!bytes.length || bytes.toString("base64") !== value) throw new Problem(400, "Use canonical base64 workbook bytes without a data URL or alternate encoding.");
  return bytes;
}
async function prepare(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown, action: "inspect" | "convert" | "template", signal?: AbortSignal) {
  const identity = { ...supplied, unit_ids: [...supplied.unit_ids] };
  oversized(raw);
  // Capture a strict private copy before the first await. Scope never comes
  // from worker output, and no account/unit context is sent into the worker.
  const parsed = action === "template" ? { action, input: workbookTemplateInput.parse(raw) } as const
    : action === "inspect" ? { action, input: workbookInspectInput.parse(raw) } as const
    : { action, input: workbookConvertInput.parse(raw) } as const;
  const scope: WorkbookTemplateInput = parsed.input.kind === "finance" || parsed.input.kind === "staff" ? { kind: parsed.input.kind }
    : parsed.input.kind === "grade_scores" ? { kind: "grade_scores", assignmentId: parsed.input.assignmentId }
    : parsed.input.kind === "compensation_rates" ? { kind: "compensation_rates", userId: parsed.input.userId, jobId: parsed.input.jobId }
    : { kind: parsed.input.kind, unitId: parsed.input.unitId };
  // The first transaction ends before decoding, admission or worker creation.
  const current = await authorized(db, identity, sessionHash, scope, signal, async (_tx, actor, grade, compensation) => ({ actor, grade, compensation }));
  return withSpreadsheetSlot(`${current.actor.org_id}:${current.actor.id}`, async () => {
    assertWorkbookNotAborted(signal);
    let task: WorkbookTask;
    if (parsed.action === "template") { task = scope.kind === "grade_scores"
      ? { schemaVersion: 1, parserVersion: 1, kind: "grade_scores", action: "template", rows: current.grade!.rows }
      : scope.kind === "compensation_rates" ? { schemaVersion: 1, parserVersion: 1, kind: "compensation_rates", action: "template", rows: current.compensation!.rows }
      : { schemaVersion: 1, parserVersion: 1, kind: scope.kind, action: "template" }; }
    else if (parsed.action === "inspect") { const input = parsed.input; task = { schemaVersion: 1, parserVersion: 1, kind: input.kind, action: "inspect", bytes: decode(input.base64), ...(input.sheetId === undefined ? {} : { sheetId: input.sheetId }) }; }
    else { const input = parsed.input; task = { schemaVersion: 1, parserVersion: 1, kind: input.kind, action: "convert", bytes: decode(input.base64), sheetId: input.sheetId, headerRow: input.headerRow, expectedWorkbookHash: input.expectedWorkbookHash }; }
    let generated: Awaited<ReturnType<typeof runImportWorkbook>>;
    try { generated = await runImportWorkbook(task, { signal }); }
    catch (error) {
      // Coordinate errors can also reveal uploaded structure. Refresh proof
      // before returning any worker error, with no successful-conversion audit.
      assertWorkbookNotAborted(signal);
      await authorized(db, identity, sessionHash, scope, signal, async () => null);
      throw error;
    }
    return authorized(db, identity, sessionHash, scope, signal, async (tx, actor, grade, compensation) => {
      if (action === "template") {
        if (scope.kind === "grade_scores") requireCondition(grade?.sourceHash === current.grade?.sourceHash, 409, "Assignment scores or captured identities changed while preparing the template. Download a fresh copy.");
        if (scope.kind === "compensation_rates") requireCondition(compensation?.sourceHash === current.compensation?.sourceHash, 409, "Pay records, assignments or captured identities changed while preparing the template. Download a fresh copy.");
        const template = generated as WorkbookTemplate;
        await audit(tx, actor, "import.workbook_template_downloaded", null, { ...scope, formatVersion: 1, workbookHash: template.hash, workbookBytes: template.bytes,
          ...(grade ? { bookId: grade.bookId, bookVersion: grade.bookVersion, assignmentVersion: grade.assignmentVersion, sourceHash: grade.sourceHash } : {}),
          ...(compensation ? { scheduleId: compensation.scheduleId, recordVersion: compensation.version, sourceHash: compensation.sourceHash } : {}) });
        return template;
      }
      if (action === "inspect") {
        const result = workbookInspectResultSchema.parse(generated); JSON.stringify(result);
        await audit(tx, actor, "import.workbook_inspected", null, { ...scope, parserVersion: 1, workbookHash: result.workbookHash, workbookBytes: result.workbookBytes,
          sheetId: task.action === "inspect" ? task.sheetId ?? null : null, sheetCount: result.sheets.length });
        return result;
      }
      const result = workbookConvertResultSchemaFor(scope.kind).parse(generated); JSON.stringify(result);
      await audit(tx, actor, "import.workbook_converted", null, { ...scope, parserVersion: 1, workbookHash: result.workbookHash, workbookBytes: result.workbookBytes,
        sheetId: result.sheetId, headerRow: result.headerRow, rowCount: result.rowCount, csvHash: result.csvHash, csvBytes: result.csvBytes,
        ignoredSheetCount: result.ignoredSheets.length, ignoredLeadingRowCount: result.ignoredLeadingRows.count, emptyRowCount: result.emptyRows.length });
      return result;
    });
  });
}
export async function inspectImportWorkbook(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown, signal?: AbortSignal) {
  return workbookInspectResultSchema.parse(await prepare(db, actor, sessionHash, raw, "inspect", signal));
}
export async function convertImportWorkbook(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown, signal?: AbortSignal) {
  return await prepare(db, actor, sessionHash, raw, "convert", signal) as WorkbookConvertResult;
}
export async function downloadImportWorkbookTemplate(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown, signal?: AbortSignal) {
  return await prepare(db, actor, sessionHash, raw, "template", signal) as WorkbookTemplate;
}
export async function downloadFinanceWorkbookTemplate(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown = { kind: "finance" }, signal?: AbortSignal) {
  const input = workbookTemplateInput.parse(raw);
  requireCondition(input.kind === "finance", 400, "Choose the financial template.");
  return downloadImportWorkbookTemplate(db, actor, sessionHash, input, signal);
}
export function installImportWorkbooks(app: Express, db: Database) {
  const handle = async (req: Request, res: Response, action: "inspect" | "convert" | "template") => {
    const { actor, sessionHash } = req as AppRequest;
    const controller = new AbortController(), cancel = () => { if (!res.writableFinished) controller.abort(); };
    req.once("aborted", cancel); res.once("close", cancel); res.set("Cache-Control", "private, no-store");
    try {
      if (action === "template") {
        const input = workbookTemplateInput.parse(req.query);
        const result = await downloadImportWorkbookTemplate(db, actor, sessionHash, input, controller.signal); assertWorkbookNotAborted(controller.signal);
        const filename = input.kind === "finance" ? "stjw-financial-template.xlsx" : input.kind === "staff" ? "stjw-staff-template.xlsx" : input.kind === "grade_scores" ? "stjw-assignment-scores-template.xlsx" : input.kind === "compensation_rates" ? "stjw-editable-pay-template.xlsx" : `stjw-${input.kind.slice(7).replaceAll("_", "-")}-template.xlsx`;
        res.set({ "X-Workbook-SHA256": result.hash, "X-Workbook-Format-Version": "1", "Content-Length": String(result.bytes), "X-Content-Type-Options": "nosniff" })
          .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(filename).send(result.buffer);
      } else {
        const result = await (action === "inspect" ? inspectImportWorkbook : convertImportWorkbook)(db, actor, sessionHash, req.body, controller.signal);
        assertWorkbookNotAborted(controller.signal); res.json(result);
      }
    } catch (error) {
      if (error instanceof ImportWorkbookProblem) res.status(error.status).json(error.issue); else throw error;
    } finally { req.off("aborted", cancel); res.off("close", cancel); }
  };
  app.post("/api/import-workbooks/inspect", (req, res) => handle(req, res, "inspect"));
  app.post("/api/import-workbooks/convert", (req, res) => handle(req, res, "convert"));
  app.get("/api/import-workbooks/template", (req, res) => handle(req, res, "template"));
}
