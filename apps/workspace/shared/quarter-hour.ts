/** Quarter-hour display rounding. Apply once, to an already aggregated total of exact microseconds. Never to an individual punch, segment or shift before they are summed. Source evidence is unchanged. */
export const QUARTER_HOUR_MICROSECONDS = 900_000_000n;
export type HourRounding = 'quarter' | 'exact';

/** Nearest 15 minutes; an exact half rounds up (away from zero for negative changes). */
export function roundToQuarterHour(microseconds: bigint): bigint {
  const magnitude = microseconds < 0n ? -microseconds : microseconds;
  const rounded = ((magnitude + QUARTER_HOUR_MICROSECONDS / 2n) / QUARTER_HOUR_MICROSECONDS) * QUARTER_HOUR_MICROSECONDS;
  return microseconds < 0n ? -rounded : rounded;
}

/** Decimal hours at the nearest quarter hour, such as "7.75". A quarter hour is always exact in two decimals. */
export function quarterHourDecimal(microseconds: bigint, places = 2): string {
  const rounded = roundToQuarterHour(microseconds), magnitude = rounded < 0n ? -rounded : rounded;
  const scale = 10n ** BigInt(places), units = (magnitude * scale) / 3_600_000_000n;
  return `${rounded < 0n ? '-' : ''}${units / scale}.${String(units % scale).padStart(places, '0')}`;
}
