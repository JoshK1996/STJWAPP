CREATE TABLE report_run_previews (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, report_id uuid NOT NULL,
 report_version integer NOT NULL CHECK(report_version>0), snapshot_id uuid NOT NULL UNIQUE,
 payload_text text NOT NULL, payload_hash text NOT NULL, access_manifest jsonb NOT NULL, manifest_hash text NOT NULL,
 bytes integer NOT NULL CHECK(bytes>=0 AND bytes<=8388608),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(org_id,user_id,report_id) REFERENCES saved_reports(org_id,user_id,id)
);
CREATE INDEX report_run_previews_owner ON report_run_previews(org_id,user_id,expires_at);
CREATE TABLE report_run_snapshots (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, report_id uuid NOT NULL,
 report_version integer NOT NULL CHECK(report_version>0), preview_id uuid NOT NULL UNIQUE,
 payload_text text NOT NULL, payload_hash text NOT NULL, access_manifest jsonb NOT NULL, manifest_hash text NOT NULL,
 json_text text NOT NULL, json_hash text NOT NULL, csv_text text NOT NULL, csv_hash text NOT NULL,
 bytes integer NOT NULL CHECK(bytes>=0 AND bytes<=8388608), captured_at timestamptz NOT NULL,
 UNIQUE(org_id,user_id,id), FOREIGN KEY(org_id,user_id,report_id) REFERENCES saved_reports(org_id,user_id,id),
 FOREIGN KEY(report_id,report_version) REFERENCES saved_report_history(report_id,version)
);
CREATE INDEX report_run_snapshots_owner ON report_run_snapshots(org_id,user_id,report_id,captured_at DESC,id);
CREATE TRIGGER immutable_report_run_snapshots BEFORE UPDATE OR DELETE ON report_run_snapshots FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE report_snapshot_commands (
 org_id uuid NOT NULL, user_id uuid NOT NULL, command_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id,command_id), FOREIGN KEY(org_id,user_id,snapshot_id) REFERENCES report_run_snapshots(org_id,user_id,id)
);
CREATE TRIGGER immutable_report_snapshot_commands BEFORE UPDATE OR DELETE ON report_snapshot_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
