import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { managedJobInput, managedJobUpdateInput } from '../server/staff-authority';
import { requestEditInput, requestWithdrawInput } from '../server/request-editing';
import { changePasswordInput } from '../shared/account-credentials';
import { schoolYearUpdateInput, termUpdateInput, courseUpdateInput } from '../shared/school';
import { accountingContactEditInput, accountingDocumentEditInput, accountingDraftDiscardInput } from '../shared/accounting-operations';

// Apply this release's additive contracts last; existing component anchors and ordering stay stable.
const file = 'docs/openapi.json', doc = JSON.parse(await readFile(file, 'utf8')), schemas = doc.components.schemas;
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const str = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, date = { type: 'string', format: 'date' }, instant = { type: 'string', format: 'date-time' }, bool = { type: 'boolean' }, version = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: unknown, maxItems?: number) => ({ type: 'array', items, ...(maxItems === undefined ? {} : { maxItems }) });
const rows = (schema: unknown, maxItems?: number) => object({ rows: array(schema, maxItems) });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const input = (name: string, schema: z.ZodType) => { schemas[name] = z.toJSONSchema(schema, { io: 'input' }); return ref(name); };
const scope = 'Current actual password session in the same organization, completed onboarding and any enrolled MFA proof required. PIN and API bearer tokens cannot use this operation. ';
const writes = 'Writes require the configured Origin, application/json and the X-CSRF-Token from /api/me. ';
function add(path: string, method: string, summary: string, description: string, response: unknown, request?: unknown, statuses: string[] = []) {
  const parameters: any[] = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: uuid }));
  if (method !== 'get') parameters.push({ name: 'Origin', in: 'header', required: true, schema: str }, { name: 'X-CSRF-Token', in: 'header', required: true, schema: str });
  const errors: Record<string, string> = {
    '400': 'Invalid input or domain validation; password changes also reject incorrect current password or unchanged password.',
    '401': 'Missing, expired, revoked or changed password session.',
    '403': 'Current role, scope, password mode, onboarding, enabled module, Origin or CSRF denied.',
    '404': 'Record unavailable in the current organization.',
    '409': 'Stale version/revision, duplicate identity, immutable state, retained-record conflict or conflicting command.',
    '429': 'Too many confirmation attempts; retry after the stated delay.',
    '503': 'Transaction contention or timeout; follow the operation retry guidance.',
  };
  const responses: Record<string, unknown> = { '200': { description: 'Successful operation', content: json(response) } };
  for (const status of ['400', '401', '403', ...statuses]) responses[status] = { description: errors[status], content: json(ref('Error')) };
  const operation: any = { operationId: method + '_' + path.replace(/[^a-zA-Z0-9]/g, '_'), summary, description: scope + (method === 'get' ? '' : writes) + description, security: [{ Session: [] }], responses };
  if (parameters.length) operation.parameters = parameters;
  if (request) operation.requestBody = { required: true, content: json(request) };
  (doc.paths[path] ??= {})[method] = operation;
}
function response(path: string, method: string, schema: unknown, status = '200') {
  doc.paths[path][method].responses[status] = { description: 'Successful operation', content: json(schema) };
}
function describe(path: string, method: string, text: string) {
  const operation = doc.paths[path][method];
  if (!operation.description.includes(text)) operation.description += text;
}

const job = { id: uuid, title: str, description: str, unit_id: uuid, active: bool, version };
schemas.ManagedJob = object(job);
schemas.ManagedJobCatalogRecord = object({ ...job, org_id: uuid, unit_name: str });
schemas.ManagedJobCatalog = rows(ref('ManagedJobCatalogRecord'));
const jobSnapshot = object({ title: str, description: str, unitId: uuid, active: bool, version });
const historyCommon = { created_at: instant, actor_name: nullable(str) };
schemas.ManagedJobHistory = object({ rows: array({ oneOf: [
  object({ ...historyCommon, action: { const: 'job.created', type: 'string' }, detail: z.toJSONSchema(managedJobInput, { io: 'input' }) }),
  object({ ...historyCommon, action: { const: 'job.updated', type: 'string' }, detail: object({ before: jobSnapshot, after: jobSnapshot, reason: str }) }),
] }, 100), truncated: bool, communityLocked: bool });
response('/jobs', 'get', ref('ManagedJobCatalog'));
doc.paths['/jobs'].post.requestBody.content = json(input('ManagedJobCreateInput', managedJobInput));
response('/jobs', 'post', object({ id: uuid }), '201');
add('/jobs/{id}', 'patch', 'Edit or archive a managed job',
  'Current developer/owner/administrator/manager with access to both current and requested units. Title/description and active status are version checked. The unit may change only before any assignment or retained record references the job. Archiving is blocked while an active segment uses it; assigned staff and historical records remain retained. Refresh current state after conflict or uncertain response; there is no command receipt on this route.',
  object({ job: ref('ManagedJob') }), input('ManagedJobUpdateInput', managedJobUpdateInput), ['404', '409', '503']);
