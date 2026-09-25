# Workforce overview

The default workforce screen starts with Today/This week worked and scheduled hours, followed immediately by the people currently clocked in. Each card shows the current job, community, work/break state, and elapsed time in the current segment. Payroll is a direct action at the top. Advanced charts, date controls, exact records, and saved reviews open from **Detailed reports & charts**.

## Time and schedule meaning

- **Worked** excludes recorded breaks. Current-segment clocks are display estimates anchored to the server's exact timestamp and a monotonic browser timer. They never write time or feed payroll calculations. Offline and older snapshots show the last confirmed time with a visible notice.
- **Scheduled** uses the assigned scheduled shifts for the selected calendar period. Legacy overlapping shifts for the same employee/job are counted once through interval union.
- **Over schedule** compares each employee’s total work across jobs with that employee’s total allowance for each organization-local day. Switching jobs within the daily allowance does not create excess; a shorter day does not cancel excess from another day. Job rows show worked, scheduled, break, and outside-schedule time. Daily excess belongs to the employee comparison, without inventing an allocation between jobs.
- **Below scheduled totals** includes future scheduled time within the selected period. It is not an absence finding.
- **Outside scheduled times** measures recorded work outside matching scheduled intervals. It differs from over-schedule duration.

Today and This week are organization-timezone calendar periods. Both follow the selected community. An employee drilldown filters its own selected-period request while the team summaries remain team summaries. No wage, paid-break, or statutory overtime rule is inferred.

All authoritative arithmetic uses integer microseconds; time splits honor local calendar boundaries and daylight saving changes. Compact cards identify approximate minute displays, while exact durations remain in detail values. Charts use bounded display ratios after exact aggregation.

## Exports and saved reviews

The selected Today/This week comparison can download Excel or CSV or save a review snapshot. Each action captures fresh current source data. Saving preserves the captured schedule versions, recorded segment evidence, precise totals, and labels; it does not approve payroll or close a period. Repeated requests with the same command ID return the original capture, and a conflicting command payload is rejected.

Expanded reports list the latest 100 accessible saved reviews. A saved review can be opened and downloaded again without replacing its captured figures with current schedules. These records cannot be overwritten or deleted. Scope is checked against every captured organizational unit on subsequent reads and exports.

Excel has employee summaries, jobs/community details, and daily review sheets with named columns, frozen headings, wrapped labels, and two-decimal numeric hours. CSV contains named employee summary rows, with formula-like text neutralized. Rounding is applied only to final presentation values.

Browser requests belong to their mounted account and selected query. Obsolete responses are suppressed; export bytes are followed by a fresh session/access check before creating a browser download. Leaving a screen, changing selection, or revoked authorization prevents an old request from publishing.

## Verification

The targeted overview/service suite and visual-helper suite passed 21 tests on September 25, 2026. Coverage includes exact microseconds across local midnight, 23/25-hour daylight saving days, nonoffset employee daily excess and job-switch allowance, overlapping schedule union, work/break separation, future allowance, refreshed account/session/token/unit access, exact board anchors, immutable saved evidence after schedule changes, retry conflicts and concurrent retry, final expiry rollback, CSV formula protection, styled numeric Excel cells, private HTTP attachments, strict query validation, and session CSRF on capture. These are synthetic fixtures and do not establish live payroll policy.

Browser acceptance passed 70 checks across 13 layouts against production entry SHA-256 `a8310bd62e2bef46c529ac71e363a24e25a01da3f1c3a83666d4d88fa1b68e0d` (build version `9889c0c74be7b1994c467fda7798bbc7cd45453764780200670602177524a86e`). Normal password authentication and a disposable synthetic database covered live timers, offline freezing, community and break filters, employee drilldowns, actual CSV/Excel downloads, saved-review readback, and delayed downloads after navigation or credential revocation. Screens at 1440, 390, and 320 pixels, plus dark/large-text/flat mode at 320 pixels, had no horizontal overflow or clipped card text. Desktop/mobile top views, dialogs, and the narrow chart were also visually inspected. These are emulated-browser checks, not physical-device or live-customer evidence. Private artifacts are under `output/playwright/workforce-overview/`; no customer data was used. Jev source screens `f350a541acfe4ce187adaf693e7ebe35` and `65600d94efef44c3925af375115fe861` reviewed bounded ownership/display/download invariants; their results were advisory, followed by source inspection and deterministic tests. The earlier context rank receipt was `7bd268644c67428291b56087211d0f8c`.
