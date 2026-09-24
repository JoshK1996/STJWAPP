import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { createImportWorkbookTemplate, parseImportWorkbook, workbookImportColumns } from '../server/import-workbook-parser.mjs';
import { workbookConvertResultSchemaFor, workbookTemplateInput, workbookInspectInput } from '../shared/import-workbooks';
import { staffImportColumns } from '../shared/staff-imports';

const unit='10000000-0000-4000-8000-000000000001', job='10000000-0000-4000-8000-000000000002';
const values=['=Synthetic café, "name" 🕊','synthetic@example.test','employee',`${unit}|${job}`,job];
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const convert=(bytes:Uint8Array)=>parseImportWorkbook({schemaVersion:1,parserVersion:1,kind:'staff',action:'convert',bytes,sheetId:1,headerRow:1,expectedWorkbookHash:sha(bytes)});
async function filled(change?:(sheet:ExcelJS.Worksheet)=>void){
  const template=await createImportWorkbookTemplate('staff'), book=new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(template.bytes) as any);const sheet=book.worksheets[0];
  assert.equal(sheet.name,'New staff');assert.equal(sheet.getCell('E501').numFmt,'@');assert.equal(sheet.getCell('A2').value,null);
  values.forEach((value,index)=>{sheet.getCell(2,index+1).value=value;});change?.(sheet);
  return new Uint8Array(await book.xlsx.writeBuffer());
}
test('blank staff XLSX uses exact five columns and preserves literal identities through CSV',async()=>{
  assert.deepEqual(workbookImportColumns.staff,staffImportColumns);
  const bytes=await filled(), result=await convert(bytes);workbookConvertResultSchemaFor('staff').parse(result);
  assert.deepEqual(parse(result.csv,{bom:true,skip_empty_lines:true}),[[...staffImportColumns],values]);
  assert.deepEqual(result.rowMap,[{csvRow:2,worksheetRow:2}]);assert.equal(result.workbookHash,sha(bytes));
});
test('staff destination is strict and never accepts caller scope, credentials or template rows',()=>{
  for(const extra of [{unitId:unit},{assignmentId:job},{rows:[values]},{password:'not-a-credential'},{columns:['email']}]){
    assert.equal(workbookTemplateInput.safeParse({kind:'staff',...extra}).success,false);
    assert.equal(workbookInspectInput.safeParse({kind:'staff',base64:'eA==',...extra}).success,false);
  }
  assert.deepEqual(workbookTemplateInput.parse({kind:'staff'}),{kind:'staff'});
});
test('staff reordered, duplicate and extra data columns reject without discarding assignments',async()=>{
  for(const change of [
    (s:ExcelJS.Worksheet)=>{s.getCell('A1').value='email';s.getCell('B1').value='name';},
    (s:ExcelJS.Worksheet)=>{s.getCell('B1').value='name';},
    (s:ExcelJS.Worksheet)=>{s.getCell('F2').value='unexpected credential';},
  ])await assert.rejects(convert(await filled(change)),(e:any)=>e.code==='header_mismatch');
});
test('staff numeric, boolean, date and formula cells never become text or permissions',async()=>{
  for(const value of [123,true,new Date('2026-01-01T00:00:00Z'),{formula:'1+1',result:2}])
    await assert.rejects(convert(await filled(s=>{s.getCell('D2').value=value;})),(e:any)=>['non_text_cell','unsupported_feature'].includes(e.code));
});
test('staff workbook enforces record, row and total CSV bounds before publication',async()=>{
  await assert.rejects(convert(await filled(s=>{s.getCell('A2').value='é'.repeat(2100);})),(e:any)=>e.code==='limit');
  await assert.rejects(convert(await filled(s=>{for(let row=3;row<=502;row++)values.forEach((value,i)=>{s.getCell(row,i+1).value=value;});})),(e:any)=>e.code==='limit');
  await assert.rejects(convert(await filled(s=>{for(let row=2;row<=501;row++){values.forEach((value,i)=>{s.getCell(row,i+1).value=value;});s.getCell(row,1).value='x'.repeat(500);}})),(e:any)=>e.code==='limit');
});
