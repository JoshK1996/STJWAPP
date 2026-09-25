import { z } from 'zod';
import { DateTime } from 'luxon';

export const scheduleDocumentLimits = { bytes: 2 * 1024 * 1024, base64: 2796204, rows: 2000, cells: 20000, columns: 64, sheets: 20, resultBytes: 2 * 1024 * 1024, deadlineMs: 15000, heapMb: 192 } as const;
export const scheduleDocumentFormat = z.enum(['csv', 'xlsx', 'pdf', 'docx']);
export const scheduleDocumentInput = z.object({ format: scheduleDocumentFormat, base64: z.string().min(4).max(scheduleDocumentLimits.base64).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
export const scheduleDocumentResult = z.object({ format: scheduleDocumentFormat, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sheets: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1).max(128), rows: z.array(z.object({ row: z.number().int().positive().max(2000), cells: z.array(z.string().max(8192)).max(64) }).strict()).max(2000) }).strict()).max(20),
  warnings: z.array(z.string().max(500)).max(30), timezone: z.string().min(1).max(100),
}).strict();
export type ScheduleDocumentResult = z.infer<typeof scheduleDocumentResult>;
export type ScheduleImportContext = { staff: Array<{ id: string; name: string; email: string; unit_ids: string[]; job_ids: string[]; active?: boolean }>;
  jobs: Array<{ id: string; title: string; unit_id: string; active?: boolean }>; units: Array<{ id: string; name: string }>; timezone: string };
export type ScheduleDraftRow = { source: string; include: boolean; userId: string; jobId: string; start: string; end: string; note: string };
export type ScheduleDateFormat = 'iso' | 'mdy' | 'dmy';

/** Explicit offsets are authoritative. Local wall times use the stated organization zone; never the browser zone. */
export function scheduleImportTimestamp(raw: string, timezone: string, format: ScheduleDateFormat = 'iso'): string {
  let value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const time = DateTime.fromISO(value, { setZone: true }); if (!time.isValid) throw Error('Use a valid date and UTC offset.'); return time.toUTC().toISO()!;
  }
  if (format !== 'iso') {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](.+)$/.exec(value);
    if (match) value = `${match[3]}-${(format === 'mdy' ? match[1] : match[2]).padStart(2, '0')}-${(format === 'mdy' ? match[2] : match[1]).padStart(2, '0')}T${match[4]}`;
  }
  value = value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(value);
  if (!match) throw Error('Enter a complete date and time, such as 2026-10-05 08:00; select the matching date order for slash dates.');
  let hour = Number(match[2]);
  if (match[5]) { if (hour < 1 || hour > 12) throw Error('Use a valid 12-hour time.'); hour = hour % 12 + (match[5].toUpperCase() === 'PM' ? 12 : 0); }
  const local = `${match[1]}T${String(hour).padStart(2, '0')}:${match[3]}:${match[4] ?? '00'}`;
  const time = DateTime.fromISO(local, { zone: timezone });
  if (!time.isValid || time.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw Error('This local date/time is invalid or falls in a daylight-saving gap. Choose a valid time.');
  if (time.getPossibleOffsets().length > 1) throw Error('This clock time occurs twice. Add the intended UTC offset, for example -04:00 or -05:00.');
  return time.toUTC().toISO()!;
}
export function scheduleDraftCsv(rows: ScheduleDraftRow[], context: ScheduleImportContext, format: ScheduleDateFormat = 'iso') {
  const included = rows.filter(row => row.include);
  if (!included.length || included.length > 1000) throw Error('Include between 1 and 1,000 shifts in each reviewed import.');
  const errors: Array<{ index: number; message: string }> = [], values: string[][] = [];
  rows.forEach((row, index) => {
    if (!row.include) return;
    try {
      const person = context.staff.find(person => person.id === row.userId && person.active !== false), job = context.jobs.find(job => job.id === row.jobId && job.active !== false), unit = context.units.find(unit => unit.id === job?.unit_id);
      if (!person || !job || !unit) throw Error('Choose an active employee and job.');
      if (!person.job_ids.includes(job.id) || !person.unit_ids.includes(unit.id)) throw Error('This employee needs this job and community assignment first.');
      // The legacy import resolver deliberately refuses ambiguous names. Do not disguise this by choosing an ID the final service cannot retain.
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
      if (context.units.filter(value => same(value.name, unit.name)).length !== 1 || context.jobs.filter(value => value.unit_id === unit.id && same(value.title, job.title)).length !== 1) throw Error('Duplicate community or job names must be renamed before this import can identify them safely.');
      const start = scheduleImportTimestamp(row.start, context.timezone, format), end = scheduleImportTimestamp(row.end, context.timezone, format);
      if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 86400000) throw Error('End must follow start by no more than 24 hours. For overnight work, enter the next date explicitly.');
      if (row.note.length > 500) throw Error('Shorten the note to 500 characters.');
      values.push([person.email, unit.name, job.title, start, end, row.note.trim()]);
    } catch (error) { errors.push({ index, message: error instanceof Error ? error.message : 'Check this row.' }); }
  });
  const csv = [['employeeEmail', 'community', 'jobTitle', 'startsAt', 'endsAt', 'note'], ...values].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
  return { csv, errors };
}
