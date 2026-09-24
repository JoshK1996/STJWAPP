import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { connectDatabase, migrate, type Database, type Queryable } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { issueSetup, digest, type Actor } from '../server/security';
import { accountingTransaction, saveAccountingConfig, saveAccountingAccount, saveAccountingFund, createAccountingPeriod, postJournalTx } from '../server/accounting-ledger';
import { createAccountingBudget, actOnAccountingBudget, accountingBudgetReport, createAccountingPayroll, actOnAccountingPayroll } from '../server/accounting-planning';
import { assertRuntimeAccess, runtimeGrantsSql } from '../server/runtime-access';

let db: Database, actor: Actor, proof: string, maintenanceLogin: string;
let periodId: string, expenseId: string, payableId: string, deductionId: string, cashId: string;
let accountSequence = 0;
const origin = 'http://localhost:3191', reason = 'Synthetic accounting invariant review';
const run = <T>(work: (tx: Queryable, current: Actor) => Promise<T>) => accountingTransaction(db, actor, proof, work);
const action = (version: number) => ({ commandId: randomUUID(), expectedVersion: version, reason, reviewed: true as const });
async function makeAccount(type: 'asset' | 'liability' | 'expense', isCash = false) {
  const id = randomUUID(), code = 'INV-' + (++accountSequence);
  await run((tx, current) => saveAccountingAccount(tx, current, { id, expectedRevision: 0, code, name: 'Synthetic ' + code, type, isCash, cashFlowCategory: 'unclassified', functionalCategory: 'unclassified', active: true }));
  return { id, code };
}
async function runtime<T>(work: () => Promise<T>): Promise<T> {
  await db.query('SET SESSION AUTHORIZATION stjw_runtime');
  try { return await work(); }
  finally { await db.query('SET SESSION AUTHORIZATION "' + maintenanceLogin.replaceAll('"', '""') + '"'); }
}
before(async () => {
  db = await connectDatabase(); await migrate(db);
  await initialize(db, { demo: false, ownerEmail: 'planning-invariants@example.test' });
  maintenanceLogin = (await db.query('SELECT session_user AS login')).rows[0].login;
  const user = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  actor = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: user.role, mode: 'password', unit_ids: [] };
  const app = createApp(db, { origin, production: false, staffDomain: 'stjw.org', demo: false });
  const token = await db.transaction(tx => issueSetup(tx, actor)), password = 'Synthetic-' + randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin', origin).send({ token, password })).status, 200);
  const login = await request(app).post('/api/auth/login').set('Origin', origin).send({ email: actor.email, credential: password, mode: 'password' });
  assert.equal(login.status, 200);
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  proof = digest(cookie.slice(cookie.indexOf('=') + 1));
  assert.equal((await request(app).get('/api/me').set('Cookie', cookie)).status, 200);
  await run((tx, current) => saveAccountingConfig(tx, current, { expectedRevision: 0, currency: 'USD', precision: 2, basis: 'accrual', fiscalStartMonth: 1, fiscalStartDay: 1, modules: ['ledger', 'budgets', 'payroll'] }));
  expenseId = (await makeAccount('expense')).id; payableId = (await makeAccount('liability')).id;
  deductionId = (await makeAccount('liability')).id; cashId = (await makeAccount('asset', true)).id;
  periodId = randomUUID();
  await run((tx, current) => createAccountingPeriod(tx, current, { id: periodId, name: 'Synthetic 2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }));
  for (const statement of runtimeGrantsSql().match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await db.query(statement);
});
after(async () => { await db?.close(); });
function payroll(month: string, expenseAccountId = expenseId) {
  return { commandId: randomUUID(), name: 'Synthetic payroll ' + month, start: `2026-${month}-01`, end: `2026-${month}-15`, payDate: `2026-${month}-15`, reason, payableAccountId: payableId,
    employees: [{ userId: actor.id, earnings: [{ label: 'Reviewed earning', quantity: '1', rate: '1.00', expenseAccountId, fundId: null as string | null }], deductions: [] as { label: string; amount: string; liabilityAccountId: string }[], employerCosts: [] as { label: string; amount: string; expenseAccountId: string; liabilityAccountId: string }[] }] };
}
function budget(accountId: string, fundId: string | null = null) {
  return { commandId: randomUUID(), name: 'Synthetic budget', periodId, reason, lines: [{ accountId, fundId, amount: '10.00' }] };
}
async function reclassify(account: { id: string; code: string }) {
  await run((tx, current) => saveAccountingAccount(tx, current, { id: account.id, expectedRevision: 1, code: account.code, name: 'Synthetic reclassified account', type: 'asset', isCash: false, cashFlowCategory: 'unclassified', functionalCategory: 'unclassified', active: true }));
}

test('approved payroll rejects account reclassification before posting and retains approval evidence', async () => {
  const expense = await makeAccount('expense'), draft = await createAccountingPayroll(db, actor, proof, payroll('01', expense.id));
  const approved = await actOnAccountingPayroll(db, actor, proof, draft.id, 'approve', action(draft.version));
  await reclassify(expense);
  await assert.rejects(actOnAccountingPayroll(db, actor, proof, draft.id, 'post', action(approved.version)), /expense account/);
  const saved = (await db.query('SELECT status,version,journal_id FROM accounting_payroll_runs WHERE id=$1', [draft.id])).rows[0];
  assert.equal(saved.status, 'approved'); assert.equal(saved.version, approved.version); assert.equal(saved.journal_id, null);
  assert.equal((await db.query('SELECT id FROM accounting_journals WHERE org_id=$1 AND source_id=$2', [actor.org_id, draft.id])).rows.length, 0);
});

test('budgets reject changed account classifications during approval and subsequent actual comparisons', async () => {
  const pendingAccount = await makeAccount('expense'), pending = await createAccountingBudget(db, actor, proof, budget(pendingAccount.id));
  await reclassify(pendingAccount);
  await assert.rejects(actOnAccountingBudget(db, actor, proof, pending.id, 'approve', action(pending.version)), /reclassified/);
  await assert.rejects(accountingBudgetReport(db, actor, proof, pending.id), /reclassified/);
  const approvedAccount = await makeAccount('expense'), draft = await createAccountingBudget(db, actor, proof, budget(approvedAccount.id));
  await actOnAccountingBudget(db, actor, proof, draft.id, 'approve', action(draft.version)); await reclassify(approvedAccount);
  await assert.rejects(accountingBudgetReport(db, actor, proof, draft.id), /reclassified/);
  await assert.rejects(accountingBudgetReport(db, actor, proof, draft.id, true), /reclassified/);
});

test('program and grant identities cannot be submitted as budget or payroll funds', async () => {
  for (const kind of ['program', 'grant'] as const) {
    const id = randomUUID();
    await run((tx, current) => saveAccountingFund(tx, current, { id, expectedRevision: 0, code: 'SYN-' + kind, name: 'Synthetic ' + kind, kind, restriction: 'unrestricted', purpose: '', active: true, allowedAccountIds: [], allowedUnitIds: [], startsOn: null, endsOn: null }));
    await assert.rejects(createAccountingBudget(db, actor, proof, budget(expenseId, id)), /active fund/);
    const input = payroll('02'); input.employees[0].earnings[0].fundId = id;
    await assert.rejects(createAccountingPayroll(db, actor, proof, input), /active fund/);
  }
});

test('runtime SQL cannot replace approval identity or timestamp through otherwise-valid transitions', async () => {
  const reviewerId = randomUUID(); await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic second reviewer','finance')", [reviewerId, actor.org_id, reviewerId + '@example.test']);
  const draftBudget = await createAccountingBudget(db, actor, proof, budget(expenseId));
  const approvedBudget = await actOnAccountingBudget(db, actor, proof, draftBudget.id, 'approve', action(draftBudget.version));
  const draftPayroll = await createAccountingPayroll(db, actor, proof, payroll('03'));
  const approvedPayroll = await actOnAccountingPayroll(db, actor, proof, draftPayroll.id, 'approve', action(draftPayroll.version));
  for (const [table, record] of [['accounting_budgets', approvedBudget], ['accounting_payroll_runs', approvedPayroll]] as const) {
    await runtime(async () => {
      await assert.rejects(db.query(`UPDATE ${table} SET status='voided',version=version+1,approved_by=$2 WHERE id=$1`, [record.id, reviewerId]), /approval evidence is immutable/);
      await assert.rejects(db.query(`UPDATE ${table} SET status='voided',version=version+1,approved_at=NULL WHERE id=$1`, [record.id]), /approval evidence is immutable/);
      await assert.rejects(db.query(`UPDATE ${table} SET status='voided',version=version+1,approved_at=approved_at+interval '1 second' WHERE id=$1`, [record.id]), /approval evidence is immutable/);
    });
    const saved = (await db.query(`SELECT status,version,approved_by,approved_at FROM ${table} WHERE id=$1`, [record.id])).rows[0];
    assert.equal(saved.status, 'approved'); assert.equal(saved.version, record.version); assert.equal(saved.approved_by, actor.id); assert.equal(new Date(saved.approved_at).toISOString(), record.approvedAt);
  }
});

test('runtime SQL cannot replace posted or paid payroll journal links during later transitions', async () => {
  const draft = await createAccountingPayroll(db, actor, proof, payroll('04'));
  const approved = await actOnAccountingPayroll(db, actor, proof, draft.id, 'approve', action(draft.version));
  const posted = await actOnAccountingPayroll(db, actor, proof, draft.id, 'post', action(approved.version));
  const other = await run((tx, current) => postJournalTx(tx, current, { id: randomUUID(), commandId: randomUUID(), date: '2026-04-16', description: 'Unrelated synthetic journal', lines: [{ accountId: expenseId, debit: '1.00', credit: '0.00' }, { accountId: cashId, debit: '0.00', credit: '1.00' }] }));
  await runtime(async () => {
    await assert.rejects(db.query("UPDATE accounting_payroll_runs SET status='paid',version=version+1,journal_id=$2,payment_journal_id=$2 WHERE id=$1", [draft.id, other.id]), /journal evidence is immutable/);
    await assert.rejects(db.query("UPDATE accounting_payroll_runs SET status='paid',version=version+1,journal_id=NULL,payment_journal_id=$2 WHERE id=$1", [draft.id, other.id]), /journal evidence is immutable/);
  });
  const paid = await actOnAccountingPayroll(db, actor, proof, draft.id, 'pay', { ...action(posted.version), date: '2026-04-16', cashAccountId: cashId });
  await runtime(async () => {
    await assert.rejects(db.query("UPDATE accounting_payroll_runs SET status='voided',version=version+1,payment_journal_id=$2 WHERE id=$1", [draft.id, other.id]), /journal evidence is immutable/);
  });
  const saved = (await db.query('SELECT status,version,journal_id,payment_journal_id FROM accounting_payroll_runs WHERE id=$1', [draft.id])).rows[0];
  assert.equal(saved.status, 'paid'); assert.equal(saved.version, paid.version); assert.equal(saved.journal_id, posted.journalId); assert.equal(saved.payment_journal_id, paid.paymentJournalId);
});

test('mixed-fund payroll balances every fund through cent rounding, separate deductions and actual payment', async () => {
  const funds = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
  for (const [index, id] of funds.entries()) await run((tx, current) => saveAccountingFund(tx, current, { id, expectedRevision: 0, code: 'FUND-' + index, name: 'Synthetic fund ' + index, kind: 'fund', restriction: 'unrestricted', purpose: '', active: true, allowedAccountIds: [], allowedUnitIds: [], startsOn: null, endsOn: null }));
  const input = payroll('05');
  input.employees[0].earnings = [
    { label: 'One-and-half-cent earning rounds to two cents', quantity: '1.5', rate: '0.01', expenseAccountId: expenseId, fundId: funds[0] },
    { label: 'Half-cent earning rounds to one cent', quantity: '0.5', rate: '0.01', expenseAccountId: expenseId, fundId: funds[1] },
    { label: 'Unassigned earning', quantity: '1', rate: '0.01', expenseAccountId: expenseId, fundId: null },
  ];
  input.employees[0].deductions = [{ label: 'First entered deduction', amount: '0.01', liabilityAccountId: deductionId }, { label: 'Second entered deduction', amount: '0.01', liabilityAccountId: deductionId }];
  input.employees[0].employerCosts = [{ label: 'Employer cost', amount: '0.01', expenseAccountId: expenseId, liabilityAccountId: deductionId }];
  const draft = await createAccountingPayroll(db, actor, proof, input);
  assert.equal(draft.payload.totals.gross, '0.04'); assert.equal(draft.payload.totals.deductions, '0.02'); assert.equal(draft.payload.totals.net, '0.02');
  const approved = await actOnAccountingPayroll(db, actor, proof, draft.id, 'approve', action(draft.version));
  const posted = await actOnAccountingPayroll(db, actor, proof, draft.id, 'post', action(approved.version));
  const groups = (await db.query('SELECT fund_id,sum(debit)::text AS debit,sum(credit)::text AS credit FROM accounting_journal_lines WHERE journal_id=$1 GROUP BY fund_id ORDER BY fund_id NULLS FIRST', [posted.journalId])).rows;
  assert.deepEqual(groups.map(row => [row.fund_id, row.debit, row.credit]), [[null, '2', '2'], [funds[0], '2', '2'], [funds[1], '1', '1']]);
  const payable = (await db.query('SELECT fund_id,credit::text AS credit FROM accounting_journal_lines WHERE journal_id=$1 AND account_id=$2 ORDER BY fund_id', [posted.journalId, payableId])).rows;
  assert.deepEqual(payable.map(row => [row.fund_id, row.credit]), [[funds[0], '1'], [funds[1], '1']]);
  const paid = await actOnAccountingPayroll(db, actor, proof, draft.id, 'pay', { ...action(posted.version), date: '2026-05-16', cashAccountId: cashId });
  const payment = (await db.query('SELECT fund_id,sum(debit)::text AS debit,sum(credit)::text AS credit FROM accounting_journal_lines WHERE journal_id=$1 GROUP BY fund_id ORDER BY fund_id', [paid.paymentJournalId])).rows;
  assert.deepEqual(payment.map(row => [row.fund_id, row.debit, row.credit]), [[funds[0], '1', '1'], [funds[1], '1', '1']]);
});

test('runtime startup rejects missing accounting mutation grants and altered evidence triggers', async () => {
  await runtime(async () => { await assertRuntimeAccess(db); });
  for (const [table, permission] of [['accounting_journals', 'UPDATE'], ['accounting_journal_lines', 'DELETE'], ['accounting_payroll_runs', 'UPDATE'], ['accounting_budgets', 'UPDATE'], ['accounting_bank_matches', 'DELETE']] as const) {
    await db.query(`REVOKE ${permission} ON ${table} FROM stjw_runtime`);
    try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
    finally { await db.query(`GRANT ${permission} ON ${table} TO stjw_runtime`); }
  }
  await db.query('ALTER TABLE accounting_payroll_runs DISABLE TRIGGER protected_accounting_payroll_runs');
  try { await runtime(async () => { await assert.rejects(assertRuntimeAccess(db), /restricted runtime-role/); }); }
  finally { await db.query('ALTER TABLE accounting_payroll_runs ENABLE TRIGGER protected_accounting_payroll_runs'); }
  await runtime(async () => { await assertRuntimeAccess(db); });
});
