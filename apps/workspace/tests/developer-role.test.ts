import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database } from '../server/db';
import { createApp } from '../server/app';
import { initialize } from '../server/seed';
import { issueSetup, digest, orgWide, manages, canReport, type Actor } from '../server/security';
import { isOwnerRole, isDeveloperRole, roleSchema } from '../shared/contracts';
import { createManagedJob } from '../server/staff-authority';
import { publishOrganizationBranding } from '../server/organization-branding';

// Fresh synthetic PGlite only. The two explicit role changes below model the
// separately reviewed maintenance provisioning, not a public elevation endpoint.
const origin='http://localhost:3189';
type Auth={cookie:string;csrf:string;actor:Actor;hash:string;password:string};
let db:Database,owner:Auth,developer:Auth,admin:Auth,manager:Auth,employee:Auth,unitId:string,otherUnit:string;
const app=()=>createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});
function send(auth:Auth,path:string,body?:unknown,method='post'){
  const client=request(app());return body===undefined?client.get('/api'+path).set('Cookie',auth.cookie):
    (client as any)[method]('/api'+path).set('Cookie',auth.cookie).set('Origin',origin).set('X-CSRF-Token',auth.csrf).send(body);
}
async function login(email:string,password:string):Promise<Auth>{
  const login=await request(app()).post('/api/auth/login').set('Origin',origin).send({email,credential:password,mode:'password'});
  assert.equal(login.status,200,login.body.error);const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me=await request(app()).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  return{cookie,csrf:me.body.actor.csrf,actor:me.body.actor,hash:digest(cookie.slice(cookie.indexOf('=')+1)),password};
}
async function person(role:string){
  const email=randomUUID()+'@stjw.org',password='Synthetic-'+randomUUID();
  const created=await send(owner,'/staff',{name:'Synthetic developer-role fixture',email,role,unitIds:[unitId],jobIds:[]});assert.equal(created.status,201,created.body.error);
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin',origin).send({token:new URL(created.body.setupUrl).hash.slice(7),password})).status,200);
  return login(email,password);
}
before(async()=>{
  process.env.STJW_PIN_LOOKUP_SECRET=randomBytes(32).toString('hex');
  db=await connectDatabase();await migrate(db);const email='synthetic.role.owner@example.test',password='Synthetic-'+randomUUID();
  await initialize(db,{demo:false,ownerEmail:email});const row=(await db.query('SELECT id,org_id FROM users WHERE email=$1',[email])).rows[0];
  const token=await db.transaction(tx=>issueSetup(tx,row as Actor));
  assert.equal((await request(app()).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  owner=await login(email,password);unitId=owner.actor.unit_ids[0];otherUnit=owner.actor.unit_ids[1];assert.ok(otherUnit);
  admin=await person('admin');manager=await person('manager');employee=await person('employee');
  const candidate=await person('admin');
  await db.query("UPDATE users SET role='developer' WHERE id=$1 AND org_id=$2",[candidate.actor.id,candidate.actor.org_id]);
  developer=await login(candidate.actor.email,candidate.password);
});
after(async()=>{delete process.env.STJW_PIN_LOOKUP_SECRET;await db?.close();});
const body=(auth:Auth,extra:Record<string,unknown>={})=>({name:auth.actor.name,email:auth.actor.email,role:auth.actor.role,active:true,unitIds:auth.actor.unit_ids,jobIds:[],...extra});

test('developer is owner-equivalent in role helpers while PIN and lower-role predicates retain their restrictions',()=>{
  assert.equal(roleSchema.parse('developer'),'developer');assert.equal(isDeveloperRole('developer'),true);assert.equal(isOwnerRole('developer'),true);
  assert.equal(isOwnerRole('owner'),true);assert.equal(isOwnerRole('admin'),false);
  for(const predicate of [orgWide,manages,canReport])assert.equal(predicate(developer.actor),true);
  assert.equal(manages({...developer.actor,mode:'pin'}),false);assert.equal(canReport({...developer.actor,mode:'pin'}),false);
  assert.equal(orgWide(manager.actor),false);assert.equal(manages(employee.actor),false);
});

test('additive role constraint accepts developer and still rejects unknown roles without changing owner credentials',async()=>{
  assert.equal((await db.query('SELECT version FROM schema_migrations WHERE version=32')).rows[0].version,32);
  await assert.rejects(db.transaction(tx=>tx.query("UPDATE users SET role='superuser' WHERE id=$1",[developer.actor.id])),/users_role_check/);
  assert.equal((await db.query('SELECT role FROM users WHERE id=$1',[developer.actor.id])).rows[0].role,'developer');
  assert.equal((await db.query('SELECT role FROM users WHERE id=$1',[owner.actor.id])).rows[0].role,'owner');
});

test('current developer password session opens owner management, pay, school and organization-wide reports without all memberships or jobs',async()=>{
  const me=await send(developer,'/me');assert.equal(me.status,200);assert.equal(me.body.actor.role,'developer');
  assert.deepEqual(me.body.permissions,{manage:true,report:true,owner:true});assert.equal(me.body.actor.unit_ids.includes(otherUnit),false);
  for(const path of ['/staff','/audit','/tokens','/organization/structure','/compensation/staff','/finance/template','/school/access',
    `/school/years?unitId=${otherUnit}`,`/reports/v2?start=2026-01-01&end=2026-01-02&unitId=${otherUnit}`]){
    const result=await send(developer,path);assert.equal(result.status,200,path+': '+result.body.error);
  }
  const school=await send(developer,'/school/access');assert.equal(school.body.admin,true);
  const created=await send(developer,'/jobs',{unitId:otherUnit,title:'Synthetic developer cross-unit job'});assert.equal(created.status,201,created.body.error);
});

test('developer can publish and review owner-only organization appearance; administrator remains denied',async()=>{
  const current=await send(developer,'/organization/branding');assert.equal(current.body.allowedActions.publish,true);assert.equal(current.body.allowedActions.history,true);
  const input={commandId:randomUUID(),expectedVersion:current.body.version,reviewed:true,reason:'Synthetic developer organization identity',
    settings:{...current.body.settings,displayName:'Synthetic developer authority'}};
  const saved=await send(developer,'/organization/branding',input);assert.equal(saved.status,200,saved.body.error);
  assert.equal((await send(developer,'/organization/branding/history')).status,200);
  assert.equal((await send(admin,'/organization/branding/history')).status,403);
  assert.equal((await send(admin,'/organization/branding',{...input,commandId:randomUUID(),expectedVersion:1})).status,403);
});

test('developer may create administrators, but no ordinary account/import path provisions owner or developer',async()=>{
  const input={name:'Synthetic top-role denial',email:randomUUID()+'@stjw.org',role:'admin',unitIds:[otherUnit],jobIds:[]};
  assert.equal((await send(developer,'/staff',input)).status,201);
  for(const caller of [developer,owner,admin,manager])for(const role of ['developer','owner']){
    const result=await send(caller,'/staff',{...input,email:randomUUID()+'@stjw.org',role});assert.equal(result.status,403,caller.actor.role+' -> '+role);
    const csv=`name,email,role,unitIds,jobIds\nSynthetic blocked,${randomUUID()}@stjw.org,${role},${unitId},`;
    assert.equal((await send(caller,'/imports/staff/preview',{csv})).status,403);
  }
});

test('owner administrator and manager cannot edit deactivate reset or demote a developer',async()=>{
  const before=(await db.query('SELECT role,active,password_hash,pin_hash FROM users WHERE id=$1',[developer.actor.id])).rows[0];
  for(const caller of [owner,admin,manager]){
    assert.equal((await send(caller,'/staff/'+developer.actor.id,body(developer,{active:false,role:'employee'}),'patch')).status,403);
    assert.equal((await send(caller,'/staff/'+developer.actor.id+'/setup-link',{})).status,403);
  }
  assert.deepEqual((await db.query('SELECT role,active,password_hash,pin_hash FROM users WHERE id=$1',[developer.actor.id])).rows[0],before);
});

test('a supplied developer label cannot elevate an actual employee through current-authority services',async()=>{
  const forged={...employee.actor,role:'developer'},denied=(error:unknown)=>typeof error==='object' && error!==null && 'status' in error && error.status===403;
  await assert.rejects(createManagedJob(db,forged,employee.hash,{unitId:otherUnit,title:'Synthetic forbidden stale-role job'}),denied);
  const current=await send(developer,'/organization/branding');
  await assert.rejects(publishOrganizationBranding(db,forged,employee.hash,{commandId:randomUUID(),expectedVersion:current.body.version,
    reviewed:true,reason:'Synthetic forbidden stale-role change',settings:{...current.body.settings,displayName:'Must not publish'}}),denied);
});

test('developer can manage an existing external-email owner while preserving that account credentials and self-edit denial',async()=>{
  const before=(await db.query('SELECT password_hash,pin_hash FROM users WHERE id=$1',[owner.actor.id])).rows[0];
  const saved=await send(developer,'/staff/'+owner.actor.id,body(owner,{name:'Synthetic reviewed owner'}),'patch');assert.equal(saved.status,200,saved.body.error);
  assert.deepEqual((await db.query('SELECT password_hash,pin_hash FROM users WHERE id=$1',[owner.actor.id])).rows[0],before);
  assert.equal((await send(developer,'/staff/'+developer.actor.id,body(developer,{active:false}),'patch')).status,403);
  owner=await login(owner.actor.email,owner.password);
  assert.equal(owner.actor.role,'owner');assert.equal(owner.actor.email,'synthetic.role.owner@example.test');
});

test('developer PIN session stays clock-only and cannot inherit developer management permissions',async()=>{
  const pin='78341526';assert.equal((await send(developer,'/auth/pin',{password:developer.password,pin})).status,200);
  const login=await request(app()).post('/api/auth/login').set('Origin',origin).send({email:developer.actor.email,credential:pin,mode:'pin'});assert.equal(login.status,200,login.body.error);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  assert.equal((await request(app()).get('/api/clock').set('Cookie',cookie)).status,200);
  for(const path of ['/api/staff','/api/tokens','/api/finance/template','/api/organization/branding/history'])assert.equal((await request(app()).get(path).set('Cookie',cookie)).status,403,path);
});

test('developer current role and actual password proof remain authoritative after an earlier logout',async()=>{
  assert.equal((await send(developer,'/auth/logout',{})).status,200);
  for(const path of ['/me','/staff','/organization/branding/history','/finance/template'])assert.equal((await send(developer,path)).status,401,path);
});
