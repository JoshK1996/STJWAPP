import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, type Database, type Row, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { initialDefinition, initialWorkforceDefinitionV2 } from "../shared/report-library";
import { saveReport } from "../server/report-library";

const origin="http://localhost:3000", options={origin,production:false,staffDomain:"stjw.org",demo:true};
const password="Synthetic-layout-"+randomUUID();
type Auth={cookie:string;csrf:string;hash:string;actor:Actor};
let db:Database, app:ReturnType<typeof createApp>, owner:Auth;
const layout=(changes:Record<string,unknown>={})=>({id:randomUUID(),version:0,name:"Synthetic private layout",description:"No real records",definition:initialDefinition("workforce"),archived:false,reason:"Synthetic reviewed layout",...changes});
async function authenticate(target:ReturnType<typeof createApp>,response:any):Promise<Auth>{
 assert.equal(response.status,200);const cookie=String(response.headers["set-cookie"][0]).split(";")[0];
 const me=await request(target).get("/api/me").set("Cookie",cookie);assert.equal(me.status,200);
 return{cookie,csrf:me.body.actor.csrf,hash:digest(cookie.slice(cookie.indexOf("=")+1)),actor:me.body.actor};
}
function send(target:ReturnType<typeof createApp>,auth:Auth,path:string,body?:unknown,method="post"){
 return (request(target) as any)[method]("/api"+path).set("Cookie",auth.cookie).set("Origin",origin).set("X-CSRF-Token",auth.csrf).send(body);
}
async function person(role="employee"){
 const unit=(await db.query("SELECT id FROM units WHERE org_id=$1 ORDER BY id LIMIT 1",[owner.actor.org_id])).rows[0];
 const email=randomUUID()+"@stjw.org",created=await send(app,owner,"/staff",{name:"Synthetic layout reviewer",email,role,unitIds:[unit.id],jobIds:[]});assert.equal(created.status,201);
 const setup=await request(app).post("/api/auth/setup").set("Origin",origin).send({token:new URL(created.body.setupUrl).hash.slice(7),password});assert.equal(setup.status,200);
 const auth=await authenticate(app,await request(app).post("/api/auth/login").set("Origin",origin).send({email,mode:"password",credential:password}));return auth;
}
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:"layout.session.owner@example.test"});app=createApp(db,options);
 const row=(await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];const token=await db.transaction(tx=>issueSetup(tx,row as {id:string;org_id:string}));
 owner=await authenticate(app,await request(app).post("/api/auth/setup").set("Origin",origin).send({token,password}));
});
after(async()=>{await db?.close();});
async function counts(id:string){return(await db.query(`SELECT
 (SELECT count(*)::int FROM saved_reports WHERE id=$1) AS reports,
 (SELECT count(*)::int FROM saved_report_history WHERE report_id=$1) AS history,
 (SELECT count(*)::int FROM audit_events WHERE target_id=$1::text AND action='report_library.saved') AS audits`,[id])).rows[0];}

// Hooks run before the first domain transaction, or before an old unguarded
// direct layout query. Middleware has already accepted the real login proof.
function beforeLayout(action:()=>Promise<void>){let fired=false;const gate=async()=>{if(!fired){fired=true;await action();}};
 const wrapped:Database={...db,query:async<T extends Row=Row>(sql:string,values?:any[])=>{if(sql.includes("FROM saved_reports"))await gate();return db.query<T>(sql,values);},transaction:async fn=>{await gate();return db.transaction(fn);}};
 return{app:createApp(wrapped,options),fired:()=>fired};
}
test("normal-auth logout after middleware denies a private layout save",async()=>{
 const auth=await person(),input=layout(),gated=beforeLayout(async()=>{const logout=await send(app,auth,"/auth/logout",{});assert.equal(logout.status,200);});
 const response=await send(gated.app,auth,"/report-library",input),state=await counts(input.id);
 console.log("layout-session-logout",JSON.stringify({status:response.status,...state}));
 assert.ok(gated.fired());assert.equal(response.status,401);assert.deepEqual(state,{reports:0,history:0,audits:0});
});

