import {useEffect,useRef,useState} from 'react';
import {DateTime} from 'luxon';
import {Download,FileSpreadsheet,History,RefreshCw,Save} from 'lucide-react';
import {z} from 'zod';
import {api,ApiError} from './api';
import {Modal} from './components';
import {allowanceSnapshotReceipt,allowanceSnapshotSchema,allowanceSnapshotListSchema,type AllowancePeriod} from '../shared/workforce-overview';
import {compactWorkDuration} from '../shared/workforce-visuals';
import {formatWorkforceDuration} from '../shared/workforce-display';

type Summary=z.infer<typeof allowanceSnapshotListSchema>['snapshots'][number];
type Snapshot=z.infer<typeof allowanceSnapshotSchema>;
const actorKey=(me:any)=>`${me.actor.org_id}:${me.actor.id}:${me.actor.mode}:${me.actor.role}:${me.actor.csrf}:${JSON.stringify(me.actor.unit_ids??[])}`;
const denied=(error:unknown)=>error instanceof ApiError&&[401,403,404].includes(error.status);
const message=(error:unknown)=>error instanceof ApiError?error.message:'The review could not finish. Please try again.';

// Every completion belongs to one mounted actor and selection. Export bytes get
// an additional fresh session check before a browser download is published.
function useReviewOwner(me:any,scope:string,onDenied:()=>void){
  const key=actorKey(me)+':'+scope,owner=useRef(key);owner.current=key;
  const alive=useRef(false),controllers=useRef(new Set<AbortController>()),reject=useRef(onDenied);reject.current=onDenied;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const controller of controllers.current)controller.abort();controllers.current.clear();};},[key]);
  function capture(){const expected=key,identity=actorKey(me),controller=new AbortController();controllers.current.add(controller);
    const owns=()=>alive.current&&!controller.signal.aborted&&owner.current===expected;
    const finish=()=>controllers.current.delete(controller);
    const verify=async()=>{const current=await api('/me',undefined,'GET',controller.signal);if(!owns())return false;if(actorKey(current)!==identity||current.actor.mode!=='password'||!current.permissions?.report)throw new ApiError('Your workforce access changed. Refresh your session.',403);return true;};
    const fail=(error:unknown)=>{if(owns()&&denied(error))reject.current();};
    return {owns,verify,finish,fail,cancel:()=>{controller.abort();finish();},signal:controller.signal};
  }
  return {key,capture};
}
type Operation=ReturnType<ReturnType<typeof useReviewOwner>['capture']>;
async function exportReview(path:string,name:string,operation:Operation){
  const response=await fetch('/api'+path,{credentials:'same-origin',signal:operation.signal});if(!operation.owns())return false;
  if(!response.ok){let detail='The report could not download.';try{const body=await response.json();if(typeof body.error==='string')detail=body.error;}catch{}throw new ApiError(detail,response.status);}
  const bytes=await response.blob();if(!operation.owns()||!await operation.verify()||!operation.owns())return false;
  const url=URL.createObjectURL(bytes);let published=false;
  try{const link=document.createElement('a');link.href=url;link.download=name;if(!operation.owns())return false;link.click();published=true;return true;}
  finally{if(published)setTimeout(()=>URL.revokeObjectURL(url),1000);else URL.revokeObjectURL(url);}
}
function readableDate(value:string){return DateTime.fromISO(value).toFormat('MMM d, yyyy');}

