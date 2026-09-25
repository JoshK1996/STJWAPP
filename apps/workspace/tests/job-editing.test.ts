import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase,migrate,type Database,type Queryable,type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest,issueSetup,type Actor } from '../server/security';
import { updateManagedJob } from '../server/staff-authority';

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

test('jobs have editable title/description, stable identity, readable audit and stale-write rejection',async()=>{
 const j=await job(),result=await ok(owner,'/jobs/'+j.id,edit(j,{title:'Reviewed program assistant',description:'Choose for after-school supervision.'}),'patch');
 assert.equal(result.job.id,j.id);assert.equal(result.job.version,2);assert.equal(result.job.title,'Reviewed program assistant');
 assert.equal((await send(owner,'/jobs/'+j.id,edit(j,{title:'Stale edit'}),'patch')).status,409);
 const history=await send(owner,'/jobs/'+j.id+'/history');assert.equal(history.status,200);assert.equal(history.body.rows.length,2);assert.equal(history.body.rows[0].detail.before.title,j.title);assert.equal(history.body.rows[0].detail.after.description,'Choose for after-school supervision.');
 assert.equal((await send(owner,'/jobs/'+j.id,edit({...j,version:2},{reason:'x'}),'patch')).status,400);
});
test('managers need explicit scope; employees/finance/PIN/anonymous cannot edit or read management history',async()=>{
 const j=await job(),manager=await person('manager',[otherUnit]),employee=await person(),finance=await person('finance');
 for(const auth of [manager.auth,employee.auth,finance.auth]){assert.equal((await send(auth,'/jobs/'+j.id,edit(j),'patch')).status,403);assert.equal((await send(auth,'/jobs/'+j.id+'/history')).status,403);}
 assert.equal((await request(app()).patch('/api/jobs/'+j.id).set('Origin',origin).send(edit(j))).status,401);
 await assert.rejects(updateManagedJob(db,{...employee.auth.actor,role:'developer'},employee.auth.proof,j.id,edit(j)),(e:any)=>e.status===403);
 await assert.rejects(updateManagedJob(db,{...owner.actor,mode:'pin'},owner.proof,j.id,edit(j)),(e:any)=>e.status===403);
 await assert.rejects(updateManagedJob(db,owner.actor,employee.auth.proof,j.id,edit(j)),(e:any)=>e.status===401);
});
test('an unused job can move; any retained assignment or recorded time preserves its community',async()=>{
 const unused=await job();assert.equal((await ok(owner,'/jobs/'+unused.id,edit(unused,{unitId:otherUnit}),'patch')).job.unit_id,otherUnit);
 const used=await job(),worker=await person('employee',[unit],[used.id]);assert.equal((await send(owner,'/jobs/'+used.id,edit(used,{unitId:otherUnit}),'patch')).status,409);
 await ok(worker.auth,'/clock',{action:'clock_in',jobId:used.id,commandId:randomUUID()});await ok(worker.auth,'/clock',{action:'clock_out',commandId:randomUUID()});
 await ok(owner,'/staff/'+worker.id,{name:'Synthetic unassigned employee',email:worker.email,role:'employee',unitIds:[unit],jobIds:[],active:true},'patch');
 assert.equal((await send(owner,'/jobs/'+used.id,edit(used,{unitId:otherUnit}),'patch')).status,409);
});
test('archive waits for current clock use, preserves times and assignments, permits restoration',async()=>{
 const j=await job(),worker=await person('employee',[unit],[j.id]);await ok(worker.auth,'/clock',{action:'clock_in',jobId:j.id,commandId:randomUUID()});
 assert.equal((await send(owner,'/jobs/'+j.id,edit(j,{active:false}),'patch')).status,409);
 const renamed=await ok(owner,'/jobs/'+j.id,edit(j,{title:'Corrected working job'}),'patch');await ok(worker.auth,'/clock',{action:'clock_out',commandId:randomUUID()});
 const evidence=(await db.query('SELECT * FROM segments WHERE org_id=$1 AND job_id=$2 ORDER BY id',[owner.actor.org_id,j.id])).rows;
 const archived=await ok(owner,'/jobs/'+j.id,edit({...j,...renamed.job},{active:false}),'patch');
 assert.equal((await send(worker.auth,'/clock')).body.jobs.some((x:any)=>x.id===j.id),false);
 assert.equal((await send(worker.auth,'/clock',{action:'clock_in',jobId:j.id,commandId:randomUUID()})).status,403);
 await ok(owner,'/staff/'+worker.id,{name:'Synthetic renamed employee',email:worker.email,role:'employee',unitIds:[unit],jobIds:[j.id],active:true},'patch');
 const replacement=await person();assert.equal((await send(owner,'/staff/'+replacement.id,{name:'Synthetic new assignment',email:replacement.email,role:'employee',unitIds:[unit],jobIds:[j.id],active:true},'patch')).status,400);
 assert.deepEqual((await db.query('SELECT * FROM segments WHERE org_id=$1 AND job_id=$2 ORDER BY id',[owner.actor.org_id,j.id])).rows,evidence);
 await ok(owner,'/jobs/'+j.id,edit({...j,...archived.job},{active:true}),'patch');const auth=await signIn(worker.email,worker.password);await ok(auth,'/clock',{action:'clock_in',jobId:j.id,commandId:randomUUID()});await ok(auth,'/clock',{action:'clock_out',commandId:randomUUID()});
});
test('competing editors produce one accepted revision and audit failure rolls the mutation back',async()=>{
 const j=await job(),results=await Promise.all(['First editor','Second editor'].map(title=>send(owner,'/jobs/'+j.id,edit(j,{title}),'patch')));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const current=(await send(owner,'/jobs')).body.rows.find((x:any)=>x.id===j.id),before=(await send(owner,'/jobs/'+j.id+'/history')).body;
 const broken:Database={...db,transaction:async<T>(fn:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>fn({query:async<R extends Row=Row>(sql:string,params?:any[])=>{if(sql.startsWith('INSERT INTO audit_events')&&params?.[3]==='job.updated')throw new Error('Synthetic audit failure');return tx.query<R>(sql,params);}}))};
 await assert.rejects(updateManagedJob(broken,owner.actor,owner.proof,j.id,edit(current,{title:'Must roll back'})),/Synthetic audit failure/);
 assert.equal((await send(owner,'/jobs')).body.rows.find((x:any)=>x.id===j.id).title,current.title);assert.deepEqual((await send(owner,'/jobs/'+j.id+'/history')).body,before);
});

test('staff creation cannot finish with an assignment to a concurrently moved job',async()=>{
 const j=await job(),email=randomUUID()+'@stjw.org';
 const [created,moved]=await Promise.all([
  send(owner,'/staff',{name:'Synthetic competing assignment',email,role:'employee',unitIds:[unit],jobIds:[j.id]}),
  send(owner,'/jobs/'+j.id,edit(j,{unitId:otherUnit}),'patch'),
 ]);
 assert.ok(!(created.status===201&&moved.status===200),'Creation and community move cannot both accept the old assignment');
 assert.ok(created.status===201||moved.status===200,'One serialized operation succeeds');
 const invalid=(await db.query(`SELECT uj.user_id FROM user_jobs uj JOIN jobs j ON j.id=uj.job_id AND j.org_id=uj.org_id
 WHERE j.id=$1 AND NOT EXISTS(SELECT 1 FROM user_units uu WHERE uu.user_id=uj.user_id AND uu.org_id=uj.org_id AND uu.unit_id=j.unit_id)`,[j.id])).rows;
 assert.equal(invalid.length,0);
 // PGlite serializes local transactions; this covers outcomes, not a hosted PostgreSQL lock-queue proof.
});
