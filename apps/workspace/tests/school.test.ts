import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {DateTime} from "luxon";
import {openAttendance,saveAttendance,attendanceOverview,closeAttendanceDay,reconcileAttendance} from "../server/attendance";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createStaff } from "../server/workforce";
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  createStudent,
  saveEnrollment,
  createSection,
  saveRoster,
  peakRoster,
  officeUnits,
} from "../server/school";
import {
  studentInput,
  sectionInput,
  enrollmentInput,
  rosterInput,
} from "../shared/school";
let db: Database,
  owner: Actor,
  units: any[],
  jobs: any[],
  app: ReturnType<typeof createApp>,
  ownerAuth: any;
const origin = "http://localhost:3000",
  year = new Date().getUTCFullYear(),
  startsOn = `${year}-01-01`,
  endsOn = `${year}-12-31`;
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, {
    demo: false,
    ownerEmail: "school.owner@example.test",
  });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  units = (await db.query("SELECT * FROM units ORDER BY name")).rows;
  jobs = (await db.query("SELECT * FROM jobs")).rows;
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: "owner",
    mode: "password",
    unit_ids: units.map((row) => row.id),
  };
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
  ownerAuth = await session(owner);
});
after(async () => {
  await db?.close();
});
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
async function person(role = "employee", unit = units[0]) {
  const job = jobs.find((row) => row.unit_id === unit.id),
    email = randomUUID() + "@stjw.org";
  const id = await db.transaction((tx) =>
    createStaff(
      tx,
      owner,
      {
        name: "Synthetic School Staff",
        email,
        role: role as any,
        unitIds: [unit.id],
        jobIds: [job.id],
      },
      "stjw.org",
    ),
  );
  const actor: Actor = {
    ...owner,
    id,
    email,
    name: "Synthetic School Staff",
    role,
    unit_ids: [unit.id],
  };
  return { actor, auth: await session(actor) };
}
function post(path: string, body: any, auth = ownerAuth) {
  return request(app)
    .post("/api" + path)
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send(body);
}
function patch(path: string, body: any, auth = ownerAuth) {
  return request(app)
    .patch("/api" + path)
    .set("Origin", origin)
    .set("Cookie", auth.cookie)
    .set("X-CSRF-Token", auth.csrf)
    .send(body);
}
function get(path: string, auth = ownerAuth) {
  return request(app)
    .get("/api" + path)
    .set("Cookie", auth.cookie);
}
async function newYear(unit = units[0]) {
  const response = await post("/school/years", {
    unitId: unit.id,
    name: "Synthetic year " + randomUUID(),
    startsOn,
    endsOn,
  });
  assert.equal(response.status, 201, response.body.error);
  return response.body;
}
async function newStudent(unit = units[0], schoolYear?: any) {
  const student = await createStudent(
    db,
    owner,
    studentInput.parse({
      unitId: unit.id,
      name: "Sample Student " + randomUUID(),
      studentNumber: randomUUID(),
    }),
  );
  if (schoolYear)
    await saveEnrollment(
      db,
      owner,
      student.id,
      enrollmentInput.parse({
        yearId: schoolYear.id,
        gradeLevel: "Sample 3",
        startsOn,
        endsOn,
      }),
    );
  return student;
}

