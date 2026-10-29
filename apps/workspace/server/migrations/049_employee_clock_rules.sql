-- Per-employee clock rules: weekday and time-of-day limits for clock-in and clock-out.
-- Rules live on the existing employee clock policy row so they share its revision, audit and grants.
-- NULL means no rules, which is every existing employee's behavior.
ALTER TABLE clock_employee_policies ADD COLUMN rules jsonb
 CHECK(rules IS NULL OR (jsonb_typeof(rules)='object' AND jsonb_typeof(rules->'days')='array' AND jsonb_array_length(rules->'days')=7));

-- A rule-based pending start has no schedule. Existing intents are all schedule-based.
ALTER TABLE clock_intents ADD COLUMN source text NOT NULL DEFAULT 'schedule' CHECK(source IN('schedule','rule'));
ALTER TABLE clock_intents ALTER COLUMN schedule_id DROP NOT NULL;
ALTER TABLE clock_intents ALTER COLUMN schedule_version DROP NOT NULL;
ALTER TABLE clock_intents ADD CONSTRAINT clock_intents_source_schedule CHECK(
 (source='schedule' AND schedule_id IS NOT NULL AND schedule_version IS NOT NULL)
 OR (source='rule' AND schedule_id IS NULL AND schedule_version IS NULL));
