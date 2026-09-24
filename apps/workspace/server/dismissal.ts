import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import { schoolActor, officeUnits, assertOffice, schoolChange } from "./school";
import { pickupState, careProgram } from "./care";
import { toCsv } from "./reports";
import {
  dismissalSettingsInput,
  dismissalOpenInput,
  dismissalPlanInput,
  dismissalBusInput,
  dismissalBusArrivalInput,
  dismissalEntryInput,
  dismissalReconcileInput,
  dismissalReviewInput,
} from "../shared/dismissal";
const id = (value: unknown) => z.uuid().parse(value);
async function moment(tx: Queryable, actor: Actor) {
  const row = (
    await tx.query(
      "SELECT clock_timestamp() AS instant,timezone FROM organizations WHERE id=$1",
      [actor.org_id],
    )
  ).rows[0];
  const at = new Date(row.instant).toISOString();
  return {
    at,
    timezone: row.timezone,
    day: DateTime.fromISO(at).setZone(row.timezone).toISODate()!,
  };
}
async function settings(
  tx: Queryable,
  actor: Actor,
  unitId: string,
): Promise<Row & { staff: Row[] }> {
  const row = (
    await tx.query(
      "SELECT * FROM dismissal_settings WHERE org_id=$1 AND unit_id=$2",
      [actor.org_id, unitId],
    )
  ).rows[0] ?? {
    org_id: actor.org_id,
    unit_id: unitId,
    version: 0,
    confirmed: false,
    instructions: "",
  };
  const staff = (
    await tx.query(
      "SELECT d.user_id,u.name,u.active FROM dismissal_staff d JOIN users u ON u.id=d.user_id WHERE d.org_id=$1 AND d.unit_id=$2 ORDER BY u.name",
      [actor.org_id, unitId],
    )
  ).rows;
  return { ...row, staff };
}
async function scope(tx: Queryable, actor: Actor, unitId: string) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in required.",
  );
  const office = (await officeUnits(tx, actor)).includes(unitId);
  const assigned =
    actor.unit_ids.includes(unitId) &&
    (
      await tx.query(
        "SELECT user_id FROM dismissal_staff WHERE org_id=$1 AND unit_id=$2 AND user_id=$3",
        [actor.org_id, unitId, actor.id],
      )
    ).rows.length > 0;
  requireCondition(
    office || assigned,
    403,
    "Dismissal assignment or school office access required.",
  );
  return office;
}
async function runById(
  tx: Queryable,
  actor: Actor,
  runId: string,
): Promise<Row & { office: boolean }> {
  const row = (
    await tx.query(
      "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM dismissal_runs WHERE org_id=$1 AND id=$2 FOR UPDATE",
      [actor.org_id, runId],
    )
  ).rows[0];
  requireCondition(row, 404, "Dismissal day not found.");
  return { ...row, office: await scope(tx, actor, row.unit_id) };
}
async function sourceRoster(tx: Queryable, actor: Actor, run: Row) {
  const rows = (
    await tx.query(
      "SELECT s.id AS student_id,s.student_number,p.name AS student_name,e.grade_level,e.id AS enrollment_id,e.version AS enrollment_version,to_char(e.starts_on,'YYYY-MM-DD') AS starts_on,to_char(e.ends_on,'YYYY-MM-DD') AS ends_on FROM student_enrollments e JOIN students s ON s.id=e.student_id JOIN school_people p ON p.id=s.person_id WHERE e.org_id=$1 AND e.unit_id=$2 AND e.year_id=$3 AND $4::date BETWEEN e.starts_on AND e.ends_on ORDER BY s.id LIMIT 1001",
      [actor.org_id, run.unit_id, run.year_id, run.day],
    )
  ).rows;
  requireCondition(
    rows.length <= 1000,
    400,
    "This dismissal unit exceeds 1,000 enrolled students. Split the operational unit before opening dismissal.",
  );
  return { rows, fingerprint: digest(JSON.stringify(rows)) };
}
async function records(tx: Queryable, actor: Actor, runId: string) {
  return (
    await tx.query(
      "SELECT * FROM dismissal_entries WHERE org_id=$1 AND run_id=$2 ORDER BY student_name,student_id",
      [actor.org_id, runId],
    )
  ).rows;
}
async function buses(tx: Queryable, actor: Actor, runId: string) {
  return (
    await tx.query(
      "SELECT * FROM dismissal_buses WHERE org_id=$1 AND run_id=$2 ORDER BY name,id",
      [actor.org_id, runId],
    )
  ).rows;
}
async function assertOpenToday(tx: Queryable, actor: Actor, run: Row) {
  const now = await moment(tx, actor);
  requireCondition(run.status === "open", 409, "This dismissal day is closed.");
  requireCondition(
    run.day === now.day,
    409,
    "Physical dismissal actions are only available for today in the organization timezone.",
  );
  return now;
}
async function assertCurrentRoster(tx: Queryable, actor: Actor, run: Row) {
  const source = await sourceRoster(tx, actor, run);
  requireCondition(
    source.fingerprint === run.roster_fingerprint,
    409,
    "School enrollment changed. The office must reconcile this dismissal roster before continuing.",
  );
  return source;
}
async function bump(tx: Queryable, run: Row) {
  await tx.query("UPDATE dismissal_runs SET version=version+1 WHERE id=$1", [
    run.id,
  ]);
}
async function childLock(
  tx: Queryable,
  actor: Actor,
  studentId: string,
  unitId: string,
) {
  const row = (
    await tx.query(
      "SELECT id FROM students WHERE org_id=$1 AND unit_id=$2 AND id=$3 FOR UPDATE",
      [actor.org_id, unitId, studentId],
    )
  ).rows[0];
  requireCondition(row, 404, "Student not found.");
}
async function notInCare(tx: Queryable, actor: Actor, studentId: string) {
  requireCondition(
    !(
      await tx.query(
        "SELECT id FROM care_sessions WHERE org_id=$1 AND student_id=$2 AND checked_out_at IS NULL",
        [actor.org_id, studentId],
      )
    ).rows.length,
    409,
    "This child is currently in childcare. Resolve the care handoff before a school dismissal action.",
  );
}
export async function assertNoPendingCareTransfer(
  tx: Queryable,
  actor: Actor,
  runId: string,
  studentId: string,
) {
  requireCondition(
    !(
      await tx.query(
        "SELECT id FROM care_transfers WHERE org_id=$1 AND run_id=$2 AND student_id=$3 AND status='pending'",
        [actor.org_id, runId, studentId],
      )
    ).rows.length,
    409,
    "A care handoff is pending. Cancel it before changing this dismissal record.",
  );
}
async function command<T>(
  db: Database,
  actor: Actor,
  commandId: string,
  input: unknown,
  authorize: (tx: Queryable) => Promise<unknown>,
  execute: (tx: Queryable) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.org_id + actor.id + commandId,
    ]);
    await authorize(tx);
    const fingerprint = digest(JSON.stringify(input)),
      old = (
        await tx.query(
          "SELECT fingerprint,result FROM dismissal_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
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
      "INSERT INTO dismissal_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [actor.org_id, actor.id, commandId, fingerprint, JSON.stringify(result)],
    );
    return result;
  });
}
export async function openDismissal(
  db: Database,
  actor: Actor,
  input: z.infer<typeof dismissalOpenInput>,
) {
  return command(
    db,
    actor,
    input.commandId,
    { action: "open", ...input },
    (tx) => assertOffice(tx, actor, input.unitId),
    async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "dismissal-settings:" + actor.org_id + input.unitId,
      ]);
      const now = await moment(tx, actor);
      requireCondition(
        input.day === now.day,
        400,
        "Open dismissal for today in the organization timezone.",
      );
      const existing = (
        await tx.query(
          "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM dismissal_runs WHERE org_id=$1 AND unit_id=$2 AND day=$3",
          [actor.org_id, input.unitId, input.day],
        )
      ).rows[0];
      if (existing) {
        requireCondition(
          existing.year_id === input.yearId,
          409,
          "A dismissal run already exists for another school year on this day.",
        );
        return existing;
      }
      const policy = await settings(tx, actor, input.unitId);
      requireCondition(
        policy.confirmed && policy.version === input.settingsVersion,
        409,
        "Confirm and review the current dismissal instructions first.",
      );
      const year = (
        await tx.query(
          "SELECT id FROM school_years WHERE org_id=$1 AND unit_id=$2 AND id=$3 AND NOT archived AND $4::date BETWEEN starts_on AND ends_on",
          [actor.org_id, input.unitId, input.yearId, input.day],
        )
      ).rows[0];
      requireCondition(
        year,
        400,
        "Choose an active school year containing today.",
      );
      const source = await sourceRoster(tx, actor, {
        unit_id: input.unitId,
        year_id: input.yearId,
        day: input.day,
      });
      requireCondition(
        source.rows.length > 0,
        409,
        "No dated school enrollment for this day.",
      );
      const run = (
        await tx.query(
          "INSERT INTO dismissal_runs(id,org_id,unit_id,year_id,day,status,policy_snapshot,roster_fingerprint,created_by) VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8) RETURNING *",
          [
            randomUUID(),
            actor.org_id,
            input.unitId,
            input.yearId,
            input.day,
            JSON.stringify({
              instructions: policy.instructions,
              version: policy.version,
            }),
            source.fingerprint,
            actor.id,
          ],
        )
      ).rows[0];
      for (const row of source.rows)
        await tx.query(
          "INSERT INTO dismissal_entries(org_id,unit_id,run_id,student_id,student_name,student_number,grade_level) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            actor.org_id,
            input.unitId,
            run.id,
            row.student_id,
            row.student_name,
            row.student_number,
            row.grade_level,
          ],
        );
      await schoolChange(
        tx,
        actor,
        input.unitId,
        "dismissal.opened",
        run.id,
        null,
        { ...run, roster: source.rows },
      );
      return run;
    },
  );
}
export async function dismissalDetail(
  tx: Queryable,
  actor: Actor,
  runId: string,
) {
  const run = await runById(tx, actor, runId),
    source = await sourceRoster(tx, actor, run),
    entries = await records(tx, actor, run.id),
    routes = await buses(tx, actor, run.id),
    now = await moment(tx, actor);
  const counts = {
    expected: 0,
    unaccounted: 0,
    present: 0,
    called: 0,
    released: 0,
    absent: 0,
    inCare: 0,
  };
  for (const r of entries)
    if (r.expected) {
      counts.expected++;
      counts[
        r.status as "unaccounted" | "present" | "called" | "released" | "absent"
      ]++;
      if (r.status === "released" && r.mode === "care") counts.inCare++;
    }
  const closures = (
    await tx.query(
      "SELECT id,run_version,created_at,reason FROM dismissal_closures WHERE org_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 50",
      [actor.org_id, run.id],
    )
  ).rows;
  return {
    run,
    entries,
    buses: routes,
    counts,
    closures,
    rosterCurrent: source.fingerprint === run.roster_fingerprint,
    rosterFingerprint: source.fingerprint,
    asOf: now.at,
    timezone: now.timezone,
    today: now.day,
    transfers: (
      await tx.query(
        "SELECT * FROM care_transfers WHERE org_id=$1 AND run_id=$2 ORDER BY requested_at,id",
        [actor.org_id, run.id],
      )
    ).rows,
    carePrograms: (
      await tx.query(
        "SELECT id,name,room,instructions,capacity,version,confirmed,archived FROM care_programs WHERE org_id=$1 AND unit_id=$2 AND ($3::boolean OR id IN (SELECT care_program_id FROM dismissal_entries WHERE run_id=$4)) ORDER BY archived,name,id",
        [actor.org_id, run.unit_id, run.office, run.id],
      )
    ).rows,
  };
}
export async function saveDismissalPlans(
  db: Database,
  actor: Actor,
  runId: string,
  input: z.infer<typeof dismissalPlanInput>,
) {
  return db.transaction(async (tx) => {
    const run = await runById(tx, actor, runId);
    await assertOffice(tx, actor, run.unit_id);
    const now = await assertOpenToday(tx, actor, run);
    await assertCurrentRoster(tx, actor, run);
    if (input.careProgramId) {
      const program = await careProgram(tx, actor, input.careProgramId, true);
      requireCondition(
        program.unit_id === run.unit_id &&
          program.confirmed &&
          !program.archived,
        409,
        "Choose a confirmed active care program in this dismissal unit.",
      );
    }
    if (input.busId)
      requireCondition(
        (
          await tx.query(
            "SELECT id FROM dismissal_buses WHERE id=$1 AND org_id=$2 AND run_id=$3",
            [input.busId, actor.org_id, runId],
          )
        ).rows.length,
        404,
        "Bus not found on this dismissal day.",
      );
    const rows = await records(tx, actor, runId);
    for (const wanted of input.entries) {
      await assertNoPendingCareTransfer(tx, actor, runId, wanted.studentId);
      if (input.careProgramId)
        requireCondition(
          (
            await tx.query(
              "SELECT student_id FROM care_enrollments WHERE program_id=$1 AND student_id=$2 AND enabled AND $3::date BETWEEN starts_on AND ends_on",
              [input.careProgramId, wanted.studentId, now.day],
            )
          ).rows.length,
          409,
          "Every selected child needs a current enrollment in this care program.",
        );
      const old = rows.find((r) => r.student_id === wanted.studentId);
      requireCondition(
        old?.expected && old.version === wanted.version,
        409,
        "One or more child records changed. Refresh and review the selection.",
      );
      requireCondition(
        !["released", "absent"].includes(old.status),
        409,
        "Resolved children cannot have their plan changed.",
      );
      const updated = (
        await tx.query(
          "UPDATE dismissal_entries SET mode=$1,bus_id=$2,care_program_id=$5,status=CASE WHEN status='called' THEN 'present' ELSE status END,called_contact_id=NULL,call_snapshot=NULL,version=version+1 WHERE run_id=$3 AND student_id=$4 RETURNING *",
          [input.mode, input.busId, runId, old.student_id, input.careProgramId],
        )
      ).rows[0];
      await schoolChange(
        tx,
        actor,
        run.unit_id,
        "dismissal.plan_saved",
        old.student_id,
        old,
        { ...updated, reason: input.reason },
      );
    }
    await bump(tx, run);
    return { ok: true };
  });
}
export async function dismissalAction(
  db: Database,
  actor: Actor,
  runId: string,
  studentId: string,
  input: z.infer<typeof dismissalEntryInput>,
) {
  return command(
    db,
    actor,
    input.commandId,
    { runId, studentId, ...input },
    (tx) => runById(tx, actor, runId),
    async (tx) => {
      const run = await runById(tx, actor, runId),
        now = await assertOpenToday(tx, actor, run);
      if (!["absent", "cancel_call"].includes(input.action))
        await assertCurrentRoster(tx, actor, run);
      await childLock(tx, actor, studentId, run.unit_id);
      await assertNoPendingCareTransfer(tx, actor, runId, studentId);
      const entry = (
        await tx.query(
          "SELECT * FROM dismissal_entries WHERE org_id=$1 AND run_id=$2 AND student_id=$3 FOR UPDATE",
          [actor.org_id, runId, studentId],
        )
      ).rows[0];
      requireCondition(entry?.expected, 404, "Expected child not found.");
      requireCondition(
        entry.version === input.version,
        409,
        "This child’s dismissal record changed. Refresh before acting.",
      );
      requireCondition(
        entry.status !== "released",
        409,
        "This child has already been released.",
      );
      let status = entry.status,
        contactId = entry.called_contact_id,
        call = entry.call_snapshot,
        release: unknown = null,
        releasedAt: string | null = null,
        absence = entry.absence_reason;
      if (input.action === "present") {
        requireCondition(
          ["unaccounted", "absent"].includes(status),
          409,
          "Presence is already recorded.",
        );
        if (status === "absent") await assertOffice(tx, actor, run.unit_id);
        await notInCare(tx, actor, studentId);
        status = "present";
        absence = "";
      }
      if (input.action === "absent") {
        await assertOffice(tx, actor, run.unit_id);
        requireCondition(
          status !== "called",
          409,
          "Cancel the call before resolving absence.",
        );
        status = "absent";
        absence = input.reason;
        contactId = null;
        call = null;
      }
      if (input.action === "cancel_call") {
        requireCondition(
          status === "called",
          409,
          "This child is not in the call queue.",
        );
        status = "present";
        contactId = null;
        call = null;
      }
      if (
        input.action === "call" ||
        input.action === "release_pickup" ||
        input.action === "release_bus"
      ) {
        requireCondition(
          entry.mode !== "care",
          409,
          "Care handoffs require a receiving staff confirmation in Childcare.",
        );
        await notInCare(tx, actor, studentId);
        const pickup = await pickupState(tx, actor, studentId, now.day);
        requireCondition(
          !pickup.hold.active && !pickup.restricted,
          409,
          "Pickup is blocked by a child hold or contact restriction. Ask the school office to resolve it.",
        );
        requireCondition(
          entry.mode,
          409,
          "The office must set this child’s dismissal plan.",
        );
        if (input.action === "call") {
          requireCondition(
            status === "present",
            409,
            "Confirm this child’s presence before calling.",
          );
          if (entry.mode === "pickup") {
            const contact = pickup.contacts.find(
              (c) => c.person_id === input.contactId,
            );
            requireCondition(
              contact?.eligible,
              409,
              "Select a currently permitted pickup person.",
            );
            contactId = contact.person_id;
            call = {
              at: now.at,
              actorId: actor.id,
              arrivalObserved: true,
              contactId: contact.person_id,
              name: contact.name,
              contactVersion: contact.version,
              personVersion: contact.person_version,
            };
          } else {
            const bus = (
              await tx.query(
                "SELECT * FROM dismissal_buses WHERE id=$1 AND run_id=$2",
                [entry.bus_id, runId],
              )
            ).rows[0];
            requireCondition(
              bus?.arrived_at,
              409,
              "The bus driver and vehicle must be verified as arrived first.",
            );
            contactId = null;
            call = {
              at: now.at,
              actorId: actor.id,
              arrivalObserved: true,
              busId: bus.id,
              busVersion: bus.version,
            };
          }
          status = "called";
        } else {
          requireCondition(
            status === "called",
            409,
            "Call the child after arrival is observed, then verify the handoff.",
          );
          if (input.action === "release_pickup") {
            requireCondition(
              entry.mode === "pickup" &&
                entry.called_contact_id === input.contactId,
              409,
              "The collecting person must match this child’s call. Cancel and call again if pickup changed.",
            );
            const c = pickup.contacts.find(
              (c) => c.person_id === input.contactId,
            );
            requireCondition(
              c?.eligible &&
                c.version === input.contactVersion &&
                c.person_version === input.personVersion,
              409,
              "Pickup permission or identity changed. Refresh and verify again.",
            );
            release = {
              method: "pickup",
              personId: c.person_id,
              name: c.name,
              relationship: c.relationship,
              contactVersion: c.version,
              personVersion: c.person_version,
              pickupUntil: c.pickup_until,
              identityMethod: input.identityMethod,
              identityConfirmed: true,
              released: true,
              note: input.note,
            };
          } else {
            requireCondition(
              entry.mode === "bus",
              409,
              "This child does not have a bus plan.",
            );
            const bus = (
              await tx.query(
                "SELECT * FROM dismissal_buses WHERE id=$1 AND run_id=$2",
                [entry.bus_id, runId],
              )
            ).rows[0];
            requireCondition(
              bus?.arrived_at &&
                bus.version === input.busVersion &&
                entry.call_snapshot?.busVersion === bus.version,
              409,
              "The bus changed. Cancel the call and verify the current arrival before boarding.",
            );
            release = {
              method: "bus",
              busId: bus.id,
              busName: bus.name,
              busVersion: bus.version,
              driverName: bus.driver_name,
              vehicle: bus.vehicle,
              arrival: bus.arrival_snapshot,
              boarded: true,
              note: input.note,
            };
          }
          status = "released";
          releasedAt = now.at;
        }
      }
      const result = (
        await tx.query(
          "UPDATE dismissal_entries SET status=$1,called_contact_id=$2,call_snapshot=$3,release_snapshot=$4,released_at=$5,released_by=$6,absence_reason=$7,version=version+1 WHERE run_id=$8 AND student_id=$9 RETURNING *",
          [
            status,
            contactId,
            call ? JSON.stringify(call) : null,
            release ? JSON.stringify(release) : null,
            releasedAt,
            releasedAt ? actor.id : null,
            absence,
            runId,
            studentId,
          ],
        )
      ).rows[0];
      await bump(tx, run);
      await schoolChange(
        tx,
        actor,
        run.unit_id,
        "dismissal." + input.action,
        studentId,
        entry,
        { ...result, reason: "reason" in input ? input.reason : undefined },
      );
      return result;
    },
  );
}
export function installDismissal(app: Express, db: Database) {
  app.get("/api/dismissal/access", async (req, res) => {
    const actor = schoolActor(req),
      offices = await officeUnits(db, actor);
    const units = (
      await db.query(
        "SELECT id,name,kind FROM units WHERE org_id=$1 AND (id=ANY($2::uuid[]) OR (id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM dismissal_staff d WHERE d.unit_id=units.id AND d.user_id=$4))) ORDER BY name",
        [actor.org_id, offices, actor.unit_ids, actor.id],
      )
    ).rows;
    res.json({ units, officeUnits: offices });
  });
  app.get("/api/dismissal/settings", async (req, res) => {
    const actor = schoolActor(req),
      unitId = id(req.query.unitId);
    await scope(db, actor, unitId);
    res.json(await settings(db, actor, unitId));
  });
  app.put("/api/dismissal/settings", async (req, res) => {
    const actor = schoolActor(req),
      input = dismissalSettingsInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        await assertOffice(tx, actor, input.unitId);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "dismissal-settings:" + actor.org_id + input.unitId,
        ]);
        const old = await settings(tx, actor, input.unitId);
        requireCondition(
          old.version === input.version,
          409,
          "Dismissal configuration changed. Refresh first.",
        );
        const staff = (
          await tx.query(
            "SELECT u.id FROM users u JOIN user_units n ON n.user_id=u.id AND n.org_id=u.org_id WHERE u.org_id=$1 AND n.unit_id=$2 AND u.active AND u.id=ANY($3::uuid[])",
            [actor.org_id, input.unitId, input.staffIds],
          )
        ).rows;
        requireCondition(
          staff.length === input.staffIds.length,
          400,
          "Select active staff in this unit.",
        );
        const result = (
          await tx.query(
            "INSERT INTO dismissal_settings(org_id,unit_id,confirmed,instructions) VALUES($1,$2,$3,$4) ON CONFLICT(unit_id) DO UPDATE SET confirmed=EXCLUDED.confirmed,instructions=EXCLUDED.instructions,version=dismissal_settings.version+1 RETURNING *",
            [actor.org_id, input.unitId, input.confirmed, input.instructions],
          )
        ).rows[0];
        await tx.query(
          "DELETE FROM dismissal_staff WHERE org_id=$1 AND unit_id=$2",
          [actor.org_id, input.unitId],
        );
        for (const userId of input.staffIds)
          await tx.query(
            "INSERT INTO dismissal_staff(org_id,unit_id,user_id) VALUES($1,$2,$3)",
            [actor.org_id, input.unitId, userId],
          );
        await schoolChange(
          tx,
          actor,
          input.unitId,
          "dismissal.settings_saved",
          input.unitId,
          old,
          { ...result, staffIds: input.staffIds, reason: input.reason },
        );
        return result;
      }),
    );
  });
  app.get("/api/dismissal/runs", async (req, res) => {
    const actor = schoolActor(req),
      query = z
        .object({
          unitId: z.uuid(),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .strict()
        .parse(req.query);
    await scope(db, actor, query.unitId);
    const rows = (
      await db.query(
        "SELECT *,to_char(day,'YYYY-MM-DD') AS day FROM dismissal_runs WHERE org_id=$1 AND unit_id=$2 ORDER BY dismissal_runs.day DESC LIMIT 51 OFFSET $3",
        [actor.org_id, query.unitId, query.offset],
      )
    ).rows;
    res.json({ rows: rows.slice(0, 50), hasMore: rows.length > 50 });
  });
  app.post("/api/dismissal/runs", async (req, res) =>
    res.json(
      await openDismissal(
        db,
        schoolActor(req),
        dismissalOpenInput.parse(req.body),
      ),
    ),
  );
  app.get("/api/dismissal/runs/:id", async (req, res) =>
    res.json(
      await db.transaction((tx) =>
        dismissalDetail(tx, schoolActor(req), id(req.params.id)),
      ),
    ),
  );
  app.post("/api/dismissal/runs/:id/plans", async (req, res) =>
    res.json(
      await saveDismissalPlans(
        db,
        schoolActor(req),
        id(req.params.id),
        dismissalPlanInput.parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/dismissal/runs/:id/entries/:studentId/action",
    async (req, res) =>
      res.json(
        await dismissalAction(
          db,
          schoolActor(req),
          id(req.params.id),
          id(req.params.studentId),
          dismissalEntryInput.parse(req.body),
        ),
      ),
  );
  app.get(
    "/api/dismissal/runs/:id/entries/:studentId/pickup",
    async (req, res) =>
      res.json(
        await db.transaction(async (tx) => {
          const actor = schoolActor(req),
            run = await runById(tx, actor, id(req.params.id)),
            studentId = id(req.params.studentId);
          requireCondition(
            (
              await tx.query(
                "SELECT student_id FROM dismissal_entries WHERE run_id=$1 AND student_id=$2",
                [run.id, studentId],
              )
            ).rows.length,
            404,
            "Child not found on this dismissal day.",
          );
          await childLock(tx, actor, studentId, run.unit_id);
          const now = await moment(tx, actor);
          return {
            ...(await pickupState(tx, actor, studentId, now.day)),
            asOf: now.at,
          };
        }),
      ),
  );
  app.post("/api/dismissal/runs/:id/buses", async (req, res) => {
    const actor = schoolActor(req),
      input = dismissalBusInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const run = await runById(tx, actor, id(req.params.id));
        await assertOffice(tx, actor, run.unit_id);
        await assertOpenToday(tx, actor, run);
        requireCondition(
          input.version === 0,
          400,
          "New bus version must be zero.",
        );
        requireCondition(
          (await buses(tx, actor, run.id)).length < 100,
          400,
          "At most 100 bus routes per dismissal run.",
        );
        const row = (
          await tx.query(
            "INSERT INTO dismissal_buses(id,org_id,unit_id,run_id,name,driver_name,vehicle) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              randomUUID(),
              actor.org_id,
              run.unit_id,
              run.id,
              input.name,
              input.driverName,
              input.vehicle,
            ],
          )
        ).rows[0];
        await bump(tx, run);
        await schoolChange(
          tx,
          actor,
          run.unit_id,
          "dismissal.bus_created",
          row.id,
          null,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.patch("/api/dismissal/runs/:id/buses/:busId", async (req, res) => {
    const actor = schoolActor(req),
      input = dismissalBusInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const run = await runById(tx, actor, id(req.params.id)),
          busId = id(req.params.busId);
        await assertOffice(tx, actor, run.unit_id);
        await assertOpenToday(tx, actor, run);
        const old = (
          await tx.query(
            "SELECT * FROM dismissal_buses WHERE org_id=$1 AND run_id=$2 AND id=$3",
            [actor.org_id, run.id, busId],
          )
        ).rows[0];
        requireCondition(
          old && old.version === input.version,
          409,
          "Bus record changed. Refresh first.",
        );
        requireCondition(
          !(
            await tx.query(
              "SELECT student_id FROM dismissal_entries WHERE run_id=$1 AND bus_id=$2 AND status='released'",
              [run.id, busId],
            )
          ).rows.length,
          409,
          "A bus with recorded boardings cannot change. Add a separate route for another vehicle.",
        );
        const row = (
          await tx.query(
            "UPDATE dismissal_buses SET name=$1,driver_name=$2,vehicle=$3,arrived_at=NULL,arrival_snapshot=NULL,version=version+1 WHERE id=$4 RETURNING *",
            [input.name, input.driverName, input.vehicle, busId],
          )
        ).rows[0];
        await bump(tx, run);
        await schoolChange(
          tx,
          actor,
          run.unit_id,
          "dismissal.bus_changed",
          busId,
          old,
          { ...row, reason: input.reason },
        );
        return row;
      }),
    );
  });
  app.post("/api/dismissal/runs/:id/buses/:busId/arrival", async (req, res) => {
    const actor = schoolActor(req),
      runId = id(req.params.id),
      busId = id(req.params.busId),
      input = dismissalBusArrivalInput.parse(req.body);
    res.json(
      await command(
        db,
        actor,
        input.commandId,
        { runId, busId, ...input },
        (tx) => runById(tx, actor, runId),
        async (tx) => {
          const run = await runById(tx, actor, runId),
            now = await assertOpenToday(tx, actor, run),
            old = (
              await tx.query(
                "SELECT * FROM dismissal_buses WHERE id=$1 AND org_id=$2 AND run_id=$3",
                [busId, actor.org_id, runId],
              )
            ).rows[0];
          requireCondition(
            old && old.version === input.version,
            409,
            "Bus changed. Refresh and verify current driver/vehicle.",
          );
          requireCondition(
            !old.arrived_at,
            409,
            "This bus arrival is already verified.",
          );
          const snapshot = {
            driverName: old.driver_name,
            vehicle: old.vehicle,
            actorId: actor.id,
            at: now.at,
            identityMethod: input.identityMethod,
            identityConfirmed: true,
            vehicleConfirmed: true,
          };
          const row = (
            await tx.query(
              "UPDATE dismissal_buses SET arrived_at=$1,arrival_snapshot=$2,version=version+1 WHERE id=$3 RETURNING *",
              [now.at, JSON.stringify(snapshot), busId],
            )
          ).rows[0];
          await bump(tx, run);
          await schoolChange(
            tx,
            actor,
            run.unit_id,
            "dismissal.bus_arrived",
            busId,
            old,
            row,
          );
          return row;
        },
      ),
    );
  });
  app.post("/api/dismissal/runs/:id/reconcile", async (req, res) => {
    const actor = schoolActor(req),
      input = dismissalReconcileInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const run = await runById(tx, actor, id(req.params.id));
        await assertOffice(tx, actor, run.unit_id);
        await assertOpenToday(tx, actor, run);
        requireCondition(
          run.version === input.version,
          409,
          "Dismissal changed. Refresh before reconciling.",
        );
        const source = await sourceRoster(tx, actor, run),
          old = await records(tx, actor, run.id),
          ids = new Set(source.rows.map((r) => r.student_id));
        for (const r of old)
          if (!ids.has(r.student_id)) {
            requireCondition(
              !["present", "called"].includes(r.status),
              409,
              "A child removed from school enrollment is still marked present. The office must account for them before removing them from the expected roster.",
            );
            await tx.query(
              "UPDATE dismissal_entries SET expected=false WHERE run_id=$1 AND student_id=$2",
              [run.id, r.student_id],
            );
          }
        for (const r of source.rows) {
          const previous = old.find((x) => x.student_id === r.student_id);
          if (previous?.status === "released")
            await tx.query(
              "UPDATE dismissal_entries SET expected=true WHERE run_id=$1 AND student_id=$2",
              [run.id, r.student_id],
            );
          else
            await tx.query(
              "INSERT INTO dismissal_entries(org_id,unit_id,run_id,student_id,student_name,student_number,grade_level) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,student_id) DO UPDATE SET expected=true,student_name=EXCLUDED.student_name,student_number=EXCLUDED.student_number,grade_level=EXCLUDED.grade_level,version=dismissal_entries.version+1",
              [
                actor.org_id,
                run.unit_id,
                run.id,
                r.student_id,
                r.student_name,
                r.student_number,
                r.grade_level,
              ],
            );
        }
        await tx.query(
          "UPDATE dismissal_runs SET roster_fingerprint=$1,version=version+1 WHERE id=$2",
          [source.fingerprint, run.id],
        );
        await schoolChange(
          tx,
          actor,
          run.unit_id,
          "dismissal.roster_reconciled",
          run.id,
          old,
          { entries: await records(tx, actor, run.id), reason: input.reason },
        );
        return { ok: true };
      }),
    );
  });
  app.post("/api/dismissal/runs/:id/review", async (req, res) => {
    const actor = schoolActor(req),
      input = dismissalReviewInput.parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        const run = await runById(tx, actor, id(req.params.id));
        await assertOffice(tx, actor, run.unit_id);
        requireCondition(
          run.version === input.version,
          409,
          "Dismissal changed. Refresh and review again.",
        );
        const detail = await dismissalDetail(tx, actor, run.id);
        requireCondition(
          detail.rosterFingerprint === input.rosterFingerprint,
          409,
          "Enrollment changed. Refresh and review the current denominator.",
        );
        if (input.action === "close") {
          requireCondition(
            run.status === "open",
            409,
            "This dismissal day is already closed.",
          );
          requireCondition(
            detail.rosterCurrent &&
              detail.counts.expected > 0 &&
              detail.counts.unaccounted === 0 &&
              detail.counts.present === 0 &&
              detail.counts.called === 0,
            409,
            "Resolve every expected child and roster change before closeout.",
          );
          await tx.query(
            "INSERT INTO dismissal_closures(id,org_id,unit_id,run_id,run_version,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              randomUUID(),
              actor.org_id,
              run.unit_id,
              run.id,
              run.version,
              actor.id,
              input.reason,
              JSON.stringify({
                run,
                entries: detail.entries,
                buses: detail.buses,
                transfers: detail.transfers,
                counts: detail.counts,
                rosterFingerprint: detail.rosterFingerprint,
                asOf: detail.asOf,
              }),
            ],
          );
        } else {
          requireCondition(
            run.status === "closed",
            409,
            "This dismissal day is already open.",
          );
          requireCondition(
            run.day === detail.today,
            409,
            "Historical handoffs cannot be reopened for physical release.",
          );
        }
        const updated = (
          await tx.query(
            "UPDATE dismissal_runs SET status=$1,version=version+1 WHERE id=$2 RETURNING *",
            [input.action === "close" ? "closed" : "open", run.id],
          )
        ).rows[0];
        await schoolChange(
          tx,
          actor,
          run.unit_id,
          "dismissal." + input.action,
          run.id,
          run,
          { ...updated, reason: input.reason },
        );
        return updated;
      }),
    );
  });
  app.get("/api/dismissal/runs/:id/closures/:closureId", async (req, res) =>
    res.json(
      await db.transaction(async (tx) => {
        const actor = schoolActor(req),
          run = await runById(tx, actor, id(req.params.id));
        await assertOffice(tx, actor, run.unit_id);
        const row = (
          await tx.query(
            "SELECT * FROM dismissal_closures WHERE org_id=$1 AND run_id=$2 AND id=$3",
            [actor.org_id, run.id, id(req.params.closureId)],
          )
        ).rows[0];
        requireCondition(row, 404, "Closure not found.");
        return row;
      }),
    ),
  );
  app.get("/api/dismissal/runs/:id/export", async (req, res) => {
    const csv = await db.transaction(async (tx) => {
      const actor = schoolActor(req),
        detail = await dismissalDetail(tx, actor, id(req.params.id));
      await assertOffice(tx, actor, detail.run.unit_id);
      const rows = detail.entries.map((e) => ({
        day: detail.run.day,
        run_id: detail.run.id,
        run_version: detail.run.version,
        run_status: detail.run.status,
        roster_current: detail.rosterCurrent,
        student_id: e.student_id,
        student_name: e.student_name,
        student_number: e.student_number,
        expected: e.expected,
        status: e.status,
        mode: e.mode,
        record_version: e.version,
        released_at: e.released_at ? new Date(e.released_at).toISOString() : "",
        released_by: e.released_by,
        collector:
          e.release_snapshot?.name ??
          e.release_snapshot?.driverName ??
          e.release_snapshot?.receiverName ??
          "",
        care_program: e.release_snapshot?.programName ?? "",
        care_transfer_id: e.release_snapshot?.transferId ?? "",
        care_session_id: e.care_session_id ?? "",
        bus: e.release_snapshot?.busName ?? "",
        vehicle: e.release_snapshot?.vehicle ?? "",
        absence_reason: e.absence_reason,
        as_of: detail.asOf,
      }));
      await audit(tx, actor, "school.dismissal.exported", detail.run.id, {
        unitId: detail.run.unit_id,
        rows: rows.length,
        version: detail.run.version,
      });
      return toCsv(rows, [
        "day",
        "run_id",
        "run_version",
        "run_status",
        "roster_current",
        "student_id",
        "student_name",
        "student_number",
        "expected",
        "status",
        "mode",
        "record_version",
        "released_at",
        "released_by",
        "collector",
        "care_program",
        "care_transfer_id",
        "care_session_id",
        "bus",
        "vehicle",
        "absence_reason",
        "as_of",
      ]);
    });
    res.type("text/csv").attachment("school-dismissal.csv").send(csv);
  });
}
export {
  scope as dismissalScope,
  runById as dismissalRun,
  assertOpenToday as assertDismissalToday,
  assertCurrentRoster as assertDismissalRoster,
  childLock as lockDismissalChild,
  bump as bumpDismissal,
};
