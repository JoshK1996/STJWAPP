import test from 'node:test';
import assert from 'node:assert/strict';
import {formatWorkforceDuration,workforceBarPercent,workforceChartScale,exactWorkforceTimestamp} from '../shared/workforce-display';

test('exact duration labels retain one microsecond and trim only fractional zeroes',()=>{
 assert.equal(formatWorkforceDuration('0'),'0 s');assert.equal(formatWorkforceDuration('1'),'0.000001 s');
 assert.equal(formatWorkforceDuration('100100'),'0.1001 s');assert.equal(formatWorkforceDuration('59999999'),'59.999999 s');
 assert.equal(formatWorkforceDuration('60000000'),'1 min');assert.equal(formatWorkforceDuration('3601000001'),'1 h 1.000001 s');
 assert.equal(formatWorkforceDuration('3600000001',true),'1 hour 0.000001 seconds');
});
test('large totals retain low-order microseconds beyond Number safe integers',()=>{
 assert.equal(formatWorkforceDuration('99999999999999999999'),'27,777,777,777 h 46 min 39.999999 s');
 for(const invalid of ['-1','1.5','1e6','01',''])assert.throws(()=>formatWorkforceDuration(invalid));
});
test('chart ticks are exact integer divisions; only bounded visual geometry is approximate',()=>{
 const scale=workforceChartScale(['1000001','1']);assert.deepEqual(scale,{maximum:'1000004',ticks:['1000004','750003','500002','250001','0']});
 assert.equal(workforceBarPercent('1','3'),33.33);assert.equal(workforceBarPercent('9','3'),100);assert.equal(workforceBarPercent('0','0'),0);
 assert.equal(workforceBarPercent('99999999999999999999','99999999999999999999'),100);
 const largest=workforceChartScale(['99999999999999999999']);assert.equal(largest.maximum,'100000000000000000000');
 assert.equal(formatWorkforceDuration(largest.ticks[0]),'27,777,777,777 h 46 min 40 s');
});
test('local timestamp labels preserve six fractional digits and distinguish a DST fold by offset',()=>{
 assert.equal(exactWorkforceTimestamp('2026-11-01T05:30:00.123456Z','America/New_York'),'Nov 1, 2026 · 1:30:00.123456 AM (-04:00)');
 assert.equal(exactWorkforceTimestamp('2026-11-01T06:30:00.123456Z','America/New_York'),'Nov 1, 2026 · 1:30:00.123456 AM (-05:00)');
 assert.equal(exactWorkforceTimestamp('2026-11-01T06:30:00.000001Z','America/New_York'),'Nov 1, 2026 · 1:30:00.000001 AM (-05:00)');
});
