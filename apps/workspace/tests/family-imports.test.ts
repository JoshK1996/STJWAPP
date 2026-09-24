import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import request from "supertest";
import {connectDatabase,migrate,type Database} from "../server/db";
import {initialize} from "../server/seed";
import {createApp} from "../server/app";
import {digest,opaqueToken,type Actor} from "../server/security";
import {createStudent,createHouseholdTransaction,saveHouseholdMemberTransaction,saveContactTransaction} from "../server/school";
import {studentInput,contactInput} from "../shared/school";
import {schoolImportCatalog,type SchoolImportKind} from "../shared/school-imports";
import {previewSchoolImport,applySchoolImport,parseSchoolCsv} from "../server/school-imports";
import {toCsv} from "../server/reports";
import {runtimeGrantsSql,assertRuntimeAccess} from "../server/runtime-access";
let db:Database,owner:Actor,unitId:string,otherUnit:string,app:ReturnType<typeof createApp>,auth:{cookie:string;csrf:string;hash:string};
const passwordProofs=new Map<string,string>();
const origin="http://localhost:3000";
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:"owner@example.test"});
  const u=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner={id:u.id,org_id:u.org_id,name:u.name,email:u.email,role:u.role,unit_ids:[],mode:"password"};
  [unitId,otherUnit]=(await db.query("SELECT id FROM units ORDER BY id")).rows.map(r=>r.id);
  app=createApp(db,{origin,production:false,demo:true,staffDomain:"stjw.org"});auth=await session(owner);
});
after(async()=>{await db?.close();});
async function session(actor:Actor,mode="password") {
  const token=opaqueToken(),csrf=opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[digest(token),actor.org_id,actor.id,mode,csrf]);
  const hash=digest(token);if(mode==="password")passwordProofs.set(actor.id,hash);
  return {cookie:"stjw_session="+token,csrf,hash};
}
async function adult(unit=unitId) {
  const id=randomUUID();
  return (await db.query("INSERT INTO school_people(id,org_id,unit_id,name,email,phone) VALUES($1,$2,$3,'Synthetic adult','synthetic@example.test','555-0100') RETURNING *",[id,owner.org_id,unit])).rows[0];
}
async function family(name="Synthetic household") {return db.transaction(tx=>createHouseholdTransaction(tx,owner,{unitId,name,address:"Synthetic address"}));}
async function child(number="S-"+randomUUID()) {return createStudent(db,owner,studentInput.parse({unitId,name:"Synthetic student",studentNumber:number}));}
function csv(kind:SchoolImportKind,rows:Record<string,unknown>[]) {return toCsv(rows,schoolImportCatalog[kind].columns);}
const context=(kind:SchoolImportKind)=>({kind,unitId});
const applyBody=(preview:any)=>({sourceHash:preview.sourceHash,planHash:preview.planHash,reviewed:true});
const preview=(kind:SchoolImportKind,rows:Record<string,unknown>[],actor=owner)=>previewSchoolImport(db,actor,{context:context(kind),csv:csv(kind,rows)},passwordProofs.get(actor.id));
const apply=(p:any,actor=owner,target=db)=>applySchoolImport(target,actor,p.id,applyBody(p),passwordProofs.get(actor.id));
function contactRow(student:any,person:any,changes:Record<string,unknown>={}) {
  return {studentId:student.id,studentNumber:student.student_number,studentVersion:String(student.version),personId:person.id,personVersion:String(person.version),contactVersion:"0",relationship:"Emergency contact",isGuardian:"false",canCommunicate:"false",canPickup:"false",pickupUntilAction:"keep",pickupUntil:"",emergencyPriority:"",restrictionNoteAction:"keep",restrictionNote:"",...changes};
}
const get=(path:string,a=auth)=>request(app).get("/api"+path).set("Cookie",a.cookie);

