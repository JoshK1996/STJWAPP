ALTER TABLE users ADD COLUMN clock_authority_version bigint NOT NULL DEFAULT 1 CHECK(clock_authority_version>0);
CREATE FUNCTION advance_clock_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.password_hash,OLD.pin_hash,OLD.active,OLD.requires_credential_change)
    IS DISTINCT FROM (NEW.password_hash,NEW.pin_hash,NEW.active,NEW.requires_credential_change) THEN
  NEW.clock_authority_version:=OLD.clock_authority_version+1;
 ELSE NEW.clock_authority_version:=OLD.clock_authority_version;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER advance_clock_authority_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION advance_clock_authority();

CREATE TABLE clock_employee_policies (
 org_id uuid NOT NULL,user_id uuid PRIMARY KEY,no_early_clock_in boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),FOREIGN KEY(org_id,updated_by) REFERENCES users(org_id,id)
);
CREATE TABLE clock_intents (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,user_id uuid NOT NULL,schedule_id uuid NOT NULL,schedule_version integer NOT NULL,
 job_id uuid NOT NULL,unit_id uuid NOT NULL,job_title text NOT NULL,unit_name text NOT NULL,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 policy_version integer NOT NULL CHECK(policy_version>0),authority_version bigint NOT NULL CHECK(authority_version>0),
 authentication text NOT NULL CHECK(authentication IN ('password','pin')),
 execution_command_id uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executed','cancelled','blocked')),
 version integer NOT NULL DEFAULT 1,processed_at timestamptz,reason text NOT NULL DEFAULT '',shift_id uuid,
 UNIQUE(org_id,id),FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,schedule_id) REFERENCES schedules(org_id,id),FOREIGN KEY(schedule_id,schedule_version) REFERENCES staff_schedule_history(schedule_id,version),
 FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id),FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,shift_id) REFERENCES shifts(org_id,id),
 CHECK((status='pending' AND version=1 AND processed_at IS NULL AND shift_id IS NULL AND reason='')
    OR (status<>'pending' AND version=2 AND processed_at IS NOT NULL AND length(reason)>0)),
 CHECK((status='executed')=(shift_id IS NOT NULL))
);
CREATE UNIQUE INDEX clock_intents_one_pending ON clock_intents(org_id,user_id) WHERE status='pending';
CREATE INDEX clock_intents_pending_due ON clock_intents(starts_at,checked_at,id) WHERE status='pending';
CREATE INDEX clock_intents_employee_history ON clock_intents(org_id,user_id,created_at DESC,id DESC);
CREATE FUNCTION protect_clock_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scheduled clock evidence cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.version<>1 THEN RAISE EXCEPTION 'Scheduled clock intent must begin pending'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'pending' THEN RAISE EXCEPTION 'Completed scheduled clock evidence is immutable'; END IF;
 IF NEW.status='pending' THEN
  IF (to_jsonb(OLD)-'checked_at') IS DISTINCT FROM (to_jsonb(NEW)-'checked_at') THEN
   RAISE EXCEPTION 'Pending scheduled clock evidence is immutable';
  END IF;
 ELSE
  IF NEW.version<>2 OR (to_jsonb(OLD)-ARRAY['status','version','processed_at','reason','shift_id','checked_at'])
      IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','version','processed_at','reason','shift_id','checked_at']) THEN
   RAISE EXCEPTION 'Original scheduled clock authorization cannot change';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_clock_intent BEFORE INSERT OR UPDATE OR DELETE ON clock_intents FOR EACH ROW EXECUTE FUNCTION protect_clock_intent();
CREATE TABLE clock_intent_events (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,intent_id uuid NOT NULL,actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('queued','executed','cancelled','blocked')),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(intent_id,action),FOREIGN KEY(org_id,intent_id) REFERENCES clock_intents(org_id,id),FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_clock_intent_events BEFORE UPDATE OR DELETE ON clock_intent_events FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE clock_intent_commands (
 org_id uuid NOT NULL,user_id uuid NOT NULL,command_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id,command_id),FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_clock_intent_commands BEFORE UPDATE OR DELETE ON clock_intent_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
