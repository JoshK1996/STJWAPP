import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase,migrate,type Database,type Queryable,type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest,issueSetup,type Actor } from '../server/security';
import { editOwnRequest } from '../server/request-editing';
import { reviewAuthenticatedRequest } from '../server/workforce';

const origin='http://localhost:3196';
type Auth={cookie:string;csrf:string;actor:Actor;proof:string};
let db:Database,owner:Auth,unit:string,otherUnit:string;
const app=(database=db)=>createApp(database,{origin,production:false,demo:false,staffDomain:'stjw.org'});
async function signIn(email:string,password:string):Promise<Auth>{
 const login=await request(app()).post('/api/auth/login').set('Origin',origin).send({mode:'password',email,credential:password});assert.equal(login.status,200,login.body.error);
 const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app()).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
 return {cookie,csrf:me.body.actor.csrf,actor:me.body.actor,proof:digest(cookie.slice(cookie.indexOf('=')+1))};
}
function send(auth:Auth,path:string,body?:unknown,method='post',database=db){const client=request(app(database));return body===undefined?client.get('/api'+path).set('Cookie',auth.cookie):(client as any)[method]('/api'+path).set('Cookie',auth.cookie).set('Origin',origin).set('X-CSRF-Token',auth.csrf).send(body);}
async function ok(auth:Auth,path:string,body:unknown,method='post'){const r=await send(auth,path,body,method);assert.ok(r.status<300,r.body.error);return r.body;}
async function person(role='employee',units=[unit],jobs:string[]=[]){const email=randomUUID()+'@stjw.org',created=await ok(owner,'/staff',{name:'Synthetic editing employee',email,role,unitIds:units,jobIds:jobs}),password='Synthetic-'+randomUUID();const setup=await request(app()).post('/api/auth/setup').set('Origin',origin).send({token:new URL(created.setupUrl).hash.slice('#setup='.length),password});assert.equal(setup.status,200,setup.body.error);return {auth:await signIn(email,password),email,id:created.id,password};}
async function job(title='Synthetic editable job'){const result=await ok(owner,'/jobs',{title,unitId:unit});return (await send(owner,'/jobs')).body.rows.find((row:any)=>row.id===result.id);}
const edit=(j:any,changes:Record<string,unknown>={})=>({title:j.title,description:j.description,unitId:j.unit_id,active:j.active,expectedVersion:j.version,reason:'Reviewed synthetic correction',...changes});
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'job.editor.owner@example.test'});
 const account=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0],password='Synthetic-'+randomUUID();const token=await db.transaction(tx=>issueSetup(tx,{id:account.id,org_id:account.org_id}));
 assert.equal((await request(app()).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);owner=await signIn(account.email,password);
 const units=(await db.query('SELECT id FROM units ORDER BY id')).rows;unit=units[0].id;otherUnit=units[1].id;
});
after(async()=>{await db?.close();});

test('employees edit and withdraw only their own pending request with a current version',async()=>{
 const worker=await person(),someoneElse=await person(),body={kind:'pto',unitId:unit,startsOn:'2026-10-01',endsOn:'2026-10-02',note:'Synthetic request for review'};
 const created=await ok(worker.auth,'/requests',body),path='/requests/'+created.id;
 assert.equal((await send(someoneElse.auth,path,{...body,expectedVersion:1},'patch')).status,403);
 assert.equal((await send(owner,path,{...body,expectedVersion:1},'patch')).status,403);
 assert.equal((await send(worker.auth,path,{...body,unitId:otherUnit,expectedVersion:1},'patch')).status,403);
 const edited=await ok(worker.auth,path,{...body,note:'Updated synthetic dates and details',endsOn:'2026-10-03',expectedVersion:1},'patch');assert.equal(edited.version,2);
 assert.equal((await send(worker.auth,path,{...body,expectedVersion:1},'patch')).status,409);
 assert.equal((await send(worker.auth,path,{...body,startsOn:'2026-10-05',expectedVersion:2},'patch')).status,400);
 await ok(worker.auth,path+'/withdraw',{expectedVersion:2,reason:'Plans changed before review'});
 assert.equal((await send(worker.auth,path,{...body,expectedVersion:3},'patch')).status,409);
 assert.equal((await send(owner,path+'/review',{status:'approved',note:'Cannot approve a withdrawn request'})).status,409);
 const stored=(await db.query('SELECT * FROM requests WHERE id=$1',[created.id])).rows[0];assert.equal(stored.status,'cancelled');assert.equal(stored.version,3);
 const audits=(await db.query("SELECT action,detail FROM audit_events WHERE target_id=$1 AND action IN('request.updated','request.withdrawn') ORDER BY created_at",[created.id])).rows;assert.equal(audits.length,2);assert.equal(audits[0].detail.before.note,body.note);
});
test('reviewed decisions remain immutable and late authorization failures roll edits back',async()=>{
 const worker=await person(),body={kind:'other',unitId:unit,startsOn:'2026-11-01',endsOn:'2026-11-01',note:'Synthetic operational request'},created=await ok(worker.auth,'/requests',body);
 await ok(owner,'/requests/'+created.id+'/review',{status:'approved',note:'Reviewed synthetic decision'});
 assert.equal((await send(worker.auth,'/requests/'+created.id,{...body,expectedVersion:2},'patch')).status,409);
 assert.equal((await send(worker.auth,'/requests/'+created.id+'/withdraw',{expectedVersion:2,reason:'Cannot withdraw a reviewed decision'})).status,409);
 const pending=await ok(worker.auth,'/requests',body),before=(await db.query('SELECT * FROM requests WHERE id=$1',[pending.id])).rows[0];
 await assert.rejects(editOwnRequest(db,worker.auth.actor,owner.proof,pending.id,{...body,expectedVersion:1}), (e:any)=>e.status===401);
 const revoked:Database={...db,transaction:async<T>(fn:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>fn({query:async<R extends Row=Row>(sql:string,params?:any[])=>{const result=await tx.query<R>(sql,params);if(sql.startsWith('INSERT INTO audit_events')&&params?.[3]==='request.updated')await tx.query(`UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1`,[worker.auth.proof]);return result;}}))};
 await assert.rejects(editOwnRequest(revoked,worker.auth.actor,worker.auth.proof,pending.id,{...body,note:'This edit must roll back',expectedVersion:1}),(e:any)=>e.status===401);
 assert.deepEqual((await db.query('SELECT * FROM requests WHERE id=$1',[pending.id])).rows[0],before);
});

