# 0014 — Shared attention rules and personal simplicity

Date: 2026-09-27. Status: Accepted; deployment evidence belongs in STATUS and VALIDATION.

## Context

Customer feedback found too many features and controls visible at once. The owner chose shared administrator flag rules, with personal filters and appearance. Existing exact records, schedule protections and payroll/report capabilities must remain accessible.

## Decision

Default to a simple menu with personal favorites and progressive disclosure for advanced planning and report controls. Keep clock access direct. Store menu, schedule-view defaults and payroll presentation in the existing personal preferences object. Save individual fields to avoid overwriting unrelated defaults; explicit links override saved filters. Visibility never grants authority.

Store shared flag rules separately by organization in migration048. Require a current password session and developer/owner/administrator role to write. Version checks, command receipts, immutable before/after history and audit commit together. Managers and finance can read according to existing workforce reporting access. Exact integer-microsecond arithmetic applies minute thresholds to each employee-local-day. Flag policy cannot alter recorded duration, wages, authorization or conflict validation. Saved review sources capture policy; historical sources without policy remain readable with legacy semantics.

Recommend Excel for formatted human review; offer plain CSV for interchange. Preserve numeric types and exact source/audit options. Report layout preferences are personal; they are not accounting policy.

## Consequences and verification

Advanced features remain available, while daily screens expose fewer decisions. Personal defaults may reference retired filters; clear unavailable selections with notice. Shared-policy writes handle concurrent changes and uncertain delivery explicitly. Focused tests cover changed policy, preferences, exact daily thresholds, exports, route contracts and runtime protections. New synthetic browser checks cover the changed flows and responsive layouts. No unrelated completed baseline is rerun under the owner's no-overlap rule.

Jev supplied bounded advisory ranking and invariant screening from reviewed source excerpts; code and human source review verified actions and exact arithmetic. Question/state context follows the official [TypeSafe skill-suggestion pattern](https://docs.typesafe.ai/cookbooks/skill_suggestion). Receipts are recorded in validation; neither model judgments nor small synthetic checks prove production security or physical-device compatibility.
