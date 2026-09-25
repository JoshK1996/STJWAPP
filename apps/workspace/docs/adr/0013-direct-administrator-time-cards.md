# 0013: Direct administrator time-card corrections

Date: September 25, 2026

Status: Accepted; implementation and release evidence belong in STATUS and VALIDATION.

## Context

The customer needs administrators to find all employees' logged time and correct dates, punches, jobs and breaks without a proposal followed by a second person's approval. The owner explicitly selected immediate saving with an audit history for administrator corrections to another employee. Existing time-record search only covered the currently loaded page, and its summary used elapsed shift duration rather than distinguishing work from breaks.

## Decision

Provide direct administrator/owner/developer correction endpoints for another employee's completed card, missing shift and missed clock-out. Preserve the established employee/self/scoped-manager proposal and independent-review endpoints. Direct application must be labeled as an administrative adjustment; it must not imply that another person approved it.

Keep original punches and precise instants. A correction publishes a new selected revision and records before/after evidence, reason, current editor and exact command identity in the same database transaction. Recheck server-derived session authority, all affected communities, current source revision/hash, jobs and overlaps before committing. Exact retries return the original outcome; changed input cannot reuse a command. No model grants correction authority or writes a punch.

Move search, employee/status/job/community filters and whole-range work/break summaries to the service. Preserve whole-card access boundaries for multi-community shifts and label clipped period totals separately from a full card's duration. Keep historical inactive employees discoverable. Place prefilled edit controls beside each card and provide direct entry from employees, Payroll and Overview.

The interface retains dirty drafts on validation failures and preserves uncertain write commands for exact retry. Sidebar navigation and application updates must not discard unresolved saves. Keep compact phone layouts and visible date/time/job information ahead of decorative elements.

## Consequences

An authorized administrator can correct another employee's time without a second approver; the audit trail documents who acted. Their own time retains independent review. Existing pending requests stay pending and may become stale after a direct correction. Saved reports and posted financial evidence are not retroactively rewritten. These changes do not infer paid breaks, wages, statutory overtime or organization payroll policy.

## Verification and rollout

Require authorization/self/PIN/session-revocation tests; source conflicts and concurrent time changes; exact microsecond preservation; overnight/date/DST cases; overlap and missing/open-card invariants; audit rollback and immutable evidence; and lost-response retry. Verify normal synthetic administrator workflows and narrow-screen layout in a browser, followed by the full application suite, build and publication checks. Any additive migration is applied by separate reviewed maintenance, never the runtime web role. Preserve customer credentials and all operational data.

Jev supplies advisory evidence selection and invariant screening using the existing [compact selection pattern](https://docs.typesafe.ai/cookbooks/skill_suggestion). Its findings require source and executable verification; no provider threshold or application authority is delegated to it.
