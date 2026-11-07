import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { changeShoppingReceipt, getShoppingReceipt, listShoppingReceipts, shoppingReceiptPhoto, uploadShoppingReceipt } from '../server/shopping-receipts';
import { getStaffAssignments, saveStaffAssignments } from '../server/staff-assignments';
import { createStaff } from '../server/workforce';
import { updateManagedJob, updateStaffAccount } from '../server/staff-authority';
import { staffRecordRevision } from '../server/staff-revision';
import { previewStaffImport, applyStaffImport, getStaffImport } from '../server/imports';
import { normalizeReceiptImage, receiptSource } from '../server/receipt-image';
import { receiptAmountMinor, receiptAmountLabel } from '../shared/shopping-receipts';

type Person={actor:Actor;hash:string;cookie:string;csrf:string;password:string};
const origin='http://localhost:3297',status=(code:number)=>(e:any)=>e.status===code;
let db:Database,app:ReturnType<typeof createApp>,owner:Person,worker:Person,manager:Person,outside:Person,finance:Person,ordinary:Person,pin:Person;
let cafe:string,shopping:string,unit:string,otherUnit:string,today:string,photo:Buffer;
async function authenticate(actor:Actor):Promise<Person>{
  await db.query('DELETE FROM auth_limits');const password='Synthetic-'+randomUUID(),token=await db.transaction(tx=>issueSetup(tx,actor));
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  return {actor:me.body.actor,hash:digest(cookie.slice(cookie.indexOf('=')+1)),cookie,csrf:me.body.actor.csrf,password};
}
async function person(role:Actor['role'],community=unit,jobs:string[]=[]){
  const id=randomUUID(),email=id+'@stjw.org',name='Synthetic receipt '+role;
  await db.transaction(async tx=>{
    await tx.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[id,owner.actor.org_id,email,name,role]);
    await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[owner.actor.org_id,id,community]);
    for(const job of jobs)await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[owner.actor.org_id,id,job]);
  });
  return authenticate({id,org_id:owner.actor.org_id,email,name,role,mode:'password',unit_ids:[community]});
}
function input(extra:Record<string,unknown>={}){return {commandId:randomUUID(),jobId:shopping,purchasedOn:today,imageBase64:photo.toString('base64'),vendor:'Synthetic market',total:'12.34',note:'Café supplies',...extra};}
const upload=(who:Person,body:unknown,database=db)=>uploadShoppingReceipt(database,who.actor,who.hash,body);
const list=(who:Person,query:unknown={},database=db)=>listShoppingReceipts(database,who.actor,who.hash,query);
const change=(who:Person,id:string,body:unknown,database=db)=>changeShoppingReceipt(database,who.actor,who.hash,id,body);
const body=(version:number,status:string)=>({commandId:randomUUID(),expectedVersion:version,status});
function probe(effect:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{return {...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Row=Row>(sql:string,params:any[]=[])=>{const result=await tx.query<T>(sql,params);await effect(tx,sql,params);return result;}}))};}
async function uniquePhoto(seed:number){return sharp({create:{width:600,height:900,channels:3,background:{r:(seed%13)*17,g:220,b:240}}}).jpeg({quality:100}).toBuffer();}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'receipts.owner@example.test'});
  app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});
  const initial=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner=await authenticate({id:initial.id,org_id:initial.org_id,name:initial.name,email:initial.email,role:initial.role,mode:'password',unit_ids:[]});
  const jobs=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id')).rows;cafe=jobs[0].id;unit=jobs[0].unit_id;otherUnit=jobs.find(j=>j.unit_id!==unit)!.unit_id;
  shopping=randomUUID();
  const configured=(await db.query('SELECT provision_cafe_shopping($1,$2,$3,$4) AS result',[owner.actor.org_id,cafe,shopping,'Synthetic owner-authorized café receipt setup'])).rows[0].result;
  assert.equal(configured.created,true);assert.equal((await db.query('SELECT provision_cafe_shopping($1,$2,$3,$4) AS result',[owner.actor.org_id,cafe,randomUUID(),'Synthetic exact setup retry'])).rows[0].result.created,false);
  worker=await person('employee',unit,[cafe,shopping]);manager=await person('manager');outside=await person('manager',otherUnit);finance=await person('finance',otherUnit);ordinary=await person('employee');
  assert.equal((await request(app).post('/api/auth/pin').set('Origin',origin).set('Cookie',worker.cookie).set('X-CSRF-Token',worker.csrf).send({password:worker.password,pin:'718263'})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({credential:'718263',mode:'pin'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);
  pin={...worker,actor:me.body.actor,cookie,hash:digest(cookie.slice(cookie.indexOf('=')+1)),csrf:me.body.actor.csrf};
  today=(await db.query('SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text AS date FROM organizations WHERE id=$1',[owner.actor.org_id])).rows[0].date;
  photo=await uniquePhoto(101);
});
after(async()=>db?.close());

test('Shopping eligibility is café-derived for password and PIN; off-clock uploads are private and exact retries are atomic',async()=>{
  assert.ok((await list(worker)).eligibleJobs.some(j=>j.id===shopping));assert.ok((await list(pin)).eligibleJobs.some(j=>j.id===shopping));assert.equal((await list(ordinary)).eligibleJobs.length,0);
  const command=input(),saved=await upload(worker,command);assert.deepEqual(await upload(worker,command),saved);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM shopping_receipt_events WHERE receipt_id=$1',[saved.receiptId])).rows[0].n,1);
  const detail=await getShoppingReceipt(db,pin.actor,pin.hash,saved.receiptId);assert.equal(detail.receipt.amountMinor,'1234');assert.equal(detail.receipt.canManage,false);assert.equal(detail.receipt.shiftId,null);
  assert.equal((await shoppingReceiptPhoto(db,pin.actor,pin.hash,saved.receiptId,false)).bytes[0],255);
  await assert.rejects(upload(ordinary,input()),status(403));await assert.rejects(upload(pin,{...command,commandId:randomUUID()}),status(409));
  await assert.rejects(upload(worker,{...command,total:'12.35'}),status(409));
  await assert.rejects(upload(worker,{...command,userId:owner.actor.id}),{name:'ZodError'});
});

test('team reviews respect current unit scope and PIN stays self-only even with a privileged role',async()=>{
  const saved=await upload(pin,input({imageBase64:(await uniquePhoto(102)).toString('base64')}));
  assert.ok((await list(manager,{view:'team'})).rows.some(r=>r.id===saved.receiptId));assert.ok((await list(finance,{view:'team'})).rows.some(r=>r.id===saved.receiptId));
  assert.equal((await list(outside,{view:'team'})).rows.length,0);await assert.rejects(getShoppingReceipt(db,outside.actor,outside.hash,saved.receiptId),status(404));
  await assert.rejects(list(pin,{view:'team'}),status(403));await assert.rejects(list(pin,{userId:owner.actor.id}),status(403));
  await assert.rejects(change(pin,saved.receiptId,body(1,'archived')),status(403));await assert.rejects(change(finance,saved.receiptId,body(1,'archived')),status(403));
  const fake={...pin.actor,role:'developer' as const,unit_ids:[otherUnit]};await assert.rejects(listShoppingReceipts(db,fake,pin.hash,{view:'team'}),status(403));
  const state=body(1,'archived');assert.deepEqual(await change(manager,saved.receiptId,state),await change(manager,saved.receiptId,state));
  assert.equal((await list(worker,{status:'archived'})).rows.find(r=>r.id===saved.receiptId)?.status,'archived');
  await db.query('DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2',[manager.actor.id,unit]);
  try{await assert.rejects(change(manager,saved.receiptId,state),status(404));}finally{await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[owner.actor.org_id,manager.actor.id,unit]);}
});

