-- Immutable institutional term GPA results and expiring private reviews.
-- Existing exact school/card keys from025 and GPA policy keys from028 are reused.
-- No school rules or records are seeded. Apply via reviewed maintenance only.

CREATE TABLE gpa_series (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL,
 student_id uuid NOT NULL, year_id uuid NOT NULL, term_id uuid NOT NULL, policy_id uuid NOT NULL,
 latest_decision_id uuid, latest_number integer NOT NULL DEFAULT 0 CHECK(latest_number>=0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,unit_id,student_id,year_id,term_id,policy_id),
 UNIQUE(org_id,unit_id,student_id,year_id,term_id,policy_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,year_id) REFERENCES school_years(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,year_id,term_id) REFERENCES school_terms(org_id,unit_id,year_id,id),
 FOREIGN KEY(org_id,unit_id,year_id,policy_id) REFERENCES gpa_policies(org_id,unit_id,year_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id),
 CHECK((latest_number=0 AND latest_decision_id IS NULL) OR (latest_number>0 AND latest_decision_id IS NOT NULL))
);

CREATE TABLE gpa_previews (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, prepared_by uuid NOT NULL,
 student_id uuid NOT NULL, year_id uuid NOT NULL, term_id uuid NOT NULL,
 policy_id uuid NOT NULL, policy_version_id uuid NOT NULL,
 card_id uuid NOT NULL, card_version integer NOT NULL CHECK(card_version>0), issue_id uuid NOT NULL,
 expected_series_id uuid, expected_latest_id uuid, expected_latest_number integer NOT NULL CHECK(expected_latest_number>=0),
 review_text text NOT NULL, preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
 source_copy_text text NOT NULL, comparison_hash text NOT NULL CHECK(comparison_hash ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 8388608),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(org_id,prepared_by) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,unit_id,student_id) REFERENCES students(org_id,unit_id,id),
 FOREIGN KEY(org_id,unit_id,year_id,term_id) REFERENCES school_terms(org_id,unit_id,year_id,id),
 FOREIGN KEY(org_id,unit_id,year_id,policy_id) REFERENCES gpa_policies(org_id,unit_id,year_id,id),
 FOREIGN KEY(org_id,policy_id,policy_version_id) REFERENCES gpa_policy_versions(org_id,policy_id,id),
 FOREIGN KEY(org_id,unit_id,student_id,year_id,card_id) REFERENCES report_cards(org_id,unit_id,student_id,year_id,id),
 FOREIGN KEY(org_id,unit_id,card_id,card_version,issue_id) REFERENCES report_card_issues(org_id,unit_id,card_id,card_version,id),
 FOREIGN KEY(org_id,unit_id,student_id,year_id,term_id,policy_id,expected_series_id)
   REFERENCES gpa_series(org_id,unit_id,student_id,year_id,term_id,policy_id,id),
 CHECK(expires_at=created_at+interval '10 minutes'),
 CHECK(consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at)),
 CHECK(bytes=octet_length(review_text)+octet_length(source_copy_text)),
 CHECK((expected_latest_number=0 AND expected_series_id IS NULL AND expected_latest_id IS NULL)
    OR (expected_latest_number>0 AND expected_series_id IS NOT NULL AND expected_latest_id IS NOT NULL))
);
CREATE INDEX gpa_previews_private ON gpa_previews(org_id,prepared_by,expires_at);

