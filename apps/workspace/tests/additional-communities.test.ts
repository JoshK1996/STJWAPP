import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {connectDatabase,migrate,type Database} from '../server/db';
import {initialize} from '../server/seed';

const wanted=[['Teacher Aides','Teacher aide'],['Cafeteria','Cafeteria staff'],['Maintenance','Maintenance technician'],['Janitorial','Custodian'],['Extended Care','Extended care staff'],['Substitute Teachers','Substitute teacher'],['IT','IT coordinator']];
let db:Database,sql:string,orgId:string;
before(async()=>{
  db=await connectDatabase();await migrate(db);
  sql=await readFile(new URL('../server/migrations/050_additional_communities.sql',import.meta.url),'utf8');
  await initialize(db,{demo:false,ownerEmail:'communities.owner@example.test'});
  orgId=(await db.query('SELECT id FROM organizations')).rows[0].id;
});
after(async()=>{await db?.close();});
const communities=async()=>(await db.query("SELECT u.id,u.name,u.kind,u.version,(SELECT count(*) FROM jobs j WHERE j.unit_id=u.id AND j.active)::int AS jobs FROM units u WHERE u.org_id=$1 ORDER BY lower(u.name)",[orgId])).rows;

test('migration on an organization created before it adds the seven communities, each a department with one starter job',async()=>{
  const before=await communities();assert.equal(before.length,4,'the four baseline communities');
  const structureBefore=(await db.query('SELECT version FROM organization_structure_state WHERE org_id=$1',[orgId])).rows[0]?.version??0;
  await db.query(sql);
  const after=await communities();assert.equal(after.length,11);
  for(const [name,title] of wanted){
    const unit=after.find(u=>u.name===name);assert.ok(unit,name);assert.equal(unit.kind,'department');assert.equal(unit.version,1);assert.equal(unit.jobs,1);
    assert.equal((await db.query('SELECT title FROM jobs WHERE unit_id=$1',[unit.id])).rows[0].title,title);
  }
  assert.deepEqual(after.filter(u=>!wanted.some(([name])=>name===u.name)).map(u=>u.name).sort(),before.map(u=>u.name).sort(),'existing communities are untouched');
  assert.equal((await db.query('SELECT version FROM organization_structure_state WHERE org_id=$1',[orgId])).rows[0].version,structureBefore+7,'the structure revision advances so open editors reload');
});

test('running the migration again changes nothing, and a community that already exists in any letter case is not duplicated',async()=>{
  const first=await communities(),structure=(await db.query('SELECT version FROM organization_structure_state WHERE org_id=$1',[orgId])).rows[0].version;
  await db.query(sql);assert.deepEqual(await communities(),first);
  assert.equal((await db.query('SELECT version FROM organization_structure_state WHERE org_id=$1',[orgId])).rows[0].version,structure);
  // An administrator renamed IT before the migration ran on another database: simulate with a differently cased name.
  await db.query("DELETE FROM jobs WHERE unit_id=(SELECT id FROM units WHERE org_id=$1 AND name='Cafeteria')",[orgId]);
  await db.query("UPDATE units SET name='cafeteria' WHERE org_id=$1 AND name='Cafeteria'",[orgId]);
  await db.query(sql);
  const names=(await communities()).map(u=>u.name);assert.equal(names.filter(n=>n.toLowerCase()==='cafeteria').length,1);assert.ok(names.includes('cafeteria'));
});

test('an employee can be given a new community and its starter job and can clock in there',async()=>{
  const unit=(await db.query("SELECT id FROM units WHERE org_id=$1 AND name='Janitorial'",[orgId])).rows[0],job=(await db.query('SELECT id FROM jobs WHERE unit_id=$1',[unit.id])).rows[0];
  const user=randomUUID();
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic custodian','employee')",[user,orgId,user+'@stjw.org']);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[orgId,user,unit.id]);
  await db.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[orgId,user,job.id]);
  const {clockState}=await import('../server/workforce');
  const state=await clockState(db,{id:user,org_id:orgId,name:'Synthetic custodian',email:user+'@stjw.org',role:'employee',unit_ids:[unit.id],mode:'password'});
  assert.deepEqual(state.jobs.map((j:any)=>[j.title,j.unit_name]),[['Custodian','Janitorial']]);
});
