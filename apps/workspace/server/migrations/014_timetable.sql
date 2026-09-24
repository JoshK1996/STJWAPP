CREATE TABLE timetable_revisions (
 org_id uuid PRIMARY KEY REFERENCES organizations(id), version integer NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE timetable_rooms (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, name text NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE UNIQUE INDEX timetable_room_name ON timetable_rooms(org_id,lower(name));
CREATE TABLE timetable_meetings (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, room_id uuid,
 starts_on date NOT NULL, ends_on date NOT NULL, weekdays integer[] NOT NULL,
 starts_at text NOT NULL, ends_at text NOT NULL, version integer NOT NULL DEFAULT 1,
 canceled boolean NOT NULL DEFAULT false, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_on>=starts_on AND ends_on-starts_on<367), CHECK(ends_at>starts_at),
 CHECK(starts_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ends_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]), CHECK(version>0),
 FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,room_id) REFERENCES timetable_rooms(org_id,unit_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE INDEX timetable_section ON timetable_meetings(org_id,section_id);
CREATE TABLE timetable_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_timetable_commands BEFORE UPDATE OR DELETE ON timetable_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
