-- Missing recorded shifts and independently reviewed closure of open shifts.
-- All existing time rows and null-ended historical segments are preserved.
CREATE TABLE time_adjustment_requests (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('missing_shift','close_open_shift')),
 source_shift_id uuid, source_revision integer CHECK(source_revision>0), source_hash text, source_snapshot jsonb,
 proposed_snapshot jsonb NOT NULL, scope_snapshot jsonb NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>=starts_at),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), proposed_by uuid NOT NULL, proposer_name text NOT NULL,
 created_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','declined','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version IN(1,2)),
 resolved_by uuid, resolver_name text, resolution_note text, resolved_at timestamptz,
 result_shift_id uuid, result_revision integer CHECK(result_revision>0), result_snapshot jsonb, result_hash text,
 UNIQUE(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,proposed_by) REFERENCES users(org_id,id), FOREIGN KEY(org_id,resolved_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,source_shift_id) REFERENCES shifts(org_id,id), FOREIGN KEY(org_id,result_shift_id) REFERENCES shifts(org_id,id),
 CHECK((kind='missing_shift' AND source_shift_id IS NULL AND source_revision IS NULL AND source_hash IS NULL AND source_snapshot IS NULL AND ends_at>starts_at)
   OR (kind='close_open_shift' AND source_shift_id IS NOT NULL AND source_revision IS NOT NULL AND source_hash IS NOT NULL AND source_hash ~ '^[a-f0-9]{64}$' AND source_snapshot IS NOT NULL
     AND source_snapshot#>'{shift,endedAt}' IS NOT DISTINCT FROM 'null'::jsonb AND source_snapshot#>>'{shift,id}' IS NOT DISTINCT FROM source_shift_id::text)),
 CHECK(starts_at IS NOT DISTINCT FROM (proposed_snapshot#>>'{shift,startedAt}')::timestamptz AND ends_at IS NOT DISTINCT FROM (proposed_snapshot#>>'{shift,endedAt}')::timestamptz),
 CHECK(proposed_snapshot->>'orgId' IS NOT DISTINCT FROM org_id::text AND proposed_snapshot#>>'{employee,id}' IS NOT DISTINCT FROM user_id::text),
 CHECK((status='pending' AND version=1 AND resolved_by IS NULL AND resolver_name IS NULL AND resolution_note IS NULL AND resolved_at IS NULL)
   OR (status<>'pending' AND version=2 AND resolved_by IS NOT NULL AND resolver_name IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 10 AND 2000 AND resolved_at IS NOT NULL)),
 CHECK((status='approved' AND result_shift_id IS NOT NULL AND result_revision IS NOT NULL AND result_snapshot IS NOT NULL AND result_hash IS NOT NULL AND result_hash ~ '^[a-f0-9]{64}$')
   OR (status<>'approved' AND result_shift_id IS NULL AND result_revision IS NULL AND result_snapshot IS NULL AND result_hash IS NULL)),
 CHECK(status NOT IN('approved','declined') OR (resolved_by<>proposed_by AND resolved_by<>user_id)),
 CHECK(status<>'cancelled' OR resolved_by=proposed_by)
);
CREATE INDEX time_adjustment_scope ON time_adjustment_requests(org_id,user_id,created_at DESC,id DESC);
CREATE INDEX time_adjustment_queue ON time_adjustment_requests(org_id,status,created_at DESC,id DESC);
CREATE INDEX time_adjustment_source ON time_adjustment_requests(org_id,source_shift_id);
CREATE UNIQUE INDEX time_adjustment_applied_revision ON time_adjustment_requests(org_id,result_shift_id,result_revision) WHERE status='approved';

CREATE FUNCTION protect_time_adjustment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Time adjustment evidence cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.version<>1 THEN RAISE EXCEPTION 'A time adjustment begins pending at version one'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'pending' OR OLD.version<>1 OR NEW.status='pending' OR NEW.version<>2
   OR (to_jsonb(NEW)-ARRAY['status','version','resolved_by','resolver_name','resolution_note','resolved_at','result_shift_id','result_revision','result_snapshot','result_hash']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','version','resolved_by','resolver_name','resolution_note','resolved_at','result_shift_id','result_revision','result_snapshot','result_hash']) THEN
  RAISE EXCEPTION 'Time adjustment source and terminal evidence are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_time_adjustment_request BEFORE INSERT OR UPDATE OR DELETE ON time_adjustment_requests FOR EACH ROW EXECUTE FUNCTION protect_time_adjustment_request();

CREATE TABLE time_adjustment_history (
 org_id uuid NOT NULL, request_id uuid NOT NULL, version integer NOT NULL CHECK(version IN(1,2)),
 action text NOT NULL CHECK(action IN('proposed','approved','declined','cancelled')),
 actor_id uuid NOT NULL, actor_name text NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL,
 snapshot_text text NOT NULL, snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 json_text text NOT NULL, json_hash text NOT NULL CHECK(json_hash ~ '^[a-f0-9]{64}$'),
 csv_text text NOT NULL, csv_hash text NOT NULL CHECK(csv_hash ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes=octet_length(snapshot_text)+octet_length(json_text)+octet_length(csv_text) AND bytes BETWEEN 1 AND 1048576),
 PRIMARY KEY(org_id,request_id,version), FOREIGN KEY(org_id,request_id) REFERENCES time_adjustment_requests(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 CHECK((version=1 AND action='proposed') OR (version=2 AND action<>'proposed')),
 CHECK(snapshot_text::jsonb#>>'{snapshot,request,id}' IS NOT DISTINCT FROM request_id::text AND (snapshot_text::jsonb->>'version')::integer IS NOT DISTINCT FROM version AND snapshot_text::jsonb->>'action' IS NOT DISTINCT FROM action)
);
CREATE TRIGGER immutable_time_adjustment_history BEFORE UPDATE OR DELETE ON time_adjustment_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
ALTER TABLE time_adjustment_requests ADD CONSTRAINT time_adjustment_current_history
 FOREIGN KEY(org_id,id,version) REFERENCES time_adjustment_history(org_id,request_id,version) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE time_adjustment_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, action text NOT NULL CHECK(action IN('propose','review','cancel')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), request_id uuid NOT NULL, result_version integer NOT NULL,
 result_text text NOT NULL, result_hash text NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,request_id,result_version) REFERENCES time_adjustment_history(org_id,request_id,version),
 CHECK(octet_length(result_text) BETWEEN 1 AND 4096)
);
CREATE TRIGGER immutable_time_adjustment_commands BEFORE UPDATE OR DELETE ON time_adjustment_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
