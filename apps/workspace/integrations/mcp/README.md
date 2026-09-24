# Local read-only MCP bridge

This optional Node/TypeScript package exposes three scoped STJW reads over local stdio. It opens no HTTP listener, grants no extra access and performs no writes. It is not a hosted OAuth connector or proof of third-party desktop-client acceptance.

## Verify

From this directory, run `npm ci`, `npm test` and `npm run build`. With the parent application dependencies installed, run `npm run test:workspace` for synthetic in-memory application acceptance. Tests need no production token or database. The generated `build/` and dependencies remain ignored.

## Configure a trusted client

Launch the installed Node executable directly with the absolute path to `integrations/mcp/build/index.js` as its argument. Use the client's protected environment configuration for `STJW_API_ORIGIN` (the intended bare HTTPS origin) and `STJW_API_TOKEN` (an existing unexpired scoped API token). Never put credentials in source, command arguments or logs. The package does not load environment files or mint/store/refresh tokens. An npm startup banner can interfere with protocol stdout, so launch Node directly.

| Tool | Arguments | Fixed API | Scope |
| --- | --- | --- | --- |
| `stjw_list_staff` | none | `GET /api/staff` | `staff:read` |
| `stjw_workforce_report` | start/end/group, optional unitId/userId | `GET /api/reports` | `reports:read` |
| `stjw_workforce_report_v2` | same filters | `GET /api/reports/v2` | `reports:read` |

Dates are inclusive organization-local dates. Grouping is hour/day/week/month/year. V2 preserves integer microsecond strings and six-digit source timestamps; it never falls back to legacy precision. The current account, organization, endpoint scope and domain permissions are enforced by the upstream app on every request.

Origins reject embedded credentials, non-root paths, query strings and fragments. HTTPS verification remains enabled, redirects are refused, destination/method/path cannot be changed by tools and results are not cached. Explicit synthetic loopback HTTP is limited to literal loopback addresses.

Responses are bounded to 2 MiB, 5,000 source rows, 2,000 staff and 1,024 buckets, with a ten-second timeout, four concurrent reads and sixty attempts per minute. A larger result fails explicitly instead of truncating; narrow the report filters or use the app. Cancellation aborts fetch. Errors use fixed diagnostics without tokens, response bodies or sensitive configuration.

Returned labels are untrusted data. A connected client's model/provider and retention settings remain an operator data-access choice. This bridge does not itself send records to a model provider. Hosted OAuth, writes, Google connections and school/family/care tools remain unfinished.

The implementation follows the [MCP stdio specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) and [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Current versions and verification commands are recorded in this package's lockfile and CI.
