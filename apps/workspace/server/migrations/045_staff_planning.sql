CREATE TABLE staff_planning_definitions (
 org_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('rule','target')),
 job_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id)
);
CREATE INDEX staff_planning_job ON staff_planning_definitions(org_id,job_id,kind);
CREATE TABLE staff_planning_history (
 org_id uuid NOT NULL, definition_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 action text NOT NULL CHECK(action IN ('created','updated','archived','restored')), reason text NOT NULL,
 before_snapshot jsonb, after_snapshot jsonb NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,definition_id,version), FOREIGN KEY(org_id,definition_id) REFERENCES staff_planning_definitions(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_planning_history BEFORE UPDATE OR DELETE ON staff_planning_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE staff_planning_previews (
 org_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL, source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id), CHECK(expires_at>created_at)
);
CREATE TRIGGER immutable_staff_planning_previews BEFORE UPDATE OR DELETE ON staff_planning_previews FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE staff_planning_applications (
 org_id uuid NOT NULL, preview_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'), result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,preview_id), FOREIGN KEY(org_id,preview_id) REFERENCES staff_planning_previews(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id), UNIQUE(org_id,actor_id,command_id)
);
CREATE TRIGGER immutable_staff_planning_applications BEFORE UPDATE OR DELETE ON staff_planning_applications FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE staff_planning_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'), result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_planning_commands BEFORE UPDATE OR DELETE ON staff_planning_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
