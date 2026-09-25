import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { issueSetup } from '../server/security';
import { completeInitialCredentials } from '../server/temporary-credentials';
const origin='http://localhost:3198', password='Start!88', replacement='Ready!88';
type Auth={cookie:string;csrf:string};
let db:Database, app:ReturnType<typeof createApp>, owner:Auth, admin:Auth, adminId:string, orgId:string, unitId:string, pinNumber=830100;
const nextPin=()=>String(pinNumber++);
function post(path:string,body:object,auth?:Auth){const req=request(app).post('/api'+path).set('Origin',origin);if(auth)req.set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf);return req.send(body);}
async function authFrom(response:any):Promise<Auth>{assert.equal(response.status,200,response.body.error);const cookie=response.headers['set-cookie'][0].split(';')[0];const me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);return {cookie,csrf:me.body.actor.csrf};}
const login=(email:string,credential=password)=>post('/auth/login',{mode:'password',email,credential});
const flags=(requirePasswordChange:boolean,requirePinChange:boolean)=>({requirePasswordChange,requirePinChange});
async function create(policy=flags(true,true),pin=nextPin()){
 const email=randomUUID()+'@stjw.org';const response=await post('/staff',{name:'Synthetic independent requirements',email,role:'employee',unitIds:[unitId],jobIds:[],initialCredentials:{password,pin,...policy}},admin);
 assert.equal(response.status,201,response.body.error);return {id:response.body.id,email,pin,response};
}
async function state(id:string){return (await db.query('SELECT password_hash,pin_hash,pin_lookup,pin_lookup_key_id,requires_credential_change,require_password_change,require_pin_change FROM users WHERE id=$1',[id])).rows[0];}
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'credential.options.owner@example.test'});app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});
 const person=(await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];orgId=person.org_id;unitId=(await db.query('SELECT id FROM units LIMIT 1')).rows[0].id;
 const token=await db.transaction(tx=>issueSetup(tx,{id:person.id,org_id:orgId}));assert.equal((await post('/auth/setup',{token,password})).status,200);owner=await authFrom(await login('credential.options.owner@example.test'));
 const email='credential.options.admin@stjw.org',created=await post('/staff',{name:'Synthetic account administrator',email,role:'admin',unitIds:[unitId],jobIds:[]},owner);assert.equal(created.status,201);adminId=created.body.id;
 assert.equal((await post('/auth/setup',{token:new URL(created.body.setupUrl).hash.slice(7),password})).status,200);admin=await authFrom(await login(email));
});
beforeEach(async()=>{await db.query('DELETE FROM auth_limits');});
after(async()=>{await db?.close();});

for(const [pw,pin] of [[true,true],[true,false],[false,true],[false,false]] as const){
 test(`administrator creation supports password=${pw}, PIN=${pin} with only selected replacements`,async()=>{
  const person=await create(flags(pw,pin)),initial=await state(person.id);
  assert.equal(person.response.body.requiresCredentialChange,pw||pin);assert.equal(initial.require_password_change,pw);assert.equal(initial.require_pin_change,pin);
  assert.equal(Boolean(initial.pin_lookup),!pin);
  const directory=await request(app).get('/api/staff').set('Cookie',admin.cookie),row=directory.body.rows.find((x:any)=>x.id===person.id);
  assert.equal(row.require_password_change,pw);assert.equal(row.require_pin_change,pin);assert.equal(row.password_hash,undefined);assert.equal(row.pin_hash,undefined);
  const first=await login(person.email);assert.equal(first.status,200,first.body.error);
  if(!pw&&!pin){assert.equal(first.body.requiresCredentialChange,undefined);assert.ok((await authFrom(first)).csrf);const quick=await post('/auth/login',{mode:'pin',credential:person.pin});assert.equal(quick.status,200);const clockAuth=await authFrom(quick);assert.equal((await request(app).get('/api/staff').set('Cookie',clockAuth.cookie)).status,403);return;}
  assert.equal(first.body.requirePasswordChange,pw);assert.equal(first.body.requirePinChange,pin);
  assert.equal((await db.query('SELECT token_hash FROM sessions WHERE user_id=$1',[person.id])).rows.length,0);
  const quick=await post('/auth/login',{mode:'pin',credential:person.pin});assert.equal(quick.status,200);assert.equal(quick.body.requiresCredentialChange,true);
  const challenge=quick.body.challenge,newPin=nextPin(),body={challenge,...(pw?{password:replacement}:{}),...(pin?{pin:newPin}:{})};
  assert.equal((await post('/auth/credentials/complete',{challenge})).status,400);
  if(!pw)assert.equal((await post('/auth/credentials/complete',{...body,password:replacement})).status,400);
  if(!pin)assert.equal((await post('/auth/credentials/complete',{...body,pin:newPin})).status,400);
  assert.deepEqual(await state(person.id),initial);
  const done=await post('/auth/credentials/complete',body);assert.equal(done.status,200,done.body.error);const saved=await state(person.id);
  assert.equal(saved.requires_credential_change,false);assert.equal(saved.require_password_change,false);assert.equal(saved.require_pin_change,false);
  assert.equal(saved.password_hash===initial.password_hash,!pw);assert.equal(saved.pin_hash===initial.pin_hash,!pin);
  if(!pin){assert.equal(saved.pin_lookup,initial.pin_lookup);assert.equal(saved.pin_lookup_key_id,initial.pin_lookup_key_id);}
  assert.equal((await login(person.email,pw?replacement:password)).status,200);assert.equal((await post('/auth/login',{mode:'pin',credential:pin?newPin:person.pin})).status,200);
  const evidence=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND action='auth.initial_credentials_replaced'",[person.id])).rows[0].detail;
  assert.deepEqual(evidence,{passwordReplaced:pw,pinReplaced:pin});
 });
}

