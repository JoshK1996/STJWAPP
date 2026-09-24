import type ExcelJS from "exceljs";
import type { SnapshotData } from "../shared/report-snapshots";
import { formatReportValue, readableReportColumns, reportColumnLabel } from "../shared/report-presentation";
import { sourceCatalog } from "../shared/report-library";
import { reportSheetText } from "./report-sheet-layout";

/** Presentation sheet only; exact Data and source evidence remain untouched. */
export function addReadableSnapshotSheet(book: ExcelJS.stream.xlsx.WorkbookWriter, data: SnapshotData, safeText: (value: string) => string) {
  const columns = readableReportColumns(data.columns), span = Math.max(4, columns.length);
  const sheet = book.addWorksheet("Report", {
    views: [{ state: "frozen", ySplit: 6, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: columns.length > 5 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "6:6" },
    headerFooter: { oddFooter: "&LSTJW · Reviewed report&RPg &P of &N" },
  });
  sheet.columns = Array.from({ length: span }, (_, index) => ({ width: columns[index]?.key.endsWith("_at") ? 34 : columns[index]?.key.includes("name") || columns[index]?.key.includes("note") || columns[index]?.key.includes("label") ? 34 : 24 }));
  const bannerWidth = sheet.columns.reduce((sum, column) => sum + (column.width ?? 24), 0);
  const banner = (rowNumber: number, text: string, size: number, height: number, fill: string, color: string) => {
    sheet.mergeCells(rowNumber, 1, rowNumber, span);
    const layout = reportSheetText(text, bannerWidth, size, height, 360, "Source JSON");
    const row = sheet.getRow(rowNumber); row.getCell(1).value = safeText(layout.text);
    row.font = { name: "Aptos", size, bold: rowNumber === 1, color: { argb: color } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    row.alignment = { vertical: "middle", wrapText: true }; row.height = layout.height; row.commit();
  };
  banner(1, data.name, 22, 44, "FF17355E", "FFFFFFFF");
  banner(2, `${sourceCatalog[data.source].label} · ${data.rowCount.toLocaleString("en-US")} rows · ${data.timezone}`, 11, 30, "FFE8F0FD", "FF17355E");
  const range = data.range ? `${formatReportValue("date", data.range.from, { timezone: data.timezone })} – ${formatReportValue("date", data.range.to, { timezone: data.timezone })} · ` : "";
  banner(3, `${range}Data as of ${formatReportValue("captured_at", data.asOf, { timezone: data.timezone })}`, 10, 32, "FFF4F7FC", "FF365579");
  banner(4, data.description || "A readable presentation of your saved report.", 11, 36, "FFFFFFFF", "FF17355E");
  banner(5, `Display uses 2 decimals. Long text may be abbreviated and marked; full values remain in Data and full descriptions/notices in Source JSON. Exact values and source evidence are in Data, Provenance and Source JSON. ${data.notice}`, 10, 64, "FFFDF2D8", "FF6A4B13");
  const headings = columns.map((column, index) => reportSheetText(reportColumnLabel(column), sheet.columns[index].width ?? 24, 11, 34, 120, "Data"));
  const heading = sheet.addRow(headings.map(value => safeText(value.text)));
  heading.height = Math.max(...headings.map(value => value.height)); heading.font = { name: "Aptos", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF246C91" } };
  heading.alignment = { vertical: "middle", wrapText: true }; heading.commit();
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: Math.max(6, data.rows.length + 6), column: columns.length } };
  for (const [index, source] of data.rows.entries()) {
    const values = columns.map((column, i) => reportSheetText(formatReportValue(column.key, source[column.key], { timezone: data.timezone, source: data.source, currency: "currency" in data.provenance ? data.provenance.currency : undefined, row: source }), sheet.columns[i].width ?? 24, 11, 30, 300, "Data"));
    const row = sheet.addRow(values.map(value => safeText(value.text)));
    row.height = Math.max(...values.map(value => value.height));
    row.font = { name: "Aptos", size: 11, color: { argb: "FF183153" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? "FFF0F6FC" : "FFFFFFFF" } };
    row.alignment = { vertical: "top", wrapText: true };
    columns.forEach((column, i) => { if (/(?:amount|percentage|_microseconds|_ms|count)$/.test(column.key)) row.getCell(i + 1).alignment = { horizontal: "right", vertical: "top", wrapText: true }; });
    row.commit();
  }
  if (!data.rows.length) { const empty = sheet.addRow(["No matching records in this saved report."]); empty.font = { name: "Aptos", italic: true, color: { argb: "FF365579" } }; empty.height = 30; empty.commit(); }
  sheet.commit();
}
