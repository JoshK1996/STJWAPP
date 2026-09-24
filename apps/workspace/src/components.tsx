import { useEffect,useRef,useId,type ReactNode } from 'react';
import { X,ArrowUpRight,Inbox } from 'lucide-react';
export const initials=(name:string)=>name.split(' ').filter(x=>!x.startsWith('(')).slice(0,2).map(x=>x[0]).join('');
export const hours=(ms:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(ms/3600000);
export const shortName=(name:string)=>name.replace(' (Demo)','');
export function Avatar({name,index=0}:{name:string;index?:number}){return <span className={`avatar tone-${index%5}`} aria-hidden="true">{initials(name)}</span>;}
export function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={`badge ${tone}`}>{children}</span>;}
export function Empty({title,detail}:{title:string;detail:string}){return <div className="empty"><div className="empty-illustration" aria-hidden="true"><span className="empty-art-sheet"/><span className="empty-art-sheet"/><Inbox size={30}/><span className="empty-art-dot"/><span className="empty-art-dot"/></div><h3>{title}</h3><p>{detail}</p></div>;}
export function Panel({title,detail,action,children,className=''}:{title:string;detail?:string;action?:ReactNode;children:ReactNode;className?:string}){return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{detail&&<p>{detail}</p>}</div>{action}</div>{children}</section>;}
export function TextLink({children,onClick}:{children:ReactNode;onClick:()=>void}){return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={15}/></button>;}
const dialogOpeners = new WeakMap<HTMLDialogElement, HTMLElement | null>();
const openedDialogs: HTMLDialogElement[] = [];
const topOpenDialog = () => openedDialogs.filter(dialog => dialog.isConnected && dialog.open).at(-1);
const canRestoreFocus = (element: HTMLElement | null): boolean => Boolean(element?.isConnected &&
  !element.matches(":disabled") && !element.closest('[inert],dialog:not([open])') && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
export function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null), titleId=useId();
  useEffect(()=>{
    const dialog=ref.current;
    if(!dialog)return;
    const opener=document.activeElement instanceof HTMLElement && document.activeElement!==document.body ? document.activeElement : null;
    dialogOpeners.set(dialog,opener);
    dialog.showModal();
    openedDialogs.push(dialog);
    const observer=new MutationObserver(()=>queueMicrotask(()=>{
      const topDialog=topOpenDialog();
      if(dialog.isConnected && dialog.open && topDialog===dialog && document.activeElement===document.body)dialog.focus({preventScroll:true});
    }));
    observer.observe(dialog,{childList:true,subtree:true});
    return()=>{
      observer.disconnect();
      const index=openedDialogs.indexOf(dialog);
      if(index>=0)openedDialogs.splice(index,1);
      const restore=document.activeElement===document.body || dialog.contains(document.activeElement);
      dialog.close();
      queueMicrotask(()=>{
        // A caller or another dialog may already have chosen a meaningful destination.
        if(!restore || (document.activeElement!==document.body && !dialog.contains(document.activeElement)))return;
        let target=opener;
        const visited=new Set<HTMLElement>();
        while(target && !canRestoreFocus(target) && !visited.has(target)) {
          visited.add(target);
          const parent=target.closest('dialog');
          target=parent ? dialogOpeners.get(parent)??null : null;
        }
        if(!canRestoreFocus(target))target=null;
        const topDialog=topOpenDialog();
        if(topDialog && (!target || !topDialog.contains(target)))
          target=Array.from(topDialog.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]')).find(element=>element.tabIndex>=0 && canRestoreFocus(element))??topDialog;
        target??=document.getElementById('workspace-main');
        if(target && canRestoreFocus(target))target.focus({preventScroll:true});
      });
    };
  },[]);
  return <dialog ref={ref} tabIndex={-1} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}} aria-labelledby={titleId}><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>{children}</dialog>;
}
