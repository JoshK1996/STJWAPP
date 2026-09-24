import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReportDecimal, formatReportHours, formatReportValue, readableReportColumns, readableReportCsv, reportColumnLabel, reportFilename } from "../shared/report-presentation";

test("display rounding stays exact above safe integer range and carries half-up without negative zero", () => {
  assert.equal(formatReportDecimal("9007199254740993.9950"), "9,007,199,254,740,994.00");
  assert.equal(formatReportDecimal("-12.345"), "-12.35");
  assert.equal(formatReportDecimal("-0.0001"), "0.00");
  assert.equal(formatReportDecimal("0.12505", 4), "0.1251");
  assert.equal(formatReportDecimal("0000123", 2), "123.00");
  assert.equal(formatReportDecimal("not an amount"), "not an amount");
});
test("duration display aggregates no source records and rounds only the provided integer total", () => {
  assert.equal(formatReportHours("3600000001"), "1.00");
  assert.equal(formatReportHours("18000000"), "0.01");
  assert.equal(formatReportHours("-17999999"), "0.00");
  assert.equal(formatReportHours("9007199254740993"), "2,501,999.79");
  assert.equal(formatReportValue("duration_ms", 3600001, { timezone: "UTC" }), "1.00");
});
test("readable dates distinguish fall DST offsets and do not shift date-only values", () => {
  const context = { timezone: "America/New_York" };
  assert.equal(formatReportValue("started_at", "2026-11-01T05:30:00.000001Z", context), "Nov 1, 2026 1:30 AM EDT");
  assert.equal(formatReportValue("started_at", "2026-11-01T06:30:00.000001Z", context), "Nov 1, 2026 1:30 AM EST");
  assert.equal(formatReportValue("starts_on", "2026-01-01", context), "Jan 1, 2026");
  assert.equal(formatReportValue("starts_on", "2026-02-30", context), "2026-02-30");
});
test("presentation keeps textual numbers names nulls booleans and explicit currency meaning", () => {
  assert.equal(formatReportValue("student_number", "000123", { timezone: "UTC" }), "000123");
  assert.equal(formatReportValue("amount", "1234.5678", { timezone: "UTC", row: { currency: "USD" } }), "USD 1,234.57");
  assert.equal(formatReportValue("amount", "1234.5678", { timezone: "UTC", row: { currency: "USD" }, decimals: 4 }), "USD 1,234.5678");
  assert.equal(formatReportValue("kind", "unpaid_break", { timezone: "UTC" }), "Unpaid Break");
  assert.equal(formatReportValue("active", false, { timezone: "UTC" }), "No");
  assert.equal(formatReportValue("ended_at", null, { timezone: "UTC" }), "—");
});
test("reader columns hide technical identifiers while preserving deliberate all-ID layouts and student numbers", () => {
  const columns = [{ key: "employee_name", label: "Employee" }, { key: "id", label: "ID" }, { key: "student_number", label: "Student number" }, { key: "record_version", label: "Version" }];
  assert.deepEqual(readableReportColumns(columns).map(c => c.key), ["employee_name", "student_number"]);
  assert.deepEqual(readableReportColumns([columns[1]]), [columns[1]]);
  assert.equal(columns.length, 4);
  assert.equal(reportColumnLabel({ key: "duration_microseconds", label: "Duration in range (microseconds)" }), "Duration in range (hours)");
});
test("readable CSV retains ordered readable headers, shields spreadsheet formulas and leaves exact evidence unchanged", () => {
  const data = { columns: [{ key: "employee_name", label: "Employee" }, { key: "id", label: "Internal ID" }, { key: "duration_microseconds", label: "Time (microseconds)" }], rows: [{ employee_name: " =SUM(A1:A2)", id: "internal-id", duration_microseconds: "3600000001" }], timezone: "UTC" };
  const before = JSON.stringify(data), csv = readableReportCsv(data);
  assert.ok(csv.startsWith('\ufeff"Employee","Time (hours)"\r\n'));
  assert.ok(csv.includes('"\' =SUM(A1:A2)","1.00"'));
  assert.ok(!csv.includes("internal-id"));
  assert.ok(readableReportCsv(data, { includeTechnical: true, decimals: 4 }).includes('"internal-id","1.0000"'));
  assert.equal(JSON.stringify(data), before);
  assert.equal(reportFilename("School / Payroll: September", "csv"), "School-Payroll-September.csv");
  assert.equal(reportFilename("../", "xlsx"), "STJW-report.xlsx");
});
