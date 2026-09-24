import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DateTime } from "luxon";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  History,
  Plus,
  Scissors,
  Trash2,
  X,
  Search, SlidersHorizontal, Users, Coffee, CalendarDays, Wallet, ArrowUpRight, BriefcaseBusiness,
} from "lucide-react";
import { api, ApiError } from "./api";
import { Badge, Empty, Modal, Panel } from "./components";
import TimeAdjustments, { type AdjustmentTarget } from "./TimeAdjustments";
type Notice = (message: string, error?: boolean) => void;
type Segment = {
  jobId: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
};
const localFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS";
const local = (value: string, zone: string) =>
  DateTime.fromISO(value).setZone(zone).toFormat(localFormat);
const label = (value: string, zone: string) =>
  DateTime.fromISO(value).setZone(zone).toFormat("LLL d, h:mm:ss a ZZZZ");
const conciseDate = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat("ccc, LLL d");
const conciseTime = (value: string, zone: string) => DateTime.fromISO(value).setZone(zone).toFormat("h:mm a");
// Source precision stays intact; only the human-readable label omits fractions.
const instantMicros = (value: string) => BigInt(Date.parse(value)) * 1000n + BigInt((value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "").padEnd(6, "0").slice(3, 6) || "0");
const spanMicros = (start: string, end: string | null) => end ? instantMicros(end) - instantMicros(start) : null;
const durationLabel = (micros: bigint | null) => {
  if (micros === null) return "In progress";
  const seconds = micros > 0n ? micros / 1000000n : 0n, h = seconds / 3600n, m = seconds % 3600n / 60n, s = seconds % 60n;
  if (!seconds && micros > 0n) return "Less than 1 sec";
  return h ? h + "h " + m + "m" + (s ? " " + s + "s" : "") : m ? m + "m" + (s ? " " + s + "s" : "") : s + "s";
};
const totals = (segments: Segment[]) =>
  segments.reduce(
    (sum, segment) => {
      sum[segment.kind === "work" ? "work" : "break"] += spanMicros(segment.startedAt, segment.endedAt) ?? 0n;
      return sum;
    },
    { work: 0n, break: 0n },
  );
