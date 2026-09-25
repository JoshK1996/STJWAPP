-- Preserve immutable source/receipt history while admitting larger schedule batches.
ALTER TABLE workforce_import_batches DROP CONSTRAINT workforce_import_batches_display_rows_check;
ALTER TABLE workforce_import_batches ADD CONSTRAINT workforce_import_batches_display_rows_check
 CHECK(jsonb_typeof(display_rows)='array' AND jsonb_array_length(display_rows) BETWEEN 1 AND CASE WHEN kind='schedules' THEN 1000 ELSE 100 END);
