# STJW experience and integration roadmap

Research date: September 23, 2026. The owner approved the bold workforce visual direction and requested more visual explanation, useful interactions, mobile reliability, and maintained engineering records. **This is a prioritized roadmap, not a claim that the features below are all live.** [STATUS](STATUS.md), [DEPLOYMENT](DEPLOYMENT.md), and [VALIDATION](VALIDATION.md) contain the actual release evidence. The original organization/SIS scope remains broader than this work; see [REMAINING-SCOPE](REMAINING-SCOPE.md).

## Keep and extend what works

The live workforce release already provides interactive area/line/bar and job/community donut charts, exact data tables, visual clock/record timelines, direct payroll Excel/CSV/JSON downloads, and access to permitted pay-rate records. Personal themes, artwork, depth, reduced motion, and navigation order already have settings. The next experience pass should make those capabilities easier to discover and use, preserving exact time calculations, current authorization, and reviewed changes. [Workforce walkthrough](WORKFORCE-ANALYTICS.md)

Standalone calendars and internal messaging remain the chosen first-party tools. Existing `.ics` downloads are explicit file copies of permitted events; they are not a Google connection or live subscription. Internal messages do not currently deliver email or push notifications. [Calendar export](CALENDAR-EXPORT.md), [API boundaries](API.md)

## Delivery order and concrete acceptance

These are priority groups, not time or cost estimates. A release is complete only when its source, tests, build, browser evidence, and deployment readback agree.

| Priority and status | Change | User benefit | Acceptance boundary |
| --- | --- | --- | --- |
| Implemented; local verification passed; deployment pending | Searchable quick navigator and visible workflow shortcuts | Find Payroll, time records, messages, calendar, and permitted school tools without learning the sidebar | Password/PIN and role visibility preserved; keyboard/touch operation; Escape and focus return; unsaved-change guard still applies; no hidden submit action |
| Implemented; local verification passed; deployment pending | Consistent labeled status indicators, color accents, layered surfaces, and restrained interaction feedback | See what is working, pending, unavailable, or needs attention without reading an entire table | Icons/labels accompany colors; zero/unknown/loading remain distinct; artwork/depth/reduced-motion preferences honored; data geometry unchanged |
| Implemented; local verification passed; deployment pending | Mobile layout and long-content audit | Complete workflows on small screens without clipped controls, vertical letter stacks, or page overflow | Record checked pages, widths/themes, actual interactions and remaining issues; do not claim every phone is verified from one screenshot |
| Next candidate; not implemented here | Personal saved report filters and a clear reset | Reopen a useful employee/community/date grouping without repetitive setup | Persist filter definitions, not private result rows; reauthorize every fetch; explain moving dates such as “This week”; handle deleted/inaccessible units |
| Next candidate; not implemented here | Payroll preparation checklist and comparison view | Surface ongoing segments, missing configuration, and period-to-period differences in one place | Show evidence and scope; never label hours “approved payroll” without a real approval/closeout model; previous periods must use identical filters and comparable duration |
| Next candidate; not implemented here | Scoped needs-attention inbox | Bring pending requests, time corrections, and incomplete office work into the relevant person's workspace | Counts come from the authorized source and distinguish unread, pending, missing and overdue; any overdue definition needs an actual due date/policy |
| Next candidate; not implemented here | Helpful empty states and first-use walkthroughs | Explain the next permitted action and why a chart/list is empty | Separate no data from no permission and a failed fetch; never insert example people or totals into a real result; walkthrough is dismissible and keyboard usable |
| Separate scoped pilot | Installable web-app entry point | Open STJW directly from a device's app launcher | Manifest/icons/start route, session behavior, install/update/logout and physical-device checks; no offline writes or private cache implied |
| Organization configuration needed | Google Calendar, Classroom and Drive pilots | Reduce repeated calendar/roster/document handling | Read-only/selected-resource pilot, school-owned configuration, exact identities, explicit scopes, audit, visible sync state and disconnect behavior |

Further payroll work still needs confirmed overtime, break, leave, pay-period, and compensation rules. Colors, retained rates, and time totals do not establish gross/net wages. School-specific grading and attendance policies cannot be inferred from FACTS product features.

## Visual and mobile design evidence

The accepted direction is recorded in [ADR 0001](adr/0001-accessible-visual-language.md). The following are primary-source constraints applied to STJW, not a claim of completed WCAG conformance.

