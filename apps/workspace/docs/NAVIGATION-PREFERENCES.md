# Personal navigation order

Live in release `91c0c15c-db3c-4faa-b3c0-6e516934e716` (September23 local date, schema031 unchanged). This adds per-account ordering
within the two existing sidebar groups. It does not add links, hide controls,
change permissions, move items between groups or change sign-in home pages.
See the operator guide for the editor workflow.

## Data contract

`shared/preferences.ts` exports `workspaceNavigationIds`,
`organizationNavigationIds` and their corresponding ID types. Preferences gain
two flat arrays:

| Field | Default order |
| --- | --- |
| `workspaceNavOrder` | overview, clock, time-records, staff, schedule, calendar, messages, requests, reports |
| `organizationNavOrder` | school, care, dismissal, workspace, audit, settings |

The existing `PATCH /api/me/preferences` accepts either array independently and
returns the existing `{ok:true,preferences}` shape. A supplied array must contain
each known ID in that group exactly once. Missing items, duplicates, foreign-group
IDs, unknown links/IDs, null and nonarray values return400. Omitting a field from
PATCH preserves its saved value. Existing appearance, dashboard, compact-sidebar
and home preferences retain their schema and meaning.

Saved item positions are presentation data. A position for an unavailable item
grants no access. The rendered sidebar continues applying its existing mode/role
filters and maps IDs only to static application descriptors. PIN remains limited
to its time-clock navigation; server/domain permissions remain authoritative.

## Stored-value compatibility

Valid older preference objects without navigation fields retain every legacy
choice and receive the default arrays when read. For each stored navigation
array, normalization keeps the first occurrence of each recognized same-group
ID, discards invalid elements and appends missing IDs in default order. Missing
or nonarray values default only that group. Neither input arrays nor shared
default arrays are mutated. Strict incoming PATCH bodies are rejected rather
than repaired.

Only navigation normalization changes. Existing invalid legacy fields and
unknown top-level preference keys retain the prior strict all-or-default legacy
behavior. Arbitrary future top-level storage and old cached browser bundles are
not promised forward compatibility. Future navigation catalog additions can
append missing recognized IDs without discarding existing recognized order;
their API enum/length and default catalog must change together.

Preferences already occupy `users.preferences jsonb NOT NULL DEFAULT '{}'`
(`001_core.sql:15`), with no JSON-key migration constraint. There is no migration,
backfill, seed, new table or runtime-grant change. Deployed migrations001–031 are
unchanged. Existing rows are only written by the normal explicit save operation.

## Authorization, saving and recovery

`server/preferences.ts` is unchanged: actual password proof is mandatory; the
current account locks before session/membership proof, current report-home
permission is checked, merged preferences and metadata audit commit together,
and the final session check occurs after result materialization. Existing bounded
timeouts/retries and503 behavior remain in place.

The order editor previews locally; the sidebar uses saved order. Save is explicit.
An uncertain408/429/5xx/transport response keeps the complete submitted preferences
for the existing current-account readback flow. There is no new idempotency
receipt or automatic resave, and another account refresh failing after save does
not undo that save. Multiple tabs retain existing last-write-wins semantics.

Navigation-only reset changes only these two draft arrays. Existing full reset
uses their defaults while retaining its prior saved-home treatment. Discard
restores saved draft values. Organization-style adoption and visual starting
points alter only their existing accent/artwork/depth fields; both orders remain
unchanged. Organization publications do not change personal navigation.

## Verification

The focused suite in `tests/navigation-preferences.test.ts` covers old stored
choices, nav-only repair, future/missing ID ordering, legacy invalid behavior,
independent defaults, strict malformed-write rejection, normal authenticated
group/branding/older-payload merges, current-account readback and actual post-audit
SQL rollback with both order arrays. The existing preference-session regression
suite covers current proof, role change, MFA/PIN/bearer/onboarding and rollback.
Its pre-existing expiry fixture directly modifies a synthetic session expiry;
it is not described as natural expiry or new PostgreSQL queue evidence.

Focused results, UI/browser evidence, full application validation and release
status are recorded separately when completed. This additive JSON/pure-schema
change does not establish new lock-order or PostgreSQL concurrency claims.

Coordinated live release `91c0c15c-db3c-4faa-b3c0-6e516934e716` passed871 automated tests/build,35 same-build browser checks and9 public checks/two exact assets/48 anonymous protected-route denials. See VALIDATION.md for evidence and limits. Earlier local-only notes describe predeployment verification.
