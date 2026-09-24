CREATE TABLE dismissal_settings (
 org_id uuid NOT NULL, unit_id uuid PRIMARY KEY, confirmed boolean NOT NULL, instructions text NOT NULL,
 version integer NOT NULL DEFAULT 1, FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE dismissal_staff (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(unit_id,user_id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE dismissal_runs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, day date NOT NULL,
 status text NOT NULL CHECK(status IN ('open','closed')), policy_snapshot jsonb NOT NULL, roster_fingerprint text NOT NULL,
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(unit_id,day), UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE dismissal_buses (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, run_id uuid NOT NULL, name text NOT NULL, driver_name text NOT NULL, vehicle text NOT NULL,
 version integer NOT NULL DEFAULT 1, arrived_at timestamptz, arrival_snapshot jsonb,
 UNIQUE(org_id,unit_id,run_id,id), UNIQUE(run_id,name), FOREIGN KEY(org_id,unit_id,run_id) REFERENCES dismissal_runs(org_id,unit_id,id),
 CHECK((arrived_at IS NULL)=(arrival_snapshot IS NULL))
);
CREATE TABLE dismissal_entries (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, run_id uuid NOT NULL, student_id uuid NOT NULL,
 student_name text NOT NULL, student_number text NOT NULL, grade_level text NOT NULL, expected boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'unaccounted' CHECK(status IN ('unaccounted','present','called','released','absent')),
 mode text CHECK(mode IN ('pickup','bus')), bus_id uuid, version integer NOT NULL DEFAULT 1,
 called_contact_id uuid, call_snapshot jsonb, release_snapshot jsonb, released_at timestamptz, released_by uuid, absence_reason text NOT NULL DEFAULT '',
 PRIMARY KEY(run_id,student_id), FOREIGN KEY(org_id,unit_id,run_id) REFERENCES dismissal_runs(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,run_id,bus_id) REFERENCES dismissal_buses(org_id,unit_id,run_id,id),
 FOREIGN KEY(org_id,unit_id,called_contact_id) REFERENCES school_people(org_id,unit_id,id), FOREIGN KEY(org_id,released_by) REFERENCES users(org_id,id),
 CHECK((mode='bus' AND bus_id IS NOT NULL) OR (mode IS DISTINCT FROM 'bus' AND bus_id IS NULL)),
 CHECK((status='released' AND released_at IS NOT NULL AND released_by IS NOT NULL AND release_snapshot IS NOT NULL) OR (status<>'released' AND released_at IS NULL AND released_by IS NULL AND release_snapshot IS NULL))
);
CREATE FUNCTION protect_dismissal_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dismissal entries cannot be deleted'; END IF;
 IF OLD.status='released' AND (to_jsonb(NEW)-'expected') IS DISTINCT FROM (to_jsonb(OLD)-'expected') THEN RAISE EXCEPTION 'Dismissal release evidence cannot be changed'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER immutable_dismissal_release BEFORE UPDATE OR DELETE ON dismissal_entries FOR EACH ROW EXECUTE FUNCTION protect_dismissal_release();
CREATE TABLE dismissal_closures (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, run_id uuid NOT NULL, run_version integer NOT NULL,
 actor_id uuid NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,unit_id,run_id) REFERENCES dismissal_runs(org_id,unit_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_dismissal_closure BEFORE UPDATE OR DELETE ON dismissal_closures FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE dismissal_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_dismissal_command BEFORE UPDATE OR DELETE ON dismissal_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX dismissal_date ON dismissal_runs(org_id,unit_id,day);
