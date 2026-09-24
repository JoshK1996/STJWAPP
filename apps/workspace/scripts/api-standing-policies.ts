import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { standingPolicySchema } from "../shared/academic-standing";
import { gradingPolicySchema } from "../shared/grading";
import {
  standingConfigurationSchema, standingPolicyCreateInput, standingPolicyUpdateInput,
  standingPolicyConfirmInput, standingPolicyArchiveInput, standingPolicyLimits,
} from "../shared/standing-policies";

const doc = JSON.parse(await readFile("docs/openapi.json", "utf8"));
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const str = { type: "string" }, uuid = { ...str, format: "uuid" }, date = { ...str, format: "date" };
const instant = { ...str, format: "date-time" }, hash = { ...str, pattern: "^[a-f0-9]{64}$" };
const bool = { type: "boolean" }, positive = { type: "integer", minimum: 1 };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const array = (items: unknown, maxItems?: number) => ({ type: "array", items, ...(maxItems === undefined ? {} : { maxItems }) });
const json = (schema: unknown) => ({ "application/json": { schema } });
const literal = (value: string | number) => ({ type: typeof value, const: value });
function component(name: string, schema: z.ZodType) {
  const value = z.toJSONSchema(schema, { io: "input" });
  function rebase(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(rebase); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#")) record.$ref = "#/components/schemas/" + name + record.$ref.slice(1);
    Object.values(record).forEach(rebase);
  }
  rebase(value); doc.components.schemas[name] = value;
}
component("StandingConfiguration", standingConfigurationSchema);
component("StandingConfirmedPolicy", standingPolicySchema);
component("StandingCapturedGradingPolicy", gradingPolicySchema);
const unit = object({ id: uuid, name: str });
const year = object({ id: uuid, name: str, version: positive, startsOn: date, endsOn: date, archived: bool });
const terms = array(object({ id: uuid, name: str, version: positive, startsOn: date, endsOn: date, locked: bool }), standingPolicyLimits.terms);
const courses = array(object({ id: uuid, code: str, title: str, version: positive, archived: bool, offeredInYear: bool }), standingPolicyLimits.courses);
const provenance = { oneOf: [
  object({ kind: literal("confirmed_settings"), unitId: uuid, version: positive }),
  object({ kind: literal("reviewed_release"), releaseId: uuid, bookId: uuid, bookVersion: positive, createdAt: instant }),
] };
const gradingEvidence = object({ hash, version: positive, policy: ref("StandingCapturedGradingPolicy"), provenance: array(provenance) });
const evidenceFields = { schemaVersion: literal(1), hashAlgorithm: literal("sha256-canonical-json-v1"), catalogHash: hash,
  unit, year, terms, courses, gradingPolicies: array(gradingEvidence, standingPolicyLimits.catalogPolicies) };
doc.components.schemas.StandingPolicyEvidence = object(evidenceFields);
doc.components.schemas.StandingPolicyCatalog = object({ ...evidenceFields,
  gradeLevels: object({ source: literal("explicit_configuration_required"), values: array(str, 0) }),
});
doc.components.schemas.StandingPolicyRecord = object({
  id: uuid, orgId: uuid, unitId: uuid, yearId: uuid, version: positive, archived: bool,
  configuration: ref("StandingConfiguration"), draftHash: hash, catalogHash: hash, evidence: ref("StandingPolicyEvidence"),
  activePolicyVersionId: nullable(uuid), confirmedVersion: { type: "integer", minimum: 0 }, hasUnconfirmedChanges: bool,
  createdAt: instant, updatedAt: instant,
});
doc.components.schemas.StandingPolicyVersion = object({
  policyVersionId: uuid, policyId: uuid, version: positive, draftVersion: positive, policyHash: hash,
  configurationHash: hash, policy: ref("StandingConfirmedPolicy"), evidence: ref("StandingPolicyEvidence"),
  sourceDescription: str, reason: str, confirmedBy: object({ id: uuid, name: str }), confirmedAt: instant,
});
doc.components.schemas.StandingPolicyMutation = object({ policy: ref("StandingPolicyRecord"), confirmed: nullable(ref("StandingPolicyVersion")) });
doc.components.schemas.StandingPolicyDetail = object({ policy: ref("StandingPolicyRecord"), confirmed: nullable(ref("StandingPolicyVersion")),
  allowedActions: object({ edit: bool, confirm: bool, archive: bool, restore: bool }),
  catalogFreshness: literal("compare_with_current_catalog"),
});
doc.components.schemas.StandingPolicyList = object({ rows: array(ref("StandingPolicyRecord"), standingPolicyLimits.page), nextBeforeId: nullable(uuid) });
doc.components.schemas.StandingPolicyHistoryEntry = object({
  version: positive, action: { ...str, enum: ["created", "updated", "confirmed", "archived", "restored"] },
  before: nullable(ref("StandingPolicyRecord")), after: ref("StandingPolicyRecord"), reason: str,
  actor: object({ id: uuid, name: str }), createdAt: instant,
});
doc.components.schemas.StandingPolicyHistoryPage = object({ rows: array(ref("StandingPolicyHistoryEntry"), standingPolicyLimits.page), nextBeforeVersion: nullable(positive) });
doc.components.schemas.StandingPolicyVersionsPage = object({ rows: array(ref("StandingPolicyVersion"), standingPolicyLimits.page), nextBeforeVersion: nullable(positive) });