test('permanent initial PINs reject active permanent and temporary collisions atomically',async()=>{
 for(const policy of [flags(false,false),flags(true,true)]){
  const existing=await create(policy),before=(await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const response=await post('/staff',{name:'Synthetic duplicate prevention',email:randomUUID()+'@stjw.org',role:'employee',unitIds:[unitId],jobIds:[],initialCredentials:{password,pin:existing.pin,...flags(true,false)}},admin);
  assert.equal(response.status,409);assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n,before);
 }
});

test('independent reset flags are command-bound, rollback duplicate PINs and preserve completed replacements on retry',async()=>{
 const target=await create(flags(false,false)),occupied=await create(flags(false,false)),original=await state(target.id);
 const duplicate={commandId:randomUUID(),password,pin:occupied.pin,reason:'Synthetic PIN collision',...flags(false,false)};
 assert.equal((await post('/staff/'+target.id+'/temporary-credentials',duplicate,admin)).status,409);assert.deepEqual(await state(target.id),original);
 const command={commandId:randomUUID(),password,pin:nextPin(),reason:'Synthetic one-step replacement',...flags(false,true)};
 const reset=await post('/staff/'+target.id+'/temporary-credentials',command,admin);assert.equal(reset.status,200,reset.body.error);assert.equal(reset.body.requirePasswordChange,false);assert.equal(reset.body.requirePinChange,true);
 const resetState=await state(target.id);
 assert.equal((await post('/staff/'+target.id+'/temporary-credentials',{...command,...flags(true,true)},admin)).status,409);
 const challenge=(await login(target.email)).body.challenge;assert.equal((await post('/auth/credentials/complete',{challenge,pin:nextPin()})).status,200);
 const completed=await state(target.id);assert.equal(completed.password_hash,resetState.password_hash);
 const replay=await post('/staff/'+target.id+'/temporary-credentials',command,admin);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.requirePasswordChange,false);assert.equal(replay.body.requirePinChange,false);assert.deepEqual(await state(target.id),completed);
 assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='staff.temporary_credentials_reset'",[target.id])).rows.length,1);
});

