import express, { type Express, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Database, Queryable, Row } from './db';
import type { AppRequest } from './auth';
import { audit, canAdminister, canReport, digest, limitAuth, manages, orgWide, requireCondition, type Actor } from './security';
import { currentClockActor, recheckClockSession } from './clock-session-access';
import { canonicalTimeJson, preciseTimeSql, timeTransaction } from './time-record-access';
import { shoppingJobFamily } from './shopping-jobs';
import { normalizeReceiptImage, receiptHash, receiptSource } from './receipt-image';
import { receiptAmountMinor, receiptLimits, receiptListInput, receiptStateInput, receiptUploadInput, type ShoppingReceipt } from '../shared/shopping-receipts';

const projection=`r.id,r.org_id,r.user_id,r.job_id,r.unit_id,r.employee_name,r.job_title,r.unit_name,r.purchased_on::text AS purchased_on,
 r.vendor,r.amount_minor::text AS amount_minor,r.note,r.shift_id,r.shift_revision,r.status,r.version,r.width,r.height,r.photo_size,
 ${preciseTimeSql('r.uploaded_at')} AS uploaded_at,${preciseTimeSql('r.updated_at')} AS updated_at`;
const visible=(actor:Actor,row:Row)=>row.user_id===actor.id||(canReport(actor)&&(orgWide(actor)||actor.unit_ids.includes(row.unit_id)));
const manage=(actor:Actor,row:Row)=>actor.mode==='password'&&manages(actor)&&(orgWide(actor)||actor.unit_ids.includes(row.unit_id));
const dto=(actor:Actor,row:Row):ShoppingReceipt=>({id:row.id,userId:row.user_id,employeeName:row.employee_name,jobId:row.job_id,jobTitle:row.job_title,unitId:row.unit_id,unitName:row.unit_name,
  purchasedOn:row.purchased_on,vendor:row.vendor,amountMinor:row.amount_minor,note:row.note,shiftId:row.shift_id,shiftRevision:row.shift_revision,
  uploadedAt:row.uploaded_at,updatedAt:row.updated_at,status:row.status,version:row.version,width:row.width,height:row.height,photoSize:row.photo_size,canManage:manage(actor,row)});
