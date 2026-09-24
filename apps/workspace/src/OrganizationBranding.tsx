import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Church, Palette, RefreshCw } from 'lucide-react';
import {
  organizationBrandingHistorySchema, organizationBrandingReceiptSchema, publishOrganizationBrandingSchema,
  type BrandingSnapshot, type OrganizationBrandingCurrent, type OrganizationBrandingHistoryRow,
  type OrganizationBrandingReceipt, type OrganizationBrandingSettings, type PublishOrganizationBranding,
} from '../shared/organization-branding';
import { api, ApiError } from './api';
import { Modal } from './components';
import { palettes } from './appearance';
import './organization-branding.css';

export type BrandingState = { status: 'loading' | 'ready' | 'unavailable'; current: OrganizationBrandingCurrent | null; error: string };
export type BrandingAccess = {
  branding: BrandingState; reloadBranding: () => Promise<OrganizationBrandingCurrent | null>;
  onSessionExpired: () => void; isSessionCurrent: () => boolean;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const uncertain = (error: unknown) => !(error instanceof ApiError) || [408, 429].includes(error.status) || error.status >= 500;
const message = (error: unknown) => error instanceof ApiError ? error.message : 'The connection was interrupted. Please try again.';
const fields = [
  ['shortName', 'Short name'], ['displayName', 'Display name'], ['subtitle', 'Subtitle'],
  ['paletteId', 'Palette'], ['artwork', 'Artwork'], ['depth', 'Depth'],
] as const;
function settingText(settings: OrganizationBrandingSettings, key: typeof fields[number][0]) {
  if (key === 'paletteId') return palettes.find(palette => palette.id === settings.paletteId)?.label ?? settings.paletteId;
  if (key === 'depth') return settings.depth ? 'On' : 'Off';
  return settings[key] || 'No subtitle';
}
function Comparison({ before, after }: { before: OrganizationBrandingSettings; after: OrganizationBrandingSettings }) {
  return <div className="branding-comparison branding-setting-comparison" role="region" aria-label="Publication settings comparison" tabIndex={0}><table><caption>Published style and proposed style</caption><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>{fields.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{settingText(before, key)}</td><td>{settingText(after, key)}</td></tr>)}</tbody></table></div>;
}
function SnapshotDetails({ snapshot }: { snapshot: BrandingSnapshot }) {
  return <details className="branding-evidence"><summary>Exact publication evidence</summary><dl><dt>Version</dt><dd>{snapshot.version}</dd><dt>Settings SHA-256</dt><dd><code>{snapshot.settingsHash}</code></dd><dt>Published at (UTC)</dt><dd>{snapshot.updatedAt ?? 'Not published'}</dd></dl></details>;
}
/** This preview uses only fixed palette IDs and local assets. It never applies root preferences. */
function StylePreview({ settings, dark }: { settings: OrganizationBrandingSettings; dark: boolean }) {
  const color = palettes.find(palette => palette.id === settings.paletteId)!.color;
  return <div className={`branding-preview ${dark ? 'is-dark' : ''} ${settings.depth ? 'has-depth' : ''}`} style={{ '--branding-color': color } as CSSProperties} data-artwork-preview={settings.artwork} aria-label={`${dark ? 'Dark' : 'Light'} organization style preview`}>
    <div className="branding-preview-identity"><span className="branding-preview-mark"><Church size={23} /></span><span><strong>{settings.shortName || 'Short name'}</strong><small>COMMUNITY WORKSPACE</small></span></div>
    <h3>{settings.displayName || 'Display name'}</h3><p>{settings.subtitle}</p>
    <div className="branding-preview-scene">{settings.artwork !== 'none' && <img src="/art/school-front-640.webp" alt="" aria-hidden="true" />}<div><span>YOUR SHARED STARTING POINT</span><strong>A clear view of the day.</strong><p>Time, people and community, together.</p></div></div>
    <div className="branding-preview-cards" aria-hidden="true"><span>My time clock<i /></span><span>Community calendar<i /></span></div>
    <p className="branding-preview-caption">Preview only · Each person chooses whether to adopt this style.</p>
  </div>;
}

