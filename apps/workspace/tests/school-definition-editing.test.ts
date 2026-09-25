import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {issueSetup,digest,type Actor} from '../server/security';
import {createStaff} from '../server/workforce';
import {updateSchoolCourse,updateSchoolYear} from '../server/school-definitions';

let db:Database,app:ReturnType<typeof createApp>,owner:Actor,unitId:string,otherUnitId:string,auth:Auth;
type Auth={cookie:string;csrf:string;hash:string};
const origin='http://localhost:3000',reason='Synthetic administrative definition correction';
async function signIn(actor:Actor):Promise<Auth>{
  const token=await db.transaction(tx=>issueSetup(tx,actor)),password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});
  assert.equal(login.status,200,JSON.stringify(login.body));
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const me=await request(app).get('/api/me').set('Cookie',cookie);assert.equal(me.status,200);
  const csrf=me.body.actor.csrf;
  return {cookie,csrf,hash:digest(cookie.slice(cookie.indexOf('=')+1))};
}
function send(path:string,body:unknown,a=auth,method='post'){
  return (request(app) as any)[method]('/api'+path).set('Origin',origin).set('Cookie',a.cookie).set('X-CSRF-Token',a.csrf).send(body);
}
async function ok(path:string,body:unknown,a=auth,method='post'){
  const result=await send(path,body,a,method);assert.ok(result.status<300,JSON.stringify(result.body));return result.body;
}
const suffix=()=>randomUUID().slice(0,8);
async function year(unit=unitId){return ok('/school/years',{unitId:unit,name:'Synthetic year '+suffix(),startsOn:'2026-01-01',endsOn:'2026-12-31'});}
async function course(unit=unitId){return ok('/school/courses',{unitId:unit,code:'S-'+suffix(),title:'Synthetic course',description:'Original description'});}
const yearEdit=(row:any,overrides={})=>({name:row.name,startsOn:'2026-01-01',endsOn:'2026-12-31',archived:false,version:row.version,reason,...overrides});
const courseEdit=(row:any,overrides={})=>({code:row.code,title:row.title,description:row.description,archived:false,version:row.version,reason,...overrides});
async function section(y:any,c?:any){return ok('/school/sections',{unitId,yearId:y.id,...(c?{courseId:c.id}:{}),name:'Synthetic class '+suffix(),teacherIds:[],capacity:25,homeroom:false});}
async function revision(){return Number((await db.query('SELECT version FROM timetable_revisions WHERE org_id=$1',[owner.org_id])).rows[0]?.version??0);}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'school-editing@example.test'});
  const row=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  [unitId,otherUnitId]=(await db.query('SELECT id FROM units ORDER BY name')).rows.map(r=>r.id);
  owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:row.role,unit_ids:[],mode:'password'};
  app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:false});auth=await signIn(owner);
  await ok('/school/attendance/config',{unitId,weekdays:[1,2,3,4,5],periods:['Daily'],confirmed:true,version:0,reason},auth,'put');
});
after(async()=>{await db?.close();});

test('year, term and course editors use revisions and record readable before/after audit evidence',async()=>{
  const y=await year(),term=await ok('/school/terms',{yearId:y.id,name:'Original term',startsOn:'2026-02-01',endsOn:'2026-05-30'}),c=await course();
  const previous=await revision();
  const changed=await ok('/school/years/'+y.id,yearEdit(y,{name:'Corrected '+suffix()}),auth,'patch');
  assert.equal(changed.version,2);assert.ok(await revision()>previous);
  assert.equal((await send('/school/years/'+y.id,yearEdit(y),auth,'patch')).status,409);
  const changedTerm=await ok('/school/terms/'+term.id,{name:'Corrected term',startsOn:'2026-02-02',endsOn:'2026-05-29',version:term.version,reason},auth,'patch');
  assert.equal(changedTerm.version,2);assert.equal(changedTerm.starts_on,'2026-02-02');
  const changedCourse=await ok('/school/courses/'+c.id,courseEdit(c,{code:'EDIT-'+suffix(),title:'Corrected title',description:'Clear revised description'}),auth,'patch');
  assert.equal(changedCourse.version,2);assert.equal(changedCourse.description,'Clear revised description');
  const histories=(await db.query('SELECT entity_type AS action,snapshot FROM school_history WHERE entity_id=ANY($1::uuid[]) ORDER BY created_at',[ [y.id,term.id,c.id] ])).rows.filter(r=>r.action.endsWith('.updated'));
  assert.equal(histories.length,3);assert.ok(histories.every(r=>r.snapshot.after.change_reason===reason));
  assert.equal(histories.find(r=>r.action==='course.updated')!.snapshot.before.title,'Synthetic course');
  assert.equal((await db.query("SELECT id FROM audit_events WHERE target_id=ANY($1::text[]) AND action LIKE 'school.%.updated'",[[y.id,term.id,c.id]])).rows.length,3);
});

