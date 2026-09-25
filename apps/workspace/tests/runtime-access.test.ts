import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  verifySchema,
  type Database,
} from "../server/db";
import { initialize } from "../server/seed";
import {
  assertRuntimeAccess,
  runtimeGrantsSql,
} from "../server/runtime-access";
import { clockCommand } from "../server/workforce";
import { previewCompensation, saveCompensation } from "../server/compensation";
import { saveReport, runReport } from "../server/report-library";
import { initialDefinition } from "../shared/report-library";
import { digest, type Actor } from "../server/security";
import { createPayrollView, updatePayrollView, deletePayrollView } from '../server/payroll-views';
let db: Database, owner: Actor, jobId: string;
let maintenanceLogin:string;
const reportSessionHash = digest(randomUUID());
before(async () => {
  db = await connectDatabase();
  maintenanceLogin=(await db.query("SELECT session_user AS name")).rows[0].name;
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (
    await db.query(
      "SELECT id,org_id,name,email,role FROM users WHERE role='owner'",
    )
  ).rows[0];
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: user.role,
    mode: "password",
    unit_ids: (
      await db.query("SELECT unit_id FROM user_units WHERE user_id=$1", [
        user.id,
      ])
    ).rows.map((x) => x.unit_id),
  };
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic-runtime',clock_timestamp()+interval '1 hour')", [reportSessionHash,owner.org_id,owner.id]);
  jobId = (
    await db.query(
      "SELECT job_id FROM user_jobs WHERE user_id=$1 ORDER BY job_id",
      [owner.id],
    )
  ).rows[0].job_id;
  for (const statement of runtimeGrantsSql().match(
    /(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g,
  ) ?? [])
    await db.query(statement);
});
after(async () => {
  await db?.close();
});
test('runtime accounting startup detects disabled evidence triggers and missing transition privileges',async()=>{
 for(const [table,privilege] of [['accounting_payroll_runs','UPDATE'],['accounting_budgets','UPDATE'],['accounting_journal_lines','DELETE'],['accounting_bank_matches','DELETE']]){
  await db.query(`REVOKE ${privilege} ON ${table} FROM stjw_runtime`);
  try{await runtime(async()=>{await assert.rejects(assertRuntimeAccess(db),/restricted runtime-role/);});}
  finally{await db.query(`GRANT ${privilege} ON ${table} TO stjw_runtime`);}
 }
 await db.query('ALTER TABLE accounting_commands DISABLE TRIGGER immutable_accounting_commands');
 try{await runtime(async()=>{await assert.rejects(assertRuntimeAccess(db),/restricted runtime-role/);});}
 finally{await db.query('ALTER TABLE accounting_commands ENABLE TRIGGER immutable_accounting_commands');}
 await runtime(async()=>{await assertRuntimeAccess(db);});
});
async function runtime(fn: () => Promise<void>) {
  await db.query("SET SESSION AUTHORIZATION stjw_runtime");
  try {
    await fn();
  } finally {
    await db.query('SET SESSION AUTHORIZATION "'+maintenanceLogin.replaceAll('"','""')+'"');
  }
}
test("the restricted runtime identity can verify the schema without migration privileges", async () => {
  await runtime(async () => {
    assert.equal(await verifySchema(db), 39);
    const access = await assertRuntimeAccess(db);
    assert.equal(access.role, "stjw_runtime");
    assert.equal(access.login, "stjw_runtime");
  });
  await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/);
  await db.query("INSERT INTO schema_migrations(version) VALUES(999)");
  await assert.rejects(verifySchema(db), /does not match/);
  await db.query("DELETE FROM schema_migrations WHERE version=999");
});
test("runtime cannot alter schema, remove audits, bypass triggers or change migration metadata", async () => {
  await runtime(async () => {
    for (const sql of [
      "CREATE TABLE forbidden_runtime_table(id integer)",
      "CREATE TEMP TABLE forbidden_runtime_temp(id integer)",
      "CREATE SCHEMA forbidden_runtime_schema",
      "ALTER TABLE audit_events DISABLE TRIGGER immutable_audit",
      "TRUNCATE audit_events",
      "UPDATE audit_events SET action='tampered'",
      "DELETE FROM audit_events",
      "INSERT INTO schema_migrations(version) VALUES(999)",
      "ALTER ROLE stjw_runtime SUPERUSER",
    ])
      await assert.rejects(
        db.query(sql),
        /permission denied|must be owner|must be superuser|Only roles/,
      );
    await assert.rejects(db.query("SET ROLE postgres"), /permission denied/);
  });
});
test("runtime still supports audited clocking, immutable pay revisions and personal reports", async () => {
  await runtime(async () => {
    await clockCommand(
      db,
      owner,
      { action: "clock_in", jobId, commandId: randomUUID() },
      new Date("2026-01-02T14:00:00Z"),
    );
    await clockCommand(
      db,
      owner,
      { action: "start_break", commandId: randomUUID() },
      new Date("2026-01-02T15:00:00Z"),
    );
    await clockCommand(
      db,
      owner,
      { action: "end_break", commandId: randomUUID() },
      new Date("2026-01-02T15:15:00Z"),
    );
    const stopped = await clockCommand(
      db,
      owner,
      { action: "clock_out", commandId: randomUUID() },
      new Date("2026-01-02T16:00:00Z"),
    );
    assert.equal(stopped.shift, null);
    const input = {
        userId: owner.id,
        jobId,
        expectedVersion: 0,
        rates: [
          {
            id: randomUUID(),
            startsOn: "2026-01-01",
            endsOn: null,
            amount: "18.125",
            currency: "USD",
            basis: "hour",
            voided: false,
            note: "Synthetic restricted-role rate",
          },
        ],
        reason: "Synthetic runtime permission verification",
      },
      preview = await previewCompensation(db, owner, input, reportSessionHash),
      saved = await saveCompensation(db, owner, {
        ...input,
        previewHash: preview.previewHash,
        commandId: randomUUID(),
        reviewed: true,
      }, reportSessionHash);
    assert.equal(saved.version, 1);
    const definition = {
      ...initialDefinition("workforce"),
      range: { preset: "custom", from: "2026-01-02", to: "2026-01-02" },
    };
    const report = await saveReport(db, owner, reportSessionHash, {
      id: randomUUID(),
      version: 0,
      name: "Synthetic runtime report",
      description: "",
      definition,
      archived: false,
      reason: "Synthetic role verification",
    });
    const data = await runReport(db, owner, report.definition);
    assert.equal(data.sourceRowCount, 3);
    assert.ok(
      (
        await db.query(
          "SELECT id FROM audit_events WHERE action='compensation.saved'",
        )
      ).rows.length,
    );
  });
});
test("runtime startup detects a newly granted immutable-table mutation privilege", async () => {
  await db.query("GRANT UPDATE ON audit_events TO stjw_runtime");
  try {
    await runtime(async () => {
      await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/);
    });
  } finally {
    await db.query("REVOKE UPDATE ON audit_events FROM stjw_runtime");
  }
});
test("runtime requires the database timetable timestamp trigger and can use legacy version-only writes", async () => {
  await runtime(async () => {
    await db.query("INSERT INTO timetable_revisions(org_id) VALUES($1) ON CONFLICT DO NOTHING", [owner.org_id]);
    await db.query("UPDATE timetable_revisions SET version=version+1 WHERE org_id=$1", [owner.org_id]);
    const row = (await db.query("SELECT version,calendar_revised_at FROM timetable_revisions WHERE org_id=$1", [owner.org_id])).rows[0];
    assert.ok(row.version > 0 && row.calendar_revised_at);
    const changed = (await db.query("UPDATE timetable_revisions SET calendar_revised_at='2100-01-01' WHERE org_id=$1 RETURNING calendar_revised_at", [owner.org_id])).rows[0];
    assert.deepEqual(changed.calendar_revised_at, row.calendar_revised_at);
  });
  await db.query("ALTER TABLE timetable_revisions DISABLE TRIGGER timetable_calendar_revision");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("ALTER TABLE timetable_revisions ENABLE TRIGGER timetable_calendar_revision"); }
});
test("runtime protects standing policy retention, confirmed versions, history and command receipts", async () => {
  await runtime(async () => {
    for (const table of ["standing_policy_versions", "standing_policy_history", "standing_policy_commands"])
      for (const mutation of ["UPDATE " + table + " SET org_id=org_id", "DELETE FROM " + table]) await assert.rejects(db.query(mutation), /permission denied/i);
    await assert.rejects(db.query("DELETE FROM standing_policies"), /permission denied/i);
  });
  await db.query("ALTER TABLE standing_policies DISABLE TRIGGER protected_standing_policy");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("ALTER TABLE standing_policies ENABLE TRIGGER protected_standing_policy"); }
  await db.query("GRANT DELETE ON standing_policies TO stjw_runtime");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("REVOKE DELETE ON standing_policies FROM stjw_runtime"); }
});

