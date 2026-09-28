import { Check, LayoutGrid, ListChecks, Palette } from 'lucide-react';
import { workspaceNavigationIds, type Preferences, type WorkspaceNavigationId } from '../shared/preferences';
import './simple-workspace.css';

const pageLabels: Record<WorkspaceNavigationId,string> = { overview:'Overview',clock:'My time clock','time-records':'Time records',payroll:'Payroll',staff:'Employees & jobs',schedule:'Schedule',calendar:'Calendar',messages:'Messages',requests:'Requests',reports:'Reports & imports' };
export default function SimpleWorkspaceSetup({draft, canReport, onChange}:{draft:Preferences;canReport:boolean;onChange:(patch:Partial<Preferences>)=>void}) {
  const pages=workspaceNavigationIds.filter(id=>canReport||!['staff','payroll'].includes(id));
  function toggle(id:WorkspaceNavigationId) {
    const next=draft.favoritePages.includes(id)?draft.favoritePages.filter(item=>item!==id):[...draft.favoritePages,id];
    onChange({favoritePages:next.length?next:['clock']});
  }
  return <div className="simple-setup">
    <div className="simple-setup-intro"><ListChecks size={26}/><div><h3>Start with the essentials</h3><p>Choose your menu and a comfortable look. Save once to use this setup on your other devices.</p></div></div>
    <div className="simple-mode-options" aria-label="Workspace detail level">
      <button type="button" aria-pressed={draft.workspaceMode==='simple'} onClick={()=>onChange({workspaceMode:'simple'})}><Check/><strong>Simple workspace</strong><span>Your chosen pages first. Everything else stays in More tools.</span></button>
      <button type="button" aria-pressed={draft.workspaceMode==='full'} onClick={()=>onChange({workspaceMode:'full'})}><LayoutGrid/><strong>All tools</strong><span>Show every page your account is allowed to use.</span></button>
    </div>
    <fieldset className="simple-favorites"><legend>Keep these pages in my menu</legend><p>Your time clock stays easy to find. Other pages remain available through More tools and Quick jump.</p><div>{pages.map(id=><label key={id}><input type="checkbox" checked={id==='clock'||draft.favoritePages.includes(id)} disabled={id==='clock'} onChange={()=>toggle(id)}/>{pageLabels[id]}</label>)}</div></fieldset>
    <div className="simple-style-options" aria-label="Quick appearance choices">
      <button type="button" onClick={()=>onChange({accent:'cobalt',artwork:'full',depth:true,compact:false})}><Palette/><strong>Colorful</strong><span>Bright colors and dimensional cards</span></button>
      <button type="button" onClick={()=>onChange({accent:'lagoon',artwork:'subtle',depth:true,compact:false})}><Palette/><strong>Calm</strong><span>Softer accents and comfortable spacing</span></button>
      <button type="button" onClick={()=>onChange({accent:'slate',artwork:'none',depth:false,compact:false})}><Palette/><strong>Focused</strong><span>Clean cards with fewer decorations</span></button>
    </div>
    <div className="simple-basic-fields">
      <label>Screen colors<select aria-label="Quick screen colors" value={draft.theme} onChange={e=>onChange({theme:e.target.value as Preferences['theme']})}><option value="system">Match my device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label>Text size<select aria-label="Quick text size" value={draft.textSize} onChange={e=>onChange({textSize:e.target.value as Preferences['textSize']})}><option value="standard">Standard</option><option value="large">Larger text</option></select></label>
      <label>Start page on a larger screen<select aria-label="Quick start page" value={draft.home} onChange={e=>onChange({home:e.target.value as Preferences['home']})}><option value="overview">Overview</option><option value="clock">My time clock</option>{canReport&&<option value="reports">Reports</option>}</select></label>
    </div>
    <p className="simple-setup-note">Phones open to the time clock. Save schedule filters on Schedule and report layouts in Payroll using their “save my defaults” controls.</p>
  </div>;
}
