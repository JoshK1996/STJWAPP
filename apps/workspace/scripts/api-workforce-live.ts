import { staffAssignmentsInput, staffAssignmentsSnapshot } from '../shared/staff-assignments';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { staffTemporaryCredentialsInput, staffTemporaryCredentialsResult } from '../shared/temporary-credentials';
import { clockPolicyInput, cancelPreclockInput } from '../shared/scheduled-clock';
import { workforceUtcMicrosSchema } from '../shared/workforce-reports-v2';
import { workforceOverviewQuerySchema, workforceOverviewSchema, allowanceSnapshotInput, allowanceSnapshotReceipt, allowanceSnapshotSchema, allowanceSnapshotListSchema } from '../shared/workforce-overview';
import { workforceImportPreviewInput, workforceImportApplyInput, workforceImportDetail, workforceImportReceipt, workforceImportList } from '../shared/workforce-imports';

const file = 'docs/openapi.json', doc = JSON.parse(await readFile(file, 'utf8')), schemas = doc.components.schemas;
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, instant = { type: 'string', format: 'date-time' }, bool = { type: 'boolean' }, version = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: unknown, maxItems?: number) => ({ type: 'array', items, ...(maxItems === undefined ? {} : { maxItems }) });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const put = (name: string, schema: z.ZodType, io: 'input' | 'output' = 'output') => { schemas[name] = z.toJSONSchema(schema, { io }); return ref(name); };
const session = 'Actual current browser session in the same organization, completed onboarding and any required password MFA proof. API bearer tokens cannot use this operation. ';
const reporting = 'Current developer/owner/administrator/finance or explicitly scoped manager; actual password session or current reports:read bearer proof. Scope and proof are rechecked before publication. ';
const write = 'Writes require exact configured Origin, application/json and X-CSRF-Token from /me. ';
function add(path: string, method: string, summary: string, description: string, response: unknown, input?: unknown,
  options: { report?: boolean; status?: number; query?: any[]; media?: string; pin?: boolean } = {}) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: match[1] === 'kind' ? { type: 'string', enum: ['jobs', 'schedules'] } : uuid }));
  parameters.push(...(options.query ?? []));
  if (method !== 'get') parameters.push({ in: 'header', name: 'Origin', required: true, schema: str }, { in: 'header', name: 'X-CSRF-Token', required: true, schema: str });
  const responses: Record<string, unknown> = { [options.status ?? 200]: { description: 'Successful operation', content: options.media ? { [options.media]: { schema: response } } : json(response) } };
  for (const [status, detail] of Object.entries({400:'Invalid input or domain validation',401:'Missing, expired, revoked or changed proof',403:'Current role, exact scope, mode, MFA, Origin or CSRF denied',404:'Record unavailable in this account or organization',409:'Conflicting state, source revision, preview expiry or changed command payload',413:'Source or result size exceeded',422:'Retained source evidence inconsistent',429:'Attempt/admission limit reached',503:'Transaction/worker temporarily unavailable; follow the documented retry guidance'})) responses[status] = { description: detail, content: json(ref('Error')) };
  (doc.paths[path] ??= {})[method] = { operationId: method + '_' + path.replace(/[^a-zA-Z0-9]/g, '_'), summary,
    description: (options.report ? reporting : session) + (method === 'get' ? '' : write) + (options.pin ? 'A restricted PIN session is also permitted for this own-clock action. ' : '') + description,
    security: [{ Session: [] }, ...(options.report ? [{ AgentBearer: [] }] : [])], parameters, responses,
    ...(input ? { requestBody: { required: true, content: json(input) } } : {}) };
}

put('StaffAssignments',staffAssignmentsSnapshot);
const assignmentAccess='Assignment-only access: developer may manage any same-organization account; owner may manage self or lower roles; administrator may manage self, peer administrators and lower roles; scoped manager may manage another ordinary employee only with explicit access to every existing/requested community. Owner/developer targets remain protected from administrators. No role, credential, identity or active-state writes. ';
add('/staff/{id}/assignments','get','Read an employee job/community editor',assignmentAccess+'Returns the current revision, permitted choices, retained archived jobs and current clock assignment locks.',ref('StaffAssignments'));
add('/staff/{id}/assignments','put','Save employee job and community assignments',assignmentAccess+'Supply expectedRevision from GET. A changed source returns409, except an already-applied identical state returns changed:false without another audit. Jobs must belong to selected communities; new assignments require active jobs. Safe additions during an open shift are supported, but its current job/community cannot be removed. Current account/session locks, final proof checks and audit are transactional. Preserves credentials and sessions; subsequent requests use current assignments.',ref('StaffAssignments'),put('StaffAssignmentsInput',staffAssignmentsInput,'input'));

