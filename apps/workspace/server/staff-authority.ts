import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db';
import { assertUnit, audit, issueSetup, manages, Problem, requireCondition, type Actor } from './security';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { assertManagePerson, validateStaff } from './workforce';
import { staffInput } from '../shared/contracts';
import { acquirePinNamespace } from './pin-auth';

export const staffUpdateInput = staffInput.extend({ active: z.boolean() });
export const managedJobInput = z.object({ unitId: z.uuid(), title: z.string().trim().min(2).max(100) }).strict();
const proofOf = (value: string | undefined): string => {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 401, 'Your session has expired or changed. Sign in again.');
  return value;
};
const capture = (actor: Actor) => ({ ...actor, id: actor.id.toLowerCase(), org_id: actor.org_id.toLowerCase(), unit_ids: actor.unit_ids.map(id => id.toLowerCase()) });
async function transaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'");
      await tx.query("SET LOCAL lock_timeout='5s'");
      return work(tx);
    }); } catch (error) {
      const code = (error as { code?: string }).code;
      if (['40001', '40P01'].includes(code ?? '') && attempt < 2) continue;
      if (['55P03', '57014', '40001', '40P01'].includes(code ?? '')) throw new Problem(503, 'Staff management is busy. Refresh the current state before trying again.');
      throw error;
    }
  }
}
async function currentActor(tx: Queryable, supplied: Actor, proof: string, targetId?: string) {
  requireCondition(supplied.mode === 'password', 403, 'Password sign-in is required for staff management.');
  if (targetId) {
    // Lock both existing accounts in a stable order before any session or
    // membership lock. Actor SHARE keeps audit foreign keys compatible; target
    // UPDATE is taken initially, never upgraded from a shared target lock.
    for (const id of [...new Set([supplied.id, targetId])].sort()) {
      const mode = id === targetId ? 'UPDATE' : 'SHARE';
      const found = (await tx.query(`SELECT id FROM users WHERE id=$1 AND org_id=$2 FOR ${mode}`, [id, supplied.org_id])).rows[0];
      requireCondition(found, id === supplied.id ? 403 : 404, id === supplied.id ? 'This account is unavailable.' : 'Staff member not found.');
    }
  }
  const actor = await currentReportActor(tx, supplied, proof);
  requireCondition(manages(actor), 403, 'Staff management access required.');
  return actor;
}
async function publish<T>(tx: Queryable, actor: Actor, proof: string, result: T) {
  JSON.stringify(result);
  await recheckReportSession(tx, actor, proof);
  return result;
}
async function lockAssignments(tx: Queryable, actor: Actor, input: z.infer<typeof staffUpdateInput>) {
  const jobs = [...new Set(input.jobIds)].sort();
  const found = (await tx.query('SELECT id,unit_id,active FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, jobs])).rows;
  requireCondition(found.length === jobs.length && found.every(job => job.active), 400, 'Jobs must be current active jobs in the assigned units.');
  const units = [...new Set([...input.unitIds, ...found.map(job => job.unit_id as string)])].sort();
  const rows = (await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [actor.org_id, units])).rows;
  requireCondition(rows.length === units.length, 400, 'Unknown organizational unit.');
}

export async function updateStaffAccount(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string, raw: unknown, staffDomain: string) {
  const proof = proofOf(sessionHash), identity = capture(supplied), id = z.uuid().parse(targetId).toLowerCase(), input = staffUpdateInput.parse(raw);
  return transaction(db, async tx => {
    // Active-state changes participate in identifier-free PIN uniqueness before
    // either actor or target account is locked.
    await acquirePinNamespace(tx);
    const actor = await currentActor(tx, identity, proof, id);
    await assertManagePerson(tx, actor, id);
    await lockAssignments(tx, actor, input);
    const before = (await tx.query('SELECT name,email,role,active FROM users WHERE id=$1 AND org_id=$2', [id, actor.org_id])).rows[0];
    await validateStaff(tx, actor, input, staffDomain, { role: before.role, email: before.email });
    before.unitIds = (await tx.query('SELECT unit_id FROM user_units WHERE user_id=$1 AND org_id=$2 ORDER BY unit_id', [id, actor.org_id])).rows.map(row => row.unit_id);
    before.jobIds = (await tx.query('SELECT job_id FROM user_jobs WHERE user_id=$1 AND org_id=$2 ORDER BY job_id', [id, actor.org_id])).rows.map(row => row.job_id);
    requireCondition(!(await tx.query('SELECT id FROM shifts WHERE user_id=$1 AND org_id=$2 AND ended_at IS NULL', [id, actor.org_id])).rows.length,
      409, 'Clock out before changing this employee’s account or job assignments.');
    // An inactive PIN may now collide with a different active account. Preserve
    // its salted hash but require legacy uniqueness verification after reactivation.
    await tx.query('UPDATE users SET name=$1,email=$2,role=$3,pin_lookup=CASE WHEN NOT active AND $4 THEN NULL ELSE pin_lookup END,pin_lookup_key_id=CASE WHEN NOT active AND $4 THEN NULL ELSE pin_lookup_key_id END,active=$4 WHERE id=$5 AND org_id=$6', [input.name, input.email, input.role, input.active, id, actor.org_id]);
    await tx.query('DELETE FROM user_jobs WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM user_units WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    for (const unitId of [...new Set(input.unitIds)].sort()) await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [actor.org_id, id, unitId]);
    for (const jobId of [...new Set(input.jobIds)].sort()) await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)', [actor.org_id, id, jobId]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, actor.org_id]);
    await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM credential_change_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await audit(tx, actor, 'staff.updated', id, { before, after: input });
    return publish(tx, actor, proof, { ok: true as const });
  });
}

export async function issueManagedStaffSetupLink(db: Database, supplied: Actor, sessionHash: string | undefined, targetId: string, origin: string) {
  const proof = proofOf(sessionHash), identity = capture(supplied), id = z.uuid().parse(targetId).toLowerCase();
  return transaction(db, async tx => {
    const actor = await currentActor(tx, identity, proof, id);
    await assertManagePerson(tx, actor, id);
    const token = await issueSetup(tx, { id, org_id: actor.org_id });
    await audit(tx, actor, 'staff.setup_issued', id);
    return publish(tx, actor, proof, { setupUrl: `${origin}/#setup=${token}` });
  });
}

export async function createManagedJob(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown) {
  const proof = proofOf(sessionHash), identity = capture(supplied), input = managedJobInput.parse(raw);
  return transaction(db, async tx => {
    const actor = await currentActor(tx, identity, proof);
    assertUnit(actor, input.unitId);
    requireCondition((await tx.query('SELECT id FROM units WHERE id=$1 AND org_id=$2 FOR SHARE', [input.unitId, actor.org_id])).rows.length, 404, 'Unit not found.');
    const id = randomUUID();
    await tx.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)', [id, actor.org_id, input.unitId, input.title]);
    await audit(tx, actor, 'job.created', id, input);
    return publish(tx, actor, proof, { id });
  });
}
