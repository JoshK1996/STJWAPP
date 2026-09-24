import {before,after,afterEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {parse} from "csv-parse/sync";
import {connectDatabase,migrate,type Database,type Row} from "../server/db";
import type {Actor} from "../server/security";
import {initialDefinition,initialWorkforceDefinitionV2,reportDefinition,reportDefinitionV1,outputColumns,workforceV2Catalog} from "../shared/report-library";
import {snapshotDataSchema,snapshotEnvelopeSchema} from "../shared/report-snapshots";
import {saveReport,loadReportSource,shapeReportRows} from "../server/report-library";
import {prepareReportSnapshot,captureReportSnapshot,readReportSnapshot,listReportSnapshots} from "../server/report-snapshots";

let db:Database,owner:Actor,manager:Actor,unit:string,otherUnit:string,job:string,otherJob:string;
const day="2025-01-15",ownerHash="a".repeat(64),managerHash="b".repeat(64),hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const def=(precise=true,summary=false)=>reportDefinition.parse({...(precise?initialWorkforceDefinitionV2():initialDefinition("workforce")),range:{preset:"custom",from:day,to:day},...(summary?{layout:"summary",sort:{key:precise?"duration_microseconds":"duration_ms",direction:"desc"}}:{})});
async function saved(definition=def(),actor=owner,session=ownerHash){return saveReport(db,actor,session,{id:randomUUID(),version:0,name:"Synthetic exact report",description:"Independent v2 fixture",definition,archived:false,reason:"Create synthetic report for precision verification"});}
async function prepared(definition=def(),actor=owner,session=ownerHash){const report=await saved(definition,actor,session),preview=await prepareReportSnapshot(db,actor,session,report.id,{version:1});return{report,preview};}
const command=(preview:any)=>({version:1,previewId:preview.id,payloadHash:preview.payloadHash,commandId:randomUUID(),reviewed:true as const,reason:"Reviewed exact synthetic time evidence"});
async function captured(definition=def(),actor=owner,session=ownerHash){const value=await prepared(definition,actor,session),input=command(value.preview),result=await captureReportSnapshot(db,actor,session,value.report.id,input);return{...value,input,result};}
async function state(reportId:string){return(await db.query(`SELECT
 (SELECT count(*) FROM report_run_snapshots WHERE report_id=$1) AS snapshots,
 (SELECT count(*) FROM report_snapshot_commands c JOIN report_run_snapshots s ON s.id=c.snapshot_id WHERE s.report_id=$1) AS commands,
 (SELECT count(*) FROM report_run_previews WHERE report_id=$1) AS previews,
 (SELECT count(*) FROM audit_events WHERE org_id=$2 AND action='report_snapshot.captured') AS captures`,[reportId,owner.org_id])).rows[0];}
function intercepted(action:(sql:string,params:any[],tx:any)=>Promise<void>):Database{return{...db,transaction:fn=>db.transaction(tx=>fn({query:async<T extends Row>(sql:string,params:any[]=[])=>{const result=await tx.query<T>(sql,params);await action(sql,params,tx);return result;}}))};}

before(async()=>{
 db=await connectDatabase();await migrate(db);const org=randomUUID();unit=randomUUID();otherUnit=randomUUID();job=randomUUID();otherJob=randomUUID();
 owner={id:randomUUID(),org_id:org,name:"Synthetic exact owner",email:"exact.fixture@example.test",role:"owner",mode:"password",unit_ids:[unit,otherUnit]};
 manager={id:randomUUID(),org_id:org,name:"Synthetic scoped reader",email:"exact.manager@example.test",role:"manager",mode:"password",unit_ids:[unit,otherUnit]};
 await db.query("INSERT INTO organizations(id,name,timezone,demo) VALUES($1,'Synthetic v2 reports','UTC',false)",[org]);
 for(const actor of[owner,manager]){await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)",[actor.id,org,actor.name,actor.email,actor.role]);}
 for(const [id,name]of[[unit,"Synthetic A"],[otherUnit,"Synthetic B"]]){await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,'department')",[id,org,name]);for(const actor of[owner,manager])await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",[org,actor.id,id]);}
 for(const [id,unitId]of[[job,unit],[otherJob,otherUnit]])await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic exact job')",[id,org,unitId]);
 for(const [actor,proof]of[[owner,ownerHash],[manager,managerHash]] as const)await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic-test-only',clock_timestamp()+interval '1 hour')",[proof,org,actor.id]);
 const segments=[
  ["work","14:00:00.000900","14:00:00.001100"],["work","14:00:00.001100","14:00:00.001900"],
  ["break","14:00:00.001900","14:00:00.002100"],["work","14:00:00.002100","14:00:00.002900"],
 ];
 for(const [actor,jobId,rows]of[[owner,job,segments],[manager,otherJob,[["work","14:01:00.000100","14:01:00.000900"],["work","14:01:00.000900","14:01:00.000900"]]]] as const){const shift=randomUUID();await db.query("INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)",[shift,org,actor.id,`${day}T${rows[0][1]}Z`,`${day}T${rows.at(-1)![2]}Z`]);for(const [kind,start,end]of rows)await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),org,shift,jobId,kind,`${day}T${start}Z`,`${day}T${end}Z`]);}
});
afterEach(async()=>{await db.query("DELETE FROM report_run_previews");});after(async()=>{await db?.close();});

