# ADR 0004: Make the clock the mobile entry point

Date: 2026-09-24

Status: Accepted. Implementation and deployment evidence are recorded separately in [STATUS](../STATUS.md) and [VALIDATION](../VALIDATION.md).

## Context

The owner identified immediate mobile clock access as the highest priority. Staff need to clock in/out, change jobs and record breaks with minimal navigation and scrolling. The existing visual design should support those actions, while administrators retain access to the wider workspace.

## Decision

- At initial session load, a viewport no wider than 720 CSS pixels or a primary coarse pointer opens the clock. This includes sign-in and full reload. PIN sessions always open the clock; other desktop password sessions honor their saved homepage. Returning focus to an already open app does not force navigation.
- Place status, current/selected job, elapsed time and clock commands before the decorative scene in DOM and reading order. Use a compact narrow/short-landscape layout, retaining color and dimensional styling while hiding the large dial and secondary journey on that layout.
- Keep the native job selector and explicit **Switch job** command. Selection alone is not a write. Preserve the existing clock command identity, transaction, audit, confirmation, session and recovery paths.
- On the narrow or short-landscape layout, move workforce links and the PIN explanation below the clock card. Expose a top-bar **Clock** shortcut on other pages through the existing guarded navigation function. Do not grant permissions or bypass unsaved-change/pending-clock protections.
- Render clock notifications inline below the compact card, preserving their status/alert semantics without covering action buttons.
- Suppress the automatic installation promotion on the compact clock page, retain the persistent installation entry, and initially collapse a new update into a chip that the user can expand. Preserve guarded, explicit reloads.

## Consequences

Phone and some touch-oriented tablet sessions prioritize the clock even when the account has a different saved desktop homepage. The preference is not rewritten, and management remains available to authorized password sessions. The pointer signal describes browser capability rather than an exact device category; a wide touch-oriented device can therefore start on the clock while keeping its wider layout.

Compact clock actions have a minimum 48 CSS pixel height and the job selector a minimum 44 pixels. These are layout choices, not a claim of complete accessibility conformance. Small or enlarged-text screens may still require scrolling; verification must measure the actual content rather than promise every action fits every viewport.

No new data model, migration, backend authorization, payroll rule, offline behavior, job-selection persistence or automatic time transition is required. Large-screen artwork remains secondary to working controls. See [ADR 0001](0001-accessible-visual-language.md) for visual principles and [ADR 0003](0003-installation-and-safe-updates.md) for installation/update boundaries.

## Verification and rollout gates

Verify initial mobile/PIN routing and preserved desktop preferences; the top-bar shortcut with unsaved work; long names and native selector behavior; clock-in, switch-job, break and clock-out states; uncertain-command retries; and compact/expanded update notices. Use normal synthetic authentication and distinguish any controlled browser failure simulation. Run the required application tests and production build, then record the actual release receipts.

Physical phone acceptance remains separate from browser emulation. This decision does not establish completion of the wider organization/SIS/accounting request. The user-facing workflow is documented in [MOBILE-CLOCK](../MOBILE-CLOCK.md).
