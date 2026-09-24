import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase,migrate,type Database } from '../server/db';
import { initialize } from '../server/seed';
import { audit,digest,hashPassword,issueSetup,opaqueToken,type Actor } from '../server/security';
import { clockCommand,createStaff,reviewRequest,createRequest,createSchedule } from '../server/workforce';
import { aggregateSegments,getReport,toCsv } from '../server/reports';
import { previewStaffImport,applyStaffImport } from '../server/imports';
import { createApp } from '../server/app';
import { normalizePreferences, widgetIds } from '../shared/preferences';
import {createEvents,updateEvent,saveMessage,sendMessage} from '../server/community';
import {eventCreateInput,messageInput} from '../shared/community';
let db:Database,owner:Actor,units:any[],jobs:any[],app:ReturnType<typeof createApp>;
const origin='http://localhost:3000';
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'owner@example.test'});
 const u=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];units=(await db.query('SELECT * FROM units ORDER BY name')).rows;jobs=(await db.query('SELECT * FROM jobs ORDER BY title')).rows;
 owner={id:u.id,org_id:u.org_id,email:u.email,name:u.name,role:'owner',mode:'password',unit_ids:units.map(x=>x.id)};
 app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:true});
});
after(async()=>{await db?.close();});
async function person(role='employee',unit=units[0]){
 const job=jobs.find(x=>x.unit_id===unit.id);
 const email=`${randomUUID()}@stjw.org`;
 const id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic Test Person',email,role:role as any,unitIds:[unit.id],jobIds:[job.id]},'stjw.org'));
 return {actor:{id,org_id:owner.org_id,email,name:'Synthetic Test Person',role,mode:'password',unit_ids:[unit.id]} as Actor,job};
}
async function session(actor:Actor,mode='password',expired=false){
 const token=opaqueToken(),csrf=opaqueToken();await db.query('INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[digest(token),actor.org_id,actor.id,mode,csrf,new Date(Date.now()+(expired?-10000:3600000))]);
 return {cookie:`stjw_session=${token}`,csrf,hash:digest(token)};
}
function post(path:string,auth:{cookie:string;csrf:string},body:any){return request(app).post('/api'+path).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body);}
test('clocking, switching jobs, break, resuming, and clocking out preserve exact boundaries and audit records',async()=>{
 const {actor,job}=await person();const second=jobs.find(j=>j.id!==job.id)!;
 await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[actor.org_id,actor.id,second.unit_id]);
 await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[actor.org_id,actor.id,second.id]);
 const start=Date.parse('2026-09-21T12:00:00Z');
 const actions=[['clock_in',job.id,0],['switch_job',second.id,60],['start_break',undefined,120],['end_break',undefined,150],['clock_out',undefined,240]] as const;
 for(const [action,jobId,minutes] of actions)await clockCommand(db,actor,{action,jobId,commandId:randomUUID()},new Date(start+minutes*60000));
 const rows=(await db.query('SELECT g.* FROM segments g JOIN shifts s ON s.id=g.shift_id WHERE s.user_id=$1 ORDER BY g.started_at',[actor.id])).rows;
 assert.equal(rows.length,4);assert.deepEqual(rows.map(x=>x.kind),['work','work','break','work']);
 for(let i=1;i<rows.length;i++)assert.equal(new Date(rows[i-1].ended_at).getTime(),new Date(rows[i].started_at).getTime());
 const report=await getReport(db,actor,{start:'2026-09-21',end:'2026-09-21',group:'day'},new Date(start+300*60000));
 assert.equal(report.workMs,210*60000);assert.equal(report.breakMs,30*60000);
 assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action LIKE 'clock.%'",[actor.id])).rows.length,5);
});
test('concurrent duplicate commands are idempotent, while competing clocks cannot create two open shifts',async()=>{
 const {actor,job}=await person();const input={action:'clock_in' as const,jobId:job.id,commandId:randomUUID()};
 const results=await Promise.all([clockCommand(db,actor,input),clockCommand(db,actor,input)]);
 assert.equal(results[0].shift.id,results[1].shift.id);
 const retry=await clockCommand(db,actor,input);assert.equal(retry.shift.id,results[0].shift.id);
 await assert.rejects(clockCommand(db,actor,{...input,action:'clock_out'}),/identifier/);
 await assert.rejects(clockCommand(db,actor,{...input,commandId:randomUUID()}),/already clocked/);
 assert.equal((await db.query('SELECT id FROM shifts WHERE user_id=$1 AND ended_at IS NULL',[actor.id])).rows.length,1);
});
test('unassigned jobs and switching during breaks are rejected without changing current state',async()=>{
 const {actor,job}=await person(),foreign=jobs.find(x=>x.id!==job.id)!;
 await assert.rejects(clockCommand(db,actor,{action:'clock_in',jobId:foreign.id,commandId:randomUUID()}),/assigned jobs/);
 await clockCommand(db,actor,{action:'clock_in',jobId:job.id,commandId:randomUUID()});
 await clockCommand(db,actor,{action:'start_break',commandId:randomUUID()});
 await assert.rejects(clockCommand(db,actor,{action:'switch_job',jobId:foreign.id,commandId:randomUUID()}),/End your break/);
 await clockCommand(db,actor,{action:'clock_out',commandId:randomUUID()});
 assert.equal((await db.query('SELECT id FROM shifts WHERE user_id=$1 AND ended_at IS NULL',[actor.id])).rows.length,0);
});
test('session identity, CSRF, PIN restriction, expiration, and forged role headers enforce access',async()=>{
 const {actor,job}=await person(),auth=await session(actor);
 assert.equal((await request(app).get('/api/staff')).status,401);
 assert.equal((await request(app).get('/api/staff').set('Cookie',auth.cookie).set('x-staff-role','owner')).status,403);
 assert.equal((await request(app).post('/api/clock').set('Cookie',auth.cookie).set('Origin',origin).send({action:'clock_in',jobId:job.id,commandId:randomUUID()})).status,403);
 assert.equal((await request(app).post('/api/clock').set('Cookie',auth.cookie).set('Origin','https://attacker.invalid').set('X-CSRF-Token',auth.csrf).send({})).status,403);
 assert.equal((await post('/clock',auth,{action:'clock_in',jobId:job.id,commandId:randomUUID(),userId:owner.id})).status,400);
 const pin=await session(owner,'pin');assert.equal((await request(app).get('/api/staff').set('Cookie',pin.cookie)).status,403);
 assert.equal((await request(app).get('/api/clock').set('Cookie',pin.cookie)).status,200);
 const expired=await session(actor,'password',true);assert.equal((await request(app).get('/api/me').set('Cookie',expired.cookie)).status,401);
});
test('manager permissions do not cross organizational units or permit admin provisioning',async()=>{
 const {actor:manager}=await person('manager',units[0]),auth=await session(manager);
 const foreignJob=jobs.find(x=>x.unit_id===units[1].id)!;
 const result=await post('/staff',auth,{name:'Invalid Scope',email:`${randomUUID()}@stjw.org`,role:'employee',unitIds:[units[1].id],jobIds:[foreignJob.id]});assert.equal(result.status,403);
 const elevated=await post('/staff',auth,{name:'Invalid Role',email:`${randomUUID()}@stjw.org`,role:'admin',unitIds:[units[0].id],jobIds:[]});assert.equal(elevated.status,403);
 const {actor:other,job}=await person('employee',units[1]);await clockCommand(db,other,{action:'clock_in',jobId:job.id,commandId:randomUUID()});
 const board=await request(app).get('/api/board').set('Cookie',auth.cookie);assert.equal(board.status,200);assert.ok(board.body.rows.every((r:any)=>r.unit_id===units[0].id));
 const report=await getReport(db,manager,{start:'2026-01-01',end:'2026-12-31',group:'month'});assert.ok(report.rows.every(r=>r.unit_id===units[0].id));
 const foreignOrg=randomUUID(),foreignUnit=randomUUID();await db.query('INSERT INTO organizations(id,name,timezone) VALUES($1,$2,$3)',[foreignOrg,'Other Org','America/New_York']);await db.query('INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,$4)',[foreignUnit,foreignOrg,'Foreign School','school']);
 assert.equal((await post('/jobs',await session(owner),{unitId:foreignUnit,title:'Cannot cross organization'})).status,404);
});
test('requests require another scoped manager; decisions are atomic and do not modify time records',async()=>{
 const {actor}=await person('manager',units[0]);const input={kind:'correction' as const,unitId:units[0].id,startsOn:'2026-09-21',endsOn:'2026-09-21',note:'Synthetic missed punch at 8 AM.'};
 const record=await createRequest(db,actor,input);await assert.rejects(reviewRequest(db,actor,record.id,'approved','Self approval'),/different manager/);
 const {actor:outside}=await person('manager',units[1]);await assert.rejects(reviewRequest(db,outside,record.id,'approved','Outside scope'),/outside your access/);
 await reviewRequest(db,owner,record.id,'approved','Confirmed, requires an explicit correction.');
 await assert.rejects(reviewRequest(db,owner,record.id,'declined','Second decision'),/already been reviewed/);
 assert.equal((await db.query('SELECT id FROM shifts WHERE user_id=$1',[actor.id])).rows.length,0);
});
test('scheduled shifts require assigned jobs and reject overlapping shifts',async()=>{
 const {actor,job}=await person();const input={userId:actor.id,jobId:job.id,startsAt:'2026-09-23T12:00:00Z',endsAt:'2026-09-23T20:00:00Z',note:'Synthetic schedule'};
 await createSchedule(db,owner,{...input,reason:'Initial synthetic schedule',commandId:randomUUID()});await assert.rejects(createSchedule(db,owner,{...input,reason:'Competing synthetic schedule',commandId:randomUUID()}),/already has a shift/);
 const foreign=jobs.find(x=>x.id!==job.id)!;await assert.rejects(createSchedule(db,owner,{...input,jobId:foreign.id,reason:'Invalid synthetic schedule',commandId:randomUUID()}),/not assigned/);
});
test('staff imports have deterministic previews, transactional apply, and replay protection',async()=>{
 const job=jobs.find(j=>j.unit_id===units[0].id)!,email=`${randomUUID()}@stjw.org`,auth=await session(owner);
 const csv=`name,email,role,unitIds,jobIds\nSynthetic Import,${email},employee,${units[0].id},${job.id}`;
 const preview=await previewStaffImport(db,owner,csv,'stjw.org',auth.hash);assert.equal(preview.count,1);assert.equal((await db.query('SELECT id FROM users WHERE email=$1',[email])).rows.length,0);
 await assert.rejects(applyStaffImport(db,owner,preview.id,'0'.repeat(64),'stjw.org',auth.hash),/not found/);
 const result=await applyStaffImport(db,owner,preview.id,preview.sourceHash,'stjw.org',auth.hash);assert.equal(result.created,1);
 assert.deepEqual(await applyStaffImport(db,owner,preview.id,preview.sourceHash,'stjw.org',auth.hash),result);
 await assert.rejects(previewStaffImport(db,owner,csv,'stjw.org',auth.hash),/already has an account/);
 const missing=csv.replace('role,unitIds','other,unitIds');await assert.rejects(previewStaffImport(db,owner,missing,'stjw.org',auth.hash),/exact headers/);
 assert.ok(toCsv([{name:' =HYPERLINK("bad")'}],['name']).includes("' =HYPERLINK"));
});
test('private setup links are single-use; password login and PIN login use different sessions',async()=>{
 const {actor}=await person();const setup=await db.transaction(tx=>issueSetup(tx,actor));const password='Test!826';
 const tooShort=await request(app).post('/api/auth/setup').set('Origin',origin).send({token:setup,password:'Short!7'});assert.equal(tooShort.status,400);
 const response=await request(app).post('/api/auth/setup').set('Origin',origin).send({token:setup,password});assert.equal(response.status,200);assert.ok(response.headers['set-cookie'][0].includes('HttpOnly'));assert.ok(response.headers['set-cookie'][0].includes('SameSite=Strict'));
 assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token:setup,password})).status,400);
 const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(login.status,200);
 const wrong=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:'incorrect',mode:'password'});assert.equal(wrong.status,401);
 const auth=await session(actor);assert.equal((await post('/auth/pin',auth,{password,pin:'782619'})).status,200);
 const pin=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:'782619',mode:'pin'});assert.equal(pin.status,200);
 const cookie=pin.headers['set-cookie'][0].split(';')[0];assert.equal((await request(app).get('/api/reports?start=2026-09-21&end=2026-09-22').set('Cookie',cookie)).status,403);
});
test('immutable audit rows, read-only API tokens, revocation, and security headers',async()=>{
 const auth=await session(owner);const issued=await post('/tokens',auth,{name:'Synthetic reporting integration',days:1,scopes:['reports:read']});assert.equal(issued.status,200);
 const token=issued.body.token;const report=await request(app).get('/api/reports?start=2026-09-21&end=2026-09-22').set('Authorization',`Bearer ${token}`);assert.equal(report.status,200);assert.equal(report.headers['cache-control'],'no-store');assert.match(report.headers['content-security-policy'],/frame-ancestors 'none'/);assert.ok(!report.headers['x-powered-by']);
 assert.equal((await request(app).get('/api/staff').set('Authorization',`Bearer ${token}`)).status,403);
 assert.equal((await request(app).post('/api/clock').set('Origin',origin).set('Authorization',`Bearer ${token}`).send({})).status,403);
 await post(`/tokens/${issued.body.id}/revoke`,auth,{});assert.equal((await request(app).get('/api/reports?start=2026-09-21&end=2026-09-22').set('Authorization',`Bearer ${token}`)).status,403);
 await assert.rejects(db.query("UPDATE audit_events SET action='tampered' WHERE org_id=$1",[owner.org_id]),/append-only/);
});
test('DST, midnight clipping, month boundaries, and subsecond precision conserve elapsed time',()=>{
 const row=(start:string,end:string)=>({user_id:'a',employee_name:'Synthetic',kind:'work',started_at:start,ended_at:end});
 const fall=aggregateSegments([row('2026-11-01T04:00:00Z','2026-11-02T05:00:00Z')],{start:'2026-11-01',end:'2026-11-01',group:'hour'},'America/New_York',new Date('2026-11-03'));
 assert.equal(fall.workMs,25*3600000);assert.equal(fall.buckets.length,25);assert.equal(fall.buckets.reduce((s,x)=>s+x.workMs,0),fall.workMs);
 const spring=aggregateSegments([row('2026-03-08T05:00:00Z','2026-03-09T04:00:00Z')],{start:'2026-03-08',end:'2026-03-08',group:'day'},'America/New_York',new Date('2026-03-10'));assert.equal(spring.workMs,23*3600000);
 const clipped=aggregateSegments([row('2026-09-21T03:59:59.500Z','2026-09-21T04:00:00.500Z')],{start:'2026-09-21',end:'2026-09-21',group:'day'},'America/New_York',new Date('2026-09-22'));assert.equal(clipped.workMs,500);
 const month=aggregateSegments([row('2026-09-30T23:00:00Z','2026-10-01T05:00:00Z')],{start:'2026-09-30',end:'2026-10-01',group:'month'},'America/New_York',new Date('2026-10-02'));assert.deepEqual(month.buckets.map(x=>x.workMs),[5*3600000,3600000]);
});
test('export duration clips boundary-spanning segments while preserving original timestamps',async()=>{
 const {actor,job}=await person();
 await clockCommand(db,actor,{action:'clock_in',jobId:job.id,commandId:randomUUID()},new Date('2026-09-21T03:00:00Z'));
 await clockCommand(db,actor,{action:'clock_out',commandId:randomUUID()},new Date('2026-09-22T05:00:00Z'));
 const report=await getReport(db,actor,{start:'2026-09-21',end:'2026-09-21',group:'day'},new Date('2026-09-23'));
 assert.equal(report.rows.length,1);assert.equal(report.rows[0].duration_seconds,24*3600);assert.equal(report.workMs,report.rows[0].duration_seconds*1000);
 assert.equal(new Date(report.rows[0].started_at).toISOString(),'2026-09-21T03:00:00.000Z');
 const auth=await session(actor);const response=await request(app).get('/api/reports/export?start=2026-09-21&end=2026-09-21&columns=duration_seconds').set('Cookie',auth.cookie);
 assert.equal(response.status,200);assert.match(response.text,/"86400"/);
 assert.equal((await request(app).get('/api/reports?start=2026-02-30&end=2026-03-01').set('Cookie',auth.cookie)).status,400);
});
test('staff edits preserve before/after audit history and revoke old sessions',async()=>{
 const {actor,job}=await person(),oldSession=await session(actor),admin=await session(owner);
 const input={name:'Updated Synthetic Person',email:actor.email,role:'employee',active:true,unitIds:actor.unit_ids,jobIds:[job.id]};
 const result=await request(app).patch(`/api/staff/${actor.id}`).set('Origin',origin).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).send(input);
 assert.equal(result.status,200);assert.equal((await request(app).get('/api/me').set('Cookie',oldSession.cookie)).status,401);
 const event=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND action='staff.updated'",[actor.id])).rows[0];
 assert.equal(event.detail.before.name,actor.name);assert.equal(event.detail.after.name,input.name);assert.deepEqual(event.detail.before.jobIds,[job.id]);assert.ok(!('password_hash' in event.detail.before));
});
test('personalization persists across sessions and partial changes retain other account preferences',async()=>{
 const {actor}=await person(),auth=await session(actor);
 const patch=(body:object)=>request(app).patch('/api/me/preferences').set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body);
 const chosen={theme:'dark',accent:'violet',customColor:'#17a8c2',artwork:'subtle',depth:false,contrast:'high',textSize:'large',navigation:'rail',corners:'crisp',compact:false,reducedMotion:true,home:'clock',widgetOrder:['clock','metrics','people','requests','hours','community'],hiddenWidgets:['community']};
 assert.equal((await patch(chosen)).status,200);
 const partial=await patch({compact:true});assert.equal(partial.status,200);assert.equal(partial.body.preferences.accent,'violet');assert.equal(partial.body.preferences.theme,'dark');assert.equal(partial.body.preferences.compact,true);
 const second=await session(actor);const read=await request(app).get('/api/me').set('Cookie',second.cookie);assert.deepEqual(read.body.actor.preferences,{...chosen,compact:true,workspaceNavOrder:['overview','clock','time-records','payroll','staff','schedule','calendar','messages','requests','reports'],organizationNavOrder:['school','care','dismissal','workspace','audit','settings']});
 const isolated=await request(app).get('/api/me').set('Cookie',(await session(owner)).cookie);assert.notEqual(isolated.body.actor.preferences.accent,'violet');
});
test('personalization rejects injected fields, inaccessible landing pages, invalid and empty dashboards, and PIN writes',async()=>{
 const {actor}=await person(),auth=await session(actor);
 const patch=(body:object,cookie=auth.cookie,csrf=auth.csrf)=>request(app).patch('/api/me/preferences').set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',csrf).send(body);
 assert.equal((await patch({userId:owner.id,accent:'rose'})).status,400);
 assert.equal((await patch({accent:'url(https://untrusted.invalid)'})).status,400);
 assert.equal((await patch({customColor:'url(https://untrusted.invalid)'})).status,400);
 assert.equal((await patch({artwork:'<script>'})).status,400);
 assert.equal((await patch({depth:'true'})).status,400);
 assert.equal((await patch({widgetOrder:['clock','clock','people','requests','hours','community']})).status,400);
 assert.equal((await patch({hiddenWidgets:widgetIds})).status,400);
 assert.equal((await patch({home:'reports'})).status,403);
 const pin=await session(actor,'pin');assert.equal((await patch({theme:'dark'},pin.cookie,pin.csrf)).status,403);
 const read=await request(app).get('/api/me').set('Cookie',auth.cookie);assert.deepEqual(read.body.actor.preferences,{});
 assert.equal(normalizePreferences({theme:'dark',compact:true,home:'clock'}).accent,'cobalt');
});


