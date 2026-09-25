# 0008: Management editing and preserved evidence

Date: September 24, 2026

Status: Accepted. Implementation and rollout evidence are recorded separately in STATUS and VALIDATION.

## Context

Several screens allowed creation without an obvious way to correct their definitions. Jobs were the clearest example. Similar gaps affected academic setup, accounting contacts/drafts and calendar discovery. Unrestricted overwrites would lose payroll, financial, attendance or custody evidence.

## Decision

Give mutable definitions nearby, prefilled editors with explicit archive/restore controls where applicable. Revalidate the current password session, account, role and explicit unit scope at the service boundary. Version checks reject stale writes while retaining drafts. Reasons and before/after history commit with the change. Concurrency locks coordinate edits with new uses of the definition; academic mutations preserve the academic-mutex-first order.

Keep operational evidence immutable or versioned. Financial drafts may change only before events exist; issued/posted records retain linked correction/reversal flows. Job communities become fixed after references exist. Room availability controls future assignments without erasing existing meetings. Captured attendance, released grades, original financial source versions and custody evidence remain retained.

Make editing part of the review checklist for every management page. Calculated charts and exported snapshots direct people to source corrections. Document missing amendment workflows instead of presenting a disabled or absent control as completed functionality.

## Consequences

New migrations 038 and 039 add management revision fields and constrained accounting-draft/contact mutability. Runtime grant/trigger checks still prohibit deleting accounting evidence. Deployed migrations are never edited.

Budget and payroll replacement preparation remains separate from voiding/reversing the original. Historical childcare amendments, reconciled-bank corrections and certain cross-year/community/time-zone migrations remain gaps. See the complete [editing inventory](../EDITABILITY.md).

## Verification and rollout

Authorization, stale revisions, concurrent definition use, date boundaries, exact source round trips and rollback are exercised with synthetic data. Browser checks use ordinary authentication and inspect desktop/narrow layouts. Run the full suite and production build, then stage an exact manifest, dry-run and commit database maintenance separately, deploy that same source and verify hosted public assets/routes. Local synthetic tests do not claim customer-account or physical-device acceptance.
