import type { Database, Queryable } from './db';
import { clockInput } from '../shared/contracts';
import { requireCondition, type Actor } from './security';
import { clockState, clockTransition } from './workforce';
import { timeTransaction } from './time-record-access';

/** Account is already held before this proof. PIN intentionally keeps its
 * existing restricted clock scope without requiring password MFA. */
async function recheckClockSession(tx: Queryable, actor: Actor, sessionHash: string) {
  requireCondition((await tx.query(`SELECT s.token_hash FROM sessions s
    WHERE s.token_hash=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.mode=$4
      AND s.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM users u WHERE u.org_id=s.org_id AND u.id=s.user_id AND u.active AND NOT u.requires_credential_change)
      AND (s.mode='pin' OR s.mfa_verified OR NOT EXISTS(SELECT 1 FROM mfa_factors f WHERE f.org_id=s.org_id AND f.user_id=s.user_id AND f.enabled_at IS NOT NULL))
    FOR SHARE OF s`, [sessionHash,actor.org_id,actor.id,actor.mode])).rows.length,401,'Your clock session has expired or changed. Sign in again.');
}

async function currentClockActor(tx: Queryable, supplied: Actor, sessionHash: string, write: boolean): Promise<Actor> {
  requireCondition(supplied.mode==='password' || supplied.mode==='pin',403,'Sign in with your password or PIN to use the clock.');
  requireCondition(typeof sessionHash==='string' && /^[a-f0-9]{64}$/.test(sessionHash),401,'A verified clock session is required.');
  // Credential, staff and assignment writers use this same account-first order.
  const user=(await tx.query(`SELECT id,org_id,name,email,role,active,requires_credential_change FROM users
    WHERE id=$1 AND org_id=$2 FOR ${write?'UPDATE':'SHARE'}`,[supplied.id,supplied.org_id])).rows[0];
  requireCondition(user?.active && !user.requires_credential_change,403,'This account is inactive or must finish credential setup.');
  const actor:Actor={id:user.id,org_id:user.org_id,name:user.name,email:user.email,role:user.role,mode:supplied.mode,
    unit_ids:(await tx.query('SELECT unit_id FROM user_units WHERE org_id=$1 AND user_id=$2 ORDER BY unit_id FOR SHARE',[user.org_id,user.id])).rows.map(row=>row.unit_id)};
  await recheckClockSession(tx,actor,sessionHash);
  return actor;
}

/** Public read boundary: actual proof is mandatory, including for PIN. */
export async function getAuthenticatedClock(db: Database, supplied: Actor, sessionHash: string) {
  return timeTransaction(db,async tx=>{
    const actor=await currentClockActor(tx,supplied,sessionHash,false);
    const result=await clockState(tx,actor);
    await recheckClockSession(tx,actor,sessionHash);
    return result;
  });
}

/** No injected timestamp or omitted-proof path is exposed to public callers. */
export async function applyAuthenticatedClockCommand(db: Database, supplied: Actor, sessionHash: string, raw: unknown) {
  const input=clockInput.parse(raw);
  return timeTransaction(db,async tx=>{
    const actor=await currentClockActor(tx,supplied,sessionHash,true);
    const result=await clockTransition(tx,actor,input);
    // Includes exact receipt replay. A lost response never restores old authority.
    await recheckClockSession(tx,actor,sessionHash);
    return result;
  });
}
