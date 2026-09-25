# STJW community workspace

A dedicated employee, school, early-childhood and parish workspace. The live workforce focus is employee timekeeping, organizational roles, reviewed time records, scheduled-hour comparisons and accountant-ready exports. Owner-confirmed demonstration operational records have been removed; synthetic fixtures are for isolated tests. The broader SIS/accounting scope remains unfinished.

The application is React/Vite, a TypeScript Express API and PostgreSQL. Development and tests can use PGlite. Production runs independently of the reference applications and uses a restricted database account.

## Develop

Use Node 22.12 or newer. Run `npm ci`, `npm test` and `npm run build` from this directory. Start the API with `npm run dev` and the frontend with `npm run dev:web`. Tests contain synthetic records only. Supply private local configuration as described by `server/config.ts`; never configure a development test run with a production database or credentials.

Start with [everyday workforce use](docs/WORKFORCE-DAILY-USE.md). Read [development and delivery](docs/DEVELOPMENT.md), [current status](docs/STATUS.md), [roadmap](docs/PLAN.md), [workforce analytics](docs/WORKFORCE-ANALYTICS.md), [payroll hours](docs/PAYROLL-HOURS.md) and [API](docs/API.md). The [local MCP bridge](integrations/mcp/README.md) exposes approved read-only API operations to compatible agents; it does not grant additional access.

Passwords open the permitted workspace. PIN-only sessions provide the time clock. Payroll hours are not calculated wages: overtime, paid-break treatment, taxes, deductions and payroll closeout require separately configured and reviewed policies.

The root repository prototype remains separate. Never copy its student records, documents, credentials or databases into this app, CI fixtures or deployment artifacts.
