# Implementation status

The app is a live synthetic demonstration workspace. The full school, early-childhood, parish and accounting request remains incomplete. This public status records capabilities; account receipts, private operational evidence and local machine configuration are not published.

## Payroll preparation - September 24, 2026

The reviewed release candidate adds personal saved Payroll filters, relative calendar periods, cross-device revision conflicts, explicit unavailable selections and Reset filters. The colorful comparison shows the preceding equal-calendar-day period, employee drilldowns, exact values, incomplete-period labels and CSV/JSON downloads alongside the existing Excel hours workbook. Pending corrections remain a separate Time records review, explicitly uncounted here. Gross/net pay, wage policy and payroll approval/closeout remain unimplemented. See [PAYROLL-PREPARATION](PAYROLL-PREPARATION.md) and [ADR0005](adr/0005-personal-payroll-views-and-comparisons.md).

Local validation passed all 976 application tests and the production/staged builds. Final normal-authentication synthetic browser acceptance passed 44 Payroll checks across eight layouts and 84 clock checks across 14 samples, with zero runtime errors. Narrow layouts, large text, dark/flat preferences, saved-view conflicts and a deliberately delayed export after leaving Payroll were checked. Physical devices and hosted customer-account authentication remain unverified. The new table requires migration034 through separate maintenance; this candidate is not yet recorded as deployed.

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

## Mobile clock first - September 24, 2026

Mobile session startup now opens My time clock directly and resets the inherited login scroll position. Status, job selection, clock-in/out, break and explicit job-change controls precede decoration. Narrow/short-landscape layouts hide the large dial, place secondary navigation below the clock, and provide a one-tap Clock shortcut from other pages. Compact clock notifications appear below the card; install/update notices preserve access to the actions. Desktop saved homepages, permissions and clock command/retry logic are unchanged. See [MOBILE-CLOCK](MOBILE-CLOCK.md) and [ADR 0004](adr/0004-mobile-clock-first.md).

Local application suite: 935 tests passed; final production and staged builds passed. Final normal-authentication browser acceptance with the demonstration banner enabled passed 84 checks across 14 samples, zero runtime errors. At 320 x 568, Clock in and all job-switch actions remain inside the initial viewport; full bounding-box checks show no overlap with notifications or the update chip. Network loss and version discovery were deliberately simulated; physical devices remain unverified.

Release source `5d007df291aaa68d0fa0b7c68307499969710cc3` matches all 288 manifest entries (`3fb4cc7039109a89aeecac40fbf725b7a23c4aac06e300c2285ba181b7a288ed`). Separate maintenance dry-run and commit passed with schema 033 unchanged. Deployment `44e603a3-2e76-4bee-9b0e-d832f6895622` is live. Public hosted checks passed 34 checks, 12 exact asset comparisons and 52 anonymous protected-route denials, with no unexpected console/runtime errors. These anonymous checks are separate from the local authenticated workflows; no customer-account hosted test is claimed. Temporary maintenance access was revoked.