add('/staff/{id}/temporary-credentials', 'post', 'Reset a managed account to temporary first-sign-in credentials',
  'Password developer/owner/administrator only, with the existing target hierarchy; no self reset or inactive target. Supply password, PIN, commandId, reason and optional independent requirePasswordChange/requirePinChange booleans (both default true). All four policies are supported; only selected credentials require replacement. A retained PIN must be unique. Email plus temporary password identifies the account; a shared temporary PIN cannot select a unique employee. Revokes target sessions, setup links, onboarding/MFA challenges and API tokens; preserves enabled MFA and all recorded hours. Credential values never appear in the response or audit. The command is actor/target/payload bound using a domain-separated HMAC. Retry the exact command after an uncertain response: a replay returns current requiresCredentialChange without overwriting later employee credentials. Limited to20 reset attempts per actor per15-minute bucket.',
  put('StaffTemporaryCredentialsResult', staffTemporaryCredentialsResult), put('StaffTemporaryCredentialsInput', staffTemporaryCredentialsInput, 'input'));

schemas.EmployeeClockPolicy = object({ noEarlyClockIn: bool, version: { type: 'integer', minimum: 0 } });
const exact = z.toJSONSchema(workforceUtcMicrosSchema);
schemas.PreclockIntent = object({ id: uuid, version, status: { type: 'string', enum: ['pending', 'executed', 'cancelled', 'blocked'] }, jobId: uuid, jobTitle: str, unitName: str,
  scheduleId: uuid, scheduleVersion: version, startsAt: exact, endsAt: exact, createdAt: exact, processedAt: nullable(exact), reason: str, shiftId: nullable(uuid) });
schemas.PreclockState = object({ policy: ref('EmployeeClockPolicy'), pending: nullable(ref('PreclockIntent')), latest: nullable(ref('PreclockIntent')), timezone: str,
  schedules: array(object({ scheduleId: uuid, scheduleVersion: version, jobId: uuid, startsAt: exact, endsAt: exact, phase: { type: 'string', enum: ['current', 'upcoming'] } }), 100) });
schemas.ClockOpenShift = object({ id: uuid, org_id: uuid, user_id: uuid, started_at: instant, ended_at: { type: 'null' }, revision: version,
  segment_id: uuid, kind: { type: 'string', enum: ['work', 'break'] }, segment_started_at: instant, job_id: uuid, job_title: str, unit_name: str });
const clock = { shift: nullable(ref('ClockOpenShift')), jobs: array(ref('ManagedJobCatalogRecord')), serverTime: instant, preclock: ref('PreclockState') };
schemas.ClockState = object(clock);
schemas.ClockReceiptState = object(clock, ['shift', 'jobs', 'serverTime']);
doc.paths['/clock'].get.responses['200'].content = json(ref('ClockState'));
doc.paths['/clock'].post.responses['200'].content = json(ref('ClockReceiptState'));
const preclock = ' When No early clock-in is enabled, clock_in for an assigned upcoming shift today queues a durable start intent instead of recording worked time. A current matching shift starts immediately; no matching shift is409. The worker rechecks account, credential authority, assignment, job, policy and exact schedule revision before executing. Closing the browser or ordinary session expiry does not cancel a submitted intent. The queue is not a clocked-in shift. Read preclock.pending/latest for status and reason; server supplies timestamps. Cancelling an already executed intent cannot clock out its shift. Legacy exact command receipts may omit preclock; GET /clock always returns the current extended state.';
doc.paths['/clock'].post.description += preclock; doc.paths['/clock'].get.description += ' Includes current No early clock-in policy, pending/latest intent, matching schedules and organization timezone.';
add('/clock/preclock/{id}/cancel', 'post', 'Cancel your pending scheduled start',
  'Own pending intent only. version must match; commandId is an exact payload-bound retry receipt. A changed/executed intent returns409; refresh the clock and use ordinary clock_out for an active shift. Returns the complete clock state without changing recorded hours.',
  ref('ClockState'), put('CancelPreclockInput', cancelPreclockInput, 'input'), { pin: true });
