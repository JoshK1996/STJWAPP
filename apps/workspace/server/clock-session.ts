import type { Database } from './db';
import { clockInput } from '../shared/contracts';
import { type Actor } from './security';
import { clockTransition } from './workforce';
import { timeTransaction } from './time-record-access';
import {currentClockActor,recheckClockSession} from './clock-session-access';
export {currentClockActor,recheckClockSession} from './clock-session-access';
import {clockStateWithPreclock,interceptScheduledClockIn,readPreclockState} from './scheduled-clock';

/** Public read boundary: actual proof is mandatory, including for PIN. */
export async function getAuthenticatedClock(db: Database, supplied: Actor, sessionHash: string) {
  return timeTransaction(db,async tx=>{
    const actor=await currentClockActor(tx,supplied,sessionHash,false);
    const result=await clockStateWithPreclock(tx,actor);
    await recheckClockSession(tx,actor,sessionHash);
    return result;
  });
}

/** No injected timestamp or omitted-proof path is exposed to public callers. */
export async function applyAuthenticatedClockCommand(db: Database, supplied: Actor, sessionHash: string, raw: unknown) {
  const input=clockInput.parse(raw);
  return timeTransaction(db,async tx=>{
    const actor=await currentClockActor(tx,supplied,sessionHash,true);
    const intercepted=await interceptScheduledClockIn(tx,actor,input);
    const result=intercepted??await clockTransition(tx,actor,input,undefined,undefined,async state=>({...state,preclock:await readPreclockState(tx,actor)}));
    // Includes exact receipt replay. A lost response never restores old authority.
    await recheckClockSession(tx,actor,sessionHash);
    return result;
  });
}
