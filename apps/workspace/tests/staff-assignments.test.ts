import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable,type Row} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {digest,issueSetup,type Actor} from '../server/security';
import {getStaffAssignments,saveStaffAssignments} from '../server/staff-assignments';
import {issueManagedStaffSetupLink} from '../server/staff-authority';
import {applyAuthenticatedClockCommand,getAuthenticatedClock} from '../server/clock-session';

const origin='http://localhost:3196';
type Person={actor:Actor;hash:string;cookie:string;csrf:string;password:string};
let db:Database,app:ReturnType<typeof createApp>,developer:Person,unitId:string,otherUnit:string,jobId:string,secondJob:string,otherJob:string;
const status=(code:number)=>(error:any)=>error.status===code;
async function authenticate(user:Actor):Promise<Person>{
  // Normal setup and login in a disposable database. Clear unrelated limiter
  // fixtures between scenarios; this suite does not test authentication limits.
  await db.query('DELETE FROM auth_limits');const password='Synthetic-'+randomUUID(),token=await db.transaction(tx=>issueSetup(tx,user));
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:user.email,credential:password,mode:'password'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  return {actor:{...me.body.actor,mode:'password'},hash:digest(cookie.slice(cookie.indexOf('=')+1)),cookie,csrf:me.body.actor.csrf,password};
}
async function person(role:Actor['role']='employee',units=[unitId],jobs=[jobId]):Promise<Person>{
  const id=randomUUID(),email=id+'@stjw.org';
  // Higher-role fixtures are deliberately provisioned before ordinary login;
  // this is not a public provisioning route or a customer-account shortcut.
  await db.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[id,developer.actor.org_id,email,'Synthetic assignment '+role,role]);
  for(const unit of units)await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[developer.actor.org_id,id,unit]);
  for(const job of jobs)await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[developer.actor.org_id,id,job]);
  return authenticate({id,org_id:developer.actor.org_id,email,name:'Synthetic assignment '+role,role,mode:'password',unit_ids:units});
}
const read=(who:Person,target=who,database=db)=>getStaffAssignments(database,who.actor,who.hash,target.actor.id);
const save=(who:Person,target:Person,raw:unknown,database=db)=>saveStaffAssignments(database,who.actor,who.hash,target.actor.id,raw);
const input=(state:any,changes:Record<string,unknown>={})=>({unitIds:state.unitIds,jobIds:state.jobIds,expectedRevision:state.revision,...changes});
async function countAudits(id:string){return Number((await db.query("SELECT count(*) AS value FROM audit_events WHERE target_id=$1 AND action='staff.assignments_changed'",[id])).rows[0].value);}
function probe(effect:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{return {...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Row=Row>(sql:string,params:any[]=[])=>{const result=await tx.query<T>(sql,params);await effect(tx,sql,params);return result;}}))};}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'assignment.developer@example.test'});
  const initial=(await db.query("SELECT id,org_id,name,email FROM users WHERE role='owner'")).rows[0];await db.query("UPDATE users SET role='developer' WHERE id=$1",[initial.id]);
  app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});developer=await authenticate({id:initial.id,org_id:initial.org_id,email:initial.email,name:initial.name,role:'developer',mode:'password',unit_ids:[]});
  const jobs=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id')).rows;jobId=jobs[0].id;unitId=jobs[0].unit_id;const other=jobs.find(job=>job.unit_id!==unitId)!;otherJob=other.id;otherUnit=other.unit_id;
  secondJob=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[secondJob,developer.actor.org_id,unitId,'Synthetic second assigned job']);
});
after(async()=>{await db?.close();});

test('administrators can assign themselves and peer administrators without changing accounts or invalidating sessions',async()=>{
  const a=await person('admin'),b=await person('admin'),before=(await db.query('SELECT name,email,role,active,password_hash,pin_hash,clock_authority_version FROM users WHERE id=$1',[b.actor.id])).rows[0];
  const self=await read(a),saved=await save(a,a,input(self,{jobIds:[jobId,secondJob]}));assert.equal(saved.changed,true);
  assert.deepEqual(new Set((await getAuthenticatedClock(db,a.actor,a.hash)).jobs.map(job=>job.id)),new Set([jobId,secondJob]));
  const peer=await read(a,b),changed=await save(a,b,input(peer,{unitIds:[unitId,otherUnit],jobIds:[jobId,otherJob]}));assert.equal(changed.changed,true);
  assert.deepEqual((await db.query('SELECT name,email,role,active,password_hash,pin_hash,clock_authority_version FROM users WHERE id=$1',[b.actor.id])).rows[0],before);
  assert.equal((await request(app).get('/api/me').set('Cookie',a.cookie)).status,200);assert.equal((await request(app).get('/api/me').set('Cookie',b.cookie)).status,200);
  assert.deepEqual(new Set((await getAuthenticatedClock(db,b.actor,b.hash)).jobs.map(job=>job.id)),new Set([jobId,otherJob]));
  await assert.rejects(issueManagedStaffSetupLink(db,a.actor,a.hash,a.actor.id,origin),status(403));await assert.rejects(issueManagedStaffSetupLink(db,a.actor,a.hash,b.actor.id,origin),status(403));
});

