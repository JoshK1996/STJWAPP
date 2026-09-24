# Implementation status

The app is a live synthetic demonstration workspace. The full school, early-childhood, parish and accounting request remains incomplete. This public status records capabilities; account receipts, private operational evidence and local machine configuration are not published.

## Available

- Password/private setup, optional authenticator MFA, restricted PIN-only clock sessions, developer/owner/administrator/manager/finance/employee roles and explicit unit assignments.
- Transactional clock-in/out, job changes, breaks, exact historical evidence, reviewed time adjustments, staff schedules and requests.
- Interactive workforce charts, date/unit/person filters, exact tables, current staff state and direct payroll-hours Excel/CSV/JSON exports. Pay-rate records have separate restricted access.
- Standalone calendar/messaging; scoped school, family, class, attendance, admissions, care/dismissal, grading/report-card/standing/GPA foundations and selected validated import/report workflows.
- Account visual/navigation preferences, scoped expiring API credentials and an optional local read-only MCP bridge.

These capabilities do not establish complete operational workflows. School policies and operational acceptance require staff confirmation before real student use.

## Current delivery work

The current iteration adds searchable Quick jump with Ctrl/Cmd+K and keyboard navigation, permission-aware destinations, a labeled offline indicator, a colorful current-team board with work/break filters and honest refresh/error state, dimensional interaction feedback, and responsive corrections for narrow screens and dialogs. Reduced-motion/depth preferences and unsaved-change guards remain honored. Local verification passed 41 normal-authentication synthetic workflow checks and 85 responsive layout samples with zero runtime errors. These samples do not establish every physical device or full accessibility conformance. The clean publication suite passed all 925 application tests and its production build. This iteration is live in deployment `f2d4d531-c9de-4a4f-9e6f-5f40e24b5131`, with schema 033 unchanged. Public hosted verification passed 12 checks, two exact asset comparisons and 52 anonymous protected-route denials, with zero unexpected console/runtime errors. This is not authenticated customer-account acceptance.

GitHub source is organized under `apps/workspace`; the original prototype remains unchanged.

## Explicit limitations

Clock duration is not wages. Gross/net pay, overtime, paid breaks, earned PTO, taxes/deductions and payroll closeout remain unfinished. Google sync, external email, parent arrival/geolocation, full accounting and remaining SIS work are not complete. Private finance attachments are paused and excluded.

See [remaining scope](REMAINING-SCOPE.md), [delivery](DEVELOPMENT.md) and [ADRs](adr/README.md). Mocked, local authenticated and hosted checks are distinct evidence and must be reported separately per release.


## Saved local work â€” September 24, 2026

Paused at the owner's request for the night on branch `codex/install-school-identity`. This work is **not deployed**. The live deployment above remains unchanged.

Implemented locally: official school entrance / All Saints Chapel photography and school crest; home-screen manifest and icons; capability-based Android install action and iPhone guidance; permanent app/update entry; deterministic release discovery, guarded bottom update prompt, and synchronous pending-write protection. No service worker, private offline cache, automatic reload or queued clock writes is introduced. See [installation](INSTALLATION.md), [imagery provenance](SCHOOL-IMAGERY.md), and [ADR 0003](adr/0003-installation-and-safe-updates.md).

Verification so far: 935 application tests and production build passed; 37 compiled browser installation checks passed, including simulated native install events (not physical-device installation). Initial two-real-build synthetic rollout passed 17 checks, including sessions, active shift, pending-write protection and unsaved/sign-in form refusal. A follow-up extends lost-response clock retry/rollback checks; verify its final result before claiming it passed. Private local evidence remains in `.work` and `output/playwright`.

Before release: correct the crest tile's stacking in reduced-motion mode (photo retains translateZ while crest is flattened), rerun affected browser/build checks, complete source/publication review, update final release evidence and publish/merge/deploy through the documented separate database maintenance procedure. Physical iPhone/Android installation still needs device acceptance. Existing browser clients will need one ordinary refresh to receive this first update-monitor implementation; subsequent compatible deployments can then prompt them.

Follow-up result before stopping: the extended rollout run did not complete. The browser reported pointer interception while clicking the employee update button after confirming the shift; the cause still needs investigation. Do not report the added lost-response/rollback checks as passed. The earlier 17-check rollout pass and the 37-check installation pass are separate evidence.
