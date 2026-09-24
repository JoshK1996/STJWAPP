import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { AppRequest } from './auth';
import type { Database, Queryable, Row } from './db';
import { audit, digest, requireCondition, Problem, type Actor } from './security';
import { accountingTransaction } from './accounting-ledger';
import { formatAmount } from '../shared/accounting';
import { bankPreviewInput, bankImportInput, bankMatchInput, bankReconcileInput, bankCancelInput, operationsDate, type BankPreview, type BankStatement } from '../shared/accounting-operations';
import { cashAccount, operationsAmount, operationsConfig, operationCommand } from './accounting-operations';
import { toCsv } from './reports';
const day = (value: unknown) => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
const lineFingerprint = (line: { date: string; reference: string; amount: string }) => digest(JSON.stringify([line.date,line.reference,line.amount]));

export async function previewBankStatement(db: Database, actor: Actor, hash: string | undefined, raw: unknown): Promise<BankPreview> {
  const input = bankPreviewInput.parse(raw);
  return accountingTransaction(db, actor, hash, async (tx, current) => {
    const config = await operationsConfig(tx, current,'banking'); await cashAccount(tx, current, input.cashAccountId);
    const mapping = input.mapping, selected = Object.values(mapping); requireCondition(new Set(selected).size === selected.length,400,'Map each bank column once.');
    let records: Record<string,string>[];
    try {
      records = parse(input.csv, { bom:true, skip_empty_lines:true, max_record_size:10000, columns: (columns: string[]) => {
        requireCondition(new Set(columns).size === columns.length && columns.every(value => value.length > 0 && value.length <= 80),400,'CSV needs unique, non-empty headers of at most 80 characters.');
        requireCondition(selected.every(value => columns.includes(value)),400,'Every mapped column must exist in the CSV.'); return columns;
      }});
    } catch (error) { if (error instanceof Problem) throw error; throw new Problem(400,'Could not read the bank CSV. Use a header row and consistently quoted columns.'); }
    requireCondition(records.length > 0 && records.length <= 2000,400,'Import between 1 and 2,000 statement lines.');
    const seen = new Set<string>();
    const lines = records.map((row,index) => {
      const date = operationsDate.parse(row[mapping.date]?.trim()), reference = row[mapping.reference]?.trim(), description = mapping.description ? row[mapping.description]?.trim() : '';
      requireCondition(date >= input.from && date <= input.to,400,`Bank row ${index+1} falls outside the statement dates.`);
      requireCondition(reference && reference.length <= 120 && description.length <= 300,400,`Bank row ${index+1} needs a reference of at most 120 characters and description of at most 300.`);
      const value = operationsAmount(row[mapping.amount]?.trim() ?? '',config.precision); requireCondition(value !== 0n,400,`Bank row ${index+1} must have a nonzero amount.`);
      const line = {date,reference,description,amount:formatAmount(value,config.precision)}, fingerprint = lineFingerprint(line);
      requireCondition(!seen.has(fingerprint),400,`Bank row ${index+1} duplicates a date, reference and amount. Use the bank's distinct transaction references.`); seen.add(fingerprint); return line;
    });
    const opening = operationsAmount(input.openingBalance,config.precision), closing = operationsAmount(input.closingBalance,config.precision), movement = lines.reduce((sum,line)=>sum+operationsAmount(line.amount,config.precision),0n);
    requireCondition(opening+movement === closing,400,'Opening balance plus imported transactions must equal the statement closing balance.');
    let duplicateCount = 0;
    for(const fingerprint of seen) duplicateCount += (await tx.query('SELECT l.id FROM accounting_bank_lines l WHERE l.org_id=$1 AND l.cash_account_id=$2 AND l.fingerprint=$3 AND NOT EXISTS(SELECT 1 FROM accounting_bank_cancellations c WHERE c.statement_id=l.statement_id)',[current.org_id,input.cashAccountId,fingerprint])).rows.length;
    const sourceHash = digest(input.csv), base = { cashAccountId:input.cashAccountId,from:input.from,to:input.to,openingBalance:formatAmount(opening,config.precision),closingBalance:formatAmount(closing,config.precision),movement:formatAmount(movement,config.precision),currency:config.currency,precision:config.precision,lines,duplicateCount };
    const id = randomUUID(), fingerprint = digest(JSON.stringify({sourceHash,...base}));
    await tx.query('INSERT INTO accounting_bank_previews(id,org_id,actor_id,input,fingerprint,source_hash,source_text) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,current.org_id,current.id,JSON.stringify(base),fingerprint,sourceHash,input.csv]);
    await audit(tx,current,'accounting.bank_preview_created',id,{sourceHash,lineCount:lines.length,duplicateCount}); return {id,fingerprint,sourceHash,...base};
  });
}
export async function bankStatementRecord(tx: Queryable, actor: Actor, id: string): Promise<BankStatement> {
  await operationsConfig(tx,actor,'banking');
  const statement = (await tx.query('SELECT s.*,a.name AS account_name FROM accounting_bank_statements s JOIN accounting_accounts a ON a.id=s.cash_account_id AND a.org_id=s.org_id WHERE s.org_id=$1 AND s.id=$2',[actor.org_id,id])).rows[0];
  requireCondition(statement,404,'Bank statement not found.');
  const lines = (await tx.query("SELECT l.*,coalesce(jsonb_agg(m.journal_line_id ORDER BY m.journal_line_id) FILTER(WHERE m.journal_line_id IS NOT NULL),'[]'::jsonb) AS journal_line_ids FROM accounting_bank_lines l LEFT JOIN accounting_bank_matches m ON m.statement_line_id=l.id AND m.org_id=l.org_id WHERE l.org_id=$1 AND l.statement_id=$2 GROUP BY l.id ORDER BY l.date,l.reference,l.id",[actor.org_id,id])).rows;
  const reconciliation = (await tx.query('SELECT evidence,created_at FROM accounting_bank_reconciliations WHERE org_id=$1 AND statement_id=$2',[actor.org_id,id])).rows[0];
  const cancellation = (await tx.query('SELECT reason FROM accounting_bank_cancellations WHERE org_id=$1 AND statement_id=$2',[actor.org_id,id])).rows[0];
  return {id,cashAccountId:statement.cash_account_id,accountName:statement.account_name,from:day(statement.from_date),to:day(statement.to_date),openingBalance:statement.opening_balance,
    closingBalance:statement.closing_balance,currency:statement.currency,precision:statement.precision,status:cancellation?'cancelled':reconciliation?'reconciled':'open',sourceHash:statement.source_hash,
    ...(cancellation?{cancellationReason:cancellation.reason}:{}),
    lines:lines.map(line=>({id:line.id,date:day(line.date),reference:line.reference,description:line.description,amount:line.amount,journalLineId:line.journal_line_ids[0] ?? null,journalLineIds:line.journal_line_ids})),
    ...(reconciliation?{reconciliation:{...reconciliation.evidence,reconciledAt:new Date(reconciliation.created_at).toISOString()}}:{})};
}
export async function importBankStatement(db: Database, actor: Actor, hash: string | undefined, raw: unknown): Promise<BankStatement> {
  const input = bankImportInput.parse(raw);
  return accountingTransaction(db,actor,hash,(tx,current)=>operationCommand(tx,current,input.commandId,{action:'bank_import',input},async()=>{
    const config = await operationsConfig(tx,current,'banking'), preview = (await tx.query('SELECT * FROM accounting_bank_previews WHERE org_id=$1 AND actor_id=$2 AND id=$3',[current.org_id,current.id,input.previewId])).rows[0];
    requireCondition(preview && preview.fingerprint === input.fingerprint && new Date(preview.expires_at).getTime() > Date.now(),409,'The private bank preview has changed or expired. Preview again.');
    const source = preview.input as Omit<BankPreview,'id'|'fingerprint'|'sourceHash'>;
    requireCondition(source.currency === config.currency && source.precision === config.precision,409,'Currency settings changed. Preview again.'); await cashAccount(tx,current,source.cashAccountId);
    requireCondition(!(await tx.query('SELECT s.id FROM accounting_bank_statements s JOIN accounting_bank_reconciliations r ON r.statement_id=s.id AND r.org_id=s.org_id WHERE s.org_id=$1 AND s.cash_account_id=$2 AND s.to_date>=$3',[current.org_id,source.cashAccountId,source.from])).rows.length,409,'New statements must follow the finalized reconciliation history.');
    requireCondition(!(await tx.query('SELECT s.id FROM accounting_bank_statements s WHERE s.org_id=$1 AND s.cash_account_id=$2 AND s.from_date<=$3 AND s.to_date>=$4 AND NOT EXISTS(SELECT 1 FROM accounting_bank_cancellations c WHERE c.statement_id=s.id)',[current.org_id,source.cashAccountId,source.to,source.from])).rows.length,409,'Statement dates overlap an existing statement for this cash account.');
    for(const line of source.lines) requireCondition(!(await tx.query('SELECT l.id FROM accounting_bank_lines l WHERE l.org_id=$1 AND l.cash_account_id=$2 AND l.fingerprint=$3 AND NOT EXISTS(SELECT 1 FROM accounting_bank_cancellations c WHERE c.statement_id=l.statement_id)',[current.org_id,source.cashAccountId,lineFingerprint(line)])).rows.length,409,'A statement line was already imported for this cash account.');
    const id = randomUUID();
    await tx.query(`INSERT INTO accounting_bank_statements(id,org_id,cash_account_id,from_date,to_date,opening_balance,closing_balance,currency,precision,source_hash,source_text,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,current.org_id,source.cashAccountId,source.from,source.to,source.openingBalance,source.closingBalance,source.currency,source.precision,preview.source_hash,preview.source_text,current.id]);
    for(const line of source.lines) await tx.query('INSERT INTO accounting_bank_lines(id,org_id,statement_id,cash_account_id,date,reference,description,amount,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),current.org_id,id,source.cashAccountId,line.date,line.reference,line.description,line.amount,lineFingerprint(line)]);
    await audit(tx,current,'accounting.bank_statement_imported',id,{sourceHash:preview.source_hash,lineCount:source.lines.length}); return bankStatementRecord(tx,current,id);
  }));
}
async function cashLedger(tx: Queryable, actor: Actor, statement: BankStatement): Promise<Row[]> {
  const rows = (await tx.query(`SELECT l.id,l.debit::text,l.credit::text,j.entry_date,j.description,j.reference,m.statement_line_id,
    b.statement_id AS matched_statement_id,r.statement_id AS reconciled_statement_id,o.statement_id AS opening_statement_id
    FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id AND j.org_id=l.org_id
    LEFT JOIN accounting_bank_matches m ON m.journal_line_id=l.id AND m.org_id=l.org_id
    LEFT JOIN accounting_bank_lines b ON b.id=m.statement_line_id AND b.org_id=m.org_id
    LEFT JOIN accounting_bank_reconciliations r ON r.statement_id=b.statement_id AND r.org_id=b.org_id
    LEFT JOIN accounting_bank_opening_lines o ON o.journal_line_id=l.id AND o.org_id=l.org_id
    WHERE l.org_id=$1 AND l.account_id=$2 AND j.status='posted' AND j.entry_date<=$3 ORDER BY j.entry_date,j.id,l.line_number LIMIT 10001`,[actor.org_id,statement.cashAccountId,statement.to])).rows;
  requireCondition(rows.length<=10000,400,'This reconciliation exceeds 10,000 ledger lines. A narrower ledger reconciliation workflow is required.'); return rows;
}
export async function bankCandidates(tx: Queryable, actor: Actor, id: string) {
  const statement = await bankStatementRecord(tx,actor,id), rows = await cashLedger(tx,actor,statement);
  return {rows:rows.filter(row=>!row.opening_statement_id && (!row.statement_line_id || row.matched_statement_id===id)).map(row=>({id:row.id,date:day(row.entry_date),description:row.description,reference:row.reference,amount:formatAmount(BigInt(row.debit)-BigInt(row.credit),statement.precision)}))};
}
export async function matchBankLine(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = bankMatchInput.parse(raw);
  return accountingTransaction(db,actor,hash,(tx,current)=>operationCommand(tx,current,input.commandId,{action:'bank_match',id,input},async()=>{
    const statement = await bankStatementRecord(tx,current,id); requireCondition(statement.status==='open',409,'Reconciled bank evidence cannot be changed.');
    const line = statement.lines.find(value=>value.id===input.statementLineId); requireCondition(line,404,'Statement line not found.');
    const ids=input.journalLineIds ?? (input.journalLineId?[input.journalLineId]:[]);
    requireCondition(new Set(ids).size===ids.length,400,'Choose each ledger line once.');
    if(ids.length) {
      const ledger=await cashLedger(tx,current,statement); let total=0n;
      for(const selected of ids) {
        const candidate=ledger.find(row=>row.id===selected);
        requireCondition(candidate,400,'Choose posted ledger lines on this cash account dated on or before the statement end.');
        requireCondition(!candidate.opening_statement_id,409,'That ledger line belongs to reviewed opening balance evidence.');
        requireCondition(!candidate.statement_line_id || candidate.statement_line_id===line.id,409,'That ledger line is already matched to another statement line.');
        total+=BigInt(candidate.debit)-BigInt(candidate.credit);
      }
      requireCondition(total===operationsAmount(line.amount,statement.precision),400,'The signed bank and selected ledger amounts must match exactly.');
    }
    await tx.query('DELETE FROM accounting_bank_matches WHERE org_id=$1 AND statement_line_id=$2',[current.org_id,line.id]);
    for(const selected of ids) await tx.query('INSERT INTO accounting_bank_matches(statement_line_id,org_id,journal_line_id,matched_by) VALUES($1,$2,$3,$4)',[line.id,current.org_id,selected,current.id]);
    await audit(tx,current,'accounting.bank_match_reviewed',id,{statementLineId:line.id,journalLineIds:ids}); return bankStatementRecord(tx,current,id);
  }));
}
export async function reconcileBankStatement(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = bankReconcileInput.parse(raw);
  return accountingTransaction(db,actor,hash,(tx,current)=>operationCommand(tx,current,input.commandId,{action:'bank_reconcile',id,input},async()=>{
    const statement = await bankStatementRecord(tx,current,id); requireCondition(statement.status==='open',409,'This statement is already reconciled.');
    requireCondition(statement.lines.every(line=>line.journalLineId),409,'Review and match every bank transaction before reconciling.');
    const previous = (await tx.query(`SELECT s.* FROM accounting_bank_statements s WHERE s.org_id=$1 AND s.cash_account_id=$2 AND s.to_date<$3 AND NOT EXISTS(SELECT 1 FROM accounting_bank_cancellations c WHERE c.statement_id=s.id) ORDER BY s.to_date DESC LIMIT 1`,[current.org_id,statement.cashAccountId,statement.from])).rows[0];
    if(previous) {
      const record = await bankStatementRecord(tx,current,previous.id);
      requireCondition(record.status==='reconciled',409,'Reconcile the preceding statement first.');
      requireCondition(operationsAmount(record.closingBalance,statement.precision)===operationsAmount(statement.openingBalance,statement.precision),409,'Opening balance must equal the preceding statement closing balance.');
      requireCondition(Date.parse(statement.from)-Date.parse(record.to)===86_400_000,409,'Statement dates must continue directly after the preceding statement.');
    }
    const rows = await cashLedger(tx,current,statement), ledger = rows.reduce((sum,row)=>sum+BigInt(row.debit)-BigInt(row.credit),0n);
    const openingLines = !previous ? rows.filter(row=>day(row.entry_date)<statement.from && !row.statement_line_id) : [];
    if(!previous && (openingLines.length || operationsAmount(statement.openingBalance,statement.precision)!==0n)) {
      requireCondition(input.openingBalanceReviewed,409,'Confirm that the opening ledger lines represent the cleared starting bank balance.');
      requireCondition(openingLines.reduce((sum,row)=>sum+BigInt(row.debit)-BigInt(row.credit),0n)===operationsAmount(statement.openingBalance,statement.precision),409,'The reviewed opening ledger lines must equal the first statement opening balance.');
    }
    const openingIds = new Set(openingLines.map(row=>row.id));
    const outstanding = rows.filter(row=>row.matched_statement_id!==id && !row.reconciled_statement_id && !row.opening_statement_id && !openingIds.has(row.id)).map(row=>({id:row.id,date:day(row.entry_date),description:row.description,amount:formatAmount(BigInt(row.debit)-BigInt(row.credit),statement.precision)}));
    const outstandingAmount = outstanding.reduce((sum,row)=>sum+operationsAmount(row.amount,statement.precision),0n), adjusted = ledger-outstandingAmount;
    requireCondition(adjusted===operationsAmount(statement.closingBalance,statement.precision),409,'The adjusted ledger balance does not equal the bank statement closing balance. Review opening evidence and all matches.');
    const evidence = {ledgerBalance:formatAmount(ledger,statement.precision),outstandingAmount:formatAmount(outstandingAmount,statement.precision),adjustedLedgerBalance:formatAmount(adjusted,statement.precision),outstanding,
      sourceHash:statement.sourceHash,lines:statement.lines,openingBalance:statement.openingBalance,closingBalance:statement.closingBalance,
      openingBalanceReviewed:input.openingBalanceReviewed,openingLedgerLineIds:[...openingIds]};
    for(const openingId of openingIds) await tx.query('INSERT INTO accounting_bank_opening_lines(journal_line_id,org_id,statement_id) VALUES($1,$2,$3)',[openingId,current.org_id,id]);
    await tx.query('INSERT INTO accounting_bank_reconciliations(statement_id,org_id,evidence,created_by) VALUES($1,$2,$3,$4)',[id,current.org_id,JSON.stringify(evidence),current.id]);
    await audit(tx,current,'accounting.bank_reconciled',id,{sourceHash:statement.sourceHash,lineCount:statement.lines.length,ledgerBalance:evidence.ledgerBalance,outstandingAmount:evidence.outstandingAmount});
    return bankStatementRecord(tx,current,id);
  }));
}
export function registerAccountingBankingRoutes(app: Express, db: Database) {
  const actor=(req:Request)=>(req as AppRequest).actor,hash=(req:Request)=>(req as AppRequest).sessionHash,id=(req:Request)=>z.uuid().parse(req.params.id);
  app.post('/api/accounting/bank-statements/preview',async(req,res)=>res.status(201).json(await previewBankStatement(db,actor(req),hash(req),req.body)));
  app.post('/api/accounting/bank-statements',async(req,res)=>res.status(201).json(await importBankStatement(db,actor(req),hash(req),req.body)));
  app.get('/api/accounting/bank-statements',async(req,res)=>res.json(await accountingTransaction(db,actor(req),hash(req),async(tx,current)=>{
    await operationsConfig(tx,current,'banking');
    const ids=(await tx.query('SELECT id FROM accounting_bank_statements WHERE org_id=$1 ORDER BY to_date DESC,id LIMIT 501',[current.org_id])).rows;
    requireCondition(ids.length<=500,400,'More than 500 statements need a narrower catalog.'); const rows=[]; for(const value of ids) rows.push(await bankStatementRecord(tx,current,value.id)); return {rows};
  })));
  app.get('/api/accounting/bank-statements/:id/candidates',async(req,res)=>res.json(await accountingTransaction(db,actor(req),hash(req),(tx,current)=>bankCandidates(tx,current,id(req)))));
  app.get('/api/accounting/bank-statements/:id',async(req,res)=>{
    const format=z.enum(['json','csv','source']).default('json').parse(req.query.format);
    if(format==='source') {
      const source=await accountingTransaction(db,actor(req),hash(req),async(tx,current)=>{
        const value=await bankStatementRecord(tx,current,id(req));
        const row=(await tx.query('SELECT source_text FROM accounting_bank_statements WHERE org_id=$1 AND id=$2',[current.org_id,value.id])).rows[0];
        await audit(tx,current,'accounting.bank_source_exported',value.id,{sourceHash:value.sourceHash}); return {text:row.source_text,sourceHash:value.sourceHash};
      }); res.set('X-Source-Hash',source.sourceHash).type('text/plain').attachment('bank-statement-original-source.txt').send(source.text); return;
    }
    const result=await accountingTransaction(db,actor(req),hash(req),async(tx,current)=>{
      const value=await bankStatementRecord(tx,current,id(req)); await audit(tx,current,'accounting.bank_statement_read',value.id,{format,status:value.status}); return value;
    });
    if(format==='json') res.json(result); else res.type('text/csv').attachment('bank-statement-'+result.to+'.csv').send(toCsv(result.lines.map(line=>({Date:line.date,Reference:line.reference,Description:line.description,Amount:line.amount,Currency:result.currency,Review:line.journalLineId?'Matched':'Unmatched'})),['Date','Reference','Description','Amount','Currency','Review']));
  });
  app.post('/api/accounting/bank-statements/:id/matches',async(req,res)=>res.json(await matchBankLine(db,actor(req),hash(req),id(req),req.body)));
  app.post('/api/accounting/bank-statements/:id/reconcile',async(req,res)=>res.json(await reconcileBankStatement(db,actor(req),hash(req),id(req),req.body)));
  app.post('/api/accounting/bank-statements/:id/cancel',async(req,res)=>res.json(await cancelBankStatement(db,actor(req),hash(req),id(req),req.body)));
}
export async function cancelBankStatement(db:Database,actor:Actor,hash:string|undefined,id:string,raw:unknown) {
  const input=bankCancelInput.parse(raw);
  return accountingTransaction(db,actor,hash,(tx,current)=>operationCommand(tx,current,input.commandId,{action:'bank_cancel',id,input},async()=>{
    const statement=await bankStatementRecord(tx,current,id); requireCondition(statement.status==='open',409,'Only an open statement can be cancelled. Finalized evidence is immutable.');
    await tx.query('DELETE FROM accounting_bank_matches WHERE org_id=$1 AND statement_line_id IN (SELECT id FROM accounting_bank_lines WHERE org_id=$1 AND statement_id=$2)',[current.org_id,id]);
    await tx.query('INSERT INTO accounting_bank_cancellations(statement_id,org_id,reason,created_by) VALUES($1,$2,$3,$4)',[id,current.org_id,input.reason,current.id]);
    await audit(tx,current,'accounting.bank_statement_cancelled',id,{reason:input.reason,sourceHash:statement.sourceHash}); return bankStatementRecord(tx,current,id);
  }));
}
