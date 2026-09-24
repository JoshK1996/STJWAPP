import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {createStaff} from '../server/workforce';
import {getAuthenticatedClock,applyAuthenticatedClockCommand} from '../server/clock-session';
import {digest,opaqueToken,type Actor} from '../server/security';
let db:Database,owner:Actor,job:any,app:ReturnType<typeof createApp>;
const origin='http://localhost:3000';
type Credential={cookie:string;hash:string;csrf:string};
async function session(actor:Actor,mode:'password'|'pin'=actor.mode as 'password'|'pin'):Promise<Credential>{const token=opaqueToken(),hash=digest(token),csrf=opaqueToken();await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')",[hash,actor.org_id,actor.id,mode,csrf]);return {cookie:'stjw_session='+token,hash,csrf};}
before(async()=>{db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'clock.session.owner@example.test'});const row=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];job=(await db.query('SELECT * FROM jobs ORDER BY id LIMIT 1')).rows[0];owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:'owner',unit_ids:[job.unit_id],mode:'password'};app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:true});});
after(async()=>{await db?.close();});
async function person(mode:'password'|'pin'='password'){const email=randomUUID()+'@stjw.org',id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic clock proof worker',email,role:'employee',unitIds:[job.unit_id],jobIds:[job.id]},'stjw.org'));const actor:Actor={id,org_id:owner.org_id,email,name:'Synthetic clock proof worker',role:'employee',unit_ids:[job.unit_id],mode};return {actor,auth:await session(actor)};}
type Person=Awaited<ReturnType<typeof person>>;
const input=()=>({action:'clock_in',jobId:job.id,commandId:randomUUID()});
const post=(application:ReturnType<typeof createApp>,body:unknown,auth:Credential)=>request(application).post('/api/clock').set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body as object);
async function counts(person:Person){return (await db.query(`SELECT (SELECT count(*)::int FROM shifts WHERE user_id=$1) shifts,
 (SELECT count(*)::int FROM segments g JOIN shifts s ON s.id=g.shift_id WHERE s.user_id=$1) segments,
 (SELECT count(*)::int FROM clock_commands WHERE user_id=$1) commands,
 (SELECT count(*)::int FROM audit_events WHERE actor_id=$1 AND action LIKE 'clock.%') audits`,[person.actor.id])).rows[0];}
function intercepted(operation:(sql:string,params:any[],tx:Queryable)=>Promise<void>):Database{return {...db,transaction:fn=>db.transaction(tx=>fn({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{await operation(sql,params,tx);return tx.query<T>(sql,params);}}))};}
function afterMiddleware(person:Person,change:()=>Promise<void>){let changed=false;const wrapped:Database={...db,query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{const value=await db.query<T>(sql,params);if(!changed&&sql.includes('FROM sessions s JOIN users u')&&params[0]===person.auth.hash){changed=true;await change();}return value;}};return {app:createApp(wrapped,{origin,production:false,staffDomain:'stjw.org',demo:true}),changed:()=>changed};}

for(const mode of ['password','pin'] as const)test(`${mode} token revoked immediately after middleware cannot clock in or read state`,async()=>{
 const p=await person(mode),wrapped=afterMiddleware(p,async()=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[p.auth.hash]);});
 const response=await post(wrapped.app,input(),p.auth);assert.ok(wrapped.changed());assert.equal(response.status,401,response.text);assert.deepEqual(await counts(p),{shifts:0,segments:0,commands:0,audits:0});
 const q=await person(mode),read=afterMiddleware(q,async()=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[q.auth.hash]);});const result=await request(read.app).get('/api/clock').set('Cookie',q.auth.cookie);assert.equal(result.status,401,result.text);assert.ok(read.changed());
});

