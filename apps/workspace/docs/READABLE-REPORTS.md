# Readable reports and accountant handoffs

The reporting workspace separates a human-facing presentation from exact source evidence. Formatting never changes stored amounts, recorded time, permissions or payroll rules. A displayed total is rounded after aggregation, so adding rounded rows can differ from the displayed total.

## Payroll

In Payroll, choose a period, community and employee, then **Customize report & preview**. Start with Accountant summary, Job breakdown or Detailed review. Adjust the title, row grouping, sorting, included columns and 2/3/4 decimal places. A preview shows the first eight rows and identifies the full row count. All selected records are exported; the separate employee-search box does not restrict exports.

The readable Excel workbook opens with a styled report overview and a focused employee or employee/job table. It includes names, local reporting dates, the time zone, capture time, column headers, appropriate number formats, filters, frozen headers and print settings. Optional audit sheets retain the previous exact workbook evidence. CSV contains one row per selected employee or employee/job, without mixed summary/detail totals that could be double counted. Source JSON retains exact data. Open records remain labeled; hours do not establish approved payroll, paid breaks, overtime or wages.

Layout settings apply while Payroll is open. Personal saved Payroll views continue to save filters; they do not save these new presentation settings. Each download obtains fresh authorized data and can differ from its earlier preview.

## Recorded time and Report library

Hours & imports opens with readable CSV columns, local timestamps and two-decimal hours. Everyday report and All audit columns provide quick starting points. A selected-column preview precedes export. Exact audit CSV and source JSON remain explicit choices.

Report library retains reusable source/date/group/sort/column definitions. Reader essentials excludes internal reference columns. Preview controls allow readable or audit display and 2/4 decimal places. Readable CSV uses the chosen layout; original source CSV and JSON remain available. Presentation controls are temporary, while saved definitions retain their existing revision history.

Saved snapshot Excel downloads open with a styled Report sheet and retain Data, Provenance and Source JSON evidence sheets. Export format version 2 identifies this new workbook layout; it does not change the snapshot's source schema or hash. Reader views do not replace exact retained evidence.

## Finance

The financial workspace analyzes reviewed imported reports. Its report browser supports search/type/currency ordering; its report view supports column selection, line filtering and sorting. A readable CSV and printable customized view use those selections, while original source exports remain separate. Currency and reporting-period labels accompany amounts. Cash/accrual accounting method is not inferred from an activity-versus-balance period label.

This release does not establish a general ledger, bank reconciliation, accounts payable/receivable, tuition billing, payments, taxes or certified payroll. See [the accounting roadmap](FINANCE-ROADMAP.md) for the requested broader buildout. All accounting areas remain required; users should be able to configure workflows appropriate to their role and organization.

## API compatibility and access

- Existing export calls without presentation options retain exact CSV/JSON contracts. The saved-snapshot workbook explicitly advances its layout version.
- Payroll hours accepts a validated JSON `presentation` query option for CSV/XLSX, with bounded title, columns, grouping, sorting, precision and optional audit sheets. Presentation with source JSON rejects.
- Payroll comparison and workforce CSV accept `presentation=readable`; the omitted default remains exact. Workforce CSV labels its duration header as `hour` when readable.
- Report library readable export and finance view exports run through their existing current-session/source authorization and audit transactions. Presentation cannot select unauthorized sources or grant access.
- Formula-like names remain spreadsheet-safe. Exact duration arithmetic uses integers; display formatting cannot become pay policy. Deferred client downloads are checked against account ownership and component lifetime before publication.

## Verification

Regression coverage exercises once-only rounding, large/negative amounts, duplicate names, formula-like input, column selection, empty data, styled Excel XML, worker limits, route authorization and expired/revoked access. Browser acceptance uses a disposable synthetic database and ordinary password authentication. Actual test, deployment and device evidence is recorded in STATUS; physical phones and customer accounting acceptance require their own checks.

Agent evidence selection follows the progressive-disclosure pattern in [TypeSafe's skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion); Jev findings are advisory and independently checked against source and deterministic tests.
