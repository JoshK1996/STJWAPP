# 0016: Weekly employee clock plans

Date: November 2, 2026
Status: Accepted for implementation; deployment is recorded separately.

## Context

The former editor presented two poorly distinguished switches and twenty-eight time inputs. Weekly limits had no job selection, and an early rule-based start could bypass the matching-schedule option. The owner requested a complete usable redesign and live delivery.

## Decision

Use an explicit flexible/weekly mode, a seven-day selector, one day editor, a readable full-week preview and selected-day copying. Separate the optional matching-shift requirement from weekly limits. Explain automatic starts/ends beside their controls and show the organization time zone. Keep unsaved-change guarding, pending-write tracking, generation isolation, explicit revision conflict reload and named invalid-day feedback.

Extract the editor from pending-clock display into EmployeeClockPolicy; keep pure setup/copy/format/validation helpers in shared/clock-rule-editor. Add optional per-day jobIds to the existing strict rule schema: null/omitted allows every assigned job; a nonempty selection restricts clock-in and job changes. All allowed jobs on a given day share that day's time limits. This additive JSON shape needs no new migration and preserves existing policies. The service validates active job assignments under employee/job locks; selections never grant an assignment or account permission.

When both scheduling options apply, intersect their windows, preserve the schedule identity/version on the pending start and recheck the schedule, policy, job assignment, allowed start and account authority before execution. Existing exits, exact receipt replay, timestamps and transactional audits remain protected. Staff hierarchy and scoped-manager authorization are unchanged.

## Consequences

The week is understandable before saving; changing mode has no effect until saved. New drafts explicitly allow weekdays and block weekends, without assuming working hours. Existing saved plans retain their values. Flexible mode does not turn off the separately chosen schedule requirement. Selected jobs do not automatically expand to future assignments. A same-day plan has one time window; overnight and separate per-job windows remain outside this editor.

## Verification and rollout

Use synthetic normal authentication and changed-code tests for job validation/scope, revoked sessions, competing/stale saves, clock entry/switch/exit, schedule intersections, date/DST boundaries and day copying. Inspect desktop and phone screenshots including dark/large-text/reduced-motion preferences. Run the production build and publication guard; CI owns the complete configured suite. Merge and stage exact reviewed source; use separate PostgreSQL maintenance and Railway deployment, preserving runtime privileges and customer records. Record actual release evidence in STATUS/VALIDATION/DEPLOYMENT.
