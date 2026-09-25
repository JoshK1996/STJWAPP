import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {clockCommand,clockState,createStaff} from '../server/workforce';
import {digest,opaqueToken,type Actor} from '../server/security';
import {applyDirectTimeAdjustment,proposeTimeAdjustment,reviewTimeAdjustment,cancelTimeAdjustment,getTimeAdjustment,getTimeAdjustmentSource,getTimeAdjustmentOptions,getTimeAdjustmentHistory,exportTimeAdjustment,listTimeAdjustments,listOpenTimeShifts} from '../server/time-adjustments';
import {proposeCorrection,reviewCorrection,timeRecordDetail} from '../server/time-records';
import {getReport} from '../server/reports';
import {timeMicroseconds} from '../server/time-record-access';
import {adjustmentDefinitionHash,validateTimeEnvelope} from '../server/time-adjustment-export';
import {proposeTimeAdjustmentInput} from '../shared/time-adjustments';
import {initialDefinition,reportDefinition} from '../shared/report-library';
import {saveReport} from '../server/report-library';
import {prepareReportSnapshot,captureReportSnapshot,readReportSnapshot} from '../server/report-snapshots';
let db:Database,owner:Actor,ownerAuth:Auth,units:any[],jobs:any[],app:ReturnType<typeof createApp>;
const origin='http://localhost:3000',at=(minute:number)=>new Date(Date.UTC(2025,10,2,5,0)+minute*60000).toISOString();
type Auth={hash:string;cookie:string;csrf:string};
async function session(actor:Actor,mode='password'):Promise<Auth>{const token=opaqueToken(),csrf=opaqueToken();await db.query('INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval \'1 hour\')',[digest(token),actor.org_id,actor.id,mode,csrf]);return {hash:digest(token),cookie:'stjw_session='+token,csrf};}
before(async()=>{db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'adjustment.owner@example.test'});const row=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];units=(await db.query('SELECT * FROM units ORDER BY name')).rows;jobs=(await db.query('SELECT * FROM jobs ORDER BY title')).rows;owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:'owner',mode:'password',unit_ids:units.map(u=>u.id)};ownerAuth=await session(owner);app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:true});});
after(async()=>{await db?.close();});
async function person(role:Actor['role']='employee',unitIndex=0){const unit=units[unitIndex],job=jobs.find(j=>j.unit_id===unit.id),email=randomUUID()+'@stjw.org';const id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic adjustment '+role,email,role:role as "employee"|"manager"|"finance"|"admin",unitIds:[unit.id],jobIds:[job.id]},'stjw.org'));const actor:Actor={id,org_id:owner.org_id,name:'Synthetic adjustment '+role,email,role,unit_ids:[unit.id],mode:'password'};return {actor,auth:await session(actor),job};}
type Person=Awaited<ReturnType<typeof person>>;
const missing=(p:Person,start=0,end=90)=>({kind:'missing_shift' as const,employeeId:p.actor.id,segments:[{jobId:p.job.id,kind:'work' as const,startedAt:at(start),endedAt:at(end)}],reason:'Synthetic missing recorded work for independent review.',commandId:randomUUID()});
async function proposed(p:Person,input=missing(p)){const saved=await proposeTimeAdjustment(db,p.actor,p.auth.hash,input);return {saved,input,detail:await getTimeAdjustment(db,p.actor,p.auth.hash,saved.result.requestId)};}
const approve=(d:any)=>({version:1,requestHash:d.requestHash,status:'approved',note:'Independently reviewed synthetic recorded events.',commandId:randomUUID()});
async function open(p:Person,start=0){const state=await clockCommand(db,p.actor,{action:'clock_in',jobId:p.job.id,commandId:randomUUID()},new Date(at(start)));return state.shift.id as string;}
async function closure(p:Person,shiftId:string,end=90){const source=await getTimeAdjustmentSource(db,p.actor,p.auth.hash,{shiftId});const input={kind:'close_open_shift',shiftId,sourceHash:source.sourceHash,endedAt:at(end),reason:'Synthetic missing final clock-out reviewed separately.',commandId:randomUUID()};const saved=await proposeTimeAdjustment(db,p.actor,p.auth.hash,input);return {source,input,saved,detail:await getTimeAdjustment(db,p.actor,p.auth.hash,saved.result.requestId)};}
function intercept(operation:(sql:string,params:any[],tx:Queryable)=>Promise<void>):Database{return {...db,transaction:fn=>db.transaction(tx=>fn({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{await operation(sql,params,tx);return tx.query<T>(sql,params);}}))};}
const post=(path:string,body:unknown,auth:Auth)=>request(app).post('/api'+path).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body as object);

test('administrator missing time saves immediately with one honest applied history and exact lost-response replay',async()=>{
 const p=await person(),admin=await person('admin'),input=missing(p),saved=await applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,input),id=saved.result.requestId;
 assert.equal(saved.result.status,'applied');assert.equal(saved.result.version,1);assert.equal(saved.result.resultRevision,1);
 const detail=await getTimeAdjustment(db,p.actor,p.auth.hash,id),history=await getTimeAdjustmentHistory(db,admin.actor,admin.auth.hash,id);
 assert.equal(detail.result!.totals!.workMicroseconds,'5400000000');assert.deepEqual(detail.allowedActions,{approve:false,decline:false,cancel:false});
 assert.equal(detail.request.proposedBy.id,admin.actor.id);assert.equal(detail.request.resolvedBy!.id,admin.actor.id);assert.equal(history.items.length,1);assert.equal(history.items[0].action,'applied');
 assert.deepEqual((await applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,input)).result,saved.result);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM shifts WHERE user_id=$1',[p.actor.id])).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='time_adjustment.applied'",[id])).rows[0].n,1);
 await assert.rejects(applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,{...input,reason:'A different reason for a reused command.'}),/different/);
 await assert.rejects(proposeTimeAdjustment(db,admin.actor,admin.auth.hash,input),/different/);
 await assert.rejects(reviewTimeAdjustment(db,owner,ownerAuth.hash,id,approve(detail)),/resolved|changed/);
 const csv=await exportTimeAdjustment(db,admin.actor,admin.auth.hash,id,{format:'csv',version:'1'});assert.equal(digest(csv.text),csv.hash);assert.match(csv.text,/applied/);
 for(const [table,where] of [['time_adjustment_requests','id'],['time_adjustment_history','request_id'],['time_adjustment_commands','request_id']])await assert.rejects(db.query(`DELETE FROM ${table} WHERE ${where}=$1`,[id]),/deleted|immutable|append-only/i);
 await assert.rejects(db.query("UPDATE time_adjustment_requests SET reason='Attempted terminal evidence rewrite' WHERE id=$1",[id]),/immutable/);
 assert.equal((await listTimeAdjustments(db,admin.actor,admin.auth.hash,{start:'2025-11-02',end:'2025-11-02',employeeId:p.actor.id,status:'applied'})).items[0].id,id);
 assert.equal((await listTimeAdjustments(db,admin.actor,admin.auth.hash,{sourceShiftId:saved.result.resultShiftId})).items[0].id,id);
});

