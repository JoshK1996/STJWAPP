-- Existing pending accounts continue to require both changes. Completed accounts
-- remain completed. This migration does not change any credential or session.
ALTER TABLE users ADD COLUMN require_password_change boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN require_pin_change boolean NOT NULL DEFAULT false;
UPDATE users SET require_password_change=requires_credential_change,
 require_pin_change=requires_credential_change;
ALTER TABLE users ADD CONSTRAINT credential_change_requirements_consistent
 CHECK(requires_credential_change=(require_password_change OR require_pin_change));
