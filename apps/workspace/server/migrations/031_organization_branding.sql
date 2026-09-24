-- Owner-published workspace presentation, without seeded branding or preference changes.
CREATE TABLE organization_branding_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
 version integer NOT NULL CHECK(version>0), command_id uuid NOT NULL,
 previous_history_id uuid, before_version integer NOT NULL CHECK(before_version>=0),
 before_settings_hash text NOT NULL CHECK(before_settings_hash ~ '^[a-f0-9]{64}$'),
 before_state jsonb NOT NULL, after_state jsonb NOT NULL,
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 actor_id uuid NOT NULL, actor_name text NOT NULL CHECK(length(actor_name) BETWEEN 1 AND 240),
 created_at timestamptz NOT NULL,
 UNIQUE(org_id,version), UNIQUE(org_id,id,version,settings_hash),
 UNIQUE(org_id,id,version,settings_hash,actor_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,previous_history_id,before_version,before_settings_hash)
  REFERENCES organization_branding_history(org_id,id,version,settings_hash),
 CHECK(before_version=version-1),
 CHECK((version=1 AND previous_history_id IS NULL) OR (version>1 AND previous_history_id IS NOT NULL)),
 CHECK(coalesce(jsonb_typeof(before_state)='object' AND jsonb_typeof(after_state)='object'
  AND before_state ?& ARRAY['schemaVersion','configured','version','settings','settingsHash','updatedAt']
  AND after_state ?& ARRAY['schemaVersion','configured','version','settings','settingsHash','updatedAt']
  AND before_state->>'schemaVersion'='1' AND after_state->>'schemaVersion'='1'
  AND before_state->>'version'=before_version::text AND after_state->>'version'=version::text
  AND before_state->>'settingsHash'=before_settings_hash AND after_state->>'settingsHash'=settings_hash
  AND after_state->'configured'='true'::jsonb AND jsonb_typeof(after_state->'settings')='object'
  AND jsonb_typeof(before_state->'settings')='object'
  AND after_state->>'updatedAt'=to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  AND ((version=1 AND before_state->'configured'='false'::jsonb AND before_state->'updatedAt'='null'::jsonb)
   OR (version>1 AND before_state->'configured'='true'::jsonb AND jsonb_typeof(before_state->'updatedAt')='string')),false)),
 CHECK(octet_length(before_state::text)<=16384 AND octet_length(after_state::text)<=16384)
);
CREATE TRIGGER immutable_organization_branding_history BEFORE UPDATE OR DELETE ON organization_branding_history
 FOR EACH ROW EXECUTE FUNCTION protect_audit_events();

CREATE TABLE organization_branding (
 org_id uuid PRIMARY KEY REFERENCES organizations(id), version integer NOT NULL CHECK(version>0),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'), history_id uuid NOT NULL,
 updated_at timestamptz NOT NULL,
 FOREIGN KEY(org_id,history_id,version,settings_hash) REFERENCES organization_branding_history(org_id,id,version,settings_hash),
 CHECK(octet_length(settings::text)<=16384)
);
CREATE FUNCTION protect_organization_branding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Published organization appearance cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 THEN RAISE EXCEPTION 'Organization appearance begins at version one'; END IF;
 ELSE
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.version::bigint<>OLD.version::bigint+1 THEN
   RAISE EXCEPTION 'Organization appearance identity is immutable and its version must advance once';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_organization_branding BEFORE INSERT OR UPDATE OR DELETE ON organization_branding
 FOR EACH ROW EXECUTE FUNCTION protect_organization_branding();

CREATE FUNCTION check_organization_branding_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row organization_branding%ROWTYPE;
 latest organization_branding_history%ROWTYPE;
 previous organization_branding_history%ROWTYPE;
BEGIN
 SELECT * INTO current_row FROM organization_branding WHERE org_id=NEW.org_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization appearance history requires its current pointer'; END IF;
 SELECT * INTO latest FROM organization_branding_history WHERE org_id=NEW.org_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR (current_row.history_id,current_row.version,current_row.settings_hash)
  IS DISTINCT FROM (latest.id,latest.version,latest.settings_hash)
  OR current_row.settings IS DISTINCT FROM latest.after_state->'settings'
  OR current_row.updated_at IS DISTINCT FROM latest.created_at THEN
  RAISE EXCEPTION 'Organization appearance current pointer must match its latest retained history';
 END IF;
 IF TG_TABLE_NAME='organization_branding_history' AND NEW.version>1 THEN
  SELECT * INTO previous FROM organization_branding_history WHERE org_id=NEW.org_id AND id=NEW.previous_history_id;
  IF NOT FOUND OR NEW.before_state IS DISTINCT FROM previous.after_state THEN
   RAISE EXCEPTION 'Organization appearance before evidence must match its exact predecessor';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organization_branding_current_chain AFTER INSERT OR UPDATE ON organization_branding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_organization_branding_chain();
CREATE CONSTRAINT TRIGGER organization_branding_history_chain AFTER INSERT ON organization_branding_history
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_organization_branding_chain();

CREATE TABLE organization_branding_commands (
 org_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid NOT NULL, command_id uuid NOT NULL,
 history_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result_text text NOT NULL CHECK(octet_length(result_text) BETWEEN 1 AND 16384),
 result_hash text NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,history_id,version,settings_hash,actor_id,command_id)
  REFERENCES organization_branding_history(org_id,id,version,settings_hash,actor_id,command_id)
);
CREATE TRIGGER immutable_organization_branding_commands BEFORE UPDATE OR DELETE ON organization_branding_commands
 FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
