# Validation evidence

Run `npm test` and `npm run build` from the current application. Run the publication hygiene checker against staged/tracked files before pushing. The CI workflow separately installs/tests/builds the local MCP bridge and runs its actual synthetic application acceptance.

Each reviewed release must identify its source commit, exact production manifest, schema version, deployment ID and check results. Keep local tests, mocked interface checks, local normal-authentication browser workflows, public hosted checks and authenticated hosted acceptance separate. A screenshot or passing compile does not establish workflow correctness.

Changed visual screens need desktop/mobile, keyboard, touch, contrast and reduced-motion checks with synthetic data. Clock/report changes also need exact durations, date boundaries, export reconciliation, authorization and relevant concurrency tests. No customer account is used as a verification shortcut.

Current GitHub workflow results and the reviewed pull request provide the publication evidence. Private operational logs and account provisioning receipts are retained outside this public repository. See [status](STATUS.md), [deployment](DEPLOYMENT.md) and [development](DEVELOPMENT.md).

## Current visual and mobile iteration

Local verification passed 41 normal-authentication synthetic workflow checks and 85 responsive layout samples, with zero runtime errors. The clean publication build passed. The local MCP bridge passed 19 protocol/schema tests and 16 actual synthetic application checks. The production dependency audit reported zero vulnerabilities at review time. The exact staged publication passed repository hygiene; existing prototype files have no modification/deletion.

The clean publication suite passed all 925 application tests, with zero failures, cancellations or skipped tests. Paused attachment tests/dependencies in the historical local workspace are excluded from this count. Hosted deployment `f2d4d531-c9de-4a4f-9e6f-5f40e24b5131` is verified live: 12 public checks, two exact asset SHA comparisons and 52 protected GET requests correctly denied to anonymous clients; zero unexpected console/runtime errors. Production source matches the 270-file reviewed manifest `5bc763dd7730896f31b3c9bdc4813c73a5c1ce9328b15efef7385c529fb25898` and runtime bytes in commit `7952abbd2bebe62ab3bfd46f2f48cbdd3eb76e16`. Schema 033 is unchanged. No hosted authenticated customer-account test is claimed. No customer account or production records were used for these local checks.

## Presentation release - September 24, 2026

Source commit `415cb65be54b4149236a644a048555e218e8c456` matches all 287 production manifest entries (`4636f022fa3cd48e760eed3e6223a58a10f284e2f83b065a497907b3789bb643`). Application and separately staged builds have identical entry SHA256 `0ea9424d5e7a847071768eb560e92ecff7a4436efeb3aa61d525ac24acf2c3b8` and build version `378251467fb8596c3933744bcd142c12ed00fe026a8e0a1f6c1a589b85f08e7f`.

- All 935 application tests passed, with no failures, cancellations or skips; production build passed.
- 38 compiled installation checks covered responsive layouts, official imagery, reduced-motion crest visibility, persistent guide/dismissal and manual checks. Native install events and installed/device modes were simulated; this does not establish physical phone installation.
- 25 actual two-build rollout checks used normal authentication against disposable databases. They covered explicit reload, session/active-shift preservation, pending writes, unsaved forms, lost clock response plus safe retry, compatible rollback, mobile hit targets and the development-build message. The lost response was deliberately simulated.
- 41 workforce/payroll checks verified chart interactions, exact totals, numeric Excel hours/source segments, CSV/JSON exports, pay visibility, team status and mobile layouts. Authentication and API calls used disposable databases; the board-error and offline cases used explicit simulation.
- Public deployment `c0bfd6e2-e95a-4b56-bac9-28a463d26fd5` passed 34 checks, 12 exact asset comparisons and all 52 anonymous protected GET denials, with zero unexpected console/runtime errors. The served entry, version, manifest, photos and icons match reviewed bytes. HTML/version are no-store; manifest revalidates. The visible iPhone guide was browser-emulated.

The mobile update spacer now lives outside the horizontal application flex shell; the full clock and Retry controls remain reachable. Reduced-motion photo and crest layers now flatten together. Jev advisory source receipts `4f99ea3c60e74ad2b7fbe6166f471fa8`, `6528732b6acf4bc49db1af993d3a9a7c` and `4a31174b2f934d58b373d20bc46a6dee` were independently checked against source/browser behavior, not treated as proof. No private customer credentials were used. Physical iPhone/Android installation and authenticated hosted acceptance remain separate follow-up checks.
