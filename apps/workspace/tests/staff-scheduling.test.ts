import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createSchedule, updateSchedule, cancelSchedule, listSchedules, scheduleHistory } from "../server/staff-scheduling";
import { staffScheduleCreateInput, staffScheduleQuery } from "../shared/staff-scheduling";
import { assertRuntimeAccess, runtimeGrantsSql } from "../server/runtime-access";
let db: Database, owner: Actor, app: ReturnType<typeof createApp>, units: string[];
const origin = "http://localhost:3000";
before(async () => {
  db = await connectDatabase(); await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const u = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner = { id:u.id, org_id:u.org_id, name:u.name, email:u.email, role:u.role, unit_ids:[], mode:"password" };
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(r => r.id);
  app = createApp(db, { origin, production:false, demo:true, staffDomain:"stjw.org" });
});
after(async () => { await db?.close(); });
async function person(role = "employee", unitIds = [units[0]]) {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic schedule staff',$3,$4)", [id,owner.org_id,id+"@stjw.org",role]);
  for (const unitId of unitIds) await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [owner.org_id,id,unitId]);
  return {...owner,id,role,unit_ids:unitIds};
}
async function job(userId: string, unitId = units[0]) {
  const id = randomUUID();
  await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic scheduled work')", [id,owner.org_id,unitId]);
  await db.query("INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)", [owner.org_id,userId,id]);
  return id;
}
async function input() {
  const employee = await person();
  return { userId:employee.id, jobId:await job(employee.id), startsAt:"2026-11-01T05:30:00.000Z", endsAt:"2026-11-01T07:30:00.000Z", note:"Synthetic schedule", reason:"Initial staffing assignment", commandId:randomUUID() };
}
function update(raw: Awaited<ReturnType<typeof input>>, expectedVersion = 1) {
  return { jobId:raw.jobId, startsAt:raw.startsAt, endsAt:raw.endsAt, note:"Revised staffing note", expectedVersion, reason:"Confirmed staff schedule adjustment", commandId:randomUUID() };
}
async function session(actor = owner, mode = "password") {
  const token = opaqueToken(), csrf = opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [digest(token),actor.org_id,actor.id,mode,csrf]);
  return { cookie:"stjw_session="+token, csrf };
}
const query = (includeCancelled = false) => ({ start:"2026-11-01T00:00:00.000Z", end:"2026-11-02T00:00:00.000Z", includeCancelled });

test("schedule changes preserve before/after evidence, exact instants and idempotent retries after later changes", async () => {
  const raw = await input(), first = await createSchedule(db, owner, raw);
  assert.deepEqual(await createSchedule(db, owner, raw), first);
  const edit = update(raw), second = await updateSchedule(db, owner, first.id, edit);
  const cancel = { expectedVersion:2, reason:"Shift no longer required", commandId:randomUUID() };
  const third = await cancelSchedule(db, owner, first.id, cancel);
  assert.equal(third.version, 3); assert.equal(third.status, "cancelled");
  assert.deepEqual(await createSchedule(db, owner, raw), first);
  assert.deepEqual(await updateSchedule(db, owner, first.id, edit), second);
  assert.deepEqual(await cancelSchedule(db, owner, first.id, cancel), third);
  await assert.rejects(cancelSchedule(db, owner, first.id, {...cancel,reason:"Changed command payload"}), /identifier/);
  const history = await scheduleHistory(db, owner, first.id);
  assert.deepEqual(history.rows.map(r => r.action), ["cancelled","updated","created"]);
  assert.equal(history.rows[0].before_snapshot.version, 2);
  assert.equal(history.rows[2].after_snapshot.startsAt, raw.startsAt);
  assert.equal(Date.parse(history.rows[2].after_snapshot.endsAt)-Date.parse(raw.startsAt), 2*3600000);
  assert.equal(history.current.cancelledAt !== null, true);
  assert.equal((await listSchedules(db, owner, query())).rows.some(r => r.id===first.id), false);
  assert.equal((await listSchedules(db, owner, query(true))).rows.some(r => r.id===first.id), true);
  await assert.rejects(updateSchedule(db, owner, first.id, {...edit,expectedVersion:3,commandId:randomUUID()}), /cancelled/);
  for (const table of ["staff_schedule_history","staff_schedule_commands"])
    await assert.rejects(db.query(`DELETE FROM ${table}`), /immutable|append|audit/i);
});

