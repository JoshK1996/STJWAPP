import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {DateTime} from 'luxon';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {issueSetup,digest,type Actor} from '../server/security';
import {createStaff,clockCommand} from '../server/workforce';
import {createSchedule,updateSchedule,cancelSchedule} from '../server/staff-scheduling';
import {applyAuthenticatedClockCommand,getAuthenticatedClock} from '../server/clock-session';
import {cancelPreclock,getEmployeeClockPolicy,saveEmployeeClockPolicy,processPreclockIntent,processScheduledClockIntents} from '../server/scheduled-clock';
import {preciseTimeSql} from '../server/time-record-access';

let db:Database,app:ReturnType<typeof createApp>,owner:Actor,ownerProof:string,ownerAuth:Proof,job:any,unit:any;
const origin='http://localhost:3000',reason='Synthetic scheduled clock verification';
const base=DateTime.now().setZone('America/New_York').startOf('day').plus({hours:10}).toUTC();
const queueAt=base.toISO()!,startAt=base.plus({minutes:30}).toISO()!.replace(/\.\d{3}Z$/,'.123456Z'),endAt=base.plus({hours:3}).toISO()!,dueAt=base.plus({minutes:31}).toISO()!;
type Proof={actor:Actor;hash:string;cookie:string;csrf:string;password:string};
async function authenticate(actor:Actor):Promise<Proof>{
  // Each synthetic scenario gets a fresh normal setup/login; unrelated limiter state is reset in this disposable database.
  await db.query('DELETE FROM auth_limits');
  const token=await db.transaction(tx=>issueSetup(tx,actor)),password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  return {actor,hash:digest(cookie.slice(cookie.indexOf('=')+1)),cookie,csrf:me.body.actor.csrf,password};
}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'preclock.owner@example.test'});
  const row=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];job=(await db.query('SELECT * FROM jobs ORDER BY id LIMIT 1')).rows[0];unit=(await db.query('SELECT * FROM units WHERE id=$1',[job.unit_id])).rows[0];
  owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:'owner',unit_ids:[job.unit_id],mode:'password'};
  app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:false});ownerAuth=await authenticate(owner);ownerProof=ownerAuth.hash;
});
after(async()=>{await db?.close();});
async function person(role:'employee'|'manager'='employee'){
  const email=randomUUID()+'@stjw.org',id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic pending clock user',email,role,unitIds:[job.unit_id],jobIds:[job.id]},'stjw.org'));
  return authenticate({id,org_id:owner.org_id,name:'Synthetic pending clock user',email,role,unit_ids:[job.unit_id],mode:'password'});
}
/** Deterministic database time fixture only. Authentication still uses real expiry and no public timestamp injection exists. */
function at(instant:string,intercept?:(sql:string,params:any[],tx:Queryable)=>Promise<void>):Database{
  return {...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{
    await intercept?.(sql,params,tx);
    if(sql.startsWith('SELECT to_char(clock_timestamp()')&&sql.endsWith(' AS instant'))return {rows:[{instant} as unknown as T]};
    return tx.query<T>(sql,params);
  }}))};
}
async function setup(p:Proof,startsAt=startAt,endsAt=endAt){
  await saveEmployeeClockPolicy(db,owner,ownerProof,p.actor.id,{noEarlyClockIn:true,expectedVersion:0});
  return createSchedule(db,owner,{userId:p.actor.id,jobId:job.id,startsAt,endsAt,note:reason,reason,commandId:randomUUID()});
}
const clockIn=()=>({action:'clock_in' as const,jobId:job.id,commandId:randomUUID()});
async function queue(p:Proof){const command=clockIn();return {command,state:await applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,command)};}
async function shiftCount(id:string){return Number((await db.query('SELECT count(*) AS count FROM shifts WHERE user_id=$1',[id])).rows[0].count);}

test('per-employee policy defaults off; ordinary immediate clock retains its exact receipt and timestamp behavior',async()=>{
  const p=await person();assert.deepEqual(await getEmployeeClockPolicy(db,owner,ownerProof,p.actor.id),{noEarlyClockIn:false,version:0});
  const command=clockIn(),first=await applyAuthenticatedClockCommand(db,p.actor,p.hash,command);
  assert.ok(first.shift);assert.equal(first.preclock.pending,null);assert.equal(first.preclock.policy.noEarlyClockIn,false);
  assert.deepEqual(await applyAuthenticatedClockCommand(db,p.actor,p.hash,command),JSON.parse(JSON.stringify(first)));
});

