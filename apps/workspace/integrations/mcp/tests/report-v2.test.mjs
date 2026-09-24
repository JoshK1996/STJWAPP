import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { StjwReads } from '../build/api.js';
import { readConfig } from '../build/config.js';
import { reportOutputV2Schema } from '../build/report-v2-schema.js';

const id='11111111-1111-4111-8111-111111111111';
const query={start:'2026-09-22',end:'2026-09-22',group:'day'};
const token='synthetic_v2_bridge_token_'.padEnd(43,'x');
export function exactReport(){
  const start='2026-09-22T12:00:00.123400Z',end='2026-09-22T12:00:00.123456Z';
  return {schemaVersion:2,precisionVersion:2,durationUnit:'microsecond',timezone:'America/New_York',asOf:'2026-09-22T18:00:00.000001Z',
    range:{from:'2026-09-22T04:00:00.000000Z',toExclusive:'2026-09-23T04:00:00.000000Z'},query,
    workMicroseconds:'56',breakMicroseconds:'0',sourceRowCount:1,contributingRowCount:1,
    rows:[{id,shift_id:id,revision:1,user_id:id,employee_name:'Synthetic employee',job_id:id,job_title:'Synthetic job',unit_id:id,unit_name:'Synthetic unit',kind:'work',started_at:start,ended_at:end,recorded_duration_microseconds:'56',clipped_started_at:start,clipped_ended_at:end,duration_microseconds:'56'}],
    buckets:[{key:'2026-09-22T04:00:00.000000Z',startsAt:'2026-09-22T04:00:00.000000Z',endsAt:'2026-09-23T04:00:00.000000Z',label:'Sep 22',workMicroseconds:'56',breakMicroseconds:'0'}],
    staff:[{userId:id,name:'Synthetic employee',workMicroseconds:'56',breakMicroseconds:'0'}],notice:'Recorded durations only; no payroll rules.'};
}
async function upstream(t,handler){
  const requests=[];
  const server=http.createServer((req,res)=>{requests.push(req.url);handler(req,res);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config=readConfig({STJW_API_ORIGIN:`http://127.0.0.1:${server.address().port}`,STJW_API_TOKEN:token,STJW_ALLOW_LOOPBACK_HTTP:'1'});
  return {api:new StjwReads(config),requests};
}
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const rejected=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('v2 uses its fixed route and preserves one-microsecond evidence as strings',async t=>{
  const server=await upstream(t,(req,res)=>{assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer '+token);json(res,exactReport());});
  const value=await server.api.reportV2(query);
  assert.deepEqual(value,exactReport());assert.deepEqual(server.requests,['/api/reports/v2?start=2026-09-22&end=2026-09-22&group=day']);
  assert.equal(value.rows[0].duration_microseconds,'56');
});
test('v2 strips unknown properties at every report level',()=>{
  const value=exactReport();value.password='synthetic-private-field';value.rows[0].setupUrl='synthetic-private-field';value.staff[0].token='synthetic-private-field';value.buckets[0].secret='synthetic-private-field';value.range.cookie='synthetic-private-field';
  const parsed=reportOutputV2Schema.parse(value);assert.equal(JSON.stringify(parsed).includes('synthetic-private-field'),false);assert.deepEqual(parsed,exactReport());
});
test('v2 rejects unsafe numeric substitutions, excess precision and version drift',()=>{
  for(const change of [v=>v.workMicroseconds=56,v=>v.workMicroseconds='056',v=>v.workMicroseconds='-1',v=>v.workMicroseconds='1e6',v=>v.workMicroseconds='1'.repeat(21),v=>v.schemaVersion=1,v=>v.precisionVersion=1,v=>v.durationUnit='millisecond',v=>v.rows[0].started_at='2026-02-30T00:00:00.000000Z',v=>v.asOf='2026-09-22T18:00:00.0000001Z',v=>v.asOf='0000-09-22T18:00:00.000000Z']){
    const value=exactReport();change(value);assert.equal(reportOutputV2Schema.safeParse(value).success,false);
  }
  const huge=exactReport();huge.workMicroseconds='9007199254740993';assert.equal(reportOutputV2Schema.parse(huge).workMicroseconds,'9007199254740993');
});
test('v2 rejects query-echo mismatches and never retries the legacy endpoint',async t=>{
  let legacy=false;
  const server=await upstream(t,(_req,res)=>{const value=exactReport();if(legacy)delete value.schemaVersion;else value.query={...query,userId:id};json(res,value);});
  await rejected(server.api.reportV2(query),'INVALID_RESPONSE');legacy=true;await rejected(server.api.reportV2(query),'INVALID_RESPONSE');
  assert.equal(server.requests.length,2);assert.ok(server.requests.every(path=>path.startsWith('/api/reports/v2?')));
});
test('v2 validates input before sending any request',async t=>{
  const server=await upstream(t,(_req,res)=>json(res,exactReport()));
  for(const value of [{...query,url:'https://untrusted.test'},{...query,start:'2026-02-30'},{...query,start:'2025-01-01'},{...query,group:'hour',end:'2026-11-01'}])await rejected(server.api.reportV2(value),'INVALID_INPUT');
  assert.equal(server.requests.length,0);
});
test('v2 preserves read limits and sanitized denials',async t=>{
  let mode='limit';const server=await upstream(t,(_req,res)=>{if(mode==='denied')return json(res,{error:token},403);const value=exactReport();value.rows=Array(5001).fill(value.rows[0]);json(res,value);});
  await rejected(server.api.reportV2(query),'RESPONSE_LIMIT');mode='denied';await assert.rejects(server.api.reportV2(query),error=>error.code==='FORBIDDEN'&&!error.message.includes(token));
});
