import { z } from 'zod';
import { dateOnly } from './contracts';

const amount = z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/, 'Use a positive decimal amount without commas.');
const quantity = z.string().trim().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/, 'Use a quantity with up to six decimal places.');
const label = z.string().trim().min(1).max(160);
const reason = z.string().trim().min(5).max(1000);
export const budgetInput = z.object({commandId:z.uuid(),name:label,periodId:z.uuid(),reason,
  lines:z.array(z.object({accountId:z.uuid(),fundId:z.uuid().nullable().default(null),amount}).strict()).min(1).max(500)}).strict();
export const planningAction = z.object({commandId:z.uuid(),expectedVersion:z.number().int().positive(),reason,reviewed:z.literal(true)}).strict();
export const payrollPlanningInput = z.object({commandId:z.uuid(),name:label,start:dateOnly,end:dateOnly,payDate:dateOnly,reason,
  payableAccountId:z.uuid(),
  employees:z.array(z.object({userId:z.uuid(),
    earnings:z.array(z.object({label,quantity,rate:amount,expenseAccountId:z.uuid(),fundId:z.uuid().nullable().default(null)}).strict()).min(1).max(20),
    deductions:z.array(z.object({label,amount,liabilityAccountId:z.uuid()}).strict()).max(20),
    employerCosts:z.array(z.object({label,amount,expenseAccountId:z.uuid(),liabilityAccountId:z.uuid()}).strict()).max(20),
  }).strict()).min(1).max(200),
}).strict().refine(x=>x.end>=x.start && x.payDate>=x.end,'Pay date must follow the end of the work period.');
export type PayrollPlanningInput=z.infer<typeof payrollPlanningInput>;
/** Exact quantity x rate, rounded half up at each named earning, to the configured currency precision. */
export function earningUnits(quantity:string,rate:string,precision:number):bigint {
  if(!Number.isInteger(precision)||precision<0||precision>4)throw new RangeError('Invalid currency precision.');
  const parts=(value:string,places:number)=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));};
  const q=parts(z.string().regex(/^\d+(?:\.\d{1,6})?$/).parse(quantity),6);
  const r=parts(amount.parse(rate),4), divisor=10n**BigInt(10-precision);
  return (q*r+divisor/2n)/divisor;
}
