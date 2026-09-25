# Financial, report and custody editability

Reviewed September 24, 2026. This document describes the management-editing source change; deployment and acceptance are recorded in STATUS by the release owner.

## Controls by page

| Page | Edit or correct path | History and constraints |
| --- | --- | --- |
| Accounting settings | Edit currency, decimal precision, basis, fiscal start and enabled modules; explicitly review/save | Currency, precision and basis lock when financial records exist. Fiscal settings do not rewrite existing period dates. |
| Chart of accounts | Select Edit, change account metadata, classifications or availability | Revision checked. Posted usage protects financial classification. Inactive accounts remain in history. |
| Funds, programs and grants | Edit name/code/purpose, restriction, dates, permitted units/accounts and availability | Existing posted dimensions retain protected classification. |
| Accounting periods | Edit an open period; close/reopen with a reason | Used period dates cannot be rewritten. Closed periods block postings/reversals. |
| Journals | Edit or discard unused manual drafts; post after review; reverse posted journals with date/reason | Posted journals remain immutable. Source-generated journals are corrected through their source workflow. |
| Bills and invoices | **Edit draft** preloads contact, document number, dates, description, control account, charges and dimensions. **Discard draft** records a reason without moving money | Changes require the expected revision and retain before/after audit snapshots. Issue acknowledges the current draft revision. Reload saved draft/contact explicitly refreshes conflicting edits after confirmation. Issued documents use credit, void/replacement, recorded refund or payment void instead of overwrite. |
| Vendor and billing contacts | **Manage vendors/billing contacts → Edit contact** changes name, email, note/type and availability. Clear availability to archive; select it to restore | Used contacts keep their type. Existing documents retain the captured contact name. Archived contacts cannot receive new drafts or be used when issuing an existing draft. |
| Banking | Open statements can replace/remove matches or **Cancel incorrect statement** then reimport | Original CSV and cancellation remain. Reconciled statement evidence is locked; no historical reconciliation rewrite is offered. |
| Budgets | **Edit a replacement draft** copies period, accounts, funds and entered amounts to the editor | Creates a separate plan; the original keeps its status/history. Review and explicitly void the original when superseded. Unavailable accounts/closed periods require current valid choices. Comparison errors retain a recovery path. |
| Payroll preparation | **Edit a replacement draft** copies dates, employees, entered earnings/deductions/employer costs and payable account | Saving recalculates totals and captures fresh time evidence. Original approval, posting and payment remain unchanged. Overlap checks require reviewed void/reversal of the original before approving a conflicting replacement. External payments are not silently undone. |
| Imported source reports | **Edit report details** preloads metadata and exact existing source lines, then Preview report and Publish report version | Creates a reviewed revision, preserving previous versions and their original source files. **Import correction** replaces source data through the same preview workflow. |
| Financial report studio | Change display columns, ordering, groups, search, precision and export format before export | Display formatting does not rewrite exact financial source values. |
| Report library | Select a saved report, edit name/description/source filters/columns and Save report; Archive/Restore available | Versioned saved definitions. Current source authorization is checked when run/exported. |
| Saved report copies | Prepare/review a new saved copy using the saved layout | An existing saved copy is exact retained evidence, not an editable document. Edit source data or layout and prepare another copy. |
| Payroll hours dashboard | Edit named personal filters/default view and report selections | Hours derive from time records. Use Time records to correct the source, then regenerate the report. |
| Employee pay rates | Edit effective-dated rate rows, add/void rates, preview differences and save a reviewed compensation revision | Owner/admin/finance/developer access only. Revision and preview fingerprint guard changes; historical rates remain reviewable. |
| Time records | Select shift and open correction editor; review precision-preserving time/job/type changes and reason | Employee proposals remain separate until authorized review. Corrections and original evidence are retained. Report values are not edited directly. |
| Childcare programs and enrollment | Edit program settings/staff/availability; edit enrollment dates and enabled state; manage pickup holds with reasons | Operational child check-in/out remains recorded evidence. Closed childcare time entries currently have no historical amendment editor. |
| Dismissal | Change unreleased student plan, edit available bus routes and staff setup, cancel calls/reconcile enrollment or reopen eligible cases | Released-child identity/custody and receiving-care acknowledgment remain historical evidence. No arbitrary undo or overwrite of a completed physical handoff. |

## Database and API guarantees

Migration `039_accounting_editing.sql` permits revisioned accounting contact and unissued document updates. Database triggers block document edits after any issue/discard event, preserve identity/creation fields, prevent deletions and reject edits without the next revision. Existing immutable event, audit, journal and command protections remain. Runtime privilege verification now requires both these guards, contact/document UPDATE and absence of DELETE permission.

Services obtain current actor and organization from a live password session under the accounting transaction lock. Each editing command checks expected revision, validates current catalog/organization/module state, and records its audit in the same transaction. Duplicate command retries return the original receipt; changed/stale requests fail. Contact names in earlier documents are intentionally captured values.

## Explicit remaining gaps

- Historical closed childcare timesheet amendment and reconciled-bank correction workflows need dedicated evidence-preserving designs. Their absence is not represented as an editable field.
- Budget/payroll replacement editing is a separate prefilled preparation, not an in-place overwrite or a single atomic replace/void operation. The UI explains the original status and required reviewed correction.
- Editing imported report details creates canonical CSV for the new revision from exact current values. It does not recreate the previous uploaded workbook bytes; those remain attached to the previous version.

## Verification

Focused operations, runtime-access and financial presentation suites passed 43 tests. They cover concurrent/stale draft changes, archived contacts, immutable issued/discarded documents, current account classifications at issue/cash settlement, exact audit snapshots, session authorization, duplicate numbers, audit rollback, retained source strings and runtime trigger/privilege checks. Final normal-password synthetic browser acceptance passed 90 checks across 18 desktop/390px/320px layouts, with zero layout failures or unexpected browser errors. It exercised contact edits/archive/restore/stale recovery, draft invoice edit/issue/discard, separate budget/payroll replacements and exact source metadata revisions. The receipt is private `output/playwright/finance-editability/results.json`; entry SHA256 `5ea710ff678e16c3d8c227452cb5729577e2716c43e6b22d28c3358dcae75d87`. Expected console responses were anonymous pre-login 401 and the deliberately stale contact edit 409. Browser emulation does not establish physical-device or hosted customer acceptance.

Jev evidence selection: `62947753e8f647fd81e7f80f90fea2f5`. Service invariant review: `f46dfe8dad784a479f090e07160cfc73` (Jev clear hypotheses, independently checked against guards, source and tests). Test-failure triage: `6f2b1b6aaff047b78e1813637e842dfe`; findings were checked against source and corrected fixtures. No production/customer data was used.

Posting classification review: Jev hypothesis `dab91de5106748e98be5d6b9aedadc59`, independently reproduced as two missing-rejection failures (receipt `7400e875b5fd4ada97af1f217ddf977c`). Issue and settlement now recheck active document-specific account kinds; a draft can be corrected through its editor before issue.