async function context(tx:Queryable,actor:Actor){
  return (await tx.query("SELECT timezone,(clock_timestamp() AT TIME ZONE timezone)::date::text AS today FROM organizations WHERE id=$1",[actor.org_id])).rows[0] as {timezone:string;today:string};
}
async function eligible(tx:Queryable,actor:Actor){
  return (await tx.query(`SELECT s.id,s.title,p.unit_id,u.name AS unit_name,c.title AS cafe_title FROM shopping_programs p
    JOIN jobs s ON s.id=p.shopping_job_id AND s.org_id=p.org_id AND s.active JOIN jobs c ON c.id=p.cafe_job_id AND c.org_id=p.org_id AND c.active
    JOIN user_jobs sj ON sj.org_id=p.org_id AND sj.job_id=s.id AND sj.user_id=$2
    JOIN user_jobs cj ON cj.org_id=p.org_id AND cj.job_id=c.id AND cj.user_id=$2
    JOIN user_units m ON m.org_id=p.org_id AND m.unit_id=p.unit_id AND m.user_id=$2 JOIN units u ON u.id=p.unit_id AND u.org_id=p.org_id
    WHERE p.org_id=$1 ORDER BY u.name,s.title,s.id LIMIT 41`,[actor.org_id,actor.id])).rows;
}
async function readRow(tx:Queryable,actor:Actor,id:string,lock=false){
  const row=(await tx.query(`SELECT ${projection} FROM shopping_receipts r WHERE r.org_id=$1 AND r.id=$2${lock?' FOR UPDATE OF r':''}`,[actor.org_id,id])).rows[0];
  requireCondition(row&&visible(actor,row),404,'Receipt not found under your current access.');return row;
}
async function command(tx:Queryable,actor:Actor,id:string,fingerprint:string,management=false){
  const previous=(await tx.query('SELECT fingerprint,result,receipt_id FROM shopping_receipt_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3',[actor.org_id,actor.id,id])).rows[0];
  if(!previous)return null;
  const row=await readRow(tx,actor,previous.receipt_id);
  requireCondition(!management||manage(actor,row),403,'Receipt management access is required.');
  requireCondition(previous.fingerprint===fingerprint,409,'This save identifier was already used for different receipt details.');
  await recheckClockSession(tx,actor,(actor as Actor&{proof:string}).proof);return previous.result;
}
async function record(tx:Queryable,actor:Actor,receiptId:string,version:number,action:string,commandId:string,fingerprint:string,note=''){
  await tx.query('INSERT INTO shopping_receipt_events(id,org_id,receipt_id,actor_id,actor_name,action,version,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),actor.org_id,receiptId,actor.id,actor.name,action,version,note]);
  const result={receiptId,version,action};
  await tx.query('INSERT INTO shopping_receipt_commands(org_id,actor_id,command_id,fingerprint,receipt_id,result) VALUES($1,$2,$3,$4,$5,$6)',[actor.org_id,actor.id,commandId,fingerprint,receiptId,JSON.stringify(result)]);
  await audit(tx,actor,'shopping.receipt_'+action,receiptId,{version});return result;
}
async function actorFor(tx:Queryable,supplied:Actor,proof:string,write=false){return Object.assign(await currentClockActor(tx,supplied,proof,write),{proof});}

export async function listShoppingReceipts(db:Database,supplied:Actor,proof:string,raw:unknown){
  const input=receiptListInput.parse(raw);
  return timeTransaction(db,async tx=>{
    const actor=await actorFor(tx,supplied,proof),meta=await context(tx,actor),review=canReport(actor);
    requireCondition(input.view!=='team'||review,403,'Password reporting access is required to review team receipts.');
    requireCondition(!input.userId||input.userId===actor.id||review,403,'You can view only your own receipts.');
    requireCondition(!input.unitId||orgWide(actor)||actor.unit_ids.includes(input.unitId),403,'This community is outside your access.');
    const start=input.start??DateTime.fromISO(meta.today).minus({days:30}).toISODate()!,end=input.end??meta.today;
    requireCondition(start<=end&&DateTime.fromISO(end).diff(DateTime.fromISO(start),'days').days<=366,400,'Choose a receipt range of up to 367 dates.');
    const args=[actor.org_id,actor.id,review,orgWide(actor),actor.unit_ids,input.view==='mine'?actor.id:input.userId??null,input.unitId??null,input.shiftId??null,start,end,input.status,input.offset];
    const where=`r.org_id=$1 AND (r.user_id=$2 OR ($3::boolean AND ($4::boolean OR r.unit_id=ANY($5::uuid[]))))
      AND ($6::uuid IS NULL OR r.user_id=$6) AND ($7::uuid IS NULL OR r.unit_id=$7)
      AND (($8::uuid IS NOT NULL AND r.shift_id=$8) OR ($8::uuid IS NULL AND r.purchased_on BETWEEN $9::date AND $10::date))
      AND ($11='all' OR r.status=$11)`;
    const rows=(await tx.query(`SELECT ${projection} FROM shopping_receipts r WHERE ${where} ORDER BY r.purchased_on DESC,r.uploaded_at DESC,r.id LIMIT 51 OFFSET $12`,args)).rows;
    const jobs=await eligible(tx,actor);
    const hasOwnReceipts=(await tx.query('SELECT EXISTS(SELECT 1 FROM shopping_receipts WHERE org_id=$1 AND user_id=$2) AS found',[actor.org_id,actor.id])).rows[0].found;
    const storage=canAdminister(actor)?(await tx.query(`SELECT coalesce((SELECT sum(photo_size+thumbnail_size)::text FROM shopping_receipts WHERE org_id=$1 AND status<>'deleted'),'0') AS used,
      coalesce((SELECT byte_limit::text FROM shopping_receipt_storage WHERE org_id=$1),'1073741824') AS capacity`,[actor.org_id])).rows[0]:null;
    const result={rows:rows.slice(0,receiptLimits.page).map(row=>dto(actor,row)),hasMore:rows.length>receiptLimits.page,hasOwnReceipts,...meta,
      eligibleJobs:jobs.map(j=>({id:j.id,title:j.title,unitId:j.unit_id,unitName:j.unit_name,cafeTitle:j.cafe_title})),canReview:review,canManage:manages(actor),
      ...(storage?{storage:{usedBytes:storage.used,limitBytes:storage.capacity}}:{})};
    JSON.stringify(result);await recheckClockSession(tx,actor,proof);return result;
  });
}
export async function getShoppingReceipt(db:Database,supplied:Actor,proof:string,id:string){
  id=z.uuid().parse(id).toLowerCase();return timeTransaction(db,async tx=>{
    const actor=await actorFor(tx,supplied,proof),row=await readRow(tx,actor,id);
    const events=(await tx.query(`SELECT actor_name,action,version,note,${preciseTimeSql('created_at')} AS created_at FROM shopping_receipt_events WHERE org_id=$1 AND receipt_id=$2 ORDER BY version`,[actor.org_id,id])).rows;
    const result={receipt:dto(actor,row),events};JSON.stringify(result);await recheckClockSession(tx,actor,proof);return result;
  });
}
export async function shoppingReceiptPhoto(db:Database,supplied:Actor,proof:string,id:string,thumbnail:boolean){
  id=z.uuid().parse(id).toLowerCase();return timeTransaction(db,async tx=>{
    const actor=await actorFor(tx,supplied,proof),row=await readRow(tx,actor,id);
    requireCondition(row.status!=='deleted',410,'This receipt photo was deleted.');
    const file=(await tx.query(`SELECT ${thumbnail?'thumbnail':'photo'} AS bytes,photo_hash FROM shopping_receipts WHERE org_id=$1 AND id=$2 FOR SHARE`,[actor.org_id,id])).rows[0];
    requireCondition(file?.bytes,410,'This receipt photo was deleted.');
    const bytes=Buffer.from(file.bytes);await recheckClockSession(tx,actor,proof);
    return {bytes,hash:receiptHash(bytes),filename:'shopping-receipt-'+id+(thumbnail?'-preview':'')+'.jpg'};
  });
}
export async function uploadShoppingReceipt(db:Database,supplied:Actor,proof:string,raw:unknown){
  const input=receiptUploadInput.parse(raw),source=receiptSource(input.imageBase64),sourceHash=receiptHash(source);
  const {imageBase64:_,...details}=input,fingerprint=digest(canonicalTimeJson({action:'upload',...details,sourceHash}));
  const replay=await timeTransaction(db,async tx=>{
    const actor=await actorFor(tx,supplied,proof),prior=await command(tx,actor,input.commandId,fingerprint);if(prior)return prior;
    requireCondition((await eligible(tx,actor)).some(job=>job.id===input.jobId),403,'A current café and Shopping assignment is required to add a receipt.');
    await recheckClockSession(tx,actor,proof);return null;
  });
  if(replay)return replay;
  const image=await normalizeReceiptImage(source);
  return timeTransaction(db,async tx=>{
    // Capacity comes before accounts; image decoding never holds database locks.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('shopping-storage:'||$1,0))",[supplied.org_id]);
    const actor=await actorFor(tx,supplied,proof,true),prior=await command(tx,actor,input.commandId,fingerprint);if(prior)return prior;
    const family=await shoppingJobFamily(tx,actor.org_id,input.jobId);
    await tx.query('SELECT id FROM jobs WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[actor.org_id,family]);
    const selected=(await eligible(tx,actor)).find(job=>job.id===input.jobId);
    requireCondition(selected,403,'Your café or Shopping assignment changed. Refresh the clock before adding a receipt.');
    const meta=await context(tx,actor);requireCondition(input.purchasedOn<=meta.today,400,'The purchase date cannot be in the future.');
    let shiftRevision:number|null=null;
    if(input.shiftId){
      const shift=(await tx.query(`SELECT s.revision FROM shifts s WHERE s.org_id=$1 AND s.id=$2 AND s.user_id=$3
        AND EXISTS(SELECT 1 FROM segments g JOIN jobs j ON j.id=g.job_id AND j.org_id=g.org_id WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision AND j.unit_id=$4) FOR SHARE OF s`,[actor.org_id,input.shiftId,actor.id,selected.unit_id])).rows[0];
      requireCondition(shift,400,'Attach this receipt only to one of your café-community time cards.');shiftRevision=shift.revision;
    }
    requireCondition(!(await tx.query("SELECT id FROM shopping_receipts WHERE org_id=$1 AND user_id=$2 AND source_hash=$3 AND status<>'deleted'",[actor.org_id,actor.id,sourceHash])).rows.length,409,'This photo is already saved. Check your receipts before uploading it again.');
    await tx.query('INSERT INTO shopping_receipt_storage(org_id) VALUES($1) ON CONFLICT DO NOTHING',[actor.org_id]);
    const capacity=(await tx.query(`SELECT byte_limit::text AS capacity,(SELECT coalesce(sum(photo_size+thumbnail_size),0)::text FROM shopping_receipts WHERE org_id=$1 AND status<>'deleted') AS used FROM shopping_receipt_storage WHERE org_id=$1 FOR SHARE`,[actor.org_id])).rows[0];
    requireCondition(BigInt(capacity.used)+BigInt(image.photo.length+image.thumbnail.length)<=BigInt(capacity.capacity),409,'Receipt storage is full. Export and delete older receipt photos to make room.');
    const id=randomUUID();
    await tx.query(`INSERT INTO shopping_receipts(id,org_id,user_id,job_id,unit_id,employee_name,job_title,unit_name,purchased_on,vendor,amount_minor,note,shift_id,shift_revision,source_hash,photo_hash,photo_size,thumbnail_size,width,height,photo,thumbnail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id,actor.org_id,actor.id,input.jobId,selected.unit_id,actor.name,selected.title,selected.unit_name,input.purchasedOn,input.vendor||null,receiptAmountMinor(input.total),input.note||null,input.shiftId??null,shiftRevision,sourceHash,image.photoHash,image.photo.length,image.thumbnail.length,image.width,image.height,image.photo,image.thumbnail]);
    const result=await record(tx,actor,id,1,'uploaded',input.commandId,fingerprint);await recheckClockSession(tx,actor,proof);return result;
  });
}
export async function changeShoppingReceipt(db:Database,supplied:Actor,proof:string,id:string,raw:unknown){
  id=z.uuid().parse(id).toLowerCase();const input=receiptStateInput.parse(raw),fingerprint=digest(canonicalTimeJson({action:'state',id,...input}));
  return timeTransaction(db,async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('shopping-storage:'||$1,0))",[supplied.org_id]);
    const actor=await actorFor(tx,supplied,proof,true),prior=await command(tx,actor,input.commandId,fingerprint,true);if(prior)return prior;
    const row=await readRow(tx,actor,id,true);requireCondition(manage(actor,row),403,'Password manager or administrator access to this community is required.');
    requireCondition(row.status!=='deleted',409,'This receipt photo was already deleted. It cannot be restored.');
    requireCondition(row.version===input.expectedVersion,409,'This receipt changed. Refresh it before continuing.');
    requireCondition(row.status!==input.status,400,'Choose a different receipt status.');
    const version=row.version+1;
    await tx.query(`UPDATE shopping_receipts SET status=$1,version=$2,updated_at=clock_timestamp(),
      photo=CASE WHEN $1='deleted' THEN NULL ELSE photo END,thumbnail=CASE WHEN $1='deleted' THEN NULL ELSE thumbnail END,
      vendor=CASE WHEN $1='deleted' THEN NULL ELSE vendor END,note=CASE WHEN $1='deleted' THEN NULL ELSE note END,amount_minor=CASE WHEN $1='deleted' THEN NULL ELSE amount_minor END WHERE org_id=$3 AND id=$4`,[input.status,version,actor.org_id,id]);
    const action=input.status==='active'?'restored':input.status;
    const result=await record(tx,actor,id,version,action,input.commandId,fingerprint,input.note);await recheckClockSession(tx,actor,proof);return result;
  });
}
export function installShoppingReceipts(app:Express,db:Database){
  const auth=(req:Request)=>({actor:(req as AppRequest).actor,proof:(req as AppRequest).sessionHash!});
  app.get('/api/shopping-receipts',async(req,res)=>{const {actor,proof}=auth(req);res.set('Cache-Control','private, no-store').json(await listShoppingReceipts(db,actor,proof,req.query));});
  let uploads=0;
  app.post('/api/shopping-receipts',async(req,res,next)=>{
    requireCondition(uploads<2,503,'Another receipt photo is saving. Please retry in a moment.');uploads++;
    let released=false;const release=()=>{if(!released){released=true;uploads--;}};res.once('finish',release);res.once('close',release);
    await limitAuth(db,'shopping-upload:'+auth(req).actor.org_id+':'+auth(req).actor.id,30);next();},express.json({limit:'12mb'}),async(req,res)=>{const {actor,proof}=auth(req);res.set('Cache-Control','private, no-store').status(201).json(await uploadShoppingReceipt(db,actor,proof,req.body));});
  app.get('/api/shopping-receipts/:id',async(req,res)=>{const {actor,proof}=auth(req);res.set('Cache-Control','private, no-store').json(await getShoppingReceipt(db,actor,proof,req.params.id));});
  app.get('/api/shopping-receipts/:id/photo',async(req,res)=>{const {actor,proof}=auth(req),query=z.object({size:z.enum(['full','thumb']).default('full'),download:z.literal('1').optional()}).strict().parse(req.query),file=await shoppingReceiptPhoto(db,actor,proof,req.params.id,query.size==='thumb');res.set({'Cache-Control':'private, no-store','Content-Type':'image/jpeg','X-Content-SHA256':file.hash,'Content-Disposition':`${query.download?'attachment':'inline'}; filename="${file.filename}"`}).send(file.bytes);});
  app.post('/api/shopping-receipts/:id/state',async(req,res)=>{const {actor,proof}=auth(req);res.set('Cache-Control','private, no-store').json(await changeShoppingReceipt(db,actor,proof,req.params.id,req.body));});
}