test('direct closure preserves precise original events, updates clocks/reports and stales an older review request',async()=>{
 const p=await person(),shiftId=await open(p);await db.query("UPDATE segments SET started_at='2025-11-02T05:00:00.000001Z' WHERE shift_id=$1",[shiftId]);await db.query("UPDATE shifts SET started_at='2025-11-02T05:00:00.000001Z' WHERE id=$1",[shiftId]);
 await clockCommand(db,p.actor,{action:'start_break',commandId:randomUUID()},new Date(at(30)));await clockCommand(db,p.actor,{action:'end_break',commandId:randomUUID()},new Date(at(40)));
 const old=await closure(p,shiftId),original=(await db.query('SELECT * FROM segments WHERE shift_id=$1 AND revision=1 ORDER BY started_at',[shiftId])).rows;
 const source=await getTimeAdjustmentSource(db,owner,ownerAuth.hash,{shiftId});assert.equal(source.allowedActions.applyDirect,true);
 const saved=await applyDirectTimeAdjustment(db,owner,ownerAuth.hash,{...old.input,sourceHash:source.sourceHash,commandId:randomUUID()});
 assert.equal(saved.result.resultRevision,2);assert.deepEqual((await db.query('SELECT * FROM segments WHERE shift_id=$1 AND revision=1 ORDER BY started_at',[shiftId])).rows,original);
 const detail=await getTimeAdjustment(db,owner,ownerAuth.hash,saved.result.requestId);assert.equal(detail.request.source!.segments.at(-1)!.endedAt,null);assert.equal(detail.result!.segments[0].startedAt,'2025-11-02T05:00:00.000001Z');assert.equal(detail.result!.totals!.workMicroseconds,'4799999999');
 assert.equal((await clockState(db,p.actor)).shift,null);assert.equal((await getTimeAdjustment(db,owner,ownerAuth.hash,old.saved.result.requestId)).readiness.state,'stale');
 // This legacy chart API displays milliseconds; exact microseconds are asserted above.
 const report=await getReport(db,p.actor,{start:'2025-11-02',end:'2025-11-02',group:'hour'});assert.equal(report.workMs,4800000);assert.equal(report.breakMs,600000);
});

test('direct saves enforce fresh administrator role, other-employee rule, password session and same authority on retry',async()=>{
 const p=await person(),admin=await person('admin'),manager=await person('manager'),finance=await person('finance');
 for(const actor of [p,manager,finance])await assert.rejects(applyDirectTimeAdjustment(db,actor.actor,actor.auth.hash,missing(p)),(e:any)=>e.status===403);
 await assert.rejects(applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,missing(admin)),/another employee/);
 assert.equal((await getTimeAdjustmentOptions(db,admin.actor,admin.auth.hash,{employeeId:p.actor.id})).allowedActions.applyDirect,true);
 assert.equal((await getTimeAdjustmentOptions(db,admin.actor,admin.auth.hash,{employeeId:admin.actor.id})).allowedActions.applyDirect,false);
 assert.equal((await getTimeAdjustmentOptions(db,manager.actor,manager.auth.hash,{employeeId:p.actor.id})).allowedActions.applyDirect,false);
 const input=missing(p),saved=await applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,input);assert.equal(saved.result.status,'applied');
 await db.query("UPDATE users SET role='manager' WHERE id=$1",[admin.actor.id]);await assert.rejects(applyDirectTimeAdjustment(db,admin.actor,admin.auth.hash,input),(e:any)=>e.status===403);
 await assert.rejects(applyDirectTimeAdjustment(db,{...manager.actor,role:'admin'},manager.auth.hash,missing(await person())),(e:any)=>e.status===403);
 const pin=await session(owner,'pin');await assert.rejects(applyDirectTimeAdjustment(db,{...owner,mode:'pin'},pin.hash,missing(await person())),/password/);
 const revoked=await session(owner);await db.query('DELETE FROM sessions WHERE token_hash=$1',[revoked.hash]);await assert.rejects(applyDirectTimeAdjustment(db,owner,revoked.hash,missing(await person())),(e:any)=>e.status===401);
});

