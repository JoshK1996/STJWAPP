import { useEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { Clock3, Pencil } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import TimeCardEditor from './TimeCardEditor';
import { recordDuration } from './time-record-editor';

export type OverviewCardsTarget = { userId?: string; name?: string; start: string; end: string; unitId?: string; openNow?: boolean };

export default function OverviewTimeCards({ target, me, onClose, onChanged, onDirty, onPendingChange, notify }: {
  target: OverviewCardsTarget; me: any; onClose(): void; onChanged(): void;
  onDirty?(dirty: boolean): void; onPendingChange?(pending: boolean): void; notify(message: string, error?: boolean): void;
}) {
  const zone = me.organization.timezone;
  const authority = [me.actor.org_id, me.actor.id, me.actor.mode, me.actor.role, me.actor.csrf, JSON.stringify(me.actor.unit_ids ?? [])].join('|');
  const [start, setStart] = useState(target.start), [end, setEnd] = useState(target.end), [search, setSearch] = useState('');
  const [query, setQuery] = useState({ start: target.start, end: target.end, search: '', status: target.openNow ? 'open' : 'all', offset: 0 });
  const [list, setList] = useState<any>(null), [detail, setDetail] = useState<any>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [opening, setOpening] = useState(false), [denied, setDenied] = useState(false), [refresh, setRefresh] = useState(0);
  const mounted = useRef(true), request = useRef(0), autoOpen = useRef(Boolean(target.openNow));
  const key = JSON.stringify([authority, query, refresh]), currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => { onDirty?.(Boolean(detail)); return () => onDirty?.(false); }, [Boolean(detail), onDirty]);
  function failure(cause: unknown) {
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      request.current++; setDenied(true); setList(null); setDetail(null); setOpening(false);
      setError('These time cards are no longer available with your current access. Refresh your session before continuing.');
    } else setError((cause as Error).message);
  }
  async function open(id: string, captured = key) {
    if (opening || detail || denied) return;
    const sequence = ++request.current; setOpening(true); setError('');
    try {
      const result = await api('/time-records/' + id);
      if (!mounted.current || currentKey.current !== captured || sequence !== request.current) return;
      if (!result.canAdjust && !result.canPropose) { setError('Your current access allows viewing this card, but not changing it.'); return; }
      setDetail(result);
    } catch (cause) { if (mounted.current && currentKey.current === captured && sequence === request.current) failure(cause); }
    finally { if (mounted.current && currentKey.current === captured && sequence === request.current) setOpening(false); }
  }
  useEffect(() => {
    if (denied) return;
    const controller = new AbortController(), captured = key;
    setList(null); setLoading(true); setError('');
    const params = new URLSearchParams({ ...query, offset: String(query.offset), ...(target.userId ? { userId: target.userId } : {}), ...(target.unitId ? { unitId: target.unitId } : {}) });
    void api('/time-records?' + params, undefined, 'GET', controller.signal).then(result => {
      if (!mounted.current || controller.signal.aborted || currentKey.current !== captured) return;
      setList(result);
      if (autoOpen.current) { autoOpen.current = false; if (result.rows.length === 1) void open(result.rows[0].id, captured); }
    }).catch(cause => { if (!controller.signal.aborted && mounted.current && currentKey.current === captured) failure(cause); })
      .finally(() => { if (!controller.signal.aborted && mounted.current && currentKey.current === captured) setLoading(false); });
    return () => controller.abort();
  }, [key, denied]);
  async function reloadDetail() {
    const captured = key, result = await api('/time-records/' + detail.shift.id);
    if (!mounted.current || currentKey.current !== captured) throw Error('The selected time-card view changed.');
    return result;
  }
  async function saved(immediate: boolean) {
    setDetail(null); setRefresh(value => value + 1); onChanged();
    notify(immediate ? 'Time card saved. Overview is refreshing with the corrected hours.' : 'Correction submitted for a different manager to review.');
  }
  const stamp = (value: string) => DateTime.fromISO(value).setZone(zone).toFormat('ccc, MMM d, yyyy · h:mm a');
  return <>
    <Modal title={target.name ? target.name + ' · time cards' : 'Edit employee time cards'} onClose={() => { if (!detail && !opening) onClose(); }}>
      <div className="overview-time-cards">
        <p className="time-card-help">Correct clock-in, clock-out, dates, jobs and breaks here. You’ll stay on Overview. Times use <strong>{zone.replaceAll('_', ' ')}</strong>.</p>
        {!denied && <form className="overview-card-filters" onSubmit={event => { event.preventDefault(); autoOpen.current = false; setQuery({ start, end, search: search.trim(), status: 'all', offset: 0 }); }}>
          <fieldset disabled={opening || Boolean(detail)}>
            <label>From<input aria-label="Time cards from date" type="date" value={start} required onChange={event => setStart(event.target.value)} /></label>
            <label>Through<input aria-label="Time cards through date" type="date" value={end} required min={start} onChange={event => setEnd(event.target.value)} /></label>
            {!target.userId && <label>Find employee<input type="search" value={search} placeholder="Employee name" onChange={event => setSearch(event.target.value)} /></label>}
            <button type="submit" className="button secondary">Show time cards</button>
          </fieldset>
        </form>}
        {error && <div role="alert"><p className="form-error">{error}</p>{!denied&&<button type="button" className="button secondary" onClick={()=>setRefresh(value=>value+1)}>Refresh time cards</button>}</div>}
        {denied ? <button type="button" className="button secondary" onClick={() => window.location.reload()}>Refresh access</button> : <>
          {query.status === 'open' && <p>Showing the current open card. <button type="button" disabled={opening} onClick={() => setQuery(value => ({ ...value, status: 'all', offset: 0 }))}>Include completed cards</button></p>}
          <div className="overview-card-list" aria-label="Employee time cards" aria-busy={loading || opening}>
            {loading ? <p role="status">Loading time cards…</p> : list?.rows.map((row: any) => <article className="overview-time-card" key={row.id} data-shift-id={row.id}>
              <div><strong>{row.employee_name}</strong><span>{row.ended_at ? 'Completed shift' : 'On the clock'}{row.pending_count > 0 ? ' · Correction awaiting review' : ''}</span></div>
              <dl><div><dt>Clock-in</dt><dd>{stamp(row.started_at)}</dd></div><div><dt>Clock-out</dt><dd>{row.ended_at ? stamp(row.ended_at) : 'Still clocked in'}</dd></div></dl>
              <p>{row.jobs.map((job: any) => job.title + ' · ' + job.unitName).join(' / ')}</p>
              <div className="overview-card-action"><span><Clock3 size={15} />{recordDuration(row.workMicroseconds)} worked</span><button type="button" className="button primary" aria-disabled={opening} onClick={() => void open(row.id)}><Pencil size={15} />{row.canAdjust ? 'Edit time card' : 'Request correction'}</button></div>
            </article>)}
            {!loading && list && !list.rows.length && <p>No time cards match these dates and your permitted communities. Choose another date range to find an earlier card.</p>}
          </div>
          {opening && <p role="status">Opening the full time-card editor…</p>}
          <div className="dialog-actions">{query.offset>0&&<button type="button" className="button secondary" disabled={loading || opening} onClick={() => setQuery(value => ({ ...value, offset: Math.max(0, value.offset - 100) }))}>Previous cards</button>}{list?.hasMore && <button type="button" className="button secondary" disabled={loading || opening} onClick={() => setQuery(value => ({ ...value, offset: value.offset + 100 }))}>Next cards</button>}<button type="button" className="button secondary" disabled={opening} onClick={onClose}>Done</button></div>
        </>}
      </div>
    </Modal>
    {detail && <TimeCardEditor detail={detail} zone={zone} authorityKey={authority} onClose={() => setDetail(null)} onSaved={saved} onReload={reloadDetail} onDenied={failure} onPendingChange={onPendingChange} />}
  </>;
}
