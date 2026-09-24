import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as time from '../shared/time-adjustments';

const doc = JSON.parse(await readFile('docs/openapi.json', 'utf8'));
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const text = { type: 'string' }, uuid = { ...text, format: 'uuid' };
const json = (schema: unknown) => ({ 'application/json': { schema } });
const privateHeaders = { 'Cache-Control': { schema: { const: 'private, no-store', type: 'string' } } };
function component(name: string, schema: z.ZodType) {
  const value = z.toJSONSchema(schema, { io: 'output' });
  function rebase(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(rebase); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string' && record.$ref.startsWith('#')) record.$ref = '#/components/schemas/' + name + record.$ref.slice(1);
    Object.values(record).forEach(rebase);
  }
  rebase(value); doc.components.schemas[name] = value;
}
for (const [name, schema] of Object.entries({
  TimeAdjustmentSnapshot: time.timeSnapshotSchema, TimeAdjustmentEnvelope: time.timeAdjustmentEnvelopeSchema,
  TimeAdjustmentDetail: time.timeAdjustmentDetailSchema, TimeAdjustmentReceipt: time.timeAdjustmentReceiptSchema,
  TimeAdjustmentSource: time.timeAdjustmentSourceSchema, TimeAdjustmentOptions: time.timeAdjustmentOptionsSchema,
  TimeAdjustmentHistory: time.timeAdjustmentHistorySchema, TimeAdjustmentHistoryEntry: time.timeAdjustmentHistoryEntrySchema,
  TimeAdjustmentList: time.timeAdjustmentListSchema, OpenTimeShifts: time.openTimeShiftsSchema,
})) component(name, schema);
const access = 'Current active password-session identity and full captured/current unit scope are checked under account locks, including final session expiry/MFA checks. PIN and bearer tokens are denied. Employees read their own evidence; reporting roles require all units for other employees. Manager membership is explicit per subgroup. Private, no-store responses. ';
function add(path: string, method: string, summary: string, description: string, response: string, input?: z.ZodType, status = 200) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: uuid }));
  const operation: any = { operationId: method + '_' + path.replace(/[^a-zA-Z]/g, '_'), summary, description: access + description,
    security: [{ Session: [] }], parameters, responses: { [status]: { description: 'Successful operation', headers: privateHeaders, content: json(ref(response)) } } };
  for (const [code, description] of Object.entries({ 400: 'Invalid input', 401: 'Session missing, expired or changed', 403: 'Current access denied', 404: 'Scoped record unavailable', 409: 'Source, version, cursor, overlap or command conflict', 422: 'Unsupported or inconsistent source evidence', 429: 'Attempt limit reached', 503: 'Temporary transaction conflict; retry the identical command' }))
    operation.responses[code] = { description, content: json(ref('Error')) };
  if (input) {
    operation.requestBody = { required: true, content: json(z.toJSONSchema(input, { io: 'input' })) };
    parameters.push({ in: 'header', name: 'Origin', required: true, schema: text, description: 'Exact configured APP_ORIGIN' },
      { in: 'header', name: 'X-CSRF-Token', required: true, schema: text, description: 'Current password-session CSRF token from GET /me' });
  }
  (doc.paths[path] ??= {})[method] = operation; return operation;
}
function query(operation: any, schema: z.ZodType) {
  const shape = z.toJSONSchema(schema, { io: 'input' }) as any;
  for (const [name, field] of Object.entries(shape.properties)) operation.parameters.push({ in: 'query', name, required: shape.required?.includes(name) ?? false, schema: field });
}
const base = '/time-adjustments';
query(add(base + '/options', 'get', 'Read current employee and job choices',
  'Requires an explicit employeeId. Current assigned active jobs are offered for a missing shift. Employees/finance propose for themselves; managers may propose for permitted employees, including inactive employees with valid current assignments. No job or time is inferred.', 'TimeAdjustmentOptions'), time.timeAdjustmentOptionsInput);
query(add(base + '/closure-source', 'get', 'Read the exact active source for a proposed closure',
  'Requires shiftId. Returns the complete active revision, immutable source hash, exact UTC source instants and current observation time. The recorded null end stays null and completed totals stay unknown. No clock action occurs.', 'TimeAdjustmentSource'), time.timeAdjustmentSourceInput);
