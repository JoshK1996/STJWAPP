import type { Queryable } from "./db";

export const runtimeRole = "stjw_runtime";
// Used only by the privileged maintenance path. No password is part of this
// source or generated permission plan; provisioning sets it separately.
export function runtimeGrantsSql() {
  return `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='stjw_runtime') THEN
  CREATE ROLE stjw_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
ALTER ROLE stjw_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30;
ALTER ROLE stjw_runtime SET search_path = pg_catalog, public;
ALTER ROLE stjw_runtime SET statement_timeout = '30s';
ALTER ROLE stjw_runtime SET lock_timeout = '10s';
ALTER ROLE stjw_runtime SET idle_in_transaction_session_timeout = '60s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='stjw_runtime')) THEN
  RAISE EXCEPTION 'Runtime role must not be a member of another role';
 END IF;
 EXECUTE format('REVOKE CREATE,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
 EXECUTE format('REVOKE ALL ON DATABASE %I FROM stjw_runtime',current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO stjw_runtime',current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM stjw_runtime;
GRANT USAGE ON SCHEMA public TO stjw_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM stjw_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO stjw_runtime;
REVOKE ALL ON TABLE public.schema_migrations FROM stjw_runtime;
GRANT SELECT ON TABLE public.schema_migrations TO stjw_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM stjw_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO stjw_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM stjw_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO stjw_runtime;
DO $$ DECLARE immutable_table record; BEGIN
 FOR immutable_table IN
  SELECT DISTINCT n.nspname,c.relname FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
  WHERE n.nspname='public' AND f.nspname='public' AND p.proname IN('protect_audit_events','reject_staff_credential_command_change') AND NOT t.tgisinternal
 LOOP
  EXECUTE format('REVOKE UPDATE,DELETE ON TABLE %I.%I FROM stjw_runtime',immutable_table.nspname,immutable_table.relname);
 END LOOP;
 FOR immutable_table IN
  SELECT DISTINCT n.nspname,c.relname FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
  WHERE n.nspname='public' AND f.nspname='public' AND p.proname IN ('protect_staff_schedule_request','protect_standing_policy','protect_standing_series','protect_gpa_policy','protect_gpa_series','protect_staff_import','protect_organization_branding','protect_payroll_saved_views','protect_accounting_planning','protect_accounting_editable_record','protect_clock_intent','preserve_workforce_import_evidence') AND NOT t.tgisinternal
 LOOP
  EXECUTE format('REVOKE DELETE ON TABLE %I.%I FROM stjw_runtime',immutable_table.nspname,immutable_table.relname);
 END LOOP;
END $$;
REVOKE DELETE ON TABLE public.clock_employee_policies FROM stjw_runtime;
`;
}
const accountingProtections = [
 ['accounting_journals','accounting_journal_immutable','accounting_immutable_posted',31,false],
 ['accounting_journal_lines','accounting_lines_immutable','accounting_immutable_posted',31,false],
 ['accounting_commands','immutable_accounting_commands','protect_audit_events',27,true],
 ['accounting_operation_commands','immutable_accounting_operation_commands','protect_audit_events',27,true],
 ['accounting_contacts','protected_accounting_contacts','protect_accounting_editable_record',27,false],
 ['accounting_documents','protected_accounting_document_drafts','protect_accounting_editable_record',27,false],
 ['accounting_document_events','immutable_accounting_document_events','protect_audit_events',27,true],
 ['accounting_bank_previews','immutable_accounting_bank_previews','protect_audit_events',27,true],
 ['accounting_bank_statements','immutable_accounting_bank_statements','protect_audit_events',27,true],
 ['accounting_bank_lines','immutable_accounting_bank_lines','protect_audit_events',27,true],
 ['accounting_bank_reconciliations','immutable_accounting_bank_reconciliations','protect_audit_events',27,true],
 ['accounting_bank_opening_lines','immutable_accounting_bank_opening_lines','protect_audit_events',27,true],
 ['accounting_bank_cancellations','immutable_accounting_bank_cancellations','protect_audit_events',27,true],
 ['accounting_bank_matches','immutable_final_bank_matches','protect_final_bank_match',31,false],
 ['accounting_budgets','protected_accounting_budgets','protect_accounting_planning',27,false],
 ['accounting_payroll_runs','protected_accounting_payroll_runs','protect_accounting_planning',27,false],
 ['accounting_planning_commands','immutable_accounting_planning_commands','protect_audit_events',27,true],
] as const;
const accountingProtectionValues = accountingProtections.map(([table,trigger,fn,type,immutable])=>`('${table}','${trigger}','${fn}',${type},${immutable})`).join(',');
// Exact trigger identities are checked even when a table currently has no rows.
// Policy rows cannot be deleted and recreated with a reused pending version.
const workforceProtections = [
 ['users','advance_clock_authority_version','advance_clock_authority',19,true,false],
 ['clock_intents','protected_clock_intent','protect_clock_intent',31,true,true],
 ['clock_intent_events','immutable_clock_intent_events','protect_audit_events',27,false,true],
 ['clock_intent_commands','immutable_clock_intent_commands','protect_audit_events',27,false,true],
 ['staff_credential_commands','staff_credential_commands_immutable','reject_staff_credential_command_change',27,false,true],
 ['workforce_allowance_reviews','immutable_workforce_allowance_reviews','protect_audit_events',27,false,true],
 ['workforce_import_batches','workforce_import_evidence_immutable','preserve_workforce_import_evidence',27,true,true],
] as const;
const workforceProtectionValues = workforceProtections.map(([table,trigger,fn,type,allowUpdate,forbidDelete])=>`('${table}','${trigger}','${fn}',${type},${allowUpdate},${forbidDelete})`).join(',');
export async function inspectRuntimeAccess(db: Queryable) {
  const result = (
    await db.query(`SELECT current_user AS role, session_user AS login,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS elevated,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships,
    EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(datdba,'MEMBER')) AS owns_database,
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public' AND pg_has_role(nspowner,'MEMBER')) AS owns_schema,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(c.relowner,'MEMBER')) AS owns_tables,
    has_database_privilege(current_database(),'CREATE') AS create_schema,
    has_database_privilege(current_database(),'TEMPORARY') AS create_temp,
    has_schema_privilege('public','CREATE') AS create_objects,
    has_table_privilege('public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE') AS change_migrations,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND has_table_privilege(c.oid,'TRUNCATE,TRIGGER,REFERENCES')) AS dangerous_table_grants,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND NOT has_table_privilege(c.oid,'SELECT')) AS missing_table_reads,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef) AS unreviewed_definers,
    EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace WHERE n.nspname='public' AND f.nspname='public' AND p.proname IN('protect_audit_events','reject_staff_credential_command_change') AND NOT t.tgisinternal AND has_table_privilege(c.oid,'UPDATE,DELETE')) AS mutable_immutable_tables,
    EXISTS(SELECT 1 FROM (VALUES ${workforceProtectionValues}) AS expected(table_name,trigger_name,function_name,trigger_type,allow_update,forbid_delete)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
        WHERE n.nspname='public' AND f.nspname='public' AND c.relname=expected.table_name AND t.tgname=expected.trigger_name
          AND p.proname=expected.function_name AND t.tgtype=expected.trigger_type AND NOT t.tgisinternal AND t.tgenabled IN('O','A'))
      OR NOT has_table_privilege('public.'||expected.table_name,'SELECT')
      OR NOT has_table_privilege('public.'||expected.table_name,'INSERT')
      OR has_table_privilege('public.'||expected.table_name,'UPDATE')<>expected.allow_update
      OR (expected.forbid_delete AND has_table_privilege('public.'||expected.table_name,'DELETE'))) AS unprotected_workforce_activation,
    (NOT has_table_privilege('public.clock_employee_policies','SELECT')
      OR NOT has_table_privilege('public.clock_employee_policies','INSERT')
      OR NOT has_table_privilege('public.clock_employee_policies','UPDATE')
      OR has_table_privilege('public.clock_employee_policies','DELETE')) AS unprotected_clock_policy,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='payroll_saved_views' AND t.tgname='protected_payroll_saved_views'
        AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_payroll_saved_views')
      OR has_table_privilege('public.payroll_saved_views','DELETE')
      OR NOT has_table_privilege('public.payroll_saved_views','INSERT')
      OR NOT has_table_privilege('public.payroll_saved_views','UPDATE')) AS unprotected_payroll_saved_views,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='organization_branding' AND t.tgname='protected_organization_branding'
        AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_organization_branding')
      OR has_table_privilege('public.organization_branding','DELETE')
      OR NOT has_table_privilege('public.organization_branding','INSERT')
      OR NOT has_table_privilege('public.organization_branding','UPDATE')) AS unprotected_organization_branding,
    ((SELECT count(*)<>2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=27
        AND f.nspname='public' AND p.proname='protect_audit_events'
        AND ((c.relname='organization_branding_history' AND t.tgname='immutable_organization_branding_history')
          OR (c.relname='organization_branding_commands' AND t.tgname='immutable_organization_branding_commands')))
      OR has_table_privilege('public.organization_branding_history','UPDATE,DELETE')
      OR has_table_privilege('public.organization_branding_commands','UPDATE,DELETE')
      OR NOT has_table_privilege('public.organization_branding_history','INSERT')
      OR NOT has_table_privilege('public.organization_branding_commands','INSERT')) AS unprotected_organization_branding_evidence,
    (SELECT count(*)<>2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgdeferrable AND t.tginitdeferred
        AND f.nspname='public' AND p.proname='check_organization_branding_chain'
        AND ((c.relname='organization_branding' AND t.tgname='organization_branding_current_chain' AND t.tgtype=21)
          OR (c.relname='organization_branding_history' AND t.tgname='organization_branding_history_chain' AND t.tgtype=5))) AS unprotected_organization_branding_chain,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='import_batches' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_staff_import')
      OR has_table_privilege('public.import_batches','DELETE')
      OR NOT has_table_privilege('public.import_batches','INSERT')
      OR NOT has_table_privilege('public.import_batches','UPDATE')) AS unprotected_staff_imports,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='staff_schedule_requests' AND
      (has_table_privilege(c.oid,'DELETE') OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace f ON f.oid=p.pronamespace WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND f.nspname='public' AND p.proname='protect_staff_schedule_request'))) AS unprotected_schedule_requests,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='standing_policies' AND
      (has_table_privilege(c.oid,'DELETE') OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace f ON f.oid=p.pronamespace WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_standing_policy'))) AS unprotected_standing_policies,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='gpa_policies' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_gpa_policy')
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='gpa_policies' AND has_table_privilege(c.oid,'DELETE'))) AS unprotected_gpa_policies,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='gpa_series' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_gpa_series')
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='gpa_series' AND has_table_privilege(c.oid,'DELETE'))) AS unprotected_gpa_series,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='gpa_series' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=21 AND t.tgdeferrable AND t.tginitdeferred AND f.nspname='public' AND p.proname='check_gpa_series_chain')
      OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
        WHERE n.nspname='public' AND c.relname='gpa_decisions' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
          AND t.tgtype=5 AND t.tgdeferrable AND t.tginitdeferred AND f.nspname='public' AND p.proname='check_gpa_series_chain')) AS unprotected_gpa_chain,
    EXISTS(SELECT 1 FROM (VALUES ${accountingProtectionValues}) AS expected(table_name,trigger_name,function_name,trigger_type,immutable)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
        WHERE n.nspname='public' AND f.nspname='public' AND c.relname=expected.table_name AND t.tgname=expected.trigger_name
          AND p.proname=expected.function_name AND t.tgtype=expected.trigger_type AND NOT t.tgisinternal AND t.tgenabled IN('O','A'))
      OR (expected.immutable AND has_table_privilege('public.'||expected.table_name,'UPDATE,DELETE'))
      OR NOT has_table_privilege('public.'||expected.table_name,'SELECT')
      OR NOT has_table_privilege('public.'||expected.table_name,'INSERT')
      OR (expected.table_name IN('accounting_journals','accounting_journal_lines','accounting_budgets','accounting_payroll_runs','accounting_contacts','accounting_documents') AND NOT has_table_privilege('public.'||expected.table_name,'UPDATE'))
      OR (expected.table_name IN('accounting_journals','accounting_journal_lines','accounting_bank_matches') AND NOT has_table_privilege('public.'||expected.table_name,'DELETE'))
      OR (expected.table_name IN('accounting_budgets','accounting_payroll_runs','accounting_contacts','accounting_documents') AND has_table_privilege('public.'||expected.table_name,'DELETE'))) AS unprotected_accounting,
    NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='gpa_previews' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
        AND t.tgtype=27 AND f.nspname='public' AND p.proname='protect_gpa_preview') AS unprotected_gpa_previews,
    (NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='standing_series' AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=31 AND f.nspname='public' AND p.proname='protect_standing_series')
      OR has_table_privilege('public.standing_series','DELETE')) AS unprotected_standing_series,
    (SELECT count(*)<>2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname IN('standing_series','standing_decisions') AND t.tgenabled IN('O','A') AND t.tgdeferrable AND t.tginitdeferred
        AND f.nspname='public' AND p.proname='check_standing_series_chain') AS unprotected_standing_chain,
    NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='standing_previews' AND NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=27 AND f.nspname='public' AND p.proname='protect_standing_preview') AS unprotected_standing_previews,
    NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname='timetable_revisions' AND NOT t.tgisinternal AND t.tgenabled IN('O','A')
      AND t.tgtype=19 AND f.nspname='public' AND p.proname='protect_timetable_calendar_revision') AS unprotected_timetable_calendar_revision
  `)
  ).rows[0];
  return result;
}
export async function assertRuntimeAccess(db: Queryable) {
  const result = await inspectRuntimeAccess(db);
  if (
    result.role !== runtimeRole ||
    result.login !== runtimeRole ||
    Object.entries(result).some(
      ([key, value]) => !["role", "login"].includes(key) && value !== false,
    )
  )
    throw new Error(
      "The web database connection does not meet the restricted runtime-role policy. Use the separate maintenance path to configure it.",
    );
  return result;
}
