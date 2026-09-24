# Deployment

Railway hosts the app and its separate PostgreSQL database independently of the reference applications. The root prototype is not a deployment source for `apps/workspace`.

## Current payroll preparation release

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