test("household imports use exact identities, retain BOM source privately, and retry with one immutable receipt",async()=>{
  const source=csv("households",[{householdId:"",version:"0",name:"Synthetic café household 🏠",address:"Line one\nLine two",archived:"false"}]);
  const p=await previewSchoolImport(db,owner,{context:context("households"),csv:source},auth.hash);
  assert.equal(p.plan.counts.create,1);assert.equal(p.hasSource,true);assert.equal(p.sourceHash,digest(source));
  assert.equal("originalSource" in p.plan,false);
  const downloaded=await get(`/school/imports/${p.id}/source`).buffer(true).parse((res,callback)=>{const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>callback(null,Buffer.concat(chunks)));}).expect(200);
  assert.deepEqual(downloaded.body,Buffer.from(source,"utf8"));assert.match(downloaded.headers["content-disposition"],/\.txt/);
  const a=await apply(p),retry=await apply(p);assert.deepEqual(retry.receipt,a.receipt);
  const id=a.receipt.records[0].householdId;
  assert.equal((await db.query("SELECT name FROM households WHERE id=$1",[id])).rows[0].name,"Synthetic café household 🏠");
  await assert.rejects(db.query("UPDATE school_import_batches SET plan='{}' WHERE id=$1",[p.id]),/immutable|receipt/);
  const invalid=await preview("households",[{householdId:id,version:"0",name:"Wrong version",address:"",archived:"false"}]);
  assert.equal(invalid.plan.counts.errors,1);await assert.rejects(apply(invalid),/every row error/);
});

test("current-record household templates round-trip literal spreadsheet text without matching names",async()=>{
  const h=await family("=Synthetic name");
  await db.query("UPDATE households SET address='-Synthetic address' WHERE id=$1",[h.id]);
  const template=await get(`/school/imports/template/households?unitId=${unitId}&populated=true`).expect(200);
  const p=await previewSchoolImport(db,owner,{context:context("households"),csv:template.text},auth.hash);
  assert.equal(p.plan.counts.errors,0);assert.equal(p.plan.counts.update,0);assert.equal(p.plan.counts.create,0);
  const separate=await preview("households",[{householdId:"",version:"0",name:"=Synthetic name",address:"",archived:"false"}]);
  assert.equal(separate.plan.counts.create,1);assert.notEqual((await apply(separate)).receipt.records[0].householdId,h.id);
  const duplicates=await preview("households",[1,2].map(()=>({householdId:h.id,version:"1",name:"Synthetic edit",address:"",archived:"false"})));
  assert.equal(duplicates.plan.counts.errors,2);
  const missing=await preview("households",[{householdId:randomUUID(),version:"1",name:"=Synthetic name",address:"",archived:"false"}]);
  assert.equal(missing.plan.counts.errors,1);
});

test("household membership grants no contact permission and detects exact membership/person drift",async()=>{
  const h=await family(),person=await adult(),student=await child();
  const input={householdId:h.id,householdVersion:"1",personId:person.id,personVersion:"1",role:"guardian",remove:"false"};
  const p=await preview("household_members",[input]);await apply(p);
  assert.equal((await db.query("SELECT role FROM household_members WHERE household_id=$1 AND person_id=$2",[h.id,person.id])).rows[0].role,"guardian");
  assert.equal((await db.query("SELECT * FROM student_contacts WHERE student_id=$1",[student.id])).rows.length,0);
  const pending=await preview("household_members",[{...input,role:"other"}]);
  await db.transaction(tx=>saveHouseholdMemberTransaction(tx,owner,h.id,{personId:person.id,role:"student",remove:false}));
  await assert.rejects(apply(pending),/changed after this preview/);
  const remove=await preview("household_members",[{...input,role:"student",remove:"true"}]);await apply(remove);
  assert.equal((await db.query("SELECT * FROM household_members WHERE household_id=$1 AND person_id=$2",[h.id,person.id])).rows.length,0);
  const foreign=await adult(otherUnit);
  const invalid=await preview("household_members",[{...input,personId:foreign.id}]);assert.equal(invalid.plan.counts.errors,1);
});

