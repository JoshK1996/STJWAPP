import { test } from "node:test";
import assert from "node:assert/strict";
import { reportSheetText } from "../server/report-sheet-layout";

test("long banners expand to their explicit wrapped line count within Excel's row-height bound", () => {
  const title = reportSheetText("W".repeat(100), 106, 22, 44, 360, "Source JSON");
  assert.ok(title.height > 44);
  assert.ok(title.height <= 360);
  assert.equal(title.abbreviated, false);
  assert.equal(title.text.replaceAll("\n", ""), "W".repeat(100));
  const description = reportSheetText("A complete synthetic report description. ".repeat(12), 106, 11, 36, 360, "Source JSON");
  assert.ok(description.height > 36);
  assert.equal(description.abbreviated, false);
});
test("very long or multiline cells are visibly abbreviated and point to the untouched source sheet", () => {
  for (const text of ["W".repeat(32000), "A short line\n".repeat(100), "👨‍👩‍👧‍👦".repeat(1000)]) {
    const result = reportSheetText(text, 24, 11, 30, 300, "Data");
    assert.equal(result.abbreviated, true);
    assert.ok(result.height <= 300);
    assert.ok(result.text.replaceAll("\n", " ").includes("[full text: Data]"));
    assert.equal(result.lines, result.text.split("\n").length);
    assert.ok(result.lines * 16 + 14 <= result.height);
    assert.ok(!/\uFFFD/.test(result.text));
  }
});
test("readable cells use explicit newline spacing rather than fixed-height silent clipping", () => {
  const text = "Teacher meeting\nArrival supervision\nClassroom instruction";
  const result = reportSheetText(text, 34, 11, 30, 300, "Data");
  assert.equal(result.abbreviated, false);
  assert.ok(result.lines >= 3);
  assert.ok(result.height >= 3 * 16 + 14);
});
