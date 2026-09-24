CREATE TABLE staff_schedule_requests (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, schedule_id uuid NOT NULL, requester_id uuid NOT NULL,
 requester_name text NOT NULL, source_version integer NOT NULL CHECK(source_version>0),
 source_snapshot jsonb NOT NULL, source_job_id uuid NOT NULL, source_unit_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('update','cancel')),
 proposal jsonb, target_job_id uuid, target_unit_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 proposal_hash text NOT NULL CHECK(proposal_hash ~ '^[a-f0-9]{64}$'),
 schedule_command_id uuid NOT NULL UNIQUE, submitted_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending',
 decided_by uuid, decided_name text, decided_note text, decided_at timestamptz,
 applied_schedule_version integer, applied_schedule jsonb,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,schedule_id) REFERENCES schedules(org_id,id),
 FOREIGN KEY(org_id,requester_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,source_job_id) REFERENCES jobs(org_id,id),
 FOREIGN KEY(org_id,source_unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,target_job_id) REFERENCES jobs(org_id,id),
 FOREIGN KEY(org_id,target_unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES users(org_id,id),
 FOREIGN KEY(schedule_id,source_version) REFERENCES staff_schedule_history(schedule_id,version),
 FOREIGN KEY(schedule_id,applied_schedule_version) REFERENCES staff_schedule_history(schedule_id,version),
 CHECK((action='update' AND proposal IS NOT NULL AND target_job_id IS NOT NULL AND target_unit_id IS NOT NULL)
    OR (action='cancel' AND proposal IS NULL AND target_job_id IS NULL AND target_unit_id IS NULL)),
 CHECK((status='pending' AND version=1 AND decided_by IS NULL AND decided_name IS NULL AND decided_note IS NULL AND decided_at IS NULL)
    OR (status IN ('approved','declined','withdrawn') AND version=2 AND decided_by IS NOT NULL AND decided_name IS NOT NULL AND decided_note IS NOT NULL AND decided_at IS NOT NULL AND length(decided_note) BETWEEN 3 AND 1000)),
 CHECK((status='approved' AND applied_schedule_version IS NOT NULL AND applied_schedule IS NOT NULL)
    OR (status<>'approved' AND applied_schedule_version IS NULL AND applied_schedule IS NULL)),
 CHECK(status NOT IN ('approved','declined') OR decided_by<>requester_id),
 CHECK(status<>'withdrawn' OR decided_by=requester_id),
 CHECK(status<>'approved' OR (applied_schedule_version=source_version+1
   AND applied_schedule->>'id'=schedule_id::text AND (applied_schedule->>'version')::integer=applied_schedule_version
   AND applied_schedule->>'status'=CASE WHEN action='cancel' THEN 'cancelled' ELSE 'scheduled' END))
);
CREATE UNIQUE INDEX staff_schedule_request_one_pending ON staff_schedule_requests(org_id,schedule_id) WHERE status='pending';
CREATE INDEX staff_schedule_request_inbox ON staff_schedule_requests(org_id,requester_id,status,submitted_at DESC,id DESC);
CREATE FUNCTION protect_staff_schedule_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER protected_staff_schedule_request BEFORE INSERT OR UPDATE OR DELETE ON staff_schedule_requests FOR EACH ROW EXECUTE FUNCTION protect_staff_schedule_request();
CREATE TABLE staff_schedule_request_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, request_id uuid NOT NULL, request_version integer NOT NULL CHECK(request_version IN (1,2)),
 action text NOT NULL CHECK(action IN ('submitted','approved','declined','withdrawn')),
 actor_id uuid NOT NULL, actor_name text NOT NULL, actor_role text NOT NULL,
 reason text NOT NULL, before_state jsonb, after_state jsonb NOT NULL, applied_schedule jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,request_version),
 FOREIGN KEY(org_id,request_id) REFERENCES staff_schedule_requests(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_schedule_request_history BEFORE UPDATE OR DELETE ON staff_schedule_request_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE staff_schedule_request_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,actor_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_schedule_request_commands BEFORE UPDATE OR DELETE ON staff_schedule_request_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