test('new migrations apply once and preserve existing accounts',async()=>{
 const before=(await db.query('SELECT count(*)::integer AS count FROM users')).rows[0].count;
 await migrate(db);await migrate(db);
 assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34]);
 assert.equal((await db.query('SELECT count(*)::integer AS count FROM users')).rows[0].count,before);
});
const eventFixture=(overrides:any={})=>eventCreateInput.parse({event:{title:'Synthetic planning',startsAt:'2026-10-25T13:00:00.000Z',endsAt:'2026-10-25T14:00:00.000Z',timezone:'America/New_York',audience:'personal',...overrides},repeat:{frequency:'weekly',interval:1,count:3}});
test('calendar recurrence preserves local time across DST, records revisions and prevents stale edits',async()=>{
 const {actor}=await person();const {rows}=await createEvents(db,actor,eventFixture());
 assert.deepEqual(rows.map(row=>new Date(row.starts_at).toISOString()),['2026-10-25T13:00:00.000Z','2026-11-01T14:00:00.000Z','2026-11-08T14:00:00.000Z']);
 const changed=await updateEvent(db,actor,rows[1].id,{event:{...eventFixture().event,title:'Updated occurrence'},version:1});assert.equal(changed.version,2);
 await assert.rejects(()=>updateEvent(db,actor,rows[1].id,{event:eventFixture().event,version:1}),/changed/);
 assert.equal((await db.query('SELECT title FROM calendar_events WHERE id=$1',[rows[0].id])).rows[0].title,'Synthetic planning');
 assert.equal((await db.query('SELECT version FROM calendar_revisions WHERE event_id=$1',[rows[1].id])).rows.length,2);
 const before=(await db.query('SELECT count(*)::integer AS count FROM calendar_events')).rows[0].count;
 await assert.rejects(()=>createEvents(db,actor,eventCreateInput.parse({event:{...eventFixture().event,startsAt:'2027-03-07T07:30:00.000Z',endsAt:'2027-03-07T08:30:00.000Z'},repeat:{frequency:'weekly',interval:1,count:2}})),/does not exist/);
 assert.equal((await db.query('SELECT count(*)::integer AS count FROM calendar_events')).rows[0].count,before);
});
test('calendar enforces personal, unit, tenant and PIN boundaries including history and audience changes',async()=>{
 const {actor:a}=await person('manager',units[0]),{actor:b}=await person('employee',units[1]);const authA=await session(a),authB=await session(b),ownerAuth=await session(owner);
 const created=await createEvents(db,a,eventFixture());const personal=created.rows[0];
 const range='?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z';
 const own=await request(app).get('/api/calendar/events'+range).set('Cookie',authA.cookie);assert.ok(own.body.rows.some((r:any)=>r.id===personal.id));
 const other=await request(app).get('/api/calendar/events'+range).set('Cookie',authB.cookie);assert.ok(!other.body.rows.some((r:any)=>r.id===personal.id));
 assert.equal((await request(app).get('/api/calendar/events/'+personal.id+'/history').set('Cookie',ownerAuth.cookie)).status,404);
 const shared=(await createEvents(db,a,eventFixture({audience:'unit',unitId:units[0].id}))).rows[0];
 assert.equal((await request(app).get('/api/calendar/events/'+shared.id+'/history').set('Cookie',authB.cookie)).status,404);
 assert.equal((await post('/calendar/events/'+shared.id+'/cancel',authB,{version:1})).status,404);
 await assert.rejects(()=>createEvents(db,a,eventFixture({audience:'unit',unitId:units[1].id})),/outside/);
 await assert.rejects(()=>createEvents(db,a,eventFixture({audience:'organization'})),/administrator/);
 await assert.rejects(()=>updateEvent(db,a,personal.id,{event:eventFixture({audience:'unit',unitId:units[0].id}).event,version:1}),/audience unchanged/);
 const pin=await session(a,'pin');assert.equal((await request(app).get('/api/calendar/events'+range).set('Cookie',pin.cookie)).status,403);
 assert.equal((await post('/calendar/events/'+shared.id+'/cancel',authA,{version:1})).status,200);
 assert.equal((await post('/calendar/events/'+shared.id+'/cancel',authA,{version:1})).status,409);
 const invisible=(await request(app).get('/api/calendar/events'+range).set('Cookie',authA.cookie)).body.rows;assert.ok(!invisible.some((r:any)=>r.id===shared.id));
 const foreign={...owner,org_id:randomUUID()};await assert.rejects(()=>updateEvent(db,foreign,shared.id,{event:eventFixture().event,version:1}),/not found/);
});
test('messages keep drafts private, validate current recipients on send and deliver once under concurrent sends',async()=>{
 const {actor:sender}=await person(),{actor:recipient}=await person(),{actor:outside}=await person('employee',units[1]);
 const senderAuth=await session(sender),recipientAuth=await session(recipient),outsideAuth=await session(outside),ownerAuth=await session(owner);
 const input=messageInput.parse({subject:'Synthetic private note',body:'Synthetic message body',recipientIds:[recipient.id]});
 let draft=await saveMessage(db,sender,input);
 assert.equal((await request(app).get('/api/messages/'+draft.id).set('Cookie',recipientAuth.cookie)).status,404);
 assert.equal((await request(app).get('/api/messages/'+draft.id).set('Cookie',ownerAuth.cookie)).status,404);
 await assert.rejects(()=>saveMessage(db,sender,{...input,recipientIds:[outside.id]}),/outside/);
 await assert.rejects(()=>saveMessage(db,sender,input,draft.id,999),/changed/);
 draft=await saveMessage(db,sender,{...input,body:'Reviewed synthetic body'},draft.id,1);
 assert.equal((await post('/messages/'+draft.id+'/send',senderAuth,{version:1})).status,409);
 await db.query('UPDATE users SET active=false WHERE id=$1',[recipient.id]);
 await assert.rejects(()=>sendMessage(db,sender,draft.id,draft.version),/inactive/);
 await db.query('UPDATE users SET active=true WHERE id=$1',[recipient.id]);
 const sent=await Promise.all([sendMessage(db,sender,draft.id,draft.version),sendMessage(db,sender,draft.id,draft.version)]);assert.equal(new Date(sent[0].sent_at).getTime(),new Date(sent[1].sent_at).getTime());
 assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='message.sent'",[draft.id])).rows.length,1);
 const delivered=await request(app).get('/api/messages/'+draft.id).set('Cookie',recipientAuth.cookie);assert.equal(delivered.status,200);assert.equal(delivered.body.body,'Reviewed synthetic body');
 assert.equal((await request(app).get('/api/messages/'+draft.id).set('Cookie',outsideAuth.cookie)).status,404);
 assert.equal((await request(app).get('/api/messages/'+draft.id).set('Cookie',ownerAuth.cookie)).status,404);
 await assert.rejects(()=>saveMessage(db,sender,input,draft.id,draft.version),/cannot be edited/);
 const inbox=await request(app).get('/api/messages?folder=inbox').set('Cookie',recipientAuth.cookie);assert.ok(inbox.body.rows.some((r:any)=>r.id===draft.id));assert.equal(inbox.body.unread,1);
 const patch=(path:string,auth:any,body:any)=>request(app).patch('/api'+path).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body);
 assert.equal((await patch('/messages/'+draft.id+'/state',outsideAuth,{read:true})).status,404);
 assert.equal((await patch('/messages/'+draft.id+'/state',recipientAuth,{read:true,archived:true})).status,200);
 const archived=await request(app).get('/api/messages?folder=archive').set('Cookie',recipientAuth.cookie);assert.ok(archived.body.rows.some((r:any)=>r.id===draft.id));assert.equal(archived.body.unread,0);
 const readback=await request(app).get('/api/messages/'+draft.id).set('Cookie',senderAuth.cookie);assert.ok(readback.body.recipients[0].read_at);
 const reply=await saveMessage(db,recipient,messageInput.parse({subject:'Re: synthetic',body:'A reply',recipientIds:[sender.id],replyTo:draft.id}));assert.equal(reply.reply_to,draft.id);
 await assert.rejects(()=>saveMessage(db,outside,{...input,recipientIds:[owner.id],replyTo:draft.id}),/not found/);
 const pin=await session(sender,'pin');assert.equal((await request(app).get('/api/messages').set('Cookie',pin.cookie)).status,403);
 const auditRows=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1",[draft.id])).rows;assert.ok(!JSON.stringify(auditRows).includes('Reviewed synthetic body'));
});
