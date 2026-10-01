# Personal hours with PIN sign-in

Sign in with **Quick PIN**, then choose **My hours & clock records** below the clock or **My hours** in the menu. The clock still opens first. **Back to clock** returns directly to clock actions.

Choose **Day**, **Week**, **Month**, **Year**, **Custom** or **All time**. Calendar periods use the organization's timezone; weeks begin Monday. Previous/next controls and the date field let you review earlier periods. Custom dates include both selected days and may span up to 366 days.

Work hours and breaks appear separately. The chart and job/community breakdown summarize the entire selected period, even when the record list spans several pages. Expand a clock record to see its work, breaks and job changes. Revised cards show the currently effective times. Time outside a selected period is excluded from its totals; a crossing shift can still show its full clock-in and clock-out times.

Open shifts are counted only through the displayed refresh time. Refresh to update them. These are recorded durations, not calculated wages or a determination of whether a break is paid. No records, pay rates or corrections can be changed here.

PIN sessions remain five minutes long. When a session expires, sign in again. Each PIN session shows only that employee's own time, including when the employee has an administrator, owner or developer role. Use password sign-in for permitted management, corrections and payroll tools.

Large histories have explicit limits of 10,000 cards, 20,000 segments and 50,000 calendar-day entries per query; select a shorter period if that limit is reached. The app does not silently omit older totals. No customer records are migrated or changed by this feature.

API: `GET /api/clock/history`; see [API](API.md) and [ADR0015](adr/0015-pin-personal-time-history.md). Actual release verification is recorded in STATUS and VALIDATION.