add('/staff/{id}/clock-policy', 'get', 'Read a managed employee’s scheduled clock setting', 'Password management role and existing staff hierarchy/scope. No self editing. Missing configuration reads noEarlyClockIn=false/version0.', ref('EmployeeClockPolicy'));
add('/staff/{id}/clock-policy', 'put', 'Set No early clock-in for a managed employee', 'Password management role and existing staff hierarchy/scope. expectedVersion prevents lost edits; changed policy cancels any pending intent. Repeated unchanged existing policy returns the same version. This is an employee-specific clock rule, not a pay policy.', ref('EmployeeClockPolicy'), put('EmployeeClockPolicyInput', clockPolicyInput, 'input'));

put('WorkforceOverviewQuery', workforceOverviewQuerySchema, 'input'); put('WorkforceOverview', workforceOverviewSchema);
const querySchema = schemas.WorkforceOverviewQuery;
const queries = Object.entries(querySchema.properties).map(([name, schema]) => ({ in: 'query', name, required: querySchema.required.includes(name), schema }));
add('/workforce/overview', 'get', 'Read worked versus scheduled hours for today, this week and a selected period',
  '1–367 inclusive organization-local calendar dates; exact microseconds are decimal strings. One repeatable-read capture/asOf for all three periods. Today/week inherit the optional unit filter; userId applies only to selected. Schedule allowance includes future scheduled time in the period. Above/below compare total work across all jobs with total scheduled allowance for each employee and local day; excess is not offset against shorter days. Job rows show raw worked, scheduled, outside-schedule and break durations without assigning employee overage to a job. Outside-schedule work intersects actual intervals; breaks stay separate. These are duration comparisons, not legal overtime, entitlement balances, wages or approved payroll.', ref('WorkforceOverview'), undefined, { report: true, query: queries });
schemas.WorkforceLiveBoard = object({ asOf: exact, rows: array(object({ user_id: uuid, name: str, job_id: uuid, job_title: str, unit_id: uuid, unit_name: str, kind: { type: 'string', enum: ['work', 'break'] }, started_at: exact, segment_started_at: exact })) });
add('/board', 'get', 'Read the currently clocked-in team with a server capture time', 'Current open shifts and their current-revision active segments only. Organization-wide reporting roles or manager exact assigned units. Includes six-fraction UTC timestamps; an empty successful rows array differs from a failed or stale request.', ref('WorkforceLiveBoard'), undefined, { report: true });
add('/workforce/allowance/snapshots', 'post', 'Save an immutable scheduled-hours review',
  'Reporting role with an actual password session; bearer writes denied. Captures current durations, source segment/schedule evidence and exact identities in one repeatable-read transaction. Source payload is capped at16MiB. commandId binds actor and query: identical retries recover the receipt; another actor/query conflicts. Saved review is retained evidence, not payroll approval, payment or statutory overtime determination.',
  put('AllowanceSnapshotReceipt', allowanceSnapshotReceipt), put('AllowanceSnapshotInput', allowanceSnapshotInput, 'input'), { status: 201 });