test('direct edits reject changed open sources, overlaps, future times and unavailable assignments',async()=>{
 const p=await person(),shiftId=await open(p),source=await getTimeAdjustmentSource(db,owner,ownerAuth.hash,{shiftId});
 const input={kind:'close_open_shift',shiftId,sourceHash:source.sourceHash,endedAt:at(90),reason:'Administrator fixing a forgotten clock-out.',commandId:randomUUID()};
 await clockCommand(db,p.actor,{action:'start_break',commandId:randomUUID()},new Date(at(10)));
 await assert.rejects(applyDirectTimeAdjustment(db,owner,ownerAuth.hash,input),/changed/);assert.ok((await clockState(db,p.actor)).shift);
 const q=await person();await applyDirectTimeAdjustment(db,owner,ownerAuth.hash,missing(q));await assert.rejects(applyDirectTimeAdjustment(db,owner,ownerAuth.hash,missing(q,10,100)),/overlaps/);
 const r=await person(),future=missing(r);future.segments[0].endedAt='2099-11-02T06:00:00.000Z';await assert.rejects(applyDirectTimeAdjustment(db,owner,ownerAuth.hash,future),/future/);
 await db.query('DELETE FROM user_jobs WHERE user_id=$1',[r.actor.id]);await assert.rejects(applyDirectTimeAdjustment(db,owner,ownerAuth.hash,missing(r)),/assigned/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM shifts WHERE user_id=$1',[r.actor.id])).rows[0].n,0);
});

test('competing direct saves serialize, exact command races replay and final authorization/audit failures roll back',async()=>{
 const p=await person(),input=missing(p),same=await Promise.all([applyDirectTimeAdjustment(db,owner,ownerAuth.hash,input),applyDirectTimeAdjustment(db,owner,ownerAuth.hash,input)]);
 assert.deepEqual(same[0].result,same[1].result);assert.equal(same.filter(value=>value.replayed).length,1);
 const q=await person(),competing=await Promise.allSettled([applyDirectTimeAdjustment(db,owner,ownerAuth.hash,missing(q)),applyDirectTimeAdjustment(db,owner,ownerAuth.hash,missing(q))]);assert.equal(competing.filter(value=>value.status==='fulfilled').length,1);
 for(const mode of ['audit','session']) {
  const r=await person(),bad=intercept(async(sql,_params,tx)=>{if(sql.includes('INSERT INTO audit_events')){if(mode==='audit')throw Error('synthetic direct audit failure');await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[ownerAuth.hash]);}});
  await assert.rejects(applyDirectTimeAdjustment(bad,owner,ownerAuth.hash,missing(r)),mode==='audit'?/synthetic direct audit failure/:(e:any)=>e.status===401);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM shifts WHERE user_id=$1',[r.actor.id])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM time_adjustment_requests WHERE user_id=$1',[r.actor.id])).rows[0].n,0);
 }
});

test('direct HTTP endpoint enforces CSRF/password/strict inputs and returns the same private receipt on retry',async()=>{
 const p=await person(),input=missing(p),path='/api/time-adjustments/direct';
 assert.equal((await request(app).post(path).set('Origin',origin).send(input)).status,401);
 assert.equal((await request(app).post(path).set('Origin',origin).set('Cookie',ownerAuth.cookie).send(input)).status,403);
 assert.equal((await request(app).post(path).set('Origin','https://foreign.example.test').set('Cookie',ownerAuth.cookie).set('X-CSRF-Token',ownerAuth.csrf).send(input)).status,403);
 const pin=await session(owner,'pin');assert.equal((await post('/time-adjustments/direct',input,pin)).status,403);
 assert.equal((await post('/time-adjustments/direct',{...input,orgId:owner.org_id},ownerAuth)).status,400);
 const response=await post('/time-adjustments/direct',input,ownerAuth);assert.equal(response.status,201);assert.equal(response.body.status,'applied');assert.match(response.headers['cache-control'],/no-store/);
 const retry=await post('/time-adjustments/direct',input,ownerAuth);assert.equal(retry.status,200);assert.deepEqual(retry.body,response.body);
});

test('missing proposal does not write time; independent approval, exact receipts and immutable evidence',async()=>{
 const p=await person(),proposal=await proposed(p),id=proposal.saved.result.requestId;
 assert.equal((await db.query('SELECT count(*)::int AS n FROM shifts WHERE user_id=$1',[p.actor.id])).rows[0].n,0);
 const input=approve(proposal.detail),saved=await reviewTimeAdjustment(db,owner,ownerAuth.hash,id,input);
 assert.equal(saved.result.resultRevision,1);assert.equal(saved.result.status,'approved');
 assert.deepEqual((await reviewTimeAdjustment(db,owner,ownerAuth.hash,id,input)).result,saved.result);
 assert.deepEqual((await proposeTimeAdjustment(db,p.actor,p.auth.hash,proposal.input)).result,proposal.saved.result);
 const detail=await getTimeAdjustment(db,p.actor,p.auth.hash,id);assert.equal(detail.result!.totals!.workMicroseconds,'5400000000');
 const history=await getTimeAdjustmentHistory(db,p.actor,p.auth.hash,id);assert.equal(history.items.length,2);assert.equal(history.items[0].snapshot.request.status,'pending');
 for(const [table,where] of [['time_adjustment_requests','id'],['time_adjustment_history','request_id'],['time_adjustment_commands','request_id']])await assert.rejects(db.query(`DELETE FROM ${table} WHERE ${where}=$1`,[id]),/deleted|immutable|append-only/i);
 await assert.rejects(db.query('UPDATE time_adjustment_requests SET reason=$1 WHERE id=$2',['Attempted retained evidence rewrite',id]),/immutable/);
 const csv=await exportTimeAdjustment(db,p.actor,p.auth.hash,id,{format:'csv',version:'1'});assert.equal(csv.text.charCodeAt(0),0xfeff);assert.ok(csv.text.includes('\r\n'));assert.equal(digest(csv.text),csv.hash);
 assert.match(csv.text,/Synthetic missing recorded work/);assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE target_id=$1 AND action='time_adjustment.approved'",[id])).rows[0].n,1);
});

test('closure preserves exact null-ended source and only completed active revision reaches clock/report readers',async()=>{
 const p=await person(),shiftId=await open(p);
 await clockCommand(db,p.actor,{action:'start_break',commandId:randomUUID()},new Date(at(30)));
 await clockCommand(db,p.actor,{action:'end_break',commandId:randomUUID()},new Date(at(40)));
 const original=(await db.query('SELECT * FROM segments WHERE shift_id=$1 ORDER BY started_at',[shiftId])).rows,c=await closure(p,shiftId);
 assert.equal(c.source.source.totals,null);assert.equal(c.source.source.segments.at(-1)!.endedAt,null);assert.equal((await clockState(db,p.actor)).shift.id,shiftId);
 const saved=await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail));
 assert.deepEqual((await db.query('SELECT * FROM segments WHERE shift_id=$1 AND revision=1 ORDER BY started_at',[shiftId])).rows,original);
 assert.equal((await clockState(db,p.actor)).shift,null);
 assert.equal((await timeRecordDetail(db,p.actor,shiftId,p.auth.hash)).segments.length,3);
 const report=await getReport(db,p.actor,{start:'2025-11-02',end:'2025-11-02',group:'hour'});assert.equal(report.workMs,80*60000);assert.equal(report.breakMs,10*60000);
 const oldCsv=await exportTimeAdjustment(db,p.actor,p.auth.hash,c.saved.result.requestId,{format:'csv',version:'1'});assert.match(oldCsv.text,/No end recorded in this source/);assert.doesNotMatch(oldCsv.text,/1970-01-01/);
 await open(p,100);assert.equal((await clockState(db,p.actor)).shift.revision,1);assert.equal(saved.result.resultRevision,2);
 assert.deepEqual((await proposeTimeAdjustment(db,p.actor,p.auth.hash,c.input)).result,c.saved.result);
});