test('archive retains storage; restore is versioned; deletion erases photo/details and retains immutable tombstone/history',async()=>{
  const saved=await upload(worker,input({imageBase64:(await uniquePhoto(103)).toString('base64')})),id=saved.receiptId;
  await change(owner,id,body(1,'archived'));await assert.rejects(change(owner,id,body(1,'active')),status(409));
  assert.ok((await shoppingReceiptPhoto(db,worker.actor,worker.hash,id,true)).bytes.length>0);
  await change(owner,id,body(2,'active'));const deletion=body(3,'deleted');assert.deepEqual(await change(owner,id,deletion),await change(owner,id,deletion));
  const row=(await db.query('SELECT photo,thumbnail,vendor,note,amount_minor,status FROM shopping_receipts WHERE id=$1',[id])).rows[0];assert.deepEqual(row,{photo:null,thumbnail:null,vendor:null,note:null,amount_minor:null,status:'deleted'});
  assert.equal((await getShoppingReceipt(db,owner.actor,owner.hash,id)).events.length,4);await assert.rejects(shoppingReceiptPhoto(db,owner.actor,owner.hash,id,false),status(410));
  await assert.rejects(change(owner,id,body(4,'active')),status(409));await assert.rejects(db.query('DELETE FROM shopping_receipts WHERE id=$1',[id]),/tombstone/);await assert.rejects(db.query('UPDATE shopping_receipt_events SET note=$1 WHERE receipt_id=$2',['altered',id]),/immutable|append|audit/i);
  const command=(await db.query('SELECT result FROM shopping_receipt_commands WHERE receipt_id=$1 LIMIT 1',[id])).rows[0].result;assert.deepEqual(Object.keys(command).sort(),['action','receiptId','version']);
});

