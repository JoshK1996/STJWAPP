import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, Problem, requireCondition, type Actor } from "./security";
import { currentReportActor, recheckReportSession } from "./report-source-access";
import { amountText, amountUnits } from "./finance-engine";
import { toCsv } from "./reports";
import { parseCompensationCsv } from "./compensation-csv";
import {
  compensationCsvColumns,
  compensationImportInput,
} from "../shared/compensation";
import {
  compensationPair,
  compensationPreviewInput,
  compensationSaveInput,
  compensationRate,
  type CompensationRate,
} from "../shared/compensation";

const actorOf = (req: Request) => (req as AppRequest).actor;
const proofOf = (req: Request) => (req as AppRequest).sessionHash;
type Pair = z.infer<typeof compensationPair>;
function identityOf(supplied: Actor): Actor {
  return { ...supplied, id: z.uuid().parse(supplied.id).toLowerCase(), org_id: z.uuid().parse(supplied.org_id).toLowerCase(), unit_ids: [...supplied.unit_ids] };
}
function requiredProof(sessionHash: string | undefined): string {
  requireCondition(typeof sessionHash === "string" && /^[a-f0-9]{64}$/.test(sessionHash), 401, "A verified password session is required.");
  return sessionHash;
}
async function lockPair(tx: Queryable, actor: Actor, scope: Pair) {
  // This mutex always precedes account/session locks, including reads and workbook
  // publication. Preserve the writer's existing hashtext protocol.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "compensation:" + actor.org_id + ":" + scope.userId.toLowerCase() + ":" + scope.jobId.toLowerCase(),
  ]);
}
async function currentPayActor(tx: Queryable, supplied: Actor, proof: string, userId?: string) {
  requireCondition(supplied.mode === "password", 403, "Pay records require password sign-in.");
  // Discover the full account set before locking any account. Reacquiring the
  // actor in currentReportActor is safe once this sorted set is already held.
  const ids = [...new Set([supplied.id, ...(userId ? [userId.toLowerCase()] : [])])].sort();
  const rows = (await tx.query("SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE", [supplied.org_id, ids])).rows;
  const actor = await currentReportActor(tx, supplied, proof);
  requireCondition(["developer", "owner", "admin", "finance"].includes(actor.role), 403, "Owner, administrator or finance access is required for pay records.");
  if (userId) requireCondition(rows.some(row => row.id === userId.toLowerCase()), 404, "Staff member not found.");
  return actor;
}
async function payTransaction<T>(db: Database, supplied: Actor, sessionHash: string | undefined, scope: { userId?: string; jobId?: string }, action: (tx: Queryable, actor: Actor) => Promise<T>): Promise<T> {
  const proof = requiredProof(sessionHash), identity = identityOf(supplied), captured = { ...scope };
  try { return await db.transaction(async tx => {
    await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
    if (captured.userId && captured.jobId) await lockPair(tx, identity, captured as Pair);
    const actor = await currentPayActor(tx, identity, proof, captured.userId), result = await action(tx, actor);
    // File actions serialize their exact response here, before the final proof.
    // Preserve normal JS value types and historical receipt property formats.
    JSON.stringify(result);
    await recheckReportSession(tx, actor, proof); return result;
  }); } catch (error) {
    if (["55P03", "57014", "40001", "40P01"].includes((error as { code?: string }).code ?? ""))
      throw new Problem(503, "Pay records are busy. Retry the same reviewed command when available.");
    throw error;
  }
}
async function access(tx: Queryable, actor: Actor, userId?: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Pay records require password sign-in.",
  );
  // Stable shared-lock order also covers administrators editing one another's records.
  const rows = (
    await tx.query(
      "SELECT id,name,email,active,role FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
      [actor.org_id, [...new Set([actor.id, ...(userId ? [userId] : [])])]],
    )
  ).rows;
  const current = rows.find((x) => x.id === actor.id);
  requireCondition(
    current?.active && ["developer", "owner", "admin", "finance"].includes(current.role),
    403,
    "Owner, administrator or finance access is required for pay records.",
  );
  if (userId) {
    const target = rows.find((x) => x.id === userId);
    requireCondition(target, 404, "Staff member not found.");
    return target;
  }
}
export async function compensationReportAccess(tx: Queryable, actor: Actor, unitId?: string) {
  await access(tx, actor);
  if (unitId) requireCondition((await tx.query("SELECT id FROM units WHERE id=$1 AND org_id=$2", [unitId, actor.org_id])).rows.length, 404, "Community not found.");
}
export async function compensationReportSource(tx: Queryable, actor: Actor, input: {from:string;to:string;unitId?:string;includeVoided:boolean}, now = new Date()) {
  await compensationReportAccess(tx, actor, input.unitId);
  // One statement snapshot captures rates, versions and current directory/assignment labels.
  // Retained records still appear after an employee/job is deactivated or unassigned.
  const rows=(await tx.query(`SELECT c.id AS record_id,c.version AS record_version,c.updated_at AS record_updated_at,
    e.id AS user_id,e.name AS employee_name,e.email AS employee_email,e.active AS employee_active,
    j.id AS job_id,j.title AS job_title,j.active AS job_active,u.id AS unit_id,u.name AS unit_name,
    r.value->>'id' AS rate_id,r.value->>'amount' AS amount,r.value->>'currency' AS currency,r.value->>'basis' AS basis,
    r.value->>'startsOn' AS starts_on,r.value->>'endsOn' AS ends_on,(r.value->>'voided')::boolean AS voided,r.value->>'note' AS note,
    EXISTS(SELECT 1 FROM user_jobs a JOIN user_units b ON b.org_id=a.org_id AND b.user_id=a.user_id AND b.unit_id=j.unit_id WHERE a.org_id=c.org_id AND a.user_id=c.user_id AND a.job_id=c.job_id) AS assigned
    FROM compensation_schedules c JOIN users e ON e.org_id=c.org_id AND e.id=c.user_id
    JOIN jobs j ON j.org_id=c.org_id AND j.id=c.job_id JOIN units u ON u.org_id=c.org_id AND u.id=j.unit_id
    CROSS JOIN LATERAL jsonb_array_elements(c.rates) r(value)
    WHERE c.org_id=$1 AND ($2::uuid IS NULL OR j.unit_id=$2)
    AND ($5::boolean OR (r.value->>'voided')::boolean=false)
    AND r.value->>'startsOn'<=$4 AND (r.value->>'endsOn' IS NULL OR r.value->>'endsOn'>=$3)
    ORDER BY c.id,r.value->>'startsOn',r.value->>'id' LIMIT 5001`,[actor.org_id,input.unitId??null,input.from,input.to,input.includeVoided])).rows
    .map((row):Row=>({...row,record_updated_at:new Date(row.record_updated_at).toISOString()}));
  requireCondition(rows.length<=5000,400,"More than 5,000 rate entries match. Narrow the dates or community before running the report.");
  return {rows,sourceHash:digest(JSON.stringify(rows)),recordCount:new Set(rows.map(row=>row.record_id)).size,asOf:now.toISOString()};
}
export function validateCompensationRates(
  rates: CompensationRate[],
  previous: CompensationRate[] = [],
) {
  const ids = new Set(rates.map((r) => r.id));
  requireCondition(
    ids.size === rates.length,
    400,
    "Each rate needs a distinct identity.",
  );
  requireCondition(
    previous.every((r) => ids.has(r.id)),
    400,
    "Retain existing rate entries. Mark an incorrect entry void instead of removing it.",
  );
  const normalized = rates
    .map((r) => ({ ...r, amount: amountText(amountUnits(r.amount)) }))
    .sort(
      (a, b) =>
        a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id),
    );
  const active = normalized.filter((r) => !r.voided);
  for (let i = 1; i < active.length; i++)
    requireCondition(
      active[i - 1].endsOn !== null &&
        active[i - 1].endsOn! < active[i].startsOn,
      409,
      "Effective dates overlap. End the earlier rate before the next rate begins, or mark an incorrect entry void.",
    );
  return normalized;
}
async function pair(
  tx: Queryable,
  actor: Actor,
  userId: string,
  jobId: string,
) {
  const employee = await access(tx, actor, userId.toLowerCase());
  const job = (
    await tx.query(
      "SELECT j.id,j.title,j.unit_id,j.active,u.name AS unit_name FROM jobs j JOIN units u ON u.id=j.unit_id AND u.org_id=j.org_id WHERE j.id=$1 AND j.org_id=$2 FOR SHARE OF j,u",
      [jobId, actor.org_id],
    )
  ).rows[0];
  requireCondition(job, 404, "Job not found.");
  const assigned =
    (
      await tx.query(
        "SELECT uj.job_id FROM user_jobs uj JOIN user_units uu ON uu.user_id=uj.user_id AND uu.org_id=uj.org_id WHERE uj.org_id=$1 AND uj.user_id=$2 AND uj.job_id=$3 AND uu.unit_id=$4",
        [actor.org_id, userId, jobId, job.unit_id],
      )
    ).rows.length > 0;
  const schedule =
    (
      await tx.query(
        "SELECT * FROM compensation_schedules WHERE org_id=$1 AND user_id=$2 AND job_id=$3 FOR SHARE",
        [actor.org_id, userId, jobId],
      )
    ).rows[0] ?? null;
  requireCondition(
    schedule || assigned,
    404,
    "Choose an assigned job or an existing pay record.",
  );
  return { employee: employee!, job, assigned, schedule };
}
/** Transaction-only workbook source. Invoke before any generic account locks.
 * Caller owns final session proof after audit/materialization and must not keep
 * this transaction open during workbook parsing. No report helper uses this. */
