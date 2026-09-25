import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import request from 'supertest';
import {createApp} from '../server/app';
import {aggregateSegmentsV2} from '../server/reports-v2';
import {aggregateAllowance,getWorkforceOverview,getWorkforceBoard,type AllowanceSchedule} from '../server/workforce-overview';
import {saveAllowanceSnapshot,getAllowanceSnapshot,listAllowanceSnapshots,exportAllowance,renderAllowanceExport} from '../server/workforce-allowance-reviews';
import {canonicalWorkforceUtc,type WorkforceSourceRowV2} from '../shared/workforce-reports-v2';
import {connectDatabase,migrate,type Database,type Queryable,type Row} from '../server/db';
import {initialize} from '../server/seed';
import {digest,opaqueToken,type Actor} from '../server/security';

const userId=randomUUID(),jobId=randomUUID(),unitId=randomUUID(),hour=3_600_000_000n;
const hours=(value:number)=>(BigInt(value)*hour).toString();
const status=(code:number)=>(error:any)=>error?.status===code;
function segment(start:string,end:string|null,changes:Partial<WorkforceSourceRowV2>={}):WorkforceSourceRowV2{
 return {id:randomUUID(),shift_id:randomUUID(),revision:1,user_id:userId,employee_name:'Synthetic worker',job_id:jobId,job_title:'Synthetic job',unit_id:unitId,unit_name:'Synthetic community',kind:'work',started_at:canonicalWorkforceUtc(start),ended_at:end===null?null:canonicalWorkforceUtc(end),...changes};
}
function scheduled(start:string,end:string,changes:Partial<AllowanceSchedule>={}):AllowanceSchedule{
 return {id:randomUUID(),version:1,userId,employeeName:'Synthetic worker',jobId,jobTitle:'Synthetic job',unitId,unitName:'Synthetic community',startsAt:canonicalWorkforceUtc(start),endsAt:canonicalWorkforceUtc(end),...changes};
}
function comparison(rows:WorkforceSourceRowV2[],schedules:AllowanceSchedule[],start='2026-09-21',end=start,zone='UTC',asOf='2027-01-01T00:00:00.000000Z'){
 return aggregateAllowance(aggregateSegmentsV2(rows,{start,end,group:'day'},zone,asOf),schedules);
}
test('allowance retains microseconds across local midnight and reconciles both date cells',()=>{
 const value=comparison([segment('2026-09-22T03:59:59.999999Z','2026-09-22T04:00:00.000002Z')],[scheduled('2026-09-22T04:00:00Z','2026-09-22T04:00:00.000001Z')],'2026-09-21','2026-09-22','America/New_York');
 assert.equal(value.totals.workMicroseconds,'3');assert.equal(value.totals.scheduledMicroseconds,'1');assert.equal(value.totals.aboveScheduledMicroseconds,'2');assert.equal(value.totals.unscheduledWorkMicroseconds,'2');
 assert.deepEqual(value.days.map(row=>[row.date,row.workMicroseconds,row.scheduledMicroseconds,row.aboveScheduledMicroseconds]),[['2026-09-21','1','0','1'],['2026-09-22','2','1','1']]);
});
test('allowance honors 23-hour spring and 25-hour fall local days',()=>{
 for(const [date,start,end,expected] of [['2026-03-08','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',23],['2026-11-01','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z',25]] as const){
  const value=comparison([segment(start,end)],[scheduled(start,end)],date,date,'America/New_York');assert.equal(value.days.length,1);assert.equal(value.totals.workMicroseconds,hours(expected));assert.equal(value.totals.scheduledMicroseconds,hours(expected));assert.equal(value.totals.aboveScheduledMicroseconds,'0');assert.equal(value.totals.unscheduledWorkMicroseconds,'0');
 }
});
test('employee daily overages do not disappear into shorter days',()=>{
 const secondJob=randomUUID(),value=comparison([segment('2026-09-21T08:00:00Z','2026-09-21T18:00:00Z'),segment('2026-09-22T08:00:00Z','2026-09-22T14:00:00Z'),segment('2026-09-21T22:00:00Z','2026-09-22T00:00:00Z',{job_id:secondJob,job_title:'Second synthetic job'})],[scheduled('2026-09-21T08:00:00Z','2026-09-21T16:00:00Z'),scheduled('2026-09-22T08:00:00Z','2026-09-22T16:00:00Z')],'2026-09-21','2026-09-22');
 assert.equal(value.totals.workMicroseconds,hours(18));assert.equal(value.totals.scheduledMicroseconds,hours(16));assert.equal(value.totals.aboveScheduledMicroseconds,hours(4));assert.equal(value.totals.belowScheduledMicroseconds,hours(2));assert.equal(value.jobs.find(row=>row.jobId===secondJob)?.unscheduledWorkMicroseconds,hours(2));
});
test('legacy overlapping schedules form one allowance union and breaks stay separate from outside work',()=>{
 const value=comparison([segment('2026-09-21T08:00:00Z','2026-09-21T10:00:00Z'),segment('2026-09-21T10:00:00Z','2026-09-21T11:00:00Z',{kind:'break'}),segment('2026-09-21T11:00:00Z','2026-09-21T15:00:00Z')],[scheduled('2026-09-21T09:00:00Z','2026-09-21T12:00:00Z'),scheduled('2026-09-21T11:00:00Z','2026-09-21T14:00:00Z')]);
 assert.equal(value.totals.workMicroseconds,hours(6));assert.equal(value.totals.breakMicroseconds,hours(1));assert.equal(value.totals.scheduledMicroseconds,hours(5));assert.equal(value.totals.unscheduledWorkMicroseconds,hours(2));assert.equal(value.totals.aboveScheduledMicroseconds,hours(1));
});
test('switching jobs uses the employee total daily allowance without treating a job change as daily excess',()=>{
 const secondJob=randomUUID(),first=segment('2026-09-21T08:00:00Z','2026-09-21T12:00:00Z'),shift=[scheduled('2026-09-21T08:00:00Z','2026-09-21T16:00:00Z')];
 const within=comparison([first,segment('2026-09-21T12:00:00Z','2026-09-21T16:00:00Z',{job_id:secondJob,job_title:'Second synthetic job'})],shift);assert.equal(within.totals.workMicroseconds,hours(8));assert.equal(within.totals.aboveScheduledMicroseconds,'0');assert.equal(within.totals.belowScheduledMicroseconds,'0');assert.equal(within.totals.unscheduledWorkMicroseconds,hours(4));assert.ok(within.jobs.every(row=>!('aboveScheduledMicroseconds' in row)&&!('belowScheduledMicroseconds' in row)));
 const excess=comparison([first,segment('2026-09-21T12:00:00Z','2026-09-21T18:00:00Z',{job_id:secondJob,job_title:'Second synthetic job'})],shift);assert.equal(excess.totals.aboveScheduledMicroseconds,hours(2));assert.equal(excess.totals.belowScheduledMicroseconds,'0');assert.equal(excess.people[0].aboveScheduledMicroseconds,hours(2));assert.equal(excess.days[0].aboveScheduledMicroseconds,hours(2));assert.equal(excess.jobs.reduce((sum,row)=>sum+BigInt(row.workMicroseconds),0n),BigInt(excess.totals.workMicroseconds));
});
test('open work stops at asOf while future scheduled allowance remains explicitly included',()=>{
 const value=comparison([segment('2026-09-21T09:00:00Z',null)],[scheduled('2026-09-21T09:00:00Z','2026-09-21T17:00:00Z')],'2026-09-21','2026-09-21','UTC','2026-09-21T12:30:00.000001Z');
 assert.equal(value.totals.workMicroseconds,'12600000001');assert.equal(value.totals.scheduledMicroseconds,hours(8));assert.equal(value.totals.belowScheduledMicroseconds,'16199999999');assert.match(value.notice,/future scheduled time/);
 const dup=scheduled('2026-09-21T09:00:00Z','2026-09-21T10:00:00Z');assert.throws(()=>comparison([], [dup,dup]),status(422));
});