for(const mode of ['password','pin'] as const)test(`${mode} current proof preserves ordinary transitions, exact receipts and private state`,async()=>{
 const p=await person(mode),command=input(),first=await post(app,command,p.auth);assert.equal(first.status,200,first.text);assert.ok(first.body.shift.id);assert.match(first.headers['cache-control'],/private, no-store/);
 const replay=await post(app,command,p.auth);assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);assert.equal((await counts(p)).commands,1);
 const otherJob=randomUUID();await db.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[otherJob,p.actor.org_id,job.unit_id,'Synthetic clock alternative']);await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[p.actor.org_id,p.actor.id,otherJob]);
 for(const next of [{action:'start_break'},{action:'end_break'},{action:'switch_job',jobId:otherJob},{action:'clock_out'}]){const result=await post(app,{...next,commandId:randomUUID()},p.auth);assert.equal(result.status,200,result.text);}
 const current=await request(app).get('/api/clock').set('Cookie',p.auth.cookie);assert.equal(current.status,200);assert.equal(current.body.shift,null);assert.equal(current.body.jobs.length,2);assert.match(current.headers['cache-control'],/private, no-store/);
 assert.deepEqual((await post(app,command,p.auth)).body,first.body);assert.equal((await counts(p)).commands,5);
 if(mode==='pin')assert.equal((await request(app).get('/api/time-records?start=2025-01-01&end=2025-01-01').set('Cookie',p.auth.cookie)).status,403);
});

test('route-facing service cannot omit proof, cross users/organizations/modes, or use an API actor',async()=>{
 const p=await person(),other=await person(),pin=await session(p.actor,'pin');
 for(const proof of [undefined as any,opaqueToken(),other.auth.hash,pin.hash]){await assert.rejects(getAuthenticatedClock(db,p.actor,proof),(e:any)=>e.status===401);await assert.rejects(applyAuthenticatedClockCommand(db,p.actor,proof,input()),(e:any)=>e.status===401);}
 await assert.rejects(getAuthenticatedClock(db,{...p.actor,org_id:randomUUID()},p.auth.hash),(e:any)=>[401,403].includes(e.status));
 await assert.rejects(applyAuthenticatedClockCommand(db,{...p.actor,mode:'api'},p.auth.hash,input()),(e:any)=>e.status===403);
 await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[p.auth.hash]);await assert.rejects(getAuthenticatedClock(db,p.actor,p.auth.hash),(e:any)=>e.status===401);
 assert.deepEqual(await counts(p),{shifts:0,segments:0,commands:0,audits:0});
});

test('current account deactivation and pending credential gate deny stale supplied actors after middleware',async()=>{
 for(const pending of [false,true]){const p=await person(),wrapped=afterMiddleware(p,async()=>{if(pending)await db.query("UPDATE users SET password_hash='synthetic-not-a-real-hash',pin_hash='synthetic-not-a-real-hash',requires_credential_change=true WHERE id=$1",[p.actor.id]);else await db.query('UPDATE users SET active=false WHERE id=$1',[p.actor.id]);});const result=await post(wrapped.app,input(),p.auth);assert.equal(result.status,403,result.text);assert.equal((await counts(p)).shifts,0);await assert.rejects(getAuthenticatedClock(db,p.actor,p.auth.hash),(e:any)=>e.status===403);}
});

test('password requires current MFA proof while a current PIN retains its restricted exemption',async()=>{
 const p=await person(),command=input();await applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,command);
 await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-unused-cipher','synthetic',clock_timestamp(),clock_timestamp())",[p.actor.id,p.actor.org_id,randomUUID()]);
 await assert.rejects(getAuthenticatedClock(db,p.actor,p.auth.hash),(e:any)=>e.status===401);await assert.rejects(applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,command),(e:any)=>e.status===401);
 const pin=await session(p.actor,'pin');assert.ok((await getAuthenticatedClock(db,{...p.actor,mode:'pin'},pin.hash)).shift);
 await db.query('UPDATE sessions SET mfa_verified=true WHERE token_hash=$1',[p.auth.hash]);assert.ok((await getAuthenticatedClock(db,p.actor,p.auth.hash)).shift);
 await db.query("DELETE FROM sessions WHERE user_id=$1 AND mode='pin'",[p.actor.id]);await assert.rejects(getAuthenticatedClock(db,{...p.actor,mode:'pin'},pin.hash),(e:any)=>e.status===401);
});

test('job and explicit unit revocation after middleware deny new entry; recorded job can still clock out',async()=>{
 for(const table of ['user_jobs','user_units']){const p=await person(),wrapped=afterMiddleware(p,async()=>{await db.query(`DELETE FROM ${table} WHERE user_id=$1`,[p.actor.id]);});const result=await post(wrapped.app,input(),p.auth);assert.equal(result.status,403,result.text);assert.equal((await counts(p)).shifts,0);}
 const p=await person();await applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,input());await db.query('DELETE FROM user_jobs WHERE user_id=$1',[p.actor.id]);await db.query('DELETE FROM user_units WHERE user_id=$1',[p.actor.id]);
 const ended=await applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,{action:'clock_out',commandId:randomUUID()});assert.equal(ended.shift,null);
});

