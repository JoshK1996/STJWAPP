CREATE TABLE saved_reports (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 name text NOT NULL, description text NOT NULL, definition jsonb NOT NULL,
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,user_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE INDEX saved_reports_owner ON saved_reports(org_id,user_id,archived);
CREATE TABLE saved_report_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, report_id uuid NOT NULL,
 version integer NOT NULL, snapshot jsonb NOT NULL, reason text NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(report_id,version),
 FOREIGN KEY(org_id,user_id,report_id) REFERENCES saved_reports(org_id,user_id,id)
);
CREATE TRIGGER immutable_saved_report_history BEFORE UPDATE OR DELETE ON saved_report_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
