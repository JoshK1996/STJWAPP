import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { timetableCalendarExportInput } from "../shared/timetable-export";

const doc = JSON.parse(await readFile("docs/openapi.json", "utf8"));
const str = { type: "string" }, hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const responses: Record<string, unknown> = {};
for (const [code, description] of Object.entries({ 400: "Invalid, empty or oversized request", 401: "Session expired, changed or revoked", 403: "Current school access denied", 404: "Requested school/class/student identity unavailable", 409: "Timetable revision changed or source cannot be exported completely", 429: "Request limit reached" })) {
  responses[code] = { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
}
responses["200"] = { description: "Complete private timetable calendar copy; maximum 2,000 occurrences and 5 MiB. No subscription, invitation or automatic update.",
  headers: { "X-STJW-Timetable-Revision": { schema: { type: "integer", minimum: 0 } }, "X-STJW-Source-SHA256": { schema: hash }, "X-STJW-File-SHA256": { schema: hash }, "X-STJW-Occurrence-Count": { schema: { type: "integer", minimum: 1, maximum: 2000 } }, "Content-Disposition": { schema: str }, "Cache-Control": { schema: { type: "string", const: "private, no-store" } } },
  content: { "text/calendar": { schema: str } } };
doc.paths["/school/timetable/export"] = { post: {
  operationId: "post_school_timetable_export", summary: "Download the reviewed instructional timetable as ICS",
  description: "Current active password session and CSRF required. Three completed transactions separate current authority, academic-locked source extraction, and fresh publication authority. Exact unit/year and intersecting class/teacher filters; exact student-number filtering requires current office access throughout. Teachers need current unit membership and every exported class assignment. No parent-unit inheritance, roster identities, teacher names or emails in file. Inclusive local dates, maximum 367 days. expectedRevision must match the loaded timetable. Changed source returns409; refresh explicitly. Reject any source issue, empty or oversized result without a partial file. Stable organization/meeting/local-date UID and revision timestamp; full scheduled UTC occurrence times. Later edits do not update downloaded copies. Metadata-only atomic audit and final session/MFA check before bytes are returned.",
  security: [{ Session: [] }], parameters: [
    { in: "header", name: "Origin", required: true, schema: str, description: "Exact configured APP_ORIGIN" },
    { in: "header", name: "X-CSRF-Token", required: true, schema: str, description: "Current password-session CSRF token" },
  ], requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(timetableCalendarExportInput, { io: "input" }) } } }, responses,
} };
const view = doc.paths["/school/timetable"]?.get;
if (view) {
  const note = " JSON additionally includes revision (nonnegative organization timetable revision) and calendarRevisedAt (UTC representation timestamp) captured with the displayed rows under the academic lock. Migration023 establishes the timestamp baseline for existing revisions; it does not reconstruct old edit times. CSV columns are unchanged.";
  if (!view.description.includes("calendarRevisedAt")) view.description += note;
}
await writeFile("docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(Object.keys(doc.paths).length + " documented paths");
