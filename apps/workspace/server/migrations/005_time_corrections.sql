ALTER TABLE shifts ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE segments ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE INDEX segment_shift_revision ON segments(shift_id,revision);
CREATE TABLE time_corrections (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, shift_id uuid NOT NULL, user_id uuid NOT NULL,
 proposed_by uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL, source_revision integer NOT NULL,
 original jsonb NOT NULL, proposed jsonb NOT NULL, reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
 version integer NOT NULL DEFAULT 1, reviewed_by uuid, review_note text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(proposed_by,command_id), FOREIGN KEY(org_id,shift_id) REFERENCES shifts(org_id,id),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,proposed_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id)
);
CREATE INDEX time_correction_queue ON time_corrections(org_id,status,created_at);
CREATE FUNCTION protect_time_correction() RETURNS trigger AS $$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Time correction history cannot be deleted'; END IF;
 IF OLD.status<>'pending' OR ROW(NEW.id,NEW.org_id,NEW.shift_id,NEW.user_id,NEW.proposed_by,NEW.command_id,NEW.fingerprint,NEW.source_revision,NEW.original,NEW.proposed,NEW.reason,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.shift_id,OLD.user_id,OLD.proposed_by,OLD.command_id,OLD.fingerprint,OLD.source_revision,OLD.original,OLD.proposed,OLD.reason,OLD.created_at) THEN RAISE EXCEPTION 'Time correction evidence is immutable'; END IF;
 RETURN NEW;
 END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER immutable_time_correction BEFORE UPDATE OR DELETE ON time_corrections FOR EACH ROW EXECUTE FUNCTION protect_time_correction();
