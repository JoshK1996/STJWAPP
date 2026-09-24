CREATE TABLE IF NOT EXISTS organizations (
 id uuid PRIMARY KEY, name text NOT NULL, timezone text NOT NULL,
 demo boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS units (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, kind text NOT NULL CHECK (kind IN ('school','early_childhood','parish','administration')),
 UNIQUE(org_id,id), UNIQUE(org_id,name)
);
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
 email text NOT NULL UNIQUE CHECK (email = lower(email)), name text NOT NULL,
 role text NOT NULL CHECK (role IN ('owner','admin','manager','finance','employee')),
 password_hash text, pin_hash text, active boolean NOT NULL DEFAULT true,
 preferences jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id)
);
CREATE TABLE IF NOT EXISTS user_units (
 org_id uuid NOT NULL, user_id uuid NOT NULL, unit_id uuid NOT NULL,
 PRIMARY KEY(user_id,unit_id),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL,
 title text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(org_id,id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE TABLE IF NOT EXISTS user_jobs (
 org_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
 PRIMARY KEY(user_id,job_id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id)
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('password','pin')), csrf text NOT NULL,
 expires_at timestamptz NOT NULL, FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS setup_tokens (
 token_hash text PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS auth_limits (
 bucket text PRIMARY KEY, attempts integer NOT NULL, resets_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 started_at timestamptz NOT NULL, ended_at timestamptz,
 UNIQUE(org_id,id), CHECK(ended_at IS NULL OR ended_at >= started_at),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(user_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS segments (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, shift_id uuid NOT NULL, job_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('work','break')), started_at timestamptz NOT NULL,
 ended_at timestamptz, CHECK(ended_at IS NULL OR ended_at >= started_at),
 FOREIGN KEY(org_id,shift_id) REFERENCES shifts(org_id,id),
 FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_segment ON segments(shift_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS segment_dates ON segments(org_id,started_at,ended_at);
CREATE TABLE IF NOT EXISTS clock_commands (
 org_id uuid NOT NULL, user_id uuid NOT NULL, command_id uuid NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,command_id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS requests (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, unit_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pto','schedule','correction','other')),
 starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on >= starts_on),
 note text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
 reviewer_id uuid, review_note text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id),
 FOREIGN KEY(org_id,reviewer_id) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS schedules (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at > starts_at),
 note text NOT NULL DEFAULT '', created_by uuid NOT NULL,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,job_id) REFERENCES jobs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid,
 action text NOT NULL, target_id text, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE INDEX IF NOT EXISTS audit_org_time ON audit_events(org_id,created_at);
CREATE OR REPLACE FUNCTION protect_audit_events() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'Audit events are append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_audit ON audit_events;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE IF NOT EXISTS api_tokens (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, name text NOT NULL, scopes jsonb NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS import_batches (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, actor_id uuid NOT NULL,
 source_hash text NOT NULL, rows jsonb NOT NULL, applied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
