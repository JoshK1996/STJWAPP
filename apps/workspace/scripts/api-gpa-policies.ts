import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {gpaPolicyCatalogSchema,gpaPolicyDetailSchema,gpaPolicyMutationResultSchema,gpaPolicyListSchema,gpaPolicyHistoryPageSchema,gpaPolicyVersionsPageSchema,gpaPolicyVersionSchema,gpaPolicyCreateInput,gpaPolicyUpdateInput,gpaPolicyConfirmInput,gpaPolicyArchiveInput} from '../shared/gpa-policies';

const doc=JSON.parse(await readFile('docs/openapi.json','utf8'));
const uuid={type:'string',format:'uuid'},str={type:'string'};
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const json=(schema:unknown)=>({'application/json':{schema}});
for(const [name,schema] of Object.entries({GpaPolicyCatalog:gpaPolicyCatalogSchema,GpaPolicyDetail:gpaPolicyDetailSchema,GpaPolicyMutation:gpaPolicyMutationResultSchema,GpaPolicyList:gpaPolicyListSchema,GpaPolicyHistoryPage:gpaPolicyHistoryPageSchema,GpaPolicyVersionsPage:gpaPolicyVersionsPageSchema,GpaPolicyVersion:gpaPolicyVersionSchema})){
 const value=z.toJSONSchema(schema,{io:'input'});
 function rebase(node:unknown){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(rebase);return;}const row=node as Record<string,unknown>;if(typeof row.$ref==='string'&&row.$ref.startsWith('#'))row.$ref='#/components/schemas/'+name+row.$ref.slice(1);Object.values(row).forEach(rebase);}
 rebase(value);doc.components.schemas[name]=value;
}
const access='Current active password-session and exact school-office access only; current MFA/onboarding/session proof is rechecked after waits and audit. PIN, bearer, teacher-only and inherited parent-unit access do not grant this workflow. Only the current owner may confirm or replay confirmation. No default GPA scale, course weight, missing-work treatment or display rounding is configured. These routes configure policies; they do not calculate, retain or issue student GPAs, rank, transcripts or graduation outcomes. ';
function add(path:string,method:string,summary:string,description:string,response:string,input?:z.ZodType,status=200){
 const parameters:any[]=[...path.matchAll(/\{([^}]+)\}/g)].map(match=>({in:'path',name:match[1],required:true,schema:uuid}));
 const operation:any={operationId:method+'_'+path.replace(/[^a-zA-Z]/g,'_'),summary,description:access+description,security:[{Session:[]}],parameters,responses:{[status]:{description:'Successful operation',content:json(ref(response))}}};
 for(const [code,description] of Object.entries({400:'Invalid explicit configuration or request',401:'Expired or revoked session',403:'Current scope or owner-confirmation authority denied',404:'Scoped policy, year, course or confirmed version unavailable',409:'Changed catalog/draft, archived state, command mismatch or resource limit',422:'Catalog selections, captured evidence or stored policy integrity are inconsistent',429:'Request limit reached',500:'Unexpected server error',503:'Concurrent operation could not complete; retain the exact command before retrying'}))operation.responses[code]={description,content:json(ref('Error'))};
 if(input){operation.requestBody={required:true,content:json(z.toJSONSchema(input,{io:'input'}))};parameters.push({in:'header',name:'Origin',required:true,schema:str,description:'Exact configured APP_ORIGIN'},{in:'header',name:'X-CSRF-Token',required:true,schema:str,description:'Current session CSRF proof'});}
 doc.paths[path]??={};doc.paths[path][method]=operation;return operation;
}
const base='/school/gpa/policies';
const scoped=(operation:any)=>operation.parameters.push({in:'query',name:'unitId',required:true,schema:uuid},{in:'query',name:'yearId',required:true,schema:uuid});
scoped(add(base+'/catalog','get','Read actual GPA configuration source choices','Returns exact captured grading hash/version/label evidence, year terms and unit courses. Grade-level choices require explicit configuration; no scale-to-points conversion or equal weighting is inferred. Catalog hash identifies reviewed input evidence.','GpaPolicyCatalog'));
const list=add(base,'get','List GPA policy drafts and current confirmations','Lists up to50 scoped records with a beforeId cursor; an unconfirmed draft is not an active academic rule.','GpaPolicyList');scoped(list);list.parameters.push({in:'query',name:'beforeId',required:false,schema:uuid});
add(base,'post','Create an unconfirmed GPA configuration','Requires explicit awarded-label point mappings or unsupported dispositions, actual captured grading-policy references, each course inclusion/exclusion and positive weight, applicability, missing-work behavior and final display rule. Catalog labels must match exactly. Command UUID/reason and reviewed catalog hash are required; exact replay preserves the original response under current authority.','GpaPolicyMutation',gpaPolicyCreateInput,201);
add(base+'/{id}','get','Read GPA draft, active confirmation and permitted actions','Returns captured evidence; catalog freshness is checked separately against the current catalog. Editing a draft never silently replaces its active immutable confirmation.','GpaPolicyDetail');
add(base+'/{id}','patch','Revise an unconfirmed GPA draft','Requires expected draft version and current catalog hash. Keeps prior configuration history, confirmations and command receipts.','GpaPolicyMutation',gpaPolicyUpdateInput);
add(base+'/{id}/confirm','post','Confirm explicitly reviewed GPA rules as the owner','Requires current owner authority, expected version/draft/catalog hashes, reviewed=true, authoritative source description, reason and command UUID. Retains an immutable policy version with exact configuration and original grading-source evidence; no student determination is produced.','GpaPolicyMutation',gpaPolicyConfirmInput);
add(base+'/{id}/archive','post','Archive or restore a GPA policy','Requires expected version, explicit archived state and reason. Historical evidence remains; restoration does not invent or confirm new rules.','GpaPolicyMutation',gpaPolicyArchiveInput);
for(const [suffix,response,title] of [['history','GpaPolicyHistoryPage','Read GPA policy change history'],['versions','GpaPolicyVersionsPage','List immutable GPA confirmations']]){
 const operation=add(base+'/{id}/'+suffix,'get',title,'Returns up to50 records with a beforeVersion cursor, preserving captured identities, evidence and reasons.',''+response);
 operation.parameters.push({in:'query',name:'beforeVersion',required:false,schema:{type:'integer',minimum:1,maximum:2147483647}});
}
add(base+'/{id}/versions/{versionId}','get','Read an immutable confirmed GPA policy','Uses the exact confirmation UUID and current office access. Does not reconstruct earlier point mappings or source labels from today\'s catalog.','GpaPolicyVersion');
await writeFile('docs/openapi.json',JSON.stringify(doc,null,2)+'\n');
console.log(Object.keys(doc.paths).length+' documented paths');
