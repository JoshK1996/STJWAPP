import { financeTransaction } from "./finance-access";
import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import {
  audit,
  digest,
  limitAuth,
  requireCondition,
  type Actor,
} from "./security";
import {
  financeColumns,
  financePreviewInput,
  financePublishInput,
  financeComparisonInput,
  type FinanceSnapshot,
} from "../shared/finance";
import {
  parseFinanceCsv,
  financialTotals,
  compareFinancialReports,
} from "./finance-engine";
import { toCsv } from "./reports";
import { financeViewSchema } from '../shared/finance-presentation';
import { financeReadableCsv } from './finance-presentation';

/** Transaction-only source permission; callers own actual session/publication proof. */
async function access(tx: Queryable, actor: Actor, unitId?: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Financial reports require password sign-in.",
  );
  const user = (
    await tx.query(
      "SELECT role,active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2 FOR SHARE",
      [actor.id, actor.org_id],
    )
  ).rows[0];
  requireCondition(
    user?.active && !user.requires_credential_change && ["developer", "owner", "admin", "finance"].includes(user.role),
    403,
    "Financial report access is required.",
  );
  if (unitId)
    requireCondition(
      (
        await tx.query("SELECT id FROM units WHERE id=$1 AND org_id=$2", [
          unitId,
          actor.org_id,
        ])
      ).rows.length,
      404,
      "Community not found.",
    );
}
function publicPreview(row: Row) {
  return {
    id: row.id,
    unitId: row.unit_id,
    reportId: row.report_id,
    expectedVersion: row.expected_version,
    metadata: row.metadata,
    lines: row.lines,
    sourceHash: row.source_hash,
    fingerprint: row.fingerprint,
    reason: row.reason,
    expiresAt: row.expires_at,
    receipt: row.receipt,
    totals: financialTotals(row.lines),
  };
}
export async function previewFinancialReport(
  db: Database,
  actor: Actor,
  sessionHash: string | undefined,
  raw: unknown,
) {
  const input = financePreviewInput.parse(raw),
    lines = parseFinanceCsv(input.csv),
    sourceHash = digest(input.csv),
    fingerprint = digest(JSON.stringify({ ...input, lines }));
  return financeTransaction(db, actor, sessionHash, async (tx, actor) => {
    await access(tx, actor, input.unitId);
    const existing = (
      await tx.query(
        "SELECT * FROM financial_reports WHERE id=$1 AND org_id=$2",
        [input.reportId, actor.org_id],
      )
    ).rows[0];
    requireCondition(
      existing
        ? existing.unit_id === input.unitId &&
            existing.version === input.expectedVersion &&
            !existing.archived
        : input.expectedVersion === 0,
      409,
      "This report changed or is archived. Reload before importing a revision.",
    );
    const row = (
      await tx.query(
        "INSERT INTO financial_import_previews(id,org_id,unit_id,actor_id,report_id,expected_version,metadata,lines,source_text,source_hash,fingerprint,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          input.unitId,
          actor.id,
          input.reportId,
          input.expectedVersion,
          JSON.stringify(input.metadata),
          JSON.stringify(lines),
          input.csv,
          sourceHash,
          fingerprint,
          input.reason,
        ],
      )
    ).rows[0];
    await audit(tx, actor, "finance.preview_created", row.id, {
      unitId: input.unitId,
      rows: lines.length,
      sourceHash,
    });
    return publicPreview(row);
  });
}
export async function publishFinancialReport(
  db: Database,
  actor: Actor,
  sessionHash: string | undefined,
  id: string,
  raw: unknown,
) {
  const input = financePublishInput
    .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(raw);
  return financeTransaction(db, actor, sessionHash, async (tx, actor) => {
    await access(tx, actor);
    const preview = (
      await tx.query(
        "SELECT * FROM financial_import_previews WHERE id=$1 AND org_id=$2 AND actor_id=$3 FOR UPDATE",
        [id, actor.org_id, actor.id],
      )
    ).rows[0];
    requireCondition(preview, 404, "Private import preview not found.");
    requireCondition(
      preview.source_hash === input.sourceHash &&
        preview.fingerprint === input.fingerprint,
      409,
      "The reviewed source does not match this preview.",
    );
    if (preview.applied_at) return preview.receipt;
    if (preview.expected_version === 0)
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('financial-unit:'||$1,0))",
        [preview.unit_id],
      );
    // Serialize competing first versions as well as later versions of the same report.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('financial-report:'||$1,0))",
      [preview.report_id],
    );
    const existing = (
      await tx.query(
        "SELECT * FROM financial_reports WHERE id=$1 AND org_id=$2 FOR UPDATE",
        [preview.report_id, actor.org_id],
      )
    ).rows[0];
    requireCondition(
      (await tx.query("SELECT expires_at>clock_timestamp() AS live FROM financial_import_previews WHERE id=$1", [id])).rows[0]?.live,
      409,
      "This preview expired. Preview the source again.",
    );
    requireCondition(
      existing
        ? existing.unit_id === preview.unit_id &&
            existing.version === preview.expected_version &&
            !existing.archived
        : preview.expected_version === 0,
      409,
      "This report changed or is archived. Preview the revision again.",
    );
    const version = preview.expected_version + 1;
    if (existing)
      await tx.query(
        "UPDATE financial_reports SET version=$1,state_version=state_version+1,updated_at=now() WHERE id=$2",
        [version, existing.id],
      );
    else {
      const count = (
        await tx.query(
          "SELECT count(*)::int AS n FROM financial_reports WHERE org_id=$1 AND unit_id=$2",
          [actor.org_id, preview.unit_id],
        )
      ).rows[0].n;
      requireCondition(
        count < 500,
        400,
        "This community has 500 retained reports. Add a revision to an existing report.",
      );
      await tx.query(
        "INSERT INTO financial_reports(id,org_id,unit_id,created_by) VALUES($1,$2,$3,$4)",
        [preview.report_id, actor.org_id, preview.unit_id, actor.id],
      );
    }
    await tx.query(
      "INSERT INTO financial_report_versions(report_id,org_id,version,metadata,lines,source_text,source_hash,fingerprint,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        preview.report_id,
        actor.org_id,
        version,
        JSON.stringify(preview.metadata),
        JSON.stringify(preview.lines),
        preview.source_text,
        preview.source_hash,
        preview.fingerprint,
        preview.reason,
        actor.id,
      ],
    );
    const receipt = {
      reportId: preview.report_id,
      version,
      unitId: preview.unit_id,
      sourceHash: preview.source_hash,
      fingerprint: preview.fingerprint,
      rows: preview.lines.length,
    };
    await audit(tx, actor, "finance.report_published", preview.report_id, {
      unitId: preview.unit_id,
      version,
      sourceHash: preview.source_hash,
      rows: preview.lines.length,
    });
    const consumed = await tx.query(
      "UPDATE financial_import_previews SET applied_at=clock_timestamp(),receipt=$1 WHERE id=$2 AND applied_at IS NULL AND expires_at>clock_timestamp() RETURNING id",
      [JSON.stringify(receipt), id],
    );
    requireCondition(consumed.rows.length, 409, "This preview expired. Preview the source again.");
    return receipt;
  });
}
async function reportRecord(tx: Queryable, actor: Actor, id: string) {
  const report = (
    await tx.query(
      "SELECT * FROM financial_reports WHERE id=$1 AND org_id=$2",
      [id, actor.org_id],
    )
  ).rows[0];
  requireCondition(report, 404, "Financial report not found.");
  return report;
}
async function versionRecord(
  tx: Queryable,
  actor: Actor,
  id: string,
  version: number,
  includeSource = false,
): Promise<Row> {
  const report = await reportRecord(tx, actor, id);
  const row = (
    await tx.query(
      `SELECT report_id,version,metadata,lines,source_hash,fingerprint,reason,created_by,created_at${includeSource ? ",source_text" : ""} FROM financial_report_versions WHERE report_id=$1 AND org_id=$2 AND version=$3`,
      [id, actor.org_id, version],
    )
  ).rows[0];
  requireCondition(row, 404, "Financial report version not found.");
  return {
    ...row,
    unit_id: report.unit_id,
    archived: report.archived,
    totals: financialTotals(row.lines),
  };
}
async function compareFinanceSource(tx: Queryable, actor: Actor, raw: unknown) {
  const input = financeComparisonInput.parse(raw);
  await access(tx, actor);
  const left = await versionRecord(
      tx,
      actor,
      input.leftId,
      input.leftVersion,
    ),
    right = await versionRecord(tx, actor, input.rightId, input.rightVersion);
  requireCondition(
    left.unit_id === right.unit_id,
    400,
    "Choose financial reports from the same community.",
  );
  const toSnapshot = (row: Row): FinanceSnapshot => ({
    metadata: row.metadata,
    lines: row.lines,
    sourceHash: row.source_hash,
  });
  const result = compareFinancialReports(
    toSnapshot(left),
    toSnapshot(right),
    input.differentPeriodsReviewed,
  );
  const refs = {
    left: {
      id: left.report_id,
      version: left.version,
      sourceHash: left.source_hash,
      fingerprint: left.fingerprint,
      metadata: left.metadata,
    },
    right: {
      id: right.report_id,
      version: right.version,
      sourceHash: right.source_hash,
      fingerprint: right.fingerprint,
      metadata: right.metadata,
    },
  };
  await audit(tx, actor, "finance.reports_compared", null, {
    unitId: left.unit_id,
    leftId: left.report_id,
    leftVersion: left.version,
    rightId: right.report_id,
    rightVersion: right.version,
  });
  return {
    ...result,
    ...refs,
    unitId: left.unit_id,
    sourceHash: digest(JSON.stringify(refs)),
    asOf: new Date().toISOString(),
  };
}
export async function compareFinance(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown) {
  return financeTransaction(db, actor, sessionHash, (tx, current) => compareFinanceSource(tx, current, raw));
}

