# ADR0009: Workforce activation and durable scheduled starts

Status: accepted for the current implementation; release verification is recorded separately.

## Scheduled-start decision

The owner requested a per-employee **No early clock-in** setting: an early tap prepares an automatic start at the assigned shift's start, including when the browser is closed. The owner declined location collection. Keep the setting off until an authorized manager enables it. Use an active assigned job's upcoming shift on the current organization-local date; allow immediate clock-in during a matching current interval. Show a pending state and **Start work then**, not a claim that early time has been recorded.

Store the authorization in a durable database intent instead of a browser timer. Preserve the original exact scheduled start, end, schedule/policy/credential revisions and job/community identities. The server worker revalidates current authority, then creates the actual shift, work segment, receipt and audits in the same transaction as the terminal intent outcome. Retain scheduled time and processing time separately. Do not infer a clock-out or create a shift after its entire scheduled interval has elapsed.

Serialize submission, cancellation, worker execution and person/schedule changes on the employee account before schedule/job/intent locks. A pending intent is cancellable by its employee using either a current PIN or password session. Completed evidence is immutable. Browser/session expiry is not revocation of an authorization already submitted; credential, account, policy, assignment and schedule changes are checked before execution. Bounded retries isolate individual failures so one employee's failed transaction does not stop the rest of the selected batch.

This preserves mobile first-screen actions and existing time-correction review while avoiding queued browser writes. The tradeoff is eventual server execution: restarts can delay processing, and an elapsed scheduled interval is blocked for human review. PGlite regressions verify local transactions and boundaries; multi-connection PostgreSQL contention and physical-device acceptance require separate evidence. Full behavior, API and recovery details are in [Scheduled clock starts](../SCHEDULED-CLOCK.md).

## Runtime evidence protections

The maintenance permission plan and application startup checks include exact trigger/function identities, trigger operation masks and required/forbidden privileges for account authority, scheduled intent/events/receipts, credential-reset command receipts, workforce allowance snapshots and workforce-import evidence. Immutable tables lose UPDATE/DELETE; one-way transition tables retain UPDATE and lose DELETE. Clock-policy rows retain SELECT/INSERT/UPDATE and lose DELETE to prevent removal/recreation with a reused revision. This extends the existing restricted database identity without granting schema or migration access to the web service.

## Simple navigation and accountant review

The customer prioritized workforce operations over the broader organization feature inventory. Keep the clock, current team, schedules, people/jobs and payroll prominent. Place less frequent school/accounting/report tools behind an explicit More tools control; permissions still govern every operation. Dimensional surfaces, colors, job/community labels and running indicators supplement concise text and precise source values. Clock actions remain first on mobile.

The owner selected scheduled shift hours as the allowance. Aggregate exact integer microseconds using the organization-local day, then accrue positive differences per employee/day across all jobs so job changes within the daily allowance do not produce flags and later short days do not cancel prior flags. Same-job overlapping legacy schedules form a union. Work outside matching intervals and breaks remain separate quantities. Future schedules contribute allowance without implying absence, earned pay or overtime. Styled Excel/CSV are presentation of the same aggregate.

An optional immutable review captures query, source segment revisions, exact schedule versions and resulting totals together with an audit. Saving is not payroll approval. All reads/exports use fresh session or explicitly scoped read-token authorization, repeatable-read source and final proof checks. Retained reviews require current access to every captured community. Current views may change after corrections; existing captures do not. Export bytes are checked against the current UI identity before download. Read-token access does not permit capture or other writes.

## Account lifecycle and bulk entry

First-time creation offers confirmed temporary password and PIN or private setup. A shared temporary PIN cannot choose an account, so first-use guidance leads to email/password followed by mandatory private replacement. Permanent PIN uniqueness remains enforced. Privileged account recovery has an idempotent, actor/target/request-bound receipt; retrying after employee replacement preserves the employee's newer credentials. Reset revokes prior sessions/tokens and retains enabled MFA. Current role hierarchy is always checked.

Employee, job and schedule imports use blank templates, bounded CSV/XLSX parsing, resolved readable preview, current-source fingerprints and a transactional apply with durable receipt. Jobs and schedules are created, not overwritten. The ordinary service layer owns validation, overlap rules, permissions, locks and audit. No model can authorize or perform these actions.

## Live transition and evidence

The owner explicitly confirmed that only three accounts were real and every other operational record was a demonstration. A separate maintenance transaction verified schema/catalog and reviewed source fingerprints under exclusive locks, created an on-host recovery archive denied to the runtime, removed demonstrations and restored only the approved accounts and basic structure. It compared retained credentials/roles internally and checked empty operational tables before commit. Dry run preceded the identical committed plan. This operational reset is not an application API or production startup seed. Production demonstration mode defaults off; local synthetic fixtures remain for isolated testing.

Jev supplied bounded, advisory source rankings and invariant screens; code and direct source/browser/database checks own verification. The ranking pattern follows the [official TypeSafe skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion). No model pin or decision threshold changed. Advisory clear results are not authorization or production proof. Small PGlite tests, local Chromium workflows, anonymous hosted checks and actual production readback remain separately labeled in STATUS/VALIDATION.
