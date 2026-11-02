-- Retain the original null-ended segment when an authorized correction creates
-- another open revision. Live readers already select shifts.revision.
-- One live segment is still enforced inside every revision. Historical source
-- rows, clock commands and correction evidence remain unchanged.
DROP INDEX one_open_segment;
CREATE UNIQUE INDEX one_open_segment ON segments(shift_id,revision) WHERE ended_at IS NULL;
