CREATE TABLE accounting_budgets (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
 period_id uuid NOT NULL, version integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('draft','approved','voided')), payload jsonb NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 approved_by uuid, approved_at timestamptz, reason text NOT NULL,
 FOREIGN KEY(org_id,period_id) REFERENCES accounting_periods(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,approved_by) REFERENCES users(org_id,id)
);
CREATE TABLE accounting_payroll_runs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
 starts_on date NOT NULL, ends_on date NOT NULL, pay_date date NOT NULL,
 version integer NOT NULL DEFAULT 1, status text NOT NULL CHECK(status IN ('draft','approved','posted','paid','voided')),
 payload jsonb NOT NULL, source_hash text NOT NULL, journal_id uuid,
 payment_journal_id uuid,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 approved_by uuid, approved_at timestamptz, reason text NOT NULL,
 FOREIGN KEY(org_id,journal_id) REFERENCES accounting_journals(org_id,id), FOREIGN KEY(org_id,payment_journal_id) REFERENCES accounting_journals(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,approved_by) REFERENCES users(org_id,id)
);
CREATE TABLE accounting_planning_commands (
 org_id uuid NOT NULL REFERENCES organizations(id), command_id uuid NOT NULL, actor_id uuid NOT NULL,
 fingerprint text NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_planning_commands BEFORE UPDATE OR DELETE ON accounting_planning_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE FUNCTION protect_accounting_planning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accounting plans retain their history'; END IF;
 IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.name<>OLD.name OR NEW.payload<>OLD.payload OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Accounting plan evidence is immutable';
 END IF;
 IF OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN RAISE EXCEPTION 'Accounting approval evidence is immutable'; END IF;
 IF NEW.status='approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN RAISE EXCEPTION 'An approval requires reviewer evidence'; END IF;
 IF TG_TABLE_NAME='accounting_budgets' THEN
  IF NEW.period_id<>OLD.period_id OR NOT ((OLD.status='draft' AND NEW.status IN('approved','voided')) OR (OLD.status='approved' AND NEW.status='voided')) THEN RAISE EXCEPTION 'Invalid budget transition'; END IF;
 ELSE
  IF NEW.starts_on<>OLD.starts_on OR NEW.ends_on<>OLD.ends_on OR NEW.pay_date<>OLD.pay_date OR NEW.source_hash<>OLD.source_hash OR NOT (
    (OLD.status='draft' AND NEW.status IN('approved','voided')) OR
    (OLD.status='approved' AND NEW.status IN('posted','paid','voided')) OR
    (OLD.status='posted' AND NEW.status IN('paid','voided')) OR
    (OLD.status='paid' AND NEW.status='voided')) THEN RAISE EXCEPTION 'Invalid payroll transition'; END IF;
  IF (OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id) OR (OLD.payment_journal_id IS NOT NULL AND NEW.payment_journal_id IS DISTINCT FROM OLD.payment_journal_id) THEN RAISE EXCEPTION 'Payroll journal evidence is immutable'; END IF;
  IF NEW.status='posted' AND (NEW.payload->>'basis'<>'accrual' OR NEW.journal_id IS NULL) THEN RAISE EXCEPTION 'Accrual posting requires journal evidence'; END IF;
  IF OLD.status='approved' AND NEW.status='paid' AND NEW.payload->>'basis'<>'cash' THEN RAISE EXCEPTION 'Accrual payroll must be posted before payment'; END IF;
  IF NEW.status='paid' AND (NEW.payload->>'basis'='cash' OR (NEW.payload->'totals'->>'net')::numeric>0) AND NEW.payment_journal_id IS NULL THEN RAISE EXCEPTION 'Payment requires journal evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_accounting_budgets BEFORE UPDATE OR DELETE ON accounting_budgets FOR EACH ROW EXECUTE FUNCTION protect_accounting_planning();
CREATE TRIGGER protected_accounting_payroll_runs BEFORE UPDATE OR DELETE ON accounting_payroll_runs FOR EACH ROW EXECUTE FUNCTION protect_accounting_planning();
CREATE INDEX accounting_budgets_org ON accounting_budgets(org_id,created_at);
CREATE INDEX accounting_payroll_org ON accounting_payroll_runs(org_id,starts_on,ends_on);