test('audit and final wall-clock proof failures roll back transition and receipt for both modes',async()=>{
 for(const mode of ['password','pin'] as const){const p=await person(mode);const failAudit=intercepted(async(sql)=>{if(sql.includes('INSERT INTO audit_events'))throw new Error('Synthetic clock audit failure');});await assert.rejects(applyAuthenticatedClockCommand(failAudit,p.actor,p.auth.hash,input()),/Synthetic clock audit failure/);assert.deepEqual(await counts(p),{shifts:0,segments:0,commands:0,audits:0});
 const expireAfterWrites=intercepted(async(sql,_params,tx)=>{if(sql.includes('INSERT INTO clock_commands'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[p.auth.hash]);});await assert.rejects(applyAuthenticatedClockCommand(expireAfterWrites,p.actor,p.auth.hash,input()),(e:any)=>e.status===401);assert.deepEqual(await counts(p),{shifts:0,segments:0,commands:0,audits:0});}
});

test('GET and successful receipt replay still perform a final expiry proof',async()=>{
 const p=await person(),command=input(),saved=await applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,command);
 const expireRead=intercepted(async(sql,_params,tx)=>{if(sql.includes('FROM shifts s JOIN segments g'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[p.auth.hash]);});await assert.rejects(getAuthenticatedClock(expireRead,p.actor,p.auth.hash),(e:any)=>e.status===401);
 const expireReplay=intercepted(async(sql,_params,tx)=>{if(sql.includes('SELECT fingerprint,result FROM clock_commands'))await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[p.auth.hash]);});await assert.rejects(applyAuthenticatedClockCommand(expireReplay,p.actor,p.auth.hash,command),(e:any)=>e.status===401);
 assert.equal((await counts(p)).commands,1);assert.equal((await getAuthenticatedClock(db,p.actor,p.auth.hash)).shift.id,saved.shift.id);
 await db.query('DELETE FROM sessions WHERE token_hash=$1',[p.auth.hash]);await assert.rejects(applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,command),(e:any)=>e.status===401);
});

test('validated command copy and post-lock sampling resist mutable caller input and duplicate commands',async()=>{
 const p=await person(),raw=input();let sampledAfter=0;const slow=intercepted(async(sql)=>{if(sql.includes('SELECT id,org_id,name,email,role,active,requires_credential_change')){raw.action='clock_out';raw.jobId=randomUUID();await new Promise(resolve=>setTimeout(resolve,30));sampledAfter=Date.now();}});
 const saved=await applyAuthenticatedClockCommand(slow,p.actor,p.auth.hash,raw);assert.ok(saved.shift.id);assert.equal(saved.shift.job_id,job.id);assert.ok(new Date(saved.shift.started_at).valueOf()>=sampledAfter);
 const original={action:'clock_in',jobId:job.id,commandId:raw.commandId};const repeats=await Promise.all([applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,original),applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,original)]);assert.ok(repeats.every(row=>row.shift.id===saved.shift.id));assert.equal((await counts(p)).commands,1);
 await assert.rejects(applyAuthenticatedClockCommand(db,p.actor,p.auth.hash,raw),(e:any)=>e.status===409);
});

test('clock HTTP keeps origin/CSRF/bearer denial and app imports only authenticated clock boundaries',async()=>{
 const p=await person();assert.equal((await request(app).post('/api/clock').set('Origin',origin).set('Cookie',p.auth.cookie).send(input())).status,403);assert.equal((await request(app).post('/api/clock').set('Origin','https://foreign.example.test').set('Cookie',p.auth.cookie).set('X-CSRF-Token',p.auth.csrf).send(input())).status,403);assert.equal((await request(app).get('/api/clock').set('Authorization','Bearer '+opaqueToken())).status,403);
 const source=await readFile(new URL('../server/app.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/\bclockState\s*\(|\bclockCommand\s*\(/);assert.match(source,/getAuthenticatedClock\(db,actorOf\(req\),\(req as AppRequest\)\.sessionHash!/);assert.match(source,/applyAuthenticatedClockCommand\(db,actorOf\(req\),\(req as AppRequest\)\.sessionHash!/);
});
