import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {scheduleRequestCreateInput,scheduleRequestReviewInput,scheduleRequestWithdrawInput} from '../shared/schedule-requests';

const doc=JSON.parse(await readFile('docs/openapi.json','utf8'));
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'},uuid={type:'string',format:'uuid'},instant={type:'string',format:'date-time'};
const nullable=(schema:unknown)=>({anyOf:[schema,{type:'null'}]});
const status={type:'string',enum:['pending','approved','declined','withdrawn']};
const requestVersion={type:'integer',enum:[1,2]},version={type:'integer',minimum:1};
const action={type:'string',enum:['update','cancel']};
const actor=object({id:uuid,nameSnapshot:str});
const applied=object({id:uuid,version,status:{type:'string',enum:['scheduled','cancelled']}});
const schedule=object({id:uuid,userId:uuid,employeeName:str,jobId:uuid,jobTitle:str,unitId:uuid,unitName:str,startsAt:instant,endsAt:instant,note:str,version,status:{type:'string',enum:['scheduled','cancelled']},updatedAt:instant,cancelledAt:nullable(instant)});
const proposal=object({jobId:uuid,jobTitle:str,unitId:uuid,unitName:str,startsAt:instant,endsAt:instant});
const summary={id:uuid,version:requestVersion,status,action,requester:actor,submittedAt:instant,decidedAt:nullable(instant),source:schedule,proposal:nullable(proposal),appliedSchedule:nullable(applied)};
doc.components.schemas.ScheduleRequestSummary=object(summary);
doc.components.schemas.ScheduleRequestDetail=object({...summary,reason:str,proposalHash:{type:'string',pattern:'^[a-f0-9]{64}$'},current:schedule,
 decision:nullable(object({actor,note:str,at:instant})),
 allowedActions:object({approve:{type:'boolean'},decline:{type:'boolean'},withdraw:{type:'boolean'}}),
 blockers:{type:'array',items:object({code:{type:'string',enum:['SCHEDULE_CHANGED','SCHEDULE_CANCELLED','EMPLOYEE_INACTIVE','SOURCE_UNIT_CHANGED','TARGET_UNIT_CHANGED','TARGET_JOB_INACTIVE','TARGET_JOB_UNASSIGNED','OVERLAP','NO_FIELD_CHANGE']},message:str})}});
doc.components.schemas.ScheduleRequestList=object({rows:{type:'array',maxItems:50,items:ref('ScheduleRequestSummary')},nextCursor:nullable(str)});
doc.components.schemas.ScheduleRequestCreated=object({id:uuid,version:{const:1},status:{const:'pending'},proposalHash:{type:'string',pattern:'^[a-f0-9]{64}$'}});
doc.components.schemas.ScheduleRequestDecided=object({id:uuid,version:{const:2},status:{type:'string',enum:['approved','declined','withdrawn']},appliedSchedule:nullable(applied)});
doc.components.schemas.ScheduleRequestHistory=object({rows:{type:'array',maxItems:2,items:object({id:uuid,requestVersion,action:{type:'string',enum:['submitted','approved','declined','withdrawn']},actor:object({id:uuid,nameSnapshot:str,roleSnapshot:str}),at:instant,reason:str,before:nullable(object({version,status})),after:object({version,status}),appliedSchedule:nullable(applied)})}});
const json=(schema:unknown)=>({'application/json':{schema}});
const access='Active password account only; PIN and bearer credentials denied. Submitters read their own retained requests. Other readers require current owner/admin or explicit manager scope over all captured and current source/target units. Finance schedule-read permission does not expose other employees’ request reasons. Parent-unit access does not include subgroups. Private explanations remain in request evidence, not general schedule history or audit metadata. ';
function add(path:string,method:string,summaryText:string,description:string,response:string,input?:z.ZodType,query:any[]=[],success=200){
 const parameters:any[]=[...query,...[...path.matchAll(/\{([^}]+)\}/g)].map(match=>({in:'path',name:match[1],required:true,schema:uuid}))];
 const operation:any={operationId:method+'_'+path.replace(/[^a-zA-Z]/g,'_'),summary:summaryText,description:access+description,security:[{Session:[]}],parameters,responses:{[success]:{description:'Successful operation',content:json(ref(response))}}};
 for(const [code,text] of Object.entries({400:'Invalid input or proposal',401:'Sign-in required',403:'Current access denied',404:'Scoped request or schedule unavailable',409:'Changed version, proposal, command or state',429:'Request limit reached'}))operation.responses[code]={description:text,content:json(ref('Error'))};
 if(input){operation.requestBody={required:true,content:json(z.toJSONSchema(input,{io:'input'}))};parameters.push({in:'header',name:'Origin',required:true,schema:str,description:'Exact configured APP_ORIGIN'},{in:'header',name:'X-CSRF-Token',required:true,schema:str,description:'Current password session CSRF token from GET /me'});}
 doc.paths[path]??={};doc.paths[path][method]=operation;
}
const q=(name:string,schema:unknown)=>({in:'query',name,required:false,schema});
add('/schedule-requests','get','List own or permitted team schedule-change requests','Fixed 50-row pages ordered by submission time and UUID descending. Scope reapplied on every cursor page; cursor carries position only.','ScheduleRequestList',undefined,[q('view',{type:'string',enum:['own','team'],default:'own'}),q('status',{...status,enum:[...status.enum,'all'],default:'pending'}),q('scheduleId',uuid),q('cursor',{type:'string',minLength:1,maxLength:500})]);
add('/schedule-requests','post','Submit a reviewed proposal for an owned scheduled shift','Exact schedule version and immutable update/cancel proposal. Updates require current assigned active job/unit and valid exact instants, up to 24 elapsed hours. Original administrative note retained. One pending request per schedule; matching command retries return the original result. Submission does not change the schedule.','ScheduleRequestCreated',scheduleRequestCreateInput,[],201);
add('/schedule-requests/{id}','get','Read submitted evidence and current approval blockers','Original source/proposal remain unchanged; current schedule and allowedActions are separate. Stale requests can remain withdrawable or declinable.','ScheduleRequestDetail');
add('/schedule-requests/{id}/history','get','Read immutable schedule-request history','Submitted and final events retain captured actor names/roles and resulting schedule version.','ScheduleRequestHistory');
add('/schedule-requests/{id}/review','post','Approve and apply the exact proposal, or decline it','Different current owner/admin/scoped manager required. Version, proposal hash and reviewed=true required. Approval revalidates source/target scope, assignment, schedule version/state and overlap, then commits the schedule change, request outcome, histories, audits and retry receipts in one transaction. Decline changes only the request. No caller replacement fields. No clock, pay, PTO, academic or message effect.','ScheduleRequestDecided',scheduleRequestReviewInput);
add('/schedule-requests/{id}/withdraw','post','Withdraw an owned pending schedule-change request','Current submitter only; exact request version/hash and reason required. No schedule change. Terminal outcomes are immutable. Retries recheck current access before returning retained results.','ScheduleRequestDecided',scheduleRequestWithdrawInput);
await writeFile('docs/openapi.json',JSON.stringify(doc,null,2)+'\n');
console.log(Object.keys(doc.paths).length+' documented paths');