let db:Database,org:string,unit:string,otherUnit:string,worker:string,job:string,ownerId:string,scheduleId:string;
const query={start:'2026-09-21',end:'2026-09-21'};
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'allowance.owner@example.test'});
 const first=(await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];org=first.org_id;ownerId=first.id;const jobs=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2')).rows;job=jobs[0].id;unit=jobs[0].unit_id;otherUnit=jobs[1].unit_id;worker=randomUUID();scheduleId=randomUUID();
 await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,'allowance.worker@stjw.org','Synthetic precise allowance worker','employee')",[worker,org]);
 const shift=randomUUID();await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-09-21T14:00:00.123400Z','2026-09-21T14:00:00.123456Z')",[shift,org,worker]);
 await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work','2026-09-21T14:00:00.123400Z','2026-09-21T14:00:00.123456Z')",[randomUUID(),org,shift,job]);
 await db.query("INSERT INTO schedules(id,org_id,user_id,job_id,starts_at,ends_at,note,created_by) VALUES($1,$2,$3,$4,'2026-09-21T14:00:00.123420Z','2026-09-21T14:00:00.123450Z','Synthetic allowance fixture',$5)",[scheduleId,org,worker,job,ownerId]);
});
after(async()=>{await db?.close();});
async function reader(mode:'password'|'api'='password'){
 const id=randomUUID(),raw=opaqueToken(),hash=digest(raw),csrf=opaqueToken(),name='Synthetic allowance manager',email=id+'@stjw.org';
 await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,'manager')",[id,org,email,name]);await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[org,id,unit]);
 if(mode==='api')await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic allowance token','[\"reports:read\"]',now()+interval '1 hour')",[randomUUID(),org,id,hash]);
 else await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')",[hash,org,id,csrf]);
 return {raw,csrf,actor:{id,org_id:org,name,email,role:'manager',mode,unit_ids:[unit],scopes:['reports:read']} as Actor,proof:{mode,hash}};
}
function probe(action:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{
 return {...db,transaction:<T>(run:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>run({query:async<R extends Row=Row>(sql:string,params:any[]=[])=>{const result=await tx.query<R>(sql,params);await action(tx,sql,params);return result;}}))};
}
test('overview uses one repeatable snapshot and current scope; selected employee never filters today/week team totals',async()=>{
 const r=await reader(),statements:string[]=[];const wrapped=probe(async(_tx,sql)=>{statements.push(sql);});
 const result=await getWorkforceOverview(wrapped,r.actor,r.proof,{...query,unitId:unit,userId:worker});assert.equal(statements[0],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');assert.equal(result.selected.totals.workMicroseconds,'56');assert.equal(result.selected.totals.scheduledMicroseconds,'30');assert.equal(result.selected.totals.aboveScheduledMicroseconds,'26');assert.equal(result.selected.totals.unscheduledWorkMicroseconds,'26');assert.equal(result.selected.query.userId,worker);assert.equal(result.today.query.userId,undefined);assert.equal(result.week.query.userId,undefined);assert.equal(result.today.query.unitId,unit);assert.equal(result.week.query.unitId,unit);assert.match(result.asOf,/\.\d{6}Z$/);
 await db.query('UPDATE user_units SET unit_id=$1 WHERE user_id=$2',[otherUnit,r.actor.id]);const restricted=await getWorkforceOverview(db,r.actor,r.proof,{...query,unitId:unit});assert.equal(restricted.selected.people.length,0);assert.equal(restricted.selected.totals.workMicroseconds,'0');assert.equal(restricted.selected.totals.scheduledMicroseconds,'0');assert.equal((await getWorkforceOverview(db,r.actor,r.proof,query)).selected.people.length,0);
});
test('fresh account, password, bearer scope and board proof reject stale authority',async()=>{
 const password=await reader();await db.query('DELETE FROM sessions WHERE token_hash=$1',[password.proof.hash]);for(const read of [()=>getWorkforceOverview(db,password.actor,password.proof,query),()=>getWorkforceBoard(db,password.actor,password.proof)])await assert.rejects(read,status(401));
 const role=await reader();await db.query("UPDATE users SET role='employee' WHERE id=$1",[role.actor.id]);await assert.rejects(getWorkforceOverview(db,role.actor,role.proof,query),status(403));
 const token=await reader('api');assert.equal((await getWorkforceOverview(db,token.actor,token.proof,query)).selected.totals.workMicroseconds,'56');await db.query("UPDATE api_tokens SET scopes='[\"staff:read\"]' WHERE token_hash=$1",[token.proof.hash]);await assert.rejects(getWorkforceOverview(db,token.actor,token.proof,query),status(403));await assert.rejects(saveAllowanceSnapshot(db,token.actor,token.proof,{commandId:randomUUID(),query}),status(403));
});
test('live team returns exact server anchors and job identity only inside the refreshed unit scope',async()=>{
 const r=await reader(),liveWorker=randomUUID(),shift=randomUUID();await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic live clock worker','employee')",[liveWorker,org,liveWorker+'@stjw.org']);
 await db.query("INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[shift,org,liveWorker]);await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at) VALUES($1,$2,$3,$4,'break',clock_timestamp()-interval '5 minutes')",[randomUUID(),org,shift,job]);
 const board=await getWorkforceBoard(db,r.actor,r.proof);assert.match(board.asOf,/\.\d{6}Z$/);const current=board.rows.find(row=>row.user_id===liveWorker);assert.ok(current);assert.equal(current.job_id,job);assert.equal(current.unit_id,unit);assert.equal(current.kind,'break');assert.match(current.segment_started_at,/\.\d{6}Z$/);assert.ok(current.segment_started_at<=board.asOf);
 await db.query('UPDATE user_units SET unit_id=$1 WHERE user_id=$2',[otherUnit,r.actor.id]);assert.equal((await getWorkforceBoard(db,r.actor,r.proof)).rows.length,0);
 await db.query('UPDATE segments SET ended_at=clock_timestamp() WHERE shift_id=$1',[shift]);await db.query('UPDATE shifts SET ended_at=clock_timestamp() WHERE id=$1',[shift]);
});
test('saved reviews preserve exact source and labels after schedules change, retry once and reject conflicting commands',async()=>{
 const r=await reader(),commandId=randomUUID(),input={commandId,query:{...query,unitId:unit,userId:worker}},receipt=await saveAllowanceSnapshot(db,r.actor,r.proof,input),initial=await getAllowanceSnapshot(db,r.actor,r.proof,receipt.id);assert.equal(receipt.replayed,false);assert.equal(initial.period.totals.scheduledMicroseconds,'30');assert.equal(initial.period.totals.workMicroseconds,'56');
 await db.query("UPDATE schedules SET ends_at='2026-09-21T14:00:00.123455Z' WHERE id=$1",[scheduleId]);
 assert.deepEqual(await getAllowanceSnapshot(db,r.actor,r.proof,receipt.id),initial);assert.equal((await getWorkforceOverview(db,r.actor,r.proof,query)).selected.totals.scheduledMicroseconds,'35');
 const retry=await saveAllowanceSnapshot(db,r.actor,r.proof,input);assert.equal(retry.id,receipt.id);assert.equal(retry.replayed,true);await assert.rejects(saveAllowanceSnapshot(db,r.actor,r.proof,{commandId,query}),status(409));
 const raw=(await db.query('SELECT source,payload FROM workforce_allowance_reviews WHERE id=$1',[receipt.id])).rows[0];assert.equal(raw.source.report.rows[0].duration_microseconds,'56');assert.equal(raw.source.schedules[0].endsAt,'2026-09-21T14:00:00.123450Z');assert.deepEqual(raw.payload,initial);
 await assert.rejects(db.query("UPDATE workforce_allowance_reviews SET payload='{}' WHERE id=$1",[receipt.id]));await assert.rejects(db.query('DELETE FROM workforce_allowance_reviews WHERE id=$1',[receipt.id]));
 assert.ok((await listAllowanceSnapshots(db,r.actor,r.proof)).snapshots.some(row=>row.id===receipt.id));await db.query('UPDATE user_units SET unit_id=$1 WHERE user_id=$2',[otherUnit,r.actor.id]);assert.ok(!(await listAllowanceSnapshots(db,r.actor,r.proof)).snapshots.some(row=>row.id===receipt.id));await assert.rejects(getAllowanceSnapshot(db,r.actor,r.proof,receipt.id),status(404));await assert.rejects(exportAllowance(db,r.actor,r.proof,{},'csv',receipt.id),status(404));await assert.rejects(saveAllowanceSnapshot(db,r.actor,r.proof,input),status(404));
 await db.query("UPDATE schedules SET ends_at='2026-09-21T14:00:00.123450Z' WHERE id=$1",[scheduleId]);
});
test('final session expiry rolls back saved evidence and export audits before publishing',async()=>{
 for(const operation of ['save','export'] as const){const r=await reader(),commandId=randomUUID();let fired=false;const wrapped=probe(async(tx,sql,params)=>{if(!fired&&sql.includes('INSERT INTO audit_events')&&params[3]===(operation==='save'?'workforce.allowance_review_saved':'workforce.allowance_exported')){fired=true;await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[r.proof.hash]);}});
  await assert.rejects(operation==='save'?saveAllowanceSnapshot(wrapped,r.actor,r.proof,{commandId,query}):exportAllowance(wrapped,r.actor,r.proof,query,'csv'),status(401));assert.equal(fired,true);assert.equal((await db.query('SELECT id FROM workforce_allowance_reviews WHERE command_id=$1',[commandId])).rows.length,0);assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action IN ('workforce.allowance_review_saved','workforce.allowance_exported')",[r.actor.id])).rows.length,0);
 }
});
test('concurrent retries of one review command create one immutable capture and one audit',async()=>{
 const r=await reader(),commandId=randomUUID(),receipts=await Promise.all([saveAllowanceSnapshot(db,r.actor,r.proof,{commandId,query}),saveAllowanceSnapshot(db,r.actor,r.proof,{commandId,query})]);assert.equal(receipts[0].id,receipts[1].id);assert.deepEqual(receipts.map(value=>value.replayed).sort(),[false,true]);assert.equal((await db.query('SELECT id FROM workforce_allowance_reviews WHERE command_id=$1',[commandId])).rows.length,1);assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='workforce.allowance_review_saved'",[r.actor.id])).rows.length,1);
});
test('HTTP exports are private attachments and saved review mutations require current session CSRF',async()=>{
 const r=await reader(),origin='http://localhost:3197',app=createApp(db,{origin,production:false,demo:true,staffDomain:'stjw.org'}),cookie='stjw_session='+r.raw,params='?start='+query.start+'&end='+query.end;
 assert.equal((await request(app).get('/api/workforce/overview'+params)).status,401);const overview=await request(app).get('/api/workforce/overview'+params).set('Cookie',cookie);assert.equal(overview.status,200);assert.equal(overview.body.selected.totals.workMicroseconds,'56');assert.match(overview.headers['cache-control'],/no-store/);
 const csv=await request(app).get('/api/workforce/allowance/export.csv'+params).set('Cookie',cookie);assert.equal(csv.status,200);assert.match(csv.headers['content-disposition'],/attachment.*\.csv/);assert.match(csv.text,/Hours over schedule/);assert.match(csv.headers['cache-control'],/no-store/);
 assert.equal((await request(app).get('/api/workforce/overview'+params+'&asOf=2026-01-01').set('Cookie',cookie)).status,400);
 const body={commandId:randomUUID(),query};assert.equal((await request(app).post('/api/workforce/allowance/snapshots').set('Cookie',cookie).set('Origin',origin).send(body)).status,403);const saved=await request(app).post('/api/workforce/allowance/snapshots').set('Cookie',cookie).set('Origin',origin).set('X-CSRF-Token',r.csrf).send(body);assert.equal(saved.status,201);const read=await request(app).get('/api/workforce/allowance/snapshots/'+saved.body.id).set('Cookie',cookie);assert.equal(read.status,200);assert.equal(read.body.period.totals.workMicroseconds,'56');
});
test('CSV neutralizes formulas and Excel presents typed rounded hours with readable sheets and unchanged source',async()=>{
 const period=comparison([segment('2026-09-21T09:00:00Z','2026-09-21T10:15:00.123456Z',{employee_name:'=Synthetic formula',job_title:'+Synthetic job',unit_name:'@Synthetic community'})],[]),before=JSON.stringify(period),document={period,organizationName:'-Synthetic organization',timezone:'UTC',asOf:'2026-09-21T20:00:00.000000Z'};
 const csv=await renderAllowanceExport(document,'csv');assert.equal(typeof csv,'string');assert.ok(String(csv).startsWith('\uFEFF'));assert.match(String(csv),/Worked hours/);assert.match(String(csv),/'=Synthetic formula/);assert.ok(!String(csv).includes('Synthetic job'));assert.ok(!String(csv).includes('Synthetic community'));assert.match(String(csv),/'-Synthetic organization/);assert.match(String(csv),/1\.25/);assert.ok(!String(csv).includes(userId));assert.ok(!String(csv).includes('123456'));
 const book=new ExcelJS.Workbook();await book.xlsx.load(await renderAllowanceExport(document,'xlsx') as any);assert.deepEqual(book.worksheets.map(sheet=>sheet.name),['Employee summary','Jobs and communities','Daily review']);const people=book.getWorksheet('Employee summary')!;assert.equal(people.getCell('B8').value,1.25);assert.equal(people.getCell('B8').numFmt,'#,##0.00');assert.equal(people.views[0].state,'frozen');assert.ok(people.getColumn(1).width!>=30);assert.equal(people.getCell('A8').type,ExcelJS.ValueType.String);assert.match(String(people.getCell('A8').value),/Synthetic formula/);assert.ok(people.getRow(4).height!>=85);const jobs=book.getWorksheet('Jobs and communities')!;assert.equal(jobs.getCell('B7').type,ExcelJS.ValueType.String);assert.equal(jobs.getCell('C7').type,ExcelJS.ValueType.String);assert.ok(!JSON.stringify(jobs.getRow(6).values).includes('Hours over schedule'));assert.equal(JSON.stringify(period),before);
 const r=await reader(),exported=await exportAllowance(db,r.actor,r.proof,query,'xlsx');assert.ok(Buffer.isBuffer(exported.body));assert.match(exported.asOf,/\.\d{6}Z$/);assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='workforce.allowance_exported'",[r.actor.id])).rows.length,1);
});
test('Excel reserves printable title height for long organization names without inflating short banners',async()=>{
 const period=comparison([],[]),organizationName='Synthetic Saint Joseph the Worker School, Parish, Early Childhood Education and Extended Day Community Administration';
 const long=new ExcelJS.Workbook();await long.xlsx.load(await renderAllowanceExport({organizationName,timezone:'UTC',asOf:'2026-09-22T00:00:00.000000Z',period},'xlsx') as any);
 for(const sheet of long.worksheets){assert.equal(sheet.getCell('A1').value,organizationName+' · '+sheet.name);assert.ok(sheet.getRow(1).height!>=60);assert.ok(sheet.getRow(1).height!<=409);assert.equal(sheet.getCell('A1').alignment.wrapText,true);assert.equal(sheet.getCell('A1').font.size,20);assert.equal(sheet.pageSetup.printTitlesRow,'1:6');}
 const short=new ExcelJS.Workbook();await short.xlsx.load(await renderAllowanceExport({organizationName:'STJW',timezone:'UTC',asOf:'2026-09-22T00:00:00.000000Z',period},'xlsx') as any);assert.ok(short.worksheets.every(sheet=>sheet.getRow(1).height===42));
});
