import { z } from "zod";
import { standingPolicySchema, standingSourceSchema, standingResultSchema, standingCalculatorVersion } from "./academic-standing";
import { standingEvidenceSchema, standingLabelsSchema } from "./standing-evidence";

export const standingDecisionLimits = Object.freeze({ bytes: 8 * 1024 * 1024, previews: 3, previewMinutes: 10,
  organizationPreviews: 100, organizationPreviewBytes: 128 * 1024 * 1024,
  organizationCount: 1000, organizationBytes: 1024 * 1024 * 1024, page: 50 });
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), utc = z.iso.datetime();
const positive = z.number().int().positive().max(2147483647), nonnegative = z.number().int().min(0).max(2147483647);
const reason = z.string().trim().min(10).max(2000), outcome = z.enum(["qualifies", "does_not_qualify", "incomplete"]);
export const prepareStandingInput = z.object({ policyVersionId: id, studentId: id, yearId: id, termId: id, reportCardIssueId: id }).strict();
export const retainStandingInput = z.object({ previewId: id, previewHash: hash, expectedPolicyVersionId: id,
  expectedCardVersion: positive, expectedLatestDecisionId: id.nullable(), reviewed: z.literal(true), reason, commandId: id }).strict();
export const eligibleStandingIssuesInput = z.object({ unitId: id, studentId: id, yearId: id, termId: id }).strict();
export const standingDecisionListInput = z.object({ unitId: id, studentId: id, yearId: id, termId: id.optional(), policyId: id.optional(),
  latestOnly: z.enum(["true", "false"]).optional().transform(v => v === "true"), cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
export const standingDecisionCursorSchema = z.object({ capturedAt: utc, id, revision: nonnegative.max(standingDecisionLimits.organizationCount) }).strict();
export const standingDecisionExportInput = z.object({ format: z.enum(["json", "csv"]) }).strict();
export const standingReviewDataSchema = z.object({ schemaVersion: z.literal(1), calculatorVersion: z.literal(standingCalculatorVersion),
  policyVersion: z.object({ id, policyId: id, version: positive, hash }).strict(),
  policyConfirmation: z.object({ sourceDescription: z.string().min(10).max(2000), reason: z.string().min(10).max(2000),
    confirmedBy: z.object({ id, name: z.string().min(1).max(5000) }).strict(), confirmedAt: utc,
    courses: z.array(z.object({ id, code: z.string().min(1).max(5000), title: z.string().min(1).max(5000) }).strict()).max(200) }).strict(),
  policy: standingPolicySchema, source: standingSourceSchema, result: standingResultSchema, labels: standingLabelsSchema, evidence: standingEvidenceSchema,
  expected: z.object({ policyVersionId: id, policyHash: hash, cardId: id, cardVersion: positive, issueId: id, issueHash: hash,
    currentSourceHash: hash.nullable(), comparisonHash: hash, latestDecisionId: id.nullable(), latestDecisionNumber: nonnegative }).strict(),
}).strict();
export const standingPreviewSchema = z.object({ id, expiresAt: utc, previewHash: hash, data: standingReviewDataSchema }).strict();
export const standingDecisionEnvelopeSchema = z.object({ schemaVersion: z.literal(1), id, seriesId: id, number: positive,
  supersedesId: id.nullable(), previewId: id, previewHash: hash, capturedAt: utc,
  reviewedBy: z.object({ id, name: z.string().min(1).max(5000) }).strict(), reason, data: standingReviewDataSchema }).strict();
export const standingDecisionSummarySchema = z.object({ id, seriesId: id, number: positive, supersedesId: id.nullable(),
  policyVersionId: id, outcome, snapshotHash: hash, jsonHash: hash, csvHash: hash, capturedAt: utc }).strict();
export const standingDecisionDetailSchema = z.object({ decision: standingDecisionEnvelopeSchema, snapshotHash: hash, jsonHash: hash, csvHash: hash,
  jsonBytes: nonnegative.max(standingDecisionLimits.bytes), csvBytes: nonnegative.max(standingDecisionLimits.bytes) }).strict();
export const standingDecisionListSchema = z.object({ items: z.array(standingDecisionSummarySchema.extend({ studentId: id, yearId: id, termId: id,
  policyId: id, policyVersion: positive, latest: z.boolean() }).strict()).max(standingDecisionLimits.page), nextCursor: z.string().max(200).nullable() }).strict();
export const eligibleStandingIssuesSchema = z.object({ items: z.array(z.object({ cardId: id, cardVersion: positive, issueId: id, issueNumber: positive,
  issueHash: hash, termIds: z.array(id).min(1).max(8), issuedAt: utc }).strict()).max(standingDecisionLimits.page) }).strict();
export const standingDecisionCurrentnessSchema = z.object({ checkedAt: utc,
  state: z.enum(["matches_current_sources", "source_changed", "source_check_unavailable"]),
  policyState: z.enum(["current", "superseded", "archived"]), cardState: z.enum(["current", "changed", "unavailable"]) }).strict();
export type PrepareStanding = z.infer<typeof prepareStandingInput>;
export type RetainStanding = z.infer<typeof retainStandingInput>;
export type StandingReviewData = z.infer<typeof standingReviewDataSchema>;
export type StandingPreview = z.infer<typeof standingPreviewSchema>;
export type StandingDecisionEnvelope = z.infer<typeof standingDecisionEnvelopeSchema>;
export type StandingDecisionSummary = z.infer<typeof standingDecisionSummarySchema>;
export type StandingDecisionDetail = z.infer<typeof standingDecisionDetailSchema>;
export type StandingDecisionList = z.infer<typeof standingDecisionListSchema>;
export type EligibleStandingIssues = z.infer<typeof eligibleStandingIssuesSchema>;
export type StandingDecisionCurrentness = z.infer<typeof standingDecisionCurrentnessSchema>;
