import {useCallback,useState} from 'react';
import {Landmark,FileBarChart2} from 'lucide-react';
import Finance from './Finance';
import Accounting from './Accounting';
type Props={me:any,notify:(message:string,error?:boolean)=>void,onDirty:(dirty:boolean)=>void};
export default function FinanceWorkspace(props:Props){
 const [view,setView]=useState<'accounting'|'sources'>('accounting'),[dirty,setDirty]=useState(false);
 const changed=useCallback((value:boolean)=>{setDirty(value);props.onDirty(value);},[props.onDirty]);
 const choose=(next:typeof view)=>{if(next===view)return;if(dirty&&!window.confirm('Discard unsaved accounting changes?'))return;changed(false);setView(next);};
 return <><nav className="finance-actions" aria-label="Finance workspaces"><button className={'button '+(view==='accounting'?'primary':'secondary')} onClick={()=>choose('accounting')} aria-pressed={view==='accounting'}><Landmark size={18}/>Accounting workspace</button><button className={'button '+(view==='sources'?'primary':'secondary')} onClick={()=>choose('sources')} aria-pressed={view==='sources'}><FileBarChart2 size={18}/>Imported source reports</button></nav>{view==='accounting'?<Accounting {...props} onDirty={changed}/>:<Finance {...props} onDirty={changed}/>}</>;
}
