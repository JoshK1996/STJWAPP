import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {reportDefinition,saveReportInput} from '../shared/report-library';
const path='docs/openapi.json',doc=JSON.parse(await readFile(path,'utf8'));
const base=doc.paths['/care/programs'].post;
function operation(method:string,path:string,summary:string,schema?:any,extra=''){
 const result:any={operationId:method+'_'+path.replace(/[^a-zA-Z0-9]/g,'_'),summary,description:'Password sessions only. Saved definitions and history are private to the verified account and organization. Every run/export rechecks current source access; workforce permissions do not grant school access. '+extra,security:[{Session:[]}],responses:{...base.responses,'200':base.responses['201']}};delete result.responses['201'];
 result.responses['404']={description:'Private report or source unavailable'};
 if(schema)result.requestBody={required:true,content:{'application/json':{schema:z.toJSONSchema(schema)}}};
 if(path.includes('{id}'))result.parameters=[{in:'path',name:'id',required:true,schema:{type:'string',format:'uuid'}}];
 if(path.endsWith('/run')||path.endsWith('/export'))result.parameters.push({in:'query',name:'version',required:true,schema:{type:'integer',minimum:1}},{in:'query',name:'format',schema:{type:'string',enum:['csv','json'],default:'csv'}});
 if(path.endsWith('/export'))result.responses['200']={description:'Freshly generated rows with report version, as-of time, resolved range and source provenance.',content:{'text/csv':{schema:{type:'string'}},'application/json':{schema:{type:'object'}}}};
 doc.paths[path]??={};doc.paths[path][method]=result;
}
operation('get','/report-library','List personal saved report definitions');
operation('post','/report-library','Create or revise a personal report definition',saveReportInput,'Client-generated UUID and expected version; account-serialized, fingerprinted retries. Definition history is immutable. Maximum 500 retained definitions per account. Source columns, grouping and sort keys have additional cross-field allowlist validation.');
operation('get','/report-library/options','List currently accessible report sources and choices');
operation('get','/report-library/finance-options','List published financial sources in one community',undefined,'Current active owner/admin/finance role is rechecked under a shared account lock. At most 500 sources, including archived historical sources. Catalog uses latest titles; report definitions pin an explicit immutable version. Financial summaries require detail rows only; exact decimal amounts retain up to four fraction digits.');
doc.paths['/report-library/finance-options'].get.parameters=[{in:'query',name:'unitId',required:true,schema:{type:'string',format:'uuid'}}];
operation('post','/report-library/preview','Run an unsaved report definition',reportDefinition,'Relative dates use the organization timezone; weeks start Monday. Workforce is self-scoped without reporting privileges. Care requires school-office access; grades require class or school-office access. Pay rates require a current active owner/admin/finance role; inclusive effective-date overlap uses current reviewed records, including inactive/unassigned records. Optional void entries, exact amounts, maximum 5,000 matching entries. Pay summaries count entries only and never sum rates or infer payroll. Source limits reject overly broad requests.');
operation('get','/report-library/{id}/history','Read up to 100 retained definition revisions');
operation('get','/report-library/{id}/run','Run a saved report with current data',undefined,'Rejects archived or stale definition versions.');
operation('get','/report-library/{id}/export','Export a current saved report as CSV or JSON',undefined,'CSV protects against spreadsheet formulas. Downloads rerun the source; displayed previews are separate as-of snapshots.');
doc.info.description=doc.info.description.replace('staff-operated dismissal routes','staff-operated dismissal and private report-library routes');
await writeFile(path,JSON.stringify(doc,null,2)+'\n');console.log(Object.keys(doc.paths).length+' documented paths');
