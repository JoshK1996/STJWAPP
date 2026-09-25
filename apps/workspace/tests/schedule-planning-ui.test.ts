import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planningInstant, planningOverlap, planningRange, planningTime, staffHours } from '../src/SchedulePlanningShared';

test('planning ranges use calendar boundaries and Monday weeks, including leap years and DST weeks',()=>{
  assert.deepEqual(planningRange('2027-03-14','week'),{start:'2027-03-08',end:'2027-03-14'});
  assert.deepEqual(planningRange('2028-02-29','month'),{start:'2028-02-01',end:'2028-02-29'});
  assert.deepEqual(planningRange('2028-02-29','year'),{start:'2028-01-01',end:'2028-12-31'});
  assert.equal(planningRange('not a date','day'),null);
});
test('staff-hour presentation rounds only the aggregate and preserves signed exact inputs',()=>{
  assert.equal(staffHours('3599999999'),'1');
  assert.equal(staffHours('18000000'),'0.01');
  assert.equal(staffHours('-18000000'),'−0.01');
  assert.equal(staffHours('444444440444444444'),'123,456,789.01');
});
test('preview overlap distinguishes microsecond boundaries and allows adjacent places',()=>{
  const a={startsAt:'2027-01-05T13:00:00.000000Z',endsAt:'2027-01-05T14:00:00.000001Z'};
  assert.equal(planningOverlap(a,{startsAt:'2027-01-05T14:00:00.000000Z',endsAt:'2027-01-05T15:00:00.000000Z'}),true);
  assert.equal(planningOverlap(a,{startsAt:'2027-01-05T14:00:00.000001Z',endsAt:'2027-01-05T15:00:00.000000Z'}),false);
  assert.equal(planningInstant('2027-01-05T13:00:00.000001Z')-planningInstant('2027-01-05T13:00:00.000000Z'),1n);
});
test('partial coverage time labels retain seconds and exact fractional boundary while ordinary times remain readable',()=>{
  assert.equal(planningTime('2027-01-05T13:00:00.000000Z','America/New_York'),'Jan 5, 8:00 AM');
  assert.equal(planningTime('2027-01-05T13:00:00.000001Z','America/New_York'),'Jan 5, 8:00:00.000001 AM');
});
