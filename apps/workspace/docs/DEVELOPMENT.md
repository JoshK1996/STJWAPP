# Development and delivery

The current application lives in `apps/workspace` in the existing `JoshK1996/STJWAPP` repository. The root prototype and its history remain preserved. Run the commands below from `apps/workspace`; do not use prototype data as test fixtures or copy it into the current application.

## Local verification

Use Node 22.12 or newer and the checked-in npm lockfile. Install with `npm ci`, then run `npm test` and `npm run build`. Tests use synthetic records. `scripts/test-env.mjs` supplies a random test-only PIN lookup key when none is configured; never run tests with production configuration. Install and verify the optional local MCP bridge separately with `npm ci --prefix integrations/mcp`, `npm test --prefix integrations/mcp` and `npm run build --prefix integrations/mcp`.

Use `npm run dev` for the application server and `npm run dev:web` for Vite development. Configuration requirements and production startup checks are documented in [deployment](DEPLOYMENT.md) and [database operations](DATABASE-OPERATIONS.md). Keep local credentials in ignored environment configuration; never commit a configured environment file, a database, exported school records, downloaded reports, browser storage or Railway connection artifacts.

## Source publication boundary

Publish from a clean checkout built from the last reviewed release and explicit current changes. The historical local workspace contains paused finance-attachment experiments and extra AWS dependencies that are not part of the deployed application. Those files and their dependent tests are intentionally excluded until that work is finished and reviewed. This is not a claim that the full original request is complete; [remaining scope](REMAINING-SCOPE.md) records the gaps.

`node scripts/verify-repository-hygiene.mjs` validates staged/tracked blobs only within the current application directory. Before staging, supply `--manifest PATH` with an explicit JSON array of relative filenames. The checker rejects paths outside its source/documentation allowlist, credentials and database/report artifacts, paused attachment implementation, symlinks, malformed text, known deployment-account identities and several high-confidence secret formats. Identity matching uses one-way fingerprints, so the guard itself does not publish customer names or addresses. It reports paths and rule names, never matched values. Its hash identifies the inspected bytes. The checker is a guard against common publication errors, not a complete secret or privacy review.

Stage reviewed paths explicitly. Avoid `git add .` and `git add -A` in the historical workspace. Verify `git diff --cached --stat` and the hygiene result before committing. Reference repositories, `.work`, `.railway`, `output`, `undefined`, local database files and keys stay outside the publication boundary. New binary assets require explicit checker review; images cannot be checked for personal data using text patterns.

The application's `.gitattributes` preserves source bytes across operating systems. In particular, deployed migration bytes must not change through automatic line-ending conversion. Keep new text UTF-8, preserve immutable migrations and verify the manifest against the Git tree before release.

## Branches and review

Use `codex/<short-change>` branches and focused pull requests into `main`. Describe the user-visible result, validation, migration implications and known limitations. Update `docs/STATUS.md`, the affected feature document and the relevant architecture decision when behavior or an architectural constraint changes. Do not rewrite immutable deployed migrations 001–039.

The `Workspace CI / verify` job runs repository hygiene, application tests/build, production dependency audit and the MCP bridge tests/build. It uses a sparse checkout of the current application, read-only repository permission, no deployment credentials, and immutable action SHAs. All pull requests run the job so a required check is not left pending by a path filter. The workflow never deploys to Railway. These choices follow [GitHub's secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

CODEOWNERS identifies Josh as the current reviewer. It does not by itself enforce approval. Branch protection, required checks, allowed merge methods and reviewer requirements must be configured and verified on GitHub; documentation or local files cannot establish those settings. Do not claim that a push or merge happened until the remote commit/PR and check results have been read back.

## Release discipline

After the branch checks pass, review and merge the exact tested commit under the owner's authorization. Stage only the reviewed production paths, keep the manifest immutable, run separate PostgreSQL maintenance as a dry run and then a commit, and deploy that exact source. The web application keeps the restricted `stjw_runtime` account and never migrates or seeds production. See [database operations](DATABASE-OPERATIONS.md).

Record the source commit, manifest hash, deployment ID, schema version and actual acceptance evidence. Local synthetic browser checks, mocked interface checks, public hosted checks and authenticated hosted checks are distinct evidence. Verify mobile layouts, touch targets, keyboard access, reduced motion and relevant themes for changed screens. Preserve visible failure/empty states and exact report values. Never reset customer credentials or use their accounts merely to obtain a screenshot.

Temporary maintenance access must be revoked after verification. Keep backups, restoration drills and remaining operational limitations explicit. A successful pipeline does not establish FACTS parity, payroll certification or acceptance for live student records.
