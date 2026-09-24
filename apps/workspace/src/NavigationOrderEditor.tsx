import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import {
  organizationNavigationIds,
  workspaceNavigationIds,
  type OrganizationNavigationId,
  type Preferences,
  type WorkspaceNavigationId,
} from '../shared/preferences';
import './navigation-order.css';

type NavigationAccess = {
  actor: { mode: string; role: string };
  permissions: { report: boolean };
};
type NavigationOrders = Pick<Preferences, 'workspaceNavOrder' | 'organizationNavOrder'>;
type NavigationField = keyof NavigationOrders;
type NavigationId = WorkspaceNavigationId | OrganizationNavigationId;
const labels: Record<NavigationId, string> = {
  overview: 'Overview', clock: 'My time clock', 'time-records': 'Time records', payroll: 'Payroll',
  staff: 'People & jobs', schedule: 'Schedule', calendar: 'Calendar', messages: 'Messages',
  requests: 'Requests', reports: 'Reports & imports', school: 'School records',
  care: 'Childcare', dismissal: 'Dismissal', workspace: 'School & community',
  audit: 'Activity log', settings: 'Settings',
};
export const navigationPreferenceLabels = {
  workspaceNavOrder: 'Your workspace navigation',
  organizationNavOrder: 'Organization navigation',
} as const;

// Keep these cosmetic visibility rules aligned with the existing App sidebar.
// Saved positions never grant access to a page or its records.
function available(id: NavigationId, field: NavigationField, me: NavigationAccess) {
  if (field === 'workspaceNavOrder') {
    return !(me.actor.mode === 'pin' && id !== 'clock') && !(['staff','payroll'].includes(id) && !me.permissions.report);
  }
  return me.actor.mode !== 'pin' && (id !== 'audit' || ['developer', 'owner', 'admin', 'finance'].includes(me.actor.role));
}

export function NavigationPreferenceValue({ field, value, me }: {
  field: NavigationField; value: NavigationOrders[NavigationField]; me: NavigationAccess;
}) {
  const visible = value.filter(id => available(id, field, me));
  return visible.length ? <ol className="navigation-comparison-order">{visible.map(id => <li key={id}>{labels[id]}</li>)}</ol> : <span>No available pages in this group.</span>;
}

export default function NavigationOrderEditor({ draft, me, onChange }: {
  draft: Preferences; me: NavigationAccess; onChange: (orders: NavigationOrders) => void;
}) {
  const headingId = useId(), explanationId = useId();
  const [announcement, setAnnouncement] = useState('');
  function move(field: NavigationField, id: NavigationId, direction: -1 | 1) {
    const order: NavigationId[] = [...draft[field]], visible = order.filter(item => available(item, field, me));
    const position = visible.indexOf(id), destination = position + direction;
    if (position < 0 || destination < 0 || destination >= visible.length) return;
    const from = order.indexOf(id), to = order.indexOf(visible[destination]);
    [order[from], order[to]] = [order[to], order[from]];
    onChange({ workspaceNavOrder: draft.workspaceNavOrder, organizationNavOrder: draft.organizationNavOrder, [field]: order });
    setAnnouncement(`${labels[id]} moved to position ${destination + 1} of ${visible.length} in ${field === 'workspaceNavOrder' ? 'Your workspace' : 'Organization'}. Save preferences to update the sidebar.`);
  }
  const groups = [
    { field: 'workspaceNavOrder', title: 'Your workspace' },
    { field: 'organizationNavOrder', title: 'Organization' },
  ] as const;
  return <section className="navigation-order-editor" aria-labelledby={headingId} aria-describedby={explanationId}>
    <div className="navigation-order-heading"><div><h3 id={headingId}>Navigation order</h3><p id={explanationId}>Move the pages you use most to the top of each group. This list previews your changes; the sidebar updates after Save preferences.</p></div>
      <button type="button" className="button secondary small" onClick={() => { onChange({ workspaceNavOrder: [...workspaceNavigationIds], organizationNavOrder: [...organizationNavigationIds] }); setAnnouncement('Default navigation order is in your unsaved preview. Save preferences to update the sidebar.'); }}><RotateCcw size={16} aria-hidden="true"/>Reset navigation order</button>
    </div>
    <div className="navigation-order-groups">{groups.filter(group => group.field !== 'organizationNavOrder' || me.actor.mode !== 'pin').map(({ field, title }) => {
      const visible = draft[field].filter(id => available(id, field, me));
      return <section className="navigation-order-group" key={field} aria-label={`${title} order preview`}>
        <h4>{title}</h4>
        <ol aria-label={`${title} page order`}>{visible.map((id, index) => <li key={id} data-navigation-id={id}>
          <div className="navigation-order-item"><span className="navigation-order-position" aria-hidden="true">{index + 1}</span><span>{labels[id]}<small>Position {index + 1} of {visible.length}</small></span></div>
          {visible.length > 1 && <div className="navigation-order-controls">
            <button type="button" className="icon-button" aria-label={`Move ${labels[id]} up in ${title}`} aria-disabled={index === 0} onClick={() => move(field, id, -1)}><ArrowUp size={17} aria-hidden="true"/></button>
            <button type="button" className="icon-button" aria-label={`Move ${labels[id]} down in ${title}`} aria-disabled={index === visible.length - 1} onClick={() => move(field, id, 1)}><ArrowDown size={17} aria-hidden="true"/></button>
          </div>}
        </li>)}</ol>
        {visible.length < 2 && <p>There are no other available pages to reorder in this group.</p>}
      </section>;
    })}</div>
    <p className="navigation-order-status" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
  </section>;
}
