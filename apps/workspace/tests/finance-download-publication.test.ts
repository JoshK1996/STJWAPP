import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,downloadPost} from '../src/api';
import {getPendingWriteCount} from '../src/pending-writes';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function capture(t:TestContext){
  const original=Object.getOwnPropertyDescriptor(globalThis,'document'),state={created:0,clicked:0,revoked:0};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({href:'',download:'',click(){state.clicked++;}})}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');});
  t.mock.method(URL,'createObjectURL',()=>{state.created++;return 'blob:synthetic-finance';});t.mock.method(URL,'revokeObjectURL',()=>{state.revoked++;});return state;
}
test('finance POST export loses publication ownership before response and releases its pending-write guard',async t=>{
  const state=capture(t),response=deferred<Response>();let owned=true,read=0;
  t.mock.method(globalThis,'fetch',()=>response.promise);const pending=downloadPost('/finance/compare/export',{},'synthetic.csv',()=>owned);assert.equal(getPendingWriteCount(),1);owned=false;
  response.resolve({ok:true,blob:async()=>{read++;return new Blob(['synthetic']);}} as Response);
  assert.equal(await pending,false);assert.equal(read,0);assert.equal(state.created,0);assert.equal(state.clicked,0);assert.equal(getPendingWriteCount(),0);
});
test('finance POST export prevents a late body download after unmount or actor change',async t=>{
  const state=capture(t),body=deferred<Blob>(),reading=deferred<void>();let owned=true;
  t.mock.method(globalThis,'fetch',async()=>({ok:true,blob:()=>{reading.resolve();return body.promise;}} as Response));
  const pending=downloadPost('/finance/compare/export',{},'synthetic.csv',()=>owned);await reading.promise;owned=false;body.resolve(new Blob(['synthetic']));
  assert.equal(await pending,false);assert.equal(state.created,0);assert.equal(state.clicked,0);assert.equal(getPendingWriteCount(),0);
});
test('finance POST export revokes an unpublished object URL if ownership changes before the click',async t=>{
  const state=capture(t);let checks=0;t.mock.method(globalThis,'fetch',async()=>new Response('synthetic'));
  assert.equal(await downloadPost('/finance/compare/export',{},'synthetic.csv',()=>++checks<3),false);assert.equal(state.clicked,0);assert.equal(state.created,1);assert.equal(state.revoked,1);assert.equal(getPendingWriteCount(),0);
});
test('ordinary POST exports preserve their return contract and owned HTTP failures remain actionable',async t=>{
  const state=capture(t);t.mock.method(globalThis,'fetch',async()=>new Response('synthetic'));
  assert.equal(await downloadPost('/finance/compare/export',{},'synthetic.csv'),undefined);assert.equal(state.clicked,1);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'Access changed'}),{status:403}));
  await assert.rejects(downloadPost('/finance/compare/export',{},'synthetic.csv',()=>true),error=>error instanceof ApiError&&error.status===403);
  assert.equal(state.clicked,1);assert.equal(getPendingWriteCount(),0);
});