test("precision is explicit and v1 definitions and column vocabularies remain separate",()=>{
 const old=def(false),exact=def();assert.equal("precisionVersion" in old,false);assert.equal(reportDefinitionV1.safeParse(exact).success,false);
 assert.equal(reportDefinition.safeParse({...old,precisionVersion:1}).success,false);assert.equal(reportDefinition.safeParse({...old,precisionVersion:2}).success,false);
 const {precisionVersion:_version,...without}=exact as any;assert.equal(reportDefinition.safeParse(without).success,false);
 assert.deepEqual(outputColumns(def(true,true)).map(row=>row.key),["group_name","group_id","record_count","duration_microseconds","work_microseconds","break_microseconds"]);
 assert.deepEqual(outputColumns(def(false,true)).map(row=>row.key),["group_name","group_id","record_count","duration_ms","work_ms","break_ms"]);
});

test("v2 source and summaries preserve every microsecond and selected zero contributions",async()=>{
 const details=await db.transaction(tx=>loadReportSource(tx,owner,def(),new Date(`${day}T16:00:00.000Z`)));
 assert.equal(details.report.precisionVersion,2);assert.equal(details.report.durationUnit,"microsecond");assert.equal(details.report.sourceRowCount,6);assert.equal(details.report.provenance.contributingRowCount,5);
 assert.deepEqual({work:details.report.provenance.workMicroseconds,rest:details.report.provenance.breakMicroseconds},{work:"2600",rest:"200"});
 assert.match(details.report.asOf,/\.\d{6}Z$/);assert.ok(details.rows.some(row=>row.started_at.endsWith(".000900Z")));assert.ok(details.rows.some(row=>row.duration_microseconds==="0"&&row.clipped_started_at===null));
 const summary=shapeReportRows(def(true,true),details.rows);assert.deepEqual(summary.rows.map(row=>[row.duration_microseconds,row.work_microseconds,row.break_microseconds]),[["2000","1800","200"],["800","800","0"]]);
 const legacy=await db.transaction(tx=>loadReportSource(tx,owner,def(false,true),new Date(`${day}T16:00:00.000Z`)));assert.equal(legacy.report.rows.reduce((sum,row)=>sum+Number(row.duration_ms),0),2);assert.equal("precisionVersion" in legacy.report,false);
});

test("integer grouping and sorting distinguish values one microsecond apart above Number safe range",()=>{
 const definition=reportDefinition.parse({...def(true,true),groupBy:"unit"});
 const rows:Row[]=[];for(const [unitId,extra]of[[unit,0],[otherUnit,1]] as const)for(let i=0;i<300;i++)rows.push({unit_id:unitId,unit_name:"Same label",kind:"work",duration_microseconds:i===0&&extra?"31536000000001":"31536000000000"});
 const result=shapeReportRows(definition,rows);assert.deepEqual(result.rows.map(row=>[row.group_id,row.duration_microseconds]),[[otherUnit,"9460800000000001"],[unit,"9460800000000000"]]);
 assert.ok(result.rows.every(row=>row.record_count===300&&row.work_microseconds===row.duration_microseconds&&row.break_microseconds==="0"));
 assert.throws(()=>shapeReportRows(definition,[{...rows[0],duration_microseconds:31536000000000}]));
});

