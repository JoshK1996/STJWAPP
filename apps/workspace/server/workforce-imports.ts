import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'csv-parse/sync';
import type { Express } from 'express';
import { z } from 'zod';
import type { AppRequest } from './auth';
import type { Actor } from './security';
import { audit, digest, manages, Problem, requireCondition } from './security';
import type { Database, Queryable, Row } from './db';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { createManagedJob } from './staff-authority';
import { prepareStaffScheduleChange } from './staff-scheduling';
import { toCsv } from './reports';
import { workforceImportKind, workforceImportColumns, workforceImportLimits as limits, workforceImportRowLimit, workforceImportPreviewInput, workforceImportApplyInput,
  workforceJobImportRow, workforceScheduleImportRow, workforceImportDetail, workforceImportReceipt, workforceImportList, type WorkforceImportKind, type WorkforceImportDetail } from '../shared/workforce-imports';

type JobRow = z.infer<typeof workforceJobImportRow>;
type ScheduleRow = z.infer<typeof workforceScheduleImportRow>;
type InputRow = JobRow | ScheduleRow;
const key = (value: string) => value.trim().toLowerCase();
const unique = (values: string[]) => [...new Set(values)].sort();
const proofOf = (proof: string | undefined): string => { requireCondition(typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof), 401, 'A current password session is required.'); return proof; };
const shape = (kind: WorkforceImportKind) => kind === 'jobs' ? workforceJobImportRow : workforceScheduleImportRow;
function parseSource(kind: WorkforceImportKind, csv: string): InputRow[] {
  requireCondition(Buffer.byteLength(csv, 'utf8') <= limits.bytes && Buffer.from(csv, 'utf8').toString('utf8') === csv, 413, 'Use a smaller valid UTF-8 CSV.');
  let rows: string[][];
  try { rows = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 4096, relax_column_count: false }); }
  catch { throw new Problem(400, 'Invalid CSV. Use the blank template and plain text cells.'); }
  requireCondition(rows.length > 1 && rows.length <= workforceImportRowLimit(kind) + 1, 400, `Import between 1 and ${workforceImportRowLimit(kind)} rows.`);
  const columns = workforceImportColumns[kind];
  requireCondition(isDeepStrictEqual(rows[0], [...columns]), 400, 'Keep the exact template headers in their original order.');
  const seen = new Set<string>();
  return rows.slice(1).map((values, index) => {
    const result = shape(kind).safeParse(Object.fromEntries(columns.map((column, i) => [column, values[i]])));
    requireCondition(result.success, 400, `Row ${index + 2}: ${result.error?.issues[0]?.message ?? 'invalid fields'}`);
    const row = result.data!, identity = kind === 'jobs' ? JSON.stringify([key(row.community), key((row as JobRow).title)]) : JSON.stringify(row);
    requireCondition(!seen.has(identity), 400, `Row ${index + 2} duplicates another row.`); seen.add(identity); return row;
  });
}
async function transaction<T>(db: Database, work: (tx: Queryable) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'"); return work(tx);
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (['40001', '40P01'].includes(code ?? '') && attempt < 2) continue;
      if (['55P03', '57014', '40001', '40P01'].includes(code ?? '')) throw new Problem(503, 'Workforce import is busy. Retry the same preview or apply request.');
      throw error;
    }
  }
}
async function lockActor(tx: Queryable, supplied: Actor, proof: string, kind: WorkforceImportKind, rows: InputRow[] = []) {
  requireCondition(manages(supplied), 403, 'Staff management access is required.');
  // Imports serialize before account locks. Direct schedule writers use the same
  // sorted account order; lock the complete batch before any per-row service.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workforce-import:' + supplied.org_id]);
  const emails = kind === 'schedules' ? unique((rows as ScheduleRow[]).map(row => row.employeeEmail)) : [];
  const people = emails.length ? (await tx.query('SELECT id FROM users WHERE org_id=$1 AND email=ANY($2::text[])', [supplied.org_id, emails])).rows : [];
  const ids = unique([supplied.id, ...people.map(person => person.id)]);
  await tx.query(`SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${kind === 'schedules' && rows.length ? 'NO KEY UPDATE' : 'SHARE'}`, [supplied.org_id, ids]);
  const actor = await currentReportActor(tx, supplied, proof);
  requireCondition(manages(actor), 403, 'Staff management access is required.'); return actor;
}
async function context(tx: Queryable, actor: Actor, kind: WorkforceImportKind, rows: InputRow[], validate = true) {
  const unitNames = unique(rows.map(row => key(row.community)));
  let units = (await tx.query(`SELECT id,name FROM units WHERE org_id=$1 AND lower(btrim(name))=ANY($2::text[])
    AND ($3::boolean OR id=ANY($4::uuid[])) ORDER BY id`, [actor.org_id, unitNames, actor.role !== 'manager', actor.unit_ids])).rows;
  requireCondition(units.length === unitNames.length && unitNames.every(name => units.filter(unit => key(unit.name) === name).length === 1), 400, 'A community is unavailable or its name is ambiguous. Use a distinct community name within your access.');
  const unitIds = units.map(unit => unit.id);
  requireCondition(unitIds.length <= 100, 400, 'Use at most 100 communities in one import.');
  const jobs = (await tx.query('SELECT id,unit_id,title,description,active,version FROM jobs WHERE org_id=$1 AND unit_id=ANY($2::uuid[]) ORDER BY id LIMIT 2001 FOR SHARE', [actor.org_id, unitIds])).rows;
  requireCondition(jobs.length <= 2000, 400, 'Too many jobs match these communities. Import a smaller community group.');
  // Existing job editors lock jobs before units. The stronger unit lock on job
  // creation also blocks a concurrent direct create until this batch commits.
  units = (await tx.query(`SELECT id,name FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${kind === 'jobs' ? 'UPDATE' : 'SHARE'}`, [actor.org_id, unitIds])).rows;
  requireCondition(unitNames.every(name => units.filter(unit => key(unit.name) === name).length === 1), 409, 'Community names changed. Preview the file again.');
  if (kind === 'jobs') {
    const after = (await tx.query('SELECT id FROM jobs WHERE org_id=$1 AND unit_id=ANY($2::uuid[]) ORDER BY id LIMIT 2001', [actor.org_id, unitIds])).rows.map(value => value.id);
    requireCondition(isDeepStrictEqual(after, jobs.map(value => value.id)), 409, 'Jobs changed while acquiring the preview. Preview the file again.');
  }
  const display: WorkforceImportDetail['rows'] = [], resolved: { unitId: string; userId?: string; jobId?: string; row: InputRow }[] = [];
  let people: Row[] = [], assignments: Row[] = [], memberships: Row[] = [], schedules: Row[] = [];
  if (kind === 'schedules') {
    const input = rows as ScheduleRow[];
    people = (await tx.query('SELECT id,name,email,active FROM users WHERE org_id=$1 AND email=ANY($2::text[]) ORDER BY id', [actor.org_id, unique(input.map(row => row.employeeEmail))])).rows;
    const ids = people.map(person => person.id);
    assignments = (await tx.query('SELECT user_id,job_id FROM user_jobs WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id,job_id LIMIT 5001', [actor.org_id, ids])).rows;
    memberships = (await tx.query('SELECT user_id,unit_id FROM user_units WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id,unit_id LIMIT 5001', [actor.org_id, ids])).rows;
    requireCondition(assignments.length <= 5000 && memberships.length <= 5000, 400, 'Too many staff assignments match. Split the file into smaller employee groups.');
    const first = input.map(row => row.startsAt).sort()[0], last = input.map(row => row.endsAt).sort().at(-1)!;
    schedules = (await tx.query(`SELECT id,user_id,job_id,version,status,
      to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at
      FROM schedules WHERE org_id=$1 AND user_id=ANY($2::uuid[]) AND starts_at<$4 AND ends_at>$3 ORDER BY id LIMIT 2001`, [actor.org_id, ids, first, last])).rows;
    requireCondition(schedules.length <= 2000, 400, 'Too many existing schedules span this file. Import a shorter date range.');
  }
  for (const [index, row] of rows.entries()) {
    const unit = units.find(value => key(value.name) === key(row.community))!, line = index + 2;
    if (kind === 'jobs') {
      const job = row as JobRow;
      if (validate) requireCondition(!jobs.some(value => value.unit_id === unit.id && key(value.title) === key(job.title)), 409, `Row ${line}: that job already exists in ${unit.name}. This import creates new jobs only; use the existing job's edit control.`);
      resolved.push({ unitId: unit.id, row }); display.push({ row: line, community: unit.name, title: job.title, note: job.description });
    } else {
      const schedule = row as ScheduleRow, person = people.find(value => value.email === schedule.employeeEmail), matches = jobs.filter(value => value.unit_id === unit.id && key(value.title) === key(schedule.jobTitle));
      requireCondition(person && matches.length === 1, 400, `Row ${line}: employee or job is unavailable, or the job name is ambiguous.`);
      const job = matches[0];
      requireCondition(person.active && job.active && assignments.some(value => value.user_id === person.id && value.job_id === job.id) && memberships.some(value => value.user_id === person.id && value.unit_id === unit.id), 400, `Row ${line}: use an active employee's assigned job and community.`);
      if (validate) requireCondition(!schedules.some(value => value.user_id === person.id && value.status === 'scheduled' && Date.parse(value.starts_at) < Date.parse(schedule.endsAt) && Date.parse(value.ends_at) > Date.parse(schedule.startsAt)) && !resolved.some(value => value.userId === person.id && Date.parse((value.row as ScheduleRow).startsAt) < Date.parse(schedule.endsAt) && Date.parse((value.row as ScheduleRow).endsAt) > Date.parse(schedule.startsAt)), 409, `Row ${line}: this shift overlaps an existing shift or an earlier row in the file.`);
      resolved.push({ unitId: unit.id, userId: person.id, jobId: job.id, row });
      display.push({ row: line, community: unit.name, title: job.title, employee: person.name, email: person.email, startsAt: schedule.startsAt, endsAt: schedule.endsAt, note: schedule.note });
    }
  }
  return { resolved, display, hash: digest(JSON.stringify({ role: actor.role, unitIds: unique(actor.unit_ids), units, jobs, people, assignments, memberships, schedules })) };
}
const detail = (row: Row) => workforceImportDetail.parse({ id: row.id, kind: row.kind, sourceHash: row.source_hash, contextHash: row.context_hash,
  createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(new Date(row.created_at).getTime() + 86400000).toISOString(), rows: row.display_rows, receipt: row.receipt });
