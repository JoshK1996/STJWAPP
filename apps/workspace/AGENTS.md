# Current STJW application

Read `docs/PLAN.md` and `docs/STATUS.md` before continuing. Keep implementation and verification claims explicit. The full original organization/SIS/accounting scope is not complete.

Use synthetic records for tests and browser checks. Never read, copy, serve or export the root prototype or reference repositories' school records, PDFs, credentials or production databases. Do not include local `.work`, `.railway`, output, keys or database artifacts in source control or deployments.

Obtain actor and organization from server-verified sessions. Use service-layer writes, explicit organizational-unit access, transactional time transitions and audits, precise historical timestamps and immutable evidence. Never round individual time segments before aggregation. AI supplies advice only; it cannot authorize access, approve pay or release a child.

Run `npm test`, `npm run build` and the repository hygiene checker. Meaningful changes require authorization/concurrency/date-boundary/import regressions where applicable. Use normal synthetic authentication for browser acceptance and label mocks separately.

Web production uses only `stjw_runtime`. It verifies schema/privileges and never migrates or seeds. Review and stage an exact manifest; run separate database maintenance as a dry run, then commit; deploy that exact source. Migrations 001-039 are deployed and immutable. See `docs/DATABASE-OPERATIONS.md`.

Academic scheduling mutations acquire `lockAcademics` before domain row locks, validate the resulting timetable and advance its revision in the same transaction. Attendance preserves captured identity/code snapshots and repeatable-read source evidence; missing/draft coverage is never an absence.

Use focused `codex/` branches and reviewable pull requests. Follow the owner's current authorization for external writes. Keep ADRs, feature documentation and actual status current. Owner/customer credentials are never testing shortcuts.
