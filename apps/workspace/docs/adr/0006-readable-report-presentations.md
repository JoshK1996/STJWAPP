# ADR 0006: Human-readable presentation over exact reporting evidence

Status: accepted for implementation, September 24, 2026.

## Problem

Exports and screens expose internal identifiers, exact subsecond values and machine-oriented headings that make ordinary review difficult. People need to choose understandable columns and inspect a report before sharing it. Existing source evidence and API integrations must remain trustworthy.

## Decision

Add a deterministic presentation layer over authorized report results. UI download actions favor readable reports; explicit audit/source actions retain precise values. Presentation formats dates in the report time zone, groups digits, rounds after aggregation and labels units. Raw identities and evidence remain unchanged. Report layout controls choose supported columns, grouping, sorting and precision, with a visible preview.

New presentation options are strict and bounded. Existing machine-facing export defaults remain compatible. Snapshot Excel gains a first Report sheet with the original evidence sheets retained and an explicit export-layout version increment. Spreadsheet worker isolation, size/deadline limits, admission control, formula safety, source authorization and transactional audit publication remain in force. Downloads are suppressed when their owning account or workspace is no longer active.

Customizable financial reporting extends the current reviewed-import workflow. It does not invent accounting classifications, organizational payroll policy or a double-entry ledger. Bookkeeping, purchasing and tuition workflows remain in the accounting roadmap, rather than being represented as completed features.

## Consequences

Readable rounded rows can differ from rounded aggregate totals; reports explain this. Same-name employees remain separate and get report-local disambiguation, while exact references remain in audit evidence. A fresh download can differ from a previous live preview. Presentation preferences are currently local to the open workspace unless they are part of an existing saved report definition. Further saved-format preferences and accounting workflows can build on this boundary.

See [readable reports](../READABLE-REPORTS.md) for supported controls and [STATUS](../STATUS.md) for actual verification and deployment.
