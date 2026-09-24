-- Existing salted PIN hashes remain unchanged. A lookup is enrolled only when
-- the original PIN is supplied and verified through the application service.
ALTER TABLE users ADD COLUMN pin_lookup text;
ALTER TABLE users ADD COLUMN pin_lookup_key_id text;
ALTER TABLE users ADD CONSTRAINT users_pin_lookup_check CHECK (pin_lookup IS NULL OR pin_lookup ~ '^[a-f0-9]{64}$');
ALTER TABLE users ADD CONSTRAINT users_pin_lookup_key_check CHECK (
  (pin_lookup IS NULL AND pin_lookup_key_id IS NULL) OR
  (pin_lookup IS NOT NULL AND pin_lookup_key_id IS NOT NULL AND pin_lookup_key_id ~ '^[a-f0-9]{64}$')
);
-- The public clock does not ask for an organization or account identifier.
-- Temporary shared PINs remain unindexed and never choose an arbitrary user.
CREATE UNIQUE INDEX users_active_permanent_pin_lookup ON users(pin_lookup)
  WHERE active AND NOT requires_credential_change AND pin_lookup IS NOT NULL;
