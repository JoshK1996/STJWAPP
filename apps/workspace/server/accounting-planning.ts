import { randomUUID } from 'node:crypto';
import type { Express,Request } from 'express';
import { z } from 'zod';
import type { AppRequest } from './auth';
import type { Database,Queryable,Row } from './db';
import { audit,digest,requireCondition,Problem,type Actor } from './security';
import { accountingTransaction,lockAccounting,postJournalTx,reverseJournalTx,assertOpenPeriod } from './accounting-ledger';
import { parseAmount as exactAmount,formatAmount } from '../shared/accounting';
import { budgetInput,planningAction,payrollPlanningInput,earningUnits } from '../shared/accounting-planning';
import { readWorkforceReportSourceV2 } from './reports-v2';
import { buildPayrollHoursReport } from '../shared/payroll-hours';
import { payrollPresentationHours } from '../shared/payroll-presentation';
import { dateOnly } from '../shared/contracts';
import { toCsv } from './reports';

function parseAmount(value:string,precision:number){try{return exactAmount(value,precision);}catch(e){throw new Problem(400,(e as Error).message);}}
const day=(value:any)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const actorOf=(req:Request)=>(req as AppRequest).actor, proofOf=(req:Request)=>(req as AppRequest).sessionHash;
async function configured(tx:Queryable,actor:Actor,module:string){const c=await lockAccounting(tx,actor);requireCondition(c.configured,409,'Configure accounting before preparing records.');requireCondition(c.modules.includes(module),409,'Enable this accounting workflow in Settings first.');return c;}
async function account(tx:Queryable,actor:Actor,id:string,type?:string){const a=(await tx.query('SELECT * FROM accounting_accounts WHERE org_id=$1 AND id=$2',[actor.org_id,id])).rows[0];requireCondition(a?.active && (!type||a.type===type),400,'Select an active '+(type??'')+' account in this organization.');return a;}
async function fund(tx:Queryable,actor:Actor,id:string|null){if(id)requireCondition((await tx.query("SELECT id FROM accounting_funds WHERE org_id=$1 AND id=$2 AND active=true AND kind='fund'",[actor.org_id,id])).rows.length,400,'Select an active fund.');}
async function command(tx:Queryable,actor:Actor,key:string,input:unknown,operation:()=>Promise<any>){
 await configured(tx,actor,String((input as {operation:string}).operation).startsWith('budget.')?'budgets':'payroll');
 const fingerprint=digest(JSON.stringify(input)),old=(await tx.query('SELECT * FROM accounting_planning_commands WHERE org_id=$1 AND command_id=$2',[actor.org_id,key])).rows[0];
 if(old){requireCondition(old.actor_id===actor.id&&old.fingerprint===fingerprint,409,'This command was already used for a different request.');return old.receipt;}
 const result=await operation();await tx.query('INSERT INTO accounting_planning_commands(org_id,command_id,actor_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)',[actor.org_id,key,actor.id,fingerprint,JSON.stringify(result)]);return result;
}
const view=(r:Row)=>({id:r.id,name:r.name,version:r.version,status:r.status,periodId:r.period_id??null,start:r.starts_on?day(r.starts_on):null,end:r.ends_on?day(r.ends_on):null,payDate:r.pay_date?day(r.pay_date):null,payload:r.payload,createdAt:new Date(r.created_at).toISOString(),approvedAt:r.approved_at?new Date(r.approved_at).toISOString():null,journalId:r.journal_id??null,paymentJournalId:r.payment_journal_id??null,sourceHash:r.source_hash??null});
export async function listAccountingBudgets(db:Database,actor:Actor,proof:string|undefined){return accountingTransaction(db,actor,proof,async(tx,a)=>{await configured(tx,a,'budgets');const rows=(await tx.query('SELECT * FROM accounting_budgets WHERE org_id=$1 ORDER BY created_at DESC LIMIT 501',[a.org_id])).rows;requireCondition(rows.length<=500,409,'Budget archive exceeds this view limit. Export or narrow the archive before continuing.');return {rows:rows.map(view)};});}
export async function createAccountingBudget(db:Database,actor:Actor,proof:string|undefined,raw:unknown){const input=budgetInput.parse(raw);return accountingTransaction(db,actor,proof,async(tx,a)=>command(tx,a,input.commandId,{operation:'budget.create',input},async()=>{
 const c=await configured(tx,a,'budgets'),p=(await tx.query('SELECT * FROM accounting_periods WHERE org_id=$1 AND id=$2',[a.org_id,input.periodId])).rows[0];requireCondition(p&&p.status==='open',409,'Choose an open accounting period.');const seen=new Set<string>();
 const lines=[];for(const l of input.lines){const acc=await account(tx,a,l.accountId);requireCondition(['revenue','expense'].includes(acc.type),400,'Budgets use revenue and expense accounts.');await fund(tx,a,l.fundId);const k=l.accountId+':'+l.fundId;requireCondition(!seen.has(k),400,'Combine duplicate account/fund budget lines.');seen.add(k);const units=parseAmount(l.amount,c.precision);requireCondition(units>=0n,400,'Use a nonnegative budget.');lines.push({...l,amount:formatAmount(units,c.precision),accountCode:acc.code,accountName:acc.name,accountType:acc.type});}
 const id=randomUUID(),payload={currency:c.currency,precision:c.precision,period:{id:p.id,name:p.name,start:day(p.starts_on),end:day(p.ends_on)},lines};const r=(await tx.query("INSERT INTO accounting_budgets(id,org_id,name,period_id,status,payload,created_by,reason) VALUES($1,$2,$3,$4,'draft',$5,$6,$7) RETURNING *",[id,a.org_id,input.name,p.id,JSON.stringify(payload),a.id,input.reason])).rows[0];await audit(tx,a,'accounting.budget_created',id,{reason:input.reason,lines:lines.length});return view(r);
}));}
export async function actOnAccountingBudget(db:Database,actor:Actor,proof:string|undefined,id:string,action:'approve'|'void',raw:unknown){const input=planningAction.parse(raw);return accountingTransaction(db,actor,proof,async(tx,a)=>command(tx,a,input.commandId,{operation:'budget.'+action,id,input},async()=>{
 await configured(tx,a,'budgets');const r=(await tx.query('SELECT * FROM accounting_budgets WHERE org_id=$1 AND id=$2 FOR UPDATE',[a.org_id,id])).rows[0];requireCondition(r,404,'Budget not found.');requireCondition(r.version===input.expectedVersion&&r.status!=='voided'&&(action==='void'||r.status==='draft'),409,'Budget changed. Reload before reviewing.');
 if(action==='approve'){requireCondition((await tx.query("SELECT id FROM accounting_periods WHERE org_id=$1 AND id=$2 AND status='open'",[a.org_id,r.period_id])).rows.length,409,'This period is closed.');for(const line of r.payload.lines){const current=await account(tx,a,line.accountId);requireCondition(current.type===line.accountType,409,'A budget account was reclassified. Void this draft and prepare a new budget.');await fund(tx,a,line.fundId);}}
 const out=(await tx.query('UPDATE accounting_budgets SET status=$3,version=version+1,reason=$4,approved_by=CASE WHEN $3=\'approved\' THEN $5 ELSE approved_by END,approved_at=CASE WHEN $3=\'approved\' THEN now() ELSE approved_at END WHERE org_id=$1 AND id=$2 RETURNING *',[a.org_id,id,action==='approve'?'approved':'voided',input.reason,a.id])).rows[0];await audit(tx,a,'accounting.budget_'+action,id,{reason:input.reason,version:out.version});return view(out);
}));}
export async function accountingBudgetReport(db:Database,actor:Actor,proof:string|undefined,id:string,asCsv=false){return accountingTransaction(db,actor,proof,async(tx,a)=>{
 const c=await configured(tx,a,'budgets'),r=(await tx.query('SELECT * FROM accounting_budgets WHERE org_id=$1 AND id=$2',[a.org_id,id])).rows[0];requireCondition(r,404,'Budget not found.');const p=r.payload.period;
 for(const line of r.payload.lines){const current=(await tx.query('SELECT type FROM accounting_accounts WHERE org_id=$1 AND id=$2',[a.org_id,line.accountId])).rows[0];requireCondition(current?.type===line.accountType,409,'A budget account was reclassified. Review and replace this budget before comparing actuals.');}
 const actual=(await tx.query("SELECT l.account_id,l.fund_id,sum(l.debit-l.credit)::text AS balance FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id AND j.org_id=l.org_id WHERE l.org_id=$1 AND j.status='posted' AND j.entry_date BETWEEN $2::date AND $3::date GROUP BY l.account_id,l.fund_id",[a.org_id,p.start,p.end])).rows;
 const funds=(await tx.query('SELECT id,name FROM accounting_funds WHERE org_id=$1',[a.org_id])).rows;
 const rows=r.payload.lines.map((l:any)=>{const sign=l.accountType==='revenue'?-1n:1n,budget=parseAmount(l.amount,c.precision),value=actual.filter(x=>x.account_id===l.accountId&&(l.fundId===null?x.fund_id===null:x.fund_id===l.fundId)).reduce((sum,x)=>sum+BigInt(x.balance)*sign,0n);return {accountId:l.accountId,accountCode:l.accountCode,accountName:l.accountName,accountType:l.accountType,fundName:funds.find(x=>x.id===l.fundId)?.name??'Unassigned fund',budget:l.amount,actual:formatAmount(value,c.precision),variance:formatAmount(value-budget,c.precision)};});
 const report={budget:view(r),rows,currency:c.currency,precision:c.precision,notice:'Variance is actual minus budget. Only the exact budget account/fund combinations are included. An unassigned fund is not an all-funds total.'};
 if(asCsv){await audit(tx,a,'accounting.budget_exported',id,{version:r.version});return toCsv(rows.map((x:any)=>({'Account':x.accountName,'Fund':x.fundName,'Budget':x.budget,'Actual':x.actual,'Actual minus budget':x.variance,'Currency':c.currency})),['Account','Fund','Budget','Actual','Actual minus budget','Currency']);}return report;
});}

