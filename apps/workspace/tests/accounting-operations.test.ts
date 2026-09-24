import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { digest, issueSetup, type Actor } from '../server/security';
import { createApp } from '../server/app';
import { accountingTransaction, saveAccountingConfig, saveAccountingAccount, saveAccountingFund, createAccountingPeriod, setAccountingPeriodStatus, postJournalTx } from '../server/accounting-ledger';
import { createAccountingContact, createAccountingDocument, issueAccountingDocument, payAccountingDocument, creditAccountingDocument, refundAccountingPayment, voidAccountingDocument,
  documentRecord, accountingAging, allocateExact, listAccountingContacts } from '../server/accounting-operations';
import { previewBankStatement, importBankStatement, matchBankLine, reconcileBankStatement, bankCandidates, bankStatementRecord, cancelBankStatement } from '../server/accounting-banking';

let db: Database, actor: Actor, hash: string, cookie: string, csrf: string, app: ReturnType<typeof createApp>;
let cash: string, receivable: string, payable: string, revenue: string, expense: string, equity: string, period: string;
const origin='http://localhost:3000';
const command=()=>randomUUID();
const run=<T>(fn:Parameters<typeof accountingTransaction<T>>[3])=>accountingTransaction(db,actor,hash,fn);
async function newAccount(name: string,type:string,isCash=false) {
  const id=randomUUID(); await run((tx,current)=>saveAccountingAccount(tx,current,{id,expectedRevision:0,code:id.slice(0,12),name,type,isCash,cashFlowCategory:'operating',functionalCategory:'program',active:true})); return id;
}
before(async()=>{
  db=await connectDatabase(); await migrate(db); await initialize(db,{demo:false,ownerEmail:'accounting-owner@example.test'});
  const user=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  actor={id:user.id,org_id:user.org_id,name:user.name,email:user.email,role:user.role,mode:'password',unit_ids:[]};
  app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:true});
  const token=await db.transaction(tx=>issueSetup(tx,actor)), password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'}); assert.equal(login.status,200);
  cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0]; hash=digest(cookie.slice(cookie.indexOf('=')+1));
  const me=await request(app).get('/api/me').set('Cookie',cookie); csrf=me.body.actor.csrf;
  await run((tx,current)=>saveAccountingConfig(tx,current,{expectedRevision:0,currency:'USD',precision:2,basis:'accrual',fiscalStartMonth:1,fiscalStartDay:1,modules:['ledger','payables','receivables','banking']}));
  cash=await newAccount('Synthetic operating bank','asset',true); receivable=await newAccount('Receivables','asset'); payable=await newAccount('Payables','liability');
  revenue=await newAccount('Tuition revenue','revenue'); expense=await newAccount('Program supplies','expense'); equity=await newAccount('Opening net assets','equity');
  period=randomUUID(); await run((tx,current)=>createAccountingPeriod(tx,current,{id:period,name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31'}));
});
after(async()=>{await db?.close();});
async function draft(kind:'invoice'|'bill'='invoice',amount='100.00') {
  const contact=await createAccountingContact(db,actor,hash,{commandId:command(),name:'Synthetic '+kind,kind:kind==='invoice'?'family':'vendor'});
  return createAccountingDocument(db,actor,hash,{commandId:command(),kind,contactId:contact.id,number:'SYN-'+command().slice(0,8),date:'2026-01-10',dueDate:'2026-01-31',description:'Reviewed synthetic transaction',
    controlAccountId:kind==='invoice'?receivable:payable,lines:[{description:kind==='invoice'?'Tuition':'Supplies',accountId:kind==='invoice'?revenue:expense,amount}]});
}
async function issued(kind:'invoice'|'bill'='invoice',amount='100.00') { const value=await draft(kind,amount); return issueAccountingDocument(db,actor,hash,value.id,{commandId:command()}); }
test('exact allocation conserves cents with deterministic remainders',()=>{
  assert.deepEqual(allocateExact(2n,[1n,1n,1n]),[1n,1n,0n]);
  assert.deepEqual(allocateExact(100000000000003n,[900000000000000n,100000000000000n]),[90000000000003n,10000000000000n]);
  assert.throws(()=>allocateExact(4n,[1n,2n]),/exceeds/);
});
test('AP and AR drafts, issue postings, payments, credits and refunds retain exact immutable evidence',async()=>{
  let doc=await issued(); assert.equal(doc.outstanding,'100.00'); assert.equal(doc.events[0].type,'issue'); assert.ok(doc.events[0].journalId);
  doc=await payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-02-01',amount:'100.00',cashAccountId:cash,reference:'Manual receipt 1'}); assert.equal(doc.outstanding,'0.00');
  const payment=doc.events.find(value=>value.type==='payment')!;
  doc=await creditAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-02-02',reason:'Approved tuition adjustment',lines:[{lineIndex:0,amount:'30.00'}]}); assert.equal(doc.outstanding,'-30.00');
  doc=await refundAccountingPayment(db,actor,hash,doc.id,payment.id,{commandId:command(),date:'2026-02-03',amount:'30.00',reference:'Manual refund 1'}); assert.equal(doc.outstanding,'0.00'); assert.equal(doc.refunded,'30.00');
  await assert.rejects(refundAccountingPayment(db,actor,hash,doc.id,payment.id,{commandId:command(),date:'2026-02-04',amount:'70.01',reference:'Too much'}),/exceeds/);
  await assert.rejects(db.query('UPDATE accounting_documents SET description=$1 WHERE id=$2',['tampered',doc.id]),/append-only/);
  await assert.rejects(db.query('DELETE FROM accounting_document_events WHERE id=$1',[payment.id]),/append-only/);
  const bill=await issued('bill','12.34'); const paid=await payAccountingDocument(db,actor,hash,bill.id,{commandId:command(),date:'2026-02-01',amount:'12.34',cashAccountId:cash,reference:'Manual vendor payment'});
  assert.equal(paid.outstanding,'0.00'); const journal=paid.events.find(value=>value.type==='payment')!.journalId;
  const bank=(await db.query('SELECT debit::text,credit::text FROM accounting_journal_lines WHERE journal_id=$1 AND account_id=$2',[journal,cash])).rows[0]; assert.deepEqual(bank,{debit:'0',credit:'1234'});
});
test('duplicate command retries are stable while changed retries, duplicate numbers and overpayments fail',async()=>{
  const doc=await issued(), input={commandId:command(),date:'2026-02-01',amount:'60.00',cashAccountId:cash,reference:'Retryable receipt'};
  const [first,second]=await Promise.all([payAccountingDocument(db,actor,hash,doc.id,input),payAccountingDocument(db,actor,hash,doc.id,input)]);
  assert.deepEqual(first,second); assert.equal(first.paid,'60.00'); assert.equal(first.events.filter(value=>value.type==='payment').length,1);
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,{...input,amount:'59.00'}),/different data/);
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,{...input,commandId:command()}),/already recorded/);
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,{...input,commandId:command(),amount:'40.01',reference:'Overpayment'}),/exceeds/);
  const concurrent=await Promise.allSettled([payAccountingDocument(db,actor,hash,doc.id,{...input,commandId:command(),amount:'40.00',reference:'Settlement A'}),payAccountingDocument(db,actor,hash,doc.id,{...input,commandId:command(),amount:'40.00',reference:'Settlement B'})]);
  assert.equal(concurrent.filter(value=>value.status==='fulfilled').length,1);
  await assert.rejects(createAccountingDocument(db,actor,hash,{commandId:command(),kind:doc.kind,contactId:doc.contactId,number:doc.number,date:doc.date,dueDate:doc.dueDate,description:doc.description,controlAccountId:receivable,lines:doc.lines}),/already exists/);
});
test('period locks and chronological event dates reject writes without leaving ledger or event fragments',async()=>{
  const doc=await draft();
  await run((tx,current)=>setAccountingPeriodStatus(tx,current,period,{expectedRevision:1,status:'closed',reason:'Synthetic close validation',commandId:command()}));
  await assert.rejects(issueAccountingDocument(db,actor,hash,doc.id,{commandId:command()}),/open|closed/i);
  assert.equal((await run((tx,current)=>documentRecord(tx,current,doc.id))).events.length,0);
  await run((tx,current)=>setAccountingPeriodStatus(tx,current,period,{expectedRevision:2,status:'open',reason:'Reopen synthetic validation',commandId:command()}));
  await issueAccountingDocument(db,actor,hash,doc.id,{commandId:command()});
  await payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-02-01',amount:'10.00',cashAccountId:cash,reference:'Date proof'});
  await assert.rejects(creditAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-01-31',reason:'Backdated credit',lines:[{lineIndex:0,amount:'10.00'}]}),/on or after/);
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2027-01-01',amount:'10.00',cashAccountId:cash,reference:'Closed date'}),/open|period/i);
});
test('void and payment void preserve originals, reopen balances and prevent contradictory adjustments',async()=>{
  const doc=await issued(); let changed=await payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-02-01',amount:'20.00',cashAccountId:cash,reference:'Mistaken recording'});
  const payment=changed.events.find(value=>value.type==='payment')!;
  changed=await refundAccountingPayment(db,actor,hash,doc.id,payment.id,{commandId:command(),date:'2026-02-02',reason:'Correct mistaken receipt'},true);
  assert.equal(changed.outstanding,'100.00'); assert.equal(changed.paid,'0.00');
  await assert.rejects(refundAccountingPayment(db,actor,hash,doc.id,payment.id,{commandId:command(),date:'2026-02-03',amount:'1.00',reference:'Invalid refund'}),/active payment/);
  const untouched=await issued(); const voided=await voidAccountingDocument(db,actor,hash,untouched.id,{commandId:command(),date:'2026-02-01',reason:'Duplicate invoice replaced'});
  assert.equal(voided.status,'void'); assert.equal(voided.outstanding,'0.00'); assert.equal(voided.events.length,2);
});
test('aging uses as-of event boundaries, separates credit balances and exports readable headers via normal authentication',async()=>{
  const doc=await issued('invoice','43.21'); await payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-03-01',amount:'43.21',cashAccountId:cash,reference:'Later settlement'});
  const before=await run((tx,current)=>accountingAging(tx,current,'2026-02-28')), after=await run((tx,current)=>accountingAging(tx,current,'2026-03-01'));
  assert.equal(before.rows.find(row=>row.id===doc.id)?.outstanding,'43.21'); assert.equal(before.rows.find(row=>row.id===doc.id)?.bucket,'1–30 days'); assert.ok(!after.rows.some(row=>row.id===doc.id));
  const response=await request(app).get('/api/accounting/aging?asOf=2026-02-28&format=csv').set('Cookie',cookie);
  assert.equal(response.status,200); assert.match(response.text,/"Contact","Document","Description"/); assert.ok(!response.text.includes(doc.id));
  assert.equal((await request(app).get('/api/accounting/documents')).status,401);
});
test('current authorization and transactional audit failure prevent unauthorized or partial financial records',async()=>{
  await assert.rejects(listAccountingContacts(db,actor,undefined),/verified password/);
  const fake={...actor,org_id:randomUUID()}; await assert.rejects(createAccountingContact(db,fake,hash,{commandId:command(),name:'Wrong organization',kind:'vendor'}));
  const role=actor.role; await db.query("UPDATE users SET role='employee' WHERE id=$1",[actor.id]);
  await assert.rejects(listAccountingContacts(db,actor,hash),/access/i); await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,actor.id]);
  const doc=await issued(), count=(await db.query('SELECT count(*)::int AS n FROM accounting_journals')).rows[0].n;
  await db.query(`CREATE FUNCTION fail_operations_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='accounting.document_payment' THEN RAISE EXCEPTION 'Synthetic audit rejection'; END IF; RETURN NEW; END; $$`);
  await db.query('CREATE TRIGGER fail_operations_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_operations_audit()');
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-02-01',amount:'10.00',cashAccountId:cash,reference:'Atomic audit'}),/Synthetic audit rejection/);
  await db.query('DROP TRIGGER fail_operations_audit ON audit_events'); await db.query('DROP FUNCTION fail_operations_audit()');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_journals')).rows[0].n,count);
  assert.equal((await run((tx,current)=>documentRecord(tx,current,doc.id))).paid,'0.00');
});
async function cashJournal(bank:string,amount:string,date='2026-04-02',reference='Synthetic bank transaction') {
  const value=await run((tx,current)=>postJournalTx(tx,current,{id:command(),commandId:command(),date,description:reference,reference,lines:[{accountId:bank,debit:amount,credit:'0.00'},{accountId:revenue,debit:'0.00',credit:amount}]}));
  return value.lines.find(line=>line.accountId===bank)!.id;
}
async function statement(bank:string,amount='25.00',from='2026-04-01',to='2026-04-30',opening='0.00',closing=amount) {
  const preview=await previewBankStatement(db,actor,hash,{cashAccountId:bank,from,to,openingBalance:opening,closingBalance:closing,csv:`Date,Reference,Amount,Description\n${from.slice(0,8)}02,BANK-1,${amount},Synthetic deposit`,mapping:{date:'Date',reference:'Reference',amount:'Amount',description:'Description'}});
  const input={commandId:command(),previewId:preview.id,fingerprint:preview.fingerprint,reviewed:true};
  const value=await importBankStatement(db,actor,hash,input); assert.deepEqual(await importBankStatement(db,actor,hash,input),value); return value;
}
test('bank CSV rejects malformed date/range, duplicate lines and unbalanced statement amounts',async()=>{
  const base={cashAccountId:cash,from:'2026-04-01',to:'2026-04-30',openingBalance:'0.00',closingBalance:'1.00',mapping:{date:'Date',reference:'Reference',amount:'Amount'}};
  await assert.rejects(previewBankStatement(db,actor,hash,{...base,csv:'Date,Reference,Amount\n2026-04-31,R,1.00'}));
  await assert.rejects(previewBankStatement(db,actor,hash,{...base,csv:'Date,Reference,Amount\n2026-03-31,R,1.00'}),/outside/);
  await assert.rejects(previewBankStatement(db,actor,hash,{...base,csv:'Date,Reference,Amount\n2026-04-01,R,1.00\n2026-04-01,R,1.00'}),/duplicates/);
  await assert.rejects(previewBankStatement(db,actor,hash,{...base,csv:'Date,Reference,Amount\n2026-04-01,R,2.00'}),/closing balance/);
  await assert.rejects(previewBankStatement(db,actor,hash,{...base,csv:'Date,Reference,Amount\n2026-04-01,R,1.001'}),/decimal places/);
});
test('reviewed bank matching requires exact account/date/amount and final reconciliation evidence is immutable',async()=>{
  const bank=await newAccount('Reconciliation bank','asset',true), other=await newAccount('Other bank','asset',true);
  const line=await cashJournal(bank,'25.00'), wrong=await cashJournal(other,'25.00'), future=await cashJournal(bank,'25.00','2026-05-01'), mismatch=await cashJournal(bank,'2.00');
  const bankStatement=await statement(bank); await assert.rejects(statement(bank),/overlap|already imported/);
  for(const bad of [wrong,future,mismatch]) await assert.rejects(matchBankLine(db,actor,hash,bankStatement.id,{commandId:command(),statementLineId:bankStatement.lines[0].id,journalLineId:bad}),/account|amount/i);
  await assert.rejects(reconcileBankStatement(db,actor,hash,bankStatement.id,{commandId:command(),reviewed:true}),/every bank/);
  await matchBankLine(db,actor,hash,bankStatement.id,{commandId:command(),statementLineId:bankStatement.lines[0].id,journalLineId:line});
  const result=await reconcileBankStatement(db,actor,hash,bankStatement.id,{commandId:command(),reviewed:true});
  assert.equal(result.status,'reconciled'); assert.equal(result.reconciliation?.ledgerBalance,'27.00'); assert.equal(result.reconciliation?.outstandingAmount,'2.00'); assert.equal(result.reconciliation?.adjustedLedgerBalance,'25.00');
  await assert.rejects(matchBankLine(db,actor,hash,result.id,{commandId:command(),statementLineId:result.lines[0].id,journalLineId:null}),/cannot be changed/);
  await assert.rejects(db.query('DELETE FROM accounting_bank_matches WHERE statement_line_id=$1',[result.lines[0].id]),/immutable/);
  await assert.rejects(db.query("UPDATE accounting_bank_reconciliations SET evidence='{}' WHERE statement_id=$1",[result.id]),/append-only/);
});
test('first nonzero opening reconciliation requires reviewed exact opening evidence and consumes it once',async()=>{
  const bank=await newAccount('Opening bank','asset',true); const openingLine=await cashJournal(bank,'100.00','2026-03-31','Reviewed opening balance');
  const line=await cashJournal(bank,'25.00'), value=await statement(bank,'25.00','2026-04-01','2026-04-30','100.00','125.00');
  await matchBankLine(db,actor,hash,value.id,{commandId:command(),statementLineId:value.lines[0].id,journalLineId:line});
  await assert.rejects(reconcileBankStatement(db,actor,hash,value.id,{commandId:command(),reviewed:true}),/Confirm/);
  const finalized=await reconcileBankStatement(db,actor,hash,value.id,{commandId:command(),reviewed:true,openingBalanceReviewed:true}); assert.equal(finalized.reconciliation?.adjustedLedgerBalance,'125.00');
  assert.ok(!(await run((tx,current)=>bankCandidates(tx,current,value.id))).rows.some(row=>row.id===openingLine));
  assert.equal((await run((tx,current)=>bankStatementRecord(tx,current,value.id))).reconciliation?.outstandingAmount,'0.00');
});
test('disabled modules reject writes and retries, while restoring the setting retains evidence',async()=>{
  const doc=await issued(), input={commandId:command(),date:'2026-02-01',amount:'10.00',cashAccountId:cash,reference:'Module gate'};
  await payAccountingDocument(db,actor,hash,doc.id,input);
  const original=(await db.query('SELECT modules FROM accounting_config WHERE org_id=$1',[actor.org_id])).rows[0].modules;
  await db.query("UPDATE accounting_config SET modules='[\"ledger\",\"payables\"]' WHERE org_id=$1",[actor.org_id]);
  await assert.rejects(payAccountingDocument(db,actor,hash,doc.id,input),/Enable the receivables/);
  await assert.rejects(previewBankStatement(db,actor,hash,{cashAccountId:cash,from:'2026-04-01',to:'2026-04-30',openingBalance:'0.00',closingBalance:'1.00',csv:'Date,Reference,Amount\n2026-04-02,R,1.00',mapping:{date:'Date',reference:'Reference',amount:'Amount'}}),/Enable the banking/);
  await db.query('UPDATE accounting_config SET modules=$1 WHERE org_id=$2',[JSON.stringify(original),actor.org_id]);
  assert.equal((await run((tx,current)=>documentRecord(tx,current,doc.id))).paid,'10.00');
});
test('cancelled open bank imports keep source evidence, release matches, and permit corrected reimport',async()=>{
  const bank=await newAccount('Correction bank','asset',true), line=await cashJournal(bank,'25.00'), original=await statement(bank);
  await matchBankLine(db,actor,hash,original.id,{commandId:command(),statementLineId:original.lines[0].id,journalLineId:line});
  const cancelled=await cancelBankStatement(db,actor,hash,original.id,{commandId:command(),reason:'Correct the source statement selection'});
  assert.equal(cancelled.status,'cancelled'); assert.equal(cancelled.lines[0].journalLineId,null);
  assert.ok((await db.query('SELECT source_text FROM accounting_bank_statements WHERE id=$1',[original.id])).rows[0].source_text.includes('BANK-1'));
  await assert.rejects(matchBankLine(db,actor,hash,original.id,{commandId:command(),statementLineId:original.lines[0].id,journalLineId:line}),/cannot be changed/);
  const corrected=await statement(bank); assert.notEqual(corrected.id,original.id);
  await matchBankLine(db,actor,hash,corrected.id,{commandId:command(),statementLineId:corrected.lines[0].id,journalLineId:line});
  await reconcileBankStatement(db,actor,hash,corrected.id,{commandId:command(),reviewed:true});
  await assert.rejects(cancelBankStatement(db,actor,hash,corrected.id,{commandId:command(),reason:'Cannot remove final proof'}),/Finalized evidence/);
});
test('document dimensions balance on both sides and a bank transaction can match exact grouped cash lines',async()=>{
  const fund=randomUUID(), bank=await newAccount('Split fund bank','asset',true);
  await run((tx,current)=>saveAccountingFund(tx,current,{id:fund,expectedRevision:0,code:fund.slice(0,10),name:'Synthetic tuition fund',kind:'fund',restriction:'unrestricted',purpose:'Synthetic dimension proof',active:true,allowedAccountIds:[],allowedUnitIds:[],startsOn:null,endsOn:null}));
  const contact=await createAccountingContact(db,actor,hash,{commandId:command(),name:'Split synthetic family',kind:'family'});
  let doc=await createAccountingDocument(db,actor,hash,{commandId:command(),kind:'invoice',contactId:contact.id,number:'SPLIT-'+command().slice(0,5),date:'2026-04-01',dueDate:'2026-04-30',description:'Split financial coding',controlAccountId:receivable,
    lines:[{description:'Fund tuition',accountId:revenue,amount:'10.00',fundId:fund},{description:'Other tuition',accountId:revenue,amount:'15.00'}]});
  doc=await issueAccountingDocument(db,actor,hash,doc.id,{commandId:command()});
  doc=await payAccountingDocument(db,actor,hash,doc.id,{commandId:command(),date:'2026-04-02',amount:'25.00',cashAccountId:bank,reference:'Combined deposit'});
  const payment=doc.events.find(value=>value.type==='payment')!, balance=(await db.query('SELECT fund_id,sum(debit-credit)::text AS balance FROM accounting_journal_lines WHERE journal_id=$1 GROUP BY fund_id',[payment.journalId])).rows;
  assert.ok(balance.every(row=>row.balance==='0'));
  const lines=(await db.query('SELECT id FROM accounting_journal_lines WHERE journal_id=$1 AND account_id=$2',[payment.journalId,bank])).rows.map(row=>row.id); assert.equal(lines.length,2);
  const imported=await statement(bank); await assert.rejects(matchBankLine(db,actor,hash,imported.id,{commandId:command(),statementLineId:imported.lines[0].id,journalLineIds:[lines[0],lines[0]]}),/once/);
  const matched=await matchBankLine(db,actor,hash,imported.id,{commandId:command(),statementLineId:imported.lines[0].id,journalLineIds:lines}); assert.equal(matched.lines.length,1); assert.equal(matched.lines[0].journalLineIds.length,2);
  const finalized=await reconcileBankStatement(db,actor,hash,imported.id,{commandId:command(),reviewed:true}); assert.equal(finalized.reconciliation?.adjustedLedgerBalance,'25.00');
});
test('cash basis recognizes only recorded settlements and credits refund the original coded revenue first',async()=>{
  const org=randomUUID(), id=randomUUID(), email=id+'@example.test';
  await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic cash organization','America/New_York')",[org]);
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Cash owner',$3,'owner')",[id,org,email]);
  const current:Actor={...actor,id,org_id:org,email,name:'Cash owner'};
  const token=await db.transaction(tx=>issueSetup(tx,current)), password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email,credential:password,mode:'password'}); assert.equal(login.status,200);
  const credential=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], proof=digest(credential.slice(credential.indexOf('=')+1));
  const cashRun=<T>(fn:Parameters<typeof accountingTransaction<T>>[3])=>accountingTransaction(db,current,proof,fn);
  await cashRun((tx,user)=>saveAccountingConfig(tx,user,{expectedRevision:0,currency:'USD',precision:2,basis:'cash',fiscalStartMonth:1,fiscalStartDay:1,modules:['ledger','receivables','banking']}));
  const bank=randomUUID(), tuition=randomUUID(), care=randomUUID();
  for(const [accountId,name,type,isCash] of [[bank,'Bank','asset',true],[tuition,'Tuition','revenue',false],[care,'Care','revenue',false]] as const)
    await cashRun((tx,user)=>saveAccountingAccount(tx,user,{id:accountId,expectedRevision:0,code:accountId.slice(0,12),name,type,isCash,cashFlowCategory:'operating',functionalCategory:'program',active:true}));
  await cashRun((tx,user)=>createAccountingPeriod(tx,user,{id:randomUUID(),name:'Synthetic cash year',startsOn:'2026-01-01',endsOn:'2026-12-31'}));
  const contact=await createAccountingContact(db,current,proof,{commandId:command(),name:'Cash synthetic family',kind:'family'});
  let doc=await createAccountingDocument(db,current,proof,{commandId:command(),kind:'invoice',contactId:contact.id,number:'CASH-1',date:'2026-01-01',dueDate:'2026-01-31',description:'Explicit tuition and care charges',lines:[{description:'Tuition',accountId:tuition,amount:'100.00'},{description:'Care',accountId:care,amount:'100.00'}]});
  doc=await issueAccountingDocument(db,current,proof,doc.id,{commandId:command()}); assert.equal(doc.events[0].journalId,undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_journals WHERE org_id=$1',[org])).rows[0].n,0);
  doc=await payAccountingDocument(db,current,proof,doc.id,{commandId:command(),date:'2026-02-01',amount:'200.00',cashAccountId:bank,reference:'External receipt'});
  const payment=doc.events.find(value=>value.type==='payment')!;
  doc=await creditAccountingDocument(db,current,proof,doc.id,{commandId:command(),date:'2026-02-02',reason:'Tuition cancellation',lines:[{lineIndex:0,amount:'100.00'}]});
  assert.equal(doc.events.find(value=>value.type==='credit')?.journalId,undefined);
  doc=await refundAccountingPayment(db,current,proof,doc.id,payment.id,{commandId:command(),date:'2026-02-03',amount:'100.00',reference:'External refund'});
  const refund=doc.events.find(value=>value.type==='refund')!; assert.deepEqual(refund.allocations,[{lineIndex:0,amount:'100.00'}]); assert.equal(doc.outstanding,'0.00');
  const coded=(await db.query('SELECT account_id,debit::text FROM accounting_journal_lines WHERE journal_id=$1 AND debit>0',[refund.journalId])).rows;
  assert.deepEqual(coded,[{account_id:tuition,debit:'10000'}]);
  await assert.rejects(createAccountingDocument(db,current,proof,{commandId:command(),kind:'invoice',contactId:contact.id,number:'CROSS-ORG',date:'2026-01-01',dueDate:'2026-01-31',description:'Must reject foreign account',lines:[{description:'Foreign account',accountId:revenue,amount:'1.00'}]}),/organization/);
  await assert.rejects(matchBankLine(db,current,proof,randomUUID(),{commandId:command(),statementLineId:randomUUID(),journalLineId:randomUUID()}),/not found/);
});
