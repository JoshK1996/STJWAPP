import { z } from 'zod';

export const accountingModules = ['ledger', 'budgets', 'payables', 'receivables', 'banking', 'payroll'] as const;
export const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export const cashFlowCategories = ['operating', 'investing', 'financing', 'unclassified'] as const;
export const functionalCategories = ['program', 'management', 'fundraising', 'unclassified'] as const;
export const accountingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '9999-12-31';
}, 'Use a valid calendar date.');
export const amountText = z.string().regex(/^\d{1,16}(?:\.\d{1,4})?$/, 'Use an unsigned decimal amount with at most four decimal places.');
/** Exact storage units. No floating-point conversion, rounding or currency inference. */
export function parseAmount(value: string, precision: number): bigint {
  if (!Number.isInteger(precision) || precision < 0 || precision > 4 || !/^\d{1,16}(?:\.\d{1,4})?$/.test(value)) throw new Error('Invalid accounting amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) throw new Error(`Amounts must have at most ${precision} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0');
}
export function formatAmount(units: bigint, precision: number): string {
  if (!Number.isInteger(precision) || precision < 0 || precision > 4) throw new Error('Invalid currency precision.');
  const sign = units < 0n ? '-' : '', digits = (units < 0n ? -units : units).toString().padStart(precision + 1, '0');
  return sign + (precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits);
}
export function displayAccountingAmount(value: string, currency?: string | null): string {
  const [whole, fraction] = value.split('.');
  return `${currency ? currency + ' ' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : '.' + fraction}`;
}
const revision = z.number().int().min(0), text = (max: number) => z.string().trim().max(max);
export const accountingConfigInput = z.object({
  expectedRevision: revision, currency: z.string().regex(/^[A-Z]{3}$/), precision: z.number().int().min(0).max(4),
  basis: z.enum(['cash', 'accrual']), fiscalStartMonth: z.number().int().min(1).max(12), fiscalStartDay: z.number().int().min(1).max(31),
  modules: z.array(z.enum(accountingModules)).min(1).max(accountingModules.length).refine(values => new Set(values).size === values.length && values.includes('ledger'), 'Select Ledger and distinct modules.'),
}).strict().refine(value => {
  const date = new Date(Date.UTC(2001, value.fiscalStartMonth - 1, value.fiscalStartDay));
  return date.getUTCMonth() === value.fiscalStartMonth - 1;
}, 'Use a valid annual fiscal start date (not February 29).');
export const accountingAccountInput = z.object({
  id: z.uuid(), expectedRevision: revision, code: text(30).min(1), name: text(120).min(1), type: z.enum(accountTypes),
  isCash: z.boolean(), cashFlowCategory: z.enum(cashFlowCategories), functionalCategory: z.enum(functionalCategories), active: z.boolean(),
}).strict().refine(value => !value.isCash || value.type === 'asset', 'Cash accounts must be assets.');
export const accountingFundInput = z.object({
  id: z.uuid(), expectedRevision: revision, code: text(30).min(1), name: text(120).min(1), kind: z.enum(['fund', 'program', 'grant']),
  restriction: z.enum(['unrestricted', 'restricted']), purpose: text(1000), active: z.boolean(),
  allowedAccountIds: z.array(z.uuid()).max(500), allowedUnitIds: z.array(z.uuid()).max(100),
  startsOn: accountingDate.nullable(), endsOn: accountingDate.nullable(),
}).strict().refine(value => value.restriction !== 'restricted' || value.purpose.length > 0, 'Describe the restriction purpose.')
  .refine(value => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn, 'End date must follow start date.');
export const accountingPeriodInput = z.object({id: z.uuid(), name: text(120).min(1), startsOn: accountingDate, endsOn: accountingDate}).strict()
  .refine(value => value.startsOn <= value.endsOn, 'End date must follow start date.');
