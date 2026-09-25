# Implementation status

The app is a live synthetic demonstration workspace. The full school, early-childhood, parish and accounting request remains incomplete. This public status records capabilities; account receipts, private operational evidence and local machine configuration are not published.

## Management editing — September 24, 2026

Prepared for release: People & jobs gains job title/description/community/availability editing, archive/restore, search and readable history. Own pending general requests can be edited or withdrawn. School years, terms, courses and timetable rooms have editors/history. Calendar exposes direct agenda editing and preserves exact unchanged timestamps. Settings supports current-password-confirmed self-service password changes. Accounting adds contact maintenance, bill/invoice draft edit/discard, explicit conflict reloads, budget/payroll replacement preparation and imported-report metadata revisions. See the [cross-page editing inventory](EDITABILITY.md) and [ADR0008](adr/0008-management-editing-and-preserved-evidence.md).

Expected revisions, fresh authorization, transaction/audit rollback and preserved historical references protect these changes. Request approvals reject revoked sessions and changed requests; creating an employee coordinates with job edits; financial issue/settlement revalidates current account coding. Posted/issued financial evidence, captured attendance, released results and completed custody records are not freely overwritten. The inventory explicitly lists remaining historical amendment/migration gaps.

The final application suite passed all 1,106 tests, with zero failures, cancellations or skips. Final local browser acceptance passed 45 management checks/15 layouts, 79 school checks/33 layouts, 90 finance checks/18 layouts and 84 clock checks/14 samples, with zero unexpected errors. The entry SHA256 was `5ea710ff678e16c3d8c227452cb5729577e2716c43e6b22d28c3358dcae75d87`. These are ordinary-authentication synthetic Chromium checks, not physical devices or hosted customer-account acceptance. Deployment evidence follows after maintenance and hosted verification.

## Accounting workflows — September 24, 2026

Live in the accounting release: exact ledger and configurable starter settings; accounts, funds/programs/grants, periods, balanced posting and linked reversals; ledger-backed financial statements and styled Excel; bills/invoices, credits, refunds and externally recorded payments; bank CSV preview, grouped matching and immutable reconciliation; approved budget comparisons; and reviewed payroll preparation, accounting posting and recorded net payment. The colorful accounting workspace includes mobile layouts, workflow selection and clear settings guidance. See [ACCOUNTING](ACCOUNTING.md) and [ADR0007](adr/0007-accounting-ledger-and-reviewed-workflows.md).

The owner explicitly selected usable defaults: USD, two decimals, accrual accounting, January 1 fiscal start and all workflows enabled. They remain visibly unreviewed until an authorized accountant saves the settings. The optional starter chart creates no balances or transactions. Historical currency/basis/precision cannot be silently changed after financial records exist.

Local verification passed 1,068 application tests, the production build, 184 accounting browser checks/42 layouts, 58 existing reporting checks/13 layouts and 84 clock checks/14 samples. Actual Excel rendered seven synthetic accounting pages, all visually inspected. Production dependencies reported zero vulnerabilities; publication hygiene checked 506 files without problems. Deployment `e3bbb811-6c1e-49fa-9feb-30d399603e2c` is live. Separate database maintenance dry-run and commit passed; migrations 035–037 are deployed and immutable. All 329 staged runtime files match source commit `f3bdf309ea54496f0098c16d3d083e2f7452ccdc`, manifest SHA256 `dcee19b2c161575bdc8e9ac93393ef926346e5442593a69c9c9959cd2fa55cd8`. Public hosted acceptance passed 34 checks, 12 exact asset comparisons and 80 anonymous protected-route denials with zero unexpected browser errors. Temporary maintenance access was revoked. These are anonymous hosted checks, separate from local authenticated synthetic workflows.

Bank feeds, payment transmission, statutory tax calculations/filing, inferred wage/fee rules, automated tuition/childcare billing, donor receipting, automated allocations, currency/basis conversion, multi-entity consolidation and statutory close/disclosures are not implemented by this release. Payroll amounts are accountant-entered/reviewed inputs, not determined legal pay or tax obligations. Customer credentials and real financial data are not used for acceptance.