// Accelerate ONLY the INSERT for one new normally authenticated session. No
// existing session/evidence is edited, and no auth/proof predicate is skipped.
async function shortLogin(auth:Auth,afterQuery:(sql:string,values:any[]|undefined)=>boolean){
 let inserting=true,expiresAt=0,observed=false;
 const query=(tx:Queryable)=>async<T extends Row=Row>(sql:string,values?:any[])=>{
  let actual=values;
  if(inserting&&sql.startsWith("INSERT INTO sessions(")&&values?.[2]===auth.actor.id){actual=[...values];expiresAt=Date.now()+2500;actual[5]=new Date(expiresAt);}
  const result=await tx.query<T>(sql,actual);
  if(!inserting&&!observed&&afterQuery(sql,values)){observed=true;assert.ok(Date.now()<expiresAt,"domain/audit query must execute before accelerated expiry");await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now())+80));}
  return result;
 };
 const wrapped:Database={...db,query:query(db),transaction:fn=>db.transaction(tx=>fn({query:query(tx)}))},target=createApp(wrapped,options);
 const next=await authenticate(target,await request(target).post("/api/auth/login").set("Origin",origin).send({email:auth.actor.email,mode:"password",credential:password}));inserting=false;
 assert.ok(expiresAt>Date.now());return{app:target,auth:next,observed:()=>observed};
}
test("normal-auth accelerated login expiry after actual save audit rolls back the layout",async()=>{
 const auth=await person(),input=layout(),short=await shortLogin(auth,(sql,values)=>sql.startsWith("INSERT INTO audit_events")&&values?.[3]==="report_library.saved"&&values[4]===input.id);
 const response=await send(short.app,short.auth,"/report-library",input),state=await counts(input.id);
 console.log("layout-session-expiry",JSON.stringify({status:response.status,...state}));
 assert.ok(short.observed());assert.equal(response.status,401);assert.deepEqual(state,{reports:0,history:0,audits:0});
});