test('same-revision clock events stale a closure; decline and cancel retain stale history',async()=>{
 const p=await person(),shiftId=await open(p),c=await closure(p,shiftId);
 await clockCommand(db,p.actor,{action:'start_break',commandId:randomUUID()},new Date(at(10)));
 assert.equal((await db.query('SELECT revision FROM shifts WHERE id=$1',[shiftId])).rows[0].revision,1);
 await assert.rejects(reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail)),/changed/);
 const stale=await getTimeAdjustment(db,p.actor,p.auth.hash,c.saved.result.requestId);assert.equal(stale.readiness.state,'stale');assert.equal(stale.allowedActions.cancel,true);
 const cancel={version:1,requestHash:c.detail.requestHash,reason:'Cancelling stale synthetic source for fresh review.',commandId:randomUUID()};
 await cancelTimeAdjustment(db,p.actor,p.auth.hash,c.saved.result.requestId,cancel);assert.equal((await cancelTimeAdjustment(db,p.actor,p.auth.hash,c.saved.result.requestId,cancel)).replayed,true);
 const other=await closure(p,shiftId,40);await clockCommand(db,p.actor,{action:'clock_out',commandId:randomUUID()},new Date(at(20)));
 await reviewTimeAdjustment(db,owner,ownerAuth.hash,other.saved.result.requestId,{...approve(other.detail),status:'declined'});
 assert.equal((await getTimeAdjustment(db,p.actor,p.auth.hash,other.saved.result.requestId)).request.status,'declined');
});

test('scoped managers, finance and employees receive current complete authority, not proposer shortcuts',async()=>{
 const p=await person(),manager=await person('manager'),finance=await person('finance'),outsider=await person(),input=missing(p);
 const saved=await proposeTimeAdjustment(db,manager.actor,manager.auth.hash,input),id=saved.result.requestId,detail=await getTimeAdjustment(db,manager.actor,manager.auth.hash,id);
 await assert.rejects(reviewTimeAdjustment(db,manager.actor,manager.auth.hash,id,approve(detail)),/different/);
 await assert.rejects(reviewTimeAdjustment(db,p.actor,p.auth.hash,id,approve(detail)),/different/);
 assert.equal((await getTimeAdjustment(db,finance.actor,finance.auth.hash,id)).allowedActions.approve,false);
 await assert.rejects(proposeTimeAdjustment(db,finance.actor,finance.auth.hash,{...input,commandId:randomUUID()}),/Only the employee/);
 await assert.rejects(getTimeAdjustment(db,outsider.actor,outsider.auth.hash,id),(e:any)=>e.status===404);
 await db.query('DELETE FROM user_units WHERE user_id=$1',[manager.actor.id]);
 for(const operation of [()=>getTimeAdjustment(db,manager.actor,manager.auth.hash,id),()=>proposeTimeAdjustment(db,manager.actor,manager.auth.hash,input),()=>cancelTimeAdjustment(db,manager.actor,manager.auth.hash,id,{version:1,requestHash:detail.requestHash,reason:'Synthetic author with revoked scope.',commandId:randomUUID()})])await assert.rejects(operation,(e:any)=>e.status===404);
 assert.equal((await listTimeAdjustments(db,manager.actor,manager.auth.hash,{start:'2025-11-02',end:'2025-11-02'})).items.length,0);
});

test('all source units hide a mixed open shift even when its final job is in scope',async()=>{
 const p=await person(),manager=await person('manager'),other=jobs.find(j=>j.unit_id===units[1].id)!;
 await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,other.unit_id]);await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,other.id]);
 const shiftId=await open(p);await clockCommand(db,p.actor,{action:'switch_job',jobId:other.id,commandId:randomUUID()},new Date(at(5)));await clockCommand(db,p.actor,{action:'switch_job',jobId:p.job.id,commandId:randomUUID()},new Date(at(10)));
 assert.equal((await listOpenTimeShifts(db,manager.actor,manager.auth.hash,{employeeId:p.actor.id})).items.length,0);
 await assert.rejects(getTimeAdjustmentSource(db,manager.actor,manager.auth.hash,{shiftId}),(e:any)=>e.status===404);
 assert.equal((await listOpenTimeShifts(db,p.actor,p.auth.hash,{})).items[0].shiftId,shiftId);
});

test('missing jobs are revalidated; recorded closure jobs may be inactive and unassigned',async()=>{
 const p=await person(),m=await proposed(p);await db.query('DELETE FROM user_jobs WHERE user_id=$1',[p.actor.id]);
 await assert.rejects(reviewTimeAdjustment(db,owner,ownerAuth.hash,m.saved.result.requestId,approve(m.detail)),/assigned/);
 const q=await person(),shiftId=await open(q),c=await closure(q,shiftId);await db.query('DELETE FROM user_jobs WHERE user_id=$1',[q.actor.id]);await db.query('UPDATE jobs SET active=false WHERE id=$1',[q.job.id]);
 try{await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail));}finally{await db.query('UPDATE jobs SET active=true WHERE id=$1',[q.job.id]);}
 const inactive=await person();await db.query('UPDATE users SET active=false WHERE id=$1',[inactive.actor.id]);
 await proposeTimeAdjustment(db,owner,ownerAuth.hash,missing(inactive));await assert.rejects(proposeTimeAdjustment(db,inactive.actor,inactive.auth.hash,missing(inactive)),(e:any)=>e.status===403);
});

