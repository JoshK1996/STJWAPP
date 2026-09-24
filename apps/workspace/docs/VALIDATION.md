# Validation evidence

Run `npm test` and `npm run build` from the current application. Run the publication hygiene checker against staged/tracked files before pushing. The CI workflow separately installs/tests/builds the local MCP bridge and runs its actual synthetic application acceptance.

Each reviewed release must identify its source commit, exact production manifest, schema version, deployment ID and check results. Keep local tests, mocked interface checks, local normal-authentication browser workflows, public hosted checks and authenticated hosted acceptance separate. A screenshot or passing compile does not establish workflow correctness.

Changed visual screens need desktop/mobile, keyboard, touch, contrast and reduced-motion checks with synthetic data. Clock/report changes also need exact durations, date boundaries, export reconciliation, authorization and relevant concurrency tests. No customer account is used as a verification shortcut.

Current GitHub workflow results and the reviewed pull request provide the publication evidence. Private operational logs and account provisioning receipts are retained outside this public repository. See [status](STATUS.md), [deployment](DEPLOYMENT.md) and [development](DEVELOPMENT.md).

## Current visual and mobile iteration

Local verification passed 41 normal-authentication synthetic workflow checks and 85 responsive layout samples, with zero runtime errors. The clean publication build passed. The local MCP bridge passed 19 protocol/schema tests and 16 actual synthetic application checks. The production dependency audit reported zero vulnerabilities at review time. The exact staged publication passed repository hygiene; existing prototype files have no modification/deletion.

The clean publication suite passed all 925 application tests, with zero failures, cancellations or skipped tests. Paused attachment tests/dependencies in the historical local workspace are excluded from this count. Hosted deployment/acceptance remains a separate operation. No customer account or production records were used for these local checks.
