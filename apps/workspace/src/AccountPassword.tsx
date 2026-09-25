import { useEffect, useRef, useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { api, ApiError, setCsrf } from "./api";
import { Panel } from "./components";
import { MIN_PASSWORD_LENGTH } from "../shared/contracts";

export default function AccountPassword({ onChange, onDirty, isSessionCurrent, onSessionExpired, notify }: {
  onChange: () => Promise<void>; onDirty: (value: boolean) => void;
  isSessionCurrent: () => boolean; onSessionExpired: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), writing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writing.current) return;
    const form = event.currentTarget, data = new FormData(form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      setError("The new passwords do not match."); return;
    }
    writing.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ ok: true; csrf: string }>("/auth/password", {
        currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"),
      });
      if (!mounted.current || !isSessionCurrent()) return;
      setCsrf(result.csrf); form.reset(); onDirty(false);
      await onChange();
      if (mounted.current && isSessionCurrent()) notify("Password changed. Your other sessions and API tokens have been revoked.");
    } catch (problem) {
      if (!mounted.current || !isSessionCurrent()) return;
      if (problem instanceof ApiError && problem.status === 401) { form.reset(); onDirty(false); onSessionExpired(); return; }
      setError(problem instanceof ApiError ? problem.message : "The result could not be confirmed. Refresh this page; if asked to sign in, try your new password before submitting again.");
    } finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  return <Panel title="Change your password" detail="Update the password for your own account.">
    <form className="padded-form" onSubmit={submit} onChange={() => onDirty(true)}>
      <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} /></label>
      <label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={128} disabled={busy} /><small>Use {MIN_PASSWORD_LENGTH}–128 characters.</small></label>
      <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={128} disabled={busy} /></label>
      <p className="panel-note">You stay signed in on this device. Other sessions, setup links, and API tokens are revoked. Your PIN and enabled authenticator stay the same.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions"><button type="reset" className="button secondary" disabled={busy} onClick={() => { setError(""); onDirty(false); }}>Clear</button><button className="button primary" disabled={busy}><LockKeyhole size={16} />{busy ? "Changing password…" : "Change password"}</button></div>
    </form>
  </Panel>;
}
