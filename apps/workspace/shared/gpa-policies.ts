import { z } from "zod";
import { termGpaConfigurationSchema, termGpaPolicySchema } from "./term-gpa";
import { standingCapturedGradingPolicySchema } from "./standing-evidence";

export const gpaPolicyHashAlgorithm = "sha256-canonical-json-v1" as const;
export const gpaPolicyLimits = Object.freeze({ catalogPolicies: 200, courses: 1000, terms: 100, page: 50, catalogBytes: 1_048_576 });
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().min(1).max(2147483647);
const reason = z.string().trim().min(10).max(2000), capturedReason = z.string().min(10).max(2000);
const name = z.string().min(1).max(5000), timestamp = z.iso.datetime(), date = z.iso.date();
const command = { commandId: id, reason }, expected = { expectedVersion: version };
export const gpaPolicyScopeInput = z.object({ unitId: id, yearId: id }).strict();
export const gpaPolicyListInput = gpaPolicyScopeInput.extend({ beforeId: id.optional() }).strict();
export const gpaPolicyHistoryInput = z.object({ beforeVersion: z.union([version, z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(version)]).optional() }).strict();
export const gpaPolicyCreateInput = gpaPolicyScopeInput.extend({ ...command, configuration: termGpaConfigurationSchema, catalogHash: hash }).strict();
export const gpaPolicyUpdateInput = z.object({ ...command, ...expected, configuration: termGpaConfigurationSchema, catalogHash: hash }).strict();
export const gpaPolicyConfirmInput = z.object({ ...command, ...expected, draftHash: hash, catalogHash: hash,
  sourceDescription: z.string().trim().min(10).max(2000), reviewed: z.literal(true) }).strict();
export const gpaPolicyArchiveInput = z.object({ ...command, ...expected, archived: z.boolean() }).strict();

const term = z.object({ id, name, version, startsOn: date, endsOn: date, locked: z.boolean() }).strict();
const course = z.object({ id, code: name, title: name, version, archived: z.boolean(), offeredInYear: z.boolean() }).strict();
export const gpaGradingEvidenceSchema = z.object({ hash, version, policy: standingCapturedGradingPolicySchema,
  provenance: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("confirmed_settings"), unitId: id, version }).strict(),
    z.object({ kind: z.literal("reviewed_release"), releaseId: id, bookId: id, bookVersion: version, createdAt: timestamp }).strict(),
  ])).min(1).max(2),
}).strict();
export const gpaPolicyCatalogSchema = z.object({ schemaVersion: z.literal(1), hashAlgorithm: z.literal(gpaPolicyHashAlgorithm), catalogHash: hash,
  unit: z.object({ id, name }).strict(),
  year: z.object({ id, name, version, startsOn: date, endsOn: date, archived: z.boolean() }).strict(),
  terms: z.array(term).max(gpaPolicyLimits.terms), courses: z.array(course).max(gpaPolicyLimits.courses),
  gradingPolicies: z.array(gpaGradingEvidenceSchema).max(gpaPolicyLimits.catalogPolicies),
  gradeLevels: z.object({ source: z.literal("explicit_configuration_required"), values: z.tuple([]) }).strict(),
}).strict();
export const gpaPolicyEvidenceSchema = gpaPolicyCatalogSchema.omit({ gradeLevels: true }).extend({
  terms: z.array(term).min(1).max(8), courses: z.array(course).min(1).max(200), gradingPolicies: z.array(gpaGradingEvidenceSchema).min(1).max(200),
}).strict();
export const gpaPolicyRecordSchema = z.object({
  id, orgId: id, unitId: id, yearId: id, version, archived: z.boolean(), configuration: termGpaConfigurationSchema,
  draftHash: hash, catalogHash: hash, evidence: gpaPolicyEvidenceSchema,
  activePolicyVersionId: id.nullable(), confirmedVersion: z.number().int().min(0).max(2147483647), hasUnconfirmedChanges: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
export const gpaPolicyVersionSchema = z.object({
  policyVersionId: id, policyId: id, version, draftVersion: version, policyHash: hash, configurationHash: hash,
  policy: termGpaPolicySchema, evidence: gpaPolicyEvidenceSchema,
  sourceDescription: capturedReason, reason: capturedReason, confirmedBy: z.object({ id, name }).strict(), confirmedAt: timestamp,
}).strict();
export const gpaPolicyDetailSchema = z.object({ policy: gpaPolicyRecordSchema, confirmed: gpaPolicyVersionSchema.nullable(),
  allowedActions: z.object({ edit: z.boolean(), confirm: z.boolean(), archive: z.boolean(), restore: z.boolean() }).strict(),
  catalogFreshness: z.literal("compare_with_current_catalog"),
}).strict();
export const gpaPolicyHistorySchema = z.object({ version, action: z.enum(["created", "updated", "confirmed", "archived", "restored"]),
  before: gpaPolicyRecordSchema.nullable(), after: gpaPolicyRecordSchema, reason: capturedReason,
  actor: z.object({ id, name }).strict(), createdAt: timestamp,
}).strict();
export const gpaPolicyMutationResultSchema = z.object({ policy: gpaPolicyRecordSchema, confirmed: gpaPolicyVersionSchema.nullable() }).strict();
export const gpaPolicyListSchema = z.object({ rows: z.array(gpaPolicyRecordSchema).max(50), nextBeforeId: id.nullable() }).strict();
export const gpaPolicyHistoryPageSchema = z.object({ rows: z.array(gpaPolicyHistorySchema).max(50), nextBeforeVersion: version.nullable() }).strict();
export const gpaPolicyVersionsPageSchema = z.object({ rows: z.array(gpaPolicyVersionSchema).max(50), nextBeforeVersion: version.nullable() }).strict();
export type GpaGradingEvidence = z.infer<typeof gpaGradingEvidenceSchema>;
export type GpaPolicyCatalog = z.infer<typeof gpaPolicyCatalogSchema>;
export type GpaPolicyEvidence = z.infer<typeof gpaPolicyEvidenceSchema>;
export type GpaPolicyRecord = z.infer<typeof gpaPolicyRecordSchema>;
export type GpaPolicyVersion = z.infer<typeof gpaPolicyVersionSchema>;
export type GpaPolicyDetail = z.infer<typeof gpaPolicyDetailSchema>;
export type GpaPolicyHistory = z.infer<typeof gpaPolicyHistorySchema>;
export type GpaPolicyMutationResult = z.infer<typeof gpaPolicyMutationResultSchema>;
export type GpaPolicyList = z.infer<typeof gpaPolicyListSchema>;
export type GpaPolicyHistoryPage = z.infer<typeof gpaPolicyHistoryPageSchema>;
export type GpaPolicyVersionsPage = z.infer<typeof gpaPolicyVersionsPageSchema>;