test("employee serialization blocks concurrent overlaps and stale edits but permits adjacent shifts and replacing cancelled time", async () => {
  const raw = await input();
  const results = await Promise.allSettled([createSchedule(db, owner, raw), createSchedule(db, owner, {...raw,commandId:randomUUID()})]);
  assert.equal(results.filter(r => r.status==="fulfilled").length,1);
  const first = (results.find(r => r.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof createSchedule>>>).value;
  const adjacent = await createSchedule(db, owner, {...raw,startsAt:raw.endsAt,endsAt:"2026-11-01T08:30:00.000Z",commandId:randomUUID()});
  await assert.rejects(updateSchedule(db, owner, first.id, {...update(raw),endsAt:"2026-11-01T07:30:00.001Z"}), /already has a shift/);
  const edits = await Promise.allSettled([updateSchedule(db, owner, first.id, update(raw)),updateSchedule(db, owner, first.id, {...update(raw),note:"Other concurrent edit"})]);
  assert.equal(edits.filter(r => r.status==="fulfilled").length,1);
  await cancelSchedule(db, owner, adjacent.id, {expectedVersion:1,reason:"Cancel adjacent example",commandId:randomUUID()});
  await createSchedule(db, owner, {...raw,startsAt:raw.endsAt,endsAt:"2026-11-01T08:30:00.000Z",commandId:randomUUID()});
  assert.throws(() => staffScheduleCreateInput.parse({...raw,endsAt:"2026-11-02T05:30:00.001Z"}), /24 hours/);
  assert.throws(() => staffScheduleCreateInput.parse({...raw,endsAt:raw.startsAt}), /zero/);
  assert.equal(staffScheduleCreateInput.parse({...raw,endsAt:"2026-11-02T05:30:00.000Z"}).endsAt,"2026-11-02T05:30:00.000Z");
  assert.throws(() => staffScheduleQuery.parse({start:raw.startsAt,end:raw.endsAt,includeCancelled:"anything"}));
});

test("managers need exact source and target units; current database roles and explicit memberships override cached actors", async () => {
  const manager = await person("manager"), employee = await person("employee",[units[0],units[1]]);
  const firstJob = await job(employee.id), otherJob = await job(employee.id,units[1]);
  const raw = {...await input(),userId:employee.id,jobId:firstJob};
  const first = await createSchedule(db, manager, raw);
  await assert.rejects(updateSchedule(db, manager, first.id, {...update(raw),jobId:otherJob}), /selected job.*outside/);
  await updateSchedule(db, owner, first.id, {...update(raw),jobId:otherJob});
  await assert.rejects(updateSchedule(db, manager, first.id, {...update(raw,2),jobId:firstJob}), /original scheduled job.*outside/);
  await assert.rejects(cancelSchedule(db, manager, first.id, {expectedVersion:2,reason:"Unauthorized source cancellation",commandId:randomUUID()}), /original scheduled job.*outside/);
  const otherManager = await person("manager",[units[1]]);
  await assert.rejects(scheduleHistory(db, otherManager, first.id), /earlier history/);
  assert.equal((await listSchedules(db, otherManager, query())).rows.some(r => r.id===first.id),true);
  await db.query("UPDATE users SET role='employee' WHERE id=$1",[manager.id]);
  await assert.rejects(createSchedule(db, manager, {...raw,commandId:randomUUID()}), /management access/);
  await db.query("UPDATE users SET role='manager' WHERE id=$1",[manager.id]);
  await db.query("DELETE FROM user_units WHERE user_id=$1",[manager.id]);
  await assert.rejects(createSchedule(db, manager, {...raw,commandId:randomUUID()}), /outside/);
  await db.query("UPDATE units SET parent_id=$1 WHERE id=$2",[units[0],units[1]]);
  const parentManager = await person("manager",[units[0]]);
  await assert.rejects(createSchedule(db,parentManager,{...raw,jobId:otherJob,commandId:randomUUID()}),/outside/);
});

test("inactive or unassigned staff and jobs retain visible schedules and cancellation history", async () => {
  const raw = await input(), first = await createSchedule(db, owner, raw);
  const employee = {...owner,id:raw.userId,role:"employee",unit_ids:[]};
  await db.query("DELETE FROM user_jobs WHERE user_id=$1",[raw.userId]);
  await db.query("DELETE FROM user_units WHERE user_id=$1",[raw.userId]);
  assert.equal((await listSchedules(db,employee,query())).rows.some(r=>r.id===first.id),true);
  assert.equal((await scheduleHistory(db,employee,first.id)).current.id,first.id);
  await assert.rejects(updateSchedule(db,owner,first.id,update(raw)),/not assigned/);
  await db.query("UPDATE jobs SET active=false WHERE id=$1",[raw.jobId]);
  await db.query("UPDATE users SET active=false WHERE id=$1",[raw.userId]);
  await assert.rejects(updateSchedule(db,owner,first.id,update(raw)),/inactive/);
  const cancelled = await cancelSchedule(db,owner,first.id,{expectedVersion:1,reason:"Close inactive staff assignment",commandId:randomUUID()});
  assert.equal(cancelled.status,"cancelled");
  assert.equal((await scheduleHistory(db,owner,first.id)).rows.length,2);
});

test("current access and assignment are checked after employee locks, and snapshot labels stay historical", async () => {
  const raw = await input(), manager = await person("manager");
  const wrap = (mutation: (tx: Queryable) => Promise<unknown>): Database => ({...db,transaction:fn=>db.transaction(async tx=>{
    let applied = false;
    return fn({query:async (sql,params)=>{
      if (!applied && sql.includes("FROM users") && sql.includes("FOR NO KEY UPDATE")) { applied=true; await mutation(tx); }
      return tx.query(sql,params);
    }});
  })});
  await assert.rejects(createSchedule(wrap(tx=>tx.query("UPDATE users SET role='employee' WHERE id=$1",[manager.id])),manager,raw),/management access/);
  await assert.rejects(createSchedule(wrap(tx=>tx.query("DELETE FROM user_jobs WHERE user_id=$1",[raw.userId])),owner,raw),/not assigned/);
  const first = await createSchedule(db,owner,raw);
  await db.query("UPDATE users SET name='Renamed synthetic person' WHERE id=$1",[raw.userId]);
  await updateSchedule(db,owner,first.id,update(raw));
  const history = await scheduleHistory(db,owner,first.id);
  assert.equal(history.rows[1].after_snapshot.employeeName,"Synthetic schedule staff");
  assert.equal(history.rows[0].after_snapshot.employeeName,"Renamed synthetic person");
});

test("schedule mutations roll back with history and retry receipts when the metadata-only audit fails", async () => {
  const raw = await input(), first = await createSchedule(db,owner,raw), edit = update(raw);
  const wrapped: Database = {...db,transaction:fn=>db.transaction(tx=>fn({query:(sql,params)=>{
    if (sql.includes("INSERT INTO audit_events")) throw Error("Synthetic schedule audit failure");
    return tx.query(sql,params);
  }}))};
  await assert.rejects(updateSchedule(wrapped,owner,first.id,edit),/Synthetic schedule audit failure/);
  assert.equal((await scheduleHistory(db,owner,first.id)).rows.length,1);
  assert.equal((await db.query("SELECT version,note FROM schedules WHERE id=$1",[first.id])).rows[0].version,1);
  assert.equal((await db.query("SELECT command_id FROM staff_schedule_commands WHERE command_id=$1",[edit.commandId])).rows.length,0);
  await updateSchedule(db,owner,first.id,edit);
  const details=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1 ORDER BY created_at",[first.id])).rows;
  assert.equal(details.length,2);
  for(const row of details) {
    assert.deepEqual(Object.keys(row.detail).sort(),["commandId","previousVersion","snapshotHash","version"]);
    assert.equal(JSON.stringify(row.detail).includes(edit.note),false);
    assert.equal(JSON.stringify(row.detail).includes(edit.reason),false);
  }
});

test("HTTP schedule API requires password sessions, CSRF, valid reasons and versions, and preserves own-only employee reads", async () => {
  const raw=await input(), auth=await session(), employee={...owner,id:raw.userId,role:"employee",unit_ids:[units[0]]};
  const staffAuth=await session(employee), outsider=await person(), outsiderAuth=await session(outsider);
  await request(app).post("/api/schedules").set("Cookie",auth.cookie).set("Origin",origin).send(raw).expect(403);
  await request(app).post("/api/schedules").set("Cookie",auth.cookie).set("Origin",origin).set("X-CSRF-Token",auth.csrf).send({...raw,reason:""}).expect(400);
  const response=await request(app).post("/api/schedules").set("Cookie",auth.cookie).set("Origin",origin).set("X-CSRF-Token",auth.csrf).send(raw).expect(201);
  const id=response.body.id;
  await request(app).patch("/api/schedules/"+id).set("Cookie",staffAuth.cookie).set("Origin",origin).set("X-CSRF-Token",staffAuth.csrf).send(update(raw)).expect(403);
  await request(app).patch("/api/schedules/"+id).set("Cookie",auth.cookie).set("Origin",origin).set("X-CSRF-Token",auth.csrf).send({...update(raw),userId:owner.id}).expect(400);
  await request(app).get(`/api/schedules/${id}/history`).set("Cookie",staffAuth.cookie).expect(200);
  await request(app).get(`/api/schedules/${id}/history`).set("Cookie",outsiderAuth.cookie).expect(403);
  const pin=await session(owner,"pin");
  await request(app).get("/api/schedules").query({start:raw.startsAt,end:raw.endsAt}).set("Cookie",pin.cookie).expect(403);
  const rows=await request(app).get("/api/schedules").query({start:raw.startsAt,end:raw.endsAt}).set("Cookie",outsiderAuth.cookie).expect(200);
  assert.equal(rows.body.rows.length,0);
  await request(app).post(`/api/schedules/${id}/cancel`).set("Cookie",auth.cookie).set("Origin",origin).set("X-CSRF-Token",auth.csrf).send({expectedVersion:9,reason:"Stale cancellation",commandId:randomUUID()}).expect(409);
  const finance=await person("finance");
  assert.equal((await listSchedules(db,finance,query())).rows.some(r=>r.id===id),true);
  await assert.rejects(createSchedule(db,finance,{...raw,commandId:randomUUID()}),/management access/);
});

test("history uses bounded pages without losing any revision or changing the current snapshot", async () => {
  const raw=await input(), first=await createSchedule(db,owner,raw);
  for(let version=1;version<=22;version++) await updateSchedule(db,owner,first.id,{...update(raw,version),note:"Revision "+(version+1)});
  const page1=await scheduleHistory(db,owner,first.id);
  assert.equal(page1.rows.length,20); assert.equal(page1.nextBeforeVersion,4);
  const page2=await scheduleHistory(db,owner,first.id,page1.nextBeforeVersion!);
  assert.deepEqual(page2.rows.map(r=>r.version),[3,2,1]);
  assert.equal(page2.current.version,23); assert.equal(page2.nextBeforeVersion,null);
});

test("restricted runtime role can perform audited schedule changes while history remains immutable", async () => {
  const raw=await input();
  const original=(await db.query("SELECT session_user AS name")).rows[0].name;
  for (const statement of runtimeGrantsSql().match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await db.query(statement);
  try {
    await db.query("SET SESSION AUTHORIZATION stjw_runtime");
    await assertRuntimeAccess(db);
    const first=await createSchedule(db,owner,raw);
    await updateSchedule(db,owner,first.id,update(raw));
    await cancelSchedule(db,owner,first.id,{expectedVersion:2,reason:"Runtime role cancellation example",commandId:randomUUID()});
    assert.equal((await scheduleHistory(db,owner,first.id)).rows.length,3);
    await assert.rejects(db.query("DELETE FROM staff_schedule_history WHERE schedule_id=$1",[first.id]),/permission denied/);
    await assert.rejects(db.query("UPDATE staff_schedule_commands SET fingerprint='changed'"),/permission denied/);
  } finally {
    await db.query('SET SESSION AUTHORIZATION "'+String(original).replaceAll('"','""')+'"');
  }
});

test("fresh synthetic demo provisioning records an initial version for every scheduled shift", async () => {
  const seeded=await connectDatabase();
  try {
    await migrate(seeded);
    await initialize(seeded,{demo:true,ownerEmail:"synthetic.owner@example.test"});
    const rows=(await seeded.query("SELECT s.id,h.action,h.version,h.before_snapshot,h.after_snapshot FROM schedules s LEFT JOIN staff_schedule_history h ON h.schedule_id=s.id")).rows;
    assert.equal(rows.length,8);
    for(const row of rows) {
      assert.equal(row.action,"created");assert.equal(row.version,1);assert.equal(row.before_snapshot,null);
      assert.equal(row.after_snapshot.id,row.id);assert.equal(row.after_snapshot.note,"Demonstration schedule");
    }
  } finally { await seeded.close(); }
});

test("migration 020 captures existing planned shifts as immutable baselines without inventing earlier edits", async () => {
  const legacy=await connectDatabase();
  const applySql=async (name:string)=>{
    const sql=await readFile(new URL("../server/migrations/"+name,import.meta.url),"utf8");
    await legacy.transaction(async tx=>{
      for(const statement of sql.match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g)??[]) await tx.query(statement);
    });
  };
  try {
    // The schedules table retained its 001 shape through 019. Exercise the
    // actual 020 SQL against that old table with an existing record.
    await applySql("001_core.sql");
    await initialize(legacy,{demo:false,ownerEmail:"synthetic.legacy@example.test"});
    const staff=(await legacy.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
    const assigned=(await legacy.query("SELECT j.id,j.title,j.unit_id,u.name AS unit_name FROM jobs j JOIN units u ON u.id=j.unit_id ORDER BY j.id LIMIT 1")).rows[0];
    const id=randomUUID(),start="2026-11-01T05:30:00.000Z",end="2026-11-01T07:30:00.000Z";
    await legacy.query("INSERT INTO schedules(id,org_id,user_id,job_id,starts_at,ends_at,note,created_by) VALUES($1,$2,$3,$4,$5,$6,'Existing synthetic plan',$3)",[id,staff.org_id,staff.id,assigned.id,start,end]);
    await applySql("020_staff_scheduling.sql");
    const history=(await legacy.query("SELECT * FROM staff_schedule_history WHERE schedule_id=$1",[id])).rows[0];
    assert.equal(history.version,1);assert.equal(history.action,"baseline");assert.equal(history.actor_id,null);
    assert.equal(history.before_snapshot,null);assert.match(history.reason,/Earlier changes are unavailable/);
    assert.equal(history.after_snapshot.note,"Existing synthetic plan");assert.equal(history.after_snapshot.unitName,assigned.unit_name);
    assert.equal(new Date(history.after_snapshot.startsAt).toISOString(),start);
    assert.equal(new Date(history.after_snapshot.endsAt).toISOString(),end);
    const current=(await legacy.query("SELECT id,created_by,version,status,cancelled_at FROM schedules WHERE id=$1",[id])).rows[0];
    assert.deepEqual(current,{id,created_by:staff.id,version:1,status:"scheduled",cancelled_at:null});
    await assert.rejects(legacy.query("UPDATE staff_schedule_history SET reason='Fabricated earlier history'"),/immutable|append|audit/i);
  } finally {await legacy.close();}
});
