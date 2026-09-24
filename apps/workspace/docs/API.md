# API and agent access

The application exposes its implemented workforce and school operations under `/api`. [openapi.json](openapi.json) is its machine-readable inventory; request definitions derive from the same Zod schemas as the service. Staff-directory, workforce-report, linked schedule-request, time-adjustment, retained report-snapshot, employee-import evidence and workbook-conversion responses have explicit schemas; other response contracts still need expansion. Regenerate with `npx tsx scripts/api-contract.ts` after endpoint changes. The September 24 payroll-preparation inventory has 258 paths and 305 operations; deployment status is tracked in STATUS.md.

Browser credentials are private setup → password → expiring server session. Writes require the exact configured Origin, JSON content type, and `X-CSRF-Token` obtained from `/api/me`. A PIN session can only read its identity, read/mutate its own clock, and sign out. No role, organization, employee ID, or timestamp supplied by a caller overrides server identity.

`PATCH /api/me/preferences` saves appearance and dashboard choices for the verified account. Partial updates retain unrelated choices; the strict schema is in `shared/preferences.ts`. Themes are light/dark/system with nine named accent palettes and a custom color. Dashboard order must contain all six known card IDs exactly once, and at least one card must remain visible. Preferences cannot grant a role or bypass data scope. PIN sessions cannot write preferences. Existing light/dark/compact/home clients remain supported.

Owner Settings can create a named bearer token lasting 1–90 days with `reports:read` and/or `staff:read`. Supply `Authorization: Bearer <private token>` over HTTPS. Staff scope permits GET `/api/staff`; report scope permits the documented workforce report/export routes, payroll hours/comparison reads and exports, and personal payroll-view listing/resolution. These tokens cannot modify anything or impersonate another employee. Current service checks enforce role and organizational scope in addition to the token scope. Never store tokens in a browser URL, source control, an AI prompt, or a shared report.

Personal payroll views and period comparison contracts are described in [PAYROLL-PREPARATION](PAYROLL-PREPARATION.md). Views store filters only and never retain access after assignments change. Their mutations require a current password session and expected revision; report tokens remain read-only.

