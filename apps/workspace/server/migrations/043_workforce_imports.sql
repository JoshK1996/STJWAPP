CREATE TABLE workforce_import_batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('jobs','schedules')),
 source_base64 text NOT NULL CHECK(octet_length(source_base64)<=1066668),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
 unit_ids uuid[] NOT NULL CHECK(cardinality(unit_ids) BETWEEN 1 AND 100),
 display_rows jsonb NOT NULL CHECK(jsonb_typeof(display_rows)='array' AND jsonb_array_length(display_rows) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 applied_at timestamptz, receipt jsonb,
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 CHECK((applied_at IS NULL)=(receipt IS NULL))
);
CREATE INDEX workforce_import_batches_owner ON workforce_import_batches(org_id,actor_id,created_at DESC);
CREATE FUNCTION preserve_workforce_import_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workforce import evidence is immutable'; END IF;
 IF OLD.applied_at IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
 OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.kind IS DISTINCT FROM OLD.kind
 OR NEW.source_base64 IS DISTINCT FROM OLD.source_base64 OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
 OR NEW.context_hash IS DISTINCT FROM OLD.context_hash OR NEW.display_rows IS DISTINCT FROM OLD.display_rows
 OR NEW.unit_ids IS DISTINCT FROM OLD.unit_ids
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.applied_at IS NULL OR NEW.receipt IS NULL
 THEN RAISE EXCEPTION 'Workforce import evidence is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER workforce_import_evidence_immutable BEFORE UPDATE OR DELETE ON workforce_import_batches
 FOR EACH ROW EXECUTE FUNCTION preserve_workforce_import_evidence();
