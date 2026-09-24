import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable,type Row} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {digest,issueSetup,type Actor} from '../server/security';
import {aggregateSegmentsV2} from '../server/reports-v2';
import {getAuthorizedPayrollReview,exportAuthorizedPayrollReview,payrollReviewCsv} from '../server/payroll-review';
import {buildPayrollReview,payrollReviewQuerySchema,payrollReviewSchema,previousPayrollReviewQuery,payrollReviewLimits} from '../shared/payroll-review';
import {workforceInstantMicroseconds,workforceUtcFromMicroseconds,type WorkforceSourceRowV2} from '../shared/workforce-reports-v2';

const selected={start:'2026-09-20',end:'2026-09-20',group:'day' as const},asOf='2026-09-21T00:00:00.000000Z';
const ids={user:randomUUID(),job:randomUUID(),unit:randomUUID(),shift:randomUUID()};
function row(start='2026-09-20T14:00:00.000000Z',micros=3_600_000_000n,changes:Partial<WorkforceSourceRowV2>={}):WorkforceSourceRowV2{
  return {id:randomUUID(),shift_id:ids.shift,revision:1,user_id:ids.user,employee_name:'Synthetic comparison',job_id:ids.job,job_title:'Synthetic job',unit_id:ids.unit,unit_name:'Synthetic unit',kind:'work',started_at:start,ended_at:workforceUtcFromMicroseconds(workforceInstantMicroseconds(start)+micros),...changes};
}
function compare(current:WorkforceSourceRowV2[],previous:WorkforceSourceRowV2[],query=selected,zone='UTC',capture=asOf){
  return buildPayrollReview(aggregateSegmentsV2(current,query,zone,capture),aggregateSegmentsV2(previous,previousPayrollReviewQuery(query).query,zone,capture));
}
test('calendar comparison is adjacent and equally sized; limits and client asOf are rejected',()=>{
  const q=previousPayrollReviewQuery({start:'2026-03-01',end:'2026-03-31',group:'month'});assert.equal(q.days,31);assert.equal(q.query.start,'2026-01-29');assert.equal(q.query.end,'2026-02-28');
  assert.throws(()=>previousPayrollReviewQuery({start:'0001-01-01',end:'0001-01-01'}));
  for(const query of [{...selected,asOf},{start:'2026-01-01',end:'2027-01-03'},{start:'2026-01-01',end:'2026-02-02',group:'hour'},{start:'2026-02-30',end:'2026-03-01'}])assert.equal(payrollReviewQuerySchema.safeParse(query).success,false);
  assert.throws(()=>aggregateSegmentsV2(Array(20_001).fill(row()),selected,'UTC',asOf),{status:400});
});
test('exact microsecond deltas precede decimal rounding and zero baseline has no invented percent',()=>{
  const value=compare([row(undefined,1000n),row(undefined,1000n)],[row('2026-09-19T14:00:00.000000Z',1001n)]);
  assert.equal(value.totals.current.workHours,'0.000001');assert.equal(value.totals.previous.workHours,'0.000000');assert.equal(value.totals.delta.workMicroseconds,'999');assert.equal(value.totals.delta.workHours,'0.000000');assert.equal(value.totals.delta.workPercentChange,'99.800200');
  const negative=compare([row(undefined,1001n)],[row('2026-09-19T14:00:00.000000Z',2000n)]);assert.equal(negative.totals.delta.workMicroseconds,'-999');assert.equal(negative.totals.delta.workHours,'0.000000');
  assert.equal(compare([row()],[]).totals.delta.workPercentChange,null);assert.equal(compare([],[]).totals.delta.workPercentChange,null);
});
test('equal local calendar days preserve fall and spring DST elapsed-hour differences',()=>{
  const fall=compare([row('2026-11-01T04:00:00.000000Z',25n*3_600_000_000n)],[row('2026-10-31T04:00:00.000000Z',24n*3_600_000_000n)],{start:'2026-11-01',end:'2026-11-01',group:'day'},'America/New_York','2026-11-03T00:00:00.000000Z');
  assert.equal(fall.totals.current.workHours,'25.000000');assert.equal(fall.totals.previous.workHours,'24.000000');assert.equal(fall.totals.delta.workPercentChange,'4.166667');assert.equal(fall.periods.current.calendarDays,1);assert.equal(fall.periods.previous.calendarDays,1);
  const spring=compare([row('2026-03-08T05:00:00.000000Z',23n*3_600_000_000n)],[row('2026-03-07T05:00:00.000000Z',24n*3_600_000_000n)],{start:'2026-03-08',end:'2026-03-08',group:'day'},'America/New_York','2026-03-10T00:00:00.000000Z');
  assert.equal(spring.totals.delta.workHours,'-1.000000');assert.equal(spring.totals.delta.workPercentChange,'-4.166667');
});
test('large sums remain exact beyond Number precision',()=>{
  const year=365n*86_400_000_000n,now=Array.from({length:400},()=>row('2026-01-01T00:00:00.000000Z',year,{shift_id:randomUUID()})),prior=Array.from({length:400},()=>row('2025-01-01T00:00:00.000000Z',year-1n,{shift_id:randomUUID()}));
  const value=compare(now,prior,{start:'2026-01-01',end:'2026-12-31',group:'day'},'UTC','2027-01-02T00:00:00.000000Z');assert.ok(BigInt(value.totals.current.workMicroseconds)>BigInt(Number.MAX_SAFE_INTEGER));assert.equal(value.totals.delta.workMicroseconds,'400');
});
test('employee union retains prior-only people and zeroes only the missing period',()=>{
  const departed=randomUUID(),value=compare([row()],[row('2026-09-19T14:00:00.000000Z',7_200_000_000n,{user_id:departed,employee_name:'Previous only'})]);
  const employee=value.employees.find(item=>item.userId===departed)!;assert.equal(value.employees.length,2);assert.equal(employee.current.employeeCount,0);assert.equal(employee.previous.workHours,'2.000000');assert.equal(employee.delta.workHours,'-2.000000');assert.equal(employee.delta.workPercentChange,'-100.000000');
});
test('partial and future periods report captured status without projecting hours or certifying preparation',()=>{
  const value=compare([row(undefined,0n,{ended_at:null})],[],selected,'UTC','2026-09-20T15:00:00.000000Z');assert.equal(value.periods.current.status,'in_progress');assert.equal(value.periods.current.capturedThrough,'2026-09-20T15:00:00.000000Z');assert.equal(value.periods.previous.status,'complete');assert.equal(value.preparation.openSegmentCount,1);assert.equal(value.preparation.employeesWithOpenSegments,1);assert.equal(value.preparation.pendingCorrections.count,null);assert.equal(value.preparation.status,'review_required');
  const future=compare([row()],[],selected,'UTC','2026-09-18T00:00:00.000000Z');assert.equal(future.periods.current.status,'future');assert.equal(future.periods.current.capturedThrough,null);assert.equal(future.totals.current.workMicroseconds,'0');assert.equal(future.periods.previous.status,'future');
});
test('mixed captures, timezone, range or source identities cannot be merged',()=>{
  const now=aggregateSegmentsV2([row()],selected,'UTC',asOf),prior=aggregateSegmentsV2([row('2026-09-19T14:00:00.000000Z')],previousPayrollReviewQuery(selected).query,'UTC',asOf);
  assert.throws(()=>buildPayrollReview(now,{...prior,asOf:'2026-09-21T00:00:00.000001Z'}));assert.throws(()=>buildPayrollReview(now,{...prior,timezone:'Europe/London'}));assert.throws(()=>buildPayrollReview(now,{...prior,query:{...prior.query,userId:randomUUID()}}));
  assert.throws(()=>buildPayrollReview(now,{...prior,rows:prior.rows.map(item=>({...item,employee_name:'Changed identity'}))}));
  assert.equal(payrollReviewSchema.safeParse({...compare([],[]),approved:true}).success,false);
});
test('comparison CSV protects formulas and retains signed microseconds and explicit absent correction coverage',()=>{
  const csv=payrollReviewCsv(compare([],[row('2026-09-19T14:00:00.000000Z',3_600_000_000n,{employee_name:'=Synthetic'})]));assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=Synthetic"));assert.ok(csv.includes('-3600000000'));assert.ok(csv.includes('Not included; review in Time records'));assert.ok(csv.includes(asOf));
});

