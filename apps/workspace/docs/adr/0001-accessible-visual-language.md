# ADR 0001: Accessible dimensional visual language

- **Status:** Accepted
- **Date:** September 23, 2026
- **Decision owner:** STJW development, following Josh's approved visual direction
- **Implementation status:** Partial. The workforce visual release is live; this decision governs subsequent components. It is not an accessibility certification or a claim that every screen is redesigned.

## Context

Josh approved the colorful workforce redesign and requested more color, indicators, illustrations, diagrams, depth, motion, and helpful interactions. He also explicitly requires mobile layouts without clipped labels, unnatural vertical text, or unstable controls. Existing user preferences already include artwork, depth, and reduced motion. Exact workforce records and their authorization are authoritative; a visual treatment must not alter their meaning.

## Decision

Use shared semantic colors and layered surfaces, with decorative illustration and modest dimensional motion around the data. Keep chart geometry faithful to values: do not tilt a pie, extrude bars to suggest additional quantity, or use perspective that changes the perceived comparison. Depth belongs in frames, decorative objects, and interaction feedback. Every chart retains an accessible exact-value/table path.

Status uses a short text label and a distinguishable icon or shape alongside color. Do not equate the same green dot with unrelated meanings such as “on the clock,” “approved,” and “saved.” The text identifies the actual state. “No records,” “loading,” “access unavailable,” “zero,” and “not configured” are distinct. Pending/uncertain writes never display completed success, and sampled reports show their captured time and scope.

Nonessential movement respects both the app's reduced-motion preference and the operating system's preference. Artwork and depth controls continue to work independently. Decorative motion must not delay a control, block reading, conceal focus, or be necessary to discover an action. Essential state feedback remains available as text when movement is disabled. New idle decorations remain static; brief transitions respond to deliberate interaction. No automatic parallax, flashing effects, sound, or continuously moving background is introduced by this decision.

Use responsive grids with shrinkable children, wrapping labels, and full-width controls where needed. Preserve words as words; avoid letter-by-letter wrapping of short labels. Long email addresses/identifiers may wrap at available break points, with complete content available without hover. Tables and genuinely two-dimensional charts may scroll inside their own labeled region; the entire page must not scroll horizontally to reach routine controls. Touch and keyboard access must expose the same actions and information as hover.

Quick actions are navigation, not a separate authorization layer. Render only currently permitted destinations and use the existing app navigation/unsaved-change guard. A shortcut never submits a time transition, pays someone, sends a message, or bypasses a reviewed command.

## Consequences

- Visual polish is reusable through existing theme variables and a small shared vocabulary, instead of assigning unrelated colors to each page.
- Some decoration is intentionally hidden or simplified on narrow screens and when artwork, depth, or motion is disabled.
- More colors and animation require light/dark/high-contrast and reduced-motion verification; screenshots alone cannot establish keyboard behavior or numerical accuracy.
- A textual equivalent and exact data view add layout space but preserve interpretation on touch devices and assistive technology.
- We use WCAG 2.2 AA as the accessibility target and additionally adopt the ability to disable interaction-triggered motion. This is a target, not a conformance claim.

## Acceptance and verification

For each changed workflow, use synthetic data and normal app authentication. Check at least 320, 375/390, 768, and 1440 CSS-pixel widths, plus a short landscape viewport. Check 200% text resizing and the equivalent of a 320 CSS-pixel viewport at 400% zoom. Verify long names, emails, translated-length labels, empty states, large values, and denied/loading/error states.

No content or operation may become unreachable. New primary touch controls target 44 by 44 CSS pixels where practical; compact controls must meet the applicable WCAG 2.2 minimum target-size/spacing rule. Verify visible keyboard focus, sensible focus order, Escape/return-focus behavior for overlays, and that overlays fit the viewport with internal scrolling. Pointer-only tooltips need an equivalent focus/touch/data-table route.

Check text contrast and component/graphic contrast across the supported themes. Color must not carry the sole meaning. Compare chart totals and selections to exact source values; chart animation must not fabricate or smooth data. Measure overflow and inspect screenshots, but also operate the screen with keyboard and touch emulation. Test existing uncertain-write retries and unsaved-change protection after adding shortcuts or responsive rearrangement.

Release notes must identify the screens, viewport/theme matrix, actual checks, and remaining gaps. A passing desktop build is not mobile acceptance; browser emulation is not a physical iOS/Android device claim.

## References

Official guidance and its application are recorded in [EXPERIENCE-ROADMAP](../EXPERIENCE-ROADMAP.md). Current workforce behavior is documented in [WORKFORCE-ANALYTICS](../WORKFORCE-ANALYTICS.md).
