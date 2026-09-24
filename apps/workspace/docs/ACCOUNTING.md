# Accounting workspace

The accounting workspace lives under **Reports → Finance & accounting → Accounting workspace**. Imported source reports remain in their own tab and do not automatically become ledger entries.

## Starter settings and how to change them

The owner requested usable defaults with clear controls. A new accounting workspace starts with **USD, two decimal places, accrual accounting, January 1 fiscal-year start, and all accounting workflows enabled**. These are application starter choices, not confirmed STJW accounting policies. The workspace labels them as awaiting accountant review.

Choose **Change accounting settings** or **Settings** to review the currency, precision, accounting method, fiscal calendar and enabled modules. Saving the settings records that review. Tim and other authorized developer, owner, administrator or finance accounts can do this after password sign-in. PIN sessions remain limited to the time clock.

**Use starter chart & period** creates suggested account names and an explicit calendar-year period. It creates no opening balances, invoices, payments, payroll or journal postings. An accountant can instead create an organization-specific chart and fiscal periods. Account names/codes, dimensions, classifications, active status, periods and workflow choices have their own controls.

Currency, monetary precision and accounting method can be changed before financial records exist. Once records exist, these settings cannot silently reinterpret historical figures. Review an accounting conversion with the accountant; automatic conversion between currencies or cash/accrual books is not provided. Changing the fiscal start setting does not rewrite existing dated accounting periods. New period dates are explicit, and overlapping periods are rejected.

## Books and financial statements

- Accounts use asset, liability, equity, revenue and expense types. Cash accounts, cash-flow classifications and functional expense classifications are explicit.
- Funds, programs and grants have optional account/community/date restrictions. A dimension label does not establish a legally valid donor restriction; the accountant defines the purpose and permitted coding.
- Draft journals can be reviewed before posting. Posting requires exactly balanced debits and credits in an open period. Posted entries retain account identity snapshots and cannot be edited or deleted. Corrections create opposite entries linked to the original. Source-owned entries must be corrected through their originating workflow.
- Period closure blocks new postings dated in that period. Reopening requires a recorded reason. Closing does not silently create retained-earnings or tax adjustment entries.
- Reports include a trial balance, ledger activity, financial position, activities, functional expenses and categorized cash movement. Scope/date filters, readable CSV and styled Excel preserve traceability. Unclassified cash movement is displayed explicitly; it is not invented cash-flow classification or a certified statement.

## Bills, invoices and recorded payments

Create named vendor, customer, family or donor contacts, then prepare bills or invoices with explicit dates, due dates, line descriptions and account coding. Tuition, childcare and other fees can be entered as described invoice lines; there is no inferred fee schedule, automatic attendance billing or live family-account link in this release.

Issue reviewed documents to retain their evidence. Accrual documents post receivable/payable controls when issued; cash-basis documents recognize coded activity when settlement is recorded. Record partial payments, credits, refunds and corrections through the document's actions. Balances and aging derive from immutable dated events, and overpayments/refunds beyond available amounts are rejected. Payment recording documents an external transaction; it does not transmit funds or contact families/vendors.

## Bank reconciliation

Preview a CSV statement with explicit dates, signed amounts and references. Review opening/closing balances before importing. Exact duplicate lines and overlapping active statement ranges are rejected. Source CSV evidence is retained separately from readable exports.

Match statement lines to posted cash-account journal lines. Reconciliation verifies amounts and boundaries and preserves immutable evidence. A first statement with a nonzero opening requires reviewed ledger opening evidence. Later statements must continue the prior reconciled statement's dates and closing balance. An incorrect open statement can be canceled and reimported; reconciled statements retain their history. Live bank feeds and automatic money movement are not connected.

## Budgets

Create named budget drafts for explicit fiscal periods, with revenue/expense account and fund lines. Approve the reviewed budget and compare it with posted activity. Variance means **actual minus budget**, not automatically favorable or unfavorable. An unassigned-fund line counts entries with no fund; it is not an all-funds total. CSV includes the visible account/fund comparisons. Void superseded plans while retaining their history.

## Payroll preparation

The existing Payroll screen continues to provide exact time-clock summaries and accountant-ready Excel/CSV exports. The accounting Payroll preparation workflow adds reviewed earnings, deductions, employer costs, net-pay summaries, approval, accounting posting and recorded external net payment.

Enter each employee's earning description, quantity and rate, along with the accountant's deduction/withholding and employer-cost amounts. Code them to explicit expense and payable accounts. Deductions are allocated proportionally across the employee’s explicit earning funds using exact minor units and largest remainders; stable fund order resolves ties. Net-pay and cash/payable offsets retain those fund assignments so each fund stays balanced. Employer-cost expense/payable pairs remain unassigned unless separately journaled by the accountant. Integer arithmetic computes quantity × rate and rounds half up once per named earning to the configured currency precision. No time segment is rounded to derive the recorded-hours evidence. The draft retains a snapshot of the selected employees' time records; approval rechecks that evidence, and overlapping approved employee pay periods are rejected.

The quantities and rates are reviewed inputs. The application does not determine legal overtime, paid-break, leave, salary-proration or statutory tax entitlement. Those calculations require confirmed organization rules or a payroll provider. Entered withholding is not a tax calculation. A run's CSV identifies its review status; drafts must not be described as approved payroll.

Accrual payroll posts labor costs and payables after approval; recorded net payment clears the payable against cash. Cash-basis payroll records the cost at the recorded payment. Voiding posted/paid runs creates dated reversals in an open period while keeping the original evidence. Payment recording does not send money or file returns.

## Controls and operational boundaries

Financial access follows the existing organization-wide developer/owner/admin/finance policy; managers and employee/PIN sessions cannot use these workflows. Every service obtains current authority, serializes accounting changes per organization, validates organization ownership, and writes audits in the transaction. Mutations use command receipts or expected revisions to reject stale/duplicate changes. Runtime database startup checks the accounting protections and uses the restricted role, never schema-owner credentials.

This is a synthetic demonstration deployment until accountant acceptance, opening balances, operational procedures and reconciliation are verified. No real bank/provider credentials, payment transmissions, tax filings, customer-password testing, historical-source migration or sensitive financial attachments are part of this build.

## Remaining integrations and advanced automation

Live bank feeds, payment processing, tax calculation/filing, attendance-driven tuition/childcare billing, donor receipting, automated allocations, currency conversion, consolidated multi-entity books and a statutory disclosure/close package require further provider/configuration work. The implemented workflows support manual reviewed accounting and exports; they do not establish those integrations or certify financial compliance.

The architecture follows the existing [accounting roadmap](FINANCE-ROADMAP.md) and capability research: [Sage nonprofit accounting](https://www.sage.com/en-us/industry/nonprofit/) and [Xero financial reporting](https://www.xero.com/us/accounting-software/run-financial-reports/). Vendor capabilities inform product structure, not STJW policy.
