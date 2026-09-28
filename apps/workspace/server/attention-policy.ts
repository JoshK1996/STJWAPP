import type {Database,Queryable} from './db';
import {audit,canReport,digest,Problem,requireCondition,type Actor} from './security';
import {currentReportActor,recheckReportSession} from './report-source-access';
import {attentionPolicyInput,attentionPolicyResponseSchema,attentionPolicySaveResponseSchema,attentionPolicySchema,defaultAttentionPolicy} from '../shared/attention-policy';

const canEdit=(actor:Actor)=>actor.mode==='password'&&['developer','owner','admin'].includes(actor.role);
const exact=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function readAttentionPolicy(tx:Queryable,orgId:string){
 const row=(await tx.query(`SELECT version,rules,updated_by_name AS "updatedByName",${exact('updated_at')} AS "updatedAt" FROM workforce_attention_policy WHERE org_id=$1`,[orgId])).rows[0];
 return row?attentionPolicySchema.parse(row):defaultAttentionPolicy();
}
function proof(hash:string|undefined):asserts hash is string{requireCondition(typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash),401,'Your session has expired or changed. Sign in again.');}
export async function getAttentionPolicy(db:Database,supplied:Actor,sessionHash:string|undefined){
 proof(sessionHash);const identity={...supplied,unit_ids:[...supplied.unit_ids]};
 return db.transaction(async tx=>{
  const actor=await currentReportActor(tx,identity,sessionHash);requireCondition(canReport(actor),403,'Workforce reporting access required.');
  const result=attentionPolicyResponseSchema.parse({policy:await readAttentionPolicy(tx,actor.org_id),canEdit:canEdit(actor)});
  await recheckReportSession(tx,actor,sessionHash);return result;
 });
}
export async function saveAttentionPolicy(db:Database,supplied:Actor,sessionHash:string|undefined,raw:unknown){
 proof(sessionHash);const input=attentionPolicyInput.parse(raw),fingerprint=digest(JSON.stringify(input)),identity={...supplied,unit_ids:[...supplied.unit_ids]};
 for(let attempt=0;;attempt++){
  try{return await db.transaction(async tx=>{
   await tx.query("SET LOCAL statement_timeout='15s'");await tx.query("SET LOCAL lock_timeout='5s'");
   const actor=await currentReportActor(tx,identity,sessionHash,true);requireCondition(canEdit(actor),403,'Only administrators, owners and developers can change shared flag rules.');
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.org_id+':workforce-attention-policy']);
   const old=(await tx.query('SELECT fingerprint,after_snapshot FROM workforce_attention_history WHERE org_id=$1 AND actor_id=$2 AND command_id=$3',[actor.org_id,actor.id,input.commandId])).rows[0];
   if(old){requireCondition(old.fingerprint===fingerprint,409,'This save was already used for different flag rules. Reload the shared rules.');await recheckReportSession(tx,actor,sessionHash);return attentionPolicySaveResponseSchema.parse({policy:old.after_snapshot,canEdit:true,replayed:true});}
   const before=await readAttentionPolicy(tx,actor.org_id);requireCondition(before.version===input.expectedVersion,409,'Another administrator changed the shared flag rules. Reload them before saving.');
   const returning=` RETURNING version,rules,updated_by_name AS "updatedByName",${exact('updated_at')} AS "updatedAt"`;
   const sql=before.version===0?'INSERT INTO workforce_attention_policy(org_id,version,rules,updated_by,updated_by_name) VALUES($1,$2,$3,$4,$5)':'UPDATE workforce_attention_policy SET version=$2,rules=$3,updated_by=$4,updated_by_name=$5,updated_at=clock_timestamp() WHERE org_id=$1';
   const row=(await tx.query(sql+returning,[actor.org_id,before.version+1,input.rules,actor.id,actor.name])).rows[0];
   const policy=attentionPolicySchema.parse(row);
   await tx.query('INSERT INTO workforce_attention_history(org_id,version,actor_id,command_id,fingerprint,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.org_id,policy.version,actor.id,input.commandId,fingerprint,before,policy]);
   await audit(tx,actor,'workforce.attention_policy_updated',actor.org_id,{before,after:policy});
   await recheckReportSession(tx,actor,sessionHash);return attentionPolicySaveResponseSchema.parse({policy,canEdit:true,replayed:false});
  });}catch(error){const code=(error as {code?:string}).code;if(['40001','40P01'].includes(code??'')&&attempt<2)continue;if(['55P03','57014','40001','40P01'].includes(code??''))throw new Problem(503,'Shared flag rules are busy. Retry the same save.');throw error;}
 }
}
