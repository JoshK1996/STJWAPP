CREATE TABLE financial_reports (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), state_version integer NOT NULL DEFAULT 1,
 archived boolean NOT NULL DEFAULT false, created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE financial_report_versions (
 report_id uuid NOT NULL, org_id uuid NOT NULL, version integer NOT NULL,
 metadata jsonb NOT NULL, lines jsonb NOT NULL, source_text text NOT NULL,
 source_hash text NOT NULL, fingerprint text NOT NULL, reason text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(report_id,version), FOREIGN KEY(org_id,report_id) REFERENCES financial_reports(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_financial_versions BEFORE UPDATE OR DELETE ON financial_report_versions FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE financial_import_previews (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, actor_id uuid NOT NULL,
 report_id uuid NOT NULL, expected_version integer NOT NULL, metadata jsonb NOT NULL, lines jsonb NOT NULL,
 source_text text NOT NULL, source_hash text NOT NULL, fingerprint text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 applied_at timestamptz, receipt jsonb,
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 CHECK((applied_at IS NULL AND receipt IS NULL) OR (applied_at IS NOT NULL AND receipt IS NOT NULL))
);
CREATE TRIGGER immutable_financial_preview BEFORE UPDATE OR DELETE ON financial_import_previews FOR EACH ROW EXECUTE FUNCTION protect_school_import();
CREATE INDEX financial_preview_owner ON financial_import_previews(org_id,actor_id,created_at DESC);
CREATE TABLE financial_report_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, report_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,report_id) REFERENCES financial_reports(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_financial_events BEFORE UPDATE OR DELETE ON financial_report_events FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