export async function compensationImportWorkbookContext(tx: Queryable, suppliedActor: Actor, sessionHash: string | undefined, raw: Pair) {
  const proof = requiredProof(sessionHash), supplied = identityOf(suppliedActor), input = compensationPair.parse(raw);
  const scope = { userId: input.userId.toLowerCase(), jobId: input.jobId.toLowerCase() };
  await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
  await lockPair(tx, supplied, scope);
  const actor = await currentPayActor(tx, supplied, proof, scope.userId), record = await pair(tx, actor, scope.userId, scope.jobId);
  const version: number = record.schedule?.version ?? 0, scheduleId: string | null = record.schedule?.id ?? null;
  const rates: Row[] = record.schedule?.rates ?? [{ id: "", startsOn: "", endsOn: null, amount: "", currency: "", basis: "", voided: false, note: "" }];
  requireCondition(Array.isArray(rates) && rates.length >= 1 && rates.length <= 200, 422, "The complete pay record cannot be represented by this template.");
  if (record.schedule) requireCondition(rates.every(rate => compensationRate.safeParse(rate).success), 422, "The retained pay fields failed validation for this template.");
  const rows: string[][] = rates.map(rate => {
    const values = { userId: scope.userId, jobId: scope.jobId, recordVersion: String(version), rateId: rate.id,
      startsOn: rate.startsOn, endsOn: rate.endsOn ?? "", amount: rate.amount, currency: rate.currency, basis: rate.basis,
      voided: rate.voided === true ? "true" : rate.voided === false ? "false" : null, note: rate.note };
    const row = compensationCsvColumns.map(column => values[column]);
    requireCondition(row.every(value => typeof value === "string" && Buffer.from(value, "utf8").toString("utf8") === value), 422, "The retained pay text cannot be represented exactly by this template.");
    return row as string[];
  });
  const sourceHash = digest(JSON.stringify({ schemaVersion: 1, kind: "compensation_workbook_source", ...scope, scheduleId, version, rows,
    employee: { id: record.employee.id, name: record.employee.name, email: record.employee.email, active: record.employee.active },
    job: { id: record.job.id, title: record.job.title, active: record.job.active, unitId: record.job.unit_id, unitName: record.job.unit_name }, assigned: record.assigned }));
  return { actor, ...scope, scheduleId, version, rows, sourceHash };
}
async function plan(
  tx: Queryable,
  actor: Actor,
  input: z.infer<typeof compensationPreviewInput>,
) {
  const source = await pair(tx, actor, input.userId, input.jobId),
    version = source.schedule?.version ?? 0;
  requireCondition(
    input.expectedVersion === version,
    409,
    "Pay records changed. Reload before reviewing this change.",
  );
  const before: CompensationRate[] = source.schedule?.rates ?? [],
    rates = validateCompensationRates(input.rates, before);
  if (input.sourceCsv)
    parseCompensationCsv(
      input.sourceCsv,
      { ...input, previous: before },
      input.rates,
    );
  requireCondition(
    Buffer.byteLength(JSON.stringify(input), "utf8") <= 450000,
    400,
    "The encoded pay-record change is too large. Shorten source notes before reviewing.",
  );
  const previousIds = new Set(before.map((r) => r.id));
  if (rates.some((r) => !previousIds.has(r.id)))
    requireCondition(
      source.employee.active && source.job.active && source.assigned,
      409,
      "New rate entries require an active employee and currently assigned active job. Existing records can still be corrected.",
    );
  const changes = rates
    .filter((r) => {
      const old = before.find((b) => b.id === r.id);
      return (
        !old ||
        JSON.stringify(compensationRate.parse(old)) !== JSON.stringify(r)
      );
    })
    .map((after) => ({
      before: before.find((b) => b.id === after.id) ?? null,
      after,
    }));
  requireCondition(
    changes.length,
    400,
    "Change at least one rate entry before saving.",
  );
  const snapshot = {
    userId: input.userId,
    employeeName: source.employee.name,
    employeeEmail: source.employee.email,
    jobId: input.jobId,
    jobTitle: source.job.title,
    unitId: source.job.unit_id,
    unitName: source.job.unit_name,
    rates,
  };
  const previewHash = digest(
    JSON.stringify({
      expectedVersion: version,
      snapshot,
      before,
      reason: input.reason,
      employeeActive: source.employee.active,
      jobActive: source.job.active,
      assigned: source.assigned,
      ...(input.sourceCsv ? { sourceHash: digest(input.sourceCsv) } : {}),
    }),
  );
  return { ...source, version, rates, changes, snapshot, previewHash };
}
export async function previewCompensation(
  db: Database,
  actor: Actor,
  raw: unknown,
  sessionHash: string | undefined,
) {
  const input = compensationPreviewInput.parse(raw);
  return payTransaction(db, actor, sessionHash, input, async (tx, actor) => {
    const result = await plan(tx, actor, input);
    await audit(
      tx,
      actor,
      "compensation.previewed",
      result.schedule?.id ?? null,
      {
        userId: input.userId,
        jobId: input.jobId,
        version: result.version,
        changes: result.changes.length,
        previewHash: result.previewHash,
      },
    );
    return result;
  });
}
export async function saveCompensation(
  db: Database,
  actor: Actor,
  raw: unknown,
  sessionHash: string | undefined,
) {
  const input = compensationSaveInput.parse(raw),
    fingerprint = digest(JSON.stringify(input));
  return payTransaction(db, actor, sessionHash, input, async (tx, actor) => {
    const prior = (
      await tx.query(
        "SELECT fingerprint,result FROM compensation_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
        [actor.org_id, actor.id, input.commandId],
      )
    ).rows[0];
    if (prior) {
      requireCondition(
        prior.fingerprint === fingerprint,
        409,
        "This command was already used for a different pay-record change.",
      );
      return prior.result;
    }
    const result = await plan(tx, actor, input);
    requireCondition(
      result.previewHash === input.previewHash,
      409,
      "The reviewed pay record changed. Preview it again before saving.",
    );
    const id = result.schedule?.id ?? randomUUID(),
      version = result.version + 1;
    if (result.schedule)
      await tx.query(
        "UPDATE compensation_schedules SET version=$1,rates=$2,updated_at=now() WHERE id=$3 AND org_id=$4",
        [version, JSON.stringify(result.rates), id, actor.org_id],
      );
    else
      await tx.query(
        "INSERT INTO compensation_schedules(id,org_id,user_id,job_id,version,rates) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          actor.org_id,
          input.userId,
          input.jobId,
          version,
          JSON.stringify(result.rates),
        ],
      );
    await tx.query(
      "INSERT INTO compensation_history(schedule_id,org_id,version,snapshot,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        actor.org_id,
        version,
        JSON.stringify({
          ...result.snapshot,
          before: result.schedule?.rates ?? [],
          changes: result.changes,
          ...(input.sourceCsv
            ? {
                importSource: {
                  base64: Buffer.from(input.sourceCsv, "utf8").toString(
                    "base64",
                  ),
                  sha256: digest(input.sourceCsv),
                  bytes: Buffer.byteLength(input.sourceCsv, "utf8"),
                },
              }
            : {}),
        }),
        input.reason,
        actor.id,
      ],
    );
    const receipt = {
      id,
      version,
      previewHash: result.previewHash,
      changedEntries: result.changes.length,
    };
    await tx.query(
      "INSERT INTO compensation_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [
        actor.org_id,
        actor.id,
        input.commandId,
        fingerprint,
        JSON.stringify(receipt),
      ],
    );
    await audit(tx, actor, "compensation.saved", id, {
      userId: input.userId,
      jobId: input.jobId,
      version,
      changedEntries: result.changes.length,
      previewHash: result.previewHash,
    });
    return receipt;
  });
}
export function installCompensation(app: Express, db: Database) {
  app.use("/api/compensation", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  app.get("/api/compensation/template", async (req, res) => {
    const actor = actorOf(req),
      query = compensationPair.parse(req.query);
    const csv = await payTransaction(db, actor, proofOf(req), query, async (tx, actor) => {
      const record = await pair(tx, actor, query.userId, query.jobId),
        version = record.schedule?.version ?? 0;
      const rates: Row[] = record.schedule?.rates ?? [
        {
          id: "",
          startsOn: "",
          endsOn: "",
          amount: "",
          currency: "",
          basis: "",
          voided: false,
          note: "",
        },
      ];
      const rows = rates.map((r) => ({
        userId: query.userId,
        jobId: query.jobId,
        recordVersion: version,
        rateId: r.id,
        ...r,
        endsOn: r.endsOn ?? "",
      }));
      await audit(
        tx,
        actor,
        "compensation.template_downloaded",
        record.schedule?.id ?? null,
        { ...query, version },
      );
      return toCsv(rows, [...compensationCsvColumns]);
    });
    res.type("text/csv").attachment("stjw-editable-pay-template.csv").send(csv);
  });
  app.post("/api/compensation/import-preview", async (req, res) => {
    const actor = actorOf(req),
      raw = compensationImportInput.parse(req.body);
    res.json(
      await payTransaction(db, actor, proofOf(req), raw, async (tx, actor) => {
        const record = await pair(tx, actor, raw.userId, raw.jobId),
          rates = parseCompensationCsv(raw.csv, {
            ...raw,
            previous: record.schedule?.rates ?? [],
          });
        const input = compensationPreviewInput.parse({
          userId: raw.userId,
          jobId: raw.jobId,
          expectedVersion: raw.expectedVersion,
          reason: raw.reason,
          rates,
          sourceCsv: raw.csv,
        });
        const data = await plan(tx, actor, input);
        await audit(
          tx,
          actor,
          "compensation.import_previewed",
          record.schedule?.id ?? null,
          {
            userId: raw.userId,
            jobId: raw.jobId,
            version: data.version,
            changes: data.changes.length,
            sourceHash: digest(raw.csv),
            previewHash: data.previewHash,
          },
        );
        return { input, data, sourceHash: digest(raw.csv) };
      }),
    );
  });
  app.get("/api/compensation/history-source", async (req, res) => {
    const actor = actorOf(req),
      query = compensationPair
        .extend({ version: z.coerce.number().int().positive().max(2147483647) })
        .strict()
        .parse(req.query);
    const csv = await payTransaction(db, actor, proofOf(req), query, async (tx, actor) => {
      const record = await pair(tx, actor, query.userId, query.jobId);
      requireCondition(record.schedule, 404, "Pay record not found.");
      const source = (
        await tx.query(
          "SELECT snapshot->'importSource' AS source FROM compensation_history WHERE org_id=$1 AND schedule_id=$2 AND version=$3",
          [actor.org_id, record.schedule.id, query.version],
        )
      ).rows[0]?.source;
      requireCondition(source, 404, "This version has no imported CSV source.");
      const text = Buffer.from(source.base64, "base64").toString("utf8");
      requireCondition(
        digest(text) === source.sha256,
        409,
        "The retained source failed its integrity check.",
      );
      await audit(
        tx,
        actor,
        "compensation.source_downloaded",
        record.schedule.id,
        { ...query, sourceHash: source.sha256 },
      );
      return text;
    });
    res
      .type("text/plain; charset=utf-8")
      .attachment("stjw-pay-import-original.txt")
      .send(csv);
  });
  app.get("/api/compensation/staff", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await payTransaction(db, actorOf(req), proofOf(req), {}, async (tx, actor) => {
        const rows = (
          await tx.query(
            "SELECT id,name,email,active FROM users WHERE org_id=$1 ORDER BY active DESC,name,id LIMIT 1001",
            [actor.org_id],
          )
        ).rows;
        requireCondition(
          rows.length <= 1000,
          400,
          "More than 1,000 staff records require a narrower directory.",
        );
        return { rows };
      }),
    );
  });
  app.get("/api/compensation/jobs", async (req, res) => {
    const { userId } = z.object({ userId: z.uuid() }).strict().parse(req.query);
    res.json(
      await payTransaction(db, actorOf(req), proofOf(req), { userId }, async (tx, actor) => {
        const rows = (
          await tx.query(
            `SELECT j.id,j.title,j.unit_id,j.active,u.name AS unit_name,c.version,
      EXISTS(SELECT 1 FROM user_jobs a JOIN user_units b ON b.user_id=a.user_id AND b.org_id=a.org_id WHERE a.org_id=j.org_id AND a.user_id=$2 AND a.job_id=j.id AND b.unit_id=j.unit_id) AS assigned
      FROM jobs j JOIN units u ON u.id=j.unit_id AND u.org_id=j.org_id LEFT JOIN compensation_schedules c ON c.org_id=j.org_id AND c.job_id=j.id AND c.user_id=$2
      WHERE j.org_id=$1 AND (c.id IS NOT NULL OR EXISTS(SELECT 1 FROM user_jobs a WHERE a.org_id=j.org_id AND a.job_id=j.id AND a.user_id=$2)) ORDER BY u.name,j.title,j.id`,
            [actor.org_id, userId],
          )
        ).rows;
        return { rows };
      }),
    );
  });
  app.get("/api/compensation/record", async (req, res) => {
    const query = compensationPair.parse(req.query);
    res.json(
      await payTransaction(db, actorOf(req), proofOf(req), query, async (tx, actor) => {
        const result = await pair(tx, actor, query.userId, query.jobId);
        await audit(
          tx,
          actor,
          "compensation.viewed",
          result.schedule?.id ?? null,
          {
            userId: query.userId,
            jobId: query.jobId,
            version: result.schedule?.version ?? 0,
          },
        );
        return result;
      }),
    );
  });
  app.post("/api/compensation/preview", async (req, res) =>
    res.json(await previewCompensation(db, actorOf(req), req.body, proofOf(req))),
  );
  app.post("/api/compensation/save", async (req, res) =>
    res.json(await saveCompensation(db, actorOf(req), req.body, proofOf(req))),
  );
  app.get("/api/compensation/history", async (req, res) => {
    const query = compensationPair
            .extend({
              beforeVersion: z.coerce.number().int().positive().max(2147483647).optional(),
            })
            .strict()
            .parse(req.query);
    res.json(
      await payTransaction(db, actorOf(req), proofOf(req), query, async (tx, actor) => {
        const result = await pair(tx, actor, query.userId, query.jobId);
        const rows = result.schedule
          ? (
              await tx.query(
                "SELECT h.version,h.snapshot - 'importSource' AS snapshot,(h.snapshot ? 'importSource') AS has_import_source,h.snapshot->'importSource'->>'sha256' AS source_hash,h.reason,h.created_at,u.name AS actor_name FROM compensation_history h JOIN users u ON u.id=h.actor_id AND u.org_id=h.org_id WHERE h.org_id=$1 AND h.schedule_id=$2 AND h.version<$3 ORDER BY version DESC LIMIT 11",
                [
                  actor.org_id,
                  result.schedule.id,
                  query.beforeVersion ?? 2147483647,
                ],
              )
            ).rows
          : [];
        await audit(
          tx,
          actor,
          "compensation.history_viewed",
          result.schedule?.id ?? null,
          { userId: query.userId, jobId: query.jobId },
        );
        return {
          rows: rows.slice(0, 10),
          nextBeforeVersion: rows.length > 10 ? rows[9].version : null,
        };
      }),
    );
  });
  app.get("/api/compensation/export", async (req, res) => {
    const query = compensationPair
        .extend({ format: z.enum(["csv", "json"]).default("csv") })
        .strict()
        .parse(req.query),
      actor = actorOf(req);
    const output = await payTransaction(db, actor, proofOf(req), query, async (tx, actor) => {
      const record = await pair(tx, actor, query.userId, query.jobId);
      await audit(
        tx,
        actor,
        "compensation.exported",
        record.schedule?.id ?? null,
        {
          userId: query.userId,
          jobId: query.jobId,
          version: record.schedule?.version ?? 0,
        },
      );
      const result = {
        ...record,
        asOf: new Date().toISOString(),
        notice:
          "Recorded compensation rates only. No earned wages, overtime, paid-break or PTO calculation is inferred. Effective dates include both the first and last day; a blank last day has no recorded end.",
      };
      if (query.format === "json") return JSON.stringify(result, null, 2);
    const rows = (result.schedule?.rates ?? []).map((r: Row) => ({
      userId: query.userId,
      employee: result.employee.name,
      jobId: query.jobId,
      job: result.job.title,
      unitId: result.job.unit_id,
      version: result.schedule.version,
      ...r,
      endsOn: r.endsOn ?? "",
      asOf: result.asOf,
    }));
      return toCsv(rows, [
          "userId",
          "employee",
          "jobId",
          "job",
          "unitId",
          "version",
          "id",
          "startsOn",
          "endsOn",
          "amount",
          "currency",
          "basis",
          "voided",
          "note",
          "asOf",
        ]);
    });
    res.type(query.format === "json" ? "application/json" : "text/csv")
      .attachment(query.format === "json" ? "stjw-pay-record.json" : "stjw-pay-record.csv").send(output);
  });
}
