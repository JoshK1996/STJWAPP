# Delivery plan

The first live milestone is employee timekeeping, staff roles and administrative reporting using synthetic records. The school, parish and early-childhood programs share configurable organization structure. Managers require explicit subgroup assignments. PIN sessions provide the clock; passwords open the permitted workspace.

The visual direction is a colorful dimensional dashboard with interactive charts, useful indicators and illustrations. Responsive layouts, keyboard use, contrast and motion/depth preferences remain supported. Color and animation supplement text and shape.

## Sequence

1. Improve mobile readability and workforce interactions, retaining exact data/export semantics and clear failure states.
2. Confirm accountant requirements for periods, rates, breaks, overtime, approvals, rounding and exports. Do not infer policies from another organization.
3. Confirm school rules and test classroom, attendance, admissions, care and dismissal with synthetic fixtures. Receiving care staff confirm their own handoffs; conflicting teacher/student/room schedules are blocked.
4. Extend reporting/import templates and reviewed integrations. Standalone calendar/messaging precede Google services, which need organization configuration and scoped OAuth.
5. Complete remaining academic, financial, parent and operational requirements before moving sensitive live records.

Current implementation slice: personal payroll filter views, exact comparison with the preceding calendar period, and clearer accountant preparation visuals. Preserve the first-screen mobile clock and existing hours exports. See [PAYROLL-PREPARATION](PAYROLL-PREPARATION.md); actual verification and deployment belong in STATUS. Confirmed wage policy, payroll approval/closeout and broader SIS work remain separate requirements.

## Engineering boundaries

Server-verified accounts and organization scope control every action. Code owns authorization, arithmetic, validation, execution and audit writes. AI may advise mappings/classifications; it cannot grant access, approve pay or release a child. Preserve exact history and immutable migrations.

Use focused branches, passing CI, review and ADRs. Deploy an exact reviewed manifest after separate database maintenance; the web runtime never migrates production. See [development](DEVELOPMENT.md), [database operations](DATABASE-OPERATIONS.md), [status](STATUS.md) and [remaining scope](REMAINING-SCOPE.md).


Immediate mobile priority: open directly to clock actions, keep job changes and breaks visible before decoration, and retain safe retries and unobstructed feedback. See [MOBILE-CLOCK](MOBILE-CLOCK.md) and [the employee and accountant walkthrough](PRESENTATION-DAY.md). Record actual deployment and acceptance in STATUS and VALIDATION. Confirm phone installation on the organization's physical devices before a wider rollout. Resume broader work from REMAINING-SCOPE after the presentation; do not infer payroll or school policy from demonstration data.
