import { DateTime } from 'luxon';
import type { Queryable, Row } from './db';
import { orgWide, canReport, requireCondition, type Actor } from './security';
export type ReportQuery = { start: string; end: string; group: 'hour'|'day'|'week'|'month'|'year'; unitId?: string; userId?: string };
export function reportBounds(query: ReportQuery, zone: string) {
  const start=DateTime.fromISO(query.start,{zone}).startOf('day');
  const end=DateTime.fromISO(query.end,{zone}).startOf('day').plus({days:1});
  requireCondition(start.isValid && end.isValid && end>start,400,'Choose a valid date range.');
  requireCondition(end.diff(start,'days').days<=367,400,'Choose a range of at most one year.');
  if(query.group==='hour') requireCondition(end.diff(start,'days').days<=32,400,'Hourly reports support at most 32 calendar dates.');
  return {start,end};
}
export function aggregateSegments(rows: Row[], query: ReportQuery, zone: string, now: Date) {
  const {start,end}=reportBounds(query,zone);
  const groups=new Map<string,Row>();
  const staff=new Map<string,Row>();
  let workMs=0,breakMs=0;
  for(const row of rows) {
    let cursor=Math.max(new Date(row.started_at).getTime(),start.toMillis());
    const stop=Math.min(new Date(row.ended_at??now).getTime(),end.toMillis(),now.getTime());
    if(stop<=cursor) continue;
    const person=staff.get(row.user_id)??{id:row.user_id,name:row.employee_name,workMs:0,breakMs:0};
    person[row.kind==='work'?'workMs':'breakMs']+=stop-cursor; staff.set(row.user_id,person);
    if(row.kind==='work')workMs+=stop-cursor;else breakMs+=stop-cursor;
    while(cursor<stop) {
      const local=DateTime.fromMillis(cursor,{zone});
      const base=local.startOf(query.group);
      // Hour progression follows instants; calendar days follow the organization's timezone.
      const next=base.plus({[query.group+'s']:1}).toMillis();
      const boundary=Math.min(next,stop);
      requireCondition(boundary>cursor,500,'Invalid report boundary.');
      const key=base.toISO()!;
      const bucket=groups.get(key)??{key,label:base.toFormat(query.group==='hour'?'LLL d HH:mm ZZZZ':query.group==='month'?'LLL yyyy':query.group==='year'?'yyyy':'LLL d'),workMs:0,breakMs:0};
      bucket[row.kind==='work'?'workMs':'breakMs']+=boundary-cursor; groups.set(key,bucket); cursor=boundary;
    }
  }
  return {workMs,breakMs,buckets:[...groups.values()].sort((a,b)=>a.key.localeCompare(b.key)),staff:[...staff.values()].sort((a,b)=>a.name.localeCompare(b.name))};
}
export async function getReport(db: Queryable, actor: Actor, query: ReportQuery, now=new Date()) {
  const org=(await db.query('SELECT timezone FROM organizations WHERE id=$1',[actor.org_id])).rows[0];
  const {start,end}=reportBounds(query,org.timezone);
  const privileged=canReport(actor);
  const rows=(await db.query(`SELECT s.id,s.kind,s.started_at,s.ended_at,h.revision AS revision,h.id AS shift_id,h.user_id,u.name AS employee_name,
    j.id AS job_id,j.title AS job_title,n.id AS unit_id,n.name AS unit_name FROM segments s JOIN shifts h ON h.id=s.shift_id
    JOIN users u ON u.id=h.user_id JOIN jobs j ON j.id=s.job_id JOIN units n ON n.id=j.unit_id
    WHERE s.org_id=$1 AND s.revision=h.revision AND s.started_at<$3 AND (s.ended_at IS NULL OR s.ended_at>$2)
    AND ($4::boolean OR h.user_id=$5) AND ($6::boolean OR h.user_id=$5 OR n.id=ANY($7::uuid[]))
    AND ($8::uuid IS NULL OR n.id=$8) AND ($9::uuid IS NULL OR h.user_id=$9) ORDER BY s.started_at DESC LIMIT 20001`,
    [actor.org_id,start.toJSDate(),end.toJSDate(),privileged,actor.id,orgWide(actor),actor.unit_ids,query.unitId??null,query.userId??null])).rows;
  requireCondition(rows.length<=20000,400,'This report exceeds 20,000 segments. Choose a shorter range.');
  const detailedRows:Row[]=rows.map(row=>{const duration_ms=Math.max(0,Math.min(new Date(row.ended_at??now).getTime(),end.toMillis(),now.getTime())-Math.max(new Date(row.started_at).getTime(),start.toMillis()));return {...row,duration_ms,duration_seconds:duration_ms/1000};});
  return { ...aggregateSegments(rows,query,org.timezone,now), rows:detailedRows, timezone:org.timezone, asOf:now.toISOString(), query,
    notice:'Recorded work and break durations only. Paid-break, overtime, leave accrual, and payroll rules are not configured.' };
}
export function csvCell(value: unknown) {
  let text=value instanceof Date?value.toISOString():String(value??'');
  // Spreadsheet formula protection is applied to all strings, including after leading whitespace.
  if (/^[\s]*[=+@\-\t\r\0]/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function toCsv(rows: Row[], columns: string[]) { return '\uFEFF'+[columns.map(csvCell).join(','),...rows.map(row=>columns.map(k=>csvCell(row[k])).join(','))].join('\r\n'); }
export const reportColumns=['employee_name','unit_name','job_title','kind','started_at','ended_at','duration_seconds','shift_id','id','revision'];