test('year dates preserve child boundaries and prohibit shrinking a year already used for classes',async()=>{
  const y=await year();await ok('/school/terms',{yearId:y.id,name:'Spring',startsOn:'2026-01-01',endsOn:'2026-05-31'});
  assert.equal((await send('/school/years/'+y.id,yearEdit(y,{startsOn:'2026-02-01'}),auth,'patch')).status,409);
  const changed=await ok('/school/years/'+y.id,yearEdit(y,{startsOn:'2025-12-01',endsOn:'2027-01-31'}),auth,'patch');
  await section(changed);
  const denied=await send('/school/years/'+y.id,yearEdit(changed,{startsOn:'2025-12-02',endsOn:'2027-01-31'}),auth,'patch');
  assert.equal(denied.status,409);assert.match(denied.body.error,/cannot shrink/);
  assert.equal((await db.query("SELECT to_char(starts_on,'YYYY-MM-DD') AS start FROM school_years WHERE id=$1",[y.id])).rows[0].start,'2025-12-01');
});

test('course archive and restore preserve existing classes while controlling new selection',async()=>{
  const y=await year(),c=await course(),s=await section(y,c);
  const archived=await ok('/school/courses/'+c.id,courseEdit(c,{archived:true}),auth,'patch');
  assert.equal((await db.query('SELECT course_id FROM sections WHERE id=$1',[s.id])).rows[0].course_id,c.id);
  assert.equal((await send('/school/sections',{unitId,yearId:y.id,courseId:c.id,name:'Blocked class',homeroom:false,capacity:25,teacherIds:[]})).status,404);
  const restored=await ok('/school/courses/'+c.id,courseEdit(archived),auth,'patch');
  assert.equal(restored.archived,false);assert.ok((await section(y,c)).id);
});

test('term dates freeze after a gradebook, names remain editable until term lock, and releases stay unchanged',async()=>{
  const y=await year(),s=await section(y),t=await ok('/school/terms',{yearId:y.id,name:'Original spring',startsOn:'2026-02-01',endsOn:'2026-05-30'}),book=randomUUID();
  // Synthetic captured evidence fixture: normal HTTP below must not rewrite it.
  await db.query("INSERT INTO gradebooks(id,org_id,unit_id,section_id,term_id,policy,policy_version,roster,roster_fingerprint,created_by) VALUES($1,$2,$3,$4,$5,'{}',1,'[]','synthetic-captured-roster',$6)",[book,owner.org_id,unitId,s.id,t.id,owner.id]);
  const snapshot={term:'Original spring',results:[]};
  await db.query('INSERT INTO gradebook_releases(id,org_id,unit_id,book_id,book_version,snapshot,created_by) VALUES($1,$2,$3,$4,1,$5,$6)',[randomUUID(),owner.org_id,unitId,book,JSON.stringify(snapshot),owner.id]);
  const edit={name:'Renamed spring',startsOn:'2026-02-01',endsOn:'2026-05-30',version:t.version,reason};
  assert.equal((await send('/school/terms/'+t.id,{...edit,endsOn:'2026-05-31'},auth,'patch')).status,409);
  const renamed=await ok('/school/terms/'+t.id,edit,auth,'patch');assert.equal(renamed.name,'Renamed spring');
  assert.deepEqual((await db.query('SELECT snapshot FROM gradebook_releases WHERE book_id=$1',[book])).rows[0].snapshot,snapshot);
  await db.query('UPDATE school_terms SET locked_at=now() WHERE id=$1',[t.id]);
  assert.equal((await send('/school/terms/'+t.id,{...edit,version:renamed.version},auth,'patch')).status,409);
});

