# 0010: Employee job assignments and account authority

Date: September 25, 2026. Status: Accepted; release verification is recorded in STATUS and VALIDATION.

## Context

The account editor intentionally prevents self changes and administrator-to-administrator account administration. Putting job assignments behind that same editor made administrators unable to assign their own jobs or those of another administrator. The directory also hid assignments behind an editor and a horizontal table. A full account form could overwrite a newer saved assignment because it lacked an expected revision.

## Decision

Use **Employees & jobs** as the workspace name. Put visible job/community assignments and **Manage jobs** beside each eligible employee. Keep a grouped employee creation/editing form and the existing credential, rate and clock-rule controls.

Assignment-only reads and writes have a separate service boundary. Developer, owner and administrator accounts can maintain their own assignments. Administrators can maintain peer administrator and lower-role assignments, but cannot change owner/developer assignments. Managers can maintain other ordinary employees only when every existing and requested community is explicitly in their scope. The operation cannot change identity, active state, access role or credentials. Existing account administration and credential-recovery restrictions remain separate.

Require an actual current password session and organization-scoped records. Lock existing accounts in stable order before jobs and communities; validate active or retained archived jobs and current clock assignments. Safe additions are allowed during an open shift; removing its current job/community is rejected. History and recorded time are preserved. Assignment-only writes keep sessions, while every subsequent request still loads current authority.

Use deterministic canonical revisions over the stored source. Assignment writes require the observed assignment revision; an identical already-applied state returns unchanged without a duplicate audit. Full employee edits require a revision covering identity, account fields and assignments. Conflicts preserve the draft and require reload. The full account editor keeps its established clock-out and session-revocation rules.

## Consequences and verification

Assignment editing itself needs no schema change. Independent onboarding choices are covered separately by ADR0011 and migration044. Existing API clients that edit employees must obtain the current directory revision and send expectedRevision. Older full forms fail closed and must reload the updated app.

Verify self/peer administrator assignment changes, scoped manager denials, cross-organization and higher-role denials, current-session rechecks, open-shift guards, archived jobs, repeat saves, stale full-form conflicts and transactional audit rollback. Use synthetic accounts for creation, clock and mobile acceptance; never use customer credentials as a general test shortcut.

Jev supplies advisory evidence ranking and narrow invariant hypotheses; ordinary code owns revision hashing, authorization, locking, execution and verification. The existing compact evidence pattern follows the [TypeSafe skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion). No model decides access.
