-- Personal filter definitions only. No captured payroll rows or policy calculations.
CREATE TABLE payroll_saved_views (
 org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL, id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80 AND name=btrim(name)),
 filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object' AND octet_length(filters::text)<=4096),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 creation_fingerprint text NOT NULL CHECK(creation_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
 PRIMARY KEY(org_id,user_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 CHECK(filters ?& ARRAY['period','group','comparePrevious']
  AND filters - ARRAY['period','start','end','group','unitId','userId','comparePrevious'] = '{}'::jsonb
  AND filters->>'period' IN ('this_week','last_week','last_14_days','this_month','custom')
  AND filters->>'group' IN ('hour','day','week','month','year')
  AND jsonb_typeof(filters->'comparePrevious')='boolean'
  AND CASE WHEN filters->>'period'='custom' THEN filters ?& ARRAY['start','end']
    AND jsonb_typeof(filters->'start')='string' AND jsonb_typeof(filters->'end')='string'
   ELSE NOT(filters ? 'start' OR filters ? 'end') END)
);
CREATE INDEX payroll_saved_views_active ON payroll_saved_views(org_id,user_id,updated_at DESC,id) WHERE deleted_at IS NULL;

CREATE FUNCTION protect_payroll_saved_views() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Saved payroll views must retain their deletion evidence'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Saved payroll views begin active at revision one'; END IF;
 ELSE
  IF OLD.deleted_at IS NOT NULL OR (NEW.org_id,NEW.user_id,NEW.id,NEW.creation_fingerprint,NEW.created_at)
    IS DISTINCT FROM (OLD.org_id,OLD.user_id,OLD.id,OLD.creation_fingerprint,OLD.created_at)
    OR NEW.revision::bigint<>OLD.revision::bigint+1 THEN
   RAISE EXCEPTION 'Saved payroll view identity is immutable and each change advances its revision';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_payroll_saved_views BEFORE INSERT OR UPDATE OR DELETE ON payroll_saved_views
 FOR EACH ROW EXECUTE FUNCTION protect_payroll_saved_views();
