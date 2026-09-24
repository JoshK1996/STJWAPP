ALTER TABLE dismissal_entries DROP CONSTRAINT dismissal_entries_mode_check;
ALTER TABLE dismissal_entries ADD CONSTRAINT dismissal_entry_mode CHECK(mode IN ('pickup','bus','care'));
ALTER TABLE dismissal_entries ADD COLUMN care_program_id uuid;
ALTER TABLE dismissal_entries ADD COLUMN care_session_id uuid;
ALTER TABLE dismissal_entries ADD CONSTRAINT dismissal_care_program FOREIGN KEY(org_id,unit_id,care_program_id) REFERENCES care_programs(org_id,unit_id,id);
ALTER TABLE dismissal_entries ADD CONSTRAINT dismissal_care_session FOREIGN KEY(org_id,unit_id,care_session_id) REFERENCES care_sessions(org_id,unit_id,id);
ALTER TABLE dismissal_entries ADD CONSTRAINT dismissal_care_plan CHECK((mode IS NOT DISTINCT FROM 'care' AND care_program_id IS NOT NULL) OR (mode IS DISTINCT FROM 'care' AND care_program_id IS NULL));
ALTER TABLE dismissal_entries ADD CONSTRAINT dismissal_care_receipt CHECK((mode IS NOT DISTINCT FROM 'care' AND status='released' AND care_session_id IS NOT NULL) OR ((mode IS DISTINCT FROM 'care' OR status<>'released') AND care_session_id IS NULL));
CREATE TABLE care_transfers (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, run_id uuid NOT NULL, student_id uuid NOT NULL, program_id uuid NOT NULL,
 program_version integer NOT NULL, student_name text NOT NULL, student_number text NOT NULL, program_snapshot jsonb NOT NULL,
 requested_by uuid NOT NULL, requester_name text NOT NULL, requested_at timestamptz NOT NULL, request_reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','canceled')), version integer NOT NULL DEFAULT 1,
 completed_by uuid, completed_at timestamptz, completion_snapshot jsonb, care_session_id uuid,
 UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,run_id) REFERENCES dismissal_runs(org_id,unit_id,id),
 FOREIGN KEY(run_id,student_id) REFERENCES dismissal_entries(run_id,student_id), FOREIGN KEY(org_id,unit_id,program_id) REFERENCES care_programs(org_id,unit_id,id),
 FOREIGN KEY(org_id,requested_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,completed_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,unit_id,care_session_id) REFERENCES care_sessions(org_id,unit_id,id),
 CHECK((status='pending' AND version=1 AND completed_by IS NULL AND completed_at IS NULL AND completion_snapshot IS NULL) OR (status<>'pending' AND version=2 AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completion_snapshot IS NOT NULL)),
 CHECK((status='accepted' AND care_session_id IS NOT NULL AND completed_by<>requested_by) OR (status<>'accepted' AND care_session_id IS NULL))
);
CREATE UNIQUE INDEX care_transfer_one_pending ON care_transfers(org_id,student_id) WHERE status='pending';
CREATE UNIQUE INDEX care_transfer_one_receipt ON care_transfers(care_session_id) WHERE care_session_id IS NOT NULL;
CREATE INDEX care_transfer_program ON care_transfers(org_id,program_id,status,requested_at);
CREATE FUNCTION protect_care_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Care handoff evidence cannot be deleted'; END IF;
 IF OLD.status<>'pending' OR NEW.status='pending' OR
 (to_jsonb(NEW)-ARRAY['status','version','completed_by','completed_at','completion_snapshot','care_session_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','completed_by','completed_at','completion_snapshot','care_session_id'])
 THEN RAISE EXCEPTION 'Care handoff evidence cannot be changed'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER immutable_care_transfer BEFORE UPDATE OR DELETE ON care_transfers FOR EACH ROW EXECUTE FUNCTION protect_care_transfer();
CREATE TABLE care_transfer_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_care_transfer_command BEFORE UPDATE OR DELETE ON care_transfer_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
