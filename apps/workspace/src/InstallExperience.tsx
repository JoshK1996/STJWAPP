import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDownToLine,Check,Download,Ellipsis,ExternalLink,Plus,RefreshCw,Share,Smartphone,Wifi} from 'lucide-react';
import {Modal} from './components';
import {APP_BUILD_VERSION} from './pwa-runtime';
import './install-experience.css';

type NativeInstallEvent=Event & {
  prompt:()=>Promise<void>;
  userChoice:Promise<{outcome:'accepted'|'dismissed';platform:string}>;
};
type InstallPlatform='ios'|'android'|'desktop';
export type InstallUpdateState={available:boolean;checking:boolean;error:string|null;latestVersion:string|null};
const dismissalKey='stjw.installPromptDismissedAt';
const dismissalDuration=7*24*60*60*1000;
const installedDisplay=()=>Boolean((navigator as Navigator & {standalone?:boolean}).standalone)||matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: window-controls-overlay)').matches;
const platform=():InstallPlatform=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)?'ios':/Android/i.test(navigator.userAgent)?'android':'desktop';
function promotionDismissed(){
  try{const timestamp=Number(localStorage.getItem(dismissalKey));return timestamp>0&&Date.now()>=timestamp&&Date.now()-timestamp<dismissalDuration;}catch{return false;}
}

/** Browser events are capabilities, not a promise that every browser can install. */
export function useInstallExperience(){
  const [installed,setInstalled]=useState(installedDisplay),[device]=useState(platform);
  const [canPrompt,setCanPrompt]=useState(false),[prompting,setPrompting]=useState(false),[guideOpen,setGuideOpen]=useState(false);
  const [dismissed,setDismissed]=useState(promotionDismissed),[message,setMessage]=useState('');
  const nativePrompt=useRef<NativeInstallEvent|null>(null),mounted=useRef(true);
  useEffect(()=>{
    mounted.current=true;
    const beforeInstall=(event:Event)=>{
      // Do not suppress a browser event unless it actually exposes the prompt API.
      if(typeof (event as NativeInstallEvent).prompt!=='function')return;
      event.preventDefault();nativePrompt.current=event as NativeInstallEvent;setCanPrompt(true);
    };
    const onInstalled=()=>{nativePrompt.current=null;setCanPrompt(false);setInstalled(true);setMessage('STJW has been added. Open it from your Home Screen or app launcher.');};
    const displayChanged=()=>setInstalled(installedDisplay());
    const displays=[matchMedia('(display-mode: standalone)'),matchMedia('(display-mode: window-controls-overlay)')];
    window.addEventListener('beforeinstallprompt',beforeInstall);window.addEventListener('appinstalled',onInstalled);
    displays.forEach(display=>display.addEventListener('change',displayChanged));
    return()=>{mounted.current=false;window.removeEventListener('beforeinstallprompt',beforeInstall);window.removeEventListener('appinstalled',onInstalled);displays.forEach(display=>display.removeEventListener('change',displayChanged));};
  },[]);
  const dismissPromotion=useCallback(()=>{setDismissed(true);try{localStorage.setItem(dismissalKey,String(Date.now()));}catch{/* Storage may be disabled; this visit still respects dismissal. */}},[]);
  const install=useCallback(async()=>{
    const event=nativePrompt.current;
    if(!event){setGuideOpen(true);return;}
    // Consume before awaiting so repeated taps cannot use a one-shot event twice.
    nativePrompt.current=null;setCanPrompt(false);setPrompting(true);setMessage('');
    try{
      await event.prompt();
      const choice=await event.userChoice;
      if(!mounted.current)return;
      if(choice.outcome==='accepted')setMessage('Installation requested. Complete any browser steps, then open STJW from your Home Screen or app launcher.');
      else{dismissPromotion();setMessage('Installation was dismissed. You can try again from your browser menu.');}
    }catch{if(mounted.current){setMessage('The browser could not open installation. Use the steps below or try its menu.');setGuideOpen(true);}}
    finally{if(mounted.current)setPrompting(false);}
  },[dismissPromotion]);
  return {installed,device,canPrompt,prompting,guideOpen,message,promotionVisible:!installed&&!dismissed&&(canPrompt||device==='ios'),install,dismissPromotion,
    openGuide:()=>{setMessage('');setGuideOpen(true);},closeGuide:()=>setGuideOpen(false)};
}
export type InstallController=ReturnType<typeof useInstallExperience>;