export function AllowanceReviewActions({me,period,label,onSaved,onDenied}:{me:any;period:AllowancePeriod|null;label:string;onSaved:()=>void;onDenied:()=>void}){
  const query=period?new URLSearchParams(period.query as Record<string,string>).toString():'',owner=useReviewOwner(me,query,onDenied);
  const [status,setStatus]=useState<{key:string;busy:string;error:string;success:string}|null>(null),pending=useRef('');
  const command=useRef({key:owner.key,id:crypto.randomUUID()});if(command.current.key!==owner.key)command.current={key:owner.key,id:crypto.randomUUID()};
  const view=status?.key===owner.key?status:null,busy=Boolean(view?.busy);
  async function run(action:'csv'|'xlsx'|'save'){
    if(!period||pending.current===owner.key)return;const operation=owner.capture(),key=owner.key;pending.current=key;setStatus({key,busy:action,error:'',success:''});
    try{
      if(action==='save'){
        if(!await operation.verify())return;
        allowanceSnapshotReceipt.parse(await api('/workforce/allowance/snapshots',{commandId:command.current.id,query:period.query},'POST',operation.signal));
        if(!operation.owns()||!await operation.verify())return;
        command.current={key,id:crypto.randomUUID()};setStatus({key,busy:'',error:'',success:'Review snapshot saved. Open detailed reports to revisit it.'});onSaved();
      }else if(await exportReview('/workforce/allowance/export.'+action+'?'+query,`stjw-scheduled-hours-${period.query.start}-${period.query.end}.${action}`,operation))setStatus({key,busy:'',error:'',success:'Scheduled and worked hours downloaded.'});
    }catch(error){if(operation.owns()){operation.fail(error);setStatus({key,busy:'',error:message(error),success:''});}}
    finally{operation.finish();if(pending.current===key)pending.current='';if(operation.owns())setStatus(value=>value?.key===key?{...value,busy:''}:value);}
  }
  return <div className="wf-allowance-actions" aria-label={label+' scheduled hours reports'}><div className="wf-allowance-buttons"><button type="button" disabled={!period||busy} onClick={()=>void run('xlsx')}><FileSpreadsheet size={17}/>{view?.busy==='xlsx'?'Preparing Excel…':label+' Excel'}</button><button type="button" disabled={!period||busy} onClick={()=>void run('csv')}><Download size={16}/>{view?.busy==='csv'?'Preparing CSV…':'CSV'}</button><button type="button" disabled={!period||busy} onClick={()=>void run('save')}><Save size={16}/>{view?.busy==='save'?'Saving…':'Save review snapshot'}</button></div><p>Downloads and saved reviews capture current worked and scheduled hours. A saved review preserves that moment for later comparison.</p>{view?.error&&<p className="wf-review-error" role="alert">{view.error}</p>}{view?.success&&<p role="status">{view.success}</p>}</div>;
}

