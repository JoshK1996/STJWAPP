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
