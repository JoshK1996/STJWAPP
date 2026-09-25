import { useState } from 'react';
import { BriefcaseBusiness, Building2, Search, ShieldCheck, UserRound } from 'lucide-react';
import { isOwnerRole } from '../shared/contracts';
import { communityAssignmentBlockers, selectEmployeeJob, type EmployeeAssignmentSelection, type EmployeeJobChoice } from '../shared/employee-job-selection';
import { TemporaryCredentialFields } from './StaffCredentials';
import './employee-management.css';

export type EmployeeUnitChoice = { id: string; name: string };
export function EmployeeAssignmentFields({ units, jobs, selection, onChange, lockedJobIds = [], lockedUnitIds = [], disabled = false }: {
  units: EmployeeUnitChoice[]; jobs: EmployeeJobChoice[]; selection: EmployeeAssignmentSelection;
  onChange: (value: EmployeeAssignmentSelection) => void; lockedJobIds?: string[]; lockedUnitIds?: string[]; disabled?: boolean;
}) {
  const [search, setSearch] = useState(''), [message, setMessage] = useState('');
  const unitName = (id: string) => units.find(unit => unit.id === id)?.name ?? 'Unavailable community';
  const unknownJobs = selection.jobIds.filter(id => !jobs.some(job => job.id === id));
  const unknownUnits = selection.unitIds.filter(id => !units.some(unit => unit.id === id));
  const visibleJobs = jobs.filter(job => `${job.title} ${unitName(job.unitId)}`.toLowerCase().includes(search.trim().toLowerCase()));
  function chooseCommunity(id: string, checked: boolean) {
    const blockers = communityAssignmentBlockers(selection, jobs, id);
    if (!checked && blockers.length) { setMessage(`Uncheck ${blockers.join(', ')} before removing ${unitName(id)}. Your assignments have not been removed.`); return; }
    setMessage(''); onChange({ ...selection, unitIds: checked ? [...new Set([...selection.unitIds, id])] : selection.unitIds.filter(value => value !== id) });
  }
  return <div className="employee-assignments">
    {selection.unitIds.map(id => <input key={id} type="hidden" name="unitIds" value={id}/>)}
    {selection.jobIds.map(id => <input key={id} type="hidden" name="jobIds" value={id}/>)}
    <fieldset disabled={disabled} className="employee-fieldset">
      <legend><BriefcaseBusiness size={17}/>Clock-in jobs <span>{selection.jobIds.length} selected</span></legend>
      <p className="employee-help">Choose what this employee can clock in as. Selecting a job also selects its community below.</p>
      {jobs.length > 5 && <label className="employee-job-search"><Search size={17}/><span className="sr-only">Find a job</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a job or community"/></label>}
      <div className="employee-choice-list">
        {visibleJobs.map(job => <label className={`employee-choice ${selection.jobIds.includes(job.id) ? 'selected' : ''}`} key={job.id}>
          <input type="checkbox" aria-label={`${job.title} · ${unitName(job.unitId)}`} checked={selection.jobIds.includes(job.id)} disabled={lockedJobIds.includes(job.id)} onChange={event => { setMessage(''); onChange(selectEmployeeJob(selection, job, event.target.checked)); }}/>
          <span><strong>{job.title}</strong><small>{unitName(job.unitId)}{!job.active ? ' · Archived assignment' : ''}{lockedJobIds.includes(job.id) ? ' · Currently clocked in' : !selection.unitIds.includes(job.unitId) ? ' · Also adds this community' : ''}</small></span>
        </label>)}
      </div>
      {!visibleJobs.length && <p className="employee-help">{jobs.length ? 'No jobs match this search. Your selected jobs are retained.' : 'No jobs are available. Create a job in Employees & jobs, then assign it here.'}</p>}
      {!selection.jobIds.length && <p className="employee-help">Without an assigned job, this employee cannot clock in.</p>}
    </fieldset>
    <fieldset disabled={disabled} className="employee-fieldset">
      <legend><Building2 size={17}/>Communities <span>{selection.unitIds.length} selected</span></legend>
      <p className="employee-help">Select each community this employee belongs to. Subgroups require their own selection.</p>
      <div className="employee-choice-list employee-community-choices">{units.map(unit => <label className={`employee-choice ${selection.unitIds.includes(unit.id) ? 'selected' : ''}`} key={unit.id}>
        <input type="checkbox" aria-label={unit.name} checked={selection.unitIds.includes(unit.id)} disabled={lockedUnitIds.includes(unit.id)} onChange={event => chooseCommunity(unit.id, event.target.checked)}/>
        <span><strong>{unit.name}</strong>{lockedUnitIds.includes(unit.id) && <small>Current clock-in community</small>}</span>
      </label>)}</div>
      {!selection.unitIds.length && <p className="employee-help">Select at least one community before saving.</p>}
    </fieldset>
    {(unknownJobs.length > 0 || unknownUnits.length > 0) && <p className="employee-help" role="status">Some saved assignments are unavailable in this catalog. They are retained when saving; reload the saved values to review current access.</p>}
    {message && <p className="employee-selection-notice" role="status">{message}</p>}
  </div>;
}

export function EmployeeForm({ me, jobs, person, busy }: { me: any; jobs: any[]; person?: any; busy: boolean }) {
  const [selection, setSelection] = useState<EmployeeAssignmentSelection>({ unitIds: person?.unit_ids ?? [], jobIds: person?.job_ids ?? [] });
  const [onboarding, setOnboarding] = useState('temporary');
  const [role, setRole] = useState(person?.role ?? 'employee');
  const roleLabels: Record<string, string> = { employee: 'Employee', manager: 'Manager', finance: 'Finance', admin: 'Administrator', owner: 'Owner', developer: 'Developer' };
  const roles = isOwnerRole(me.actor.role)
    ? ['employee', 'manager', 'finance', 'admin', ...(me.actor.role === 'developer' && person?.role === 'owner' ? ['owner'] : []), ...(me.actor.role === 'developer' && person?.role === 'developer' ? ['developer'] : [])]
    : me.actor.role === 'admin' ? ['employee', 'manager', 'finance'] : ['employee'];
  const descriptions: Record<string, string> = {
    employee: 'Personal time clock, schedule and requests.', manager: 'Employee and workforce management within explicitly assigned communities.',
    finance: 'Financial and payroll tools; employee pay rates.', admin: 'Organization administration, employee management and financial tools.',
    owner: 'Owner access across the organization.', developer: 'Developer access across the organization.',
  };
  return <div className="employee-form">
    <fieldset className="employee-fieldset"><legend><UserRound size={17}/>Employee details</legend><div className="form-row">
      <label>Full name<input name="name" defaultValue={person?.name} required minLength={2} maxLength={100} autoComplete="name"/></label>
      <label>Email (sign-in username)<input name="email" type="email" defaultValue={person?.email} placeholder="you@stjw.org" required autoComplete="email"/></label>
    </div></fieldset>
    <fieldset className="employee-fieldset"><legend><ShieldCheck size={17}/>Account access</legend>
      <label>Access role<select name="role" value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option value={value} key={value}>{roleLabels[value]}</option>)}</select><small>{descriptions[role]}</small></label>
      {person && <label className="check-label employee-active"><input name="active" type="checkbox" defaultChecked={person.active}/>Account active</label>}
      {person && <p className="employee-help">Saving account details signs out this employee’s existing sessions. They must clock out before changing account details; use Manage jobs to add assignments during a shift.</p>}
    </fieldset>
    <EmployeeAssignmentFields units={me.units} jobs={jobs.filter(job => job.active || person?.job_ids?.includes(job.id)).map(job => ({ id: job.id, title: job.title, unitId: job.unit_id, active: job.active }))} selection={selection} onChange={setSelection} disabled={busy}/>
    {!person && ['developer', 'owner', 'admin'].includes(me.actor.role) && <fieldset className="employee-fieldset temporary-staff-onboarding" disabled={busy}>
      <legend>First sign-in</legend><label>Account setup method<select name="onboarding" aria-label="Account setup method" value={onboarding} onChange={event => setOnboarding(event.target.value)}><option value="private">Private setup link</option><option value="temporary">Set password and PIN</option></select></label>
      {onboarding === 'private' ? <p className="employee-help">After saving, share the one-time link privately. The employee chooses their own password.</p> : <TemporaryCredentialFields busy={busy}/>}
    </fieldset>}
    {!person && me.actor.role === 'manager' && <p className="employee-help">After saving, share the private setup link with this employee.</p>}
  </div>;
}
