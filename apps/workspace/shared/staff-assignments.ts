import {z} from 'zod';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const uniqueIds=(maximum:number,minimum=0)=>z.array(uuid).min(minimum).max(maximum)
  .refine(ids=>new Set(ids).size===ids.length,'Choose each assignment only once.');
export const staffAssignmentsInput=z.object({
  unitIds:uniqueIds(30,1),jobIds:uniqueIds(40),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const staffAssignmentsSnapshot=z.object({
  userId:z.uuid(),employeeName:z.string(),unitIds:z.array(z.uuid()),jobIds:z.array(z.uuid()),
  revision:z.string().regex(/^[a-f0-9]{64}$/),lockedJobIds:z.array(z.uuid()),lockedUnitIds:z.array(z.uuid()),
  units:z.array(z.object({id:z.uuid(),name:z.string()}).strict()).max(1000),
  jobs:z.array(z.object({id:z.uuid(),title:z.string(),unitId:z.uuid(),active:z.boolean()}).strict()).max(5000),
  changed:z.boolean(),
}).strict();
export type StaffAssignments=z.infer<typeof staffAssignmentsSnapshot>;
export type StaffAssignmentsInput=z.infer<typeof staffAssignmentsInput>;
