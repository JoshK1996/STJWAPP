import { z } from 'zod';

export const operationsDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value && value>='1900-01-01' && value<='9999-12-31';
}, 'Use a valid calendar date.');
const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/, 'Enter a decimal amount without separators.');
const command = z.uuid();
export const accountingContactInput = z.object({ commandId: command, name: z.string().trim().min(1).max(160),
  kind: z.enum(['vendor','customer','family','donor']), email: z.email().max(254).optional(), note: z.string().trim().max(500).default('') }).strict();
export const accountingContactEditInput=accountingContactInput.extend({expectedRevision:z.number().int().positive(),active:z.boolean(),reason:z.string().trim().min(3).max(500)}).strict();
export const accountingDocumentInput = z.object({ commandId: command, kind: z.enum(['bill','invoice']), contactId: z.uuid(),
  number: z.string().trim().min(1).max(60), date: operationsDate, dueDate: operationsDate, description: z.string().trim().min(1).max(300),
  controlAccountId: z.uuid().optional(), lines: z.array(z.object({ description: z.string().trim().min(1).max(200), accountId: z.uuid(),
    amount, unitId: z.uuid().optional(), fundId: z.uuid().optional() }).strict()).min(1).max(100) }).strict()
  .refine(value => value.dueDate >= value.date, 'Due date must be on or after the document date.');
export const accountingDocumentEditInput=accountingDocumentInput.safeExtend({expectedRevision:z.number().int().positive(),reason:z.string().trim().min(3).max(500)});
export const accountingDraftDiscardInput=z.object({commandId:command,expectedRevision:z.number().int().positive(),reason:z.string().trim().min(3).max(500)}).strict();
export const accountingIssueInput = z.object({ commandId: command,expectedRevision:z.number().int().positive().optional() }).strict();
export const accountingVoidInput = z.object({ commandId: command, date: operationsDate, reason: z.string().trim().min(3).max(300) }).strict();
export const accountingPaymentInput = z.object({ commandId: command, date: operationsDate, amount, cashAccountId: z.uuid(),
  reference: z.string().trim().min(1).max(120) }).strict();
export const accountingCreditInput = z.object({ commandId: command, date: operationsDate, reason: z.string().trim().min(3).max(300),
  lines: z.array(z.object({ lineIndex: z.number().int().min(0).max(99), amount }).strict()).min(1).max(100) }).strict();
export const accountingRefundInput = z.object({ commandId: command, date: operationsDate, amount, reference: z.string().trim().min(1).max(120) }).strict();

export type AccountingContact = { id: string; name: string; kind: 'vendor'|'customer'|'family'|'donor'; email: string; note: string;revision:number;active:boolean };
export type AccountingDocumentLine = { description: string; accountId: string; amount: string; unitId?: string; fundId?: string };
export type AccountingDocumentEvent = { id: string; type: 'issue'|'credit'|'payment'|'refund'|'payment_void'|'void'; date: string;
  amount: string; reference: string; reason: string; paymentId?: string; journalId?: string; allocations: { lineIndex: number; amount: string }[] };
export type AccountingDocument = { id: string; kind: 'bill'|'invoice'; contactId: string; contactName: string; number: string; date: string;
  dueDate: string; description: string; controlAccountId?: string; currency: string; precision: number; basis: 'cash'|'accrual';
  status: 'draft'|'issued'|'void'; lines: AccountingDocumentLine[]; total: string; credited: string; paid: string; refunded: string;
  outstanding: string; events: AccountingDocumentEvent[];revision:number };
export type AccountingAging = { asOf: string; currency: string; precision: number; rows: (AccountingDocument & {
  daysOverdue: number; bucket: 'Current'|'1–30 days'|'31–60 days'|'61–90 days'|'Over 90 days'|'Credit balance' })[] };

export const bankPreviewInput = z.object({ cashAccountId: z.uuid(), from: operationsDate, to: operationsDate, openingBalance: amount,
  closingBalance: amount, csv: z.string().min(1).max(1_000_000), mapping: z.object({ date: z.string().min(1).max(80),
    reference: z.string().min(1).max(80), amount: z.string().min(1).max(80), description: z.string().min(1).max(80).optional() }).strict()
}).strict().refine(value => value.from <= value.to, 'Statement dates must be ordered.');
export const bankImportInput = z.object({ commandId: command, previewId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export const bankMatchInput = z.object({ commandId: command, statementLineId: z.uuid(), journalLineId: z.uuid().nullable().optional(), journalLineIds:z.array(z.uuid()).max(200).optional() }).strict()
  .refine(value=>(value.journalLineId!==undefined)!==(value.journalLineIds!==undefined),'Supply either one ledger line or a reviewed group of ledger lines.');
export const bankReconcileInput = z.object({ commandId: command, reviewed: z.literal(true), openingBalanceReviewed: z.boolean().default(false) }).strict();
export const bankCancelInput = z.object({commandId: command, reason: z.string().trim().min(3).max(300)}).strict();
export type BankStatementLine = { id: string; date: string; reference: string; description: string; amount: string; journalLineId: string | null; journalLineIds:string[] };
export type BankStatement = { id: string; cashAccountId: string; accountName: string; from: string; to: string; openingBalance: string;
  closingBalance: string; currency: string; precision: number; status: 'open'|'reconciled'|'cancelled'; sourceHash: string; lines: BankStatementLine[];
  cancellationReason?: string;
  reconciliation?: { ledgerBalance: string; outstandingAmount: string; adjustedLedgerBalance: string; outstanding: { id: string; date: string; description: string; amount: string }[]; reconciledAt: string } };
export type BankPreview = { id: string; fingerprint: string; sourceHash: string; cashAccountId: string; from: string; to: string;
  openingBalance: string; closingBalance: string; movement: string; currency: string; precision: number;
  lines: Omit<BankStatementLine,'id'|'journalLineId'|'journalLineIds'>[]; duplicateCount: number };
