import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDatabase,migrate,type Database} from '../server/db';
import {initialize} from '../server/seed';
import {createRequest,reviewRequest} from '../server/workforce';
import type {Actor} from '../server/security';
let db:Database,owner:Actor,unitId:string;
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'requests@example.test'});
  const row=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:row.role,mode:'password',unit_ids:[]};
  unitId=(await db.query('SELECT id FROM units ORDER BY id LIMIT 1')).rows[0].id;
});
after(async()=>{await db?.close();});
async function person(role:Actor['role']='employee'){
  const id=randomUUID(),email=id+'@stjw.org';
  await db.query('INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)',[id,owner.org_id,'Synthetic requester',email,role]);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[owner.org_id,id,unitId]);
  return {...owner,id,email,role,unit_ids:[unitId]};
}
const input=()=>({unitId,kind:'schedule' as const,startsOn:'2026-10-01',endsOn:'2026-10-01',note:'Synthetic request for a different shift'});
test('request submission rejects a stale unit assignment and a newly inactive account',async()=>{
  const actor=await person();
  await db.query('DELETE FROM user_units WHERE user_id=$1',[actor.id]);
  await assert.rejects(createRequest(db,actor,input()),/assigned units/);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[owner.org_id,actor.id,unitId]);
  await db.query('UPDATE users SET active=false WHERE id=$1',[actor.id]);
  await assert.rejects(createRequest(db,actor,input()),/inactive|unavailable/);
  assert.equal((await db.query('SELECT id FROM requests WHERE user_id=$1',[actor.id])).rows.length,0);
});
test('request review rejects a stale manager role and stale exact-unit access',async()=>{
  const employee=await person(),manager=await person('manager');
  const pending=await createRequest(db,employee,input());
  await db.query("UPDATE users SET role='employee' WHERE id=$1",[manager.id]);
  await assert.rejects(reviewRequest(db,manager,pending.id,'approved','Reviewed synthetic request'),/review access/);
  await db.query("UPDATE users SET role='manager' WHERE id=$1",[manager.id]);
  await db.query('DELETE FROM user_units WHERE user_id=$1',[manager.id]);
  await assert.rejects(reviewRequest(db,manager,pending.id,'approved','Reviewed synthetic request'),/unit|scope/i);
  assert.equal((await db.query('SELECT status FROM requests WHERE id=$1',[pending.id])).rows[0].status,'pending');
});
test('password-only current actors retain self-review denial and one final decision',async()=>{
  const manager=await person('manager'),employee=await person();
  await assert.rejects(createRequest(db,{...employee,mode:'pin'},input()),/password/);
  const own=await createRequest(db,manager,input());
  await assert.rejects(reviewRequest(db,manager,own.id,'approved','Self review denied'),/different manager/);
  const pending=await createRequest(db,employee,input());
  await assert.rejects(reviewRequest(db,{...manager,mode:'pin'},pending.id,'approved','PIN review denied'),/password/);
  const decisions=await Promise.allSettled([
    reviewRequest(db,manager,pending.id,'approved','First reviewed decision'),
    reviewRequest(db,owner,pending.id,'declined','Other reviewed decision'),
  ]);
  assert.equal(decisions.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(decisions.filter(result=>result.status==='rejected').length,1);
});
test('a failed request audit leaves both submission and review unchanged',async()=>{
  const employee=await person(),manager=await person('manager');
  const failing:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:(sql,params)=>{
    if(sql.includes('INSERT INTO audit_events')) throw Error('Synthetic request audit failure');
    return tx.query(sql,params);
  }}))};
  await assert.rejects(createRequest(failing,employee,input()),/Synthetic request audit failure/);
  assert.equal((await db.query('SELECT id FROM requests WHERE user_id=$1',[employee.id])).rows.length,0);
  const pending=await createRequest(db,employee,input());
  await assert.rejects(reviewRequest(failing,manager,pending.id,'approved','Review rollback'),/Synthetic request audit failure/);
  const row=(await db.query('SELECT status,reviewer_id FROM requests WHERE id=$1',[pending.id])).rows[0];
  assert.equal(row.status,'pending');assert.equal(row.reviewer_id,null);
});
