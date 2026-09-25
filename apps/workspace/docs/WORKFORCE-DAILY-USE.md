# Everyday workforce use

The default workspace focuses on Overview, My time clock, Time records, Payroll, Employees & jobs, Schedule and Requests. Calendar, messaging, reporting/imports and school tools remain under **More tools**. Settings is always available. Mobile opens directly to the clock; a PIN session is clock-only and does not ask for a username.

## Add employees and prepare sign-in

In **Employees & jobs → Add employee**, enter the employee's work email (their sign-in username), name, access role, communities and jobs. All active jobs within your permitted scope remain visible, including jobs from communities that are not selected yet. Selecting such a job adds its named community explicitly; remove its jobs before removing a community.

Developers, owners and administrators can choose **Set password and PIN**, supply an 8–128 character password and a 6–8 digit PIN with confirmation, and independently select **Require password change at first sign-in** and **Require PIN change at first sign-in**. Both are on by default. Keep both on, require either one, or turn both off to use the assigned credentials immediately. A PIN kept for ongoing use must be unique; a shared change-required PIN cannot identify an account, so use the exact work email and Password tab. First sign-in asks only for the selected replacements before opening the permitted workspace. **Private setup link** remains an alternative that lets the employee choose their own password.

Next to an eligible employee, **Edit employee** changes their details, role, communities, jobs and active status. **Reset sign-in** offers the same independent password/PIN replacement choices and revokes old access while preserving enrolled MFA. Retries of the same reset cannot overwrite credentials the employee has since chosen. Role hierarchy and current permissions apply on the server.

**Manage jobs** is a separate action on each eligible employee card. Administrators can change their own assignments and another administrator's assignments without changing account privileges. Owners and developers can maintain assignments within their hierarchy; managers need explicit access to every community on an ordinary employee. Select the jobs and their communities, then save. Existing archived jobs may be retained but cannot be newly assigned. Adding a job while clocked in is supported; the current clock job and community cannot be removed. Assignment-only changes preserve sign-in sessions.

Full **Edit employee** saves require the employee to be clocked out and retain the existing account/role hierarchy. Both editors detect a changed saved record; reload after reviewing a conflict instead of overwriting another administrator's update.

**Pay rates** opens that employee's job-specific rates with effective dates, preview, confirmation and retained history. Only developers, owners, administrators and finance staff can use pay-rate management. Editing a rate does not automatically infer overtime or statutory pay.

## Schedule and clock

Create shifts in **Schedule**, or use **Import scheduled shifts**. For an employee who must wait for a scheduled start, open **Employees & jobs → Clock rules → No early clock-in**. It is off by default. An early tap on the assigned job saves a pending start; the screen shows its time and **Start work then**. The server starts it at the scheduled timestamp even if the browser closes. Changes or revoked access can block a saved start; the screen explains why. Employees can cancel a pending start. No location is collected.

See [Scheduled clock starts](SCHEDULED-CLOCK.md) for exact boundaries, recovery, cancellation and worker behavior. Recorded time corrections still use **Time records**; clock duration alone is not a wage calculation.

## Overview and payroll

**Overview** opens with people currently clocked in, their job/community and a server-anchored running time indicator. Offline or unavailable data is labeled; the indicator must not suggest new records have been fetched. Today and This week compare worked hours with **scheduled shift hours**, the owner-selected allowance.

**Hours over schedule** adds each employee/local-day excess across all jobs. A shorter day does not erase an earlier overage. **Outside schedule hours** measures work outside that employee/job's scheduled intervals. Breaks are shown separately. Future scheduled hours remain in the selected allowance; a below-schedule total can therefore include work that is not due yet. These indicators are separate from overtime and payroll rules.

Use **Today Excel**, **This week Excel** or CSV for simple accountant review. Excel includes Employee summary, Jobs and communities and Daily review sheets with readable names, two-decimal hours, filters, colors and print settings. Calculations retain exact microseconds until presentation. The full Payroll screen retains configurable hours exports and accountant-reviewed payroll workflows.

**Show detailed reports** exposes additional charts, filters, exact evidence and saved reviews. **Save review snapshot** retains the current time/schedule source and results without approving payroll. Later corrections or schedule changes do not rewrite that capture. The latest 100 accessible reviews can be reopened/exported. Captured reviews remain subject to current organization and explicit community access.

## Bulk entry

Employees & jobs exposes **Import employees** and **Import jobs**; Schedule exposes **Import scheduled shifts**. Blank CSV/Excel templates, readable preview, source-conflict checks and atomic apply are required before new records are created. Imports never silently replace existing jobs or shifts. See [Workforce imports](WORKFORCE-IMPORTS.md) for columns, limits, offset-based times and the wider existing import catalog.

## Live-data transition

The owner confirmed that only three existing accounts were real and all other operational records were demonstrations. A reviewed, guarded maintenance transaction removed demonstration accounts, school/time/financial records and retained those accounts plus four basic STJW communities/jobs. Password/PIN hashes and retained MFA were preserved internally; no credential contents were exported. The runtime cannot read the private on-host rollback archive. Public-facing demonstration mode is disabled. Synthetic fixtures remain isolated in development/testing.

The live reset is not a restore drill or certification of complete payroll, SIS, accounting, policy or physical-device workflows. Current release evidence and remaining boundaries are in [STATUS](STATUS.md) and [REMAINING-SCOPE](REMAINING-SCOPE.md).
