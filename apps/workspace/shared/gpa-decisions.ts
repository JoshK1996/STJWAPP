import { z } from "zod";
import { standingSourceSchema } from "./academic-standing";
import { standingEvidenceSchema, standingLabelsSchema } from "./standing-evidence";
import { termGpaCalculatorVersion, termGpaPolicySchema, termGpaResultSchema } from "./term-gpa";
import { gpaPolicyEvidenceSchema, gpaPolicyVersionSchema } from "./gpa-policies";

export const gpaDecisionLimits = Object.freeze({ bytes: 8 * 1024 * 1024, previews: 3, previewMinutes: 10,
  organizationPreviews: 100, organizationPreviewBytes: 128 * 1024 * 1024,
  organizationCount: 1000, organizationBytes: 1024 * 1024 * 1024, page: 50, cursorCharacters: 384 });
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), utc = z.iso.datetime({ precision: 3 });
const positive = z.number().int().positive().max(2147483647), nonnegative = z.number().int().min(0).max(2147483647);
const reason = z.string().trim().min(10).max(2000), capturedReason = z.string().min(10).max(2000);
const person = z.object({ id, name: z.string().min(1).max(5000) }).strict();
const cursor = z.string().min(1).max(gpaDecisionLimits.cursorCharacters).regex(/^[A-Za-z0-9_-]+$/);

export const prepareGpaInput = z.object({ policyVersionId: id, studentId: id, yearId: id, termId: id, reportCardIssueId: id }).strict();
export const retainGpaInput = z.object({ previewId: id, previewHash: hash, expectedPolicyVersionId: id,
  expectedCardVersion: positive, expectedLatestDecisionId: id.nullable(), reviewed: z.literal(true), reason, commandId: id }).strict();
export const eligibleGpaIssuesInput = z.object({ unitId: id, studentId: id, yearId: id, termId: id }).strict();
export const gpaDecisionListInput = z.object({ unitId: id, studentId: id, yearId: id, termId: id.optional(), policyId: id.optional(),
  latestOnly: z.enum(["true", "false"]).optional().transform(value => value === "true"), cursor: cursor.optional() }).strict();
export const gpaDecisionCursorSchema = z.object({ schemaVersion: z.literal(1), capturedAt: utc, id,
  revision: nonnegative.max(gpaDecisionLimits.organizationCount), filterHash: hash }).strict();
export const gpaDecisionExportInput = z.object({ format: z.enum(["json", "csv"]) }).strict();

export const gpaReviewDataSchema = z.object({ schemaVersion: z.literal(1), calculatorVersion: z.literal(termGpaCalculatorVersion),
  policyVersion: z.object({ id, policyId: id, version: positive, hash, configurationHash: hash }).strict(),
  policyConfirmation: z.object({ sourceDescription: capturedReason, reason: capturedReason,
    confirmedBy: person, confirmedAt: gpaPolicyVersionSchema.shape.confirmedAt, evidence: gpaPolicyEvidenceSchema }).strict(),
  policy: termGpaPolicySchema, source: standingSourceSchema, result: termGpaResultSchema,
  labels: standingLabelsSchema, evidence: standingEvidenceSchema,
  expected: z.object({ policyVersionId: id, policyHash: hash, cardId: id, cardVersion: positive, issueId: id, issueHash: hash,
    currentSourceHash: hash.nullable(), comparisonHash: hash, latestDecisionId: id.nullable(), latestDecisionNumber: nonnegative }).strict(),
}).strict();
export const gpaPreviewSchema = z.object({ id, expiresAt: utc, previewHash: hash, data: gpaReviewDataSchema }).strict();
export const gpaDecisionEnvelopeSchema = z.object({ schemaVersion: z.literal(1), id, seriesId: id, number: positive,
  supersedesId: id.nullable(), previewId: id, previewHash: hash, capturedAt: utc, reviewedBy: person,
  reason: capturedReason, data: gpaReviewDataSchema }).strict();

const totals = termGpaResultSchema.shape.totals.unwrap();
/** Reuse the calculator's reduced exact fraction and configured display shapes.
 * Historical integrity additionally binds this summary to its verified full result. */
export const exactGpaSummarySchema = totals.shape.gpa.extend({ display: totals.shape.display, displayRule: totals.shape.displayRule }).strict();
export const gpaDecisionSummarySchema = z.object({ id, seriesId: id, number: positive, supersedesId: id.nullable(),
  policyVersionId: id, outcome: z.enum(["calculated", "incomplete"]), gpa: exactGpaSummarySchema.nullable(),
  snapshotHash: hash, jsonHash: hash, csvHash: hash, capturedAt: utc }).strict().superRefine((value, ctx) => {
  if ((value.outcome === "incomplete") !== (value.gpa === null))
    ctx.addIssue({ code: "custom", path: ["gpa"], message: "Only calculated results have an exact GPA summary." });
});
export const gpaDecisionDetailSchema = z.object({ decision: gpaDecisionEnvelopeSchema, snapshotHash: hash, jsonHash: hash, csvHash: hash,
  jsonBytes: nonnegative.max(gpaDecisionLimits.bytes), csvBytes: nonnegative.max(gpaDecisionLimits.bytes) }).strict();
export const gpaDecisionListSchema = z.object({ items: z.array(gpaDecisionSummarySchema.safeExtend({ studentId: id, yearId: id, termId: id,
  policyId: id, policyVersion: positive, latest: z.boolean() })).max(gpaDecisionLimits.page), nextCursor: cursor.nullable() }).strict();
export const gpaRetainResultSchema = z.object({ decision: gpaDecisionSummarySchema, replayed: z.boolean() }).strict();
export const eligibleGpaIssuesSchema = z.object({ items: z.array(z.object({ cardId: id, cardVersion: positive, issueId: id,
  issueNumber: positive, issueHash: hash, termIds: z.array(id).min(1).max(8), issuedAt: utc }).strict()).max(gpaDecisionLimits.page) }).strict();
export const gpaDecisionCurrentnessSchema = z.object({ checkedAt: utc,
  state: z.enum(["matches_current_sources", "source_changed", "source_check_unavailable"]),
  policyState: z.enum(["current", "superseded", "archived"]), cardState: z.enum(["current", "changed", "unavailable"]) }).strict();

export type PrepareGpa = z.infer<typeof prepareGpaInput>;
export type RetainGpa = z.infer<typeof retainGpaInput>;
export type GpaReviewData = z.infer<typeof gpaReviewDataSchema>;
export type GpaPreview = z.infer<typeof gpaPreviewSchema>;
export type GpaDecisionEnvelope = z.infer<typeof gpaDecisionEnvelopeSchema>;
export type ExactGpaSummary = z.infer<typeof exactGpaSummarySchema>;
export type GpaDecisionSummary = z.infer<typeof gpaDecisionSummarySchema>;
export type GpaDecisionDetail = z.infer<typeof gpaDecisionDetailSchema>;
export type GpaDecisionList = z.infer<typeof gpaDecisionListSchema>;
export type GpaRetainResult = z.infer<typeof gpaRetainResultSchema>;
export type EligibleGpaIssues = z.infer<typeof eligibleGpaIssuesSchema>;
export type GpaDecisionCurrentness = z.infer<typeof gpaDecisionCurrentnessSchema>;
export type GpaDecisionCursor = z.infer<typeof gpaDecisionCursorSchema>;