Example read (supply the token through your client's secret store):

```http
GET /api/reports?start=2026-09-01&end=2026-09-30&group=week
Authorization: Bearer <secret-store-value>
```

Reports return `workMs`, `breakMs`, `buckets`, `staff`, `rows`, `timezone`, `asOf`, `query`, and a payroll-policy notice. Dates include both selected local calendar days. Row `duration_seconds` is clipped to that range and the report's `asOf`; original segment timestamps remain unchanged. Work and break durations are separate, and neither is a certified wage or payroll calculation. Use `asOf` when explaining a report of open shifts.

Live in `7a2bdc29-ffc9-4f4d-8681-de457ef9df0c`: both direct report routes refresh current account, role, exact unit membership and actual session/scoped bearer proof under locks, then recheck expiry before publication. CSV formatting and its audit share that transaction. Response fields and existing millisecond arithmetic are unchanged. See WORKFORCE-REPORT-AUTHORIZATION.md for evidence and limits.

Clock commands require a fresh UUID `commandId`. Retry an uncertain response with the same ID and identical body; a different payload with that ID is rejected. Supported actions are `clock_in`, `clock_out`, `switch_job`, `start_break`, and `end_break`; only clock-in/job-switch need `jobId`. Switching jobs during a break requires ending the break first.

Imports follow template → preview → human review → apply using the preview ID and source hash. Separate reviewed CSV workflows also cover students, enrollment, class rosters, assignment scores, compensation and financial reports; see their domain contracts. Multiple unit/job UUIDs use pipe characters (`|`) inside their fields. Accounts from an import remain unusable until a manager issues each private setup link. Jev advice receives column headings only and never commits a mapping or import.

Errors return `{ "error": "message" }` and sometimes an opaque `incident`. Standard statuses are 400 invalid input, 401 unauthenticated, 403 denied, 404 unavailable, 409 conflict, 413 oversized, 415 non-JSON, 429 throttled, and 503 unavailable optional AI advice. Clients must display failures and refresh state; do not fabricate success after a timeout.

Hosted ChatGPT/Claude OAuth, delegated agent writes, service identities, versioned external contracts and webhooks remain planned. A separate local stdio MCP connector exposes the existing bounded staff/workforce read interface. Browser workflows have domain-specific pagination and reviewed commands; they do not grant agent writes. Future adapters must invoke the same service authorization and audit boundary rather than access the database directly.


## Standalone calendar and messages

`/calendar/events` lists a bounded time window and creates personal, unit or organization events. Recurrence expands into individual occurrences with a common series ID. Updates/cancellations affect one occurrence and require its current version; each change preserves a revision. The original audience is retained to protect history. Personal events are only visible to their creator. Shared unit/organization writes require appropriate managers/administrators. Google sync, resource bookings, invitations and reminders are not implemented.

`/messages` supports own inbox, sent, drafts and archive with 50-row pagination. Drafts are sender-only. Sending revalidates the reviewed version and current permitted active recipients, locks the draft and delivers once under retries. Read/archive state belongs to each recipient. Sent content is immutable. General audit contains metadata, not private content. These messages remain inside the application; external email, family portal delivery, push notifications and attachments are not connected.

Both modules require password sessions. Existing read-only agent tokens have no access to these modules. See the generated OpenAPI inventory for each payload and endpoint.

## School records and attendance

The generated inventory now contains 68 implemented paths. School routes require password sessions. Owner/admin have school office access; other staff need an explicit unit office grant or a current teaching assignment. Workforce finance/manager roles alone grant no student access. Teacher student views omit birth dates, private restrictions, households and pickup permissions. Private histories use school-specific access.

Attendance is dated by school timezone and enrollment, with captured roster/name/code snapshots. Save the current session version and every captured expected student; submission requires all marks and any required notes. Submitted corrections require office access plus a reason. Office reconciliation retains removed marks and resets the session to draft. Closeout requires fresh coverage fingerprint/version and reviewed absences; reopening is explicit and audited. Exports distinguish each session’s roster validity from the daily homeroom closeout. Existing read-only agent tokens cannot access school routes.

## Time records and applied corrections

`GET /time-records` lists up to 100 full shifts with date/person filters and offsets; `GET /time-records/{id}` returns the current segments, visible correction history and allowed jobs. A manager needs every unit of the full shift; proposed/historical units are checked separately. `POST /time-corrections` creates an immutable proposal against a source revision and command ID. The same command ID/payload retries safely. Every proposed segment is explicit, ordered, contiguous and nonfuture; code rechecks jobs and overlap under the employee lock. `POST /time-corrections/{id}/review` approves/applies or declines, with current version and review note. The proposer and affected employee cannot review. Approval adds a new revision of segments without editing old segments; reports and exports select the active revision. Proposers may cancel pending corrections. Generic `/requests` decisions remain separate and do not apply a correction. PIN/API tokens cannot use these new routes. The OpenAPI inventory contains 73 paths.

## Admissions

School-office password sessions only: `/school/admissions/settings` versions/confirms per-unit checklists; `/school/admissions` lists stages or records idempotent inquiries; `/{id}` returns/edits office details and private history; `/stage`, `/checklist`, `/refresh-checklist` and `/enroll` record explicit reviewed actions. Offers, acceptance and enrollment require the current confirmed checklist. Policy edits and decisions serialize per unit. Conversion reuses applicant identity, preserves existing student/contact permissions and grants no guardian/pickup authority. New communication permission is an explicit input. Files, public application submission, tuition and external sends are not implemented by these endpoints.

Personalization also accepts `accent` values cobalt/lagoon/sunset/custom, a strict six-digit `customColor`, `artwork` full/subtle/none and boolean `depth`. Existing appearance choices remain valid; partial updates preserve unrelated fields. These values grant no application permissions.

## Classroom grading

Gradebooks are scoped to currently assigned teachers or school office access. `/school/grading/settings` versions school-confirmed policy; `/school/gradebooks` snapshots that policy and dated class/term enrollment. Assignment and score mutations require current book/assignment versions. Points use integer hundredths; category weights and grade thresholds use hundredths of a percent. Rational arithmetic compares labels before configured display rounding. Submit makes a book read-only; office lock creates immutable results, and reopening preserves earlier releases. Changed rosters require office reconciliation before another review. Exports include provenance and roster validity. Lists show 100 recent private history entries and 50 release summaries; retained older records remain in storage. Annual report-card endpoints now combine reviewed class results across terms; parent/student portals, transcripts, GPA, rank, honor-roll and graduation remain open.

Childcare routes are documented under `/care` in OpenAPI (100 implemented paths total). Password sessions and independent program assignments or school office access apply. Program/roster/hold changes and timesheets require school office access. No agent or PIN access. Server timestamps, actor-bound commands, current contact/person versions, explicit identity/handoff confirmations and atomic audit evidence govern check-in/out. See CHILDCARE.md for limits.

Staff dismissal adds `/dismissal` routes, bringing the documented contract to 114 implemented paths. Explicit unit dismissal assignment or school office access is required; office controls configuration, plans, absence resolution, reconciliation, closure and exports. Calls never release children. Physical actions require today/open state and current roster; office absence resolution or call cancellation may resolve a changed roster. Immutable original handoffs and closeouts remain readable within scope. Canonical input contracts are in shared/dismissal.ts.

Report-library routes: GET/POST `/report-library`, GET `/report-library/options`, POST `/report-library/preview`, GET `/:id/history`, `/:id/run?version=N`, and `/:id/export?version=N&format=csv|json` under that prefix. Password-only, private account ownership; every source execution rechecks permissions. Versioned definitions are not retained result snapshots. Runtime schemas: shared/report-library.ts. See REPORT-LIBRARY.md and openapi.json.

Care transfer routes: POST `/dismissal/runs/:id/entries/:studentId/care-transfer`, GET `/care/programs/:id/transfers`, POST `/care/transfers/:id/decision`. Source staff request; a different currently assigned receiving account accepts. Client commands carry versions and physical confirmation, never a receiver identity. Current scope, today/roster/program/enrollment/capacity and child hold checks are repeated within the transaction. Office plan input now accepts mode care and careProgramId.


Schedule revision contract: POST /schedules now requires reason and commandId. PATCH /schedules/{id} and POST /schedules/{id}/cancel require expectedVersion, reason and commandId. Employee identity is fixed; current role/unit/job access and overlaps are rechecked under sorted account locks. GET history uses optional beforeVersion cursor; cancelled rows require includeCancelled=true in the list. Details: STAFF-SCHEDULING.md.

GET /calendar/export?from=...&to=...&audience=all|personal|unit|organization returns an explicit text/calendar attachment after current session/unit checks. Standalone active events only, maximum 367 days/2,000 events; no public subscription or external send. Details: CALENDAR-EXPORT.md.

The report-library compensation source is current owner/admin/finance-only and uses effective-date overlap, exact decimal strings, optional void entries and count-only summaries. Saved layouts cannot retain source access after role revocation. Details: COMPENSATION-REPORTS.md. That release contained 188 documented HTTP paths; only existing staff/workforce-report GET routes accept current read-only agent tokens.

September 23 extension: the generated OpenAPI inventory now has 190 paths. Staff directory and workforce report GET responses have explicit field schemas; most other response contracts still require that work. Family templates now include households, memberships and student contacts, with populated CSV, exact identity export and private retained-source downloads. The separate `integrations/mcp` package provides two bounded local stdio read tools, tested against the synthetic actual app. No hosted OAuth or agent write endpoints were added.


Linked schedule requests add GET/POST `/schedule-requests`, detail/history, reviewed approval/decline and employee withdrawal. Approval applies the exact submitted schedule change in the same transaction as the request decision, histories, audits and retry receipts. Generic `/requests` remain decision-only. Request explanations are excluded from broader schedule history. See SCHEDULE-REQUESTS.md.

Private report snapshots add prepare/reopen review, capture/list, retained-detail and exact CSV/JSON export under `/report-library/:id`. Source access is rechecked against the full captured contributor manifest, including hidden grouping inputs and zero-row class selections. Stored copies do not rerun the source. Complete response schemas and limits are in OpenAPI and shared/report-snapshots.ts. These paths require password sessions; existing bearer scopes do not grant access. See REPORT-SNAPSHOT-DESIGN.md.

The deployed instructional-calendar extension adds POST `/school/timetable/export` with the exact loaded unit/year/date/filter selection and `expectedRevision`. It returns a complete private ICS attachment after fresh password-session and source-scope checks, or rejects the whole request. Student filtering is office-only and remains in the request body. GET `/school/timetable` JSON includes the revision and representation timestamp captured with its displayed rows; CSV columns are unchanged. The generated contract now contains 201 paths/238 operations; actual deployment evidence is tracked separately in STATUS.md. The pure academic-standing calculator has no HTTP endpoint yet.

The deployed schema-024 policy extension adds `/school/standing/policies`: a source catalog, paginated records, office-prepared draft creation/editing, owner-only confirmation, archive/restore, history and immutable confirmed-copy reads. All routes require current password-session and exact school-office authority; no agent or PIN access is added. Inputs and response fields are documented in the generated inventory, now 209 paths/248 operations with 1,348 resolving local references. This policy contract is deployed in `84a4f848-b530-4f58-b4cb-5ffbd8070e27` and retained unchanged by its sign-in contrast successor. The policy endpoints do not calculate or retain a student's standing. Temporary source timeouts return 503 so a retry retains its original command; stale/conflicting reviews return 409. See STANDING-POLICIES.md.


Reviewed student standing adds eight operations under `/school/standing`: eligible issued cards, private preparation/readback, immutable retention/list/detail/export, and separate currentness checking. Its strict public schemas include immutable policy-confirmation provenance, exact attachment hashes, same-command retry behavior and revision-aware pagination. Generated inventory:216 paths/256 operations/1,422 resolving references. These routes require current password-session and exact office authority. They add no bearer access. Release status is tracked in STATUS.md; see STANDING-DECISIONS.md.


Schema 026 adds `POST /auth/credentials/complete` and explicit temporary-onboarding branches for staff creation/login. New account creation optionally accepts `initialCredentials` only for current owners/admins; owner-only administrator grants remain enforced. Both temporary sign-in modes return the strict limited challenge without an ordinary session. Completion requires both distinct replacements, consumes current proof atomically and requires a fresh sign-in. The staff directory exposes `requires_credential_change` and keeps `setup_complete=false` until completion. Generated inventory: 217 paths, 257 operations, 1,431 resolving references. See TEMPORARY-CREDENTIALS.md.

Schema027 time-adjustment endpoints are live in deployment `7a2bdc29-ffc9-4f4d-8681-de457ef9df0c`: reviewed missing shifts, open-shift closure, scoped discovery, immutable decisions and exact retained JSON/CSV evidence. These management endpoints require a current password session; PIN and bearer access are denied. See TIME-ADJUSTMENTS.md.

Clock-session release `cb797de6-f702-4ac6-a676-161db3add614` now revalidates actual password/PIN proof under account-first locks and again before returning reads, new transitions or exact receipts. Current password MFA applies while PIN stays restricted to the clock. See CLOCK-SESSIONS.md for verification and remaining limits.


Exact `/api/reports/v2` and CSV/full-JSON `/api/reports/v2/export` are live in deployment `8d62f2bd-5014-4eb7-892c-0a41936a6f17`, together with explicit precisionVersion2 library definitions and schemaVersion2 retained copies. Existing v1 contracts/bytes remain. The generated source contract has228 paths,269 operations and1,538 resolved local references. MCP version2 support is local connector code; no client/token/OAuth configuration is implied. See WORKFORCE-REPORT-V2.md.


GPA policy configuration `/api/school/gpa/policies` and retained-copy `export?format=xlsx` are live in `a5be4735-05da-441e-83d4-57cca205eb96`. The generated contract has236 paths,279 operations and1,640 resolved local references. The workbook uses separate generated-byte and original-payload hashes. GPA policy endpoints configure explicit rules; student GPA endpoints are not deployed. See GPA-POLICIES.md and XLSX-EXPORTS.md.


Student term-GPA review endpoints are live in `fc9e27ae-d6a2-4fc4-ae35-6075709f4161`: `/api/school/gpa/eligible-issues`, private previews and retained decisions, history/detail/currentness and original JSON/CSV exports. The generated contract contains 243 paths, 287 operations and 1,714 resolved local references. Current password-session and office authority are required; no PIN or bearer access is added. See GPA-REVIEWS.md.


The finance/layout session release preserves the endpoint inventory and successful DTO/file contracts. Expired or revoked actual proof now denies direct financial and private layout publication; transient financial lock/deadlock/serialization failures return503. See FINANCE-SESSION-AUTHORIZATION.md.

## Reviewed financial workbook conversion

Live in `e93a16cd-c8e6-425d-b45e-f5648b22c4ed` (schema 029 unchanged):

- `GET /api/import-workbooks/template?kind=finance` downloads the fixed text-formatted XLSX template.
- `POST /api/import-workbooks/inspect` accepts `{kind:"finance",base64,sheetId?}` and returns bounded sheet metadata and optional selected-sheet display samples. No worksheet/header is guessed.
- `POST /api/import-workbooks/convert` accepts `{kind:"finance",base64,sheetId,headerRow,expectedWorkbookHash}` and returns exact CSV plus separate original-workbook/CSV hashes, physical row mapping, excluded sheets/leading/empty rows and parser version. It creates no financial report; the existing preview/publish remains required.

These routes require a current owner/administrator/finance password session before parsing and again before publishing results/errors. Origin/JSON/CSRF middleware applies to POST; PIN and bearer tokens cannot use them. Workbook bytes are canonical base64, maximum 256 KiB decoded. Strict text-cell and ZIP/XML/projection/output limits are in XLSX-IMPORTS.md. The original workbook is transient; only the derived CSV follows existing financial source retention. One process-local spreadsheet slot is shared with retained-copy XLSX export.

Active care/grade/attendance layout save/restore/retry now retains current authorizing source grants through commit, with bounded NOWAIT transaction retries and 503 on persistent contention. Author metadata/history/archive custody and separate run/export source authorization remain unchanged; see REPORT-LAYOUT-GRANTS.md. The generated inventory has 246 paths and 290 operations. Anonymous hosted denials and local PostgreSQL concurrency evidence do not establish authenticated hosted races or natural session-expiry acceptance.

September23 deployment `ef4c6195-4bed-48a7-b903-691800ea6390` extends the existing three workbook routes to finance and six explicit `school_*` kinds. School requests require `unitId` and exact current school-office authority; finance rejects unitId. School headers retain catalog order and4096UTF8byte serialized-record cap; there are no arbitrary columns, domain writes or inferred permissions. Downstream school imports now require actual-session/final-expiry proof including all read/export and applied-receipt paths. Inventory remains246paths/290operations, with1762 resolved references and unique operation IDs. See SCHOOL-XLSX-IMPORTS.md and generated openapi.json.

September23 deployment `67791a01-a71c-4400-8804-bf65d0349eb6` adds `grade_scores` to the existing workbook routes with required `assignmentId` and forbidden `unitId`/caller-supplied rows. Templates contain1–200 authorized current captured rows, exact text and versions; generated source freshness is rechecked before download. Grade workbook CSV uses the exact unordered eight-column set, a200-row cap,20000-byte serialized records and200000-byte total. Existing grade CSV routes now require actual-session/final-expiry proof, including creator-private history/source and exact receipts. Inventory remains246 paths/290 operations, with1776 resolved references and unique operation IDs. See GRADE-XLSX-IMPORTS.md and GRADE-IMPORTS.md.


Organization appearance is live through current-password `GET /organization/branding`, owner-only `POST /organization/branding`, and owner-only paged `GET /organization/branding/history`. Strict plain-text/preset inputs, current authority, reviewed versions and canonical command receipts are documented in the generated inventory. Existing `/me/preferences`, staff PATCH, setup-link and job POST now recheck actual acting proof inside their transactions. Personal preference writes retain last-writer behavior; after an uncertain response, read and compare current preferences before another save. Publishing an organization preset does not automatically change personal preferences. See ORGANIZATION-BRANDING.md and STAFF-AUTHORITY.md.


Pay-rate workbook scope is live: strict `{kind:"compensation_rates",userId,jobId}` through existing import-workbook inspect/convert/template endpoints. No new paths or caller-supplied template rows. Text-only templates include retained IDs/version; 200 data rows and64,000 UTF-8 emitted CSV bytes. Current owner/admin/finance actual password proof is checked before and after the unlocked worker. Templates also compare the captured source hash. Existing compensation routes now require actual initial/final proof; pair mutex precedes sorted accounts; historical fingerprint/receipt formats are unchanged. Converted CSV still requires the existing business preview/save. See COMPENSATION-XLSX.md and generated OpenAPI.

Release `22218b78-d0bb-47d4-ba90-9487e447f0b5` adds the seventh school CSV kind, `people`, with context `{kind:"people",unitId}` and exact columns `personId,version,name,emailAction,email,phoneAction,phone`. Current templates and preview/apply/history/source use the existing creator-private routes and current actual session boundary. Person-profile XLSX remains unsupported. Manual `/school/people` GET/POST/PATCH now rechecks current actual password proof and office scope inside the transaction and before publication. Directory overflow above1000 returns422; import populated templates reject above500. Exact semantics and limits: PERSON-IMPORTS.md and PERSON-PROFILES.md. OpenAPI descriptions and source generators are updated.

Navigation release `91c0c15c-db3c-4faa-b3c0-6e516934e716` extends existing PATCH `/me/preferences` with `workspaceNavOrder` and `organizationNavOrder`. Each supplied array is an exact complete permutation of known IDs in its group; strict writes reject duplicates/missing/unknown/cross-group values. Omitted PATCH fields preserve stored order. Stored legacy preferences receive defaults; nav-only repair preserves valid legacy choices. No new routes, roles or scope grants. OpenAPI/generator updated; details in NAVIGATION-PREFERENCES.md.


Readable export options are additive. See [READABLE-REPORTS](READABLE-REPORTS.md) and the OpenAPI parameter definitions. Payroll hours accepts a JSON `presentation` query option for CSV/XLSX. Workforce and payroll-comparison CSV accept `presentation=readable`; Report library readable CSV also accepts `decimals=2|4` and `includeTechnical=true|false`. Finance version downloads accept `format=readable_csv`, selected `columns`, `search`, exact `group`, `rowKind`, `sort` and `decimalPlaces=2|4`. Existing default machine formats stay exact. Snapshot Excel uses export layout version 2 with a first readable Report sheet and retained Data/Provenance/Source JSON sheets. No presentation setting grants source access or changes source values.
