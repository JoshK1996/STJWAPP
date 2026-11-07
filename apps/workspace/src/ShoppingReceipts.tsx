import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, ReceiptText, Archive, Download, Trash2, ArrowLeft, RefreshCw, ShoppingBag } from 'lucide-react';
import { api, ApiError, download } from './api';
import { Modal } from './components';
import { receiptAmountLabel, type ShoppingReceipt, type ShoppingReceiptList } from '../shared/shopping-receipts';
import './shopping-receipts.css';

export type ReceiptTarget={nonce:number;view:'mine'|'team';capture?:boolean;userId?:string;unitId?:string;shiftId?:string;start?:string;end?:string};
type Open=(target:Omit<ReceiptTarget,'nonce'>)=>void;
type Draft={jobId:string;purchasedOn:string;vendor:string;total:string;note:string;imageBase64:string;preview:string;shiftId?:string};
type Attempt={path:string;body:Record<string,unknown>;label:string};
const message=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'The receipt could not be saved. Try again.';
const blank=(data:ShoppingReceiptList,shiftId?:string):Draft=>({jobId:data.eligibleJobs[0]?.id??'',purchasedOn:data.today,vendor:'',total:'',note:'',imageBase64:'',preview:'',...(shiftId?{shiftId}:{})});

/** Camera files stay in memory and are resized before leaving the device. */
async function cameraPhoto(file:File){
  if(file.size>20*1024*1024)throw new Error('Choose a photo smaller than 20 MB.');
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;await img.decode();
    if(img.naturalWidth*img.naturalHeight>50_000_000)throw new Error('Choose a smaller photo or take another picture.');
    const scale=Math.min(1,2400/img.naturalWidth,4000/img.naturalHeight),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('This browser could not prepare the photo.');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
    let encoded=canvas.toDataURL('image/jpeg',.9);if(encoded.length>5_500_000)encoded=canvas.toDataURL('image/jpeg',.75);
    if(encoded.length>8_000_000)throw new Error('Choose a smaller photo or take another picture.');
    return {imageBase64:encoded.slice(encoded.indexOf(',')+1),preview:encoded};
  }catch(e){if(e instanceof Error&&!(e instanceof DOMException))throw e;throw new Error('This photo could not be opened. Try a JPG, PNG or WebP photo, or take a new photo.');}
  finally{URL.revokeObjectURL(url);}
}

function PrivatePhoto({receipt,onDenied}:{receipt:ShoppingReceipt;onDenied:()=>void}){
  const [src,setSrc]=useState(''),[error,setError]=useState('');const denied=useRef(onDenied);denied.current=onDenied;
  useEffect(()=>{
    const controller=new AbortController();let url='';setSrc('');setError('');
    void fetch(`/api/shopping-receipts/${receipt.id}/photo`,{credentials:'same-origin',signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok){if([401,403,404].includes(response.status))denied.current();throw new Error(response.status===410?'This photo was deleted.':'This photo is unavailable under your current access.');}
      const blob=await response.blob();if(controller.signal.aborted)return;url=URL.createObjectURL(blob);setSrc(url);
    }).catch(e=>{if(!controller.signal.aborted)setError(message(e));});
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[receipt.id,receipt.version]);
  return <div className="receipt-photo">{src?<img src={src} alt={`Receipt from ${receipt.vendor||receipt.employeeName}, purchased ${receipt.purchasedOn}`}/>:<p role="status">{error||'Loading private receipt photo…'}</p>}</div>;
}

export function ShoppingReceiptEntry({revision,onOpen}:{revision:string;onOpen:Open}){
  const [available,setAvailable]=useState<{capture:boolean;history:boolean}|null>(null);
  useEffect(()=>{const controller=new AbortController();
    void api<ShoppingReceiptList>('/shopping-receipts?status=all',undefined,'GET',controller.signal).then(data=>{if(!controller.signal.aborted)setAvailable({capture:data.eligibleJobs.length>0,history:data.hasOwnReceipts});}).catch(()=>{if(!controller.signal.aborted)setAvailable(null);});
    return()=>controller.abort();
  },[revision]);
  if(!available||(!available.capture&&!available.history))return null;
  return <section className="receipt-entry" aria-label="Shopping receipts"><span className="receipt-entry-icon"><ShoppingBag size={24}/></span><div><h2>Shopping receipts</h2><p>Save a clear photo after a café purchase. You can add it on or off the clock.</p><div className="receipt-actions">{available.capture&&<button type="button" className="button primary" onClick={()=>onOpen({view:'mine',capture:true})}><Camera size={17}/>Add receipt photo</button>}<button type="button" className="button secondary" onClick={()=>onOpen({view:'mine'})}>My receipts</button></div></div></section>;
}

