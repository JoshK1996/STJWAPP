import { DateTime } from "luxon";
import type { TimeSnapshot } from "../shared/time-adjustments";

export const timeLocalFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS";
export const timeLabel = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat("LLL d, yyyy, h:mm:ss a ZZZZ");
export const localTime = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat(timeLocalFormat);
export function instantMicros(value: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw Error("Unsupported timestamp.");
  return BigInt(Date.parse(match[1] + "Z")) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function exactDuration(value: string): string {
  const micros = BigInt(value), hours = micros / 3600000000n, minutes = (micros / 60000000n) % 60n, seconds = (micros / 1000000n) % 60n;
  const fraction = String(micros % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${hours}h ${minutes}m ${seconds}${fraction ? "." + fraction : ""}s`;
}
export function snapshotTotals(segments: TimeSnapshot["segments"]): TimeSnapshot["totals"] {
  if (segments.some(segment => segment.endedAt === null)) return null;
  let work = 0n, breaks = 0n;
  for (const segment of segments) {
    const duration = instantMicros(segment.endedAt!) - instantMicros(segment.startedAt);
    if (duration < 0n) throw Error("Each end must be at or after its start.");
    if (segment.kind === "work") work += duration; else breaks += duration;
  }
  return { workMicroseconds: String(work), breakMicroseconds: String(breaks), totalMicroseconds: String(work + breaks) };
}
export function resolveEnteredTime(value: string, zone: string, offset: number | null): string {
  const time = DateTime.fromISO(value, { zone });
  if (!time.isValid || time.toFormat(timeLocalFormat) !== DateTime.fromISO(value, { zone: "UTC" }).toFormat(timeLocalFormat))
    throw Error("This local time does not exist in the organization timezone.");
  const options = time.getPossibleOffsets();
  if (options.length > 1) {
    const selected = options.find(option => option.offset === offset);
    if (!selected) throw Error("Choose the daylight or standard-time occurrence for the repeated clock time.");
    return selected.toUTC().toISO()!;
  }
  return time.toUTC().toISO()!;
}
export function AdjustmentTimeField({ label, value, offset, zone, onChange, disabled = false }: {
  label: string; value: string; offset: number | null; zone: string; onChange(value: string, offset: number | null): void; disabled?: boolean;
}) {
  const time = DateTime.fromISO(value, { zone }), options = time.isValid ? time.getPossibleOffsets() : [];
  return <div className="adjustment-time-field">
    <label>{label}<input aria-label={label} type="datetime-local" step="0.001" required disabled={disabled} value={value}
      onChange={event => onChange(event.target.value, null)} /></label>
    {options.length > 1 && <label>Repeated clock time<select aria-label={`${label} occurrence`} disabled={disabled} value={offset ?? ""}
      onChange={event => onChange(value, Number(event.target.value))}>
      <option value="" disabled>Choose occurrence</option>
      {options.map(option => <option key={option.offset} value={option.offset}>{option.toFormat("ZZZZ (ZZ)")}</option>)}
    </select></label>}
  </div>;
}
export function TimeEvidence({ snapshot, title, zone }: { snapshot: TimeSnapshot; title: string; zone: string }) {
  return <section className="adjustment-evidence">
    <h3>{title}</h3>
    <p>{snapshot.employee.name}{snapshot.shift.revision !== null ? ` · Revision ${snapshot.shift.revision}` : " · Proposed new shift"}</p>
    {snapshot.totals ? <dl className="adjustment-totals">
      <div><dt>Work</dt><dd>{exactDuration(snapshot.totals.workMicroseconds)}</dd></div>
      <div><dt>Breaks</dt><dd>{exactDuration(snapshot.totals.breakMicroseconds)}</dd></div>
      <div><dt>Entire shift</dt><dd>{exactDuration(snapshot.totals.totalMicroseconds)}</dd></div>
    </dl> : <p className="muted">Duration unknown — this source has no recorded end.</p>}
    <ol className="adjustment-segments">{snapshot.segments.map((segment, index) => <li key={segment.id ?? index}>
      <strong>{segment.kind === "work" ? "Work" : "Break"} · {segment.jobTitle}</strong><span>{segment.unitName}</span>
      <p>{timeLabel(segment.startedAt, zone)}<br />to {segment.endedAt === null ? "No end recorded in this source" : timeLabel(segment.endedAt, zone)}</p>
    </li>)}</ol>
    <details><summary>Exact recorded values</summary><p>Local display uses {zone}. These UTC values retain their recorded precision.</p>
      <dl><div><dt>Shift</dt><dd>{snapshot.shift.id ?? "Not created"}</dd></div></dl>
      {snapshot.segments.map((segment, index) => <div className="adjustment-exact" key={segment.id ?? index}>
        <strong>Entry {index + 1}</strong><code>{segment.startedAt}</code><code>{segment.endedAt ?? "No end recorded in this source"}</code>
        <small>Job {segment.jobId} · Community {segment.unitId}{segment.id ? ` · Entry ${segment.id}` : ""}</small>
      </div>)}
    </details>
  </section>;
}
