import { DateTime } from "luxon";

export type ReportPresentation = { timezone: string; source?: string; currency?: unknown; row?: Record<string, unknown>; decimals?: 2 | 4 };
export type PresentationColumn = { key: string; label: string };
const groupDigits = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Display only. Round the final decimal using integer arithmetic; never mutate source values. */
export function formatReportDecimal(value: unknown, places: number = 2): string {
  const text = String(value), match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || !Number.isInteger(places) || places < 0 || places > 6) return text;
  const fraction = match[3] ?? "", scale = 10n ** BigInt(places);
  let magnitude = BigInt(match[2]) * scale + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
  if (Number(fraction[places] ?? "0") >= 5) magnitude++;
  return `${match[1] === "-" && magnitude !== 0n ? "-" : ""}${groupDigits(String(magnitude / scale))}${places ? "." + String(magnitude % scale).padStart(places, "0") : ""}`;
}

export function formatReportHours(microseconds: string, places: 2 | 4 = 2): string {
  if (!/^-?\d+$/.test(microseconds)) return microseconds;
  const amount = BigInt(microseconds), absolute = amount < 0n ? -amount : amount, scale = 10n ** BigInt(places);
  const rounded = (absolute * scale + 1_800_000_000n) / 3_600_000_000n;
  return `${amount < 0n && rounded > 0n ? "-" : ""}${groupDigits(String(rounded / scale))}.${String(rounded % scale).padStart(places, "0")}`;
}

export function reportColumnIsTechnical(key: string): boolean {
  return key === "id" || key.endsWith("_id") || /(?:^|_)(?:version|revision|hash)$/.test(key);
}
export function readableReportColumns<T extends PresentationColumn>(columns: T[]): T[] {
  const readable = columns.filter(column => !reportColumnIsTechnical(column.key));
  return readable.length ? readable : columns;
}
export function reportColumnLabel(column: PresentationColumn): string {
  return column.label.replace(/\((?:microseconds|milliseconds)\)/gi, "(hours)").replace(/\s*\(UTC\)/g, "");
}
const dateKeys = new Set(["date", "starts_on", "ends_on", "period_from", "period_through", "start_date", "end_date"]);
const numericKeys = new Set(["amount", "percentage", "average_percentage", "total", "work_hours", "break_hours", "total_hours"]);
const enumKeys = new Set(["kind", "row_kind", "basis", "status", "book_status", "category", "identity_method"]);

export function formatReportValue(key: string, value: unknown, options: ReportPresentation): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = String(value), places = options.decimals ?? 2;
  if (key.endsWith("_microseconds") && /^-?\d+$/.test(text)) return formatReportHours(text, places);
  if (key.endsWith("_ms") && /^-?\d+$/.test(text)) return formatReportHours(String(BigInt(text) * 1000n), places);
  if (dateKeys.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = DateTime.fromISO(text, { zone: "UTC" });
    return parsed.isValid ? parsed.setLocale("en-US").toFormat("LLL d, yyyy") : text;
  }
  if (key.endsWith("_at") && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = DateTime.fromISO(text, { zone: options.timezone });
    return parsed.isValid ? parsed.setLocale("en-US").toFormat("LLL d, yyyy h:mm a ZZZZ") : text;
  }
  if (numericKeys.has(key) && /^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const formatted = formatReportDecimal(text, places);
    const currency = options.row?.currency ?? options.currency;
    if (key === "amount" && typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) return `${currency} ${formatted}`;
    return key.includes("percentage") ? `${formatted}%` : formatted;
  }
  if (enumKeys.has(key) && /^[a-z]+(?:_[a-z]+)*$/.test(text)) return text.split("_").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
  if (typeof value === "number" && Number.isSafeInteger(value)) return groupDigits(text);
  return text;
}

export function reportFilename(name: string, extension: "csv" | "xlsx" | "json"): string {
  const stem = name.normalize("NFKD").replace(/[^a-zA-Z0-9 -]/g, "").trim().replace(/[ -]+/g, "-").slice(0, 80).replace(/-+$/, "");
  return `${stem || "STJW-report"}.${extension}`;
}

/** Spreadsheet-safe presentation CSV. Original source/export contracts remain separate. */
export function readableReportCsv(data: { columns: PresentationColumn[]; rows: Record<string, unknown>[]; timezone: string; source?: string; provenance?: Record<string, unknown> }, options: { decimals?: 2 | 4; includeTechnical?: boolean } = {}): string {
  const columns = options.includeTechnical ? data.columns : readableReportColumns(data.columns);
  const cell = (text: string) => `"${(/^[\s]*[=+\-@]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
  const rows = data.rows.map(row => columns.map(column => cell(formatReportValue(column.key, row[column.key], { timezone: data.timezone, source: data.source, currency: data.provenance?.currency, row, decimals: options.decimals }))).join(","));
  return "\ufeff" + [columns.map(column => cell(reportColumnLabel(column))).join(","), ...rows].join("\r\n") + "\r\n";
}
