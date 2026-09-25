-- Immediate administrator entry/clock-out is a distinct terminal action.
-- Retained requests, approvals, source snapshots and command receipts are unchanged.
ALTER TABLE time_adjustment_requests
 DROP CONSTRAINT time_adjustment_requests_status_check,
 DROP CONSTRAINT time_adjustment_requests_check4,
 DROP CONSTRAINT time_adjustment_requests_check5,
 ADD CONSTRAINT time_adjustment_requests_status_check CHECK(status IN('pending','approved','declined','cancelled','applied')),
 ADD CONSTRAINT time_adjustment_requests_decision_check CHECK(
   (status='pending' AND version=1 AND resolved_by IS NULL AND resolver_name IS NULL AND resolution_note IS NULL AND resolved_at IS NULL)
   OR (status<>'pending' AND version=CASE WHEN status='applied' THEN 1 ELSE 2 END AND resolved_by IS NOT NULL AND resolver_name IS NOT NULL
     AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 10 AND 2000 AND resolved_at IS NOT NULL)),
 ADD CONSTRAINT time_adjustment_requests_result_check CHECK(
   (status IN('approved','applied') AND result_shift_id IS NOT NULL AND result_revision IS NOT NULL AND result_snapshot IS NOT NULL AND result_hash IS NOT NULL AND result_hash ~ '^[a-f0-9]{64}$')
   OR (status NOT IN('approved','applied') AND result_shift_id IS NULL AND result_revision IS NULL AND result_snapshot IS NULL AND result_hash IS NULL)),
 ADD CONSTRAINT time_adjustment_requests_direct_actor_check CHECK(status<>'applied' OR (resolved_by=proposed_by AND resolved_by<>user_id));

DROP INDEX time_adjustment_applied_revision;
CREATE UNIQUE INDEX time_adjustment_applied_revision ON time_adjustment_requests(org_id,result_shift_id,result_revision) WHERE status IN('approved','applied');

CREATE OR REPLACE FUNCTION protect_time_adjustment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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

ALTER TABLE time_adjustment_history
 DROP CONSTRAINT time_adjustment_history_action_check,
 DROP CONSTRAINT time_adjustment_history_check1,
 ADD CONSTRAINT time_adjustment_history_action_check CHECK(action IN('proposed','approved','declined','cancelled','applied')),
 ADD CONSTRAINT time_adjustment_history_action_version_check CHECK((version=1 AND action IN('proposed','applied')) OR (version=2 AND action IN('approved','declined','cancelled')));
ALTER TABLE time_adjustment_commands
 DROP CONSTRAINT time_adjustment_commands_action_check,
 ADD CONSTRAINT time_adjustment_commands_action_check CHECK(action IN('propose','review','cancel','direct'));