export const accountingPeriodStatusInput = z.object({expectedRevision: revision, status: z.enum(['open', 'closed']), reason: text(1000).min(3), commandId: z.uuid()}).strict();
export const journalLineInput = z.object({
  accountId: z.uuid(), debit: amountText, credit: amountText, unitId: z.uuid().optional(), fundId: z.uuid().optional(),
  programId: z.uuid().optional(), grantId: z.uuid().optional(), memo: text(500).optional(), cashFlowCategory: z.enum(cashFlowCategories).optional(),
}).strict();
export const journalDraftInput = z.object({
  id: z.uuid(), expectedRevision: revision, date: accountingDate, description: text(500).min(1), reference: text(120).optional(), lines: z.array(journalLineInput).min(2).max(200),
}).strict();
export const journalPostInput = z.object({expectedRevision: revision, commandId: z.uuid()}).strict();
export const journalReverseInput = z.object({expectedRevision: revision, date: accountingDate, reason: text(1000).min(3), commandId: z.uuid()}).strict();
export const accountingReportViews = ['trial_balance','position','activities','functional_expenses','cash_movement','ledger'] as const;
export const accountingReportInput = z.object({from: accountingDate, to: accountingDate, unitId: z.uuid().optional(), fundId: z.uuid().optional(), programId: z.uuid().optional(), grantId: z.uuid().optional(), accountId: z.uuid().optional(), format: z.enum(['json','csv','xlsx']).default('json'), view:z.enum(accountingReportViews).default('trial_balance')}).strict()
  .refine(value => value.from <= value.to, 'End date must follow start date.');
export type JournalLineInput = z.infer<typeof journalLineInput>;
export type JournalPostRequest = Omit<z.infer<typeof journalDraftInput>, 'expectedRevision'> & {commandId: string; sourceType?: string; sourceId?: string};
export type AccountingConfig = {configured: boolean; reviewed: boolean; currency: string | null; precision: number | null; basis: 'cash' | 'accrual' | null; fiscalStartMonth: number | null; fiscalStartDay: number | null; modules: string[]; revision: number};
export type AccountingAccount = {id: string; code: string; name: string; type: typeof accountTypes[number]; isCash: boolean; cashFlowCategory: typeof cashFlowCategories[number]; functionalCategory: typeof functionalCategories[number]; active: boolean; revision: number};
export type AccountingFund = {id: string; code: string; name: string; kind: 'fund'|'program'|'grant'; restriction: 'unrestricted'|'restricted'; purpose: string; active: boolean; allowedAccountIds: string[]; allowedUnitIds: string[]; startsOn: string|null; endsOn: string|null; revision: number};
export type AccountingPeriod = {id: string; name: string; startsOn: string; endsOn: string; status: 'open'|'closed'; revision: number; reason: string};
export type AccountingJournal = {id: string; date: string; description: string; reference: string; sourceType: string; sourceId: string|null; status: 'draft'|'posted'; revision: number; reversalOf: string|null; reversedBy: string|null; createdAt: string; postedAt: string|null; lines: (JournalLineInput & {id: string; accountCode: string; accountName: string})[]};
export type AccountingWorkspace = {config: AccountingConfig; accounts: AccountingAccount[]; funds: AccountingFund[]; periods: AccountingPeriod[]; journals: AccountingJournal[]; units: {id:string; name:string}[]; journalsTruncated: boolean};
export type AccountingStatementRow = {key: string; label: string; type: string; amount: string};
export type AccountingTrialRow = {accountId: string; code: string; name: string; type: string; openingDebit: string; openingCredit: string; debit: string; credit: string; closingDebit: string; closingCredit: string};
export type AccountingReport = {from:string; to:string; currency:string; precision:number; basis:string; filters:{unitId?:string;fundId?:string;programId?:string;grantId?:string;accountId?:string};scopeLabels:string[]; trialBalance:AccountingTrialRow[]; totals:{debit:string;credit:string;closingDebit:string;closingCredit:string}; position:AccountingStatementRow[]; activities:AccountingStatementRow[]; functionalExpenses:AccountingStatementRow[]; cashMovement:AccountingStatementRow[]; ledger:{journalId:string;date:string;description:string;reference:string;accountId:string;accountName:string;debit:string;credit:string;memo:string}[]; ledgerTruncated:boolean; notices:string[]};