test("school office access requires explicit unit grants and revokes when membership changes", async () => {
  const { actor, auth } = await person("manager"),
    finance = await person("finance"),
    other = await person("manager", units[1]);
  assert.equal(
    (await get("/school/students?unitId=" + units[0].id, auth)).status,
    403,
  );
  assert.equal(
    (await get("/school/students?unitId=" + units[0].id, finance.auth)).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/school/office-grants",
        { unitId: units[0].id, userId: actor.id, enabled: true },
        auth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post("/school/office-grants", {
        unitId: units[0].id,
        userId: actor.id,
        enabled: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await get("/school/students?unitId=" + units[0].id, auth)).status,
    200,
  );
  assert.equal(
    (await get("/school/students?unitId=" + units[1].id, auth)).status,
    403,
  );
  assert.equal(
    (
      await post("/school/office-grants", {
        unitId: units[0].id,
        userId: other.actor.id,
        enabled: true,
      })
    ).status,
    400,
  );
  await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [
    actor.id,
    units[0].id,
  ]);
  assert.equal(
    (await get("/school/students?unitId=" + units[0].id, auth)).status,
    403,
  );
  assert.deepEqual(await officeUnits(db, { ...actor, mode: "api" }), []);
});
test("school year and term boundaries, active enrollment and stale versions are enforced", async () => {
  const schoolYear = await newYear(),
    student = await newStudent(),
    foreignYear = await newYear(units[1]);
  const yearsRead=await get('/school/years?unitId='+units[0].id);assert.equal(yearsRead.status,200);assert.equal(yearsRead.body.rows.find((row:any)=>row.id===schoolYear.id).starts_on,startsOn);
  const input = enrollmentInput.parse({
    yearId: schoolYear.id,
    gradeLevel: "Sample 4",
    startsOn,
    endsOn,
  });
  await assert.rejects(
    () =>
      saveEnrollment(db, owner, student.id, {
        ...input,
        startsOn: `${year - 1}-12-31`,
      }),
    /within the school year/,
  );
  await assert.rejects(
    () =>
      saveEnrollment(db, owner, student.id, {
        ...input,
        yearId: foreignYear.id,
      }),
    /not found/,
  );
  const enrolled = await saveEnrollment(db, owner, student.id, input);
  assert.equal(enrolled.version, 1);
  await assert.rejects(
    () =>
      saveEnrollment(db, owner, student.id, {
        ...input,
        gradeLevel: "Sample 5",
      }),
    /changed/,
  );
  const updated = await saveEnrollment(
    db,
    owner,
    student.id,
    { ...input, gradeLevel: "Sample 5" },
    1,
  );
  assert.equal(updated.version, 2);
  assert.equal(
    (
      await post("/school/terms", {
        yearId: schoolYear.id,
        name: "Outside term",
        startsOn: `${year - 1}-12-30`,
        endsOn,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/school/terms", {
        yearId: schoolYear.id,
        name: "Sample term",
        startsOn,
        endsOn: `${year}-06-30`,
      })
    ).status,
    201,
  );
  const termsRead=await get('/school/terms?unitId='+units[0].id+'&yearId='+schoolYear.id);assert.equal(termsRead.status,200);assert.equal(termsRead.body.rows[0].starts_on,startsOn);
  const studentUpdate = {
    name: "Updated Sample",
    studentNumber: student.student_number,
    dateOfBirth: null,
    active: false,
    version: 1,
  };
  assert.equal(
    (await patch("/school/students/" + student.id, studentUpdate)).status,
    409,
  );
  await saveEnrollment(
    db,
    owner,
    student.id,
    { ...input, status: "completed" },
    2,
  );
  assert.equal(
    (await patch("/school/students/" + student.id, studentUpdate)).status,
    200,
  );
  await assert.rejects(
    () => saveEnrollment(db, owner, student.id, input, 3),
    /Reactivate/,
  );
});
test("teachers see assigned rosters and approved communication contacts without office, birth or custody data", async () => {
  const schoolYear = await newYear(),
    teacher = await person(),
    unrelated = await person(),
    student = await newStudent(units[0], schoolYear),
    outsideStudent = await newStudent(units[0], schoolYear);
  const section = await createSection(
    db,
    owner,
    sectionInput.parse({
      unitId: units[0].id,
      yearId: schoolYear.id,
      name: "Synthetic homeroom " + randomUUID(),
      homeroom: true,
      capacity: 20,
      teacherIds: [teacher.actor.id],
    }),
  );
  await saveRoster(
    db,
    owner,
    section.id,
    rosterInput.parse({ studentId: student.id, startsOn, endsOn }),
  );
  const guardian = await post("/school/people", {
    unitId: units[0].id,
    name: "Synthetic Guardian",
    email: "guardian@example.test",
    phone: "555-0100",
  });
  assert.equal(guardian.status, 201);
  const permissions = {
    personId: guardian.body.id,
    relationship: "Guardian",
    isGuardian: true,
    canCommunicate: false,
    canPickup: false,
    restrictionNote: "Synthetic office-only restriction",
  };
  assert.equal(
    (await post("/school/students/" + student.id + "/contacts", permissions))
      .status,
    200,
  );
  const hidden = await get("/school/students/" + student.id, teacher.auth);
  assert.equal(hidden.status, 200, hidden.body.error);
  assert.equal(hidden.body.contacts.length, 0);
  assert.ok(!("date_of_birth" in hidden.body.student));
  assert.equal(
    (
      await post("/school/students/" + student.id + "/contacts", {
        ...permissions,
        canCommunicate: true,
        version: 1,
      })
    ).status,
    200,
  );
  const shown = await get("/school/students/" + student.id, teacher.auth);
  assert.equal(shown.body.contacts[0].email, "guardian@example.test");
  assert.ok(!("restriction_note" in shown.body.contacts[0]));
  assert.ok(!("can_pickup" in shown.body.contacts[0]));
  assert.equal(
    (await get("/school/students/" + outsideStudent.id, teacher.auth)).status,
    404,
  );
  assert.equal(
    (await get("/school/sections/" + section.id, unrelated.auth)).status,
    404,
  );
  assert.equal(
    (await get("/school/students?unitId=" + units[0].id, teacher.auth)).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/school/students",
        {
          unitId: units[0].id,
          name: "Unauthorized student",
          studentNumber: "bad",
        },
        teacher.auth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/school/sections/" + section.id + "/curriculum",
        { title: "Sample unit plan", content: "Synthetic curriculum notes" },
        teacher.auth,
      )
    ).status,
    201,
  );
  const pin = await session(teacher.actor, "pin");
  assert.equal((await get("/school/sections/" + section.id, pin)).status, 403);
  await db.query(
    "DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2",
    [section.id, teacher.actor.id],
  );
  assert.equal(
    (await get("/school/students/" + student.id, teacher.auth)).status,
    404,
  );
});
test("class capacity and single homeroom remain valid under concurrent enrollment", async () => {
  const schoolYear = await newYear(),
    one = await newStudent(units[0], schoolYear),
    two = await newStudent(units[0], schoolYear);
  const definition = sectionInput.parse({
    unitId: units[0].id,
    yearId: schoolYear.id,
    name: "Small class " + randomUUID(),
    homeroom: true,
    capacity: 1,
    teacherIds: [],
  });
  const section = await createSection(db, owner, definition);
  const results = await Promise.allSettled([
    saveRoster(db, owner, section.id, { studentId: one.id, startsOn, endsOn }),
    saveRoster(db, owner, section.id, { studentId: two.id, startsOn, endsOn }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const selected = (
    await db.query(
      "SELECT student_id FROM section_students WHERE section_id=$1",
      [section.id],
    )
  ).rows[0].student_id;
  const another = await createSection(db, owner, {
    ...definition,
    name: "Other homeroom " + randomUUID(),
  });
  await assert.rejects(
    () =>
      saveRoster(db, owner, another.id, {
        studentId: selected,
        startsOn,
        endsOn,
      }),
    /already has a homeroom/,
  );
  await assert.rejects(
    () =>
      saveRoster(db, owner, section.id, {
        studentId: selected,
        startsOn,
        endsOn,
      }),
    /Roster changed/,
  );
  const row = await saveRoster(db, owner, section.id, {
    studentId: selected,
    startsOn,
    endsOn,
    version: 1,
  });
  assert.equal(row.version, 2);
  const wrong = await newStudent(units[1]);
  await assert.rejects(
    () =>
      saveRoster(db, owner, section.id, {
        studentId: wrong.id,
        startsOn,
        endsOn,
      }),
    /unit/,
  );
  assert.equal(
    peakRoster([
      { starts_on: "2026-01-01", ends_on: "2026-03-31" },
      { starts_on: "2026-04-01", ends_on: "2026-06-30" },
    ]),
    1,
  );
  assert.equal(
    peakRoster([
      { starts_on: "2026-01-01", ends_on: "2026-04-01" },
      { starts_on: "2026-04-01", ends_on: "2026-06-30" },
    ]),
    2,
  );
});
test("household membership does not grant contact permissions and private school history is immutable", async () => {
  const household = await post("/school/households", {
    unitId: units[0].id,
    name: "Synthetic household",
    address: "Example address",
  });
  assert.equal(household.status, 201);
  const guardian = await post("/school/people", {
    unitId: units[0].id,
    name: "Synthetic contact",
  });
  assert.equal(guardian.status, 201);
  assert.equal(
    (
      await post("/school/households/" + household.body.id + "/members", {
        personId: guardian.body.id,
        role: "guardian",
      })
    ).status,
    200,
  );
  const student = await createStudent(
    db,
    owner,
    studentInput.parse({
      unitId: units[0].id,
      name: "Synthetic family student",
      studentNumber: randomUUID(),
      householdId: household.body.id,
    }),
  );
  assert.equal(
    (await get("/school/students/" + student.id)).body.contacts.length,
    0,
  );
  const foreign = await person("employee", units[1]);
  assert.equal(
    (await get("/school/households/" + household.body.id, foreign.auth)).status,
    403,
  );
  assert.equal(
    (await get("/school/history/" + student.id, foreign.auth)).body.rows.length,
    0,
  );
  const history = await get("/school/history/" + student.id);
  assert.equal(history.body.rows.length, 1);
  assert.ok(JSON.stringify(history.body).includes("Synthetic family student"));
  const auditRows = (
    await db.query("SELECT detail FROM audit_events WHERE target_id=$1", [
      student.id,
    ])
  ).rows;
  assert.ok(!JSON.stringify(auditRows).includes("Synthetic family student"));
  await assert.rejects(
    () =>
      db.query("DELETE FROM school_history WHERE entity_id=$1", [student.id]),
    /append-only/i,
  );
  const foreignStudent = await newStudent(units[1]);
  assert.equal(
    (
      await post("/school/students/" + student.id + "/contacts", {
        personId: foreignStudent.person_id,
        relationship: "Guardian",
        isGuardian: true,
        canCommunicate: true,
        canPickup: true,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post("/school/students/" + student.id + "/contacts", {
        personId: student.person_id,
        relationship: "Guardian",
        isGuardian: true,
        canCommunicate: true,
        canPickup: true,
      })
    ).status,
    404,
  );
});


const attendanceDate=DateTime.now().setZone('America/New_York').toISODate()!;
async function attendanceFixture(){
 const schoolYear=await newYear(),teacher=await person(),students=[await newStudent(units[0],schoolYear),await newStudent(units[0],schoolYear)];
 const section=await createSection(db,owner,sectionInput.parse({unitId:units[0].id,yearId:schoolYear.id,name:'Roll call '+randomUUID(),homeroom:true,capacity:20,teacherIds:[teacher.actor.id]}));
 for(const student of students)await saveRoster(db,owner,section.id,{studentId:student.id,startsOn,endsOn});
 const settings=(await get('/school/attendance/config?unitId='+units[0].id)).body.settings;
 const policy={unitId:units[0].id,weekdays:[1,2,3,4,5,6,7],periods:['Daily'],confirmed:true,version:settings.version,reason:'Explicit synthetic fixture configuration'};
 const configured=await request(app).put('/api/school/attendance/config').set('Origin',origin).set('Cookie',ownerAuth.cookie).set('X-CSRF-Token',ownerAuth.csrf).send(policy);assert.equal(configured.status,200,configured.body.error);
 const codes:any={};for(const category of ['present','absent','tardy']){const response=await post('/school/attendance/codes',{unitId:units[0].id,code:category[0]+randomUUID().slice(0,6),label:'Sample '+category,category,excused:false,reasonRequired:category==='tardy'});assert.equal(response.status,201);codes[category]=response.body;}
 const input={unitId:units[0].id,yearId:schoolYear.id,date:attendanceDate,period:'Daily'};
 return {schoolYear,teacher,students,section,codes,input,policy};
}
const put=(path:string,body:any,auth=ownerAuth)=>request(app).put('/api'+path).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send(body);
test('attendance requires confirmed configuration outside demo, configured days and authenticated classroom access',async()=>{
 const fixture=await attendanceFixture(),{section,teacher,input,policy}=fixture;
 const latest=(await get('/school/attendance/config?unitId='+input.unitId)).body.settings;
 assert.equal((await put('/school/attendance/config',{...policy,confirmed:false,version:latest.version})).status,200);
 await assert.rejects(()=>openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'}),/configuration needs review/);
 assert.equal((await put('/school/attendance/config',{...policy,version:latest.version+1},teacher.auth)).status,403);
 assert.equal((await put('/school/attendance/config',{...policy,version:latest.version+1})).status,200);
 assert.equal((await put('/school/attendance/days',{unitId:input.unitId,yearId:input.yearId,date:attendanceDate,instructional:false,label:'Synthetic closure',version:0})).status,200);
 await assert.rejects(()=>openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'}),/not an instructional day/);
 assert.equal((await put('/school/attendance/days',{unitId:input.unitId,yearId:input.yearId,date:attendanceDate,instructional:true,label:'Synthetic instructional exception',version:1})).status,200);
 const future=DateTime.fromISO(attendanceDate).plus({days:1}).toISODate()!;
 await assert.rejects(()=>openAttendance(db,teacher.actor,{sectionId:section.id,date:future,period:'Daily'}));
 const outsider=await person('employee',units[1]);await assert.rejects(()=>openAttendance(db,outsider.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'}),/not found/);
 const opened=await openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'});assert.equal(opened.marks.length,2);assert.ok(opened.marks.every(mark=>mark.code_id===null));
 const again=await openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'});assert.equal(again.session.id,opened.session.id);
 assert.equal((await get('/school/attendance/overview?'+new URLSearchParams(input),teacher.auth)).status,403);
 const days=await get('/school/attendance/days?unitId='+input.unitId+'&yearId='+input.yearId);assert.equal(days.status,200);assert.equal(days.body.rows[0].day,attendanceDate);
});
test('attendance rejects incomplete or injected rosters, requires code notes and serializes edits',async()=>{
 const {teacher,section,codes,students}=await attendanceFixture(),opened=await openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'});
 const marks=students.map(student=>({studentId:student.id,codeId:codes.present.id,note:''}));
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks:[marks[0]]}),/complete captured roster/);
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks:[marks[0],{...marks[1],codeId:null}]}),/Mark every student/);
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks:[marks[0],{...marks[1],studentId:randomUUID()}]}),/complete captured roster/);
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks:[marks[0],{...marks[1],codeId:codes.tardy.id}]}),/requires a note/);
 const foreignCode=await post('/school/attendance/codes',{unitId:units[1].id,code:randomUUID().slice(0,8),label:'Foreign code',category:'present',excused:false,reasonRequired:false});
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks:[marks[0],{...marks[1],codeId:foreignCode.body.id}]}),/active attendance code/);
 const results=await Promise.allSettled([saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:false,reason:'',marks}),saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:false,reason:'',marks})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const saved=await saveAttendance(db,teacher.actor,opened.session.id,{version:2,submit:true,reason:'',marks});assert.equal(saved.session.status,'submitted');
 await assert.rejects(()=>saveAttendance(db,teacher.actor,opened.session.id,{version:3,submit:true,reason:'Teacher edit attempt',marks}),/school office/);
 await assert.rejects(()=>saveAttendance(db,owner,opened.session.id,{version:3,submit:true,reason:'',marks}),/reason/);
 const corrected=await saveAttendance(db,owner,opened.session.id,{version:3,submit:true,reason:'Office verified late arrival',marks:[marks[0],{...marks[1],codeId:codes.tardy.id,note:'Arrived at office'}]});assert.equal(corrected.session.version,4);
 const history=await get('/school/attendance/sessions/'+opened.session.id+'/history',teacher.auth);assert.equal(history.body.rows.length,4);assert.equal(history.body.rows[0].reason,'Office verified late arrival');
 await assert.rejects(()=>db.query('DELETE FROM attendance_revisions WHERE session_id=$1',[opened.session.id]),/append-only/);
});
test('front office distinguishes missing submissions from absence and validates closeout and reopening',async()=>{
 const {teacher,section,codes,students,input}=await attendanceFixture(),opened=await openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'});
 let overview=await attendanceOverview(db,owner,input);assert.equal(overview.counts.reported,0);assert.equal(overview.counts.absent,0);assert.equal(overview.pending.length,2);
 await assert.rejects(()=>closeAttendanceDay(db,owner,{...input,fingerprint:overview.fingerprint,version:0,reason:'Synthetic office daily review',acknowledgeUnexcused:true}),/missing submissions/);
 const marks=students.map((student,index)=>({studentId:student.id,codeId:index?codes.absent.id:codes.present.id,note:index?'Office follow-up pending':''}));
 await saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks});overview=await attendanceOverview(db,owner,input);assert.equal(overview.counts.reported,2);assert.equal(overview.counts.present,1);assert.equal(overview.counts.absent,1);assert.equal(overview.pending.length,0);
 await assert.rejects(()=>closeAttendanceDay(db,owner,{...input,fingerprint:overview.fingerprint,version:0,reason:'Synthetic office daily review',acknowledgeUnexcused:false}),/unexcused/);
 const closed=await closeAttendanceDay(db,owner,{...input,fingerprint:overview.fingerprint,version:0,reason:'Synthetic office daily review completed',acknowledgeUnexcused:true});assert.ok(closed.closed_at);assert.equal((await attendanceOverview(db,owner,input)).closureValid,true);
 await assert.rejects(()=>saveAttendance(db,owner,opened.session.id,{version:2,submit:true,reason:'Office correction after close',marks}),/day is closed/);
 assert.equal((await post('/school/attendance/closeouts/'+closed.id+'/reopen',{version:closed.version,reason:'Office correcting a recorded status'},teacher.auth)).status,403);
 assert.equal((await post('/school/attendance/closeouts/'+closed.id+'/reopen',{version:closed.version,reason:'Office correcting a recorded status'})).status,200);
 assert.equal((await post('/school/attendance/closeouts/'+closed.id+'/reopen',{version:closed.version,reason:'Replay of old reopening action'})).status,409);
 await saveAttendance(db,owner,opened.session.id,{version:2,submit:true,reason:'Office verified the absence was reported',marks});
 const exported=await get('/school/attendance/export?'+new URLSearchParams(input));assert.equal(exported.status,200);assert.match(exported.text,/"student_id","student","code","category"/);assert.match(exported.text,/"session_id","session_version","submitted_at","roster_current","day_closeout_valid"/);
 assert.equal((await get('/school/attendance/export?'+new URLSearchParams(input),teacher.auth)).status,403);
});
test('roster changes invalidate submission and closeout fingerprints, while historical code and student snapshots persist',async()=>{
 const {teacher,section,codes,students,input,schoolYear}=await attendanceFixture(),opened=await openAttendance(db,teacher.actor,{sectionId:section.id,date:attendanceDate,period:'Daily'});
 const marks=students.map(student=>({studentId:student.id,codeId:codes.present.id,note:''}));await saveAttendance(db,teacher.actor,opened.session.id,{version:1,submit:true,reason:'',marks});
 const previous=await attendanceOverview(db,owner,input),added=await newStudent(units[0],schoolYear);let current=await attendanceOverview(db,owner,input);assert.equal(current.unassigned.length,1);assert.notEqual(current.fingerprint,previous.fingerprint);
 await assert.rejects(()=>closeAttendanceDay(db,owner,{...input,fingerprint:previous.fingerprint,version:0,reason:'Stale snapshot closeout attempt',acknowledgeUnexcused:true}),/changed/);
 await saveRoster(db,owner,section.id,{studentId:added.id,startsOn,endsOn});current=await attendanceOverview(db,owner,input);assert.equal(current.rows[0].status,'roster_changed');assert.equal(current.counts.reported,0);
 await assert.rejects(()=>saveAttendance(db,owner,opened.session.id,{version:2,submit:true,reason:'Office review before correction',marks}),/roster changed/);
 const reconciled=await reconcileAttendance(db,owner,opened.session.id,2,'Added the newly enrolled student');assert.equal(reconciled.session.status,'draft');assert.equal(reconciled.marks.filter(mark=>mark.expected).length,3);assert.equal(reconciled.marks.filter(mark=>mark.code_id===codes.present.id).length,2);
 const inputCode={unitId:input.unitId,code:codes.present.code,label:'Changed label for future records',category:'other',excused:false,reasonRequired:false,active:true,version:codes.present.version};assert.equal((await patch('/school/attendance/codes/'+codes.present.id,inputCode)).status,200);
 const nextMarks=reconciled.marks.filter(mark=>mark.expected).map(mark=>({studentId:mark.student_id,codeId:codes.present.id,note:''}));await saveAttendance(db,teacher.actor,opened.session.id,{version:3,submit:true,reason:'',marks:nextMarks});current=await attendanceOverview(db,owner,input);assert.equal(current.counts.present,2);assert.equal(current.counts.other,1);
 // Inactive directory flags must not erase attendance for dates covered by historical enrollment.
 await saveEnrollment(db,owner,students[0].id,enrollmentInput.parse({yearId:schoolYear.id,gradeLevel:'Sample 3',startsOn,endsOn,status:'completed'}),1);
 const inactive=await patch('/school/students/'+students[0].id,{name:'Historical sample student',studentNumber:students[0].student_number,dateOfBirth:null,active:false,version:1});assert.equal(inactive.status,200);
 current=await attendanceOverview(db,owner,input);assert.equal(current.counts.reported,3);assert.equal(current.counts.enrolled,3);
 const readback=await get('/school/attendance/sessions/'+opened.session.id,teacher.auth);assert.equal(readback.body.rosterChanged,false);assert.ok(readback.body.marks.some((mark:any)=>mark.student_id===students[0].id&&mark.student_name!=='Historical sample student'));
});
