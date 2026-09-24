# ADR 0007: Exact accounting ledger and reviewed operational workflows

Status: accepted for implementation; deployment evidence is recorded separately in STATUS.

## Context

Financial source imports and readable reports did not provide books, invoices, bills, reconciliation or payroll posting. The owner requested all accounting tracks with customizable workflows, then explicitly requested usable defaults that are easy to find and change. Organization policies and financial providers remain unconfirmed.

## Decision

Use one exact ledger per organization, with explicit reporting currency/precision, cash or accrual basis, dated periods, accounts and dimensions. Store amounts as scaled integer database numerics and compute with BigInt. Journal posting enforces a nonzero balanced entry in an open period; posted evidence is immutable and correction means a linked reversal. A shared accounting transaction wrapper verifies the current password session, takes the organization's accounting configuration lock, then accesses domain rows. Recheck authority before publishing the transaction's result.

Provide documented starter settings (USD/two places/accrual/January 1/all workflows) with an unreviewed label and an optional starter chart/period, never synthetic balances masquerading as actual books. Financial-record existence prevents changing currency, precision or basis in place. Future fiscal settings do not rewrite existing dated periods.

AP/AR documents and their dated events own their generated journals. Banking records preserve original CSV and reviewed reconciliation evidence. Budgets and payroll runs preserve their preparation snapshot and review state. These modules share accounting locks and transaction audits; AI cannot post, approve, transfer money or replace deterministic validation. Manual journal endpoints cannot reverse source-owned entries independently of the subledger.

Payroll preparation computes explicit quantities/rates and uses externally reviewed deduction/tax inputs. It preserves clock evidence without guessing overtime, paid-break or tax rules. Recorded payments are evidence of external transactions, not execution of financial transfers.

Readable tables, charts, CSV and Excel sit above exact evidence. Invalid scopes, excessive result sets or ambiguous classifications fail explicitly or carry a visible limitation rather than silently invent totals. Local browser acceptance uses normal synthetic authentication; hosted public acceptance is separate.

## Consequences

Financial operations now have one traceable posting model and reversible correction history. Per-organization serialization favors correctness over high-volume write throughput. There is no silent currency/basis conversion, inferred tax engine, live bank feed or provider payment execution. Those require separately reviewed integrations and organization policy.

Agent evidence ranking and narrow advisory screening use Jev according to [TypeSafe progressive evidence selection](https://docs.typesafe.ai/cookbooks/skill_suggestion). Exact lookup, arithmetic, permission checks and action execution remain ordinary code. Jev findings are hypotheses verified against source and tests, not accounting authority.
