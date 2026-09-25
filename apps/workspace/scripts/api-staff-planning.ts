import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { planningQuery, coverageRuleInput, hoursTargetInput, planningPreviewInput, planningApplyInput } from '../shared/staff-planning';
import { scheduleDocumentInput, scheduleDocumentResult } from '../shared/schedule-documents';

const file='docs/openapi.json',doc=JSON.parse(await readFile(file,'utf8')),schemas=doc.components.schemas;
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const str={type:'string'},uuid={type:'string',format:'uuid'},date={type:'string',format:'date'},instant={type:'string',format:'date-time'},bool={type:'boolean'},integer={type:'integer'},micros={type:'string',pattern:'^[0-9]+$'},signed={type:'string',pattern:'^-?[0-9]+$'};
const arr=(items:unknown,maxItems?:number)=>({type:'array',items,...(maxItems===undefined?{}:{maxItems})});
const obj=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const nullable=(schema:unknown)=>({anyOf:[schema,{type:'null'}]});
const json=(schema:unknown)=>({'application/json':{schema}});
const put=(name:string,schema:z.ZodType,io:'input'|'output'='input')=>{schemas[name]=z.toJSONSchema(schema,{io});return ref(name);};
put('StaffPlanningQuery',planningQuery);put('CoverageRuleInput',coverageRuleInput);put('JobHoursTargetInput',hoursTargetInput);
put('StaffPlanningPreviewInput',planningPreviewInput);put('StaffPlanningApplyInput',planningApplyInput);
put('ScheduleDocumentInput',scheduleDocumentInput);put('ScheduleDocumentResult',scheduleDocumentResult,'output');
function stored(name:string,inputName:string,extra:Record<string,unknown>){
 const input=schemas[inputName],properties={...input.properties};
 for(const key of ['commandId','reason','expectedVersion'])delete properties[key];
 schemas[name]=obj({...properties,id:uuid,version:{type:'integer',minimum:1},...extra});
}
stored('CoverageRule','CoverageRuleInput',{timezone:str});stored('JobHoursTarget','JobHoursTargetInput',{});
schemas.PlanningJob=obj({id:uuid,title:str,unitId:uuid,unitName:str,active:bool});
const employee={id:uuid,name:str,jobIds:arr(uuid),scheduledMicroseconds:micros};
schemas.PlanningEmployee=obj(employee);
schemas.PlanningWarning=obj({code:{type:'string',enum:['SKIPPED_DATE','DST_BLOCKED','RULE_OVERLAP']},message:str,ruleIds:arr(uuid),date});
schemas.PlanningSlice=obj({startsAt:instant,endsAt:instant,assigned:integer,required:integer,missing:integer,excess:integer,employeeIds:arr(uuid)});
const totals={requiredMicroseconds:micros,filledMicroseconds:micros,uncoveredMicroseconds:micros,excessMicroseconds:micros};
schemas.PlanningOccurrence=obj({id:str,ruleId:uuid,date,jobId:uuid,label:str,startsAt:instant,endsAt:instant,staffCount:integer,slices:arr(ref('PlanningSlice')),...totals,conflict:bool});
schemas.JobTargetPeriod=obj({targetId:uuid,jobId:uuid,period:{type:'string',enum:['day','week','month','year']},start:date,end:date,targetHours:str,targetMicroseconds:micros,scheduledMicroseconds:micros,deltaMicroseconds:signed,partial:bool,label:str});
schemas.PlanningSchedule=obj({id:uuid,userId:uuid,employeeName:str,jobId:uuid,jobTitle:str,unitId:uuid,unitName:str,startsAt:instant,endsAt:instant,note:str,version:integer,status:{type:'string',enum:['scheduled','cancelled']},updatedAt:instant,cancelledAt:nullable(instant)});
schemas.StaffPlanning=obj({query:ref('StaffPlanningQuery'),timezone:str,asOf:instant,revision:str,jobs:arr(ref('PlanningJob'),1000),employees:arr(ref('PlanningEmployee'),200),schedules:arr(ref('PlanningSchedule'),20000),rules:arr(ref('CoverageRule'),200),hoursTargets:arr(ref('JobHoursTarget'),200),occurrences:arr(ref('PlanningOccurrence'),5000),targetPeriods:arr(ref('JobTargetPeriod')),warnings:arr(ref('PlanningWarning')),totals:obj(totals),notice:str});
schemas.PlanningSlot=obj({id:str,ruleId:uuid,occurrenceId:str,date,jobId:uuid,startsAt:instant,endsAt:instant,position:integer});
schemas.PlanningCandidate=obj({...employee,unavailableSlotIds:arr(str,1000)});
schemas.StaffPlanningPreview=obj({id:uuid,sourceHash:str,createdAt:instant,expiresAt:instant,query:ref('StaffPlanningQuery'),timezone:str,ruleIds:arr(uuid,200),slots:arr(ref('PlanningSlot'),1000),candidates:arr(ref('PlanningCandidate'),200),jobs:arr(ref('PlanningJob'),1000),warnings:arr(ref('PlanningWarning')),notice:str});
schemas.StaffPlanningApplied=obj({id:uuid,replayed:bool,schedules:arr(obj({id:uuid,version:integer,status:{type:'string',enum:['scheduled','cancelled']}}),1000),appliedCount:integer});
schemas.PlanningDefinitionSaved=obj({id:uuid,version:integer,replayed:bool});
schemas.PlanningHistory=obj({rows:arr(obj({version:integer,action:str,reason:str,before:{},after:{},actorName:str,createdAt:instant}),1000)});
const access='Current active developer/owner/administrator/manager password session; explicit community scope for managers. PIN and API bearer denied. Completed credential setup and any enrolled MFA proof required. Scope and session are rechecked before publication/commit. Private, no-store. ';
function add(path:string,method:string,summary:string,description:string,response:string,input?:string,status=200,query=false){
 const parameters:any[]=[...path.matchAll(/\{([^}]+)\}/g)].map(match=>({in:'path',name:match[1],required:true,schema:uuid}));
 if(query)parameters.push(...Object.entries(schemas.StaffPlanningQuery.properties).map(([name,schema])=>({in:'query',name,required:schemas.StaffPlanningQuery.required.includes(name),schema})));
 if(method!=='get')parameters.push(...['Origin','X-CSRF-Token'].map(name=>({in:'header',name,required:true,schema:str})));
 const responses:Record<string,unknown>={[status]:{description:'Successful operation',content:json(ref(response))}};
 for(const [code,description]of Object.entries({400:'Invalid input or bounded planning result',401:'Current session missing or revoked',403:'Mode, role, scope, Origin or CSRF denied',404:'Record unavailable in current scope',409:'Changed source/version, conflict, expired preview or changed retry payload',413:'File, source or result limit exceeded',422:'Unsupported or unreadable document',429:'Document admission limit',503:'Retryable transaction or document worker failure'}))responses[code]={description,content:json(ref('Error'))};
 (doc.paths[path]??={})[method]={operationId:method+'_'+path.replace(/[^a-zA-Z0-9]/g,'_'),summary,description:access+description,security:[{Session:[]}],parameters,responses,...(input?{requestBody:{required:true,content:json(ref(input))}}:{})};
}
add('/schedules/planning','get','Review job staffing coverage and hours targets','Inclusive organization-local dates, at most366 days. Coverage windows, employee schedules and separate calendar-period targets remain distinct. Exact elapsed durations are decimal microsecond strings; views may round only aggregate presentation. Weeks start Monday. Partial target periods retain their full target and are labeled, never silently prorated. Limits200 rules,200 targets,5000 expanded occurrences,200 employees,20000 schedules; oversized results fail explicitly. No wages or clock records are created.','StaffPlanning',undefined,200,true);
for(const [path,input,response,label]of [['rules','CoverageRuleInput','CoverageRule','staffing coverage rule'],['targets','JobHoursTargetInput','JobHoursTarget','job hours target']]){
 add('/schedules/planning/'+path+'/{id}','put','Create or edit a '+label,'Caller supplies UUID and expectedVersion0 for creation; edits require the current version. commandId binds the exact actor/payload for safe retry. Effective dates and active/archive state are editable; immutable history and audits retain changes. Rule timezone is captured. Recurrences support daily/weekly/monthly/yearly intervals, weekly weekdays, explicit overnight windows and staffing count. Conflicting expanded rules block generation. No existing employee shifts are rewritten.','PlanningDefinitionSaved',input);
 add('/schedules/planning/'+path+'/{id}/history','get','Read '+label+' history','Current scope covers retained before/after job communities. At most1000 revisions; no silent truncation.','PlanningHistory');
}
add('/schedules/planning/preview','post','Preview open staffing slots and eligible employees','Expands the selected rules/date range into at most1000 open shift choices. Existing partial coverage produces partial gaps. No employee is selected automatically. Candidate order uses scoped scheduled hours, not a staffing guarantee. Overlaps and unavailable/DST windows are explicit. Actor-owned immutable preview expires after30 minutes; no shifts are saved. Preview response cap8MiB, retained organization budget64MiB and5000 previews; reaching capacity preserves existing evidence.','StaffPlanningPreview','StaffPlanningPreviewInput',201);
add('/schedules/planning/{id}/apply','post','Save explicitly selected employees into reviewed shifts','sourceHash must match the preview and current source. Validates current employees, job assignments, scopes and overlap constraints; locks affected accounts in stable order. Up to1000 selected slots apply atomically through the existing schedule service with history, audit and a retained retry receipt. Unselected slots stay open. Exact retries recover the result without duplicate shifts or overwriting later edits. Saved shifts become employee allowance/preclock input; planning rules alone do not.','StaffPlanningApplied','StaffPlanningApplyInput');
add('/schedule-documents/inspect','post','Read an uploaded schedule into editable rows','CSV, XLSX, text PDF or DOCX;2MiB source, exact canonical base64, route-specific3MiB JSON limit. Local isolated worker has15-second deadline and192MiB heap; bounded ZIP/XML, pages/rows/cells and output. Source bytes are not retained or sent to AI. Returns SHA256, extracted sheets/pages and warnings for human mapping/correction. Scanned PDFs/images and legacy DOC are unsupported. Parsing never creates shifts. Review identity, job and local/offset timestamps, then submit canonical CSV to the workforce schedule preview/apply workflow. Canonical CSV evidence is retained there; original document is not.','ScheduleDocumentResult','ScheduleDocumentInput');
await writeFile(file,JSON.stringify(doc,null,2)+'\n');
console.log('Documented job coverage, hours targets, reviewed generation and schedule documents.');
