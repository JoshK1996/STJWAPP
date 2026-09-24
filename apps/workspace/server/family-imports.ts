import { z } from "zod";
import type { Queryable, Row } from "./db";
import { digest, requireCondition, type Actor } from "./security";
import { familyImportRowSchemas, type FamilyImportContext } from "../shared/school-imports";
import { householdInput, householdUpdateInput, contactInput } from "../shared/school";
import { createHouseholdTransaction, updateHouseholdTransaction, saveHouseholdMemberTransaction, saveContactTransaction } from "./school";

type FamilyRow = {
  row:number; input:Record<string,string>; student:Row|null; before:Row|null; after:Row|null;
  action:"create"|"update"|"unchanged"|"error"; errors:string[]; source:Row|null;
  identity:{label:string;reference:string};
};
const uuid = (text:unknown) => z.uuid().safeParse(text).success;
const ids = (rows:Record<string,string>[], field:string) => [...new Set(rows.map(r=>r[field]).filter(uuid).map(x=>x.toLowerCase()))].sort();
const same = (before:unknown, after:unknown) => JSON.stringify(before) === JSON.stringify(after);
// A spreadsheet-protection apostrophe is removed only when the exact identified
// existing field proves its origin. New text and nonmatching literals stay literal.
function retainedText(input:string, current:unknown) {
  const text=String(current??"");
  return /^[\s]*[=+@\-\t\r\0]/.test(text) && input === "'"+text ? text : input;
}
function contactValues(row:Row) {
  return {personId:row.person_id,relationship:row.relationship,isGuardian:row.is_guardian,
    canCommunicate:row.can_communicate,canPickup:row.can_pickup,pickupUntil:row.pickup_until??null,
    pickupExpiry:row.can_pickup ? row.pickup_until ?? "No expiry — pickup permission has no expiration" : "No pickup permission",
    emergencyPriority:row.emergency_priority??null,restrictionNote:row.restriction_note};
}
export async function buildFamilyPlan(tx:Queryable,actor:Actor,context:FamilyImportContext,inputs:Record<string,string>[],lock:boolean) {
  const householdIds=ids(inputs,"householdId"),personIds=ids(inputs,"personId"),studentIds=ids(inputs,"studentId");
  // Existing academic and child-release writers lock student before person. For
  // membership rows, include student identities corresponding to selected people.
  const students=(await tx.query(`SELECT s.id,s.person_id,s.student_number,s.version,s.active FROM students s
    WHERE s.org_id=$1 AND s.unit_id=$2 AND (s.id=ANY($3::uuid[]) OR s.person_id=ANY($4::uuid[])) ORDER BY s.id${lock?" FOR UPDATE":""}`,
    [actor.org_id,context.unitId,studentIds,personIds])).rows;
  const households=(await tx.query(`SELECT * FROM households WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id${lock?" FOR NO KEY UPDATE":""}`,
    [actor.org_id,context.unitId,householdIds])).rows;
  const people=(await tx.query(`SELECT id,name,email,phone,version FROM school_people WHERE org_id=$1 AND unit_id=$2 AND id=ANY($3::uuid[]) ORDER BY id${lock?" FOR SHARE":""}`,
    [actor.org_id,context.unitId,[...new Set([...personIds,...students.map(s=>s.person_id)])]])).rows;
  const counts=new Map<string,number>();
  for(const row of inputs) {
    const key=context.kind==="households" ? row.householdId : context.kind==="household_members" ? row.householdId+":"+row.personId : row.studentId+":"+row.personId;
    if(key) counts.set(key.toLowerCase(),(counts.get(key.toLowerCase())??0)+1);
  }
  const rows:FamilyRow[]=[];
  for(let index=0;index<inputs.length;index++) {
    const normalized={...inputs[index]};
    for(const field of ["householdId","personId","studentId"]) if(uuid(normalized[field])) normalized[field]=normalized[field].toLowerCase();
    const household=households.find(h=>h.id===normalized.householdId)??null;
    const person=people.find(p=>p.id===normalized.personId)??null;
    const student=students.find(s=>s.id===normalized.studentId)??null;
    const contact=context.kind==="contacts"&&student&&person ? (await tx.query("SELECT *,to_char(pickup_until,'YYYY-MM-DD') AS pickup_until FROM student_contacts WHERE org_id=$1 AND student_id=$2 AND person_id=$3",[actor.org_id,student.id,person.id])).rows[0]??null : null;
    // Unescape only a known existing field before validating its length. A
    // maximal-length value must still round-trip through a protected CSV cell.
    if(context.kind==="households"&&household) for(const field of ["name","address"]) normalized[field]=retainedText(normalized[field],household[field]);
    if(context.kind==="contacts") {
      if(student) normalized.studentNumber=retainedText(normalized.studentNumber,student.student_number);
      if(contact) {
        normalized.relationship=retainedText(normalized.relationship,contact.relationship);
        normalized.restrictionNote=retainedText(normalized.restrictionNote,contact.restriction_note);
      }
    }
    const checked=familyImportRowSchemas[context.kind].safeParse(normalized);
    const input:Record<string,string>={...(checked.success?checked.data:normalized)};
    const errors=checked.success?[]:checked.error.issues.map(issue=>(issue.path.join(".")||"row")+": "+issue.message);
    const key=context.kind==="households"?input.householdId:context.kind==="household_members"?input.householdId+":"+input.personId:input.studentId+":"+input.personId;
    if(key && (counts.get(key.toLowerCase())??0)>1) errors.push("This exact record appears more than once in the file.");
    let before:Row|null=null,after:Row|null=null,source:Row|null=null;
    let action:FamilyRow["action"]="create";
    let identity={label:input.name??"Family record",reference:input.householdId||input.personId||"New household"};
    if(context.kind==="households") {
      if(input.householdId && !household) errors.push("Exact household ID not found in this unit.");
      if(checked.success) {
        if(!input.householdId) {
          if(input.version!=="0") errors.push("A new household requires a blank ID and version 0.");
          if(input.archived!=="false") errors.push("Create an active household with archived=false.");
        } else if(household && household.version!==Number(input.version)) errors.push("Household version changed. Download current records again.");
        before=household?{name:household.name,address:household.address,archived:household.archived}:null;
        after={name:retainedText(input.name,household?.name),address:retainedText(input.address,household?.address),archived:input.archived==="true"};
        source=household;
        identity={label:household?.name??input.name,reference:input.householdId||"New household — identity assigned on apply"};
      }
    } else if(context.kind==="household_members") {
      identity={label:(household?.name??"Unknown household")+" · "+(person?.name??"Unknown person"),reference:(input.householdId??"")+" / "+(input.personId??"")};
      if(!household||household.archived) errors.push("Active household not found at this exact ID in this unit.");
      if(!person) errors.push("Person not found at this exact ID in this unit.");
      if(checked.success&&household&&person) {
        if(household.version!==Number(input.householdVersion)) errors.push("Household version changed.");
        if(person.version!==Number(input.personVersion)) errors.push("Person version changed.");
        const member=(await tx.query("SELECT person_id,role FROM household_members WHERE org_id=$1 AND household_id=$2 AND person_id=$3",[actor.org_id,household.id,person.id])).rows[0]??null;
        before=member?{personId:person.id,role:member.role,member:true}:null;
        after={personId:person.id,role:input.role,member:input.remove!=="true"};
        source={household,person,member,student:students.find(s=>s.person_id===person.id)??null};
        if(!member && input.remove==="true") action="unchanged";
      }
    } else {
      const studentPerson=people.find(p=>p.id===student?.person_id);
      identity={label:(studentPerson?.name??"Unknown student")+" · "+(person?.name??"Unknown adult contact"),reference:(input.studentNumber??"")+" / "+(input.personId??"")};
      if(!student?.active) errors.push("Active student not found at this exact ID in this unit.");
      if(!person) errors.push("Existing contact person not found at this exact ID in this unit.");
      if(person&&students.some(s=>s.person_id===person.id)) errors.push("A student cannot be designated as an adult contact.");
      if(checked.success&&student&&person) {
        if(retainedText(input.studentNumber,student.student_number)!==student.student_number) errors.push("Student number does not match the exact student ID.");
        if(student.version!==Number(input.studentVersion)) errors.push("Student version changed.");
        if(person.version!==Number(input.personVersion)) errors.push("Contact person version changed.");
        if((contact?.version??0)!==Number(input.contactVersion)) errors.push("Contact permissions changed. Use version 0 only for a new relationship.");
        for(const [field,actionField] of [["pickupUntil","pickupUntilAction"],["restrictionNote","restrictionNoteAction"]]) {
          if(input[actionField]==="replace"&&!input[field]) errors.push(field+": replace requires a value.");
          if(input[actionField]!=="replace"&&input[field]) errors.push(field+": keep or clear requires a blank value.");
        }
        if(input.canPickup==="true"&&!contact?.can_pickup&&input.pickupUntilAction==="keep") errors.push("A new pickup grant requires replace with an expiry date, or clear for explicitly no expiry.");
        const pickupUntil=input.pickupUntilAction==="keep" ? contact?.pickup_until??null : input.pickupUntilAction==="clear" ? null : input.pickupUntil;
        const restrictionNote=input.restrictionNoteAction==="keep" ? contact?.restriction_note??"" : input.restrictionNoteAction==="clear" ? "" : retainedText(input.restrictionNote,contact?.restriction_note);
        before=contact?contactValues(contact):null;
        after=contactValues({person_id:person.id,relationship:retainedText(input.relationship,contact?.relationship),is_guardian:input.isGuardian==="true",can_communicate:input.canCommunicate==="true",can_pickup:input.canPickup==="true",pickup_until:pickupUntil,emergency_priority:input.emergencyPriority?Number(input.emergencyPriority):null,restriction_note:restrictionNote});
        const enrollment=(await tx.query("SELECT id,version FROM student_enrollments WHERE org_id=$1 AND student_id=$2 ORDER BY id",[actor.org_id,student.id])).rows;
        const roster=(await tx.query("SELECT section_id,version FROM section_students WHERE org_id=$1 AND student_id=$2 ORDER BY section_id",[actor.org_id,student.id])).rows;
        const hold=(await tx.query("SELECT active,version,reason FROM child_pickup_holds WHERE org_id=$1 AND student_id=$2",[actor.org_id,student.id])).rows[0]??null;
        source={student,studentPerson,person,contact,enrollmentHash:digest(JSON.stringify(enrollment)),rosterHash:digest(JSON.stringify(roster)),hold};
      }
    }
    if(errors.length) action="error";
    else if(action!=="unchanged"&&before) action=same(before,after)?"unchanged":"update";
    rows.push({row:index+2,input,student,before,after,source,identity,action,errors});
  }
  return {context,year:null,section:null,roster:null,rows,counts:{total:rows.length,create:rows.filter(r=>r.action==="create").length,update:rows.filter(r=>r.action==="update").length,unchanged:rows.filter(r=>r.action==="unchanged").length,errors:rows.filter(r=>r.errors.length).length}};
}
export async function applyFamilyRows(tx:Queryable,actor:Actor,context:FamilyImportContext,rows:FamilyRow[]) {
  const results:Row[]=[];
  for(const row of rows) {
    requireCondition(row.after && !row.errors.length,409,"Family row no longer passes validation.");
    if(context.kind==="households") {
      const saved=row.source ? await updateHouseholdTransaction(tx,actor,row.input.householdId,householdUpdateInput.parse({...row.after,version:row.source.version}))
        : await createHouseholdTransaction(tx,actor,householdInput.parse({unitId:context.unitId,name:row.after.name,address:row.after.address}));
      results.push({row:row.row,householdId:saved.id,version:saved.version});
    } else if(context.kind==="household_members") {
      await saveHouseholdMemberTransaction(tx,actor,row.input.householdId,{personId:row.input.personId,role:row.input.role as "student"|"guardian"|"other",remove:row.input.remove==="true"});
      results.push({row:row.row,householdId:row.input.householdId,personId:row.input.personId,removed:row.input.remove==="true"});
    } else {
      const {pickupExpiry:_,...fields}=row.after;
      const saved=await saveContactTransaction(tx,actor,row.student!.id,contactInput.parse({...fields,...(row.source?.contact?{version:row.source.contact.version}:{})}));
      results.push({row:row.row,studentId:row.student!.id,personId:saved.person_id,version:saved.version});
    }
  }
  return results;
}

