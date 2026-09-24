import { parse } from "csv-parse/sync";
import {
  financeAmount,
  financeColumns,
  financeLine,
  type FinanceLine,
  type FinanceSnapshot,
} from "../shared/finance";
import { Problem, requireCondition } from "./security";

const SCALE = 10_000n;
export function amountUnits(raw: string) {
  const value = financeAmount.parse(raw),
    negative = value.startsWith("-"),
    [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}
export function amountText(units: bigint) {
  const negative = units < 0n,
    absolute = negative ? -units : units,
    whole = absolute / SCALE;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return (
    (negative ? "-" : "") + whole.toString() + (fraction ? "." + fraction : "")
  );
}
// A 500-line report can sum to 15 whole digits. Source inputs retain their
// narrower 12-digit limit; sorting aggregates never passes through Number.
export function reportAmountUnits(raw: string) {
  requireCondition(
    /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(raw),
    400,
    "Invalid report amount.",
  );
  const negative = raw.startsWith("-"),
    [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}
export function parseFinanceCsv(csv: string) {
  requireCondition(
    csv.length <= 400000,
    400,
    "The source exceeds the 400,000-character limit.",
  );
  let data: string[][];
  try {
    data = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 20000,
    }) as string[][];
  } catch {
    throw new Problem(
      400,
      "The CSV could not be parsed. Use the financial report template and consistent columns.",
    );
  }
  requireCondition(
    data.length >= 2 && data.length <= 501,
    400,
    "Import between 1 and 500 report lines.",
  );
  const headers = data[0].map((x) => x.trim());
  requireCondition(
    headers.length === financeColumns.length &&
      new Set(headers).size === headers.length &&
      financeColumns.every((x) => headers.includes(x)),
    400,
    "Use exactly the six financial template column names.",
  );
  const codes = new Set<string>();
  return data.slice(1).map((row, index) => {
    requireCondition(
      row.length === headers.length,
      400,
      "Row " + (index + 2) + " has a different number of columns.",
    );
    const parsed = financeLine.safeParse(
      Object.fromEntries(headers.map((key, i) => [key, row[i]])),
    );
    requireCondition(
      parsed.success,
      400,
      "Row " +
        (index + 2) +
        ": " +
        (parsed.error?.issues
          .map((x) => x.path.join(".") + " " + x.message)
          .join("; ") ?? "Invalid line."),
    );
    requireCondition(
      !codes.has(parsed.data.lineCode),
      400,
      "Row " + (index + 2) + " repeats line code " + parsed.data.lineCode + ".",
    );
    codes.add(parsed.data.lineCode);
    return {
      ...parsed.data,
      amount: amountText(amountUnits(parsed.data.amount)),
    };
  });
}
export function financialTotals(lines: FinanceLine[]) {
  let detail = 0n;
  for (const line of lines)
    if (line.rowKind === "detail") detail += amountUnits(line.amount);
  return {
    detailSum: amountText(detail),
    details: lines.filter((x) => x.rowKind === "detail").length,
    subtotals: lines.filter((x) => x.rowKind === "subtotal").length,
    totals: lines.filter((x) => x.rowKind === "total").length,
  };
}
function percentage(delta: bigint, baseline: bigint) {
  if (baseline <= 0n) return null;
  const abs = delta < 0n ? -delta : delta,
    scaled = (abs * 10_000n + baseline / 2n) / baseline;
  return (
    (delta < 0n && scaled !== 0n ? "-" : "") +
    (scaled / 100n).toString() +
    "." +
    (scaled % 100n).toString().padStart(2, "0")
  );
}
export function compareFinancialReports(
  left: FinanceSnapshot,
  right: FinanceSnapshot,
  differentPeriodsReviewed = false,
) {
  requireCondition(
    left.metadata.currency === right.metadata.currency,
    400,
    "Choose reports in the same currency.",
  );
  requireCondition(
    left.metadata.basis === right.metadata.basis,
    400,
    "Choose reports with the same reporting basis.",
  );
  const differentPeriods =
    left.metadata.from !== right.metadata.from ||
    left.metadata.to !== right.metadata.to;
  requireCondition(
    !differentPeriods || differentPeriodsReviewed,
    400,
    "Review and acknowledge the different reporting periods.",
  );
  const before = new Map(left.lines.map((x) => [x.lineCode, x])),
    after = new Map(right.lines.map((x) => [x.lineCode, x]));
  const codes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const rows = codes.map((lineCode) => {
    const a = before.get(lineCode),
      b = after.get(lineCode),
      compatible = !!a && !!b && a.rowKind === b.rowKind;
    const delta = compatible
      ? amountUnits(b.amount) - amountUnits(a.amount)
      : null;
    return {
      lineCode,
      leftLabel: a?.lineLabel ?? null,
      rightLabel: b?.lineLabel ?? null,
      leftGroup: a?.group ?? null,
      rightGroup: b?.group ?? null,
      leftKind: a?.rowKind ?? null,
      rightKind: b?.rowKind ?? null,
      leftAmount: a?.amount ?? null,
      rightAmount: b?.amount ?? null,
      delta: delta === null ? null : amountText(delta),
      percent:
        delta === null ? null : percentage(delta, amountUnits(a!.amount)),
      status: !a
        ? "missing_left"
        : !b
          ? "missing_right"
          : !compatible
            ? "kind_changed"
            : "matched",
      labelChanged: !!a && !!b && a.lineLabel !== b.lineLabel,
      groupChanged: !!a && !!b && a.group !== b.group,
    };
  });
  return {
    rows,
    currency: left.metadata.currency,
    differentPeriods,
    leftTotals: financialTotals(left.lines),
    rightTotals: financialTotals(right.lines),
    matched: rows.filter((x) => x.status === "matched").length,
    unmatched: rows.filter((x) => x.status !== "matched").length,
    notice:
      "Difference = right minus left. Missing lines are not zero. Percent change is shown only for a positive left amount. Detail sums exclude imported subtotals and totals; they are not inferred profit or account balances.",
  };
}
