import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { EmployeeAssignmentFields } from './EmployeeForm';
import { sameEmployeeAssignments, type EmployeeAssignmentSelection } from '../shared/employee-job-selection';
import { staffAssignmentsSnapshot, type StaffAssignments } from '../shared/staff-assignments';

export default function EmployeeJobsEditor({ person, onClose, onSaved, onDirty, isSessionCurrent, onSessionExpired, notify }: {
  person: { id: string; name: string }; onClose: () => void; onSaved: () => Promise<void>; onDirty: (value: boolean) => void;
  isSessionCurrent: () => boolean; onSessionExpired: () => void; notify: (message: string, error?: boolean) => void;
}) {
  const [saved, setSaved] = useState<StaffAssignments | null>(null), [selection, setSelection] = useState<EmployeeAssignmentSelection>({ unitIds: [], jobIds: [] });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [denied, setDenied] = useState(false), [conflict, setConflict] = useState(false);
  const mounted = useRef(true), generation = useRef(0), request = useRef<AbortController | null>(null), writing = useRef(false);
  const dirty = Boolean(saved && !sameEmployeeAssignments(saved, selection));
  const owns = (token: number) => mounted.current && generation.current === token && isSessionCurrent();
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; request.current?.abort(); }; }, [person.id]);
  useEffect(() => { onDirty(dirty || busy || uncertain); return () => onDirty(false); }, [dirty, busy, uncertain, onDirty]);
  function reject(cause: unknown) {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.status === 404)) {
      setSaved(null); setSelection({ unitIds: [], jobIds: [] }); setDenied(true); setUncertain(false); onDirty(false);
      if (cause.status === 401) onSessionExpired();
    }
  }
  async function load() {
    if (writing.current || ((dirty || uncertain) && !window.confirm('Replace unsaved job selections with the latest saved assignments?'))) return;
    const token = ++generation.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setDenied(false);
    try {
      const result = staffAssignmentsSnapshot.parse(await api(`/staff/${person.id}/assignments`, undefined, 'GET', controller.signal));
      if (!owns(token)) return; if (result.userId !== person.id) throw new Error('The employee response did not match. Reload the assignments.');
      setSaved(result); setSelection({ unitIds: result.unitIds, jobIds: result.jobIds }); setConflict(false); setUncertain(false);
    } catch (cause) { if (!owns(token) || controller.signal.aborted) return; reject(cause); setError((cause as Error).message); }
    finally { if (owns(token)) setLoading(false); }
  }
  function close() { if (!writing.current && (!(dirty || uncertain) || window.confirm(uncertain ? 'The save is not confirmed. Close and review this employee’s saved assignments before making another change?' : 'Discard unsaved job assignments?'))) onClose(); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!saved || writing.current || denied || conflict || !selection.unitIds.length) return;
    const token = generation.current; writing.current = true; setBusy(true); setError('');
    try {
      const result = staffAssignmentsSnapshot.parse(await api(`/staff/${person.id}/assignments`, { ...selection, expectedRevision: saved.revision }, 'PUT'));
      if (!owns(token)) return; if (result.userId !== person.id) throw new Error('The save response did not match the employee. Reload to confirm the saved assignments.');
      setSaved(result); setSelection({ unitIds: result.unitIds, jobIds: result.jobIds }); setUncertain(false); onDirty(false);
      notify(result.changed ? 'Job assignments saved. Clock-in choices are updated; the access role and sign-in details are unchanged.' : 'These job assignments are already saved.');
      try { await onSaved(); } catch { if (owns(token)) notify('Assignments saved, but the workspace could not refresh. Refresh before reviewing clock-in choices.', true); }
      if (owns(token)) onClose();
    } catch (cause) {
      if (!owns(token)) return; reject(cause);
      if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError('The save could not be confirmed. Retry the same assignments, or reload saved values before making other changes.'); }
      else { setUncertain(false); setConflict(cause.status === 409); setError(cause.message); }
    } finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal title={`${person.name} · Manage jobs`} onClose={close}>
    <form className="employee-jobs-form" onSubmit={save} aria-busy={loading || busy}>
      <p className="employee-help">Choose this employee’s clock-in jobs and communities. Their access role, password, PIN and recorded hours are preserved.</p>
      {loading ? <p role="status">Loading current assignments…</p> : saved && !denied && <>
        {(saved.lockedJobIds.length > 0 || saved.lockedUnitIds.length > 0) && <p className="employee-selection-notice">This employee is clocked in. You can add jobs now; their current job and community must remain assigned until they clock out.</p>}
        <EmployeeAssignmentFields key={saved.revision} units={saved.units} jobs={saved.jobs} selection={selection} onChange={setSelection} lockedJobIds={saved.lockedJobIds} lockedUnitIds={saved.lockedUnitIds} disabled={busy || uncertain || conflict}/>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions employee-editor-actions">
        <button type="button" className="button secondary" disabled={busy || loading} onClick={() => void load()}><RefreshCw size={16}/>{conflict || uncertain || !saved ? 'Reload saved values' : 'Reload assignments'}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button>
        <button className="button primary" disabled={busy || loading || denied || conflict || !saved || !selection.unitIds.length || (!dirty && !uncertain)}><Check size={16}/>{busy ? 'Saving…' : uncertain ? 'Retry same assignments' : 'Save job assignments'}</button>
      </div>
    </form>
  </Modal>;
}