test("contact imports require explicit booleans and expiry choices; custody restrictions and holds survive keep",async()=>{
  const student=await child(),person=await adult();
  const incomplete=await preview("contacts",[contactRow(student,person,{canPickup:""})]);assert.equal(incomplete.plan.counts.errors,1);
  const implicit=await preview("contacts",[contactRow(student,person,{canPickup:"true"})]);
  assert.match(implicit.plan.rows[0].errors.join(" "),/expiry/);
  const explicit=await preview("contacts",[contactRow(student,person,{canPickup:"true",pickupUntilAction:"replace",pickupUntil:"2026-12-31",restrictionNoteAction:"replace",restrictionNote:"Staff must verify current custody instruction"})]);
  assert.equal(explicit.plan.rows[0].after.canPickup,true);await apply(explicit);
  await db.query("INSERT INTO child_pickup_holds(org_id,unit_id,student_id,active,reason) VALUES($1,$2,$3,true,'Synthetic custody hold')",[owner.org_id,unitId,student.id]);
  const kept=await preview("contacts",[contactRow(student,person,{contactVersion:"1",relationship:"Grandparent",canPickup:"true",isGuardian:"true",canCommunicate:"true"})]);
  assert.equal(kept.plan.rows[0].after.pickupUntil,"2026-12-31");
  assert.equal(kept.plan.rows[0].after.restrictionNote,"Staff must verify current custody instruction");
  await apply(kept);
  const row=(await db.query("SELECT * FROM student_contacts WHERE student_id=$1 AND person_id=$2",[student.id,person.id])).rows[0];
  assert.equal(row.version,2);assert.equal(row.is_guardian,true);assert.equal(row.can_communicate,true);
  assert.equal((await db.query("SELECT active,reason,version FROM child_pickup_holds WHERE student_id=$1",[student.id])).rows[0].reason,"Synthetic custody hold");
  const clear=await preview("contacts",[contactRow(student,person,{contactVersion:"2",canPickup:"true",pickupUntilAction:"clear",restrictionNoteAction:"clear"})]);
  assert.match(clear.plan.rows[0].after.pickupExpiry,/No expiry/);assert.equal(clear.plan.rows[0].after.restrictionNote,"");await apply(clear);
});

test("adult contacts require exact student/person versions and do not infer identities from duplicate names",async()=>{
  const student=await child("=Synthetic"+randomUUID().slice(0,12)),person=await adult(),other=await child();
  const p=await preview("contacts",[contactRow(student,person,{pickupUntilAction:"clear",canPickup:"true"})]);await apply(p);
  const template=await get(`/school/imports/template/contacts?unitId=${unitId}&populated=true`).expect(200);
  const roundtrip=await previewSchoolImport(db,owner,{context:context("contacts"),csv:template.text},auth.hash);assert.equal(roundtrip.plan.counts.errors,0);assert.equal(roundtrip.plan.counts.update,0);
  const wrongId=await preview("contacts",[contactRow(student,person,{studentId:other.id})]);assert.equal(wrongId.plan.counts.errors,1);
  const ownStudentPerson=(await db.query("SELECT id,version FROM school_people WHERE id=$1",[other.person_id])).rows[0];
  const invalid=await preview("contacts",[contactRow(student,ownStudentPerson)]);assert.match(invalid.plan.rows[0].errors.join(" "),/adult contact/);
  const stale=await preview("contacts",[contactRow(student,person,{personVersion:"9",contactVersion:"1"})]);assert.match(stale.plan.rows[0].errors.join(" "),/Person version|person version/);
});

