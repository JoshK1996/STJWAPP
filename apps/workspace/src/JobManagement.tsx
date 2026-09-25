import { useEffect, useRef, useState } from 'react';
import { BriefcaseBusiness, History, Pencil, Plus, Search } from 'lucide-react';
import { api } from './api';
import { Badge, Empty, Modal, Panel } from './components';
import './management-editing.css';

export function JobManagement({me,jobs,onEdit,isSessionCurrent}:{me:any;jobs:any[];onEdit:(job?:any)=>void;isSessionCurrent:()=>boolean}) {
  const [search,setSearch]=useState(''),[status,setStatus]=useState('active');
  const [history,setHistory]=useState<{job:any;rows:any[];loading:boolean;error:string;truncated:boolean}|null>(null);
  const generation=useRef(0),owner=useRef(isSessionCurrent);owner.current=isSessionCurrent;
  useEffect(()=>()=>{generation.current++;},[]);
  async function showHistory(job:any) {
    const request=++generation.current;setHistory({job,rows:[],loading:true,error:'',truncated:false});
    try {const result=await api(`/jobs/${job.id}/history`);if(generation.current===request&&owner.current())setHistory({job,rows:result.rows,loading:false,error:'',truncated:result.truncated});}
    catch(error){if(generation.current===request&&owner.current())setHistory({job,rows:[],loading:false,error:(error as Error).message,truncated:false});}
  }
  const visible=jobs.filter(job=>(status==='all'||job.active===(status==='active'))&&`${job.title} ${job.unit_name} ${job.description}`.toLowerCase().includes(search.toLowerCase()));
  return <Panel title="Jobs & responsibilities" detail="Edit the work people clock in under. Access roles are managed on each staff account." action={me.permissions.manage?<button className="button secondary small" onClick={()=>onEdit()}><Plus size={16}/>Create job</button>:undefined}>
    <div className="management-toolbar"><label className="search in-panel"><Search size={16}/><input aria-label="Search jobs" placeholder="Search jobs or communities" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>Show jobs<select aria-label="Job status filter" value={status} onChange={e=>setStatus(e.target.value)}><option value="active">Available jobs</option><option value="archived">Archived jobs</option><option value="all">All jobs</option></select></label><Badge>{visible.length} {visible.length===1?'job':'jobs'}</Badge></div>
    <div className="managed-job-grid">{visible.map(job=><article className={'managed-job '+(!job.active?'archived':'')} key={job.id}><div className="managed-job-top"><span className="managed-job-icon"><BriefcaseBusiness size={23}/></span><Badge tone={job.active?'green':'neutral'}>{job.active?'Available':'Archived'}</Badge></div><h3>{job.title}</h3><p className="managed-job-community">{job.unit_name}</p>{job.description&&<p>{job.description}</p>}{me.permissions.manage&&<div className="managed-job-actions"><button className="button secondary small" onClick={()=>onEdit(job)} aria-label={`Edit job ${job.title}`}><Pencil size={15}/>Edit job</button><button className="button ghost small" onClick={()=>void showHistory(job)} aria-label={`View history for ${job.title}`}><History size={15}/>History</button></div>}</article>)}</div>
    {!visible.length&&<Empty title="No jobs match these filters" detail="Try a different search or include archived jobs."/>}
    <p className="management-help">Archive jobs you no longer use. Their assignments, time records and change history stay available. Restore an archived job through Edit job.</p>
    {history&&<Modal title={`Job history · ${history.job.title}`} onClose={()=>{generation.current++;setHistory(null);}}><div className="management-history">{history.loading?<p role="status">Loading changes…</p>:history.error?<p role="alert" className="error">{history.error}</p>:<>{history.truncated&&<p>Showing the latest 100 changes.</p>}{history.rows.map((row,index)=><article key={index}><strong>{row.action==='job.created'?'Job created':'Job updated'}</strong><small>{new Date(row.created_at).toLocaleString()} · {row.actor_name??'Recorded user'}</small>{row.detail.before&&<p>{row.detail.before.title} → {row.detail.after.title} · {row.detail.after.active?'Available':'Archived'}</p>}{row.detail.after?.description&&<p>{row.detail.after.description}</p>}{row.detail.reason&&<p>Reason: {row.detail.reason}</p>}</article>)}{!history.rows.length&&<p>No recorded changes are available.</p>}</>}</div></Modal>}
  </Panel>;
}

export function JobForm({me,job}:{me:any;job?:any}) {
  return <><label>Job title<input name="title" required minLength={2} maxLength={100} defaultValue={job?.title}/></label><label>Community<select name="unitId" defaultValue={job?.unit_id}>{me.units.map((unit:any)=><option value={unit.id} key={unit.id}>{unit.name}</option>)}</select><small>A community can change before the job has assignments or retained records. Used jobs keep their community so historical access and reports stay consistent.</small></label><label>Description<textarea name="description" rows={3} maxLength={1000} defaultValue={job?.description??''} placeholder="Explain when employees should choose this job."/></label>{job&&<><label className="check-label"><input type="checkbox" name="active" defaultChecked={job.active}/>Available for new clock-ins and assignments</label><p className="management-help">Clear this box to archive the job. Anyone working under it must switch jobs or clock out first. Historical times and saved evidence are retained; current directory/report labels use the updated job title.</p><label>Reason for change<textarea name="reason" required minLength={3} maxLength={1000} rows={2} placeholder="Describe the correction or why this job is being archived."/></label></>}</>;
}
