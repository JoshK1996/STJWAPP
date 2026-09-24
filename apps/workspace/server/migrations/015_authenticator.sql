ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
CREATE TABLE mfa_factors (
 user_id uuid PRIMARY KEY, org_id uuid NOT NULL, id uuid NOT NULL UNIQUE,
 secret_cipher text NOT NULL, credential_digest text NOT NULL,
 pending_expires_at timestamptz NOT NULL, enabled_at timestamptz,
 last_counter bigint NOT NULL DEFAULT -1,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE TABLE mfa_recovery_codes (
 user_id uuid NOT NULL REFERENCES mfa_factors(user_id) ON DELETE CASCADE,
 code_hash text NOT NULL, used_at timestamptz,
 PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE mfa_challenges (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL, org_id uuid NOT NULL,
 factor_id uuid NOT NULL, credential_digest text NOT NULL,
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE INDEX mfa_challenge_account ON mfa_challenges(user_id);
CREATE INDEX mfa_challenge_expiry ON mfa_challenges(expires_at);
