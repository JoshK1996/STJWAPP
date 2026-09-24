import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BadgeDollarSign, Banknote, BookOpen, ChartNoAxesCombined, CheckCircle2, CircleDollarSign, ClipboardList, FileBarChart2, HandCoins, Landmark, Layers3, LayoutDashboard, RefreshCw, Settings2, Sparkles, Wallet } from 'lucide-react';
import { api, ApiError } from './api';
import type { AccountingWorkspace as Workspace } from '../shared/accounting';
import AccountingBudgetPanel from './AccountingBudgetPanel';
import AccountingPayrollPanel from './AccountingPayrollPanel';
import { AccountingBooks, AccountingJournals, AccountingSettings } from './accounting-books';
import { AccountingBanking, AccountingDocuments } from './accounting-operations';
import { AccountingStatements } from './accounting-statements';
import { AccountingAccessContext, AccountingLoad, AccountingNotice, AccountingSection, accountingDate, useAccountingAction, useAccountingCommands, type AccountingContext } from './accounting-ui';
import './accounting.css';

type Props={me:any;notify:(message:string,error?:boolean)=>void;onDirty:(dirty:boolean)=>void};
type Section='overview'|'books'|'journals'|'payables'|'receivables'|'banking'|'budgets'|'payroll'|'statements'|'settings';
const sections:{id:Section;label:string;icon:typeof BookOpen;module?:string}[]=[
  {id:'overview',label:'Overview',icon:LayoutDashboard},
  {id:'books',label:'Accounts & periods',icon:BookOpen},
  {id:'journals',label:'Journals',icon:ClipboardList},
  {id:'payables',label:'Bills & vendors',icon:Wallet,module:'payables'},
  {id:'receivables',label:'Invoices & billing',icon:HandCoins,module:'receivables'},
  {id:'banking',label:'Bank reconciliation',icon:Landmark,module:'banking'},
  {id:'budgets',label:'Budgets',icon:ChartNoAxesCombined,module:'budgets'},
  {id:'payroll',label:'Payroll preparation',icon:BadgeDollarSign,module:'payroll'},
  {id:'statements',label:'Statements & reports',icon:FileBarChart2},
  {id:'settings',label:'Accounting settings',icon:Settings2},
];
export default function Accounting(props:Props){const actor=props.me.actor;return <AccountingWorkspace key={`${actor.org_id}:${actor.id}:${actor.mode}:${actor.role}:${actor.csrf}:${JSON.stringify(actor.unit_ids??[])}`} {...props}/>;}
function AccountingWorkspace({notify,onDirty}:Props){
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[denied,setDenied]=useState(false),[section,setSection]=useState<Section>('overview'),[revision,setRevision]=useState(0);
  const alive=useRef(true),dirty=useRef(false),generation=useRef(0),dirtyListener=useRef(onDirty);dirtyListener.current=onDirty;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;dirtyListener.current(false);};},[]);
  const deny=useCallback(()=>{generation.current++;setWorkspace(null);setDenied(true);dirty.current=false;dirtyListener.current(false);},[]);
  useEffect(()=>{const current=++generation.current,controller=new AbortController();setLoading(true);setError('');api<Workspace>('/accounting/workspace',undefined,'GET',controller.signal).then(result=>{if(alive.current&&current===generation.current){setWorkspace(result);setDenied(false);}}).catch(caught=>{if(alive.current&&current===generation.current&&caught?.name!=='AbortError'){setWorkspace(null);setError(caught instanceof Error?caught.message:'Unable to load accounting.');if(caught instanceof ApiError&&[401,403].includes(caught.status))deny();}}).finally(()=>{if(alive.current&&current===generation.current)setLoading(false);});return()=>controller.abort();},[revision,deny]);
  const markDirty=useCallback((value:boolean)=>{dirty.current=value;dirtyListener.current(value);},[]);
  function guard(){if(dirty.current&&!window.confirm('Discard the unsaved accounting changes and leave this view?'))return false;markDirty(false);return true;}
  function navigate(next:Section){if(next!==section&&guard())setSection(next);}
  const enabled=sections.filter(item=>!item.module||workspace?.config.modules.includes(item.module));
  const context=workspace?{workspace,notify,onDirty:markDirty,refresh:()=>setRevision(n=>n+1),guardNavigation:guard}:null;
  const validSection=enabled.some(item=>item.id===section)?section:'overview';
  return <AccountingAccessContext.Provider value={deny}><div className="accounting-workspace">
    <header className="accounting-hero"><div><span className="accounting-eyebrow"><Sparkles size={15}/>STJW · Accounting workspace</span><h2>See the whole financial picture.</h2><p>From the first invoice to the final report, keep amounts organized, decisions reviewable and every posted entry connected.</p>{workspace&&<div className="accounting-hero-pills"><span>{workspace.config.currency} · {workspace.config.precision} decimal places</span><span>{workspace.config.basis==='cash'?'Cash basis':'Accrual basis'}</span><span>{workspace.config.reviewed?'Settings reviewed':'Starter settings · review anytime'}</span></div>}</div><div className="accounting-sculpture" aria-hidden="true"><div><Layers3 size={49}/></div><span><CircleDollarSign size={32}/></span></div></header>
    {denied?<AccountingNotice tone="error">Your current session no longer has access to this accounting workspace. Sign in with an authorized password account to continue.</AccountingNotice>:<>
      {!workspace&&<AccountingLoad loading={loading} error={error} retry={()=>setRevision(n=>n+1)}/>}
      {context&&<><nav className="accounting-tabs" aria-label="Accounting workflows">{enabled.map(item=><button type="button" key={item.id} aria-current={validSection===item.id?'page':undefined} onClick={()=>navigate(item.id)}><item.icon size={17}/>{item.label}</button>)}</nav>
        {validSection!=='settings'&&!context.workspace.config.reviewed&&<AccountingNotice>Starter settings: US dollars, 2 decimals, accrual accounting and a January fiscal start. <button type="button" onClick={()=>navigate('settings')}>Review or change settings</button></AccountingNotice>}
        {validSection==='overview'&&<Overview {...context} navigate={navigate}/>}
        {validSection==='books'&&<AccountingBooks {...context}/>}
        {validSection==='journals'&&<AccountingJournals {...context}/>}
        {validSection==='payables'&&<AccountingDocuments key="bills" {...context} kind="bill"/>}
        {validSection==='receivables'&&<AccountingDocuments key="invoices" {...context} kind="invoice"/>}
        {validSection==='banking'&&<AccountingBanking {...context}/>}
        {validSection==='budgets'&&<AccountingBudgetPanel workspace={context.workspace} notify={notify} onDirty={markDirty}/>}
        {validSection==='payroll'&&<AccountingPayrollPanel workspace={context.workspace} notify={notify} onDirty={markDirty}/>}
        {validSection==='statements'&&<AccountingStatements {...context}/>}
        {validSection==='settings'&&<AccountingSettings key={context.workspace.config.revision} {...context}/>}
      </>}
    </>}
  </div></AccountingAccessContext.Provider>;
}