for(const action of ["list","history","retry","archive","run","export"]){
 test(`normal-auth logout after middleware denies layout ${action}`,async()=>{
  const auth=await person(),input=layout(),created=await send(app,auth,"/report-library",input);assert.equal(created.status,200);
  const gated=beforeLayout(async()=>{assert.equal((await send(app,auth,"/auth/logout",{})).status,200);});
  const path=action==="list"?"/report-library":action==="retry"||action==="archive"?"/report-library":`/report-library/${input.id}/${action}${action==="run"||action==="export"?"?version=999":""}`;
  const body=action==="retry"?input:action==="archive"?{...input,version:1,archived:true,reason:"Archive synthetic layout"}:undefined;
  const response=await send(gated.app,auth,path,body,body?"post":"get");
  assert.ok(gated.fired());assert.equal(response.status,401);assert.equal(response.body.rows,undefined);
  assert.deepEqual(await counts(input.id),{reports:1,history:1,audits:1});
 });
}
for(const action of ["list","history","run","export"]){
 test(`normal-auth final live expiry suppresses layout ${action} publication`,async()=>{
  const auth=await person(),input=layout();assert.equal((await send(app,auth,"/report-library",input)).status,200);
  const short=await shortLogin(auth,sql=>action==="history"?sql.startsWith("SELECT version,snapshot"):sql.includes("SELECT * FROM saved_reports"));
  const path=action==="list"?"/report-library":`/report-library/${input.id}/${action}${action==="run"||action==="export"?"?version=999":""}`;
  const response=await send(short.app,short.auth,path,undefined,"get");
  assert.ok(short.observed());assert.equal(response.status,401);assert.equal(response.body.rows,undefined);
 });
}
async function login(auth:Auth){return authenticate(app,await request(app).post("/api/auth/login").set("Origin",origin).send({email:auth.actor.email,mode:"password",credential:password}));}
async function change(auth:Auth,role:string,unitIds=auth.actor.unit_ids){
 const result=await send(app,owner,`/staff/${auth.actor.id}`,{expectedRevision:await testStaffRevision(db,auth.actor.id),name:auth.actor.name,email:auth.actor.email,role,unitIds,jobIds:[],active:true},"patch");assert.equal(result.status,200);
 return login(auth);
}
test("normal-auth role loss preserves archived author custody but denies active save and restore",async()=>{
 const original=await person("finance"),input=layout({definition:initialDefinition("compensation")});
 assert.equal((await send(app,original,"/report-library",input)).status,200);
 const current=await change(original,"employee"),archive={...input,version:1,archived:true,reason:"Retain former source layout as author"};
 await assert.rejects(saveReport(db,original.actor,current.hash,{...input,version:1}),error=>(error as any).status===403);
 const result=await saveReport(db,original.actor,current.hash,archive);assert.equal(result.archived,true);assert.equal(result.version,2);
 const list=await send(app,current,"/report-library",undefined,"get");assert.equal(list.status,200);assert.ok(list.body.rows.some((row:any)=>row.id===input.id&&row.archived));
 const history=await send(app,current,`/report-library/${input.id}/history`,undefined,"get");assert.equal(history.status,200);assert.equal(history.body.rows.length,2);
 assert.equal((await send(app,current,"/report-library",{...input,version:2,reason:"Attempt unavailable source restoration"})).status,403);
 const another=await person();assert.equal((await send(app,another,`/report-library/${input.id}/history`,undefined,"get")).status,404);
 assert.deepEqual(await counts(input.id),{reports:1,history:2,audits:2});
});
test("normal-auth current membership replaces supplied actor membership before active saves",async()=>{
 const original=await person("manager"),input=layout({definition:{...initialDefinition("workforce"),unitId:original.actor.unit_ids[0]}});
 assert.equal((await send(app,original,"/report-library",input)).status,200);
 const different=(await db.query("SELECT id FROM units WHERE org_id=$1 AND id<>$2 ORDER BY id LIMIT 1",[owner.actor.org_id,original.actor.unit_ids[0]])).rows[0];
 const current=await change(original,"manager",[different.id]);
 await assert.rejects(saveReport(db,original.actor,current.hash,{...input,version:1}),error=>(error as any).status===403);
 assert.equal((await send(app,current,"/report-library",{...input,version:1,archived:true})).status,200);
});
test("normal-auth fingerprint replay returns current later row and keeps v1/v2 definition bytes",async()=>{
 const auth=await person(),input=layout();const first=await saveReport(db,auth.actor,auth.hash,input);assert.equal(first.version,1);
 const next={...input,version:1,name:"Later synthetic layout",definition:initialWorkforceDefinitionV2(),reason:"Explicitly select precision version two"};
 const changed=await saveReport(db,auth.actor,auth.hash,next);assert.equal(changed.version,2);
 const retry=await saveReport(db,auth.actor,auth.hash,input);assert.equal(retry.version,2);assert.equal(retry.name,next.name);assert.deepEqual(retry.definition,next.definition);
 const history=await send(app,auth,`/report-library/${input.id}/history`,undefined,"get");assert.equal(history.status,200);
 assert.deepEqual(history.body.rows[0].snapshot.definition,next.definition);assert.deepEqual(history.body.rows[1].snapshot.definition,input.definition);
 assert.deepEqual(await counts(input.id),{reports:1,history:2,audits:2});
 await assert.rejects(saveReport(db,auth.actor,auth.hash,{...input,name:"Different retried body"}),error=>(error as any).status===409);
});
test("normal-auth proof is mandatory, actor-matched and password-only",async()=>{
 const auth=await person(),input=layout();
 await assert.rejects(saveReport(db,auth.actor,undefined,input),error=>(error as any).status===401);
 await assert.rejects(saveReport(db,auth.actor,owner.hash,input),error=>(error as any).status===401);
 for(const mode of ["pin","api"] as const)await assert.rejects(saveReport(db,{...auth.actor,mode},auth.hash,input),error=>(error as any).status===403);
 const pin="829417";assert.equal((await send(app,auth,"/auth/pin",{password,pin})).status,200);
 const response=await request(app).post("/api/auth/login").set("Origin",origin).send({email:auth.actor.email,mode:"pin",credential:pin});assert.equal(response.status,200);
 const cookie=String(response.headers["set-cookie"][0]).split(";")[0],hash=digest(cookie.slice(cookie.indexOf("=")+1));
 await assert.rejects(saveReport(db,auth.actor,hash,input),error=>(error as any).status===401);
 assert.equal((await request(app).get("/api/report-library").set("Cookie",cookie)).status,403);
 assert.deepEqual(await counts(input.id),{reports:0,history:0,audits:0});
});
test("normal-auth save takes account UPDATE first and an audit failure rolls back all layout writes",async()=>{
 const auth=await person(),input=layout(),locks:string[]=[];
 const wrapped:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async<T extends Row=Row>(sql:string,values?:any[])=>{
  if(sql.includes("FROM users")&&/FOR (UPDATE|SHARE)/.test(sql))locks.push(sql);
  const result=await tx.query<T>(sql,values);
  if(sql.startsWith("INSERT INTO audit_events")&&values?.[3]==="report_library.saved")throw new Error("Synthetic late audit failure");
  return result;
 }}))};
 await assert.rejects(saveReport(wrapped,auth.actor,auth.hash,input),/Synthetic late audit failure/);
 assert.ok(locks.length);assert.match(locks[0],/FOR UPDATE$/);assert.deepEqual(await counts(input.id),{reports:0,history:0,audits:0});
});
test("normal-auth current run and CSV export retain the existing authorized source publication",async()=>{
 const auth=await person(),input=layout();assert.equal((await send(app,auth,"/report-library",input)).status,200);
 const run=await send(app,auth,`/report-library/${input.id}/run?version=1`,undefined,"get");assert.equal(run.status,200);assert.equal(run.body.source,"workforce");
 const exported=await send(app,auth,`/report-library/${input.id}/export?version=1`,undefined,"get");assert.equal(exported.status,200);assert.match(exported.headers["content-type"],/text\/csv/);
 assert.equal((await send(app,auth,`/report-library/${input.id}/run?version=999`,undefined,"get")).status,409);
 assert.equal((await send(app,auth,"/report-library",undefined,"head")).status,200);
});