test('developer and owner self assignments work while higher-role and manager boundaries remain narrow',async()=>{
  const owner=await person('owner'),peerOwner=await person('owner'),admin=await person('admin'),manager=await person('manager'),worker=await person(),outside=await person('employee',[otherUnit],[otherJob]),finance=await person('finance');
  for(const actor of [developer,owner]){const current=await read(actor);assert.equal((await save(actor,actor,input(current,{unitIds:[unitId,otherUnit],jobIds:[jobId,otherJob]}))).changed,true);}
  for(const target of [developer,owner]){await assert.rejects(read(admin,target),status(403));await assert.rejects(save(admin,target,{unitIds:[unitId],jobIds:[],expectedRevision:'0'.repeat(64)}),status(403));}
  await assert.rejects(read(owner,peerOwner),status(403));await assert.rejects(read(owner,developer),status(403));
  for(const target of [manager,admin,owner,outside])await assert.rejects(read(manager,target),status(403));
  for(const actor of [worker,finance])await assert.rejects(read(actor),status(403));
  const current=await read(manager,worker);assert.equal((await save(manager,worker,input(current,{jobIds:[jobId,secondJob]}))).changed,true);
  await assert.rejects(save(manager,worker,input(await read(manager,worker),{unitIds:[unitId,otherUnit],jobIds:[jobId,otherJob]})),status(403));
});

test('assignment validation rejects foreign/unknown jobs and units, unexpected fields and duplicate choices',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker);
  await assert.rejects(save(admin,worker,input(current,{jobIds:[randomUUID()]})),status(400));
  await assert.rejects(save(admin,worker,input(current,{unitIds:[randomUUID()],jobIds:[]})),status(400));
  await assert.rejects(save(admin,worker,input(current,{jobIds:[otherJob]})),status(400));
  await assert.rejects(save(admin,worker,input(current,{role:'developer'})),{name:'ZodError'});
  await assert.rejects(save(admin,worker,input(current,{jobIds:[jobId,jobId]})),{name:'ZodError'});
  assert.equal(await countAudits(worker.actor.id),0);assert.equal((await read(admin,worker)).revision,current.revision);
});

test('archived existing jobs remain visible and retainable, but removed archived jobs cannot be assigned again',async()=>{
  const archived=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[archived,developer.actor.org_id,unitId,'Synthetic archived retained job']);
  const admin=await person('admin'),worker=await person('employee',[unitId],[jobId,archived]);await db.query('UPDATE jobs SET active=false WHERE id=$1',[archived]);
  const current=await read(admin,worker);assert.equal(current.jobs.find(job=>job.id===archived)?.active,false);
  const retained=await save(admin,worker,input(current,{jobIds:[jobId,archived,secondJob]}));assert.ok(retained.jobIds.includes(archived));
  const removed=await save(admin,worker,input(retained,{jobIds:[jobId,secondJob]}));assert.equal(removed.jobs.some(job=>job.id===archived),false);
  await assert.rejects(save(admin,worker,input(removed,{jobIds:[jobId,archived]})),status(400));
  const history=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND action='staff.assignments_changed' ORDER BY created_at DESC LIMIT 1",[worker.actor.id])).rows[0].detail;
  assert.ok(history.before.jobs.some((job:any)=>job.id===archived&&job.title==='Synthetic archived retained job'));
});

test('optimistic changes reject lost updates and exact desired-state retries do not duplicate audits',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker),body=input(current,{jobIds:[jobId,secondJob]});
  const first=await save(admin,worker,body),retry=await save(admin,worker,body);assert.equal(first.changed,true);assert.equal(retry.changed,false);assert.equal(retry.revision,first.revision);assert.equal(await countAudits(worker.actor.id),1);
  await assert.rejects(save(admin,worker,input(current,{jobIds:[]})),status(409));
  const next=await read(admin,worker),results=await Promise.allSettled([save(admin,worker,input(next,{jobIds:[jobId]})),save(admin,worker,input(next,{jobIds:[secondJob]}))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);
});

