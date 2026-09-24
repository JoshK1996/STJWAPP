# ADR 0003: Browser installation and explicit safe updates

- **Status:** Accepted
- **Date:** September 24, 2026
- **Decision owner:** STJW development, implementing the owner's phone-installation and update request
- **Implementation status:** Manifest/version-monitor and installation/update UI are implemented in this iteration. Release evidence is recorded separately in [STATUS](../STATUS.md) and [VALIDATION](../VALIDATION.md); this decision alone does not establish physical-device installation acceptance.

## Context

Staff need a recognizable Home Screen entry and an obvious way to refresh after a Railway deployment. The owner wants the convenience already used in Sweetwater. Browsers control installation, and iOS uses a different flow from Chromium's optional native prompt. STJW includes sensitive authenticated information, transactional timekeeping and editable workflows that cannot safely be discarded by an automatic page refresh.

## Decision

Provide a standards-based web app manifest with a stable identity and query-free start URL. Keep installation metadata public and account-independent. Detect an installed display through browser capabilities; use platform detection only to tailor instructions. When `beforeinstallprompt` exists, retain it until a user action and consume it once. Never simulate successful installation or call an unavailable platform API. Offer iPhone/iPad share-menu instructions and browser-menu fallback guidance. Keep the manual installation/update entry available even after promotion dismissal; an installed app uses the label **App & updates**.

Provide a small same-origin, cache-bypassed build-version check independent of service-worker lifecycle. Poll while visible and check at startup, focus/visibility return, reconnection and explicit user request. A source push is not a deployed update. The server document determines availability, and network/parse errors remain distinguishable from an up-to-date result.

Show a bottom update prompt with a user-initiated reload. Allow it to collapse to a discoverable update chip. The application owns the reload gate and refuses reload during unsaved edits, unresolved/in-flight clock commands, saves, and protected dialogs. The update component receives the callback and blocked reason; it cannot discard work, reissue commands, or reload on its own.

Installation is independent from offline capability. Do not register a service worker or cache authenticated pages, API responses, report exports or credentials in this release. Do not add an offline mutation queue. An offline device receives network-required guidance. Notification delivery, background location and Google integrations remain separate decisions.

Persist only a device-local timestamp to defer the optional install suggestion for seven days. Do not persist install-dialog contents, identity, entered values or private data. The manual entry is always available; failure to access local storage falls back to current-visit dismissal.

## Consequences

- Phone installation is easy to discover, but iOS still needs the browser's Share action and confirmation.
- Desktop and mobile browsers can install with their own supported workflows; managed-device policies can prevent installation.
- No new service-worker cache can retain a previous account's sensitive responses.
- Online page loads receive the server's current document; an already-open page receives a reload offer after a successful version check.
- Automatic refresh cannot discard a time-clock recovery state or unfinished form.
- Background update timing is not guaranteed: mobile browsers may suspend pages and network checks can fail.
- Physical-device verification is required before claiming a tested installation experience on a particular device/browser combination.

## Verification gates

Verify supported-event capture and one-shot prompt use; dismissed, accepted and failed prompt states; missing capabilities; iPhone/iPad instructions; standalone display; timestamp-only dismissal and blocked browser storage. Check dialog focus, narrow-screen wrapping, safe-area spacing and a reachable underlying page.

Verify unchanged, changed, invalid and unavailable server versions; return-to-app checks; disposal; offline behavior; no-store headers and version changes after rebuilding. Verify update-button gates against the real app's pending/dirty states, that **Later** never reloads, and that an explicit permitted reload obtains the updated deployment. Verify that no service worker or offline mutation queue is introduced.

## References

- [Google: custom installation flow and single-use browser prompt](https://web.dev/articles/customize-install)
- [Apple: iPhone share-menu installation instructions](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios)
- [WebKit: iOS/iPadOS 16.4 Home Screen improvements](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- [MDN: installation criteria and supported browser/platform behavior](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [ADR 0002: integration and offline-data boundaries](0002-integration-boundaries.md)
