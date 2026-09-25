import { z } from 'zod';
export const roleSchema = z.enum(['developer','owner','admin','manager','finance','employee']);
export const isDeveloperRole = (role: string): boolean => role === 'developer';
export const isOwnerRole = (role: string): boolean => role === 'developer' || role === 'owner';
export const staffInput = z.object({ name: z.string().trim().min(2).max(100), email: z.email().max(254).transform(s => s.toLowerCase()), role: roleSchema, unitIds: z.array(z.uuid()).min(1).max(30), jobIds: z.array(z.uuid()).max(40) }).strict();
export const clockInput = z.object({ action: z.enum(['clock_in','clock_out','switch_job','start_break','end_break']), jobId: z.uuid().optional(), commandId: z.uuid() }).strict();
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;}, 'Invalid date');
export const requestInput = z.object({ kind: z.enum(['pto','schedule','correction','other']), unitId: z.uuid(), startsOn: dateOnly, endsOn: dateOnly, note: z.string().trim().min(5).max(2000) }).strict().refine(x => x.endsOn >= x.startsOn, 'End date must follow start date.');
export const scheduleInput = z.object({ userId: z.uuid(), jobId: z.uuid(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), note: z.string().max(500).default('') }).strict().refine(x => new Date(x.endsAt).getTime() > new Date(x.startsAt).getTime(), 'End must follow start.');
export const MIN_PASSWORD_LENGTH = 8;
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`).max(128);
export const loginInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('password'), email: z.email().max(254).transform(x => x.toLowerCase()), credential: z.string().min(1).max(128) }).strict(),
  z.object({ mode: z.literal('pin'), email: z.email().max(254).transform(x => x.toLowerCase()).optional(), credential: z.string().regex(/^\d{6,8}$/, 'Use a PIN with 6 to 8 digits.') }).strict(),
]);
export const moduleCatalog = [
  { id:'workforce', name:'Staff & time', status:'First release', detail:'Accounts, assigned jobs, clocking, breaks, requests, schedules, and recorded-hours reports.' },
  { id:'students', name:'Students & families', status:'Records & admissions available', detail:'Student profiles, enrollment, households, contact permissions and staff admissions with reviewed checklists. Family accounts and public applications are planned.' },
  { id:'attendance', name:'Attendance', status:'Available for review', detail:'Teacher roll call, codes, drafts/submission, office reconciliation, corrections, daily closeout and CSV export. School policy confirmation required.' },
  { id:'academics', name:'Classrooms & academics', status:'Classes, grades & report cards', detail:'Courses, classes, curriculum, assignments, reviewed grades, annual report cards, timetables and reviewed student standing with owner-confirmed policies. GPA, ranking and graduation planning remain planned.' },
  { id:'care', name:'Early childhood', status:'Care sessions available', detail:'Scoped programs and rosters, child check-in/out, pickup permission checks, holds, occupancy and child timesheets. Staffing ratios, billing and signatures remain planned.' },
  { id:'dismissal', name:'Arrival & dismissal', status:'Staff dismissal available', detail:'Dated school roster, reviewed pickup/bus plans, arrival observation, verified handoffs, bus manifests and daily reconciliation. Parent app, geofence and external notifications are planned.' },
  { id:'finance', name:'Finance', status:'Reviewed accounting workflows', detail:'Ledger, bills/invoices, manual payment records, bank CSV reconciliation, budgets, payroll preparation and readable financial reports. External payments, bank feeds and statutory tax calculations are not connected.' },
  { id:'google', name:'Google Workspace', status:'Not connected', detail:'Separate consent-based connectors for Classroom, Drive, Calendar, and Gmail.' },
  { id:'calendar', name:'Community calendar', status:'Available', detail:'Personal and shared events, recurring occurrences, edits, cancellations, and change history.' },
  { id:'communications', name:'Communications', status:'Staff messaging available', detail:'Internal staff messages, drafts, replies, read status, and archive. Household delivery and external email are planned.' },
] as const;
