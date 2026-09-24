-- Retain exact new sources and genuine creation receipts. No history is reconstructed.
ALTER TABLE import_batches ADD COLUMN evidence_version smallint NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2));
ALTER TABLE import_batches ADD COLUMN source_base64 text;
ALTER TABLE import_batches ADD COLUMN receipt jsonb;
ALTER TABLE import_batches ADD CONSTRAINT staff_import_hash CHECK(source_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE import_batches ADD CONSTRAINT staff_import_rows CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows) BETWEEN 1 AND 500);
ALTER TABLE import_batches ADD CONSTRAINT staff_import_source CHECK(
 (evidence_version=1 AND source_base64 IS NULL) OR
 (evidence_version=2 AND source_base64 IS NOT NULL AND octet_length(source_base64) BETWEEN 4 AND 2133336 AND source_base64 ~ '^[A-Za-z0-9+/]*={0,2}$'));
ALTER TABLE import_batches ADD CONSTRAINT staff_import_receipt_state CHECK(
 (applied_at IS NULL AND receipt IS NULL) OR
 (applied_at IS NOT NULL AND ((evidence_version=1 AND receipt IS NULL) OR (receipt IS NOT NULL AND jsonb_typeof(receipt)='object'))));
CREATE INDEX staff_import_owner_history ON import_batches(org_id,actor_id,created_at DESC,id DESC);
CREATE FUNCTION protect_staff_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Staff import evidence is retained'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.applied_at IS NOT NULL OR NEW.receipt IS NOT NULL THEN RAISE EXCEPTION 'New staff imports must be pending'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.org_id,NEW.actor_id,NEW.source_hash,NEW.rows,NEW.created_at,NEW.evidence_version,NEW.source_base64)
    IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.actor_id,OLD.source_hash,OLD.rows,OLD.created_at,OLD.evidence_version,OLD.source_base64)
    OR OLD.applied_at IS NOT NULL OR OLD.receipt IS NOT NULL OR NEW.applied_at IS NULL THEN
  RAISE EXCEPTION 'Staff import evidence permits only one pending-to-applied transition';
 END IF;
 IF NEW.receipt IS NULL THEN
  IF NEW.evidence_version<>1 THEN RAISE EXCEPTION 'New staff imports require a retained receipt'; END IF;
 ELSE
  IF jsonb_typeof(NEW.receipt)<>'object' OR NOT (NEW.receipt ?& ARRAY['schemaVersion','batchId','sourceHash','created','appliedAt','accounts','notice'])
    OR NEW.receipt->>'schemaVersion' IS DISTINCT FROM '1'
    OR NEW.receipt->>'batchId' IS DISTINCT FROM NEW.id::text
    OR NEW.receipt->>'sourceHash' IS DISTINCT FROM NEW.source_hash
    OR (NEW.receipt->>'appliedAt')::timestamptz IS DISTINCT FROM NEW.applied_at
    OR jsonb_typeof(NEW.receipt->'created') IS DISTINCT FROM 'number'
    OR (NEW.receipt->>'created')::integer IS DISTINCT FROM jsonb_array_length(NEW.rows)
    OR jsonb_typeof(NEW.receipt->'accounts') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.receipt->'accounts') IS DISTINCT FROM jsonb_array_length(NEW.rows)
  THEN RAISE EXCEPTION 'Staff import receipt does not match its evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_staff_import BEFORE INSERT OR UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION protect_staff_import();
