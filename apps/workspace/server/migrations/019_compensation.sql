CREATE TABLE compensation_schedules (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), rates jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,user_id,job_id),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id)
);
CREATE TABLE compensation_history (
 schedule_id uuid NOT NULL, org_id uuid NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, reason text NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(schedule_id,version),
 FOREIGN KEY(org_id,schedule_id) REFERENCES compensation_schedules(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_compensation_history BEFORE UPDATE OR DELETE ON compensation_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE compensation_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_compensation_commands BEFORE UPDATE OR DELETE ON compensation_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