const access = "Current active password session with school-office access to the exact unit: owner/admin or explicit unit membership and school-office grant. Fresh session/MFA and authority checks apply after waits and before publication. PIN, bearer, teacher-only, workforce-manager-only and inherited parent-unit access are insufficient. ";
function add(path: string, method: string, summary: string, description: string, response: string, input?: z.ZodType, status = 200) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: "path", name: match[1], required: true, schema: uuid }));
  const op: any = { operationId: method + "_" + path.replace(/[^a-zA-Z]/g, "_"), summary, description: access + description,
    security: [{ Session: [] }], parameters, responses: { [status]: { description: "Successful operation", content: json(ref(response)) } } };
  for (const [code, description] of Object.entries({ 400: "Invalid strict input", 401: "Session expired, changed or revoked", 403: "Current account or required owner access denied", 404: "Scoped policy or source unavailable", 409: "Stale draft/catalog, mismatched command or conflicting state", 422: "Unsupported or excessive source evidence", 429: "Request limit reached", 503: "Source temporarily busy; preserve and retry the same command" }))
    op.responses[code] = { description, content: json(ref("Error")) };
  if (input) {
    op.requestBody = { required: true, content: json(z.toJSONSchema(input, { io: "input" })) };
    parameters.push({ in: "header", name: "Origin", required: true, schema: str, description: "Exact configured APP_ORIGIN" },
      { in: "header", name: "X-CSRF-Token", required: true, schema: str, description: "Current password-session CSRF token" });
  }
  doc.paths[path] ??= {}; doc.paths[path][method] = op;
  return op;
}
const base = "/school/standing/policies";
const scope = ["unitId", "yearId"].map(name => ({ in: "query", name, required: true, schema: uuid }));
const beforeVersion = { in: "query", name: "beforeVersion", required: false, schema: positive };
const catalog = add(base + "/catalog", "get", "Read the exact academic-standing source catalog",
  "Confirmed grading settings and captured reviewed grading policies only; no student grades or rosters. Catalog uses exact captured JSON policy hashes. Course identities belong to the unit, with offeredInYear separately recorded. Grade levels require explicit configuration. Oversized catalogs are rejected without truncation.", "StandingPolicyCatalog");
catalog.parameters.push(...scope);
const list = add(base, "get", "List school-year academic-standing policies", "Explicit draft and confirmed-version state. Fifty policies per page; archived records are retained.", "StandingPolicyList");
list.parameters.push(...scope, { in: "query", name: "beforeId", required: false, schema: uuid });
add(base, "post", "Prepare an academic-standing policy draft",
  "Requires explicit course, term, grade-level, missing-work and grading-evidence choices. The catalog hash must still match. Saves the configuration and reviewed source provenance, history, command receipt and metadata audit atomically. Does not confirm school rules or determine student standing.", "StandingPolicyMutation", standingPolicyCreateInput, 201);
add(base + "/{id}", "get", "Read a policy draft and its active confirmation",
  "Returns current allowed actions. Draft edits do not replace an existing immutable confirmed version. Retained evidence remains readable when current grading settings change.", "StandingPolicyDetail");
add(base + "/{id}", "patch", "Save reviewed academic-standing policy changes",
  "Expected record version and current catalog hash required. Preserves previous history and confirmations. Exact command replay requires current authority and does not repeat the write.", "StandingPolicyMutation", standingPolicyUpdateInput);
add(base + "/{id}/confirm", "post", "Confirm an exact academic-standing policy as owner",
  "Current owner only. Requires reviewed=true, saved draft hash, expected version, current catalog hash, source description and reason. The original reviewed source evidence is retained. Creates a new immutable policy version; no actual school policy is supplied by the app.", "StandingPolicyMutation", standingPolicyConfirmInput);
add(base + "/{id}/archive", "post", "Archive or restore a policy without deleting history",
  "Expected record version and reason required. Prior immutable confirmations and history remain available. Archival prevents new evaluations under this policy.", "StandingPolicyMutation", standingPolicyArchiveInput);
add(base + "/{id}/history", "get", "Read retained policy draft and confirmation history",
  "Version-descending cursor pagination preserves original before/after records, actor identity and reason.", "StandingPolicyHistoryPage").parameters.push(beforeVersion);
add(base + "/{id}/versions", "get", "Read immutable owner-confirmed policy versions",
  "Version-descending cursor pagination. Each version retains exact policy hash, reviewed grading-source evidence, source description and confirmation identity.", "StandingPolicyVersionsPage").parameters.push(beforeVersion);
add(base + "/{id}/versions/{versionId}", "get", "Read one retained owner-confirmed policy",
  "The exact scoped confirmation remains unchanged after later draft edits, replacement confirmations, catalog changes or archival.", "StandingPolicyVersion");
await writeFile("docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(Object.keys(doc.paths).length + " documented paths");
