import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountUnits,
  amountText,
  parseFinanceCsv,
  financialTotals,
  compareFinancialReports,
} from "../server/finance-engine";
import type { FinanceLine, FinanceSnapshot } from "../shared/finance";
const line = (
  lineCode: string,
  amount: string,
  rowKind: FinanceLine["rowKind"] = "detail",
): FinanceLine => ({
  lineCode,
  lineLabel: lineCode,
  group: "Synthetic group",
  rowKind,
  amount,
  note: "",
});
const snapshot = (
  lines: FinanceLine[],
  changes: object = {},
): FinanceSnapshot => ({
  metadata: {
    title: "Synthetic report",
    sourceName: "Synthetic fixture",
    currency: "USD",
    kind: "actual",
    basis: "period_activity",
    from: "2026-01-01",
    to: "2026-01-31",
    note: "",
    ...changes,
  },
  lines,
  sourceHash: "a".repeat(64),
});
test("financial amounts preserve decimal precision, signed values and large exact sums", () => {
  assert.equal(amountText(amountUnits("0.1") + amountUnits("0.2")), "0.3");
  assert.equal(amountText(amountUnits("-0.0000")), "0");
  assert.throws(() => amountUnits("-000"));
  assert.equal(
    amountText(amountUnits("999999999999.9999") * 500n),
    "499999999999999.95",
  );
  assert.equal(
    amountText(amountUnits("-1.2501") + amountUnits("0.0001")),
    "-1.25",
  );
  assert.throws(() => amountUnits("1000000000000"));
  assert.throws(() => amountUnits("1.00001"));
});
test("financial CSV requires explicit line kinds and unique exact codes without spreadsheet-number coercion", () => {
  const header = "lineCode,lineLabel,group,rowKind,amount,note\n";
  const parsed = parseFinanceCsv(
    header + "A,Revenue,General,detail,10.1200,\nB,Total,General,total,10.12,",
  );
  assert.equal(parsed[0].amount, "10.12");
  assert.deepEqual(financialTotals(parsed), {
    detailSum: "10.12",
    details: 1,
    subtotals: 0,
    totals: 1,
  });
  assert.throws(
    () => parseFinanceCsv(header + "A,A,G,detail,1,\nA,B,G,detail,2,"),
    /repeats/,
  );
  assert.throws(() => parseFinanceCsv(header + "A,A,G,detail,1e3,"), /decimal/);
  assert.throws(() => parseFinanceCsv(header + "A,A,G,,1,"), /rowKind/);
});
test("financial comparison keeps missing values and changed row kinds out of deltas", () => {
  const result = compareFinancialReports(
    snapshot([line("A", "10"), line("B", "7"), line("C", "3")]),
    snapshot([line("A", "12.5"), line("C", "3", "total"), line("D", "9")]),
  );
  assert.equal(result.rows[0].delta, "2.5");
  assert.equal(result.rows[0].percent, "25.00");
  assert.equal(result.rows[1].rightAmount, null);
  assert.equal(result.rows[1].delta, null);
  assert.equal(result.rows[2].status, "kind_changed");
  assert.equal(result.rows[2].delta, null);
  assert.equal(result.rows[3].status, "missing_left");
});
test("financial comparison requires compatible units of measure and explicit period acknowledgment", () => {
  const left = snapshot([line("A", "0"), line("B", "-2")]),
    right = snapshot([line("A", "1"), line("B", "-1")]);
  assert.ok(
    compareFinancialReports(left, right).rows.every((x) => x.percent === null),
  );
  assert.throws(
    () => compareFinancialReports(left, snapshot([], { currency: "CAD" })),
    /currency/,
  );
  assert.throws(
    () =>
      compareFinancialReports(left, snapshot([], { basis: "as_of_balance" })),
    /basis/,
  );
  assert.throws(
    () =>
      compareFinancialReports(
        left,
        snapshot([], { from: "2026-02-01", to: "2026-02-28" }),
      ),
    /different reporting periods/,
  );
  assert.equal(
    compareFinancialReports(
      left,
      snapshot([], { from: "2026-02-01", to: "2026-02-28" }),
      true,
    ).differentPeriods,
    true,
  );
});
