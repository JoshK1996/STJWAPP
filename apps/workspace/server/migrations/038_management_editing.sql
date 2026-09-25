-- Editable current definitions retain stable identities and optimistic versions.
ALTER TABLE jobs ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=1000);
ALTER TABLE jobs ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE timetable_rooms ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE timetable_rooms ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE requests ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