test('capacity accounts for archived photos and deletion frees space without changing time or pay data',async()=>{
  const used=async()=>Number((await db.query("SELECT coalesce(sum(photo_size+thumbnail_size),0)::text AS n FROM shopping_receipts WHERE org_id=$1 AND status<>'deleted'",[owner.actor.org_id])).rows[0].n);
  const current=await used();await db.query('UPDATE shopping_receipt_storage SET byte_limit=$1 WHERE org_id=$2',[current+1,owner.actor.org_id]);
  try{await assert.rejects(upload(worker,input({imageBase64:(await uniquePhoto(104)).toString('base64')})),status(409));}
  finally{await db.query('UPDATE shopping_receipt_storage SET byte_limit=1073741824 WHERE org_id=$1',[owner.actor.org_id]);}
  assert.equal(await used(),current);
});

test('current session proof gates reads and rolls back a write when revoked before publication',async()=>{
  const fresh=await person('employee',unit,[cafe,shopping]),command=input({imageBase64:(await uniquePhoto(105)).toString('base64')});let revoked=false;
  const database=probe(async(tx,sql)=>{if(!revoked&&sql.startsWith('INSERT INTO shopping_receipt_commands')){revoked=true;await tx.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1',[fresh.hash]);}});
  await assert.rejects(upload(fresh,command,database),status(401));assert.equal((await db.query('SELECT count(*)::int AS n FROM shopping_receipt_commands WHERE command_id=$1',[command.commandId])).rows[0].n,0);
  await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[fresh.hash]);
  await assert.rejects(list(fresh),status(401));await assert.rejects(upload(fresh,command),status(401));
});

test('assignment create/add/remove paths materialize Shopping and refuse unrelated Shopping or café removal while in use',async()=>{
  const id=await db.transaction(tx=>createStaff(tx,owner.actor,{name:'Synthetic café joiner',email:randomUUID()+'@stjw.org',role:'employee',unitIds:[unit],jobIds:[cafe]},'stjw.org'));
  const ids=async()=>new Set((await db.query('SELECT job_id FROM user_jobs WHERE user_id=$1',[id])).rows.map(j=>j.job_id));assert.deepEqual(await ids(),new Set([cafe,shopping]));
  const current=await getStaffAssignments(db,owner.actor,owner.hash,id);
  assert.equal(current.jobs.find(j=>j.id===shopping)?.requiresJobId,cafe);
  await saveStaffAssignments(db,owner.actor,owner.hash,id,{unitIds:[unit],jobIds:[shopping],expectedRevision:current.revision});assert.deepEqual(await ids(),new Set());
  const removed=await getStaffAssignments(db,owner.actor,owner.hash,id);await assert.rejects(saveStaffAssignments(db,owner.actor,owner.hash,id,{unitIds:[unit],jobIds:[shopping],expectedRevision:removed.revision}),status(400));
  await saveStaffAssignments(db,owner.actor,owner.hash,id,{unitIds:[unit],jobIds:[cafe],expectedRevision:removed.revision});assert.deepEqual(await ids(),new Set([cafe,shopping]));
  await assert.rejects(db.query('DELETE FROM user_jobs WHERE user_id=$1 AND job_id=$2',[id,cafe]),/Shopping assignments/);
  const job=(await db.query('SELECT * FROM jobs WHERE id=$1',[cafe])).rows[0];await assert.rejects(updateManagedJob(db,owner.actor,owner.hash,cafe,{unitId:unit,title:job.title,description:job.description,active:false,expectedVersion:job.version,reason:'Synthetic archive check'}),status(409));
});

test('archived Shopping remains derived for new café staff and restoring the job restores their eligibility',async()=>{
  const job=(await db.query('SELECT * FROM jobs WHERE id=$1',[shopping])).rows[0];
  await updateManagedJob(db,owner.actor,owner.hash,shopping,{unitId:unit,title:job.title,description:job.description,active:false,expectedVersion:job.version,reason:'Synthetic archive test'});
  try{
    assert.equal((await list(worker)).eligibleJobs.length,0);
    const id=await db.transaction(tx=>createStaff(tx,owner.actor,{name:'Synthetic archived joiner',email:randomUUID()+'@stjw.org',role:'employee',unitIds:[unit],jobIds:[cafe]},'stjw.org'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM user_jobs WHERE user_id=$1 AND job_id=$2',[id,shopping])).rows[0].n,1);
  }finally{const current=(await db.query('SELECT version FROM jobs WHERE id=$1',[shopping])).rows[0];await updateManagedJob(db,owner.actor,owner.hash,shopping,{unitId:unit,title:job.title,description:job.description,active:true,expectedVersion:current.version,reason:'Synthetic restore test'});}
  assert.equal((await list(worker)).eligibleJobs.length,1);
});

test('HTTP password/PIN upload, private download, parser/CSRF limits and protected management routes',async()=>{
  const saved=await request(app).post('/api/shopping-receipts').set('Origin',origin).set('Cookie',pin.cookie).set('X-CSRF-Token',pin.csrf).send(input({imageBase64:(await uniquePhoto(106)).toString('base64')}));assert.equal(saved.status,201,JSON.stringify(saved.body));
  const id=saved.body.receiptId,response=await request(app).get(`/api/shopping-receipts/${id}/photo?download=1`).set('Cookie',pin.cookie);
  assert.equal(response.status,200);assert.match(response.headers['cache-control'],/private, no-store/);assert.match(response.headers['content-type'],/image\/jpeg/);assert.match(response.headers['content-disposition'],/attachment; filename="shopping-receipt-/);assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert.equal((await request(app).get(`/api/shopping-receipts/${id}/photo`)).status,401);
  assert.equal((await request(app).get(`/api/shopping-receipts/${id}/photo`).set('Cookie',ordinary.cookie)).status,404);
  assert.equal((await request(app).get('/api/shopping-receipts?view=team').set('Cookie',pin.cookie)).status,403);
  assert.equal((await request(app).post(`/api/shopping-receipts/${id}/state`).set('Origin',origin).set('Cookie',pin.cookie).set('X-CSRF-Token',pin.csrf).send(body(1,'archived'))).status,403);
  assert.equal((await request(app).post('/api/shopping-receipts').set('Origin',origin).set('Cookie',worker.cookie).send(input())).status,403);
  assert.equal((await request(app).post('/api/shopping-receipts').set('Origin','https://other.example').set('Cookie',worker.cookie).set('X-CSRF-Token',worker.csrf).send(input())).status,403);
  assert.equal((await request(app).post('/api/shopping-receipts').set('Origin',origin).send({imageBase64:'x'.repeat(700000)})).status,401);
  assert.equal((await request(app).post('/api/clock').set('Origin',origin).set('Cookie',worker.cookie).set('X-CSRF-Token',worker.csrf).send({note:'x'.repeat(600000)})).status,413);
});

test('image normalization bounds dimensions, removes EXIF/location, and rejects non-photo/broken input',async()=>{
  const original=await sharp({create:{width:3200,height:4200,channels:3,background:'white'}}).withMetadata({exif:{IFD0:{Artist:'Private synthetic identity'},IFD3:{GPSLatitudeRef:'N',GPSLatitude:'40/1 1/1 1/1'}}}).jpeg().toBuffer();
  const image=await normalizeReceiptImage(original),meta=await sharp(image.photo).metadata();assert.ok(image.width<=2400&&image.height<=4000);assert.equal(meta.exif,undefined);assert.equal(meta.xmp,undefined);assert.ok(image.thumbnail.length<512*1024);
  assert.throws(()=>receiptSource(Buffer.from('<svg/>').toString('base64')),status(400));await assert.rejects(normalizeReceiptImage(Buffer.from([255,216,255,1,2,3])),status(400));
  assert.throws(()=>receiptSource('abc'),status(400));
});

test('receipt amounts remain exact, optional, and date/shift/foreign identity inputs are validated',async()=>{
  assert.equal(receiptAmountMinor('999999999.99'),'99999999999');assert.equal(receiptAmountMinor('0.1'),'10');assert.equal(receiptAmountMinor(''),null);assert.equal(receiptAmountLabel('1234'),'$12.34');
  await assert.rejects(upload(worker,input({total:'1.234'})),{name:'ZodError'});await assert.rejects(upload(worker,input({purchasedOn:'2099-01-01'})),status(400));await assert.rejects(upload(worker,input({purchasedOn:'2026-02-30'})),{name:'ZodError'});
  await assert.rejects(upload(worker,input({shiftId:randomUUID()})),status(400));await assert.rejects(upload(worker,input({jobId:randomUUID()})),status(403));
  await assert.rejects(list(owner,{start:'2020-01-01',end:today}),status(400));
  const foreign={...worker.actor,org_id:randomUUID()};await assert.rejects(listShoppingReceipts(db,foreign,worker.hash,{}),status(403));
});

test('receipt regression: café import retains exact source rows while creating derived Shopping assignments',async()=>{
  const csv=`name,email,role,unitIds,jobIds\nSynthetic imported shopper,${randomUUID()}@stjw.org,employee,${unit},${cafe}\n`;
  const preview=await previewStaffImport(db,owner.actor,csv,'stjw.org',owner.hash);assert.deepEqual(preview.rows[0].jobIds,[cafe]);
  const receipt=await applyStaffImport(db,owner.actor,preview.id,preview.sourceHash,'stjw.org',owner.hash),id=receipt.accounts[0].userId;
  assert.deepEqual(new Set((await db.query('SELECT job_id FROM user_jobs WHERE user_id=$1',[id])).rows.map(j=>j.job_id)),new Set([cafe,shopping]));
  assert.deepEqual((await getStaffImport(db,owner.actor,owner.hash,preview.id)).rows[0].jobIds,[cafe]);
  assert.deepEqual(await applyStaffImport(db,owner.actor,preview.id,preview.sourceHash,'stjw.org',owner.hash),receipt);
});

test('receipt regression: assignment removal blocks new photos but retains own history and exact upload confirmation',async()=>{
  const fresh=await person('employee',unit,[cafe,shopping]),command=input({imageBase64:(await uniquePhoto(107)).toString('base64')}),saved=await upload(fresh,command);
  const current=await getStaffAssignments(db,owner.actor,owner.hash,fresh.actor.id);await saveStaffAssignments(db,owner.actor,owner.hash,fresh.actor.id,{unitIds:[unit],jobIds:[],expectedRevision:current.revision});
  assert.equal((await list(fresh)).eligibleJobs.length,0);assert.equal((await list(fresh,{start:'2020-01-01',end:'2020-01-02'})).hasOwnReceipts,true);assert.ok((await list(fresh)).rows.some(r=>r.id===saved.receiptId));assert.deepEqual(await upload(fresh,command),saved);
  await assert.rejects(upload(fresh,input()),status(403));assert.ok((await shoppingReceiptPhoto(db,fresh.actor,fresh.hash,saved.receiptId,false)).bytes.length>0);
});

test('receipt regression: a privileged PIN stays self-only with current database role, not a supplied-role assumption',async()=>{
  await db.query("UPDATE users SET role='developer' WHERE id=$1",[worker.actor.id]);
  try{assert.equal((await list(pin)).canReview,false);assert.equal((await list(pin)).canManage,false);await assert.rejects(list(pin,{view:'team'}),status(403));}
  finally{await db.query("UPDATE users SET role='employee' WHERE id=$1",[worker.actor.id]);}
});

test('receipt regression: competing lifecycle saves cannot overwrite the same receipt version',async()=>{
  const saved=await upload(worker,input({imageBase64:(await uniquePhoto(108)).toString('base64')}));
  const results=await Promise.allSettled([change(owner,saved.receiptId,body(1,'archived')),change(manager,saved.receiptId,body(1,'deleted'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  assert.equal((await getShoppingReceipt(db,owner.actor,owner.hash,saved.receiptId)).events.length,2);
});

test('receipt regression: Shopping is clockable, own time-card links capture revision, and active Shopping locks its café grant',async()=>{
  const fresh=await person('employee',unit,[cafe,shopping]);
  const clock=await request(app).post('/api/clock').set('Origin',origin).set('Cookie',fresh.cookie).set('X-CSRF-Token',fresh.csrf).send({action:'clock_in',jobId:shopping,commandId:randomUUID()});assert.equal(clock.status,200,JSON.stringify(clock.body));
  const shiftId=clock.body.shift.id,saved=await upload(fresh,input({shiftId,imageBase64:(await uniquePhoto(109)).toString('base64')}));
  const receipt=(await getShoppingReceipt(db,fresh.actor,fresh.hash,saved.receiptId)).receipt;assert.equal(receipt.shiftId,shiftId);assert.equal(receipt.shiftRevision,1);
  const current=await getStaffAssignments(db,owner.actor,owner.hash,fresh.actor.id);assert.ok(current.lockedJobIds.includes(cafe));assert.ok(current.lockedJobIds.includes(shopping));
  await assert.rejects(saveStaffAssignments(db,owner.actor,owner.hash,fresh.actor.id,{unitIds:[unit],jobIds:[],expectedRevision:current.revision}),status(409));
  await assert.rejects(upload(worker,input({shiftId})),status(400));
  assert.equal((await request(app).post('/api/clock').set('Origin',origin).set('Cookie',fresh.cookie).set('X-CSRF-Token',fresh.csrf).send({action:'clock_out',commandId:randomUUID()})).status,200);
  assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[shiftId])).rows[0].revision,1);
});

test('receipt regression: full account edits derive Shopping and preserve source authority on both new and removed grants',async()=>{
  const fresh=await person('employee');
  async function edit(jobs:string[]){
    const row=(await db.query('SELECT id,name,email,role,active FROM users WHERE id=$1',[fresh.actor.id])).rows[0];
    row.unit_ids=[unit];row.job_ids=(await db.query('SELECT job_id FROM user_jobs WHERE user_id=$1',[fresh.actor.id])).rows.map(j=>j.job_id);
    await updateStaffAccount(db,owner.actor,owner.hash,fresh.actor.id,{name:row.name,email:row.email,role:row.role,active:row.active,unitIds:row.unit_ids,jobIds:jobs,expectedRevision:staffRecordRevision(owner.actor.org_id,row as any)},'stjw.org');
  }
  await edit([cafe]);assert.deepEqual(new Set((await db.query('SELECT job_id FROM user_jobs WHERE user_id=$1',[fresh.actor.id])).rows.map(j=>j.job_id)),new Set([cafe,shopping]));
  await edit([shopping]);assert.equal((await db.query('SELECT count(*)::int AS n FROM user_jobs WHERE user_id=$1',[fresh.actor.id])).rows[0].n,0);
});

test('receipt regression: large authenticated receipt JSON uses the dedicated parser while invalid/multi-format sources are denied',async()=>{
  const response=await request(app).post('/api/shopping-receipts').set('Origin',origin).set('Cookie',worker.cookie).set('X-CSRF-Token',worker.csrf).send(input({imageBase64:Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(600000)]).toString('base64')}));
  assert.equal(response.status,400);assert.match(response.body.error,/could not be read/);
  await assert.rejects(upload(worker,input({imageBase64:Buffer.alloc(8*1024*1024+1).toString('base64')})),status(413));
});
