CREATE TABLE attendance_settings (
 org_id uuid NOT NULL, unit_id uuid PRIMARY KEY, weekdays integer[] NOT NULL DEFAULT '{}', periods jsonb NOT NULL DEFAULT '[]',
 confirmed boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE TABLE attendance_codes (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, code text NOT NULL, label text NOT NULL,
 category text NOT NULL CHECK(category IN ('present','absent','tardy','early','other')), excused boolean NOT NULL DEFAULT false,
 reason_required boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 UNIQUE(org_id,unit_id,id), UNIQUE(unit_id,code), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE school_day_overrides (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, day date NOT NULL, instructional boolean NOT NULL, label text NOT NULL, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(year_id,day), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id)
);
CREATE TABLE attendance_sessions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, year_id uuid NOT NULL,
 day date NOT NULL, period text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
 version integer NOT NULL DEFAULT 1, submitted_by uuid, submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,unit_id,id), UNIQUE(section_id,day,period), FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id), FOREIGN KEY(org_id,submitted_by) REFERENCES users(org_id,id)
);
CREATE TABLE attendance_marks (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, session_id uuid NOT NULL, student_id uuid NOT NULL, expected boolean NOT NULL DEFAULT true,
 student_name text NOT NULL, student_number text NOT NULL, code_id uuid, code_snapshot jsonb, note text NOT NULL DEFAULT '',
 PRIMARY KEY(session_id,student_id), FOREIGN KEY(org_id,unit_id,session_id) REFERENCES attendance_sessions(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,code_id) REFERENCES attendance_codes(org_id,unit_id,id)
);
CREATE TABLE attendance_revisions (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, session_id uuid NOT NULL, version integer NOT NULL,
 actor_id uuid NOT NULL, action text NOT NULL, reason text NOT NULL DEFAULT '', snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,version), FOREIGN KEY(org_id,unit_id,session_id) REFERENCES attendance_sessions(org_id,unit_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_attendance_history BEFORE UPDATE OR DELETE ON attendance_revisions FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE attendance_closeouts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, day date NOT NULL, period text NOT NULL,
 closed_at timestamptz, closed_by uuid, reason text NOT NULL, fingerprint text NOT NULL, snapshot jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, UNIQUE(unit_id,year_id,day,period), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id), FOREIGN KEY(org_id,closed_by) REFERENCES users(org_id,id)
);
CREATE INDEX attendance_daily ON attendance_sessions(org_id,unit_id,day,period);
CREATE INDEX attendance_student ON attendance_marks(org_id,student_id,session_id);
