import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { connectDatabase, migrate, type Database, type Queryable, type Row } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { inspectImportWorkbook, convertImportWorkbook, downloadImportWorkbookTemplate } from '../server/import-workbooks';
import { suggestImport, MODEL } from '../server/jev';
import { staffImportColumns } from '../shared/staff-imports';

const origin='http://localhost:3000', password='Synthetic-staff-workbook-'+randomUUID();
type Auth={actor:Actor;cookie:string;csrf:string;hash:string};
let db:Database, app:ReturnType<typeof createApp>, owner:Auth, manager:Auth, employee:Auth, unitId:string;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function authenticated(headers:unknown):Promise<Auth>{
  assert.ok(Array.isArray(headers));const cookie=String(headers[0]).split(';')[0];
  const me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  return {actor:me.body.actor,cookie,csrf:me.body.actor.csrf,hash:digest(cookie.slice(cookie.indexOf('=')+1))};
}
function send(who:Auth,path:string,body:object,method:'post'|'patch'='post'){
  return request(app)[method](path).set('Origin',origin).set('Cookie',who.cookie).set('X-CSRF-Token',who.csrf).send(body);
}
async function provision(role:'manager'|'employee'){
  const input={name:'Synthetic staff workbook '+role,email:randomUUID()+'@example.test',role,unitIds:[unitId],jobIds:[]};
  const created=await send(owner,'/api/staff',input);assert.equal(created.status,201,JSON.stringify(created.body));
  const token=new URL(created.body.setupUrl).hash.slice(7);
  const setup=await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password});assert.equal(setup.status,200);
  return {auth:await authenticated(setup.headers['set-cookie']),input};
}
async function file(role='employee',units=unitId){
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Synthetic staff');
  sheet.addRow([...staffImportColumns]);sheet.addRow(['Synthetic staff',randomUUID()+'@example.test',role,units,'']);
  const buffer=Buffer.from(await book.xlsx.writeBuffer());return {kind:'staff' as const,base64:buffer.toString('base64'),sheetId:1,headerRow:1,expectedWorkbookHash:sha(buffer)};
}
function wrapped(beforeFinal?:()=>Promise<void>,afterQuery?:(tx:Queryable,sql:string,params:any[])=>Promise<void>):Database{
  let transactions=0;return {...db,transaction:async action=>{
    if(++transactions===2&&beforeFinal)await beforeFinal();
    return db.transaction(tx=>action({query:async<T extends Row>(sql:string,params:any[]=[])=>{
      const result=await tx.query<T>(sql,params);if(afterQuery)await afterQuery(tx,sql,params);return result;
    }}));
  }};
}
async function count(action:string){return Number((await db.query('SELECT count(*) AS n FROM audit_events WHERE action=$1',[action])).rows[0].n);}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'staff.workbook.owner@example.test'});
  app=createApp(db,{origin,production:false,demo:false,staffDomain:'example.test'});
  const person=(await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token=await db.transaction(tx=>issueSetup(tx,person as {id:string;org_id:string}));
  const setup=await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password});assert.equal(setup.status,200);
  owner=await authenticated(setup.headers['set-cookie']);const me=await request(app).get('/api/me').set('Cookie',owner.cookie);unitId=me.body.units[0].id;
  manager=(await provision('manager')).auth;employee=(await provision('employee')).auth;
});
after(async()=>{mock.restoreAll();await db?.close();});

