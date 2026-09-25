# Deployment

Railway hosts the app and its separate PostgreSQL database independently of the reference applications. The root prototype is not a deployment source for `apps/workspace`.

## Current employee administration release

Deployment `d1f9cb55-d1e8-4641-a55e-42db50652fe3` is live, verified September 25, 2026 UTC. Separate maintenance dry-run and commit passed with existing credentials, account roles/active states and operational-record counts preserved. Schema 044 is deployed; migrations 001-044 are immutable. All 367 staged runtime files match source commit `ce0460a269ace7d07ee7296e41dbb1bcb8a77d6d`, manifest SHA256 `db23abdf2662674175311be8c7d61396c10ba8cb2b7459767e2ca07d2684bce6`. Hosted public acceptance passed 36 checks, 12 exact asset comparisons and 99 anonymous protected-route denials, with zero unexpected errors. Actual web-container readback verified `stjw_runtime` as runtime/login identity, 31 protection flags, no private archive access, consistent credential policy flags and active required management roles. Temporary maintenance access was revoked.

Build version `a0c373af5e553495f51ce672c7c8af6746da5add9c058851696674275a2a1893`; entry SHA256 `a2dda044f4cc62c5c08790cee25a5933015343f741d3b35b38e7947fec31ce79`. The executed plan SHA256 is `32c11005d95d1a13403142a035e37e80b66e6015762dab4d0416c7e5a0bdd63d`. The identical reviewed plan rolled back to43 during its dry run and committed44; no previous migration was edited. Roll forward with schema044-compatible source.

Account setup and existing operational records were preserved; no cleanup or credential reset was performed. Existing clients must finish pending work and accept the update or reload to handle the new policy metadata. See WORKFORCE-DAILY-USE for job assignment and all four account-setup choices.

## Previous workforce activation release

Deployment `852705f0-238d-4e02-80cc-e8351f9bd68e` is live, verified September 25, 2026 UTC. Separate maintenance dry-run and commit passed; schema043 is deployed and migrations001-043 are immutable. All 358 staged runtime files match source commit `42e2e3ff2e0bba6a13c884ef908e36982c959c0a`, manifest SHA256 `d5c94c065000158cbc641b3cbad6802e88a6b00886922cbb319367a4f0d60aea`. Hosted public acceptance passed 36 checks, 12 exact asset comparisons and 98 anonymous protected-route denials, with zero unexpected errors. Demonstration mode is off. Actual web-container readback verified runtime/login role `stjw_runtime`, 31 denied-capability/protection checks and no access to the private rollback archive. Temporary maintenance access was revoked.

Build version `9889c0c74be7b1994c467fda7798bbc7cd45453764780200670602177524a86e`; entry SHA256 `a8310bd62e2bef46c529ac71e363a24e25a01da3f1c3a83666d4d88fa1b68e0d`. The executed plan SHA256 is `8917994ad58c3c312ac59bebe459629f8b3e806c6e7bf782c3233a672b30e13d`. The first generated dry-run plan had a SQL delimiter error before any change; the generator was corrected, then the identical reviewed plan passed rollback to39 and committed43. No deployed migration was rewritten. Roll forward with a reviewed schema043-compatible source.

The owner-confirmed demonstration records were cleared before activation, retaining three real accounts and four baseline communities/jobs. A private on-host archive is inaccessible to the web runtime. Later account setup and future live records must be preserved; do not repeat the prelaunch cleanup. Limited owner-requested administrator recovery was verified through the hosted replacement gate without creating management sessions or selecting final credentials. Subsequent readback shows one administrator completed setup. All broader authenticated workflow acceptance used disposable synthetic databases.

Use the guarded update prompt after finishing pending work. See WORKFORCE-DAILY-USE for the simplified workflow and VALIDATION for exact test/browser/Excel evidence.

## Previous management editing release

Deployment `03da1d01-7f87-4425-874a-309c89bfb58f` is live, publicly verified 2026-09-25 UTC. Separate maintenance dry-run and commit passed; schema039 is deployed. All 339 staged runtime files match source commit `fbdeadad55cf93318ddc633926a6ad324a346768`, manifest SHA256 `023390b87288d3e3f02742788a6f8dedc6331c816ea2d28dc728176e74578beb`. Public hosted acceptance passed 34 checks, 12 exact asset comparisons and 81 anonymous protected-route denials, with zero unexpected errors. Temporary maintenance access was revoked. These public checks are separate from the local authenticated synthetic workflows.