test('overlap, gaps, future instants and unsupported entered precision are rejected; exact adjacency succeeds',async()=>{
 const p=await person();await open(p,20);await assert.rejects(proposeTimeAdjustment(db,p.actor,p.auth.hash,missing(p,0,30)),/overlaps/);
 const q=await person(),one=await proposed(q,missing(q,0,30));await reviewTimeAdjustment(db,owner,ownerAuth.hash,one.saved.result.requestId,approve(one.detail));
 const adjacent=await proposed(q,missing(q,30,60));await reviewTimeAdjustment(db,owner,ownerAuth.hash,adjacent.saved.result.requestId,approve(adjacent.detail));
 await assert.rejects(clockCommand(db,q.actor,{action:'clock_in',jobId:q.job.id,commandId:randomUUID()},new Date(at(45))),/overlaps/);
 assert.equal(proposeTimeAdjustmentInput.safeParse({...missing(q),segments:[{...missing(q).segments[0],startedAt:'2025-11-02T05:00:00.000001Z'}]}).success,false);
 await assert.rejects(proposeTimeAdjustment(db,q.actor,q.auth.hash,{...missing(q),segments:[{...missing(q).segments[0],endedAt:new Date(Date.now()+60000).toISOString()}]}),/future/);
 const fresh=await person();await assert.rejects(proposeTimeAdjustment(db,fresh.actor,fresh.auth.hash,{...missing(fresh),segments:[{...missing(fresh).segments[0],endedAt:at(20)},{...missing(fresh).segments[0],startedAt:at(21)}]}),/contiguous/);
});

test('competing approvals serialize and exact retries survive later source corrections',async()=>{
 const p=await person(),a=await proposed(p),b=await proposed(p),review=approve(a.detail);
 const results=await Promise.allSettled([reviewTimeAdjustment(db,owner,ownerAuth.hash,a.saved.result.requestId,review),reviewTimeAdjustment(db,owner,ownerAuth.hash,b.saved.result.requestId,approve(b.detail))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const applied=await getTimeAdjustment(db,p.actor,p.auth.hash,a.saved.result.requestId);assert.equal(applied.request.status,'approved');
 const correction=await proposeCorrection(db,p.actor,{shiftId:applied.result!.shift.id!,sourceRevision:1,commandId:randomUUID(),reason:'Synthetic later independently reviewed time edit.',segments:[{jobId:p.job.id,kind:'work',startedAt:at(0),endedAt:at(100)}]},p.auth.hash);
 await reviewCorrection(db,owner,correction.id,{version:1,status:'approved',note:'Independent later correction after initial missing shift.'},ownerAuth.hash);
 assert.equal((await reviewTimeAdjustment(db,owner,ownerAuth.hash,a.saved.result.requestId,review)).result.resultRevision,1);
});

test('expired session, missing actual session, changed MFA and final audit expiry deny or roll back',async()=>{
 const p=await person(),m=await proposed(p),id=m.saved.result.requestId;
 await assert.rejects(getTimeAdjustment(db,p.actor,undefined as any,id),(e:any)=>e.status===401);
 const expired=await session(p.actor);await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[expired.hash]);await assert.rejects(proposeTimeAdjustment(db,p.actor,expired.hash,m.input),(e:any)=>e.status===401);
 const failure=intercept(async(sql)=>{if(sql.includes('INSERT INTO audit_events'))throw new Error('synthetic audit failure');});
 await assert.rejects(reviewTimeAdjustment(failure,owner,ownerAuth.hash,id,approve(m.detail)),/synthetic audit/);
 assert.equal((await getTimeAdjustment(db,p.actor,p.auth.hash,id)).request.version,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM shifts WHERE user_id=$1',[p.actor.id])).rows[0].n,0);
 const final=intercept(async(sql,_params,tx)=>{if(sql.includes('INSERT INTO audit_events'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[ownerAuth.hash]);});
 await assert.rejects(reviewTimeAdjustment(final,owner,ownerAuth.hash,id,approve(m.detail)),(e:any)=>e.status===401);assert.equal((await getTimeAdjustment(db,p.actor,p.auth.hash,id)).request.version,1);
 const busy=intercept(async(sql)=>{if(sql.includes('pg_advisory_xact_lock'))throw Object.assign(new Error('synthetic lock timeout'),{code:'55P03'});});await assert.rejects(proposeTimeAdjustment(busy,p.actor,p.auth.hash,m.input),(e:any)=>e.status===503);
});

test('exact microsecond source survives closure and an unchanged-boundary legacy job correction',async()=>{
 const p=await person(),secondJob=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[secondJob,p.actor.org_id,p.job.unit_id,'Synthetic second job']);await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,secondJob]);
 const shiftId=randomUUID(),segmentId=randomUUID(),start='2025-11-02T05:00:00.123456Z';
 await db.query('INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,$4)',[shiftId,p.actor.org_id,p.actor.id,start]);await db.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at) VALUES($1,$2,$3,$4,\'work\',$5)',[segmentId,p.actor.org_id,shiftId,p.job.id,start]);
 const c=await closure(p,shiftId);assert.equal(c.source.source.shift.startedAt,start);await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail));
 const detail=await timeRecordDetail(db,p.actor,shiftId,p.auth.hash);assert.equal(detail.segments[0].started_at,start);
 const input={shiftId,sourceRevision:2,commandId:randomUUID(),reason:'Job-only change keeps the exact recorded time boundary.',segments:[{jobId:secondJob,kind:'work' as const,startedAt:start,endedAt:detail.segments[0].ended_at}]};
 const correction=await proposeCorrection(db,p.actor,input,p.auth.hash);assert.equal(correction.original.segments[0].startedAt,start);await reviewCorrection(db,owner,correction.id,{version:1,status:'approved',note:'Independent job-only edit with untouched exact times.'},ownerAuth.hash);
 assert.equal((await timeRecordDetail(db,p.actor,shiftId,p.auth.hash)).segments[0].started_at,start);
 await assert.rejects(proposeCorrection(db,p.actor,{...input,sourceRevision:3,commandId:randomUUID(),segments:[{...input.segments[0],startedAt:'2025-11-02T05:00:00.123457Z'}]},p.auth.hash),/exactly preserve/);
 const raw=(await db.query("SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS start,ended_at FROM segments WHERE id=$1",[segmentId])).rows[0];assert.equal(raw.start,start);assert.equal(raw.ended_at,null);
 assert.equal(timeMicroseconds('1969-12-31T23:59:59.999999Z'),-1n);
});

