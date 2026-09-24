import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Database, Queryable, Row } from './db';
import type { AppRequest } from './auth';
import { audit, digest, requireCondition, type Actor } from './security';
import { financeTransaction } from './finance-access';
import {
  accountingConfigInput, accountingAccountInput, accountingFundInput, accountingPeriodInput, accountingPeriodStatusInput,
  journalDraftInput, journalPostInput, journalReverseInput, parseAmount, formatAmount,
  type AccountingConfig, type AccountingAccount, type AccountingFund, type AccountingPeriod, type AccountingJournal,
  type AccountingWorkspace, type JournalLineInput, type JournalPostRequest,
} from '../shared/accounting';
import { installAccountingReports } from './accounting-reports';

export async function lockAccounting(tx: Queryable, actor: Actor): Promise<Row> {
  const created = await tx.query('INSERT INTO accounting_config(org_id) VALUES($1) ON CONFLICT(org_id) DO NOTHING RETURNING org_id', [actor.org_id]);
  if(created.rows.length)await audit(tx,actor,'accounting.starter_defaults_applied',null,{currency:'USD',precision:2,basis:'accrual',fiscalStartMonth:1,fiscalStartDay:1,reviewed:false});
  return (await tx.query('SELECT * FROM accounting_config WHERE org_id=$1 FOR UPDATE', [actor.org_id])).rows[0];
}
/** Account/session locks precede this organization lock; every accounting write then follows the same order. */
export function accountingTransaction<T>(db: Database, actor: Actor, sessionHash: string | undefined, fn: (tx: Queryable, current: Actor) => Promise<T>): Promise<T> {
  return financeTransaction(db, actor, sessionHash, async (tx, current) => { await lockAccounting(tx, current); return fn(tx, current); });
}
export async function requireAccountingConfig(tx: Queryable, actor: Actor, module = 'ledger'): Promise<Row> {
  const config = (await tx.query('SELECT * FROM accounting_config WHERE org_id=$1', [actor.org_id])).rows[0];
  requireCondition(config?.configured, 409, 'An authorized accountant must configure the books first.');
  requireCondition(config.modules.includes(module), 409, 'Enable this accounting workflow in settings first.');
  return config;
}
export async function assertOpenPeriod(tx: Queryable, actor: Actor, date: string): Promise<Row> {
  const periods = (await tx.query('SELECT * FROM accounting_periods WHERE org_id=$1 AND $2::date BETWEEN starts_on AND ends_on', [actor.org_id, date])).rows;
  requireCondition(periods.length === 1 && periods[0].status === 'open', 409, 'This date requires one open accounting period.');
  return periods[0];
}
export function publicAccountingConfig(row: Row): AccountingConfig {
  return {configured: row.configured, reviewed: row.reviewed, currency: row.currency, precision: row.precision, basis: row.basis, fiscalStartMonth: row.fiscal_start_month, fiscalStartDay: row.fiscal_start_day, modules: row.modules, revision: row.revision};
}
function day(value: unknown): string { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
export function publicAccountingAccount(row: Row): AccountingAccount {
  return {id: row.id, code: row.code, name: row.name, type: row.type, isCash: row.is_cash, cashFlowCategory: row.cash_flow_category, functionalCategory: row.functional_category, active: row.active, revision: row.revision};
}
function publicFund(row: Row): AccountingFund {
  return {id: row.id, code: row.code, name: row.name, kind: row.kind, restriction: row.restriction, purpose: row.purpose, active: row.active, allowedAccountIds: row.allowed_account_ids, allowedUnitIds: row.allowed_unit_ids, startsOn: row.starts_on ? day(row.starts_on) : null, endsOn: row.ends_on ? day(row.ends_on) : null, revision: row.revision};
}
function publicPeriod(row: Row): AccountingPeriod {return {id: row.id, name: row.name, startsOn: day(row.starts_on), endsOn: day(row.ends_on), status: row.status, revision: row.revision, reason: row.reason};}
export async function readAccountingJournal(tx: Queryable, actor: Actor, id: string, precision?: number): Promise<AccountingJournal> {
  const row = (await tx.query('SELECT j.*,(SELECT r.id FROM accounting_journals r WHERE r.org_id=j.org_id AND r.reversal_of=j.id) AS reversed_by FROM accounting_journals j WHERE j.id=$1 AND j.org_id=$2', [id, actor.org_id])).rows[0];
  requireCondition(row, 404, 'Journal not found.');
  precision ??= (await requireAccountingConfig(tx, actor)).precision;
  const lines = (await tx.query('SELECT *,debit::text AS debit_text,credit::text AS credit_text FROM accounting_journal_lines WHERE org_id=$1 AND journal_id=$2 ORDER BY line_number', [actor.org_id, id])).rows;
  return {id: row.id, date: day(row.entry_date), description: row.description, reference: row.reference, sourceType: row.source_type, sourceId: row.source_id, status: row.status, revision: row.revision,
    reversalOf: row.reversal_of, reversedBy: row.reversed_by, createdAt: new Date(row.created_at).toISOString(), postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    lines: lines.map(line => ({id: line.id, accountId: line.account_id, accountCode: line.account_snapshot.code, accountName: line.account_snapshot.name,
      debit: formatAmount(BigInt(line.debit_text), precision!), credit: formatAmount(BigInt(line.credit_text), precision!),
      ...(line.unit_id ? {unitId: line.unit_id} : {}), ...(line.fund_id ? {fundId: line.fund_id} : {}), ...(line.program_id ? {programId: line.program_id} : {}), ...(line.grant_id ? {grantId: line.grant_id} : {}), memo: line.memo, cashFlowCategory: line.cash_flow_category})),
  };
}
async function receipt(tx: Queryable, actor: Actor, commandId: string, fingerprint: string): Promise<any | undefined> {
  const row = (await tx.query('SELECT * FROM accounting_commands WHERE org_id=$1 AND command_id=$2', [actor.org_id, commandId])).rows[0];
  if (!row) return undefined;
  requireCondition(row.actor_id === actor.id && row.fingerprint === fingerprint, 409, 'This command was already used for another accounting action.');
  return row.receipt;
}
async function saveReceipt(tx: Queryable, actor: Actor, commandId: string, fingerprint: string, result: unknown) {
  await tx.query('INSERT INTO accounting_commands(org_id,command_id,actor_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)', [actor.org_id, commandId, actor.id, fingerprint, JSON.stringify(result)]);
}
async function validateLines(tx: Queryable, actor: Actor, date: string, lines: JournalLineInput[], precision: number, requireBalance = true) {
  const output: {line: JournalLineInput; account: Row; debit: bigint; credit: bigint}[] = [];
  let debit = 0n, credit = 0n;
  for (const line of lines) {
    let d: bigint, c: bigint;
    try { d = parseAmount(line.debit, precision); c = parseAmount(line.credit, precision); }
    catch { requireCondition(false, 400, `Amounts must use at most ${precision} decimal places.`); }
    requireCondition((d > 0n && c === 0n) || (c > 0n && d === 0n), 400, 'Each journal line needs one positive debit or credit.');
    const account = (await tx.query('SELECT * FROM accounting_accounts WHERE org_id=$1 AND id=$2', [actor.org_id, line.accountId])).rows[0];
    requireCondition(account?.active, 400, 'Select an active account in this organization.');
    if (line.unitId) requireCondition((await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=$2', [actor.org_id, line.unitId])).rows.length, 400, 'Select a community in this organization.');
    for (const [kind, dimensionId] of [['fund', line.fundId], ['program', line.programId], ['grant', line.grantId]] as const) {
      if (!dimensionId) continue;
      const dimension = (await tx.query('SELECT * FROM accounting_funds WHERE org_id=$1 AND id=$2', [actor.org_id, dimensionId])).rows[0];
      requireCondition(dimension?.active && dimension.kind === kind, 400, `Select an active ${kind} in this organization.`);
      requireCondition((!dimension.starts_on || date >= day(dimension.starts_on)) && (!dimension.ends_on || date <= day(dimension.ends_on)), 400, 'This entry is outside the dimension dates.');
      requireCondition(!dimension.allowed_account_ids.length || dimension.allowed_account_ids.includes(line.accountId), 400, 'This account is not allowed by the selected fund, program or grant.');
      requireCondition(!dimension.allowed_unit_ids.length || (line.unitId && dimension.allowed_unit_ids.includes(line.unitId)), 400, 'This community is not allowed by the selected fund, program or grant.');
    }
    debit += d; credit += c; output.push({line, account, debit: d, credit: c});
  }
  requireCondition(!requireBalance || (debit > 0n && debit === credit), 400, 'Journal debits and credits must balance exactly.');
  return output;
}
async function insertLines(tx: Queryable, actor: Actor, id: string, lines: Awaited<ReturnType<typeof validateLines>>) {
  for (let index = 0; index < lines.length; index++) {
    const {line, account, debit, credit} = lines[index];
    await tx.query(`INSERT INTO accounting_journal_lines(id,org_id,journal_id,line_number,account_id,debit,credit,unit_id,fund_id,program_id,grant_id,memo,account_snapshot,cash_flow_category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [randomUUID(), actor.org_id, id, index + 1, line.accountId, debit.toString(), credit.toString(), line.unitId ?? null, line.fundId ?? null, line.programId ?? null, line.grantId ?? null, line.memo ?? '', JSON.stringify(publicAccountingAccount(account)), line.cashFlowCategory ?? account.cash_flow_category]);
  }
}
/** Trusted service-level posting. Caller owns accountingTransaction and may supply a fixed server-derived source. */
export async function postJournalTx(tx: Queryable, actor: Actor, raw: JournalPostRequest): Promise<AccountingJournal> {
  const {commandId, sourceType = 'manual', sourceId, ...rest} = raw;
  const input = journalDraftInput.omit({expectedRevision: true}).parse(rest);
  z.uuid().parse(commandId); if (sourceId) z.uuid().parse(sourceId);
  requireCondition(/^[a-z][a-z0-9_]{0,63}$/.test(sourceType), 400, 'Invalid journal source.');
  const fingerprint = digest(JSON.stringify({operation: 'service_post', ...input, commandId, sourceType, sourceId}));
  const old = await receipt(tx, actor, commandId, fingerprint); if (old) return old;
  const config = await requireAccountingConfig(tx, actor);
  await assertOpenPeriod(tx, actor, input.date);
  requireCondition(!(await tx.query('SELECT id FROM accounting_journals WHERE id=$1', [input.id])).rows.length, 409, 'Journal identity already exists.');
  const lines = await validateLines(tx, actor, input.date, input.lines, config.precision);
  await tx.query('INSERT INTO accounting_journals(id,org_id,entry_date,description,reference,source_type,source_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [input.id, actor.org_id, input.date, input.description, input.reference ?? '', sourceType, sourceId ?? null, actor.id]);
  await insertLines(tx, actor, input.id, lines);
  await tx.query("UPDATE accounting_journals SET status='posted',revision=revision+1,posted_by=$3,posted_at=now() WHERE org_id=$1 AND id=$2", [actor.org_id, input.id, actor.id]);
  const result = await readAccountingJournal(tx, actor, input.id, config.precision);
  await audit(tx, actor, 'accounting.journal_posted', input.id, {sourceType, sourceId, date: input.date, lines: input.lines.length, commandId});
  await saveReceipt(tx, actor, commandId, fingerprint, result); return result;
}
export async function reverseJournalTx(tx: Queryable, actor: Actor, raw: z.infer<typeof journalReverseInput> & {id: string}): Promise<AccountingJournal> {
  const {id, ...body} = raw, input = journalReverseInput.parse(body); z.uuid().parse(id);
  const fingerprint = digest(JSON.stringify({operation: 'reverse', id, ...input}));
  const old = await receipt(tx, actor, input.commandId, fingerprint); if (old) return old;
  const config = await requireAccountingConfig(tx, actor), original = await readAccountingJournal(tx, actor, id, config.precision);
  requireCondition(original.status === 'posted' && original.revision === input.expectedRevision && !original.reversedBy && !original.reversalOf, 409, 'This journal cannot be reversed again or has changed.');
  await assertOpenPeriod(tx, actor, input.date);
  requireCondition(input.date >= original.date, 400, 'A reversal cannot precede its original journal.');
  const reversalId = randomUUID();
  // Reversal preserves original classifications and dimensions even if an account is now inactive.
  await tx.query(`INSERT INTO accounting_journals(id,org_id,entry_date,description,reference,source_type,source_id,reversal_of,created_by)
    VALUES($1,$2,$3,$4,$5,'reversal',$6,$6,$7)`, [reversalId, actor.org_id, input.date, input.reason, original.reference, id, actor.id]);
  await tx.query(`INSERT INTO accounting_journal_lines(id,org_id,journal_id,line_number,account_id,debit,credit,unit_id,fund_id,program_id,grant_id,memo,account_snapshot,cash_flow_category)
    SELECT gen_random_uuid(),org_id,$3,line_number,account_id,credit,debit,unit_id,fund_id,program_id,grant_id,memo,account_snapshot,cash_flow_category
    FROM accounting_journal_lines WHERE org_id=$1 AND journal_id=$2`, [actor.org_id, id, reversalId]);
  await tx.query("UPDATE accounting_journals SET status='posted',revision=revision+1,posted_by=$3,posted_at=now() WHERE org_id=$1 AND id=$2", [actor.org_id, reversalId, actor.id]);
  const result = await readAccountingJournal(tx, actor, reversalId, config.precision);
  await audit(tx, actor, 'accounting.journal_reversed', id, {reversalId, date: input.date, reason: input.reason, commandId: input.commandId});
  await saveReceipt(tx, actor, input.commandId, fingerprint, result); return result;
}
export async function saveAccountingConfig(tx: Queryable, actor: Actor, raw: unknown) {
  const input = accountingConfigInput.parse(raw), row = await lockAccounting(tx, actor);
  requireCondition(row.revision === input.expectedRevision, 409, 'Accounting settings changed. Reload first.');
  if (row.currency !== input.currency || row.precision !== input.precision || row.basis !== input.basis) {
    for (const table of ['accounting_journals','accounting_documents','accounting_bank_statements','accounting_budgets','accounting_payroll_runs']) {
      requireCondition(!(await tx.query(`SELECT id FROM ${table} WHERE org_id=$1 LIMIT 1`, [actor.org_id])).rows.length, 409,
        'Currency, precision and basis cannot change after financial records exist, including drafts. A reviewed migration is required to reinterpret existing books.');
    }
  }
  const changed = (await tx.query(`UPDATE accounting_config SET configured=true,reviewed=true,currency=$2,precision=$3,basis=$4,fiscal_start_month=$5,fiscal_start_day=$6,modules=$7,revision=revision+1,updated_at=now() WHERE org_id=$1 RETURNING *`, [actor.org_id, input.currency, input.precision, input.basis, input.fiscalStartMonth, input.fiscalStartDay, JSON.stringify(input.modules)])).rows[0];
  await audit(tx, actor, 'accounting.configuration_saved', null, {...input, revision: changed.revision}); return publicAccountingConfig(changed);
}
export async function saveAccountingAccount(tx: Queryable, actor: Actor, raw: unknown) {
  const input = accountingAccountInput.parse(raw); await requireAccountingConfig(tx, actor);
  const prior = (await tx.query('SELECT * FROM accounting_accounts WHERE id=$1 AND org_id=$2', [input.id, actor.org_id])).rows[0];
  requireCondition(prior ? prior.revision === input.expectedRevision : input.expectedRevision === 0, 409, 'The account changed. Reload first.');
  requireCondition(!(await tx.query('SELECT id FROM accounting_accounts WHERE org_id=$1 AND code=$2 AND id<>$3', [actor.org_id, input.code, input.id])).rows.length, 409, 'Account code already exists.');
  if (prior) {
    const used = (await tx.query('SELECT l.id FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE l.org_id=$1 AND l.account_id=$2 AND j.status=\'posted\' LIMIT 1', [actor.org_id, input.id])).rows.length;
    requireCondition(!used || (prior.type === input.type && prior.is_cash === input.isCash && prior.functional_category === input.functionalCategory && prior.cash_flow_category === input.cashFlowCategory), 409, 'Posted account classifications are fixed. Create a new account for a different classification.');
  }
  const params = [input.id, actor.org_id, input.code, input.name, input.type, input.isCash, input.cashFlowCategory, input.functionalCategory, input.active];
  const row = (await tx.query(prior ? 'UPDATE accounting_accounts SET code=$3,name=$4,type=$5,is_cash=$6,cash_flow_category=$7,functional_category=$8,active=$9,revision=revision+1 WHERE id=$1 AND org_id=$2 RETURNING *' : 'INSERT INTO accounting_accounts(id,org_id,code,name,type,is_cash,cash_flow_category,functional_category,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', params)).rows[0];
  await audit(tx, actor, 'accounting.account_saved', input.id, {code: input.code, revision: row.revision}); return publicAccountingAccount(row);
}
export async function saveAccountingFund(tx: Queryable, actor: Actor, raw: unknown) {
  const input = accountingFundInput.parse(raw); await requireAccountingConfig(tx, actor);
  const prior = (await tx.query('SELECT * FROM accounting_funds WHERE id=$1 AND org_id=$2', [input.id, actor.org_id])).rows[0];
  requireCondition(prior ? prior.revision === input.expectedRevision : input.expectedRevision === 0, 409, 'The dimension changed. Reload first.');
  requireCondition(!prior || prior.kind === input.kind, 409, 'Dimension kind cannot change.');
  requireCondition(!(await tx.query('SELECT id FROM accounting_funds WHERE org_id=$1 AND code=$2 AND id<>$3', [actor.org_id, input.code, input.id])).rows.length, 409, 'Dimension code already exists.');
  for (const id of new Set(input.allowedAccountIds)) requireCondition((await tx.query('SELECT id FROM accounting_accounts WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows.length, 400, 'A permitted account belongs to another organization.');
  for (const id of new Set(input.allowedUnitIds)) requireCondition((await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows.length, 400, 'A permitted community belongs to another organization.');
  const params = [input.id, actor.org_id, input.code, input.name, input.kind, input.restriction, input.purpose, input.active, JSON.stringify(input.allowedAccountIds), JSON.stringify(input.allowedUnitIds), input.startsOn, input.endsOn];
  const row = (await tx.query(prior ? 'UPDATE accounting_funds SET code=$3,name=$4,kind=$5,restriction=$6,purpose=$7,active=$8,allowed_account_ids=$9,allowed_unit_ids=$10,starts_on=$11,ends_on=$12,revision=revision+1 WHERE id=$1 AND org_id=$2 RETURNING *' : 'INSERT INTO accounting_funds(id,org_id,code,name,kind,restriction,purpose,active,allowed_account_ids,allowed_unit_ids,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', params)).rows[0];
  await audit(tx, actor, 'accounting.dimension_saved', input.id, {...input, revision: row.revision}); return publicFund(row);
}
export async function createAccountingPeriod(tx: Queryable, actor: Actor, raw: unknown) {
  const input = accountingPeriodInput.parse(raw); await requireAccountingConfig(tx, actor);
  requireCondition(!(await tx.query('SELECT id FROM accounting_periods WHERE org_id=$1 AND starts_on<=$3 AND ends_on>=$2', [actor.org_id, input.startsOn, input.endsOn])).rows.length, 409, 'Accounting periods cannot overlap.');
  const row = (await tx.query('INSERT INTO accounting_periods(id,org_id,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5) RETURNING *', [input.id, actor.org_id, input.name, input.startsOn, input.endsOn])).rows[0];
  await audit(tx, actor, 'accounting.period_created', input.id, input); return publicPeriod(row);
}
export async function editAccountingPeriod(tx:Queryable,actor:Actor,id:string,raw:unknown){
  const input=z.object({expectedRevision:z.number().int().positive(),name:z.string().trim().min(1).max(120),startsOn:accountingPeriodInput.shape.startsOn,endsOn:accountingPeriodInput.shape.endsOn}).strict().parse(raw);
  requireCondition(input.startsOn<=input.endsOn,400,'End date must follow start date.');await requireAccountingConfig(tx,actor);
  const prior=(await tx.query('SELECT * FROM accounting_periods WHERE org_id=$1 AND id=$2',[actor.org_id,id])).rows[0];
  requireCondition(prior,404,'Period not found.');requireCondition(prior.status==='open'&&prior.revision===input.expectedRevision,409,'Period is closed or has changed.');
  if(day(prior.starts_on)!==input.startsOn||day(prior.ends_on)!==input.endsOn){
    requireCondition(!(await tx.query('SELECT id FROM accounting_journals WHERE org_id=$1 AND entry_date BETWEEN $2 AND $3 LIMIT 1',[actor.org_id,prior.starts_on,prior.ends_on])).rows.length,409,'Period dates are fixed once journals use them. Create a future period for new dates.');
    requireCondition(!(await tx.query('SELECT id FROM accounting_budgets WHERE org_id=$1 AND period_id=$2 LIMIT 1',[actor.org_id,id])).rows.length,409,'Period dates are fixed once budgets use them.');
    requireCondition(!(await tx.query('SELECT id FROM accounting_periods WHERE org_id=$1 AND id<>$4 AND starts_on<=$3 AND ends_on>=$2',[actor.org_id,input.startsOn,input.endsOn,id])).rows.length,409,'Accounting periods cannot overlap.');
  }
  const row=(await tx.query('UPDATE accounting_periods SET name=$3,starts_on=$4,ends_on=$5,revision=revision+1 WHERE org_id=$1 AND id=$2 RETURNING *',[actor.org_id,id,input.name,input.startsOn,input.endsOn])).rows[0];
  await audit(tx,actor,'accounting.period_edited',id,{before:publicPeriod(prior),after:publicPeriod(row)});return publicPeriod(row);
}
export async function setAccountingPeriodStatus(tx: Queryable, actor: Actor, id: string, raw: unknown) {
  const input = accountingPeriodStatusInput.parse(raw), fingerprint = digest(JSON.stringify({operation: 'period_status', id, ...input}));
  const old = await receipt(tx, actor, input.commandId, fingerprint); if (old) return old;
  await requireAccountingConfig(tx, actor);
  const row = (await tx.query('SELECT * FROM accounting_periods WHERE org_id=$1 AND id=$2', [actor.org_id, id])).rows[0];
  requireCondition(row, 404, 'Period not found.'); requireCondition(row.revision === input.expectedRevision && row.status !== input.status, 409, 'Period changed. Reload first.');
  if (input.status === 'closed') requireCondition(!(await tx.query("SELECT id FROM accounting_journals WHERE org_id=$1 AND status='draft' AND entry_date BETWEEN $2 AND $3 LIMIT 1", [actor.org_id, row.starts_on, row.ends_on])).rows.length, 409, 'Resolve draft journals before closing this period.');
  const changed = (await tx.query("UPDATE accounting_periods SET status=$3,revision=revision+1,reason=$4,closed_by=CASE WHEN $3='closed' THEN $5::uuid ELSE NULL END,closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END WHERE org_id=$1 AND id=$2 RETURNING *", [actor.org_id, id, input.status, input.reason, actor.id])).rows[0];
  const result = publicPeriod(changed); await audit(tx, actor, 'accounting.period_status_changed', id, {...input, revision: result.revision}); await saveReceipt(tx, actor, input.commandId, fingerprint, result); return result;
}
export async function saveJournalDraft(tx: Queryable, actor: Actor, raw: unknown) {
  const input = journalDraftInput.parse(raw), config = await requireAccountingConfig(tx, actor);
  const prior = (await tx.query('SELECT * FROM accounting_journals WHERE org_id=$1 AND id=$2', [actor.org_id, input.id])).rows[0];
  requireCondition(prior ? prior.status === 'draft' && prior.source_type === 'manual' && prior.revision === input.expectedRevision : input.expectedRevision === 0, 409, 'This journal is posted or has changed. Reload first.');
  await assertOpenPeriod(tx, actor, input.date);
  if (prior) await assertOpenPeriod(tx, actor, day(prior.entry_date));
  const lines = await validateLines(tx, actor, input.date, input.lines, config.precision, false);
  if (prior) {
    await tx.query('DELETE FROM accounting_journal_lines WHERE org_id=$1 AND journal_id=$2', [actor.org_id, input.id]);
    await tx.query('UPDATE accounting_journals SET entry_date=$3,description=$4,reference=$5,revision=revision+1 WHERE org_id=$1 AND id=$2', [actor.org_id, input.id, input.date, input.description, input.reference ?? '']);
  } else await tx.query('INSERT INTO accounting_journals(id,org_id,entry_date,description,reference,created_by) VALUES($1,$2,$3,$4,$5,$6)', [input.id, actor.org_id, input.date, input.description, input.reference ?? '', actor.id]);
  await insertLines(tx, actor, input.id, lines);
  const result = await readAccountingJournal(tx, actor, input.id, config.precision);
  await audit(tx, actor, 'accounting.journal_draft_saved', input.id, {date: input.date, revision: result.revision, lines: input.lines.length}); return result;
}
export async function postJournalDraft(tx: Queryable, actor: Actor, id: string, raw: unknown) {
  const input = journalPostInput.parse(raw), fingerprint = digest(JSON.stringify({operation: 'post_draft', id, ...input}));
  const old = await receipt(tx, actor, input.commandId, fingerprint); if (old) return old;
  const config = await requireAccountingConfig(tx, actor), journal = await readAccountingJournal(tx, actor, id, config.precision);
  requireCondition(journal.status === 'draft' && journal.sourceType === 'manual' && journal.revision === input.expectedRevision, 409, 'Journal changed or was already posted. Reload first.');
  await assertOpenPeriod(tx, actor, journal.date);
  const rawLines = journal.lines.map(({id: _id, accountCode: _code, accountName: _name, ...line}) => line);
  const lines = await validateLines(tx, actor, journal.date, rawLines, config.precision);
  // Refresh account snapshots at posting, after rechecking current classifications and restrictions.
  await tx.query('DELETE FROM accounting_journal_lines WHERE org_id=$1 AND journal_id=$2', [actor.org_id, id]); await insertLines(tx, actor, id, lines);
  await tx.query("UPDATE accounting_journals SET status='posted',revision=revision+1,posted_by=$3,posted_at=now() WHERE org_id=$1 AND id=$2", [actor.org_id, id, actor.id]);
  const result = await readAccountingJournal(tx, actor, id, config.precision);
  await audit(tx, actor, 'accounting.journal_posted', id, {date: journal.date, revision: result.revision, commandId: input.commandId}); await saveReceipt(tx, actor, input.commandId, fingerprint, result); return result;
}
export async function discardJournalDraft(tx:Queryable,actor:Actor,id:string,raw:unknown){
  const input=z.object({expectedRevision:z.number().int().positive(),commandId:z.uuid(),reason:z.string().trim().min(3).max(1000)}).strict().parse(raw),fingerprint=digest(JSON.stringify({operation:'discard_draft',id,...input}));
  const old=await receipt(tx,actor,input.commandId,fingerprint);if(old)return old;
  const journal=await readAccountingJournal(tx,actor,id);requireCondition(journal.status==='draft'&&journal.sourceType==='manual'&&journal.revision===input.expectedRevision,409,'Only the current manual draft can be discarded.');
  await assertOpenPeriod(tx,actor,journal.date);
  await tx.query('DELETE FROM accounting_journal_lines WHERE org_id=$1 AND journal_id=$2',[actor.org_id,id]);await tx.query('DELETE FROM accounting_journals WHERE org_id=$1 AND id=$2',[actor.org_id,id]);
  const result={id,discarded:true};await audit(tx,actor,'accounting.journal_draft_discarded',id,{journal,reason:input.reason,commandId:input.commandId});await saveReceipt(tx,actor,input.commandId,fingerprint,result);return result;
}
export async function accountingWorkspace(tx: Queryable, actor: Actor): Promise<AccountingWorkspace> {
  const config = await lockAccounting(tx, actor);
  const accounts = (await tx.query('SELECT * FROM accounting_accounts WHERE org_id=$1 ORDER BY code LIMIT 2001', [actor.org_id])).rows;
  const funds = (await tx.query('SELECT * FROM accounting_funds WHERE org_id=$1 ORDER BY kind,code LIMIT 2001', [actor.org_id])).rows;
  const periods = (await tx.query('SELECT * FROM accounting_periods WHERE org_id=$1 ORDER BY starts_on DESC LIMIT 1001', [actor.org_id])).rows;
  requireCondition(accounts.length <= 2000 && funds.length <= 2000 && periods.length <= 1000, 400, 'This accounting workspace exceeds its supported catalog size.');
  const journalRows = (await tx.query('SELECT id FROM accounting_journals WHERE org_id=$1 ORDER BY entry_date DESC,created_at DESC,id LIMIT 101', [actor.org_id])).rows;
  const journals: AccountingJournal[] = []; for (const row of journalRows.slice(0, 100)) journals.push(await readAccountingJournal(tx, actor, row.id, config.precision));
  return {config: publicAccountingConfig(config), accounts: accounts.map(publicAccountingAccount), funds: funds.map(publicFund), periods: periods.map(publicPeriod), journals,
    units: (await tx.query('SELECT id,name FROM units WHERE org_id=$1 ORDER BY name', [actor.org_id])).rows as {id:string;name:string}[], journalsTruncated: journalRows.length > 100};
}
/** User-requested starter defaults. No financial transaction or opening balance is invented. */
export async function createStarterAccountingChart(tx: Queryable, actor: Actor, raw: unknown) {
  const input=z.object({commandId:z.uuid(),year:z.number().int().min(1900).max(9999)}).strict().parse(raw),fingerprint=digest(JSON.stringify({operation:'starter_chart',...input}));
  const old=await receipt(tx,actor,input.commandId,fingerprint);if(old)return old;
  await requireAccountingConfig(tx,actor);
  requireCondition(!(await tx.query('SELECT id FROM accounting_accounts WHERE org_id=$1 LIMIT 1',[actor.org_id])).rows.length,409,'A chart already exists. Add or adjust individual accounts in Settings.');
  const starters=[
    ['1000','Operating bank','asset',true,'unclassified'],['1100','Accounts receivable','asset',false,'unclassified'],
    ['2000','Accounts payable','liability',false,'unclassified'],['2100','Payroll payable','liability',false,'unclassified'],['2200','Payroll deductions payable','liability',false,'unclassified'],
    ['3000','Opening net assets','equity',false,'unclassified'],['4000','Tuition and fees','revenue',false,'unclassified'],['4100','Contributions','revenue',false,'unclassified'],
    ['5000','Program expenses','expense',false,'program'],['5100','Payroll expense','expense',false,'unclassified'],['5200','Management and general','expense',false,'management'],['5300','Fundraising expense','expense',false,'fundraising'],
  ] as const;
  for(const [code,name,type,isCash,functionalCategory]of starters)await saveAccountingAccount(tx,actor,{id:randomUUID(),expectedRevision:0,code,name,type,isCash,cashFlowCategory:'unclassified',functionalCategory,active:true});
  if(!(await tx.query('SELECT id FROM accounting_periods WHERE org_id=$1 LIMIT 1',[actor.org_id])).rows.length)await createAccountingPeriod(tx,actor,{id:randomUUID(),name:`${input.year} calendar year (starter)`,startsOn:`${input.year}-01-01`,endsOn:`${input.year}-12-31`});
  const result={created:true,accountCount:starters.length};await audit(tx,actor,'accounting.starter_chart_created',null,{...input,accountCount:starters.length});await saveReceipt(tx,actor,input.commandId,fingerprint,result);return result;
}
export function registerAccountingLedgerRoutes(app: Express, db: Database) {
  const run = <T>(req: Request, fn:(tx:Queryable,actor:Actor)=>Promise<T>) => accountingTransaction(db, (req as AppRequest).actor, (req as AppRequest).sessionHash, fn);
  app.get('/api/accounting/workspace', async(req,res) => res.json(await run(req, accountingWorkspace)));
  app.post('/api/accounting/config', async(req,res) => res.json(await run(req,(tx,actor)=>saveAccountingConfig(tx,actor,req.body))));
  app.post('/api/accounting/starter-chart',async(req,res)=>res.status(201).json(await run(req,(tx,actor)=>createStarterAccountingChart(tx,actor,req.body))));
  app.post('/api/accounting/accounts', async(req,res) => res.json(await run(req,(tx,actor)=>saveAccountingAccount(tx,actor,req.body))));
  app.post('/api/accounting/funds', async(req,res) => res.json(await run(req,(tx,actor)=>saveAccountingFund(tx,actor,req.body))));
  app.post('/api/accounting/periods', async(req,res) => res.status(201).json(await run(req,(tx,actor)=>createAccountingPeriod(tx,actor,req.body))));
  app.post('/api/accounting/periods/:id',async(req,res)=>res.json(await run(req,(tx,actor)=>editAccountingPeriod(tx,actor,z.uuid().parse(req.params.id),req.body))));
  app.post('/api/accounting/periods/:id/status', async(req,res) => res.json(await run(req,(tx,actor)=>setAccountingPeriodStatus(tx,actor,z.uuid().parse(req.params.id),req.body))));
  app.get('/api/accounting/journals/:id', async(req,res) => res.json(await run(req,(tx,actor)=>readAccountingJournal(tx,actor,z.uuid().parse(req.params.id)))));
  app.post('/api/accounting/journals', async(req,res) => res.json(await run(req,(tx,actor)=>saveJournalDraft(tx,actor,req.body))));
  app.delete('/api/accounting/journals/:id',async(req,res)=>res.json(await run(req,(tx,actor)=>discardJournalDraft(tx,actor,z.uuid().parse(req.params.id),req.body))));
  app.post('/api/accounting/journals/:id/post', async(req,res) => res.json(await run(req,(tx,actor)=>postJournalDraft(tx,actor,z.uuid().parse(req.params.id),req.body))));
  app.post('/api/accounting/journals/:id/reverse', async(req,res) => res.json(await run(req,async(tx,actor)=>{
    const id=z.uuid().parse(req.params.id), original=await readAccountingJournal(tx,actor,id);
    requireCondition(original.sourceType==='manual',409,'Reverse this entry through its originating accounting workflow.');
    return reverseJournalTx(tx,actor,{...journalReverseInput.parse(req.body),id});
  })));
  installAccountingReports(app, db);
}
