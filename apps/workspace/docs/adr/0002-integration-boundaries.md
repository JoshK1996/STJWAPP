# ADR 0002: Integration boundaries and staged connectivity

- **Status:** Accepted
- **Date:** September 23, 2026
- **Decision owner:** STJW development, preserving Josh's standalone-first instruction
- **Implementation status:** The standalone calendar, explicit calendar-file export, internal messaging, and existing scoped report interfaces are implemented. Google OAuth/sync, browser push, installation support, and delegated agent writes remain separate work; this ADR enables none of them.

## Context

The organization wants one coherent workspace and eventual Google Calendar/Classroom/Drive/Gmail and AI-client connections. Josh explicitly chose standalone calendar and messaging first. Employee, school, care, finance, and family records have different access boundaries. An external integration must not become a route around subgroup scope, private calendars, reviewed changes, or the existing audit trail.

## Decision

Every connector calls the same domain services used by the application. Server-verified identity, organization, exact subgroup grants, source visibility, revision checks, audit, and idempotency remain authoritative. A connector never writes directly to domain tables or uses the web service's database identity as a user. AI suggestions cannot authorize access, approve pay, match a person conclusively from a name/email, or release a child.

Keep standalone workflows useful without a Google account. Existing explicit `.ics` downloads remain file copies, not subscriptions or synchronization. Internal messages remain in-app delivery, not email or push. The UI must show a provider as disconnected until configuration, authorization, and an actual connection/readback succeed.

Introduce external connections separately by provider, purpose, and account. Use a school-owned OAuth project, exact approved redirect origins, the narrowest justified scopes, and a reviewed account-to-organization binding. Keep provider tokens on the server with restricted access, revocation, disconnect, and audit support. Do not treat domain spelling, a provider login, or domain-wide delegation as implicit application authority. Domain-wide delegation is not the default.

For a first Google synchronization pilot, choose one explicitly selected resource and a read-only direction. Store external identity/provenance and define the authoritative system for each synchronized field. Present ambiguous identity matches and conflicts for review. Persist bounded checkpoints, retry transient failures safely, and make disconnected/expired/partial/stale states visible. A “connected” badge alone does not mean the most recent synchronization succeeded.

Advance to external writes only with an explicit change preview, the intended destination/account, revision/conflict handling, an idempotent command, and a recorded result. Subscription callbacks are untrusted notification inputs: authenticate/validate them, then reconcile through the provider API and the app's own permissions. No callback directly grants school or payroll access.

Evaluate installation separately from offline capability. A future installed web app may offer a stable entry point, but authenticated API responses, report files, school data, tokens, and sign-in pages must not be added to an offline cache by this decision. Do not queue time punches, attendance, payroll decisions, or child release for later submission without a separate conflict/time/security design. Offline means visibly unavailable for those writes.

## Consequences

- Calendar, messaging, and workforce use remain independent of Google's availability and onboarding.
- Read-only pilots deliver value before write-back complexity, but do not imply two-way synchronization.
- Provider approvals, school account ownership, privacy/retention decisions, and actual OAuth scope verification remain deployment prerequisites.
- Installation and push need browser/device acceptance. They do not establish native background geofencing or delivery guarantees.
- Existing read-only agent interfaces remain bounded; a future ChatGPT/Claude connector needs its own identity, delegation, consent, and revocation design.

## Rollout and verification gates

Before connecting a provider, record the purpose, resource owner, exact scopes, data fields, authoritative direction, retention/deletion behavior, revoked-access behavior, and accountable organization owner. Use a synthetic/test resource first. Verify foreign-organization and unassigned-subgroup denial, revoked/expired token handling, retries, pagination, API quota errors, stale checkpoints, duplicate callbacks, deletions, and conflict reconciliation. Include daylight-saving/all-day/recurring-event cases for calendars and explicit student/course matching for Classroom.

Before shipping installation support, inventory routes and cache behavior; verify no private response is retained by a new service worker, logout/account changes do not expose previous private state, upgrades recover cleanly, and an offline screen cannot report a write as saved. Use physical-device checks for promised iOS/Android capabilities. Require a separate ADR before any offline mutation queue or background location behavior.

This record grants no authorization to email recipients or connect an organization's external account. Integration execution still follows the user's authorized task and the confirmed provider setup. No secret belongs in chat, logs, source control, or a model prompt.

## References

The researched provider constraints and prioritized implementation options are in [EXPERIENCE-ROADMAP](../EXPERIENCE-ROADMAP.md). Existing boundaries are documented in [API](../API.md), [CALENDAR-EXPORT](../CALENDAR-EXPORT.md), and [PLAN](../PLAN.md).