test('early tap stores one durable pending intent and no hours, rejects premature execution and preserves clock receipt replay',async()=>{
  const p=await person();await setup(p);const {command,state}=await queue(p);
  assert.equal(state.shift,null);assert.ok(state.preclock.pending.id);assert.equal(state.preclock.pending.startsAt,startAt);
  assert.equal(await shiftCount(p.actor.id),0);
  assert.deepEqual(await applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,command),state);
  const other=await applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,clockIn());assert.equal(other.preclock.pending.id,state.preclock.pending.id);
  assert.equal(await processPreclockIntent(at(queueAt),state.preclock.pending.id),'pending');assert.equal(await shiftCount(p.actor.id),0);
  assert.equal((await db.query("SELECT id FROM clock_intent_events WHERE intent_id=$1 AND action='queued'",[state.preclock.pending.id])).rows.length,1);
});

test('independent due processing survives browser/session closure, retains microseconds and executes once without an invented end',async()=>{
  const p=await person();await setup(p);const {state}=await queue(p),id=state.preclock.pending.id;
  await db.query('DELETE FROM sessions WHERE user_id=$1',[p.actor.id]);
  const outcomes=await Promise.all([processPreclockIntent(at(dueAt),id),processPreclockIntent(at(dueAt),id)]);assert.ok(outcomes.every(status=>status==='executed'));
  const shifts=(await db.query(`SELECT *,${preciseTimeSql('started_at')} AS exact_start FROM shifts WHERE user_id=$1`,[p.actor.id])).rows;
  assert.equal(shifts.length,1);assert.equal(shifts[0].exact_start,startAt);assert.equal(shifts[0].ended_at,null);
  const intent=(await db.query('SELECT status,version,shift_id FROM clock_intents WHERE id=$1',[id])).rows[0];assert.equal(intent.status,'executed');assert.equal(intent.version,2);assert.equal(intent.shift_id,shifts[0].id);
  const audit=(await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='clock.clock_in'",[p.actor.id])).rows[0].detail;
  assert.equal(audit.at,startAt);assert.equal(audit.scheduled.processedAt,dueAt);assert.equal(audit.scheduled.intentId,id);
  assert.equal((await db.query("SELECT id FROM clock_intent_events WHERE intent_id=$1 AND action='executed'",[id])).rows.length,1);
});

test('ended shifts never become phantom open records after restart or delayed processing',async()=>{
  const p=await person();await setup(p);const {state}=await queue(p),id=state.preclock.pending.id;
  assert.equal(await processPreclockIntent(at(endAt),id),'blocked');assert.equal(await shiftCount(p.actor.id),0);
  const row=(await db.query('SELECT reason,status FROM clock_intents WHERE id=$1',[id])).rows[0];assert.match(row.reason,/ended before/);assert.equal(row.status,'blocked');
});

for(const change of ['schedule_cancelled','schedule_edited','job_archived','job_revoked','unit_revoked','credentials_changed','account_disabled'] as const){
  test(`pending intent blocks ${change} under current authority before any hours are created`,async()=>{
    const p=await person(),s=await setup(p),{state}=await queue(p),id=state.preclock.pending.id;
    if(change==='schedule_cancelled')await cancelSchedule(db,owner,s.id,{expectedVersion:1,reason,commandId:randomUUID()});
    if(change==='schedule_edited')await updateSchedule(db,owner,s.id,{expectedVersion:1,jobId:job.id,startsAt:startAt,endsAt:endAt,note:'Changed after pending authorization',reason,commandId:randomUUID()});
    if(change==='job_archived')await db.query('UPDATE jobs SET active=false WHERE id=$1',[job.id]);
    if(change==='job_revoked')await db.query('DELETE FROM user_jobs WHERE user_id=$1',[p.actor.id]);
    if(change==='unit_revoked')await db.query('DELETE FROM user_units WHERE user_id=$1',[p.actor.id]);
    if(change==='credentials_changed')await db.query("UPDATE users SET password_hash='synthetic-replaced-proof' WHERE id=$1",[p.actor.id]);
    if(change==='account_disabled')await db.query('UPDATE users SET active=false WHERE id=$1',[p.actor.id]);
    assert.equal(await processPreclockIntent(at(dueAt),id),'blocked');assert.equal(await shiftCount(p.actor.id),0);
    if(change==='job_archived')await db.query('UPDATE jobs SET active=true WHERE id=$1',[job.id]);
  });
}

test('policy edits are versioned, cancel pending authorization immediately, and keep existing hours untouched',async()=>{
  const p=await person();await setup(p);const {state}=await queue(p);
  await assert.rejects(saveEmployeeClockPolicy(db,owner,ownerProof,p.actor.id,{noEarlyClockIn:false,expectedVersion:0}),{status:409});
  const changed=await saveEmployeeClockPolicy(db,owner,ownerProof,p.actor.id,{noEarlyClockIn:false,expectedVersion:1});assert.deepEqual(changed,{noEarlyClockIn:false,version:2});
  assert.equal((await db.query('SELECT status FROM clock_intents WHERE id=$1',[state.preclock.pending.id])).rows[0].status,'cancelled');
  const current=await getAuthenticatedClock(db,p.actor,p.hash);assert.equal(current.preclock.pending,null);assert.equal(current.preclock.policy.noEarlyClockIn,false);
  await applyAuthenticatedClockCommand(db,p.actor,p.hash,clockIn());assert.equal(await shiftCount(p.actor.id),1);
});

test('enabled policy requires a matching assigned job today; current intervals clock now and tomorrow is never queued',async()=>{
  const p=await person();await saveEmployeeClockPolicy(db,owner,ownerProof,p.actor.id,{noEarlyClockIn:true,expectedVersion:0});
  await assert.rejects(applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,clockIn()),{status:409});
  const tomorrow=base.plus({days:1});await createSchedule(db,owner,{userId:p.actor.id,jobId:job.id,startsAt:tomorrow.toISO()!,endsAt:tomorrow.plus({hours:2}).toISO()!,note:reason,reason,commandId:randomUUID()});
  await assert.rejects(applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,clockIn()),{status:409});
  await createSchedule(db,owner,{userId:p.actor.id,jobId:job.id,startsAt:base.minus({minutes:1}).toISO()!,endsAt:endAt,note:reason,reason,commandId:randomUUID()});
  const current=await applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,clockIn());assert.ok(current.shift);assert.equal(current.preclock.pending,null);
});

