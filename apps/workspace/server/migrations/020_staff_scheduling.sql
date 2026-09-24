ALTER TABLE schedules ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE schedules ADD COLUMN status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled'));
ALTER TABLE schedules ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE schedules ADD COLUMN cancelled_at timestamptz;
ALTER TABLE schedules ADD CONSTRAINT schedule_status_time CHECK((status='cancelled')=(cancelled_at IS NOT NULL));
ALTER TABLE schedules ADD CONSTRAINT schedules_org_identity UNIQUE(org_id,id);
CREATE INDEX schedules_active_employee_time ON schedules(org_id,user_id,starts_at,ends_at) WHERE status='scheduled';
CREATE TABLE staff_schedule_history (
 org_id uuid NOT NULL, schedule_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 action text NOT NULL CHECK(action IN ('baseline','created','updated','cancelled')),
 before_snapshot jsonb, after_snapshot jsonb NOT NULL, reason text NOT NULL,
 actor_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(schedule_id,version),
 FOREIGN KEY(org_id,schedule_id) REFERENCES schedules(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_schedule_history BEFORE UPDATE OR DELETE ON staff_schedule_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE staff_schedule_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_staff_schedule_commands BEFORE UPDATE OR DELETE ON staff_schedule_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
INSERT INTO staff_schedule_history(org_id,schedule_id,version,action,after_snapshot,reason)
 SELECT s.org_id,s.id,1,'baseline',jsonb_build_object(
 'id',s.id,'userId',s.user_id,'employeeName',e.name,'jobId',s.job_id,'jobTitle',j.title,
 'unitId',j.unit_id,'unitName',u.name,'startsAt',s.starts_at,'endsAt',s.ends_at,
 'note',s.note,'version',1,'status','scheduled','updatedAt',s.updated_at,'cancelledAt',NULL),
 'Existing schedule captured when version history was introduced. Earlier changes are unavailable.'
 FROM schedules s JOIN users e ON e.org_id=s.org_id AND e.id=s.user_id
 JOIN jobs j ON j.org_id=s.org_id AND j.id=s.job_id JOIN units u ON u.org_id=s.org_id AND u.id=j.unit_id;