add('/jobs/{id}/history', 'get', 'Read retained job edits and community reassignment availability',
  'Current management role and exact unit scope. At most 100 newest creation/update audit rows, with truncated and communityLocked indicators. No job or audit record is deleted.', ref('ManagedJobHistory'), undefined, ['404', '503']);

schemas.EmployeeRequestRecord = object({ id: uuid, org_id: uuid, user_id: uuid, unit_id: uuid,
  kind: { type: 'string', enum: ['pto', 'schedule', 'correction', 'other'] }, starts_on: date, ends_on: date, note: str,
  status: { type: 'string', enum: ['pending', 'approved', 'declined', 'cancelled'] }, reviewer_id: nullable(uuid), review_note: nullable(str), reviewed_at: nullable(instant), created_at: instant, version,
  employee_name: str, unit_name: str });
schemas.EmployeeRequestEditResult = object({ id: uuid, version, status: { type: 'string', enum: ['pending', 'cancelled'] } });
response('/requests', 'get', rows(ref('EmployeeRequestRecord'), 300));
doc.paths['/requests/{id}/review'].post.requestBody.content = json(input('EmployeeRequestReviewInput', z.object({ status: z.enum(['approved', 'declined']), note: z.string().trim().min(3).max(1000), expectedVersion: z.number().int().positive().optional() }).strict()));
describe('/requests/{id}/review', 'post', ' expectedVersion must match the pending request. Omission is accepted only at unchanged version 1 for older clients; revised requests require acknowledgement of their current version. Stale or missing acknowledgement returns 409.');
response('/requests/{id}/review', 'post', object({ id: uuid, status: { type: 'string', enum: ['approved', 'declined'] } }));
add('/requests/{id}', 'patch', 'Edit your pending employee request',
  'Only the current requester can revise kind, assigned unit, dates and note while pending. Current explicit membership is required for the chosen unit. expectedVersion prevents lost edits, with before/after audit evidence. Already reviewed or withdrawn requests require a new request. This does not change punches, schedules or PTO balances. After an uncertain response, read the current request before retrying.',
  ref('EmployeeRequestEditResult'), input('EmployeeRequestEditInput', requestEditInput), ['404', '409']);
add('/requests/{id}/withdraw', 'post', 'Withdraw your pending employee request',
  'Only the requester; expectedVersion and reason required. Retains the request and audit evidence with cancelled status and an advanced version. Reviewed/withdrawn requests cannot be overwritten. Read current state after a lost response; no command receipt is available.',
  ref('EmployeeRequestEditResult'), input('EmployeeRequestWithdrawInput', requestWithdrawInput), ['404', '409']);

schemas.PasswordChanged = object({ ok: { type: 'boolean', const: true }, csrf: str });
add('/auth/password', 'post', 'Change your own password and rotate the current session',
  'Confirms the current password and requires a different new password of 8–128 characters. Rotates the HttpOnly session cookie and CSRF without extending expiry; the response returns only ok and the new CSRF. Revokes other sessions, setup links, pending MFA/onboarding challenges and API tokens. Existing PIN and enabled authenticator remain. Credentials never appear in audit details. A bad current password returns 400 without ending the session; stale proof returns 401. Limited to 10 attempts per account per 15-minute bucket. A lost response has no receipt: refresh and verify sign-in with the new password before submitting again.',
  ref('PasswordChanged'), input('ChangeOwnPasswordInput', changePasswordInput), ['429']);

const schoolIdentity = { id: uuid, org_id: uuid, unit_id: uuid };
schemas.EditableSchoolYear = object({ ...schoolIdentity, name: str, starts_on: date, ends_on: date, archived: bool, version });
schemas.EditableSchoolTerm = object({ ...schoolIdentity, year_id: uuid, name: str, starts_on: date, ends_on: date, locked_at: nullable(instant), version });
schemas.EditableSchoolCourse = object({ ...schoolIdentity, code: str, title: str, description: str, archived: bool, version });
schemas.EditableTimetableRoom = object({ id: uuid, name: str, active: bool, version });
const schoolScope = 'Current developer/owner/administrator or explicit current unit membership plus school-office grant. The academic mutex precedes definition row locks; resulting timetable validation, revision and reasoned school-history/audit are transactional. Stale versions return 409. Retained records are never silently rewritten. After contention or an uncertain response, refresh and review before retrying. ';
add('/school/years/{id}', 'patch', 'Revise or archive a school year', schoolScope +
  'Dates must contain existing terms, enrollment, roster places, meetings, instructional overrides, attendance and dismissal records. Once classes or enrollment exist the year can expand but cannot shrink. Name is unique within the school unit.',
  ref('EditableSchoolYear'), input('SchoolYearUpdateInput', schoolYearUpdateInput), ['404', '409', '503']);
