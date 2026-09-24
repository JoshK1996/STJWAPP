import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  LayoutDashboard,
  Monitor,
  Moon,
  RotateCcw,
  Sun,
} from "lucide-react";
import {
  dashboardWidgets,
  normalizePreferences,
  preferencesSchema,
  type Preferences,
  type WidgetId,
} from "../shared/preferences";
import { applyAppearance, palettes } from "./appearance";
import { api, ApiError } from "./api";
import { WorkspaceArt } from "./WorkspaceArt";
import type { BrandingAccess } from './OrganizationBranding';
import NavigationOrderEditor, { NavigationPreferenceValue, navigationPreferenceLabels } from './NavigationOrderEditor';

export default function Personalization({
  me,
  notify,
  onChange,
  branding, reloadBranding, onSessionExpired, isSessionCurrent, onDirty,
}: BrandingAccess & {
  me: any;
  notify: (text: string, error?: boolean) => void;
  onChange: (preferences?: Preferences) => Promise<void>;
  onDirty: (value: boolean) => void;
}) {
  const saved = useRef(normalizePreferences(me.actor.preferences));
  const resetButton = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<Preferences>(saved.current);
  const [busy, setBusy] = useState(false);
  const [uncertainSave, setUncertainSave] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [observed, setObserved] = useState<Preferences | null>(null);
  const active = useRef(true), running = useRef(false), submitted = useRef<Preferences | null>(null), draftRef = useRef(draft);
  draftRef.current = draft;
  const actorId = me.actor.id;
  const owns = () => active.current && isSessionCurrent();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.current);
  useEffect(() => {
    if (!running.current && !submitted.current && JSON.stringify(draftRef.current) === JSON.stringify(saved.current)) {
      saved.current = normalizePreferences(me.actor.preferences);
      setDraft(saved.current);
    }
  }, [me.actor.preferences]);
  useEffect(() => { onDirty(dirty || busy || uncertainSave); return () => onDirty(false); }, [dirty, busy, uncertainSave, onDirty]);
  useEffect(() => {
    applyAppearance(draft);
    const system = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(draft);
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [draft]);
  useEffect(() => { active.current = true; return () => { active.current = false; if (isSessionCurrent()) applyAppearance(saved.current); }; }, [isSessionCurrent]);
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  function move(id: WidgetId, direction: number) {
    const order = [...draft.widgetOrder],
      index = order.indexOf(id),
      next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    change("widgetOrder", order);
  }
  function toggle(id: WidgetId) {
    if (draft.hiddenWidgets.includes(id))
      change(
        "hiddenWidgets",
        draft.hiddenWidgets.filter((x) => x !== id),
      );
    else if (draft.hiddenWidgets.length < dashboardWidgets.length - 1)
      change("hiddenWidgets", [...draft.hiddenWidgets, id]);
    else notify("Keep at least one dashboard card visible.", true);
  }
  async function save() {
    if (running.current || uncertainSave || !owns()) return;
    const body = preferencesSchema.parse(draft);
    running.current = true; submitted.current = body; setError(''); setStatus(''); setObserved(null);
    setBusy(true);
    try {
      const result = await api("/me/preferences", body, "PATCH");
      if (!owns()) return;
      saved.current = preferencesSchema.parse(result.preferences);
      submitted.current = null;
      setDraft(saved.current);
      setStatus('Your appearance, dashboard and navigation are saved to your account.');
      try { await onChange(saved.current); }
      catch (cause) { if (owns() && !accessLost(cause)) setError('Your preferences are saved, but account details could not refresh. No second save is needed.'); }
    } catch (error) {
      if (!owns() || accessLost(error)) return;
      if (!(error instanceof ApiError) || [408, 429].includes(error.status) || error.status >= 500) {
        setUncertainSave(true); setError('The save response was interrupted. Your preferences may already be saved. Check the account’s saved preferences before making another change. Leaving does not undo a save.');
      } else { submitted.current = null; setError(error.message); }
    } finally {
      if (owns()) { running.current = false; setBusy(false); }
    }
  }
  function accessLost(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status)) return false;
    submitted.current = null; setObserved(null); setUncertainSave(false); onDirty(false); onSessionExpired(); return true;
  }
  async function checkSaved() {
    if (running.current || !submitted.current || !owns()) return;
    running.current = true; setBusy(true); setError('');
    try {
      const current = await api('/me'); if (!owns()) return;
      if (current.actor.id !== actorId || current.actor.mode !== 'password') { onSessionExpired(); return; }
      const preferences = preferencesSchema.parse(current.actor.preferences);
      if (JSON.stringify(preferences) === JSON.stringify(submitted.current)) {
        saved.current = preferences; setDraft(preferences); submitted.current = null; setUncertainSave(false); setObserved(null);
        setStatus('The account currently has the preferences you submitted. No second save was sent.');
        try { await onChange(preferences); } catch (cause) { if (owns() && !accessLost(cause)) setError('Saved preferences were checked, but other account details could not refresh.'); }
      } else { setObserved(preferences); setStatus('The account’s current preferences differ from your submitted draft. Review both before choosing how to continue. This read does not establish which save happened first.'); }
    } catch (cause) { if (owns() && !accessLost(cause)) setError(cause instanceof ApiError ? cause.message : 'Saved preferences could not be checked. Try the read again; no new save has been sent.'); }
    finally { if (owns()) { running.current = false; setBusy(false); } }
  }
  function resolveDifferent(useCurrent: boolean) {
    if (!observed || running.current) return;
    saved.current = observed; if (useCurrent) setDraft(observed);
    submitted.current = null; setUncertainSave(false); setObserved(null); setError('');
    setStatus(useCurrent ? 'Using the account’s current saved preferences.' : 'Your draft is preserved. Review it, then explicitly save if you want to replace the account’s current preferences.');
    void onChange(observed).catch(cause => { if (owns() && !accessLost(cause)) setError('Account details could not refresh. Your reviewed draft remains here.'); });
  }
  return (
    <section
      className="personalization panel"
      aria-labelledby="personalization-heading"
    >
      <div className="personalization-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE, YOUR WAY</span>
          <h2 id="personalization-heading">Make yourself at home.</h2>
          <p>
            Preview changes as you choose. Save to use them wherever you sign
            in.
          </p>
        </div>
        <span className="personalization-icon">
          <LayoutDashboard size={26} />
        </span>
      </div>
      <fieldset className="personalization-edit-controls" disabled={busy || uncertainSave}><legend className="sr-only">Personal appearance, dashboard and navigation controls</legend><div className="personalization-body">
        <div className="appearance-options">
          <section className="organization-style-adoption" aria-label="Organization style starting point">
            <h3>A shared starting point</h3>
            {branding.status === 'loading' ? <p role="status">Loading organization style…</p> : branding.status === 'unavailable' ? <><p>Organization style is unavailable. Your personal preferences remain available.</p><button type="button" className="button secondary" onClick={() => void reloadBranding().catch(cause => { if (owns() && !accessLost(cause)) setError('Organization style could not be loaded.'); })}>Retry organization style</button></> : branding.current?.configured ? <><p>{branding.current.settings.displayName} · publication {branding.current.version}</p><p>Copy its palette, artwork and depth into this preview. Your other preferences stay as they are. Save explicitly to adopt it; later publications never change your saved choices automatically.</p><button type="button" className="button secondary" onClick={() => { const style = branding.current!.settings; setDraft(current => ({ ...current, accent: style.paletteId, artwork: style.artwork, depth: style.depth })); setStatus('Organization style copied into your unsaved preview. Review, save or discard.'); }}>Preview organization style</button></> : <p>No organization style has been published yet.</p>}
          </section>
          <fieldset className="preference-group">
            <legend>A starting point</legend>
            <p>Pick a visual direction, then make every detail your own.</p>
            <div className="visual-presets">
              <button
                className="preset-vivid"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    accent: "cobalt",
                    artwork: "full",
                    depth: true,
                  }))
                }
              >
                <span />
                <strong>Vivid studio</strong>
                <small>Color, art & dimension</small>
              </button>
              <button
                className="preset-warm"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    accent: "sunset",
                    artwork: "subtle",
                    depth: true,
                  }))
                }
              >
                <span />
                <strong>Warm community</strong>
                <small>Sunlit & expressive</small>
              </button>
              <button
                className="preset-quiet"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    accent: "slate",
                    artwork: "none",
                    depth: false,
                  }))
                }
              >
                <span />
                <strong>Quiet focus</strong>
                <small>Simple & spacious</small>
              </button>
            </div>
          </fieldset>
          <fieldset className="preference-group">
            <legend>Appearance</legend>
            <p>
              Use a light workspace, a dark workspace, or follow your device.
            </p>
            <div className="mode-options">
              {(
                [
                  { id: "light", label: "Light", Icon: Sun },
                  { id: "dark", label: "Dark", Icon: Moon },
                  { id: "system", label: "System", Icon: Monitor },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={draft.theme === id ? "selected" : ""}
                  aria-pressed={draft.theme === id}
                  onClick={() => change("theme", id)}
                  aria-label={`${label} appearance`}
                >
                  <Icon size={21} />
                  <strong>{label}</strong>
                  {draft.theme === id && <Check size={15} />}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="preference-group">
            <legend>Color theme</legend>
            <p>
              One consistent palette across your dashboard, forms, reports, and
              navigation.
            </p>
            <div className="palette-options">
              {palettes.map((palette) => (
                <button
                  type="button"
                  key={palette.id}
                  aria-label={`${palette.label} color theme`}
                  aria-pressed={draft.accent === palette.id}
                  className={draft.accent === palette.id ? "selected" : ""}
                  onClick={() => change("accent", palette.id)}
                >
                  <span
                    className="palette-swatch"
                    style={{ background: palette.color }}
                  >
                    {draft.accent === palette.id && <Check size={17} />}
                  </span>
                  <span>
                    <strong>{palette.label}</strong>
                    <small>{palette.description}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="custom-color-control">
              <label>
                Custom accent color
                <input
                  type="color"
                  aria-label="Custom accent color"
                  value={draft.customColor}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      customColor: event.target.value,
                      accent: "custom",
                    }))
                  }
                />
              </label>
              <div>
                <strong>{draft.customColor.toUpperCase()}</strong>
                <small>Text contrast adjusts automatically.</small>
              </div>
              <button
                className="button secondary small"
                aria-pressed={draft.accent === "custom"}
                onClick={() => change("accent", "custom")}
              >
                {draft.accent === "custom"
                  ? "Custom color selected"
                  : "Use my color"}
              </button>
            </div>
          </fieldset>
          <div className="preference-controls">
            <label>
              Illustrations
              <select
                aria-label="Illustrations"
                value={draft.artwork}
                onChange={(event) =>
                  change(
                    "artwork",
                    event.target.value as Preferences["artwork"],
                  )
                }
              >
                <option value="full">Full artwork</option>
                <option value="subtle">Subtle accents</option>
                <option value="none">No artwork</option>
              </select>
            </label>
            <label>
              Depth & interaction
              <select
                aria-label="Depth and interaction"
                value={String(draft.depth)}
                onChange={(event) =>
                  change("depth", event.target.value === "true")
                }
              >
                <option value="true">Dimensional & interactive</option>
                <option value="false">Flat & still</option>
              </select>
            </label>
            <label>
              Text size
              <select
                aria-label="Text size"
                value={draft.textSize}
                onChange={(e) =>
                  change("textSize", e.target.value as Preferences["textSize"])
                }
              >
                <option value="standard">Standard</option>
                <option value="large">Larger text</option>
              </select>
            </label>
            <label>
              Contrast
              <select
                aria-label="Contrast"
                value={draft.contrast}
                onChange={(e) =>
                  change("contrast", e.target.value as Preferences["contrast"])
                }
              >
                <option value="standard">Standard</option>
                <option value="high">Higher contrast</option>
              </select>
            </label>
            <label>
              Spacing
              <select
                aria-label="Spacing"
                value={String(draft.compact)}
                onChange={(e) => change("compact", e.target.value === "true")}
              >
                <option value="false">Comfortable</option>
                <option value="true">Compact</option>
              </select>
            </label>
            <label>
              Navigation
              <select
                aria-label="Navigation"
                value={draft.navigation}
                onChange={(e) =>
                  change(
                    "navigation",
                    e.target.value as Preferences["navigation"],
                  )
                }
              >
                <option value="full">Full sidebar</option>
                <option value="rail">Compact icon rail</option>
              </select>
            </label>
            <label>
              Card corners
              <select
                aria-label="Card corners"
                value={draft.corners}
                onChange={(e) =>
                  change("corners", e.target.value as Preferences["corners"])
                }
              >
                <option value="soft">Soft & rounded</option>
                <option value="crisp">Crisp & structured</option>
              </select>
            </label>
            <label>
              Open after sign-in
              <select
                aria-label="Open after sign-in"
                value={draft.home}
                onChange={(e) =>
                  change("home", e.target.value as Preferences["home"])
                }
              >
                <option value="overview">Overview</option>
                <option value="clock">My time clock</option>
                {me.permissions.report && (
                  <option value="reports">Reports</option>
                )}
              </select>
            </label>
          </div>
          <label className="check-label motion-option">
            <input
              type="checkbox"
              checked={draft.reducedMotion}
              onChange={(e) => change("reducedMotion", e.target.checked)}
            />
            Reduce motion
            <small>Device accessibility preferences are also respected.</small>
          </label>
        </div>
        <div className="dashboard-options">
          <div className="art-live-preview">
            <WorkspaceArt />
            <div>
              <span className="eyebrow">YOUR VISUAL PREVIEW</span>
              <strong>A brighter kind of workday.</strong>
              <small>Original artwork. Your colors. Your pace.</small>
            </div>
          </div>
          <div className="workspace-preview" aria-hidden="true">
            <div className="preview-sidebar">
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="preview-content">
              <span>YOUR WORKSPACE</span>
              <strong>A clear view of your day.</strong>
              <div className="preview-stats">
                <i />
                <i />
                <i />
              </div>
              <div className="preview-clock">
                <span />
                <span />
              </div>
              <div className="preview-panels">
                <i />
                <i />
              </div>
            </div>
          </div>
          <div className="dashboard-options-heading">
            <h3>Your overview</h3>
            <p>
              Show the cards you need and put them in the order that works for
              you.
            </p>
          </div>
          <div
            className="dashboard-presets"
            role="group"
            aria-label="Dashboard presets"
          >
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  widgetOrder: [
                    "metrics",
                    "clock",
                    "people",
                    "requests",
                    "hours",
                    "community",
                  ],
                  hiddenWidgets: [],
                }))
              }
            >
              All cards
            </button>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  widgetOrder: [
                    "clock",
                    "requests",
                    "hours",
                    "metrics",
                    "people",
                    "community",
                  ],
                  hiddenWidgets: ["people", "community"],
                }))
              }
            >
              My workday
            </button>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  widgetOrder: [
                    "metrics",
                    "people",
                    "requests",
                    "hours",
                    "clock",
                    "community",
                  ],
                  hiddenWidgets: ["community"],
                }))
              }
            >
              Team overview
            </button>
          </div>
          <ol className="widget-options">
            {draft.widgetOrder.map((id, index) => {
              const widget = dashboardWidgets.find((x) => x.id === id)!;
              return (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!draft.hiddenWidgets.includes(id)}
                      onChange={() => toggle(id)}
                    />
                    <span>
                      <strong>{widget.label}</strong>
                      <small>{widget.description}</small>
                    </span>
                  </label>
                  <div className="widget-order">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${widget.label} up`}
                      disabled={index === 0}
                      onClick={() => move(id, -1)}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${widget.label} down`}
                      disabled={index === draft.widgetOrder.length - 1}
                      onClick={() => move(id, 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <NavigationOrderEditor draft={draft} me={me} onChange={orders => setDraft(current => ({ ...current, ...orders }))}/>
      </fieldset>
      {(error || status || uncertainSave) && <div className="preferences-recovery">{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}{uncertainSave && <button type="button" className="button primary" disabled={busy} onClick={() => void checkSaved()}>{busy ? 'Checking…' : 'Check saved preferences'}</button>}{observed && <><details><summary>Compare your draft with current saved preferences</summary><p>Navigation lists show pages available to your account. Saved positions for other pages are preserved.</p><div className="branding-comparison"><table><thead><tr><th>Preference</th><th>Your draft</th><th>Currently saved</th></tr></thead><tbody>{Object.keys(observed).map(key => <tr key={key}><th scope="row">{key === 'workspaceNavOrder' || key === 'organizationNavOrder' ? navigationPreferenceLabels[key] : key}</th><td>{key === 'workspaceNavOrder' || key === 'organizationNavOrder' ? <NavigationPreferenceValue field={key} value={draft[key]} me={me}/> : String(draft[key as keyof Preferences])}</td><td>{key === 'workspaceNavOrder' || key === 'organizationNavOrder' ? <NavigationPreferenceValue field={key} value={observed[key]} me={me}/> : String(observed[key as keyof Preferences])}</td></tr>)}</tbody></table></div></details><button type="button" className="button secondary" disabled={busy} onClick={() => resolveDifferent(true)}>Use current saved preferences</button><button type="button" className="button secondary" disabled={busy} onClick={() => resolveDifferent(false)}>Keep my draft for review</button></>}</div>}
      <div className="personalization-actions">
        <span role="status">
          {dirty ? "Previewing unsaved changes" : "Saved to your account"}
        </span>
        <button
          ref={resetButton}
          type="button"
          className="text-link"
          disabled={busy || uncertainSave}
          onClick={() =>
            setDraft(normalizePreferences({ home: saved.current.home }))
          }
        >
          <RotateCcw size={15} />
          Reset to defaults
        </button>
        {dirty && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || uncertainSave}
            onClick={() => { setDraft(saved.current); resetButton.current?.focus(); }}
          >
            Discard changes
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={busy || uncertainSave || !dirty}
          onClick={() => void save()}
        >
          <Check size={17} />
          {busy ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </section>
  );
}
