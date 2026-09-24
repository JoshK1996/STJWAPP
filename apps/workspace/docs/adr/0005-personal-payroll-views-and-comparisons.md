# 0005 — Personal payroll views and period comparisons

Date: 2026-09-24. Status: Accepted; implementation and deployment evidence belongs in STATUS and VALIDATION.

## Context

Accountants and administrators need repeatable filters and a quick explanation of changes in recorded hours. A shared saved query must not become a way to retain access after an account or organizational assignment changes. The organization has not supplied its wage, overtime, paid-break or payroll-approval rules.

## Decision

Store personal named filter definitions in a dedicated table, separate from general appearance preferences. Each definition belongs to the current organization and account, has a revision, retains deletion evidence, and uses a client-generated creation ID for safe retries. Account-first transactions validate current authority, apply the change, write the audit and recheck session expiry together. A stale revision is a conflict, not permission to overwrite another device's change.

Resolve relative dates using the database clock and organization timezone when a view opens. Explicit employee or unit selections that become unavailable must produce a visible unavailable result. Never substitute an unfiltered report. Saved definitions retain no payroll result rows or authority grants.

Compare the selected local calendar dates with the immediately preceding equal number of dates. Both sides use one capture time and repeatable-read source transaction, exact microsecond arithmetic, the same filters and current reporting authority. Calendar-day counts are not fixed elapsed-hour durations across daylight-saving changes. In-progress and future periods are labeled; no projection or annualization is implied. A zero prior baseline has no percentage change.

The comparison is preparation evidence, not payroll certification. Work and break hours remain separate. Wage calculations, approval, closeout and payment processing require their own confirmed policy and implementation. Existing accountant Excel/CSV/JSON hours exports keep their established source and precision contracts.

## Consequences

Views work across a person's signed-in devices but are not shared organization templates. Manager access remains explicit, without child-unit inheritance. Read-only agents can inspect permitted views and reports using an existing reports:read token; only current password sessions can mutate views. PIN sessions remain clock-only.

The additive migration requires separate maintenance and restricted-runtime verification before deploying the exact staged source. Old application versions require their declared schema; do not roll back the database or deploy an older schema declaration casually. A correction uses a reviewed forward release that retains migration history.

## Verification gates

Verify stale and concurrent mutations, retry behavior, audit rollback, current account/session/unit authority, cross-account isolation, unavailable filters, relative dates, DST boundaries, exact signed deltas and zero baselines. Check both standard and narrow-screen workflows with synthetic authentication. Record local, hosted, simulated and physical-device acceptance separately.