add('/school/terms/{id}', 'patch', 'Revise an unlocked school term', schoolScope +
  'Term dates must fit the parent year; an archived year must be restored first. A locked term rejects every edit. Dates cannot change after a gradebook uses the term; permitted label edits preserve original grade evidence. Name must remain unique within the year.',
  ref('EditableSchoolTerm'), input('SchoolTermUpdateInput', termUpdateInput), ['404', '409', '503']);
add('/school/courses/{id}', 'patch', 'Edit, archive or restore a course definition', schoolScope +
  'Change code, title, description and archived status. Code is unique within its school unit. Existing class references remain linked to the retained course identity.',
  ref('EditableSchoolCourse'), input('SchoolCourseUpdateInput', courseUpdateInput), ['404', '409', '503']);
const roomInput = z.object({ name: z.string().trim().min(2).max(100), active: z.boolean(), version: z.number().int().positive(), reason: z.string().trim().min(5).max(1000) }).strict();
add('/school/timetable/rooms/{id}', 'patch', 'Rename, deactivate or restore a timetable room', schoolScope +
  'An inactive room cannot be newly assigned (400), while an existing meeting can retain its same room. Room edits preserve conflict validation and history. Duplicate names return 409.',
  ref('EditableTimetableRoom'), input('TimetableRoomUpdateInput', roomInput), ['404', '409', '503']);
for (const [path, schema] of [['/school/years', 'EditableSchoolYear'], ['/school/terms', 'EditableSchoolTerm'], ['/school/courses', 'EditableSchoolCourse']]) response(path, 'get', rows(ref(schema)));
response('/school/timetable/rooms', 'get', rows(ref('EditableTimetableRoom')));
delete doc.paths['/school/timetable/rooms'].post.responses['200'];
response('/school/timetable/rooms', 'post', ref('EditableTimetableRoom'), '201');

schemas.AccountingContact.properties.revision = version; schemas.AccountingContact.properties.active = bool;
for (const name of ['revision', 'active']) if (!schemas.AccountingContact.required.includes(name)) schemas.AccountingContact.required.push(name);
schemas.AccountingDocument.properties.revision = version;
if (!schemas.AccountingDocument.required.includes('revision')) schemas.AccountingDocument.required.push('revision');
// Aging embeds the document shape rather than referencing it.
const agingDocument = schemas.AccountingAging.properties.rows.items;
agingDocument.properties.revision = version;
if (!agingDocument.required.includes('revision')) agingDocument.required.push('revision');
doc.paths['/accounting/contacts'].post.summary = 'Create a financial contact';
describe('/accounting/contacts', 'get', ' Includes active and revision for contact editing; existing document contact-name snapshots remain unchanged.');
describe('/accounting/documents', 'get', ' Includes revision for reviewed draft edits and issuance.');
describe('/accounting/documents/{id}/issue', 'post', ' expectedRevision may be omitted only for a draft at revision 1. Revised drafts require acknowledgement of their current revision; stale/missing acknowledgement returns 409. An active financial contact is required.');
const financeScope = 'Current developer/owner/administrator/finance role with transactional accounting authority, session proof, and enabled document workflow where applicable. expectedRevision prevents stale edits. Commands are bound to actor, UUID and exact input; repeat an uncertain request using the same commandId/body. ';
add('/accounting/contacts/{id}', 'post', 'Edit or archive a financial contact', financeScope +
  'Update name, email, note and active status with a reason. Contact type can change only before a document references it; otherwise retain the type and create a separate contact. Historical document contact snapshots are not rewritten. Active contacts are required for draft saving and issuance.',
  ref('AccountingContact'), input('AccountingContactEditInput', accountingContactEditInput), ['404', '409', '503']);
add('/accounting/documents/{id}/draft', 'post', 'Revise an unissued bill or invoice draft', financeScope +
  'Only a draft without financial events is editable. Keep its bill/invoice kind; recalculate coded lines and exact totals under current accounting settings. Active contact, valid account/fund/unit coding, ordered dates and a unique number for contact/kind are required. Issued/discarded documents return 409 and require their retained credit, void or replacement workflows.',
  ref('AccountingDocument'), input('AccountingDocumentEditInput', accountingDocumentEditInput), ['404', '409', '503']);
add('/accounting/documents/{id}/discard', 'post', 'Discard an unissued financial document while retaining evidence', financeScope +
  'Only a draft without financial events can be discarded. Records a zero-amount void event and reasoned audit; the document remains readable with void status. No money is sent and no posted journal is changed.',
  ref('AccountingDocument'), input('AccountingDraftDiscardInput', accountingDraftDiscardInput), ['404', '409', '503']);

await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
console.log('Documented management, password, school-definition and financial draft editing contracts.');
