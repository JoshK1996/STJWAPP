import {useContext,useEffect,useRef,useState} from 'react';
import {api,ApiError,download} from './api';
import {AccountingAccessContext} from './accounting-ui';
import './accounting-planning.css';
export type PlanningProps={workspace:any,notify:(message:string,error?:boolean)=>void,onDirty:(dirty:boolean)=>void};
export function useAccountingPlanning(notify:PlanningProps['notify']){
 const onDenied=useContext(AccountingAccessContext),running=useRef(false),alive=useRef(true),allowed=useRef(true),commands=useRef(new Map<string,string>()),[busy,setBusy]=useState(false),[denied,setDenied]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;allowed.current=true;return()=>{alive.current=false;allowed.current=false;};},[]);
 const current=()=>alive.current&&allowed.current;
 const fail=(e:unknown)=>{if(!alive.current)return;if(e instanceof ApiError&&(e.status===401||e.status===403)){allowed.current=false;setDenied(true);onDenied();}setError((e as Error).message);notify((e as Error).message,true);};
 async function read<T=any>(path:string):Promise<T|undefined>{try{const result=await api<T>(path);return current()?result:undefined;}catch(e){fail(e);return undefined;}}
 async function write(path:string,body:Record<string,unknown>){if(!current()||running.current)return;running.current=true;const key=path+JSON.stringify(body);if(!commands.current.has(key))commands.current.set(key,crypto.randomUUID());setBusy(true);setError('');try{const result=await api(path,{...body,commandId:commands.current.get(key)});if(current())return result;}catch(e){fail(e);}finally{running.current=false;if(alive.current)setBusy(false);}}
 async function exportFile(path:string,name:string){try{await download(path,name,current);}catch(e){fail(e);}}
 return {read,write,exportFile,busy,denied,error,current};
}
export function PlanningAmount({value,currency}:{value:string,currency?:string}){const [whole,fraction]=String(value).split('.');return <span className="planning-money">{currency?currency+' ':''}{whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}{fraction!==undefined?'.'+fraction:''}</span>;}
export function PlanningAccount({accounts,value,onChange,type,label='Account',cash=false}:{accounts:any[],value:string,onChange:(value:string)=>void,type?:string,label?:string,cash?:boolean}){return <label>{label}<select aria-label={label} required value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose an account</option>{accounts.filter(a=>a.active&&(!type||a.type===type)&&(!cash||(a.isCash??a.is_cash))).map(a=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>;}
