import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarInstant, calendarLocalInput, calendarTimeOptions } from "../src/calendar-editing";

const zone = "America/New_York";
test("metadata-only calendar edits preserve exact timestamp precision and both repeated-hour occurrences", () => {
  for (const original of ["2026-06-15T14:02:37.123456Z", "2026-11-01T05:30:45.321Z", "2026-11-01T06:30:45.321Z"]) {
    const local = calendarLocalInput(original, zone), offset = original.includes("T06:30") ? "-300" : "-240";
    assert.equal(calendarInstant(local, zone, offset, original), original);
  }
});
test("calendar rejects nonexistent and invalid local times and requires an explicit offset for repeated hours", () => {
  assert.throws(() => calendarInstant("2026-03-08T02:30", zone, ""), /does not exist/);
  assert.throws(() => calendarInstant("invalid", zone, ""), /does not exist/);
  assert.equal(calendarTimeOptions("2026-03-08T02:30", zone).length, 0);
  assert.equal(calendarTimeOptions("2026-11-01T01:30", zone).length, 2);
  assert.throws(() => calendarInstant("2026-11-01T01:30", zone, ""), /occurs twice/);
  assert.equal(calendarInstant("2026-11-01T01:30", zone, "-240"), "2026-11-01T05:30:00.000Z");
  assert.equal(calendarInstant("2026-11-01T01:30", zone, "-300"), "2026-11-01T06:30:00.000Z");
});
test("changing a calendar time updates its actual instant instead of retaining the original timestamp", () => {
  assert.equal(calendarInstant("2026-06-15T10:03", zone, "", "2026-06-15T14:02:37.123Z"), "2026-06-15T14:03:00.000Z");
  assert.equal(calendarInstant("2026-11-01T01:30", zone, "-300", "2026-11-01T05:30:45.123Z"), "2026-11-01T06:30:00.000Z");
});
