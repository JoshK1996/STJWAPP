import { recordSeedSchedule } from './staff-scheduling';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Database } from './db';
import { audit } from './security';
export async function initialize(db: Database, options: {demo: boolean; ownerEmail: string}) {
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(78239102)');
    const existing=(await tx.query('SELECT id FROM organizations ORDER BY created_at LIMIT 1')).rows[0];
    if(existing) return existing.id as string;
    const orgId=randomUUID(), ownerId=randomUUID();
    await tx.query('INSERT INTO organizations(id,name,timezone,demo) VALUES($1,$2,$3,$4)',[orgId,'St. Joseph the Worker','America/New_York',options.demo]);
    await tx.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[ownerId,orgId,options.ownerEmail.toLowerCase(),'Workspace Owner','owner']);
    const definitions=[['School','school','Classroom teacher'],['Early Childhood','early_childhood','Early childhood educator'],['Parish','parish','Parish support'],['Administration','administration','Office support']];
    const units:string[]=[],jobs:string[]=[];
    for(const [name,kind,title] of definitions) {
      const unit=randomUUID(),job=randomUUID();units.push(unit);jobs.push(job);
      await tx.query('INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,$3,$4)',[unit,orgId,name,kind]);
      await tx.query('INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,$4)',[job,orgId,unit,title]);
      await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[orgId,ownerId,unit]);
      await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[orgId,ownerId,job]);
    }
    if(options.demo) {
      const names=['Avery Ellis','Jordan Reed','Morgan Lane','Riley Brooks','Casey Bennett','Taylor Quinn','Parker James','Cameron Hayes'];
      const today=DateTime.now().setZone('America/New_York').startOf('day');
      for(let i=0;i<names.length;i++) {
        const id=randomUUID(),unit=units[i%4],job=jobs[i%4];
        await tx.query('INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,$5)',[id,orgId,`demo.${i+1}@stjw.org`,`${names[i]} (Demo)`,i===7?'manager':'employee']);
        await tx.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)',[orgId,id,unit]);
        await tx.query('INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)',[orgId,id,job]);
        for(let days=1;days<=14;days++) {
          const date=today.minus({days});if(date.weekday>5)continue;
          const start=date.plus({hours:7,minutes:30+(i%3)*15});
          const shift=randomUUID();
          await tx.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at) VALUES($1,$2,$3,$4,$5)',[shift,orgId,id,start.toJSDate(),start.plus({hours:8}).toJSDate()]);
          for(const [kind,offset,length] of [['work',0,4],['break',4,0.5],['work',4.5,3.5]] as const)
            await tx.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),orgId,shift,job,kind,start.plus({hours:offset}).toJSDate(),start.plus({hours:offset+length}).toJSDate()]);
        }
        if(i<5) {
          const start=new Date(Date.now()-(120+i*11)*60000),shift=randomUUID();
          await tx.query('INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,$4)',[shift,orgId,id,start]);
          await tx.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),orgId,shift,job,i===3?'break':'work',start]);
        }
        const scheduleId=randomUUID();
        await tx.query('INSERT INTO schedules(id,org_id,user_id,job_id,starts_at,ends_at,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[scheduleId,orgId,id,job,today.plus({days:1,hours:7,minutes:30}).toJSDate(),today.plus({days:1,hours:15,minutes:30}).toJSDate(),'Demonstration schedule',ownerId]);
        await recordSeedSchedule(tx,{id:ownerId,org_id:orgId},scheduleId);
        if(i<3) await tx.query('INSERT INTO requests(id,org_id,user_id,unit_id,kind,starts_on,ends_on,note) VALUES($1,$2,$3,$4,$5,$6,$6,$7)',[randomUUID(),orgId,id,unit,['pto','schedule','correction'][i],today.plus({days:3+i}).toISODate(),'Synthetic request for reviewing the approval workflow.']);
      }
    }
    await audit(tx,{id:ownerId,org_id:orgId},'workspace.initialized',orgId,{syntheticData:options.demo});
    return orgId;
  });
}
