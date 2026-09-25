# Architecture decision records

ADRs preserve a decision, the reasons for it, and its consequences. **Accepted** means the architecture direction is adopted; it does not mean every feature is implemented or deployed. [STATUS](../STATUS.md), [DEPLOYMENT](../DEPLOYMENT.md), and [VALIDATION](../VALIDATION.md) remain the implementation and release evidence.

| Record | Decision | Status |
| --- | --- | --- |
| [0001](0001-accessible-visual-language.md) | Use an accessible, dimensional visual language with truthful data and responsive layouts | Accepted |
| [0002](0002-integration-boundaries.md) | Keep integrations behind the same authorization and service boundaries as the app | Accepted |
| [0003](0003-installation-and-safe-updates.md) | Installable online app with explicit guarded updates | Accepted; implemented; see release evidence and device limitations in STATUS |
| [0004](0004-mobile-clock-first.md) | Open the clock first on mobile and place time actions before secondary content | Accepted; see implementation and release evidence in STATUS |
| [0005](0005-personal-payroll-views-and-comparisons.md) | Save personal payroll filters and compare exact recorded hours without inferring wage policy | Accepted; see implementation and release evidence in STATUS |

For a new decision, add the next numbered file with date, status, context, decision, consequences, and verification or rollout gates. Change an accepted decision through a superseding ADR rather than silently rewriting its rationale. Correct factual errors openly; implementation updates belong in the feature documents and release record.

- [0006: Readable report presentations](0006-readable-report-presentations.md)

- [0007: Accounting ledger and reviewed workflows](0007-accounting-ledger-and-reviewed-workflows.md)

- [0008: Management editing and preserved evidence](0008-management-editing-and-preserved-evidence.md)

- [0009: Workforce activation and durable scheduled starts](0009-workforce-activation.md)

- [0010: Employee job assignments and account authority](0010-employee-job-assignment-management.md)

- [0011: Independent employee sign-in requirements](0011-configurable-employee-sign-in.md)
