import { z } from 'zod';

export const workforceImportKinds = ['jobs', 'schedules'] as const;
export const workforceImportKind = z.enum(workforceImportKinds);
export type WorkforceImportKind = z.infer<typeof workforceImportKind>;
export const workforceImportColumns = {
  jobs: ['community', 'title', 'description'],
  schedules: ['employeeEmail', 'community', 'jobTitle', 'startsAt', 'endsAt', 'note'],
} as const;
export const workforceImportLimits = { rows: 100, scheduleRows: 1000, characters: 200000, bytes: 800000, sourceBudgetBytes: 64 * 1024 * 1024 } as const;
export const workforceImportRowLimit = (kind: WorkforceImportKind) => kind === 'schedules' ? workforceImportLimits.scheduleRows : workforceImportLimits.rows;
const name = z.string().trim().min(2).max(100), hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Use a valid date and UTC offset.').transform(value => new Date(value).toISOString());
export const workforceJobImportRow = z.object({ community: name, title: name, description: z.string().trim().max(1000) }).strict();
export const workforceScheduleImportRow = z.object({ employeeEmail: z.email().max(254).transform(value => value.toLowerCase()), community: name,
  jobTitle: name, startsAt: timestamp, endsAt: timestamp, note: z.string().trim().max(500) }).strict()
  .refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt) && Date.parse(value.endsAt) - Date.parse(value.startsAt) <= 86400000, 'A scheduled shift must last more than zero and no longer than 24 hours.');
export const workforceImportPreviewInput = z.object({ csv: z.string().min(1).max(workforceImportLimits.characters) }).strict();
export const workforceImportApplyInput = z.object({ sourceHash: hash }).strict();
export const workforceImportDisplayRow = z.object({ row: z.number().int().min(2).max(1001), community: z.string(), title: z.string(),
  employee: z.string().optional(), email: z.string().optional(), startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().optional(), note: z.string() }).strict();
const receiptFor = <K extends WorkforceImportKind>(kind: K) => z.object({ batchId: z.uuid(), kind: z.literal(kind), sourceHash: hash, appliedAt: z.iso.datetime(),
  created: z.number().int().min(1).max(workforceImportRowLimit(kind)), records: z.array(z.object({ row: z.number().int().min(2).max(workforceImportRowLimit(kind) + 1), id: z.uuid() }).strict()).min(1).max(workforceImportRowLimit(kind)) }).strict();
export const workforceImportReceipt = z.discriminatedUnion('kind', [receiptFor('jobs'), receiptFor('schedules')]);
const detailFor = <K extends WorkforceImportKind>(kind: K) => z.object({ id: z.uuid(), kind: z.literal(kind), sourceHash: hash, contextHash: hash,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), rows: z.array(workforceImportDisplayRow.extend({ row: z.number().int().min(2).max(workforceImportRowLimit(kind) + 1) })).min(1).max(workforceImportRowLimit(kind)), receipt: receiptFor(kind).nullable() }).strict();
export const workforceImportDetail = z.discriminatedUnion('kind', [detailFor('jobs'), detailFor('schedules')]);
export type WorkforceImportDetail = z.infer<typeof workforceImportDetail>;
export type WorkforceImportReceipt = z.infer<typeof workforceImportReceipt>;
const summaryFor = <K extends WorkforceImportKind>(kind: K) => z.object({ id: z.uuid(), kind: z.literal(kind), createdAt: z.iso.datetime(), count: z.number().int().min(1).max(workforceImportRowLimit(kind)), applied: z.boolean() }).strict();
export const workforceImportList = z.object({ rows: z.array(z.discriminatedUnion('kind', [summaryFor('jobs'), summaryFor('schedules')])).max(20) }).strict();
