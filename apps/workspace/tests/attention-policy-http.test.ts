import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app';
import {connectDatabase,migrate,type Database} from '../server/db';
import {initialize} from '../server/seed';
import {digest,opaqueToken} from '../server/security';
import {attentionPolicyResponseSchema,attentionPolicySaveResponseSchema} from '../shared/attention-policy';
let db:Database,app:ReturnType<typeof createApp>,org:string,owner:string;
const origin='http://localhost:3281',path='/api/workforce/attention-policy';
before(async()=>{db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'attention.http@example.test'});const user=(await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];org=user.org_id;owner=user.id;app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});});
after(async()=>{await db?.close();});
async function session(mode:'password'|'pin'='password',role='owner'){
 const id=role==='owner'?owner:randomUUID(),raw=opaqueToken(),csrf=opaqueToken();
 if(role!=='owner')await db.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[id,org,id+'@stjw.org','Synthetic HTTP viewer',role]);
 await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[digest(raw),org,id,mode,csrf]);
 return {cookie:'stjw_session='+raw,csrf,id,hash:digest(raw)};
}
const body=()=>({expectedVersion:0,commandId:randomUUID(),rules:{overSchedule:{enabled:true,afterMinutes:10},outsideSchedule:{enabled:false,afterMinutes:0}}});
test('attention HTTP GET denies anonymous and PIN sessions and publishes private structured policy',async()=>{
 assert.equal((await request(app).get(path)).status,401);
 const pin=await session('pin');assert.equal((await request(app).get(path).set('Cookie',pin.cookie)).status,403);
 const password=await session(),result=await request(app).get(path).set('Cookie',password.cookie);
 assert.equal(result.status,200);assert.match(result.headers['cache-control'],/private.*no-store/);
 const parsed=attentionPolicyResponseSchema.parse(result.body);assert.equal(parsed.canEdit,true);assert.equal(parsed.policy.version,0);
 const finance=await session('password','finance'),read=await request(app).get(path).set('Cookie',finance.cookie);assert.equal(read.status,200);assert.equal(read.body.canEdit,false);
 const employee=await session('password','employee');assert.equal((await request(app).get(path).set('Cookie',employee.cookie)).status,403);
 await db.query('DELETE FROM sessions WHERE token_hash=$1',[password.hash]);assert.equal((await request(app).get(path).set('Cookie',password.cookie)).status,401);
});
test('attention HTTP PUT enforces origin, JSON, CSRF and role before returning a retryable save receipt',async()=>{
 const admin=await session(),input=body();
 assert.equal((await request(app).put(path).set('Cookie',admin.cookie).set('Origin','https://wrong.example').set('X-CSRF-Token',admin.csrf).send(input)).status,403);
 assert.equal((await request(app).put(path).set('Cookie',admin.cookie).set('Origin',origin).send(input)).status,403);
 assert.equal((await request(app).put(path).set('Cookie',admin.cookie).set('Origin',origin).set('X-CSRF-Token',admin.csrf).type('text/plain').send('invalid')).status,415);
 const finance=await session('password','finance');assert.equal((await request(app).put(path).set('Cookie',finance.cookie).set('Origin',origin).set('X-CSRF-Token',finance.csrf).send(input)).status,403);
 const send=(data:Record<string,unknown>)=>request(app).put(path).set('Cookie',admin.cookie).set('Origin',origin).set('X-CSRF-Token',admin.csrf).send(data);
 assert.equal((await send({...input,unexpected:true})).status,400);
 const result=await send(input);assert.equal(result.status,200);assert.match(result.headers['cache-control'],/private.*no-store/);const receipt=attentionPolicySaveResponseSchema.parse(result.body);assert.equal(receipt.policy.version,1);assert.equal(receipt.replayed,false);
 const replay=await send(input);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.deepEqual(replay.body.policy,receipt.policy);
 assert.equal((await send({...input,commandId:randomUUID()})).status,409);
});
test('attention HTTP routes do not accept reports bearer tokens',async()=>{
 const token=opaqueToken();await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic HTTP token',$5,now()+interval '1 hour')",[randomUUID(),org,owner,digest(token),JSON.stringify(["reports:read"])]);
 assert.equal((await request(app).get(path).set('Authorization','Bearer '+token)).status,403);
 assert.equal((await request(app).put(path).set('Authorization','Bearer '+token).set('Origin',origin).send(body())).status,403);
});
test('attention OpenAPI uses password-only operations and strict versioned save schema',async()=>{
 const doc=JSON.parse(await readFile('docs/openapi.json','utf8')),route=doc.paths['/workforce/attention-policy'];
 for(const method of ['get','put'])assert.deepEqual(route[method].security,[{Session:[]}]);
 assert.equal(route.put.requestBody.content['application/json'].schema.$ref,'#/components/schemas/AttentionPolicyInput');
 const input=doc.components.schemas.AttentionPolicyInput;assert.equal(input.additionalProperties,false);assert.deepEqual([...input.required].sort(),['commandId','expectedVersion','rules']);
 assert.equal(input.properties.rules.properties.overSchedule.properties.afterMinutes.maximum,1440);
 assert.equal(doc.components.schemas.AttentionPolicySaveResponse.properties.replayed.type,'boolean');
 assert.match(route.put.description,/never punches/);
});
