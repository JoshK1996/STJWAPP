# Editing and correcting records

Management pages should let an authorized person maintain the records they create. This release adds missing editors and makes existing correction paths explicit. Deployment and actual acceptance are recorded in [STATUS](STATUS.md) and [VALIDATION](VALIDATION.md).

## Employees and jobs

Open **Employees & jobs → Jobs** and choose **Edit job**. Change the title, description or availability, enter a reason and save. Clear availability to archive; select it to restore. **History** shows who changed the job, when, why and the before/after values. Search and status filters include archived jobs.

An unused job can move to another community. Once assigned, scheduled or used in time/pay/correction evidence, its community stays fixed; create the replacement in the correct community instead. A job cannot be archived while someone is currently working or on break in it. Archiving preserves past segments and existing employee assignments, but prevents new assignments and new clock-in/job-switch use. Current report labels follow a renamed job; retained timestamps and captured historical snapshots are not rewritten.

**Manage jobs** opens the dedicated assignment editor, including an administrator's own account and peer administrators. It changes only jobs and communities. Current clock assignments are protected; other available jobs can be added during a shift without changing credentials or ending sessions. Archived assignments may be retained. Both this editor and the full employee form require the currently observed source revision.

**Edit employee** maintains an authorized account's profile, role, community assignments and jobs. An existing archived job can remain assigned while other account details change. Archived jobs cannot be newly assigned. Role and community controls remain restricted by current server-verified authority. Own-password changes belong in **Settings → Change your password**.

If another person saved first, the editor preserves your unsaved values and shows the conflict. **Reload saved values** asks before replacing that draft with the current record. Discarding an unsaved edit also requires confirmation.

## Page-by-page entry points

| Area | Maintain or correct data here |
| --- | --- |
| Overview and workforce charts | Adjust filters/views; edit the underlying people, jobs or time records. Aggregated chart values are calculated. |
| My time clock | Clock in/out, change job and start/end a break. Submit a time adjustment for a past punch. |
| Employees & jobs | Create/edit employees; manage own and permitted employee jobs; create/edit/archive/restore jobs; inspect job history. |
| Time records | Open a shift and use the reasoned correction/review workflow. Original evidence remains. |
| Requests | Edit or withdraw your own pending general request. Reviewed requests stay recorded. A reviewer must acknowledge its current revision. |
| Staff schedule | Open a planned shift to edit or cancel with a reason. Submitted schedule-change proposals can be withdrawn and replaced. |
| Payroll / reports | Customize and save views, report definitions, columns and exports. Correct hours at their source; prepare a new retained report copy. |
| Calendar | Use **Edit** on an editable agenda entry or **Edit occurrence** in its detail. Timetable events link back to school scheduling. |
| Messages | Edit drafts before sending. Correct a sent message with a reply; mailbox archive/read state remains editable. |
| School records | Student, family, contact, class, curriculum, roster, admission, attendance and grading editors; new year, term, course and room editors/history. See [school inventory](EDITABILITY-SCHOOL.md). |
| Childcare and dismissal | Maintain programs, enrollment, authorized contacts, transport/setup and unreleased plans in their existing editors. Corrections must preserve recorded custody evidence. See [custody inventory](EDITABILITY-FINANCE.md). |
| Accounting | Settings, accounts, dimensions, open periods, manual journal drafts, contacts and bill/invoice drafts have editors. Posted entries use linked correction/reversal workflows. Budgets/payroll can prefill a separate replacement draft. See [finance inventory](EDITABILITY-FINANCE.md). |
| Imported financial reports | **Edit report details** preserves exact source lines and publishes a reviewed revision. **Import correction** previews replacement source data. |
| Settings / organization | Appearance, PIN, password, authenticator, API-token replacement, reviewed branding and organizational-unit editors. See [operational inventory](EDITABILITY-OPERATIONS.md). |
| Activity history | Read/filter retained audit evidence. Audit entries cannot be edited or deleted through the app. |

## Protected records and remaining gaps

This release does not make every field freely editable. Recorded punches, released school results, sent messages, issued financial documents and completed child handoffs require their documented correction/reversal workflows. Where no safe correction workflow exists, the limitation remains explicit:

- Closed childcare time entries do not yet have a historical amendment editor.
- Reconciled bank statements have no historical reconciliation correction workflow; open statements can be cancelled and reimported.
- Budget/payroll replacement drafts are separate records. They do not automatically void the original or undo an external payment; approval checks enforce conflicting-run constraints.
- Established class year/course/homeroom changes, used term dates, organization-wide time-zone conversion and cross-community historical moves need separately reviewed migration workflows.

## Development rule

Every management feature must document its create/read/edit/archive-or-correct lifecycle. Put editing beside the record, prefill existing values, explain unavailable actions, protect unsaved work and preserve failed drafts. Require current authority, explicit scope, expected revision, applicable reason, and transactional before/after history. Test stale saves and revoked access; check the actual editor at narrow widths. Immutable evidence needs a visible correction/replacement path or an explicit documented gap. See [ADR0008](adr/0008-management-editing-and-preserved-evidence.md).
