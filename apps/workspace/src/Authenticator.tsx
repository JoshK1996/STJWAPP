import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, KeyRound, Download } from "lucide-react";
import { api } from "./api";
import { Badge, Panel } from "./components";
import "./authenticator.css";
type Status = {
  available: boolean;
  enabled: boolean;
  recoveryCodesRemaining: number;
};
type Enrollment = {
  id: string;
  secret: string;
  qrDataUrl: string;
  expiresAt: string;
};
export default function Authenticator({
  notify,
  onChange,
}: {
  notify: (text: string, error?: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [codes, setCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    setStatus(await api("/auth/mfa"));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function begin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      password = new FormData(form).get("password");
    await perform(async () => {
      setEnrollment(await api("/auth/mfa/enroll", { password }));
      form.reset();
    });
  }
  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get("code");
    await perform(async () => {
      const result = await api("/auth/mfa/confirm", {
        id: enrollment!.id,
        code,
      });
      setCodes(result.recoveryCodes);
      setEnrollment(null);
      await onChange();
      await refresh();
      notify("Authenticator enabled. Save your recovery codes now.");
    });
  }
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form),
      action =
        (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ??
        "recovery-codes";
    await perform(async () => {
      const result = await api("/auth/mfa/" + action, {
        password: f.get("password"),
        code: f.get("code"),
      });
      setCodes(result.recoveryCodes);
      form.reset();
      await onChange();
      await refresh();
      notify(
        action === "disable"
          ? "Authenticator disabled."
          : "New recovery codes are ready. Previous codes no longer work.",
      );
    });
  }
  function downloadCodes() {
    const content =
      "STJW account recovery codes\nKeep these private and separate from your password. Each code works once.\n\n" +
      codes.join("\n") +
      "\n";
    const url = URL.createObjectURL(
        new Blob([content], { type: "text/plain" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = "STJW-private-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Panel
      title="Authenticator protection"
      detail="Optional extra protection for password sign-in."
    >
      <div className="mfa-settings">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!status ? (
          <p>Loading authenticator settings…</p>
        ) : (
          <>
            <div className="mfa-status">
              <ShieldCheck size={22} />
              <Badge tone={status.enabled ? "good" : "warm"}>
                {status.enabled ? "Enabled" : "Not enabled"}
              </Badge>
              {status.enabled && (
                <span>
                  {status.recoveryCodesRemaining} recovery codes remaining
                </span>
              )}
            </div>
            <p>
              When enabled, password sign-in also asks for a code from your
              authenticator app. Quick PIN still opens only your time clock.
            </p>
            {codes.length > 0 ? (
              <section
                className="mfa-recovery"
                aria-label="Save your recovery codes"
              >
                <h3>Save these recovery codes</h3>
                <p>
                  You will only see this set once. Store it privately so you can
                  sign in if you lose access to your authenticator.
                </p>
                <ul>
                  {codes.map((code) => (
                    <li key={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ul>
                <div className="mfa-actions">
                  <button className="button primary" onClick={downloadCodes}>
                    <Download size={16} />
                    Download codes
                  </button>
                  <button className="button" onClick={() => setCodes([])}>
                    I saved my codes
                  </button>
                </div>
              </section>
            ) : enrollment ? (
              <form onSubmit={confirm}>
                <h3>Connect your authenticator</h3>
                <p>
                  Scan this QR code using an authenticator app, or enter the
                  setup key manually. Choose a time-based code. Setup expires in
                  ten minutes.
                </p>
                <div className="mfa-enrollment">
                  <img
                    src={enrollment.qrDataUrl}
                    width="240"
                    height="240"
                    alt="Private authenticator setup QR code"
                  />
                  <label>
                    Manual setup key
                    <code className="mfa-secret">{enrollment.secret}</code>
                    <small>STJW · six digits · changes every 30 seconds</small>
                  </label>
                </div>
                <label>
                  Authenticator code
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                  />
                </label>
                <p className="panel-note">
                  Enabling protection signs out other sessions and revokes your
                  API tokens. Save the recovery codes shown next.
                </p>
                <div className="mfa-actions">
                  <button className="button primary" disabled={busy}>
                    Verify & enable
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy}
                    onClick={() => setEnrollment(null)}
                  >
                    Cancel setup
                  </button>
                </div>
              </form>
            ) : status.enabled ? (
              <form onSubmit={change}>
                <p>
                  To replace recovery codes or disable protection, confirm your
                  password and enter a new authenticator code or an unused
                  recovery code.
                </p>
                <label>
                  Current password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </label>
                <label>
                  Authenticator or recovery code
                  <input
                    name="code"
                    autoComplete="one-time-code"
                    minLength={6}
                    maxLength={35}
                    required
                  />
                </label>
                <p className="panel-note">
                  Either change signs out other sessions and revokes API tokens.
                  Disabling also removes the authenticator and its recovery
                  codes.
                </p>
                <div className="mfa-actions">
                  <button
                    className="button"
                    value="recovery-codes"
                    disabled={busy}
                  >
                    <KeyRound size={16} />
                    Replace recovery codes
                  </button>
                  <button
                    className="button danger"
                    value="disable"
                    disabled={busy}
                  >
                    Disable authenticator
                  </button>
                </div>
              </form>
            ) : status.available ? (
              <form onSubmit={begin}>
                <label>
                  Confirm your current password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </label>
                <button className="button primary" disabled={busy}>
                  <ShieldCheck size={16} />
                  Set up authenticator
                </button>
              </form>
            ) : (
              <p className="panel-note">
                Authenticator setup is not available yet. Your administrator
                needs to finish configuring it.
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
