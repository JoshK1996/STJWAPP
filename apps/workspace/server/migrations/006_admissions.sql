CREATE TABLE admission_settings (
 org_id uuid NOT NULL, unit_id uuid PRIMARY KEY, requirements jsonb NOT NULL DEFAULT '[]', confirmed boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE TABLE admission_applications (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL, applicant_id uuid NOT NULL,
 primary_contact_id uuid, existing_student_id uuid, enrolled_student_id uuid, grade_level text NOT NULL,
 status text NOT NULL DEFAULT 'inquiry' CHECK(status IN ('inquiry','application','review','offered','accepted','enrolled','declined','withdrawn')),
 checklist jsonb NOT NULL DEFAULT '[]', policy_version integer NOT NULL DEFAULT 0,
 notes text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(created_by,command_id),
 UNIQUE(year_id,applicant_id), FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,applicant_id) REFERENCES school_people(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,primary_contact_id) REFERENCES school_people(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,existing_student_id) REFERENCES students(org_id,unit_id,id), FOREIGN KEY(org_id,unit_id,enrolled_student_id) REFERENCES students(org_id,unit_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE INDEX admission_application_queue ON admission_applications(org_id,unit_id,year_id,status,created_at);
