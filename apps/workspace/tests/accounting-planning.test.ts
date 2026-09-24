import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {issueSetup,digest,type Actor} from '../server/security';
import {accountingTransaction,saveAccountingConfig,saveAccountingAccount,createAccountingPeriod,postJournalTx} from '../server/accounting-ledger';
import {createAccountingBudget,actOnAccountingBudget,accountingBudgetReport,createAccountingPayroll,actOnAccountingPayroll,exportAccountingPayroll,allocatePayrollAmount} from '../server/accounting-planning';
import {earningUnits} from '../shared/accounting-planning';
let db:Database,actor:Actor,hash:string,cookie:string,csrf:string,period:string,expense:string,revenue:string,cash:string,payable:string,tax:string;
const origin='http://localhost:3189',reason='Synthetic accountant review';
const run=<T>(fn:(tx:Queryable,a:Actor)=>Promise<T>)=>accountingTransaction(db,actor,hash,fn);
before(async()=>{
 db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'planning.owner@example.test'});const u=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];actor={id:u.id,org_id:u.org_id,name:u.name,email:u.email,role:u.role,mode:'password',unit_ids:[]};
 const app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:false}),token=await db.transaction(tx=>issueSetup(tx,actor)),password='Synthetic-'+randomUUID();
 assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);const auth=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(auth.status,200);cookie=(auth.headers['set-cookie'] as unknown as string[])[0].split(';')[0];hash=digest(cookie.slice(cookie.indexOf('=')+1));csrf=(await request(app).get('/api/me').set('Cookie',cookie)).body.actor.csrf;
 await run((tx,a)=>saveAccountingConfig(tx,a,{expectedRevision:0,currency:'USD',precision:2,basis:'accrual',fiscalStartMonth:1,fiscalStartDay:1,modules:['ledger','budgets','payroll']}));
 const account=async(code:string,type:string,isCash=false)=>{const id=randomUUID();await run((tx,a)=>saveAccountingAccount(tx,a,{id,expectedRevision:0,code,name:'Synthetic '+code,type,isCash,cashFlowCategory:'operating',functionalCategory:'management',active:true}));return id;};
 expense=await account('5000','expense');revenue=await account('4000','revenue');cash=await account('1000','asset',true);payable=await account('2100','liability');tax=await account('2200','liability');period=randomUUID();await run((tx,a)=>createAccountingPeriod(tx,a,{id:period,name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31'}));
});
after(async()=>{await db?.close();});
const action=(version:number)=>({commandId:randomUUID(),expectedVersion:version,reason,reviewed:true as const});
function payroll(start='2026-01-01',end='2026-01-15'){return {commandId:randomUUID(),name:'Synthetic payroll',start,end,payDate:end,reason,payableAccountId:payable,employees:[{userId:actor.id,earnings:[{label:'Reviewed hours',quantity:'2.5',rate:'12.3456',expenseAccountId:expense,fundId:null}],deductions:[{label:'Accountant entered withholding',amount:'5.00',liabilityAccountId:tax}],employerCosts:[{label:'Entered employer cost',amount:'2.00',expenseAccountId:expense,liabilityAccountId:tax}]}]};}
test('payroll quantity and rates use integer arithmetic and explicit final earning rounding',()=>{assert.equal(earningUnits('2.5','12.3456',2),3086n);assert.equal(earningUnits('0.5','0.01',2),1n);assert.equal(earningUnits('1000000.000001','999999999999.9999',4),9999999999999999000000n+10000000000n);assert.throws(()=>earningUnits('1e2','1',2));assert.throws(()=>earningUnits('1','1',-1));});
test('budget approval and exact variance reflect only posted activity and retain immutable input',async()=>{
 const input={commandId:randomUUID(),name:'Synthetic budget',periodId:period,reason,lines:[{accountId:expense,fundId:null,amount:'100.00'}]},b=await createAccountingBudget(db,actor,hash,input);assert.deepEqual(await createAccountingBudget(db,actor,hash,input),b);
 await run((tx,a)=>postJournalTx(tx,a,{id:randomUUID(),commandId:randomUUID(),date:'2026-02-01',description:'Synthetic expense',lines:[{accountId:expense,debit:'12.30',credit:'0.00'},{accountId:cash,debit:'0.00',credit:'12.30'}]}));
 const approved=await actOnAccountingBudget(db,actor,hash,b.id,'approve',action(b.version));assert.equal(approved.status,'approved');const report:any=await accountingBudgetReport(db,actor,hash,b.id);assert.equal(report.rows[0].actual,'12.30');assert.equal(report.rows[0].variance,'-87.70');
 const csv=await accountingBudgetReport(db,actor,hash,b.id,true);assert.match(csv as string,/Actual minus budget/);assert.match(csv as string,/Synthetic 5000/);await assert.rejects(db.query("UPDATE accounting_budgets SET payload='{}' WHERE id=$1",[b.id]),/immutable/);
 await assert.rejects(actOnAccountingBudget(db,actor,hash,b.id,'void',action(1)),/changed/);
});
test('payroll exact earnings/net, approval, accrual, payment, reversal and duplicate retry stay balanced',async()=>{
 const input=payroll(),draft=await createAccountingPayroll(db,actor,hash,input);assert.equal(draft.payload.totals.gross,'30.86');assert.equal(draft.payload.totals.net,'25.86');assert.deepEqual(await createAccountingPayroll(db,actor,hash,input),draft);
 const approved=await actOnAccountingPayroll(db,actor,hash,draft.id,'approve',action(draft.version)),post=action(approved.version),posted=await actOnAccountingPayroll(db,actor,hash,draft.id,'post',post);assert.equal(posted.status,'posted');assert.deepEqual(await actOnAccountingPayroll(db,actor,hash,draft.id,'post',post),posted);
 const paid=await actOnAccountingPayroll(db,actor,hash,draft.id,'pay',{...action(posted.version),date:'2026-01-16',cashAccountId:cash});assert.equal(paid.status,'paid');assert.ok(paid.paymentJournalId);
 const totals=(await db.query("SELECT sum(l.debit)::text AS debit,sum(l.credit)::text AS credit FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.source_id=$1",[draft.id])).rows[0];assert.equal(totals.debit,totals.credit);
 const csv=await exportAccountingPayroll(db,actor,hash,draft.id);assert.match(csv,/30.86/);assert.match(csv,/25.86/);assert.match(csv,/paid/);
 const voided=await actOnAccountingPayroll(db,actor,hash,draft.id,'void',{...action(paid.version),date:'2026-01-17'});assert.equal(voided.status,'voided');assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journals WHERE reversal_of=ANY($1::uuid[])',[[posted.journalId,paid.paymentJournalId]])).rows[0].n,2);
});
test('deductions above gross, foreign staff and wrong account kinds are rejected',async()=>{
 const over=payroll('2026-02-01','2026-02-15');over.employees[0].deductions[0].amount='99.00';await assert.rejects(createAccountingPayroll(db,actor,hash,over),/exceed/);
 const missing=payroll('2026-02-01','2026-02-15');missing.employees[0].userId=randomUUID();await assert.rejects(createAccountingPayroll(db,actor,hash,missing),/active employee/);
 const wrong=payroll('2026-02-01','2026-02-15');wrong.payableAccountId=expense;await assert.rejects(createAccountingPayroll(db,actor,hash,wrong),/liability account/);
});
test('overlapping approved employee periods are blocked and stale revisions cannot approve',async()=>{
 const one=await createAccountingPayroll(db,actor,hash,payroll('2026-03-01','2026-03-15')),two=await createAccountingPayroll(db,actor,hash,payroll('2026-03-10','2026-03-20'));
 await actOnAccountingPayroll(db,actor,hash,one.id,'approve',action(one.version));await assert.rejects(actOnAccountingPayroll(db,actor,hash,two.id,'approve',action(two.version)),/already covers/);await assert.rejects(actOnAccountingPayroll(db,actor,hash,one.id,'post',action(one.version)),/changed/);
});
test('concurrent idempotent creation produces one payroll run and failed audit rolls back all evidence',async()=>{
 const input=payroll('2026-04-01','2026-04-15'),[a,b]=await Promise.all([createAccountingPayroll(db,actor,hash,input),createAccountingPayroll(db,actor,hash,input)]);assert.equal(a.id,b.id);
 const broken:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{if(sql.startsWith('INSERT INTO audit_events')&&params?.[3]==='accounting.payroll_prepared')throw new Error('synthetic audit failure');return tx.query(sql,params);}}))};
 const fail=payroll('2026-05-01','2026-05-15');await assert.rejects(createAccountingPayroll(broken,actor,hash,fail),/audit failure/);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_planning_commands WHERE command_id=$1',[fail.commandId])).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int n FROM accounting_payroll_runs WHERE starts_on='2026-05-01'")).rows[0].n,0);
});
test('HTTP planning writes require CSRF and current financial authority, reads deny anonymous',async()=>{
 const app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:false});assert.equal((await request(app).get('/api/accounting/payroll')).status,401);
 assert.equal((await request(app).post('/api/accounting/payroll').set('Origin',origin).set('Cookie',cookie).send(payroll())).status,403);
 await db.query("UPDATE users SET role='employee' WHERE id=$1",[actor.id]);try{assert.equal((await request(app).get('/api/accounting/payroll').set('Cookie',cookie)).status,403);assert.equal((await request(app).post('/api/accounting/budgets').set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',csrf).send({commandId:randomUUID(),name:'Denied',periodId:period,reason,lines:[{accountId:expense,fundId:null,amount:'1.00'}]})).status,403);}finally{await db.query("UPDATE users SET role='owner' WHERE id=$1",[actor.id]);}
});
test('payroll fund allocations preserve exact totals, zero weights, and deterministic residual units',()=>{
 const result=allocatePayrollAmount(5n,new Map([['b',5n],['a',5n],['zero',0n]]));assert.equal(result.get('a'),3n);assert.equal(result.get('b'),2n);assert.equal(result.get('zero'),0n);assert.equal([...result.values()].reduce((a,b)=>a+b),5n);assert.throws(()=>allocatePayrollAmount(11n,new Map([['a',10n]])),/exceeds/);
});
test('cash-basis payroll moves directly from approval to paid and records exact costs only at payment',async()=>{
 const org=randomUUID(),user=randomUUID(),proof=digest(randomUUID());await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic cash organization','UTC')",[org]);await db.query("INSERT INTO users(id,org_id,name,email,role,active) VALUES($1,$2,'Synthetic cash owner',$3,'owner',true)",[user,org,randomUUID()+'@example.test']);await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic',now()+interval '1 hour')",[proof,org,user]);const other:Actor={...actor,org_id:org,id:user};
 const transaction=<T>(fn:(tx:Queryable,a:Actor)=>Promise<T>)=>accountingTransaction(db,other,proof,fn);await transaction((tx,a)=>saveAccountingConfig(tx,a,{expectedRevision:0,currency:'USD',precision:2,basis:'cash',fiscalStartMonth:1,fiscalStartDay:1,modules:['ledger','payroll']}));
 const ids:string[]=[];for(const [code,type,isCash] of [['1000','asset',true],['2000','liability',false],['5000','expense',false]] as const){const id=randomUUID();ids.push(id);await transaction((tx,a)=>saveAccountingAccount(tx,a,{id,expectedRevision:0,code,name:'Synthetic '+code,type,isCash,cashFlowCategory:'operating',functionalCategory:'management',active:true}));}await transaction((tx,a)=>createAccountingPeriod(tx,a,{id:randomUUID(),name:'Cash period',startsOn:'2026-01-01',endsOn:'2026-12-31'}));
 const input={...payroll('2026-06-01','2026-06-15'),payableAccountId:ids[1],employees:[{userId:user,earnings:[{label:'Reviewed cash earning',quantity:'1',rate:'10.00',expenseAccountId:ids[2],fundId:null}],deductions:[],employerCosts:[]}]};const draft=await createAccountingPayroll(db,other,proof,input),approved=await actOnAccountingPayroll(db,other,proof,draft.id,'approve',action(draft.version));assert.equal((await db.query('SELECT id FROM accounting_journals WHERE org_id=$1',[org])).rows.length,0);
 await assert.rejects(actOnAccountingPayroll(db,other,proof,draft.id,'pay',{...action(approved.version),date:'2026-06-14',cashAccountId:ids[0]}),/cannot precede/);
 const paid=await actOnAccountingPayroll(db,other,proof,draft.id,'pay',{...action(approved.version),date:'2026-06-16',cashAccountId:ids[0]});assert.equal(paid.status,'paid');assert.equal(paid.journalId,null);assert.ok(paid.paymentJournalId);
});
test('drafts reject calculated earnings outside the ledger magnitude instead of trapping an unpostable run',async()=>{const input=payroll('2026-07-01','2026-07-15');input.employees[0].earnings[0].quantity='9999999';input.employees[0].earnings[0].rate='999999999999';await assert.rejects(createAccountingPayroll(db,actor,hash,input),/Invalid accounting amount/);});
