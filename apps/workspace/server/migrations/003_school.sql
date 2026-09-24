CREATE TABLE school_office_grants (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, user_id uuid NOT NULL, granted_by uuid NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(unit_id,user_id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,granted_by) REFERENCES users(org_id,id)
);
CREATE TABLE school_years (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, name text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL,
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 UNIQUE(org_id,unit_id,id), UNIQUE(unit_id,name), CHECK(ends_on>=starts_on), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE school_terms (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, name text NOT NULL,
 starts_on date NOT NULL, ends_on date NOT NULL, locked_at timestamptz, version integer NOT NULL DEFAULT 1,
 UNIQUE(org_id,unit_id,id), UNIQUE(year_id,name), CHECK(ends_on>=starts_on), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id)
);
CREATE TABLE school_people (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, name text NOT NULL,
 email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', date_of_birth date,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE households (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, name text NOT NULL, address text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false, UNIQUE(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE household_members (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, household_id uuid NOT NULL, person_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('student','guardian','other')), PRIMARY KEY(household_id,person_id),
 FOREIGN KEY(org_id,unit_id,household_id) REFERENCES households(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,person_id) REFERENCES school_people(org_id,unit_id,id)
);
CREATE TABLE students (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, person_id uuid NOT NULL, student_number text NOT NULL,
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,unit_id,id), UNIQUE(unit_id,student_number), UNIQUE(person_id), FOREIGN KEY(org_id,unit_id,person_id) REFERENCES school_people(org_id,unit_id,id)
);
CREATE TABLE student_contacts (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, student_id uuid NOT NULL, person_id uuid NOT NULL, relationship text NOT NULL,
 is_guardian boolean NOT NULL DEFAULT false, can_communicate boolean NOT NULL DEFAULT false, can_pickup boolean NOT NULL DEFAULT false,
 pickup_until date, emergency_priority integer CHECK(emergency_priority BETWEEN 1 AND 20), restriction_note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(student_id,person_id), FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,person_id) REFERENCES school_people(org_id,unit_id,id)
);
CREATE TABLE student_enrollments (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, student_id uuid NOT NULL, year_id uuid NOT NULL,
 grade_level text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, status text NOT NULL DEFAULT 'enrolled' CHECK(status IN ('enrolled','withdrawn','completed')),
 version integer NOT NULL DEFAULT 1, UNIQUE(student_id,year_id), UNIQUE(org_id,unit_id,id), CHECK(ends_on>=starts_on),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id)
);
CREATE TABLE courses (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, code text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, UNIQUE(org_id,unit_id,id), UNIQUE(unit_id,code), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE sections (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, course_id uuid, name text NOT NULL,
 homeroom boolean NOT NULL DEFAULT false, capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 200), room text NOT NULL DEFAULT '',
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, UNIQUE(org_id,unit_id,id), UNIQUE(year_id,name),
 FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,course_id) REFERENCES courses(org_id,unit_id,id)
);
CREATE TABLE section_teachers (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(section_id,user_id),
 FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE section_students (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, student_id uuid NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(section_id,student_id), CHECK(ends_on>=starts_on), FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id)
);
CREATE TABLE curriculum_items (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, title text NOT NULL,
 content text NOT NULL, sort_order integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false,
 FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id)
);
CREATE TABLE school_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
 actor_id uuid NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE INDEX school_history_record ON school_history(org_id,entity_id,created_at);
CREATE TRIGGER immutable_school_history BEFORE UPDATE OR DELETE ON school_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX school_student_name ON school_people(org_id,unit_id,name);
CREATE INDEX section_teacher_scope ON section_teachers(org_id,user_id);
CREATE INDEX section_student_scope ON section_students(org_id,student_id);
CREATE TABLE demo_fixtures (org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,name));
