import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {DateTime} from 'luxon';
import {z} from 'zod';
import type {Database,Queryable} from './db';
import {audit,canReport,orgWide,requireCondition,type Actor} from './security';
import {withAuthorizedWorkforceSource,type WorkforceReportProof} from './workforce-report-access';
import {readAllowanceSource} from './workforce-overview';
import {allowanceSnapshotInput,allowanceSnapshotReceipt,allowanceSnapshotSchema,allowanceSnapshotListSchema,workforceOverviewQuerySchema,type AllowancePeriod,type AllowanceMetrics,type WorkforceOverviewQuery} from '../shared/workforce-overview';
import {payrollPresentationHours} from '../shared/payroll-presentation';
import {toCsv} from './reports';
import {xlsxText} from './report-snapshot-xlsx';
import {reportSheetColumnWidth,reportSheetText} from './report-sheet-layout';
import {periodAttention,type AttentionCounts} from '../shared/attention-policy';

const exact=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const access=(actor:Actor)=>requireCondition(canReport(actor),403,'Workforce reporting access required.');
const sameQuery=(left:unknown,right:WorkforceOverviewQuery)=>{
 const a=workforceOverviewQuerySchema.parse(left);return a.start===right.start&&a.end===right.end&&a.unitId===right.unitId&&a.userId===right.userId;
};
async function currentSource(tx:Queryable,actor:Actor,query:WorkforceOverviewQuery){
 access(actor);
 const meta=(await tx.query(`SELECT name,timezone,${exact('clock_timestamp()')} AS as_of FROM organizations WHERE id=$1`,[actor.org_id])).rows[0];requireCondition(meta,404,'Organization unavailable.');
 const source=await readAllowanceSource(tx,actor,query,meta.as_of);
 const units=[...new Set([...source.period.jobs.map(row=>row.unitId),...(query.unitId?[query.unitId]:[])])].sort();
 // Empty organization-wide captures are still restricted to the creator's reviewed unit scope.
 const unitIds=units.length?units:(orgWide(actor)?(await tx.query('SELECT id FROM units WHERE org_id=$1 ORDER BY id',[actor.org_id])).rows.map(row=>row.id):actor.unit_ids);
 return {source,unitIds,meta};
}
function scope(actor:Actor,units:string[]){requireCondition(orgWide(actor)||units.every(id=>actor.unit_ids.includes(id)),404,'This saved review is unavailable under your current access.');}
export async function saveAllowanceSnapshot(db:Database,supplied:Actor,proof:WorkforceReportProof,raw:unknown){
 const input=allowanceSnapshotInput.parse(raw);requireCondition(proof.mode==='password',403,'Use your password workspace to save a review.');
 return withAuthorizedWorkforceSource(db,supplied,proof,async(tx,actor)=>{
  access(actor);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.org_id+':allowance:'+input.commandId]);
  const previous=(await tx.query(`SELECT id,actor_id,query,unit_ids,${exact('created_at')} AS created_at FROM workforce_allowance_reviews WHERE org_id=$1 AND command_id=$2`,[actor.org_id,input.commandId])).rows[0];
  if(previous){requireCondition(previous.actor_id===actor.id&&sameQuery(previous.query,input.query),409,'This command was already used for another review.');scope(actor,previous.unit_ids);return allowanceSnapshotReceipt.parse({id:previous.id,createdAt:previous.created_at,replayed:true});}
  const {source,unitIds,meta}=await currentSource(tx,actor,input.query),id=randomUUID();
  const payload=allowanceSnapshotSchema.parse({id,createdAt:meta.as_of,createdByName:actor.name,asOf:meta.as_of,organizationName:meta.name,timezone:meta.timezone,period:source.period});
  requireCondition(Buffer.byteLength(JSON.stringify(source))<=16*1024*1024,400,'Choose a shorter period for a saved review.');
  const inserted=await tx.query('INSERT INTO workforce_allowance_reviews(id,org_id,actor_id,command_id,query,unit_ids,payload,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(org_id,command_id) DO NOTHING RETURNING id',[id,actor.org_id,actor.id,input.commandId,input.query,unitIds,payload,source,meta.as_of]);
  requireCondition(inserted.rows.length===1,503,'This review was captured concurrently. Retry the same unchanged command.');
  await audit(tx,actor,'workforce.allowance_review_saved',id,{query:input.query,asOf:meta.as_of,sourceSegments:source.report.rows.length,sourceSchedules:source.schedules.length});
  return allowanceSnapshotReceipt.parse({id,createdAt:meta.as_of,replayed:false});
 },async(_tx,_actor,result)=>result,{repeatableRead:true});
}
async function snapshotSource(tx:Queryable,actor:Actor,id:string){
 access(actor);const row=(await tx.query('SELECT payload,unit_ids FROM workforce_allowance_reviews WHERE org_id=$1 AND id=$2',[actor.org_id,z.uuid().parse(id)])).rows[0];requireCondition(row,404,'Saved review unavailable.');scope(actor,row.unit_ids);return allowanceSnapshotSchema.parse(row.payload);
}
export function getAllowanceSnapshot(db:Database,actor:Actor,proof:WorkforceReportProof,id:string){return withAuthorizedWorkforceSource(db,actor,proof,(tx,current)=>snapshotSource(tx,current,id),async(_tx,_current,result)=>result,{repeatableRead:true});}
export function listAllowanceSnapshots(db:Database,actor:Actor,proof:WorkforceReportProof){
 return withAuthorizedWorkforceSource(db,actor,proof,async(tx,current)=>{
  access(current);const rows=(await tx.query(`SELECT id,${exact('created_at')} AS created_at,payload->>'createdByName' AS name,payload->'period'->'jobs' AS jobs,payload->'period'->'people' AS people,query FROM workforce_allowance_reviews WHERE org_id=$1 AND ($2::boolean OR unit_ids <@ $3::uuid[]) ORDER BY created_at DESC,id DESC LIMIT 100`,[current.org_id,orgWide(current),current.unit_ids])).rows;
  return allowanceSnapshotListSchema.parse({snapshots:rows.map(row=>({id:row.id,createdAt:row.created_at,createdByName:row.name,start:row.query.start,end:row.query.end,...(row.query.unitId?{unitName:row.jobs.find((job:any)=>job.unitId===row.query.unitId)?.unitName??'Selected community'}:{}),...(row.query.userId?{employeeName:row.people.find((person:any)=>person.userId===row.query.userId)?.name??'Selected employee'}:{})}))});
 },async(_tx,_current,result)=>result,{repeatableRead:true});
}
type Document={organizationName:string;timezone:string;asOf:string;period:AllowancePeriod};
const labels=['Worked hours','Scheduled hours','Hours over schedule','Hours below schedule','Outside schedule hours','Break hours'];
const values=(value:AllowanceMetrics)=>[value.workMicroseconds,value.scheduledMicroseconds,value.aboveScheduledMicroseconds,value.belowScheduledMicroseconds,value.unscheduledWorkMicroseconds,value.breakMicroseconds].map(value=>payrollPresentationHours(value,2));
function allowanceRuleNotice(period:AllowancePeriod){
 if(!period.attention)return 'Historical review: no flag rules were captured. Original highlights identify any time over or outside schedule.';
 const rules=period.attention.policy.rules;
 const describe=(label:string,rule:typeof rules.overSchedule)=>`${label}: ${rule.enabled?`more than ${rule.afterMinutes} ${rule.afterMinutes===1?'minute':'minutes'} per employee per day`:'off'}`;
 return `Captured flag rules · ${describe('Over schedule',rules.overSchedule)} · ${describe('Outside schedule',rules.outsideSchedule)}. Flags change highlights only; all recorded hours stay visible.`;
}
function allowanceAttentionLabel(period:AllowancePeriod,counts:AttentionCounts){
 const names=[counts.overScheduleDays?`Over schedule${period.attention?`: ${counts.overScheduleDays} daily ${counts.overScheduleDays===1?'flag':'flags'}`:''}`:'',counts.outsideScheduleDays?`Outside schedule${period.attention?`: ${counts.outsideScheduleDays} daily ${counts.outsideScheduleDays===1?'flag':'flags'}`:''}`:''].filter(Boolean);
 return names.join('; ')||'No flags';
}
export async function renderAllowanceExport(document:Document,format:'csv'|'xlsx'){
 const {period}=document,ruleNotice=allowanceRuleNotice(period),headers=['Organization','Period start','Period end','Employee',...labels,'Attention','Flag rules'];
 const rows=period.people.map(row=>[document.organizationName,period.query.start,period.query.end,row.name,...values(row),allowanceAttentionLabel(period,periodAttention(period,{userId:row.userId})),ruleNotice]);
 if(format==='csv')return toCsv(rows.map(row=>Object.fromEntries(headers.map((name,index)=>[name,row[index]]))),headers);
 requireCondition(rows.length<=10_000&&period.jobs.length<=10_000,400,'Choose a shorter period or CSV for more than 10,000 employee or job rows.');
 const workbook=new ExcelJS.Workbook();workbook.creator='STJW';
 function sheet(name:string,headers:string[],data:(string|number)[][],numericFrom:number,flags?:AttentionCounts[]){
  const numericEnd=numericFrom+(flags?labels.length:headers.length-numericFrom);
  const tab=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:6,showGridLines:false}],pageSetup:{orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0},headerFooter:{oddFooter:'&LSTJW | Scheduled hours review&RPage &P of &N'}});
  tab.columns=headers.map((heading,index)=>({width:reportSheetColumnWidth(heading,data.map(row=>String(row[index])),index<numericFrom?30:index>=numericEnd?28:18,index<numericFrom?72:index>=numericEnd?34:20)}));
  const totalWidth=tab.columns.reduce((sum,column)=>sum+(column.width??18),0);
  const banner=(number:number,text:string,height:number,size=11)=>{tab.mergeCells(number,1,number,headers.length);const row=tab.getRow(number),layout=reportSheetText(text,totalWidth,size,height,409,'Source JSON');row.getCell(1).value=xlsxText(text);row.height=layout.lines===1?height:layout.height;row.getCell(1).font={name:'Aptos',size};row.getCell(1).alignment={wrapText:true,vertical:'middle',indent:1};};
  const title=document.organizationName+' · '+name;
  banner(1,title,42,20);tab.getRow(1).getCell(1).font={name:'Aptos',size:20,bold:true,color:{argb:'FFFFFFFF'}};tab.getRow(1).getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17304B'}};
  const localDate=(value:string)=>DateTime.fromISO(value).setLocale('en-US').toFormat('MMM d, yyyy');
  banner(2,`${localDate(period.query.start)} through ${localDate(period.query.end)} · ${document.timezone}`,25);
  banner(3,`Captured ${DateTime.fromISO(document.asOf,{zone:document.timezone}).setLocale('en-US').toFormat('MMM d, yyyy, h:mm:ss a ZZZZ')} · Hours rounded to two decimals after aggregation`,25);
  banner(4,period.notice,85);
  banner(5,ruleNotice+(name==='Jobs and communities'?' Job rows show contributions; daily flags appear on Employee summary and Daily review.':''),45,10);
  tab.getRow(5).getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F5FC'}};
  const headings=headers.map((value,index)=>reportSheetText(value,tab.columns[index].width??24,11,38,180,'Source JSON'));
  tab.getRow(6).values=headings.map(value=>xlsxText(value.text));tab.getRow(6).height=Math.max(...headings.map(value=>value.height));
  tab.getRow(6).eachCell(cell=>{cell.font={name:'Aptos',size:11,bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF245CB9'}};cell.alignment={wrapText:true,vertical:'middle'};});
  data.forEach((entry,index)=>{
   const text=entry.map((value,i)=>i<numericFrom||i>=numericEnd?reportSheetText(String(value).replace(/\s+/gu,' ').trim(),tab.columns[i].width??30,11,30,409,'Source JSON'):null);
   const row=tab.getRow(7+index);row.values=entry.map((value,i)=>text[i]?xlsxText(text[i]!.abbreviated?String(value):text[i]!.text):Number(value));row.height=Math.max(30,...text.map(value=>value?.height??0));
   row.eachCell((cell,col)=>{const flagged=Boolean(flags?.[index]&&((col===numericFrom+3&&flags[index].overScheduleDays)||(col===numericFrom+5&&flags[index].outsideScheduleDays)||(col>numericEnd&&(flags[index].overScheduleDays||flags[index].outsideScheduleDays))));cell.font={name:'Aptos',size:11,color:{argb:flagged?'FF9A5800':'FF17304B'},...(flagged?{bold:true}:{})};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:index%2?'FFF0F5FC':'FFFFFFFF'}};cell.alignment={wrapText:true,vertical:'middle',horizontal:col>numericFrom&&col<=numericEnd?'right':'left'};if(col>numericFrom&&col<=numericEnd)cell.numFmt='#,##0.00';});
  });
  if(!data.length)banner(7,'No matching time or scheduled shifts in this period.',34);
  tab.autoFilter={from:{row:6,column:1},to:{row:6+Math.max(data.length,1),column:headers.length}};tab.pageSetup.printTitlesRow='6:6';
 }
 const totalFlags=periodAttention(period),peopleFlags=period.people.map(row=>periodAttention(period,{userId:row.userId}));
 sheet('Employee summary',['Employee',...labels,'Attention'],[['All employees',...values(period.totals),allowanceAttentionLabel(period,totalFlags)],...period.people.map((row,index)=>[row.name,...values(row),allowanceAttentionLabel(period,peopleFlags[index])])],1,[totalFlags,...peopleFlags]);
 sheet('Jobs and communities',['Employee','Community','Job','Worked hours','Scheduled hours','Outside schedule hours','Break hours'],period.jobs.map(row=>[row.employeeName,row.unitName,row.jobTitle,...[row.workMicroseconds,row.scheduledMicroseconds,row.unscheduledWorkMicroseconds,row.breakMicroseconds].map(value=>payrollPresentationHours(value,2))]),3);
 const dayFlags=period.days.map(row=>periodAttention(period,{date:row.date}));
 sheet('Daily review',['Date',...labels,'Attention'],period.days.map((row,index)=>[row.date,...values(row),allowanceAttentionLabel(period,dayFlags[index])]),1,dayFlags);
 return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function exportAllowance(db:Database,actor:Actor,proof:WorkforceReportProof,raw:unknown,format:'csv'|'xlsx',snapshotId?:string){
 const query=snapshotId?null:workforceOverviewQuerySchema.parse(raw);
 return withAuthorizedWorkforceSource(db,actor,proof,async(tx,current):Promise<Document>=>{
  if(snapshotId)return snapshotSource(tx,current,snapshotId);
  const {source,meta}=await currentSource(tx,current,query!);return {period:source.period,organizationName:meta.name,timezone:meta.timezone,asOf:meta.as_of};
 },async(tx,current,document)=>{const body=await renderAllowanceExport(document,format);await audit(tx,current,'workforce.allowance_exported',snapshotId??null,{format,query:document.period.query,asOf:document.asOf});return {body,asOf:document.asOf,query:document.period.query};},{repeatableRead:true});
}
