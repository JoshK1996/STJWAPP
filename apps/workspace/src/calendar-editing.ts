import { DateTime } from "luxon";

const localPattern = "yyyy-MM-dd'T'HH:mm";
export const calendarLocalInput = (instant: string, zone: string) => DateTime.fromISO(instant).setZone(zone).toFormat(localPattern);
export function calendarTimeOptions(local: string, zone: string) {
  const value = DateTime.fromISO(local, { zone });
  if (!value.isValid || value.toFormat(localPattern) !== local) return [];
  return value.getPossibleOffsets().map(option => ({ offset: String(option.offset), label: `${option.offsetNameShort} (UTC${option.toFormat("ZZ")})` }));
}
/** Preserve the exact supplied timestamp during a metadata-only edit, including sub-minute precision and DST fold. */
export function calendarInstant(local: string, zone: string, offset: string, original?: string): string {
  const value = DateTime.fromISO(local, { zone });
  if (!value.isValid || value.toFormat(localPattern) !== local)
    throw Error("This local time does not exist. Choose a time outside the daylight-saving change.");
  const originalValue = original ? DateTime.fromISO(original).setZone(zone) : null;
  if (original && originalValue?.isValid && calendarLocalInput(original, zone) === local && String(originalValue.offset) === offset) return original;
  const options = value.getPossibleOffsets();
  const selected = options.length === 1 ? options[0] : options.find(option => String(option.offset) === offset);
  if (!selected) throw Error("This time occurs twice when daylight saving ends. Choose the correct UTC offset.");
  return selected.toUTC().toISO()!;
}
