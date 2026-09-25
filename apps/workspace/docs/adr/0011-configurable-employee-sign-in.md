# 0011: Independent employee sign-in requirements

Date: September 25, 2026. Status: Accepted; release verification is recorded in STATUS and VALIDATION.

## Context

Employee provisioning previously offered a private setup link or a password and PIN that both had to change. Administrators need to choose a rollout per employee, including keeping assigned credentials or requiring only one replacement.

## Decision

Keep the work email as the sign-in username and PIN-only sign-in as a restricted clock session. Developers, owners and administrators can supply a password and PIN during employee creation or authorized sign-in reset. Two independent boolean choices control password replacement and PIN replacement. Both default to true to preserve existing callers; all four combinations are supported. Private setup remains a separate alternative.

Migration044 adds separate persisted requirements and backfills existing pending accounts with both enabled. A database constraint keeps the existing summary guard equal to their logical OR. This preserves all current workspace access guards without changing stored credentials. New permanent PINs must meet the existing organization-wide uniqueness rule.

First sign-in issues a short-lived challenge when either replacement is pending. The server decides which fields must be provided, validates the current requirements under account locks, and preserves any credential not selected for replacement. The challenge cannot open the workspace; completed accounts sign in again normally. Enabled MFA remains required.

Reset commands bind the selected policy to the actor, target and exact retry intent. Existing both-required command receipts and challenges retain their established fingerprints. No retry may overwrite later employee choices. Account, assignment and credential changes remain transactional with audit metadata that excludes credential values.

## Consequences and verification

Existing accounts do not receive new passwords or PINs on deployment. Older clients that assume both replacements must refresh; incompatible requests fail validation instead of replacing an unrequested credential. Authentication still requires eight-character-or-longer passwords and six-to-eight-digit PINs.

Verify all four provisioning/reset policies, preservation of the unselected credential, unique permanent PINs, required-field enforcement, concurrent completion and safe replay, current authority, setup-link boundaries and legacy pending-account migration. Exercise normal synthetic password/PIN sign-in and mobile forms; never use customer credentials for regression fixtures.