test("contact previews reject changed permissions, people, students, holds, enrollment and roster sources atomically",async()=>{
  const student=await child(),person=await adult();
  const yearId=randomUUID(),sectionId=randomUUID();
  await db.query("INSERT INTO school_years(id,org_id,unit_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,'2026-01-01','2026-12-31')",[yearId,owner.org_id,unitId,yearId]);
  await db.query("INSERT INTO sections(id,org_id,unit_id,year_id,name,capacity) VALUES($1,$2,$3,$4,'Synthetic class',20)",[sectionId,owner.org_id,unitId,yearId]);
  await db.query("INSERT INTO student_enrollments(id,org_id,unit_id,student_id,year_id,grade_level,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,'1','2026-01-01','2026-12-31')",[randomUUID(),owner.org_id,unitId,student.id,yearId]);
  await db.query("INSERT INTO section_students(org_id,unit_id,section_id,student_id,starts_on,ends_on) VALUES($1,$2,$3,$4,'2026-01-01','2026-12-31')",[owner.org_id,unitId,sectionId,student.id]);
  const mutations=[
    ()=>db.query("UPDATE school_people SET name='Changed synthetic name',version=version+1 WHERE id=$1",[person.id]),
    ()=>db.query("UPDATE students SET version=version+1 WHERE id=$1",[student.id]),
    ()=>db.query("UPDATE section_students SET version=version+1 WHERE student_id=$1",[student.id]),
    ()=>db.query("UPDATE student_enrollments SET version=version+1 WHERE student_id=$1",[student.id]),
    ()=>db.query("INSERT INTO child_pickup_holds(org_id,unit_id,student_id,active,reason) VALUES($1,$2,$3,true,'New synthetic hold')",[owner.org_id,unitId,student.id]),
  ];
  for(const mutate of mutations) {
    const current=(await db.query("SELECT * FROM students WHERE id=$1",[student.id])).rows[0];
    const currentPerson=(await db.query("SELECT id,version FROM school_people WHERE id=$1",[person.id])).rows[0];
    const p=await preview("contacts",[contactRow(current,currentPerson)]);
    assert.equal(p.plan.counts.errors,0);await mutate();await assert.rejects(apply(p),/changed after this preview/);
    assert.equal((await db.query("SELECT * FROM student_contacts WHERE student_id=$1",[student.id])).rows.length,0);
  }
  const current=(await db.query("SELECT * FROM students WHERE id=$1",[student.id])).rows[0],currentPerson=(await db.query("SELECT id,version FROM school_people WHERE id=$1",[person.id])).rows[0];
  const p=await preview("contacts",[contactRow(current,currentPerson)]);
  await db.transaction(tx=>saveContactTransaction(tx,owner,student.id,contactInput.parse({personId:person.id,relationship:"Other emergency contact",isGuardian:false,canCommunicate:false,canPickup:false})));
  await assert.rejects(apply(p),/changed after this preview/);
});

test("office grants and password sessions protect private previews, source downloads, and identity exports",async()=>{
  const actorId=randomUUID();await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic office staff',$3,'employee')",[actorId,owner.org_id,actorId+"@stjw.org"]);
  const employee={...owner,id:actorId,role:"employee",unit_ids:[]};
  await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",[owner.org_id,actorId,unitId]);
  await db.query("INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)",[owner.org_id,unitId,actorId,owner.id]);
  const a=await session(employee);
  const p=await preview("households",[{householdId:"",version:"0",name:"Private synthetic preview",address:"",archived:"false"}],employee);
  await get(`/school/imports/${p.id}`,auth).expect(404);
  await get(`/school/imports/${p.id}/source`,auth).expect(404);
  await get(`/school/imports/identities/export?unitId=${unitId}`,a).expect(200);
  await get(`/school/imports/template/households?unitId=${otherUnit}`,a).expect(403);
  const pin=await session(owner,"pin");await get(`/school/imports/identities/export?unitId=${unitId}`,pin).expect(403);
  await db.query("DELETE FROM school_office_grants WHERE user_id=$1",[employee.id]);
  await assert.rejects(apply(p,employee),/office access/);
  await get(`/school/imports/${p.id}/source`,a).expect(403);
  await get(`/school/imports/identities/export?unitId=${unitId}`,a).expect(403);
});

test("family mutations and per-record history roll back together when audit fails",async()=>{
  const marker=randomUUID();
  const p=await preview("households",[1,2].map(i=>({householdId:"",version:"0",name:marker+" "+i,address:"",archived:"false"})));
  let audits=0;
  const wrapped:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:(sql,params)=>{
    if(sql.includes("INSERT INTO audit_events")&&++audits===2) throw Error("Synthetic family audit failure");
    return tx.query(sql,params);
  }}))};
  await assert.rejects(apply(p,owner,wrapped),/Synthetic family audit failure/);
  assert.equal((await db.query("SELECT id FROM households WHERE name LIKE $1",[marker+"%"]).then(r=>r.rows)).length,0);
  assert.equal((await db.query("SELECT applied_at FROM school_import_batches WHERE id=$1",[p.id])).rows[0].applied_at,null);
  assert.equal((await apply(p)).receipt.records.length,2);
});