test('active work and breaks allow additional jobs while preserving the current job/community and recorded time',async()=>{
  const admin=await person('admin'),worker=await person();await applyAuthenticatedClockCommand(db,worker.actor,worker.hash,{action:'clock_in',jobId,commandId:randomUUID()});
  const current=await read(admin,worker);assert.deepEqual(current.lockedJobIds,[jobId]);assert.deepEqual(current.lockedUnitIds,[unitId]);
  const added=await save(admin,worker,input(current,{unitIds:[unitId,otherUnit],jobIds:[jobId,secondJob,otherJob]}));assert.equal(added.changed,true);
  await assert.rejects(save(admin,worker,input(added,{jobIds:[secondJob,otherJob]})),status(409));await assert.rejects(save(admin,worker,input(added,{unitIds:[otherUnit],jobIds:[otherJob]})),status(409));
  await applyAuthenticatedClockCommand(db,worker.actor,worker.hash,{action:'start_break',commandId:randomUUID()});await assert.rejects(save(admin,worker,input(added,{jobIds:[secondJob,otherJob]})),status(409));
  await applyAuthenticatedClockCommand(db,worker.actor,worker.hash,{action:'end_break',commandId:randomUUID()});await applyAuthenticatedClockCommand(db,worker.actor,worker.hash,{action:'switch_job',jobId:secondJob,commandId:randomUUID()});
  const switched=await read(admin,worker);assert.equal((await save(admin,worker,input(switched,{jobIds:[secondJob,otherJob]}))).changed,true);
  const clock=await getAuthenticatedClock(db,worker.actor,worker.hash);assert.equal(clock.shift.job_id,secondJob);assert.equal(Number((await db.query('SELECT count(*) AS n FROM shifts WHERE user_id=$1',[worker.actor.id])).rows[0].n),1);
});

test('clocking that commits before assignment save prevents removal, and removal before clocking rejects stale choices',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker);let called=false;
  const afterClock:Database={...db,transaction:async work=>{if(!called){called=true;await applyAuthenticatedClockCommand(db,worker.actor,worker.hash,{action:'clock_in',jobId,commandId:randomUUID()});}return db.transaction(work);}};
  await assert.rejects(save(admin,worker,input(current,{jobIds:[]}),afterClock),status(409));assert.equal((await read(admin,worker)).revision,current.revision);
  const other=await person(),state=await read(admin,other);await save(admin,other,input(state,{jobIds:[]}));await assert.rejects(applyAuthenticatedClockCommand(db,other.actor,other.hash,{action:'clock_in',jobId,commandId:randomUUID()}),status(403));
});

test('fresh session, role and scope checks reject stale or forged authority before no-op and changed saves',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker);
  await assert.rejects(getStaffAssignments(db,admin.actor,undefined,worker.actor.id),status(401));await assert.rejects(getStaffAssignments(db,admin.actor,worker.hash,worker.actor.id),status(401));
  for(const mode of ['pin','api'] as const)await assert.rejects(getStaffAssignments(db,{...admin.actor,mode},admin.hash,worker.actor.id),status(403));
  await assert.rejects(getStaffAssignments(db,{...worker.actor,role:'developer'},worker.hash,admin.actor.id),status(403));
  await assert.rejects(getStaffAssignments(db,{...admin.actor,org_id:randomUUID()},admin.hash,worker.actor.id),status(403));
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[admin.hash]);await assert.rejects(save(admin,worker,input(current)),status(401));
  const demoted=await person('admin');await db.query("UPDATE users SET role='employee' WHERE id=$1",[demoted.actor.id]);await assert.rejects(read(demoted,worker),status(403));
  const manager=await person('manager');await db.query('DELETE FROM user_units WHERE user_id=$1',[manager.actor.id]);await assert.rejects(read(manager,worker),status(403));
});

test('audit failure and final expiry roll back assignments and preserve sessions and historical evidence',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker),body=input(current,{jobIds:[jobId,secondJob]});
  for(const mode of ['audit_failure','final_expiry']){
    const wrapped=probe(async(tx,sql,params)=>{if(sql.startsWith('INSERT INTO audit_events')&&params[3]==='staff.assignments_changed'){if(mode==='audit_failure')throw Error('Synthetic assignment audit failure');await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[admin.hash]);}});
    await assert.rejects(save(admin,worker,body,wrapped),mode==='audit_failure'?/Synthetic assignment audit failure/:status(401));
    assert.equal((await read(admin,worker)).revision,current.revision);assert.equal(await countAudits(worker.actor.id),0);
  }
});