test('staff workbook manager downloads blank template and conversion writes no accounts or previews',async()=>{
  const template=await downloadImportWorkbookTemplate(db,manager.actor,manager.hash,{kind:'staff'});
  assert.equal(template.hash,sha(template.buffer));const book=new ExcelJS.Workbook();await book.xlsx.load(template.buffer as any);
  const headerValues=book.worksheets[0].getRow(1).values;assert.ok(Array.isArray(headerValues));assert.deepEqual(headerValues.slice(1),staffImportColumns);assert.equal(book.worksheets[0].getCell('A2').value,null);
  const before=(await db.query('SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM import_batches) AS batches')).rows;
  const input=await file(),inspected=await inspectImportWorkbook(db,manager.actor,manager.hash,{kind:'staff',base64:input.base64,sheetId:1});assert.equal(inspected.samples.length,2);
  const result=await convertImportWorkbook(db,manager.actor,manager.hash,input);assert.equal(result.rowCount,1);
  assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM import_batches) AS batches')).rows,before);
  const preview=await send(manager,'/api/imports/staff/preview',{csv:result.csv});assert.equal(preview.status,200,JSON.stringify(preview.body));
  const applied=await send(manager,`/api/imports/staff/${preview.body.id}/apply`,{sourceHash:preview.body.sourceHash});assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(applied.body.created,1);assert.equal(applied.body.accounts.length,1);
});
test('workbook conversion cannot authorize a manager to import administrators or unassigned units',async()=>{
  for(const input of [await file('admin'),await file('employee',randomUUID())]){
    const result=await convertImportWorkbook(db,manager.actor,manager.hash,input);
    const preview=await send(manager,'/api/imports/staff/preview',{csv:result.csv});assert.equal(preview.status,403);
  }
});
test('staff workbook requires an actual matching password session and current management role',async()=>{
  for(const hash of [undefined,'f'.repeat(64),owner.hash])await assert.rejects(downloadImportWorkbookTemplate(db,manager.actor,hash,{kind:'staff'}),(e:any)=>e.status===401);
  await assert.rejects(downloadImportWorkbookTemplate(db,{...employee.actor,role:'owner'},employee.hash,{kind:'staff'}),(e:any)=>e.status===403);
  await assert.rejects(downloadImportWorkbookTemplate(db,owner.actor,owner.hash,{kind:'staff',unitId}),(e:any)=>e.name==='ZodError');
  const result=await request(app).get('/api/import-workbooks/template?kind=staff').set('Cookie',manager.cookie);
  assert.equal(result.status,200);assert.match(result.headers['cache-control'],/private, no-store/);assert.match(result.headers['content-disposition'],/stjw-staff-template.xlsx/);
});
test('logout and demotion committed after worker preparation prevent result publication and audit',async()=>{
  for(const change of ['logout','role'] as const){
    const person=await provision('manager'),before=await count('import.workbook_converted');
    const gated=wrapped(async()=>{
      const result=change==='logout'?await send(person.auth,'/api/auth/logout',{}):await send(owner,`/api/staff/${person.auth.actor.id}`,{...person.input,expectedRevision:await testStaffRevision(db,person.auth.actor.id),role:'employee',active:true},'patch');
      assert.ok(result.status<300,JSON.stringify(result.body));
    });
    // Staff role changes revoke existing sessions as well as changing authority.
    await assert.rejects(convertImportWorkbook(gated,person.auth.actor,person.auth.hash,await file()),(e:any)=>e.status===401);
    assert.equal(await count('import.workbook_converted'),before);
  }
});
test('staff workbook audit failure rolls back without publishing converted data',async()=>{
  const before=await count('import.workbook_converted');
  const gated=wrapped(undefined,async(tx,sql,params)=>{if(sql.startsWith('INSERT INTO audit_events')&&params.includes('import.workbook_converted'))await tx.query('SELECT 1/0');});
  await assert.rejects(convertImportWorkbook(gated,manager.actor,manager.hash,await file()));assert.equal(await count('import.workbook_converted'),before);
});

test('Jev advice ends database work before provider call, rechecks proof, and protects cached answers',async()=>{
  process.env.TYPESAFE_API_KEY='synthetic-unit-test-not-a-provider-key';
  let calls=0;const requests:any[]=[];
  const provider=mock.method(TypeSafeClient.prototype,'systemOne',((input:unknown)=>{
    calls++;requests.push(input);return {withResponse:async()=>({requestId:'synthetic',data:{model:MODEL,answers:{category:{choice:'employees',confidence:0.9,probabilities:{employees:0.9,other:0.1}},sufficient:{noul:0.9}}}})};
  }) as any);
  try{
    let active=0;const observed:Database={...db,transaction:async action=>{active++;try{return await db.transaction(action);}finally{active--;}}};
    provider.mock.mockImplementation(((input:unknown)=>{assert.equal(active,0);calls++;requests.push(input);return {withResponse:async()=>({requestId:'synthetic',data:{model:MODEL,answers:{category:{choice:'employees',confidence:0.9,probabilities:{employees:0.9,other:0.1}},sufficient:{noul:0.9}}}})};}) as any);
    const labels=['department','staff contact'];const result=await suggestImport(observed,manager.actor,labels,manager.hash);assert.equal(result.cached,false);assert.equal(result.reviewRequired,true);
    const cached=await suggestImport(db,manager.actor,labels,manager.hash);assert.equal(cached.cached,true);assert.equal(calls,1);
    assert.deepEqual(Object.keys(requests[0].state).sort(),['headers','sourceHash']);assert.deepEqual(requests[0].state.headers,labels);
    for(const hash of [undefined,owner.hash])await assert.rejects(suggestImport(db,manager.actor,labels,hash),(e:any)=>e.status===401);
    await assert.rejects(suggestImport(db,{...employee.actor,role:'owner'},labels,employee.hash),(e:any)=>e.status===403);assert.equal(calls,1);
    const response=await send(manager,'/api/imports/suggest',{headers:labels});assert.equal(response.status,200);assert.match(response.headers['cache-control'],/private, no-store/);
  }finally{provider.mock.restore();delete process.env.TYPESAFE_API_KEY;}
});
test('Jev successful and failed provider responses refresh logout proof without retaining an answer',async()=>{
  process.env.TYPESAFE_API_KEY='synthetic-unit-test-not-a-provider-key';
  try{for(const fail of [false,true]){
    const person=await provision('manager'),before=await count('jev.import_suggestion');
    const provider=mock.method(TypeSafeClient.prototype,'systemOne',(()=>({withResponse:async()=>{
      assert.equal((await send(person.auth,'/api/auth/logout',{})).status,200);if(fail)throw new Error('Synthetic provider failure');
      return {requestId:'synthetic',data:{model:MODEL,answers:{category:{choice:'other',confidence:0.9,probabilities:{other:0.9}},sufficient:{noul:0.2}}}};
    }})) as any);
    try{await assert.rejects(suggestImport(db,person.auth.actor,['unique '+randomUUID()],person.auth.hash),(e:any)=>e.status===401);assert.equal(await count('jev.import_suggestion'),before);}finally{provider.mock.restore();}
  }}finally{delete process.env.TYPESAFE_API_KEY;}
});
