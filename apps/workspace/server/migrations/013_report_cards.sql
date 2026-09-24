CREATE TABLE report_cards (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, student_id uuid NOT NULL, year_id uuid NOT NULL,
 term_ids uuid[] NOT NULL, term_key text NOT NULL, presentation jsonb NOT NULL, cells jsonb NOT NULL,
 source_snapshot jsonb NOT NULL, source_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), issue_count integer NOT NULL DEFAULT 0 CHECK(issue_count>=0),
 created_by uuid NOT NULL, updated_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(student_id,year_id,term_key), UNIQUE(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE TABLE report_card_issues (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, card_id uuid NOT NULL,
 number integer NOT NULL CHECK(number>0), card_version integer NOT NULL, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 issued_by uuid NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL,
 UNIQUE(card_id,number), UNIQUE(card_id,card_version),
 FOREIGN KEY(org_id,unit_id,card_id) REFERENCES report_cards(org_id,unit_id,id), FOREIGN KEY(org_id,issued_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_report_card_issues BEFORE UPDATE OR DELETE ON report_card_issues FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE report_card_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_report_card_commands BEFORE UPDATE OR DELETE ON report_card_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX report_card_student ON report_cards(org_id,unit_id,student_id,year_id);