test('cancellation is self-only, uses current session and expected version, replays exactly and prevents later execution',async()=>{
  const p=await person(),stranger=await person();await setup(p);const {state}=await queue(p),id=state.preclock.pending.id,input={version:1,commandId:randomUUID()};
  await assert.rejects(cancelPreclock(db,stranger.actor,stranger.hash,id,input),{status:404});
  await assert.rejects(cancelPreclock(db,p.actor,stranger.hash,id,input),{status:401});
  await assert.rejects(cancelPreclock(db,p.actor,p.hash,id,{...input,version:2}),{status:409});
  const cancelled=await cancelPreclock(db,p.actor,p.hash,id,input);assert.equal(cancelled.preclock.pending,null);
  assert.deepEqual(await cancelPreclock(db,p.actor,p.hash,id,input),cancelled);
  assert.equal(await processPreclockIntent(at(dueAt),id),'cancelled');assert.equal(await shiftCount(p.actor.id),0);
});

test('existing open or overlapping corrected time blocks pending execution rather than duplicating attendance',async()=>{
  const p=await person();await setup(p);const {state}=await queue(p);
  await clockCommand(db,p.actor,clockIn(),new Date(base.plus({minutes:10}).toISO()!));
  assert.equal(await processPreclockIntent(at(dueAt),state.preclock.pending.id),'blocked');assert.equal(await shiftCount(p.actor.id),1);
  const q=await person();await setup(q);const queued=await queue(q);
  await clockCommand(db,q.actor,clockIn(),new Date(base.plus({minutes:10}).toISO()!));
  await clockCommand(db,q.actor,{action:'clock_out',commandId:randomUUID()},new Date(dueAt));
  assert.equal(await processPreclockIntent(at(dueAt),queued.state.preclock.pending.id),'blocked');assert.equal(await shiftCount(q.actor.id),1);
});

test('submission and due-execution audit failures roll back all new records and can retry the same authorization',async()=>{
  const p=await person();await setup(p);const fail=async(sql:string)=>{if(sql.includes('INSERT INTO audit_events'))throw Error('Synthetic scheduled audit failure');};
  const command=clockIn();await assert.rejects(applyAuthenticatedClockCommand(at(queueAt,fail),p.actor,p.hash,command),/Synthetic scheduled audit failure/);
  assert.equal((await db.query('SELECT id FROM clock_intents WHERE user_id=$1',[p.actor.id])).rows.length,0);
  const queued=await applyAuthenticatedClockCommand(at(queueAt),p.actor,p.hash,command);
  await assert.rejects(processPreclockIntent(at(dueAt,fail),queued.preclock.pending.id),/Synthetic scheduled audit failure/);
  assert.equal(await shiftCount(p.actor.id),0);assert.equal((await db.query('SELECT status FROM clock_intents WHERE id=$1',[queued.preclock.pending.id])).rows[0].status,'pending');
  assert.equal(await processPreclockIntent(at(dueAt),queued.preclock.pending.id),'executed');assert.equal(await shiftCount(p.actor.id),1);
});