function Overview({workspace,notify,onDirty,refresh,navigate}:AccountingContext&{navigate:(section:Section)=>void}){
  const [year,setYear]=useState(String(new Date().getFullYear())),[reviewed,setReviewed]=useState(false),action=useAccountingAction(notify),command=useAccountingCommands();
  async function starter(event:React.FormEvent){event.preventDefault();const body={year:Number(year)};const result=await action.run(()=>api('/accounting/starter-chart',{...body,commandId:command('starter-chart',body)}),'Starter accounts and accounting period created. Review and customize them before posting.');if(result){onDirty(false);refresh();}}
  const openPeriods=workspace.periods.filter(p=>p.status==='open'),drafts=workspace.journals.filter(j=>j.status==='draft'),posted=workspace.journals.filter(j=>j.status==='posted');
  return <div className="accounting-stack"><div className="accounting-stat-grid">{[
    {label:'Active accounts',value:workspace.accounts.filter(a=>a.active).length,detail:'Your chart of accounts',color:'var(--book-purple)',icon:BookOpen},
    {label:'Open accounting periods',value:openPeriods.length,detail:openPeriods[0]?.name??'Create a period to post entries',color:'var(--book-teal)',icon:ClipboardList},
    {label:'Drafts to review',value:drafts.length,detail:workspace.journalsTruncated?'Within recent journal list':'Not included in account balances',color:'var(--book-gold)',icon:FileBarChart2},
    {label:'Posted journals',value:posted.length,detail:workspace.journalsTruncated?'Within recent journal list':'Preserved with their source history',color:'var(--book-rose)',icon:CheckCircle2},
  ].map(stat=><article className="accounting-stat" key={stat.label} style={{'--stat-tone':stat.color} as CSSProperties}><stat.icon size={23}/><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.detail}</small></article>)}</div>
    {workspace.accounts.length===0?<AccountingSection title="Start with an organized set of books" detail="Use a suggested school and nonprofit chart, or bring your own reviewed accounts. Neither option adds financial balances."><form inert={action.busy} className="accounting-stack" onSubmit={starter}><AccountingNotice>Starter accounts cover banking, receivables, payables, payroll liabilities, net assets, tuition, contributions and program, management and fundraising expenses. Every name and classification is available in Accounts & periods.</AccountingNotice><div className="accounting-form-grid"><label>Starter calendar year<input required type="number" min={1900} max={9999} value={year} onChange={e=>{setYear(e.target.value);setReviewed(false);onDirty(true);}}/><small>The starter period runs January 1 to December 31. Use your own period dates if your fiscal year differs.</small></label></div><label className="accounting-check"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>Create suggested accounts and an open calendar-year period for review.</label>{action.error&&<AccountingNotice tone="error">{action.error}</AccountingNotice>}<div className="accounting-actions"><button type="submit" className="primary" disabled={!reviewed||action.busy}>Use starter chart & period</button><button type="button" onClick={()=>navigate('books')}>Use my own accounts</button><button type="button" onClick={()=>navigate('settings')}>Change accounting settings</button></div></form></AccountingSection>:<AccountingSection title="Your next financial task" detail="Pick the workflow you need. Each one uses the same accounts, dates, dimensions and review history."><div className="accounting-module-grid">{sections.filter(item=>['journals','payables','receivables','banking','budgets','payroll','statements'].includes(item.id)&&(!item.module||workspace.config.modules.includes(item.module))).map(item=><article className="accounting-module-card" key={item.id}><item.icon size={23}/><h4>{item.label}</h4><p>{item.id==='journals'?'Prepare opening balances and adjustments.':item.id==='payables'?'Review bills and record completed payments.':item.id==='receivables'?'Manage invoices, credits and receipts.':item.id==='banking'?'Match statement lines and reconcile cash.':item.id==='budgets'?'Compare your approved plan with the books.':item.id==='payroll'?'Prepare earnings and accountant-reviewed deductions.':'Explore readable financial reports and Excel packs.'}</p><button type="button" onClick={()=>navigate(item.id)}>Open {item.label.toLowerCase()}</button></article>)}</div></AccountingSection>}
    <AccountingSection title="How the accounting flow works" detail="Keep each step understandable, from setup through reporting."><div className="accounting-flow"><article><h4>Choose your structure</h4><p>Review currency and basis, customize accounts, define funds and open a period.</p></article><article><h4>Prepare the record</h4><p>Enter a balanced journal, bill, invoice, budget or payroll draft with meaningful names.</p></article><article><h4>Review & record</h4><p>Post approved entries. Record completed payments and reconcile them with the bank.</p></article><article><h4>Understand & share</h4><p>Explore statements, filter dimensions and give your accountant readable Excel or CSV reports.</p></article></div><div className="accounting-actions"><button type="button" onClick={()=>navigate('settings')}><Settings2 size={16}/>Choose enabled workflows</button><button type="button" onClick={()=>navigate('books')}><BookOpen size={16}/>Review accounts & periods</button></div></AccountingSection>
  </div>;
}
