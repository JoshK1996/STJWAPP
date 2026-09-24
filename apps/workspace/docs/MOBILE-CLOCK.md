# Mobile clock first

Mobile staff should reach the clock without navigating through reports or decorative content. On initial session load, including sign-in and a full reload, STJW opens **My time clock** when the viewport is at most 720 CSS pixels wide or the browser reports a primary coarse pointer. Password sessions retain their permitted management pages. PIN sessions remain clock-only on every screen size. Desktop password sessions keep their saved homepage, or the overview when none is saved.

Successful sign-in also resets the page to the top so the login screen's scroll position cannot carry into the clock.

This is an initial destination rule, not a redirect whenever the app regains focus. It does not change a person's saved desktop homepage or promise to remember their last selected job.

## Clock actions

The clock presents the recorded status, current/selected job, elapsed shift and available actions first. On narrow screens, the large decorative dial and shift journey are hidden; compact color, depth, status and timer styling remain. The elapsed shift includes recorded breaks.

1. Check the assigned job in **I'm working as**, then tap **Clock in**. Wait for **On the clock**.
2. While working, use the native **Change job** selector. A different selection reveals **Switch job**. Tap it to record the change; selecting a job alone does not save or end a shift.
3. Use **Take a break** and **End break**. The status shows **On a break**; end the break before changing jobs.
4. Use **Clock out** and wait for **Clocked out**.

On the compact layout, the job selector has a minimum 44 CSS pixel height, and primary clock/recovery buttons have a minimum 48 CSS pixel height. Buttons wrap text instead of relying on fixed one-line labels. Clock confirmations and errors appear below the card on this layout, so a success message does not cover the next action.

The same compact clock layout also applies to short landscape viewports up to 1024 pixels wide and 500 pixels high; this does not change the separate initial-destination rule above.

On the narrow or short-landscape layout, secondary workforce navigation and the PIN-session explanation appear below the clock card. Other pages expose a **Clock** shortcut in the top bar. It uses the existing navigation path: an unresolved clock request blocks leaving, and unsaved changes still require a discard decision. Role permissions are unchanged.

## Installation, updates and recovery

The compact clock page suppresses the optional automatic installation suggestion. The persistent **Install app / App & updates** entry remains available. A newly available update starts as an **Update available** chip; tap it to expand **New version ready** and **Reload to update**. This keeps clock controls prominent without removing installation or update access.

Clock requests keep their existing confirmation and recovery behavior. **Retry clock request** resends the same unresolved command. **Refresh clock status** refreshes an action already confirmed as saved. Resolve pending work before reloading. No automatic clock action, automatic reload, offline queue or new credential flow is introduced. See [installation](INSTALLATION.md).

## Verification boundary

[STATUS](STATUS.md) identifies what is actually deployed; [VALIDATION](VALIDATION.md) holds the release's test and browser receipts. This document describes behavior, not a claim that every physical phone has passed. Browser emulation does not establish physical iPhone/Android acceptance. Check normal and enlarged text, long job/account names, portrait/landscape, native job selection, working/break/clocked-out states, update expansion and uncertain-request recovery on the organization's actual devices before broad rollout.

See [ADR 0004](adr/0004-mobile-clock-first.md) and the [presentation walkthrough](PRESENTATION-DAY.md).
