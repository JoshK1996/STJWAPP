import test from 'node:test';
import assert from 'node:assert/strict';
import {movePersonalTimeAnchor,personalTimeCustomError,personalTimeDuration,personalTimeCommunities} from '../shared/personal-time-view';

test('personal history navigation preserves calendar periods across short months and leap years',()=>{
 assert.equal(movePersonalTimeAnchor('2028-01-31','month',1),'2028-02-01');
 assert.equal(movePersonalTimeAnchor('2028-03-31','month',-1),'2028-02-01');
 assert.equal(movePersonalTimeAnchor('2028-02-29','year',1),'2029-01-01');
 assert.equal(movePersonalTimeAnchor('2027-01-01','year',-1),'2026-01-01');
});
test('personal history week movement uses Monday and crosses daylight-saving calendar boundaries',()=>{
 assert.equal(movePersonalTimeAnchor('2026-03-08','week',1),'2026-03-09');
 assert.equal(movePersonalTimeAnchor('2026-11-01','day',1),'2026-11-02');
 assert.equal(movePersonalTimeAnchor('2026-03-09','day',-1),'2026-03-08');
 assert.equal(movePersonalTimeAnchor('2026-01-01','week',-1),'2025-12-22');
});
test('personal history custom range is inclusive and rejects impossible, reversed and oversized dates',()=>{
 assert.equal(personalTimeCustomError('2028-01-01','2028-12-31'),'');
 assert.equal(personalTimeCustomError('2026-10-01','2026-10-01'),'');
 assert.match(personalTimeCustomError('2028-01-01','2029-01-01'),/366/);
 assert.match(personalTimeCustomError('2026-10-02','2026-10-01'),/on or after/);
 assert.match(personalTimeCustomError('2026-02-29','2026-03-01'),/valid/);
 assert.match(personalTimeCustomError('','2026-03-01'),/valid/);
 assert.throws(()=>movePersonalTimeAnchor('2026-02-30','day',1),/valid/);
});
test('personal navigation and custom dates stay within the server-supported calendar',()=>{
 assert.throws(()=>movePersonalTimeAnchor('1900-01-01','day',-1),/1900/);
 assert.throws(()=>movePersonalTimeAnchor('9998-12-31','year',1),/9998/);
 assert.match(personalTimeCustomError('1899-12-31','1900-01-01'),/valid/);
 assert.match(personalTimeCustomError('9998-12-31','9999-01-01'),/valid/);
});
test('personal display labels stay readable without changing exact duration values',()=>{
 assert.equal(personalTimeDuration('0'),'0 min');
 assert.equal(personalTimeDuration('1'),'<1 min');
 assert.equal(personalTimeDuration('59999999'),'<1 min');
 assert.equal(personalTimeDuration('60000000'),'1m');
 assert.equal(personalTimeDuration('3660000000'),'1h 1m');
 assert.equal(personalTimeDuration('3660000001'),'≈ 1h 1m');
 assert.equal(personalTimeDuration('9007199254740993'),'≈ 2,501,999h 47m');
 assert.throws(()=>personalTimeDuration('-1'),/nonnegative/);
});
test('personal community breakdown aggregates exact values across jobs with stable identities',()=>{
 const result=personalTimeCommunities([
  {unitId:'school',unitName:'School',workMicroseconds:'9007199254740993',breakMicroseconds:'1'},
  {unitId:'school',unitName:'School',workMicroseconds:'9007199254740993',breakMicroseconds:'2'},
  {unitId:'care',unitName:'Early care',workMicroseconds:'100',breakMicroseconds:'200'},
 ]);
 assert.deepEqual(result,[{unitId:'school',unitName:'School',workMicroseconds:'18014398509481986',breakMicroseconds:'3'},{unitId:'care',unitName:'Early care',workMicroseconds:'100',breakMicroseconds:'200'}]);
 assert.deepEqual(personalTimeCommunities([]),[]);
});