test('intent evidence and credential-generation guard resist SQL rewrites; worker uses account before schedule and intent locks',async()=>{
  const p=await person();await setup(p);const {state}=await queue(p),id=state.preclock.pending.id;
  await assert.rejects(db.query("UPDATE clock_intents SET starts_at=starts_at+interval '1 minute' WHERE id=$1",[id]),/immutable/);
  const authority=(await db.query('SELECT clock_authority_version FROM users WHERE id=$1',[p.actor.id])).rows[0].clock_authority_version;
  await db.query('UPDATE users SET clock_authority_version=clock_authority_version+100 WHERE id=$1',[p.actor.id]);assert.equal((await db.query('SELECT clock_authority_version FROM users WHERE id=$1',[p.actor.id])).rows[0].clock_authority_version,authority);
  const statements:string[]=[];await processPreclockIntent(at(dueAt,async sql=>{statements.push(sql);}),id);
  const account=statements.findIndex(s=>s.includes('FROM users')&&s.includes('FOR UPDATE')),schedule=statements.findIndex(s=>s.includes('FROM schedules')&&s.includes('FOR SHARE')),intent=statements.findIndex(s=>s.includes('FROM clock_intents')&&s.includes('FOR UPDATE'));
  assert.ok(account>=0&&schedule>account&&intent>schedule);
  await assert.rejects(db.query("UPDATE clock_intents SET reason='rewritten' WHERE id=$1",[id]),/immutable/);
  await assert.rejects(db.query('DELETE FROM clock_intent_events WHERE intent_id=$1',[id]),/immutable|append-only/i);
});

test('clock policy rejects employee self-escalation, missing proof and cross-organization reads',async()=>{
  const p=await person(),other=await person();
  await assert.rejects(saveEmployeeClockPolicy(db,p.actor,p.hash,other.actor.id,{noEarlyClockIn:true,expectedVersion:0}),{status:403});
  await assert.rejects(getEmployeeClockPolicy(db,owner,undefined as any,p.actor.id),{status:401});
  await assert.rejects(getEmployeeClockPolicy(db,{...owner,org_id:randomUUID()},ownerProof,p.actor.id),{status:403});
  await assert.rejects(getEmployeeClockPolicy(db,{...owner,mode:'pin'},ownerProof,p.actor.id),{status:403});
});

test('bounded background sweep applies a due persisted intent using real server time without a browser request',async()=>{
  const p=await person();
  const target=new Date(Date.now()+400),end=new Date(target.valueOf()+3_600_000);
  await setup(p,target.toISOString(),end.toISOString());
  const queuedAt=new Date(target.valueOf()-1).toISOString();
  const queued=await applyAuthenticatedClockCommand(at(queuedAt),p.actor,p.hash,clockIn());assert.ok(queued.preclock.pending);
  await db.query('DELETE FROM sessions WHERE user_id=$1',[p.actor.id]);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,target.valueOf()-Date.now()+30)));
  await processScheduledClockIntents(db,100);
  const row=(await db.query('SELECT status,shift_id FROM clock_intents WHERE id=$1',[queued.preclock.pending.id])).rows[0];
  assert.equal(row.status,'executed');assert.ok(row.shift_id);assert.equal(await shiftCount(p.actor.id),1);
});