Build version `7faeab7148e8df229aa0f0ed88be6adc681a074a9c169fac3b90699524c936dc`; entry SHA256 `5ea710ff678e16c3d8c227452cb5729577e2716c43e6b22d28c3358dcae75d87`. The exact executed maintenance plan SHA256 is `2451deb6c8b72e3a0f8b2fccd28f8975cc475f912de01ef7ae8bf863833719c1`; dry run rolled back to37, then that same serialized plan committed39. Migrations001–039 are immutable. Runtime startup verifies schema and restricted privileges without migration/seeding. Roll forward with a reviewed schema039-compatible release. Use the guarded update prompt after finishing pending work. See EDITABILITY for available controls and remaining historical amendment limits.

## Previous accounting release

Deployment `e3bbb811-6c1e-49fa-9feb-30d399603e2c` is live, verified September 24, 2026 UTC. Separate maintenance dry-run and commit passed; schema 037 is deployed. Migrations 001–037 are now immutable. The web runtime passed startup schema/privilege checks using its restricted role, without migrations or seeding. Temporary maintenance access was revoked.

All 329 staged runtime files match source commit `f3bdf309ea54496f0098c16d3d083e2f7452ccdc`, manifest SHA256 `dcee19b2c161575bdc8e9ac93393ef926346e5442593a69c9c9959cd2fa55cd8`. Build version `a56b89abd5659612ec8ee8457f207c2fe273141a9119fa77876635e3784b6063`; entry SHA256 `1c14b6eb27741c5b3db66f265269b9d0314e05cf82c5a565d7e6ef4f6fa77236`. Public acceptance passed 34 checks, 12 exact asset comparisons and 80 anonymous protected-route denials, with zero unexpected browser errors. See VALIDATION for the 1,068-test suite, normal-authentication accounting/reporting/clock browser checks and seven actual Excel-rendered pages.

The accounting workspace supplies visibly unreviewed starter settings, exact ledger workflows, manual AP/AR and external payment recording, bank CSV reconciliation, budgets, reviewed payroll preparation and readable financial statements. It does not transmit money or calculate/file statutory taxes. Existing clients can use the guarded update prompt after finishing pending work. Roll forward with a reviewed schema-037-compatible release; do not deploy older schema expectations against this database or remove historical evidence.

## Previous readable reports release

Deployment `0f53d564-9184-4cb1-a059-e63d2ef773aa` is live, verified September 24, 2026 UTC. Separate maintenance dry-run and commit passed with schema034 unchanged. The runtime keeps its restricted role and verifies startup privileges without migrations or seeding. Temporary maintenance access was revoked.

All 307 runtime files match source commit `665aa1c59757d6607345fbefff4c8fc0e1d1a641`, manifest SHA256 `ff6d3d326b4732b2fa3f160a4d2e03126eb566c3426060f4603efcf71e4f84aa`. Build version `ea2415c50d227ba91502b9906d1fb06bbd7d3593488f4514d9fd8877ee60c3b2`; entry SHA256 `d55dd7c2baf89c298f3911cc8a7bc2011ad210364f4c338a7c43afe2c5a9e7c5`. Public checks passed34, exact assets12 and anonymous denials62, with zero unexpected browser errors. See VALIDATION for 1,013 local application tests, actual Excel rendering, 58 normal-auth report checks and 84 clock checks.

Presentation options are additive; exact CSV/JSON defaults remain stable. Saved-snapshot Excel explicitly uses layout version2. Existing clients can use the guarded update prompt after finishing pending work. This release does not implement a financial ledger, payment processing or wage calculations.

## Previous payroll preparation release

Deployment `b50f8e26-97a5-411e-9981-0f492e4afce4` is live, verified September 24, 2026 UTC. The separate maintenance dry-run and commit passed; schema034 is deployed and immutable. The web runtime still verifies restricted grants and never migrates or seeds. Temporary maintenance access was revoked after verification.

All 294 runtime files match source commit `96f0059386efd6df76eb6041155fb32e1d0e723e`, manifest SHA256 `21eea6f395a807a9592b7ac325939d70332ed9548fb4aaaf7ac4eaec46326a8e`. The exact build version is `7b84fb7847cf6a89e8844c84ce25882228a1abf982291883cde8667b3a097f9b`; entry SHA256 `d0225073126b07537d2fe45de23e2f174f18f3a523613c725a568a930099f772`. Public checks passed34, exact assets12 and anonymous denials57, with zero unexpected browser errors. See VALIDATION for the976-test suite and separate synthetic browser evidence.

Roll forward with a reviewed release retaining schema034 if a correction is needed. Do not delete the saved-view table/history or deploy a schema033 application against the new database. The new API operations are additive; existing clients retain their established clock and hours routes and can use the guarded update prompt.

## Reviewed source

