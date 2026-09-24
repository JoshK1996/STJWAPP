CREATE TABLE accounting_config (
 org_id uuid PRIMARY KEY REFERENCES organizations(id), configured boolean NOT NULL DEFAULT true, reviewed boolean NOT NULL DEFAULT false,
 currency text DEFAULT 'USD', precision integer DEFAULT 2 CHECK(precision BETWEEN 0 AND 4), basis text DEFAULT 'accrual' CHECK(basis IN ('cash','accrual')),
 fiscal_start_month integer DEFAULT 1 CHECK(fiscal_start_month BETWEEN 1 AND 12), fiscal_start_day integer DEFAULT 1 CHECK(fiscal_start_day BETWEEN 1 AND 31),
 modules jsonb NOT NULL DEFAULT '["ledger","budgets","payables","receivables","banking","payroll"]', revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT configured OR (currency IS NOT NULL AND precision IS NOT NULL AND basis IS NOT NULL AND fiscal_start_month IS NOT NULL AND fiscal_start_day IS NOT NULL))
);
CREATE TABLE accounting_accounts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), code text NOT NULL, name text NOT NULL,
 type text NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')), is_cash boolean NOT NULL,
 cash_flow_category text NOT NULL CHECK(cash_flow_category IN ('operating','investing','financing','unclassified')),
 functional_category text NOT NULL CHECK(functional_category IN ('program','management','fundraising','unclassified')),
 active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 UNIQUE(org_id,id), UNIQUE(org_id,code), CHECK(NOT is_cash OR type='asset')
);
CREATE TABLE accounting_funds (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), code text NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('fund','program','grant')), restriction text NOT NULL CHECK(restriction IN ('unrestricted','restricted')),
 purpose text NOT NULL, active boolean NOT NULL DEFAULT true, allowed_account_ids jsonb NOT NULL DEFAULT '[]', allowed_unit_ids jsonb NOT NULL DEFAULT '[]',
 starts_on date, ends_on date, revision integer NOT NULL DEFAULT 1,
 UNIQUE(org_id,id), UNIQUE(org_id,code), CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on), CHECK(restriction <> 'restricted' OR length(purpose)>0)
);
CREATE TABLE accounting_periods (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), revision integer NOT NULL DEFAULT 1,
 closed_at timestamptz, closed_by uuid, reason text NOT NULL DEFAULT '',
 UNIQUE(org_id,id), CHECK(ends_on >= starts_on), FOREIGN KEY(org_id,closed_by) REFERENCES users(org_id,id)
);
CREATE INDEX accounting_period_dates ON accounting_periods(org_id,starts_on,ends_on);
CREATE TABLE accounting_journals (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), entry_date date NOT NULL, description text NOT NULL, reference text NOT NULL DEFAULT '',
 source_type text NOT NULL DEFAULT 'manual', source_id uuid, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')), revision integer NOT NULL DEFAULT 1,
 reversal_of uuid, created_by uuid NOT NULL, posted_by uuid, created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz,
 UNIQUE(org_id,id), UNIQUE(org_id,reversal_of), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,posted_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,reversal_of) REFERENCES accounting_journals(org_id,id), CHECK((status='draft' AND posted_at IS NULL) OR (status='posted' AND posted_at IS NOT NULL AND posted_by IS NOT NULL))
);
CREATE INDEX accounting_journal_dates ON accounting_journals(org_id,entry_date,status);
CREATE TABLE accounting_journal_lines (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, journal_id uuid NOT NULL, line_number integer NOT NULL,
 account_id uuid NOT NULL, debit numeric(24,0) NOT NULL, credit numeric(24,0) NOT NULL,
 unit_id uuid, fund_id uuid, program_id uuid, grant_id uuid, memo text NOT NULL DEFAULT '', account_snapshot jsonb NOT NULL,
 cash_flow_category text NOT NULL CHECK(cash_flow_category IN ('operating','investing','financing','unclassified')),
 UNIQUE(journal_id,line_number), FOREIGN KEY(org_id,journal_id) REFERENCES accounting_journals(org_id,id),
 FOREIGN KEY(org_id,account_id) REFERENCES accounting_accounts(org_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,fund_id) REFERENCES accounting_funds(org_id,id), FOREIGN KEY(org_id,program_id) REFERENCES accounting_funds(org_id,id), FOREIGN KEY(org_id,grant_id) REFERENCES accounting_funds(org_id,id),
 CHECK(debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)))
);
CREATE INDEX accounting_lines_account ON accounting_journal_lines(org_id,account_id,journal_id);
CREATE TABLE accounting_commands (
 org_id uuid NOT NULL REFERENCES organizations(id), command_id uuid NOT NULL, actor_id uuid NOT NULL, fingerprint text NOT NULL, receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE FUNCTION accounting_immutable_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'accounting_journals' THEN
  IF TG_OP = 'INSERT' THEN
   IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'Accounting journals must begin as drafts'; END IF;
   RETURN NEW;
  END IF;
  IF OLD.status='posted' THEN RAISE EXCEPTION 'Posted accounting journals are immutable'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='posted' THEN
   IF NOT EXISTS(SELECT 1 FROM accounting_periods p WHERE p.org_id=NEW.org_id AND NEW.entry_date BETWEEN p.starts_on AND p.ends_on AND p.status='open') THEN RAISE EXCEPTION 'An open accounting period is required'; END IF;
   IF (SELECT count(*) FROM accounting_journal_lines WHERE journal_id=NEW.id) < 2 OR
     (SELECT COALESCE(sum(debit-credit),0) FROM accounting_journal_lines WHERE journal_id=NEW.id) <> 0 THEN RAISE EXCEPTION 'Accounting journal must balance'; END IF;
  END IF;
 ELSE
  IF TG_OP <> 'INSERT' AND EXISTS(SELECT 1 FROM accounting_journals WHERE id=OLD.journal_id AND status='posted') THEN RAISE EXCEPTION 'Posted accounting journal lines are immutable'; END IF;
  IF TG_OP <> 'DELETE' AND EXISTS(SELECT 1 FROM accounting_journals WHERE id=NEW.journal_id AND status='posted') THEN RAISE EXCEPTION 'Posted accounting journal lines are immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_journal_immutable BEFORE INSERT OR UPDATE OR DELETE ON accounting_journals FOR EACH ROW EXECUTE FUNCTION accounting_immutable_posted();
CREATE TRIGGER accounting_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON accounting_journal_lines FOR EACH ROW EXECUTE FUNCTION accounting_immutable_posted();
CREATE TRIGGER immutable_accounting_commands BEFORE UPDATE OR DELETE ON accounting_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
