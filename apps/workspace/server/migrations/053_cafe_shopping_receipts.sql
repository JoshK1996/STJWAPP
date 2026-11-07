-- Café membership is the source of Shopping assignments. No production catalog
-- identities or staff records are embedded in this migration.
CREATE TABLE shopping_programs (
 org_id uuid NOT NULL, shopping_job_id uuid PRIMARY KEY, cafe_job_id uuid NOT NULL,
 unit_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,shopping_job_id), UNIQUE(org_id,shopping_job_id,unit_id), UNIQUE(org_id,cafe_job_id), CHECK(shopping_job_id<>cafe_job_id),
 FOREIGN KEY(org_id,shopping_job_id) REFERENCES jobs(org_id,id),
 FOREIGN KEY(org_id,cafe_job_id) REFERENCES jobs(org_id,id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TRIGGER immutable_shopping_program BEFORE UPDATE OR DELETE ON shopping_programs
 FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE INDEX user_jobs_job_members ON user_jobs(org_id,job_id,user_id);

CREATE FUNCTION check_shopping_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person uuid; organization uuid;
BEGIN
 FOR person,organization IN SELECT DISTINCT identity.user_id,identity.org_id FROM
   (VALUES (NEW.user_id,NEW.org_id),(OLD.user_id,OLD.org_id)) identity(user_id,org_id) WHERE identity.user_id IS NOT NULL LOOP
 IF EXISTS(SELECT 1 FROM shopping_programs p WHERE p.org_id=organization AND (
   EXISTS(SELECT 1 FROM user_jobs j WHERE j.org_id=organization AND j.user_id=person AND j.job_id=p.cafe_job_id)
   <> EXISTS(SELECT 1 FROM user_jobs j WHERE j.org_id=organization AND j.user_id=person AND j.job_id=p.shopping_job_id)
   OR (EXISTS(SELECT 1 FROM user_jobs j WHERE j.org_id=organization AND j.user_id=person AND j.job_id=p.shopping_job_id)
     AND NOT EXISTS(SELECT 1 FROM user_units u WHERE u.org_id=organization AND u.user_id=person AND u.unit_id=p.unit_id)))) THEN
  RAISE EXCEPTION 'Shopping assignments must follow the café job and its community';
 END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shopping_job_membership AFTER INSERT OR UPDATE OR DELETE ON user_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shopping_member();
CREATE CONSTRAINT TRIGGER shopping_unit_membership AFTER INSERT OR UPDATE OR DELETE ON user_units
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shopping_member();
CREATE FUNCTION check_shopping_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE organization uuid;
BEGIN
 organization:=NEW.org_id;
 IF EXISTS(SELECT 1 FROM shopping_programs p JOIN jobs c ON c.id=p.cafe_job_id AND c.org_id=p.org_id
   JOIN jobs s ON s.id=p.shopping_job_id AND s.org_id=p.org_id WHERE p.org_id=organization
   AND (c.unit_id<>p.unit_id OR s.unit_id<>p.unit_id OR (s.active AND NOT c.active)
     OR EXISTS(SELECT 1 FROM shopping_programs x WHERE x.shopping_job_id=p.cafe_job_id OR x.cafe_job_id=p.shopping_job_id))) THEN
  RAISE EXCEPTION 'Shopping must share the café community; restore the café job before Shopping';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shopping_job_structure AFTER UPDATE ON jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shopping_jobs();
CREATE CONSTRAINT TRIGGER shopping_program_structure AFTER INSERT ON shopping_programs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shopping_jobs();

CREATE TABLE shopping_receipt_storage (
 org_id uuid PRIMARY KEY REFERENCES organizations(id),
 byte_limit bigint NOT NULL DEFAULT 1073741824 CHECK(byte_limit>0 AND byte_limit<=10737418240)
);
CREATE TABLE shopping_receipts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
 unit_id uuid NOT NULL, employee_name text NOT NULL, job_title text NOT NULL, unit_name text NOT NULL,
 purchased_on date NOT NULL, vendor text, amount_minor bigint CHECK(amount_minor>=0 AND amount_minor<=99999999999),
 note text, shift_id uuid, shift_revision integer, uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 photo_hash text NOT NULL CHECK(photo_hash ~ '^[a-f0-9]{64}$'), photo_size integer NOT NULL CHECK(photo_size>0 AND photo_size<=4194304),
 thumbnail_size integer NOT NULL CHECK(thumbnail_size>0 AND thumbnail_size<=524288),
 width integer NOT NULL CHECK(width>0 AND width<=4000), height integer NOT NULL CHECK(height>0 AND height<=4000),
 photo bytea, thumbnail bytea, status text NOT NULL DEFAULT 'active' CHECK(status IN('active','archived','deleted')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,job_id,unit_id) REFERENCES shopping_programs(org_id,shopping_job_id,unit_id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,shift_id) REFERENCES shifts(org_id,id),
 CHECK((shift_id IS NULL)=(shift_revision IS NULL)),
 CHECK((status='deleted' AND photo IS NULL AND thumbnail IS NULL AND vendor IS NULL AND note IS NULL AND amount_minor IS NULL)
   OR (status<>'deleted' AND photo IS NOT NULL AND thumbnail IS NOT NULL AND octet_length(photo)=photo_size AND octet_length(thumbnail)=thumbnail_size))
);
CREATE INDEX shopping_receipt_review ON shopping_receipts(org_id,unit_id,purchased_on DESC,id);
CREATE INDEX shopping_receipt_owner ON shopping_receipts(org_id,user_id,purchased_on DESC,id);
CREATE INDEX shopping_receipt_shift ON shopping_receipts(org_id,shift_id) WHERE shift_id IS NOT NULL;
CREATE UNIQUE INDEX shopping_receipt_photo_once ON shopping_receipts(org_id,user_id,source_hash) WHERE status<>'deleted';
CREATE TABLE shopping_receipt_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, receipt_id uuid NOT NULL, actor_id uuid NOT NULL, actor_name text NOT NULL,
 action text NOT NULL CHECK(action IN('uploaded','archived','restored','deleted')), version integer NOT NULL,
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(receipt_id,version), FOREIGN KEY(org_id,receipt_id) REFERENCES shopping_receipts(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_receipt_event BEFORE UPDATE OR DELETE ON shopping_receipt_events FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE shopping_receipt_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 receipt_id uuid NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,actor_id,command_id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,receipt_id) REFERENCES shopping_receipts(org_id,id)
);
CREATE TRIGGER immutable_receipt_command BEFORE UPDATE OR DELETE ON shopping_receipt_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE FUNCTION protect_shopping_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Receipt deletion must retain its audit tombstone'; END IF;
 IF OLD.status='deleted' OR NEW.version<>OLD.version+1
   OR ROW(NEW.id,NEW.org_id,NEW.user_id,NEW.job_id,NEW.unit_id,NEW.employee_name,NEW.job_title,NEW.unit_name,NEW.purchased_on,NEW.shift_id,NEW.shift_revision,NEW.uploaded_at,NEW.source_hash,NEW.photo_hash,NEW.photo_size,NEW.thumbnail_size,NEW.width,NEW.height) IS DISTINCT FROM
      ROW(OLD.id,OLD.org_id,OLD.user_id,OLD.job_id,OLD.unit_id,OLD.employee_name,OLD.job_title,OLD.unit_name,OLD.purchased_on,OLD.shift_id,OLD.shift_revision,OLD.uploaded_at,OLD.source_hash,OLD.photo_hash,OLD.photo_size,OLD.thumbnail_size,OLD.width,OLD.height)
   OR (NEW.status<>'deleted' AND ROW(NEW.photo,NEW.thumbnail,NEW.vendor,NEW.note,NEW.amount_minor) IS DISTINCT FROM ROW(OLD.photo,OLD.thumbnail,OLD.vendor,OLD.note,OLD.amount_minor)) THEN
  RAISE EXCEPTION 'Receipt content is retained until explicit deletion; lifecycle changes require the next version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_shopping_receipt BEFORE UPDATE OR DELETE ON shopping_receipts FOR EACH ROW EXECUTE FUNCTION protect_shopping_receipt();

