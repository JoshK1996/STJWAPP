# Finance: readable reports and the accounting roadmap

Reviewed September 24, 2026. This is a product plan, not the organization's accounting policy or proof of regulatory compliance. All three accounting priorities remain important: reliable books, everyday money workflows, and nonprofit reporting. Their dependency order does not remove any priority.

## Current source-report workspace

Finance imports explicitly described CSV report lines, including workbook-assisted CSV preparation. A reviewer previews the source and publishes an immutable revision; corrections retain previous versions. Metadata identifies the community, source name, currency, report kind, dates and whether the figures describe activity during a period or balances at a date. **That period type does not establish cash or accrual accounting.**

Current comparisons match exact line codes between selected versions. Missing lines remain missing, incompatible line kinds cannot produce a difference, and different reporting periods need explicit review. Full CSV, JSON and original-source downloads, revision history and print remain available. Amount arithmetic uses scaled integers; the import supports four decimal places.

The readable-report iteration adds:

- Search, report-kind and currency filters in the source library, with name or period ordering. Overview cards count reports and list currencies; they do not add unrelated reports or currencies together.
- Names first, readable dates, explicit currency and period-type labels. Source codes and hashes remain available in the source/evidence views.
- A report studio with name/code/group/note search, exact group selection, line-type selection, source/name/amount ordering, selectable columns and keyboard column ordering. Readable overview, detail review and source evidence provide starting layouts.
- A selected-view CSV generated through the existing authenticated finance service. The server validates the options, reloads the authorized version, applies the selection and records the export options in its audit transaction. The existing machine CSV/JSON/source behavior remains separate.
- Print this view, using its selected rows and columns; full-source print remains available. Settings apply to the open view and are not saved across devices.
- A group chart derived only from imported detail lines. Shares use the absolute magnitude of each detail amount; signed net group amounts remain labeled. Subtotals and totals are excluded to avoid counting them again. These are source-analysis figures, not inferred profit, cash, expenses or fund balances.

Readable values add separators and default to two decimal places, with four places available in the report studio. This view's table, CSV and printout use the selected precision; display rounding follows exact aggregation. Original precision remains in full-source downloads and amount hover text. No currency conversion, wage rule or accounting classification is inferred. Negative CSV cells receive spreadsheet-formula protection; exact machine downloads retain the established contract.

Implementation and local test results belong in the delivery handoff and STATUS. This document alone does not establish that the iteration is deployed. Sensitive source attachments remain paused and excluded; this work does not enable PDF/document storage.

## Product research

Intuit describes nonprofit reporting around financial position, activities, cash flows and functional expenses, with restricted support tracked separately. Those reports depend on classified accounting records; a source-file comparison is only a reporting foundation. [Intuit nonprofit accounting guide](https://quickbooks.intuit.com/r/accounting/nonprofit-accounting/)

Xero describes configurable report rows/columns, tracking categories, budget-versus-actual comparisons and accounting reports including aged receivables/payables. These are useful benchmarks for approachable report customization and explain why budget data and transaction workflows need their own models. [Xero reporting and budgeting](https://www.xero.com/us/accounting-software/run-financial-reports/)

Sage describes a dimensional general ledger, accounts payable/receivable, cash management, fund/grant tracking and dashboards across programs, funds and locations. This supports designing explicit dimensions with their own permissions and validation, rather than turning free-text imported groups into accounting authority. [Sage nonprofit accounting](https://www.sage.com/en-us/industry/nonprofit/)

These vendor pages describe capabilities, not a verified STJW configuration, a complete competitor audit or a commitment to a specific provider. The following sequencing is our proposed architecture based on those benchmarks and the current source.

## Gaps and dependency plan

| Workstream | Available foundation | Required next work |
| --- | --- | --- |
| Reliable books | Versioned imported reports and audit events | Accountant-reviewed chart of accounts; explicit fiscal periods and cash/accrual policy; balanced journal entries; posting/reversal workflow; trial balance; opening balances; period lock and closeout. No general ledger is implemented. |
| Banking and reconciliation | Imported source comparisons | Authorized bank/import connectors, duplicate detection, statement boundaries, matched/unmatched transactions, reconciliation approval and immutable reconciliation evidence. No bank feed or reconciliation is implemented. |
| Payables and expenses | Source names, notes and report revisions | Vendors, invoices, due dates, coding, approval limits, payment preparation, duplicate prevention, aging and supporting-document permissions. No bill payment or accounts payable is implemented. |
| Receivables and billing | School/family foundations elsewhere in the app | Approved tuition/childcare/other fee rules, responsible billing parties, invoices, credits, payments, refunds, aging and reconciliation. No financial invoice ledger or payment processor is implemented here. |
| Funds, grants and giving | Explicit organizational units and source groups | Accountant-reviewed restriction rules, funds/grants/program dimensions, allocation rules, releases, donor/grant records, reconciled balances and restricted access. Imported group names do not create funds or prove donor restrictions. |
| Budgets and planning | Imported budget/actual/forecast kinds and exact comparisons | Budget versions, approvals, period/account/dimension alignment, variance rules and forecast assumptions. Imported forecasts are source snapshots, not a forecasting engine. |
| Financial statements | Readable selected-view exports and source evidence | Ledger-backed statements and approved classifications for activities, financial position, cash flow and functional expenses; reviewed consolidation rules and reconciled disclosure support. A source detail sum is not a financial statement. |
| Payroll and labor costs | Exact clock records, hours exports and restricted pay-rate records | Confirmed wage/leave/overtime/break policy, approvals, payroll-provider mapping, payroll reconciliation and reviewed accounting postings. Gross/net pay, deductions and taxes remain unfinished. |
| Board and accountant reporting | Current report studio and report library | Reviewed persistent templates, audience-specific permissions, locked report packets, reconciled period comparisons and traceable drilldowns. No automated external delivery is enabled by this change. |

## Make each workflow selectable without inventing policy

1. Keep the current source-report studio usable while the accountant defines organization entities, accounts, periods, currencies and authority. Preserve explicit subgroup assignments and separate access to pay rates and family financial information.
2. Build and verify the posting/reversal foundation first. Then add banking, payables and receivables as separate selectable workflows that share reconciled accounting records. Each module needs its own configuration and acceptance; a settings switch must not imply implementation or approval.
3. Add funds/grants, budgets, allocations and statements against the verified ledger. Allow users to select approved dimensions, columns and layouts. Preserve all underlying precision and evidence when a readable view omits technical fields.
4. Configure imports and integrations independently. Use preview, validation, duplicate checks, explicit review, current permissions and transactional audit records. AI may suggest mappings; code validates them and an authorized person approves financial actions.
5. Before real financial use, the responsible accountant confirms policies, opening balances, reconciliation expectations, export formats and review/closeout roles. Test rejected access, concurrent edits, duplicate retries, failed audit writes, date boundaries, currency separation and reversal history with synthetic fixtures first.

No calendar dates, costs, tax treatment, donor restrictions, fee rules or wage policies are assumed by this plan. Relevant staff must confirm them before implementation or activation.
