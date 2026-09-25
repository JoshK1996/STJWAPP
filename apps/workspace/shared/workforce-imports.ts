import { z } from 'zod';

export const workforceImportKinds = ['jobs', 'schedules'] as const;
export const workforceImportKind = z.enum(workforceImportKinds);
export type WorkforceImportKind = z.infer<typeof workforceImportKind>;
export const workforceImportColumns = {
  jobs: ['community', 'title', 'description'],
  schedules: ['employeeEmail', 'community', 'jobTitle', 'startsAt', 'endsAt', 'note'],
} as const;
export const workforceImportLimits = { rows: 100, characters: 200000, bytes: 800000, sourceBudgetBytes: 64 * 1024 * 1024 } as const;
const name = z.string().trim().min(2).max(100), hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Use a valid date and UTC offset.').transform(value => new Date(value).toISOString());
export const workforceJobImportRow = z.object({ community: name, title: name, description: z.string().trim().max(1000) }).strict();
export const workforceScheduleImportRow = z.object({ employeeEmail: z.email().max(254).transform(value => value.toLowerCase()), community: name,
  jobTitle: name, startsAt: timestamp, endsAt: timestamp, note: z.string().trim().max(500) }).strict()
  .refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt) && Date.parse(value.endsAt) - Date.parse(value.startsAt) <= 86400000, 'A scheduled shift must last more than zero and no longer than 24 hours.');
export const workforceImportPreviewInput = z.object({ csv: z.string().min(1).max(workforceImportLimits.characters) }).strict();
export const workforceImportApplyInput = z.object({ sourceHash: hash }).strict();
export const workforceImportDisplayRow = z.object({ row: z.number().int().min(2).max(101), community: z.string(), title: z.string(),
  employee: z.string().optional(), email: z.string().optional(), startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().optional(), note: z.string() }).strict();
export const workforceImportReceipt = z.object({ batchId: z.uuid(), kind: workforceImportKind, sourceHash: hash, appliedAt: z.iso.datetime(),
  created: z.number().int().min(1).max(100), records: z.array(z.object({ row: z.number().int().min(2).max(101), id: z.uuid() }).strict()).min(1).max(100) }).strict();
export const workforceImportDetail = z.object({ id: z.uuid(), kind: workforceImportKind, sourceHash: hash, contextHash: hash,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), rows: z.array(workforceImportDisplayRow).min(1).max(100),
  receipt: workforceImportReceipt.nullable() }).strict();
export type WorkforceImportDetail = z.infer<typeof workforceImportDetail>;
export type WorkforceImportReceipt = z.infer<typeof workforceImportReceipt>;
export const workforceImportList = z.object({ rows: z.array(z.object({ id: z.uuid(), kind: workforceImportKind,
  createdAt: z.iso.datetime(), count: z.number().int().min(1).max(100), applied: z.boolean() }).strict()).max(20) }).strict();