test('administrator resets support every requirement combination and revoke prior access',async()=>{
 for(const [pw,pin] of [[true,true],[true,false],[false,true],[false,false]] as const){
  const target=await create(flags(false,false)),oldSession=await authFrom(await login(target.email));
  const command={commandId:randomUUID(),password,pin:nextPin(),reason:'Synthetic independent reset policy',...flags(pw,pin)};
  const reset=await post('/staff/'+target.id+'/temporary-credentials',command,admin);assert.equal(reset.status,200,reset.body.error);assert.equal(reset.body.requiresCredentialChange,pw||pin);
  assert.equal((await request(app).get('/api/me').set('Cookie',oldSession.cookie)).status,401);
  const initial=await state(target.id),first=await login(target.email);assert.equal(first.status,200);
  if(pw||pin){
   assert.equal(first.body.requirePasswordChange,pw);assert.equal(first.body.requirePinChange,pin);
   const done=await post('/auth/credentials/complete',{challenge:first.body.challenge,...(pw?{password:replacement}:{}),...(pin?{pin:nextPin()}:{})});assert.equal(done.status,200,done.body.error);
   const completed=await state(target.id);assert.equal(completed.password_hash===initial.password_hash,!pw);assert.equal(completed.pin_hash===initial.pin_hash,!pin);
  }else{assert.ok((await authFrom(first)).csrf);assert.equal((await post('/auth/login',{mode:'pin',credential:command.pin})).status,200);}
 }
});

test('default both-required reset retains legacy retry fingerprint and binds no plaintext in receipts',async()=>{
 const person=await create(),command={commandId:randomUUID(),password,pin:nextPin(),reason:'Synthetic legacy command compatibility'};
 const response=await post('/staff/'+person.id+'/temporary-credentials',command,admin);assert.equal(response.status,200);
 const expected=createHmac('sha256',Buffer.from(process.env.STJW_PIN_LOOKUP_SECRET!,'hex')).update('stjw-staff-credential-command-v1\0').update(JSON.stringify({orgId,actorId:adminId,targetId:person.id,commandId:command.commandId,password:command.password,pin:command.pin,reason:command.reason})).digest('hex');
 const receipt=(await db.query('SELECT fingerprint FROM staff_credential_commands WHERE command_id=$1',[command.commandId])).rows[0];assert.equal(receipt.fingerprint,expected);
 assert.equal((await post('/staff/'+person.id+'/temporary-credentials',{...command,...flags(true,true)},admin)).body.replayed,true);
});

test('requirement changes committed after completion preread invalidate the locked proof without credential writes',async()=>{
 const person=await create(),initial=await state(person.id),challenge=(await login(person.email)).body.challenge;
 let changed=false;
 const wrapped:Database={...db,transaction:async work=>{
  // Isolated committed-boundary fixture. Keep both hashes unchanged so this
  // specifically proves that the digest binds requirements, not only hashes.
  if(!changed){changed=true;await db.query('UPDATE users SET require_password_change=false WHERE id=$1',[person.id]);}
  return db.transaction(work);
 }};
 await assert.rejects(completeInitialCredentials(wrapped,{challenge,password:replacement,pin:nextPin()}),(error:any)=>error.status===401);
 assert.ok(changed);assert.deepEqual(await state(person.id),{...initial,require_password_change:false});
 assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=$1 AND action='auth.initial_credentials_replaced'",[person.id])).rows.length,0);
 const fresh=await login(person.email);assert.equal(fresh.body.requirePasswordChange,false);assert.equal(fresh.body.requirePinChange,true);
 assert.equal((await post('/auth/credentials/complete',{challenge:fresh.body.challenge,pin:nextPin()})).status,200);
 assert.equal((await state(person.id)).password_hash,initial.password_hash);
});

test('migration conservatively backfills pending users and prevents summary/requirement divergence',async()=>{
 const isolated=await connectDatabase();try{
  await isolated.query('CREATE TABLE users(id integer PRIMARY KEY, requires_credential_change boolean NOT NULL)');await isolated.query('INSERT INTO users VALUES(1,true),(2,false)');
  for(const statement of (await readFile(new URL('../server/migrations/044_credential_change_requirements.sql',import.meta.url),'utf8')).split(';').map(value=>value.trim()).filter(Boolean))await isolated.query(statement);
  assert.deepEqual((await isolated.query('SELECT * FROM users ORDER BY id')).rows,[{id:1,requires_credential_change:true,require_password_change:true,require_pin_change:true},{id:2,requires_credential_change:false,require_password_change:false,require_pin_change:false}]);
  await assert.rejects(isolated.query('UPDATE users SET requires_credential_change=false WHERE id=1'),/credential_change_requirements_consistent/);
 }finally{await isolated.close();}
});
