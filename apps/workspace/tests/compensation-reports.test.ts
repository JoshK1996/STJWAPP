import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import request from "supertest";
import {parse} from "csv-parse/sync";
import {connectDatabase,migrate,type Database} from "../server/db";
import {initialize} from "../server/seed";
import {createApp} from "../server/app";
import {digest,opaqueToken,type Actor} from "../server/security";
import {previewCompensation,saveCompensation} from "../server/compensation";
import {initialDefinition,type ReportDefinition} from "../shared/report-library";
import {runReport,saveReport} from "../server/report-library";
let db:Database,app:ReturnType<typeof createApp>,owner:Actor,unitId:string,childId:string;
const origin="http://localhost:3000";
let subjects:any[]=[],savedRates:any[]=[];
async function person(role="employee",unit=unitId){
 const id=randomUUID(),jobId=randomUUID();
 await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)",[id,owner.org_id,"=Synthetic same name",id+"@stjw.org",role]);
 await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",[owner.org_id,id,unit]);
 await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic pay reporting job')",[jobId,owner.org_id,unit]);
 await db.query("INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)",[owner.org_id,id,jobId]);
 return {...owner,id,role,name:"=Synthetic same name",email:id+"@stjw.org",unit_ids:[unit],jobId};
}
function rate(changes:any={}){return {id:randomUUID(),startsOn:"2026-01-01",endsOn:null,amount:"18.125",currency:"USD",basis:"hour",voided:false,note:"Synthetic reporting entry",...changes};}
async function saveRates(subject:any,rates:any[],version=0){const auth=await session(owner);const input={userId:subject.id,jobId:subject.jobId,expectedVersion:version,rates,reason:"Synthetic pay reporting verification"},preview=await previewCompensation(db,owner,input,auth.hash);return saveCompensation(db,owner,{...input,previewHash:preview.previewHash,reviewed:true,commandId:randomUUID()},auth.hash);}
function definition(changes:any={}):ReportDefinition{return {...initialDefinition("compensation"),range:{preset:"custom",from:"2026-01-31",to:"2026-01-31"},...changes} as ReportDefinition;}
async function session(actor=owner){const token=opaqueToken(),csrf=opaqueToken();await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password',$4,now()+interval '1 hour')",[digest(token),actor.org_id,actor.id,csrf]);return {cookie:"stjw_session="+token,csrf,hash:digest(token)};}
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:"pay.reports.owner@example.test"});
 const u=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];owner={id:u.id,org_id:u.org_id,name:u.name,email:u.email,role:u.role,mode:"password",unit_ids:[]};
 unitId=(await db.query("SELECT id FROM units ORDER BY id LIMIT 1")).rows[0].id;
 childId=randomUUID();await db.query("INSERT INTO units(id,org_id,name,kind,parent_id) VALUES($1,$2,'Synthetic reporting subgroup','school',$3)",[childId,owner.org_id,unitId]);
 app=createApp(db,{origin,production:false,demo:true,staffDomain:"stjw.org"});
 subjects=[await person(),await person(),await person("employee",childId)];
 savedRates=[
  [rate({endsOn:"2026-01-31",amount:"999999999999.9998"}),rate({startsOn:"2026-02-01",amount:"20"}),rate({amount:"99",basis:"month",voided:true})],
  [rate({startsOn:"2026-01-31",amount:"999999999999.9999",currency:"EUR",basis:"year"})],
  [rate({amount:"0"})],
 ];
 for(let i=0;i<subjects.length;i++)await saveRates(subjects[i],savedRates[i]);
});
after(async()=>{await db?.close();});
test("pay report matches inclusive effective dates, preserves current record identity and respects exact unit filters",async()=>{
 const report=await runReport(db,owner,definition());assert.equal(report.rowCount,3);assert.equal(report.provenance.recordCount,3);
 assert.match(report.provenance.sourceHash,/^[a-f0-9]{64}$/);assert.equal(report.rows.filter(x=>x.ends_on==="2026-01-31").length,1);assert.ok(report.rows.every(x=>x.record_version===1&&!x.voided&&x.record_id&&x.rate_id));
 assert.equal((await runReport(db,owner,definition({unitId}))).rowCount,2);
 assert.equal((await runReport(db,owner,definition({unitId:childId}))).rowCount,1);
 assert.equal((await runReport(db,owner,definition({includeVoided:true}))).rowCount,4);
 assert.equal((await runReport(db,owner,definition({range:{preset:"custom",from:"2026-02-01",to:"2026-02-01"}}))).rows.find(x=>x.record_id===report.rows.find(x=>x.ends_on==="2026-01-31")?.record_id)?.amount,"20");
 await assert.rejects(runReport(db,owner,definition({unitId:randomUUID()})),/Community not found/);
});
test("pay summaries count entries without adding rates, currencies, durations or identical names together",async()=>{
 const base={layout:"summary",sort:{key:"group_name",direction:"asc"}};
 const byEmployee=await runReport(db,owner,definition({...base,groupBy:"employee"}));assert.equal(byEmployee.rows.length,3);assert.ok(byEmployee.rows.every(x=>x.record_count===1));assert.ok(byEmployee.rows.every(x=>!("amount"in x)&&!("duration_ms"in x)));
 const byCurrency=await runReport(db,owner,definition({...base,groupBy:"currency"}));assert.deepEqual(Object.fromEntries(byCurrency.rows.map(x=>[x.group_name,x.record_count])),{EUR:1,USD:2});
 const sorted=await runReport(db,owner,definition({sort:{key:"amount",direction:"desc"}}));assert.deepEqual(sorted.rows.map(x=>x.amount),["999999999999.9999","999999999999.9998","0"]);
});
test("pay-report access follows the active database role, never a stale actor, PIN, agent or foreign organization",async()=>{
 for(const role of ["owner","admin","finance"]){const actor=role==="owner"?owner:await person(role);assert.equal((await runReport(db,actor,definition())).rowCount,3);}
 for(const role of ["manager","employee"]){const actor=await person(role);await assert.rejects(runReport(db,actor,definition()),/finance access is required/);}
 for(const mode of ["pin","token"])await assert.rejects(runReport(db,{...owner,mode} as Actor,definition()),/password/);
 const stale=await person("finance");await db.query("UPDATE users SET role='employee' WHERE id=$1",[stale.id]);await assert.rejects(runReport(db,stale,definition()),/finance access is required/);
 await assert.rejects(runReport(db,{...owner,org_id:randomUUID()},definition()),(e:any)=>e.status===403);
 await db.query("UPDATE users SET active=false WHERE id=$1",[stale.id]);await assert.rejects(runReport(db,{...stale,role:"owner"},definition()),(e:any)=>e.status===403);
});
test("personal pay layouts export exact formula-safe source identities and deny downloads after role revocation",async()=>{
 const finance=await person("finance"),auth=await session(finance),layout=await saveReport(db,finance,auth.hash,{id:randomUUID(),version:0,name:"Synthetic consolidated pay rates",description:"Current reviewed rates",definition:definition(),archived:false,reason:"Synthetic pay report layout"});
 const csv=await request(app).get(`/api/report-library/${layout.id}/export?version=1&format=csv`).set("Cookie",auth.cookie);assert.equal(csv.status,200);const rows=parse(csv.text,{columns:true,bom:true});assert.equal(rows.length,3);assert.ok(rows.every((r:any)=>r.employee_name==="'=Synthetic same name"&&r.record_version==="1"));assert.ok(rows.some((r:any)=>r.amount==="999999999999.9999"));
 const ownerAuth=await session();assert.equal((await request(app).get(`/api/report-library/${layout.id}/run?version=1`).set("Cookie",ownerAuth.cookie)).status,404);
 await db.query("UPDATE users SET role='employee' WHERE id=$1",[finance.id]);assert.equal((await request(app).get(`/api/report-library/${layout.id}/export?version=1&format=json`).set("Cookie",auth.cookie)).status,403);
 await assert.rejects(saveReport(db,finance,auth.hash,{version:1,id:layout.id,name:layout.name,description:layout.description,definition:layout.definition,archived:false,reason:"Stale finance edit"}),/finance access/);
 const audit=(await db.query("SELECT detail FROM audit_events WHERE action='report_library.exported' AND target_id=$1",[layout.id])).rows;
 assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes("999999999999"));
});
test("unassigned inactive staff and jobs retain rate evidence; reruns use the newly reviewed version without changing earlier history",async()=>{
 const subject=subjects[0],before=await runReport(db,owner,definition()),beforeRow=before.rows.find(x=>x.rate_id===savedRates[0][0].id)!;
 const next=savedRates[0].map((r:any,i:number)=>i===0?{...r,amount:"19.25"}:r);await saveRates(subject,next,1);
 await db.query("DELETE FROM user_jobs WHERE user_id=$1",[subject.id]);await db.query("UPDATE users SET active=false WHERE id=$1",[subject.id]);await db.query("UPDATE jobs SET active=false WHERE id=$1",[subject.jobId]);
 const result=await runReport(db,owner,definition({columns:["rate_id","amount","record_version","employee_active","job_active","assigned"],sort:{key:"amount",direction:"asc"}}));
 const row=result.rows.find(x=>x.rate_id===savedRates[0][0].id)!;assert.equal(row.amount,"19.25");assert.equal(row.record_version,2);assert.equal(row.employee_active,false);assert.equal(row.job_active,false);assert.equal(row.assigned,false);assert.notEqual(result.provenance.sourceHash,before.provenance.sourceHash);
 const old=(await db.query("SELECT snapshot FROM compensation_history WHERE schedule_id=$1 AND version=1",[beforeRow.record_id])).rows[0];assert.equal(old.snapshot.rates.find((r:any)=>r.id===savedRates[0][0].id).amount,"999999999999.9998");
});

test("pay source rejects over 5,000 matching entries rather than exporting a truncated audit report",async()=>{
 const unit=randomUUID();await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,'Synthetic report limit','administration')",[unit,owner.org_id]);
 for(let i=0;i<26;i++){const subject=await person("employee",unit);await saveRates(subject,Array.from({length:200},()=>rate({voided:true,note:"Synthetic report limit"})));}
 await assert.rejects(runReport(db,owner,definition({unitId:unit,includeVoided:true})),/More than 5,000 rate entries/);
 assert.equal((await runReport(db,owner,definition({unitId:unit,includeVoided:false}))).rowCount,0);
});
