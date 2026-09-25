import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Express, Request } from 'express';
import type { AppRequest } from './auth';
import type { Database, Queryable, Row } from './db';
import { audit, digest, manages, orgWide, requireCondition, type Actor } from './security';
import { currentTimeActor, preciseTimeSql, timeMicroseconds, timeNow, timeTransaction } from './time-record-access';
import { recheckReportSession } from './report-source-access';
import { prepareStaffScheduleChange } from './staff-scheduling';
import { planningLimits, planningQuery, coverageRuleInput, hoursTargetInput, planningPreviewInput, planningApplyInput,
  type PlanningQuery, type CoverageRule, type HoursTarget, type PlanningWorkspace, type PlanningEmployee, type PlanningJob, type PlanningPreview, type PlanningApplied, type PlanningHistory } from '../shared/staff-planning';
import type { StaffScheduleSnapshot } from '../shared/staff-scheduling';
import { exactIso, localDay, planningBounds, expandCoverage, measureCoverage, measureTargets, openCoverageSlots, elapsedWithin } from './staff-planning-engine';

const notice = 'Coverage is measured across the whole permitted team. Coverage windows belong to their start date and include the complete overnight shift. Job hours targets are separate planning guidance, never employee allotments or pay limits. Only saved scheduled shifts feed scheduled-hours reports and pending clock starts. Monthly day 29–31 and yearly February 29 occurrences are skipped when their date does not exist. Ambiguous or missing daylight-saving times block generation. Recurrence overlap checks cover the displayed/generated window, not an unlimited future.';
type Source = { timezone: string; asOf: string; jobs: PlanningJob[]; employees: PlanningEmployee[]; rules: CoverageRule[]; targets: HoursTarget[]; schedules: StaffScheduleSnapshot[]; revision: string };
function identity(actor: Actor, proof: string | undefined) {
  requireCondition(typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof), 401, 'A current password session is required.');
  return { supplied: { ...actor, id: actor.id.toLowerCase(), org_id: actor.org_id.toLowerCase() }, proof };
}
async function plannerLock(tx: Queryable, actor: Actor) { await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['staff-planning:' + actor.org_id]); }
async function authority(tx: Queryable, supplied: Actor, proof: string) {
  const actor = await currentTimeActor(tx, supplied, proof);
  requireCondition(manages(actor), 403, 'Schedule planning requires developer, owner, administrator or scoped manager access.');
  return actor;
}
async function source(tx: Queryable, actor: Actor, query: PlanningQuery): Promise<Source> {
  const meta = (await tx.query(`SELECT timezone,${preciseTimeSql('clock_timestamp()')} AS as_of FROM organizations WHERE id=$1`, [actor.org_id])).rows[0];
  requireCondition(meta, 404, 'Organization unavailable.');
  const zone = meta.timezone, from = exactIso(localDay(query.start, zone).startOf('year').startOf('week').minus({ days: 1 })), through = exactIso(localDay(query.end, zone).endOf('year').endOf('week').startOf('day').plus({ days: 2 }));
  const jobs: PlanningJob[] = (await tx.query(`SELECT j.id,j.title,j.unit_id AS "unitId",u.name AS "unitName",j.active FROM jobs j JOIN units u ON u.org_id=j.org_id AND u.id=j.unit_id
    WHERE j.org_id=$1 AND ($2::boolean OR j.unit_id=ANY($3::uuid[])) ORDER BY j.id LIMIT 1001`, [actor.org_id, orgWide(actor), actor.unit_ids])).rows as PlanningJob[];
  requireCondition(jobs.length <= 1000, 400, 'Too many jobs for this planning workspace. Contact your developer.');
  if (query.jobId) requireCondition(jobs.some(job => job.id === query.jobId), 403, 'This job is outside your planning scope.');
  const jobIds = jobs.map(job => job.id), sourceJobIds = query.jobId ? [query.jobId] : jobIds;
  const definitions = (await tx.query(`SELECT id,kind,version,payload FROM staff_planning_definitions WHERE org_id=$1 AND job_id=ANY($2::uuid[]) ORDER BY id LIMIT 401`, [actor.org_id, jobIds])).rows;
  const rules = definitions.filter(row => row.kind === 'rule').map(row => ({ ...row.payload, id: row.id, version: row.version })) as CoverageRule[];
  const targets = definitions.filter(row => row.kind === 'target').map(row => ({ ...row.payload, id: row.id, version: row.version })) as HoursTarget[];
  requireCondition(definitions.length <= planningLimits.rules + planningLimits.targets && rules.length <= planningLimits.rules && targets.length <= planningLimits.targets, 400, 'Too many planning definitions. Contact your developer.');
  const rows = (await tx.query(`SELECT s.id,s.user_id,s.job_id,s.note,s.version,s.status,e.name AS employee_name,j.title AS job_title,j.unit_id,u.name AS unit_name,
    ${preciseTimeSql('s.starts_at')} AS starts_at,${preciseTimeSql('s.ends_at')} AS ends_at,${preciseTimeSql('s.updated_at')} AS updated_at,${preciseTimeSql('s.cancelled_at')} AS cancelled_at
    FROM schedules s JOIN users e ON e.org_id=s.org_id AND e.id=s.user_id JOIN jobs j ON j.org_id=s.org_id AND j.id=s.job_id JOIN units u ON u.org_id=j.org_id AND u.id=j.unit_id
    WHERE s.org_id=$1 AND s.job_id=ANY($2::uuid[]) AND s.starts_at<$4 AND s.ends_at>$3 ORDER BY s.starts_at,s.id LIMIT 20001`, [actor.org_id, sourceJobIds, from, through])).rows;
  requireCondition(rows.length <= planningLimits.schedules, 400, 'Too many schedules in the calendar-year source. Choose a narrower management scope.');
  const schedules: StaffScheduleSnapshot[] = rows.map(row => ({ id: row.id, userId: row.user_id, employeeName: row.employee_name, jobId: row.job_id, jobTitle: row.job_title, unitId: row.unit_id, unitName: row.unit_name, startsAt: row.starts_at, endsAt: row.ends_at, note: row.note, version: row.version, status: row.status, updatedAt: row.updated_at, cancelledAt: row.cancelled_at }));
  const people = (await tx.query(`SELECT u.id,u.name,array_agg(j.id ORDER BY j.id) AS job_ids FROM users u JOIN user_jobs uj ON uj.org_id=u.org_id AND uj.user_id=u.id JOIN jobs j ON j.org_id=uj.org_id AND j.id=uj.job_id
    WHERE u.org_id=$1 AND u.active AND j.active AND j.id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM user_units uu WHERE uu.org_id=u.org_id AND uu.user_id=u.id AND uu.unit_id=j.unit_id)
    GROUP BY u.id,u.name ORDER BY u.id LIMIT 201`, [actor.org_id, sourceJobIds])).rows;
  requireCondition(people.length <= planningLimits.employees, 400, 'More than 200 eligible employees. Choose one job or a smaller explicit management scope.');
  const bounds = planningBounds(query, zone);
  const employees = people.map(row => ({ id: row.id, name: row.name, jobIds: row.job_ids, scheduledMicroseconds: elapsedWithin(schedules.filter(schedule => schedule.userId === row.id), bounds.from, bounds.through).toString() }));
  const revision = digest(JSON.stringify({ timezone: zone, units: actor.unit_ids.slice().sort(), role: actor.role, jobs, employees, rules, targets, schedules }));
  return { timezone: zone, asOf: meta.as_of, jobs, employees, rules, targets, schedules, revision };
}
function workspace(data: Source, query: PlanningQuery): PlanningWorkspace {
  const expanded = expandCoverage(data.rules, query), occurrences = measureCoverage(expanded.occurrences, data.schedules), bounds = planningBounds(query, data.timezone);
  const totals = { requiredMicroseconds: '0', filledMicroseconds: '0', uncoveredMicroseconds: '0', excessMicroseconds: '0' };
  // Overlapping requirements have no inferred combined denominator.
  for (const occurrence of occurrences.filter(row => !row.conflict)) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = (BigInt(totals[key]) + BigInt(occurrence[key])).toString();
  return { query, timezone: data.timezone, asOf: data.asOf, revision: data.revision, jobs: data.jobs, employees: data.employees, schedules: data.schedules.filter(row => row.startsAt < bounds.through && row.endsAt > bounds.from && (!query.jobId || row.jobId === query.jobId)), rules: data.rules, hoursTargets: data.targets, occurrences, targetPeriods: measureTargets(data.targets, data.schedules, query, data.timezone), warnings: expanded.warnings, totals, notice };
}
export async function getStaffPlanning(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const query = planningQuery.parse(raw), { supplied: who, proof } = identity(supplied, sessionHash);
  return timeTransaction(db, async tx => { const actor = await authority(tx, who, proof), result = workspace(await source(tx, actor, query), query); await recheckReportSession(tx, actor, proof); return result; }, true);
}
async function savedCommand(tx: Queryable, actor: Actor, commandId: string, fingerprint: string) {
  const row = (await tx.query('SELECT fingerprint,result FROM staff_planning_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3', [actor.org_id, actor.id, commandId])).rows[0];
  if (row) requireCondition(row.fingerprint === fingerprint, 409, 'This command was already used with different details. Reload before trying again.');
  return row?.result;
}
async function commandReceipt(tx: Queryable, actor: Actor, commandId: string, fingerprint: string, result: unknown) {
  await tx.query('INSERT INTO staff_planning_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)', [actor.org_id, actor.id, commandId, fingerprint, JSON.stringify(result)]);
}
async function saveDefinition(db: Database, supplied: Actor, sessionHash: string | undefined, kind: 'rule' | 'target', id: string, raw: unknown) {
  z.uuid().parse(id); const input = kind === 'rule' ? coverageRuleInput.parse(raw) : hoursTargetInput.parse(raw), { supplied: who, proof } = identity(supplied, sessionHash);
  const fingerprint = digest(JSON.stringify({ kind, id, input }));
  return timeTransaction(db, async tx => {
    await plannerLock(tx, who); const actor = await authority(tx, who, proof);
    const existing = (await tx.query('SELECT * FROM staff_planning_definitions WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows[0];
    requireCondition(!existing || existing.kind === kind, 409, 'This identifier belongs to another planning definition.');
    const jobs = (await tx.query('SELECT id,unit_id,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, [...new Set([input.jobId, ...(existing ? [existing.job_id] : [])])].sort()])).rows;
    requireCondition(jobs.length === new Set([input.jobId, ...(existing ? [existing.job_id] : [])]).size, 400, 'Choose a job in this organization.');
    requireCondition(jobs.every(job => orgWide(actor) || actor.unit_ids.includes(job.unit_id)), 403, 'These jobs are outside your planning scope.');
    const prior = await savedCommand(tx, actor, input.commandId, fingerprint); if (prior) { await recheckReportSession(tx, actor, proof); return { ...prior, replayed: true }; }
    requireCondition((existing?.version ?? 0) === input.expectedVersion, 409, 'This definition changed. Reload saved values before editing.');
    requireCondition(!input.active || jobs.find(job => job.id === input.jobId)?.active, 400, 'Restore this job before activating a planning definition.');
    const { expectedVersion: _, commandId: __, reason: ___, ...fields } = input;
    const timezone = (await tx.query('SELECT timezone FROM organizations WHERE id=$1', [actor.org_id])).rows[0].timezone;
    // Dates are verified against the organization calendar before persistence.
    localDay(kind === 'rule' ? (input as z.infer<typeof coverageRuleInput>).startDate : (input as z.infer<typeof hoursTargetInput>).effectiveFrom, timezone);
    const payload = kind === 'rule' ? { ...fields, timezone } : fields, version = (existing?.version ?? 0) + 1;
    if (kind === 'target' && input.active) {
      const target = input as z.infer<typeof hoursTargetInput>;
      const conflict = (await tx.query(`SELECT id FROM staff_planning_definitions WHERE org_id=$1 AND kind='target' AND active AND job_id=$2 AND id<>$3
        AND payload->>'period'=$4 AND (payload->>'effectiveFrom')::date<=coalesce($6::date,'infinity'::date) AND coalesce((payload->>'effectiveThrough')::date,'infinity'::date)>=$5::date LIMIT 1`, [actor.org_id, target.jobId, id, target.period, target.effectiveFrom, target.effectiveThrough])).rows.length;
      requireCondition(!conflict, 409, 'Another active hours target overlaps these effective dates for this job and period.');
    }
    if (existing) await tx.query('UPDATE staff_planning_definitions SET job_id=$3,version=$4,active=$5,payload=$6,updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2', [actor.org_id, id, input.jobId, version, input.active, JSON.stringify(payload)]);
    else {
      const count = (await tx.query('SELECT count(*)::int AS n FROM staff_planning_definitions WHERE org_id=$1 AND kind=$2', [actor.org_id, kind])).rows[0].n;
      requireCondition(count < (kind === 'rule' ? planningLimits.rules : planningLimits.targets), 400, 'This organization reached the planning-definition limit. Contact the developer.');
      await tx.query('INSERT INTO staff_planning_definitions(org_id,id,kind,job_id,version,active,payload) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.org_id, id, kind, input.jobId, version, input.active, JSON.stringify(payload)]);
    }
    const after = { id, version, ...payload }, before = existing ? { id, version: existing.version, ...existing.payload } : null;
    const action = !existing ? 'created' : existing.active && !input.active ? 'archived' : !existing.active && input.active ? 'restored' : 'updated';
    await tx.query('INSERT INTO staff_planning_history(org_id,definition_id,version,action,reason,before_snapshot,after_snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.org_id, id, version, action, input.reason, before ? JSON.stringify(before) : null, JSON.stringify(after), actor.id]);
    await audit(tx, actor, 'schedule.' + kind + '_' + action, id, { version, reason: input.reason, commandId: input.commandId });
    const result = { id, version, replayed: false }; await commandReceipt(tx, actor, input.commandId, fingerprint, result); await recheckReportSession(tx, actor, proof); return result;
  });
}
export const saveCoverageRule = (db: Database, actor: Actor, proof: string | undefined, id: string, raw: unknown) => saveDefinition(db, actor, proof, 'rule', id, raw);
export const saveHoursTarget = (db: Database, actor: Actor, proof: string | undefined, id: string, raw: unknown) => saveDefinition(db, actor, proof, 'target', id, raw);
export async function planningDefinitionHistory(db: Database, supplied: Actor, sessionHash: string | undefined, kind: 'rule' | 'target', id: string): Promise<PlanningHistory> {
  z.uuid().parse(id); const { supplied: who, proof } = identity(supplied, sessionHash);
  return timeTransaction(db, async tx => {
    const actor = await authority(tx, who, proof), definition = (await tx.query(`SELECT d.id,j.unit_id FROM staff_planning_definitions d JOIN jobs j ON j.org_id=d.org_id AND j.id=d.job_id WHERE d.org_id=$1 AND d.id=$2 AND d.kind=$3`, [actor.org_id, id, kind])).rows[0];
    requireCondition(definition && (orgWide(actor) || actor.unit_ids.includes(definition.unit_id)), 403, 'This planning history is outside your access.');
    const rows = (await tx.query(`SELECT h.*,u.name AS actor_name FROM staff_planning_history h JOIN users u ON u.org_id=h.org_id AND u.id=h.actor_id WHERE h.org_id=$1 AND h.definition_id=$2 ORDER BY h.version DESC LIMIT 1001`, [actor.org_id, id])).rows;
    requireCondition(rows.length <= 1000, 400, 'This history is too large to display safely. Contact your developer.');
    const jobIds = [...new Set(rows.flatMap(row => [row.before_snapshot?.jobId, row.after_snapshot.jobId]).filter(Boolean))];
    const jobs = (await tx.query('SELECT id,unit_id FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[])', [actor.org_id, jobIds])).rows;
    requireCondition(jobs.length === jobIds.length && jobs.every(job => orgWide(actor) || actor.unit_ids.includes(job.unit_id)), 403, 'Earlier history includes jobs outside your current scope.');
    const result = { rows: rows.map(row => ({ version: row.version, action: row.action, reason: row.reason, before: row.before_snapshot, after: row.after_snapshot, actorName: row.actor_name, createdAt: new Date(row.created_at).toISOString() })) };
    await recheckReportSession(tx, actor, proof); return result;
  }, true);
}
export async function previewStaffPlanning(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<PlanningPreview> {
  const input = planningPreviewInput.parse(raw), { supplied: who, proof } = identity(supplied, sessionHash);
  // Serializable predicate protection makes the retained-size admission safe
  // when several preview requests begin before another preview commits.
  const serializable: Database = { ...db, transaction: operation => db.transaction(async tx => { await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'); return operation(tx); }) };
  return timeTransaction(serializable, async tx => {
    await plannerLock(tx, who);
    const actor = await authority(tx, who, proof), data = await source(tx, actor, input.query);
    const selected = data.rules.filter(rule => rule.active && input.ruleIds.includes(rule.id));
    requireCondition(selected.length === input.ruleIds.length && selected.every(rule => !input.query.jobId || rule.jobId === input.query.jobId), 400, 'Choose current active rules within the selected job.');
    requireCondition(selected.every(rule => data.jobs.some(job => job.id === rule.jobId && job.active)), 409, 'A selected coverage job is archived. Restore the job or choose another active rule before generating.');
    const expanded = expandCoverage(data.rules, input.query);
    requireCondition(!expanded.warnings.some(warning => warning.code !== 'SKIPPED_DATE' && warning.ruleIds.some(id => input.ruleIds.includes(id))), 409, 'Resolve overlapping coverage rules or daylight-saving time decisions before generating this period.');
    const slots = openCoverageSlots(measureCoverage(expanded.occurrences.filter(row => input.ruleIds.includes(row.ruleId)), data.schedules));
    const employeeIds = data.employees.map(row => row.id);
    // Read all-job conflicts, but expose only unavailability, never another scoped job's labels or exact private times.
    const busy = (await tx.query(`SELECT user_id,${preciseTimeSql('starts_at')} AS starts_at,${preciseTimeSql('ends_at')} AS ends_at FROM schedules WHERE org_id=$1 AND user_id=ANY($2::uuid[]) AND status='scheduled' AND starts_at<$4 AND ends_at>$3 LIMIT 20001`, [actor.org_id, employeeIds, exactIso(localDay(input.query.start, data.timezone).minus({ days: 1 })), exactIso(localDay(input.query.end, data.timezone).plus({ days: 2 }))])).rows;
    requireCondition(busy.length <= planningLimits.schedules, 400, 'Too many employee schedule conflicts. Choose a shorter period.');
    const busyByEmployee = new Map<string, Row[]>();
    for (const row of busy) { const entries = busyByEmployee.get(row.user_id) ?? []; entries.push(row); busyByEmployee.set(row.user_id, entries); }
    const candidates = data.employees.map(employee => ({ ...employee, unavailableSlotIds: slots.filter(slot => employee.jobIds.includes(slot.jobId) && (busyByEmployee.get(employee.id) ?? []).some(row => row.starts_at < slot.endsAt && row.ends_at > slot.startsAt)).map(slot => slot.id) }))
      .sort((a, b) => BigInt(a.scheduledMicroseconds) < BigInt(b.scheduledMicroseconds) ? -1 : BigInt(a.scheduledMicroseconds) > BigInt(b.scheduledMicroseconds) ? 1 : a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const createdAt = await timeNow(tx), expiresAt = exactIso(DateTime.fromISO(createdAt).plus({ minutes: 30 }));
    const result: PlanningPreview = { id: randomUUID(), sourceHash: data.revision, createdAt, expiresAt, query: input.query, timezone: data.timezone, ruleIds: input.ruleIds, slots, candidates, jobs: data.jobs, warnings: expanded.warnings.filter(row => row.ruleIds.some(id => input.ruleIds.includes(id))), notice: 'No employee is selected automatically. Candidates are ordered by scheduled hours in your permitted scope and selected date range. Choose each assignment, including any bulk selections, before applying. Missing slots remain unfilled and do not become employee allotments. This preview expires in 30 minutes. ' + notice };
    const serialized = JSON.stringify(result), bytes = Buffer.byteLength(serialized, 'utf8');
    requireCondition(bytes <= 8 * 1024 * 1024, 400, 'This preview exceeds 8 MiB. Choose fewer employees, jobs or dates.');
    const retained = (await tx.query('SELECT coalesce(sum(octet_length(snapshot::text)),0)::bigint AS bytes,count(*)::int AS count FROM staff_planning_previews WHERE org_id=$1', [actor.org_id])).rows[0];
    const storedBytes = Number((await tx.query('SELECT octet_length($1::jsonb::text) AS bytes', [serialized])).rows[0].bytes);
    requireCondition(Number(retained.bytes) + storedBytes <= 64 * 1024 * 1024 && retained.count < 5000, 409, 'Retained planning previews reached the 64 MiB or 5,000-preview organization budget. Ask the developer for a reviewed retention change; no history was deleted.');
    await tx.query('INSERT INTO staff_planning_previews(org_id,id,actor_id,source_hash,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor.org_id, result.id, actor.id, result.sourceHash, serialized, createdAt, expiresAt]);
    await audit(tx, actor, 'schedule.plan_previewed', result.id, { ruleIds: input.ruleIds, query: input.query, slots: slots.length, sourceHash: result.sourceHash });
    await recheckReportSession(tx, actor, proof); return result;
  });
}
export async function applyStaffPlanning(db: Database, supplied: Actor, sessionHash: string | undefined, id: string, raw: unknown): Promise<PlanningApplied> {
  z.uuid().parse(id); const input = planningApplyInput.parse(raw), { supplied: who, proof } = identity(supplied, sessionHash), fingerprint = digest(JSON.stringify({ id, input }));
  return timeTransaction(db, async tx => {
    await plannerLock(tx, who);
    // Lock every affected employee before the actor's current proof and all schedule/job locks.
    const userIds = [...new Set([who.id, ...input.assignments.map(row => row.userId)])].sort();
    const users = (await tx.query('SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE', [who.org_id, userIds])).rows;
    requireCondition(users.length === userIds.length, 404, 'A selected employee is unavailable.');
    const actor = await authority(tx, who, proof), record = (await tx.query('SELECT *,expires_at>clock_timestamp() AS current FROM staff_planning_previews WHERE org_id=$1 AND id=$2 AND actor_id=$3', [actor.org_id, id, actor.id])).rows[0];
    requireCondition(record, 404, 'This preview is unavailable to your account.');
    const preview = record.snapshot as PlanningPreview;
    requireCondition(record.source_hash === input.sourceHash, 409, 'This source hash does not match the saved preview.');
    const chosen = input.assignments.map(selection => { const slot = preview.slots.find(row => row.id === selection.slotId); requireCondition(slot, 400, 'Choose only saved open slots.'); return { ...selection, slot }; });
    const jobIds = [...new Set(chosen.map(row => row.slot.jobId))].sort();
    // Existing direct/import/request schedule writers take jobs FOR SHARE before
    // mutation. Exclusive job locks freeze coverage across OTHER employees too,
    // after our sorted selected-account locks and before reading the source.
    const jobs = (await tx.query('SELECT id,unit_id FROM jobs WHERE org_id=$1 AND ($2::boolean OR unit_id=ANY($3::uuid[])) ORDER BY id FOR UPDATE', [actor.org_id, orgWide(actor), actor.unit_ids])).rows;
    requireCondition(jobIds.every(id => jobs.some(job => job.id === id)), 403, 'Selected jobs are outside your current scope.');
    await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, [...new Set(jobs.map(job => job.unit_id))].sort()]);
    const prior = await savedCommand(tx, actor, input.commandId, fingerprint);
    if (prior) { await recheckReportSession(tx, actor, proof); return { ...prior, replayed: true }; }
    requireCondition(!(await tx.query('SELECT preview_id FROM staff_planning_applications WHERE org_id=$1 AND preview_id=$2', [actor.org_id, id])).rows.length, 409, 'This preview was already applied. Generate a fresh preview for remaining coverage.');
    requireCondition(record.current, 409, 'This preview expired. Generate a new preview before assigning shifts.');
    const data = await source(tx, actor, preview.query);
    requireCondition(data.revision === preview.sourceHash, 409, 'Rules, targets, assignments or schedules changed since this preview. Generate a new preview.');
    for (const row of chosen) {
      const candidate = preview.candidates.find(person => person.id === row.userId);
      requireCondition(candidate && candidate.jobIds.includes(row.slot.jobId) && !candidate.unavailableSlotIds.includes(row.slotId), 409, 'One selected employee is not eligible or was unavailable for this slot.');
    }
    const schedules: PlanningApplied['schedules'] = [];
    for (const row of chosen.sort((a, b) => a.userId.localeCompare(b.userId) || a.slot.startsAt.localeCompare(b.slot.startsAt) || a.slot.id.localeCompare(b.slot.id))) {
      const change = await prepareStaffScheduleChange(tx, actor, { action: 'created', input: { userId: row.userId, jobId: row.slot.jobId, startsAt: row.slot.startsAt, endsAt: row.slot.endsAt, note: 'Reviewed coverage plan · ' + preview.id, reason: input.reason, commandId: randomUUID() } });
      schedules.push(await change.apply());
    }
    const result: PlanningApplied = { id, replayed: false, schedules, appliedCount: schedules.length };
    await tx.query('INSERT INTO staff_planning_applications(org_id,preview_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)', [actor.org_id, id, actor.id, input.commandId, fingerprint, JSON.stringify(result)]);
    await audit(tx, actor, 'schedule.plan_applied', id, { commandId: input.commandId, sourceHash: input.sourceHash, assignments: input.assignments, scheduleIds: schedules.map(row => row.id), reason: input.reason });
    await commandReceipt(tx, actor, input.commandId, fingerprint, result);
    requireCondition((await tx.query('SELECT id FROM staff_planning_previews WHERE org_id=$1 AND id=$2 AND expires_at>clock_timestamp()', [actor.org_id, id])).rows.length === 1, 409, 'This preview expired while assignments were being saved. No assignments were applied; generate a new preview.');
    await recheckReportSession(tx, actor, proof); return result;
  });
}
export function installStaffPlanning(app: Express, db: Database) {
  const state = (req: Request) => req as unknown as AppRequest;
  app.get('/api/schedules/planning', async (req, res) => res.set('Cache-Control', 'private, no-store').json(await getStaffPlanning(db, state(req).actor, state(req).sessionHash, req.query)));
  for (const [path, kind] of [['rules', 'rule'], ['targets', 'target']] as const) {
    app.put('/api/schedules/planning/' + path + '/:id', async (req, res) => res.set('Cache-Control', 'private, no-store').json(await saveDefinition(db, state(req).actor, state(req).sessionHash, kind, String(req.params.id), req.body)));
    app.get('/api/schedules/planning/' + path + '/:id/history', async (req, res) => res.set('Cache-Control', 'private, no-store').json(await planningDefinitionHistory(db, state(req).actor, state(req).sessionHash, kind, String(req.params.id))));
  }
  app.post('/api/schedules/planning/preview', async (req, res) => res.set('Cache-Control', 'private, no-store').status(201).json(await previewStaffPlanning(db, state(req).actor, state(req).sessionHash, req.body)));
  app.post('/api/schedules/planning/:id/apply', async (req, res) => res.set('Cache-Control', 'private, no-store').json(await applyStaffPlanning(db, state(req).actor, state(req).sessionHash, String(req.params.id), req.body)));
}