export function RetainedAllowanceReviews({me,refresh,onDenied}:{me:any;refresh:number;onDenied:()=>void}){
  const owner=useReviewOwner(me,'retained-reviews',onDenied),[reload,setReload]=useState(0),[data,setData]=useState<{key:string;rows:Summary[]}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [chosen,setChosen]=useState<{key:string;id:string;generation:string}|null>(null),[detail,setDetail]=useState<{key:string;value:Snapshot}|null>(null),[detailError,setDetailError]=useState(''),[busy,setBusy]=useState('');
  const selected=chosen?.key===owner.key?chosen.id:'',selection=selected?chosen!.generation:'',currentSelection=useRef(selection);currentSelection.current=selection;
  useEffect(()=>{const operation=owner.capture();setLoading(true);setError('');void api('/workforce/allowance/snapshots',undefined,'GET',operation.signal).then(async raw=>{const value=allowanceSnapshotListSchema.parse(raw);if(operation.owns()&&await operation.verify())setData({key:owner.key,rows:value.snapshots});}).catch(cause=>{if(operation.owns()){operation.fail(cause);setData(null);setError(message(cause));}}).finally(()=>{if(operation.owns())setLoading(false);operation.finish();});return operation.cancel;},[owner.key,refresh,reload]);
  useEffect(()=>{setDetail(null);setDetailError('');setBusy('');if(!selected)return;const operation=owner.capture(),owns=()=>operation.owns()&&currentSelection.current===selection;void api('/workforce/allowance/snapshots/'+selected,undefined,'GET',operation.signal).then(async raw=>{const value=allowanceSnapshotSchema.parse(raw);if(value.id!==selected)throw new Error('Mismatched saved review.');if(owns()&&await operation.verify()&&owns())setDetail({key:owner.key,value});}).catch(cause=>{if(owns()){operation.fail(cause);setDetailError(message(cause));}}).finally(()=>operation.finish());return operation.cancel;},[owner.key,selected,selection]);
  const rows=data?.key===owner.key?data.rows:[],snapshot=detail?.key===owner.key&&detail.value.id===selected?detail.value:null;
  async function download(format:'csv'|'xlsx'){
    if(!snapshot||busy)return;const operation=owner.capture(),id=snapshot.id,captured=selection;setBusy(format);setDetailError('');
    try{await exportReview('/workforce/allowance/snapshots/'+id+'/export.'+format,`stjw-saved-hours-${snapshot.period.query.start}-${snapshot.period.query.end}.${format}`,{...operation,owns:()=>operation.owns()&&currentSelection.current===captured});}
    catch(cause){if(operation.owns()&&currentSelection.current===captured){operation.fail(cause);setDetailError(message(cause));}}
    finally{if(operation.owns()&&currentSelection.current===captured)setBusy('');operation.finish();}
  }
  return <section className="wf-card wf-retained-reviews" aria-label="Retained hours reviews"><header className="wf-card-header"><div><h2><History size={20}/>Saved hours reviews</h2><p>Latest 100 saved reviews you can access. Snapshots keep their original hours and schedule comparison.</p></div><button type="button" disabled={loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={15}/>Refresh reviews</button></header>{error&&<p className="wf-review-error" role="alert">{error}</p>}{loading&&!rows.length?<p role="status">Loading saved reviews…</p>:!rows.length&&!error?<p>No saved reviews yet. Use “Save review snapshot” above to retain today or this week.</p>:<div className="wf-saved-list">{rows.map(row=><button type="button" key={row.id} onClick={()=>setChosen({key:owner.key,id:row.id,generation:crypto.randomUUID()})}><strong>{readableDate(row.start)} – {readableDate(row.end)}</strong><span>{row.employeeName??'All included employees'} · {row.unitName??'Permitted communities at capture'}</span><small>Saved {DateTime.fromISO(row.createdAt).setZone(me.organization.timezone).toFormat('MMM d, yyyy · h:mm a')} by {row.createdByName}</small></button>)}</div>}
    {selected&&<Modal title="Saved hours review" onClose={()=>{setChosen(null);setDetail(null);}}>{detailError&&<p className="wf-review-error" role="alert">{detailError}</p>}{!snapshot&&!detailError?<p role="status">Loading this saved review…</p>:snapshot&&<div className="workforce-dashboard wf-saved-detail"><p><strong>{snapshot.organizationName}</strong><br/>{readableDate(snapshot.period.query.start)} – {readableDate(snapshot.period.query.end)}<br/>Captured {DateTime.fromISO(snapshot.asOf).setZone(snapshot.timezone).toFormat('MMM d, yyyy · h:mm:ss a')} · {snapshot.timezone}</p><div className="wf-detail-metrics">{[['Worked',snapshot.period.totals.workMicroseconds],['Scheduled',snapshot.period.totals.scheduledMicroseconds],['Over schedule',snapshot.period.totals.aboveScheduledMicroseconds],['Below scheduled totals',snapshot.period.totals.belowScheduledMicroseconds]].map(([label,value])=><article key={label}><span>{label}</span><strong title={formatWorkforceDuration(value)}>{compactWorkDuration(value)}</strong></article>)}</div><div className="wf-saved-people">{snapshot.period.people.map(person=><article key={person.userId}><strong>{person.name}</strong><span>{compactWorkDuration(person.workMicroseconds)} worked · {compactWorkDuration(person.scheduledMicroseconds)} scheduled</span><small>{compactWorkDuration(person.aboveScheduledMicroseconds)} over schedule · {compactWorkDuration(person.belowScheduledMicroseconds)} below scheduled totals</small></article>)}</div><p>{snapshot.period.notice}</p><div className="wf-allowance-buttons"><button type="button" disabled={Boolean(busy)} onClick={()=>void download('xlsx')}><FileSpreadsheet size={17}/>{busy==='xlsx'?'Preparing…':'Saved review Excel'}</button><button type="button" disabled={Boolean(busy)} onClick={()=>void download('csv')}><Download size={16}/>{busy==='csv'?'Preparing…':'Saved review CSV'}</button></div></div>}</Modal>}
  </section>;
}
