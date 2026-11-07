import type { Queryable } from './db';
import { requireCondition } from './security';

export async function shoppingPrograms(tx:Queryable,orgId:string){
  return (await tx.query('SELECT shopping_job_id,cafe_job_id,unit_id FROM shopping_programs WHERE org_id=$1 ORDER BY shopping_job_id',[orgId])).rows;
}
/** Materialize the café-derived grant in every staff write path. */
export async function shoppingAssignmentIds(tx:Queryable,orgId:string,selected:string[],retained:string[]=[]){
  const result=new Set(selected),programs=await shoppingPrograms(tx,orgId);
  for(const p of programs){
    if(result.has(p.cafe_job_id))result.add(p.shopping_job_id);
    else if(result.has(p.shopping_job_id)){
      requireCondition(retained.includes(p.shopping_job_id),400,'Shopping is included with the café job. Assign the café job first.');result.delete(p.shopping_job_id);
    }
  }
  requireCondition(result.size<=40,400,'This employee has too many jobs, including café Shopping assignments.');return [...result].sort();
}
export async function shoppingJobFamily(tx:Queryable,orgId:string,id:string){
  const rows=(await tx.query('SELECT shopping_job_id,cafe_job_id FROM shopping_programs WHERE org_id=$1 AND (shopping_job_id=$2 OR cafe_job_id=$2)',[orgId,id])).rows;
  return [...new Set<string>([id,...rows.flatMap(p=>[p.shopping_job_id,p.cafe_job_id])])].sort();
}
