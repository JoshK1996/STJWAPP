import { digest } from "./security";
import { gradingPolicySchema } from "../shared/grading";
import { standingPolicySchema } from "../shared/academic-standing";

/** Version 1 canonical JSON: lexicographic object keys, preserved array order,
 * JSON primitive encoding. Hash raw validated evidence, never parsed transforms. */
export function canonicalStandingJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStandingJson).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalStandingJson((value as Record<string, unknown>)[key])).join(",") + "}";
  throw new TypeError("Policy evidence must contain only JSON values.");
}
export function gradingPolicyEvidenceHash(policy: unknown): string {
  gradingPolicySchema.parse(policy);
  return digest(canonicalStandingJson({ schemaVersion: 1, kind: "grading_policy", policy }));
}
export function standingPolicyEvidenceHash(policy: unknown): string {
  standingPolicySchema.parse(policy);
  return digest(canonicalStandingJson({ schemaVersion: 1, kind: "standing_policy", policy }));
}
