import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { parse } from 'csv-parse/sync';
import { connectDatabase, migrate, type Database } from '../server/db';
import { initialize } from '../server/seed';
import { createApp } from '../server/app';
import { digest, issueSetup, type Actor } from '../server/security';
import { financeReadableCsv } from '../server/finance-presentation';
import { financeDefaultView, financeGroups, financeMagnitudePercent, financePeriod, financeViewQuery, financeViewSchema, financeVisibleLines, formatFinanceAmount, financeUnits } from '../shared/finance-presentation';
import type { FinanceLine } from '../shared/finance';
const rows: FinanceLine[] = [
  { lineCode:'A',lineLabel:'Tuition',group:'School',rowKind:'detail',amount:'100.1234',note:'Review source' },
  { lineCode:'B',lineLabel:'Adjustment',group:'School',rowKind:'detail',amount:'-20.0001',note:'Credit' },
  { lineCode:'C',lineLabel:'Giving',group:'Parish',rowKind:'detail',amount:'30',note:'' },
  { lineCode:'D',lineLabel:'Other',group:'',rowKind:'detail',amount:'0.0001',note:'' },
  { lineCode:'T',lineLabel:'Source total',group:'School',rowKind:'total',amount:'110.1234',note:'' },
];
const metadata={title:'Synthetic activity report',sourceName:'Synthetic source',currency:'USD',kind:'actual' as const,basis:'period_activity' as const,from:'2026-01-01',to:'2026-01-31',note:''};
test('readable finance amounts default to two decimals and offer exact four-place displays without floating-point rounding',()=>{
  assert.equal(formatFinanceAmount('999999999999999.9999','USD',4),'USD 999,999,999,999,999.9999');
  assert.equal(formatFinanceAmount('123456.7891'),'123,456.79');assert.equal(formatFinanceAmount('-20.0001'),'-20.00');assert.equal(formatFinanceAmount('1'),'1.00');
  assert.equal(formatFinanceAmount('1.0010','',4),'1.0010');assert.equal(formatFinanceAmount('-0.0000'),'0.00');
  assert.equal(formatFinanceAmount('1.0050'),'1.01');assert.equal(formatFinanceAmount('-1.0050'),'-1.01');
  assert.equal(formatFinanceAmount('-0.0001'),'0.00');assert.equal(formatFinanceAmount('999999999999999.9999'),'1,000,000,000,000,000.00');
  assert.equal(formatFinanceAmount(null),'Not present');assert.throws(()=>financeUnits('1e6'));
});
test('view filters preserve real empty groups and source order, sort signed amounts exactly and leave source untouched',()=>{
  const original=JSON.stringify(rows),defaults=financeDefaultView();
  assert.deepEqual(financeVisibleLines(rows,{...defaults,group:''}).map(row=>row.lineCode),['D']);
  assert.deepEqual(financeVisibleLines(rows,{...defaults,group:'School',rowKind:'detail',sort:'amount_asc'}).map(row=>row.lineCode),['B','A']);
  assert.deepEqual(financeVisibleLines(rows,{...defaults,search:'CREDIT'}).map(row=>row.lineCode),['B']);
  assert.deepEqual(financeVisibleLines(rows,{...defaults,sort:'amount_desc'}).map(row=>row.lineCode),['T','A','C','D','B']);
  assert.equal(JSON.stringify(rows),original);assert.equal(new URLSearchParams(financeViewQuery({...defaults,group:''})).get('group'),'');
  assert.equal(new URLSearchParams(financeViewQuery(defaults)).has('group'),false);
  assert.equal(financeViewSchema.safeParse({...defaults,columns:['amount','amount']}).success,false);
  assert.equal(financeViewSchema.safeParse({...defaults,columns:['amount','lineLabel','source_hash']}).success,false);
});
test('group visualizations exclude totals and subtotals and use absolute detail amounts without treating net as profit',()=>{
  const groups=financeGroups(rows),school=groups.find(row=>row.group==='School')!;
  assert.equal(school.count,2);assert.equal(school.net,801233n);assert.equal(school.magnitude,1201235n);
  assert.equal(financeMagnitudePercent(1n,3n),33.33);assert.equal(financeMagnitudePercent(0n,0n),0);
  assert.equal(financePeriod({...metadata,basis:'as_of_balance'}),'As of Jan 31, 2026');
});
test('the maximum permitted 500-line import aggregates without overflowing presentation precision',()=>{
  const maximum=Array.from({length:500},(_,index)=>({...rows[0],lineCode:String(index),amount:'999999999999.9999'}));
  const group=financeGroups(maximum)[0];assert.equal(group.net,4999999999999999500n);
  assert.equal(formatFinanceAmount('499999999999999.9500'),'499,999,999,999,999.95');
  assert.equal(formatFinanceAmount('499999999999999.9500','USD',4),'USD 499,999,999,999,999.9500');
  assert.equal(financeMagnitudePercent(group.magnitude,group.magnitude),100);
});
test('readable CSV has friendly context, selected ordered columns, exact amounts and formula-safe cells without raw identifiers',()=>{
  const options={...financeDefaultView(),decimalPlaces:4 as const,group:'School',rowKind:'detail' as const,sort:'amount_asc' as const,columns:['lineLabel','amount'] as const};
  const csv=financeReadableCsv({metadata:{...metadata,title:'=Unsafe title'},lines:[...rows,{...rows[0],lineCode:'X',lineLabel:'=SUM(A1)',amount:'0.0001'}],version:2,source_hash:'a'.repeat(64)},{...options,columns:[...options.columns]},'School community');
  const cells=parse(csv,{bom:true,relax_column_count:true}) as string[][];
  assert.equal(cells[0][1],"'=Unsafe title");assert.ok(cells.some(line=>line[0]==='Community'&&line[1]==='School community'));
  const header=cells.findIndex(line=>line[0]==='Report line');assert.deepEqual(cells[header],['Report line','Amount (USD)']);
  assert.deepEqual(cells.slice(header+1),[['Adjustment',"'-20.0001"],["'=SUM(A1)",'0.0001'],['Tuition','100.1234']]);
  assert.equal(csv.includes('Source SHA256'),false);assert.equal(csv.includes('a'.repeat(64)),false);assert.ok(csv.includes('Cash / accrual method is not recorded'));
});