/** Kept at workspace root so a slow/uncertain upload can be resumed after clocking. */
export function ReceiptHub({target,staff,onPendingChange,onChanged,notify}:{target:ReceiptTarget|null;staff:any[];onPendingChange:(value:boolean)=>void;onChanged:()=>void;notify:(text:string,error?:boolean)=>void}){
  const [open,setOpen]=useState(false),[scope,setScope]=useState<ReceiptTarget|null>(null),[data,setData]=useState<ShoppingReceiptList|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null),[detail,setDetail]=useState<{receipt:ShoppingReceipt;events:any[]}|null>(null);
  const [status,setStatus]=useState('active'),[start,setStart]=useState(''),[end,setEnd]=useState(''),[user,setUser]=useState(''),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[preparing,setPreparing]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState<Attempt|null>(null);
  const [decision,setDecision]=useState<'archived'|'active'|'deleted'|null>(null),[decisionNote,setDecisionNote]=useState('');
  const alive=useRef(true),busyRef=useRef(false),attemptRef=useRef<Attempt|null>(null),draftRef=useRef<Draft|null>(null),photoGeneration=useRef(0),readGeneration=useRef(0),captureRequested=useRef(false);
  draftRef.current=draft;attemptRef.current=attempt;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;photoGeneration.current++;readGeneration.current++;};},[]);
  useEffect(()=>{onPendingChange(Boolean(draft||attempt||busy||preparing));},[draft,attempt,busy,preparing,onPendingChange]);
  useEffect(()=>{
    if(!target)return;
    if(attemptRef.current||busyRef.current||draftRef.current){setOpen(true);return;}
    readGeneration.current++;setScope(target);setOpen(true);setDetail(null);setDecision(null);setError('');setData(null);setStart(target.start??'');setEnd(target.end??'');setUser(target.userId??'');setOffset(0);setStatus('active');captureRequested.current=Boolean(target.capture);
  },[target]);
  const query=new URLSearchParams({view:scope?.view??'mine',status,offset:String(offset),...(start?{start}:{}),...(end?{end}:{}),...(user?{userId:user}:{}),...(scope?.unitId?{unitId:scope.unitId}:{}),...(scope?.shiftId?{shiftId:scope.shiftId}:{})}).toString();
  useEffect(()=>{
    if(!scope||!open||draft||detail)return;const controller=new AbortController(),generation=++readGeneration.current;setLoading(true);setData(null);setError('');
    void api<ShoppingReceiptList>('/shopping-receipts?'+query,undefined,'GET',controller.signal).then(result=>{
      if(!alive.current||controller.signal.aborted||generation!==readGeneration.current)return;setData(result);
      if(captureRequested.current){captureRequested.current=false;if(result.eligibleJobs.length)setDraft(blank(result,scope.shiftId));else setError('A current café and Shopping assignment is required to add a receipt.');}
    }).catch(e=>{if(!controller.signal.aborted&&alive.current&&generation===readGeneration.current)setError(message(e));}).finally(()=>{if(!controller.signal.aborted&&alive.current&&generation===readGeneration.current)setLoading(false);});
    return()=>controller.abort();
  },[scope,query,refresh,open,Boolean(draft),Boolean(detail)]);
  function close(){
    if(attempt||busy){setOpen(false);return;}
    if((draft||preparing)&&!window.confirm('Discard this unsaved receipt photo and its details?'))return;
    photoGeneration.current++;setPreparing(false);setDraft(null);setOpen(false);setDetail(null);setDecision(null);setError('');
  }
  async function pick(file?:File){
    if(!file||busyRef.current||attemptRef.current)return;const generation=++photoGeneration.current;setPreparing(true);setError('');
    try{const photo=await cameraPhoto(file);if(alive.current&&generation===photoGeneration.current)setDraft(value=>value?{...value,...photo}:value);}
    catch(e){if(alive.current&&generation===photoGeneration.current)setError(message(e));}
    finally{if(alive.current&&generation===photoGeneration.current)setPreparing(false);}
  }
  async function send(value:Attempt){
    if(busyRef.current)return;busyRef.current=true;attemptRef.current=value;setAttempt(value);setBusy(true);setError('');
    try{
      await api(value.path,value.body);if(!alive.current)return;
      attemptRef.current=null;setAttempt(null);setDraft(null);setDetail(null);setDecision(null);setDecisionNote('');setRefresh(n=>n+1);onChanged();notify(value.label);
    }catch(e){
      if(!alive.current)return;setError(message(e));
      if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){
        attemptRef.current=null;setAttempt(null);
        if([401,403,404].includes(e.status)){setDraft(null);setDetail(null);setData(null);setDecision(null);}
        if(e.status===409&&value.path.endsWith('/state')){setDetail(null);setDecision(null);setRefresh(n=>n+1);}
      }
    }finally{busyRef.current=false;if(alive.current)setBusy(false);}
  }
  function save(event:FormEvent){event.preventDefault();if(!draft||preparing||busyRef.current)return;if(attempt)return void send(attempt);
    const {preview:_,...body}=draft;if(!body.imageBase64){setError('Take or choose a clear photo of the receipt first.');return;}
    void send({path:'/shopping-receipts',body:{...body,commandId:crypto.randomUUID()},label:'Receipt photo saved.'});
  }
  async function inspect(row:ShoppingReceipt){
    const generation=++readGeneration.current;setError('');setLoading(true);
    try{const result=await api<{receipt:ShoppingReceipt;events:any[]}>(`/shopping-receipts/${row.id}`);if(alive.current&&generation===readGeneration.current){setDetail(result);setDecision(null);setDecisionNote('');}}
    catch(e){if(alive.current&&generation===readGeneration.current){setError(message(e));if(e instanceof ApiError&&[401,403,404].includes(e.status))setData(null);}}
    finally{if(alive.current&&generation===readGeneration.current)setLoading(false);}
  }
  const locked=busy||Boolean(attempt),receipt=detail?.receipt;
  return <>{!open&&(attempt||draft||preparing)&&<aside className="receipt-resume" role="status"><ReceiptText size={20}/><span>{busy?'Saving receipt photo…':attempt?'Receipt save needs checking':'Unsaved receipt photo'}</span><button className="button secondary small" onClick={()=>setOpen(true)}>Resume receipt</button></aside>}
    {open&&<Modal title={draft?'Add receipt photo':receipt?'Receipt details':scope?.view==='team'?'Shopping receipts':'My shopping receipts'} onClose={close}>
      <div className="receipt-hub">
      {error&&<div className="receipt-error" role="alert">{error}</div>}
      {attempt&&!busy&&<div className="receipt-notice" role="status"><p>The result is unconfirmed. Retry the same action to check it without recording it twice. You can minimize this window and use the clock.</p>{!draft&&!decision&&<button className="button primary" onClick={()=>void send(attempt)}>Retry same save</button>}</div>}
      {busy&&<p role="status">Saving… You can minimize this window and keep using the clock.</p>}
      {draft?<form onSubmit={save} className="receipt-form">
        <p className="receipt-intro">Photograph the whole receipt, including the store, date and total. Check that the text is readable.</p>
        <label className="receipt-photo-picker"><Camera size={25}/><strong>{draft.preview?'Replace receipt photo':'Take or choose a receipt photo'}</strong><span>Choose a saved photo, or use your phone’s camera</span><input aria-label="Receipt photo" type="file" accept="image/*" disabled={locked||preparing} onChange={event=>{void pick(event.target.files?.[0]);event.target.value='';}}/></label>
        {preparing&&<p role="status">Preparing your photo…</p>}{draft.preview&&<img className="receipt-draft-photo" src={draft.preview} alt="Receipt photo to upload"/>}
        <div className="receipt-fields"><label>Purchase date<input type="date" required value={draft.purchasedOn} max={data?.today} disabled={locked} onChange={e=>setDraft({...draft,purchasedOn:e.target.value})}/></label>{(data?.eligibleJobs.length??0)>1?<label>Shopping job<select aria-label="Shopping job" value={draft.jobId} disabled={locked} onChange={e=>setDraft({...draft,jobId:e.target.value})}>{data?.eligibleJobs.map(job=><option key={job.id} value={job.id}>{job.title} · {job.unitName}</option>)}</select></label>:<p className="receipt-job"><ShoppingBag size={17}/>{data?.eligibleJobs.find(job=>job.id===draft.jobId)?.unitName??'Café'} · Shopping</p>}</div>
        <details><summary>Add store, total or a note (optional)</summary><div className="receipt-fields"><label>Store<input maxLength={200} value={draft.vendor} disabled={locked} onChange={e=>setDraft({...draft,vendor:e.target.value})}/></label><label>Receipt total ($)<input inputMode="decimal" pattern="[0-9]{1,9}([.][0-9]{1,2})?" placeholder="0.00" value={draft.total} disabled={locked} onChange={e=>setDraft({...draft,total:e.target.value})}/></label></div><label>Purchase note<textarea rows={3} maxLength={2000} value={draft.note} disabled={locked} onChange={e=>setDraft({...draft,note:e.target.value})}/></label></details>
        {draft.shiftId&&<p className="panel-note">Linked to the selected time card. Adding a receipt does not change your recorded time.</p>}
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>{attempt||busy?'Minimize':'Cancel'}</button><button className="button primary" disabled={busy||preparing||!draft.imageBase64}>{busy?'Saving…':attempt?'Retry same save':'Save receipt photo'}</button></div>
      </form>:receipt?<>
        <button className="text-link" disabled={locked} onClick={()=>{setDetail(null);setDecision(null);setError('');}}><ArrowLeft size={16}/>Back to receipts</button>
        <div className="receipt-detail-heading"><div><h3>{receipt.vendor||'Shopping receipt'}</h3><p>{receipt.employeeName} · {receipt.purchasedOn}</p><p>{receipt.unitName} · {receipt.jobTitle}</p></div><strong>{receiptAmountLabel(receipt.amountMinor)}</strong><span className="badge">{receipt.status}</span></div>
        {receipt.status!=='deleted'&&<><PrivatePhoto receipt={receipt} onDenied={()=>{setDetail(null);setData(null);setError('This receipt is unavailable under your current access.');}}/>{receipt.note&&<p className="receipt-note">{receipt.note}</p>}<div className="receipt-actions"><button className="button secondary" onClick={()=>{const id=receipt.id,generation=readGeneration.current;void download(`/shopping-receipts/${id}/photo?download=1`,`shopping-receipt-${receipt.purchasedOn}-${id}.jpg`,()=>alive.current&&readGeneration.current===generation).catch(e=>{if(alive.current)setError(message(e));});}}><Download size={17}/>Download photo</button>{receipt.canManage&&<><button className="button secondary" disabled={locked} onClick={()=>setDecision(receipt.status==='archived'?'active':'archived')}><Archive size={17}/>{receipt.status==='archived'?'Restore receipt':'Archive receipt'}</button><button className="button secondary danger" disabled={locked} onClick={()=>setDecision('deleted')}><Trash2 size={17}/>Delete photo</button></>}</div></>}
        {receipt.status==='deleted'&&<p className="receipt-notice">The photo and purchase details were permanently deleted. The dated record and action history remain.</p>}
        {receipt.shiftId&&<p className="panel-note">Linked to a time card · captured revision {receipt.shiftRevision}. Receipt actions do not change time or payroll.</p>}
        {decision&&<form className="receipt-decision" onSubmit={e=>{e.preventDefault();if(!busyRef.current)void send(attempt??{path:`/shopping-receipts/${receipt.id}/state`,body:{commandId:crypto.randomUUID(),expectedVersion:receipt.version,status:decision,note:decisionNote},label:decision==='deleted'?'Receipt photo deleted.':decision==='active'?'Receipt restored.':'Receipt archived.'});}}><h4>{decision==='deleted'?'Permanently delete this photo?':decision==='active'?'Restore this receipt?':'Archive this receipt?'}</h4><p>{decision==='deleted'?'This removes the stored photo, store, total and purchase note. Download the photo first if you need a copy. The action history remains.':decision==='archived'?'Keep the photo and its history, and move it out of the active list. Archiving does not free photo storage.':'Return the receipt to the active list.'}</p><label>Review note (optional)<textarea maxLength={1000} rows={2} disabled={locked} value={decisionNote} onChange={e=>setDecisionNote(e.target.value)}/></label><div className="dialog-actions"><button type="button" className="button secondary" disabled={locked} onClick={()=>setDecision(null)}>Cancel</button><button className={`button ${decision==='deleted'?'danger':'primary'}`} disabled={busy}>{busy?'Saving…':attempt?'Retry same save':decision==='deleted'?'Delete photo permanently':decision==='active'?'Restore receipt':'Archive receipt'}</button></div></form>}
        <details className="receipt-history"><summary>Action history</summary><ol>{detail.events.map(event=><li key={event.version}><strong>{event.action==='uploaded'?'Photo uploaded':event.action==='restored'?'Receipt restored':event.action==='archived'?'Receipt archived':'Photo deleted'}</strong> · {event.actor_name}<small>{new Date(event.created_at).toLocaleString()}</small>{event.note&&<p>{event.note}</p>}</li>)}</ol></details>
      </>:<>
        <div className="receipt-list-heading"><p className="receipt-intro">Private receipt photos for café shopping. Open a receipt to view or download the photo{data?.canManage?', archive it or delete it':''}.</p>{scope?.view==='mine'&&Boolean(data?.eligibleJobs.length)&&<button className="button primary" disabled={locked} onClick={()=>{setError('');setDraft(blank(data!,scope?.shiftId));}}><Camera size={17}/>Add receipt photo</button>}</div>
        <div className="receipt-filters">{!scope?.shiftId&&<><label>From<input type="date" value={start} onChange={e=>{setStart(e.target.value);setOffset(0);}}/></label><label>Through<input type="date" value={end} onChange={e=>{setEnd(e.target.value);setOffset(0);}}/></label></>}<label>Show<select aria-label="Receipt status" value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}}><option value="active">Active receipts</option><option value="archived">Archived receipts</option><option value="deleted">Deleted photo records</option><option value="all">All records</option></select></label>{scope?.view==='team'&&!scope?.shiftId&&<label>Employee<select aria-label="Receipt employee" value={user} onChange={e=>{setUser(e.target.value);setOffset(0);}}><option value="">All permitted employees</option>{staff.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}<button className="icon-button" aria-label="Refresh receipts" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={18}/></button></div>
        {!scope?.shiftId&&!start&&!end&&<p className="panel-note">Showing purchases from the last 30 days. Choose dates for older receipts.</p>}
        {loading?<p role="status">Loading receipts…</p>:data?<><div className="receipt-list">{data.rows.map(row=><button key={row.id} className="receipt-row" onClick={()=>void inspect(row)}><span className="receipt-row-icon"><ReceiptText size={23}/></span><span><strong>{row.vendor||'Shopping receipt'}</strong><span>{row.employeeName} · {row.purchasedOn}</span><small>{row.unitName} · {row.status}</small></span><span className="receipt-row-total">{receiptAmountLabel(row.amountMinor)}<small>View receipt →</small></span></button>)}{!data.rows.length&&<div className="receipt-empty"><ReceiptText size={32}/><h3>No receipts in this view</h3><p>{status==='active'?'Add a photo after shopping, or change the dates and filters.':'Try another status or date range.'}</p></div>}</div><div className="receipt-actions">{offset>0&&<button className="button secondary" onClick={()=>setOffset(Math.max(0,offset-50))}>Previous receipts</button>}{data.hasMore&&offset<10000&&<button className="button secondary" onClick={()=>setOffset(offset+50)}>More receipts</button>}</div>{data.storage&&<p className="panel-note">Photo storage: {(Number(data.storage.usedBytes)/1024/1024).toFixed(1)} MB of {(Number(data.storage.limitBytes)/1024/1024).toFixed(0)} MB used. Archived photos still use storage.</p>}</>:null}
      </>}
      </div>
    </Modal>}
  </>;
}
