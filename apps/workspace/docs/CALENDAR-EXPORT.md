# Standalone calendar file export

Implemented locally September 23, 2026; combined deployment and hosted verification are recorded by the release operator in DEPLOYMENT.md and VALIDATION.md. This document does not claim deployment before that verification.

Calendar now has **Download events**. The dialog starts with the currently visible calendar-grid dates and audience. Users can select another inclusive local date range and explicitly download an `.ics` file. Errors stay in the dialog, and the current calendar month/day selection is preserved. Dates use the workspace timezone; each local day boundary is converted independently to UTC, including daylight-saving transitions.

This exports standalone personal, unit and community events. Academic timetable occurrences are excluded and the download button is disabled in the Classes-only view, with an explanation. Previously expanded daily/weekly recurrences export as separate events. There is no automatic Google access, subscription URL, external send, invitation, reminder, calendar import or synchronization. A downloaded copy includes event titles, descriptions and locations; later changes/cancellations do not update that copy. Re-import behavior depends on the destination calendar application and has not been validated here.

## API and authorization

`GET /api/calendar/export?from=<UTC ISO instant>&to=<UTC ISO instant>&audience=all|personal|unit|organization` returns `text/calendar; charset=utf-8`, attachment filename `stjw-calendar.ics`, and `Cache-Control: private, no-store`. The browser supplies a filename with its selected local dates. `from` is inclusive and `to` exclusive. An overlapping event keeps its original full start/end; the download does not clip the event to the requested range. Cancelled events are omitted.

The strict query permits a positive range no longer than 367 × 24 hours, consistent with the existing event-list API. It fetches at most 2,001 candidate rows and rejects a result over 2,000 instead of silently truncating. An empty result returns HTTP 400 with an explicit message rather than an empty calendar container. Unknown fields, classes audience and invalid/reversed dates are rejected.

The existing password-session middleware applies; PIN and bearer agent tokens cannot export. The service additionally requires the verified session hash. One transaction locks and reloads the active user, checks/locks the current password session, reads current unit memberships under shared locks, and applies the existing calendar visibility rules: own personal events only, organizational events, and unit events for currently assigned users or current owner/admin. Another user's private events remain private even from an owner. A parent unit gives no descendant membership.

Staff mutations serialize through the account lock before changing roles, assignments and sessions. The export consequently rechecks current access after a queued change rather than trusting request-time `actor.role` or `actor.unit_ids`. Session expiry/revocation is checked again after rendering. A simultaneous later edit/cancellation does not retroactively change a snapshot already selected for export. The download is not a continuing authorization grant, and an already downloaded file cannot be recalled.

The transaction appends `calendar.exported` before returning the file. General audit contains only range, audience, format, event count, byte count and SHA-256; titles, descriptions, locations and event bodies are omitted. Audit failure prevents the response and rolls back the audit. No database migration is required.

## File format and precision

The implementation uses CRLF and folds physical lines at at most 75 UTF-8 octets, keeping multibyte characters intact. TEXT backslashes, semicolons, commas and line breaks are escaped; property names are fixed. Unsupported ASCII controls become replacement characters in the file. Event UUIDs create stable `urn:uuid:` UIDs. Timed starts/ends use UTC; DTSTAMP and LAST-MODIFIED use the recorded revision time. SEQUENCE follows the stored event version. No METHOD, recipients, alarm, attachment or recurrence rule is generated. These choices follow [RFC 5545 content lines](https://www.rfc-editor.org/rfc/rfc5545#section-3.1), [TEXT escaping](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.11), [UTC date-time](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.5) and [DTSTAMP semantics](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.7.2).

**Precision limit:** the file format uses whole seconds. Fractions are omitted from timestamps; stored events remain unchanged. If an event's start and end collapse to the same whole second, the entire export is rejected with an explicit error instead of emitting an invalid zero-duration event. Tests cover that boundary. The application otherwise accepts subsecond timestamps through its existing event API, so this is an export limitation. `CLASS:PRIVATE` is emitted for all events as a confidentiality hint, not an access-control guarantee in another application.

## Verification

Seven focused tests pass in `tests/calendar-export.test.ts`, covering Unicode octet folding and injection resistance; stable occurrence UIDs and revisions; both daylight-saving transitions; own-personal/unit/organization/foreign-tenant isolation; cancelled and range-boundary events; anonymous/PIN/API/expired/revoked sessions; permission/session changes between middleware and the export transaction; empty/invalid/2,001-row rejection and exact 2,000-row success; and failed-audit rollback. These local tests use synthetic PGlite fixtures. The injected post-authentication access changes verify reload behavior; they do not substitute for real PostgreSQL lock-contention checks.

TypeScript checking and an isolated Vite production build passed. Root subsequently reported the combined 196-test suite and production build passed. No live access, owner password reset or external calendar action was performed by this feature agent.

Nine synthetic browser/file checks passed through a separate in-memory preview on port 3133: visible-range defaults, inline empty-range error, selected single-day download, correct filename, UTC event times, Unicode/escaped details, CRLF/line bounds, disabled Classes export and a readable 390×844 mobile dialog. The actual downloaded file was 438 bytes and its SHA-256 was `1e1fce22a2c8f199d28301b5d71c44a255c13e2a320e9e947577668d4f81872b`. Evidence: `output/playwright/calendar-export-review.json`, `output/playwright/calendar-export-mobile.png`. Expected unauthenticated/empty-range HTTP failures were observed; no calendar client import compatibility claim is made.

Local Laya advisory audit receipt `d411cd0f60df4674b5191f508ba8f8d0` weakly selected supported from a compact, source-hashed summary. Its confidence is uncalibrated. Direct source review, tests and file readback provide verification; no model finding granted authorization. No Jev fallback, application provider migration or secret data was used.


## Combined hosted verification

Live deployment 01e0ad29-92b9-4e98-8d9c-8851db79a37d, schema 020. All 196 combined tests/build and 9 isolated browser/file checks passed. Hosted PostgreSQL: 15 checks plus 3 cleanup at 2026-09-23T11:33:35.032Z verified personal/unit/community boundaries, owner exclusion from other personal calendars, cancelled-event omission, injected-newline escaping, 75-byte physical lines, expanded DST recurrence, stable bytes/UIDs, audience selection, PIN/anonymous denial, metadata-only audit, queued access/session revocation and fresh membership readback. Temporary events were cancelled, accounts/sessions removed and SSH registration revoked. Evidence: output/review/live-calendar-export.log.
