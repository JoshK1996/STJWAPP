import { useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Church,
  ShieldCheck,
  KeyRound,
  Clock3,
} from "lucide-react";
import { api } from "./api";
import { WorkspaceArt } from "./WorkspaceArt";
import { MIN_PASSWORD_LENGTH } from "../shared/contracts";
import { credentialChangeChallengeSchema, type CredentialChangeChallenge } from "../shared/temporary-credentials";
import TemporaryCredentials from "./TemporaryCredentials";
import "./temporary-credentials.css";
export default function Auth({
  onSignedIn,
  setupToken,
}: {
  onSignedIn: () => void;
  setupToken: string;
}) {
  const [mode, setMode] = useState<"password" | "pin">("password");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [credentialChange, setCredentialChange] = useState<CredentialChangeChallenge | null>(null);
  const [email, setEmail] = useState(""), [formRevision, setFormRevision] = useState(0), [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    setNotice("");
    setBusy(true);
    const element = e.currentTarget, form = new FormData(element);
    try {
      let result;
      if (challenge)
        result = await api("/auth/mfa/verify", {
          challenge,
          code: form.get("code"),
        });
      else if (setupToken)
        result = await api("/auth/setup", {
          token: setupToken,
          password: form.get("password"),
        });
      else
        result = await api("/auth/login", {
          ...(mode === "password" ? { email: form.get("email") } : {}),
          credential: form.get("credential"),
          mode,
        });
      if (result.requiresCredentialChange === true) {
        const next = credentialChangeChallengeSchema.parse(result);
        setEmail(String(form.get("email") ?? "")); element.reset();
        setChallenge(""); setRecovery(false); setCredentialChange(next);
      } else if (result.challenge) {
        setChallenge(result.challenge);
        element.reset();
        if (setupToken) history.replaceState(null, "", location.pathname);
      } else onSignedIn();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <div className="auth-brand">
          <span className="brand-mark">
            <Church size={25} />
          </span>
          <div>
            <strong>STJW</strong>
            <span>ONE CONNECTED COMMUNITY</span>
          </div>
        </div>
        <div className="auth-message">
          <span className="eyebrow">ST. JOSEPH THE WORKER</span>
          <h1>
            More time for <br />
            what matters.
          </h1>
          <p>
            A thoughtful space for the people who make our school, parish, and
            early childhood community possible.
          </p>
          <WorkspaceArt scene="community" className="auth-campus" eager />
        </div>
        <span className="auth-footer">
          SCHOOL &nbsp; / &nbsp; EARLY CHILDHOOD &nbsp; / &nbsp; PARISH
        </span>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-form">
          <span className="small-icon">
            <KeyRound size={24} />
          </span>
          <p className="eyebrow">YOUR STJW WORKSPACE</p>
          <h2>
            {credentialChange ? "Make this account yours." : challenge
              ? "One more step."
              : setupToken
                ? "Make yourself at home."
                : "Welcome to your workday."}
          </h2>
          <p className="muted">
            {credentialChange ? "Choose a new password and PIN. Your temporary sign-in only opens this setup step." : challenge
              ? "Confirm it’s you with your authenticator app or a saved recovery code."
              : setupToken
                ? "Choose your private password to finish setting up your account."
                : mode === "pin" ? "Enter only your PIN to clock in, change jobs, take a break, or clock out."
                  : "Use your email and password to open your workspace and management tools."}
          </p>
          {!setupToken && !challenge && !credentialChange && (
            <div className="segmented" role="group" aria-label="Sign-in method">
              <button
                className={mode === "password" ? "selected" : ""}
                aria-pressed={mode === "password"}
                disabled={busy}
                onClick={() => { setMode("password"); setError(""); setFormRevision(value => value + 1); }}
              >
                Password
              </button>
              <button
                className={mode === "pin" ? "selected" : ""}
                aria-pressed={mode === "pin"}
                disabled={busy}
                onClick={() => { setMode("pin"); setError(""); setFormRevision(value => value + 1); }}
              >
                Quick PIN
              </button>
            </div>
          )}
          {notice && <p className="auth-completion-notice" role="status">{notice}</p>}
          {credentialChange ? <TemporaryCredentials challenge={credentialChange} onReturn={(text, isError = false) => {
            setCredentialChange(null); setChallenge(""); setRecovery(false); setFormRevision(value => value + 1);
            setError(isError ? text : ""); setNotice(isError ? "" : text);
          }} /> : <form key={formRevision} onSubmit={submit}>
            {challenge ? (
              <label>
                {recovery ? "Recovery code" : "Authenticator code"}
                <input
                  key={recovery ? "recovery" : "totp"}
                  name="code"
                  aria-label={recovery ? 'Recovery code' : 'Authenticator code'}
                  autoComplete="one-time-code"
                  inputMode={recovery ? "text" : "numeric"}
                  pattern={recovery ? "[A-Fa-f0-9-]{32,35}" : "[0-9]{6}"}
                  maxLength={recovery ? 35 : 6}
                  required
                  autoFocus
                />
                <small>
                  {recovery
                    ? "Each recovery code can be used once."
                    : "Enter the six-digit code in your app. Each code can be used once."}
                </small>
              </label>
            ) : setupToken ? (
              <label>
                New password
                <input
                  name="password"
                  type="password"
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                />
                <small>At least {MIN_PASSWORD_LENGTH} characters.</small>
              </label>
            ) : (
              <>
                {mode === "password" && <label>
                  Work email
                  <input
                    name="email"
                    type="email"
                    placeholder="you@stjw.org"
                    autoComplete="username"
                    defaultValue={email}
                    required
                  />
                </label>}
                <label>
                  {mode === "pin" ? "Your PIN" : "Password"}
                  <input
                    key={mode}
                    name="credential"
                    type="password"
                    inputMode={mode === "pin" ? "numeric" : undefined}
                    pattern={mode === "pin" ? "[0-9]{6,8}" : undefined}
                    minLength={mode === "pin" ? 6 : undefined}
                    maxLength={mode === "pin" ? 8 : 128}
                    autoComplete="current-password"
                    autoFocus={mode === "pin"}
                    required
                  />
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy
                ? "Signing in…"
                : challenge
                  ? "Verify & sign in"
                  : setupToken
                    ? "Set password & continue"
                    : "Sign in"}
              <ArrowRight size={18} />
            </button>
          </form>}
          {challenge && (
            <div className="mfa-signin-actions">
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => {
                  setRecovery(!recovery);
                  setError("");
                }}
              >
                {recovery ? "Use authenticator app" : "Use a recovery code"}
              </button>
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => {
                  setChallenge("");
                  setError("");
                  setRecovery(false);
                  if (setupToken) location.assign(location.pathname);
                }}
              >
                Start sign-in again
              </button>
            </div>
          )}
          {!credentialChange && <p className="auth-note">
            {mode === "pin" && !setupToken ? (
              <>
                <Clock3 size={17} />
                PIN sign-in opens only your time clock for five minutes. Use Password for management access.
              </>
            ) : (
              <>
                <ShieldCheck size={17} />
                Accounts are created by your organization. Ask your manager for
                a private setup link.
              </>
            )}
          </p>}
          <div className="auth-demo">
            DEMONSTRATION WORKSPACE <span>Synthetic records for testing</span>
          </div>
        </div>
      </section>
    </div>
  );
}
