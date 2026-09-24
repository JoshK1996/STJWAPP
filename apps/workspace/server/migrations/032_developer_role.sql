-- Add the developer role without changing any existing account or credentials.
-- Provisioning the designated developer is a separately reviewed audited action.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('developer','owner','admin','manager','finance','employee'));
