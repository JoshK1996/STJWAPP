# Database operations

The web application and maintenance runner use separate privileges. Production traffic uses only `stjw_runtime`; startup verifies schema and denied elevated capabilities. It never migrates or seeds production. Development/tests may use disposable synthetic PGlite databases.

## Maintenance sequence

1. Start from a reviewed commit with passing tests/build. Stage production source and record its file/hash manifest, including only intended additive migrations.
2. Generate/review the plan using repository scripts. Confirm the target through authorized operational configuration; connection artifacts and secrets stay private.
3. Dry-run the plan in the separate PostgreSQL container with rollback. Review the result before committing that same plan.
4. Commit maintenance there, then deploy the exact staged source without changing reviewed files.
5. Read back expected schema/runtime privileges, verify the app and revoke temporary access.

PowerShell/OpenSSH scripts are operator tooling, not request handlers or CI. Identity and known-hosts files are private and never committed. The container uses its own database environment; scripts do not print passwords or connection URLs.

## Invariants

- Deployed migrations 001-043 are immutable. Add new numbered migrations instead of rewriting history.
- The web role never receives superuser, create-database/create-role or bypass-row-security privileges for migrations, tests or rollback.
- Time transitions and audits commit together. Historical revisions, finalized evidence and audits persist.
- Academic scheduling acquires `lockAcademics` before domain locks, validates the resulting timetable and advances its revision in the same transaction.
- Reports preserve captured identity/code snapshots and exact timestamps. Missing/draft attendance is not recorded absence.

Backups, retention, restore drills and response procedures need operational ownership. Schema checks do not establish restoration acceptance. See [deployment](DEPLOYMENT.md) and [development](DEVELOPMENT.md).