let db:Database,app:ReturnType<typeof createApp>,owner:Actor,cookie:string,csrf:string,hash:string,reportId:string;
const origin='http://localhost:3199';
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'finance.presentation.owner@example.test'});
  const row=(await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:row.role,mode:'password',unit_ids:[]};
  app=createApp(db,{origin,production:false,demo:false,staffDomain:'stjw.org'});
  const password='Synthetic-'+randomUUID(),token=await db.transaction(tx=>issueSetup(tx,owner));
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const signed=await request(app).post('/api/auth/login').set('Origin',origin).send({mode:'password',email:owner.email,credential:password});assert.equal(signed.status,200);
  cookie=(signed.headers['set-cookie'] as unknown as string[])[0].split(';')[0];hash=digest(cookie.slice(cookie.indexOf('=')+1));
  const me=await request(app).get('/api/me').set('Cookie',cookie);csrf=me.body.actor.csrf;
  reportId=randomUUID();const unitId=(await db.query('SELECT id FROM units ORDER BY id LIMIT 1')).rows[0].id;
  const csv='lineCode,lineLabel,group,rowKind,amount,note\n'+rows.map(row=>[row.lineCode,row.lineLabel,row.group,row.rowKind,row.amount,row.note].join(',')).join('\n');
  const preview=await request(app).post('/api/finance/previews').set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',csrf).send({unitId,reportId,expectedVersion:0,metadata,csv,reason:'Synthetic source checked'});assert.equal(preview.status,201);
  const published=await request(app).post('/api/finance/previews/'+preview.body.id+'/publish').set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',csrf).send({sourceHash:preview.body.sourceHash,fingerprint:preview.body.fingerprint,reviewed:true});assert.equal(published.status,200);
});
after(async()=>{await db?.close();});
test('normal-auth readable export honors the chosen view, keeps machine CSV stable and audits its options',async()=>{
  const path='/api/finance/reports/'+reportId+'/versions/1';
  const options={...financeDefaultView(),group:'School',rowKind:'detail' as const,columns:['lineLabel','amount'] as ('lineLabel'|'amount')[]};
  const output=await request(app).get(path+'?'+financeViewQuery(options)).set('Cookie',cookie);assert.equal(output.status,200);assert.match(output.headers['content-type'],/text\/csv/);assert.match(output.headers['cache-control'],/no-store/);
  assert.ok(output.text.includes('Tuition'));assert.equal(output.text.includes('Giving'),false);assert.equal(output.text.includes('Source total'),false);assert.equal(output.text.includes(reportId),false);
  const exact=await request(app).get(path+'?format=csv').set('Cookie',cookie);assert.equal(exact.status,200);assert.ok(exact.text.includes('lineCode'));assert.ok(exact.text.includes('source_hash'));assert.ok(exact.text.includes('Giving'));assert.ok(exact.text.includes('100.1234'));
  const audits=(await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='finance.report_read' AND detail->>'format'='readable_csv'",[owner.id])).rows;
  assert.equal(audits.length,1);assert.deepEqual(audits[0].detail.presentation,options);
});
test('custom exports reject unsupported columns and deny anonymous, PIN, bearer, foreign-organization and expired-session reads',async()=>{
  const path='/api/finance/reports/'+reportId+'/versions/1?format=readable_csv';
  assert.equal((await request(app).get(path)).status,401);
  assert.equal((await request(app).get(path+'&columns=lineLabel,amount,password_hash').set('Cookie',cookie)).status,400);
  assert.equal((await request(app).get(path+'&sort=sql').set('Cookie',cookie)).status,400);
  const bearer='synthetic-unissued-token';assert.equal((await request(app).get(path).set('Authorization','Bearer '+bearer)).status,403);
  const original=(await db.query('SELECT mode FROM sessions WHERE token_hash=$1',[hash])).rows[0].mode;
  await db.query("UPDATE sessions SET mode='pin' WHERE token_hash=$1",[hash]);assert.equal((await request(app).get(path).set('Cookie',cookie)).status,403);
  await db.query('UPDATE sessions SET mode=$1 WHERE token_hash=$2',[original,hash]);
  const foreign=randomUUID(),foreignReport=randomUUID();await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic unrelated organization','UTC')",[foreign]);
  const foreignUnit=randomUUID();await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,'Unrelated finance','department')",[foreignUnit,foreign]);
  const foreignOwner=randomUUID();await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Unrelated synthetic owner',$3,'owner')",[foreignOwner,foreign,foreignOwner+'@example.test']);
  await db.query('INSERT INTO financial_reports(id,org_id,unit_id,created_by) VALUES($1,$2,$3,$4)',[foreignReport,foreign,foreignUnit,foreignOwner]);
  assert.equal((await request(app).get('/api/finance/reports/'+foreignReport+'/versions/1?format=readable_csv').set('Cookie',cookie)).status,404);
  await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[hash]);assert.equal((await request(app).get(path).set('Cookie',cookie)).status,401);
});
