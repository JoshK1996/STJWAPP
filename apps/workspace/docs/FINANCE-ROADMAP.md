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

These vendor pages describe capabilities, not a verified STJW configuration, a complete competitor audit or a commitment to a specific provider. The following table distinguishes the implemented manual workflows from their remaining automation and acceptance requirements.

## Current capabilities and remaining work

The current accounting implementation adds manual books, AP/AR, bank CSV reconciliation, budgets, payroll preparation and ledger-backed reports; see [ACCOUNTING](ACCOUNTING.md). The release STATUS distinguishes implemented, verified and deployed work. The application starts with labeled, unreviewed USD/two-decimal/accrual/January 1 settings and all workflows enabled, as requested by the owner. Currency, precision and basis are editable before dependent records exist; fiscal-start and workflow choices remain separately configurable. These defaults are not confirmed organization policy. Provider automation, confirmed tax/wage rules and advanced conversion/consolidation remain separate.

| Workstream | Implemented capability | Remaining work and acceptance |
| --- | --- | --- |
| Reliable books | Configurable chart and periods; exact balanced journal drafts, posting and reversal; immutable posted evidence; trial balance; period close/reopen | Accountant acceptance of policy, account coding and manually entered opening balances; reviewed year-end adjustments and statutory close package. Period closure does not automatically transfer balances. |
| Banking and reconciliation | Mapped CSV preview/import, duplicate and date checks, exact grouped matches, outstanding-line evidence, immutable reconciliation and open-import cancellation/replacement | Live bank feeds/connectors and broader opening-balance/reconciling-adjustment workflows. Current first-statement review uses all unmatched pre-statement cash lines as cleared opening evidence. No money movement is initiated. |
| Payables and expenses | Vendors, coded bills, due dates, issue/credit/void history, recorded external payments/refunds, duplicate prevention and aging | Organization-specific approval thresholds, payment transmission, purchasing automation and sensitive supporting-document storage. Recording a payment does not pay a vendor. |
| Receivables and billing | Customer/family financial contacts, coded invoices, original-line credits, recorded external receipts/refunds and aging | Confirmed tuition/care fee schedules, school-family linkage, attendance-driven billing, reminders and payment processing. A family contact label grants no school-record access. |
| Funds, grants and giving | Explicit fund/program/grant dimensions with date/account/community restrictions; scoped statements; financial donor contacts; balanced payroll fund allocation | Accountant-reviewed restrictions, general allocation rules, restriction releases, donor receipts and detailed giving/grant administration. Imported groups and contact labels do not prove legal donor restrictions. |
| Budgets and planning | Retained period/account/fund budget drafts, approval/void history and exact actual-minus-budget comparisons | Forecasting, scenario planning and broader allocation automation. Imported forecasts remain source snapshots; an unassigned-fund budget line is not an all-funds total. |
| Financial statements | Ledger-backed trial balance, financial position, activities, functional expenses and classified cash movements; filtered CSV and styled Excel packets | Accountant acceptance of opening balances/classifications, statutory cash-flow/disclosure support and multi-entity consolidation. Classified cash movements are not a certified statement of cash flows. |
| Payroll and labor costs | Exact clock evidence and hours exports; explicitly entered earnings/deductions/employer costs, computed gross/net totals, reviewed approval, accounting posting, recorded net payment and reversals | Confirmed wage/leave/overtime/break policy, statutory withholding, provider mapping/submission, payment transmission and tax filing. Entered deductions are not tax calculations. |
| Board and accountant reporting | Customizable source-report studio, private report-library definitions/snapshots, ledger filters, readable CSV and styled Excel report packets | Audience-specific board distribution, ledger packet retention and automated external delivery. Existing source snapshots do not lock a newly generated ledger report packet. |

## Make each workflow selectable without inventing policy

1. Keep the source-report studio separate from accounting books while the accountant reviews starter settings, account coding, periods, opening balances and authority. Preserve explicit subgroup assignments and separate access to pay rates and school-family information; current financial roles remain organization-wide.
2. Use the available posting/reversal, banking, payables and receivables workflows with explicit module choices. Each needs operational acceptance; enabling a module does not confirm accounting policy or connect an external provider.
3. Review the available dimensions, budgets and statements, then extend general allocation and giving/grant workflows as their rules are confirmed. Preserve all underlying precision and evidence when a readable view omits technical fields.
4. Configure imports and integrations independently. Use preview, validation, duplicate checks, explicit review, current permissions and transactional audit records. AI may suggest mappings; code validates them and an authorized person approves financial actions.
5. Before real financial use, the responsible accountant confirms policies, opening balances, reconciliation expectations, export formats and review/closeout roles. Test rejected access, concurrent edits, duplicate retries, failed audit writes, date boundaries, currency separation and reversal history with synthetic fixtures first.

Starter currency, precision, accounting basis and fiscal-year settings are explicit application defaults awaiting review. They do not confirm STJW's tax treatment, donor restrictions, tuition/care fees or wage policies. Relevant staff must confirm those rules and opening balances before real financial use; changing settings cannot silently reinterpret retained accounting history.
