# ADR0012: Job coverage, hours targets and reviewed schedule documents

Date: September 25, 2026. Status: accepted; deployment status is tracked separately.

## Context

The owner requested simple recurring job staffing, day/week/month/year hours parameters, useful filters/visuals and document uploads. They explicitly selected both staffing coverage and separate hours targets, and a mixture of spreadsheet/document sources. Existing saved employee shifts already drive scheduled-hour allowances and durable scheduled clock starts; those semantics must be preserved.

## Decision

Add effective-dated, versioned job coverage rules and independent job hours targets. Use deterministic local-calendar expansion and exact elapsed-time arithmetic. Retain explicit overnight and DST decisions, rather than guessing. Compare staffing through interval coverage, including partial gaps; show rule conflicts instead of inventing a combined requirement. Full calendar-period hours targets remain separate from employee allowances and are labeled when only partly selected.

Generate an actor-owned immutable preview. Humans select eligible employees individually or with explicit bulk choices. Validate the current source and save selected shifts atomically through the existing schedule service. Rules never rewrite saved shifts. Preserve definition history, audits, stale-version rejection and command-bound retry receipts. Enforce current management password authority and explicit community scope throughout.

Read CSV/XLSX/text-PDF/DOCX locally in bounded workers. Present editable mappings and rows before the existing canonical CSV preview/apply pipeline. Uploaded content is not sent to AI, and original document bytes are not retained. Unsupported scans and ambiguous identities/times require correction. The document reader is not an account-creation or job-assignment authority.

Use the existing restrained deployment model: additive migrations, reviewed exact source, separate privileged maintenance dry run and commit, then restricted-runtime deployment. Retained planning evidence cannot be edited or deleted by the web runtime. No customer credentials or records serve as test fixtures.

## Consequences and gates

Users gain direct entry from jobs/employees, recurring coverage and reviewed bulk scheduling without changing recorded work. Capacity bounds, unsupported formats, calendar skips and partial targets are visible limitations. The system is not a staffing optimizer, OCR service or wage-policy engine.

Verification must cover scope/session changes, stale preview/version/retry behavior, transactional audit rollback, employee overlap, year/weekly boundaries, DST, partial coverage, document resource limits and meaningful 1,000-shift operation. Desktop/narrow-screen browser checks must use synthetic normal authentication. Public hosted checks remain distinct from authenticated local checks. Record actual results in STATUS/VALIDATION rather than treating this decision as proof of deployment.

Development uses Jev only for compact advisory source judgments, with independent source verification; deterministic code owns parsing, matching, calculation and actions. No new shipped AI model or confidence threshold is introduced. This division follows the TypeSafe [typed tool-routing guidance](https://docs.typesafe.ai/cookbooks/skill_suggestion); CLI receipts remain private operational evidence.
