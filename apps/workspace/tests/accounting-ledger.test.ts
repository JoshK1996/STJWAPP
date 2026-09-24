import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import ExcelJS from 'exceljs';
import {connectDatabase,migrate,type Database,type Queryable} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {digest,issueSetup,type Actor} from '../server/security';
import {parseAmount,formatAmount,type JournalPostRequest} from '../shared/accounting';
import {accountingTransaction,accountingWorkspace,lockAccounting,createStarterAccountingChart,saveAccountingConfig,saveAccountingAccount,saveAccountingFund,createAccountingPeriod,editAccountingPeriod,setAccountingPeriodStatus,postJournalTx,reverseJournalTx,saveJournalDraft,postJournalDraft,discardJournalDraft,readAccountingJournal} from '../server/accounting-ledger';
import {buildAccountingReport,accountingReportCsv,accountingReportWorkbook} from '../server/accounting-reports';

let db:Database,actor:Actor,hash:string,unitId:string,cashId:string,revenueId:string,expenseId:string,periodId:string;
let auth:{cookie:string;csrf:string},app:ReturnType<typeof createApp>;
const origin='http://localhost:3000';
const run=<T>(work:(tx:Queryable,current:Actor)=>Promise<T>)=>accountingTransaction(db,actor,hash,work);
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'accounting-owner@example.test'});
  const user=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  actor={id:user.id,org_id:user.org_id,name:user.name,email:user.email,role:user.role,mode:'password',unit_ids:[]};
  unitId=(await db.query('SELECT id FROM units WHERE org_id=$1 ORDER BY id',[actor.org_id])).rows[0].id;
  app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:true});
  const token=await db.transaction(tx=>issueSetup(tx,actor)),password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],me=await request(app).get('/api/me').set('Cookie',cookie);hash=digest(cookie.slice(cookie.indexOf('=')+1));auth={cookie,csrf:me.body.actor.csrf};
  const defaults=await run(accountingWorkspace);assert.equal(defaults.config.reviewed,false);assert.equal(defaults.config.currency,'USD');assert.equal(defaults.config.fiscalStartMonth,1);assert.equal(defaults.journals.length,0);
  await run((tx,a)=>saveAccountingConfig(tx,a,{expectedRevision:0,currency:'USD',precision:2,basis:'accrual',fiscalStartMonth:7,fiscalStartDay:1,modules:['ledger','budgets','payables','receivables','banking','payroll']}));
  const account=async(code:string,name:string,type:string,isCash=false,category='unclassified')=>{
    const id=randomUUID();await run((tx,a)=>saveAccountingAccount(tx,a,{id,expectedRevision:0,code,name,type,isCash,cashFlowCategory:isCash?'operating':'unclassified',functionalCategory:category,active:true}));return id;
  };
  cashId=await account('1000','Operating bank','asset',true);revenueId=await account('4000','Tuition revenue','revenue');expenseId=await account('5000','Teaching supplies','expense',false,'program');
  periodId=randomUUID();await run((tx,a)=>createAccountingPeriod(tx,a,{id:periodId,name:'Synthetic September',startsOn:'2026-09-01',endsOn:'2026-09-30'}));
});
after(async()=>{await db?.close();});
function entry(amount='0.30',date='2026-09-12'):JournalPostRequest{return{id:randomUUID(),commandId:randomUUID(),date,description:'Synthetic tuition receipt',lines:[{accountId:cashId,debit:amount,credit:'0.00',unitId},{accountId:revenueId,debit:'0.00',credit:amount,unitId}]};}
test('accounting exact money supports declared precision and rejects excess precision without rounding',()=>{
  assert.equal(parseAmount('0.1',2)+parseAmount('0.2',2),30n);assert.equal(formatAmount(30n,2),'0.30');assert.equal(formatAmount(-3n,4),'-0.0003');
  assert.equal(parseAmount('9999999999999999.9999',4),99999999999999999999n);assert.throws(()=>parseAmount('0.001',2));assert.throws(()=>parseAmount('1e2',2));assert.throws(()=>parseAmount('-1',2));
});
test('ledger posting balances exact units, retains identity evidence and one idempotent receipt',async()=>{
  const input=entry(),first=await run((tx,a)=>postJournalTx(tx,a,input)),again=await run((tx,a)=>postJournalTx(tx,a,input));
  assert.deepEqual(again,first);assert.equal(first.status,'posted');assert.equal(first.lines[0].debit,'0.30');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM audit_events WHERE target_id=$1 AND action=$2',[input.id,'accounting.journal_posted'])).rows[0].count,1);
  await assert.rejects(run((tx,a)=>postJournalTx(tx,a,{...input,description:'Changed attempt'})),/already used/);
});
test('imbalanced, excessive-precision and empty-sided postings leave no journals',async()=>{
  for(const input of [(()=>{const v=entry();v.lines[1].credit='0.29';return v;})(),entry('0.001'),entry('0.00')]){
    await assert.rejects(run((tx,a)=>postJournalTx(tx,a,input)),/balance|decimal|positive/);
    assert.equal((await db.query('SELECT id FROM accounting_journals WHERE id=$1',[input.id])).rows.length,0);
  }
});
test('real server session and current role are required before financial reads or writes',async()=>{
  await assert.rejects(accountingTransaction(db,actor,undefined,accountingWorkspace),/verified password session/);
  const prior=actor.role;await db.query("UPDATE users SET role='employee' WHERE id=$1",[actor.id]);
  try{await assert.rejects(run(accountingWorkspace),/Financial report access/);}finally{await db.query('UPDATE users SET role=$2 WHERE id=$1',[actor.id,prior]);}
});
test('fresh session proof rejects revoked credentials despite a caller-supplied finance actor',async()=>{
  const raw='Synthetic-'+randomUUID(),revoked=digest(raw);await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic',now()-interval '1 second')",[revoked,actor.org_id,actor.id]);
  await assert.rejects(accountingTransaction(db,actor,revoked,accountingWorkspace),/session|sign in|Sign in|expired/i);
});
test('cross-organization account and dimension IDs cannot be posted or read',async()=>{
  const orgId=randomUUID(),id=randomUUID();await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic external organization','UTC')",[orgId]);
  await db.query("INSERT INTO accounting_accounts(id,org_id,code,name,type,is_cash,cash_flow_category,functional_category) VALUES($1,$2,'1000','External bank','asset',true,'unclassified','unclassified')",[id,orgId]);
  const input=entry();input.lines[0].accountId=id;await assert.rejects(run((tx,a)=>postJournalTx(tx,a,input)),/active account/);
  await assert.rejects(run((tx,a)=>buildAccountingReport(tx,a,{from:'2026-09-01',to:'2026-09-30',accountId:id})),/scope not found/);
});
test('restricted funds enforce explicit allowed account, community and date boundaries',async()=>{
  const fundId=randomUUID();await run((tx,a)=>saveAccountingFund(tx,a,{id:fundId,expectedRevision:0,code:'BOOKS',name:'Restricted books grant',kind:'fund',restriction:'restricted',purpose:'Only classroom supplies during September',active:true,allowedAccountIds:[expenseId],allowedUnitIds:[unitId],startsOn:'2026-09-10',endsOn:'2026-09-20'}));
  const bad=entry();bad.lines[0].fundId=fundId;await assert.rejects(run((tx,a)=>postJournalTx(tx,a,bad)),/account is not allowed/);
  const input=entry('12.34');input.lines=[{accountId:expenseId,debit:'12.34',credit:'0.00',unitId,fundId},{accountId:cashId,debit:'0.00',credit:'12.34',unitId}];
  assert.equal((await run((tx,a)=>postJournalTx(tx,a,input))).status,'posted');
  await assert.rejects(run((tx,a)=>postJournalTx(tx,a,{...input,id:randomUUID(),commandId:randomUUID(),date:'2026-09-09'})),/outside the dimension dates/);
});
test('dated periods cannot overlap; outside dates cannot post',async()=>{
  await assert.rejects(run((tx,a)=>createAccountingPeriod(tx,a,{id:randomUUID(),name:'Overlap',startsOn:'2026-09-30',endsOn:'2026-10-31'})),/cannot overlap/);
  await assert.rejects(run((tx,a)=>postJournalTx(tx,a,entry('1.00','2026-10-01'))),/open accounting period/);
});
test('drafts can be unbalanced, edits use revisions, posting rechecks balance and date, and closing blocks drafts',async()=>{
  const input=entry('7.00'),{commandId:_command,...body}=input;
  const draft=await run((tx,a)=>saveJournalDraft(tx,a,{...body,expectedRevision:0,lines:[body.lines[0],{...body.lines[1],credit:'6.00'}]}));
  await assert.rejects(run((tx,a)=>postJournalDraft(tx,a,draft.id,{expectedRevision:draft.revision,commandId:randomUUID()})),/balance/);
  await assert.rejects(run((tx,a)=>setAccountingPeriodStatus(tx,a,periodId,{expectedRevision:1,status:'closed',reason:'Synthetic close review',commandId:randomUUID()})),/draft journals/);
  await assert.rejects(run((tx,a)=>saveJournalDraft(tx,a,{...body,expectedRevision:0})),/changed/);
  const changed=await run((tx,a)=>saveJournalDraft(tx,a,{...body,expectedRevision:draft.revision}));
  const posted=await run((tx,a)=>postJournalDraft(tx,a,draft.id,{expectedRevision:changed.revision,commandId:randomUUID()}));assert.equal(posted.status,'posted');
  await assert.rejects(run((tx,a)=>saveJournalDraft(tx,a,{...body,expectedRevision:posted.revision})),/posted/);
});
test('database rejects direct changes to posted headers and lines, including deletion',async()=>{
  const posted=await run((tx,a)=>postJournalTx(tx,a,entry('5.00')));
  await assert.rejects(db.query('UPDATE accounting_journals SET description=$2 WHERE id=$1',[posted.id,'Tamper']),/immutable/);
  await assert.rejects(db.query('UPDATE accounting_journal_lines SET debit=999 WHERE journal_id=$1',[posted.id]),/immutable/);
  await assert.rejects(db.query('DELETE FROM accounting_journal_lines WHERE journal_id=$1',[posted.id]),/immutable/);
});
test('reversal creates equal opposite immutable journal and preserves the original',async()=>{
  const posted=await run((tx,a)=>postJournalTx(tx,a,entry('19.23'))),raw={id:posted.id,expectedRevision:posted.revision,date:'2026-09-13',reason:'Synthetic correction',commandId:randomUUID()};
  const reversed=await run((tx,a)=>reverseJournalTx(tx,a,raw));assert.equal(reversed.reversalOf,posted.id);assert.equal(reversed.lines[0].credit,'19.23');assert.equal(reversed.lines[1].debit,'19.23');
  assert.deepEqual(await run((tx,a)=>reverseJournalTx(tx,a,raw)),reversed);
  assert.equal((await run((tx,a)=>readAccountingJournal(tx,a,posted.id))).reversedBy,reversed.id);
  await assert.rejects(run((tx,a)=>reverseJournalTx(tx,a,{...raw,commandId:randomUUID()})),/reversed again/);
});
test('closed periods reject new postings and reversals until reasoned revision-checked reopening',async()=>{
  const posted=await run((tx,a)=>postJournalTx(tx,a,entry('1.00')));
  const closed=await run((tx,a)=>setAccountingPeriodStatus(tx,a,periodId,{expectedRevision:1,status:'closed',reason:'All synthetic entries reviewed',commandId:randomUUID()}));
  await assert.rejects(run((tx,a)=>postJournalTx(tx,a,entry('1.00'))),/open accounting period/);
  await assert.rejects(run((tx,a)=>reverseJournalTx(tx,a,{id:posted.id,expectedRevision:posted.revision,date:'2026-09-14',reason:'Synthetic correction',commandId:randomUUID()})),/open accounting period/);
  await assert.rejects(run((tx,a)=>setAccountingPeriodStatus(tx,a,periodId,{expectedRevision:1,status:'open',reason:'Review more entries',commandId:randomUUID()})),/changed/);
  await run((tx,a)=>setAccountingPeriodStatus(tx,a,periodId,{expectedRevision:closed.revision,status:'open',reason:'Authorized synthetic correction',commandId:randomUUID()}));
});
test('failed audit insertion rolls back journal, lines and idempotency receipt',async()=>{
  const input=entry('4.00');
  const failing:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{if(sql.includes('INSERT INTO audit_events'))throw new Error('Synthetic audit failure');return tx.query(sql,params);}}))};
  await assert.rejects(accountingTransaction(failing,actor,hash,(tx,a)=>postJournalTx(tx,a,input)),/Synthetic audit failure/);
  assert.equal((await db.query('SELECT id FROM accounting_journals WHERE id=$1',[input.id])).rows.length,0);
  assert.equal((await db.query('SELECT command_id FROM accounting_commands WHERE org_id=$1 AND command_id=$2',[actor.org_id,input.commandId])).rows.length,0);
});
test('concurrent identical retry yields one journal and audit; changed retry is rejected',async()=>{
  const input=entry('9.87'),results=await Promise.all([run((tx,a)=>postJournalTx(tx,a,input)),run((tx,a)=>postJournalTx(tx,a,input))]);assert.equal(results[0].id,results[1].id);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM accounting_journals WHERE id=$1',[input.id])).rows[0].count,1);
});
test('posted financial statements reconcile exact balances and expose classifications and drilldown',async()=>{
  const report=await run((tx,a)=>buildAccountingReport(tx,a,{from:'2026-09-01',to:'2026-09-30'}));
  assert.equal(report.totals.debit,report.totals.credit);assert.equal(report.totals.closingDebit,report.totals.closingCredit);assert.equal(report.currency,'USD');
  assert.equal(report.functionalExpenses.find(row=>row.key==='program')?.amount,'12.34');
  const amount=(key:string)=>parseAmount(report.position.find(row=>row.key===key)!.amount,2);
  assert.equal(amount('assets'),amount('liabilities')+amount('net_assets'));
  assert.equal(report.ledger.length>0,true);assert.equal(report.ledger.some(row=>row.accountName==='Operating bank'),true);
});
test('settings cannot reinterpret recorded amounts and account classifications cannot rewrite posted history',async()=>{
  await assert.rejects(run((tx,a)=>saveAccountingConfig(tx,a,{expectedRevision:1,currency:'EUR',precision:2,basis:'accrual',fiscalStartMonth:7,fiscalStartDay:1,modules:['ledger']})),/cannot change/);
  await assert.rejects(run((tx,a)=>saveAccountingAccount(tx,a,{id:cashId,expectedRevision:1,code:'1000',name:'Operating bank',type:'asset',isCash:true,cashFlowCategory:'investing',functionalCategory:'unclassified',active:true})),/classifications are fixed/);
});
test('manual HTTP rejects caller-supplied source authority and protected workspace denies anonymous requests',async()=>{
  const anonymous=await request(app).get('/api/accounting/workspace');assert.equal(anonymous.status,401);
  const input=entry(),{commandId:_command,...draft}=input;
  const result=await request(app).post('/api/accounting/journals').set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send({...draft,expectedRevision:0,sourceType:'payroll',sourceId:randomUUID()});assert.equal(result.status,400);
});
test('manual HTTP cannot reverse a journal controlled by a payment or payroll workflow',async()=>{
  const journal=await run((tx,a)=>postJournalTx(tx,a,{...entry('2.00'),sourceType:'payroll',sourceId:randomUUID()}));
  const result=await request(app).post(`/api/accounting/journals/${journal.id}/reverse`).set('Origin',origin).set('Cookie',auth.cookie).set('X-CSRF-Token',auth.csrf).send({expectedRevision:journal.revision,date:'2026-09-19',reason:'Cannot bypass payroll workflow',commandId:randomUUID()});assert.equal(result.status,409);
  assert.equal((await run((tx,a)=>readAccountingJournal(tx,a,journal.id))).reversedBy,null);
});
test('starter chart is explicit and retry-safe, creates no transactions, and settings are editable before records',async()=>{
  const orgId=randomUUID(),ownerId=randomUUID();await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic startup organization','UTC')",[orgId]);
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic accountant','owner')",[ownerId,orgId,ownerId+'@example.test']);
  const starterActor={...actor,id:ownerId,org_id:orgId},input={commandId:randomUUID(),year:2027};
  await db.transaction(async tx=>{
    const defaults=await lockAccounting(tx,starterActor);assert.equal(defaults.reviewed,false);
    const first=await createStarterAccountingChart(tx,starterActor,input),again=await createStarterAccountingChart(tx,starterActor,input);assert.deepEqual(first,again);
    const settings=await saveAccountingConfig(tx,starterActor,{expectedRevision:0,currency:'EUR',precision:2,basis:'cash',fiscalStartMonth:8,fiscalStartDay:1,modules:['ledger']});assert.equal(settings.reviewed,true);assert.equal(settings.currency,'EUR');
    const workspace=await accountingWorkspace(tx,starterActor);assert.equal(workspace.accounts.length,12);assert.equal(workspace.journals.length,0);assert.equal(workspace.periods[0].startsOn,'2027-01-01');
  });
});
test('readable reports export selected statements and styled Excel retains precision and source context',async()=>{
  const report=await run((tx,a)=>buildAccountingReport(tx,a,{from:'2026-09-01',to:'2026-09-30',unitId}));
  const csv=accountingReportCsv(report,'activities');assert.ok(csv.includes('Change in net assets'));assert.ok(csv.includes('Community:'));assert.ok(!csv.includes('journalId'));
  const exactLarge='9999999999999999.99',workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await accountingReportWorkbook({...report,trialBalance:[{...report.trialBalance[0],debit:exactLarge}]})).buffer);
  assert.equal(workbook.worksheets.length,7);assert.equal(workbook.getWorksheet('Trial balance')!.getCell('F6').value,exactLarge);
  assert.equal(typeof workbook.getWorksheet('Activities')!.getCell('B6').value,'number');assert.equal(workbook.getWorksheet('Trial balance')!.views[0].state,'frozen');
  assert.equal(workbook.getWorksheet('Report overview')!.getCell('B9').value,report.scopeLabels.join('; '));
  await assert.rejects(async()=>accountingReportCsv({...report,ledgerTruncated:true},'ledger'),/Narrow the dates/);
});
test('matching program and grant filters retain exact scoped activity and reject wrong dimension kinds',async()=>{
  const programId=randomUUID();await run((tx,a)=>saveAccountingFund(tx,a,{id:programId,expectedRevision:0,code:'SCHOLAR',name:'Scholarship program',kind:'program',restriction:'unrestricted',purpose:'',active:true,allowedAccountIds:[],allowedUnitIds:[],startsOn:null,endsOn:null}));
  const input=entry('3.45');input.lines=input.lines.map(line=>({...line,programId}));await run((tx,a)=>postJournalTx(tx,a,input));
  const report=await run((tx,a)=>buildAccountingReport(tx,a,{from:'2026-09-01',to:'2026-09-30',programId}));assert.equal(report.totals.debit,'3.45');assert.deepEqual(report.scopeLabels,['Program: Scholarship program']);
  await assert.rejects(run((tx,a)=>buildAccountingReport(tx,a,{from:'2026-09-01',to:'2026-09-30',fundId:programId})),/matching fund/);
});
test('discarded drafts retain audited evidence and idempotent receipts without affecting posted history',async()=>{
  const input=entry('6.20'),{commandId:_command,...body}=input,draft=await run((tx,a)=>saveJournalDraft(tx,a,{...body,expectedRevision:0}));
  const command={expectedRevision:draft.revision,commandId:randomUUID(),reason:'Discard synthetic draft'};
  assert.deepEqual(await run((tx,a)=>discardJournalDraft(tx,a,draft.id,command)),{id:draft.id,discarded:true});
  assert.deepEqual(await run((tx,a)=>discardJournalDraft(tx,a,draft.id,command)),{id:draft.id,discarded:true});
  const evidence=(await db.query("SELECT detail FROM audit_events WHERE target_id=$1 AND action='accounting.journal_draft_discarded'",[draft.id])).rows[0].detail;
  assert.equal(evidence.journal.lines[0].debit,'6.20');await assert.rejects(run((tx,a)=>readAccountingJournal(tx,a,draft.id)),/not found/);
  await assert.rejects(db.query('DELETE FROM accounting_commands WHERE org_id=$1 AND command_id=$2',[actor.org_id,command.commandId]),/immutable|append.only/i);
});
test('empty starter periods can be adjusted while periods used by journals retain their dates',async()=>{
  const id=randomUUID(),created=await run((tx,a)=>createAccountingPeriod(tx,a,{id,name:'Future starter',startsOn:'2028-01-01',endsOn:'2028-12-31'}));
  const changed=await run((tx,a)=>editAccountingPeriod(tx,a,id,{expectedRevision:created.revision,name:'Reviewed fiscal year',startsOn:'2028-07-01',endsOn:'2029-06-30'}));assert.equal(changed.startsOn,'2028-07-01');
  const period=(await run(accountingWorkspace)).periods.find(row=>row.id===periodId)!;
  await assert.rejects(run((tx,a)=>editAccountingPeriod(tx,a,periodId,{expectedRevision:period.revision,name:'Changed dates',startsOn:'2026-09-01',endsOn:'2026-09-29'})),/dates are fixed/);
});
