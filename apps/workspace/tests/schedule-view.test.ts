import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDayBar, scheduleWindowSummary, scheduledTime, initialScheduleSelection } from '../src/schedule-view';
const row=(id:string,user_id:string,starts_at:string,ends_at:string,status:'scheduled'|'cancelled'='scheduled')=>({id,user_id,starts_at,ends_at,status});
const j='00000000-0000-4000-8000-000000000001',u='00000000-0000-4000-8000-000000000002',e='00000000-0000-4000-8000-000000000003';
test('schedule summary counts distinct shifts and people while excluding cancelled shifts',()=>{
 const a=row('a','person','2026-09-27T08:00:00Z','2026-09-27T09:00:00Z');
 const result=scheduleWindowSummary([a,a,row('b','person','2026-09-27T10:00:00Z','2026-09-27T11:30:00Z'),row('c','other','2026-09-27T12:00:00Z','2026-09-27T18:00:00Z','cancelled')],{start:'2026-09-27',end:'2026-09-27'},'UTC');
 assert.deepEqual(result,{shifts:2,employees:1,microseconds:9_000_000_000n});assert.equal(scheduledTime(result.microseconds),'2h 30m');
});
test('schedule summary clips overnight cards at the selected organization day and preserves microseconds',()=>{
 const result=scheduleWindowSummary([row('a','person','2026-09-27T03:59:59.123456Z','2026-09-27T04:00:00.123456Z'),row('b','other','2026-09-28T03:59:59.654321Z','2026-09-28T04:00:00.654321Z')],{start:'2026-09-27',end:'2026-09-27'},'America/New_York');
 assert.deepEqual(result,{shifts:2,employees:2,microseconds:469135n});assert.equal(scheduledTime(result.microseconds),'<1 min');
});
test('schedule summaries use real daylight-saving day lengths',()=>{
 assert.equal(scheduleWindowSummary([row('a','p','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z')],{start:'2026-03-08',end:'2026-03-08'},'America/New_York').microseconds,23n*3_600_000_000n);
 assert.equal(scheduleWindowSummary([row('a','p','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z')],{start:'2026-11-01',end:'2026-11-01'},'America/New_York').microseconds,25n*3_600_000_000n);
});
test('visual day bars clip cross-day shifts and remain within the day',()=>{
 assert.deepEqual(scheduleDayBar(row('a','p','2026-09-26T20:00:00Z','2026-09-27T06:00:00Z'),'2026-09-27','UTC'),{left:0,width:25});
 assert.deepEqual(scheduleDayBar(row('a','p','2026-09-27T18:00:00Z','2026-09-28T06:00:00Z'),'2026-09-27','UTC'),{left:75,width:25});
 assert.deepEqual(scheduleDayBar(row('a','p','2026-09-26T18:00:00Z','2026-09-26T20:00:00Z'),'2026-09-27','UTC'),{left:0,width:0});
 assert.deepEqual(scheduleDayBar(row('a','p','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z'),'2026-11-01','America/New_York'),{left:0,width:100});
});
test('saved schedule defaults use today and remove unavailable selections with a notice',()=>{
 const saved={period:'day',view:'assigned',jobId:j,unitId:u,employeeId:e};
 const result=initialScheduleSelection(saved,null,'2026-09-27',[],[]);
 assert.equal(result.anchor,'2026-09-27');assert.equal(result.period,'day');assert.equal(result.jobId,'');assert.equal(result.unitId,'');assert.equal(result.userId,'');assert.match(result.notice,/cleared/);
 const available=initialScheduleSelection(saved,null,'2026-09-28',[{id:e}],[{id:j,unit_id:u}]);assert.equal(available.userId,e);assert.equal(available.jobId,j);assert.equal(available.notice,'');
});
test('explicit employee or job links override unrelated saved personal filters',()=>{
 const saved={period:'week',view:'targets',jobId:j,unitId:u,employeeId:e};
 const person=initialScheduleSelection(saved,{userId:e},'2026-09-27',[],[]);
 assert.equal(person.view,'assigned');assert.equal(person.userId,e);assert.equal(person.jobId,'');assert.equal(person.unitId,'');assert.equal(person.notice,'');
 const job=initialScheduleSelection(saved,{jobId:j,mode:'rules'},'2026-09-27',[],[]);assert.equal(job.view,'rules');assert.equal(job.jobId,j);assert.equal(job.userId,'');
});
test('invalid legacy preferences fall back to the simple weekly schedule',()=>{
 const value=initialScheduleSelection({period:'forever'},undefined,'2026-09-27',[],[]);assert.equal(value.period,'week');assert.equal(value.view,'assigned');
 assert.deepEqual(scheduleWindowSummary([],{start:'2026-09-28',end:'2026-09-27'},'UTC'),{shifts:0,employees:0,microseconds:0n});assert.equal(scheduledTime(0n),'0 min');
});
