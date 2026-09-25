# Workforce bulk entry

People & jobs and Staff schedule expose reviewed bulk entry alongside individual editors. Bulk imports create new records. Use the existing edit, archive or schedule-cancellation controls for existing records; imports do not replace historical evidence.

| Workflow | Templates | Review and result |
| --- | --- | --- |
| Staff accounts | Existing blank CSV and Excel | Review roles and explicit community/job assignments. Accounts receive individual private setup links; passwords and PINs are not imported. |
| Jobs | Blank CSV and Excel | Resolve the community by name; create distinct job titles and descriptions. Assign jobs to employees afterward. |
| Staff schedules | Blank CSV and Excel | Resolve the employee by email and the assigned job/community by name; reject overlaps. Creating a schedule does not clock the employee in. |
| Employee pay rates | Existing current employee/job CSV and Excel | A separate restricted compensation workflow retains record versions, reasons and rate history. |

## Jobs template

Keep these exact headers in this order:

```csv
community,title,description
```

Copy the community name from People & jobs. The title must be new within that community, including archived jobs. Case and surrounding whitespace do not distinguish otherwise identical titles. If a community name or scheduled job name is ambiguous, rename it through its editor before importing. The preview displays readable community names and titles.

## Staff schedule template

Keep these exact headers in this order:

```csv
employeeEmail,community,jobTitle,startsAt,endsAt,note
```

Use the employee's account email, exact community name and a job already assigned to that employee. Both account and job must be active, and the employee must have explicit membership in that community.

Enter timestamps as text with `Z` or an explicit UTC offset. For example, `2026-10-05T08:00:00-04:00` identifies a specific instant. Choose the offset that actually applies to the intended date and location. Offset-free local dates are rejected; the app does not guess daylight-saving rules from a spreadsheet. The preview uses the browser's time zone and makes the normalized UTC timestamp available on hover. A shift must last more than zero and at most 24 hours. Adjacent shifts are allowed; overlapping file rows or existing active shifts are blocked.

## Import steps

1. Download the blank template from the relevant import panel.
2. Fill the file using plain text cells. Retain the exact header order. CSV must be UTF-8; formulas, linked content and Excel numeric date cells are rejected by the existing isolated workbook parser.
3. Choose the CSV, or inspect the Excel worksheet and explicitly accept its selected sheet/header and excluded rows. Excel conversion alone creates no records.
4. Preview and review all proposed records. The table displays ten rows per page. Correct invalid or ambiguous rows in the source and preview again.
5. Confirm the review and create the records. A saved receipt identifies every created record. If the response is uncertain, retry the same import to recover that receipt without creating duplicates.

Each jobs/schedules file supports 1–100 data rows. CSV limits are 200,000 characters and 800,000 UTF-8 bytes. Excel uses the existing 256 KiB workbook, isolated worker, formula/feature rejection, deadline and spreadsheet admission limits. The organization retains at most 64 MiB of serialized jobs/schedules source evidence; reaching this limit fails before saving another preview. Capacity management does not delete existing evidence.

My recent imports shows the current account's latest 20 previews and receipts. Reopen a pending preview to review and apply it, or an applied import to view its receipt. Pending previews expire after 24 hours. Retain the original workbook yourself: the app stores the exact converted CSV bytes and fingerprints, not the XLSX file.

## Authorization and evidence

Developer, owner, administrator and manager password sessions can use these imports; managers require explicit access to every destination community. Finance and employee accounts do not gain management access. Both preview and apply recheck the current account, session, MFA and memberships. CSRF protection applies to writes. Preview ownership is account-specific; knowing another account's batch ID grants no access.

The source CSV is retained as canonical base64 to preserve its exact UTF-8 bytes, including any BOM; this encoding is not encryption. Database triggers prevent source/history edits and allow only the first pending-to-applied receipt transition. Applying rechecks captured identities, job versions, memberships, assignments and relevant schedules. A changed source requires a fresh preview. No partial batch survives a validation error, expired proof or failed audit: service writes, schedule history and the import receipt share one transaction.

Individual job creation and the versioned staff-scheduling service execute the actual writes. Bulk schedule work locks the complete affected account set in stable order before per-row writes; jobs are locked before communities to preserve the existing editor order. Repeating an applied request returns its stored receipt after current authorization; it never overwrites later edits or creates a second batch.

Automated tests use ordinary synthetic authentication and cover templates, exact byte retention, duplicate/concurrent apply attempts, current-source conflicts, overlapping schedules, scope/session denials, audit rollback and workbook rejection. Local PGlite serializes transactions; it does not establish production PostgreSQL deadlock behavior or physical-device acceptance. Deployment and browser acceptance are recorded separately in STATUS and VALIDATION.