CREATE TABLE gpa_decisions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, series_id uuid NOT NULL,
 student_id uuid NOT NULL, year_id uuid NOT NULL, term_id uuid NOT NULL, policy_id uuid NOT NULL,
 number integer NOT NULL CHECK(number>0), supersedes_id uuid,
 predecessor_number integer GENERATED ALWAYS AS (CASE WHEN number=1 THEN NULL ELSE number-1 END) STORED,
 policy_version_id uuid NOT NULL, card_id uuid NOT NULL, card_version integer NOT NULL CHECK(card_version>0), issue_id uuid NOT NULL,
 preview_id uuid NOT NULL UNIQUE, preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
 reviewed_by uuid NOT NULL, reviewer_name text NOT NULL, captured_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
 outcome text NOT NULL CHECK(outcome IN ('calculated','incomplete')),
 gpa_summary jsonb,
 snapshot_text text NOT NULL, snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 json_text text NOT NULL, json_hash text NOT NULL CHECK(json_hash ~ '^[a-f0-9]{64}$'),
 csv_text text NOT NULL, csv_hash text NOT NULL CHECK(csv_hash ~ '^[a-f0-9]{64}$'),
 json_bytes integer NOT NULL CHECK(json_bytes=octet_length(json_text)),
 csv_bytes integer NOT NULL CHECK(csv_bytes=octet_length(csv_text)),
 bytes integer NOT NULL CHECK(bytes=octet_length(snapshot_text)+json_bytes+csv_bytes AND bytes BETWEEN 1 AND 8388608),
 UNIQUE(series_id,number), UNIQUE(series_id,number,id), UNIQUE(org_id,reviewed_by,id),
 FOREIGN KEY(org_id,unit_id,student_id,year_id,term_id,policy_id,series_id)
   REFERENCES gpa_series(org_id,unit_id,student_id,year_id,term_id,policy_id,id),
 FOREIGN KEY(org_id,policy_id,policy_version_id) REFERENCES gpa_policy_versions(org_id,policy_id,id),
 FOREIGN KEY(org_id,unit_id,student_id,year_id,card_id) REFERENCES report_cards(org_id,unit_id,student_id,year_id,id),
 FOREIGN KEY(org_id,unit_id,card_id,card_version,issue_id) REFERENCES report_card_issues(org_id,unit_id,card_id,card_version,id),
 FOREIGN KEY(org_id,reviewed_by) REFERENCES users(org_id,id),
 FOREIGN KEY(series_id,predecessor_number,supersedes_id) REFERENCES gpa_decisions(series_id,number,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((number=1 AND supersedes_id IS NULL) OR (number>1 AND supersedes_id IS NOT NULL)),
 CHECK((snapshot_text::jsonb->>'id') IS NOT DISTINCT FROM id::text
   AND (snapshot_text::jsonb->>'seriesId') IS NOT DISTINCT FROM series_id::text
   AND (snapshot_text::jsonb->>'number') IS NOT DISTINCT FROM number::text
   AND (snapshot_text::jsonb->>'supersedesId') IS NOT DISTINCT FROM supersedes_id::text
   AND (snapshot_text::jsonb->>'previewId') IS NOT DISTINCT FROM preview_id::text
   AND (snapshot_text::jsonb->>'previewHash') IS NOT DISTINCT FROM preview_hash
   AND (snapshot_text::jsonb->'data'->'policyVersion'->>'id') IS NOT DISTINCT FROM policy_version_id::text
   AND (snapshot_text::jsonb->'data'->'source'->'issue'->>'id') IS NOT DISTINCT FROM issue_id::text
   AND (snapshot_text::jsonb->'data'->'result'->>'outcome') IS NOT DISTINCT FROM outcome),
 CHECK((outcome='incomplete' AND gpa_summary IS NULL AND (snapshot_text::jsonb->'data'->'result'->'totals') IS NOT DISTINCT FROM 'null'::jsonb)
   OR (outcome='calculated' AND gpa_summary IS NOT NULL AND jsonb_typeof(gpa_summary)='object' AND
     gpa_summary IS NOT DISTINCT FROM jsonb_build_object(
       'numerator',snapshot_text::jsonb->'data'->'result'->'totals'->'gpa'->'numerator',
       'denominator',snapshot_text::jsonb->'data'->'result'->'totals'->'gpa'->'denominator',
       'display',snapshot_text::jsonb->'data'->'result'->'totals'->'display',
       'displayRule',snapshot_text::jsonb->'data'->'result'->'totals'->'displayRule')))
);
-- Deliberately no FK from decision.preview_id to temporary gpa_previews.
-- The retained envelope carries the complete reviewed evidence after expiry.
ALTER TABLE gpa_series ADD CONSTRAINT gpa_series_latest
 FOREIGN KEY(id,latest_number,latest_decision_id) REFERENCES gpa_decisions(series_id,number,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE gpa_previews ADD CONSTRAINT gpa_preview_predecessor
 FOREIGN KEY(expected_series_id,expected_latest_number,expected_latest_id) REFERENCES gpa_decisions(series_id,number,id);
CREATE INDEX gpa_decisions_scope ON gpa_decisions(org_id,unit_id,student_id,year_id,captured_at DESC,id DESC);
CREATE TRIGGER immutable_gpa_decisions BEFORE UPDATE OR DELETE ON gpa_decisions FOR EACH ROW EXECUTE FUNCTION protect_audit_events();

CREATE TABLE gpa_decision_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL,
 action text NOT NULL DEFAULT 'retain' CHECK(action='retain'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), decision_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,actor_id,command_id),
 FOREIGN KEY(org_id,actor_id,decision_id) REFERENCES gpa_decisions(org_id,reviewed_by,id)
);
CREATE TRIGGER immutable_gpa_decision_commands BEFORE UPDATE OR DELETE ON gpa_decision_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();

