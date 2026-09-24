-- Existing rows receive a representation baseline, not a reconstructed historic edit time.
ALTER TABLE timetable_revisions ADD COLUMN calendar_revised_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- Maintenance precedes a rolling web deployment: old version-only writers must
-- update the representation timestamp too. Same-version updates cannot invent
-- a new timestamp. The function uses invoker rights and performs no other writes.
CREATE FUNCTION protect_timetable_calendar_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version IS DISTINCT FROM OLD.version THEN
  NEW.calendar_revised_at := greatest(clock_timestamp(),OLD.calendar_revised_at+interval '1 microsecond');
 ELSE
  NEW.calendar_revised_at := OLD.calendar_revised_at;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER timetable_calendar_revision BEFORE UPDATE ON timetable_revisions
 FOR EACH ROW EXECUTE FUNCTION protect_timetable_calendar_revision();
