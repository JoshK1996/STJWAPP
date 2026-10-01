import {z} from 'zod';
import {dateOnly} from './contracts';

const historyDate = dateOnly.refine(value => value >= '1900-01-01' && value <= '9998-12-31', 'Choose a date from 1900 through 9998.');
export const personalTimeQuery = z.object({
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).default('week'),
  anchor: historyDate.optional(),
  from: historyDate.optional(),
  to: historyDate.optional(),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict().superRefine((value, context) => {
  if (value.period === 'custom') {
    if (!value.from || !value.to || value.to < value.from) context.addIssue({code: 'custom', message: 'Choose a start and end date in order.'});
    if (value.anchor) context.addIssue({code: 'custom', message: 'Custom dates cannot include an anchor date.'});
  } else if (value.from || value.to) context.addIssue({code: 'custom', message: 'Start and end dates are only used for a custom period.'});
  if (value.period === 'all' && value.anchor) context.addIssue({code: 'custom', message: 'All history cannot include an anchor date.'});
});
export type PersonalTimeQuery = z.infer<typeof personalTimeQuery>;
export interface PersonalTimeDuration {workMicroseconds: string; breakMicroseconds: string}
export interface PersonalTimeJob {jobId: string; title: string; unitId: string; unitName: string}
export interface PersonalTimeSegment extends PersonalTimeDuration, PersonalTimeJob {
  id: string; kind: 'work' | 'break'; startedAt: string; endedAt: string | null;
  periodWorkMicroseconds: string; periodBreakMicroseconds: string;
}
export interface PersonalTimeCard extends PersonalTimeDuration {
  id: string; startedAt: string; endedAt: string | null; revision: number;
  periodWorkMicroseconds: string; periodBreakMicroseconds: string;
  segments: PersonalTimeSegment[];
}
export interface PersonalTimePoint extends PersonalTimeDuration {date: string}
export interface PersonalTimeReport {
  timezone: string; observedAt: string;
  range: {period: PersonalTimeQuery['period']; from: string; to: string; label: string};
  history: {firstDate: string | null; lastDate: string | null};
  summary: PersonalTimeDuration & {shiftCount: number; openCount: number; totalMicroseconds: string; daysWorked: number};
  /** Sparse calendar dates with recorded time; absent dates have zero recorded duration. */
  daily: PersonalTimePoint[];
  trend: {group: 'day' | 'month'; points: PersonalTimePoint[]};
  jobs: Array<PersonalTimeJob & PersonalTimeDuration>;
  rows: PersonalTimeCard[];
  offset: number; hasMore: boolean; nextOffset: number | null;
}

const exactDuration = z.string().regex(/^\d+$/);
const instant = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
const durationShape = {workMicroseconds: exactDuration, breakMicroseconds: exactDuration};
const periodShape = {periodWorkMicroseconds: exactDuration, periodBreakMicroseconds: exactDuration};
const jobShape = {jobId: z.uuid(), title: z.string(), unitId: z.uuid(), unitName: z.string()};
const point = z.object({date: dateOnly, ...durationShape}).strict();
export const personalTimeReportSchema = z.object({
  timezone: z.string(), observedAt: instant,
  range: z.object({period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']), from: dateOnly, to: dateOnly, label: z.string()}).strict(),
  history: z.object({firstDate: dateOnly.nullable(), lastDate: dateOnly.nullable()}).strict(),
  summary: z.object({...durationShape, shiftCount: z.number().int().nonnegative(), openCount: z.number().int().nonnegative(), totalMicroseconds: exactDuration, daysWorked: z.number().int().nonnegative()}).strict(),
  daily: z.array(point), trend: z.object({group: z.enum(['day', 'month']), points: z.array(point)}).strict(),
  jobs: z.array(z.object({...jobShape, ...durationShape}).strict()),
  rows: z.array(z.object({id: z.uuid(), startedAt: instant, endedAt: instant.nullable(), revision: z.number().int().positive(), ...durationShape, ...periodShape,
    segments: z.array(z.object({id: z.uuid(), kind: z.enum(['work', 'break']), ...jobShape, startedAt: instant, endedAt: instant.nullable(), ...durationShape, ...periodShape}).strict()),
  }).strict()),
  offset: z.number().int().nonnegative(), hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
