import { createAuthenticatedRequest } from '../server/workforce';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, opaqueToken, type Actor } from '../server/security';
import { testStaffRevision } from '../scripts/test-staff-revision';
import { createSchedule } from '../server/staff-scheduling';
import { updateStaffAccount } from '../server/staff-authority';

const origin='http://localhost:3297', roles=['developer','owner','admin'];
let db:Database,app:ReturnType<typeof createApp>,org:string,unit:string,job:string;
type Auth={actor:Actor;cookie:string;csrf:string;hash:string};
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'privileged.fixture@example.test'});
  org=(await db.query('SELECT id FROM organizations')).rows[0].id;
  const row=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 1')).rows[0];job=row.id;unit=row.unit_id;
  app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});
});
after(async()=>{await db?.close();});
async function person(role:string):Promise<Auth>{
  const id=randomUUID(),email=id+'@stjw.org',name='Synthetic '+role;
  await db.query('INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)',[id,org,name,email,role]);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[org,id,unit]);
  await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[org,id,job]);
  const token=opaqueToken(),csrf=opaqueToken(),hash=digest(token);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,clock_timestamp()+interval '1 hour')",[hash,org,id,csrf]);
  return {actor:{id,org_id:org,name,email,role,mode:'password',unit_ids:[unit]},cookie:'stjw_session='+token,csrf,hash};
}
function send(auth:Auth,path:string,body?:unknown,method='POST'){
  const client=request(app);return body===undefined?client.get('/api'+path).set('Cookie',auth.cookie):
    (client as any)[method.toLowerCase()]('/api'+path).set('Cookie',auth.cookie).set('Origin',origin).set('X-CSRF-Token',auth.csrf).send(body);
}
async function ok(auth:Auth,path:string,body?:unknown,method='POST'){
  const response=await send(auth,path,body,method);assert.ok(response.status<300,path+': '+response.status+' '+JSON.stringify(response.body));return response.body;
}
async function card(auth:Auth,day=1,open=false){
  const id=randomUUID(),start=`2026-01-0${day}T08:00:00.000Z`,end=open?null:`2026-01-0${day}T10:00:00.000Z`;
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)',[id,org,auth.actor.id,start,end]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work',$5,$6)",[randomUUID(),org,id,job,start,end]);return id;
}
const missing=(auth:Auth,day=2)=>({kind:'missing_shift',employeeId:auth.actor.id,segments:[{jobId:job,kind:'work',startedAt:`2026-01-0${day}T08:00:00.000Z`,endedAt:`2026-01-0${day}T10:00:00.000Z`}],reason:'Direct privileged entry of actual synthetic time.',commandId:randomUUID()});
for(const role of roles){
  test(role+' saves own completed/open cards immediately with exact retry and retained originals',async()=>{
    const auth=await person(role),id=await card(auth),detail=await ok(auth,'/time-records/'+id);
    assert.equal(detail.canAdjust,true);
    const list=await ok(auth,'/time-records?start=2026-01-01&end=2026-01-07');assert.equal(list.rows.find((r:any)=>r.id===id).canAdjust,true);
    const input={shiftId:id,sourceRevision:1,sourceHash:detail.sourceHash,commandId:randomUUID(),reason:'Correct both dated punches on my own synthetic card.',segments:[{jobId:job,kind:'work',startedAt:'2026-01-01T07:30:00.000Z',endedAt:'2026-01-01T10:30:00.000Z'}]};
    const saved=await ok(auth,'/time-records/'+id+'/adjust',input);assert.equal(saved.status,'approved');
    assert.equal((await ok(auth,'/time-records/'+id+'/adjust',input)).id,saved.id);
    const next=await ok(auth,'/time-records/'+id);assert.equal(next.shift.revision,2);assert.equal(next.corrections[0].original.shift.startedAt,'2026-01-01T08:00:00.000000Z');
    const openId=await card(auth,3,true),source=await ok(auth,'/time-records/'+openId);
    await ok(auth,'/time-records/'+openId+'/adjust',{...input,shiftId:openId,sourceHash:source.sourceHash,commandId:randomUUID(),segments:[{jobId:job,kind:'work',startedAt:'2026-01-03T07:00:00.000Z',endedAt:null}]});
    assert.equal((await ok(auth,'/time-records/'+openId)).shift.ended_at,null);
  });
  test(role+' saves own missing shifts and missed clock-outs without review',async()=>{
    const auth=await person(role),options=await ok(auth,'/time-adjustments/options?employeeId='+auth.actor.id);assert.equal(options.allowedActions.applyDirect,true);
    const input=missing(auth),saved=await ok(auth,'/time-adjustments/direct',input);assert.equal(saved.status,'applied');assert.deepEqual(await ok(auth,'/time-adjustments/direct',input),saved);
    const id=await card(auth,3,true),source=await ok(auth,'/time-adjustments/closure-source?shiftId='+id);assert.equal(source.allowedActions.applyDirect,true);
    await ok(auth,'/time-adjustments/direct',{kind:'close_open_shift',shiftId:id,sourceHash:source.sourceHash,endedAt:'2026-01-03T10:00:00.000Z',reason:'Enter the actual missed clock-out on my own card.',commandId:randomUUID()});
    assert.ok((await ok(auth,'/time-records/'+id)).shift.ended_at);
  });
  test(role+' can resolve their existing time/schedule proposals and directly record own time off',async()=>{
    const auth=await person(role),id=await card(auth),detail=await ok(auth,'/time-records/'+id);
    const proposal=await ok(auth,'/time-corrections',{shiftId:id,sourceRevision:1,sourceHash:detail.sourceHash,commandId:randomUUID(),reason:'Existing own correction can now be resolved directly.',segments:[{jobId:job,kind:'work',startedAt:'2026-01-01T07:30:00.000Z',endedAt:'2026-01-01T10:00:00.000Z'}]});
    await ok(auth,'/time-corrections/'+proposal.id+'/review',{version:1,status:'approved',note:'Apply my existing synthetic correction directly.'});
    const pending=await ok(auth,'/time-adjustments',missing(auth));const pendingDetail=await ok(auth,'/time-adjustments/'+pending.requestId);assert.equal(pendingDetail.allowedActions.approve,true);
    await ok(auth,'/time-adjustments/'+pending.requestId+'/review',{version:1,requestHash:pendingDetail.requestHash,status:'approved',note:'Apply my existing missing-time proposal directly.',commandId:randomUUID()});
    const schedule=await createSchedule(db,auth.actor,{userId:auth.actor.id,jobId:job,startsAt:'2026-02-01T08:00:00.000Z',endsAt:'2026-02-01T10:00:00.000Z',reason:'Synthetic own schedule',note:'',commandId:randomUUID()});
    const scheduleRequest=await ok(auth,'/schedule-requests',{scheduleId:schedule.id,expectedScheduleVersion:1,action:'cancel',reason:'Resolve an existing own scheduled shift proposal.',commandId:randomUUID()});
    assert.equal((await ok(auth,'/schedule-requests/'+scheduleRequest.id)).allowedActions.approve,true);
    await ok(auth,'/schedule-requests/'+scheduleRequest.id+'/review',{expectedRequestVersion:1,proposalHash:scheduleRequest.proposalHash,decision:'approved',note:'Apply my own existing shift proposal.',reviewed:true,commandId:randomUUID()});
    const absence=await ok(auth,'/requests',{kind:'pto',unitId:unit,startsOn:'2026-02-02',endsOn:'2026-02-02',note:'Directly record my synthetic planned time off.'});
    assert.equal((await db.query('SELECT status,reviewer_id FROM requests WHERE id=$1',[absence.id])).rows[0].status,'approved');
  });
  test(role+' can edit their own staff account and keep current authenticated access',async()=>{
    const auth=await person(role),extra=await person('employee');
    await ok(auth,'/staff/'+auth.actor.id,{name:'Updated own '+role,email:auth.actor.email,role,active:true,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,auth.actor.id)},'PATCH');
    assert.equal((await ok(auth,'/me')).actor.name,'Updated own '+role);
    assert.equal((await send(extra,'/staff/'+auth.actor.id,{name:'Forbidden',email:auth.actor.email,role,active:true,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,auth.actor.id)},'PATCH')).status,403);
  });
}
test('developer can provision every role through staff and import previews; admin can manage peer admins',async()=>{
  const dev=await person('developer');
  for(const role of ['developer','owner']){
    await ok(dev,'/staff',{name:'Synthetic new '+role,email:randomUUID()+'@stjw.org',role,unitIds:[unit],jobIds:[job]});
    await ok(dev,'/imports/staff/preview',{csv:`name,email,role,unitIds,jobIds\nSynthetic imported ${role},${randomUUID()}@stjw.org,${role},${unit},${job}`});
  }
  const admin=await person('admin'),peer=await person('admin');
  await ok(admin,'/staff/'+peer.actor.id,{name:'Peer administrator edited',email:peer.actor.email,role:'admin',active:true,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,peer.actor.id)},'PATCH');
});
test('lower-role direct writes, forged privilege and expired proof remain denied',async()=>{
  for(const role of ['employee','manager','finance']){
    const auth=await person(role),id=await card(auth),detail=await ok(auth,'/time-records/'+id);assert.equal(detail.canAdjust,false);
    const input={shiftId:id,sourceRevision:1,sourceHash:detail.sourceHash,reason:'Attempt a forbidden own-card direct save.',commandId:randomUUID(),segments:[{jobId:job,kind:'work',startedAt:'2026-01-01T07:00:00.000Z',endedAt:'2026-01-01T10:00:00.000Z'}]};
    assert.equal((await send(auth,'/time-records/'+id+'/adjust',input)).status,403);
    assert.equal((await send(auth,'/time-adjustments/direct',missing(auth))).status,403);
    const otherUnit=(await db.query('SELECT id FROM units WHERE org_id=$1 AND id<>$2 LIMIT 1',[org,unit])).rows[0].id;
    assert.equal((await send(auth,'/requests',{kind:'pto',unitId:otherUnit,startsOn:'2026-02-02',endsOn:'2026-02-02',note:'Lower roles retain their own exact unit scope.'})).status,403);
  }
  const auth=await person('developer'),id=await card(auth),detail=await ok(auth,'/time-records/'+id);await db.query('DELETE FROM sessions WHERE token_hash=$1',[auth.hash]);
  assert.equal((await send(auth,'/time-records/'+id+'/adjust',{shiftId:id,sourceRevision:1,sourceHash:detail.sourceHash,commandId:randomUUID(),reason:'Expired developer proof must never authorize a write.',segments:[{jobId:job,kind:'work',startedAt:'2026-01-01T07:00:00.000Z',endedAt:'2026-01-01T10:00:00.000Z'}]})).status,401);
});
test('competing own-card saves accept one source and normal clock activity invalidates the captured source',async()=>{
  const auth=await person('developer'),id=await card(auth,3,true),source=await ok(auth,'/time-records/'+id);
  const input={shiftId:id,sourceRevision:1,sourceHash:source.sourceHash,commandId:randomUUID(),reason:'Concurrent own-card correction preserves one source.',segments:[{jobId:job,kind:'work',startedAt:'2026-01-03T07:00:00.000Z',endedAt:null}]};
  const results=await Promise.all([send(auth,'/time-records/'+id+'/adjust',input),send(auth,'/time-records/'+id+'/adjust',{...input,commandId:randomUUID()})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const captured=await ok(auth,'/time-records/'+id);
  await ok(auth,'/clock',{action:'start_break',commandId:randomUUID()});
  assert.equal((await send(auth,'/time-records/'+id+'/adjust',{...input,sourceRevision:2,sourceHash:captured.sourceHash,commandId:randomUUID(),segments:[{...input.segments[0],startedAt:'2026-01-03T06:00:00.000Z'}]})).status,409);
  assert.equal((await ok(auth,'/time-records/'+id)).segments.at(-1).kind,'break');
});
test('migration retains manager self-review denial at the database boundary',async()=>{
  const auth=await person('manager'),pending=await ok(auth,'/time-adjustments',missing(auth));
  await assert.rejects(db.query("UPDATE time_adjustment_requests SET status='declined',version=2,resolved_by=proposed_by,resolver_name=proposer_name,resolution_note='Forbidden raw self review',resolved_at=clock_timestamp() WHERE id=$1",[pending.requestId]),/different manager/);
  assert.equal((await ok(auth,'/time-adjustments/'+pending.requestId)).request.status,'pending');
});
test('an explicitly deactivated own account commits its audit and ends its authenticated access',async()=>{
  const auth=await person('developer');
  const result=await ok(auth,'/staff/'+auth.actor.id,{name:auth.actor.name,email:auth.actor.email,role:'developer',active:false,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,auth.actor.id)},'PATCH');
  assert.equal(result.requiresSignIn,true);assert.equal((await send(auth,'/me')).status,401);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='staff.updated'",[auth.actor.id])).rows[0].n,1);
});
test('an own-role change ends the old privileged session and publishes the saved role',async()=>{
  const auth=await person('developer');
  const result=await ok(auth,'/staff/'+auth.actor.id,{name:auth.actor.name,email:auth.actor.email,role:'employee',active:true,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,auth.actor.id)},'PATCH');
  assert.equal(result.requiresSignIn,true);assert.equal((await send(auth,'/me')).status,401);
  assert.equal((await db.query('SELECT role FROM users WHERE id=$1',[auth.actor.id])).rows[0].role,'employee');
});
test('self deactivation rolls back if final session proof expires during its audit',async()=>{
  const auth=await person('developer');
  const wrapped:Database={...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{
    const result=await tx.query<T>(sql,params);
    if(sql.includes('INSERT INTO audit_events'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[auth.hash]);
    return result;
  }}))};
  await assert.rejects(updateStaffAccount(wrapped,auth.actor,auth.hash,auth.actor.id,{name:auth.actor.name,email:auth.actor.email,role:'developer',active:false,unitIds:[unit],jobIds:[job],expectedRevision:await testStaffRevision(db,auth.actor.id)},'stjw.org'),(error:any)=>error.status===401);
  assert.equal((await ok(auth,'/me')).actor.role,'developer');
  assert.equal((await db.query('SELECT active FROM users WHERE id=$1',[auth.actor.id])).rows[0].active,true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='staff.updated'",[auth.actor.id])).rows[0].n,0);
});

test('direct own time-off entry rolls back when its final password proof expires',async()=>{
  const auth=await person('developer');
  const wrapped:Database={...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{
    const result=await tx.query<T>(sql,params);
    if(sql.includes('INSERT INTO audit_events'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[auth.hash]);
    return result;
  }}))};
  await assert.rejects(createAuthenticatedRequest(wrapped,auth.actor,auth.hash,{kind:'pto',unitId:unit,startsOn:'2026-02-02',endsOn:'2026-02-02',note:'Synthetic direct absence requires final current proof.'}),(error:any)=>error.status===401);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM requests WHERE user_id=$1',[auth.actor.id])).rows[0].n,0);
  assert.equal((await ok(auth,'/me')).actor.role,'developer');
});