test("competing household previews cannot overwrite a reviewed version",async()=>{
  const h=await family();
  const a=await preview("households",[{householdId:h.id,version:"1",name:"First reviewed name",address:"",archived:"false"}]);
  const b=await preview("households",[{householdId:h.id,version:"1",name:"Second reviewed name",address:"",archived:"false"}]);
  const results=await Promise.allSettled([apply(a),apply(b)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected").length,1);
  assert.equal((await db.query("SELECT version FROM households WHERE id=$1",[h.id])).rows[0].version,2);
});

test("strict family headers and identity catalog retain all existing student import kinds",async()=>{
  for(const kind of ["students","enrollments","roster","households","household_members","contacts"] as const)
    await get(`/school/imports/template/${kind}?unitId=${unitId}`).expect(200);
  const template=await get(`/school/imports/identities/export?unitId=${unitId}`).expect(200);
  assert.match(template.text,/personVersion/);assert.match(template.text,/household/);assert.match(template.text,/student/);
  assert.throws(()=>parseSchoolCsv({kind:"contacts",unitId},"studentNumber,personId\nS-1,"+randomUUID()),/exact headers/);
  const student=await preview("students",[{studentNumber:"NEW-"+randomUUID(),name:"Synthetic imported student",dateOfBirth:""}]);
  assert.equal((await apply(student)).receipt.records.length,1);
  const batch=(await db.query("SELECT * FROM school_import_batches WHERE id=$1",[student.id])).rows[0];
  const oldId=randomUUID(),legacyPlan={...batch.plan};delete legacyPlan.originalSource;
  await db.query("INSERT INTO school_import_batches(id,org_id,unit_id,actor_id,context,source_hash,plan_hash,input_rows,plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[oldId,owner.org_id,unitId,owner.id,JSON.stringify(batch.context),batch.source_hash,batch.plan_hash,JSON.stringify(batch.input_rows),JSON.stringify(legacyPlan)]);
  const history=await get(`/school/imports/${oldId}`).expect(200);assert.equal(history.body.hasSource,false);
  await get(`/school/imports/${oldId}/source`).expect(404);
});

test("spreadsheet-protected maximum-length existing fields validate after exact-identity unescaping",async()=>{
  const h=await family("="+"H".repeat(119)),address="-"+"A".repeat(499);
  await db.query("UPDATE households SET address=$1 WHERE id=$2",[address,h.id]);
  const p=await preview("households",[{householdId:h.id,version:"1",name:h.name,address,archived:"false"}]);
  assert.equal(p.plan.counts.errors,0);assert.equal(p.plan.counts.unchanged,1);
  const student=await child("="+"S".repeat(39)),person=await adult(),relationship="="+"R".repeat(79),note="-"+"N".repeat(1999);
  await db.transaction(tx=>saveContactTransaction(tx,owner,student.id,contactInput.parse({personId:person.id,relationship,isGuardian:false,canCommunicate:false,canPickup:false,restrictionNote:note})));
  const imported=await preview("contacts",[contactRow(student,person,{contactVersion:"1",relationship,restrictionNoteAction:"replace",restrictionNote:note})]);
  assert.equal(imported.plan.counts.errors,0);assert.equal(imported.plan.counts.unchanged,1);
  assert.equal(imported.plan.rows[0].after.restrictionNote,note);
});

test("restricted runtime can preview and apply household, membership and contact batches with immutable evidence",async()=>{
  const student=await child(),person=await adult();
  const original=(await db.query("SELECT session_user AS name")).rows[0].name;
  for(const statement of runtimeGrantsSql().match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g)??[]) await db.query(statement);
  try {
    await db.query("SET SESSION AUTHORIZATION stjw_runtime");await assertRuntimeAccess(db);
    const p=await preview("households",[{householdId:"",version:"0",name:"Restricted runtime household",address:"",archived:"false"}]);
    const h=(await apply(p)).receipt.records[0];
    await apply(await preview("household_members",[{householdId:h.householdId,householdVersion:"1",personId:person.id,personVersion:"1",role:"guardian",remove:"false"}]));
    await apply(await preview("contacts",[contactRow(student,person)]));
    assert.equal((await db.query("SELECT can_pickup FROM student_contacts WHERE student_id=$1 AND person_id=$2",[student.id,person.id])).rows[0].can_pickup,false);
    await assert.rejects(db.query("DELETE FROM school_history WHERE entity_id=$1",[h.householdId]),/permission denied/);
    await assert.rejects(db.query("UPDATE school_import_batches SET plan='{}' WHERE id=$1",[p.id]),/immutable|receipt/);
  } finally {await db.query('SET SESSION AUTHORIZATION "'+String(original).replaceAll('"','""')+'"');}
});
