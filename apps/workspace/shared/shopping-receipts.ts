import { z } from 'zod';
import { dateOnly } from './contracts';
const uuid=z.uuid().transform(value=>value.toLowerCase());
export const receiptLimits={sourceBytes:8*1024*1024,photoBytes:4*1024*1024,thumbnailBytes:512*1024,pixels:50_000_000,page:50,defaultStorageBytes:1024*1024*1024} as const;
export const receiptUploadInput=z.object({commandId:uuid,jobId:uuid,purchasedOn:dateOnly,
  vendor:z.string().trim().max(200).default(''),total:z.string().trim().regex(/^(?:\d{1,9}(?:\.\d{1,2})?)?$/,'Enter a dollar amount with at most two decimal places.').default(''),
  note:z.string().trim().max(2000).default(''),shiftId:uuid.nullable().optional(),
  imageBase64:z.string().min(8).max(Math.ceil(receiptLimits.sourceBytes/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/,'Choose a valid photo.')}).strict();
export const receiptListInput=z.object({view:z.enum(['mine','team']).default('mine'),start:dateOnly.optional(),end:dateOnly.optional(),
  userId:uuid.optional(),unitId:uuid.optional(),shiftId:uuid.optional(),status:z.enum(['active','archived','deleted','all']).default('active'),
  offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export const receiptStateInput=z.object({commandId:uuid,expectedVersion:z.number().int().positive(),status:z.enum(['active','archived','deleted']),note:z.string().trim().max(1000).default('')}).strict();
export function receiptAmountMinor(value:string):string|null{
  if(!value)return null;const [whole,fraction='']=value.split('.');return (BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'))).toString();
}
export function receiptAmountLabel(value:string|null):string{
  if(value===null)return '';const amount=BigInt(value);return '$'+(amount/100n).toLocaleString('en-US')+'.'+(amount%100n).toString().padStart(2,'0');
}
export type ShoppingReceipt={id:string;userId:string;employeeName:string;jobId:string;jobTitle:string;unitId:string;unitName:string;
  purchasedOn:string;vendor:string|null;amountMinor:string|null;note:string|null;shiftId:string|null;shiftRevision:number|null;
  uploadedAt:string;updatedAt:string;status:'active'|'archived'|'deleted';version:number;width:number;height:number;photoSize:number;canManage:boolean};
export type ReceiptJob={id:string;title:string;unitId:string;unitName:string;cafeTitle:string};
export type ShoppingReceiptList={rows:ShoppingReceipt[];hasMore:boolean;hasOwnReceipts:boolean;timezone:string;today:string;eligibleJobs:ReceiptJob[];canReview:boolean;canManage:boolean;storage?:{usedBytes:string;limitBytes:string}};