CREATE FUNCTION protect_gpa_series() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GPA decision series cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.latest_number<>0 OR NEW.latest_decision_id IS NOT NULL THEN RAISE EXCEPTION 'Series begins with an empty uncommitted pointer'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['latest_number','latest_decision_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['latest_number','latest_decision_id'])
   OR NEW.latest_number<>OLD.latest_number+1 OR NEW.latest_decision_id IS NULL THEN
  RAISE EXCEPTION 'Only the next gpa decision may advance this immutable series identity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_gpa_series BEFORE INSERT OR UPDATE OR DELETE ON gpa_series FOR EACH ROW EXECUTE FUNCTION protect_gpa_series();

-- A FK alone permits a stale latest pointer. At commit verify the final pointer
-- is the highest actual immutable decision. Empty series may not be committed.
CREATE FUNCTION check_gpa_series_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; s gpa_series%ROWTYPE; d gpa_decisions%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='gpa_series' THEN sid:=NEW.id; ELSE sid:=NEW.series_id; END IF;
 SELECT * INTO s FROM gpa_series WHERE id=sid;
 SELECT * INTO d FROM gpa_decisions WHERE series_id=sid ORDER BY number DESC LIMIT 1;
 IF s.id IS NULL OR d.id IS NULL OR s.latest_decision_id IS DISTINCT FROM d.id OR s.latest_number IS DISTINCT FROM d.number THEN
  RAISE EXCEPTION 'GPA series latest pointer must match its final retained chain';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gpa_series_chain AFTER INSERT OR UPDATE ON gpa_series DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_gpa_series_chain();
CREATE CONSTRAINT TRIGGER gpa_decision_chain AFTER INSERT ON gpa_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_gpa_series_chain();

CREATE FUNCTION protect_gpa_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.consumed_at IS NULL AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'Only expired or consumed previews may be purged'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR
    (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') THEN
  RAISE EXCEPTION 'Only first consumption may change a gpa preview';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_gpa_preview BEFORE UPDATE OR DELETE ON gpa_previews FOR EACH ROW EXECUTE FUNCTION protect_gpa_preview();

-- Runtime follow-up: append-only grants discovered via protect_audit_events.
-- add protect_gpa_series to retained-parent DELETE revocation and startup
-- checks. Verify both deferred chain triggers and protected_gpa_preview.
-- No policy/decision seed, no student changes, no cascaded deletion or web DDL.
