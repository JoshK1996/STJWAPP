import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import type { AppRequest } from './auth';
import type { Database, Queryable, Row } from './db';
import { audit, digest, requireCondition, Problem, type Actor } from './security';
import { accountingTransaction, lockAccounting, postJournalTx, assertOpenPeriod } from './accounting-ledger';
import { parseAmount as parseUnsigned, formatAmount } from '../shared/accounting';
import { accountingContactInput, accountingDocumentInput, accountingIssueInput, accountingVoidInput,
  accountingPaymentInput, accountingCreditInput, accountingRefundInput, operationsDate,
  type AccountingContact, type AccountingDocument, type AccountingDocumentEvent, type AccountingAging } from '../shared/accounting-operations';
import { toCsv } from './reports';

const day = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
export function operationsAmount(value: string, precision: number): bigint {
  try { return value.startsWith('-') ? -parseUnsigned(value.slice(1), precision) : parseUnsigned(value, precision); }
  catch { throw new Problem(400, `Use an exact amount with at most ${precision} decimal places.`); }
}
const parseAmount = operationsAmount;
export async function operationCommand<T>(tx: Queryable, actor: Actor, commandId: string, input: unknown, work: () => Promise<T>): Promise<T> {
  const operation = input as {action?: string; id?: string; input?: {kind?: string}};
  if (operation.action?.startsWith('bank_')) await operationsConfig(tx,actor,'banking');
  else if (operation.action === 'document') await operationsConfig(tx,actor,operation.input?.kind === 'bill' ? 'payables' : 'receivables');
  else if (operation.id && operation.action !== 'contact') {
    const doc=(await tx.query('SELECT kind FROM accounting_documents WHERE org_id=$1 AND id=$2',[actor.org_id,operation.id])).rows[0];
    if(doc) await operationsConfig(tx,actor,doc.kind === 'bill' ? 'payables' : 'receivables');
  }
  const fingerprint = digest(JSON.stringify(input));
  const previous = (await tx.query('SELECT actor_id,fingerprint,result FROM accounting_operation_commands WHERE org_id=$1 AND command_id=$2', [actor.org_id, commandId])).rows[0];
  if (previous) { requireCondition(previous.actor_id === actor.id && previous.fingerprint === fingerprint, 409, 'This command was already used by another account or for different data.'); return previous.result as T; }
  const result = JSON.parse(JSON.stringify(await work())) as T;
  await tx.query('INSERT INTO accounting_operation_commands(org_id,command_id,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)', [actor.org_id, commandId, actor.id, fingerprint, JSON.stringify(result)]);
  return result;
}
export async function operationsConfig(tx: Queryable, actor: Actor, module?: string) {
  const config = await lockAccounting(tx, actor);
  requireCondition(config.configured, 409, 'Configure and review accounting settings before creating transactions.');
  if (module) requireCondition(config.modules.includes(module),403,'Enable the '+module+' workspace in accounting settings first.');
  return config;
}
export async function operationsOpenDate(tx: Queryable, actor: Actor, date: string) {
  await assertOpenPeriod(tx, actor, date);
}
async function account(tx: Queryable, actor: Actor, id: string) {
  const result = (await tx.query('SELECT * FROM accounting_accounts WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows[0];
  requireCondition(result?.active, 400, 'Choose an active account in this organization.'); return result;
}
export async function cashAccount(tx: Queryable, actor: Actor, id: string) {
  const value = await account(tx, actor, id); requireCondition(value.type === 'asset' && value.is_cash, 400, 'Choose an active asset account marked as cash or bank.'); return value;
}
const positive = (value: string, precision: number) => { const result = parseAmount(value, precision); requireCondition(result > 0n, 400, 'Amounts must be greater than zero.'); return result; };
function event(row: Row): AccountingDocumentEvent { return { id: row.id, type: row.type, date: day(row.date), amount: row.amount,
  reference: row.reference, reason: row.reason, paymentId: row.payment_id ?? undefined, journalId: row.journal_id ?? undefined, allocations: row.allocations }; }
export async function documentRecord(tx: Queryable, actor: Actor, id: string, asOf?: string): Promise<AccountingDocument> {
  const row = (await tx.query('SELECT * FROM accounting_documents WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows[0];
  requireCondition(row, 404, 'Accounting document not found.');
  await operationsConfig(tx,actor,row.kind === 'bill' ? 'payables' : 'receivables');
  const events = (await tx.query('SELECT * FROM accounting_document_events WHERE org_id=$1 AND document_id=$2 ORDER BY created_at,id', [actor.org_id, id])).rows
    .filter(value => !asOf || day(value.date) <= asOf).map(event);
  const precision = row.precision, sum = (type: string) => events.filter(value => value.type === type).reduce((total, value) => total + parseAmount(value.amount, precision), 0n);
  const credited = sum('credit'), paid = sum('payment') - sum('payment_void'), refunded = sum('refund');
  const status = events.some(value => value.type === 'void') ? 'void' : events.some(value => value.type === 'issue') ? 'issued' : 'draft';
  return { id, kind: row.kind, contactId: row.contact_id, contactName: row.contact_name, number: row.number, date: day(row.date), dueDate: day(row.due_date),
    description: row.description, controlAccountId: row.control_account_id ?? undefined, currency: row.currency, precision, basis: row.basis,
    status, lines: row.lines, total: row.total, credited: formatAmount(credited, precision), paid: formatAmount(paid, precision),
    refunded: formatAmount(refunded, precision), outstanding: formatAmount(status === 'void' ? 0n : parseAmount(row.total, precision) - credited - paid + refunded, precision), events };
}
export async function listAccountingContacts(db: Database, actor: Actor, hash: string | undefined) {
  return accountingTransaction(db, actor, hash, async (tx, current) => {
    const rows = (await tx.query('SELECT id,name,kind,email,note FROM accounting_contacts WHERE org_id=$1 ORDER BY name,id LIMIT 2001', [current.org_id])).rows as AccountingContact[];
    requireCondition(rows.length <= 2000, 400, 'Contact catalog exceeds 2,000 entries. Narrower paging is required.'); return { rows };
  });
}
export async function createAccountingContact(db: Database, actor: Actor, hash: string | undefined, raw: unknown) {
  const input = accountingContactInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'contact', input }, async () => {
    const result: AccountingContact = { id: randomUUID(), name: input.name, kind: input.kind, email: input.email ?? '', note: input.note };
    await tx.query('INSERT INTO accounting_contacts(id,org_id,name,kind,email,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [result.id, current.org_id, result.name, result.kind, result.email, result.note, current.id]);
    await audit(tx, current, 'accounting.contact_created', result.id, { kind: result.kind }); return result;
  }));
}
export async function createAccountingDocument(db: Database, actor: Actor, hash: string | undefined, raw: unknown) {
  const input = accountingDocumentInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'document', input }, async () => {
    const config = await operationsConfig(tx, current, input.kind === 'bill' ? 'payables' : 'receivables');
    const contact = (await tx.query('SELECT * FROM accounting_contacts WHERE org_id=$1 AND id=$2', [current.org_id, input.contactId])).rows[0];
    requireCondition(contact, 400, 'Choose a contact in this organization.');
    requireCondition(input.kind === 'bill' ? contact.kind === 'vendor' : contact.kind !== 'vendor', 400, 'Bills require a vendor; invoices require a customer, family or donor.');
    requireCondition(!(await tx.query('SELECT id FROM accounting_documents WHERE org_id=$1 AND kind=$2 AND contact_id=$3 AND number=$4', [current.org_id, input.kind, input.contactId, input.number])).rows.length, 409, 'This document number already exists for this contact.');
    if (config.basis === 'accrual') requireCondition(input.controlAccountId, 400, 'Choose the receivable or payable control account for accrual accounting.');
    if (input.controlAccountId) {
      const control = await account(tx, current, input.controlAccountId);
      requireCondition(!control.is_cash && control.type === (input.kind === 'invoice' ? 'asset' : 'liability'), 400, 'The control account must be a non-cash receivable asset or payable liability.');
    }
    let total = 0n;
    const lines = [];
    for (const line of input.lines) {
      const coded = await account(tx, current, line.accountId);
      requireCondition(!coded.is_cash && line.accountId !== input.controlAccountId && (input.kind === 'invoice' ? coded.type === 'revenue' : ['expense','asset'].includes(coded.type)), 400, 'Choose revenue coding for invoices and expense or non-cash asset coding for bills.');
      if (line.unitId) requireCondition((await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=$2', [current.org_id, line.unitId])).rows.length, 400, 'Community belongs to another organization.');
      if (line.fundId) requireCondition((await tx.query('SELECT id FROM accounting_funds WHERE org_id=$1 AND id=$2 AND active=true', [current.org_id, line.fundId])).rows.length, 400, 'Choose an active fund in this organization.');
      const value = positive(line.amount, config.precision); total += value;
      lines.push({ ...line, amount: formatAmount(value, config.precision) });
    }
    const id = randomUUID();
    await tx.query(`INSERT INTO accounting_documents(id,org_id,kind,contact_id,contact_name,number,date,due_date,description,control_account_id,currency,precision,basis,lines,total,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [id, current.org_id, input.kind, input.contactId, contact.name, input.number, input.date, input.dueDate, input.description,
      input.controlAccountId ?? null, config.currency, config.precision, config.basis, JSON.stringify(lines), formatAmount(total, config.precision), current.id]);
    await audit(tx, current, 'accounting.document_drafted', id, { kind: input.kind, total: formatAmount(total, config.precision) }); return documentRecord(tx, current, id);
  }));
}
type Allocation = { lineIndex: number; amount: string };
async function addEvent(tx: Queryable, actor: Actor, doc: AccountingDocument, input: {
  id: string; type: AccountingDocumentEvent['type']; date: string; amount: string; reference?: string; reason?: string;
  paymentId?: string; journalId?: string; cashAccountId?: string; allocations?: Allocation[] }) {
  await tx.query(`INSERT INTO accounting_document_events(id,org_id,document_id,type,date,amount,reference,reason,payment_id,journal_id,cash_account_id,allocations,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [input.id, actor.org_id, doc.id, input.type, input.date, input.amount, input.reference ?? '', input.reason ?? '',
    input.paymentId ?? null, input.journalId ?? null, input.cashAccountId ?? null, JSON.stringify(input.allocations ?? []), actor.id]);
  await audit(tx, actor, 'accounting.document_' + input.type, doc.id, { eventId: input.id, date: input.date, amount: input.amount, journalId: input.journalId ?? null });
}
const chronological = (doc: AccountingDocument, date: string) => requireCondition(date >= doc.date && doc.events.every(event => date >= event.date), 409, 'Use a date on or after the document and its latest recorded financial activity.');
function codedLines(doc: AccountingDocument, allocations: Allocation[], debit: boolean) {
  return allocations.map(allocation => ({ accountId: doc.lines[allocation.lineIndex].accountId,
    debit: debit ? allocation.amount : formatAmount(0n, doc.precision), credit: debit ? formatAmount(0n, doc.precision) : allocation.amount,
    unitId: doc.lines[allocation.lineIndex].unitId, fundId: doc.lines[allocation.lineIndex].fundId, memo: doc.lines[allocation.lineIndex].description }));
}
function offsetLine(accountId: string, value: string, debit: boolean, precision: number) {
  return { accountId, debit: debit ? value : formatAmount(0n, precision), credit: debit ? formatAmount(0n, precision) : value };
}
function offsetLines(doc: AccountingDocument, allocations: Allocation[], accountId: string, debit: boolean) {
  return allocations.map(allocation=>({...offsetLine(accountId,allocation.amount,debit,doc.precision),
    unitId:doc.lines[allocation.lineIndex].unitId,fundId:doc.lines[allocation.lineIndex].fundId,memo:doc.lines[allocation.lineIndex].description}));
}
export async function issueAccountingDocument(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = accountingIssueInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'issue', id, input }, async () => {
    const doc = await documentRecord(tx, current, id); requireCondition(doc.status === 'draft', 409, 'Only draft documents can be issued.');
    await operationsOpenDate(tx, current, doc.date);
    let journalId: string | undefined;
    if (doc.basis === 'accrual') {
      const allocations=doc.lines.map((line,lineIndex)=>({lineIndex,amount:line.amount}));
      journalId = randomUUID(); await postJournalTx(tx, current, { id: journalId, commandId: input.commandId, date: doc.date, description: doc.description, reference: doc.number,
        sourceType: 'document_issue', sourceId: id, lines: [...offsetLines(doc,allocations,doc.controlAccountId!,doc.kind==='invoice'),
          ...codedLines(doc, allocations, doc.kind === 'bill')] });
    }
    await addEvent(tx, current, doc, { id: randomUUID(), type: 'issue', date: doc.date, amount: doc.total, journalId }); return documentRecord(tx, current, id);
  }));
}
export function allocateExact(total: bigint, capacities: bigint[]): bigint[] {
  const sum = capacities.reduce((value, next) => value + next, 0n);
  requireCondition(total > 0n && total <= sum && capacities.every(value => value >= 0n), 400, 'Amount exceeds the available balance.');
  const allocated = capacities.map(value => total * value / sum); let remainder = total - allocated.reduce((value, next) => value + next, 0n);
  for (let index = 0; remainder > 0n && index < allocated.length; index++) if (allocated[index] < capacities[index]) { allocated[index]++; remainder--; }
  requireCondition(remainder === 0n, 400, 'Could not allocate the amount exactly.'); return allocated;
}
function allocationsFor(doc: AccountingDocument, amount: bigint, payment?: AccountingDocumentEvent): Allocation[] {
  const capacities = doc.lines.map((line, index) => {
    if (payment) {
      const original = payment.allocations.find(value => value.lineIndex === index)?.amount ?? '0';
      return parseAmount(original, doc.precision) - doc.events.filter(value => value.type === 'refund' && value.paymentId === payment.id)
        .reduce((sum, value) => sum + parseAmount(value.allocations.find(value => value.lineIndex === index)?.amount ?? '0', doc.precision), 0n);
    }
    return parseAmount(line.amount, doc.precision) - doc.events.filter(value => value.type === 'credit')
      .reduce((sum, value) => sum + parseAmount(value.allocations.find(value => value.lineIndex === index)?.amount ?? '0', doc.precision), 0n)
      - doc.events.filter(value => value.type === 'payment').reduce((sum, value) => sum + parseAmount(value.allocations.find(value => value.lineIndex === index)?.amount ?? '0', doc.precision), 0n)
      + doc.events.filter(value => value.type === 'refund' || value.type === 'payment_void').reduce((sum, value) => sum + parseAmount(value.allocations.find(value => value.lineIndex === index)?.amount ?? '0', doc.precision), 0n);
  });
  // Credits entered after payment can make a coded line negative. New money must
  // not silently change another line's account; refund the credited money first.
  let values: bigint[];
  if(payment) {
    // Refund credited coding first, then allocate any ordinary payment reversal.
    // This avoids reversing unrelated revenue when one tuition/care line was credited.
    const deficits=doc.lines.map((line,index)=>{
      const signed=doc.events.reduce((sum,event)=>{
        const value=parseAmount(event.allocations.find(item=>item.lineIndex===index)?.amount ?? '0',doc.precision);
        return sum+(['credit','payment'].includes(event.type)?value:['refund','payment_void'].includes(event.type)?-value:0n);
      },0n)-parseAmount(line.amount,doc.precision);
      return signed>0n?(signed<capacities[index]?signed:capacities[index]):0n;
    });
    const deficitTotal=deficits.reduce((sum,value)=>sum+value,0n), first=deficitTotal<amount?deficitTotal:amount;
    values=first?allocateExact(first,deficits):capacities.map(()=>0n);
    if(first<amount) { const remainder=allocateExact(amount-first,capacities.map((value,index)=>value-values[index])); values=values.map((value,index)=>value+remainder[index]); }
  } else values = allocateExact(amount, capacities);
  return values.flatMap((value, lineIndex) => value ? [{ lineIndex, amount: formatAmount(value, doc.precision) }] : []);
}
async function settlementJournal(tx: Queryable, actor: Actor, doc: AccountingDocument, id: string, commandId: string, date: string,
  cashAccountId: string, amount: string, allocations: Allocation[], reverse: boolean, reference: string) {
  const incoming = doc.kind === 'invoice' !== reverse;
  await postJournalTx(tx, actor, { id, commandId, date, description: (reverse ? 'Reverse settlement: ' : 'Recorded settlement: ') + doc.description,
    reference, sourceType: reverse ? 'document_refund' : 'document_payment', sourceId: doc.id,
    lines: [...offsetLines(doc,allocations,cashAccountId,incoming), ...(doc.basis === 'accrual'
      ? offsetLines(doc,allocations,doc.controlAccountId!,!incoming) : codedLines(doc, allocations, !incoming))] });
}
export async function payAccountingDocument(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = accountingPaymentInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'payment', id, input }, async () => {
    const doc = await documentRecord(tx, current, id); requireCondition(doc.status === 'issued', 409, 'Issue the document before recording a payment.');
    chronological(doc, input.date); await cashAccount(tx, current, input.cashAccountId);
    requireCondition(!(await tx.query("SELECT id FROM accounting_document_events WHERE org_id=$1 AND document_id=$2 AND type='payment' AND date=$3 AND reference=$4 AND cash_account_id=$5",[current.org_id,id,input.date,input.reference,input.cashAccountId])).rows.length,409,'A payment with this date and reference is already recorded for this document.');
    const value = positive(input.amount, doc.precision); requireCondition(value <= parseAmount(doc.outstanding, doc.precision), 409, 'Payment exceeds the document balance.');
    const amount = formatAmount(value, doc.precision), allocations = allocationsFor(doc, value), journalId = randomUUID();
    await settlementJournal(tx, current, doc, journalId, input.commandId, input.date, input.cashAccountId, amount, allocations, false, input.reference);
    await addEvent(tx, current, doc, { id: randomUUID(), type: 'payment', date: input.date, amount, cashAccountId: input.cashAccountId, reference: input.reference, allocations, journalId });
    return documentRecord(tx, current, id);
  }));
}
export async function creditAccountingDocument(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = accountingCreditInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'credit', id, input }, async () => {
    const doc = await documentRecord(tx, current, id); requireCondition(doc.status === 'issued', 409, 'Only issued documents can be credited.'); chronological(doc, input.date);
    await operationsOpenDate(tx, current, input.date); requireCondition(new Set(input.lines.map(line => line.lineIndex)).size === input.lines.length, 400, 'Choose each original line once.');
    let total = 0n; const allocations: Allocation[] = [];
    for (const line of input.lines) {
      requireCondition(doc.lines[line.lineIndex], 400, 'Choose an original document line.');
      const value = positive(line.amount, doc.precision), previous = doc.events.filter(value => value.type === 'credit').reduce((sum, event) => sum + parseAmount(event.allocations.find(value => value.lineIndex === line.lineIndex)?.amount ?? '0', doc.precision), 0n);
      requireCondition(value + previous <= parseAmount(doc.lines[line.lineIndex].amount, doc.precision), 409, 'Credits exceed the original coded line.');
      total += value; allocations.push({ lineIndex: line.lineIndex, amount: formatAmount(value, doc.precision) });
    }
    const amount = formatAmount(total, doc.precision); let journalId: string | undefined;
    if (doc.basis === 'accrual') { journalId = randomUUID(); await postJournalTx(tx, current, { id: journalId, commandId: input.commandId, date: input.date, description: input.reason,
      reference: doc.number, sourceType: 'document_credit', sourceId: id, lines: [...offsetLines(doc,allocations,doc.controlAccountId!,doc.kind==='bill'), ...codedLines(doc, allocations, doc.kind === 'invoice')] }); }
    await addEvent(tx, current, doc, { id: randomUUID(), type: 'credit', date: input.date, amount, reason: input.reason, allocations, journalId }); return documentRecord(tx, current, id);
  }));
}
export async function refundAccountingPayment(db: Database, actor: Actor, hash: string | undefined, id: string, paymentId: string, raw: unknown, voidPayment = false) {
  const input = voidPayment ? accountingVoidInput.parse(raw) : accountingRefundInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: voidPayment ? 'payment_void' : 'refund', id, paymentId, input }, async () => {
    const doc = await documentRecord(tx, current, id); requireCondition(doc.status === 'issued', 409, 'Only issued documents can receive payment adjustments.'); chronological(doc, input.date);
    const payment = doc.events.find(value => value.type === 'payment' && value.id === paymentId);
    requireCondition(payment && !doc.events.some(value => value.type === 'payment_void' && value.paymentId === paymentId), 409, 'Choose an active payment on this document.');
    if(!voidPayment) requireCondition(!doc.events.some(value=>value.type==='refund' && value.paymentId===paymentId && value.date===input.date && value.reference===('reference' in input?input.reference:'')),409,'A refund with this date and reference is already recorded for this payment.');
    const refunded = doc.events.filter(value => value.type === 'refund' && value.paymentId === paymentId).reduce((sum, value) => sum + parseAmount(value.amount, doc.precision), 0n);
    if (voidPayment) requireCondition(refunded === 0n, 409, 'A partly refunded payment cannot be voided. Record the remaining refund instead.');
    const value = voidPayment ? parseAmount(payment.amount, doc.precision) : positive((input as z.infer<typeof accountingRefundInput>).amount, doc.precision);
    requireCondition(value <= parseAmount(payment.amount, doc.precision) - refunded, 409, 'Refund exceeds the remaining original payment.');
    const source = (await tx.query('SELECT cash_account_id FROM accounting_document_events WHERE org_id=$1 AND id=$2', [current.org_id, paymentId])).rows[0];
    const amount = formatAmount(value, doc.precision), allocations = allocationsFor(doc, value, payment), journalId = randomUUID(), reference = 'reference' in input ? input.reference : payment.reference;
    await settlementJournal(tx, current, doc, journalId, input.commandId, input.date, source.cash_account_id, amount, allocations, true, reference);
    await addEvent(tx, current, doc, { id: randomUUID(), type: voidPayment ? 'payment_void' : 'refund', date: input.date, amount, paymentId, cashAccountId: source.cash_account_id,
      reference, reason: 'reason' in input ? input.reason : '', allocations, journalId }); return documentRecord(tx, current, id);
  }));
}
export async function voidAccountingDocument(db: Database, actor: Actor, hash: string | undefined, id: string, raw: unknown) {
  const input = accountingVoidInput.parse(raw);
  return accountingTransaction(db, actor, hash, (tx, current) => operationCommand(tx, current, input.commandId, { action: 'void', id, input }, async () => {
    const doc = await documentRecord(tx, current, id); requireCondition(doc.status !== 'void', 409, 'This document is already void.'); chronological(doc, input.date);
    requireCondition(!doc.events.some(value => ['payment','credit','refund'].includes(value.type)), 409, 'Documents with payment or credit history must be settled with explicit credits and refunds.');
    await operationsOpenDate(tx, current, input.date); let journalId: string | undefined;
    if (doc.status === 'issued' && doc.basis === 'accrual') {
      const allocations=doc.lines.map((line,lineIndex)=>({lineIndex,amount:line.amount}));
      journalId = randomUUID(); await postJournalTx(tx, current, { id: journalId, commandId: input.commandId, date: input.date, description: input.reason,
        reference: doc.number, sourceType: 'document_void', sourceId: id, lines: [...offsetLines(doc,allocations,doc.controlAccountId!,doc.kind==='bill'),
          ...codedLines(doc, allocations, doc.kind === 'invoice')] });
    }
    await addEvent(tx, current, doc, { id: randomUUID(), type: 'void', date: input.date, amount: doc.total, reason: input.reason, journalId }); return documentRecord(tx, current, id);
  }));
}
export async function accountingAging(tx: Queryable, actor: Actor, asOf: string): Promise<AccountingAging> {
  const config = await operationsConfig(tx, actor), ids = (await tx.query('SELECT id FROM accounting_documents WHERE org_id=$1 AND date<=$2 ORDER BY due_date,number,id LIMIT 2001', [actor.org_id, asOf])).rows;
  requireCondition(ids.length <= 2000, 400, 'More than 2,000 documents need a narrower report.');
  const rows: AccountingAging['rows'] = [];
  for (const { id } of ids) {
    const kind=(await tx.query('SELECT kind FROM accounting_documents WHERE org_id=$1 AND id=$2',[actor.org_id,id])).rows[0].kind;
    if(!config.modules.includes(kind==='bill'?'payables':'receivables')) continue;
    const doc = await documentRecord(tx, actor, id, asOf), outstanding = parseAmount(doc.outstanding, doc.precision);
    if (doc.status !== 'issued' || outstanding === 0n) continue;
    const daysOverdue = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(doc.dueDate)) / 86_400_000));
    rows.push({ ...doc, daysOverdue, bucket: outstanding < 0n ? 'Credit balance' : daysOverdue === 0 ? 'Current' : daysOverdue <= 30 ? '1–30 days' : daysOverdue <= 60 ? '31–60 days' : daysOverdue <= 90 ? '61–90 days' : 'Over 90 days' });
  }
  return { asOf, currency: config.currency, precision: config.precision, rows };
}
export function registerAccountingOperationsRoutes(app: Express, db: Database) {
  const actor = (req: Request) => (req as AppRequest).actor, hash = (req: Request) => (req as AppRequest).sessionHash;
  const id = (req: Request) => z.uuid().parse(req.params.id);
  app.get('/api/accounting/contacts', async (req, res) => res.json(await listAccountingContacts(db, actor(req), hash(req))));
  app.post('/api/accounting/contacts', async (req, res) => res.status(201).json(await createAccountingContact(db, actor(req), hash(req), req.body)));
  app.get('/api/accounting/documents', async (req, res) => res.json(await accountingTransaction(db, actor(req), hash(req), async (tx, current) => {
    const config=await operationsConfig(tx,current);
    const kinds=['bill','invoice'].filter(kind=>config.modules.includes(kind==='bill'?'payables':'receivables'));
    const values = (await tx.query('SELECT id FROM accounting_documents WHERE org_id=$1 AND kind=ANY($2::text[]) ORDER BY date DESC,number,id LIMIT 501', [current.org_id,kinds])).rows;
    requireCondition(values.length <= 500, 400, 'More than 500 documents need a narrower catalog.');
    const rows = []; for (const value of values) rows.push(await documentRecord(tx, current, value.id)); return { rows };
  })));
  app.post('/api/accounting/documents', async (req, res) => res.status(201).json(await createAccountingDocument(db, actor(req), hash(req), req.body)));
  app.get('/api/accounting/documents/:id', async (req, res) => res.json(await accountingTransaction(db, actor(req), hash(req), (tx, current) => documentRecord(tx, current, id(req)))));
  app.post('/api/accounting/documents/:id/issue', async (req, res) => res.json(await issueAccountingDocument(db, actor(req), hash(req), id(req), req.body)));
  app.post('/api/accounting/documents/:id/void', async (req, res) => res.json(await voidAccountingDocument(db, actor(req), hash(req), id(req), req.body)));
  app.post('/api/accounting/documents/:id/payments', async (req, res) => res.json(await payAccountingDocument(db, actor(req), hash(req), id(req), req.body)));
  app.post('/api/accounting/documents/:id/credits', async (req, res) => res.json(await creditAccountingDocument(db, actor(req), hash(req), id(req), req.body)));
  app.post('/api/accounting/documents/:id/payments/:paymentId/refund', async (req, res) => res.json(await refundAccountingPayment(db, actor(req), hash(req), id(req), z.uuid().parse(req.params.paymentId), req.body)));
  app.post('/api/accounting/documents/:id/payments/:paymentId/void', async (req, res) => res.json(await refundAccountingPayment(db, actor(req), hash(req), id(req), z.uuid().parse(req.params.paymentId), req.body, true)));
  app.get('/api/accounting/aging', async (req, res) => {
    const query = z.object({ asOf: operationsDate, format: z.enum(['json','csv']).default('json') }).strict().parse(req.query);
    const result = await accountingTransaction(db, actor(req), hash(req), async (tx, current) => {
      const report = await accountingAging(tx, current, query.asOf);
      await audit(tx, current, 'accounting.aging_read', null, { asOf: query.asOf, format: query.format, count: report.rows.length }); return report;
    });
    if (query.format === 'json') res.json(result); else res.type('text/csv').attachment('accounting-aging-' + query.asOf + '.csv').send(toCsv(result.rows.map(row => ({
      Type: row.kind === 'invoice' ? 'Receivable' : 'Payable', Contact: row.contactName, Document: row.number, Description: row.description, Issued: row.date,
      Due: row.dueDate, Currency: row.currency, Total: row.total, Credits: row.credited, Payments: row.paid, Refunds: row.refunded, Outstanding: row.outstanding, Aging: row.bucket,
    })), ['Type','Contact','Document','Description','Issued','Due','Currency','Total','Credits','Payments','Refunds','Outstanding','Aging']));
  });
}
