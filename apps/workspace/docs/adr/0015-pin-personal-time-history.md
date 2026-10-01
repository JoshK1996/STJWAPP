# ADR0015: PIN access to personal clock history

Accepted October 1, 2026, following the owner's request to review personal hours after PIN-only sign-in.

The previous clock-only boundary prevented employees from checking their own records without changing sign-in methods. Extend PIN access with one read-only endpoint, `GET /clock/history`, and a dedicated **My hours** view. Keep the clock as the entry screen and retain the five-minute PIN lifetime.

The server derives employee and organization from the verified session. Strict query input rejects employee/organization overrides. Password sessions can also read this endpoint, but it remains self-only regardless of role. Existing administrative time-card, payroll, directory, correction and settings routes retain their password requirement; bearer tokens gain no scope.

Reuse account-first clock-session proof checks, consistent read transactions and final current-session validation. Read current effective shift revisions. Aggregate integer microseconds before display rounding, split by local calendar day, clip selected-period totals and retain work/break distinctions. Return explicit pagination and whole-range totals. Bound oversized data and report an error rather than silently truncating results.

The UI publishes results only for the latest selected request, clears old totals during replacement loads, and removes private state on sign-out or denied sessions. Responsive charts supplement readable labels and numbers. Corrections remain in the existing password workspace.

No database migration, new role, API-token grant, AI access decision or payroll-policy assumption is needed. Synthetic changed-code/service, HTTP and browser checks own this delivery; previous release baselines are not repeated. Jev ranks task-relevant source excerpts and screens narrow invariants as advice; code and source review determine correctness. Context selection follows the official [TypeSafe skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion), without adopting its experimental thresholds for application access.
