import type { WorkforceReportRowV2 } from './workforce-reports-v2';

const hour = 3_600_000_000n, minute = 60_000_000n;
function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RangeError('Expected a nonnegative integer duration.');
  return BigInt(value);
}

/** Display rounding happens once after exact aggregation; this is never a payroll rule. */
export function decimalWorkHours(value: string): string {
  const hundredths = (amount(value) * 100n + hour / 2n) / hour;
  return `${(hundredths / 100n).toLocaleString('en-US')}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

export function compactWorkDuration(value: string): string {
  const total = amount(value), hours = total / hour, minutes = (total % hour) / minute;
  if (total < minute) {
    const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${total / 1_000_000n}${fraction ? '.' + fraction : ''}s`;
  }
  return `${total % minute ? '≈ ' : ''}${hours ? hours.toLocaleString('en-US') + 'h ' : ''}${minutes}m`;
}

/** Only the bounded ratio used to draw a shape is converted to floating point. */
export function visualRatio(value: string, maximum: string): number {
  const total = amount(value), max = amount(maximum);
  if (!max) return 0;
  return Number((total > max ? max : total) * 1_000_000n / max) / 1_000_000;
}

export type WorkforceMix = { id: string; label: string; duration: string; records: number };
export function workforceMix(rows: readonly WorkforceReportRowV2[], group: 'job' | 'unit'): WorkforceMix[] {
  const result = new Map<string, { label: string; duration: bigint; records: number }>();
  for (const row of rows) {
    if (row.kind !== 'work' || amount(row.duration_microseconds) === 0n) continue;
    const id = group === 'job' ? row.job_id : row.unit_id;
    const label = group === 'job' ? row.job_title : row.unit_name;
    const entry = result.get(id) ?? { label, duration: 0n, records: 0 };
    entry.duration += amount(row.duration_microseconds); entry.records++;
    result.set(id, entry);
  }
  return [...result.entries()].map(([id, row]) => ({ id, ...row, duration: row.duration.toString() }))
    .sort((a, b) => amount(a.duration) > amount(b.duration) ? -1 : amount(a.duration) < amount(b.duration) ? 1 : a.id.localeCompare(b.id));
}

export function workforceDonutSlices(items: readonly WorkforceMix[], limit = 7): WorkforceMix[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Choose a positive slice limit.');
  if (items.length <= limit) return [...items];
  const remainder = items.slice(limit);
  return [...items.slice(0, limit), { id: '__other__', label: 'Other jobs / communities',
    duration: remainder.reduce((sum, item) => sum + amount(item.duration), 0n).toString(),
    records: remainder.reduce((sum, item) => sum + item.records, 0) }];
}

export function exactDescending(a: string, b: string): number {
  return amount(a) > amount(b) ? -1 : amount(a) < amount(b) ? 1 : 0;
}
