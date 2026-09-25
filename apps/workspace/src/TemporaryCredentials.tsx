import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { api, ApiError } from "./api";
import { MIN_PASSWORD_LENGTH } from "../shared/contracts";
import { completeCredentialsResultSchema, type CredentialChangeChallenge } from "../shared/temporary-credentials";

export default function TemporaryCredentials({ challenge, onReturn }: {
  challenge: CredentialChangeChallenge; onReturn: (message: string, error?: boolean) => void;
}) {
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [expired, setExpired] = useState(Date.now() >= Date.parse(challenge.expiresAt));
  const busyRef = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setExpired(Date.now() >= Date.parse(challenge.expiresAt)), 1000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [challenge.expiresAt]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || expired) return;
    const form = event.currentTarget, values = new FormData(form);
    setError("");
    if (values.get("password") !== values.get("passwordConfirmation")) {
      setError("The new passwords do not match. Enter the same password in both fields.");
      form.querySelector<HTMLInputElement>('[name="passwordConfirmation"]')?.focus(); return;
    }
    if (values.get("pin") !== values.get("pinConfirmation")) {
      setError("The new PINs do not match. Enter the same PIN in both fields.");
      form.querySelector<HTMLInputElement>('[name="pinConfirmation"]')?.focus(); return;
    }
    busyRef.current = true; setBusy(true);
    try {
      completeCredentialsResultSchema.parse(await api("/auth/credentials/complete", {
        challenge: challenge.challenge, password: values.get("password"), pin: values.get("pin"),
      }));
      form.reset();
      if (alive.current) onReturn("Your password and PIN are ready. Sign in with your email and new password to open your workspace. Your new PIN opens the time clock.");
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        form.reset(); onReturn("This setup step expired or changed. Sign in again. If your update already completed, use your new credentials.", true);
      } else if (!(cause instanceof ApiError) || cause.status >= 500) {
        // Completion may have committed before its response was lost. Do not
        // silently resend changed secrets or treat this as an ordinary session.
        form.reset(); onReturn("We could not confirm the update. Try signing in with your new credentials. If they do not work, use your temporary credentials to restart this step.", true);
      } else setError(cause.message);
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="temporary-credentials">
    <p className="auth-note">Replace both temporary credentials before opening the workspace. Your password must differ from the temporary password, and your PIN must differ from the temporary PIN.</p>
    <form onSubmit={submit} aria-label="Replace temporary password and PIN" aria-busy={busy}>
      <fieldset disabled={busy || expired}>
        <legend>Choose your private password</legend>
        <label>New password<input name="password" aria-label="New password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required autoFocus /></label>
        <small>Use {MIN_PASSWORD_LENGTH}–128 characters.</small>
        <label>Confirm new password<input name="passwordConfirmation" aria-label="Confirm new password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={128} required /></label>
      </fieldset>
      <fieldset disabled={busy || expired}>
        <legend>Choose your private time-clock PIN</legend>
        <label>New PIN<input name="pin" aria-label="New PIN" type="password" inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /></label>
        <small>Use 6–8 digits. Keep your PIN private.</small>
        <label>Confirm new PIN<input name="pinConfirmation" aria-label="Confirm new PIN" type="password" inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} autoComplete="off" required /></label>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {expired && <p className="error" role="alert">This setup step has expired. Start sign-in again to continue.</p>}
      <button className="button primary full" disabled={busy || expired}>{busy ? "Updating credentials…" : "Update password and PIN"}<ArrowRight size={18} /></button>
    </form>
    <p className="muted">After saving, you will sign in again. No workspace access is granted by this step.</p>
    <button type="button" className="button ghost full" disabled={busy} onClick={() => onReturn("Sign in to continue. Temporary credentials still require both replacements before workspace access.")}>Start sign-in again</button>
  </div>;
}
