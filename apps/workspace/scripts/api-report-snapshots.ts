import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { prepareSnapshotInput, captureSnapshotInput, snapshotPreviewSchema, snapshotEnvelopeSchema, snapshotSummarySchema } from '../shared/report-snapshots';

const doc = JSON.parse(await readFile('docs/openapi.json', 'utf8'));
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const json = (schema: unknown) => ({ 'application/json': { schema } });
function component(name: string, schema: z.ZodType) {
  const value = z.toJSONSchema(schema);
  // Recursive JSON provenance creates local $defs. Their references must be
  // rooted at this component when the schema is embedded in the OpenAPI file.
  function rebase(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(rebase); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string' && record.$ref.startsWith('#')) record.$ref = '#/components/schemas/' + name + record.$ref.slice(1);
    Object.values(record).forEach(rebase);
  }
  rebase(value); doc.components.schemas[name] = value;
}
component('ReportSnapshotPreview', snapshotPreviewSchema);
component('ReportSnapshotEnvelope', snapshotEnvelopeSchema);
component('ReportSnapshotSummary', snapshotSummarySchema);
doc.components.schemas.ReportSnapshotCapture = object({ snapshot: ref('ReportSnapshotSummary') });
doc.components.schemas.ReportSnapshotList = object({ rows: { type: 'array', maxItems: 50, items: ref('ReportSnapshotSummary') }, nextOffset: { anyOf: [{ type: 'integer', minimum: 0, maximum: 100 }, { type: 'null' }] } });
doc.components.schemas.ReportSnapshotDetail = object({ snapshot: ref('ReportSnapshotEnvelope'), payloadHash: hash, jsonHash: hash, csvHash: hash, bytes: { type: 'integer', minimum: 0 } });
const access = 'Current active password session only, including fresh session/MFA and source permission checks. Private to the account that owns the report; another owner cannot read its copies. The entire captured source manifest is reauthorized, including contributors hidden by selected columns or grouped output. Any inaccessible contributor denies the whole copy; no partial redaction. PIN and bearer access denied. Legacy workforce definitions retain schema1 and millisecond semantics; explicitly selected precisionVersion2 workforce definitions produce strict schema2 copies with exact microsecond strings and UTC6 provenance. Historical files and hashes are never upgraded; an existing v1 preview captures asv1. ';
function add(path: string, method: string, title: string, description: string, response: string, input?: z.ZodType, status = 200) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: uuid }));
  const operation: any = { operationId: method + '_' + path.replace(/[^a-zA-Z]/g, '_'), summary: title, description: access + description, security: [{ Session: [] }], parameters, responses: { [status]: { description: 'Successful operation', content: json(ref(response)) } } };
  for (const [code, description] of Object.entries({ 400: 'Invalid input or report exceeds size limits', 401: 'Session expired or revoked', 403: 'Current account access denied', 404: 'Private report or captured source unavailable', 409: 'Changed definition, expired review, mismatched command or capacity reached', 429: 'Request limit reached', 500: 'Saved report integrity verification failed' })) operation.responses[code] = { description, content: json(ref('Error')) };
  if (input) {
    operation.requestBody = { required: true, content: json(z.toJSONSchema(input, { io: 'input' })) };
    parameters.push({ in: 'header', name: 'Origin', required: true, schema: str, description: 'Exact configured APP_ORIGIN' }, { in: 'header', name: 'X-CSRF-Token', required: true, schema: str, description: 'Current password-session CSRF token from GET /me' });
  }
  doc.paths[path] ??= {}; doc.paths[path][method] = operation;
  return operation;
}
add('/report-library/{id}/snapshot-previews', 'post', 'Prepare a frozen report for human review', 'Reads one repeatable-read source transaction using a fixed as-of clock, then checks fresh access and the saved definition version before returning exact data and SHA-256. Six sources: workforce, care, grades, attendance, finance and compensation. Maximum 20,000 rows, 25 columns, 8 MiB retained representations and authorization manifest; no silent truncation. Three unexpired reviews per account; review expires after ten minutes. Does not approve grades, payroll, attendance or source records.', 'ReportSnapshotPreview', prepareSnapshotInput, 201);
add('/report-library/{id}/snapshot-previews/{previewId}', 'get', 'Reopen an unexpired frozen review', 'Rechecks current source access and returns the original payload. Does not rerun the source. Expired or consumed previews are unavailable.', 'ReportSnapshotPreview');
add('/report-library/{id}/snapshots', 'post', 'Save the exact reviewed report with immutable files', 'Requires expected definition version, original preview ID/payload hash, reviewed=true, a five-character reason and client-generated command UUID. Saves canonical JSON, formula-safe CSV, hashes, manifest, receipt and audit atomically. A matching committed retry returns its original result even after preview expiry or later definition changes, but only after current source access is rechecked. No source rerun. Limits: 100 copies/128 MiB per account, 1,000 copies/1 GiB per organization. Capacity errors preserve existing copies. Archived definitions reject new copies.', 'ReportSnapshotCapture', captureSnapshotInput, 201);
const list = add('/report-library/{id}/snapshots', 'get', 'List currently accessible private saved report copies', 'Retained copies are filtered by current access before pagination. Fifty rows per page; nextOffset is null when complete. Archived definitions retain access to old copies. Source data dates and capture dates are distinct.', 'ReportSnapshotList');
list.parameters.push({ in: 'query', name: 'offset', required: false, schema: { type: 'integer', minimum: 0, maximum: 100, default: 0 } });
add('/report-library/{id}/snapshots/{snapshotId}', 'get', 'Read an immutable saved report and its file hashes', 'Verifies payload, manifest and stored export hashes before returning exact saved content. Superseded retained source revisions stay unchanged; missing or moved source anchors fail closed. Views are audited.', 'ReportSnapshotDetail');
const exported = add('/report-library/{id}/snapshots/{snapshotId}/export', 'get', 'Download retained CSV/JSON or a derived Excel workbook', 'Rechecks source access, verifies integrity and audits the download. Exports never rerun source queries or change the captured as-of time. CSV/JSON retain original bytes; X-Snapshot-SHA256 identifies that retained representation. JSON includes reviewer, reason, definition, rows and provenance. CSV includes capture/source evidence and empty-report metadata. XLSX is generated privately from the saved copy with Data, Provenance and Source JSON sheets. Scalar values remain text, with null/type distinctions preserved in exact embedded source JSON. No formulas, links or macros. Unsupported text fails explicitly; use original JSON/CSV. Bounded fixed-worker generation precedes a fresh full-manifest/current-session proof, immutable byte comparison and atomic audit/final expiry check. One active generation per process/account, 15-second worker deadline, 32MiB generated-byte cap. These are process controls, not a sandbox or distributed limit. Aborted generation discards bytes. XLSX X-Export-SHA256 identifies newly generated workbook bytes; X-Snapshot-Payload-SHA256 identifies original reviewed data. Repeated workbooks need not be byte-identical and never replace retained hashes. A prepared authorized response is not evidence that a client saved/opened it.', 'ReportSnapshotEnvelope');
exported.parameters.push({ in: 'query', name: 'format', required: true, schema: { type: 'string', enum: ['csv', 'json', 'xlsx'] } });
exported.responses['200'] = { description: 'Original retained CSV/JSON bytes or a bounded derived XLSX workbook', headers: { 'X-Snapshot-SHA256': { description:'CSV/JSON only: exact retained representation hash', schema:hash }, 'X-Export-SHA256': {description:'XLSX only: generated workbook hash',schema:hash}, 'X-Snapshot-Payload-SHA256': {description:'XLSX only: original reviewed payload hash',schema:hash}, 'X-Export-Format-Version':{description:'XLSX format version',schema:{type:'integer',const:1}} }, content: { 'text/csv': { schema: str }, 'application/json': { schema: ref('ReportSnapshotEnvelope') }, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':{schema:{type:'string',format:'binary'}} } };
exported.responses['422']={description:'Retained text cannot be represented exactly by this workbook writer, or a bounded workbook size limit was exceeded; original JSON/CSV remain available',content:json(ref('Error'))};
exported.responses['503']={description:'Bounded workbook generation did not complete; no successful download audit or response bytes were published',content:json(ref('Error'))};
await writeFile('docs/openapi.json', JSON.stringify(doc, null, 2) + '\n');
console.log(Object.keys(doc.paths).length + ' documented paths');