## Readable reports - September 24, 2026

Live in deployment `0f53d564-9184-4cb1-a059-e63d2ef773aa`: customizable Payroll Excel/CSV with readable summaries and optional exact audit sheets; reader/audit modes and previews for workforce and Report Library; styled saved-snapshot Excel; and a financial source-report studio with selectable columns, filters, order, precision, interactive group charts and matching CSV/print views. Dashboard totals also use concise hours with exact durations available on hover. Internal IDs and long decimals no longer lead the new readable views. Exact source evidence remains available. See [READABLE-REPORTS](READABLE-REPORTS.md), [REPORT-STUDIO](REPORT-STUDIO.md), [accounting roadmap](FINANCE-ROADMAP.md) and [ADR0006](adr/0006-readable-report-presentations.md).

The local application suite passed all 1,013 tests; the final export-focused rerun passed 32 tests. Production build and the production dependency audit passed (zero reported vulnerabilities). Normal synthetic authentication verified 58 reporting checks across 13 layouts, plus 84 mobile-clock checks across 14 samples, with zero browser runtime errors. Actual Excel rendered two Payroll variants and a long saved-report fixture; their five pages were visually inspected. Physical devices and customer-account hosted authentication are not claimed.

Separate maintenance dry-run and commit passed with schema034 unchanged. All 307 staged runtime files match source commit `665aa1c59757d6607345fbefff4c8fc0e1d1a641`, manifest SHA256 `ff6d3d326b4732b2fa3f160a4d2e03126eb566c3426060f4603efcf71e4f84aa`. Hosted public acceptance passed 34 checks, 12 exact assets and 62 anonymous protected-route denials, with zero unexpected errors. Temporary maintenance access was revoked.

At the readable-reports release, finance remained a reviewed-source reporting workspace. The accounting implementation above now adds manual ledger, reconciliation, AP/AR, dimensions and payroll preparation; automated billing, providers and confirmed wage/tax policy remain separate. All accounting tracks remain in the plan; organization policies are not inferred from vendor features.

## Payroll preparation - September 24, 2026

The live release adds personal saved Payroll filters, relative calendar periods, cross-device revision conflicts, explicit unavailable selections and Reset filters. The colorful comparison shows the preceding equal-calendar-day period, employee drilldowns, exact values, incomplete-period labels and CSV/JSON downloads alongside the existing Excel hours workbook. Pending corrections remain a separate Time records review, explicitly uncounted here. Gross/net pay, wage policy and payroll approval/closeout remain unimplemented. See [PAYROLL-PREPARATION](PAYROLL-PREPARATION.md) and [ADR0005](adr/0005-personal-payroll-views-and-comparisons.md).

Local validation passed all 976 application tests and the production/staged builds. Final normal-authentication synthetic browser acceptance passed 44 Payroll checks across eight layouts and 84 clock checks across 14 samples, with zero runtime errors. Narrow layouts, large text, dark/flat preferences, saved-view conflicts and a deliberately delayed export after leaving Payroll were checked. Physical devices and hosted customer-account authentication remain unverified.

Separate maintenance dry-run and commit passed; schema034 is deployed. Deployment `b50f8e26-97a5-411e-9981-0f492e4afce4` is live. All 294 production files match source commit `96f0059386efd6df76eb6041155fb32e1d0e723e`, manifest `21eea6f395a807a9592b7ac325939d70332ed9548fb4aaaf7ac4eaec46326a8e`. Public hosted acceptance passed 34 checks, 12 exact assets and 57 anonymous protected-route denials, with zero unexpected browser errors. Temporary maintenance access was revoked. Existing clients can use the guarded update prompt after finishing pending work.

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

Clock duration does not establish wages. Reviewed payroll preparation calculates entered quantities/rates and net pay from entered deductions; overtime, paid-break/leave policy, statutory taxes and provider closeout remain unconfigured. Google sync, external email, parent arrival/geolocation, full accounting and remaining SIS work are not complete. Private finance attachments are paused and excluded.

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
