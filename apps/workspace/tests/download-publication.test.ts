import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,download} from '../src/api';

function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function captureDownloads(t:TestContext){
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  const state={created:0,clicked:0,revoked:0,name:''};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({href:'',download:'',click(){state.clicked++;state.name=this.download;}})}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');});
  t.mock.method(URL,'createObjectURL',()=>{state.created++;return 'blob:synthetic-download';});
  t.mock.method(URL,'revokeObjectURL',()=>{state.revoked++;});
  return state;
}

for(const path of ['/payroll/hours/export?format=xlsx','/payroll/review/export?format=csv']){
  test(`${path}: losing ownership before response prevents blob publication`,async t=>{
    const state=captureDownloads(t),response=deferred<Response>();let owned=true,read=0;
    t.mock.method(globalThis,'fetch',()=>response.promise);
    const pending=download(path,'synthetic-export',()=>owned);
    owned=false;
    response.resolve({ok:true,blob:async()=>{read++;return new Blob(['synthetic']);}} as Response);
    assert.equal(await pending,false);
    assert.equal(read,0);
    assert.equal(state.created,0);
    assert.equal(state.clicked,0);
  });
  test(`${path}: losing ownership while reading body prevents a late download`,async t=>{
    const state=captureDownloads(t),body=deferred<Blob>(),reading=deferred<void>();let owned=true;
    t.mock.method(globalThis,'fetch',async()=>({ok:true,blob:()=>{reading.resolve();return body.promise;}} as Response));
    const pending=download(path,'synthetic-export',()=>owned);
    await reading.promise;
    owned=false;
    body.resolve(new Blob(['synthetic']));
    assert.equal(await pending,false);
    assert.equal(state.created,0);
    assert.equal(state.clicked,0);
  });
}

test('an ordinary caller without an ownership callback still receives a download',async t=>{
  const state=captureDownloads(t);
  t.mock.method(globalThis,'fetch',async()=>new Response('synthetic CSV',{status:200}));
  assert.equal(await download('/example','synthetic.csv'),undefined);
  assert.equal(state.created,1);
  assert.equal(state.clicked,1);
  assert.equal(state.name,'synthetic.csv');
});

test('owned HTTP failures preserve ApiError and do not create a download',async t=>{
  const state=captureDownloads(t);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'This report is no longer available.'}),{status:403,headers:{'Content-Type':'application/json'}}));
  await assert.rejects(download('/example','synthetic.csv',()=>true),error=>error instanceof ApiError&&error.status===403);
  assert.equal(state.created,0);
  assert.equal(state.clicked,0);
});