export async function familyTemplateRows(tx:Queryable,actor:Actor,context:FamilyImportContext) {
  let rows:Row[];
  if(context.kind==="households") rows=(await tx.query("SELECT id AS \"householdId\",version,name,address,archived FROM households WHERE org_id=$1 AND unit_id=$2 ORDER BY id LIMIT 501",[actor.org_id,context.unitId])).rows;
  else if(context.kind==="household_members") rows=(await tx.query(`SELECT h.id AS "householdId",h.version AS "householdVersion",p.id AS "personId",p.version AS "personVersion",m.role,false AS remove
    FROM household_members m JOIN households h ON h.org_id=m.org_id AND h.id=m.household_id JOIN school_people p ON p.org_id=m.org_id AND p.id=m.person_id
    WHERE h.org_id=$1 AND h.unit_id=$2 AND NOT h.archived ORDER BY h.id,p.id LIMIT 501`,[actor.org_id,context.unitId])).rows;
  else rows=(await tx.query(`SELECT s.id AS "studentId",s.student_number AS "studentNumber",s.version AS "studentVersion",p.id AS "personId",p.version AS "personVersion",c.version AS "contactVersion",
    c.relationship,c.is_guardian AS "isGuardian",c.can_communicate AS "canCommunicate",c.can_pickup AS "canPickup",'keep' AS "pickupUntilAction",'' AS "pickupUntil",c.emergency_priority AS "emergencyPriority",'keep' AS "restrictionNoteAction",'' AS "restrictionNote"
    FROM student_contacts c JOIN students s ON s.org_id=c.org_id AND s.id=c.student_id JOIN school_people p ON p.org_id=c.org_id AND p.id=c.person_id
    WHERE c.org_id=$1 AND c.unit_id=$2 AND s.active ORDER BY s.id,p.id LIMIT 501`,[actor.org_id,context.unitId])).rows;
  requireCondition(rows.length<=500,400,"More than 500 family records exist in this unit. Use a blank template and the identity directory for a smaller batch.");
  return rows;
}
export async function familyIdentityRows(tx:Queryable,actor:Actor,unitId:string) {
  const people=(await tx.query(`SELECT CASE WHEN s.id IS NULL THEN 'person' ELSE 'student' END AS "recordType",coalesce(s.id,p.id) AS id,coalesce(s.student_number,'') AS "studentNumber",p.name,coalesce(s.version,p.version) AS version,
    p.id AS "personId",p.version AS "personVersion",s.active AS "studentActive"
    FROM school_people p LEFT JOIN students s ON s.org_id=p.org_id AND s.person_id=p.id WHERE p.org_id=$1 AND p.unit_id=$2 ORDER BY p.id LIMIT 5001`,[actor.org_id,unitId])).rows;
  const households=(await tx.query(`SELECT 'household' AS "recordType",id,'' AS "studentNumber",name,version,'' AS "personId",NULL AS "personVersion",NULL AS "studentActive",archived AS "householdArchived" FROM households WHERE org_id=$1 AND unit_id=$2 ORDER BY id LIMIT 5001`,[actor.org_id,unitId])).rows;
  requireCondition(people.length<=5000&&households.length<=5000,400,"The identity directory exceeds 5,000 people or households. Use the individual school record screens.");
  return [...people,...households];
}
