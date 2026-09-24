import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import {
  audit,
  digest,
  manages,
  orgWide,
  canReport,
  requireCondition,
  type Actor,
} from "./security";
import { reportBounds } from "./reports";
import {
  correctionInput,
  correctionReviewInput,
  timeRecordsQuery,
  type timeSegmentInput,
} from "../shared/time-records";
import { currentTimeActor, preciseTimeSql, timeMicroseconds, timeNow, timeTransaction, timeJobs } from "./time-record-access";
import { recheckReportSession } from "./report-source-access";
type Segment = z.infer<typeof timeSegmentInput>;
const canonicalBoundary = (value: string) => timeMicroseconds(value) % 1000n === 0n ? new Date(value).toISOString() : value.replace(/(?:\.(\d+))?Z$/, (_,digits = "") => "."+digits.padEnd(6,"0")+"Z");
const password = (req: Request) => {
  const actor = (req as AppRequest).actor;
  requireCondition(
    actor.mode === "password",
    403,
    "Sign in with your password to open time records.",
  );
  return actor;
};
const session = (req: Request) => (req as AppRequest).sessionHash!;
const inst = (value: any) => typeof value === "string" ? value : new Date(value).toISOString();
function normalized(rows: Row[]): Segment[] {
  return rows.map((row) => ({
    jobId: row.job_id,
    kind: row.kind,
    startedAt: inst(row.started_at),
    endedAt: inst(row.ended_at),
  }));
}
function reviewer(actor: Actor) {
  return manages(actor);
}
async function jobsFor(tx: Queryable, actor: Actor, ids: string[]) {
  return timeJobs(tx, actor, ids);
}
function allUnits(actor: Actor, jobs: Row[]) {
  return (
    orgWide(actor) || jobs.every((job) => actor.unit_ids.includes(job.unit_id))
  );
}
async function shiftRecord(
  tx: Queryable,
  actor: Actor,
  shiftId: string,
  lock = false,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  const shift = (
    await tx.query(
      `SELECT s.*,${preciseTimeSql("s.started_at")} AS started_at,${preciseTimeSql("s.ended_at")} AS ended_at,u.name AS employee_name FROM shifts s JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id WHERE s.id=$1 AND s.org_id=$2` +
        (lock ? " FOR UPDATE OF s" : ""),
      [shiftId, actor.org_id],
    )
  ).rows[0];
  requireCondition(shift, 404, "Time record not found.");
  const rows = (
    await tx.query(
      `SELECT s.*,${preciseTimeSql("s.started_at")} AS started_at,${preciseTimeSql("s.ended_at")} AS ended_at,j.title AS job_title,j.unit_id,u.name AS unit_name FROM segments s JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id JOIN units u ON u.id=j.unit_id AND u.org_id=j.org_id WHERE s.shift_id=$1 AND s.org_id=$2 AND s.revision=$3 ORDER BY s.started_at,s.ended_at,s.id`,
      [shift.id, actor.org_id, shift.revision],
    )
  ).rows;
  const lockedJobs = await jobsFor(tx, actor, rows.map(row => row.job_id));
  requireCondition(
    shift.user_id === actor.id || (canReport(actor) && allUnits(actor, lockedJobs)),
    404,
    "Time record not found.",
  );
  return { shift, rows:rows.map((row): Row => {const job=lockedJobs.find(job=>job.id===row.job_id)!;return {...row,job_title:job.title,unit_id:job.unit_id,unit_name:job.unit_name};}) };
}
async function authorizeCorrection(tx: Queryable, actor: Actor, row: Row) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  const jobs = await jobsFor(
    tx,
    actor,
    [...row.original.segments, ...row.proposed].map(
      (segment: Segment) => segment.jobId,
    ),
  );
  requireCondition(
    row.user_id === actor.id ||
      (canReport(actor) && allUnits(actor, jobs) && (row.original.scope?.unitIds ?? []).every((id: string) => orgWide(actor) || actor.unit_ids.includes(id))),
    404,
    "Correction not found.",
  );
  return jobs;
}
export async function timeRecordDetail(
  db: Database,
  suppliedActor: Actor,
  shiftId: string,
  sessionHash: string,
) {
 return timeTransaction(db, async tx => {
  const identity = (await tx.query('SELECT user_id FROM shifts WHERE id=$1 AND org_id=$2',[shiftId,suppliedActor.org_id])).rows[0];
  requireCondition(identity,404,'Time record not found.');
  const actor = await currentTimeActor(tx, suppliedActor, sessionHash, identity.user_id);
  const { shift, rows } = await shiftRecord(tx, actor, shiftId),
    corrections = (
      await tx.query(
        "SELECT c.*,p.name AS proposer_name,r.name AS reviewer_name FROM time_corrections c JOIN users p ON p.id=c.proposed_by LEFT JOIN users r ON r.id=c.reviewed_by WHERE c.org_id=$1 AND c.shift_id=$2 ORDER BY c.created_at DESC",
        [actor.org_id, shiftId],
      )
    ).rows;
  // Historical and proposed jobs can have a wider scope than the current shift.
  const visible = [];
  for (const correction of corrections) {
    const jobs = await jobsFor(
      tx,
      actor,
      [...correction.original.segments, ...correction.proposed].map(
        (segment: Segment) => segment.jobId,
      ),
    );
    if (
      correction.user_id === actor.id ||
      (canReport(actor) && allUnits(actor, jobs) && (correction.original.scope?.unitIds ?? []).every((id: string) => orgWide(actor) || actor.unit_ids.includes(id)))
    )
      visible.push(correction);
  }
  const assigned = (
    await tx.query(
      "SELECT j.id,j.title,j.unit_id,u.name AS unit_name FROM user_jobs a JOIN jobs j ON j.id=a.job_id JOIN units u ON u.id=j.unit_id JOIN user_units m ON m.user_id=a.user_id AND m.unit_id=j.unit_id WHERE a.org_id=$1 AND a.user_id=$2 AND j.active",
      [actor.org_id, shift.user_id],
    )
  ).rows;
  const jobs = await jobsFor(tx, actor, [
    ...rows.map((row) => row.job_id),
    ...visible.flatMap((row) =>
      [...row.original.segments, ...row.proposed].map((s: Segment) => s.jobId),
    ),
  ]);
  const choices = [
    ...new Map(
      [
        ...jobs,
        ...assigned.filter(
          (job) => shift.user_id === actor.id || allUnits(actor, [job]),
        ),
      ].map((job) => [job.id, job]),
    ).values(),
  ];
  await recheckReportSession(tx, actor, sessionHash);
  return {
    shift,
    segments: rows,
    corrections: visible,
    jobs: choices,
    canPropose:
      !!shift.ended_at && (shift.user_id === actor.id || reviewer(actor)),
  };
 });
}
async function validateProposal(
  tx: Queryable,
  actor: Actor,
  record: { shift: Row; rows: Row[] },
  segments: Segment[],
) {
  const { shift, rows } = record;
  requireCondition(
    shift.ended_at,
    409,
    "Clock out before requesting a correction to this shift.",
  );
  const jobs = await jobsFor(
      tx,
      actor,
      [...rows.map(row => row.job_id),...segments.map((segment) => segment.jobId)],
    ),
    originalJobs = new Set(rows.map((row) => row.job_id));
  const assigned = (
    await tx.query(
      "SELECT a.job_id FROM user_jobs a JOIN jobs j ON j.id=a.job_id JOIN user_units m ON m.user_id=a.user_id AND m.unit_id=j.unit_id WHERE a.org_id=$1 AND a.user_id=$2 AND j.active",
      [actor.org_id, shift.user_id],
    )
  ).rows.map((row) => row.job_id);
  requireCondition(
    jobs.length === new Set([...rows.map(row => row.job_id),...segments.map((segment) => segment.jobId)]).size &&
      segments.every(
        (segment) =>
          originalJobs.has(segment.jobId) || assigned.includes(segment.jobId),
      ),
    400,
    "Choose a recorded job or an active job currently assigned to this employee.",
  );
  requireCondition(
    shift.user_id === actor.id ||
      (reviewer(actor) && allUnits(actor, [...rows, ...jobs])),
    403,
    "A manager must have access to every original and proposed unit.",
  );
  const sourceBounds = new Set(rows.flatMap(row => [row.started_at,row.ended_at]).map(value => timeMicroseconds(value).toString()));
  const now = timeMicroseconds(await timeNow(tx));
  for (const segment of segments) for (const value of [segment.startedAt,segment.endedAt])
    requireCondition(timeMicroseconds(value) % 1000n === 0n || sourceBounds.has(timeMicroseconds(value).toString()),400,'A sub-millisecond timestamp must exactly preserve a boundary in this recorded shift. Enter changed times with millisecond precision.');
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index],
      start = timeMicroseconds(segment.startedAt),
      end = timeMicroseconds(segment.endedAt);
    requireCondition(
      end >= start && end <= now,
      400,
      "Use valid completed time ranges without future timestamps.",
    );
    if (index)
      requireCondition(
        start === timeMicroseconds(segments[index - 1].endedAt),
        400,
        "Segments must be ordered and contiguous, with no gaps or overlaps.",
      );
  }
  const start = segments[0].startedAt,
    end = segments.at(-1)!.endedAt;
  requireCondition(
    !(
      await tx.query(
        "SELECT id FROM shifts WHERE org_id=$1 AND user_id=$2 AND id<>$3 AND started_at<$5 AND coalesce(ended_at,'infinity'::timestamptz)>$4",
        [actor.org_id, shift.user_id, shift.id, start, end],
      )
    ).rows.length,
    409,
    "The proposed time overlaps another shift.",
  );
  return { start, end, unitIds:[...new Set(jobs.map(job => job.unit_id))] };
}
export async function proposeCorrection(
  db: Database,
  suppliedActor: Actor,
  input: z.infer<typeof correctionInput>,
  sessionHash: string,
) {
  input = correctionInput.parse(input);
  return timeTransaction(db, async (tx) => {
    const identity = (await tx.query('SELECT user_id FROM shifts WHERE id=$1 AND org_id=$2', [input.shiftId, suppliedActor.org_id])).rows[0];
    requireCondition(identity, 404, 'Time record not found.');
    const actor = await currentTimeActor(tx, suppliedActor, sessionHash, identity.user_id, true);
    const fingerprint = digest(
      JSON.stringify({
        shiftId: input.shiftId,
        sourceRevision: input.sourceRevision,
        reason: input.reason,
        segments: input.segments.map(segment => ({...segment, startedAt: canonicalBoundary(segment.startedAt), endedAt: canonicalBoundary(segment.endedAt)})),
      }),
    );
    const previous = (
      await tx.query(
        "SELECT * FROM time_corrections WHERE org_id=$1 AND proposed_by=$2 AND command_id=$3",
        [actor.org_id, actor.id, input.commandId],
      )
    ).rows[0];
    if (previous) {
      await authorizeCorrection(tx, actor, previous);
      requireCondition(previous.user_id === actor.id || reviewer(actor),403,"Only the employee or a scoped manager may propose a correction.");
      requireCondition(
        previous.fingerprint === fingerprint,
        409,
        "This command identifier was used for a different correction.",
      );
      await recheckReportSession(tx, actor, sessionHash);
      return previous;
    }
    const observed = await shiftRecord(tx, actor, input.shiftId);
    requireCondition(
      observed.shift.user_id === actor.id || reviewer(actor),
      403,
      "Only the employee or a scoped manager may propose a correction.",
    );
    const record = await shiftRecord(tx, actor, input.shiftId, true);
    requireCondition(
      record.shift.revision === input.sourceRevision,
      409,
      "Time record changed. Reload before proposing a correction.",
    );
    const bounds = await validateProposal(tx, actor, record, input.segments);
    const comparable = (values: Segment[]) => values.map(s => [s.jobId,s.kind,timeMicroseconds(s.startedAt).toString(),timeMicroseconds(s.endedAt).toString()]);
    requireCondition(
      JSON.stringify(comparable(normalized(record.rows))) !== JSON.stringify(comparable(input.segments)),
      400,
      "Change at least one time, job or segment before submitting.",
    );
    const row = (
      await tx.query(
        "INSERT INTO time_corrections(id,org_id,shift_id,user_id,proposed_by,command_id,fingerprint,source_revision,original,proposed,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          randomUUID(),
          actor.org_id,
          input.shiftId,
          record.shift.user_id,
          actor.id,
          input.commandId,
          fingerprint,
          input.sourceRevision,
          JSON.stringify({
            shift: {
              id: record.shift.id,
              startedAt: inst(record.shift.started_at),
              endedAt: inst(record.shift.ended_at),
              revision: record.shift.revision,
            },
            segments: normalized(record.rows),
            scope: {unitIds:bounds.unitIds},
          }),
          JSON.stringify(input.segments),
          input.reason,
        ],
      )
    ).rows[0];
    await audit(tx, actor, "time_correction.proposed", row.id, {
      shiftId: input.shiftId,
      sourceRevision: input.sourceRevision,
    });
    await recheckReportSession(tx, actor, sessionHash);
    return row;
  });
}
export async function reviewCorrection(
  db: Database,
  suppliedActor: Actor,
  correctionId: string,
  input: z.infer<typeof correctionReviewInput>,
  sessionHash: string,
) {
  input = correctionReviewInput.parse(input);
  return timeTransaction(db, async (tx) => {
    const observed = (
      await tx.query(
        "SELECT * FROM time_corrections WHERE id=$1 AND org_id=$2",
        [correctionId, suppliedActor.org_id],
      )
    ).rows[0];
    requireCondition(observed, 404, "Correction not found.");
    const actor = await currentTimeActor(tx, suppliedActor, sessionHash, observed.user_id, true);
    requireCondition(reviewer(actor), 403, "Manager review required.");
    requireCondition(
      observed.proposed_by !== actor.id && observed.user_id !== actor.id,
      403,
      "A different manager must review this correction.",
    );
    const jobs = await authorizeCorrection(tx, actor, observed);
    requireCondition(
      allUnits(actor, jobs),
      403,
      "Review requires access to every original and proposed unit.",
    );
    const row = (
      await tx.query("SELECT * FROM time_corrections WHERE id=$1 FOR UPDATE", [
        correctionId,
      ])
    ).rows[0];
    if (
      row.status === input.status &&
      row.reviewed_by === actor.id &&
      row.review_note === input.note &&
      row.version === input.version + 1
    ) {
      await recheckReportSession(tx, actor, sessionHash);
      return row;
    }
    requireCondition(
      row.status === "pending" && row.version === input.version,
      409,
      "Correction was already reviewed or changed.",
    );
    if (input.status === "approved") {
      const record = await shiftRecord(tx, actor, row.shift_id, true);
      requireCondition(
        record.shift.revision === row.source_revision,
        409,
        "Another correction changed this shift. Decline this proposal and request a fresh one.",
      );
      const bounds = await validateProposal(tx, actor, record, row.proposed),
        nextRevision = record.shift.revision + 1;
      const segmentIds: string[] = row.proposed.map(() => randomUUID()).sort();
      // Preserve every previous segment; reports read the revision selected by the shift.
      for (const [index, segment] of row.proposed.entries())
        await tx.query(
          "INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            segmentIds[index],
            actor.org_id,
            row.shift_id,
            segment.jobId,
            segment.kind,
            segment.startedAt,
            segment.endedAt,
            nextRevision,
          ],
        );
      await tx.query(
        "UPDATE shifts SET started_at=$1,ended_at=$2,revision=$3 WHERE id=$4",
        [bounds.start, bounds.end, nextRevision, row.shift_id],
      );
    }
    const updated = (
      await tx.query(
        "UPDATE time_corrections SET status=$1,reviewed_by=$2,review_note=$3,reviewed_at=now(),version=version+1 WHERE id=$4 RETURNING *",
        [input.status, actor.id, input.note, correctionId],
      )
    ).rows[0];
    await audit(tx, actor, "time_correction." + input.status, correctionId, {
      shiftId: row.shift_id,
      sourceRevision: row.source_revision,
      resultRevision:
        input.status === "approved"
          ? row.source_revision + 1
          : row.source_revision,
    });
    await recheckReportSession(tx, actor, sessionHash);
    return updated;
  });
}
export function installTimeRecords(app: Express, db: Database) {
  app.get("/api/time-records", async (req, res) => {
    const suppliedActor = password(req), sessionHash = session(req), input = timeRecordsQuery.parse(req.query);
    const result = await timeTransaction(db, async tx => {
    const actor = await currentTimeActor(tx, suppliedActor, sessionHash),
      organization = (
        await tx.query("SELECT timezone FROM organizations WHERE id=$1", [
          actor.org_id,
        ])
      ).rows[0],
      bounds = reportBounds({ ...input, group: "day" }, organization.timezone);
    const rows = (
      await tx.query(
        `SELECT s.*,u.name AS employee_name,(SELECT count(*)::int FROM time_corrections c WHERE c.org_id=s.org_id AND c.shift_id=s.id AND c.status='pending'
 AND (c.user_id=$5 OR ($6::boolean AND ($7::boolean OR (
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(c.original#>'{scope,unitIds}','[]'::jsonb)) u(id) WHERE NOT u.id::uuid=ANY($8::uuid[]))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((c.original->'segments')||c.proposed) g LEFT JOIN jobs j ON j.org_id=c.org_id AND j.id=(g->>'jobId')::uuid WHERE j.id IS NULL OR NOT j.unit_id=ANY($8::uuid[]))))))) AS pending_corrections FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.org_id=$1 AND s.started_at<$3 AND coalesce(s.ended_at,'infinity'::timestamptz)>$2 AND ($4::uuid IS NULL OR s.user_id=$4) AND (s.user_id=$5 OR ($6::boolean AND ($7::boolean OR NOT EXISTS(SELECT 1 FROM segments g JOIN jobs j ON j.id=g.job_id WHERE g.shift_id=s.id AND g.revision=s.revision AND NOT j.unit_id=ANY($8::uuid[]))))) ORDER BY s.started_at DESC,s.id LIMIT 101 OFFSET $9`,
        [
          actor.org_id,
          bounds.start.toJSDate(),
          bounds.end.toJSDate(),
          input.userId ?? null,
          actor.id,
          canReport(actor),
          orgWide(actor),
          actor.unit_ids,
          input.offset,
        ],
      )
    ).rows;
    await recheckReportSession(tx, actor, sessionHash);
    return {
      rows: rows.slice(0, 100),
      hasMore: rows.length > 100,
      timezone: organization.timezone,
    };
    });
    res.json(result);
  });
  app.get("/api/time-records/:id", async (req, res) =>
    res.json(
      await timeRecordDetail(db, password(req), z.uuid().parse(req.params.id), session(req)),
    ),
  );
  app.post("/api/time-corrections", async (req, res) =>
    res
      .status(201)
      .json(
        await proposeCorrection(
          db,
          password(req),
          correctionInput.parse(req.body),
          session(req),
        ),
      ),
  );
  app.post("/api/time-corrections/:id/review", async (req, res) =>
    res.json(
      await reviewCorrection(
        db,
        password(req),
        z.uuid().parse(req.params.id),
        correctionReviewInput.parse(req.body),
        session(req),
      ),
    ),
  );
  app.post("/api/time-corrections/:id/cancel", async (req, res) => {
    const suppliedActor = password(req), sessionHash = session(req),
      id = z.uuid().parse(req.params.id),
      input = z
        .object({ version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    await timeTransaction(db, async (tx) => {
      const identity = (await tx.query('SELECT user_id FROM time_corrections WHERE id=$1 AND org_id=$2', [id, suppliedActor.org_id])).rows[0];
      requireCondition(identity, 404, 'Correction not found.');
      const actor = await currentTimeActor(tx, suppliedActor, sessionHash, identity.user_id, true);
      const row = (
        await tx.query(
          "SELECT * FROM time_corrections WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [id, actor.org_id],
        )
      ).rows[0];
      requireCondition(
        row && row.proposed_by === actor.id,
        404,
        "Correction not found.",
      );
      await authorizeCorrection(tx, actor, row);
      requireCondition(
        row.status === "pending" && row.version === input.version,
        409,
        "Correction was already reviewed or changed.",
      );
      await tx.query(
        "UPDATE time_corrections SET status='cancelled',version=version+1 WHERE id=$1",
        [id],
      );
      await audit(tx, actor, "time_correction.cancelled", id, {
        shiftId: row.shift_id,
      });
      await recheckReportSession(tx, actor, sessionHash);
    });
    res.json({ ok: true });
  });
}