test("v2 retained JSON CSV and provenance use the reviewed exact payload and export identical bytes",async()=>{
 const value=await captured(),id=value.result.snapshot.id;assert.equal(value.result.snapshot.precisionVersion,2);assert.equal(value.preview.data.schemaVersion,2);
 const json=await readReportSnapshot(db,owner,ownerHash,value.report.id,id,"json"),csv=await readReportSnapshot(db,owner,ownerHash,value.report.id,id,"csv");
 assert.equal(json.snapshot.schemaVersion,2);assert.equal(json.snapshot.data.schemaVersion,2);assert.equal(hash(json.content!),json.jsonHash);assert.equal(hash(csv.content!),csv.csvHash);assert.equal(csv.content!.startsWith("\uFEFF"),false);
 const rows=parse(csv.content!,{columns:true}) as Record<string,string>[];assert.equal(rows.length,6);assert.ok(rows.every(row=>row.snapshot_schema_version==="2"&&row.workforce_precision_version==="2"&&row.duration_unit==="microsecond"));
 assert.ok(rows.some(row=>row.duration_microseconds==="200"));assert.equal(JSON.parse(rows[0].report_source_versions).workMicroseconds,"2600");
 await db.query("UPDATE users SET name='Synthetic renamed source' WHERE id=$1",[owner.id]);try{assert.equal((await readReportSnapshot(db,owner,ownerHash,value.report.id,id,"json")).content,json.content);assert.equal((await readReportSnapshot(db,owner,ownerHash,value.report.id,id,"csv")).content,csv.content);}finally{await db.query("UPDATE users SET name=$1 WHERE id=$2",[owner.name,owner.id]);}
 assert.equal((await captureReportSnapshot(db,owner,ownerHash,value.report.id,value.input)).snapshot.id,id);
});

test("empty v2 reports retain explicit precision provenance and an empty-report CSV row",async()=>{
 const value=await captured(reportDefinition.parse({...def(),range:{preset:"custom",from:"2000-01-01",to:"2000-01-01"}}));
 assert.equal(value.preview.data.schemaVersion,2);assert.equal(value.preview.data.rowCount,0);assert.equal(value.preview.data.sourceRowCount,0);assert.equal(value.preview.data.provenance.workMicroseconds,"0");
 const csv=await readReportSnapshot(db,owner,ownerHash,value.report.id,value.result.snapshot.id,"csv"),rows=parse(csv.content!,{columns:true}) as Record<string,string>[];
 assert.equal(rows.length,1);assert.equal(rows[0].snapshot_row_kind,"empty_report");assert.equal(rows[0].duration_microseconds,"");assert.equal(rows[0].duration_unit,"microsecond");assert.equal(JSON.parse(rows[0].report_source_versions).contributingRowCount,0);
});

test("open recorded evidence stays unknown while captured contributions retain exact bounded instants",async()=>{
 const shift=randomUUID(),segment=randomUUID();
 await db.query("INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,'2025-01-16T15:00:00.000001Z')",[shift,owner.org_id,owner.id]);
 await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at) VALUES($1,$2,$3,$4,'work','2025-01-16T15:00:00.000001Z')",[segment,owner.org_id,shift,job]);
 const value=await captured(reportDefinition.parse({...def(),range:{preset:"custom",from:"2025-01-16",to:"2025-01-16"},columns:workforceV2Catalog.columns.map(column=>column.key)}));
 const row=value.preview.data.rows[0];assert.equal(value.preview.data.rowCount,1);
 assert.equal(row.started_at,"2025-01-16T15:00:00.000001Z");assert.equal(row.ended_at,null);assert.equal(row.recorded_duration_microseconds,null);
 assert.equal(row.duration_microseconds,"32399999999");assert.equal(row.clipped_started_at,row.started_at);assert.equal(row.clipped_ended_at,"2025-01-17T00:00:00.000000Z");
 const csv=await readReportSnapshot(db,owner,ownerHash,value.report.id,value.result.snapshot.id,"csv"),rows=parse(csv.content!,{columns:true}) as Record<string,string>[];
 assert.equal(rows[0].recorded_duration_microseconds,"");assert.equal(rows[0].ended_at,"");assert.equal(rows[0].duration_microseconds,"32399999999");
 assert.equal((await readReportSnapshot(db,owner,ownerHash,value.report.id,value.result.snapshot.id)).snapshot.data.rows[0].recorded_duration_microseconds,null);
});

test("one edited definition lists mixed immutable versions and old retries retain original bytes",async()=>{
 const old=await captured(def(false)),oldJson=await readReportSnapshot(db,owner,ownerHash,old.report.id,old.result.snapshot.id,"json");
 await saveReport(db,owner,ownerHash,{id:old.report.id,version:1,name:old.report.name,description:old.report.description,definition:def(),archived:false,reason:"Explicitly select v2 for future report runs"});
 const preview=await prepareReportSnapshot(db,owner,ownerHash,old.report.id,{version:2}),input={...command(preview),version:2},exact=await captureReportSnapshot(db,owner,ownerHash,old.report.id,input);
 const list=await listReportSnapshots(db,owner,ownerHash,old.report.id);assert.equal(list.rows.length,2);assert.equal(list.rows.find(row=>row.id===exact.snapshot.id)!.precisionVersion,2);assert.equal(Object.hasOwn(list.rows.find(row=>row.id===old.result.snapshot.id)!,"precisionVersion"),false);
 assert.equal((await readReportSnapshot(db,owner,ownerHash,old.report.id,old.result.snapshot.id,"json")).content,oldJson.content);assert.equal((await captureReportSnapshot(db,owner,ownerHash,old.report.id,old.input)).snapshot.id,old.result.snapshot.id);
});

