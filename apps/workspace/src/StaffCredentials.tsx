import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { MIN_PASSWORD_LENGTH } from '../shared/contracts';
import { staffTemporaryCredentialsResult } from '../shared/temporary-credentials';
import './temporary-credentials.css';

export function TemporaryCredentialFields({ busy = false }: { busy?: boolean }) {
  const [visible, setVisible] = useState(false);
  function confirm(event: FormEvent<HTMLFieldSetElement>) {
    const form = event.currentTarget.form;
    for (const field of ['Password', 'Pin']) {
      const original = form?.elements.namedItem('temporary' + field) as HTMLInputElement | null;
      const confirmation = form?.elements.namedItem('temporary' + field + 'Confirmation') as HTMLInputElement | null;
      confirmation?.setCustomValidity(confirmation.value && confirmation.value !== original?.value ? `The temporary ${field === 'Pin' ? 'PINs' : 'passwords'} do not match.` : '');
    }
  }
  return <fieldset disabled={busy} className="temporary-credential-fields" onInput={confirm}>
    <legend>Temporary sign-in details</legend>
    <p>For the first sign-in, give the employee their email and temporary password. They must choose a new password and unique PIN before using the app. A shared temporary PIN cannot identify an employee on its own.</p>
    <label>Temporary password<input name="temporaryPassword" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required /><small>{MIN_PASSWORD_LENGTH}–128 characters; passwords are case-sensitive.</small></label>
    <label>Confirm temporary password<input name="temporaryPasswordConfirmation" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required /></label>
    <label>Temporary PIN<input name="temporaryPin" type={visible ? 'text' : 'password'} inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /><small>6–8 digits. The employee will replace this during setup.</small></label>
    <label>Confirm temporary PIN<input name="temporaryPinConfirmation" type={visible ? 'text' : 'password'} inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /></label>
    <button type="button" className="button ghost small" aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}{visible ? 'Hide temporary credentials' : 'Show temporary credentials'}</button>
  </fieldset>;
}

export default function StaffCredentials({ person, onClose, onSaved, notify, isSessionCurrent, onSessionExpired, onDirty }: {
  person: { id: string; name: string; email: string }; onClose: () => void; onSaved: () => Promise<void>;
  notify: (message: string, error?: boolean) => void; isSessionCurrent: () => boolean; onSessionExpired: () => void; onDirty: (value: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const command = useRef<null | { commandId: string; password: string; pin: string; reason: string }>(null), active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; command.current = null; }; }, []);
  useEffect(() => { onDirty(dirty || busy || uncertain); return () => onDirty(false); }, [dirty, busy, uncertain, onDirty]);
  const close = () => { if (!writing.current && (!(dirty || uncertain) || window.confirm(uncertain ? 'The reset result is not confirmed. Close without retrying? Check the employee account before starting another reset.' : 'Discard these unsaved temporary credentials?'))) onClose(); };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (writing.current) return;
    const form = event.currentTarget, values = new FormData(form);
    if (!command.current) {
      if (values.get('temporaryPassword') !== values.get('temporaryPasswordConfirmation') || values.get('temporaryPin') !== values.get('temporaryPinConfirmation')) { setError('The confirmation fields must match.'); return; }
      command.current = { commandId: crypto.randomUUID(), password: String(values.get('temporaryPassword')), pin: String(values.get('temporaryPin')), reason: String(values.get('reason')) };
    }
    writing.current = true; setBusy(true); setError('');
    try {
      const result = staffTemporaryCredentialsResult.parse(await api(`/staff/${person.id}/temporary-credentials`, command.current));
      if (!active.current || !isSessionCurrent()) return;
      form.reset(); command.current = null; setDirty(false); setUncertain(false); onDirty(false);
      notify(result.replayed ? (result.requiresCredentialChange ? 'This reset was already saved. No new reset was applied; confirm the employee has the original temporary details.' : 'This reset was already saved and setup is now complete. The employee’s current credentials were preserved.') : 'Temporary credentials saved. The employee must use email and temporary password, then choose a new password and PIN.');
      try { await onSaved(); } catch { if (active.current && isSessionCurrent()) notify('The reset was saved, but the staff list could not refresh. Refresh the workspace to check its current status.', true); }
      if (active.current && isSessionCurrent()) onClose();
    } catch (cause) {
      if (!active.current || !isSessionCurrent()) return;
      if (cause instanceof ApiError && cause.status === 401) { form.reset(); command.current = null; onDirty(false); onSessionExpired(); return; }
      if (!(cause instanceof ApiError) || cause.status >= 500) {
        setUncertain(true); setError('We could not confirm whether the reset saved. Retry the same reset below; do not create another reset until this result is known.');
      } else { command.current = null; setUncertain(false); setError(cause.message); }
    } finally { writing.current = false; if (active.current) setBusy(false); }
  }
  return <Modal title={`Reset sign-in · ${person.name}`} onClose={close}>
    <form className="padded-form staff-credentials-form" onSubmit={save} onChange={() => setDirty(true)}>
      <p className="panel-note">Employee email: <strong>{person.email}</strong>. Existing sessions and setup links will be revoked. An enabled authenticator remains required; this does not reset MFA or alter recorded hours.</p>
      <TemporaryCredentialFields busy={busy || uncertain} />
      <label>Reason for reset<textarea name="reason" minLength={3} maxLength={1000} required disabled={busy || uncertain} placeholder="For example: employee could not finish first sign-in." /></label>
      <p>Share the temporary details privately before closing. They are never shown in saved account records.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy}><KeyRound size={16} />{busy ? 'Saving reset…' : uncertain ? 'Retry same reset' : 'Save temporary credentials'}</button></div>
    </form>
  </Modal>;
}
