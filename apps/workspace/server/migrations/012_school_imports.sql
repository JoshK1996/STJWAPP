CREATE TABLE school_import_batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, actor_id uuid NOT NULL,
 context jsonb NOT NULL, source_hash text NOT NULL, plan_hash text NOT NULL,
 input_rows jsonb NOT NULL, plan jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 applied_at timestamptz, receipt jsonb,
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 CHECK((applied_at IS NULL AND receipt IS NULL) OR (applied_at IS NOT NULL AND receipt IS NOT NULL))
);
CREATE INDEX school_import_owner ON school_import_batches(org_id,actor_id,created_at DESC);
CREATE FUNCTION protect_school_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Import evidence is immutable'; END IF;
 IF OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL OR NEW.receipt IS NULL OR
    (to_jsonb(NEW)-'applied_at'-'receipt') IS DISTINCT FROM (to_jsonb(OLD)-'applied_at'-'receipt')
 THEN RAISE EXCEPTION 'Only an unapplied import may receive its receipt'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_school_import BEFORE UPDATE OR DELETE ON school_import_batches FOR EACH ROW EXECUTE FUNCTION protect_school_import();
