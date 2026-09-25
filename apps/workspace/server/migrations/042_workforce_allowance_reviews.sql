CREATE TABLE workforce_allowance_reviews (
 id uuid PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 command_id uuid NOT NULL,
 query jsonb NOT NULL CHECK(jsonb_typeof(query)='object'),
 unit_ids uuid[] NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,command_id)
);
CREATE INDEX workforce_allowance_reviews_org ON workforce_allowance_reviews(org_id,created_at DESC,id);
CREATE TRIGGER immutable_workforce_allowance_reviews BEFORE UPDATE OR DELETE ON workforce_allowance_reviews FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