/** Persistent entry: available even after the optional installation promotion is dismissed. */
export function InstallEntry({experience,compact=false}:{experience:InstallController;compact?:boolean}){
  return <button type="button" className={'install-entry'+(compact?' install-entry-compact':'')} onClick={experience.openGuide} aria-haspopup="dialog" aria-label={experience.installed?'App and updates':'Install STJW app'}>
    {experience.installed?<RefreshCw size={17}/>:<Smartphone size={17}/>}<span>{experience.installed?'App & updates':'Install app'}</span>
  </button>;
}

function InstallSteps({device}:{device:InstallPlatform}){
  if(device==='ios')return <ol className="install-steps">
    <li><span className="install-step-icon"><Share size={21}/></span><div><strong>Open the Share menu</strong><p>Tap Share in your browser. In Safari, it may be inside the Page Menu.</p></div></li>
    <li><span className="install-step-icon"><Plus size={21}/></span><div><strong>Add to Home Screen</strong><p>Scroll through the share actions. If missing in Safari, choose Edit Actions to add it.</p></div></li>
    <li><span className="install-step-icon"><Check size={21}/></span><div><strong>Tap Add, then open STJW</strong><p>Keep Open as Web App enabled if offered. The STJW icon will appear on this device.</p></div></li>
  </ol>;
  if(device==='android')return <ol className="install-steps">
    <li><span className="install-step-icon"><Ellipsis size={21}/></span><div><strong>Open the browser menu</strong><p>Use Chrome or another browser that supports installing web apps.</p></div></li>
    <li><span className="install-step-icon"><Download size={21}/></span><div><strong>Choose Install app</strong><p>Your browser may call this Add to Home screen. Confirm the steps it displays.</p></div></li>
    <li><span className="install-step-icon"><Check size={21}/></span><div><strong>Open STJW from its icon</strong><p>Sign in as usual. Your account permissions stay the same.</p></div></li>
  </ol>;
  return <ol className="install-steps">
    <li><span className="install-step-icon"><ArrowDownToLine size={21}/></span><div><strong>Look for the install option</strong><p>In Chrome or Edge, use the address-bar install icon or the browser menu.</p></div></li>
    <li><span className="install-step-icon"><Plus size={21}/></span><div><strong>Confirm in your browser</strong><p>On a supported Mac, Safari offers File → Add to Dock. Other browsers may offer a shortcut instead.</p></div></li>
    <li><span className="install-step-icon"><Check size={21}/></span><div><strong>Open STJW from your apps</strong><p>The website remains available in your browser whenever you need it.</p></div></li>
  </ol>;
}

