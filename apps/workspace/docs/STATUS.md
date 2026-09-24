# Implementation status

The app is a live synthetic demonstration workspace. The full school, early-childhood, parish and accounting request remains incomplete. This public status records capabilities; account receipts, private operational evidence and local machine configuration are not published.

## Available

- Password/private setup, optional authenticator MFA, restricted PIN-only clock sessions, developer/owner/administrator/manager/finance/employee roles and explicit unit assignments.
- Transactional clock-in/out, job changes, breaks, exact historical evidence, reviewed time adjustments, staff schedules and requests.
- Interactive workforce charts, date/unit/person filters, exact tables, current staff state and direct payroll-hours Excel/CSV/JSON exports. Pay-rate records have separate restricted access.
- Standalone calendar/messaging; scoped school, family, class, attendance, admissions, care/dismissal, grading/report-card/standing/GPA foundations and selected validated import/report workflows.
- Account visual/navigation preferences, scoped expiring API credentials and an optional local read-only MCP bridge.

These capabilities do not establish complete operational workflows. School policies and operational acceptance require staff confirmation before real student use.

## Previous visual and mobile release

The current iteration adds searchable Quick jump with Ctrl/Cmd+K and keyboard navigation, permission-aware destinations, a labeled offline indicator, a colorful current-team board with work/break filters and honest refresh/error state, dimensional interaction feedback, and responsive corrections for narrow screens and dialogs. Reduced-motion/depth preferences and unsaved-change guards remain honored. Local verification passed 41 normal-authentication synthetic workflow checks and 85 responsive layout samples with zero runtime errors. These samples do not establish every physical device or full accessibility conformance. The clean publication suite passed all 925 application tests and its production build. This iteration is live in deployment `f2d4d531-c9de-4a4f-9e6f-5f40e24b5131`, with schema 033 unchanged. Public hosted verification passed 12 checks, two exact asset comparisons and 52 anonymous protected-route denials, with zero unexpected console/runtime errors. This is not authenticated customer-account acceptance.

GitHub source is organized under `apps/workspace`; the original prototype remains unchanged.

## Explicit limitations

Clock duration is not wages. Gross/net pay, overtime, paid breaks, earned PTO, taxes/deductions and payroll closeout remain unfinished. Google sync, external email, parent arrival/geolocation, full accounting and remaining SIS work are not complete. Private finance attachments are paused and excluded.

See [remaining scope](REMAINING-SCOPE.md), [delivery](DEVELOPMENT.md) and [ADRs](adr/README.md). Mocked, local authenticated and hosted checks are distinct evidence and must be reported separately per release.

## School identity and installation release - September 24, 2026

The presentation release replaces the visible invented campus imagery with official school entrance / All Saints Chapel photography and the school crest. It adds home-screen icons, capability-based Android installation, iPhone guidance, a persistent app/update entry, deterministic release discovery and a guarded bottom update prompt. No service worker, private offline cache, automatic reload or queued clock writes is introduced. See [installation](INSTALLATION.md), [imagery provenance](SCHOOL-IMAGERY.md), [ADR 0003](adr/0003-installation-and-safe-updates.md) and [presentation walkthrough](PRESENTATION-DAY.md).

Local acceptance passed all 935 application tests and the production build, 38 installation checks, 25 two-build update/retry/rollback checks, and 41 workforce/payroll checks, with zero browser runtime errors. Installation events and device modes were simulated; physical iPhone/Android installation remains unverified. Normal local authentication and payroll actions used disposable databases. The workforce board-error/offline cases used explicit simulation. The reduced-motion crest overlap and mobile update spacer were corrected and rechecked.

Release source `415cb65be54b4149236a644a048555e218e8c456` matches the exact 287-file manifest `4636f022fa3cd48e760eed3e6223a58a10f284e2f83b065a497907b3789bb643`. Separate maintenance dry-run and commit passed with schema 033 unchanged. Deployment `c0bfd6e2-e95a-4b56-bac9-28a463d26fd5` is live. Public hosted acceptance passed 34 checks, 12 exact asset SHA comparisons and 52 anonymous protected-route denials, with zero unexpected console/runtime errors. This is separate from local authenticated acceptance; no hosted customer-account login is claimed. Temporary maintenance access was revoked.

Existing browser clients need one ordinary refresh after finishing pending work to receive this first update monitor. Subsequent compatible deployed releases can then prompt them. Verify each actual phone before rollout.