test('a reviewer must acknowledge the current edited request version',async()=>{
 const worker=await person(),body={kind:'pto',unitId:unit,startsOn:'2026-12-01',endsOn:'2026-12-01',note:'Original request for review'},created=await ok(worker.auth,'/requests',body);
 await ok(worker.auth,'/requests/'+created.id,{...body,endsOn:'2026-12-03',note:'Changed dates requiring fresh review',expectedVersion:1},'patch');
 const review={status:'approved',note:'Reviewed synthetic request'};
 assert.equal((await send(owner,'/requests/'+created.id+'/review',{...review,expectedVersion:1})).status,409);
 assert.equal((await send(owner,'/requests/'+created.id+'/review',review)).status,409);
 await ok(owner,'/requests/'+created.id+'/review',{...review,expectedVersion:2});
 const row=(await db.query('SELECT status,version FROM requests WHERE id=$1',[created.id])).rows[0];assert.equal(row.status,'approved');assert.equal(row.version,3);
});

test('HTTP review rejects a session revoked after middleware before the review transaction',async()=>{
 const worker=await person(),reviewer=await person('manager'),body={kind:'pto',unitId:unit,startsOn:'2026-12-10',endsOn:'2026-12-10',note:'Synthetic request requiring current proof'},created=await ok(worker.auth,'/requests',body);
 const before=(await db.query('SELECT * FROM requests WHERE id=$1',[created.id])).rows[0];
 await assert.rejects(reviewAuthenticatedRequest(db,reviewer.auth.actor,undefined,created.id,'approved','Synthetic reviewed request',1),(error:any)=>error.status===401);
 await assert.rejects(reviewAuthenticatedRequest(db,reviewer.auth.actor,worker.auth.proof,created.id,'approved','Synthetic reviewed request',1),(error:any)=>error.status===401);
 const revoked:Database={...db,transaction:async<T>(fn:(tx:Queryable)=>Promise<T>)=>{
   await db.query('DELETE FROM sessions WHERE token_hash=$1',[reviewer.auth.proof]);
   return db.transaction(fn);
 }};
 const response=await send(reviewer.auth,'/requests/'+created.id+'/review',{status:'approved',note:'This decision must not be recorded',expectedVersion:1},'post',revoked);
 assert.equal(response.status,401,response.body.error);
 assert.equal((await db.query('SELECT token_hash FROM sessions WHERE token_hash=$1',[reviewer.auth.proof])).rows.length,0);
 assert.deepEqual((await db.query('SELECT * FROM requests WHERE id=$1',[created.id])).rows[0],before);
 assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='request.approved'",[created.id])).rows.length,0);
});

test('late review session failure rolls back the decision, version and audit together',async()=>{
 const worker=await person(),reviewer=await person('manager'),created=await ok(worker.auth,'/requests',{kind:'other',unitId:unit,startsOn:'2026-12-11',endsOn:'2026-12-11',note:'Synthetic late session check'});
 const before=(await db.query('SELECT * FROM requests WHERE id=$1',[created.id])).rows[0];
 const expired:Database={...db,transaction:async<T>(fn:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>fn({query:async<R extends Row=Row>(sql:string,params?:any[])=>{
   const result=await tx.query<R>(sql,params);
   if(sql.startsWith('INSERT INTO audit_events')&&params?.[3]==='request.approved')await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",[reviewer.auth.proof]);
   return result;
 }}))};
 const response=await send(reviewer.auth,'/requests/'+created.id+'/review',{status:'approved',note:'This late decision must roll back',expectedVersion:1},'post',expired);
 assert.equal(response.status,401,response.body.error);
 assert.deepEqual((await db.query('SELECT * FROM requests WHERE id=$1',[created.id])).rows[0],before);
 assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='request.approved'",[created.id])).rows.length,0);
});
