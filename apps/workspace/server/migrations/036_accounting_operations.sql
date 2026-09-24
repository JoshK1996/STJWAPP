CREATE TABLE accounting_operation_commands (
 org_id uuid NOT NULL, command_id uuid NOT NULL, actor_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_operation_commands BEFORE UPDATE OR DELETE ON accounting_operation_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_contacts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('vendor','customer','family','donor')),
 email text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_contacts BEFORE UPDATE OR DELETE ON accounting_contacts FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_documents (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('bill','invoice')), contact_id uuid NOT NULL,
 contact_name text NOT NULL, number text NOT NULL, date date NOT NULL, due_date date NOT NULL, description text NOT NULL,
 control_account_id uuid, currency text NOT NULL, precision integer NOT NULL CHECK(precision BETWEEN 0 AND 4),
 basis text NOT NULL CHECK(basis IN ('cash','accrual')), lines jsonb NOT NULL, total text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id), UNIQUE(org_id,kind,contact_id,number),
 CHECK(due_date >= date), FOREIGN KEY(org_id,contact_id) REFERENCES accounting_contacts(org_id,id),
 FOREIGN KEY(org_id,control_account_id) REFERENCES accounting_accounts(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_documents BEFORE UPDATE OR DELETE ON accounting_documents FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_document_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, document_id uuid NOT NULL,
 type text NOT NULL CHECK(type IN ('issue','credit','payment','refund','payment_void','void')),
 date date NOT NULL, amount text NOT NULL, reference text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
 payment_id uuid, journal_id uuid, allocations jsonb NOT NULL DEFAULT '[]', cash_account_id uuid,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES accounting_documents(org_id,id), FOREIGN KEY(org_id,payment_id) REFERENCES accounting_document_events(org_id,id),
 FOREIGN KEY(org_id,journal_id) REFERENCES accounting_journals(org_id,id), FOREIGN KEY(org_id,cash_account_id) REFERENCES accounting_accounts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_document_events BEFORE UPDATE OR DELETE ON accounting_document_events FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX accounting_documents_due ON accounting_documents(org_id,due_date);
CREATE INDEX accounting_document_events_document ON accounting_document_events(org_id,document_id,created_at,id);
CREATE TABLE accounting_bank_previews (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid NOT NULL, input jsonb NOT NULL, fingerprint text NOT NULL,
 source_hash text NOT NULL, source_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_previews BEFORE UPDATE OR DELETE ON accounting_bank_previews FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_bank_statements (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, cash_account_id uuid NOT NULL, from_date date NOT NULL, to_date date NOT NULL,
 opening_balance text NOT NULL, closing_balance text NOT NULL, currency text NOT NULL, precision integer NOT NULL,
 source_hash text NOT NULL, source_text text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id),
 CHECK(to_date>=from_date), FOREIGN KEY(org_id,cash_account_id) REFERENCES accounting_accounts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_statements BEFORE UPDATE OR DELETE ON accounting_bank_statements FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_bank_lines (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, statement_id uuid NOT NULL, cash_account_id uuid NOT NULL,
 date date NOT NULL, reference text NOT NULL, description text NOT NULL, amount text NOT NULL, fingerprint text NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,statement_id,fingerprint), FOREIGN KEY(org_id,statement_id) REFERENCES accounting_bank_statements(org_id,id),
 FOREIGN KEY(org_id,cash_account_id) REFERENCES accounting_accounts(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_lines BEFORE UPDATE OR DELETE ON accounting_bank_lines FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_bank_matches (
 statement_line_id uuid NOT NULL, org_id uuid NOT NULL, journal_line_id uuid NOT NULL REFERENCES accounting_journal_lines(id),
 matched_by uuid NOT NULL, matched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(statement_line_id,journal_line_id), UNIQUE(org_id,journal_line_id),
 FOREIGN KEY(org_id,statement_line_id) REFERENCES accounting_bank_lines(org_id,id), FOREIGN KEY(org_id,matched_by) REFERENCES users(org_id,id)
);
CREATE TABLE accounting_bank_reconciliations (
 statement_id uuid PRIMARY KEY, org_id uuid NOT NULL, evidence jsonb NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,statement_id) REFERENCES accounting_bank_statements(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_reconciliations BEFORE UPDATE OR DELETE ON accounting_bank_reconciliations FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_bank_cancellations (
 statement_id uuid PRIMARY KEY, org_id uuid NOT NULL, reason text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,statement_id) REFERENCES accounting_bank_statements(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_cancellations BEFORE UPDATE OR DELETE ON accounting_bank_cancellations FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE accounting_bank_opening_lines (
 journal_line_id uuid PRIMARY KEY REFERENCES accounting_journal_lines(id), org_id uuid NOT NULL, statement_id uuid NOT NULL,
 FOREIGN KEY(org_id,statement_id) REFERENCES accounting_bank_statements(org_id,id)
);
CREATE TRIGGER immutable_accounting_bank_opening_lines BEFORE UPDATE OR DELETE ON accounting_bank_opening_lines FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE FUNCTION protect_final_bank_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM accounting_bank_lines l JOIN accounting_bank_reconciliations r ON r.statement_id=l.statement_id AND r.org_id=l.org_id
  WHERE l.id=OLD.statement_line_id) THEN RAISE EXCEPTION 'Reconciled bank matches are immutable'; END IF;
 IF EXISTS(SELECT 1 FROM accounting_bank_lines l JOIN accounting_bank_reconciliations r ON r.statement_id=l.statement_id AND r.org_id=l.org_id
  WHERE l.id=CASE WHEN TG_OP='DELETE' THEN OLD.statement_line_id ELSE NEW.statement_line_id END) THEN
  RAISE EXCEPTION 'Reconciled bank matches are immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_final_bank_matches BEFORE INSERT OR UPDATE OR DELETE ON accounting_bank_matches FOR EACH ROW EXECUTE FUNCTION protect_final_bank_match();