export async function financialReportSource(
  tx: Queryable,
  actor: Actor,
  id: string,
  version: number,
) {
  await access(tx, actor);
  return versionRecord(tx, actor, id, version);
}
export async function financialReportOptions(
  tx: Queryable,
  actor: Actor,
  unitId: string,
) {
  await access(tx, actor, unitId);
  const rows = (
    await tx.query(
      `SELECT r.id,r.version,r.archived,v.metadata FROM financial_reports r
     JOIN financial_report_versions v ON v.report_id=r.id AND v.org_id=r.org_id AND v.version=r.version
     WHERE r.org_id=$1 AND r.unit_id=$2 ORDER BY r.archived,v.metadata->>'title',r.id LIMIT 501`,
      [actor.org_id, unitId],
    )
  ).rows;
  requireCondition(
    rows.length <= 500,
    400,
    "More than 500 financial sources are available in this community. A narrower catalog is required.",
  );
  // Do not return private source notes in the selector catalog.
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    archived: r.archived,
    title: r.metadata.title,
    currency: r.metadata.currency,
    from: r.metadata.from,
    to: r.metadata.to,
  }));
}
export function installFinance(app: Express, db: Database) {
  const actor = (req: Request) => (req as AppRequest).actor;
  const hash = (req: Request) => (req as AppRequest).sessionHash;
  const finance = <T>(req: Request, work: (tx: Queryable, current: Actor) => Promise<T>) => financeTransaction(db, actor(req), hash(req), work);
  app.get("/api/finance/template", async (req, res) => {
    const csv = await finance(req, async () => toCsv([], [...financeColumns]));
    res.type("text/csv").attachment("financial-report-template.csv").send(csv);
  });
  app.get("/api/finance/reports", async (req, res) => {
    const input = z.object({ unitId: z.uuid(), archived: z.enum(["true", "false"]).default("false") }).strict().parse(req.query);
    const result = await finance(req, async (tx, current) => {
      await access(tx, current, input.unitId);
      const rows = (await tx.query(`SELECT r.*,v.metadata,v.source_hash,jsonb_array_length(v.lines) AS line_count FROM financial_reports r JOIN financial_report_versions v ON v.report_id=r.id AND v.version=r.version WHERE r.org_id=$1 AND r.unit_id=$2 AND r.archived=$3 ORDER BY r.updated_at DESC LIMIT 501`, [current.org_id, input.unitId, input.archived === "true"])).rows;
      requireCondition(rows.length <= 500, 400, "Too many reports to list."); return { rows };
    });
    res.json(result);
  });
  app.post("/api/finance/previews", async (req, res) => {
    await finance(req, async () => undefined);
    await limitAuth(db, "finance:preview:" + actor(req).id, 30);
    res.status(201).json(await previewFinancialReport(db, actor(req), hash(req), req.body));
  });
  app.get("/api/finance/previews/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await finance(req, async (tx, current) => {
      const row = (await tx.query("SELECT * FROM financial_import_previews WHERE id=$1 AND org_id=$2 AND actor_id=$3", [id, current.org_id, current.id])).rows[0];
      requireCondition(row, 404, "Private import preview not found."); return publicPreview(row);
    });
    res.json(result);
  });
  app.post("/api/finance/previews/:id/publish", async (req, res) =>
    res.json(await publishFinancialReport(db, actor(req), hash(req), z.uuid().parse(req.params.id), req.body)));
  app.get("/api/finance/reports/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await finance(req, async (tx, current) => {
      const report = await reportRecord(tx, current, id), versions = (await tx.query("SELECT version,metadata,source_hash,fingerprint,reason,created_at,created_by,jsonb_array_length(lines) AS line_count FROM financial_report_versions WHERE report_id=$1 AND org_id=$2 ORDER BY version DESC", [id, current.org_id])).rows;
      return { report, versions };
    });
    res.json(result);
  });
  app.get("/api/finance/reports/:id/versions/:version", async (req, res) => {
    const id = z.uuid().parse(req.params.id), version = z.coerce.number().int().min(1).parse(req.params.version),
      format = z.enum(["json", "csv", "source", "readable_csv"]).default("json").parse(req.query.format);
    const presentation = format === 'readable_csv' ? financeViewSchema.parse({
      columns: req.query.columns === undefined ? undefined : z.string().max(120).parse(req.query.columns).split(','),
      search: req.query.search, group: req.query.group, rowKind: req.query.rowKind, sort: req.query.sort,
      decimalPlaces: req.query.decimalPlaces === undefined ? undefined : z.enum(['2','4']).transform(value=>Number(value) as 2|4).parse(req.query.decimalPlaces),
    }) : undefined;
    const file = await finance(req, async (tx, current) => {
      const row = await versionRecord(tx, current, id, version, format === "source");
      const community = presentation ? (await tx.query('SELECT u.name FROM units u JOIN financial_reports r ON r.unit_id=u.id AND r.org_id=u.org_id WHERE r.org_id=$1 AND r.id=$2', [current.org_id, id])).rows[0]?.name : undefined;
      const content = presentation ? financeReadableCsv(row as any, presentation, community ?? 'Selected community') : format === "source" ? row.source_text : format === "json" ? JSON.stringify(row) : toCsv(
        row.lines.map((line: Row) => ({ ...line, report_id: id, version, source_hash: row.source_hash, currency: row.metadata.currency })),
        [...financeColumns, "currency", "report_id", "version", "source_hash"]);
      await audit(tx, current, "finance.report_read", id, { version, format, sourceHash: row.source_hash, ...(presentation ? { presentation } : {}) });
      return { content, sourceHash: row.source_hash };
    });
    res.set("X-Source-Hash", file.sourceHash);
    if (format === "source") res.type("text/plain").attachment("financial-report-original-source.txt").send(file.content);
    else if (format === "csv" || format === 'readable_csv') res.type("text/csv").attachment("financial-report-v" + version + (presentation ? '-view' : '') + ".csv").send(file.content);
    else res.type("application/json").send(file.content);
  });
  app.post("/api/finance/reports/:id/archive", async (req, res) => {
    const id = z.uuid().parse(req.params.id), input = z.object({ stateVersion: z.number().int().min(1), archived: z.boolean(), reason: z.string().trim().min(3).max(1000) }).strict().parse(req.body);
    const result = await finance(req, async (tx, current) => {
      const row = (await tx.query("SELECT * FROM financial_reports WHERE id=$1 AND org_id=$2 FOR UPDATE", [id, current.org_id])).rows[0];
      requireCondition(row, 404, "Financial report not found.");
      requireCondition(row.state_version === input.stateVersion, 409, "This report changed. Reload before changing archive status.");
      await tx.query("UPDATE financial_reports SET archived=$1,state_version=state_version+1,updated_at=now() WHERE id=$2", [input.archived, id]);
      await tx.query("INSERT INTO financial_report_events(id,org_id,report_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), current.org_id, id, current.id, input.archived ? "archived" : "restored", JSON.stringify({ reason: input.reason, previousStateVersion: input.stateVersion, version: row.version })]);
      await audit(tx, current, "finance.archive_changed", id, { archived: input.archived, unitId: row.unit_id });
      return { ok: true };
    });
    res.json(result);
  });
  app.get("/api/finance/reports/:id/history", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await finance(req, async (tx, current) => {
      await reportRecord(tx, current, id);
      return { rows: (await tx.query("SELECT id,action,detail,created_at,actor_id FROM financial_report_events WHERE report_id=$1 AND org_id=$2 ORDER BY created_at DESC", [id, current.org_id])).rows };
    });
    res.json(result);
  });
  app.post("/api/finance/compare", async (req, res) => res.json(await compareFinance(db, actor(req), hash(req), req.body)));
  app.post("/api/finance/compare/export", async (req, res) => {
    const format = z.enum(["csv", "json"]).default("csv").parse(req.query.format);
    const file = await finance(req, async (tx, current) => {
      const result = await compareFinanceSource(tx, current, req.body);
      const content = format === "json" ? JSON.stringify(result, null, 2) : toCsv(result.rows.map(row => ({ ...row, currency: result.currency,
        left_report: result.left.id, left_version: result.left.version, right_report: result.right.id, right_version: result.right.version, source_hash: result.sourceHash })),
        ["lineCode", "leftLabel", "rightLabel", "leftGroup", "rightGroup", "leftKind", "rightKind", "leftAmount", "rightAmount", "delta", "percent", "status", "labelChanged", "groupChanged", "currency", "left_report", "left_version", "right_report", "right_version", "source_hash"]);
      return { content, sourceHash: result.sourceHash };
    });
    res.set("X-Source-Hash", file.sourceHash).type(format === "json" ? "application/json" : "text/csv").attachment("financial-comparison." + format).send(file.content);
  });
}
