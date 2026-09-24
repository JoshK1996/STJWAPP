# Workforce analytics and payroll-hours walkthrough

**Live:** deployment `bd954683-157f-42aa-8977-730b1cab1b32`, schema033, September 23, 2026. Open [STJW](https://stjw-web-production.up.railway.app). The new workforce overview, clock, time records and direct payroll exports are deployed.

Use **Password** sign-in for the permitted management/reporting workspace. **Quick PIN** intentionally opens the employee clock only. The workforce navigation connects **Workforce overview**, **My time clock**, **Time records** and **Payroll**.

## Explore the overview

1. Choose **Today**, **This week**, **This month** or **This year**, or set **From / Through**. Dates use the organization's timezone. **Community** and **Employee** narrow the source; **Group time by** supports hour, day, week, month and year. Hourly ranges permit at most 32 inclusive dates; other groups permit 367.
2. Read **Recorded work**, **People contributing** and **Recorded breaks** for that selection. **On the clock now** is the latest permitted team-board count, separate from the selected historical period. Expand **Exact recorded time** or **Exact break time** for the full duration.
3. Switch **Hours over time** between **Area**, **Line** and **Bar**. Hover or touch a point to inspect it. With keyboard focus on the chart, use the arrow keys or Home/End. Work and breaks remain separate in the detail.
4. Change **Work mix** between **By job** and **By community**. Select a legend item for its exact duration. **Explore these records** opens a job's loaded rows; **Explore this community** changes the report filter. Selecting an employee bar similarly narrows the source.
5. Open **Explore data** or **View all exact totals** for keyboard-accessible **Time periods**, **Employees** and **Time records** tables. **Refresh data** samples the permitted source again; the observation time is displayed below the data.

Large totals use readable hours/minutes. The approximation symbol marks omitted seconds, and decimal-hour displays are labeled rounded. Exact durations retain recorded fractional seconds. Chart coordinates are approximate; individual segments are not rounded before aggregation.

## Clock, review and prepare hours

In **My time clock**, select an assigned job and **Clock in**. Use **Switch job**, **Take a break**, **End break** and **Clock out**, waiting for each result. An uncertain request offers **Retry clock request**; a confirmed action whose refresh failed offers **Refresh clock status**. Neither requires a replacement clock command.

Open **Time records** to inspect the shift and its separate job/break segments. Corrections, missing-shift proposals and reviewed open-shift closure use their existing review workflows; the dashboard itself changes no time records.

In **Payroll → Hours & exports**, choose **This week**, **Last week**, **Last 14 days**, **This month**, or explicit dates/community/employee. Review work hours, break hours, employees, recorded shifts and the ongoing-segment notice. Expand an employee under **Employee hours** for the job/community breakdown. The local search and sort affect the displayed list, **not** the export scope.

Report-authorized users can open payroll hours within their permitted scope. **Pay records / Manage pay rates** remain restricted to the developer, owner, administrator and finance roles.

## Accountant downloads

- **Download Excel** directly creates an hours workbook with employee summaries, job breakdowns, original segments and source evidence. Numeric hour companions support spreadsheet calculations; exact integer microseconds remain authoritative. Display/companion rounding is not a payroll rule.
- **Download CSV** includes six-decimal hour representations and exact microseconds. **Source JSON** provides the full structured source evidence. CSV uses `row_kind` to distinguish employee summaries, job breakdowns and the organization total; do not add these different row kinds together.
- Each direct download samples currently permitted records again. It can differ from the earlier displayed capture, particularly while shifts remain open. It is not an immutable saved-report receipt.
- Existing **Report library** saved copies remain a separate reviewed-evidence workflow and retain their original format and precision. A new direct payroll workbook does not rewrite older saved files.

This workspace does **not** calculate gross/net pay, overtime, paid-break treatment, PTO accrual, taxes or deductions. Retained pay rates and recorded hours do not themselves establish payable wages or payroll approval.

## Verification boundary

