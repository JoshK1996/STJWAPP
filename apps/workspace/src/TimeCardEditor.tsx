import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DateTime } from 'luxon';
import { ArrowRight, CalendarDays, Check, Coffee, Scissors, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { editRecordRows, moveRecordDate, proposedRecordSegments, recordDuration, recordInstant, recordTotals, splitRecordEntry, updateRecordBoundary, type EditTimeSegment, type RecordedSegment } from './time-record-editor';

const originalSegments = (detail: any): RecordedSegment[] => detail.segments.map((row: any) => ({ jobId: row.job_id, kind: row.kind, startedAt: row.started_at, endedAt: row.ended_at }));
type Attempt = { path: string; body: { shiftId: string; sourceRevision: number; commandId: string; reason: string; segments: RecordedSegment[] } };

export default function TimeCardEditor({ detail, zone, authorityKey, onClose, onSaved, onReload, onDenied, onPendingChange }: {
  detail: any; zone: string; authorityKey: string; onClose(): void; onSaved(immediate: boolean): Promise<void>;
  onReload(): Promise<any>; onDenied(error: unknown): void;
  onPendingChange?(pending: boolean): void;
}) {
  const [source, setSource] = useState(detail), [rows, setRows] = useState(() => editRecordRows(originalSegments(detail), zone));
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<Attempt | null>(null);
  const [stale, setStale] = useState(false), [advanced, setAdvanced] = useState(false), [moveDate, setMoveDate] = useState('');
  const mounted = useRef(true), currentAuthority = useRef(authorityKey), busyRef = useRef(false), attempt = useRef<Attempt | null>(null);
  currentAuthority.current = authorityKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onPendingChange?.(busy || Boolean(pending)); return () => onPendingChange?.(false); }, [busy, pending, onPendingChange]);
  const current = (key: string) => mounted.current && currentAuthority.current === key;
  const immediate = source.canAdjust === true, locked = busy || Boolean(pending);
  const original = useMemo(() => originalSegments(source), [source]);
  const before = useMemo(() => recordTotals(original), [original]);
  const preview = useMemo(() => { try { const segments = proposedRecordSegments(rows, zone); return { segments, totals: recordTotals(segments), error: '' }; } catch (cause) { return { segments: null, totals: null, error: (cause as Error).message }; } }, [rows, zone]);
  const altered = Boolean(reason || JSON.stringify(rows) !== JSON.stringify(editRecordRows(original, zone)));

  function close() {
    if (busyRef.current || attempt.current) return;
    if (altered && !window.confirm('Discard the unsaved changes to this time card?')) return;
    onClose();
  }
  function change(next: EditTimeSegment[]) { if (locked) return; setRows(next); setError(''); }
  function boundary(index: number, edge: 'start' | 'end', value: string, offset?: number) { change(updateRecordBoundary(rows, index, edge, value, offset)); }
  function split(index: number) {
    try { change(splitRecordEntry(rows, index, zone, crypto.randomUUID())); setAdvanced(true); }
    catch (cause) { setError((cause as Error).message); }
  }
  async function reload() {
    if (busyRef.current || attempt.current || !window.confirm('Load the current time card and replace your unsaved times? Your reason will be kept.')) return;
    const key = authorityKey; busyRef.current = true; setBusy(true); setError('');
    try { const next = await onReload(); if (!current(key)) return; setSource(next); setRows(editRecordRows(originalSegments(next), zone)); setStale(false); setMoveDate(''); }
    catch (cause) { if (current(key)) { onDenied(cause); setError((cause as Error).message); } }
    finally { if (current(key)) { busyRef.current = false; setBusy(false); } }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || stale) return;
    const key = authorityKey;
    let request = attempt.current;
    try {
      if (!request) {
        const segments = proposedRecordSegments(rows, zone);
        if (reason.trim().length < 10) throw Error('Add a reason of at least 10 characters so the history explains this change.');
        const unchanged = segments.length === original.length && segments.every((row, index) => row.jobId === original[index].jobId && row.kind === original[index].kind && recordInstant(row.startedAt) === recordInstant(original[index].startedAt) && recordInstant(row.endedAt!) === recordInstant(original[index].endedAt!));
        if (unchanged) throw Error('Change a time, job or break before saving.');
        request = { path: immediate ? `/time-records/${source.shift.id}/adjust` : '/time-corrections', body: { shiftId: source.shift.id, sourceRevision: source.shift.revision, commandId: crypto.randomUUID(), reason: reason.trim(), segments } };
        attempt.current = request; setPending(request);
      }
      busyRef.current = true; setBusy(true); setError('');
      await api(request.path, request.body);
      if (!current(key)) return;
      attempt.current = null; setPending(null);
      // A confirmed save is never retried because a subsequent refresh failed.
      void onSaved(immediate);
    } catch (cause) {
      if (!current(key)) return;
      if (cause instanceof ApiError && cause.status < 500) {
        attempt.current = null; setPending(null);
        if (cause.status === 409) setStale(true);
        if ([401, 403, 404].includes(cause.status)) onDenied(cause);
      }
      setError((cause as Error).message);
    } finally { if (current(key)) { busyRef.current = false; setBusy(false); } }
  }

  return <Modal title={immediate ? 'Edit time card' : 'Request a time-card correction'} onClose={close}>
    <form className="community-form time-card-editor" onSubmit={submit}>
      <div className="time-card-editor-person"><div><strong>{source.shift.employee_name}</strong><span>{immediate ? 'Changes take effect when you save.' : 'A different manager reviews your changes.'}</span></div><span className="time-card-revision">Revision {source.shift.revision}</span></div>
      <p className="time-card-help">Dates and times use <strong>{zone.replaceAll('_', ' ')}</strong>. Work excludes recorded breaks.</p>
      <fieldset className="time-card-basic" disabled={locked}>
        <RecordTimeField name="Clock-in date and time" value={rows[0].start} offset={rows[0].startOffset} zone={zone} change={(value, offset) => boundary(0, 'start', value, offset)} />
        <RecordTimeField name="Clock-out date and time" value={rows.at(-1)!.end} offset={rows.at(-1)!.endOffset} zone={zone} change={(value, offset) => boundary(rows.length - 1, 'end', value, offset)} />
      </fieldset>
      <div className="time-card-before-after" aria-label="Before and after totals" aria-live="polite">
        <div><span>Work before</span><strong>{recordDuration(before.work)}</strong></div><ArrowRight aria-hidden="true" size={20}/><div><span>Work after</span><strong>{preview.totals ? recordDuration(preview.totals.work) : 'Check times'}</strong></div>
        <p><Coffee size={16}/><span>Breaks: {recordDuration(before.break)} → {preview.totals ? recordDuration(preview.totals.break) : 'Check times'}</span></p>
      </div>
      {preview.error && <p className="time-card-warning" role="status">{preview.error}</p>}
      <details className="time-card-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
        <summary>Jobs, breaks &amp; moving dates <span>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span></summary>
        <p className="time-card-help">Each entry meets the next. Changing a boundary moves the adjoining boundary too. Split an entry to add a break or job change.</p>
        <fieldset disabled={locked} className="time-card-move"><label><CalendarDays size={16}/>Move the whole card to a date<input type="date" value={moveDate} onChange={event => setMoveDate(event.target.value)}/></label><button className="button secondary" type="button" disabled={!moveDate} onClick={() => { try { change(moveRecordDate(rows, moveDate)); } catch (cause) { setError((cause as Error).message); } }}>Move all entries</button><p>Keeps local clock times and overnight dates. Review work totals after moving across a daylight-saving change.</p></fieldset>
        <div className="time-edit-list">{rows.map((row, index) => <fieldset key={row.key} disabled={locked}>
          <legend>Entry {index + 1}</legend><div className="community-form-grid">
            <label>Type<select aria-label={`Entry ${index + 1} type`} value={row.kind} onChange={event => change(rows.map((item, at) => at === index ? { ...item, kind: event.target.value } : item))}><option value="work">Work</option><option value="break">Break</option></select></label>
            <label>Job and community<select aria-label={`Entry ${index + 1} job`} value={row.jobId} onChange={event => change(rows.map((item, at) => at === index ? { ...item, jobId: event.target.value } : item))}>{source.jobs.map((job: any) => <option key={job.id} value={job.id}>{job.title} · {job.unit_name}{job.active === false ? ' (inactive)' : ''}</option>)}</select></label>
          </div>
          <RecordTimeField name={`Entry ${index + 1} start`} value={row.start} offset={row.startOffset} zone={zone} change={(value, offset) => boundary(index, 'start', value, offset)}/>
          <RecordTimeField name={`Entry ${index + 1} end`} value={row.end} offset={row.endOffset} zone={zone} change={(value, offset) => boundary(index, 'end', value, offset)}/>
          <div className="time-edit-actions"><button type="button" className="button secondary" disabled={rows.length >= 200} onClick={() => split(index)}><Scissors size={16}/>Split entry</button>{rows.length > 1 && <button type="button" className="button secondary" onClick={() => { const next = rows.filter((_, at) => at !== index); if (index > 0) next[index - 1] = { ...next[index - 1], end: row.end, endOffset: row.endOffset, rawEnd: row.rawEnd }; else next[0] = { ...next[0], start: row.start, startOffset: row.startOffset, rawStart: row.rawStart }; change(next); }}><Trash2 size={16}/>Merge into {index ? 'previous' : 'next'}</button>}</div>
        </fieldset>)}</div>
      </details>
      <label>Reason for this change<textarea value={reason} disabled={locked} onChange={event => setReason(event.target.value)} rows={2} required minLength={10} maxLength={2000} placeholder="For example: corrected a missed clock-out after checking the shift."/></label>
      <p className="time-card-help"><Check size={16}/>Original times, your reason and the editor’s name stay in the audit history.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {pending && !busy && <p className="time-card-warning" role="status">The save result could not be confirmed. Retry this same save to recover its result. Your changes remain locked until confirmed.</p>}
      {stale && <div className="time-card-warning"><p>This card changed, or the correction conflicts with current records. Load the current card and review the dates, jobs and hours before saving again.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reload()}>Load current time card</button></div>}
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={close} disabled={locked}>Cancel</button><button className="button primary" disabled={busy || stale || (!pending && Boolean(preview.error))}>{busy ? 'Saving…' : pending ? 'Retry same save' : immediate ? 'Save changes' : 'Submit for review'}</button></div>
      <details className="segment-exact"><summary>Timestamp precision</summary><p>Untouched boundaries keep their exact original timestamps. Newly edited boundaries use milliseconds. Exact evidence remains in each card’s history.</p></details>
    </form>
  </Modal>;
}

export function RecordTimeField({ name, value, offset, zone, change }: { name: string; value: string; offset: number; zone: string; change(value: string, offset?: number): void }) {
  const time = DateTime.fromISO(value, { zone }), options = time.isValid ? time.getPossibleOffsets() : [];
  return <div className="time-edit-time"><label>{name}<input type="datetime-local" step="0.001" required value={value} onChange={event => change(event.target.value)}/></label>{options.length > 1 && <label>Repeated clock time<select aria-label={`${name} occurrence`} value={options.some(item => item.offset === offset) ? offset : ''} onChange={event => change(value, Number(event.target.value))}><option value="" disabled>Choose occurrence</option>{options.map(item => <option key={item.offset} value={item.offset}>{item.toFormat('ZZZZ (ZZ)')}</option>)}</select></label>}</div>;
}
