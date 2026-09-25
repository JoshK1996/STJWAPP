import {z} from 'zod';
import type {Database,Queryable,Row} from './db';
import {requireCondition,Problem,type Actor} from './security';
import {currentReportActor,recheckReportSession} from './report-source-access';
import {schoolAdmin,schoolChange} from './school';
import {lockAcademics,validateAcademicChange} from './timetable-engine';
import {schoolYearUpdateInput,termUpdateInput,courseUpdateInput} from '../shared/school';
const dateColumns="to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on";
/** Current account/session/membership and office grant precede the academic mutex and definition row locks. */
export async function schoolDefinitionTransaction<T>(db:Database,supplied:Actor,sessionHash:string|undefined,unitId:string,work:(tx:Queryable,actor:Actor)=>Promise<T>):Promise<T>{
  requireCondition(typeof sessionHash==='string'&&/^[a-f0-9]{64}$/.test(sessionHash),401,'A verified password session is required.');
  try{return await db.transaction(async tx=>{
    const actor=await currentReportActor(tx,supplied,sessionHash);requireCondition(actor.mode==='password',403,'School settings require password sign-in.');
    requireCondition((await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=$2',[actor.org_id,unitId])).rows.length,404,'School unit not found.');
    if(!schoolAdmin(actor))requireCondition(actor.unit_ids.includes(unitId)&&(await tx.query('SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND unit_id=$2 AND user_id=$3 FOR SHARE',[actor.org_id,unitId,actor.id])).rows.length,403,'School office access to this unit is required.');
    await lockAcademics(tx,actor.org_id);const result=await work(tx,actor);JSON.stringify(result);await recheckReportSession(tx,actor,sessionHash);return result;
  });}catch(error){if(['55P03','57014','40001','40P01'].includes((error as {code?:string}).code??''))throw new Problem(503,'School settings are busy. Refresh before retrying.');throw error;}
}
async function identity(db:Queryable,actor:Actor,table:string,id:string){
  const row=(await db.query(`SELECT unit_id FROM ${table} WHERE org_id=$1 AND id=$2`,[actor.org_id,z.uuid().parse(id)])).rows[0];
  requireCondition(row,404,'School definition not found.');return row.unit_id as string;
}
async function assertVersion(row:Row|undefined,version:number){requireCondition(row,404,'School definition not found.');requireCondition(row.version===version,409,'This definition changed. Close the editor, refresh, and try again.');}
export async function updateSchoolYear(db:Database,supplied:Actor,sessionHash:string|undefined,id:string,raw:unknown){
  const input=schoolYearUpdateInput.parse(raw),unitId=await identity(db,supplied,'school_years',id);
  return schoolDefinitionTransaction(db,supplied,sessionHash,unitId,async(tx,actor)=>{
    const before=(await tx.query(`SELECT *,${dateColumns} FROM school_years WHERE org_id=$1 AND id=$2 FOR UPDATE`,[actor.org_id,id])).rows[0];await assertVersion(before,input.version);
    requireCondition(!(await tx.query('SELECT id FROM school_years WHERE org_id=$1 AND unit_id=$2 AND name=$3 AND id<>$4',[actor.org_id,unitId,input.name,id])).rows.length,409,'A school year with that name already exists.');
    if(input.startsOn!==before.starts_on||input.endsOn!==before.ends_on){
      if(input.startsOn>before.starts_on||input.endsOn<before.ends_on)requireCondition(!(await tx.query('SELECT id FROM sections WHERE org_id=$1 AND year_id=$2 UNION ALL SELECT id FROM student_enrollments WHERE org_id=$1 AND year_id=$2 LIMIT 1',[actor.org_id,id])).rows.length,409,'This year has classes or enrollment. Its boundaries can expand, but cannot shrink around existing school records. Create a separate year for a different period.');
      const outside=(await tx.query(`SELECT 1 FROM (
        SELECT starts_on,ends_on FROM school_terms WHERE org_id=$1 AND year_id=$2
        UNION ALL SELECT starts_on,ends_on FROM student_enrollments WHERE org_id=$1 AND year_id=$2
        UNION ALL SELECT r.starts_on,r.ends_on FROM section_students r JOIN sections s ON s.id=r.section_id WHERE r.org_id=$1 AND s.year_id=$2
        UNION ALL SELECT m.starts_on,m.ends_on FROM timetable_meetings m JOIN sections s ON s.id=m.section_id WHERE m.org_id=$1 AND s.year_id=$2
        UNION ALL SELECT day,day FROM school_day_overrides WHERE org_id=$1 AND year_id=$2
        UNION ALL SELECT day,day FROM attendance_sessions WHERE org_id=$1 AND year_id=$2
        UNION ALL SELECT day,day FROM attendance_closeouts WHERE org_id=$1 AND year_id=$2
        UNION ALL SELECT day,day FROM dismissal_runs WHERE org_id=$1 AND year_id=$2
      ) dates WHERE starts_on<$3::date OR ends_on>$4::date LIMIT 1`,[actor.org_id,id,input.startsOn,input.endsOn])).rows.length;
      requireCondition(!outside,409,'Keep all existing terms, enrollment, class places, meetings, school days, attendance and dismissal dates within the year. Their history will not be rewritten.');
    }
    const after=(await tx.query(`UPDATE school_years SET name=$3,starts_on=$4,ends_on=$5,archived=$6,version=version+1 WHERE org_id=$1 AND id=$2 RETURNING *,${dateColumns}`,[actor.org_id,id,input.name,input.startsOn,input.endsOn,input.archived])).rows[0];
    await validateAcademicChange(tx,actor.org_id);await schoolChange(tx,actor,unitId,'year.updated',id,before,{...after,change_reason:input.reason});return after;
  });
}
export async function updateSchoolTerm(db:Database,supplied:Actor,sessionHash:string|undefined,id:string,raw:unknown){
  const input=termUpdateInput.parse(raw),unitId=await identity(db,supplied,'school_terms',id);
  return schoolDefinitionTransaction(db,supplied,sessionHash,unitId,async(tx,actor)=>{
    const before=(await tx.query(`SELECT *,${dateColumns} FROM school_terms WHERE org_id=$1 AND id=$2 FOR UPDATE`,[actor.org_id,id])).rows[0];await assertVersion(before,input.version);
    requireCondition(!before.locked_at,409,'This term is locked. Its reviewed definition is retained.');
    const year=(await tx.query(`SELECT *,${dateColumns} FROM school_years WHERE org_id=$1 AND id=$2`,[actor.org_id,before.year_id])).rows[0];
    requireCondition(year&&!year.archived,409,'Restore the school year before changing its term.');
    requireCondition(input.startsOn>=year.starts_on&&input.endsOn<=year.ends_on,400,'Term dates must fit within the school year.');
    requireCondition(!(await tx.query('SELECT id FROM school_terms WHERE org_id=$1 AND year_id=$2 AND name=$3 AND id<>$4',[actor.org_id,before.year_id,input.name,id])).rows.length,409,'A term with that name already exists in this year.');
    if(input.startsOn!==before.starts_on||input.endsOn!==before.ends_on)requireCondition(!(await tx.query('SELECT id FROM gradebooks WHERE org_id=$1 AND term_id=$2 LIMIT 1',[actor.org_id,id])).rows.length,409,'Term dates are retained once a gradebook uses them. Rename the term here; create a separate term for a different date range.');
    const after=(await tx.query(`UPDATE school_terms SET name=$3,starts_on=$4,ends_on=$5,version=version+1 WHERE org_id=$1 AND id=$2 RETURNING *,${dateColumns}`,[actor.org_id,id,input.name,input.startsOn,input.endsOn])).rows[0];
    await validateAcademicChange(tx,actor.org_id);await schoolChange(tx,actor,unitId,'term.updated',id,before,{...after,change_reason:input.reason});return after;
  });
}
export async function updateSchoolCourse(db:Database,supplied:Actor,sessionHash:string|undefined,id:string,raw:unknown){
  const input=courseUpdateInput.parse(raw),unitId=await identity(db,supplied,'courses',id);
  return schoolDefinitionTransaction(db,supplied,sessionHash,unitId,async(tx,actor)=>{
    const before=(await tx.query('SELECT * FROM courses WHERE org_id=$1 AND id=$2 FOR UPDATE',[actor.org_id,id])).rows[0];await assertVersion(before,input.version);
    requireCondition(!(await tx.query('SELECT id FROM courses WHERE org_id=$1 AND unit_id=$2 AND code=$3 AND id<>$4',[actor.org_id,unitId,input.code,id])).rows.length,409,'A course with that code already exists.');
    const after=(await tx.query('UPDATE courses SET code=$3,title=$4,description=$5,archived=$6,version=version+1 WHERE org_id=$1 AND id=$2 RETURNING *',[actor.org_id,id,input.code,input.title,input.description,input.archived])).rows[0];
    await validateAcademicChange(tx,actor.org_id);await schoolChange(tx,actor,unitId,'course.updated',id,before,{...after,change_reason:input.reason});return after;
  });
}
export async function updateTimetableRoom(db:Database,supplied:Actor,sessionHash:string|undefined,id:string,raw:unknown){
  const input=z.object({name:z.string().trim().min(2).max(100),active:z.boolean(),version:z.number().int().positive(),reason:z.string().trim().min(5).max(1000)}).strict().parse(raw),unitId=await identity(db,supplied,'timetable_rooms',id);
  return schoolDefinitionTransaction(db,supplied,sessionHash,unitId,async(tx,actor)=>{
    const before=(await tx.query('SELECT * FROM timetable_rooms WHERE org_id=$1 AND id=$2 FOR UPDATE',[actor.org_id,id])).rows[0];await assertVersion(before,input.version);
    requireCondition(!(await tx.query('SELECT id FROM timetable_rooms WHERE org_id=$1 AND unit_id=$2 AND name=$3 AND id<>$4',[actor.org_id,unitId,input.name,id])).rows.length,409,'A timetable room with that name already exists.');
    const after=(await tx.query('UPDATE timetable_rooms SET name=$3,active=$4,version=version+1 WHERE org_id=$1 AND id=$2 RETURNING id,name,active,version',[actor.org_id,id,input.name,input.active])).rows[0];
    await validateAcademicChange(tx,actor.org_id);await schoolChange(tx,actor,unitId,'timetable.room_updated',id,before,{...after,change_reason:input.reason});return after;
  });
}
