import { z } from 'zod';
import type { Database } from './db';
import type { Actor } from './security';
import { audit,requireCondition } from './security';
import { currentReportActor,recheckReportSession } from './report-source-access';
import { requestInput } from '../shared/contracts';

export const requestEditInput=requestInput.safeExtend({expectedVersion:z.number().int().positive()});
export const requestWithdrawInput=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(3).max(1000)}).strict();
export async function editOwnRequest(db:Database,supplied:Actor,proof:string|undefined,id:string,raw:unknown,withdraw=false){
 requireCondition(typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof),401,'A current password session is required.');
 const target=z.uuid().parse(id),input=withdraw?requestWithdrawInput.parse(raw):requestEditInput.parse(raw);
 return db.transaction(async tx=>{
  const actor=await currentReportActor(tx,supplied,proof);
  requireCondition(actor.mode==='password',403,'Sign in with your password to change a request.');
  const before=(await tx.query('SELECT * FROM requests WHERE org_id=$1 AND id=$2 FOR UPDATE',[actor.org_id,target])).rows[0];
  requireCondition(before,404,'Request not found.');requireCondition(before.user_id===actor.id,403,'Only the employee who submitted this request can edit or withdraw it.');
  requireCondition(before.status==='pending',409,'This request has already been reviewed or withdrawn. Submit a new request to retain the recorded decision.');
  requireCondition(before.version===input.expectedVersion,409,'This request changed while you were editing. Close the editor, refresh and review the latest version.');
  if(withdraw){
   await tx.query("UPDATE requests SET status='cancelled',version=version+1 WHERE org_id=$1 AND id=$2",[actor.org_id,target]);
  }else{
   const value=requestEditInput.parse(input);requireCondition(actor.unit_ids.includes(value.unitId),403,'Choose one of your current explicitly assigned communities.');
   await tx.query('UPDATE requests SET unit_id=$1,kind=$2,starts_on=$3,ends_on=$4,note=$5,version=version+1 WHERE org_id=$6 AND id=$7',[value.unitId,value.kind,value.startsOn,value.endsOn,value.note,actor.org_id,target]);
  }
  await audit(tx,actor,withdraw?'request.withdrawn':'request.updated',target,{before,after:input});
  await recheckReportSession(tx,actor,proof);return {id:target,version:before.version+1,status:withdraw?'cancelled':'pending'};
 });
}