test("runtime protects GPA configurations, confirmed versions, history and exact command receipts", async () => {
  await runtime(async () => {
    for (const table of ["gpa_policy_versions", "gpa_policy_history", "gpa_policy_commands"])
      for (const sql of ["UPDATE " + table + " SET org_id=org_id", "DELETE FROM " + table]) await assert.rejects(db.query(sql), /permission denied/i);
    await assert.rejects(db.query("DELETE FROM gpa_policies"), /permission denied/i);
  });
  await db.query("ALTER TABLE gpa_policies DISABLE TRIGGER protected_gpa_policy");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("ALTER TABLE gpa_policies ENABLE TRIGGER protected_gpa_policy"); }
  await db.query("GRANT DELETE ON gpa_policies TO stjw_runtime");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("REVOKE DELETE ON gpa_policies FROM stjw_runtime"); }
});

test("runtime denies staff import deletion and verifies the exact enabled evidence transition", async () => {
  await runtime(async () => { await assert.rejects(db.query("DELETE FROM import_batches"), /permission denied/i); });
  await db.query("ALTER TABLE import_batches DISABLE TRIGGER immutable_staff_import");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("ALTER TABLE import_batches ENABLE TRIGGER immutable_staff_import"); }
  for (const operation of ["GRANT DELETE", "REVOKE UPDATE", "REVOKE INSERT"]) {
    const granting = operation.startsWith("GRANT"), permission = operation.split(" ")[1];
    await db.query(`${operation} ON import_batches ${granting ? "TO" : "FROM"} stjw_runtime`);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query(`${granting ? "REVOKE" : "GRANT"} ${permission} ON import_batches ${granting ? "FROM" : "TO"} stjw_runtime`); }
  }
});

