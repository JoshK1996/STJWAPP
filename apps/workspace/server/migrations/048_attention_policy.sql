CREATE TABLE workforce_attention_policy (
 org_id uuid PRIMARY KEY REFERENCES organizations(id),
 version integer NOT NULL CHECK(version>0),
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object'),
 updated_by uuid NOT NULL,
 updated_by_name text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE FUNCTION protect_workforce_attention_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Shared attention policy cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'Shared attention policy must begin at version 1'; END IF;
 ELSIF NEW.org_id<>OLD.org_id OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Shared attention policy identity and version must be preserved';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_workforce_attention_policy BEFORE INSERT OR UPDATE OR DELETE ON workforce_attention_policy FOR EACH ROW EXECUTE FUNCTION protect_workforce_attention_policy();
CREATE TABLE workforce_attention_history (
 org_id uuid NOT NULL REFERENCES organizations(id),
 version integer NOT NULL CHECK(version>0),
 actor_id uuid NOT NULL,
 command_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
 before_snapshot jsonb NOT NULL CHECK(jsonb_typeof(before_snapshot)='object'),
 after_snapshot jsonb NOT NULL CHECK(jsonb_typeof(after_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,version),
 UNIQUE(org_id,actor_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_workforce_attention_history BEFORE UPDATE OR DELETE ON workforce_attention_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
