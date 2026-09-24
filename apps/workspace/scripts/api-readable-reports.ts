import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {payrollPresentationOptionsSchema} from '../shared/payroll-presentation';
import {financeViewSchema} from '../shared/finance-presentation';

// Keep the previously delivered readable export contracts on full regeneration.
const file='docs/openapi.json',doc=JSON.parse(await readFile(file,'utf8'));
const parameter=(name:string,schema:unknown,description:string)=>({name,in:'query',required:false,description,schema});
function append(path:string,parameters:unknown[],suffix=''){
  const operation=doc.paths[path].get;
  for(const value of parameters as any[]){operation.parameters=operation.parameters.filter((item:any)=>item.name!==value.name||item.in!=='query');operation.parameters.push(value);}
  if(suffix&&!operation.description.endsWith(suffix))operation.description+=suffix;
}
doc.components.schemas.PayrollPresentationOptions=z.toJSONSchema(payrollPresentationOptionsSchema,{io:'input'});
append('/payroll/hours/export',[parameter('presentation',{type:'string',maxLength:3000,contentMediaType:'application/json',contentSchema:{$ref:'#/components/schemas/PayrollPresentationOptions'}},'JSON object: title (1–100 characters), decimalPlaces (2,3,4), grouping (employees,jobs), sortBy (name,work_hours), columns (unique subset of workHours,breakHours,totalHours,shiftCount,ongoingSegmentCount; workHours required), includeAudit (boolean). CSV/XLSX only. Omit presentation entirely for the established exact export.')],
  ' Optional presentation selects a readable summary workbook or flat human-facing CSV. It never changes exact source values or pay policy. Readable Excel can append the original audit sheets.');
for(const path of ['/payroll/review/export','/reports/v2/export'])append(path,[parameter('presentation',{type:'string',enum:['exact','readable'],default:'exact'},'CSV only: readable labels, local timestamps and two-decimal hours. Source JSON rejects readable presentation.')]);
const finance=doc.paths['/finance/reports/{id}/versions/{version}'].get;
finance.parameters.find((value:any)=>value.name==='format').schema.enum=['json','csv','source','readable_csv'];
const view=z.toJSONSchema(financeViewSchema,{io:'input'}) as any;
append('/finance/reports/{id}/versions/{version}',[
  parameter('columns',{type:'string',maxLength:120},'Readable CSV only: comma-separated unique columns lineLabel,amount,group,rowKind,note,lineCode; label and amount required.'),
  ...(['search','group','rowKind','sort','decimalPlaces'] as const).map(name=>parameter(name,view.properties[name],({search:'Readable CSV: search report line names, codes, groups and notes.',group:'Readable CSV: exact group; omit for all, empty string for ungrouped.',rowKind:'Readable CSV line types.',sort:'Readable CSV row order.',decimalPlaces:'Readable display precision; source values stay unchanged.'})[name])),
], ' readable_csv reauthorizes the source, applies validated view options and audits the export. Rounded display sums do not certify bookkeeping or wages.');
append('/report-library/{id}/export',[
  parameter('presentation',{type:'string',enum:['exact','readable'],default:'exact'},'Readable CSV presentation; exact source CSV/JSON remains unchanged.'),
  parameter('decimals',{type:'integer',enum:[2,4],default:2},'Readable CSV decimal places.'),
  parameter('includeTechnical',{type:'string',enum:['true','false'],default:'false'},'Include internal ID/revision columns in readable CSV.'),
]);
doc.paths['/report-library/{id}/snapshots/{snapshotId}/export'].get.responses['200'].headers['X-Export-Format-Version'].schema.const=2;
await writeFile(file,JSON.stringify(doc,null,2)+'\n');
console.log('Readable export presentation contracts retained.');