test('source-only list has no date cap; source pending count and request history use exact pagination metadata',async()=>{
 const p=await person(),shiftId=await open(p),c=await closure(p,shiftId);
 const list=await listTimeAdjustments(db,p.actor,p.auth.hash,{sourceShiftId:shiftId});assert.equal(list.items[0].id,c.saved.result.requestId);
 const openList=await listOpenTimeShifts(db,p.actor,p.auth.hash,{employeeId:p.actor.id});assert.equal(openList.items[0].pendingRequests,1);assert.equal(openList.items[0].shiftId,shiftId);
 assert.equal((await getTimeAdjustmentOptions(db,p.actor,p.auth.hash,{employeeId:p.actor.id})).jobs[0].id,p.job.id);
 const invalid={...c.detail,request:{...c.detail.request,source:null}};const envelope={request:invalid.request,requestHash:'0'.repeat(64),result:null,resultHash:null};envelope.requestHash=adjustmentDefinitionHash(envelope);assert.throws(()=>validateTimeEnvelope(envelope),/source evidence/);
});

test('installed HTTP contract requires password, CSRF, strict fields and returns exact private exports',async()=>{
 const p=await person(),input=missing(p);
 assert.equal((await request(app).get('/api/time-adjustments/options?employeeId='+p.actor.id)).status,401);
 const pin=await session(p.actor,'pin');assert.equal((await request(app).get('/api/time-adjustments/options?employeeId='+p.actor.id).set('Cookie',pin.cookie)).status,403);
 assert.equal((await request(app).post('/api/time-adjustments').set('Origin',origin).set('Cookie',p.auth.cookie).send(input)).status,403);
 assert.equal((await request(app).post('/api/time-adjustments').set('Origin','https://foreign.example.test').set('Cookie',p.auth.cookie).set('X-CSRF-Token',p.auth.csrf).send(input)).status,403);
 assert.equal((await post('/time-adjustments',{...input,orgId:owner.org_id},p.auth)).status,400);
 assert.equal((await post('/time-adjustments',{...input,segments:[{...input.segments[0],payRate:1}]},p.auth)).status,400);
 const created=await post('/time-adjustments',input,p.auth);assert.equal(created.status,201,created.text);assert.match(created.headers['cache-control'],/private, no-store/);assert.equal((await post('/time-adjustments',input,p.auth)).status,200);
 const list=await request(app).get('/api/time-adjustments?start=2025-11-02&start=2025-11-03&end=2025-11-02').set('Cookie',p.auth.cookie);assert.equal(list.status,400);
 const invalid=await request(app).get('/api/time-adjustments?status=pending').set('Cookie',p.auth.cookie);assert.equal(invalid.status,400);
 const exported=await request(app).get('/api/time-adjustments/'+created.body.requestId+'/export?format=csv&version=1').set('Cookie',p.auth.cookie).buffer(true).parse((res,callback)=>{const bytes:Buffer[]=[];res.on('data',chunk=>bytes.push(Buffer.from(chunk)));res.on('end',()=>callback(null,Buffer.concat(bytes)));});
 assert.equal(exported.status,200);assert.match(exported.headers['content-disposition'],/attachment/);assert.match(exported.headers['cache-control'],/private, no-store/);assert.equal(exported.body.subarray(0,3).toString('hex'),'efbbbf');assert.equal(digest(exported.body.toString('utf8')),exported.headers['x-content-sha256']);
 const badBearer=await request(app).get('/api/time-adjustments/options?employeeId='+p.actor.id).set('Authorization','Bearer '+opaqueToken());assert.equal(badBearer.status,403);
});

test('MFA changes deny direct reads and exact successful command recovery with the old password session',async()=>{
 const p=await person(),m=await proposed(p);
 await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic',clock_timestamp(),clock_timestamp())",[p.actor.id,p.actor.org_id,randomUUID()]);
 await assert.rejects(getTimeAdjustment(db,p.actor,p.auth.hash,m.saved.result.requestId),(e:any)=>e.status===401);
 await assert.rejects(proposeTimeAdjustment(db,p.actor,p.auth.hash,m.input),(e:any)=>e.status===401);
 await db.query('UPDATE sessions SET mfa_verified=true WHERE token_hash=$1',[p.auth.hash]);assert.equal((await proposeTimeAdjustment(db,p.actor,p.auth.hash,m.input)).replayed,true);
});

test('fresh list publication rejects revocation and same-revision clock changes after RR extraction',async()=>{
 const p=await person(),m=await proposed(p),manager=await person('manager');
 let calls=0;const revoke:Database={...db,transaction:async fn=>{const result=await db.transaction(fn);if(++calls===1)await db.query('DELETE FROM user_units WHERE user_id=$1',[manager.actor.id]);return result;}};
 await assert.rejects(listTimeAdjustments(revoke,manager.actor,manager.auth.hash,{start:'2025-11-02',end:'2025-11-02',employeeId:p.actor.id}),(e:any)=>[403,404,409].includes(e.status));
 const q=await person();await open(q);calls=0;const switchClock:Database={...db,transaction:async fn=>{const result=await db.transaction(fn);if(++calls===1)await clockCommand(db,q.actor,{action:'start_break',commandId:randomUUID()},new Date(at(1)));return result;}};
 await assert.rejects(listOpenTimeShifts(switchClock,q.actor,q.auth.hash,{}),(e:any)=>e.status===409);
 assert.equal((await getTimeAdjustment(db,p.actor,p.auth.hash,m.saved.result.requestId)).request.status,'pending');
});

