import type ExcelJS from 'exceljs';
import type { PayrollHoursReport } from '../shared/payroll-hours';
import { buildPayrollPresentationTable, payrollPresentationHours, payrollPresentationNotice, payrollPresentationOptionsSchema, payrollPresentationRows, type PayrollPresentationOptions } from '../shared/payroll-presentation';
import { payrollPresentationContext } from './payroll-presentation';
import { xlsxText } from './report-snapshot-xlsx';
import { XlsxFailure } from './report-snapshot-xlsx-contract';

const ink = 'FF17304B', blue = 'FF245CB9', teal = 'FF087F8C', paper = 'FFF0F5FC', white = 'FFFFFFFF', line = 'FFDCE5EF', amber = 'FF9A5800';
type Sheet = ReturnType<ExcelJS.stream.xlsx.WorkbookWriter['addWorksheet']>;
const font = { name: 'Aptos', size: 11, color: { argb: ink } };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const amountFormat = (options: PayrollPresentationOptions) => '#,##0.' + '0'.repeat(options.decimalPlaces);

function number(value: string): number {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{2,4})?$/.test(value)) throw new XlsxFailure('invalid');
  const significant = value.replace('.', '').replace(/^0+/, '');
  if (significant.length > 15 || !Number.isFinite(Number(value))) throw new XlsxFailure('limit');
  return Number(value);
}
function merged(sheet: Sheet, rowNumber: number, value: string, columns: number, height: number, kind: 'title' | 'caption' | 'note' | 'section' = 'caption') {
  sheet.mergeCells(rowNumber, 1, rowNumber, columns);
  const row = sheet.getRow(rowNumber), cell = row.getCell(1); cell.value = xlsxText(value);
  cell.font = { ...font, ...(kind === 'title' ? { size: 22, bold: true, color: { argb: white } } : kind === 'section' ? { size: 12, bold: true, color: { argb: white } } : kind === 'note' ? { size: 10 } : {}) };
  cell.fill = fill(kind === 'title' || kind === 'section' ? ink : kind === 'note' ? paper : white);
  const totalWidth = Array.from({ length: columns }, (_, index) => sheet.getColumn(index + 1).width ?? 18).reduce((sum, size) => sum + size, 0);
  const size = kind === 'title' ? 22 : kind === 'section' ? 12 : kind === 'note' ? 10 : 11;
  // Excel does not auto-fit merged rows; reserve room for the complete wrapped text.
  const estimatedLines = Math.ceil(value.length / Math.max(12, (totalWidth - 5) * 10 / size));
  cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 }; row.height = Math.min(409, Math.max(height, estimatedLines * (size + 4) + 12)); row.commit();
}
function header(sheet: Sheet, rowNumber: number, values: string[]) {
  const row = sheet.getRow(rowNumber); row.values = values.map(value => xlsxText(value)); row.height = 34;
  row.eachCell(cell => { cell.font = { ...font, bold: true, color: { argb: white } }; cell.fill = fill(blue); cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 }; }); row.commit();
}
function sheetOptions(tabColor: string, columns: number, freeze = 0): Partial<ExcelJS.AddWorksheetOptions> {
  return { properties: { tabColor: { argb: tabColor }, defaultRowHeight: 25 },
    views: [{ state: freeze ? 'frozen' : 'normal', showGridLines: false, ...(freeze ? { ySplit: freeze } : {}) } as ExcelJS.WorksheetView],
    // OOXML Letter is 1; ExcelJS 4.4's enum omits the documented default value.
    pageSetup: { orientation: columns > 5 ? 'landscape' : 'portrait', paperSize: 1 as ExcelJS.PaperSize, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: '&LSTJW | Hours for review&RPage &P of &N' },
  };
}

