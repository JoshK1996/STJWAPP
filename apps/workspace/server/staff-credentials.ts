import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Database } from './db';
import type { AppRequest } from './auth';
import { staffTemporaryCredentialsInput, staffTemporaryCredentialsResult } from '../shared/temporary-credentials';
import { audit, hashPassword, limitAuth, requireCondition, type Actor } from './security';
import { assertManagePerson } from './workforce';
import { currentReportActor, recheckReportSession } from './report-source-access';
import { acquirePinNamespace } from './pin-auth';

function fingerprint(actor: Actor, targetId: string, input: z.infer<typeof staffTemporaryCredentialsInput>) {
  const key = process.env.STJW_PIN_LOOKUP_SECRET;
  requireCondition(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), 503, 'Credential setup is temporarily unavailable. Ask the developer to check the sign-in configuration.');
  return createHmac('sha256', Buffer.from(key, 'hex')).update('stjw-staff-credential-command-v1\0').update(JSON.stringify({ orgId: actor.org_id, actorId: actor.id, targetId, commandId: input.commandId, password: input.password, pin: input.pin, reason: input.reason })).digest('hex');
}

/** Administrator-assisted recovery preserves MFA and requires both credentials to be replaced at next sign-in. */
export async function resetStaffTemporaryCredentials(db: Database, supplied: Actor, sessionHash: string | undefined, target: string, raw: unknown) {
  const input = staffTemporaryCredentialsInput.parse(raw), id = z.uuid().parse(target).toLowerCase();
  requireCondition(supplied.mode === 'password' && ['developer', 'owner', 'admin'].includes(supplied.role), 403, 'Only owners and administrators can reset temporary credentials.');
  requireCondition(typeof sessionHash === 'string' && /^[a-f0-9]{64}$/.test(sessionHash), 401, 'A current password session is required.');
  requireCondition(id !== supplied.id, 403, 'Use Change your password in Settings for your own account.');
  await limitAuth(db, 'staff:temporary:reset:' + supplied.id, 20);
  const identity = { ...supplied, id: supplied.id.toLowerCase(), org_id: supplied.org_id.toLowerCase() };
  const commandFingerprint = fingerprint(identity, id, input);
  const [passwordHash, pinHash] = await Promise.all([hashPassword(input.password), hashPassword(input.pin)]);
  return db.transaction(async tx => {
    // Same namespace-before-sorted-accounts order as staff active-state and PIN writers.
    await acquirePinNamespace(tx);
    for (const accountId of [identity.id, id].sort()) {
      const found = (await tx.query(`SELECT id FROM users WHERE id=$1 AND org_id=$2 FOR ${accountId === id ? 'UPDATE' : 'SHARE'}`, [accountId, identity.org_id])).rows[0];
      requireCondition(found, accountId === identity.id ? 403 : 404, 'This account is unavailable.');
    }
    const actor = await currentReportActor(tx, identity, sessionHash);
    requireCondition(['developer', 'owner', 'admin'].includes(actor.role), 403, 'Only owners and administrators can reset temporary credentials.');
    await assertManagePerson(tx, actor, id);
    const user = (await tx.query('SELECT active,requires_credential_change FROM users WHERE id=$1 AND org_id=$2', [id, actor.org_id])).rows[0];
    const previous = (await tx.query('SELECT actor_id,target_id,fingerprint FROM staff_credential_commands WHERE org_id=$1 AND command_id=$2', [actor.org_id, input.commandId])).rows[0];
    if (previous) {
      requireCondition(previous.actor_id === actor.id && previous.target_id === id && timingSafeEqual(Buffer.from(previous.fingerprint, 'hex'), Buffer.from(commandFingerprint, 'hex')), 409, 'This reset command was already used. Retry with the original unchanged details, or start a new reset.');
      await recheckReportSession(tx, actor, sessionHash);
      return staffTemporaryCredentialsResult.parse({ id, requiresCredentialChange: user.requires_credential_change, replayed: true });
    }
    requireCondition(user.active, 409, 'Reactivate this staff account before assigning temporary credentials.');
    await tx.query('UPDATE users SET password_hash=$1,pin_hash=$2,requires_credential_change=true,pin_lookup=NULL,pin_lookup_key_id=NULL WHERE id=$3 AND org_id=$4', [passwordHash, pinHash, id, actor.org_id]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('UPDATE setup_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND org_id=$2 AND consumed_at IS NULL', [id, actor.org_id]);
    await tx.query('DELETE FROM credential_change_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM mfa_challenges WHERE user_id=$1 AND org_id=$2', [id, actor.org_id]);
    await tx.query('DELETE FROM mfa_factors WHERE user_id=$1 AND org_id=$2 AND enabled_at IS NULL', [id, actor.org_id]);
    await tx.query('UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, actor.org_id]);
    await tx.query('INSERT INTO staff_credential_commands(org_id,actor_id,command_id,target_id,fingerprint) VALUES($1,$2,$3,$4,$5)', [actor.org_id, actor.id, input.commandId, id, commandFingerprint]);
    await audit(tx, actor, 'staff.temporary_credentials_reset', id, { commandId: input.commandId, reason: input.reason, requiresCredentialChange: true });
    await recheckReportSession(tx, actor, sessionHash);
    return staffTemporaryCredentialsResult.parse({ id, requiresCredentialChange: true, replayed: false });
  });
}

export function installStaffCredentials(app: Express, db: Database) {
  app.post('/api/staff/:id/temporary-credentials', async (req, res) => {
    const request = req as unknown as AppRequest;
    res.set('Cache-Control', 'private, no-store').json(await resetStaffTemporaryCredentials(db, request.actor, request.sessionHash, String(req.params.id), req.body));
  });
}
