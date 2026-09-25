# Review and correct employee time cards

Open **Time records**, or use **Time cards** on an employee in **Employees & jobs**. Payroll and the Overview employee detail also link to the selected employee/date range. Actual deployment and verification are recorded in STATUS and VALIDATION.

## Find the right time

Choose dates, an employee, community or job; search and status filters apply on the server across all matching records. Inactive employees remain available when they have historical time. Worked time and breaks are separate. Range totals cover the selected reporting period; each card describes its whole shift, including an overnight shift that crosses the selected date boundary. Open shifts are identified clearly rather than represented as completed cards.

Lists show 100 cards per page, with totals across every matching page. Choose a range of up to 367 dates; requests that exceed 10,000 source cards or 20,000 source entries ask for a narrower range instead of silently dropping records. Job/community filters narrow the summary; a matching card retains all of its entries for review.

## Correct a completed card

1. Choose **Edit time card** beside the employee's shift. Recorded dates/times are already filled in.
2. Change the clock-in or clock-out date/time. Expand job and break details when those entries also need correction. Times use the organization's displayed timezone.
3. Review the original and resulting hours and enter the reason for the change.
4. An administrator, owner or developer editing another employee saves the correction immediately. The original punches, new revision, editor and reason remain in history. An employee's own correction and a scoped manager's proposal retain the independent approval workflow.

Only available recorded/currently assigned jobs can be used. A date/time correction must not overlap another shift or introduce future completed time. Repeated daylight-saving times require an explicit offset choice; nonexistent local times must be corrected. Unchanged original instants retain their full stored precision. Display rounding never rewrites recorded segments.

## Missing time and clock-outs

The missing-shift entry supports dated work and break entries for an employee. Open-shift review provides the current recorded source and a clock-out time. The same immediate administrator rule applies to another employee, while self-service and scoped-manager proposals remain independently reviewed. Saving a missed clock-out records the supplied time and preserves the original open-ended evidence.

These controls do not estimate missing work or invent punches. Staff supply the actual intended date/time and a reason. Editing logged time is separate from editing the schedule or employee pay rate.

## Conflicts, retries and reports

If someone changes the card before saving, reload its current source and review the draft again. The app will not silently overwrite the newer revision. If a response is lost, keep the captured command and use its retry control; the same command cannot create a second adjustment. Ordinary navigation and application updates remain blocked while a save is unresolved. If access changes, sign in again and inspect the card's history before entering a new correction.

Live recorded-hours reports use the new revision after a correction. Previously saved reports, payroll preparations, posted accounting entries and external payments retain their original evidence; staff must follow their separate replacement/review workflows where applicable. A time correction is not a wage, overtime or tax calculation.

See [ADR0013](adr/0013-direct-administrator-time-cards.md), [employee workflow](WORKFORCE-DAILY-USE.md), and [payroll preparation](PAYROLL-PREPARATION.md).
