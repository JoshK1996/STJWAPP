import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  prepareStandingInput, retainStandingInput, eligibleStandingIssuesInput,
  standingDecisionListInput, standingDecisionExportInput, standingReviewDataSchema,
  standingPreviewSchema, standingDecisionEnvelopeSchema, standingDecisionSummarySchema,
  standingDecisionDetailSchema, standingDecisionListSchema, eligibleStandingIssuesSchema,
  standingDecisionCurrentnessSchema,
} from "../shared/standing-decisions";

const doc = JSON.parse(await readFile("docs/openapi.json", "utf8"));
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const text = { type: "string" }, uuid = { ...text, format: "uuid" };
const json = (schema: unknown) => ({ "application/json": { schema } });
function component(name: string, schema: z.ZodType) {
  const value = z.toJSONSchema(schema, { io: "output" });
  function rebase(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(rebase); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#")) record.$ref = "#/components/schemas/" + name + record.$ref.slice(1);
    Object.values(record).forEach(rebase);
  }
  rebase(value); doc.components.schemas[name] = value;
}
for (const [name, schema] of Object.entries({
  StandingReviewData: standingReviewDataSchema, StandingPreview: standingPreviewSchema,
  StandingDecisionEnvelope: standingDecisionEnvelopeSchema, StandingDecisionSummary: standingDecisionSummarySchema,
  StandingDecisionDetail: standingDecisionDetailSchema, StandingDecisionList: standingDecisionListSchema,
  EligibleStandingIssues: eligibleStandingIssuesSchema, StandingDecisionCurrentness: standingDecisionCurrentnessSchema,
})) component(name, schema);
doc.components.schemas.StandingDecisionSavedJson = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "snapshotHash", "decision"],
  properties: { schemaVersion: { type: "integer", const: 1 }, snapshotHash: { ...text, pattern: "^[a-f0-9]{64}$" }, decision: ref("StandingDecisionEnvelope") },
};

const access = "Current active password session and school-office access to the exact unit are required. Owners/admins have organization scope; other staff need explicit unit membership and its office grant. PIN, bearer, teacher-only and inherited parent-unit access are insufficient. Current role, session, MFA and grants are rechecked after relevant waits and before publication. ";
const privateHeaders = { "Cache-Control": { description: "Private evidence is never cacheable.", schema: { type: "string", const: "private, no-store" } } };
function add(path: string, method: string, summary: string, description: string, response: string, input?: z.ZodType, status = 200) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: "path", name: match[1], required: true, schema: uuid }));
  const op: any = { operationId: method + "_" + path.replace(/[^a-zA-Z]/g, "_"), summary, description: access + description,
    security: [{ Session: [] }], parameters,
    responses: { [status]: { description: "Successful operation", headers: privateHeaders, content: json(ref(response)) } } };
  for (const [code, description] of Object.entries({
    400: "Invalid strict input", 401: "Current session expired, changed or revoked", 403: "Current account access denied",
    404: "Scoped record unavailable; private preview may be expired or consumed",
    409: "Changed reviewed sources, predecessor, policy or command body, or bounded preview/retention capacity reached",
    422: "Inconsistent or unsupported evidence", 429: "Another source extraction is active or request rate limit reached",
    503: "Temporarily busy; preserve the exact pending retention command and retry",
  })) op.responses[code] = { description, content: json(ref("Error")) };
  if (input) {
    op.requestBody = { required: true, content: json(z.toJSONSchema(input, { io: "input" })) };
    parameters.push({ in: "header", name: "Origin", required: true, schema: text, description: "Exact configured APP_ORIGIN" },
      { in: "header", name: "X-CSRF-Token", required: true, schema: text, description: "Current password-session CSRF token" });
  }
  doc.paths[path] ??= {}; doc.paths[path][method] = op;
  return op;
}
function query(op: any, schema: z.ZodType) {
  const shape = z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, unknown>; required?: string[] };
  for (const [name, field] of Object.entries(shape.properties)) op.parameters.push({ in: "query", name, required: shape.required?.includes(name) ?? false, schema: field });
}
const base = "/school/standing";
query(add(base + "/eligible-issues", "get", "Find exact issued report-card copies for one term",
  "Returns currently issued latest copies for the selected student/year/term, with identities and hashes but no grades. Requires an explicit choice even when one copy is returned. More than fifty eligible copies is rejected, never silently truncated.", "EligibleStandingIssues"), eligibleStandingIssuesInput);
