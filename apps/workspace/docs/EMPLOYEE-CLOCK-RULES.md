# Employee clock rules

An authorized manager can limit when an individual employee may clock in and out. Open **Employees & jobs**, choose the employee, open **Clock setting**, and turn on **Limit clock-in and clock-out times**. Rules are per employee. An employee with no rules behaves exactly as before.

## What a rule can say

Each weekday (Monday to Sunday) has:

| Field | Meaning |
| --- | --- |
| Can work | Off means the employee cannot clock in that day. |
| Clock in from | Earliest time work can begin. An earlier tap is not refused: it saves a pending start (see below). |
| Clock in by | Latest time the employee can still clock in. Later taps are refused. |
| Clock out from | Earliest time the employee can clock out. Earlier clock-outs are refused. |
| Clock out by | The employee can never be on the clock past this time. An open shift is closed automatically at exactly this time. |

Leave a time blank for no limit. Times are 24-hour, entered in the organization's time zone, and must stay within one calendar day: earliest not after latest, and the latest clock-in before the latest clock-out. Overnight windows are not supported. **Copy Monday to Tuesday–Friday** and **Clear all limits** speed up weekly setup. Rules save with the existing employee clock setting and its revision, so a stale form is rejected instead of overwriting a newer change. A rule set with no restriction is stored as no rules.

## What the employee sees

- **Too early.** The employee taps Clock in before the "from" time. The app saves a pending start and says **You will be clocked in automatically at [time]**, with a Cancel start button. They can close the app; the server starts the shift at exactly the allowed time (the same durable, restart-safe processing as scheduled starts, see [SCHEDULED-CLOCK](SCHEDULED-CLOCK.md)). A second tap does not queue a second start.
- **Wrong day or too late.** The tap is refused with a plain explanation, for example "Clocking in is not allowed on Sundays" or "The clock-in window closed at 10:00 AM". No time is recorded.
- **Too early to leave.** Clocking out before the "clock out from" time is refused with the allowed time. Starting a break or changing jobs after the work day has ended is also refused.
- **Past the clock-out limit.** A shift still open at the limit is closed automatically at the limit, never at the later processing time. If the employee taps Clock out afterwards, the shift is still recorded as ending at the limit. A forgotten shift is closed at the limit of the day it began, even if discovered the next day.
- Today's limits appear in plain words on the clock card.

## Boundaries

- Clock-out rules follow the weekday on which the shift began. A "Can work" off day blocks only clocking in; it never traps someone who is already on the clock.
- If a rule is changed so its clock-out limit falls before the current segment began, the shift is not backdated; the employee clocks out normally and a manager can review it.
- Manager time-card corrections, missed clock-out fixes and approved adjustments are **not** limited by these rules. They are the way to correct a shift the rules ended early or to record legitimately different hours. The audit trail records every automatic start, automatic clock-out and rule change (`clock.preclock_*`, `clock.rule_auto_clock_out`, `staff.clock_policy_changed` with before and after).
- Changing an employee's rules cancels their pending start, as changing No early clock-in always has. A pending start also becomes blocked, rather than executing, if the rules changed or were removed before it ran.
- Rules do not define pay, overtime or breaks. They do not collect location.
- The automatic clock-out check runs in the same background worker as pending starts, about once per second. Like pending starts, this is bounded processing, not a real-time guarantee, and deployment monitoring remains necessary.

## API

`GET/PUT /api/staff/:id/clock-policy` now carries `rules`. `PUT` accepts `{noEarlyClockIn, rules?, expectedVersion}`: omit `rules` to keep the saved rules, send `null` to clear them. `GET /api/clock` adds `preclock.todayRules` (plain-language summary or `null`), and pending-start records gain `source` (`schedule` or `rule`) with nullable schedule fields. See `docs/openapi.json`.

## Data

Migration 049 adds nullable `clock_employee_policies.rules` (jsonb, seven-day structure checked) and lets `clock_intents` be rule-based: `source` column and nullable schedule reference, with a check that a schedule start has a schedule and a rule start has none. Existing rows and employees are unchanged. No new table, trigger or runtime privilege is required.

## Verification

`tests/clock-rules.test.ts` covers rule validation; clock-in and clock-out decisions in organization-local time; revisioned saving, omission and clearing; early tap, replay, idempotent processing and the exact start time; cancellation and blocked execution after a rule change; refusals outside the allowed day or window; clock-out refusal and exact-limit capping, including a forgotten shift discovered the next day; and the background sweep closing only shifts that have rules with a clock-out limit. These use isolated PGlite databases with a deterministic database-time fixture. They do not establish multi-connection PostgreSQL behavior, physical-device behavior or hosted acceptance.