test('real request pages exhaust51 records and reject continuation after a not-yet-seen request changes',async()=>{
 const p=await person();for(let i=0;i<51;i++)await proposeTimeAdjustment(db,p.actor,p.auth.hash,missing(p));
 const query={start:'2025-11-02',end:'2025-11-02',employeeId:p.actor.id},first=await listTimeAdjustments(db,p.actor,p.auth.hash,query);assert.equal(first.items.length,50);assert.ok(first.nextCursor);assert.ok(first.nextCursor.length<=400);
 const last=await listTimeAdjustments(db,p.actor,p.auth.hash,{...query,cursor:first.nextCursor!});assert.equal(last.items.length,1);assert.equal(last.nextCursor,null);assert.equal(new Set([...first.items,...last.items].map(row=>row.id)).size,51);
 const detail=await getTimeAdjustment(db,p.actor,p.auth.hash,last.items[0].id);await reviewTimeAdjustment(db,owner,ownerAuth.hash,detail.request.id,{...approve(detail),status:'declined'});
 await assert.rejects(listTimeAdjustments(db,p.actor,p.auth.hash,{...query,cursor:first.nextCursor!}),(e:any)=>e.status===409);
});

test('open discovery pages exhaust actual51plus open shifts and detect a closure between pages',async()=>{
 const created:Person[]=[];for(let i=0;i<51;i++){const p=await person();created.push(p);await open(p);}
 const expected=(await db.query('SELECT id FROM shifts WHERE org_id=$1 AND ended_at IS NULL',[owner.org_id])).rows.map(row=>row.id).sort();
 const first=await listOpenTimeShifts(db,owner,ownerAuth.hash,{});assert.equal(first.items.length,50);assert.ok(first.nextCursor);
 const all=[...first.items];let cursor:string|null=first.nextCursor;while(cursor){const next=await listOpenTimeShifts(db,owner,ownerAuth.hash,{cursor});all.push(...next.items);cursor=next.nextCursor;}
 assert.deepEqual(all.map(row=>row.shiftId).sort(),expected);
 await clockCommand(db,created[0].actor,{action:'clock_out',commandId:randomUUID()},new Date(at(10)));
 await assert.rejects(listOpenTimeShifts(db,owner,ownerAuth.hash,{cursor:first.nextCursor!}),(e:any)=>e.status===409);
});

test('zero-duration recorded closure at local midnight appears on that date',async()=>{
 const p=await person(),midnight='2025-11-02T04:00:00.000Z',state=await clockCommand(db,p.actor,{action:'clock_in',jobId:p.job.id,commandId:randomUUID()},new Date(midnight));
 const source=await getTimeAdjustmentSource(db,p.actor,p.auth.hash,{shiftId:state.shift.id});
 const saved=await proposeTimeAdjustment(db,p.actor,p.auth.hash,{kind:'close_open_shift',shiftId:state.shift.id,sourceHash:source.sourceHash,endedAt:midnight,reason:'Synthetic immediate recorded closure at midnight.',commandId:randomUUID()});
 const page=await listTimeAdjustments(db,p.actor,p.auth.hash,{start:'2025-11-02',end:'2025-11-02'});assert.ok(page.items.some(row=>row.id===saved.result.requestId));assert.equal((await listTimeAdjustments(db,p.actor,p.auth.hash,{start:'2025-11-01',end:'2025-11-01'})).items.length,0);
});

test('clock default instant is sampled after the employee wait, and guarded source precision is unchanged',async()=>{
 const p=await person();let afterWait=0;const delayed=intercept(async(sql)=>{if(sql.startsWith('SELECT active FROM users')){await new Promise(resolve=>setTimeout(resolve,30));afterWait=Date.now();}});
 const result=await clockCommand(delayed,p.actor,{action:'clock_in',jobId:p.job.id,commandId:randomUUID()});assert.ok(new Date(result.shift.started_at).valueOf()>=afterWait);
});

test('legacy original+proposed historical scope and canonical millisecond receipts survive upgrades without creator bypass',async()=>{
 const p=await person(),manager=await person('manager'),otherJob=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[otherJob,p.actor.org_id,p.job.unit_id,'Synthetic independently moved job']);await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,otherJob]);
 const shiftId=await open(p);await clockCommand(db,p.actor,{action:'clock_out',commandId:randomUUID()},new Date(at(20)));
 const input={shiftId,sourceRevision:1,commandId:randomUUID(),reason:'Synthetic historical manager job correction.',segments:[{jobId:otherJob,kind:'work' as const,startedAt:at(0).replace('.000Z','Z'),endedAt:at(20).replace('.000Z','Z')}]};
 const correction=await proposeCorrection(db,manager.actor,input,manager.auth.hash);
 assert.equal((await proposeCorrection(db,manager.actor,{...input,segments:input.segments.map(row=>({...row,startedAt:at(0),endedAt:at(20)}))},manager.auth.hash)).id,correction.id);
 assert.ok(correction.original.scope.unitIds.includes(p.job.unit_id));
 await db.query('UPDATE jobs SET unit_id=$1 WHERE id=$2',[units[1].id,otherJob]);
 await assert.rejects(proposeCorrection(db,manager.actor,input,manager.auth.hash),(e:any)=>e.status===404);
 const detail=await timeRecordDetail(db,manager.actor,shiftId,manager.auth.hash);assert.equal(detail.corrections.length,0);
 const page=await request(app).get('/api/time-records?start=2025-11-02&end=2025-11-02&userId='+p.actor.id).set('Cookie',manager.auth.cookie);assert.equal(page.status,200,page.text);assert.equal(page.body.rows[0].pending_corrections,0);
 const auth=await session(manager.actor);assert.equal((await post('/time-corrections/'+correction.id+'/cancel',{version:1},auth)).status,404);
});

