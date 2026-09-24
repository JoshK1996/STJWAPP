import type { FinanceLine, FinanceMetadata } from '../shared/finance';
import { financeBasisLabel, financeColumnLabels, financeKindLabels, financePeriod, financeRowKindLabels, financeSelectionSummary, financeViewSchema, financeVisibleLines, formatFinanceAmount, type FinanceViewOptions } from '../shared/finance-presentation';
import { csvCell } from './reports';

export function financeReadableCsv(report: { metadata: FinanceMetadata; lines: FinanceLine[]; version: number; source_hash: string }, raw: FinanceViewOptions, community: string) {
  const view = financeViewSchema.parse(raw), rows = financeVisibleLines(report.lines, view), meta = report.metadata;
  const lines: unknown[][] = [
    ['Financial report view', meta.title], ['Community', community], ['Source', meta.sourceName],
    ['Report kind', financeKindLabels[meta.kind]], ['Reporting period', financePeriod(meta)], ['Period type', financeBasisLabel(meta.basis)],
    ['Source from date', meta.from], ['Source through date', meta.to], ['Currency', meta.currency], ['Source version', report.version],
    ['Accounting method', 'Cash / accrual method is not recorded by this import.'],
    ['View selection', financeSelectionSummary(view)],
    ['Included lines', `${rows.length} of ${report.lines.length}`],
    ['Display precision', `${view.decimalPlaces} decimal places; original source precision is retained in full-source downloads.`],
    ['Interpretation', 'Imported report amounts only. Detail sums are not proof of cash, profit, fund balance or payroll approval.'], [],
    view.columns.map(column => financeColumnLabels[column] + (column === 'amount' ? ` (${meta.currency})` : '')),
    ...rows.map(row => view.columns.map(column => column === 'amount' ? formatFinanceAmount(row.amount, '', view.decimalPlaces) : column === 'rowKind' ? financeRowKindLabels[row.rowKind] : row[column])),
  ];
  return '\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n');
}
