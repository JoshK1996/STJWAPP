import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { MIN_PASSWORD_LENGTH } from '../shared/contracts';
import { staffTemporaryCredentialsResult } from '../shared/temporary-credentials';
import './temporary-credentials.css';

export function TemporaryCredentialFields({ busy = false }: { busy?: boolean }) {
  const [visible, setVisible] = useState(false), [requirePasswordChange, setRequirePasswordChange] = useState(true), [requirePinChange, setRequirePinChange] = useState(true);
  const replacement = requirePasswordChange && requirePinChange ? 'password and PIN' : requirePasswordChange ? 'password' : 'PIN';
  function confirm(event: FormEvent<HTMLFieldSetElement>) {
    const form = event.currentTarget.form;
    for (const field of ['Password', 'Pin']) {
      const original = form?.elements.namedItem('temporary' + field) as HTMLInputElement | null;
      const confirmation = form?.elements.namedItem('temporary' + field + 'Confirmation') as HTMLInputElement | null;
      confirmation?.setCustomValidity(confirmation.value && confirmation.value !== original?.value ? `The ${field === 'Pin' ? 'PINs' : 'passwords'} do not match.` : '');
    }
  }
  return <fieldset disabled={busy} className="temporary-credential-fields" onInput={confirm}>
    <legend>Password and PIN</legend>
    <p>Set the sign-in details, then choose what this employee must change. Share these details privately.</p>
    <div className="credential-requirements">
      <label className="credential-requirement"><input name="requirePasswordChange" type="checkbox" checked={requirePasswordChange} onChange={event => setRequirePasswordChange(event.target.checked)}/><span>Require password change at first sign-in</span></label>
      <label className="credential-requirement"><input name="requirePinChange" type="checkbox" checked={requirePinChange} onChange={event => setRequirePinChange(event.target.checked)}/><span>Require PIN change at first sign-in</span></label>
    </div>
    <p className="credential-plan" role="status">{requirePasswordChange || requirePinChange
      ? `First sign-in: use the employee’s email and password below, then choose a new ${replacement}. ${!requirePasswordChange ? 'The password below will stay the same. ' : !requirePinChange ? 'The PIN below will stay the same. ' : ''}PIN sign-in is available after the required update.`
      : 'Ready immediately: this password opens their permitted workspace, and their unique PIN opens the time clock. No first-sign-in changes will be required.'}</p>
    <label>Password<input name="temporaryPassword" aria-label="Password" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required /><small>{MIN_PASSWORD_LENGTH}–128 characters; passwords are case-sensitive.</small></label>
    <label>Confirm password<input name="temporaryPasswordConfirmation" aria-label="Confirm password" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required /></label>
    <label>PIN<input name="temporaryPin" aria-label="PIN" type={visible ? 'text' : 'password'} inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /><small>{requirePinChange ? '6–8 digits. The employee will choose a unique replacement during setup.' : '6–8 digits. Must be unique across accounts for PIN-only sign-in.'}</small></label>
    <label>Confirm PIN<input name="temporaryPinConfirmation" aria-label="Confirm PIN" type={visible ? 'text' : 'password'} inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /></label>
    <button type="button" className="button ghost small" aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}{visible ? 'Hide password and PIN' : 'Show password and PIN'}</button>
  </fieldset>;
}

export default function StaffCredentials({ person, onClose, onSaved, notify, isSessionCurrent, onSessionExpired, onDirty }: {
  person: { id: string; name: string; email: string }; onClose: () => void; onSaved: () => Promise<void>;
  notify: (message: string, error?: boolean) => void; isSessionCurrent: () => boolean; onSessionExpired: () => void; onDirty: (value: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const command = useRef<null | { commandId: string; password: string; pin: string; requirePasswordChange: boolean; requirePinChange: boolean; reason: string }>(null), active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; command.current = null; }; }, []);
  useEffect(() => { onDirty(dirty || busy || uncertain); return () => onDirty(false); }, [dirty, busy, uncertain, onDirty]);
  const close = () => { if (!writing.current && (!(dirty || uncertain) || window.confirm(uncertain ? 'The reset result is not confirmed. Close without retrying? Check the employee account before starting another reset.' : 'Discard these unsaved sign-in details?'))) onClose(); };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (writing.current) return;
    const form = event.currentTarget, values = new FormData(form);
    if (!command.current) {
      if (values.get('temporaryPassword') !== values.get('temporaryPasswordConfirmation') || values.get('temporaryPin') !== values.get('temporaryPinConfirmation')) { setError('The confirmation fields must match.'); return; }
      command.current = { commandId: crypto.randomUUID(), password: String(values.get('temporaryPassword')), pin: String(values.get('temporaryPin')), requirePasswordChange: values.get('requirePasswordChange') === 'on', requirePinChange: values.get('requirePinChange') === 'on', reason: String(values.get('reason')) };
    }
    writing.current = true; setBusy(true); setError('');
    try {
      const result = staffTemporaryCredentialsResult.parse(await api(`/staff/${person.id}/temporary-credentials`, command.current));
      if (!active.current || !isSessionCurrent()) return;
      form.reset(); command.current = null; setDirty(false); setUncertain(false); onDirty(false);
      const required = result.requirePasswordChange && result.requirePinChange ? 'password and PIN' : result.requirePasswordChange ? 'password' : 'PIN';
      notify(result.replayed ? (result.requiresCredentialChange ? `This reset was already saved. The employee still needs to replace their ${required}; their current credentials were preserved.` : 'This reset was already saved. No credential changes remain required; current sign-in details were preserved.') : result.requiresCredentialChange ? `Sign-in details saved. The employee must sign in with email and password, then replace their ${required}.` : 'Sign-in details saved. The employee can use the password or unique PIN immediately; no first-sign-in change is required.');
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
      <p>Share the sign-in details privately before closing. They are never shown in saved account records.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy}><KeyRound size={16} />{busy ? 'Saving reset…' : uncertain ? 'Retry same reset' : 'Save sign-in details'}</button></div>
    </form>
  </Modal>;
}
