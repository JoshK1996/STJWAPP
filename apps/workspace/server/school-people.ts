import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db';
import { Problem, requireCondition, type Actor } from './security';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { assertOffice, schoolChange } from './school';
import { personInput, personUpdateInput } from '../shared/school';

const uuid = (value: unknown) => z.uuid().parse(value).toLowerCase();
function proof(value: string | undefined): string {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 401, 'Sign in again to open school person records.');
  return value;
}
function identity(actor: Actor): Actor {
  return { ...actor, id: uuid(actor.id), org_id: uuid(actor.org_id), unit_ids: [...actor.unit_ids] };
}
async function transaction<T>(db: Database, action: (tx: Queryable) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'");
      await tx.query("SET LOCAL lock_timeout='5s'");
      return action(tx);
    });
  } catch (error: any) {
    if (['55P03', '57014', '40001', '40P01'].includes(error.code))
      throw new Problem(503, 'School person records are busy. Refresh the directory before retrying a change.');
    throw error;
  }
}
// Account -> actual password proof -> memberships -> exact office grant. No
// academic or student/household locks are acquired by these standalone routes.
async function currentOffice(tx: Queryable, supplied: Actor, hash: string, unitId: string) {
  const actor = await currentReportActor(tx, supplied, hash);
  requireCondition((await tx.query('SELECT id FROM units WHERE id=$1 AND org_id=$2', [unitId, actor.org_id])).rows.length, 404, 'School unit not found.');
  if (!['developer','owner', 'admin'].includes(actor.role)) {
    requireCondition(actor.unit_ids.includes(unitId), 403, 'School office access to this unit is required.');
    requireCondition((await tx.query('SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE', [actor.org_id, actor.id, unitId])).rows.length, 403, 'School office access to this unit is required.');
  }
  return actor;
}
async function publish<T>(tx: Queryable, actor: Actor, hash: string, value: T): Promise<T> {
  // Materialize while still authorized and before the final DB-clock proof.
  const result = JSON.parse(JSON.stringify(value)) as T;
  await recheckReportSession(tx, actor, hash);
  return result;
}

// Transaction-only helpers: callers must establish current scoped authority
// before any person lock. Bulk writers must prelock their complete person set.
// These helpers never acquire a student, household or academic parent lock.
export async function createPersonTransaction(tx: Queryable, actor: Actor, raw: z.infer<typeof personInput>) {
  const input = personInput.parse(raw), unitId = uuid(input.unitId);
  await assertOffice(tx, actor, unitId);
  const created = (await tx.query('INSERT INTO school_people(id,org_id,unit_id,name,email,phone) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [randomUUID(), actor.org_id, unitId, input.name, input.email, input.phone])).rows[0];
  await schoolChange(tx, actor, unitId, 'person.created', created.id, null, created);
  return created;
}

export async function updatePersonTransaction(tx: Queryable, actor: Actor, rawId: string, raw: z.infer<typeof personUpdateInput>) {
  const personId = uuid(rawId), input = personUpdateInput.parse(raw);
  const old = (await tx.query('SELECT * FROM school_people WHERE id=$1 AND org_id=$2 FOR UPDATE', [personId, actor.org_id])).rows[0];
  requireCondition(old, 404, 'Person not found.');
  await assertOffice(tx, actor, old.unit_id);
  requireCondition(!(await tx.query('SELECT id FROM students WHERE person_id=$1', [personId])).rows.length, 400, 'Edit student names through their student record.');
  requireCondition(old.version === input.version, 409, 'Contact changed. Refresh first.');
  const updated = (await tx.query('UPDATE school_people SET name=$1,email=$2,phone=$3,version=version+1 WHERE id=$4 AND org_id=$5 AND unit_id=$6 AND version=$7 RETURNING *',
    [input.name, input.email, input.phone, personId, actor.org_id, old.unit_id, input.version])).rows[0];
  requireCondition(updated, 409, 'Contact changed. Refresh first.');
  await schoolChange(tx, actor, old.unit_id, 'person.updated', personId, old, updated);
  return updated;
}

export async function listPeople(db: Database, supplied: Actor, rawUnit: unknown, sessionHash: string | undefined) {
  const hash = proof(sessionHash), captured = identity(supplied), unitId = uuid(rawUnit);
  return transaction(db, async tx => {
    const actor = await currentOffice(tx, captured, hash, unitId);
    const rows = (await tx.query('SELECT p.id,p.name,p.email,p.phone,p.version,s.id AS student_id FROM school_people p LEFT JOIN students s ON s.person_id=p.id WHERE p.org_id=$1 AND p.unit_id=$2 ORDER BY p.name,p.id LIMIT 1001', [actor.org_id, unitId])).rows;
    requireCondition(rows.length <= 1000, 422, 'This person directory exceeds the 1,000-record limit. No partial directory was returned.');
    return publish(tx, actor, hash, { rows });
  });
}

export async function createPerson(db: Database, supplied: Actor, raw: unknown, sessionHash: string | undefined) {
  const hash = proof(sessionHash), captured = identity(supplied), input = personInput.parse(raw);
  input.unitId = uuid(input.unitId);
  return transaction(db, async tx => {
    const actor = await currentOffice(tx, captured, hash, input.unitId);
    return publish(tx, actor, hash, await createPersonTransaction(tx, actor, input));
  });
}

export async function updatePerson(db: Database, supplied: Actor, rawId: unknown, raw: unknown, sessionHash: string | undefined) {
  const hash = proof(sessionHash), captured = identity(supplied), personId = uuid(rawId), input = personUpdateInput.parse(raw);
  return transaction(db, async tx => {
    // Discover only scope before authority. Never return identity data here.
    const found = (await tx.query('SELECT unit_id FROM school_people WHERE id=$1 AND org_id=$2', [personId, captured.org_id])).rows[0];
    requireCondition(found, 404, 'Person not found.');
    const actor = await currentOffice(tx, captured, hash, found.unit_id);
    const locked = (await tx.query('SELECT unit_id FROM school_people WHERE id=$1 AND org_id=$2 FOR UPDATE', [personId, actor.org_id])).rows[0];
    requireCondition(locked, 404, 'Person not found.');
    requireCondition(locked.unit_id === found.unit_id, 409, 'Contact scope changed. Refresh first.');
    return publish(tx, actor, hash, await updatePersonTransaction(tx, actor, personId, input));
  });
}