add(base + "/previews", "post", "Prepare a private student standing review",
  "Uses an explicit immutable confirmed policy and issued card. A repeatable-read student-only extraction is followed by fresh authority, policy and source locks before publication. Returns complete rules, labels, evidence and a server-calculated per-term outcome. Missing or changed sources remain explicit incomplete evidence. No annual mean, award, rank, grade or graduation record is created. Preview expires after ten minutes; three active previews per account, one hundred or 128 MiB per organization, and eight MiB per preview apply.", "StandingPreview", prepareStandingInput, 201);
add(base + "/previews/{id}", "get", "Read the preparer's unconsumed private review",
  "Only the currently authorized preparing account can read it. Expired, consumed, inaccessible and unknown previews return the same unavailable result. Preview reads do not create a decision or extend expiry.", "StandingPreview");
const retain = add(base + "/decisions", "post", "Retain the exact reviewed term determination",
  "Requires an explicit acknowledgment, reason, preview hash, expected policy/card/predecessor and command UUID. Rechecks the complete source under locks. Decision, exact JSON/CSV bytes, predecessor link, preview consumption, receipt and metadata audit commit atomically. Incomplete reviews stay incomplete. An exact committed retry returns its immutable original receipt after current authority checks, even when the preview expired or was purged and sources or policy changed. Do not replace the command UUID after a transport failure or 503. At most 1,000 retained decisions or one GiB of stored representations per organization; eight MiB per decision. No existing record is evicted to satisfy capacity.", "StandingDecisionSummary", retainStandingInput, 201);
retain.responses[200] = { description: "Exact previously committed command under current authority", headers: privateHeaders, content: json(ref("StandingDecisionSummary")) };
query(add(base + "/decisions", "get", "List institutional standing reviews with scoped pagination",
  "Returns fifty records per page ordered by captured timestamp and ID. latestOnly accepts only literal true/false strings; true selects the authoritative series pointer. Follow every cursor before claiming no decision exists. Scope filters apply on each page. A scoped revision in the opaque cursor detects concurrent additions; 409 requires discarding partial pages and loading again from the beginning. Current office authority permits retained history after student withdrawal or policy archival; list reads do not re-evaluate outcomes.", "StandingDecisionList"), standingDecisionListInput);
add(base + "/decisions/{id}", "get", "Read immutable standing evidence and file hashes",
  "An institutional record available to currently authorized office staff in its exact unit. Captured labels, reviewer, policy, source, result and reason remain unchanged. Current student enrollment or an active policy is not required to read retained evidence. The response makes no claim about current source freshness.", "StandingDecisionDetail");
const download = add(base + "/decisions/{id}/export", "get", "Download the saved standing JSON or CSV bytes",
  "Returns exact stored UTF-8 bytes after current office authorization and integrity verification. No current grades replace the recorded result. Filename is standing-decision-<UUID>-v1.json or .csv. CSV is formula-safe long form with an evaluation row, course rows and explicit blockers/failures; unavailable grades are blank. Exact mean fractions and labeled display values remain separate. The header hash covers the complete returned file bytes, including CSV BOM/CRLF.", "StandingDecisionSavedJson");
query(download, standingDecisionExportInput);
download.responses[200].content = { ...json(ref("StandingDecisionSavedJson")), "text/csv": { schema: text } };
download.responses[200].headers = { ...privateHeaders,
  "Content-Disposition": { description: "Attachment with a fixed UUID-based versioned filename.", schema: text },
  "X-STJW-File-SHA256": { description: "SHA-256 of the exact stored response bytes.", schema: { ...text, pattern: "^[a-f0-9]{64}$" } },
};
add(base + "/decisions/{id}/currentness", "get", "Check current sources separately from a saved outcome",
  "Performs an explicit bounded check and labels source, policy and card state at checkedAt. Changed/unavailable sources never rewrite the retained outcome. Authorization/session failures are errors, never disguised as unavailable source evidence.", "StandingDecisionCurrentness");
await writeFile("docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(Object.keys(doc.paths).length + " documented paths");
