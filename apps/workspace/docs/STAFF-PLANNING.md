# Job coverage and hours targets

Scheduling separates three questions: how many people a job needs at a time, how many job hours the organization wants in a calendar period, and which employee shifts have actually been saved. Only saved shifts feed employee scheduled-hour allowances and durable pre-clock-in. Planning targets do not change payroll, worked time or existing shifts.

## Everyday workflow

Open **Schedule**, or choose **Plan coverage** on an available job in **Employees & jobs**. An employee card's **Schedule** shortcut opens that employee's assignments. Search and community/job/employee filters keep the selected scope visible.

1. Create a coverage rule for a job. Choose the starting date, optional ending date, local start/end times, whether it ends the next day, and how many people must be present. Choose a daily, weekly, monthly or yearly recurrence and its interval; weekly rules also select weekdays.
2. Add a separate hours target if useful. Choose the job, day/week/month/year, hours and effective dates. Weekly targets use Monday through Sunday. Targets are full calendar-period amounts; a partial period is labeled and is not silently prorated.
3. Review the coverage board. Required, assigned and missing employee-hours describe staffing; the separate target comparison describes planned job hours. Employee filters must not turn a whole-job requirement into a smaller requirement. Overlapping rules are conflicts requiring correction, rather than silently added requirements.
4. Preview open slots, select eligible employees, review the choices, then save the assignments. No employee is selected by the server automatically. Bulk choices are explicit and still reviewed. Unselected slots remain open. Newly saved shifts appear in Assigned shifts and employee schedule views.
5. Edit individual saved shifts through Assigned shifts. Editing, archiving or restoring a planning rule never silently changes those shifts. Retained history explains what changed and why.

The range controls support day, week, month, year and an explicit date range of up to 366 calendar days. Month/year summaries can be narrowed to review specific dates. Use smaller periods if a result exceeds its displayed capacity limit; the server rejects oversized results instead of silently dropping rows.

## Upload a schedule

Use **Upload schedule** to choose CSV, XLSX, DOCX or a PDF containing selectable text. The reader runs locally on the server, with no external AI upload. Original files are not retained. Scanned PDFs, photos and legacy `.doc` files require a text version or manual entry.

Choose the sheet/page, header and column mappings. Review employee identities, jobs, dates, start/end times and included rows. Names and emails must match the current directory unambiguously; users can correct each row before continuing. Job assignments and communities remain authoritative. A document cannot create a new employee or grant a new job assignment implicitly.

Local times use the organization's timezone, not the phone's timezone. Choose the document's date convention explicitly when needed. Ambiguous repeated daylight-saving times need an explicit UTC offset; nonexistent local times must be corrected. Overnight rows need their correct ending date. Source text is evidence for review, not a trusted scheduling command.

The editable draft becomes canonical CSV and uses the existing **Preview → Apply** import workflow. The preview creates no shifts. It checks conflicts, current identity/job assignments and community access. Apply is atomic; after an uncertain response, retry the same preview instead of starting another import. Canonical CSV and its review receipt are retained; keep the original uploaded document separately if needed.

## Limits and calendar behavior

Planning allows 200 coverage rules and 200 hours targets per organization, up to 5,000 expanded coverage occurrences, 200 eligible employees, 20,000 source schedule rows and 1,000 generated open slots per review. Archived definitions and history remain retained. A jobs CSV is limited to 100 rows; a schedules CSV can contain 1,000 rows, within the existing 200,000-character/800,000-byte input bounds.

Document inspection accepts at most 2 MiB, with a 15-second isolated-worker deadline, 192 MiB V8 worker heap and bounded extracted rows/cells. The V8 heap setting is not a total-process memory guarantee. Limits include 20 PDF pages, eight Excel sheets, 2,000 extracted rows and 20,000 cells. File format validation and existing ZIP/XML expansion controls remain enforced. An unreadable or oversized file returns a recoverable error without creating shifts. Long canonical rows can require fewer than 1,000 shifts to fit the retained CSV byte limit.

Monthly dates 29–31 and yearly February 29 skip months/years where the date does not exist; they do not silently move to a different day. Ambiguous or nonexistent daylight-saving coverage windows block generation and require a corrected rule or an explicit individual shift. Overlap validation covers the selected expanded period, not an unlimited future.

Coverage windows belong to their start date and retain their full overnight duration. Job hours targets instead clip scheduled time to the calendar period. Coverage is elapsed time times concurrent staffing. Exact durations remain microsecond strings internally; the interface rounds only human-readable aggregate displays. A scheduled shift is limited to 24 elapsed hours by the existing service. A wall-clock window spanning a daylight-saving transition can have a different elapsed duration.

## Authority and evidence

Developer, owner, administrator and scoped manager password sessions can manage planning. Managers need explicit access to the job's community. Finance/employee/PIN sessions do not acquire planning-write authority. Ordinary employees retain their own schedule view. Current session, setup, enrolled MFA and scope checks apply on the server, including before returning results or committing writes.

Definition edits require the current version and retain before/after history. A generation preview belongs to its creator and expires after 30 minutes. Changed rules, targets, employees, assignments or relevant schedules require a fresh review. Selection applies through the existing schedule service in one transaction with schedule history, audit and an immutable retry receipt. Different payloads cannot reuse a successful command. Preview evidence has an 8 MiB response limit and a 64 MiB/5,000-preview organization retention limit; capacity errors preserve existing history.

Planning history keeps referenced jobs' communities fixed, even after a definition moves to a different job. The restricted runtime cannot delete planning definitions or alter/delete retained history, previews and receipts. Additive migrations 045–046 implement planning storage and the schedule-import row limit; the web process never runs them.

Actual local, browser and deployed verification is recorded in STATUS and VALIDATION. These workflows do not establish legal overtime, wage rules, automatic staffing optimization, OCR support or payroll-provider integration.

Reader implementation references: [PDF.js byte/text APIs](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), [Node text extraction example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs), [Word document structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document), and [Luxon repeated-time offsets](https://moment.github.io/luxon/api-docs/index.html#datetimegetpossibleoffsets). PDF.js is pinned to 6.3.289; the Node 22 runtime requires version 22.13 or newer.
