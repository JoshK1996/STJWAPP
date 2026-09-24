import { z } from "zod";
import { workforcePresentationRows,workforcePresentationLabels } from "../shared/workforce-presentation";
import type { Database } from "./db";
import { audit, requireCondition, type Actor } from "./security";
import { toCsv } from "./reports";
import { readWorkforceReportSourceV2, workforceReportColumnsV2 } from "./reports-v2";
import { workforceReportQueryV2Schema } from "../shared/workforce-reports-v2";
import { withAuthorizedWorkforceSource, type WorkforceReportProof } from "./workforce-report-access";

export const workforceReportExportV2Query = workforceReportQueryV2Schema.safeExtend({
  presentation:z.enum(["readable","exact"]).default("exact"), columns: z.string().min(1).max(500).optional(), format: z.enum(["csv", "json"]).default("csv"),
});

export function getAuthorizedWorkforceReportV2(db: Database, actor: Actor, proof: WorkforceReportProof, raw: unknown) {
  const query = workforceReportQueryV2Schema.parse(raw);
  return withAuthorizedWorkforceSource(db, actor, proof,
    (tx, current) => readWorkforceReportSourceV2(tx, current, query),
    async (_tx, _current, report) => report, { repeatableRead: true });
}

export function exportAuthorizedWorkforceReportV2(db: Database, actor: Actor, proof: WorkforceReportProof, raw: unknown) {
  const { columns: selected, format, presentation, ...query } = workforceReportExportV2Query.parse(raw);
  requireCondition(format !== "json" || selected === undefined, 400, "JSON evidence includes the complete report; choose columns only for CSV.");
  requireCondition(format!=="json"||presentation==="exact",400,"Source JSON preserves exact evidence; presentation applies to CSV only.");
  const columns = selected?.split(",") ?? [...workforceReportColumnsV2];
  requireCondition(columns.length > 0 && new Set(columns).size === columns.length &&
    columns.every(column => (workforceReportColumnsV2 as readonly string[]).includes(column)), 400, "Choose unique supported exact-report columns.");
  return withAuthorizedWorkforceSource(db, actor, proof,
    (tx, current) => readWorkforceReportSourceV2(tx, current, query),
    async (tx, current, report) => {
      const body = format === "csv" ? (presentation==="readable" ? toCsv(workforcePresentationRows(report,columns),[...columns.map(column=>workforcePresentationLabels[column]),"Time zone","Period from","Period through","Captured","Report notes"]) : toCsv(report.rows, columns)) : JSON.stringify(report) + "\n";
      await audit(tx, current, "report.v2_exported", null, { query, ...(format === "csv" ? { columns } : {}), format, presentation, schemaVersion: 2, precisionVersion: 2,
        durationUnit: "microsecond", rowCount: report.rows.length, asOf: report.asOf });
      return { body, format, presentation, query, asOf: report.asOf };
    }, { repeatableRead: true });
}
