# Deployment

Railway hosts the app and its separate PostgreSQL database independently of the reference applications. The root prototype is not a deployment source for `apps/workspace`.

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
