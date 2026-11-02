# Review and correct employee time cards

Open **Time records**, or use **Time cards** on an employee in **Employees & jobs**. Authorized users can also edit directly on **Overview**: choose **Edit clock-in & clock-out** on a clocked-in employee, **Time cards & corrections** below an employee’s hours, or **Edit time cards** to search across employees. The full editor opens in place; saving refreshes Overview. The employee hours detail also opens the in-place card list. Finance readers keep their read-only link to Time records. Payroll links to the selected employee/date range. Actual deployment and verification are recorded in STATUS and VALIDATION.

## Find the right time

Choose dates, an employee, community or job; search and status filters apply on the server across all matching records. Inactive employees remain available when they have historical time. Worked time and breaks are separate. Range totals cover the selected reporting period; each card describes its whole shift, including an overnight shift that crosses the selected date boundary. Open shifts are identified clearly rather than represented as completed cards.

Lists show 100 cards per page, with totals across every matching page. Choose a range of up to 367 dates; requests that exceed 10,000 source cards or 20,000 source entries ask for a narrower range instead of silently dropping records. Job/community filters narrow the summary; a matching card retains all of its entries for review.

## Correct an open or completed card

1. Choose **Edit time card** beside the employee’s shift. On **Open shifts**, choose **Edit clock-in & clock-out**. Recorded dates/times are already filled in. Users whose changes require independent review see **Request correction**.
2. Change the **Clock-in date and time** and, when ending the card, **Clock-out date and time**. For a shift still running, **Keep this shift open** lets you correct its start without clocking the employee out; clear it to supply an actual missed clock-out. Expand job and break details when those entries also need correction. Times use the organization’s displayed timezone.
3. Review the original and resulting hours and enter the reason for the change.
4. An administrator, owner or developer editing another employee saves the correction immediately. The original punches, new revision, editor and reason remain in history. An employee's own correction and a scoped manager's proposal retain the independent approval workflow.

Only available recorded/currently assigned jobs can be used. A date/time correction must not overlap another shift or introduce future completed time. Repeated daylight-saving times require an explicit offset choice; nonexistent local times must be corrected. Unchanged original instants retain their full stored precision. Display rounding never rewrites recorded segments.

## Missing time and clock-outs

The missing-shift entry supports dated work and break entries for an employee. The full open-card editor supports changing both dated punches together or just the start while the employee remains on the clock. The optional **Correct clock-out** shortcut remains available for a clock-out-only change. The same immediate administrator rule applies to another employee, while self-service and scoped-manager proposals remain independently reviewed. Saving a missed clock-out records the supplied time and preserves the original open-ended evidence.

These controls do not estimate missing work or invent punches. Staff supply the actual intended date/time and a reason. Editing logged time is separate from editing the schedule or employee pay rate.

## Conflicts, retries and reports

If someone changes the card before saving, reload its current source and review the draft again. Normal clock-ins, breaks, job changes and clock-outs can change the source without advancing its correction revision, so open-card writes and approvals also check a captured source hash. Reloading keeps the entered reason while replacing times with the latest recorded source. The app will not silently overwrite the newer revision. If a response is lost, keep the captured command and use its retry control; the same command cannot create a second adjustment. Ordinary navigation and application updates remain blocked while a save is unresolved. If access changes, sign in again and inspect the card's history before entering a new correction.

Live recorded-hours reports use the new revision after a correction. Previously saved reports, payroll preparations, posted accounting entries and external payments retain their original evidence; staff must follow their separate replacement/review workflows where applicable. A time correction is not a wage, overtime or tax calculation.

See [ADR0013](adr/0013-direct-administrator-time-cards.md), [employee workflow](WORKFORCE-DAILY-USE.md), and [payroll preparation](PAYROLL-PREPARATION.md).


## Open-card retention and API

Only the last entry of an originally open card may retain an empty end. Completed cards cannot be reopened here. Starts and completed ends cannot be future times, and edited cards must remain ordered, contiguous and non-overlapping. Open-entry totals in the editor explicitly exclude the entry still running; recorded-hours reports observe the selected live revision normally.

The detail response supplies `sourceHash`. Direct saves and proposals accept that hash with `sourceRevision`; it is required for an open source. Only its final `segments[].endedAt` may be `null`. Pending proposals capture the full source and hash for a second check during independent approval. Existing completed-card clients that omit the hash retain their prior revision-checked behavior and exact retry identities.

Migration 051 changes the open-segment unique index to `(shift_id, revision)`. It preserves every existing row, including original null-ended segments; each revision still has at most one open entry, and the existing one-open-shift-per-employee constraint remains. All live readers select the shift’s current revision. No previous migration is changed. See ADR0017 and STATUS for deployment state.