// Normal API setup/login produces every credential. SQL fixtures only create
// disposable historical evidence and deliberate expiry conditions.
let db:Database,owner:Actor,ownerAuth:Auth,units:string[],jobs:string[],target:Person;
const origin='http://localhost:3199';
type Auth={cookie:string;csrf:string;hash:string};
type Person={id:string;email:string;password:string;role:Actor['role'];units:string[]};
const app=(database=db)=>createApp(database,{origin,production:false,demo:false,staffDomain:'stjw.org'});
const proof=(auth:Auth)=>({mode:'password' as const,hash:auth.hash});
async function send(path:string,body:unknown,auth=ownerAuth,method='post'){
  const result=await (request(app()) as any)[method]('/api'+path).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body);assert.ok(result.status<300,'Synthetic API mutation failed');return result.body;
}
async function login(email:string,password:string):Promise<Auth>{
  const result=await request(app()).post('/api/auth/login').set('Origin',origin).send({mode:'password',email,credential:password});assert.equal(result.status,200);const cookie=(result.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app()).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);return {cookie,csrf:me.body.actor.csrf,hash:digest(cookie.slice(cookie.indexOf('=')+1))};
}
async function person(role:Actor['role']='manager',assigned=units):Promise<Person>{
  const email=randomUUID()+'@stjw.org',password='Synthetic-'+randomUUID(),result=await send('/staff',{name:'Synthetic comparison staff',email,role,unitIds:assigned,jobIds:[]});
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin',origin).send({token:new URL(result.setupUrl).hash.slice(7),password})).status,200);return {id:result.id,email,password,role,units:assigned};
}
const actor=(value:Person):Actor=>({...owner,id:value.id,email:value.email,role:value.role,unit_ids:value.units});
function probe(effect:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{
  return {...db,transaction:<T>(fn:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>fn({query:async<R extends Row=Row>(sql:string,params:any[]=[])=>{const result=await tx.query<R>(sql,params);await effect(tx,sql,params);return result;}}))};
}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'payroll.review.owner@example.test'});
  const record=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];owner={id:record.id,org_id:record.org_id,name:record.name,email:record.email,role:record.role,mode:'password',unit_ids:[]};
  const password='Synthetic-'+randomUUID(),token=await db.transaction(tx=>issueSetup(tx,owner));assert.equal((await request(app()).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);ownerAuth=await login(owner.email,password);
  const found=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2')).rows;jobs=found.map(item=>item.id);units=found.map(item=>item.unit_id);assert.notEqual(units[0],units[1]);target=await person('employee');
  for(const date of ['2026-09-19','2026-09-20']){const shift=randomUUID();await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)',[shift,owner.org_id,target.id,date+'T14:00:00.000001Z',date+'T16:00:00.000002Z']);for(let index=0;index<2;index++)await db.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),owner.org_id,shift,jobs[index],index?'break':'work',date+(index?'T15:00:00.000001Z':'T14:00:00.000001Z'),date+(index?'T16:00:00.000002Z':'T15:00:00.000001Z')]);}
});
after(async()=>{await db?.close();});
test('service captures two scoped periods in one repeatable-read transaction with identical asOf',async()=>{
  const seen:string[]=[];const wrapped=probe(async(_tx,sql)=>{seen.push(sql);});const result=await getAuthorizedPayrollReview(wrapped,owner,proof(ownerAuth),selected);
  assert.equal(result.totals.current.workMicroseconds,'3600000000');assert.equal(result.totals.current.breakMicroseconds,'3600000001');assert.equal(result.totals.delta.totalMicroseconds,'0');assert.equal(result.evidence.currentSourceRows,2);assert.equal(result.evidence.previousSourceRows,2);assert.ok(seen[0].includes('REPEATABLE READ'));assert.equal(seen.filter(sql=>sql.includes('FROM segments s JOIN shifts h')).length,2);
});
test('manager scope and unit/user filters apply to both periods with fresh assignments',async()=>{
  const manager=await person('manager',[units[0]]),auth=await login(manager.email,manager.password);
  const scoped=await getAuthorizedPayrollReview(db,actor(manager),proof(auth),selected);assert.equal(scoped.totals.current.breakMicroseconds,'0');assert.equal(scoped.totals.previous.breakMicroseconds,'0');assert.equal(scoped.evidence.currentSourceRows,1);
  const foreign=await getAuthorizedPayrollReview(db,actor(manager),proof(auth),{...selected,unitId:units[1]});assert.equal(foreign.employees.length,0);
  const filtered=await getAuthorizedPayrollReview(db,owner,proof(ownerAuth),{...selected,userId:randomUUID()});assert.equal(filtered.employees.length,0);
  await send('/staff/'+manager.id,{name:'Synthetic comparison staff',email:manager.email,role:'manager',active:true,unitIds:[units[1]],jobIds:[]},ownerAuth,'patch');
  await assert.rejects(getAuthorizedPayrollReview(db,actor(manager),proof(auth),selected),{status:401});
  const renewed=await login(manager.email,manager.password),stale=await getAuthorizedPayrollReview(db,actor(manager),proof(renewed),selected);assert.equal(stale.totals.current.workMicroseconds,'0');assert.equal(stale.totals.current.breakMicroseconds,'3600000001');
});
test('current role, PIN mode, invalid capture query and out-of-range predecessor deny',async()=>{
  const employee=await person('employee'),auth=await login(employee.email,employee.password);
  await assert.rejects(getAuthorizedPayrollReview(db,actor(employee),proof(auth),selected),{status:403});
  await assert.rejects(getAuthorizedPayrollReview(db,{...owner,mode:'pin'},proof(ownerAuth),selected),{status:401});
  await assert.rejects(async()=>getAuthorizedPayrollReview(db,owner,proof(ownerAuth),{...selected,asOf}),{status:400});
  await assert.rejects(async()=>getAuthorizedPayrollReview(db,owner,proof(ownerAuth),{start:'0001-01-01',end:'0001-01-01'}),{status:400});
});
test('password expiry after source capture refuses publication and rolls back export audit',async()=>{
  let changed=false;const guarded=probe(async(tx,sql)=>{if(!changed&&sql.includes('FROM segments s JOIN shifts h')){changed=true;await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[ownerAuth.hash]);}});
  const beforeCount=Number((await db.query("SELECT count(*) n FROM audit_events WHERE action='payroll.review_exported'")).rows[0].n);
  await assert.rejects(exportAuthorizedPayrollReview(guarded,owner,proof(ownerAuth),{...selected,format:'json'}),{status:401});
  assert.equal(Number((await db.query("SELECT count(*) n FROM audit_events WHERE action='payroll.review_exported'")).rows[0].n),beforeCount);
  assert.ok((await getAuthorizedPayrollReview(db,owner,proof(ownerAuth),selected)).asOf);
});
test('scoped API proofs are accepted and rechecked after exact source capture',async()=>{
  const credential=await send('/tokens',{name:'Synthetic comparison token',scopes:['reports:read'],days:1});
  const secret=credential.token??credential.secret;assert.equal(typeof secret,'string');const tokenHash=digest(secret),apiActor={...owner,mode:'api' as const};
  const result=await getAuthorizedPayrollReview(db,apiActor,{mode:'api',hash:tokenHash},selected);assert.equal(result.totals.current.workHours,'1.000000');
  let changed=false;const expiring=probe(async(tx,sql)=>{if(!changed&&sql.includes('FROM segments s JOIN shifts h')){changed=true;await tx.query("UPDATE api_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[tokenHash]);}});
  await assert.rejects(getAuthorizedPayrollReview(expiring,apiActor,{mode:'api',hash:tokenHash},selected),{status:403});
});
test('export provides fresh scoped evidence with an audited comparison download',async()=>{
  const exported=await exportAuthorizedPayrollReview(db,owner,proof(ownerAuth),{...selected,format:'csv'});assert.equal(exported.format,'csv');assert.ok(exported.body.includes('3600000001'));assert.ok(exported.body.includes('Not included; review in Time records'));assert.ok(payrollReviewLimits.responseBytes<payrollReviewLimits.outputBytes);
  assert.ok(Number((await db.query("SELECT count(*) n FROM audit_events WHERE action='payroll.review_exported'")).rows[0].n)>=1);
});
test('password HTTP review and both comparison downloads preserve schema, private caching and capture metadata',async()=>{
  const review=await request(app()).get('/api/payroll/review').set('Cookie',ownerAuth.cookie).query(selected);
  assert.equal(review.status,200);assert.match(review.headers['cache-control'],/no-store/);const value=payrollReviewSchema.parse(review.body);assert.equal(value.totals.current.breakMicroseconds,'3600000001');
  for(const format of ['csv','json']){
    const download=await request(app()).get('/api/payroll/review/export').set('Cookie',ownerAuth.cookie).query({...selected,format});
    assert.equal(download.status,200);assert.equal(download.headers['cache-control'],'private, no-store');assert.match(download.headers['content-disposition'],new RegExp('^attachment; filename="stjw-payroll-comparison-2026-09-20-2026-09-20\\.'+format+'"$'));
    assert.match(download.headers['content-type'],format==='csv'?/^text\/csv; charset=utf-8$/:/^application\/json; charset=utf-8$/);
    assert.match(download.headers['x-stjw-report-as-of'],/^\d{4}-\d{2}-\d{2}T.*Z$/);
    if(format==='json'){const captured=payrollReviewSchema.parse(download.body);assert.equal(captured.asOf,download.headers['x-stjw-report-as-of']);assert.equal(captured.preparation.pendingCorrections.count,null);}
    else {assert.ok(download.text.includes(download.headers['x-stjw-report-as-of']));assert.ok(download.text.includes('3600000001'));assert.ok(download.text.includes('Not included; review in Time records'));}
  }
});
test('HTTP review and export deny anonymous, employee and normally authenticated PIN sessions',async()=>{
  const employeeAuth=await login(target.email,target.password),manager=await person('manager'),managerAuth=await login(manager.email,manager.password);
  await send('/auth/pin',{password:manager.password,pin:'865397'},managerAuth);
  const pin=await request(app()).post('/api/auth/login').set('Origin',origin).send({mode:'pin',credential:'865397'});assert.equal(pin.status,200);const pinCookie=(pin.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  assert.equal((await request(app()).get('/api/me').set('Cookie',pinCookie)).body.actor.mode,'pin');
  for(const path of ['/api/payroll/review','/api/payroll/review/export']){
    for(const [cookie,status] of [['',401],[employeeAuth.cookie,403],[pinCookie,403]] as const){
      const denied=await request(app()).get(path).set('Cookie',cookie).query(selected);assert.equal(denied.status,status);assert.match(denied.headers['cache-control'],/no-store/);assert.equal(denied.headers['content-disposition'],undefined);
    }
  }
});
test('HTTP bearer review requires reports:read and remains read-only',async()=>{
  const reporting=await send('/tokens',{name:'Synthetic HTTP comparison reports',scopes:['reports:read'],days:1}),staff=await send('/tokens',{name:'Synthetic HTTP comparison staff',scopes:['staff:read'],days:1});
  for(const [path,format] of [['/api/payroll/review',undefined],['/api/payroll/review/export','csv'],['/api/payroll/review/export','json']] as const){
    const query={...selected,...(format?{format}:{})};
    const allowed=await request(app()).get(path).set('Authorization','Bearer '+reporting.token).query(query);assert.equal(allowed.status,200);assert.match(allowed.headers['cache-control'],/no-store/);
    if(format==='csv')assert.match(allowed.headers['content-type'],/^text\/csv/);else assert.equal(payrollReviewSchema.parse(allowed.body).totals.current.workMicroseconds,'3600000000');
    assert.equal((await request(app()).get(path).set('Authorization','Bearer '+staff.token).query(query)).status,403);
  }
  assert.equal((await request(app()).post('/api/payroll/review').set('Origin',origin).set('Authorization','Bearer '+reporting.token).send(selected)).status,403);
});
test('HTTP comparison query rejects untrusted capture, duplicate dates and unsupported export formats',async()=>{
  for(const path of ['/api/payroll/review','/api/payroll/review/export']){
    assert.equal((await request(app()).get(path).set('Cookie',ownerAuth.cookie).query({...selected,asOf})).status,400);
    assert.equal((await request(app()).get(path).set('Cookie',ownerAuth.cookie).query(selected).query('start='+selected.start)).status,400);
  }
  assert.equal((await request(app()).get('/api/payroll/review/export').set('Cookie',ownerAuth.cookie).query({...selected,format:'xlsx'})).status,400);
});


test('readable comparison CSV gives one row per employee and preserves exact JSON separately',async()=>{
  const response=await request(app()).get('/api/payroll/review/export').set('Cookie',ownerAuth.cookie).query({...selected,format:'csv',presentation:'readable'});
  assert.equal(response.status,200);assert.match(response.text,/"Employee","Selected work hours","Previous work hours"/);assert.match(response.text,/"1.00"/);assert.ok(!response.text.includes('3600000001'));assert.ok(!response.text.includes(target.id));assert.ok(!response.text.includes('row_kind'));
  assert.match(response.text,/Sep 20, 2026/);assert.match(response.text,/No pay calculation or approval/);
  const invalid=await request(app()).get('/api/payroll/review/export').set('Cookie',ownerAuth.cookie).query({...selected,format:'json',presentation:'readable'});
  assert.equal(invalid.status,400);assert.equal(invalid.headers['content-disposition'],undefined);
  const original=await request(app()).get('/api/payroll/review/export').set('Cookie',ownerAuth.cookie).query({...selected,format:'json'});
  assert.equal(original.body.totals.current.breakMicroseconds,'3600000001');
});