Use Node 22.12 or newer, `npm ci`, `npm test` and `npm run build`. Review the source, lockfile, assets and additive migrations. `scripts/stage-release.ps1` creates an explicitly bounded production directory and hash manifest from a clean application checkout. Do not stage a historical workspace containing paused experiments.

Keep the manifest immutable through maintenance and deployment. Local credentials, records and development artifacts are excluded. A GitHub merge does not automatically deploy; CI has no Railway credentials.

## Configuration and maintenance

Configure hosting secrets through authorized operations. Never commit database URLs, PIN lookup material, setup links, passwords, tokens or SSH identities. Supply the HTTPS origin and restricted runtime connection required by `server/config.ts`.

The web service uses `stjw_runtime`, verifies schema/privileges and never migrates or seeds production. Run reviewed maintenance through the separate database container, first with rollback and then commit. See [database operations](DATABASE-OPERATIONS.md). Do not elevate the web role to resolve an operational failure.

## Acceptance

Verify health, exact assets and anonymous denial of protected operations. Use dedicated synthetic accounts for authorized workflow checks; customer credentials are not a shortcut. Check mobile/keyboard/motion/themes and distinguish mocked, local authenticated and hosted evidence.

Record commit, manifest hash, deployment ID, schema version and actual evidence in the reviewed release/PR. Revoke temporary maintenance access. Rollback must preserve additive schema compatibility and historical evidence, without rewriting deployed migrations or restoring privileged web credentials.

## Verified visual/mobile release

Deployment `f2d4d531-c9de-4a4f-9e6f-5f40e24b5131` is live, verified September 24, 2026 UTC. Schema 033 remains unchanged. The exact 270-file production source manifest is `5bc763dd7730896f31b3c9bdc4813c73a5c1ce9328b15efef7385c529fb25898`; runtime bytes match source commit `7952abbd2bebe62ab3bfd46f2f48cbdd3eb76e16`.

The deployed entry assets are `/assets/index-BkK7F96v.js` and `/assets/index-VCMd9LFC.css`. Public hosted checks passed 12 checks, two exact asset comparisons and 52 anonymous protected GET denials with zero unexpected console/runtime errors. These are public checks, separate from the 41 local normal-authentication workflow checks and 85 responsive samples. Customer credentials were not used for acceptance.

## Verified presentation release

Deployment `c0bfd6e2-e95a-4b56-bac9-28a463d26fd5` is live, verified September 24, 2026 UTC. Separate maintenance dry-run and commit both passed with schema 033 unchanged. The web role remains restricted; no migration, seed or credential change was performed by the web service. Temporary SSH maintenance registration was revoked.

All 287 production source entries match commit `415cb65be54b4149236a644a048555e218e8c456`; manifest SHA256 is `4636f022fa3cd48e760eed3e6223a58a10f284e2f83b065a497907b3789bb643`. Build version is `378251467fb8596c3933744bcd142c12ed00fe026a8e0a1f6c1a589b85f08e7f`; entry SHA256 is `0ea9424d5e7a847071768eb560e92ecff7a4436efeb3aa61d525ac24acf2c3b8`. Public acceptance passed 34 checks, 12 exact asset comparisons and 52 protected anonymous denials with zero unexpected console/runtime errors. See VALIDATION for local workflow evidence and physical-device limitations.

Older tabs must refresh once after finishing pending work to receive the first update monitor. Later compatible deployments can display guarded update prompts. A GitHub push/merge alone does not change the hosted app.

## Verified mobile clock release

Deployment `44e603a3-2e76-4bee-9b0e-d832f6895622` is live, verified September 24, 2026. All 288 production entries match source commit `5d007df291aaa68d0fa0b7c68307499969710cc3`, manifest SHA256 `3fb4cc7039109a89aeecac40fbf725b7a23c4aac06e300c2285ba181b7a288ed`. The entry SHA256 is `57b0434dc54b008a1b03fddf5808b8356f3144f72df90e9b705497f6b6681cb6`; build version is `cd12a7ce8a2bff4085bb1077383659d0e922386e61520e15134a6648e52227b4`. Root and staged builds match.

Separate database maintenance dry-run and commit passed with schema 033 unchanged. There are no backend, migration, credential or time-arithmetic changes. Temporary maintenance access was revoked. Public acceptance passed 34 checks, 12 exact asset comparisons and 52 anonymous protected-route denials; local normal-authentication mobile acceptance passed 84 checks across 14 samples with the demonstration banner enabled. Full source/API and physical-device boundaries are recorded in VALIDATION.

Existing clients can receive this deployment through their update monitor and explicitly reload after resolving pending work. A manual reload also loads the new mobile-first entry behavior. GitHub publication alone is not deployment.