test('room rename/status preserves meeting reservations and blocks new assignments to inactive rooms',async()=>{
  const y=await year(),s=await section(y),other=await section(y),room=await ok('/school/timetable/rooms',{unitId,name:'Original room '+suffix()});
  const meeting={version:0,sectionId:s.id,roomId:room.id,startsOn:'2026-09-21',endsOn:'2026-09-21',weekdays:[1],startsAt:'09:00',endsAt:'10:00',reason};
  const preview=await ok('/school/timetable/preview',meeting);assert.deepEqual(preview.issues,[]);
  const saved=await ok('/school/timetable/save',{meeting,revision:preview.revision,reviewed:true,commandId:randomUUID()});
  const before=await revision();
  const inactive=await ok('/school/timetable/rooms/'+room.id,{name:'Renamed room '+suffix(),active:false,version:room.version,reason},auth,'patch');
  assert.equal(inactive.active,false);assert.equal(inactive.version,2);assert.ok(await revision()>before);
  assert.equal((await send('/school/timetable/rooms/'+room.id,{name:'Stale rename',active:true,version:room.version,reason},auth,'patch')).status,409);
  assert.equal((await send('/school/timetable/preview',{...meeting,sectionId:other.id})).status,400);
  const old=(await db.query('SELECT id,version,room_id FROM timetable_meetings WHERE id=$1',[saved.id])).rows[0];
  assert.equal(old.room_id,room.id);
  assert.deepEqual((await ok('/school/timetable/preview',{...meeting,id:old.id,version:old.version})).issues,[]);
  await ok('/school/timetable/rooms/'+room.id,{name:inactive.name,active:true,version:inactive.version,reason},auth,'patch');
  const conflict=await ok('/school/timetable/preview',{...meeting,sectionId:other.id});
  assert.ok(conflict.issues.some((issue:any)=>String(issue.kind??issue.type??issue.code).includes('room')) || conflict.issues.length>0);
});

test('school-office edits require current explicit unit membership plus office grant, never a stale supplied role',async()=>{
  const id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic office editor',email:suffix()+'@stjw.org',role:'employee',unitIds:[unitId],jobIds:[]},'stjw.org'));
  const row=(await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
  const actor:Actor={id,org_id:owner.org_id,name:row.name,email:row.email,role:'employee',unit_ids:[unitId],mode:'password'},a=await signIn(actor),c=await course(),other=await course(otherUnitId);
  assert.equal((await send('/school/courses/'+c.id,courseEdit(c),a,'patch')).status,403);
  await ok('/school/office-grants',{unitId,userId:id,enabled:true});
  const edited=await ok('/school/courses/'+c.id,courseEdit(c,{title:'Office correction'}),a,'patch');
  assert.equal((await send('/school/courses/'+other.id,courseEdit(other),a,'patch')).status,403);
  await ok('/school/office-grants',{unitId,userId:id,enabled:false});
  await assert.rejects(updateSchoolCourse(db,{...actor,role:'owner'},a.hash,c.id,courseEdit(edited)),{status:403});
  await ok('/school/office-grants',{unitId,userId:id,enabled:true});
  await db.query('DELETE FROM user_units WHERE org_id=$1 AND user_id=$2 AND unit_id=$3',[owner.org_id,id,unitId]);
  await assert.rejects(updateSchoolCourse(db,actor,a.hash,c.id,courseEdit(edited)),{status:403});
  await assert.rejects(updateSchoolCourse(db,owner,undefined,c.id,courseEdit(edited)),{status:401});
  await assert.rejects(updateSchoolCourse(db,{...owner,mode:'pin'},auth.hash,c.id,courseEdit(edited)),{status:403});
  await assert.rejects(updateSchoolCourse(db,{...owner,org_id:randomUUID()},auth.hash,c.id,courseEdit(edited)),{status:404});
});

test('concurrent expected-version edits accept one command and preserve exactly one new history revision',async()=>{
  const c=await course();
  const results=await Promise.allSettled([updateSchoolCourse(db,owner,auth.hash,c.id,courseEdit(c,{title:'First edit'})),updateSchoolCourse(db,owner,auth.hash,c.id,courseEdit(c,{title:'Second edit'}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  assert.equal((await db.query('SELECT version FROM courses WHERE id=$1',[c.id])).rows[0].version,2);
  assert.equal((await db.query("SELECT id FROM school_history WHERE entity_id=$1 AND entity_type='course.updated'",[c.id])).rows.length,1);
});

test('academic mutex precedes definition locks and audit failure rolls back definition/history/revision together',async()=>{
  const y=await year(),before=await revision(),statements:string[]=[];
  const tracked:Database={...db,transaction:work=>db.transaction(tx=>work({query:((sql:string,params?:any[])=>{
    statements.push(sql+' '+JSON.stringify(params));if(sql.includes('INSERT INTO audit_events'))throw Error('Synthetic audit failure');return tx.query(sql,params);
  }) as Queryable['query']}))};
  await assert.rejects(updateSchoolYear(tracked,owner,auth.hash,y.id,yearEdit(y,{name:'Must roll back'})),/Synthetic audit failure/);
  const lock=statements.findIndex(s=>s.includes('academic-timetable:')),row=statements.findIndex(s=>s.includes('FROM school_years')&&s.includes('FOR UPDATE'));
  assert.ok(lock>=0&&row>lock);
  assert.equal((await db.query('SELECT name,version FROM school_years WHERE id=$1',[y.id])).rows[0].name,y.name);
  assert.equal(await revision(),before);
  assert.equal((await db.query("SELECT id FROM school_history WHERE entity_id=$1 AND entity_type='year.updated'",[y.id])).rows.length,0);
});
