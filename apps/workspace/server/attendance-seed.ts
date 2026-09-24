import { randomUUID } from "node:crypto";
import type { Database } from "./db";
import { audit } from "./security";
export async function initializeAttendanceDemo(db: Database, enabled: boolean) {
  if (!enabled) return;
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(78239104)");
    const org = (
      await tx.query(
        "SELECT id FROM organizations WHERE demo=true ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!org) return;
    if (
      (
        await tx.query(
          "SELECT name FROM demo_fixtures WHERE org_id=$1 AND name='attendance_examples_v1'",
          [org.id],
        )
      ).rows.length
    )
      return;
    const owner = (
        await tx.query(
          "SELECT id FROM users WHERE org_id=$1 AND role='owner' AND active ORDER BY created_at LIMIT 1",
          [org.id],
        )
      ).rows[0],
      unit = (
        await tx.query(
          "SELECT id FROM units WHERE org_id=$1 AND kind='school' ORDER BY name LIMIT 1",
          [org.id],
        )
      ).rows[0];
    if (!owner || !unit) return;
    // Demonstration configuration only; no claim that these are STJW's selected school policies.
    await tx.query(
      "INSERT INTO attendance_settings(org_id,unit_id,weekdays,periods,confirmed,updated_by) VALUES($1,$2,$3,$4,false,$5) ON CONFLICT(unit_id) DO NOTHING",
      [
        org.id,
        unit.id,
        [1, 2, 3, 4, 5],
        JSON.stringify(["Daily", "AM", "PM"]),
        owner.id,
      ],
    );
    for (const [code, label, category, excused] of [
      ["P", "Present (sample)", "present", false],
      ["A", "Absent (sample)", "absent", false],
      ["AE", "Excused absence (sample)", "absent", true],
      ["T", "Tardy (sample)", "tardy", false],
      ["E", "Early departure (sample)", "early", false],
    ] as const) {
      await tx.query(
        "INSERT INTO attendance_codes(id,org_id,unit_id,code,label,category,excused) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(unit_id,code) DO NOTHING",
        [randomUUID(), org.id, unit.id, code, label, category, excused],
      );
    }
    await tx.query(
      "INSERT INTO demo_fixtures(org_id,name) VALUES($1,'attendance_examples_v1')",
      [org.id],
    );
    await audit(
      tx,
      { id: owner.id, org_id: org.id },
      "demo.attendance_configured",
      unit.id,
      { synthetic: true, policyConfirmed: false },
    );
  });
}