export function InstallExperience({experience,update,onReload,onCheckForUpdate,reloadBlockedReason='',compact=false}:{
  experience:InstallController;update:InstallUpdateState;onReload:()=>string|void;onCheckForUpdate:()=>void;reloadBlockedReason?:string;compact?:boolean;
}){
  const [collapsed,setCollapsed]=useState(compact),[checked,setChecked]=useState(false),[bannerHeight,setBannerHeight]=useState(0),[reloadMessage,setReloadMessage]=useState('');
  const banner=useRef<HTMLElement>(null),[online,setOnline]=useState(()=>navigator.onLine);
  useEffect(()=>{const changed=()=>setOnline(navigator.onLine);window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
  useEffect(()=>{setCollapsed(compact);setReloadMessage('');},[update.latestVersion,update.available,compact]);
  const showUpdate=update.available,showPromotion=!compact&&!showUpdate&&experience.promotionVisible;
  useEffect(()=>{
    const element=banner.current;if(!element){setBannerHeight(0);return;}
    const measure=()=>setBannerHeight(Math.ceil(element.getBoundingClientRect().height)+24);
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[showUpdate,showPromotion,collapsed]);
  const blockedReason=!online?'Reconnect to the internet before updating.':reloadBlockedReason;
  return <>
    {/* App uses a horizontal flex shell. Reserve document space outside that shell. */}
    {(showUpdate||showPromotion)&&createPortal(<div className="install-reserved-space" style={{height:bannerHeight}} aria-hidden="true"/>,document.body)}
    {showUpdate?<aside ref={banner} className={'install-notice update-notice'+(collapsed?' install-notice-collapsed':'')} aria-label="App update">
      {collapsed?<button type="button" className="install-update-chip" onClick={()=>setCollapsed(false)}><RefreshCw size={18}/><span>Update available</span></button>:<>
        <span className="install-notice-symbol" aria-hidden="true"><RefreshCw size={23}/></span>
        <div className="install-notice-copy"><strong>New version ready</strong><p role="status">{blockedReason||reloadMessage||'Refresh STJW to use the latest improvements.'}</p></div>
        <div className="install-notice-actions"><button type="button" className="install-primary" onClick={()=>setReloadMessage(onReload()||'')} disabled={Boolean(blockedReason)}><RefreshCw size={16}/><span>Reload to update</span></button><button type="button" className="install-secondary" onClick={()=>setCollapsed(true)}>Later</button></div>
      </>}
    </aside>:showPromotion?<aside ref={banner} className="install-notice" aria-label="Install STJW">
      <span className="install-notice-symbol" aria-hidden="true"><Smartphone size={25}/></span>
      <div className="install-notice-copy"><strong>STJW, a tap away</strong><p>Add your workspace to this device’s Home Screen.</p></div>
      <div className="install-notice-actions"><button type="button" className="install-primary" onClick={()=>{if(experience.canPrompt)void experience.install();else experience.openGuide();}} disabled={experience.prompting}><Download size={16}/><span>{experience.canPrompt?'Install app':'Show me how'}</span></button><button type="button" className="install-secondary" onClick={experience.dismissPromotion}>Not now</button></div>
    </aside>:null}
    {experience.guideOpen&&<Modal title={experience.installed?'STJW app & updates':'Take STJW with you'} onClose={experience.closeGuide}>
      <div className="install-guide">
        <div className="install-guide-intro"><span className="install-guide-emblem" aria-hidden="true">{experience.installed?<Check size={28}/>:<Smartphone size={28}/>}</span><div><h3>{experience.installed?'You’re in the app':'Your workspace. One tap away.'}</h3><p>{experience.installed?'Open STJW directly from your Home Screen or app launcher.':'Keep the time clock and your workspace close with an icon on your device.'}</p></div></div>
        {!experience.installed&&<>
          {experience.canPrompt&&<button type="button" className="install-primary install-native-action" disabled={experience.prompting} onClick={()=>void experience.install()}><Download size={18}/>{experience.prompting?'Opening browser…':'Install STJW'}</button>}
          <InstallSteps device={experience.device}/>
          {experience.device==='ios'&&<p className="install-browser-help">Don’t see the option? Open this site in Safari and follow these steps. <a href="https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios" target="_blank" rel="noreferrer">Apple’s instructions <ExternalLink size={12}/></a></p>}
          <p className="install-browser-help">The browser controls installation. Some devices or managed browsers only allow shortcuts or may disable installation.</p>
        </>}
        {experience.message&&<p className="install-feedback" role="status">{experience.message}</p>}
        <div className="install-connection"><Wifi size={17}/><p>Internet is required to sign in, clock in or out, and save changes.</p></div>
        <section className="install-update-settings" aria-labelledby="install-update-heading"><div><h3 id="install-update-heading">App updates</h3><p>{update.available?'A newer version is available. Close this panel to review the update prompt.':'STJW checks for new versions when you open or return to the app.'}</p></div><button type="button" className="install-secondary" disabled={update.checking||!online} onClick={()=>{setChecked(true);onCheckForUpdate();}}><RefreshCw size={15}/>{update.checking?'Checking…':'Check for updates'}</button>
          {(update.error||(checked&&!update.checking&&!update.available))&&<p className="install-check-result" role="status">{update.error||(update.latestVersion?'You’re using the latest version available from the server.':APP_BUILD_VERSION==='development'?'Update checks are available in deployed builds.':'A version check has not completed. Try again when connected.')}</p>}
        </section>
      </div>
    </Modal>}
  </>;
}
