-- Privileged users save their own time and resolve their own pending requests.
-- Existing records and immutable evidence remain unchanged. Manager self-review
-- is still rejected at the service boundary and in retained-request triggers.
DO $$ DECLARE item record; found_count integer;
BEGIN
 found_count:=0;
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='time_adjustment_requests'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%resolved_by <> proposed_by%'
   AND pg_get_constraintdef(oid) LIKE '%resolved_by <> user_id%' LOOP
  EXECUTE format('ALTER TABLE time_adjustment_requests DROP CONSTRAINT %I',item.conname);found_count:=found_count+1;
 END LOOP;
 IF found_count<>1 THEN RAISE EXCEPTION 'Expected one time adjustment independent-review constraint'; END IF;
 found_count:=0;
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='staff_schedule_requests'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%decided_by <> requester_id%' LOOP
  EXECUTE format('ALTER TABLE staff_schedule_requests DROP CONSTRAINT %I',item.conname);found_count:=found_count+1;
 END LOOP;
 IF found_count<>1 THEN RAISE EXCEPTION 'Expected one schedule independent-review constraint'; END IF;
END $$;
ALTER TABLE time_adjustment_requests DROP CONSTRAINT time_adjustment_requests_direct_actor_check,
 ADD CONSTRAINT time_adjustment_requests_direct_actor_check CHECK(status<>'applied' OR resolved_by=proposed_by);

CREATE OR REPLACE FUNCTION protect_time_adjustment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN('approved','declined') AND (NEW.resolved_by=NEW.proposed_by OR NEW.resolved_by=NEW.user_id)
   AND NOT EXISTS(SELECT 1 FROM users WHERE org_id=NEW.org_id AND id=NEW.resolved_by AND active AND NOT requires_credential_change AND role IN('developer','owner','admin')) THEN
  RAISE EXCEPTION 'A different manager must review this time adjustment';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Time adjustment evidence cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.status NOT IN('pending','applied') THEN RAISE EXCEPTION 'A time adjustment begins pending or directly applied at version one'; END IF;
  IF NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM users WHERE org_id=NEW.org_id AND id=NEW.resolved_by AND active AND NOT requires_credential_change AND role IN('admin','owner','developer')) THEN
   RAISE EXCEPTION 'A direct time adjustment requires an active administrator';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'pending' OR OLD.version<>1 OR NEW.status IN('pending','applied') OR NEW.version<>2
   OR (to_jsonb(NEW)-ARRAY['status','version','resolved_by','resolver_name','resolution_note','resolved_at','result_shift_id','result_revision','result_snapshot','result_hash']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','version','resolved_by','resolver_name','resolution_note','resolved_at','result_shift_id','result_revision','result_snapshot','result_hash']) THEN
  RAISE EXCEPTION 'Time adjustment source and terminal evidence are immutable';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_staff_schedule_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN('approved','declined') AND NEW.decided_by=NEW.requester_id
   AND NOT EXISTS(SELECT 1 FROM users WHERE org_id=NEW.org_id AND id=NEW.decided_by AND active AND NOT requires_credential_change AND role IN('developer','owner','admin')) THEN
  RAISE EXCEPTION 'A different manager must review this schedule request';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Schedule request evidence cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.version<>1 THEN RAISE EXCEPTION 'Schedule requests must begin pending'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'pending' OR OLD.version<>1 OR NEW.status NOT IN ('approved','declined','withdrawn') OR NEW.version<>2 THEN
  RAISE EXCEPTION 'Schedule request transition is immutable';
 END IF;
 IF (to_jsonb(OLD)-ARRAY['version','status','decided_by','decided_name','decided_note','decided_at','applied_schedule_version','applied_schedule'])
   IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['version','status','decided_by','decided_name','decided_note','decided_at','applied_schedule_version','applied_schedule']) THEN
  RAISE EXCEPTION 'Original schedule request evidence is immutable';
 END IF;
 RETURN NEW;
END $$;

