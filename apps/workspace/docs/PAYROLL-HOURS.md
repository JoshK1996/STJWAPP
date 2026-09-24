# Payroll hours and visual workforce release

The new workforce overview, clock, time records and direct Payroll workspace are live in deployment `bd954683-157f-42aa-8977-730b1cab1b32`, schema033. See WORKFORCE-ANALYTICS.md for the user walkthrough. This release does not complete the original school, childcare, parish or accounting scope.

## Hours and exports

GET `/api/payroll/hours` accepts the existing workforce date/group/unit/employee query and returns a versioned employee/job summary plus the full version-2 source report. GET `/api/payroll/hours/export` adds `format=csv|xlsx|json`. Current reporting roles may read their permitted scope; manager access retains explicit assigned units and the manager's own records. Password sessions and `reports:read` credentials are checked inside the source transaction and again before publication. PIN and ordinary employee sessions are denied. Pay-rate access is unchanged and remains limited to developer/owner/admin/finance.

Work and breaks use exact integer microseconds. Six-decimal hour strings are rounded half-up only after aggregation. Shift counts are distinct within each grouping; they must not be added across jobs. Ongoing counts describe segments with no recorded end, not whole-shift status or review approval. Zero-contribution selected source segments remain in source/count evidence. A current read/export can differ from an earlier screen while records change; retained report-library snapshots remain a separate reviewed-copy workflow.

CSV `row_kind` values distinguish employee, job and total records. These are different levels of the same data: do not sum them together. Excel provides Employees, Jobs, Totals, Source segments, Provenance and Source JSON sheets. Exact fields are text. Explicit `workHoursNumeric`, `breakHoursNumeric` and `totalHoursNumeric` columns contain bounded approximate numbers for spreadsheet formulas. They preserve neither exact decimal arithmetic nor payable-wage policy; use integer microseconds for exact calculations. Source JSON reconstructs the full payload and verifies against the provenance SHA-256. This does not claim desktop Excel interoperability testing.

The workbook worker uses a fixed module, empty environment/arguments, shared spreadsheet admission, a 15-second generation deadline, 16 MiB input, 32 MiB output and 192 MiB old-generation heap limit. That heap limit is not a total process-memory guarantee. Disconnects cancel generation. Current authority/expiry and export audit commit are verified by the existing report publication boundary. No new migration, table, dependency, accounting policy or credential is introduced.

## Visual and access behavior

The main report-role overview offers interactive area, line, bar and job/community donut charts, employee bars and exact paginated data. Query/actor/session/membership changes fence stale results. The clock retains the same commands, immutable retry identity and confirmed-versus-uncertain recovery. Time records retain correction history, review permissions and dirty-draft protection. Payroll is directly available in navigation, with current period/employee/job summaries, ongoing-segment review and one-click downloads. Preferences still control dark/light mode, depth, artwork and reduced motion; prior navigation orders gain Payroll without moving existing items.

## Review evidence

- All 995 application tests and the exact staged production build passed. Public hosted checks passed 12 checks, two exact assets and 52 anonymous protected-route denials.
- 28 actual normal-auth local dashboard/Payroll browser checks and 25 actual local clock/time-record checks; zero browser runtime errors. Clock checks include a controlled lost response followed by the same-command retry and independent correction approval. Tests use disposable synthetic databases, never customer credentials.
- 24 isolated mocked dashboard checks, including delayed responses after account and same-account unit changes; these do not prove server authorization.
- 17 focused payroll tests, including service authority, exact totals, source evidence, actual worker/HTTP exports, numeric columns and failed-audit rollback; five visual-arithmetic tests.
- Existing schema001–033 remains unchanged. The release overlays 20 reviewed files on the last deployed source and contains 265 manifest-verified files. Unfinished financial attachments and their extra dependencies remain excluded.

Jev narrow source screens used receipts `bb65e3e7d07d47549bee5d9cff80d982` and `5527f7bc009e417a8fbf8b06a4887017`; ranking receipts are in the release receipt. These are advisory hypotheses, independently checked against code and executable tests. Small typed checks follow [TypeSafe's atomic-question guidance](https://docs.typesafe.ai/introduction); no model decides arithmetic, permissions, wages or deployment authorization. The installed provider/model/questions were not changed.

Gross/net pay, overtime, paid breaks, earned PTO, deductions, payroll closeout and payment processing remain unimplemented here. Actual organization policies are not inferred from a vendor's configurable SIS capabilities.
