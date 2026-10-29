import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {DateTime} from 'luxon';
import {connectDatabase,migrate,type Database} from '../server/db';
import {initialize} from '../server/seed';
import {createApp} from '../server/app';
import {issueSetup,digest,type Actor} from '../server/security';
import {createStaff} from '../server/workforce';
import {applyAuthenticatedClockCommand} from '../server/clock-session';
import {getEmployeeClockPolicy,saveEmployeeClockPolicy,processPreclockIntent,processRuleClockOuts} from '../server/scheduled-clock';
import {clockRulesSchema,clockOutCutoff,describeToday,evaluateClockIn,evaluateClockOut,normalizeClockRules,openRules,type ClockRules} from '../shared/clock-rules';

const tz='America/New_York',origin='http://localhost:3000';
let db:Database,app:ReturnType<typeof createApp>,owner:Actor,ownerProof:string,job:any;
type Proof={actor:Actor;hash:string};
const workday=(patch:Partial<ClockRules['days'][number]>={})=>({allowed:true,clockInEarliest:'07:00',clockInLatest:'10:00',clockOutEarliest:'12:00',clockOutLatest:'15:00',...patch});
const week=(patch:Partial<ClockRules['days'][number]>={}):ClockRules=>({days:Array.from({length:7},()=>workday(patch))});
/** Today's organization-local calendar day at the given time, as a UTC instant the clock accepts. */
const today=DateTime.now().setZone(tz).setLocale('en-US').startOf('day');
const local=(hour:number,minute=0)=>today.set({hour,minute}).toUTC().toISO()!;
function at(instant:string):Database{
  return {...db,transaction:work=>db.transaction(tx=>work({query:async<T extends Record<string,any>>(sql:string,params:any[]=[])=>{
    if(sql.startsWith('SELECT to_char(clock_timestamp()')&&sql.endsWith(' AS instant'))return {rows:[{instant} as unknown as T]};
    return tx.query<T>(sql,params);
  }}))};
}
before(async()=>{
  db=await connectDatabase();await migrate(db);await initialize(db,{demo:false,ownerEmail:'rules.owner@example.test'});
  const row=(await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];job=(await db.query('SELECT * FROM jobs ORDER BY id LIMIT 1')).rows[0];
  owner={id:row.id,org_id:row.org_id,name:row.name,email:row.email,role:'owner',unit_ids:[job.unit_id],mode:'password'};
  app=createApp(db,{origin,production:false,staffDomain:'stjw.org',demo:false});
  ownerProof=(await authenticate(owner)).hash;
});
after(async()=>{await db?.close();});
async function authenticate(actor:Actor):Promise<Proof>{
  await db.query('DELETE FROM auth_limits');
  const token=await db.transaction(tx=>issueSetup(tx,actor)),password='Synthetic-'+randomUUID();
  assert.equal((await request(app).post('/api/auth/setup').set('Origin',origin).send({token,password})).status,200);
  const login=await request(app).post('/api/auth/login').set('Origin',origin).send({email:actor.email,credential:password,mode:'password'});assert.equal(login.status,200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return {actor,hash:digest(cookie.slice(cookie.indexOf('=')+1))};
}
async function person():Promise<Proof>{
  const email=randomUUID()+'@stjw.org',id=await db.transaction(tx=>createStaff(tx,owner,{name:'Synthetic clock rules user',email,role:'employee',unitIds:[job.unit_id],jobIds:[job.id]},'stjw.org'));
  return authenticate({id,org_id:owner.org_id,name:'Synthetic clock rules user',email,role:'employee',unit_ids:[job.unit_id],mode:'password'});
}
const saveRules=async(p:Proof,rules:ClockRules|null|undefined,expectedVersion:number,noEarlyClockIn=false)=>saveEmployeeClockPolicy(db,owner,ownerProof,p.actor.id,{noEarlyClockIn,...(rules===undefined?{}:{rules}),expectedVersion});
const clockIn=()=>({action:'clock_in' as const,jobId:job.id,commandId:randomUUID()});
const shiftCount=async(id:string)=>Number((await db.query('SELECT count(*) AS count FROM shifts WHERE user_id=$1',[id])).rows[0].count);
async function seedOpenShift(userId:string,startedAt:string){
  const id=randomUUID();
  await db.query('INSERT INTO shifts(id,org_id,user_id,started_at) VALUES($1,$2,$3,$4)',[id,owner.org_id,userId,startedAt]);
  await db.query("INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at) VALUES($1,$2,$3,$4,'work',$5)",[randomUUID(),owner.org_id,id,job.id,startedAt]);
  return id;
}

test('rule validation rejects impossible windows and an all-open rule set is stored as no rules',()=>{
  assert.equal(clockRulesSchema.safeParse(week()).success,true);
  assert.equal(clockRulesSchema.safeParse({days:week().days.slice(0,6)}).success,false);
  for(const bad of [{clockInEarliest:'11:00',clockInLatest:'10:00'},{clockOutEarliest:'16:00',clockOutLatest:'15:00'},{clockInEarliest:'15:00'},{clockInLatest:'15:00'},{clockInEarliest:'7am'},{clockInEarliest:'24:00'}])
    assert.equal(clockRulesSchema.safeParse(week(bad)).success,false,JSON.stringify(bad));
  assert.equal(clockRulesSchema.safeParse({...week(),extra:true}).success,false);
  assert.equal(normalizeClockRules(openRules()),null);
  const limited=openRules();limited.days[5].allowed=false;assert.deepEqual(normalizeClockRules(limited),limited);
});

test('clock-in decisions: weekday lock, early wait, latest window and end of work day use organization-local time',()=>{
  const rules=week();
  // Monday 2026-10-26 is in daylight time (UTC-4).
  const early=evaluateClockIn(rules,tz,'2026-10-26T10:30:00.000Z');
  assert.deepEqual(early,{kind:'wait',startsAt:'2026-10-26T11:00:00.000Z',endsAt:'2026-10-26T19:00:00.000Z',message:early.kind==='wait'?early.message:''});
  assert.match((early as any).message,/before 7:00 AM.*automatically/);
  assert.deepEqual(evaluateClockIn(rules,tz,'2026-10-26T12:00:00.000Z'),{kind:'allow'});
  assert.equal(evaluateClockIn(rules,tz,'2026-10-26T11:00:00.000Z').kind,'allow','exactly at the earliest time is allowed');
  assert.match((evaluateClockIn(rules,tz,'2026-10-26T14:15:00.000Z') as any).message,/closed at 10:00 AM/);
  assert.match((evaluateClockIn(week({clockInLatest:null}),tz,'2026-10-26T19:30:00.000Z') as any).message,/work day ended at 3:00 PM/);
  const mondayOff=week();mondayOff.days[0].allowed=false;
  assert.match((evaluateClockIn(mondayOff,tz,'2026-10-26T12:00:00.000Z') as any).message,/not allowed on Mondays/);
  assert.equal(evaluateClockIn(mondayOff,tz,'2026-10-27T12:00:00.000Z').kind,'allow','other weekdays are unaffected');
  assert.equal(evaluateClockIn(null,tz,'2026-10-26T03:00:00.000Z').kind,'allow');
  const noEnd=evaluateClockIn(week({clockOutLatest:null,clockInLatest:null}),tz,'2026-10-26T10:30:00.000Z');
  assert.equal(noEnd.kind==='wait'&&noEnd.endsAt,'2026-10-27T04:00:00.000Z','without a latest clock-out the pending window ends at local midnight');
});

test('clock-out decisions: earliest time blocks, latest time caps at the exact cutoff, even after midnight',()=>{
  const rules=week(),shift='2026-10-26T12:00:00.000Z';
  assert.deepEqual(evaluateClockOut(rules,tz,shift,'2026-10-26T17:00:00.000Z'),{kind:'allow'});
  assert.match((evaluateClockOut(rules,tz,shift,'2026-10-26T15:00:00.000Z') as any).message,/before 12:00 PM/);
  assert.deepEqual(evaluateClockOut(rules,tz,shift,'2026-10-26T19:10:00.000Z'),{kind:'cap',at:'2026-10-26T19:00:00.000Z'});
  assert.deepEqual(evaluateClockOut(rules,tz,shift,'2026-10-27T13:00:00.000Z'),{kind:'cap',at:'2026-10-26T19:00:00.000Z'},'a forgotten shift is capped at the cutoff of the day it began');
  assert.equal(clockOutCutoff(week({clockOutLatest:null}),tz,shift),null);
  assert.equal(clockOutCutoff(rules,tz,'2026-10-26T20:00:00.000Z'),null,'a shift that began after the cutoff has none to apply');
  assert.deepEqual(evaluateClockOut(null,tz,shift,'2026-10-27T13:00:00.000Z'),{kind:'allow'});
  assert.match(describeToday(rules,tz,'2026-10-26T12:00:00.000Z')!,/clock in from 7:00 AM.*clock out by 3:00 PM/);
  assert.equal(describeToday(null,tz,'2026-10-26T12:00:00.000Z'),null);
});

test('rules save with the employee policy revision, survive a policy-only save, clear explicitly and stay out of the way when open',async()=>{
  const p=await person(),rules=week();
  assert.deepEqual(await getEmployeeClockPolicy(db,owner,ownerProof,p.actor.id),{noEarlyClockIn:false,rules:null,version:0});
  const saved=await saveRules(p,rules,0);assert.deepEqual(saved,{noEarlyClockIn:false,rules,version:1});
  assert.deepEqual(await getEmployeeClockPolicy(db,owner,ownerProof,p.actor.id),saved);
  const kept=await saveRules(p,undefined,1,true);assert.deepEqual(kept,{noEarlyClockIn:true,rules,version:2},'older clients that omit rules leave them alone');
  assert.deepEqual(await saveRules(p,rules,2,true),kept,'an identical save does not advance the revision');
  await assert.rejects(()=>saveRules(p,rules,1,true),/changed/);
  await assert.rejects(()=>saveRules(p,week({clockInEarliest:'12:00',clockInLatest:'11:00'}),2,true));
  const cleared=await saveRules(p,openRules(),2,true);assert.deepEqual(cleared,{noEarlyClockIn:true,rules:null,version:3},'an all-open rule set is the same as none');
  const audit=(await db.query("SELECT detail FROM audit_events WHERE action='staff.clock_policy_changed' AND target_id=$1 ORDER BY created_at",[p.actor.id])).rows;
  assert.equal(audit.length,3);assert.deepEqual(audit[0].detail.after.rules,rules);
});

test('an early tap saves a pending start that begins automatically at the earliest time, exactly once and without the app open',async()=>{
  const p=await person();await saveRules(p,week(),0);
  const command=clockIn(),state=await applyAuthenticatedClockCommand(at(local(6,30)),p.actor,p.hash,command);
  assert.equal(state.shift,null);assert.equal(await shiftCount(p.actor.id),0);
  const pending=state.preclock.pending;
  assert.equal(pending.source,'rule');assert.equal(pending.scheduleId,null);assert.equal(pending.startsAt.slice(0,19),local(7,0).slice(0,19));assert.equal(pending.endsAt.slice(0,19),local(15,0).slice(0,19));
  assert.match(state.preclock.todayRules,/clock in from 7:00 AM/);
  assert.deepEqual(await applyAuthenticatedClockCommand(at(local(6,30)),p.actor,p.hash,command),state,'the same command replays its receipt');
  const again=await applyAuthenticatedClockCommand(at(local(6,45)),p.actor,p.hash,clockIn());assert.equal(again.preclock.pending.id,pending.id,'a second tap does not queue a second start');
  assert.equal(await processPreclockIntent(at(local(6,50)),pending.id),'pending','nothing starts before the allowed time');assert.equal(await shiftCount(p.actor.id),0);
  assert.equal(await processPreclockIntent(at(local(7,0)),pending.id),'executed');
  assert.equal(await processPreclockIntent(at(local(7,1)),pending.id),'executed','processing is idempotent');
  assert.equal(await shiftCount(p.actor.id),1);
  const shift=(await db.query("SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS started,ended_at FROM shifts WHERE user_id=$1",[p.actor.id])).rows[0];
  assert.equal(shift.started,local(7,0).slice(0,19),'time starts at the allowed time, not when the worker ran');assert.equal(shift.ended_at,null);
  assert.equal((await db.query("SELECT count(*) AS n FROM audit_events WHERE action='clock.preclock_queued' AND target_id=$1",[pending.id])).rows[0].n,1);
});

test('changing the rules cancels a pending rule start, and a start whose rules were removed is blocked rather than executed',async()=>{
  const p=await person();await saveRules(p,week(),0);
  const first=(await applyAuthenticatedClockCommand(at(local(6,30)),p.actor,p.hash,clockIn())).preclock.pending;
  await saveRules(p,week({clockInEarliest:'07:30'}),1);
  const cancelled=(await db.query('SELECT status,reason FROM clock_intents WHERE id=$1',[first.id])).rows[0];
  assert.equal(cancelled.status,'cancelled');assert.match(cancelled.reason,/manager changed/);
  assert.equal(await shiftCount(p.actor.id),0);
  // Simulate the narrow race where the policy row moves after the intent was queued but before a worker sees it.
  const second=(await applyAuthenticatedClockCommand(at(local(6,30)),p.actor,p.hash,clockIn())).preclock.pending;
  await db.query('UPDATE clock_employee_policies SET rules=NULL,version=version+1 WHERE user_id=$1',[p.actor.id]);
  assert.equal(await processPreclockIntent(at(local(7,35)),second.id),'blocked');
  assert.match((await db.query('SELECT reason FROM clock_intents WHERE id=$1',[second.id])).rows[0].reason,/clock rules changed/);
  assert.equal(await shiftCount(p.actor.id),0);
});

test('clock-in is refused outside the allowed day or window and allowed inside it',async()=>{
  const p=await person();await saveRules(p,week(),0);
  await assert.rejects(()=>applyAuthenticatedClockCommand(at(local(10,30)),p.actor,p.hash,clockIn()),/window closed at 10:00 AM/);
  await assert.rejects(()=>applyAuthenticatedClockCommand(at(local(16,0)),p.actor,p.hash,clockIn()),/work day ended|window closed/);
  assert.equal(await shiftCount(p.actor.id),0);
  const allowed=await applyAuthenticatedClockCommand(at(local(8,0)),p.actor,p.hash,clockIn());assert.ok(allowed.shift,'inside the window the clock works as before');
  // A weekday lock names the day and blocks only that day.
  const q=await person(),locked=week();locked.days[today.weekday-1].allowed=false;await saveRules(q,locked,0);
  await assert.rejects(()=>applyAuthenticatedClockCommand(at(local(8,0)),q.actor,q.hash,clockIn()),new RegExp('not allowed on '+today.weekdayLong+'s'));
  assert.equal(await shiftCount(q.actor.id),0);
  // An employee without rules is unchanged.
  const free=await person();assert.ok((await applyAuthenticatedClockCommand(at(local(23,0)),free.actor,free.hash,clockIn())).shift);
});

test('clock-out before the earliest time is refused; a break or job change after the work day ends is refused',async()=>{
  const p=await person();await saveRules(p,week(),0);
  const shift=await seedOpenShift(p.actor.id,local(8,0));
  const out=()=>({action:'clock_out' as const,commandId:randomUUID()});
  await assert.rejects(()=>applyAuthenticatedClockCommand(at(local(11,0)),p.actor,p.hash,out()),/can't clock out before 12:00 PM/);
  await assert.rejects(()=>applyAuthenticatedClockCommand(at(local(15,30)),p.actor,p.hash,{action:'start_break',commandId:randomUUID()}),/work day has ended/);
  assert.equal((await db.query('SELECT ended_at FROM shifts WHERE id=$1',[shift])).rows[0].ended_at,null,'refused actions change nothing');
});

test('a clock-out requested after the latest time is recorded at the latest time, never later',async()=>{
  const p=await person();await saveRules(p,week(),0);
  const shift=await seedOpenShift(p.actor.id,local(8,0)),command={action:'clock_out' as const,commandId:randomUUID()};
  const state=await applyAuthenticatedClockCommand(at(local(16,40)),p.actor,p.hash,command);
  assert.equal(state.shift,null);
  const row=(await db.query("SELECT to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ended FROM shifts WHERE id=$1",[shift])).rows[0];
  assert.equal(row.ended,local(15,0).slice(0,19));
  assert.deepEqual(await applyAuthenticatedClockCommand(at(local(16,41)),p.actor,p.hash,command),state,'the same command replays its receipt');
  const audited=(await db.query("SELECT detail FROM audit_events WHERE action='clock.clock_out' AND target_id=$1",[shift])).rows;
  assert.equal(audited.length,1);assert.equal(audited[0].detail.scheduled.rule,'latest_clock_out');
});

test('the background sweep closes a forgotten shift at the latest time of the day it began and leaves compliant shifts alone',async()=>{
  const yesterday=today.minus({days:1}),at8=yesterday.set({hour:8}).toUTC().toISO()!,cutoff=yesterday.set({hour:15}).toUTC().toISO()!;
  const forgotten=await person(),noLimit=await person(),openLater=await person();
  await saveRules(forgotten,week(),0);await saveRules(openLater,week({clockOutLatest:null,clockInLatest:null}),0);
  const closedShift=await seedOpenShift(forgotten.actor.id,at8),freeShift=await seedOpenShift(noLimit.actor.id,at8),laterShift=await seedOpenShift(openLater.actor.id,at8);
  const counts=await processRuleClockOuts(db);assert.ok(counts.closed>=1);assert.equal(counts.failed,0);
  const ended=async(id:string)=>(await db.query("SELECT to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ended FROM shifts WHERE id=$1",[id])).rows[0].ended;
  assert.equal(await ended(closedShift),cutoff.slice(0,19),'recorded at the cutoff, not at processing time');
  assert.equal(await ended(freeShift),null,'employees without rules are never closed automatically');
  assert.equal(await ended(laterShift),null,'rules without a latest clock-out never close a shift');
  const segment=(await db.query("SELECT to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ended FROM segments WHERE shift_id=$1",[closedShift])).rows[0];
  assert.equal(segment.ended,cutoff.slice(0,19));
  assert.equal((await db.query("SELECT count(*) AS n FROM audit_events WHERE action='clock.rule_auto_clock_out' AND target_id=$1",[closedShift])).rows[0].n,1);
  const again=await processRuleClockOuts(db);assert.equal(again.closed,0,'a second sweep finds nothing left to close');
});

test('a forgotten shift can still be clocked out by the employee the next day, capped at the latest time',async()=>{
  const p=await person();await saveRules(p,week({clockOutEarliest:'12:00'}),0);
  const yesterday=today.minus({days:1}),shift=await seedOpenShift(p.actor.id,yesterday.set({hour:8}).toUTC().toISO()!);
  const state=await applyAuthenticatedClockCommand(at(local(9,0)),p.actor,p.hash,{action:'clock_out',commandId:randomUUID()});
  assert.equal(state.shift,null);
  assert.equal((await db.query("SELECT to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ended FROM shifts WHERE id=$1",[shift])).rows[0].ended,yesterday.set({hour:15}).toUTC().toISO()!.slice(0,19));
});
