# STJW School Ops Implementation Progress

This file tracks the FACTS-comparable buildout. Keep it updated whenever a feature moves from mock/staged to working.

## Current Runtime

- Frontend: Vite app, usually `http://127.0.0.1:5180/`
- Local API: `npm run agent:api`, `http://127.0.0.1:8787/`
- Persistent store: `data/mock-school-data.json`
- Verification command: `npm run build`

## Completed

- [x] Local school-ops API
  - `GET /api/health`
  - `GET /api/bootstrap`
  - `GET /api/export`
  - `PATCH /api/students/:id`
  - `POST /api/attendance/submit`
  - `POST /api/facts/preview`
- [x] File-backed persistence for students, attendance records, classes, and audit log.
- [x] Frontend hydrates students, attendance records, and classes from the API.
- [x] Student quick edits and profile edits save through the API.
- [x] Teacher attendance submission saves through the API and updates the class submission status.
- [x] FACTS CSV snapshot preview identifies create/update counts before import.
- [x] App date corrected to Friday, May 8, 2026.
- [x] Messages, teacher tasks, calendar requests/approvals, and class creation persist through audited collection writes.
- [x] Security page includes a visible audit log with refresh.
- [x] Account profiles are persisted and loaded from the local API.
- [x] Admin account invites/status/role/link edits persist through audited writes.
- [x] Class edit/delete workflows persist through audited writes.
- [x] Role-gated write helper blocks collection writes for non-permitted roles.
- [x] Mock seed data replaced with imported school data from `docs/SchoolData`.
- [x] Repeatable PDF import script added: `npm run import:school-data`.
- [x] Imported student records, guardians, account profiles, attendance placeholders, class sections, and import audit metadata.
- [x] Connected-school navigation model and interactive ecosystem diagram added to the command center.
- [x] Enrollment pipeline, health and safety workspace, and family portal experience added as UI-ready modules.
- [x] Responsive motion system added with reduced-motion accessibility support.

## In Progress

- [ ] Broaden persistence beyond operational collections into accounts, health, behavior, academics, lunch, and reports.
- [ ] Connect enrollment, health, and family portal modules to persisted records and role-specific APIs.
- [ ] Add CSV import apply flow after preview.
- [ ] Review imported class-list rows with blank grade values and decide whether to keep, enrich, or hide ungraded specials/rooms.

## Next Milestones

1. Persistence expansion
   - [x] Messages and acknowledgements
   - [x] Teacher tasks
   - [x] Calendar requests and approvals
   - [x] Account invites/admin actions
   - [x] Class create
   - [x] Class edit/delete

2. Security and audit
   - [x] Visible audit-log screen
   - [x] Role-gated write helper
   - [x] Actor names on API writes implemented so far
   - [ ] Sync/import lock confirmation

3. FACTS/OneRoster readiness
   - [ ] OneRoster CSV profile for users/classes/enrollments
   - [ ] SFTP/API configuration placeholder fields
   - [ ] Import apply with duplicate detection
   - [ ] Sync run history

4. Core school workflows
   - [ ] Attendance office closeout
   - [ ] Student/family CRUD
   - [ ] Class roster import and edits
   - [ ] Academic snapshots
   - [ ] Behavior events
   - [ ] Lunch balance notices
   - [ ] Health records

5. Portals and communication
   - [ ] Parent/student account views
   - [ ] Message delivery states
   - [ ] Required acknowledgements persisted
   - [ ] Family-facing student summary

## Verification Log

- 2026-05-08: `npm run build` passed. Browser smoke confirmed API hydration, FACTS CSV preview, attendance save, and no console errors.
- 2026-05-08: `npm run build` passed. Browser smoke confirmed persisted calendar request, calendar approval, message post, task create, class create, audit-log visibility, and no console errors.
- 2026-05-08: `npm run build` passed. Account profile persistence, admin invite/edit flows, class edit/delete, and guarded collection writes implemented.
- 2026-05-13: `npm run import:school-data` imported 63 students, 141 guardians, 204 account profiles, 63 attendance placeholders, and 229 class rows from `docs/SchoolData`. `npm run build` passed.