test("strict snapshot version units and row types reject mismatched or recast evidence",async()=>{
 const value=await captured(),read=await readReportSnapshot(db,owner,ownerHash,value.report.id,value.result.snapshot.id),data=value.preview.data;
 assert.equal(snapshotEnvelopeSchema.safeParse({...read.snapshot,schemaVersion:1}).success,false);assert.equal(snapshotDataSchema.safeParse({...data,schemaVersion:1}).success,false);
 assert.equal(snapshotDataSchema.safeParse({...data,precisionVersion:1}).success,false);assert.equal(snapshotDataSchema.safeParse({...data,durationUnit:"millisecond"}).success,false);
 assert.equal(snapshotDataSchema.safeParse({...data,provenance:{}}).success,false);
 assert.equal(snapshotDataSchema.safeParse({...data,rows:[{...data.rows[0],duration_microseconds:200},...data.rows.slice(1)]}).success,false);
 assert.equal(snapshotDataSchema.safeParse({...data,rows:[{...data.rows[0],started_at:"2025-01-15T14:00:00.000Z"},...data.rows.slice(1)]}).success,false);
 assert.equal(snapshotDataSchema.safeParse({...data,columns:[...data.columns].reverse()}).success,false);
});

test("hidden full workforce scope still governs v2 snapshots whose selected columns omit identities",async()=>{
 const definition=reportDefinition.parse({...def(),columns:["employee_name"],sort:{key:"employee_name",direction:"asc"}}),value=await captured(definition,manager,managerHash);
 const stored=(await db.query("SELECT access_manifest FROM report_run_snapshots WHERE id=$1",[value.result.snapshot.id])).rows[0].access_manifest;assert.equal(stored.source,"workforce");assert.equal(stored.records.length,6);assert.deepEqual([...new Set(stored.records.map((row:any)=>row.unitId))].sort(),[unit,otherUnit].sort());
 await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2",[manager.id,otherUnit]);try{await assert.rejects(readReportSnapshot(db,manager,managerHash,value.report.id,value.result.snapshot.id),(error:any)=>error.status===404);assert.deepEqual((await listReportSnapshots(db,manager,managerHash,value.report.id)).rows,[]);await assert.rejects(captureReportSnapshot(db,manager,managerHash,value.report.id,value.input),(error:any)=>error.status===404);}finally{await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",[owner.org_id,manager.id,otherUnit]);}
});

test("post-copy authority change prevents v2 candidate publication using the existing fresh proof",async()=>{
 const report=await saved(def(),manager,managerHash);let phases=0;const wrapped:Database={...db,transaction:async fn=>{const result=await db.transaction(fn);if(++phases===2)await db.query("UPDATE users SET role='employee' WHERE id=$1",[manager.id]);return result;}};
 try{await assert.rejects(prepareReportSnapshot(wrapped,manager,managerHash,report.id,{version:1}),(error:any)=>error.status===404);assert.equal(Number((await state(report.id)).previews),0);}finally{await db.query("UPDATE users SET role='manager' WHERE id=$1",[manager.id]);}
 // Controlled committed boundary in PGlite; this is not a PostgreSQL concurrency claim.
});

test("actual audit and final-session failures roll back every v2 snapshot receipt and preview transition",async()=>{
 for(const failure of["audit","session"]){const value=await prepared(),input=command(value.preview),before=await state(value.report.id),wrapped=intercepted(async(sql,params,tx)=>{if(sql.includes("INSERT INTO audit_events")&&params[3]==="report_snapshot.captured"){if(failure==="audit")throw Error("Synthetic exact snapshot audit failure");await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[ownerHash]);}});
  await assert.rejects(captureReportSnapshot(wrapped,owner,ownerHash,value.report.id,input),(error:any)=>failure==="audit"?error.message==="Synthetic exact snapshot audit failure":error.status===401);assert.deepEqual(await state(value.report.id),before);
  const result=await captureReportSnapshot(db,owner,ownerHash,value.report.id,input);assert.equal(result.snapshot.id,value.preview.snapshotId);assert.equal(result.snapshot.precisionVersion,2);
 }
});
