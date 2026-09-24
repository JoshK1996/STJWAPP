-- Configuration and explicit confirmation only. No student standing decisions.
CREATE TABLE standing_policies (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, year_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), archived boolean NOT NULL DEFAULT false,
 configuration jsonb NOT NULL, draft_hash text NOT NULL CHECK(draft_hash ~ '^[a-f0-9]{64}$'),
 catalog_hash text NOT NULL CHECK(catalog_hash ~ '^[a-f0-9]{64}$'), evidence jsonb NOT NULL,
 active_policy_version_id uuid, confirmed_version integer NOT NULL DEFAULT 0 CHECK(confirmed_version>=0),
 confirmed_configuration_hash text,
 created_by uuid NOT NULL, updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id),
 CHECK((confirmed_version=0 AND active_policy_version_id IS NULL AND confirmed_configuration_hash IS NULL)
   OR (confirmed_version>0 AND active_policy_version_id IS NOT NULL AND confirmed_configuration_hash ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX standing_policies_scope ON standing_policies(org_id,unit_id,year_id,id DESC);
CREATE FUNCTION protect_standing_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Standing policy evidence cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.confirmed_version<>0 OR NEW.archived THEN RAISE EXCEPTION 'Standing policies begin as unconfirmed drafts'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.version<>OLD.version+1 OR NEW.confirmed_version NOT IN (OLD.confirmed_version,OLD.confirmed_version+1) THEN
  RAISE EXCEPTION 'Standing policy version must advance exactly once';
 END IF;
 IF (NEW.id,NEW.org_id,NEW.unit_id,NEW.year_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.org_id,OLD.unit_id,OLD.year_id,OLD.created_by,OLD.created_at) THEN
  RAISE EXCEPTION 'Standing policy identity is immutable';
 END IF;
 IF NEW.confirmed_version=OLD.confirmed_version AND
   (NEW.active_policy_version_id,NEW.confirmed_configuration_hash) IS DISTINCT FROM (OLD.active_policy_version_id,OLD.confirmed_configuration_hash) THEN
  RAISE EXCEPTION 'Standing policy confirmation pointer requires a new version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_standing_policy BEFORE INSERT OR UPDATE OR DELETE ON standing_policies FOR EACH ROW EXECUTE FUNCTION protect_standing_policy();
CREATE TABLE standing_policy_versions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, policy_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), draft_version integer NOT NULL CHECK(draft_version>0),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
 configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
 policy jsonb NOT NULL, evidence jsonb NOT NULL,
 source_description text NOT NULL CHECK(length(source_description) BETWEEN 10 AND 2000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
 confirmed_by uuid NOT NULL, confirmed_name text NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(policy_id,version), UNIQUE(org_id,policy_id,id),
 FOREIGN KEY(org_id,policy_id) REFERENCES standing_policies(org_id,id),
 FOREIGN KEY(org_id,confirmed_by) REFERENCES users(org_id,id),
 CHECK(policy->>'policyId'=policy_id::text AND policy->>'orgId'=org_id::text AND (policy->>'version')::integer=version)
);
ALTER TABLE standing_policies ADD CONSTRAINT standing_policy_active_version FOREIGN KEY(org_id,id,active_policy_version_id) REFERENCES standing_policy_versions(org_id,policy_id,id);
CREATE TRIGGER immutable_standing_policy_versions BEFORE UPDATE OR DELETE ON standing_policy_versions FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE standing_policy_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, policy_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), action text NOT NULL CHECK(action IN ('created','updated','confirmed','archived','restored')),
 before_state jsonb, after_state jsonb NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), actor_id uuid NOT NULL, actor_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(policy_id,version),
 FOREIGN KEY(org_id,policy_id) REFERENCES standing_policies(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_standing_policy_history BEFORE UPDATE OR DELETE ON standing_policy_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE standing_policy_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 policy_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,actor_id,command_id),
 FOREIGN KEY(org_id,policy_id) REFERENCES standing_policies(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_standing_policy_commands BEFORE UPDATE OR DELETE ON standing_policy_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