export default function TimeRecords({
  me,
  notify,
  onChanged,
  onDirty,
  onNavigatePayroll,
}: {
  me: any;
  notify: Notice;
  onChanged: () => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  onNavigatePayroll?: () => void;
}) {
  const zone = me.organization.timezone,
    today = DateTime.now().setZone(zone),
    [start, setStart] = useState(today.startOf("week").toISODate()!),
    [end, setEnd] = useState(today.toISODate()!),
    [mine, setMine] = useState(!me.permissions.report),
    [offset, setOffset] = useState(0),
    [list, setList] = useState<any>(null),
    [detailData, setDetail] = useState<any>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [editor, setEditor] = useState(false),
    [review, setReview] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const [search,setSearch]=useState(""),[status,setStatus]=useState("all"),[sort,setSort]=useState("newest");
  const [listKey,setListKey]=useState(""),[detailKey,setDetailKey]=useState(""),[detailLoading,setDetailLoading]=useState(false);
  const [view, setView] = useState<"records" | "open" | "requests">("records"),
    [adjustmentTarget, setAdjustmentTarget] = useState<AdjustmentTarget | null>(null),
    [adjustmentDirty, setAdjustmentDirty] = useState(false);
  const dirty=adjustmentDirty||editor||Boolean(review);
  const authorityKey=[me.actor.org_id,me.actor.id,me.actor.mode,me.actor.role,me.actor.csrf,me.permissions.report,me.permissions.manage,JSON.stringify(me.actor.unit_ids??[])].join("|");
  const contextKey=[authorityKey,start,end,mine,offset].join("|");
  const latestContext=useRef(contextKey),requestId=useRef(0),mounted=useRef(true),previousAuthority=useRef(authorityKey),detailHeading=useRef<HTMLDivElement>(null);
  latestContext.current=contextKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestId.current++;};},[]);
  useEffect(()=>{if(previousAuthority.current!==authorityKey){previousAuthority.current=authorityKey;requestId.current++;setList(null);setDetail(null);setEditor(false);setReview(null);setAdjustmentTarget(null);setAdjustmentDirty(false);setSearch("");setError("");}},[authorityKey]);
  const visibleList=listKey===contextKey?list:null,detail=detailKey===contextKey?detailData:null;
  const pageRows:any[]=visibleList?.rows??[];
  const shownRows=useMemo(()=>pageRows.filter(row=>(!search.trim()||String(row.employee_name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))&&(status==="all"||status==="open"&&!row.ended_at||status==="completed"&&row.ended_at||status==="pending"&&row.pending_corrections>0||status==="revised"&&row.revision>1)).sort((a,b)=>sort==="name"?String(a.employee_name).localeCompare(String(b.employee_name))||b.started_at.localeCompare(a.started_at):sort==="pending"?b.pending_corrections-a.pending_corrections||b.started_at.localeCompare(a.started_at):sort==="oldest"?a.started_at.localeCompare(b.started_at):b.started_at.localeCompare(a.started_at)),[visibleList,search,status,sort]);
  const summary=pageRows.reduce((result,row)=>({open:result.open+Number(!row.ended_at),pending:result.pending+Number(row.pending_corrections??0),span:result.span+(spanMicros(row.started_at,row.ended_at)??0n)}),{open:0,pending:0,span:0n});
  function privateFailure(value:unknown){if(value instanceof ApiError&&[401,403,404].includes(value.status)){requestId.current++;setList(null);setDetail(null);setDetailLoading(false);setEditor(false);setReview(null);setAdjustmentTarget(null);setAdjustmentDirty(false);setSearch("");}}
  function changeView(next:typeof view){if(dirty){notify("Finish or close your current review before changing views.",true);return;}requestId.current++;setDetailLoading(false);setView(next);}
  useEffect(() => { onDirty?.(adjustmentDirty || editor || Boolean(review)); return () => onDirty?.(false); }, [adjustmentDirty, editor, review, onDirty]);
  const load = useCallback(async () => {
    const query = new URLSearchParams({
      start,
      end,
      offset: String(offset),
      ...(mine ? { userId: me.actor.id } : {}),
    });
    return await api("/time-records?" + query);
  }, [start, end, offset, mine, me.actor.id, authorityKey]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    const key=contextKey;requestId.current++;setDetailLoading(false);
    void load()
      .then((result) => {
        if (current&&latestContext.current===key){setList(result);setListKey(key);}
      })
      .catch((e) => {
        if (current&&latestContext.current===key){privateFailure(e);setError(e.message);}
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [load]);
  async function open(id: string) {
    if(dirty)return;
    const request=++requestId.current,key=contextKey;
    setDetailLoading(true);
    setError("");
    try {
      const result=await api("/time-records/" + id);
      if(!mounted.current||request!==requestId.current||latestContext.current!==key)return;
      setDetail(result);setDetailKey(key);
      requestAnimationFrame(()=>detailHeading.current?.focus());
    } catch (e) {
      if(mounted.current&&request===requestId.current&&latestContext.current===key){privateFailure(e);setError((e as Error).message);}
    } finally {
      if(mounted.current&&request===requestId.current&&latestContext.current===key)setDetailLoading(false);
    }
  }
  async function refresh() {
    const key=contextKey,request=++requestId.current;
    try {
      if (detail) {
        const result=await api("/time-records/"+detail.shift.id);
        if(!mounted.current||latestContext.current!==key||request!==requestId.current)return;
        setDetail(result);setDetailKey(key);
      }
      const next=await load();if(!mounted.current||latestContext.current!==key||request!==requestId.current)return;
      setList(next);setListKey(key);
      await onChanged();
    }catch(error){
      if(mounted.current&&latestContext.current===key&&request===requestId.current)privateFailure(error);
      throw error;
    }
  }
  async function decide(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const key=contextKey;setBusy(true);
    setError("");
    try {
      const form = new FormData(e.currentTarget);
      await api("/time-corrections/" + review.row.id + "/review", {
        version: review.row.version,
        status: review.status,
        note: form.get("note"),
      });
      if(!mounted.current||latestContext.current!==key)return;
      setReview(null);
      await refresh();
      notify(
        review.status === "approved"
          ? "Correction applied. Recorded-hours reports now use the reviewed revision."
          : "Correction declined. Recorded time is unchanged.",
      );
    } catch (e) {
      if(mounted.current&&latestContext.current===key){privateFailure(e);setError((e as Error).message);}
    } finally {
      setBusy(false);
    }
  }
  async function cancel(row: any) {
    const key=contextKey;setBusy(true);
    setError("");
    try {
      await api("/time-corrections/" + row.id + "/cancel", {
        version: row.version,
      });
      if(!mounted.current||latestContext.current!==key)return;
      await refresh();
      notify("Correction request cancelled.");
    } catch (e) {
      if(mounted.current&&latestContext.current===key){privateFailure(e);setError((e as Error).message);}
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="time-records-module">
      <header className="records-hero"><div><span className="records-eyebrow"><Clock3 size={15}/> TIME & ATTENDANCE</span><h2>A clearer view of every shift.</h2><p>Find recorded time, follow each job and break, and review changes in one place.</p></div><div className="records-hero-art" aria-hidden="true"><div><Clock3 size={30}/><i/><i/><i/></div><span><Check size={18}/></span></div>{onNavigatePayroll&&<button type="button" className="button records-payroll" onClick={onNavigatePayroll} disabled={dirty||busy}><Wallet size={18}/>Open payroll<ArrowUpRight size={16}/></button>}</header>
      <TimeAdjustments me={me} view={view} onView={changeView} target={adjustmentTarget} onTargetConsumed={() => setAdjustmentTarget(null)} onChanged={refresh} onDirty={setAdjustmentDirty} notify={notify} />
      {error && !editor && !review && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "records" && (detail ? (
        <>
          <div className="records-detail-nav" ref={detailHeading} tabIndex={-1}><button className="text-link" disabled={dirty||busy} onClick={() => {requestId.current++;setDetail(null);setDetailLoading(false);}}>
            <ArrowLeft size={16} />
            Back to time records
          </button><span><CalendarDays size={15}/>{conciseDate(detail.shift.started_at,zone)} · {zone.replaceAll("_"," ")}</span></div>
          <Panel
            title={detail.shift.employee_name}
            detail={`${conciseTime(detail.shift.started_at, zone)} → ${detail.shift.ended_at?conciseTime(detail.shift.ended_at,zone):"Still clocked in"} · ${detail.shift.ended_at ? "Completed shift" : "Open shift"}`}
            action={
              detail.canPropose ? (
                <button
                  className="button primary small"
                  onClick={() => setEditor(true)}
                >
                  <Plus size={16} />
                  Propose correction
                </button>
              ) : !detail.shift.ended_at && (me.permissions.manage || detail.shift.user_id === me.actor.id) ? (
                <button type="button" className="button secondary small" onClick={() => setAdjustmentTarget({ kind: "close_open_shift", shiftId: detail.shift.id })}>Request reviewed clock-out</button>
              ) : undefined
            }
          >
            <div className="records-detail-stats"><div><Clock3 size={19}/><span>Shift span<strong>{durationLabel(spanMicros(detail.shift.started_at,detail.shift.ended_at))}</strong><small>Includes breaks</small></span></div><div><BriefcaseBusiness size={19}/><span>Recorded entries<strong>{detail.segments.length}</strong><small>Jobs and breaks</small></span></div><div><History size={19}/><span>Review history<strong>{detail.corrections.length}</strong><small>Preserved proposals</small></span></div></div>
            <div className="time-record-summary">
              <Badge tone={detail.shift.revision > 1 ? "warm" : "neutral"}>
                Revision {detail.shift.revision}
              </Badge>
              <p>
                {detail.shift.ended_at
                  ? "Original entries and reviewed changes stay in the history below."
                  : "This shift is currently open. A reviewed clock-out request leaves the clock running until independently approved."}
              </p>
            </div>
            <SegmentList
              segments={detail.segments.map((row: any) => ({
                jobId: row.job_id,
                kind: row.kind,
                startedAt: row.started_at,
                endedAt: row.ended_at,
              }))}
              jobs={detail.jobs}
              zone={zone}
            />
          </Panel>
          <Panel
            title="Corrections & review history"
            detail="A different manager must review a proposal before it changes recorded hours."
          >
            {detail.corrections.length ? (
              <div className="correction-list">
                {detail.corrections.map((row: any) => (
                  <article key={row.id}>
                    <div className="correction-heading">
                      <div>
                        <strong>{row.proposer_name}</strong>
                        <p>
                          {label(row.created_at, zone)} · Based on revision{" "}
                          {row.source_revision}
                        </p>
                      </div>
                      <Badge
                        tone={
                          row.status === "approved"
                            ? "green"
                            : row.status === "pending"
                              ? "warm"
                              : "neutral"
                        }
                      >
                        {row.status}
                      </Badge>
                    </div>
                    <p className="correction-reason">{row.reason}</p>
                    <CorrectionComparison
                      row={row}
                      jobs={detail.jobs}
                      zone={zone}
                    />
                    {row.reviewed_at && (
                      <p className="correction-review-note">
                        <strong>{row.reviewer_name}</strong> ·{" "}
                        {label(row.reviewed_at, zone)}
                        <br />
                        {row.review_note}
                      </p>
                    )}
                    {row.status === "pending" && (
                      <div className="dialog-actions">
                        {row.proposed_by === me.actor.id && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void cancel(row)}
                          >
                            Cancel my proposal
                          </button>
                        )}
                        {me.permissions.manage &&
                          row.proposed_by !== me.actor.id &&
                          row.user_id !== me.actor.id && (
                            <>
                              <button
                                className="button secondary"
                                onClick={() => {
                                  setError("");
                                  setReview({ row, status: "declined" });
                                }}
                              >
                                <X size={16} />
                                Decline
                              </button>
                              <button
                                className="button primary"
                                disabled={
                                  row.source_revision !== detail.shift.revision
                                }
                                onClick={() => {
                                  setError("");
                                  setReview({ row, status: "approved" });
                                }}
                              >
                                <Check size={16} />
                                Review & apply
                              </button>
                            </>
                          )}
                        {row.source_revision !== detail.shift.revision && (
                          <p className="error">
                            This proposal is stale. Cancel or decline it, then
                            start from the current revision.
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                title="No corrections to this shift"
                detail="Recorded entries remain unchanged until a separate manager approves a proposal."
              />
            )}
          </Panel>
        </>
      ) : (
        <>
<section className="records-workbench" aria-label="Find time records">
            <div className="records-range-heading"><span><SlidersHorizontal size={17}/> Choose your records</span><small>{zone.replaceAll("_"," ")}</small></div>
            <div className="records-range-row"><div className="time-record-filters">
              <label>From<input type="date" value={start} disabled={dirty||busy} onChange={e=>{setStart(e.target.value);setOffset(0);}}/></label>
              <label>Through<input type="date" value={end} disabled={dirty||busy} onChange={e=>{setEnd(e.target.value);setOffset(0);}}/></label>
              {me.permissions.report&&<label>People<select aria-label="Time record people" value={mine?"mine":"team"} disabled={dirty||busy} onChange={e=>{setMine(e.target.value==="mine");setOffset(0);}}><option value="team">My permitted team</option><option value="mine">My records</option></select></label>}
            </div><div className="records-date-shortcuts"><button type="button" disabled={dirty||busy} onClick={()=>{setStart(today.toISODate()!);setEnd(today.toISODate()!);setOffset(0);}}>Today</button><button type="button" disabled={dirty||busy} onClick={()=>{setStart(today.startOf("week").toISODate()!);setEnd(today.toISODate()!);setOffset(0);}}>This week</button><button type="button" disabled={dirty||busy} onClick={()=>{setStart(today.startOf("month").toISODate()!);setEnd(today.toISODate()!);setOffset(0);}}>This month</button></div></div>
          </section>
          <div className="records-page-stats" aria-label="Summary of loaded page">
            <article><span className="records-stat-icon"><Users size={21}/></span><div><span>Loaded shifts</span><strong>{loading?"—":pageRows.length}</strong></div></article>
            <article><span className="records-stat-icon mint"><Clock3 size={21}/></span><div><span>Still on the clock</span><strong>{loading?"—":summary.open}</strong></div></article>
            <article><span className="records-stat-icon peach"><History size={21}/></span><div><span>Pending corrections</span><strong>{loading?"—":summary.pending}</strong></div></article>
            <article><span className="records-stat-icon blue"><CalendarDays size={21}/></span><div><span>Completed shift span</span><strong className="records-duration">{loading?"—":durationLabel(summary.span)}</strong><small>Includes breaks</small></div></article>
          </div>
          <Panel title="Shift explorer" detail="Summary, search, filters and sorting cover only this loaded page, not every record in the date range.">
            <div className="records-local-tools"><label className="records-search"><Search size={17}/><input aria-label="Search loaded time records" type="search" placeholder="Find a person on this page…" value={search} disabled={dirty||busy} onChange={e=>setSearch(e.target.value)}/></label><label>Status<select aria-label="Filter loaded time records" value={status} onChange={e=>setStatus(e.target.value)} disabled={dirty||busy}><option value="all">All shifts</option><option value="open">On the clock</option><option value="completed">Completed</option><option value="pending">Awaiting correction review</option><option value="revised">Previously revised</option></select></label><label>Sort<select aria-label="Sort loaded time records" value={sort} onChange={e=>setSort(e.target.value)} disabled={dirty||busy}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Employee name</option><option value="pending">Pending review first</option></select></label></div>
            <div className="records-result-count" role="status">{loading?"Loading recorded shifts…":detailLoading?"Opening shift details…":shownRows.length+" of "+pageRows.length+" loaded shifts shown"}{(search||status!=="all")&&<button type="button" className="text-link" onClick={()=>{setSearch("");setStatus("all");}} disabled={dirty||busy}>Clear page filters</button>}</div>
            <div className="time-record-list" aria-busy={loading||detailLoading}>
              {shownRows.map((row:any)=><button key={row.id} className={"time-record-card "+(!row.ended_at?"record-is-open":"")} onClick={()=>void open(row.id)} disabled={loading||detailLoading||dirty||busy}>
                <div className="record-date-tile"><strong>{DateTime.fromISO(row.started_at).setZone(zone).toFormat("dd")}</strong><span>{DateTime.fromISO(row.started_at).setZone(zone).toFormat("LLL")}</span></div>
                <div className="record-person"><strong>{row.employee_name}</strong><p>{conciseDate(row.started_at,zone)}</p><div className="record-clock-range"><span>{conciseTime(row.started_at,zone)}</span><i aria-hidden="true"/><span>{row.ended_at?conciseTime(row.ended_at,zone):"On the clock"}</span></div></div>
                <div className="record-span"><strong>{durationLabel(spanMicros(row.started_at,row.ended_at))}</strong><small>{row.ended_at?"Span · includes breaks":"Current open shift"}</small></div>
                <div className="time-record-tags">{row.pending_corrections>0&&<Badge tone="warm">{row.pending_corrections} pending</Badge>}{row.revision>1&&<Badge>Revision {row.revision}</Badge>}<span className="record-open-arrow"><ArrowUpRight size={18}/></span></div>
              </button>)}
            </div>
            {!shownRows.length&&<Empty title={loading?"Loading time records…":pageRows.length?"No matches on this page":"No shifts in this range"} detail={pageRows.length?"Change or clear the page filters to see these loaded records.":"Choose another date range. Missing shifts can be proposed from the request view above."}/>}
            <div className="mail-pagination records-pagination"><button className="button secondary small" disabled={offset===0||loading||dirty||busy} onClick={()=>setOffset(value=>Math.max(0,value-100))}><ArrowLeft size={15}/>Previous page</button><span>{pageRows.length?"Loaded records "+(offset+1)+"–"+(offset+pageRows.length):"No loaded records"}{visibleList?.hasMore&&<small>More records on the next page</small>}</span><button className="button secondary small" disabled={!visibleList?.hasMore||loading||dirty||busy} onClick={()=>setOffset(value=>value+100)}>Next page<ArrowRight size={15}/></button></div>
          </Panel>
        </>
      ))}
      {editor && detail && (
        <CorrectionEditor
          detail={detail}
          zone={zone}
          onClose={() => setEditor(false)}
          onSaved={async () => {
            setEditor(false);
            await refresh();
            notify("Correction submitted for a separate manager to review.");
          }}
        />
      )}
      {review && detail && (
        <Modal
          title={
            review.status === "approved"
              ? "Review and apply correction"
              : "Decline correction"
          }
          onClose={() => {if(!busy)setReview(null);}}
        >
          <form className="community-form" onSubmit={decide}>
            <p>
              {review.status === "approved"
                ? "Applying this proposal changes recorded work and break totals immediately. Previous entries remain available in history."
                : "The proposed changes will not be applied."}
            </p>
            <CorrectionComparison
              row={review.row}
              jobs={detail.jobs}
              zone={zone}
            />
            <label>
              Review note
              <textarea
                name="note"
                required
                minLength={10}
                maxLength={2000}
                rows={3}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setReview(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : review.status === "approved"
                    ? "Apply reviewed correction"
                    : "Record decline"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function SegmentList({
  segments,
  jobs,
  zone,
}: {
  segments: Segment[];
  jobs: any[];
  zone: string;
}) {
  return (
    <div className="time-segments" aria-label="Recorded shift timeline">
      {segments.map((segment, index) => (
        <div key={index} className={"time-segment-event "+(segment.kind==="break"?"segment-break":"segment-work")}>
          <span className="segment-timeline-marker" aria-hidden="true">{segment.kind==="break"?<Coffee size={18}/>:<BriefcaseBusiness size={18}/>}</span>
          <div className="segment-event-content">
            <small className="segment-event-label">{segment.kind==="break"?"RECORDED BREAK":"RECORDED WORK"} · ENTRY {index+1}</small>
            <strong>
              {jobs.find((job) => job.id === segment.jobId)?.title ??
                "Recorded job"}
            </strong>
            <p>
              {conciseDate(segment.startedAt,zone)} · {conciseTime(segment.startedAt, zone)} →{" "}
              {segment.endedAt
                ? (conciseDate(segment.startedAt,zone)!==conciseDate(segment.endedAt,zone)?conciseDate(segment.endedAt,zone)+" · ":"")+conciseTime(segment.endedAt, zone)
                : "Now — still open"}
            </p>
            <details className="segment-exact"><summary>Exact recorded times</summary><p>Start: <code>{segment.startedAt}</code><br/>End: <code>{segment.endedAt??"Still open"}</code>{segment.endedAt&&<><br/>Exact duration: <code>{spanMicros(segment.startedAt,segment.endedAt)?.toString()} microseconds</code></>}</p></details>
          </div>
          <span>
            {durationLabel(spanMicros(segment.startedAt,segment.endedAt))}
          </span>
        </div>
      ))}
    </div>
  );
}
function CorrectionComparison({
  row,
  jobs,
  zone,
}: {
  row: any;
  jobs: any[];
  zone: string;
}) {
  const before = totals(row.original.segments),
    after = totals(row.proposed);
  return (
    <details className="correction-comparison">
      <summary>
        <History size={15} />
        {durationLabel(before.work)} → {durationLabel(after.work)} work ·{" "}
        {durationLabel(before.break)} → {durationLabel(after.break)} break
      </summary>
      <div className="correction-versions">
        <section>
          <h3>Before — revision {row.source_revision}</h3>
          <SegmentList
            segments={row.original.segments}
            jobs={jobs}
            zone={zone}
          />
        </section>
        <section>
          <h3>Proposed</h3>
          <SegmentList segments={row.proposed} jobs={jobs} zone={zone} />
        </section>
      </div>
    </details>
  );
}
type EditSegment = {
  key: string;
  jobId: string;
  kind: string;
  start: string;
  end: string;
  startOffset: number;
  endOffset: number;
  rawStart?: string;
  rawEnd?: string;
};
function resolveTime(value: string, zone: string, offset: number) {
  const time = DateTime.fromISO(value, { zone });
  if (
    !time.isValid ||
    time.toFormat(localFormat) !==
      DateTime.fromISO(value, { zone: "UTC" }).toFormat(localFormat)
  )
    throw Error("This local time does not exist in the school timezone.");
  const options = time.getPossibleOffsets();
  if (options.length > 1) {
    const selected = options.find((option) => option.offset === offset);
    if (!selected)
      throw Error(
        "Choose the daylight or standard-time occurrence for this repeated time.",
      );
    return selected.toUTC().toISO()!;
  }
  return time.toUTC().toISO()!;
}
function CorrectionEditor({
  detail,
  zone,
  onClose,
  onSaved,
}: {
  detail: any;
  zone: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<EditSegment[]>(() =>
      detail.segments.map((row: any) => ({
        key: crypto.randomUUID(),
        jobId: row.job_id,
        kind: row.kind,
        start: local(row.started_at, zone),
        end: local(row.ended_at, zone),
        startOffset: DateTime.fromISO(row.started_at).setZone(zone).offset,
        endOffset: DateTime.fromISO(row.ended_at).setZone(zone).offset,
        rawStart: row.started_at,
        rawEnd: row.ended_at,
      })),
    ),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [commandId, setCommandId] = useState(() => crypto.randomUUID());
  function changed(next: EditSegment[]) {
    setRows(next);
    setCommandId(crypto.randomUUID());
  }
  function time(
    index: number,
    edge: "start" | "end",
    value: string,
    offset?: number,
  ) {
    changed(
      rows.map((row, i) => {
        const next = { ...row };
        if (i === index) {
          next[edge] = value;
          next[edge === "start" ? "rawStart" : "rawEnd"] = undefined;
          next[edge === "start" ? "startOffset" : "endOffset"] = offset ?? NaN;
        }
        if (edge === "start" && i === index - 1) {
          next.end = value;
          next.rawEnd = undefined;
          next.endOffset = offset ?? NaN;
        }
        if (edge === "end" && i === index + 1) {
          next.start = value;
          next.rawStart = undefined;
          next.startOffset = offset ?? NaN;
        }
        return next;
      }),
    );
  }
  function split(index: number) {
    try {
      const row = rows[index],
        start = Date.parse(resolveTime(row.start, zone, row.startOffset)),
        end = Date.parse(resolveTime(row.end, zone, row.endOffset));
      if (end - start < 2)
        throw Error("Choose a longer entry before splitting it.");
      const middle = new Date(Math.floor((start + end) / 2)).toISOString(),
        midLocal = local(middle, zone),
        midOffset = DateTime.fromISO(middle).setZone(zone).offset;
      changed(
        rows.flatMap((item, i) =>
          i === index
            ? [
                { ...item, end: midLocal, endOffset: midOffset, rawEnd: undefined },
                {
                  ...item,
                  key: crypto.randomUUID(),
                  start: midLocal,
                  startOffset: midOffset,
                  rawStart: undefined,
                },
              ]
            : [item],
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const segments = rows.map((row) => ({
        jobId: row.jobId,
        kind: row.kind,
        startedAt: row.rawStart ?? resolveTime(row.start, zone, row.startOffset),
        endedAt: row.rawEnd ?? resolveTime(row.end, zone, row.endOffset),
      }));
      await api("/time-corrections", {
        shiftId: detail.shift.id,
        sourceRevision: detail.shift.revision,
        commandId,
        reason,
        segments,
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Propose a time correction" onClose={()=>{if(!busy)onClose();}}>
      <form className="community-form" onSubmit={submit}>
        <p>
          Times use <strong>{zone}</strong>. Adjust an entry’s end to move the
          next start with it. Split an entry to add a missed break or job
          change, then choose its type.
        </p>
        <details>
          <summary>Original timestamp precision</summary>
          <p>Untouched time fields retain these exact UTC values, including when only a job or type changes. Editing a time uses millisecond precision.</p>
          {detail.segments.map((segment: any, index: number) => <p key={index}>Entry {index + 1}: <code>{segment.started_at}</code> to <code>{segment.ended_at}</code></p>)}
        </details>
        <div className="time-edit-list">
          {rows.map((row, index) => (
            <fieldset key={row.key} disabled={busy}>
              <legend>Entry {index + 1}</legend>
              <div className="community-form-grid">
                <label>
                  Type
                  <select
                    aria-label={"Entry " + (index + 1) + " type"}
                    value={row.kind}
                    onChange={(e) =>
                      changed(
                        rows.map((item, i) =>
                          i === index
                            ? { ...item, kind: e.target.value }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="work">Work</option>
                    <option value="break">Break</option>
                  </select>
                </label>
                <label>
                  Job
                  <select
                    aria-label={"Entry " + (index + 1) + " job"}
                    value={row.jobId}
                    onChange={(e) =>
                      changed(
                        rows.map((item, i) =>
                          i === index
                            ? { ...item, jobId: e.target.value }
                            : item,
                        ),
                      )
                    }
                  >
                    {detail.jobs.map((job: any) => (
                      <option key={job.id} value={job.id}>
                        {job.title} · {job.unit_name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <TimeField
                name={"Entry " + (index + 1) + " start"}
                value={row.start}
                offset={row.startOffset}
                zone={zone}
                change={(value, offset) => time(index, "start", value, offset)}
              />
              <TimeField
                name={"Entry " + (index + 1) + " end"}
                value={row.end}
                offset={row.endOffset}
                zone={zone}
                change={(value, offset) => time(index, "end", value, offset)}
              />
              <div className="time-edit-actions">
                <button
                  type="button"
                  className="text-link"
                  disabled={rows.length >= 200}
                  onClick={() => split(index)}
                >
                  <Scissors size={14} />
                  Split entry
                </button>
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      const next = rows.filter((_, i) => i !== index);
                      if (index > 0)
                        next[index - 1] = {
                          ...next[index - 1],
                          end: row.end,
                          endOffset: row.endOffset,
                          rawEnd: row.rawEnd,
                        };
                      else
                        next[0] = {
                          ...next[0],
                          start: row.start,
                          startOffset: row.startOffset,
                          rawStart: row.rawStart,
                        };
                      changed(next);
                    }}
                  >
                    <Trash2 size={14} />
                    Merge into {index ? "previous" : "next"}
                  </button>
                )}
              </div>
            </fieldset>
          ))}
        </div>
        <label>
          Reason for correction
          <textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setCommandId(crypto.randomUUID());
            }}
            rows={3}
            required
            minLength={10}
            maxLength={2000}
            disabled={busy}
          />
        </label>
        <p className="muted">
          Submitting saves a proposal. A separate manager reviews it before
          recorded hours change.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Submitting…" : "Submit correction proposal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TimeField({
  name,
  value,
  offset,
  zone,
  change,
}: {
  name: string;
  value: string;
  offset: number;
  zone: string;
  change: (value: string, offset?: number) => void;
}) {
  const time = DateTime.fromISO(value, { zone }),
    options = time.isValid ? time.getPossibleOffsets() : [];
  return (
    <div className="time-edit-time">
      <label>
        {name}
        <input
          type="datetime-local"
          step="0.001"
          required
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      </label>
      {options.length > 1 && (
        <label>
          Repeated clock time
          <select
            aria-label={name + " occurrence"}
            value={options.some((item) => item.offset === offset) ? offset : ""}
            onChange={(e) => change(value, Number(e.target.value))}
          >
            <option value="" disabled>
              Choose occurrence
            </option>
            {options.map((item) => (
              <option key={item.offset} value={item.offset}>
                {item.toFormat("ZZZZ (ZZ)")}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
