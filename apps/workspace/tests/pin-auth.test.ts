import { before, beforeEach, after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { issueSetup, type Actor } from "../server/security";
import { acquirePinNamespace, resolvePinAccount, uniquePermanentPin, PIN_LEGACY_LIMIT } from "../server/pin-auth";
import { loginInput } from "../shared/contracts";
import { totpAt } from "../server/totp";

const origin = "http://localhost:3191", password = "Local!826";
const priorLookup = process.env.STJW_PIN_LOOKUP_SECRET, priorMfa = process.env.MFA_ENCRYPTION_KEY;
let db: Database, owner: Auth, ownerId: string, orgId: string, unitId: string;
type Auth = { cookie: string; csrf: string };
type Person = { id: string; email: string; name: string; role: string; auth?: Auth };
const people: Person[] = [];
const app = (database = db) => createApp(database, {origin, production:false, demo:true, staffDomain:"stjw.org"});
const post = (path: string, body: object, auth?: Auth, database = db) => request(app(database)).post("/api" + path)
  .set("Origin", origin).set("Cookie", auth?.cookie ?? "").set("X-CSRF-Token", auth?.csrf ?? "").send(body);
const get = (path: string, auth: Auth) => request(app()).get("/api" + path).set("Cookie", auth.cookie);
async function proof(response: request.Response): Promise<Auth> {
  assert.equal(response.status, 200, response.body.error);
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  const me = await request(app()).get("/api/me").set("Cookie", cookie);
  assert.equal(me.status, 200); return {cookie, csrf:me.body.actor.csrf};
}
async function person(temporaryPin?: string) {
  const name = "Synthetic PIN-only account", email = randomUUID() + "@stjw.org";
  const body = {name,email,role:"employee",unitIds:[unitId],jobIds:[], ...(temporaryPin ? {initialCredentials:{password, pin:temporaryPin}} : {})};
  const created = await post("/staff", body, owner); assert.equal(created.status, 201, created.body.error);
  const value: Person = {id:created.body.id,email,name,role:"employee"}; people.push(value);
  if (!temporaryPin) value.auth = await proof(await post("/auth/setup", {token:created.body.setupUrl.split("#setup=")[1], password}));
  return value;
}
async function active(user: Person, value: boolean) {
  return request(app()).patch("/api/staff/" + user.id).set("Origin",origin).set("Cookie",owner.cookie).set("X-CSRF-Token",owner.csrf)
    .send({name:user.name,email:user.email,role:user.role,unitIds:[unitId],jobIds:[],active:value});
}
const setPin = (user: Person, pin: string, database = db) => post("/auth/pin", {password,pin}, user.auth, database);
const pinLogin = (pin: string, database = db) => post("/auth/login", {mode:"pin",credential:pin}, undefined, database);
function decodeBase32(value:string){const bits=[...value].map(c=>"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5,"0")).join("");return Buffer.from(bits.match(/.{8}/g)!.map(v=>parseInt(v,2)));}
function wrap(handler: (tx: Queryable, sql: string, params?: any[]) => Promise<void>): Database {
  return {...db, transaction: async <T>(fn:(tx:Queryable)=>Promise<T>) => db.transaction(tx=>fn({query:async<R extends Row=Row>(sql:string,params?:any[])=>{await handler(tx,sql,params);return tx.query<R>(sql,params);}}))};
}
before(async()=>{
  process.env.STJW_PIN_LOOKUP_SECRET = randomBytes(32).toString("hex");
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  db=await connectDatabase(); await migrate(db); await initialize(db,{demo:false,ownerEmail:"pin.owner@example.test"});
  const row=(await db.query("SELECT id,org_id FROM users WHERE email='pin.owner@example.test'")).rows[0];
  ownerId=row.id;orgId=row.org_id;unitId=(await db.query("SELECT unit_id FROM user_units WHERE user_id=$1 ORDER BY unit_id",[ownerId])).rows[0].unit_id;
  const token=await db.transaction(tx=>issueSetup(tx,{id:ownerId,org_id:orgId}));
  owner=await proof(await post("/auth/setup",{token,password}));
});
beforeEach(async()=>{
  // Only previously normal-API-created synthetic fixture accounts are retired.
  for(const user of people.splice(0)) assert.equal((await active(user,false)).status,200);
  await db.query("DELETE FROM auth_limits");
});
after(async()=>{
  await db?.close();
  if(priorLookup===undefined)delete process.env.STJW_PIN_LOOKUP_SECRET;else process.env.STJW_PIN_LOOKUP_SECRET=priorLookup;
  if(priorMfa===undefined)delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=priorMfa;
});

test("strict PIN-only input needs no username; password still requires email",()=>{
  assert.ok(loginInput.safeParse({mode:"pin",credential:"482913"}).success);
  assert.ok(loginInput.safeParse({mode:"pin",email:"USER@stjw.org",credential:"482913"}).success);
  for(const input of [{mode:"password",credential:password},{mode:"pin",credential:"48291"},{mode:"pin",credential:"482913x"},{mode:"pin",credential:"482913",userId:randomUUID()}])assert.equal(loginInput.safeParse(input).success,false);
});
test("normal PIN enrollment uses an opaque keyed lookup; identifier-free session stays clock-only",async()=>{
  const user=await person(); assert.equal((await setPin(user,"482913")).status,200);
  const stored=(await db.query("SELECT pin_hash,pin_lookup FROM users WHERE id=$1",[user.id])).rows[0];
  assert.match(stored.pin_lookup,/^[a-f0-9]{64}$/);assert.ok(!stored.pin_hash.includes("482913"));
  const signed=await proof(await pinLogin("482913"));
  const me=await get("/me",signed);assert.equal(me.body.actor.id,user.id);assert.equal(me.body.actor.mode,"pin");
  assert.equal((await get("/clock",signed)).status,200);assert.equal((await get("/staff",signed)).status,403);
  assert.equal((await get("/reports/v2?from=2026-09-01&to=2026-09-02",signed)).status,403);
  const audit=JSON.stringify((await db.query("SELECT detail FROM audit_events WHERE actor_id=$1",[user.id])).rows);
  assert.ok(!audit.includes("482913")&&!audit.includes(stored.pin_lookup)&&!audit.includes(stored.pin_hash));
});
test("existing hash with cleared lookup backfills only after exact unique verification",async()=>{
  const user=await person();assert.equal((await setPin(user,"582913")).status,200);
  const before=(await db.query("SELECT pin_hash,pin_lookup FROM users WHERE id=$1",[user.id])).rows[0];
  assert.equal((await active(user,false)).status,200);assert.equal((await active(user,true)).status,200);
  const legacy=(await db.query("SELECT pin_hash,pin_lookup FROM users WHERE id=$1",[user.id])).rows[0];
  assert.equal(legacy.pin_hash,before.pin_hash);assert.equal(legacy.pin_lookup,null);
  assert.equal((await pinLogin("582913")).status,200);
  assert.deepEqual((await db.query("SELECT pin_hash,pin_lookup FROM users WHERE id=$1",[user.id])).rows[0],before);
});
test("shared temporary PIN never picks a user or creates any session/challenge",async()=>{
  const a=await person("123456"),b=await person("123456");
  const denied=await pinLogin("123456");assert.equal(denied.status,401);assert.match(denied.body.error,/shared temporary PIN/);
  assert.ok(!JSON.stringify(denied.body).includes(a.email)&&!JSON.stringify(denied.body).includes(b.email));
  assert.equal((await db.query("SELECT count(*)::int n FROM sessions WHERE user_id=ANY($1::uuid[])",[[a.id,b.id]])).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM credential_change_challenges WHERE user_id=ANY($1::uuid[])",[[a.id,b.id]])).rows[0].n,0);
  const passwordLogin=await post("/auth/login",{email:a.email,mode:"password",credential:password});assert.equal(passwordLogin.body.requiresCredentialChange,true);
  assert.equal((await post("/auth/credentials/complete",{challenge:passwordLogin.body.challenge,password:"Changed!826",pin:"682913"})).status,200);
  assert.equal((await pinLogin("682913")).status,200);
});
test("an indexed PIN still checks every active unindexed temporary PIN",async()=>{
  const permanent=await person();assert.equal((await setPin(permanent,"782913")).status,200);
  await person("782913"); assert.equal((await pinLogin("782913")).status,401);
  const next=await person();assert.equal((await setPin(next,"782913")).status,409);
});
test("reactivation cannot revive a stale unique lookup after another account adopts its PIN",async()=>{
  const a=await person();assert.equal((await setPin(a,"882913")).status,200);assert.equal((await active(a,false)).status,200);
  const b=await person();assert.equal((await setPin(b,"882913")).status,200);assert.equal((await active(a,true)).status,200);
  assert.equal((await pinLogin("882913")).status,401);
  assert.equal((await db.query("SELECT pin_lookup FROM users WHERE id=$1",[a.id])).rows[0].pin_lookup,null);
});
test("new permanent PIN uniqueness includes legacy hashes; unchanged own PIN remains allowed",async()=>{
  const a=await person();assert.equal((await setPin(a,"982913")).status,200);
  assert.equal((await active(a,false)).status,200);assert.equal((await active(a,true)).status,200);
  const b=await person();assert.equal((await setPin(b,"982913")).status,409);
  assert.equal((await setPin(b,"982914")).status,200);assert.equal((await setPin(b,"982914")).status,200);
});
test("setup clears hash and lookup; old identifier-free PIN stops working",async()=>{
  const user=await person();assert.equal((await setPin(user,"192913")).status,200);
  const issued=await post("/staff/"+user.id+"/setup-link",{},owner);assert.equal(issued.status,200);
  assert.equal((await post("/auth/setup",{token:issued.body.setupUrl.split("#setup=")[1],password:"Replacement!826"})).status,200);
  assert.deepEqual((await db.query("SELECT pin_hash,pin_lookup FROM users WHERE id=$1",[user.id])).rows[0],{pin_hash:null,pin_lookup:null});
  assert.equal((await pinLogin("192913")).status,401);
});
test("PIN namespace precedes account locks; late actual SQL audit failure rolls back lookup/session",async()=>{
  const user=await person();assert.equal((await setPin(user,"292913")).status,200);
  assert.equal((await active(user,false)).status,200);assert.equal((await active(user,true)).status,200);
  const order:string[]=[];
  const faulty=wrap(async(tx,sql,params)=>{
    order.push(sql);
    if(sql.startsWith("INSERT INTO audit_events")&&params?.[3]==="auth.signed_in")await tx.query("SELECT 1/0");
  });
  assert.equal((await pinLogin("292913",faulty)).status,500);
  assert.ok(order.findIndex(sql=>sql.includes("pg_try_advisory_xact_lock(78239133)"))<order.findIndex(sql=>sql.includes("FOR UPDATE")));
  assert.equal((await db.query("SELECT pin_lookup FROM users WHERE id=$1",[user.id])).rows[0].pin_lookup,null);
  assert.equal((await db.query("SELECT count(*)::int n FROM sessions WHERE user_id=$1",[user.id])).rows[0].n,0);
  assert.equal((await pinLogin("292913")).status,200);
});
test("missing configuration and over-cap legacy inventory fail closed before admission",async()=>{
  const key=process.env.STJW_PIN_LOOKUP_SECRET;delete process.env.STJW_PIN_LOOKUP_SECRET;
  try{assert.equal((await pinLogin("392913")).status,503);}finally{process.env.STJW_PIN_LOOKUP_SECRET=key;}
  const excessive:Queryable={query:async<R extends Row=Row>(sql:string)=>({rows:(sql.includes("IS DISTINCT FROM")?[]:Array.from({length:PIN_LEGACY_LIMIT+1},()=>({id:randomUUID(),pin_hash:"never submitted"}))) as unknown as R[]})};
  await assert.rejects(resolvePinAccount(excessive,"392913"),(error:any)=>error.status===503);
});
test("a different configured key cannot hide indexed duplicates or silently enroll new PINs",async()=>{
  const a=await person(),b=await person();assert.equal((await setPin(a,"392914")).status,200);
  const before=(await db.query("SELECT pin_hash,pin_lookup,pin_lookup_key_id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id",[[a.id,b.id]])).rows;
  const key=process.env.STJW_PIN_LOOKUP_SECRET;process.env.STJW_PIN_LOOKUP_SECRET=randomBytes(32).toString("hex");
  try{assert.equal((await pinLogin("392914")).status,503);assert.equal((await setPin(b,"392914")).status,503);assert.equal((await setPin(b,"392915")).status,503);}
  finally{process.env.STJW_PIN_LOOKUP_SECRET=key;}
  assert.deepEqual((await db.query("SELECT pin_hash,pin_lookup,pin_lookup_key_id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id",[[a.id,b.id]])).rows,before);
  assert.equal((await pinLogin("392914")).status,200);
});
test("single temporary PIN produces only onboarding and rejects a permanent PIN collision",async()=>{
  const permanent=await person();assert.equal((await setPin(permanent,"392916")).status,200);
  const pending=await person("392917");const start=await pinLogin("392917");assert.equal(start.status,200);assert.equal(start.body.requiresCredentialChange,true);
  assert.equal((await db.query("SELECT pin_lookup FROM users WHERE id=$1",[pending.id])).rows[0].pin_lookup,null);
  assert.equal((await post("/auth/credentials/complete",{challenge:start.body.challenge,password:"Changed!826",pin:"392916"})).status,409);
  assert.equal((await db.query("SELECT requires_credential_change FROM users WHERE id=$1",[pending.id])).rows[0].requires_credential_change,true);
  assert.equal((await db.query("SELECT count(*)::int n FROM sessions WHERE user_id=$1",[pending.id])).rows[0].n,0);
  assert.equal((await post("/auth/credentials/complete",{challenge:start.body.challenge,password:"Changed!826",pin:"392918"})).status,200);
});
test("committed logout denies PIN replacement, with all prior PIN evidence retained",async()=>{
  const user=await person();assert.equal((await setPin(user,"392919")).status,200);
  const before=(await db.query("SELECT pin_hash,pin_lookup,pin_lookup_key_id FROM users WHERE id=$1",[user.id])).rows[0];
  assert.equal((await post("/auth/logout",{},user.auth)).status,200);
  assert.equal((await setPin(user,"392920")).status,401);
  assert.deepEqual((await db.query("SELECT pin_hash,pin_lookup,pin_lookup_key_id FROM users WHERE id=$1",[user.id])).rows[0],before);
  assert.equal((await pinLogin("392919")).status,200);
});
test("a shared clock admits more than20 successful logins without consuming password or failure budgets",async()=>{
  const user=await person();assert.equal((await setPin(user,"392921")).status,200);
  for(let i=0;i<25;i++)assert.equal((await pinLogin("392921")).status,200);
  const login=await post("/auth/login",{email:user.email,mode:"password",credential:password});assert.equal(login.status,200);
  const rows=(await db.query("SELECT attempts FROM auth_limits ORDER BY attempts DESC")).rows;
  assert.equal(rows[0].attempts,25); // separate finite total, not a failed-login bucket
});
test("20 incorrect PINs block further PIN proof; successes do not erase failures and password still works",async()=>{
  const user=await person();assert.equal((await setPin(user,"392922")).status,200);
  for(let i=0;i<20;i++){
    assert.equal((await pinLogin(i%2?"111111":"222222")).status,401);
    if(i===9)assert.equal((await pinLogin("392922")).status,200);
  }
  assert.equal((await pinLogin("392922")).status,429);
  assert.equal((await pinLogin("333333")).status,429);
  assert.equal((await post("/auth/login",{email:user.email,mode:"password",credential:password})).status,200);
});
test("an expired failed-attempt interval allows a fresh proof (accelerated original rate-row creation only)",async()=>{
  const user=await person();assert.equal((await setPin(user,"392923")).status,200);
  let failureKey:string|undefined, shifted=false;
  const accelerated:Database={...db,query:async<R extends Row=Row>(sql:string,params?:any[])=>{
    if(sql.startsWith("SELECT attempts FROM auth_limits"))failureKey=params?.[0];
    if(!shifted&&sql.includes("INSERT INTO auth_limits")&&params?.[0]===failureKey){
      assert.equal((await db.query("SELECT 1 FROM auth_limits WHERE bucket=$1",[failureKey])).rows.length,0);
      sql=sql.replace("VALUES($1,1,now()+interval '15 minutes')","VALUES($1,1,clock_timestamp()-interval '1 second')");shifted=true;
    }
    return db.query<R>(sql,params);
  }};
  assert.equal((await pinLogin("444444",accelerated)).status,401);assert.ok(shifted);
  assert.equal((await pinLogin("392923")).status,200);
  assert.equal((await pinLogin("555555")).status,401);
  assert.equal((await db.query("SELECT attempts FROM auth_limits WHERE bucket=$1",[failureKey])).rows[0].attempts,1);
});
test("nonblocking namespace and process admission are bounded; no background KDF is abandoned",async()=>{
  const busy:Queryable={query:async<R extends Row=Row>()=>({rows:[{acquired:false}] as unknown as R[]})};
  await assert.rejects(acquirePinNamespace(busy),(error:any)=>error.status===429);
  const user=await person();assert.equal((await setPin(user,"492913")).status,200);
  const tx:Queryable={query:async<R extends Row=Row>(sql:string)=>({rows:sql.includes("pin_lookup IS NULL")||sql.includes("IS DISTINCT FROM")?[]:(await db.query<R>("SELECT id,org_id,pin_hash,pin_lookup,requires_credential_change FROM users WHERE id=$1",[user.id])).rows})};
  const first=resolvePinAccount(tx,"492913");await new Promise(resolve=>setTimeout(resolve,20));
  await assert.rejects(resolvePinAccount(tx,"492913"),(error:any)=>error.status===429);assert.equal((await first).id,user.id);
  assert.equal((await resolvePinAccount(tx,"492913")).id,user.id);
});
test("legacy deadline stops new work and releases admission only after its workers settle",async()=>{
  const empty:Queryable={query:async<R extends Row=Row>()=>({rows:[] as R[]})};
  let tick=0;const mocked=mock.method(performance,"now",()=>tick++===0?0:30_000);
  try{await assert.rejects(resolvePinAccount(empty,"592913"),(error:any)=>error.status===503);}finally{mocked.mock.restore();}
  await assert.rejects(resolvePinAccount(empty,"592913"),(error:any)=>error.status===401);
});
test("MFA remains required for password workspace; PIN remains clock-only",async()=>{
  const user=await person();assert.equal((await setPin(user,"692913")).status,200);
  const enrollment=await post("/auth/mfa/enroll",{password},user.auth);assert.equal(enrollment.status,200);
  const confirmed=await post("/auth/mfa/confirm",{id:enrollment.body.id,code:totpAt(decodeBase32(enrollment.body.secret),Date.now())},user.auth);assert.equal(confirmed.status,200);
  const passwordLogin=await post("/auth/login",{email:user.email,mode:"password",credential:password});assert.equal(passwordLogin.status,200);assert.ok(passwordLogin.body.challenge);
  const signed=await proof(await pinLogin("692913"));assert.equal((await get("/clock",signed)).status,200);assert.equal((await get("/staff",signed)).status,403);
});