test('runtime supports audited personal payroll views and enforces retained deletion evidence', async () => {
  await runtime(async () => {
    const filters = { period: 'last_week', group: 'day', comparePrevious: true };
    const saved = await createPayrollView(db, owner, reportSessionHash, { id: randomUUID(), name: 'Weekly preparation', filters });
    const updated = await updatePayrollView(db, owner, reportSessionHash, saved.id, { revision: saved.revision, name: 'Weekly comparison', filters });
    const removed = await deletePayrollView(db, owner, reportSessionHash, saved.id, { revision: updated.revision });
    assert.equal(removed.deleted, true);
    assert.equal(removed.revision, 3);
    await assert.rejects(db.query('DELETE FROM payroll_saved_views'), /permission denied/i);
  });
  await db.query('ALTER TABLE payroll_saved_views DISABLE TRIGGER protected_payroll_saved_views');
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query('ALTER TABLE payroll_saved_views ENABLE TRIGGER protected_payroll_saved_views'); }
  for (const [permission, grant] of [['DELETE', true], ['INSERT', false], ['UPDATE', false]] as const) {
    await db.query(`${grant ? 'GRANT' : 'REVOKE'} ${permission} ON payroll_saved_views ${grant ? 'TO' : 'FROM'} stjw_runtime`);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query(`${grant ? 'REVOKE' : 'GRANT'} ${permission} ON payroll_saved_views ${grant ? 'FROM' : 'TO'} stjw_runtime`); }
  }
});

