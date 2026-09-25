-- Credential values never appear in this receipt. The fingerprint is a keyed,
-- domain-separated HMAC over the command, actor, target and exact input.
CREATE TABLE staff_credential_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, target_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
 FOREIGN KEY(org_id,target_id) REFERENCES users(org_id,id)
);
CREATE FUNCTION reject_staff_credential_command_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Credential command receipts are immutable'; END;
$$;
CREATE TRIGGER staff_credential_commands_immutable BEFORE UPDATE OR DELETE ON staff_credential_commands
 FOR EACH ROW EXECUTE FUNCTION reject_staff_credential_command_change();
