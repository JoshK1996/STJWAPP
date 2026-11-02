# 0017: Full corrections for open employee time cards

Date: November 2, 2026
Status: Accepted. Extends ADR0013 to open cards; release state is recorded separately.

## Context

The owner reported that authorized users could edit only clock-out. Completed cards already had a full editor, but open cards were routed exclusively to a separate closure form. Staff need to correct either dated punch, including an incorrect start while an employee is still working.

## Decision

Use the full TimeCardEditor for both open and completed cards. Offer a direct Edit clock-in & clock-out entry on Open shifts and retain the optional clock-out-only shortcut. An originally open card explicitly chooses Keep this shift open or an entered end. Both dates, times, jobs and work/break entries remain editable. Completed cards cannot be reopened. Administrator/owner/developer direct edits remain limited to other employees; self and scoped-manager proposals retain independent review.

Extend correction segments to allow only a final null end on an originally open card. Validate current jobs, whole-card scope, no future boundaries, continuity and overlaps under the established account-before-domain locks. Include a source hash of the exact current shift and segment events because normal clock actions do not advance the correction revision. Recheck that hash at submission and approval, including if a clock-out completed the source while a form was open. Preserve old completed-card request/retry fingerprints when the optional hash is omitted.

Append a new selected revision and immutable before/proposed evidence with the audit in one transaction. Migration 051 scopes the open-segment unique index to a shift revision, allowing historical null-ended rows to remain untouched while a corrected revision continues running. Each revision still has at most one open entry. The existing one-open-shift constraint is unchanged, and all live open-segment readers have been checked against source for current-revision selection.

## Consequences

Clock-in changes no longer require an invented clock-out. Both dated ends can be corrected together after a forgotten punch. A concurrent break, job switch or clock-out invalidates the draft even at an unchanged revision. Original raw rows and saved report evidence remain intact. Reload preserves the entered reason but requires reviewing current source times. The editor labels running entries as excluded from its finished-entry totals.

The additive index migration requires the separate maintenance path. The web role remains restricted and never migrates. Roll forward with schema-051-compatible source; older strict schema expectations must not be deployed after maintenance. Existing open clients should finish pending work and accept the update or reload.

## Verification and rollout

Focused service/session/helper tests cover both dated boundaries, keeping a shift open, later ordinary clock actions, exact retries, same-revision clock conflicts, independent manager review, scope/PIN/revoked proof, overlap/future/null-tail validation, audit rollback, competing saves, the per-revision index and DST choices. Normal synthetic browser acceptance covers actual saves, open-shifts entry, stale reload, mobile/appearance layouts and independent review. Production build, publication checks and configured CI precede exact-source maintenance/deployment and public/runtime readback. No customer account is used for testing.