add('/workforce/allowance/snapshots', 'get', 'List recent scheduled-hours reviews in current scope', 'Latest100 records; each captured community must still be accessible to a manager. Organization-wide reporting roles may see organization captures. No pagination is currently exposed.', put('AllowanceSnapshotList', allowanceSnapshotListSchema), undefined, { report: true });
add('/workforce/allowance/snapshots/{id}', 'get', 'Read one immutable scheduled-hours review', 'Rechecks every captured community against current access. Unavailable scope returns404. Captured identities and quantities remain as saved even if schedules or punches are subsequently corrected.', put('AllowanceSnapshot', allowanceSnapshotSchema), undefined, { report: true });
for (const format of ['csv', 'xlsx']) for (const saved of [false, true]) {
  const path = saved ? `/workforce/allowance/snapshots/{id}/export.${format}` : `/workforce/allowance/export.${format}`;
  add(path, 'get', `Download ${saved ? 'captured' : 'current'} scheduled-hours ${format.toUpperCase()}`,
    (saved ? 'Uses the saved review after current captured-scope checks. ' : 'Recaptures the selected current period; its values can differ from a previous screen. ') + 'Private/no-store; X-STJW-Report-As-Of identifies the capture. Human-readable hours are rounded to two decimals after aggregation. CSV contains employee totals across jobs. Excel has employee summary, jobs/communities and daily review sheets, with a 10,000 employee/job-row limit. This export does not approve payroll or transmit payment.',
    format === 'csv' ? str : { type: 'string', format: 'binary' }, undefined, { report: true, media: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', query: saved ? [] : queries });
  doc.paths[path].get.responses['200'].headers = { 'X-STJW-Report-As-Of': { schema: exact } };
}

const importScope = 'Password developer/owner/administrator/manager only; managers need explicit assignment to every destination community. Actor-owned preview; another account cannot use its ID. CSV uses readable names/email, never credential or pay values. ';
const importSource = 'Exact header order: jobs=community,title,description; schedules=employeeEmail,community,jobTitle,startsAt,endsAt,note. Names must resolve unambiguously. Jobs are new titles within their community; schedules require an active employee’s assigned active job and explicit community. Timestamps must carry Z or an explicit UTC offset and a shift lasts more than zero and at most24 hours. Overlapping file/existing shifts reject. Limits100 job rows or1000 schedule rows,200000 characters,800000 UTF-8 bytes,4096-character csv-parse record size. Original CSV bytes/BOM are retained as canonical base64, not encryption; serialized organization retention cap64MiB. ';
put('WorkforceImportDetail', workforceImportDetail); put('WorkforceImportReceipt', workforceImportReceipt); put('WorkforceImportList', workforceImportList);
add('/imports/workforce/{kind}/template', 'get', 'Download a blank jobs or staff-schedule CSV template', importScope + importSource + 'A header-only CSV. Excel blank templates use /import-workbooks/template?kind=jobs|schedules.', str, undefined, { media: 'text/csv' });
add('/imports/workforce/{kind}/preview', 'post', 'Validate and retain a proposed jobs or schedules import', importScope + importSource + 'Creates no jobs/shifts. Captures readable destination identities and a fingerprint of current jobs/versions, memberships, assignments and relevant schedules. Preview expires after24 hours. No existing record is overwritten.', ref('WorkforceImportDetail'), put('WorkforceImportPreviewInput', workforceImportPreviewInput, 'input'));
add('/imports/workforce/{kind}', 'get', 'List your most recent jobs or schedules imports', importScope + 'Latest20 accessible own previews and receipts, without pagination.', ref('WorkforceImportList'));
add('/imports/workforce/{kind}/{id}', 'get', 'Reopen your retained jobs or schedules preview and receipt', importScope + 'Rechecks current captured community scope and exact retained source hash. Applied receipts remain available; expired previews require a new upload.', ref('WorkforceImportDetail'));
add('/imports/workforce/{kind}/{id}/apply', 'post', 'Create the reviewed jobs or scheduled shifts atomically', importScope + 'sourceHash must match the retained file. Current source context must equal the preview; changed jobs, identities, memberships, assignments or relevant shifts return409 before any records commit. Calls the existing job/schedule services in one transaction with history, audit and a one-time immutable receipt. Current session and preview deadline are checked again before commit. Retry the same batch ID/hash after an uncertain response: a stored receipt is returned without creating duplicate records or overwriting later edits. Schedule imports never clock employees in.', ref('WorkforceImportReceipt'), put('WorkforceImportApplyInput', workforceImportApplyInput, 'input'));
for (const action of ['inspect', 'convert', 'template']) {
  const op = doc.paths['/import-workbooks/' + action][action === 'template' ? 'get' : 'post'];
  op.description += ' Jobs and schedules are additional blank-template destinations requiring current staff-management password authority, no unitId/assignmentId/userId/jobId query context, and exactly ordered catalog columns. Both cap conversion at100 data rows and4096 UTF-8 bytes per encoded CSV record. Conversion creates no records; submit CSV to /imports/workforce/{kind}/preview and then the actor-owned reviewed apply route.';
}
await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
console.log('Documented workforce recovery, scheduled starts, overview/reviews and bulk imports.');
