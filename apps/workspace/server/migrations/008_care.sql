CREATE TABLE care_programs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, name text NOT NULL, room text NOT NULL,
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 200), instructions text NOT NULL, confirmed boolean NOT NULL, archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE care_staff (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, program_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(program_id,user_id), FOREIGN KEY(org_id,unit_id,program_id) REFERENCES care_programs(org_id,unit_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE care_enrollments (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, program_id uuid NOT NULL, student_id uuid NOT NULL,
 starts_on date NOT NULL, ends_on date NOT NULL, enabled boolean NOT NULL, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(program_id,student_id), CHECK(ends_on>=starts_on), FOREIGN KEY(org_id,unit_id,program_id) REFERENCES care_programs(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id)
);
CREATE TABLE child_pickup_holds (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, student_id uuid PRIMARY KEY, active boolean NOT NULL, reason text NOT NULL, version integer NOT NULL DEFAULT 1,
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id)
);
CREATE TABLE care_sessions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, program_id uuid NOT NULL, student_id uuid NOT NULL,
 checked_in_at timestamptz NOT NULL, entered_by uuid NOT NULL, arrival_name text NOT NULL, program_snapshot jsonb NOT NULL,
 checked_out_at timestamptz, released_by uuid, pickup_snapshot jsonb, release_note text,
 UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,program_id) REFERENCES care_programs(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id),
 FOREIGN KEY(org_id,entered_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,released_by) REFERENCES users(org_id,id),
 CHECK(checked_out_at IS NULL OR checked_out_at>=checked_in_at),
 CHECK((checked_out_at IS NULL AND released_by IS NULL AND pickup_snapshot IS NULL AND release_note IS NULL) OR (checked_out_at IS NOT NULL AND released_by IS NOT NULL AND pickup_snapshot IS NOT NULL AND release_note IS NOT NULL))
);
CREATE UNIQUE INDEX care_one_open_child ON care_sessions(org_id,student_id) WHERE checked_out_at IS NULL;
CREATE INDEX care_program_time ON care_sessions(org_id,program_id,checked_in_at);
CREATE FUNCTION protect_care_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Care sessions cannot be deleted'; END IF;
 IF OLD.checked_out_at IS NOT NULL OR NEW.checked_out_at IS NULL OR
 (to_jsonb(NEW)-ARRAY['checked_out_at','released_by','pickup_snapshot','release_note']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['checked_out_at','released_by','pickup_snapshot','release_note'])
 THEN RAISE EXCEPTION 'Care session evidence cannot be changed'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER immutable_care_session BEFORE UPDATE OR DELETE ON care_sessions FOR EACH ROW EXECUTE FUNCTION protect_care_session();
CREATE TABLE care_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_care_command BEFORE UPDATE OR DELETE ON care_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
