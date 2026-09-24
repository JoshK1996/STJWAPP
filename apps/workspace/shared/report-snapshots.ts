import { z } from "zod";
import { reportDefinitionV1, workforceReportDefinitionV2, reportSources, outputColumnsV2 } from "./report-library";
import { workforceUtcMicrosSchema, workforceMicrosecondsSchema, workforceLocalDateSchema } from "./workforce-reports-v2";

export const snapshotLimits = Object.freeze({ bytes: 8 * 1024 * 1024, rows: 20000, columns: 25, previews: 3, previewMinutes: 10, accountCount: 100, accountBytes: 128 * 1024 * 1024, organizationCount: 1000, organizationBytes: 1024 * 1024 * 1024, pageSize: 50 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
export const prepareSnapshotInput = z.object({ version: z.number().int().positive() }).strict();
export const captureSnapshotInput = z.object({
  version: z.number().int().positive(), previewId: z.uuid(), payloadHash: hash,
  commandId: z.uuid(), reviewed: z.literal(true), reason: z.string().trim().min(5).max(500),
}).strict();
export const snapshotListInput = z.object({ offset: z.coerce.number().int().min(0).max(100).default(0) }).strict();
export const snapshotExportInput = z.object({ format: z.enum(["csv", "json", "xlsx"]) }).strict();
const cell = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const snapshotDataV1Schema = z.object({
  schemaVersion: z.literal(1), reportId: z.uuid(), reportVersion: z.number().int().positive(),
  name: z.string().max(100), description: z.string().max(500), source: z.enum(reportSources),
  definition: reportDefinitionV1, columns: z.array(z.object({ key: z.string(), label: z.string() }).strict()).min(1).max(25),
  rows: z.array(z.record(z.string(), cell)).max(snapshotLimits.rows),
  rowCount: z.number().int().nonnegative().max(snapshotLimits.rows), sourceRowCount: z.number().int().nonnegative().max(snapshotLimits.rows),
  asOf: instant, sourceReadStartedAt: instant, timezone: z.string().min(1).max(80),
  range: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
  notice: z.string(), provenance: z.record(z.string(), z.json()),
}).strict();
export const workforceSnapshotProvenanceV2Schema = z.object({
  sourceSchemaVersion:z.literal(2),precisionVersion:z.literal(2),durationUnit:z.literal("microsecond"),asOf:workforceUtcMicrosSchema,
  range:z.object({from:workforceUtcMicrosSchema,toExclusive:workforceUtcMicrosSchema}).strict(),
  workMicroseconds:workforceMicrosecondsSchema,breakMicroseconds:workforceMicrosecondsSchema,
  sourceRowCount:z.number().int().nonnegative().max(snapshotLimits.rows),contributingRowCount:z.number().int().nonnegative().max(snapshotLimits.rows),
}).strict();
export const snapshotDataV2Schema = snapshotDataV1Schema.extend({
  schemaVersion:z.literal(2),source:z.literal("workforce"),definition:workforceReportDefinitionV2,
  precisionVersion:z.literal(2),durationUnit:z.literal("microsecond"),asOf:workforceUtcMicrosSchema,
  range:z.object({from:workforceLocalDateSchema,to:workforceLocalDateSchema}).strict(),provenance:workforceSnapshotProvenanceV2Schema,
}).superRefine((data,ctx)=>{
  const columns=outputColumnsV2(data.definition);
  if (JSON.stringify(data.columns)!==JSON.stringify(columns)) ctx.addIssue({code:"custom",message:"Snapshot columns must match the reviewed v2 definition."});
  if(data.rowCount!==data.rows.length || data.sourceRowCount<data.rowCount || data.provenance.sourceRowCount!==data.sourceRowCount || data.provenance.contributingRowCount>data.sourceRowCount || data.provenance.asOf!==data.asOf)
    ctx.addIssue({code:"custom",message:"Snapshot source counts or observation are inconsistent."});
  const micros=new Set(["duration_microseconds","recorded_duration_microseconds","work_microseconds","break_microseconds"]);
  const instants=new Set(["started_at","ended_at","clipped_started_at","clipped_ended_at"]);
  for(const row of data.rows) {
    if(Object.keys(row).length!==columns.length || columns.some(column=>!Object.hasOwn(row,column.key))) ctx.addIssue({code:"custom",message:"Snapshot row columns are inconsistent."});
    for(const [key,value] of Object.entries(row)) {
      if(micros.has(key) && !(key==="recorded_duration_microseconds"&&value===null) && !workforceMicrosecondsSchema.safeParse(value).success) ctx.addIssue({code:"custom",message:"Snapshot durations must remain exact microsecond strings."});
      if(instants.has(key) && !(key!=="started_at"&&value===null) && !workforceUtcMicrosSchema.safeParse(value).success) ctx.addIssue({code:"custom",message:"Snapshot time boundaries must remain canonical UTC microseconds."});
    }
  }
});
export const snapshotDataSchema = z.discriminatedUnion("schemaVersion",[snapshotDataV1Schema,snapshotDataV2Schema]);
export type SnapshotData = z.infer<typeof snapshotDataSchema>;
export const snapshotPreviewSchema = z.object({ id: z.uuid(), snapshotId: z.uuid(), expiresAt: instant, payloadHash: hash, data: snapshotDataSchema }).strict();
export type SnapshotPreview = z.infer<typeof snapshotPreviewSchema>;
export const snapshotEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), capturedAt: instant, reviewerId: z.uuid(), reason: z.string(),
  payloadHash: hash, data: snapshotDataV1Schema,
}).strict();
export const snapshotEnvelopeV2Schema = snapshotEnvelopeV1Schema.extend({schemaVersion:z.literal(2),data:snapshotDataV2Schema});
export const snapshotEnvelopeSchema = z.discriminatedUnion("schemaVersion",[snapshotEnvelopeV1Schema,snapshotEnvelopeV2Schema]);
export type SnapshotEnvelope = z.infer<typeof snapshotEnvelopeSchema>;
export const snapshotSummarySchema = z.object({
  id: z.uuid(), reportId: z.uuid(), reportVersion: z.number().int().positive(), source: z.enum(reportSources),
  name: z.string(), asOf: instant, capturedAt: instant, rowCount: z.number().int().nonnegative(), sourceRowCount: z.number().int().nonnegative(),
  payloadHash: hash, jsonHash: hash, csvHash: hash, bytes: z.number().int().nonnegative(),
  precisionVersion:z.literal(2).optional(),
}).strict().superRefine((value,ctx)=>{if(value.precisionVersion===2&&value.source!=="workforce")ctx.addIssue({code:"custom",message:"V2 precision belongs to a workforce snapshot."});});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;
export type SnapshotList = { rows: SnapshotSummary[]; nextOffset: number | null };
export type SnapshotCapture = { snapshot: SnapshotSummary };
export type SnapshotDetail = { snapshot: SnapshotEnvelope; payloadHash: string; jsonHash: string; csvHash: string; bytes: number };