test('a retained pre-closure report keeps its original bytes and historical segment authority',async()=>{
 const p=await person(),shiftId=await open(p),definition=reportDefinition.parse({...initialDefinition('workforce'),range:{preset:'custom',from:'2025-11-02',to:'2025-11-02'}});
 const report=await saveReport(db,p.actor,p.auth.hash,{id:randomUUID(),version:0,name:'Synthetic open source report',description:'Retained before independent closure',definition,archived:false,reason:'Synthetic retained source compatibility evidence.'});
 const preview=await prepareReportSnapshot(db,p.actor,p.auth.hash,report.id,{version:report.version});
 const saved=await captureReportSnapshot(db,p.actor,p.auth.hash,report.id,{version:report.version,previewId:preview.id,payloadHash:preview.payloadHash,commandId:randomUUID(),reviewed:true,reason:'Reviewed synthetic source before later closure.'});
 const before=await readReportSnapshot(db,p.actor,p.auth.hash,report.id,saved.snapshot.id,'csv'),c=await closure(p,shiftId);
 await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail));
 const after=await readReportSnapshot(db,p.actor,p.auth.hash,report.id,saved.snapshot.id,'csv');assert.equal(after.content,before.content);assert.equal(after.csvHash,before.csvHash);
 assert.equal((await getReport(db,p.actor,{start:'2025-11-02',end:'2025-11-02',group:'day'})).workMs,90*60000);
 assert.equal((await db.query('SELECT ended_at FROM segments WHERE shift_id=$1 AND revision=1',[shiftId])).rows[0].ended_at,null);
});

test('027 rejects conditional NULL evidence and only allows a terminal lifecycle with retained history',async()=>{
 const p=await person(),shiftId=await open(p),c=await closure(p,shiftId),id=c.saved.result.requestId;
 const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='time_adjustment_requests' ORDER BY ordinal_position")).rows.map(row=>row.column_name as string);
 const clone=(replacement:Record<string,string>)=>'INSERT INTO time_adjustment_requests('+columns.join(',')+') SELECT '+columns.map(column=>replacement[column]??column).join(',')+' FROM time_adjustment_requests WHERE id=$1';
 await assert.rejects(db.query(clone({id:"'"+randomUUID()+"'::uuid",source_hash:'NULL'}),[id]),/check constraint/);
 await assert.rejects(db.query(clone({id:"'"+randomUUID()+"'::uuid",proposed_snapshot:"proposed_snapshot - 'employee'"}),[id]),/check constraint/);
 await assert.rejects(db.query("UPDATE time_adjustment_requests SET status='declined',version=2,resolved_by=$1,resolver_name='Synthetic reviewer',resolution_note=NULL,resolved_at=clock_timestamp() WHERE id=$2",[owner.id,id]),/check constraint/);
 await assert.rejects(db.query("UPDATE time_adjustment_requests SET status='approved',version=2,resolved_by=$1,resolver_name='Synthetic reviewer',resolution_note='Synthetic required result evidence',resolved_at=clock_timestamp(),result_shift_id=source_shift_id,result_revision=2,result_snapshot=proposed_snapshot,result_hash=NULL WHERE id=$2",[owner.id,id]),/check constraint/);
 await assert.rejects(db.query("UPDATE time_adjustment_requests SET status='declined',version=2,resolved_by=$1,resolver_name='Synthetic reviewer',resolution_note='Synthetic missing transition history',resolved_at=clock_timestamp() WHERE id=$2",[owner.id,id]),/foreign key constraint/);
 assert.equal((await getTimeAdjustment(db,p.actor,p.auth.hash,id)).request.version,1);
});

test('unsupported changed source remains readable as blocked so authorized independent decline is possible',async()=>{
 const p=await person(),shiftId=await open(p),c=await closure(p,shiftId);
 // Synthetic malformed active-source fixture; existing immutable request stays valid.
 await db.query('UPDATE shifts SET started_at=started_at-interval \'1 second\' WHERE id=$1',[shiftId]);
 const detail=await getTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId);assert.equal(detail.readiness.state,'blocked');assert.equal(detail.readiness.issues[0].code,'invalid_source');assert.equal(detail.allowedActions.approve,false);assert.equal(detail.allowedActions.decline,true);
 await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,{...approve(c.detail),status:'declined'});
});

test('same-instant zero-duration work/break/job events keep reviewed order in missing and copied revisions',async()=>{
 const p=await person(),secondJob=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[secondJob,p.actor.org_id,p.job.unit_id,'Synthetic tied-boundary job']);await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,secondJob]);
 const segments=Array.from({length:16},(_,index)=>({jobId:index%3===0?secondJob:p.job.id,kind:index%2===0?'work' as const:'break' as const,startedAt:at(0),endedAt:index===15?at(1):at(0)}));
 const input={...missing(p),segments},saved=await proposeTimeAdjustment(db,p.actor,p.auth.hash,input),detail=await getTimeAdjustment(db,p.actor,p.auth.hash,saved.result.requestId);await reviewTimeAdjustment(db,owner,ownerAuth.hash,saved.result.requestId,approve(detail));
 const result=(await getTimeAdjustment(db,p.actor,p.auth.hash,saved.result.requestId)).result!;assert.deepEqual(result.segments.map(row=>[row.jobId,row.kind]),segments.map(row=>[row.jobId,row.kind]));
 const correction=await proposeCorrection(db,p.actor,{shiftId:result.shift.id!,sourceRevision:1,commandId:randomUUID(),reason:'Synthetic later correction keeps tied event order.',segments:segments.map((row,index)=>index===15?{...row,endedAt:at(2)}:row)},p.auth.hash);await reviewCorrection(db,owner,correction.id,{version:1,status:'approved',note:'Reviewed tied zero-duration events without rearrangement.'},ownerAuth.hash);
 assert.deepEqual((await timeRecordDetail(db,p.actor,result.shift.id!,p.auth.hash)).segments.map(row=>[row.job_id,row.kind]),segments.map(row=>[row.jobId,row.kind]));
 const q=await person(),shiftId=await open(q,20);for(let i=0;i<14;i++)await clockCommand(db,q.actor,{action:i%2===0?'start_break':'end_break',commandId:randomUUID()},new Date(at(20)));
 const c=await closure(q,shiftId,21),expected=c.source.source.segments.map(row=>[row.jobId,row.kind]);await reviewTimeAdjustment(db,owner,ownerAuth.hash,c.saved.result.requestId,approve(c.detail));
 assert.deepEqual((await getTimeAdjustment(db,q.actor,q.auth.hash,c.saved.result.requestId)).result!.segments.map(row=>[row.jobId,row.kind]),expected);
});
