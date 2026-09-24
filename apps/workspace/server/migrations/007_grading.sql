CREATE TABLE grading_settings (
 org_id uuid NOT NULL, unit_id uuid PRIMARY KEY, policy jsonb NOT NULL, confirmed boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE TABLE gradebooks (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, section_id uuid NOT NULL, term_id uuid NOT NULL,
 policy jsonb NOT NULL, policy_version integer NOT NULL, roster jsonb NOT NULL, roster_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','locked')), version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(section_id,term_id), UNIQUE(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,section_id) REFERENCES sections(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,term_id) REFERENCES school_terms(org_id,unit_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE grade_assignments (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, book_id uuid NOT NULL,
 command_id uuid NOT NULL, command_fingerprint text NOT NULL, created_by uuid NOT NULL,
 title text NOT NULL, instructions text NOT NULL DEFAULT '', category_id uuid NOT NULL, due_on date NOT NULL,
 max_points_units integer NOT NULL CHECK(max_points_units BETWEEN 1 AND 1000000), archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(book_id,command_id), UNIQUE(org_id,unit_id,book_id,id),
 FOREIGN KEY(org_id,unit_id,book_id) REFERENCES gradebooks(org_id,unit_id,id), FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE grade_scores (
 org_id uuid NOT NULL, unit_id uuid NOT NULL, book_id uuid NOT NULL, assignment_id uuid NOT NULL, student_id uuid NOT NULL,
 student_name text NOT NULL, expected boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'ungraded' CHECK(status IN ('ungraded','scored','missing','exempt','incomplete')),
 points_units integer CHECK(points_units BETWEEN 0 AND 1000000), note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(assignment_id,student_id),
 CHECK((status='scored')=(points_units IS NOT NULL)),
 FOREIGN KEY(org_id,unit_id,book_id,assignment_id) REFERENCES grade_assignments(org_id,unit_id,book_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id)
);
CREATE TABLE gradebook_releases (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, book_id uuid NOT NULL, book_version integer NOT NULL,
 snapshot jsonb NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(book_id,book_version), FOREIGN KEY(org_id,unit_id,book_id) REFERENCES gradebooks(org_id,unit_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_gradebook_releases BEFORE UPDATE OR DELETE ON gradebook_releases FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX gradebook_scope ON gradebooks(org_id,unit_id,section_id);
CREATE INDEX grade_assignment_book ON grade_assignments(book_id,due_on);
CREATE INDEX grade_score_student ON grade_scores(org_id,student_id);
