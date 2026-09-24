# Presentation-day walkthrough

Open [STJW](https://stjw-web-production.up.railway.app). Present this as a working employee timekeeping and reporting demonstration using **synthetic records**. It is not yet a complete school or accounting system.

## Prepare before the meeting

- Confirm the current release in [STATUS](STATUS.md). Installation and update controls must be deployed before demonstrating them; local branch work alone does not update phones.
- Use **Password** sign-in with an authorized developer or administrator account for management access. On a phone, sign-in opens **My time clock** first; use navigation for **Workforce overview** or **Payroll**. Desktop password sessions keep their saved homepage. **Quick PIN** asks for the PIN alone and intentionally opens only the employee clock, even for a developer.
- Use a separate browser profile or device for an authorized synthetic employee with two assigned jobs. Check that the employee is clocked out before starting. Never share customer credentials or use a customer's account as a demo fixture.
- Choose a date range containing synthetic recorded hours for the charts. Keep one completed demonstration export ready in case the meeting connection fails.
- On devices that were already open before the first update-monitor release, finish any pending work and perform one ordinary browser refresh. The older client cannot display an update monitor it has not received yet.

## 1. Show the employee's day

Say: “Staff choose the work they are doing, and the same shift records their jobs and breaks.”

1. Sign in on the phone to open **My time clock** directly. The job selector and time actions come before secondary navigation and artwork. Choose an assigned job under **I'm working as**, then tap **Clock in**. Wait for **On the clock** and the confirmed clock status.
2. Choose the second job under **Change job**. Tap **Switch job** and wait for confirmation. Selection alone does not save; the employee remains clocked in.
3. Tap **Take a break**. Point out **On a break**, then tap **End break** and wait for the working state. A break must end before switching jobs.
4. Tap **Clock out** and wait for the clock-in controls to return. In the management view, open **Time records** to show the separate work and break segments in the completed shift.

A short live demonstration creates a short real recorded duration. Use the existing synthetic history for substantial chart examples; do not describe demonstration minutes as a normal workday.

On other narrow-screen pages, the top-bar **Clock** shortcut returns to the clock through the same unsaved-change and pending-clock protections. A full reload opens the clock again on mobile; merely returning focus does not force a page change. See [mobile clock behavior](MOBILE-CLOCK.md).

## 2. Turn time into a clear picture

Say: “An administrator can see who is working now and explore recorded hours by date, person, job and community.”

- Open **Workforce overview**, choose **This week** or **From / Through**, then demonstrate **Community**, **Employee** and **Group time by**.
- Read **Recorded work**, **People contributing** and **Recorded breaks**. Expand **Exact recorded time** to show the precise duration behind the rounded visual summary.
- Switch **Hours over time** between **Area**, **Line** and **Bar**. Tap or hover a point; keyboard users can focus the chart and use the arrow keys.
- Switch **Work mix** between **By job** and **By community**. Select a legend item, then select an employee bar to narrow the displayed history.
- Show the current-team board's work/break indicators and receipt time. **On the clock now** is a current view across permitted scopes, separate from the selected historical date range. It refreshes periodically rather than promising instant delivery.
- Use **Explore data** for the underlying tables and **Refresh data** to obtain a new report capture.

## 3. Give the accountant usable hours

Say: “These exports give the accountant employee totals, job breakdowns and the recorded evidence behind them.”

1. Open **Payroll → Hours & exports**. Set the intended dates, community and employee filters.
2. Review work, breaks and any ongoing-segment notice. Expand a person under **Employee hours** to inspect jobs and communities. Review open shifts and corrections before handing off payroll hours.
3. Use **Download Excel** and **Download CSV**. The Excel workbook includes Employees, Jobs, Totals, Source segments, Provenance and Source JSON sheets.
4. Explain that local list search/sort does **not** change export scope. Each download reads current permitted records again, so an open shift or intervening correction can change the result from the earlier screen.

For CSV, `row_kind` separates employee summaries, job breakdowns and totals: these are different views of the same hours and must not be summed together. These are **recorded-hours exports**, not payroll approval or wage calculations. Gross/net pay, overtime, paid-break rules, PTO accrual, taxes, deductions and payroll closeout remain unfinished. See [payroll details](PAYROLL-HOURS.md).

## 4. Put STJW on a phone

Open the live site on the phone and select **Install app**. The installed icon uses the actual school crest.

- **Android:** Use the app's native install action when available. Otherwise, open the browser menu and choose **Install app** or **Add to Home screen**, then confirm.
- **iPhone/iPad:** In Safari, open **Share** (possibly inside the Page Menu), choose **Add to Home Screen**, keep **Open as Web App** enabled if offered, then tap **Add**. Open the new icon and sign in normally.
- For a later deployed release, tap the compact **Update available** chip on the narrow clock page, then show **New version ready → Reload to update**. **Later** postpones the reload. **Install app / App & updates → Check for updates** runs a manual check. The optional installation suggestion is hidden on the narrow clock page, while the persistent entry remains available. A GitHub push alone is not a deployed update, and the app never reloads itself automatically.

An installed icon does not enable offline clocking. Browser and device policy control the installation prompt; verify installation on each actual phone. See [installation guidance](INSTALLATION.md).

## Fallback checklist

| What happens | What to do |
| --- | --- |
| Only the clock is visible | Sign out and use **Password** for the permitted management view; PIN sessions are intentionally clock-only. |
| No assigned job | Have an authorized manager configure the demonstration employee's job assignment before continuing. |
| Charts are empty | Check the selected dates, community and employee against the synthetic history. Clear a narrow selection and refresh; do not interpret missing data as zero attendance or wages. |
| Clock result is uncertain | Use **Retry clock request**. It retries the same action. If the action saved but the view failed to refresh, use **Refresh clock status**. Resolve this before reloading or starting another action. |
| Connection fails | Pause clock actions and saves. Use the prepared synthetic export to explain reporting. Nothing is queued for offline submission. |
| Update reload is blocked | Finish or resolve the protected form, save or clock request. A confirmed ongoing shift is stored on the server; an unconfirmed action still needs reconciliation. |
| No native install prompt appears | Use the persistent installation guide and browser menu/share steps. Lack of a prompt does not prove installation is impossible or already complete. |

Close by distinguishing the available standalone calendar/messaging from planned Google integrations. Google synchronization and external email are not connected. The broader SIS, childcare, parish and accounting scope remains tracked in [REMAINING-SCOPE](REMAINING-SCOPE.md).
