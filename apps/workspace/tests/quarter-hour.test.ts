import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quarterHourDecimal,roundToQuarterHour,QUARTER_HOUR_MICROSECONDS} from '../shared/quarter-hour';
import {formatReportHours} from '../shared/report-presentation';
import {payrollPresentationHours,payrollPresentationOptionsSchema,payrollPresentationValue} from '../shared/payroll-presentation';

const minutes=(value:number,seconds=0,micro=0)=>BigInt(value)*60_000_000n+BigInt(seconds)*1_000_000n+BigInt(micro);
const hours=(value:number,m=0,s=0,micro=0)=>BigInt(value)*3_600_000_000n+minutes(m,s,micro);

test('totals round to the nearest quarter hour, with an exact half rounding up',()=>{
  const cases:[bigint,string][]=[
    [0n,'0.00'],[hours(8),'8.00'],[hours(7,7,29,999_999),'7.00'],[hours(7,7,30),'7.25'],[hours(7,22,29,999_999),'7.25'],[hours(7,22,30),'7.50'],
    [hours(7,52,30),'8.00'],[hours(7,37,29),'7.50'],[hours(7,37,30),'7.75'],[minutes(7,29),'0.00'],[minutes(7,30),'0.25'],[hours(40,7,29),'40.00'],[hours(40,14),'40.25'],[hours(1234,59),'1235.00'],
  ];
  for(const [value,expected] of cases)assert.equal(quarterHourDecimal(value),expected,String(value));
  assert.equal(roundToQuarterHour(-hours(0,7,30)),-QUARTER_HOUR_MICROSECONDS,'negative changes round the same distance from zero');
  assert.equal(quarterHourDecimal(-hours(2,10)),'-2.25');
});

test('rounding happens once, after segments are added together, never per segment',()=>{
  const segments=Array.from({length:3},()=>minutes(5));
  const perSegment=segments.reduce((sum,value)=>sum+roundToQuarterHour(value),0n),afterAggregation=roundToQuarterHour(segments.reduce((sum,value)=>sum+value,0n));
  assert.equal(perSegment,0n,'rounding each five-minute segment first would lose the whole fifteen minutes');
  assert.equal(afterAggregation,QUARTER_HOUR_MICROSECONDS);
});

test('report and payroll hour displays use quarter hours by default and keep an exact choice',()=>{
  const value=String(hours(7,52,30));
  assert.equal(formatReportHours(value),'8.00');assert.equal(formatReportHours(String(hours(7,10)),2),'7.25');
  assert.equal(formatReportHours(String(hours(7,10)),2,'exact'),'7.17');assert.equal(formatReportHours(String(hours(7,10)),4,'exact'),'7.1667');
  assert.equal(formatReportHours('not a number'),'not a number');assert.equal(formatReportHours('-'+String(hours(2,10))),'-2.25');
  assert.equal(payrollPresentationHours(String(hours(7,10))),'7.25');assert.equal(payrollPresentationHours(String(hours(7,10)),4),'7.2500');
  assert.equal(payrollPresentationHours(String(hours(7,10)),2,'exact'),'7.17');assert.equal(payrollPresentationHours(String(hours(7,10)),3,'exact'),'7.167');
  const options=payrollPresentationOptionsSchema.parse({});assert.equal(options.hourRounding,'quarter');
  const row={workMicroseconds:String(hours(7,10)),breakMicroseconds:String(minutes(31)),totalMicroseconds:String(hours(7,41)),shiftCount:1,ongoingSegmentCount:0};
  assert.equal(payrollPresentationValue(row,'workHours',options),'7.25');assert.equal(payrollPresentationValue(row,'breakHours',options),'0.50');assert.equal(payrollPresentationValue(row,'totalHours',options),'7.75');
  assert.equal(payrollPresentationValue(row,'workHours',{...options,hourRounding:'exact'}),'7.17');
  assert.equal(payrollPresentationOptionsSchema.safeParse({hourRounding:'tenth'}).success,false);
});