test("runtime requires exact branding history, pointer-chain guards and restricted mutation grants", async () => {
  await runtime(async () => {
    await assert.rejects(db.query("DELETE FROM organization_branding"), /permission denied/i);
    for (const table of ["organization_branding_history", "organization_branding_commands"])
      for (const operation of ["DELETE FROM " + table, "UPDATE " + table + " SET org_id=org_id"]) await assert.rejects(db.query(operation), /permission denied/i);
  });
  for (const [table, trigger] of [["organization_branding", "protected_organization_branding"],
    ["organization_branding", "organization_branding_current_chain"], ["organization_branding_history", "organization_branding_history_chain"],
    ["organization_branding_history", "immutable_organization_branding_history"], ["organization_branding_commands", "immutable_organization_branding_commands"]]) {
    await db.query("ALTER TABLE " + table + " DISABLE TRIGGER " + trigger);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query("ALTER TABLE " + table + " ENABLE TRIGGER " + trigger); }
  }
  for (const [table, permission, grant] of [["organization_branding", "DELETE", true], ["organization_branding", "UPDATE", false],
    ["organization_branding", "INSERT", false], ["organization_branding_history", "INSERT", false],
    ["organization_branding_commands", "INSERT", false], ["organization_branding_commands", "UPDATE", true]] as const) {
    await db.query(`${grant ? "GRANT" : "REVOKE"} ${permission} ON ${table} ${grant ? "TO" : "FROM"} stjw_runtime`);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query(`${grant ? "REVOKE" : "GRANT"} ${permission} ON ${table} ${grant ? "FROM" : "TO"} stjw_runtime`); }
  }
});

test("runtime protects GPA result files, receipts, latest-chain and temporary preview boundaries", async () => {
  await runtime(async () => {
    for (const table of ["gpa_decisions", "gpa_decision_commands"])
      for (const sql of ["UPDATE " + table + " SET org_id=org_id", "DELETE FROM " + table]) await assert.rejects(db.query(sql), /permission denied/i);
    await assert.rejects(db.query("DELETE FROM gpa_series"), /permission denied/i);
    await db.query("DELETE FROM gpa_previews WHERE expires_at<=clock_timestamp() OR consumed_at IS NOT NULL");
  });
  for (const [table, trigger] of [["gpa_series", "protected_gpa_series"], ["gpa_series", "gpa_series_chain"],
    ["gpa_decisions", "gpa_decision_chain"], ["gpa_previews", "protected_gpa_preview"]]) {
    await db.query("ALTER TABLE " + table + " DISABLE TRIGGER " + trigger);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query("ALTER TABLE " + table + " ENABLE TRIGGER " + trigger); }
  }
  await db.query("GRANT DELETE ON gpa_series TO stjw_runtime");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("REVOKE DELETE ON gpa_series FROM stjw_runtime"); }
});

test("runtime protects retained standing decisions, command receipts and deferred series/preview guards", async () => {
  await runtime(async () => {
    for (const table of ["standing_decisions", "standing_decision_commands"])
      for (const sql of ["UPDATE " + table + " SET org_id=org_id", "DELETE FROM " + table]) await assert.rejects(db.query(sql), /permission denied/i);
    await assert.rejects(db.query("DELETE FROM standing_series"), /permission denied/i);
    // Expired/consumed preview cleanup remains available to the service.
    await db.query("DELETE FROM standing_previews WHERE expires_at<=clock_timestamp() OR consumed_at IS NOT NULL");
  });
  for (const [table, trigger] of [["standing_series", "protected_standing_series"], ["standing_series", "standing_series_chain"],
    ["standing_decisions", "standing_decision_chain"], ["standing_previews", "protected_standing_preview"]]) {
    await db.query("ALTER TABLE " + table + " DISABLE TRIGGER " + trigger);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query("ALTER TABLE " + table + " ENABLE TRIGGER " + trigger); }
  }
  await db.query("GRANT DELETE ON standing_series TO stjw_runtime");
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query("REVOKE DELETE ON standing_series FROM stjw_runtime"); }
});

test('runtime verifies accounting catalog edit guards and cannot delete contacts or document drafts',async()=>{
 for(const [table,trigger] of [['accounting_contacts','protected_accounting_contacts'],['accounting_documents','protected_accounting_document_drafts']]){
  await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try{await runtime(async()=>{await assert.rejects(assertRuntimeAccess(db),/restricted runtime-role/);});}finally{await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);}
  await db.query(`REVOKE UPDATE ON ${table} FROM stjw_runtime`);
  try{await runtime(async()=>{await assert.rejects(assertRuntimeAccess(db),/restricted runtime-role/);});}finally{await db.query(`GRANT UPDATE ON ${table} TO stjw_runtime`);}
  await db.query(`GRANT DELETE ON ${table} TO stjw_runtime`);
  try{await runtime(async()=>{await assert.rejects(assertRuntimeAccess(db),/restricted runtime-role/);});}finally{await db.query(`REVOKE DELETE ON ${table} FROM stjw_runtime`);}
 }
 await runtime(async()=>{await assertRuntimeAccess(db);});
});
