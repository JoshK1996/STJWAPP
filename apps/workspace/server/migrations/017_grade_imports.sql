CREATE TABLE grade_import_batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, actor_id uuid NOT NULL,
 book_id uuid NOT NULL, assignment_id uuid NOT NULL,
 source_base64 text NOT NULL, source_hash text NOT NULL, plan_hash text NOT NULL,
 plan jsonb NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 applied_at timestamptz, receipt jsonb,
 FOREIGN KEY(org_id,unit_id,book_id,assignment_id) REFERENCES grade_assignments(org_id,unit_id,book_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 CHECK((applied_at IS NULL AND receipt IS NULL) OR (applied_at IS NOT NULL AND receipt IS NOT NULL))
);
CREATE INDEX grade_import_owner ON grade_import_batches(org_id,actor_id,assignment_id,created_at DESC);
CREATE TRIGGER immutable_grade_import BEFORE UPDATE OR DELETE ON grade_import_batches FOR EACH ROW EXECUTE FUNCTION protect_school_import();
