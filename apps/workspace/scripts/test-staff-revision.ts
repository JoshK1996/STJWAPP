import type { Database } from '../server/db';
import { staffRecordRevision } from '../server/staff-revision';

/** Existing synthetic fixtures need a current source token to reach their intended guards.
 * Stale-edit regressions separately exercise revisions obtained from the actual HTTP directory. */
export async function testStaffRevision(db: Database, userId: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic fixture helpers cannot run in production.');
  const row = (await db.query(`SELECT u.id,u.org_id,u.name,u.email,u.role,u.active,
    coalesce((SELECT jsonb_agg(unit_id) FROM user_units WHERE user_id=u.id AND org_id=u.org_id),'[]') AS unit_ids,
    coalesce((SELECT jsonb_agg(job_id) FROM user_jobs WHERE user_id=u.id AND org_id=u.org_id),'[]') AS job_ids
    FROM users u WHERE u.id=$1`, [userId])).rows[0];
  if (!row) throw new Error('Synthetic employee fixture unavailable.');
  return staffRecordRevision(row.org_id, row as Parameters<typeof staffRecordRevision>[1]);
}
