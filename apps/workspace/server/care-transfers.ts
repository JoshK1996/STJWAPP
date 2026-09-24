import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import type { Actor } from "./security";
import { digest, requireCondition } from "./security";
import type { Database, Queryable, Row } from "./db";
import { schoolActor, schoolChange, officeUnits } from "./school";
import { careProgram, checkInCareTransaction, pickupState } from "./care";
import {
  dismissalScope,
  dismissalRun,
  assertDismissalToday,
  assertDismissalRoster,
  lockDismissalChild,
  bumpDismissal,
  assertNoPendingCareTransfer,
} from "./dismissal";
import {
  transferRequestInput,
  transferDecisionInput,
} from "../shared/care-transfers";

async function receiver(tx: Queryable, actor: Actor, programId: string) {
  const program = await careProgram(tx, actor, programId, true);
  requireCondition(
    actor.unit_ids.includes(program.unit_id) &&
      (
        await tx.query(
          "SELECT s.user_id FROM care_staff s JOIN user_units n ON n.user_id=s.user_id AND n.unit_id=s.unit_id AND n.org_id=s.org_id WHERE s.org_id=$1 AND s.program_id=$2 AND s.user_id=$3 FOR SHARE OF s,n",
          [actor.org_id, program.id, actor.id],
        )
      ).rows.length,
    403,
    "Only a currently assigned care staff member can confirm physical receipt in their own account.",
  );
  return program;
}
async function rawTransfer(tx: Queryable, actor: Actor, id: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  const transfer = (
    await tx.query("SELECT * FROM care_transfers WHERE id=$1 AND org_id=$2", [
      id,
      actor.org_id,
    ])
  ).rows[0];
  requireCondition(transfer, 404, "Care handoff not found.");
  const run = (
    await tx.query(
      "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM dismissal_runs WHERE id=$1 AND org_id=$2 FOR UPDATE",
      [transfer.run_id, actor.org_id],
    )
  ).rows[0];
  return { transfer, run };
}
async function decisionAccess(
  tx: Queryable,
  actor: Actor,
  id: string,
  action: "accept" | "cancel",
) {
  const { transfer, run } = await rawTransfer(tx, actor, id);
  if (action === "accept") await receiver(tx, actor, transfer.program_id);
  else {
    const offices = await officeUnits(tx, actor),
      assigned =
        actor.unit_ids.includes(transfer.unit_id) &&
        (
          await tx.query(
            "SELECT user_id FROM dismissal_staff WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
            [actor.org_id, transfer.unit_id, actor.id],
          )
        ).rows.length > 0;
    if (!offices.includes(transfer.unit_id) && !assigned)
      await receiver(tx, actor, transfer.program_id);
  }
  // Re-read under the run lock: another receiver may have completed while this request waited.
  return {
    run,
    transfer: (
      await tx.query("SELECT * FROM care_transfers WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0],
  };
}
async function command<T>(
  db: Database,
  actor: Actor,
  commandId: string,
  input: unknown,
  authorize: (tx: Queryable) => Promise<unknown>,
  execute: (tx: Queryable) => Promise<T>,
) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.org_id + actor.id + commandId,
    ]);
    await authorize(tx);
    const fingerprint = digest(JSON.stringify(input)),
      old = (
        await tx.query(
          "SELECT fingerprint,result FROM care_transfer_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
          [actor.org_id, actor.id, commandId],
        )
      ).rows[0];
    if (old) {
      requireCondition(
        old.fingerprint === fingerprint,
        409,
        "Command already used for different information.",
      );
      return old.result as T;
    }
    const result = await execute(tx);
    await tx.query(
      "INSERT INTO care_transfer_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [actor.org_id, actor.id, commandId, fingerprint, JSON.stringify(result)],
    );
    return result;
  });
}
async function noHold(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  day: string,
) {
  const pickup = await pickupState(tx, actor, studentId, day);
  requireCondition(
    !pickup.hold.active && !pickup.restricted,
    409,
    "A child hold or contact restriction requires school-office review before this handoff.",
  );
}
export async function requestCareTransfer(
  db: Database,
  actor: Actor,
  runId: string,
  studentId: string,
  raw: unknown,
) {
  const input = transferRequestInput.parse(raw);
  return command(
    db,
    actor,
    input.commandId,
    { runId, studentId, ...input },
    (tx) => dismissalRun(tx, actor, runId),
    async (tx) => {
      const run = await dismissalRun(tx, actor, runId),
        now = await assertDismissalToday(tx, actor, run);
      await assertDismissalRoster(tx, actor, run);
      const entry = (
        await tx.query(
          "SELECT * FROM dismissal_entries WHERE org_id=$1 AND run_id=$2 AND student_id=$3",
          [actor.org_id, runId, studentId],
        )
      ).rows[0];
      requireCondition(
        entry?.expected && entry.version === input.version,
        409,
        "The child record changed. Refresh before requesting care.",
      );
      requireCondition(
        entry.status === "present" &&
          entry.mode === "care" &&
          entry.care_program_id,
        409,
        "The child must be present with an office-assigned care plan.",
      );
      const program = (
        await tx.query(
          "SELECT * FROM care_programs WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR UPDATE",
          [actor.org_id, run.unit_id, entry.care_program_id],
        )
      ).rows[0];
      requireCondition(
        program?.confirmed &&
          !program.archived &&
          program.version === input.programVersion,
        409,
        "Care instructions changed or the program is unavailable. Ask the office to review the plan.",
      );
      await lockDismissalChild(tx, actor, studentId, run.unit_id);
      await assertNoPendingCareTransfer(tx, actor, runId, studentId);
      await noHold(tx, actor, studentId, now.day);
      requireCondition(
        (
          await tx.query(
            "SELECT student_id FROM care_enrollments WHERE program_id=$1 AND student_id=$2 AND enabled AND $3::date BETWEEN starts_on AND ends_on",
            [program.id, studentId, now.day],
          )
        ).rows.length,
        409,
        "Current care enrollment is required.",
      );
      requireCondition(
        (
          await tx.query(
            "SELECT s.user_id FROM care_staff s JOIN users u ON u.id=s.user_id JOIN user_units n ON n.user_id=u.id AND n.unit_id=s.unit_id WHERE s.program_id=$1 AND u.active AND u.id<>$2 LIMIT 1",
            [program.id, actor.id],
          )
        ).rows.length,
        409,
        "Assign another active care staff member to receive this handoff first.",
      );
      requireCondition(
        !(
          await tx.query(
            "SELECT id FROM care_sessions WHERE org_id=$1 AND student_id=$2 AND checked_out_at IS NULL",
            [actor.org_id, studentId],
          )
        ).rows.length,
        409,
        "This child is already in care. Ask the office to review the records.",
      );
      const transfer = (
        await tx.query(
          "INSERT INTO care_transfers(id,org_id,unit_id,run_id,student_id,program_id,program_version,student_name,student_number,program_snapshot,requested_by,requester_name,requested_at,request_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            run.unit_id,
            runId,
            studentId,
            program.id,
            program.version,
            entry.student_name,
            entry.student_number,
            JSON.stringify({
              name: program.name,
              room: program.room,
              instructions: program.instructions,
              capacity: program.capacity,
              version: program.version,
            }),
            actor.id,
            actor.name,
            now.at,
            input.reason,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE dismissal_entries SET version=version+1 WHERE run_id=$1 AND student_id=$2",
        [runId, studentId],
      );
      await bumpDismissal(tx, run);
      await schoolChange(
        tx,
        actor,
        run.unit_id,
        "care.transfer_requested",
        transfer.id,
        null,
        transfer,
      );
      return { id: transfer.id };
    },
  );
}
export async function decideCareTransfer(
  db: Database,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = transferDecisionInput.parse(raw);
  return command(
    db,
    actor,
    input.commandId,
    { id, ...input },
    (tx) => decisionAccess(tx, actor, id, input.action),
    async (tx) => {
      const { run, transfer } = await decisionAccess(
        tx,
        actor,
        id,
        input.action,
      );
      requireCondition(
        transfer.status === "pending" && transfer.version === input.version,
        409,
        "This handoff was already resolved. Refresh the queue.",
      );
      if (input.action === "cancel") {
        const now = (await tx.query("SELECT clock_timestamp() AS at")).rows[0]
          .at;
        const result = (
          await tx.query(
            "UPDATE care_transfers SET status='canceled',version=2,completed_by=$1,completed_at=$2,completion_snapshot=$3 WHERE id=$4 RETURNING *",
            [
              actor.id,
              now,
              JSON.stringify({
                actorId: actor.id,
                actorName: actor.name,
                reason: input.reason,
              }),
              id,
            ],
          )
        ).rows[0];
        await tx.query(
          "UPDATE dismissal_entries SET version=version+1 WHERE run_id=$1 AND student_id=$2",
          [run.id, transfer.student_id],
        );
        await bumpDismissal(tx, run);
        await schoolChange(
          tx,
          actor,
          run.unit_id,
          "care.transfer_canceled",
          id,
          transfer,
          result,
        );
        return { id, status: result.status, careSessionId: null };
      }
      requireCondition(
        transfer.requested_by !== actor.id,
        403,
        "The requesting account cannot confirm receipt. A different assigned care staff member must receive this child.",
      );
      const now = await assertDismissalToday(tx, actor, run);
      await assertDismissalRoster(tx, actor, run);
      const program = await receiver(tx, actor, transfer.program_id);
      requireCondition(
        program.version === transfer.program_version &&
          program.version === input.programVersion,
        409,
        "Care instructions changed. Cancel this request and arrange a new handoff after review.",
      );
      await lockDismissalChild(tx, actor, transfer.student_id, run.unit_id);
      const entry = (
        await tx.query(
          "SELECT * FROM dismissal_entries WHERE run_id=$1 AND student_id=$2 FOR UPDATE",
          [run.id, transfer.student_id],
        )
      ).rows[0];
      requireCondition(
        entry.expected &&
          entry.status === "present" &&
          entry.mode === "care" &&
          entry.care_program_id === program.id,
        409,
        "Dismissal no longer matches this handoff. Ask the office to review it.",
      );
      await noHold(tx, actor, entry.student_id, now.day);
      const session = await checkInCareTransaction(
        tx,
        actor,
        {
          programId: program.id,
          programVersion: input.programVersion,
          studentId: entry.student_id,
          arrivalName: transfer.requester_name,
          received: true,
          commandId: input.commandId,
        },
        {
          transferId: id,
          runId: run.id,
          requesterId: transfer.requested_by,
          requesterName: transfer.requester_name,
        },
      );
      requireCondition(
        DateTime.fromISO(session.checkedInAt)
          .setZone(now.timezone)
          .toISODate() === run.day,
        409,
        "The school day changed during this handoff. Refresh and ask the office to review it.",
      );
      const snapshot = {
        method: "care",
        transferId: id,
        programId: program.id,
        programName: program.name,
        programVersion: program.version,
        careSessionId: session.id,
        requesterId: transfer.requested_by,
        requesterName: transfer.requester_name,
        requestedAt: transfer.requested_at,
        receiverId: actor.id,
        receiverName: actor.name,
        received: true,
        receivedAt: session.checkedInAt,
        note: input.note,
      };
      const completed = (
        await tx.query(
          "UPDATE care_transfers SET status='accepted',version=2,completed_by=$1,completed_at=$2,completion_snapshot=$3,care_session_id=$4 WHERE id=$5 RETURNING *",
          [
            actor.id,
            session.checkedInAt,
            JSON.stringify(snapshot),
            session.id,
            id,
          ],
        )
      ).rows[0];
      const released = (
        await tx.query(
          "UPDATE dismissal_entries SET status='released',care_session_id=$1,release_snapshot=$2,released_at=$3,released_by=$4,version=version+1 WHERE run_id=$5 AND student_id=$6 RETURNING *",
          [
            session.id,
            JSON.stringify(snapshot),
            session.checkedInAt,
            actor.id,
            run.id,
            entry.student_id,
          ],
        )
      ).rows[0];
      await bumpDismissal(tx, run);
      await schoolChange(
        tx,
        actor,
        run.unit_id,
        "care.transfer_accepted",
        id,
        transfer,
        completed,
      );
      await schoolChange(
        tx,
        actor,
        run.unit_id,
        "dismissal.care_received",
        entry.student_id,
        entry,
        released,
      );
      return { id, status: "accepted", careSessionId: session.id };
    },
  );
}
export function installCareTransfers(app: Express, db: Database) {
  app.post(
    "/api/dismissal/runs/:id/entries/:studentId/care-transfer",
    async (req, res) =>
      res.json(
        await requestCareTransfer(
          db,
          schoolActor(req),
          z.uuid().parse(req.params.id),
          z.uuid().parse(req.params.studentId),
          req.body,
        ),
      ),
  );
  app.post("/api/care/transfers/:id/decision", async (req, res) =>
    res.json(
      await decideCareTransfer(
        db,
        schoolActor(req),
        z.uuid().parse(req.params.id),
        req.body,
      ),
    ),
  );
  app.get("/api/care/programs/:id/transfers", async (req, res) => {
    const actor = schoolActor(req),
      program = await careProgram(db, actor, z.uuid().parse(req.params.id));
    const canReceive =
      actor.unit_ids.includes(program.unit_id) &&
      (
        await db.query(
          "SELECT user_id FROM care_staff WHERE program_id=$1 AND user_id=$2 AND org_id=$3",
          [program.id, actor.id, actor.org_id],
        )
      ).rows.length > 0;
    const rows = (
      await db.query(
        "SELECT t.*,to_char(r.day,'YYYY-MM-DD') AS dismissal_day FROM care_transfers t JOIN dismissal_runs r ON r.id=t.run_id WHERE t.org_id=$1 AND t.program_id=$2 AND t.status='pending' ORDER BY t.requested_at,t.id LIMIT 1001",
        [actor.org_id, program.id],
      )
    ).rows;
    requireCondition(
      rows.length <= 1000,
      400,
      "More than 1,000 care handoffs are pending. Ask the office to resolve older requests before continuing.",
    );
    res.json({ program, canReceive, rows });
  });
}