| Official guidance | STJW application |
| --- | --- |
| [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) addresses content at a width equivalent to 320 CSS pixels, with an exception for content that requires two-dimensional layout. | Forms, navigation, headings and summaries must fit; exact tables/charts can use their own usable scroll region. Include a 400% zoom-equivalent check, not just a wide desktop screenshot. |
| [W3C Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) specifies 24 by 24 CSS pixels or its applicable exceptions, including spacing. | Aim for 44 by 44 primary touch controls as our stronger design preference; measure compact targets/spacing rather than calling every icon accessible. |
| [W3C Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) requires an additional visual means of conveying meaning. | A clock state uses label plus icon and color; chart legends and selected values remain legible without distinguishing hue alone. |
| [W3C Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) sets 4.5:1 for ordinary text and 3:1 for qualifying large text; [Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) covers necessary component/state and graphic information. | Check real foreground/background pairs, including gradients and dark mode. Decorative glow is not the focus indicator. |
| [W3C Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) is an AAA criterion allowing nonessential interaction motion to be disabled. | Adopt that additional safeguard while targeting AA overall: honor system/app reduced motion and retain instant text feedback. Keep decorative movement separate from chart values. |

Use CSS/SVG depth for reusable decorations and illustrations where it keeps labels sharp and bundles small. This is an implementation preference, not a benchmark claim. Exact charts should remain proportionally honest; three-dimensional frames, cards and decorative objects provide depth without making a smaller value look larger. Introduce genuinely new graphics or heavier rendering dependencies only for an identified explanatory benefit, with measured load/interaction evidence.

## Google integration options

All entries remain proposed. [ADR 0002](adr/0002-integration-boundaries.md) keeps provider access behind the app's existing service and authorization boundaries. The school must identify its actual Workspace administrator, resource owners, tenant/account setup and approved use before a connection is enabled. No passwords or API keys are requested in chat.

**Calendar:** Keep the existing file export useful now. A later pilot can display one expressly selected Google calendar read-only. Calendar has separate event/read scopes; choose the narrowest scope for the defined operation instead of requesting calendar administration. [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

Incremental synchronization requires an initial full read, stored sync token, all pages, and handling deleted entries. Invalidated tokens return `410` and require a fresh full sync. STJW should replace only its external mirror, retaining its own records and audit history; define field ownership before write-back. “Connected,” “syncing,” “last synced,” and “needs reconnect” should describe different states. [Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

**Classroom:** Begin with explicit course and roster mapping. `classroom.courses.readonly` and `classroom.rosters.readonly` are distinct from coursework/grade scopes; profile email access is also separate. Request only the fields the pilot actually requires. A matching name/email is a review candidate, not permission to merge a student or grant guardian access. No grade write-back until ownership and conflict rules are defined. [Classroom authorization](https://developers.google.com/workspace/classroom/guides/auth)

**Drive:** Investigate a selected-file workflow using Google Picker and `drive.file`. Google describes that scope as per-file/non-sensitive, while broad Drive read/manage scopes are restricted. Restricted scopes bring additional verification requirements and server-side handling can require a security assessment. Choose the actual document operation and retention model before scope approval; a file selection is not a blanket grant to everybody in STJW. [Drive scopes and selected-file access](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

**Gmail and other external delivery:** Keep separate from internal messaging. Recipient ownership, school sending identity, family/contact exclusions, delivery failures, retention, and approved sending behavior need a dedicated design. This research pass does not select Gmail scopes or enable external sends. No provider quota, verification exemption, or customer-domain configuration is assumed.

## Installation and notifications

An installable entry point is a reasonable separate candidate after responsive acceptance. Chrome's documented install-promotion criteria include HTTPS, a web-app manifest with names/icons/start URL/display, and engagement conditions. Installation behavior differs among browsers; the manifest alone is not evidence that the app works offline or supports every mobile feature. [Chrome team installability guidance](https://web.dev/articles/install-criteria)

WebKit introduced Web Push for Home Screen web apps on iOS/iPadOS 16.4, with permission requested from a direct user interaction. That establishes a possible implementation path, not current STJW support or a delivery guarantee on the customer's devices. Push needs opt-in, revocation, device/account association, and notification-content rules; default to a generic prompt to open the authenticated app instead of putting child/pay information on a lock screen. [WebKit Home Screen Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

Do not cache private API data or queue critical writes merely to offer an install button. An offline employee punch, student attendance entry, or child release needs a separate time/conflict/reconciliation model. Native/background location and a Pikmykid replacement remain distinct projects; installation or push does not establish those capabilities.

## Engineering records and follow-through

The [ADR index](adr/README.md) records accepted decisions separately from delivery status. Feature documents describe behavior and limitations; release records bind verified source and deployment evidence. New work should use a focused branch/PR, meaningful tests for changed behavior, a passing build, reproducible synthetic mobile checks, and explicit migration/rollback notes when applicable. Keep the original prototype history and the current application distinguishable in the repository. Do not call a commit pushed or a PR merged before GitHub readback verifies it.

Primary source selection used Jev metadata-rank receipt `ba367cf78c854a54a5aa1190c1826103`; the chosen sources and necessary exact follow-up documentation were read directly. That advisory ranking is not accessibility, security, or product verification. No organization records, credentials, or provider tokens were sent for this research.
