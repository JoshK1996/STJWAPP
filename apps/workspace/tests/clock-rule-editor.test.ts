import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {clockJobAllowed,clockRulesSchema,normalizeClockRules,openRules} from '../shared/clock-rules';
import {copyDayRule,dayRuleProblem,dayRuleSummary,displayRuleTime,weekdayRules} from '../shared/clock-rule-editor';

test('new weekly setup makes weekdays explicit without inventing clock times',()=>{
  const rules=weekdayRules();assert.deepEqual(rules.days.map(day=>day.allowed),[true,true,true,true,true,false,false]);
  assert.equal(rules.days[0].clockInEarliest,null);assert.notEqual(normalizeClockRules(rules),null);
  rules.days[0].clockInEarliest='08:00';assert.equal(rules.days[1].clockInEarliest,null);
});
test('copying replaces only selected days and copies job choices without shared arrays',()=>{
  const rules=weekdayRules(),job=randomUUID();rules.days[0]={...rules.days[0],jobIds:[job],clockInEarliest:'08:15',clockOutLatest:'16:30'};
  const copy=copyDayRule(rules,0,[1,3]);assert.deepEqual(copy.days[1],rules.days[0]);assert.deepEqual(copy.days[3],rules.days[0]);assert.deepEqual(copy.days[2],rules.days[2]);assert.equal(copy.days[5].allowed,false);
  copy.days[1].jobIds!.push(randomUUID());assert.equal(rules.days[0].jobIds!.length,1);assert.equal(copy.days[3].jobIds!.length,1);
});
test('preview distinguishes blocked days, all jobs and explicit windows without presenting blank times as midnight',()=>{
  assert.equal(displayRuleTime(null),'No limit');assert.equal(displayRuleTime('00:00'),'12:00 AM');assert.equal(displayRuleTime('12:05'),'12:05 PM');
  const day=weekdayRules().days[0];assert.equal(dayRuleSummary(day),'Any time · All jobs');
  assert.match(dayRuleSummary({...day,clockInEarliest:'08:00',clockOutLatest:'15:00',jobIds:[randomUUID()]}),/8:00 AM → 3:00 PM · 1 job/);
  assert.equal(dayRuleSummary({...day,allowed:false}),'Clock-in blocked');
});
test('invalid times and empty job selections identify their weekday while closed-day retained times do not block saving',()=>{
  const day={...weekdayRules().days[0],clockInEarliest:'10:00',clockInLatest:'09:00'};
  assert.match(dayRuleProblem(day,2),/^Wednesday: Earliest clock-in/);assert.equal(dayRuleProblem({...day,allowed:false},2),'');
  assert.match(dayRuleProblem({...weekdayRules().days[0],jobIds:[]},0),/Monday: Choose at least one job/);
});
test('job-only rules stay enabled and job choices follow organization-local weekday including DST changes',()=>{
  const job=randomUUID(),other=randomUUID(),rules=openRules();rules.days[6].jobIds=[job];assert.ok(normalizeClockRules(rules));assert.equal(clockRulesSchema.safeParse(rules).success,true);
  assert.equal(clockJobAllowed(rules,'America/New_York','2026-11-02T03:59:00Z',other),false,'still Sunday in New York');
  assert.equal(clockJobAllowed(rules,'America/New_York','2026-11-02T05:00:00Z',other),true,'Monday is unrestricted');
  assert.equal(clockJobAllowed(rules,'America/New_York','2026-11-01T06:30:00Z',job),true,'repeated fall-back hour');
  rules.days[6].jobIds=[job,job];assert.equal(clockRulesSchema.safeParse(rules).success,false);
  assert.equal(clockJobAllowed(null,'America/New_York','2026-11-01T06:30:00Z',other),true);
});
