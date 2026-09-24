import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, opaqueToken, type Actor } from '../server/security';
import { getAuthorizedWorkforceReportV2 } from '../server/workforce-report-v2-access';

let db:Database,org:string,unit:string,otherUnit:string,worker:string;
const origin='http://localhost:3197',query={start:'2026-09-20',end:'2026-09-20',group:'day' as const};
const path='/api/reports/v2?start=2026-09-20&end=2026-09-20',csvPath=path.replace('/v2?','/v2/export?');
const app=(database=db)=>createApp(database,{origin,production:false,demo:true,staffDomain:'stjw.org'});
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'v2.access.owner@example.test'});
  org=(await db.query('SELECT id FROM organizations')).rows[0].id;
  const jobs=(await db.query('SELECT id,unit_id FROM jobs ORDER BY id LIMIT 2')).rows;
  unit=jobs[0].unit_id;otherUnit=jobs[1].unit_id;worker=randomUUID();const shift=randomUUID();
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,'v2.access.worker@stjw.org','Synthetic precise worker','employee')",[worker,org]);
  await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,'2026-09-20T14:00:00.123400Z','2026-09-20T14:00:00.123456Z')",[shift,org,worker]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,'work','2026-09-20T14:00:00.123400Z','2026-09-20T14:00:00.123456Z')",[randomUUID(),org,shift,jobs[0].id]);
});
after(async()=>{await db?.close();});
async function reader(mode:'password'|'api'|'pin'='password'){
  const id=randomUUID(),raw=opaqueToken(),hash=digest(raw),csrf=opaqueToken();
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic v2 reader','admin')",[id,org,id+'@stjw.org']);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[org,id,unit]);
  if(mode==='api')await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic v2 token','[\"reports:read\"]',now()+interval '1 hour')",[randomUUID(),org,id,hash]);
  else await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[hash,org,id,mode,csrf]);
  return {actor:{id,org_id:org,name:'Synthetic v2 reader',email:id+'@stjw.org',role:'admin',mode,unit_ids:[unit],scopes:['reports:read']} as Actor,hash,raw};
}
function read(database:Database,r:Awaited<ReturnType<typeof reader>>,route=path){
  const req=request(app(database)).get(route);
  return r.actor.mode==='api'?req.set('Authorization','Bearer '+r.raw):req.set('Cookie','stjw_session='+r.raw);
}
function afterAuthentication(action:()=>Promise<unknown>,api=false):Database{
  let fired=false;
  return {...db,query:async<T extends Row=Row>(sql:string,params?:any[])=>{
    const result=await db.query<T>(sql,params);
    if(!fired&&sql.includes(api?'FROM api_tokens t JOIN users u':'FROM sessions s JOIN users u')){fired=true;await action();}
    return result;
  }};
}
function transactionProbe(probe:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{
  return {...db,transaction:<T>(run:(tx:Queryable)=>Promise<T>)=>db.transaction(tx=>run({query:async<R extends Row=Row>(sql:string,params:any[]=[])=>{
    const result=await tx.query<R>(sql,params);await probe(tx,sql,params);return result;
  }}))};
}
const audits=async(id:string)=>Number((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1 AND action='report.v2_exported'",[id])).rows[0].n);

test('v2 HTTP and CSV preserve exact source evidence while v1 remains millisecond based',async()=>{
  const r=await reader();const result=await read(db,r);
  assert.equal(result.status,200);assert.equal(result.body.schemaVersion,2);assert.equal(result.body.workMicroseconds,'56');
  assert.equal(result.body.rows[0].started_at,'2026-09-20T14:00:00.123400Z');assert.equal(result.body.rows[0].duration_microseconds,'56');
  assert.match(result.headers['cache-control'],/no-store/);assert.equal(result.body.query.group,'day');
  const csv=await read(db,r,csvPath+'&columns=started_at,ended_at,duration_microseconds');
  assert.equal(csv.status,200);assert.equal(csv.text,'\uFEFF"started_at","ended_at","duration_microseconds"\r\n"2026-09-20T14:00:00.123400Z","2026-09-20T14:00:00.123456Z","56"');
  assert.equal(csv.headers['x-stjw-report-version'],'2');assert.equal(csv.headers['x-stjw-duration-unit'],'microsecond');assert.match(csv.headers['x-stjw-report-as-of'],/\.\d{6}Z$/);
  const old=await read(db,r,path.replace('/v2?','?'));assert.equal(old.status,200);assert.equal(old.body.workMs,0);assert.equal(old.body.schemaVersion,undefined);
});
test('v2 strict query and column validation prevents drift without exporting audits',async()=>{
  const r=await reader();
  for(const route of [path+'&precisionVersion=1',path+'&start=2026-09-21',path+'&columns=id',csvPath+'&columns=id,id',csvPath+'&columns=duration_ms',csvPath+'&format=json&columns=id',csvPath+'&format=xml',path.replace('2026-09-20','2026-02-30')]){
    const result=await read(db,r,route);assert.ok([400,422].includes(result.status),route);assert.equal(result.headers['content-disposition'],undefined);
  }
  assert.equal(await audits(r.actor.id),0);
});
test('v2 downloadable JSON retains filters, source metadata and exact durations in one fresh authorized file',async()=>{
  const r=await reader();const result=await read(db,r,csvPath+'&format=json');
  assert.equal(result.status,200);assert.match(result.headers['content-disposition'],/\.json/);assert.match(result.headers['content-type'],/application\/json/);
  assert.equal(result.body.workMicroseconds,'56');assert.equal(result.body.rows[0].duration_microseconds,'56');
  assert.deepEqual(result.body.query,query);assert.equal(result.body.timezone,'America/New_York');
  assert.equal(result.body.range.from,'2026-09-20T04:00:00.000000Z');assert.equal(result.body.range.toExclusive,'2026-09-21T04:00:00.000000Z');
  assert.equal(result.body.asOf,result.headers['x-stjw-report-as-of']);assert.equal(await audits(r.actor.id),1);
});
test('v2 refreshes current role and explicit unit assignments after middleware',async()=>{
  const r=await reader();let wrapped=afterAuthentication(()=>db.query("UPDATE users SET role='employee' WHERE id=$1",[r.actor.id]));
  let result=await read(wrapped,r);assert.equal(result.status,200);assert.deepEqual(result.body.rows,[]);
  await db.query("UPDATE users SET role='manager' WHERE id=$1",[r.actor.id]);
  wrapped=afterAuthentication(()=>db.query('UPDATE user_units SET unit_id=$1 WHERE user_id=$2',[otherUnit,r.actor.id]));
  result=await read(wrapped,r);assert.equal(result.status,200);assert.deepEqual(result.body.rows,[]);
});
test('v2 password and bearer proof revocation after middleware prevents publication',async()=>{
  for(const mode of ['password','api'] as const)for(const route of [path,csvPath,csvPath+'&format=json']){
    const r=await reader(mode);const wrapped=afterAuthentication(()=>mode==='api'?db.query('UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE token_hash=$1',[r.hash]):db.query('DELETE FROM sessions WHERE token_hash=$1',[r.hash]),mode==='api');
    const result=await read(wrapped,r,route);assert.ok([401,403].includes(result.status));assert.equal(result.headers['content-disposition'],undefined);assert.equal(await audits(r.actor.id),0);
  }
});
test('v2 bearer scope and restricted PIN mode remain enforced',async()=>{
  const r=await reader('api');assert.equal((await read(db,r)).body.workMicroseconds,'56');
  await db.query("UPDATE api_tokens SET scopes='[\"staff:read\"]' WHERE token_hash=$1",[r.hash]);assert.equal((await read(db,r)).status,403);
  assert.equal((await read(db,await reader('pin'))).status,403);
  await assert.rejects(getAuthorizedWorkforceReportV2(db,r.actor,{mode:'api',hash:undefined},query), (e:any)=>e.status===401);
});
test('v2 controlled final-expiry and failed-audit fixtures roll back export audit and publish no CSV',async()=>{
  for(const mode of ['password','api'] as const)for(const failAudit of [false,true])for(const format of ['csv','json']){
    const r=await reader(mode);let fired=false;
    const wrapped=transactionProbe(async(tx,sql,params)=>{
      if(!fired&&sql.includes('INSERT INTO audit_events')&&params[3]==='report.v2_exported'){
        fired=true;if(failAudit)throw Error('Synthetic local v2 audit failure');
        await tx.query(`UPDATE ${mode==='api'?'api_tokens':'sessions'} SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`,[r.hash]);
      }
    });
    const result=await read(wrapped,r,csvPath+'&format='+format);assert.equal(fired,true);assert.ok(failAudit?result.status===500:[401,403].includes(result.status));
    assert.equal(result.headers['content-disposition'],undefined);assert.equal(await audits(r.actor.id),0);
  }
});
test('v2 selects repeatable read before authority/source and privately copies input',async()=>{
  const r=await reader();const events:string[]=[];const input={...query};
  const wrapped=transactionProbe(async(_tx,sql)=>{events.push(sql);if(sql.includes('ISOLATION LEVEL'))input.start='invalid-after-parse';});
  const value=await getAuthorizedWorkforceReportV2(wrapped,r.actor,{mode:'password',hash:r.hash},input);
  assert.equal(events[0],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');assert.equal(value.query.start,query.start);assert.equal(value.workMicroseconds,'56');
});


test('readable segment CSV uses selected human headings/local dates while exact source stays untouched',async()=>{
  const r=await reader();
  const csv=await read(db,r,csvPath+'&presentation=readable&columns=employee_name,started_at,duration_microseconds');
  assert.equal(csv.status,200);assert.equal(csv.headers['x-stjw-duration-unit'],'hour');assert.equal(csv.headers['x-stjw-report-presentation'],'readable');
  assert.match(csv.text,/"Employee","Recorded start","Included hours"/);assert.match(csv.text,/Synthetic precise worker/);assert.match(csv.text,/Sep 20, 2026 10:00 AM EDT/);assert.match(csv.text,/"0.00"/);
  assert.ok(!csv.text.includes(worker));assert.ok(!csv.text.includes('duration_microseconds'));assert.equal(await audits(r.actor.id),1);
  assert.equal((await read(db,r)).body.rows[0].duration_microseconds,'56');
  const details=(await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='report.v2_exported'",[r.actor.id])).rows[0].detail;
  assert.equal(details.presentation,'readable');
  assert.equal((await read(db,r,csvPath+'&presentation=readable&format=json')).status,400);
});
test('readable segment export rechecks scope and revocation before publication',async()=>{
  const r=await reader();await db.query("UPDATE users SET role='manager' WHERE id=$1",[r.actor.id]);
  const moved=afterAuthentication(()=>db.query('UPDATE user_units SET unit_id=$1 WHERE user_id=$2',[otherUnit,r.actor.id]));
  const empty=await read(moved,r,csvPath+'&presentation=readable&columns=employee_name,duration_microseconds');
  assert.equal(empty.status,200);assert.ok(!empty.text.includes('Synthetic precise worker'));
  const revoked=afterAuthentication(()=>db.query('DELETE FROM sessions WHERE token_hash=$1',[r.hash]));
  const denied=await read(revoked,r,csvPath+'&presentation=readable');assert.equal(denied.status,401);assert.equal(denied.headers['content-disposition'],undefined);
});