test('normal PIN-only authentication can cancel its own pending start while management and other methods stay denied',async()=>{
  const p=await person(),pin='68241957';
  const installed=await request(app).post('/api/auth/pin').set('Origin',origin).set('Cookie',p.cookie).set('X-CSRF-Token',p.csrf).send({password:p.password,pin});assert.equal(installed.status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({credential:pin,mode:'pin'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  const pinProof={actor:{...p.actor,mode:'pin' as const},hash:digest(cookie.slice(cookie.indexOf('=')+1))};
  await setup(p);const queued=await applyAuthenticatedClockCommand(at(queueAt),pinProof.actor,pinProof.hash,clockIn()),path='/api/clock/preclock/'+queued.preclock.pending.id+'/cancel',body={version:1,commandId:randomUUID()};
  assert.equal((await request(app).post(path).set('Origin',origin).set('Cookie',cookie).send(body)).status,403);
  assert.equal((await request(app).get(path).set('Cookie',cookie)).status,403);
  assert.equal((await request(app).get('/api/staff/'+p.actor.id+'/clock-policy').set('Cookie',cookie)).status,403);
  const cancelled=await request(app).post(path).set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',me.body.actor.csrf).send(body);assert.equal(cancelled.status,200);assert.equal(cancelled.body.preclock.pending,null);assert.equal(await shiftCount(p.actor.id),0);
  assert.equal((await request(app).get('/api/clock').set('Cookie',cookie)).status,200);
});

test('a failed due intent rolls back individually and the same bounded sweep still processes another employee',async()=>{
  const p=await person(),q=await person(),target=new Date(Date.now()-1000),end=new Date(Date.now()+3_600_000);
  for(const person of [p,q])await setup(person,target.toISOString(),end.toISOString());
  const early=new Date(target.valueOf()-1).toISOString(),one=await applyAuthenticatedClockCommand(at(early),p.actor,p.hash,clockIn()),two=await applyAuthenticatedClockCommand(at(early),q.actor,q.hash,clockIn());
  const failing=at(new Date().toISOString(),async(sql,params)=>{if(sql.includes('INSERT INTO audit_events')&&params.includes(p.actor.id))throw Error('Synthetic individual worker audit failure');}),errors:unknown[]=[];
  const counts=await processScheduledClockIntents(failing,100,error=>errors.push(error));
  assert.ok(counts.failed>=1);assert.ok(counts.executed>=1);assert.ok(errors.some(error=>(error as Error).message==='Synthetic individual worker audit failure'));
  assert.equal(await shiftCount(p.actor.id),0);assert.equal(await shiftCount(q.actor.id),1);
  assert.equal((await db.query('SELECT status FROM clock_intents WHERE id=$1',[one.preclock.pending.id])).rows[0].status,'pending');
  assert.equal((await db.query('SELECT status FROM clock_intents WHERE id=$1',[two.preclock.pending.id])).rows[0].status,'executed');
});

test('issued reports API tokens read only the new workforce report routes and reject writes, clocking and missing scope',async()=>{
  const query={start:base.toISODate()!,end:base.toISODate()!};
  const create=async(scopes:string[])=>{const result=await request(app).post('/api/tokens').set('Origin',origin).set('Cookie',ownerAuth.cookie).set('X-CSRF-Token',ownerAuth.csrf).send({name:'Synthetic scoped workforce reader',scopes,days:1});assert.equal(result.status,200);return result.body.token as string;};
  const token=await create(['reports:read']),wrongScope=await create(['staff:read']);
  const snapshot=await request(app).post('/api/workforce/allowance/snapshots').set('Origin',origin).set('Cookie',ownerAuth.cookie).set('X-CSRF-Token',ownerAuth.csrf).send({query,commandId:randomUUID()});assert.equal(snapshot.status,201);
  const routes=['/api/workforce/overview','/api/board','/api/workforce/allowance/export.csv','/api/workforce/allowance/export.xlsx','/api/workforce/allowance/snapshots','/api/workforce/allowance/snapshots/'+snapshot.body.id,'/api/workforce/allowance/snapshots/'+snapshot.body.id+'/export.csv','/api/workforce/allowance/snapshots/'+snapshot.body.id+'/export.xlsx'];
  for(const route of routes){
    const response=await request(app).get(route).query(query).set('Authorization','Bearer '+token);assert.equal(response.status,200,route+' '+response.text?.slice(0,120));
    assert.equal((await request(app).get(route).query(query).set('Authorization','Bearer '+wrongScope)).status,403,route);
  }
  for(const route of ['/api/workforce/allowance/snapshots','/api/clock','/api/clock/preclock/'+randomUUID()+'/cancel'])assert.equal((await request(app).post(route).set('Origin',origin).set('Authorization','Bearer '+token).send({commandId:randomUUID()})).status,403);
  assert.equal((await request(app).get('/api/clock').set('Authorization','Bearer '+token)).status,403);
  await db.query('UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE token_hash=$1',[digest(token)]);
  assert.equal((await request(app).get('/api/workforce/overview').query(query).set('Authorization','Bearer '+token)).status,403);
});
