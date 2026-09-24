# Install STJW and receive app updates

STJW can be opened from a phone Home Screen or a supported desktop app launcher. Installation is a browser feature; it does not change account permissions, require an app-store account, or enable offline timekeeping.

## Install on a device

Open the live STJW site in the device's browser. Use **Install app** at sign-in or in the workspace. The installation guide remains available after dismissing the optional suggestion.

- **Android:** When the browser supplies a native installation prompt, the app's install button opens it. Otherwise, open the browser menu and choose **Install app** or **Add to Home screen**, then follow the browser's confirmation steps. Available options vary by browser and device management.
- **iPhone or iPad:** Open **Share** in the browser; in Safari this can be inside the Page Menu. Choose **Add to Home Screen**, keep **Open as Web App** enabled if offered, then tap **Add**. If the action is missing in Safari, use **Edit Actions** in the share menu. Safari is the fallback when another browser does not offer the action. iOS does not expose the Chromium native install prompt to this app.
- **Desktop:** Supported Chrome/Edge browsers offer an install control or browser-menu action. Supported Safari on Mac offers **File â†’ Add to Dock**. Other browsers can offer a shortcut instead.

Apple documents the [iPhone share-menu steps](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios). WebKit documents [third-party browser share-menu support from iOS/iPadOS 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/). Google documents the [native install event, single-use prompt and installed-display detection](https://web.dev/articles/customize-install).

An installed window hides redundant installation suggestions; its persistent entry becomes **App & updates**. A regular browser tab cannot reliably determine whether an icon already exists elsewhere on every platform. The app therefore does not claim that absence of a native prompt means installation is impossible or already complete.

**Not now** hides the optional installation suggestion on that browser for seven days. Only a timestamp is stored, with no account identity or private records. The manual entry stays available. If browser storage is disabled, dismissal still applies to the current visit.

## Updates

The client compares its build fingerprint with a small same-origin version document at startup, on returning to the app or reconnecting, and periodically while visible. Checks are best effort and need a network connection; mobile operating systems can suspend background pages. A deployment is detected after the new version becomes available from the server, rather than merely when source is pushed to GitHub.

An available release produces a bottom **New version ready** prompt with **Reload to update**. On the compact clock page it initially appears as an **Update available** chip; tap the chip to expand the prompt. The optional automatic install suggestion is suppressed on that clock layout, while the persistent installation entry remains available. **Later** collapses it into an **Update available** button. The app never reloads automatically. The application blocks reload while there are unfinished changes, a clock command needing reconciliation, an active save, or another protected workflow. Finish or resolve that work first. A recorded ongoing shift remains on the server across a normal reload; an unconfirmed command must be resolved first.

**App & updates / Install app â†’ Check for updates** provides an explicit check. An unsuccessful check shows an error rather than claiming the app is current. An offline device cannot update. Build fingerprints are technical metadata and are not shown in the normal installation flow.

For this first update-monitor release, finish pending work and refresh older open tabs once. An older client cannot discover updates until it receives the monitor. Later compatible deployed releases can then show the update prompt.

## Network and privacy boundaries

This release does not register a service worker, add an offline response cache, or queue offline writes. Sign-in, time punches, reports and all other saves require the server. The manifest has a stable, query-free start URL; setup links, private report links and account tokens are not installation metadata. An installed icon is a convenient entry point, not a background notification or geolocation service.

## Verification and support

Automated checks cover the runtime's version comparison/error behavior and browser-emulated install/update flows. Runtime and browser acceptance counts belong in [VALIDATION](VALIDATION.md) for the actual release. Simulated `beforeinstallprompt`, emulated device user agents and standalone display mode establish application behavior only; they do not establish successful installation on physical iPhones or Android devices.

Before a device rollout, verify the actual organization's managed phones: install from the live HTTPS origin, open the icon, sign in normally, confirm an update prompt after the next deployed release, and verify the existing permissions and network error behavior. Device policy, browser version and operating-system prompts remain outside the app's control.

See [ADR 0003](adr/0003-installation-and-safe-updates.md) for the architecture decision.