test('assignment writes lock sorted accounts before sorted jobs and communities',async()=>{
  const admin=await person('admin'),worker=await person(),current=await read(admin,worker),queries:{sql:string;params:any[]}[]=[];
  await save(admin,worker,input(current,{unitIds:[otherUnit,unitId],jobIds:[otherJob,jobId,secondJob]}),probe(async(_tx,sql,params)=>{queries.push({sql,params});}));
  const accounts=queries.findIndex(row=>row.sql.includes('FROM users WHERE org_id=$1 AND id=ANY')&&row.sql.includes('FOR NO KEY UPDATE'));
  const jobs=queries.findIndex(row=>row.sql.startsWith('SELECT id,title,unit_id,active FROM jobs')&&row.sql.includes('FOR SHARE'));
  const units=queries.findIndex(row=>row.sql.startsWith('SELECT id,name FROM units')&&row.sql.includes('FOR SHARE'));
  assert.ok(accounts>=0&&jobs>accounts&&units>jobs);assert.deepEqual(queries[accounts].params[1],[admin.actor.id,worker.actor.id].sort());assert.deepEqual(queries[jobs].params[1],[jobId,secondJob,otherJob].sort());
});

test('HTTP assignment reads and saves use private responses, real password sessions and CSRF',async()=>{
  const admin=await person('admin'),path='/api/staff/'+admin.actor.id+'/assignments';
  const initial=await request(app).get(path).set('Cookie',admin.cookie);assert.equal(initial.status,200);assert.equal(initial.headers['cache-control'],'private, no-store');
  const body=input(initial.body,{jobIds:[jobId,secondJob]});assert.equal((await request(app).put(path).set('Origin',origin).set('Cookie',admin.cookie).send(body)).status,403);
  const saved=await request(app).put(path).set('Origin',origin).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).send(body);assert.equal(saved.status,200);assert.equal(saved.body.changed,true);assert.equal(saved.headers['cache-control'],'private, no-store');
  assert.equal((await request(app).get('/api/me').set('Cookie',admin.cookie)).status,200);
  assert.equal((await request(app).put(path).set('Origin',origin).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).send({...body,active:false})).status,400);
});

test('existing normal PIN sessions immediately see their newly assigned clock jobs without another sign-in',async()=>{
  const admin=await person('admin'),peer=await person('admin'),pin='61327485';
  assert.equal((await request(app).post('/api/auth/pin').set('Origin',origin).set('Cookie',peer.cookie).set('X-CSRF-Token',peer.csrf).send({password:peer.password,pin})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({credential:pin,mode:'pin'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];assert.equal((await request(app).get('/api/staff/'+peer.actor.id+'/assignments').set('Cookie',cookie)).status,403);
  const current=await read(admin,peer);await save(admin,peer,input(current,{unitIds:[unitId,otherUnit],jobIds:[jobId,otherJob]}));
  const clock=await request(app).get('/api/clock').set('Cookie',cookie);assert.equal(clock.status,200);assert.deepEqual(new Set(clock.body.jobs.map((job:any)=>job.id)),new Set([jobId,otherJob]));
  assert.equal((await request(app).get('/api/me').set('Cookie',peer.cookie)).status,200);
});

test('real foreign organization targets, jobs and communities cannot enter assignment changes',async()=>{
  const org=randomUUID(),unit=randomUUID(),job=randomUUID(),user=randomUUID(),admin=await person('admin'),worker=await person();
  await db.query("INSERT INTO organizations(id,name,timezone,demo) VALUES($1,'Synthetic foreign organization','America/New_York',false)",[org]);
  const kind=(await db.query('SELECT kind FROM units WHERE id=$1',[unitId])).rows[0].kind;
  await db.query('INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,$4)',[unit,org,'Synthetic foreign community',kind]);
  await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic foreign job')",[job,org,unit]);
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic foreign employee','employee')",[user,org,user+'@stjw.org']);
  await assert.rejects(getStaffAssignments(db,admin.actor,admin.hash,user),status(404));
  const current=await read(admin,worker);await assert.rejects(save(admin,worker,input(current,{jobIds:[job]})),status(400));await assert.rejects(save(admin,worker,input(current,{unitIds:[unit],jobIds:[]})),status(400));
  assert.equal((await read(admin,worker)).revision,current.revision);assert.equal(await countAudits(worker.actor.id),0);
});
