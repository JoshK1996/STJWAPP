# Scheduled clock starts

An authorized manager can open an employee's **Clock setting** in People & jobs and enable **No early clock-in**. It defaults to off. The setting has its own Save and Reload controls, protects unsaved changes, and reports conflicting revisions. Changing it cancels that employee's pending start without changing recorded hours. Managers still need explicit access to the employee's communities.

With this setting enabled, the employee selects an assigned job on the clock screen. For an upcoming shift on the organization's current local date, the primary button shows **Start at [time]**. Tapping it saves a pending start. The screen says **Your time starts at [time]. Start work then.** and offers **Cancel start**. A pending start creates no worked hours. For a matching shift already in progress, **Clock in** records the current time. Without a matching available shift, the screen directs the employee to a manager; it does not create an unscheduled future start. A shift that began on the previous local date but is still in progress can be clocked into.

The app does not collect location or apply a geofence. The existing reviewed time-correction workflow remains available when actual work differs from the recorded time. The scheduled-start setting does not define pay, overtime, break or other wage policy.

## Server processing and recovery

The database retains the submitted intent, its exact scheduled start/end, original schedule revision, job/community labels, employee credential generation, policy revision and eventual outcome. The server processes pending intents independently of the browser. Closing the app, signing out or allowing the submitting session to expire does not revoke the already submitted authorization. Account deactivation, credential reset, changed clock setting, changed/cancelled schedule, archived/moved job or removed assignments prevent execution. A changed policy cancels pending starts immediately; the worker detects other changes during its bounded sweeps.

When due, one transaction creates the clock entry at the exact authorized scheduled start, its work segment, command receipt, intent outcome and audits. The audit retains the actual processing time separately. There is no automatic clock-out. If the server restarts during the scheduled interval, it rechecks the intent before processing it. If the entire interval has already ended, or another time record overlaps it, the intent becomes blocked and creates no shift. The employee sees the reason after refreshing or reopening the app.

Each worker pass handles at most 50 intents, then schedules another pass after one second. Upcoming intents are rechecked periodically. This is bounded processing, not a real-time execution guarantee. An individual transaction failure rolls back and remains eligible for retry while other selected employees continue. Repeated failures are logged with a generic worker warning; deployment monitoring remains necessary. The browser refreshes its own pending clock state every two seconds while visible and on returning to the page. It does not need to remain open for execution.

The employee account row is the first domain lock for submission, cancellation and execution. Worker execution then locks schedule, job and intent in that order. Existing schedule/person management shares the employee serialization boundary. Completed intents and event/command evidence are immutable. Migration040 adds these records and an account trigger that advances the credential generation when password/PIN, activation or first-login status changes. Startup verifies the exact enabled triggers and restricted runtime privileges; the web service does not migrate or seed.

## API

| Endpoint | Input/result | Access |
| --- | --- | --- |
| `GET /api/clock` | Clock state plus `preclock: {policy,pending,latest,schedules,timezone}` | Current password or PIN session |
| `POST /api/clock` | Existing clock command; an early clock-in can return a pending intent and `shift: null` | Current password or PIN session; exact command retry |
| `POST /api/clock/preclock/:id/cancel` | `{version,commandId}`; updated full clock state | Own pending intent; current password or PIN session |
| `GET /api/staff/:id/clock-policy` | `{noEarlyClockIn,version}` | Authorized password management session |
| `PUT /api/staff/:id/clock-policy` | `{noEarlyClockIn,expectedVersion}`; saved policy | Authorized password management session |

No public input accepts an actual or scheduled clock timestamp. Cookie mutations require the existing origin/CSRF protections. PIN access is extended only to the exact POST cancellation route, not employee settings or other management endpoints. Responses are private and uncached. Source types are in `shared/scheduled-clock.ts`.

## Verification boundaries

The focused synthetic tests exercise ordinary password setup/login, PIN creation/login and PIN cancellation, no-hours queueing, exact receipt retries, credential/schedule/assignment revocation, current/tomorrow date boundaries, ended/overlapping shifts, audit rollback, restart-style processing without a browser session, microsecond preservation, SQL evidence guards, and failure isolation between employees. A real server-clock batch test verifies due execution. Runtime tests deliberately remove required grants, add forbidden grants and disable each new trigger, then verify startup rejection and restoration.

On September 25, 2026, the complete application suite passed all 1,157 tests with zero failures, cancellations or skips, and the production build passed. Scheduled-clock browser acceptance passed 56 checks across 11 layouts on entry SHA256 `a8310bd62e2bef46c529ac71e363a24e25a01da3f1c3a83666d4d88fa1b68e0d`, with zero browser or worker errors. Normal synthetic PIN authentication exercised pending/cancel controls at 320, 390 and 1280 pixels, a real server-worker start while the browser context was closed, and the active clock after reopening. The manager editor exercised saved policy loading, cancelled and confirmed unsaved-change reloads, versioned saving and a narrow layout. Captured mobile and desktop screenshots were visually reviewed. No product source changed after that build; deployment status is recorded separately.

These tests use isolated PGlite databases. Their transaction and retry checks do not establish multi-connection PostgreSQL contention behavior. Browser and deployment results are recorded separately in the release validation/status documentation. Jev supplied advisory narrow invariant screens from reviewed source; ordinary code, tests and source review own verification. The typed state/question approach follows the [TypeSafe introduction](https://docs.typesafe.ai/introduction); receipts are retained privately. No model can authorize or execute a clock transition.