-- Explicit operator setup, run after deploying the reviewed source. A separate
-- PostgreSQL identity is mandatory. The web role cannot invoke this function.
CREATE FUNCTION provision_cafe_shopping(organization uuid,cafe uuid,shopping uuid,reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE parent jobs%ROWTYPE; existing shopping_programs%ROWTYPE; members integer;
BEGIN
 IF current_user='stjw_runtime' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb)) THEN
  RAISE EXCEPTION 'Shopping setup requires the reviewed maintenance identity';
 END IF;
 IF length(trim(reason))<10 THEN RAISE EXCEPTION 'Record the authorized setup reason'; END IF;
 LOCK TABLE jobs,user_jobs,user_units IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO parent FROM jobs WHERE org_id=organization AND id=cafe FOR UPDATE;
 IF NOT FOUND OR NOT parent.active THEN RAISE EXCEPTION 'Choose the exact active café job in this organization'; END IF;
 IF EXISTS(SELECT 1 FROM user_jobs j WHERE j.org_id=organization AND j.job_id=cafe AND NOT EXISTS(SELECT 1 FROM user_units u WHERE u.org_id=j.org_id AND u.user_id=j.user_id AND u.unit_id=parent.unit_id)) THEN
  RAISE EXCEPTION 'Repair the café community membership before enabling Shopping';
 END IF;
 SELECT * INTO existing FROM shopping_programs WHERE org_id=organization AND cafe_job_id=cafe;
 IF FOUND THEN RETURN jsonb_build_object('jobId',existing.shopping_job_id,'created',false); END IF;
 IF EXISTS(SELECT 1 FROM jobs WHERE org_id=organization AND unit_id=parent.unit_id AND lower(title)='shopping') THEN
  RAISE EXCEPTION 'A Shopping job already exists; review it before creating another';
 END IF;
 INSERT INTO jobs(id,org_id,unit_id,title,description) VALUES(shopping,organization,parent.unit_id,'Shopping','Shopping for '||parent.title);
 INSERT INTO shopping_programs(org_id,shopping_job_id,cafe_job_id,unit_id) VALUES(organization,shopping,cafe,parent.unit_id);
 INSERT INTO shopping_receipt_storage(org_id) VALUES(organization) ON CONFLICT DO NOTHING;
 INSERT INTO user_jobs(org_id,user_id,job_id)
  SELECT organization,j.user_id,shopping FROM user_jobs j JOIN user_units u ON u.org_id=j.org_id AND u.user_id=j.user_id AND u.unit_id=parent.unit_id
  WHERE j.org_id=organization AND j.job_id=cafe ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS members=ROW_COUNT;
 INSERT INTO audit_events(id,org_id,actor_id,action,target_id,detail) VALUES(gen_random_uuid(),organization,NULL,'shopping.program_provisioned',shopping::text,
   jsonb_build_object('sourceJobId',cafe,'shoppingJobId',shopping,'assignedCount',members,'reason',reason,'operator',current_user));
 RETURN jsonb_build_object('jobId',shopping,'created',true,'assignedCount',members);
END $$;
REVOKE EXECUTE ON FUNCTION provision_cafe_shopping(uuid,uuid,uuid,text) FROM PUBLIC;
