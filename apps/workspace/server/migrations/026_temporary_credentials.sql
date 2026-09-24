-- New-account temporary onboarding only. Existing accounts are unchanged.
ALTER TABLE users ADD COLUMN requires_credential_change boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT temporary_credentials_both_present
 CHECK(NOT requires_credential_change OR (password_hash IS NOT NULL AND pin_hash IS NOT NULL));

-- This proof is deliberately not an ordinary session. No password, PIN or
-- plaintext challenge is retained. The account lock serializes every writer.
CREATE TABLE credential_change_challenges (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 org_id uuid NOT NULL, user_id uuid NOT NULL UNIQUE,
 credential_digest text NOT NULL CHECK(credential_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id),
 CHECK(expires_at=created_at+interval '10 minutes')
);
CREATE INDEX credential_change_challenges_expiry ON credential_change_challenges(expires_at);
