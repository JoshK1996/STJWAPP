import Organization from "./Organization";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Check,
  KeyRound,
  ShieldCheck,
  Plug,
  LockKeyhole,
  Copy,
  Plus,
} from "lucide-react";
import { api } from "./api";
import { Badge, Panel, Modal } from "./components";
import Personalization from "./Personalization";
import Authenticator from './Authenticator';
import OrganizationBranding, { type BrandingAccess } from './OrganizationBranding';
import type { Preferences } from '../shared/preferences';
export default function Settings({
  me,
  notify,
  onChange,
  branding, reloadBranding, onSessionExpired, isSessionCurrent, onDirty,
  appEntry,
}: BrandingAccess & {
  me: any;
  notify: (text: string, error?: boolean) => void;
  onChange: (preferences?: Preferences) => Promise<void>;
  onDirty: (value: boolean) => void;
  appEntry?: ReactNode;
}) {
  const [personalDirty, setPersonalDirty] = useState(false), [brandingDirty, setBrandingDirty] = useState(false);
  const personalChanged = useCallback((value: boolean) => setPersonalDirty(value), []);
  const brandingChanged = useCallback((value: boolean) => setBrandingDirty(value), []);
  useEffect(() => { onDirty(personalDirty || brandingDirty); return () => onDirty(false); }, [personalDirty, brandingDirty, onDirty]);
  const [busy, setBusy] = useState(false),
    [tokens, setTokens] = useState<any[]>([]),
    [secret, setSecret] = useState("");
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function refreshTokens() {
    if (me.permissions.owner) setTokens((await api("/tokens")).rows);
  }
  useEffect(() => {
    void refreshTokens().catch((e) => notify(e.message, true));
  }, []);
  async function pin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    await perform(async () => {
      await api("/auth/pin", {
        password: f.get("password"),
        pin: f.get("pin"),
      });
      form.reset();
      notify(
        "Your PIN is ready. Use Quick PIN at sign-in for time-clock-only access.",
      );
    });
  }
  async function createToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    await perform(async () => {
      const result = await api("/tokens", {
        name: f.get("name"),
        days: Number(f.get("days")),
        scopes: f.getAll("scopes"),
      });
      setSecret(result.token);
      form.reset();
      await refreshTokens();
    });
  }
  return (
    <>
      {appEntry && <Panel title="STJW on your device" detail="Add a Home Screen icon and check for the latest app improvements.">{appEntry}</Panel>}
      <Personalization me={me} notify={notify} onChange={onChange} branding={branding} reloadBranding={reloadBranding} onSessionExpired={onSessionExpired} isSessionCurrent={isSessionCurrent} onDirty={personalChanged} />
      {me.permissions.owner && <OrganizationBranding branding={branding} reloadBranding={reloadBranding} onSessionExpired={onSessionExpired} isSessionCurrent={isSessionCurrent} onDirty={brandingChanged} />}
      <Authenticator notify={notify} onChange={onChange}/>
      <div className="account-settings-row">
        <Panel
          title="Quick PIN sign-in"
          detail="A short session, dedicated to your time clock."
        >
          <form className="padded-form" onSubmit={pin}>
            <label>
              Confirm your password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              New PIN
              <input
                type="password"
                inputMode="numeric"
                name="pin"
                pattern="[0-9]{6,8}"
                minLength={6}
                maxLength={8}
                autoComplete="new-password"
                required
              />
              <small>Use 6–8 digits. Keep your PIN private.</small>
            </label>
            <p className="panel-note">
              PIN sessions expire after five minutes and can only view your
              clock and record your own punches. Administrative work requires
              your password.
            </p>
            <button className="button primary" disabled={busy}>
              <KeyRound size={16} />
              Save PIN
            </button>
          </form>
        </Panel>
      </div>
      <Panel
        title="Organization & access"
        detail="A shared structure with clear responsibilities."
      >
        <div className="settings-info">
          <div>
            <small>Organization</small>
            <strong>{me.organization.name}</strong>
          </div>
          <div>
            <small>Time zone</small>
            <strong>{me.organization.timezone}</strong>
          </div>
          <div>
            <small>Your access</small>
            <strong>{me.actor.role}</strong>
          </div>
          <div>
            <small>Environment</small>
            <Badge tone="warm">
              {me.organization.demo ? "Synthetic demonstration" : "Production"}
            </Badge>
          </div>
        </div>
        <p className="panel-note">
          Managers operate within their assigned communities. Accounts and jobs
          are assigned through People & jobs. Each subgroup requires its own
          explicit assignment. School-year settings are in School records.
        </p>
      </Panel>
      {["developer", "owner", "admin"].includes(me.actor.role) && <Organization timezone={me.organization.timezone} notify={notify} onChange={onChange}/>}
      <Panel
        title="Connections"
        detail="Each external service has its own authorization and review process."
      >
        <div className="connection-grid">
          {[
            ["Google Classroom", "Courses, rosters, and coursework"],
            ["Google Drive", "Authorized documents and attachments"],
            ["Google Calendar", "Shared calendars and event synchronization"],
            ["Gmail", "Reviewed messages and delivery tracking"],
          ].map(([name, detail]) => (
            <div key={name}>
              <span className="connection-icon">
                <Plug size={20} />
              </span>
              <strong>{name}</strong>
              <small>{detail}</small>
              <Badge>Not connected</Badge>
            </div>
          ))}
        </div>
        <p className="panel-note">
          These connectors are planned. School-owned Google Cloud credentials
          and approved OAuth scopes are required before connection.
        </p>
      </Panel>
      {me.permissions.owner && (
        <Panel
          title="Agent API access"
          detail="Named, expiring, read-only access for approved tools. Tokens inherit your current organization access."
        >
          <form className="token-form" onSubmit={createToken}>
            <label>
              Connection name
              <input
                name="name"
                minLength={2}
                maxLength={80}
                placeholder="Reporting assistant"
                required
              />
            </label>
            <label>
              Expires after
              <select name="days">
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
            </label>
            <fieldset>
              <legend>Permissions</legend>
              <label className="check-label">
                <input
                  type="checkbox"
                  name="scopes"
                  value="reports:read"
                  defaultChecked
                />
                Read reports
              </label>
              <label className="check-label">
                <input type="checkbox" name="scopes" value="staff:read" />
                Read staff directory
              </label>
            </fieldset>
            <button className="button primary" disabled={busy}>
              <Plus size={16} />
              Create token
            </button>
          </form>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Permissions</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.scopes.join(", ")}</td>
                    <td>{new Date(t.expires_at).toLocaleDateString()}</td>
                    <td>
                      {t.revoked_at
                        ? "Revoked"
                        : new Date(t.expires_at) < new Date()
                          ? "Expired"
                          : "Active"}
                    </td>
                    <td>
                      {!t.revoked_at && (
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await api(`/tokens/${t.id}/revoke`, {});
                              await refreshTokens();
                              notify("Token revoked.");
                            })
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-note">
            API base: <code>{location.origin}/api</code>. Use an Authorization:
            Bearer header. Current scopes support GET /reports, /reports/export,
            and /staff. Interactive ChatGPT/Claude connector setup and agent
            write approvals are future work.
          </p>
        </Panel>
      )}
      {secret && (
        <Modal
          title="Save your private API token"
          onClose={() => setSecret("")}
        >
          <p>
            This token is displayed once. Store it in your tool’s secure
            credential settings.
          </p>
          <input readOnly value={secret} aria-label="New API token" />
          <div className="dialog-actions">
            <button
              className="button primary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => notify("Token copied."))
                  .catch(() =>
                    notify("Select and copy the token manually.", true),
                  )
              }
            >
              <Copy size={16} />
              Copy token
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