export default function OrganizationBranding({ branding, reloadBranding, onSessionExpired, isSessionCurrent, onDirty }: BrandingAccess & { onDirty: (value: boolean) => void }) {
  const [base, setBase] = useState<BrandingSnapshot | null>(branding.current);
  const [draft, setDraft] = useState<OrganizationBrandingSettings | null>(branding.current?.settings ?? null);
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dark, setDark] = useState(false), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [review, setReview] = useState<PublishOrganizationBranding | null>(null), [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false), [receipt, setReceipt] = useState<OrganizationBrandingReceipt | null>(null);
  const [history, setHistory] = useState<OrganizationBrandingHistoryRow[]>([]), [historyLoaded, setHistoryLoaded] = useState(false), [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const attempt = useRef<PublishOrganizationBranding | null>(null), active = useRef(true), running = useRef(false), generation = useRef(0);
  const dirty = Boolean(draft && base && (!same(draft, base.settings) || reason)) || pending || busy;
  const owns = (run: number) => active.current && generation.current === run && isSessionCurrent();
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (branding.current && !branding.current.allowedActions.publish) {
      generation.current++; attempt.current = null; setPending(false); setReview(null); setChecked(false);
      setBase(null); setDraft(null); setReason(''); setReceipt(null); setHistory([]); setHistoryLoaded(false); setHistoryCursor(null);
      setError('Owner access is required to prepare or view publication history.'); return;
    }
    if (branding.current && !pending && !busy && (!base || !dirty)) {
      setBase(branding.current); setDraft(branding.current.settings);
    }
  }, [branding.current, pending, busy, dirty, base]);
  function denied(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status)) return false;
    generation.current++; attempt.current = null; setPending(false); setReview(null); setChecked(false);
    setDraft(null); setBase(null); setReason(''); setReceipt(null); setHistory([]); setHistoryLoaded(false); setHistoryCursor(null);
    setError('Your access changed. Sign in again to continue.'); onDirty(false); onSessionExpired(); return true;
  }
  async function refreshCurrent() {
    if (running.current) return;
    running.current = true; setBusy(true); const run = generation.current;
    try { const current = await reloadBranding(); if (!owns(run) || !current) return; setBase(current); if (!draft) setDraft(current.settings); setNeedsRefresh(false); setReview(null); setChecked(false); setError(''); setNotice('Current publication loaded. Your draft is preserved; review it before publishing.'); }
    catch (cause) { if (owns(run) && !denied(cause)) setError(message(cause)); }
    finally { if (owns(run)) { running.current = false; setBusy(false); } }
  }
  function prepare() {
    if (!draft || !base || !branding.current?.allowedActions.publish || pending || needsRefresh || running.current) return;
    if (base.version !== branding.current.version) { setNeedsRefresh(true); setError('The shared style changed. Refresh the publication and review your draft again.'); return; }
    const parsed = publishOrganizationBrandingSchema.safeParse({ commandId: crypto.randomUUID(), expectedVersion: base.version, settings: draft, reason, reviewed: true });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' ')); return; }
    setDraft(parsed.data.settings); setReason(parsed.data.reason); setReview(parsed.data); setChecked(false); setError(''); setNotice('');
  }
  async function copyPublication(row: OrganizationBrandingHistoryRow) {
    if (running.current || pending || !branding.current?.allowedActions.publish) return;
    if (dirty && !window.confirm('Replace your unsaved organization style draft with this historical publication?')) return;
    running.current = true; setBusy(true); const run = generation.current;
    try {
      const current = await reloadBranding(); if (!owns(run) || !current) return;
      setBase(current); setDraft(row.after.settings); setReason(''); setReview(null); setChecked(false); setNeedsRefresh(false); setError('');
      setNotice(`Publication ${row.version} was copied into a new draft. Add a reason and review it against current version ${current.version}. Publishing creates a new history entry.`);
    } catch (cause) { if (owns(run) && !denied(cause)) setError(message(cause)); }
    finally { if (owns(run)) { running.current = false; setBusy(false); } }
  }
  async function publish() {
    if (running.current || (!attempt.current && (!review || !checked))) return;
    const body = attempt.current ?? review!; attempt.current = body;
    running.current = true; setBusy(true); setError(''); const run = generation.current;
    try {
      const result = organizationBrandingReceiptSchema.parse(await api('/organization/branding', body));
      if (!owns(run)) return;
      if (result.commandId !== body.commandId || result.beforeVersion !== body.expectedVersion || !same(result.snapshot.settings, body.settings)) throw new Error('Unexpected publication receipt');
      attempt.current = null; setPending(false); setReview(null); setChecked(false); setReceipt(result);
      setBase(result.snapshot); setDraft(result.snapshot.settings); setReason(''); setHistory([]); setHistoryLoaded(false); setHistoryCursor(null);
      setNotice(`Publication ${result.snapshot.version} is saved. Personal preferences have not changed.`);
      try { const current = await reloadBranding(); if (owns(run) && current) { setBase(current); setDraft(current.settings); } }
      catch (cause) { if (owns(run) && !denied(cause)) setError('The publication is saved, but the current workspace identity could not refresh. Refresh the publication to check the latest version.'); }
    } catch (cause) {
      if (!owns(run) || denied(cause)) return;
      if (uncertain(cause)) { setPending(true); setError(`${message(cause)} The publication may already be saved. Retry the same publication to retrieve its receipt. Leaving this screen discards retry details; it does not undo a publication.`); }
      else { attempt.current = null; setPending(false); setReview(null); setChecked(false); setNeedsRefresh(true); setError(`${message(cause)} Refresh the publication, then review your preserved draft.`); }
    } finally { if (owns(run)) { running.current = false; setBusy(false); } }
  }
  async function loadHistory(more = false) {
    if (running.current) return; running.current = true; setBusy(true); const run = generation.current; setError('');
    try {
      const result = organizationBrandingHistorySchema.parse(await api(`/organization/branding/history?limit=20${more && historyCursor ? `&beforeVersion=${historyCursor}` : ''}`));
      if (!owns(run)) return;
      setHistory(previous => more ? [...previous, ...result.rows] : result.rows); setHistoryCursor(result.nextBeforeVersion); setHistoryLoaded(true);
    } catch (cause) { if (owns(run) && !denied(cause)) setError(message(cause)); }
    finally { if (owns(run)) { running.current = false; setBusy(false); } }
  }
  const canPublish = branding.status === 'ready' && branding.current?.allowedActions.publish;
  const noChange = Boolean(base?.configured && draft && same(base.settings, draft));
  return <section className="panel organization-branding" aria-labelledby="organization-branding-heading">
    <div className="panel-heading"><div><span className="eyebrow">A SHARED IDENTITY</span><h2 id="organization-branding-heading">Organization style</h2><p>Publish a workspace name and a visual starting point. Each person keeps control of their own appearance.</p></div><Palette aria-hidden="true" /></div>
    <div className="branding-body">
      <p className="branding-boundary">This changes signed-in workspace presentation. Sign-in screens, time-clock-only PIN access, legal organization records and report identities stay separate.</p>
      <p role="status">{branding.status === 'loading' ? 'Loading organization style…' : branding.status === 'unavailable' ? 'Organization style is unavailable. This is not an unpublished style.' : branding.current?.configured ? `Current publication: version ${branding.current.version}` : 'No organization style has been published. The existing app presentation is shown.'}</p>
      {branding.error && <p role="alert">{branding.error}</p>}
      {error && <p className="branding-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {(needsRefresh || branding.status === 'unavailable' || receipt) && !pending && <button type="button" className="button secondary" disabled={busy} onClick={() => void refreshCurrent()}><RefreshCw size={16} />Refresh publication</button>}
      {pending && <button type="button" className="button primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Retrieving receipt…' : 'Retry same publication'}</button>}
      {draft && base && <>
        <div className="branding-editor-grid"><fieldset className="branding-fields" disabled={busy || pending || Boolean(review) || !canPublish}><legend>Workspace identity and style</legend>
          <label>Short name<input value={draft.shortName} maxLength={24} onChange={event => setDraft({ ...draft, shortName: event.target.value })} /><small>Up to 24 characters. Shown in navigation and the workspace footer.</small></label>
          <label>Display name<input value={draft.displayName} maxLength={120} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
          <label>Subtitle<input value={draft.subtitle} maxLength={120} onChange={event => setDraft({ ...draft, subtitle: event.target.value })} /><small>Optional; leave blank for no subtitle.</small></label>
          <label>Shared palette<select value={draft.paletteId} onChange={event => setDraft({ ...draft, paletteId: event.target.value as OrganizationBrandingSettings['paletteId'] })}>{palettes.map(palette => <option key={palette.id} value={palette.id}>{palette.label}</option>)}</select></label>
          <label>Artwork<select value={draft.artwork} onChange={event => setDraft({ ...draft, artwork: event.target.value as OrganizationBrandingSettings['artwork'] })}><option value="full">Full artwork</option><option value="subtle">Subtle artwork</option><option value="none">No artwork</option></select></label>
          <label className="branding-check"><input type="checkbox" checked={draft.depth} onChange={event => setDraft({ ...draft, depth: event.target.checked })} /><span>Use depth and dimension</span></label>
          <label>Why publish this change?<textarea value={reason} minLength={10} maxLength={1000} onChange={event => setReason(event.target.value)} /><small>10–1,000 characters. Saved with the publication history.</small></label>
        </fieldset><div className="branding-preview-column"><div className="branding-preview-mode" role="group" aria-label="Organization preview appearance"><button type="button" className="button secondary" aria-pressed={!dark} onClick={() => setDark(false)}>Light preview</button><button type="button" className="button secondary" aria-pressed={dark} onClick={() => setDark(true)}>Dark preview</button></div><StylePreview settings={draft} dark={dark} /><p className="branding-boundary">The preview is static. Reduced-motion, high-contrast and personal preferences remain under each user’s control.</p></div></div>
        {noChange && <p className="branding-boundary">These settings match the loaded publication. Change a setting before preparing another publication.</p>}
        <div className="branding-actions"><button type="button" className="button primary" disabled={busy || pending || needsRefresh || !canPublish || noChange} onClick={prepare}>Review publication</button><button type="button" className="button secondary" disabled={busy || pending || !dirty} onClick={() => { setDraft(base.settings); setReason(''); setReview(null); setError(''); }}>Discard draft</button></div>
      </>}
      {receipt && <section className="branding-receipt" aria-label="Saved publication receipt"><h3>Saved publication {receipt.snapshot.version}</h3><p>This is the receipt for your command. The current publication above may be newer.</p><SnapshotDetails snapshot={receipt.snapshot} /></section>}
      {branding.current?.allowedActions.history && <section className="branding-history"><h3>Publication history</h3><button type="button" className="button secondary" disabled={busy || pending} onClick={() => void loadHistory()}>Load publication history</button>{historyLoaded && history.length === 0 && <p>No publications recorded.</p>}{history.map(row => <details key={row.id}><summary>Version {row.version} · {row.actor.name} · {row.createdAt}</summary><p>{row.reason}</p><Comparison before={row.before.settings} after={row.after.settings} /><SnapshotDetails snapshot={row.after} /><button type="button" className="button secondary" disabled={busy || pending || !canPublish} onClick={() => void copyPublication(row)}>Use version {row.version} as a draft</button></details>)}{historyCursor && <button type="button" className="button secondary" disabled={busy || pending} onClick={() => void loadHistory(true)}>Load earlier publications</button>}</section>}
    </div>
    {review && base && <Modal title="Review organization publication" onClose={() => { if (!busy) { setReview(null); setChecked(false); } }}><div className="branding-review"><p>Publishing changes the shared workspace identity. No one’s personal palette, artwork or depth changes automatically.</p><Comparison before={base.settings} after={review.settings} /><p><strong>Reason:</strong> {review.reason}</p><p>Reviewed against version {review.expectedVersion}.</p>{error && <p role="alert">{error}</p>}<label className="branding-check"><input type="checkbox" checked={checked} disabled={busy || pending} onChange={event => setChecked(event.target.checked)} /><span>I reviewed the names, style and reason shown above.</span></label><div className="branding-actions"><button type="button" className="button primary" disabled={busy || (!pending && !checked)} onClick={() => void publish()}>{busy ? 'Publishing…' : pending ? 'Retry same publication' : 'Publish organization style'}</button></div></div></Modal>}
  </section>;
}