async function clockEvidence(tx:Queryable,actor:Actor,start:string,end:string,userIds:string[]){
 const report=buildPayrollHoursReport(await readWorkforceReportSourceV2(tx,actor,{start,end}));
 const selected=new Set(userIds),rows=report.report.rows.filter(r=>selected.has(r.user_id)).sort((a,b)=>a.id.localeCompare(b.id));
 requireCondition(rows.every(r=>r.ended_at!==null),409,'Close ongoing time segments before preparing this payroll period.');
 const employees=report.employees.filter(e=>selected.has(e.userId));return {start,end,rows,employees,hash:digest(JSON.stringify({start,end,rows})),capturedAt:new Date().toISOString()};
}
export async function accountingPayrollOptions(db:Database,actor:Actor,proof:string|undefined){return accountingTransaction(db,actor,proof,async(tx,a)=>{await configured(tx,a,'payroll');const employees=(await tx.query('SELECT id,name FROM users WHERE org_id=$1 AND active=true ORDER BY name,id LIMIT 1001',[a.org_id])).rows;requireCondition(employees.length<=1000,409,'Narrow staff selection before preparing payroll.');return {employees};});}
export async function listAccountingPayroll(db:Database,actor:Actor,proof:string|undefined){return accountingTransaction(db,actor,proof,async(tx,a)=>{await configured(tx,a,'payroll');const rows=(await tx.query('SELECT * FROM accounting_payroll_runs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 501',[a.org_id])).rows;requireCondition(rows.length<=500,409,'Payroll archive exceeds this view limit.');return {rows:rows.map(view)};});}
export async function createAccountingPayroll(db:Database,actor:Actor,proof:string|undefined,raw:unknown){
 const input=payrollPlanningInput.parse(raw),ids=input.employees.map(e=>e.userId);requireCondition(new Set(ids).size===ids.length,400,'Include each employee once.');
 return accountingTransaction(db,actor,proof,async(tx,a)=>command(tx,a,input.commandId,{operation:'payroll.create',input},async()=>{
  const c=await configured(tx,a,'payroll'),evidence=await clockEvidence(tx,a,input.start,input.end,ids);await account(tx,a,input.payableAccountId,'liability');let gross=0n,withheld=0n,costs=0n;const employees=[];
  for(const employee of input.employees){const user=(await tx.query('SELECT id,name FROM users WHERE org_id=$1 AND id=$2 AND active=true',[a.org_id,employee.userId])).rows[0];requireCondition(user,400,'Select an active employee in this organization.');let eg=0n,ed=0n,ec=0n;const earnings=[];
   for(const earning of employee.earnings){await account(tx,a,earning.expenseAccountId,'expense');await fund(tx,a,earning.fundId);const units=earningUnits(earning.quantity,earning.rate,c.precision);requireCondition(units>0n,400,'Each earning must be positive.');parseAmount(formatAmount(units,c.precision),c.precision);eg+=units;earnings.push({...earning,amount:formatAmount(units,c.precision)});}
   for(const deduction of employee.deductions){await account(tx,a,deduction.liabilityAccountId,'liability');const units=parseAmount(deduction.amount,c.precision);requireCondition(units>0n,400,'Deductions must be positive.');ed+=units;}
   for(const cost of employee.employerCosts){await account(tx,a,cost.expenseAccountId,'expense');await account(tx,a,cost.liabilityAccountId,'liability');const units=parseAmount(cost.amount,c.precision);requireCondition(units>0n,400,'Employer costs must be positive.');ec+=units;}
   requireCondition(ed<=eg,400,'Employee deductions cannot exceed gross earnings.');gross+=eg;withheld+=ed;costs+=ec;
   employees.push({...employee,name:user.name,earnings,gross:formatAmount(eg,c.precision),deductionsTotal:formatAmount(ed,c.precision),net:formatAmount(eg-ed,c.precision),employerCostsTotal:formatAmount(ec,c.precision),recordedWorkHours:evidence.employees.find(e=>e.userId===user.id)?.workHours??'0.000000',recordedWorkMicroseconds:evidence.employees.find(e=>e.userId===user.id)?.workMicroseconds??'0'});
  }
  for(const value of [gross,withheld,costs])parseAmount(formatAmount(value,c.precision),c.precision);
  const id=randomUUID(),payload={currency:c.currency,precision:c.precision,basis:c.basis,payableAccountId:input.payableAccountId,employees,evidence,totals:{gross:formatAmount(gross,c.precision),deductions:formatAmount(withheld,c.precision),net:formatAmount(gross-withheld,c.precision),employerCosts:formatAmount(costs,c.precision)},notice:'Prepared from explicitly entered earnings, deductions and employer costs. Tax amounts and wage rules are supplied by the accountant; the app does not calculate statutory withholding or determine legal pay entitlement. Each earning is rounded half up after exact quantity × rate calculation.'};
  const r=(await tx.query("INSERT INTO accounting_payroll_runs(id,org_id,name,starts_on,ends_on,pay_date,status,payload,source_hash,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10) RETURNING *",[id,a.org_id,input.name,input.start,input.end,input.payDate,JSON.stringify(payload),evidence.hash,a.id,input.reason])).rows[0];await audit(tx,a,'accounting.payroll_prepared',id,{sourceHash:evidence.hash,employees:employees.length,reason:input.reason});return view(r);
 }));
}
/** Largest-remainder allocation in exact currency units; stable fund order resolves equal remainders. */
export function allocatePayrollAmount(amount:bigint,weights:Map<string,bigint>):Map<string,bigint>{
 const total=[...weights.values()].reduce((a,b)=>a+b,0n);requireCondition(amount>=0n&&amount<=total,400,'Allocation exceeds remaining earnings.');
 if(!total)return new Map([...weights.keys()].map(key=>[key,0n]));
 const shares=[...weights].map(([key,value])=>({key,units:amount*value/total,remainder:amount*value%total})).sort((a,b)=>a.remainder===b.remainder?a.key.localeCompare(b.key):a.remainder>b.remainder?-1:1);
 let residual=amount-shares.reduce((sum,x)=>sum+x.units,0n);for(const part of shares){if(!residual)break;part.units++;residual--;}
 return new Map(shares.map(x=>[x.key,x.units]));
}
const payrollAction=planningAction.extend({date:dateOnly.optional(),cashAccountId:z.uuid().optional()});
async function validatePayrollAccounts(tx:Queryable,a:Actor,payload:any){
 await account(tx,a,payload.payableAccountId,'liability');
 for(const employee of payload.employees){for(const line of employee.earnings){await account(tx,a,line.expenseAccountId,'expense');await fund(tx,a,line.fundId);}for(const line of employee.deductions)await account(tx,a,line.liabilityAccountId,'liability');for(const line of employee.employerCosts){await account(tx,a,line.expenseAccountId,'expense');await account(tx,a,line.liabilityAccountId,'liability');}}
}
export async function actOnAccountingPayroll(db:Database,actor:Actor,proof:string|undefined,id:string,action:'approve'|'post'|'pay'|'void',raw:unknown){
 const input=payrollAction.parse(raw);
 return accountingTransaction(db,actor,proof,async(tx,a)=>command(tx,a,input.commandId,{operation:'payroll.'+action,id,input},async()=>{
  const c=await configured(tx,a,'payroll'),r=(await tx.query('SELECT * FROM accounting_payroll_runs WHERE org_id=$1 AND id=$2 FOR UPDATE',[a.org_id,id])).rows[0];requireCondition(r,404,'Payroll preparation not found.');requireCondition(r.version===input.expectedVersion&&r.status!=='voided',409,'Payroll preparation changed. Reload before reviewing.');
  let status=r.status,journalId=r.journal_id,paymentId=r.payment_journal_id;const payload=r.payload,zero=formatAmount(0n,c.precision);
  if(action!=='void')await validatePayrollAccounts(tx,a,payload);
  if(action==='approve'){
   requireCondition(r.status==='draft',409,'Only a draft can be approved.');const evidence=await clockEvidence(tx,a,day(r.starts_on),day(r.ends_on),r.payload.employees.map((e:any)=>e.userId));requireCondition(evidence.hash===r.source_hash,409,'Time records changed. Void this draft and prepare a fresh run.');
   const overlaps=(await tx.query("SELECT payload FROM accounting_payroll_runs WHERE org_id=$1 AND id<>$2 AND status IN('approved','posted','paid') AND starts_on<=$4::date AND ends_on>=$3::date",[a.org_id,id,r.starts_on,r.ends_on])).rows;
   const users=new Set(payload.employees.map((e:any)=>e.userId));requireCondition(!overlaps.some(x=>x.payload.employees.some((e:any)=>users.has(e.userId))),409,'An approved payroll already covers an employee in this date range.');status='approved';
  }else if(action==='post'||action==='pay'){
   const pay=action==='pay';requireCondition(pay?(c.basis==='cash'?r.status==='approved':r.status==='posted'):r.status==='approved'&&c.basis==='accrual',409,pay?'Approve/post payroll before recording payment.':'Accrual payroll must be approved before posting. Cash-basis payroll posts when payment is recorded.');
   if(pay){requireCondition(input.date&&input.cashAccountId,400,'Supply the actual payment date and cash account.');requireCondition(input.date>=day(r.pay_date),400,'Payment date cannot precede the reviewed pay date.');await assertOpenPeriod(tx,a,input.date);}
   const lines:any[]=[];let creditAccount=payload.payableAccountId;
   if(pay){const cash=await account(tx,a,input.cashAccountId!,'asset');requireCondition(cash.is_cash,400,'Select a cash account.');creditAccount=cash.id;}
   for(const e of payload.employees){
    const remaining=new Map<string,bigint>();for(const earning of e.earnings){const fund=earning.fundId??'';remaining.set(fund,(remaining.get(fund)??0n)+parseAmount(earning.amount,c.precision));}
    const deductionLines:any[]=[];
    for(const deduction of e.deductions){const amount=parseAmount(deduction.amount,c.precision),allocations=allocatePayrollAmount(amount,remaining);for(const [fund,units] of allocations){remaining.set(fund,remaining.get(fund)!-units);if(units)deductionLines.push({accountId:deduction.liabilityAccountId,debit:zero,credit:formatAmount(units,c.precision),...(fund?{fundId:fund}:{}),memo:deduction.label});}}
    if(pay&&c.basis==='accrual'){
     for(const [fund,units] of remaining)if(units){const dimensions=fund?{fundId:fund}:{};lines.push({accountId:payload.payableAccountId,debit:formatAmount(units,c.precision),credit:zero,...dimensions},{accountId:creditAccount,debit:zero,credit:formatAmount(units,c.precision),...dimensions});}
    }else{
     for(const earning of e.earnings)lines.push({accountId:earning.expenseAccountId,debit:earning.amount,credit:zero,...(earning.fundId?{fundId:earning.fundId}:{}),memo:e.name+' · '+earning.label});
     lines.push(...deductionLines);
     for(const cost of e.employerCosts)lines.push({accountId:cost.expenseAccountId,debit:cost.amount,credit:zero,memo:cost.label},{accountId:cost.liabilityAccountId,debit:zero,credit:cost.amount,memo:cost.label});
     for(const [fund,units] of remaining)if(units)lines.push({accountId:creditAccount,debit:zero,credit:formatAmount(units,c.precision),...(fund?{fundId:fund}:{}),memo:e.name+' · net pay'});
    }
   }
   const grouped=new Map<string,any>();for(const line of lines){const key=line.accountId+':'+(line.fundId??'')+':'+(parseAmount(line.debit,c.precision)>0n?'debit':'credit'),found=grouped.get(key);if(found){found.debit=formatAmount(parseAmount(found.debit,c.precision)+parseAmount(line.debit,c.precision),c.precision);found.credit=formatAmount(parseAmount(found.credit,c.precision)+parseAmount(line.credit,c.precision),c.precision);}else grouped.set(key,{...line,memo:'Payroll summary; employee detail retained in reviewed run'});}requireCondition(grouped.size<=200,400,'Split payroll into smaller runs with at most 200 account/fund posting lines.');
   if(lines.length){const journal=await postJournalTx(tx,a,{id:randomUUID(),date:pay?input.date!:day(r.pay_date),description:r.name+(pay?' · recorded payment':' · payroll accrual'),reference:input.reason.slice(0,120),sourceType:pay?'payroll_payment':'payroll',sourceId:id,lines:[...grouped.values()],commandId:randomUUID()});if(pay)paymentId=journal.id;else journalId=journal.id;}
   status=pay?'paid':'posted';
  }else{
   if(r.journal_id||r.payment_journal_id){requireCondition(input.date,400,'Choose a reversal date in an open period.');for(const jid of [r.payment_journal_id,r.journal_id].filter(Boolean)){const j=(await tx.query('SELECT revision FROM accounting_journals WHERE org_id=$1 AND id=$2',[a.org_id,jid])).rows[0];await reverseJournalTx(tx,a,{id:jid,date:input.date!,reason:input.reason,commandId:randomUUID(),expectedRevision:j.revision});}}
   status='voided';
  }
  const out=(await tx.query("UPDATE accounting_payroll_runs SET status=$3,version=version+1,reason=$4,approved_by=CASE WHEN $3='approved' THEN $5 ELSE approved_by END,approved_at=CASE WHEN $3='approved' THEN now() ELSE approved_at END,journal_id=$6,payment_journal_id=$7 WHERE org_id=$1 AND id=$2 RETURNING *",[a.org_id,id,status,input.reason,a.id,journalId,paymentId])).rows[0];await audit(tx,a,'accounting.payroll_'+action,id,{version:out.version,reason:input.reason});return view(out);
 }));
}
export async function exportAccountingPayroll(db:Database,actor:Actor,proof:string|undefined,id:string){return accountingTransaction(db,actor,proof,async(tx,a)=>{await configured(tx,a,'payroll');const r=(await tx.query('SELECT * FROM accounting_payroll_runs WHERE org_id=$1 AND id=$2',[a.org_id,id])).rows[0];requireCondition(r,404,'Payroll preparation not found.');await audit(tx,a,'accounting.payroll_exported',id,{version:r.version,status:r.status});return toCsv(r.payload.employees.map((e:any)=>({'Employee':e.name,'Period start':day(r.starts_on),'Period end':day(r.ends_on),'Pay date':day(r.pay_date),'Recorded work hours':payrollPresentationHours(e.recordedWorkMicroseconds,2),'Gross earnings':e.gross,'Entered deductions':e.deductionsTotal,'Net pay':e.net,'Employer costs':e.employerCostsTotal,'Currency':r.payload.currency,'Review status':r.status})),['Employee','Period start','Period end','Pay date','Recorded work hours','Gross earnings','Entered deductions','Net pay','Employer costs','Currency','Review status']);});}
export function registerAccountingPlanningRoutes(app:Express,db:Database){
 app.get('/api/accounting/budgets',async(req,res)=>res.json(await listAccountingBudgets(db,actorOf(req),proofOf(req))));
 app.post('/api/accounting/budgets',async(req,res)=>res.status(201).json(await createAccountingBudget(db,actorOf(req),proofOf(req),req.body)));
 for(const action of ['approve','void'] as const)app.post('/api/accounting/budgets/:id/'+action,async(req,res)=>res.json(await actOnAccountingBudget(db,actorOf(req),proofOf(req),z.uuid().parse(req.params.id),action,req.body)));
 app.get('/api/accounting/budgets/:id/report',async(req,res)=>{const csv=z.enum(['json','csv']).default('json').parse(req.query.format)==='csv';const result=await accountingBudgetReport(db,actorOf(req),proofOf(req),z.uuid().parse(req.params.id),csv);if(csv)res.type('text/csv').attachment('budget-comparison.csv').send(result);else res.json(result);});
 app.get('/api/accounting/payroll/options',async(req,res)=>res.json(await accountingPayrollOptions(db,actorOf(req),proofOf(req))));
 app.get('/api/accounting/payroll',async(req,res)=>res.json(await listAccountingPayroll(db,actorOf(req),proofOf(req))));
 app.post('/api/accounting/payroll',async(req,res)=>res.status(201).json(await createAccountingPayroll(db,actorOf(req),proofOf(req),req.body)));
 for(const action of ['approve','post','pay','void'] as const)app.post('/api/accounting/payroll/:id/'+action,async(req,res)=>res.json(await actOnAccountingPayroll(db,actorOf(req),proofOf(req),z.uuid().parse(req.params.id),action,req.body)));
 app.get('/api/accounting/payroll/:id/export',async(req,res)=>res.type('text/csv').attachment('reviewed-payroll.csv').send(await exportAccountingPayroll(db,actorOf(req),proofOf(req),z.uuid().parse(req.params.id))));
}
