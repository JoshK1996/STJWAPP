ALTER TABLE units ADD COLUMN parent_id uuid;
ALTER TABLE units ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE units ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE units ADD CONSTRAINT units_parent FOREIGN KEY(org_id,parent_id) REFERENCES units(org_id,id);
ALTER TABLE units ADD CONSTRAINT units_not_self_parent CHECK(parent_id IS NULL OR parent_id<>id);
ALTER TABLE units DROP CONSTRAINT units_kind_check;
ALTER TABLE units ADD CONSTRAINT units_kind_check CHECK(kind IN ('school','early_childhood','parish','administration','department'));
CREATE UNIQUE INDEX units_name_case_insensitive ON units(org_id,lower(name));
CREATE TABLE organization_structure_state (
 org_id uuid PRIMARY KEY REFERENCES organizations(id), version integer NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE organization_structure_history (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, unit_id uuid NOT NULL, unit_version integer NOT NULL,
 structure_version integer NOT NULL, actor_id uuid NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(unit_id,unit_version),
 FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_organization_history BEFORE UPDATE OR DELETE ON organization_structure_history FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
CREATE TABLE organization_structure_commands (
 org_id uuid NOT NULL, actor_id uuid NOT NULL, command_id uuid NOT NULL, fingerprint text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,actor_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TRIGGER immutable_organization_commands BEFORE UPDATE OR DELETE ON organization_structure_commands FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