query(add(base + '/open-shifts', 'get', 'Discover current open shifts independently of date filters',
  'Fifty rows per page with current full-source scope. Includes older open shifts without an age cutoff or automatic closure. A changed scoped cursor revision returns409: discard prior pages and reload. Pending counts include only currently visible requests.', 'OpenTimeShifts'), time.openTimeShiftsInput);
query(add(base, 'get', 'List missing-shift and closure review requests',
  'Supply both inclusive organization-calendar start/end dates (at most367 days), or an exact sourceShiftId. Date filters mean proposed work overlaps the range, not submission date. Optional employee/kind/status filters. Fifty rows per page. A changed scoped revision returns409 and requires discarding accumulated pages.', 'TimeAdjustmentList'), time.timeAdjustmentListInput);
const proposal = add(base, 'post', 'Submit a missing shift or reviewed closure proposal',
  'Missing shifts require complete contiguous work/break segments, assigned active jobs and a positive overall duration. Closure requires the exact current sourceHash and one explicit proposed end. New entered instants are UTC with at most3 fractional digits; recorded source instants retain up to6. At most200 segments. Reason and command UUID are required. Submission changes no clock record. The same body/command retry returns the retained receipt after current authorization.', 'TimeAdjustmentReceipt', time.proposeTimeAdjustmentInput, 201);
proposal.responses[200] = { description: 'Exact successful command replay under current authority', headers: privateHeaders, content: json(ref('TimeAdjustmentReceipt')) };
add(base + '/{id}', 'get', 'Read immutable proposal and separately labeled current readiness',
  'Original/proposed/result evidence and hashes remain immutable. Readiness and allowedActions describe current approval eligibility separately. A stale request may remain independently declinable or author-cancellable. Microsecond totals are decimal integer strings; a source without an end has null completed totals.', 'TimeAdjustmentDetail');
add(base + '/{id}/history', 'get', 'Read retained submitted and terminal request evidence',
  'At most two immutable versions. Captured identities, reasons and exact raw timestamps remain unchanged after later edits to employee labels or time revisions.', 'TimeAdjustmentHistory');
const download = add(base + '/{id}/export', 'get', 'Download exact retained time-adjustment evidence',
  'Explicit json/csv format and optional version1/2. Defaults to current request version. Returns stored UTF-8 bytes with their exact SHA-256, including CSV BOM/CRLF, after current authority and integrity checks. Historical null ends remain blank in CSV and null in JSON; unavailable duration is not zero.', 'TimeAdjustmentHistoryEntry');
query(download, time.timeAdjustmentExportInput);
download.responses[200].content = { ...json(ref('TimeAdjustmentHistoryEntry')), 'text/csv': { schema: text } };
download.responses[200].headers = { ...privateHeaders, 'Content-Disposition': { description: 'Fixed UUID-based attachment filename.', schema: text },
  'X-Content-SHA256': { description: 'SHA-256 of the exact returned bytes.', schema: { ...text, pattern: '^[a-f0-9]{64}$' } } };
add(base + '/{id}/review', 'post', 'Independently approve and apply, or decline a proposal',
  'Reviewer must be a current scoped manager/owner/admin other than both proposer and affected employee. Version1, exact requestHash, note and command UUID are required. Approval revalidates complete source, job scope and overlap under the employee lock. Missing shifts create a closed revision1; closure appends a completed revision preserving the original null-ended segments. Result, history, receipt and audit commit atomically. Decline changes only request state. Exact retries return the original outcome even after later time corrections.', 'TimeAdjustmentReceipt', time.reviewTimeAdjustmentInput);
add(base + '/{id}/cancel', 'post', 'Cancel an owned pending time-adjustment proposal',
  'Current proposer with current self/management scope only. Version1, requestHash, reason and command UUID required. No clock record changes. Terminal outcomes and exact successful receipts are immutable.', 'TimeAdjustmentReceipt', time.cancelTimeAdjustmentInput);
await writeFile('docs/openapi.json', JSON.stringify(doc, null, 2) + '\n');
console.log(Object.keys(doc.paths).length + ' documented paths');
