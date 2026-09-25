# Delivery plan

The active milestone is simple live employee timekeeping, staff roles and accountant-ready administrative reporting. The owner approved removing demonstration operational records while retaining three real accounts; synthetic data is now for isolated tests only. The school, parish and early-childhood programs share configurable organization structure. Managers require explicit subgroup assignments. PIN sessions provide the clock; passwords open the permitted workspace.

The visual direction is a colorful dimensional dashboard with interactive charts, useful indicators and illustrations. Responsive layouts, keyboard use, contrast and motion/depth preferences remain supported. Color and animation supplement text and shape.

## Current customer priority

Focus the first screen on who is clocked in, their organization/job, elapsed time, worked versus scheduled hours and accrued over-schedule flags. Keep payroll and Employees & jobs direct; place broader tools behind More tools. Make account creation/recovery, pay-rate editing and employee/job/schedule bulk entry discoverable. Per-employee No early clock-in saves a durable start for the scheduled timestamp. Do not collect location. See WORKFORCE-DAILY-USE and ADR0009; STATUS distinguishes implemented, tested and deployed work.

## Sequence

Administrator time-card review and editing is implemented and undergoing release verification. The owner selected immediate saving with audit history for another employee's time. Preserve self/scoped-manager independent review, original punches, exact retries and current source/session checks. Add whole-range search/totals, work/break separation and direct employee/Payroll/Overview entry. See TIME-CARDS and ADR0013; actual implementation and rollout must be recorded in STATUS/VALIDATION.

1. Improve mobile readability and workforce interactions, retaining exact data/export semantics and clear failure states.
2. Confirm accountant requirements for periods, rates, breaks, overtime, approvals, rounding and exports. Do not infer policies from another organization.
3. Confirm school rules and test classroom, attendance, admissions, care and dismissal with synthetic fixtures. Receiving care staff confirm their own handoffs; conflicting teacher/student/room schedules are blocked.
4. Extend reporting/import templates and reviewed integrations. Standalone calendar/messaging precede Google services, which need organization configuration and scoped OAuth.
5. Complete remaining academic, financial, parent and operational requirements before moving sensitive live records.

Current implementation: the accounting ledger and reviewed manual workflows, including configurable starter settings, journals, financial statements, bills/invoices/credits/recorded payments, bank CSV reconciliation, budgets and payroll preparation with approval, accounting posting and recorded external net payment. See [ACCOUNTING](ACCOUNTING.md), ADR0007 and [FINANCE-ROADMAP](FINANCE-ROADMAP.md). Keep the readable report studio and exact exports available; provider automation and organization policy configuration remain separate. Preserve the first-screen mobile clock and existing hours exports. See [PAYROLL-PREPARATION](PAYROLL-PREPARATION.md) for the hours-report workflow; actual verification and deployment belong in STATUS. Confirmed wage/leave/overtime rules, statutory deductions, provider submission and tax filing remain separate requirements, alongside broader SIS work.

## Engineering boundaries

Management editing is part of every feature's lifecycle: nearby prefilled edit controls, archive/restore or a reviewed correction path, conflict recovery, current authorization and retained history. The cross-page inventory and remaining amendment gaps are in [EDITABILITY](EDITABILITY.md) and ADR0008. Preserve these requirements when adding new pages.

Server-verified accounts and organization scope control every action. Code owns authorization, arithmetic, validation, execution and audit writes. AI may advise mappings/classifications; it cannot grant access, approve pay or release a child. Preserve exact history and immutable migrations.

Use focused branches, passing CI, review and ADRs. Deploy an exact reviewed manifest after separate database maintenance; the web runtime never migrates production. See [development](DEVELOPMENT.md), [database operations](DATABASE-OPERATIONS.md), [status](STATUS.md) and [remaining scope](REMAINING-SCOPE.md).


Immediate mobile priority: open directly to clock actions, keep job changes and breaks visible before decoration, and retain safe retries and unobstructed feedback. See [MOBILE-CLOCK](MOBILE-CLOCK.md) and [the employee and accountant walkthrough](PRESENTATION-DAY.md). Record actual deployment and acceptance in STATUS and VALIDATION. Confirm phone installation on the organization's physical devices before a wider rollout. Resume broader work from REMAINING-SCOPE after the presentation; do not infer payroll or school policy from demonstration data.

Delivered scheduling milestone: recurring job staffing coverage, independent calendar-period job hours targets, visual range/filter controls, direct employee/job planning entry and reviewed spreadsheet/document schedule imports. Saved-shift allowance/preclock semantics, individual editing, scope/session validation and exact evidence remain preserved. See STAFF-PLANNING and ADR0012; STATUS/VALIDATION record the release gates. Resume the broader priorities above without treating planning targets as payroll policy or implementing unconfirmed school rules.
