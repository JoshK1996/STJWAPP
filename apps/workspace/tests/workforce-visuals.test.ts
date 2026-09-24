import test from 'node:test';
import assert from 'node:assert/strict';
import { compactWorkDuration, decimalWorkHours, visualRatio, workforceMix, workforceDonutSlices, exactDescending } from '../shared/workforce-visuals';
import type { WorkforceReportRowV2 } from '../shared/workforce-reports-v2';

test('readable compact labels distinguish display approximation from exact subminute time', () => {
  assert.equal(compactWorkDuration('0'), '0s');
  assert.equal(compactWorkDuration('1'), '0.000001s');
  assert.equal(compactWorkDuration('3600000000'), '1h 0m');
  assert.equal(compactWorkDuration('3660000001'), '≈ 1h 1m');
  assert.equal(compactWorkDuration('59999999'), '59.999999s');
});
test('decimal hours round the final integer total and preserve enormous totals without Number conversion', () => {
  assert.equal(decimalWorkHours('9000000000'), '2.50');
  assert.equal(decimalWorkHours('18000000'), '0.01');
  assert.equal(decimalWorkHours('17999999'), '0.00');
  assert.equal(decimalWorkHours('99999999999999999999'), '27,777,777,777.78');
  assert.throws(() => decimalWorkHours('-1'));
});
const row = (job: string, unit: string, duration: string, kind = 'work') => ({job_id: job, job_title: 'Same label', unit_id: unit, unit_name: unit, duration_microseconds: duration, kind}) as WorkforceReportRowV2;
test('mix groups identities instead of names, excludes breaks and aggregates low-order fractions exactly', () => {
  const rows = [row('a','u','9007199254740993'), row('a','u','1'), row('b','u','2'), row('a','u','999','break'), row('c','v','0')];
  assert.deepEqual(workforceMix(rows, 'job').map(x => [x.id, x.duration]), [['a','9007199254740994'], ['b','2']]);
  assert.equal(workforceMix(rows, 'unit')[0].duration, '9007199254740996');
});
test('small visual ratios are bounded; authoritative sort retains differences above safe Number range', () => {
  assert.equal(visualRatio('1','4'), .25); assert.equal(visualRatio('0','0'),0); assert.equal(visualRatio('20','10'),1);
  assert.equal(exactDescending('9007199254740993','9007199254740992'), -1);
});
test('Other is the exact complete remainder, with no omitted work', () => {
  const entries = workforceMix([row('a','u','9'), row('b','u','7'), row('c','u','3')], 'job');
  const slices = workforceDonutSlices(entries,1);
  assert.equal(slices[1].duration,'10'); assert.equal(slices[1].records,2);
  assert.equal(slices.reduce((sum,x)=>sum+BigInt(x.duration),0n),19n);
});