/** Styled presentation only. The bounded worker and exact source validator own execution. */
export function writePayrollPresentationSheets(book: ExcelJS.stream.xlsx.WorkbookWriter, report: PayrollHoursReport, raw: PayrollPresentationOptions) {
  const options = payrollPresentationOptionsSchema.parse(raw), context = payrollPresentationContext(report), table = buildPayrollPresentationTable(report, options);
  const overview = book.addWorksheet('Report overview', sheetOptions(teal, 4));
  overview.columns = [{ width: 38 }, { width: 22 }, { width: 22 }, { width: 25 }];
  merged(overview, 1, options.title, 4, 54, 'title');
  merged(overview, 2, `STJW · ${context.period}`, 4, 27);
  merged(overview, 3, `Prepared ${context.capturedAt} · ${context.timezone}`, 4, 25);
  merged(overview, 4, context.scope, 4, 25);
  header(overview, 6, ['Work hours', 'Employees', 'Distinct shifts', 'Open time records']);
  const metrics = overview.getRow(7); metrics.values = [number(payrollPresentationHours(report.totals.workMicroseconds, options.decimalPlaces)), report.totals.employeeCount, report.totals.shiftCount, report.totals.ongoingSegmentCount]; metrics.height = 46;
  metrics.eachCell((cell, index) => { cell.font = { ...font, bold: true, size: 22, color: { argb: index === 4 && report.totals.ongoingSegmentCount ? amber : teal } }; cell.fill = fill(paper); cell.alignment = { vertical: 'middle', horizontal: 'center' }; cell.numFmt = index === 1 ? amountFormat(options) : '#,##0'; }); metrics.commit();
  merged(overview, 9, payrollPresentationNotice, 4, 74, 'note');
  const ranked = payrollPresentationRows(report, { ...options, grouping: 'employees', sortBy: 'work_hours' }), shown = ranked.slice(0, 12);
  merged(overview, 11, `Work hours by employee${ranked.length > 12 ? ' · largest 12, full detail on the next sheet' : ''}`, 4, 28, 'section');
  header(overview, 12, ['Employee', 'Work hours', 'Share of work hours', 'Review indicator']);
  shown.forEach((item, index) => {
    const total = BigInt(report.totals.workMicroseconds), work = BigInt(item.amounts.workMicroseconds);
    const share = total ? Number((work * 10000n + total / 2n) / total) / 10000 : 0;
    const row = overview.getRow(13 + index); row.values = [xlsxText(item.employee), number(payrollPresentationHours(item.amounts.workMicroseconds, options.decimalPlaces)), share,
      item.amounts.ongoingSegmentCount ? `${item.amounts.ongoingSegmentCount} open` : 'No open records'];
    row.height = Math.max(29, Math.ceil(item.employee.length / 32) * 16 + 8);
    row.eachCell((cell, column) => { cell.font = { ...font, ...(column === 4 && item.amounts.ongoingSegmentCount ? { bold: true, color: { argb: amber } } : {}) }; cell.fill = fill(index % 2 ? paper : white); cell.alignment = { vertical: 'middle', wrapText: true, horizontal: column === 2 || column === 3 ? 'right' : 'left' }; });
    row.getCell(2).numFmt = amountFormat(options); row.getCell(3).numFmt = '0.0%'; row.commit();
  });
  // The pinned writer supports data-bar color, although its declaration omits it.
  const bar: ExcelJS.DataBarRuleType & { color: Partial<ExcelJS.Color> } = { type: 'dataBar', priority: 1, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF68C9C3' }, showValue: true, gradient: true };
  if (shown.length) overview.addConditionalFormatting({ ref: `C13:C${12 + shown.length}`, rules: [bar] });
  else merged(overview, 13, 'No time records match the selected period and filters.', 4, 42, 'note');
  const end = 15 + Math.max(shown.length, 1);
  merged(overview, end, options.includeAudit ? 'Exact evidence included in Employees, Jobs, Totals, Source segments, Provenance and Source JSON. Presentation sheets are for review.' : 'Exact evidence is available by selecting Include audit sheets before an Excel download, or using the separate source-data exports.', 4, 48, 'note');
  overview.pageSetup.printArea = `A1:D${end}`; overview.commit();

  const width = table.columns.length, nameColumns = options.grouping === 'jobs' ? 3 : 1;
  const details = book.addWorksheet(options.grouping === 'jobs' ? 'Hours by job' : 'Employee hours', sheetOptions(blue, width, 6));
  const columnWidths = table.columns.map((column, index) => index < nameColumns ? index === 0 ? 34 : 28 : Math.max(18, Math.min(25, column.label.length + 2)));
  // A small selection should still use the printable page width instead of a narrow strip.
  columnWidths[0] += Math.max(0, 107 - columnWidths.reduce((sum, value) => sum + value, 0));
  details.columns = columnWidths.map(width => ({ width }));
  merged(details, 1, options.title, width, 54, 'title');
  merged(details, 2, `${context.period} · ${context.timezone}`, width, 28);
  merged(details, 3, `${context.scope} · ${options.grouping === 'jobs' ? 'One row per employee and job' : 'One row per employee'}`, width, width < 4 ? 42 : 28);
  merged(details, 4, `Prepared ${context.capturedAt} · Hours shown to ${options.decimalPlaces} decimal places`, width, width < 4 ? 42 : 28);
  header(details, 6, table.columns.map(column => column.label));
  table.rows.forEach((values, index) => {
    const row = details.getRow(7 + index); row.values = values.map((value, column) => column < nameColumns ? xlsxText(value) : number(value));
    row.height = Math.max(29, ...values.slice(0, nameColumns).map(value => Math.ceil(value.length / 26) * 16 + 8));
    row.eachCell((cell, column) => { cell.font = font; cell.fill = fill(index % 2 ? paper : white); cell.border = { bottom: { style: 'hair', color: { argb: line } } }; cell.alignment = { vertical: 'middle', horizontal: column <= nameColumns ? 'left' : 'right', wrapText: true };
      if (column > nameColumns) cell.numFmt = table.columns[column - 1].key.endsWith('Hours') ? amountFormat(options) : '#,##0'; }); row.commit();
  });
  const totalRow = 7 + table.rows.length + (table.rows.length ? 1 : 2);
  if (!table.rows.length) merged(details, 7, 'No time records match the selected period and filters.', width, 44, 'note');
  const totals = details.getRow(totalRow); totals.values = table.totals.map((value, index) => index < nameColumns ? xlsxText(value) : number(value)); totals.height = 36;
  totals.eachCell((cell, column) => { cell.font = { ...font, bold: true, color: { argb: white } }; cell.fill = fill(teal); cell.alignment = { vertical: 'middle', wrapText: true, horizontal: column <= nameColumns ? 'left' : 'right' }; if (column > nameColumns) cell.numFmt = table.columns[column - 1].key.endsWith('Hours') ? amountFormat(options) : '#,##0'; }); totals.commit();
  const noteRow = totalRow + 2;
  merged(details, noteRow, payrollPresentationNotice, width, width < 4 ? 138 : 76, 'note');
  details.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6 + table.rows.length, column: width } };
  details.pageSetup.printTitlesRow = '1:6'; details.pageSetup.printArea = `A1:${details.getColumn(width).letter}${noteRow}`; details.commit();
}
