# Saved payroll views and period preparation

Payroll gains personal saved filters and a comparison with the preceding calendar period. This extends the recorded-hours workspace; it does not calculate wages or close a payroll run. The existing employee/job workbook, CSV and JSON hours downloads remain available.

## Personal views

A view has a name, relative or fixed date selection, grouping, optional community/employee filters and a comparison preference. Relative choices are This week, Last week, Last 14 days and This month. This week and This month run through the date on which the view opens; Last week is the previous Monday–Sunday. These are calendar shortcuts, not an assumed payroll schedule.

Views belong to one account in one organization and synchronize across its signed-in devices. There are at most25 active views per account. Renames, filter changes and removal require the current revision. Another device's change produces a conflict instead of silently overwriting it. A lost creation response can be retried with the same ID and identical body. Removed definitions retain deletion and audit evidence.

Opening a view resolves dates from the database clock in the organization timezone and checks the current account, session and organizational access. A selected employee who is inactive or unavailable, or an inaccessible selected community, makes the view unavailable. It never silently changes to all employees or communities. Managers retain explicit assigned-unit access and their own historical records; subgroup access is not inherited.

## Comparison

The prior period immediately precedes the selected start date and contains the same number of local calendar dates. Daylight-saving transitions can make their elapsed durations different. Both sides use the same captured database instant and repeatable-read source transaction. A current period that has not ended is labeled in progress; a future period is labeled future. The comparison does not project a complete period from partial hours.

Exact integer microseconds drive totals and signed changes. Decimal hours and percentages are rounded after aggregation. With no prior work hours, percentage change is unavailable rather than infinite. Employees present on only one side remain represented. Open-segment indicators describe selected source segments without a recorded end, not full-shift approval or payroll readiness.

Pending corrections remain a separate Time records review because their authorization covers every original and proposed unit of a whole shift. The preparation response explicitly returns `not_included` and a null count; it never treats missing correction coverage as zero or approval. Review actions link to the existing Time records workspace.

Comparison CSV and JSON downloads recapture the current source under the same authorization checks and write an export audit before publication. They can therefore differ from an earlier screen. Existing Excel hours downloads remain separate. Recorded work and breaks do not determine gross/net pay, paid breaks, overtime, PTO, taxes, deductions or payment obligations.

Both Payroll download paths check their current page/account ownership before publishing the file. Leaving Payroll, signing out or changing the account/scope while a response is pending prevents a late file save and success notification. This client publication guard complements the server's current proof checks; other existing callers retain their established download behavior.

## Service and storage

- GET `/api/payroll/review` and `/api/payroll/review/export` accept the workforce date/group/unit/employee query; export adds `format=csv|json`.
- GET/POST `/api/payroll/views`, PATCH/DELETE `/api/payroll/views/:id`, and GET `/api/payroll/views/:id/resolve` manage and resolve personal filters.
- Reads require a current reporting role and actual password or reports:read bearer proof. Writes require a current password session, correct Origin and CSRF. PIN sessions remain clock-only.
- Migration034 adds the dedicated filter table and its retained-deletion guard. The restricted web role can select/insert/update; it cannot delete definitions or migrate the database. Current startup verifies the exact enabled trigger and grants.

Shared strict schemas and the generated [API contract](openapi.json) define request and response fields. [ADR0005](adr/0005-personal-payroll-views-and-comparisons.md) records the decision. STATUS and VALIDATION record actual local, hosted and deployment evidence. Real school/payroll policies and operational acceptance remain outstanding.
