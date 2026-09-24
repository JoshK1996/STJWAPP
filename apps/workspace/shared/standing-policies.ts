import { z } from "zod";
import { standingPolicySchema, type StandingPolicy } from "./academic-standing";
import type { GradingPolicy } from "./grading";

export const standingPolicyEvidenceVersion = 1 as const;
export const standingPolicyHashAlgorithm = "sha256-canonical-json-v1" as const;
export const standingPolicyLimits = Object.freeze({ catalogPolicies: 200, courses: 1000, terms: 100, page: 50, catalogBytes: 1_048_576 });
const omit = { schemaVersion: true, policyId: true, version: true, orgId: true, unitId: true, yearId: true } as const;
export const standingConfigurationSchema = z.discriminatedUnion("basis", [
  standingPolicySchema.options[0].omit(omit), standingPolicySchema.options[1].omit(omit),
]).superRefine((p, ctx) => {
  for (const [path, values] of [["termIds", p.termIds], ["gradeLevels", p.gradeLevels], ["courseRules", p.courseRules.map(x => x.courseId)], ["acceptedGradingPolicies", p.acceptedGradingPolicies.map(x => x.hash + ":" + x.version)]] as const)
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [path], message: "Choose each identity once." });
  if (p.basis === "awarded_label") p.acceptedGradingPolicies.forEach((r, i) => {
    if (new Set(r.allowedLabels).size !== r.allowedLabels.length) ctx.addIssue({ code: "custom", path: ["acceptedGradingPolicies", i, "allowedLabels"], message: "Choose each label once." });
  });
});
export type StandingConfiguration = z.infer<typeof standingConfigurationSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/), reason = z.string().trim().min(10).max(2000);
const command = { commandId: z.uuid(), reason };
const expected = { expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
export const standingPolicyScopeInput = z.object({ unitId: z.uuid(), yearId: z.uuid() }).strict();
export const standingPolicyListInput = standingPolicyScopeInput.extend({ beforeId: z.uuid().optional() }).strict();
export const standingPolicyHistoryInput = z.object({ beforeVersion: z.coerce.number().int().positive().max(2147483647).optional() }).strict();
export const standingPolicyCreateInput = standingPolicyScopeInput.extend({ ...command, configuration: standingConfigurationSchema, catalogHash: hash }).strict();
export const standingPolicyUpdateInput = z.object({ ...command, ...expected, configuration: standingConfigurationSchema, catalogHash: hash }).strict();
export const standingPolicyConfirmInput = z.object({ ...command, ...expected, draftHash: hash, catalogHash: hash, sourceDescription: z.string().trim().min(10).max(2000), reviewed: z.literal(true) }).strict();
export const standingPolicyArchiveInput = z.object({ ...command, ...expected, archived: z.boolean() }).strict();

export type StandingGradingEvidence = {
  hash: string; version: number; policy: GradingPolicy;
  provenance: Array<{ kind: "confirmed_settings"; unitId: string; version: number } | { kind: "reviewed_release"; releaseId: string; bookId: string; bookVersion: number; createdAt: string }>;
};
export type StandingPolicyCatalog = {
  schemaVersion: 1; hashAlgorithm: typeof standingPolicyHashAlgorithm; catalogHash: string;
  unit: { id: string; name: string }; year: { id: string; name: string; version: number; startsOn: string; endsOn: string; archived: boolean };
  terms: Array<{ id: string; name: string; version: number; startsOn: string; endsOn: string; locked: boolean }>;
  courses: Array<{ id: string; code: string; title: string; version: number; archived: boolean; offeredInYear: boolean }>;
  gradingPolicies: StandingGradingEvidence[];
  gradeLevels: { source: "explicit_configuration_required"; values: [] };
};
export type StandingPolicyEvidence = Pick<StandingPolicyCatalog, "schemaVersion" | "hashAlgorithm" | "catalogHash" | "unit" | "year"> & {
  terms: StandingPolicyCatalog["terms"]; courses: StandingPolicyCatalog["courses"]; gradingPolicies: StandingGradingEvidence[];
};
export type StandingPolicyRecord = {
  id: string; orgId: string; unitId: string; yearId: string; version: number; archived: boolean;
  configuration: StandingConfiguration; draftHash: string; catalogHash: string; evidence: StandingPolicyEvidence;
  activePolicyVersionId: string | null; confirmedVersion: number; hasUnconfirmedChanges: boolean;
  createdAt: string; updatedAt: string;
};
export type StandingPolicyVersion = {
  policyVersionId: string; policyId: string; version: number; draftVersion: number; policyHash: string;
  configurationHash: string; policy: StandingPolicy; evidence: StandingPolicyEvidence;
  sourceDescription: string; reason: string; confirmedBy: { id: string; name: string }; confirmedAt: string;
};
export type StandingPolicyDetail = {
  policy: StandingPolicyRecord; confirmed: StandingPolicyVersion | null;
  allowedActions: { edit: boolean; confirm: boolean; archive: boolean; restore: boolean };
  catalogFreshness: "compare_with_current_catalog";
};
export type StandingPolicyHistory = {
  version: number; action: "created" | "updated" | "confirmed" | "archived" | "restored";
  before: StandingPolicyRecord | null; after: StandingPolicyRecord;
  reason: string; actor: { id: string; name: string }; createdAt: string;
};
export type StandingPolicyMutationResult = { policy: StandingPolicyRecord; confirmed: StandingPolicyVersion | null };
export type StandingPolicyList = { rows: StandingPolicyRecord[]; nextBeforeId: string | null };
export type StandingPolicyHistoryPage = { rows: StandingPolicyHistory[]; nextBeforeVersion: number | null };
export type StandingPolicyVersionsPage = { rows: StandingPolicyVersion[]; nextBeforeVersion: number | null };
