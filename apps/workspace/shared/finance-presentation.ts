import { z } from 'zod';
import { DateTime } from 'luxon';
import type { FinanceLine, FinanceMetadata } from './finance';

export const financeViewColumns = ['lineLabel', 'amount', 'group', 'rowKind', 'note', 'lineCode'] as const;
export type FinanceViewColumn = typeof financeViewColumns[number];
export const financeColumnLabels: Record<FinanceViewColumn, string> = { lineLabel: 'Report line', amount: 'Amount', group: 'Group', rowKind: 'Line type', note: 'Note', lineCode: 'Source code' };
export const financeKindLabels: Record<string, string> = { actual: 'Actual', budget: 'Budget', forecast: 'Forecast', other: 'Other' };
export const financeRowKindLabels: Record<string, string> = { detail: 'Detail', subtotal: 'Subtotal', total: 'Total' };
export const financeSortLabels = { source: 'Original source order', label: 'Line name', amount_desc: 'Amount: highest first', amount_asc: 'Amount: lowest first' };
export const financeBasisLabel = (value: string) => ({ period_activity: 'Activity during a period', as_of_balance: 'Balance at a date', other: 'Other period type' })[value] ?? value;
export const financeViewSchema = z.object({
  columns: z.array(z.enum(financeViewColumns)).min(2).max(6).default(['lineLabel', 'amount', 'group', 'rowKind', 'note']),
  search: z.string().trim().max(160).default(''), group: z.string().max(100).optional(),
  rowKind: z.enum(['all', 'detail', 'subtotal', 'total']).default('all'),
  sort: z.enum(['source', 'label', 'amount_desc', 'amount_asc']).default('source'),
  decimalPlaces: z.union([z.literal(2), z.literal(4)]).default(2),
}).strict().superRefine((value, context) => {
  if (new Set(value.columns).size !== value.columns.length || !value.columns.includes('lineLabel') || !value.columns.includes('amount'))
    context.addIssue({ code: 'custom', path: ['columns'], message: 'Choose unique columns including Report line and Amount.' });
});
export type FinanceViewOptions = z.infer<typeof financeViewSchema>;
export const financeDefaultView = (): FinanceViewOptions => financeViewSchema.parse({});
export function financeSelectionSummary(view: FinanceViewOptions): string {
  return `Search: ${view.search || 'none'}; Group: ${view.group === undefined ? 'all' : view.group || 'Ungrouped'}; Line type: ${view.rowKind === 'all' ? 'All source lines' : financeRowKindLabels[view.rowKind]}; Order: ${financeSortLabels[view.sort]}`;
}
export function financeViewQuery(options: FinanceViewOptions): string {
  const value = financeViewSchema.parse(options);
  const query = new URLSearchParams({ format: 'readable_csv', search: value.search, rowKind: value.rowKind, sort: value.sort, columns: value.columns.join(','), decimalPlaces: String(value.decimalPlaces) });
  if (value.group !== undefined) query.set('group', value.group);
  return query.toString();
}
export function financeUnits(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) throw new RangeError('Invalid financial amount.');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')); return negative ? -amount : amount;
}
export function financeDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return (value < 0n ? '-' : '') + (absolute / 10000n) + '.' + String(absolute % 10000n).padStart(4, '0');
}
/** Display rounding only, after exact source aggregation. Original amounts stay unchanged. */
export function formatFinanceAmount(value: string | null, currency = '', decimalPlaces: 2 | 4 = 2): string {
  if (value === null) return 'Not present';
  const original = financeUnits(value), absolute = original < 0n ? -original : original;
  const rounded = decimalPlaces === 2 ? (absolute + 50n) / 100n : absolute, scale = decimalPlaces === 2 ? 100n : 10000n;
  const whole = String(rounded / scale).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (currency ? currency + ' ' : '') + (original < 0n && rounded > 0n ? '-' : '') + whole + '.' + String(rounded % scale).padStart(decimalPlaces, '0');
}
export function financePeriod(metadata: Pick<FinanceMetadata, 'from' | 'to' | 'basis'>): string {
  const date = (raw: string) => DateTime.fromISO(raw, { zone: 'UTC' }).toFormat('LLL d, yyyy');
  return metadata.basis === 'as_of_balance' ? `As of ${date(metadata.to)}` : `${date(metadata.from)} – ${date(metadata.to)}`;
}
export function financeVisibleLines(lines: FinanceLine[], raw: FinanceViewOptions): FinanceLine[] {
  const options = financeViewSchema.parse(raw), search = options.search.toLocaleLowerCase();
  return lines.map((line, index) => ({ line, index })).filter(({ line }) =>
    (options.group === undefined || line.group === options.group) && (options.rowKind === 'all' || line.rowKind === options.rowKind) &&
    (!search || [line.lineLabel, line.lineCode, line.group, line.note].some(value => value.toLocaleLowerCase().includes(search))))
    .sort((a, b) => {
      if (options.sort === 'source') return a.index - b.index;
      if (options.sort === 'label') return a.line.lineLabel.localeCompare(b.line.lineLabel) || a.index - b.index;
      const left = financeUnits(a.line.amount), right = financeUnits(b.line.amount);
      return left === right ? a.index - b.index : (left < right ? -1 : 1) * (options.sort === 'amount_desc' ? -1 : 1);
    }).map(value => value.line);
}
export function financeGroups(lines: FinanceLine[]) {
  const groups = new Map<string, { group: string; count: number; net: bigint; magnitude: bigint }>();
  for (const row of lines) if (row.rowKind === 'detail') {
    const value = financeUnits(row.amount), group = groups.get(row.group) ?? { group: row.group, count: 0, net: 0n, magnitude: 0n };
    group.count++; group.net += value; group.magnitude += value < 0n ? -value : value; groups.set(row.group, group);
  }
  return [...groups.values()].sort((a, b) => a.magnitude === b.magnitude ? a.group.localeCompare(b.group) : a.magnitude > b.magnitude ? -1 : 1);
}
export function financeMagnitudePercent(value: bigint, total: bigint) {
  return total <= 0n ? 0 : Number((value < 0n ? -value : value) * 10000n / total) / 100;
}
export function financeFilename(title: string, version: number): string {
  return (title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'financial-report') + '-v' + version + '-view.csv';
}