async function owned(tx: Queryable, actor: Actor, kind: WorkforceImportKind, id: string): Promise<Row & { source_csv: string }> {
  const row = (await tx.query('SELECT * FROM workforce_import_batches WHERE id=$1 AND org_id=$2 AND actor_id=$3 AND kind=$4', [id, actor.org_id, actor.id, kind])).rows[0];
  requireCondition(row, 404, 'Import preview not found.');
  // Retain UTF-8 bytes as canonical base64: text decoders can strip a CSV BOM.
  const bytes = Buffer.from(row.source_base64, 'base64'), source = bytes.toString('utf8');
  requireCondition(bytes.length <= limits.bytes && bytes.toString('base64') === row.source_base64 && Buffer.from(source, 'utf8').equals(bytes) && digest(source) === row.source_hash, 422, 'Retained import source is inconsistent.');
  return { ...row, source_csv: source };
}
async function publish<T>(tx: Queryable, actor: Actor, proof: string, value: T) { JSON.stringify(value); await recheckReportSession(tx, actor, proof); return value; }
export async function previewWorkforceImport(db: Database, supplied: Actor, sessionHash: string | undefined, type: unknown, raw: unknown) {
  const kind = workforceImportKind.parse(type), input = workforceImportPreviewInput.parse(raw), proof = proofOf(sessionHash), rows = parseSource(kind, input.csv);
  return transaction(db, async tx => {
    const actor = await lockActor(tx, supplied, proof, kind, rows), source = await context(tx, actor, kind, rows);
    const retained = Buffer.from(input.csv, 'utf8').toString('base64');
    const used = BigInt((await tx.query('SELECT coalesce(sum(octet_length(source_base64)),0)::text AS used FROM workforce_import_batches WHERE org_id=$1', [actor.org_id])).rows[0].used);
    requireCondition(used + BigInt(retained.length) <= BigInt(limits.sourceBudgetBytes), 409, 'Retained workforce import source capacity is full. Ask the developer to review capacity; existing evidence is preserved.');
    const id = randomUUID(), sourceHash = digest(input.csv);
    await tx.query('INSERT INTO workforce_import_batches(id,org_id,actor_id,kind,source_base64,source_hash,context_hash,display_rows,unit_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, actor.org_id, actor.id, kind, retained, sourceHash, source.hash, JSON.stringify(source.display), unique(source.resolved.map(value => value.unitId))]);
    await audit(tx, actor, 'workforce.import_previewed', id, { kind, sourceHash, contextHash: source.hash, rowCount: rows.length });
    return publish(tx, actor, proof, detail(await owned(tx, actor, kind, id)));
  });
}
export async function getWorkforceImport(db: Database, supplied: Actor, sessionHash: string | undefined, type: unknown, id: string) {
  const kind = workforceImportKind.parse(type), proof = proofOf(sessionHash), batchId = z.uuid().parse(id);
  return transaction(db, async tx => {
    const actor = await lockActor(tx, supplied, proof, kind), row = await owned(tx, actor, kind, batchId);
    // Managers may no longer see rows for a community after their scope changes.
    requireCondition(actor.role !== 'manager' || row.unit_ids.every((id: string) => actor.unit_ids.includes(id)), 403, 'This import contains a community outside current access.');
    return publish(tx, actor, proof, detail(row));
  });
}
export async function applyWorkforceImport(db: Database, supplied: Actor, sessionHash: string | undefined, type: unknown, id: string, raw: unknown) {
  const kind = workforceImportKind.parse(type), proof = proofOf(sessionHash), batchId = z.uuid().parse(id), input = workforceImportApplyInput.parse(raw);
  return transaction(db, async tx => {
    // A non-returned preliminary read identifies all account locks. Ownership,
    // actual session and retained source are checked again under the mutex.
    const candidate = await owned(tx, supplied, kind, batchId), rows = parseSource(kind, candidate.source_csv);
    const actor = await lockActor(tx, supplied, proof, kind, rows), row = await owned(tx, actor, kind, batchId);
    requireCondition(row.source_hash === input.sourceHash, 409, 'The selected source changed. Preview the file again.');
    // Receipt retries must not revalidate overlaps created by this very batch.
    if (row.receipt) {
      requireCondition(actor.role !== 'manager' || row.unit_ids.every((id: string) => actor.unit_ids.includes(id)), 403, 'This import is outside current management access.');
      return publish(tx, actor, proof, workforceImportReceipt.parse(row.receipt));
    }
    const fresh = async () => requireCondition((await tx.query("SELECT id FROM workforce_import_batches WHERE id=$1 AND applied_at IS NULL AND created_at+interval '24 hours'>clock_timestamp()", [batchId])).rows.length, 409, 'This preview expired. Upload and review the file again.');
    requireCondition(actor.role !== 'manager' || row.unit_ids.every((id: string) => actor.unit_ids.includes(id)), 403, 'This import is outside current management access.');
    await fresh(); let source: Awaited<ReturnType<typeof context>>;
    try { source = await context(tx, actor, kind, rows, false); }
    catch (error) { if (error instanceof Problem && [400, 404].includes(error.status)) throw new Problem(409, 'The preview source changed. Preview the file again; nothing was imported.'); throw error; }
    requireCondition(source.hash === row.context_hash && isDeepStrictEqual(source.display, row.display_rows), 409, 'Jobs, staff assignments, community details or schedules changed since preview. Preview the file again; nothing was imported.');
    const records: { row: number; id: string }[] = [];
    const scopedDb: Database = { query: tx.query.bind(tx), transaction: work => work(tx), close: async () => {} };
    for (const [index, value] of source.resolved.entries()) {
      const result = kind === 'jobs'
        ? await createManagedJob(scopedDb, actor, proof, { unitId: value.unitId, title: (value.row as JobRow).title, description: (value.row as JobRow).description })
        : await (await prepareStaffScheduleChange(tx, actor, { action: 'created', input: { userId: value.userId!, jobId: value.jobId!, startsAt: (value.row as ScheduleRow).startsAt, endsAt: (value.row as ScheduleRow).endsAt, note: (value.row as ScheduleRow).note, commandId: randomUUID(), reason: 'Reviewed bulk schedule import ' + batchId } })).apply();
      records.push({ row: index + 2, id: result.id });
    }
    await fresh();
    const appliedAt = new Date((await tx.query('SELECT clock_timestamp() AS now')).rows[0].now).toISOString();
    const receipt = workforceImportReceipt.parse({ batchId, kind, sourceHash: input.sourceHash, appliedAt, created: records.length, records });
    await tx.query('UPDATE workforce_import_batches SET applied_at=$1,receipt=$2 WHERE id=$3', [appliedAt, JSON.stringify(receipt), batchId]);
    await audit(tx, actor, 'workforce.import_applied', batchId, { kind, sourceHash: input.sourceHash, contextHash: source.hash, rowCount: records.length });
    return publish(tx, actor, proof, receipt);
  });
}
export function installWorkforceImports(app: Express, db: Database) {
  app.use('/api/imports/workforce', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  app.get('/api/imports/workforce/:kind/template', async (req, res) => {
    const { actor: supplied, sessionHash } = req as unknown as AppRequest, kind = workforceImportKind.parse(req.params.kind), proof = proofOf(sessionHash);
    const csv = await transaction(db, async tx => { const actor = await lockActor(tx, supplied, proof, kind); await audit(tx, actor, 'workforce.import_template_downloaded', null, { kind }); return publish(tx, actor, proof, toCsv([], [...workforceImportColumns[kind]])); });
    res.attachment(`stjw-${kind}-template.csv`).type('text/csv').send(csv);
  });
  app.post('/api/imports/workforce/:kind/preview', async (req, res) => { const { actor, sessionHash } = req as unknown as AppRequest; res.json(await previewWorkforceImport(db, actor, sessionHash, req.params.kind, req.body)); });
  app.get('/api/imports/workforce/:kind', async (req, res) => {
    const { actor: supplied, sessionHash } = req as unknown as AppRequest, kind = workforceImportKind.parse(req.params.kind), proof = proofOf(sessionHash);
    res.json(await transaction(db, async tx => {
      const actor = await lockActor(tx, supplied, proof, kind);
      const rows = (await tx.query(`SELECT id,kind,created_at,jsonb_array_length(display_rows) AS count,applied_at IS NOT NULL AS applied FROM workforce_import_batches
        WHERE org_id=$1 AND actor_id=$2 AND kind=$3 AND ($4::boolean OR unit_ids<@$5::uuid[]) ORDER BY created_at DESC,id DESC LIMIT 20`, [actor.org_id, actor.id, kind, actor.role !== 'manager', actor.unit_ids])).rows;
      return publish(tx, actor, proof, workforceImportList.parse({ rows: rows.map(row => ({ id: row.id, kind: row.kind, count: row.count, applied: row.applied, createdAt: new Date(row.created_at).toISOString() })) }));
    }));
  });
  app.get('/api/imports/workforce/:kind/:id', async (req, res) => { const { actor, sessionHash } = req as unknown as AppRequest; res.json(await getWorkforceImport(db, actor, sessionHash, req.params.kind, String(req.params.id))); });
  app.post('/api/imports/workforce/:kind/:id/apply', async (req, res) => { const { actor, sessionHash } = req as unknown as AppRequest; res.json(await applyWorkforceImport(db, actor, sessionHash, req.params.kind, String(req.params.id), req.body)); });
}
