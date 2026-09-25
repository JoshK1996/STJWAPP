import type { Database, Row } from './db';
import { canReport, orgWide, requireCondition, type Actor } from './security';
import { reportBounds } from './reports';
import { timeRecordsQuery } from '../shared/time-records';
import { canonicalTimeJson, currentTimeActor, preciseTimeSql, timeJobs, timeMicroseconds, timeNow, timeTransaction } from './time-record-access';
import { recheckReportSession } from './report-source-access';

// Visibility is proved for the whole current card before loading facets, totals,
// search candidates or pages. A mixed-community card is never partially exposed.
const visible = `s.org_id=$1 AND s.started_at<$3 AND (coalesce(s.ended_at,'infinity'::timestamptz)>$2 OR (s.ended_at=s.started_at AND s.started_at>=$2))
 AND EXISTS(SELECT 1 FROM segments g WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision)
 AND (s.user_id=$4 OR ($5::boolean AND ($6::boolean OR NOT EXISTS(
 SELECT 1 FROM segments g LEFT JOIN jobs j ON j.org_id=g.org_id AND j.id=g.job_id
 WHERE g.org_id=s.org_id AND g.shift_id=s.id AND g.revision=s.revision AND (j.id IS NULL OR NOT j.unit_id=ANY($7::uuid[]))))))`;
const pendingVisible = `(c.user_id=$4 OR ($5::boolean AND ($6::boolean OR (
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(c.original#>'{scope,unitIds}','[]'::jsonb)) u(id) WHERE NOT u.id::uuid=ANY($7::uuid[]))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((c.original->'segments')||c.proposed) g LEFT JOIN jobs j ON j.org_id=c.org_id AND j.id=(g->>'jobId')::uuid WHERE j.id IS NULL OR NOT j.unit_id=ANY($7::uuid[]))))))`;
const pendingAdjustmentVisible = `(r.user_id=$4 OR ($5::boolean AND ($6::boolean OR (
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.scope_snapshot->'unitIds') u(id) WHERE NOT u.id::uuid=ANY($7::uuid[]))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.scope_snapshot->'jobIds') ref(id) LEFT JOIN jobs j ON j.org_id=r.org_id AND j.id=ref.id::uuid WHERE j.id IS NULL OR NOT j.unit_id=ANY($7::uuid[]))))))`;
const unique = (values: string[]) => [...new Set(values)].sort();
const directRole = (actor: Actor) => ['developer', 'owner', 'admin'].includes(actor.role);
type Total = {work: bigint; rest: bigint};
const zero = (): Total => ({work: 0n, rest: 0n});
const durations = (total: Total) => ({workMicroseconds: total.work.toString(), breakMicroseconds: total.rest.toString()});
const add = (total: Total, kind: string, value: bigint) => { if (kind === 'work') total.work += value; else total.rest += value; };
const duration = (start: bigint, end: bigint) => end > start ? end - start : 0n;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const jobIdentity = (job: Row) => ({jobId: job.id, title: job.title, unitId: job.unit_id, unitName: job.unit_name});

export async function listTimeRecords(db: Database, supplied: Actor, sessionHash: string, raw: unknown) {
  const input = timeRecordsQuery.parse(raw);
  const prepared = await timeTransaction(db, async tx => {
    const actor = await currentTimeActor(tx, supplied, sessionHash);
    const organization = (await tx.query('SELECT timezone FROM organizations WHERE id=$1', [actor.org_id])).rows[0];
    const bounds = reportBounds({...input, group: 'day'}, organization.timezone), observedAt = await timeNow(tx);
    const args = [actor.org_id, bounds.start.toJSDate(), bounds.end.toJSDate(), actor.id, canReport(actor), orgWide(actor), actor.unit_ids];
    const shifts = (await tx.query(`SELECT s.*,${preciseTimeSql('s.started_at')} AS started_at,${preciseTimeSql('s.ended_at')} AS ended_at,
      u.name AS employee_name,u.active AS employee_active,
      (SELECT count(*)::int FROM time_corrections c WHERE c.org_id=s.org_id AND c.shift_id=s.id AND c.status='pending' AND ${pendingVisible}) AS pending_corrections,
      (SELECT count(*)::int FROM time_adjustment_requests r WHERE r.org_id=s.org_id AND r.source_shift_id=s.id AND r.status='pending' AND ${pendingAdjustmentVisible}) AS pending_adjustments
      FROM shifts s JOIN users u ON u.org_id=s.org_id AND u.id=s.user_id WHERE ${visible} ORDER BY s.started_at DESC,s.id LIMIT 10001`, args)).rows;
    requireCondition(shifts.length <= 10000, 422, 'This time-card view exceeds 10,000 cards. Choose a shorter date range.');
    const segments = (await tx.query(`SELECT g.id,g.shift_id,g.job_id,g.kind,${preciseTimeSql('g.started_at')} AS started_at,${preciseTimeSql('g.ended_at')} AS ended_at
      FROM segments g JOIN shifts s ON s.org_id=g.org_id AND s.id=g.shift_id AND s.revision=g.revision
      WHERE s.org_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY g.shift_id,g.started_at,g.ended_at,g.id LIMIT 20001`, [actor.org_id, shifts.map(row => row.id)])).rows;
    requireCondition(segments.length <= 20000, 422, 'This time-card view exceeds 20,000 time segments. Choose a shorter date range.');
    // Pending proposals can refer to former or proposed jobs absent from the
    // current card. Their visibility proof also needs a fresh publication check.
    const pendingJobs = (await tx.query(`SELECT DISTINCT (g->>'jobId')::uuid AS id FROM time_corrections c
      JOIN shifts s ON s.org_id=c.org_id AND s.id=c.shift_id
      CROSS JOIN LATERAL jsonb_array_elements((c.original->'segments')||c.proposed) g
      WHERE ${visible} AND c.status='pending' AND ${pendingVisible}
      UNION SELECT DISTINCT ref.id::uuid AS id FROM time_adjustment_requests r
      JOIN shifts s ON s.org_id=r.org_id AND s.id=r.source_shift_id
      CROSS JOIN LATERAL jsonb_array_elements_text(r.scope_snapshot->'jobIds') ref(id)
      WHERE ${visible} AND r.status='pending' AND ${pendingAdjustmentVisible} LIMIT 20001`,args)).rows;
    requireCondition(pendingJobs.length <= 20000,422,'This time-card view exceeds the supported pending-job evidence. Choose a shorter date range.');
    const cardJobIds = new Set(segments.map(row => row.job_id));
    const evidenceJobs = await timeJobs(tx, actor, unique([...cardJobIds, ...pendingJobs.map(row => row.id)]));
    const jobs = evidenceJobs.filter(job => cardJobIds.has(job.id));
    const jobMap = new Map(jobs.map(job => [job.id, job]));
    const segmentMap = new Map<string, Row[]>();
    for (const segment of segments) { const list = segmentMap.get(segment.shift_id) ?? []; list.push(segment); segmentMap.set(segment.shift_id, list); }
    const now = timeMicroseconds(observedAt), start = BigInt(bounds.start.toMillis()) * 1000n, end = BigInt(bounds.end.toMillis()) * 1000n;
    const cards = shifts.map(shift => {
      const total = zero(), period = zero(), groups = new Map<string, {total: Total; period: Total}>();
      for (const segment of segmentMap.get(shift.id) ?? []) {
        const from = timeMicroseconds(segment.started_at), until = min(timeMicroseconds(segment.ended_at ?? observedAt), now);
        const full = duration(from, until), clipped = duration(max(from, start), min(until, end));
        const group = groups.get(segment.job_id) ?? {total: zero(), period: zero()};
        add(total, segment.kind, full); add(period, segment.kind, clipped);
        add(group.total, segment.kind, full); add(group.period, segment.kind, clipped); groups.set(segment.job_id, group);
      }
      const breakdown = [...groups].map(([id, value]) => ({...jobIdentity(jobMap.get(id)!), ...durations(value.total), periodWorkMicroseconds: value.period.work.toString(), periodBreakMicroseconds: value.period.rest.toString()}));
      return {...shift, id: shift.id, user_id: shift.user_id, employee_name: shift.employee_name, employee_active: shift.employee_active,
        started_at: shift.started_at, ended_at: shift.ended_at, revision: shift.revision, pending_corrections: shift.pending_corrections,
        pending_adjustments: shift.pending_adjustments, pending_count: shift.pending_corrections + shift.pending_adjustments,
        ...durations(total), periodWorkMicroseconds: period.work.toString(), periodBreakMicroseconds: period.rest.toString(), jobs: breakdown,
        canAdjust: !!shift.ended_at && shift.user_id !== actor.id && directRole(actor)};
    });
    const options = {
      employees: [...new Map(shifts.map(row => [row.user_id, {id: row.user_id, name: row.employee_name, active: row.employee_active}])).values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      jobs: jobs.map(job => ({id: job.id, title: job.title, unitId: job.unit_id, unitName: job.unit_name, active: job.active})).sort((a,b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
      units: [...new Map(jobs.map(job => [job.unit_id, {id: job.unit_id, name: job.unit_name}])).values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
    const search = input.search?.toLocaleLowerCase() ?? '';
    const selectedJob = (job: ReturnType<typeof jobIdentity>) => (!input.jobId || job.jobId === input.jobId) && (!input.unitId || job.unitId === input.unitId);
    const filtered = cards.filter(card => (!input.userId || card.user_id === input.userId) && card.jobs.some(selectedJob) &&
      (input.status === 'all' || input.status === 'open' && !card.ended_at || input.status === 'completed' && !!card.ended_at || input.status === 'pending' && card.pending_count > 0 || input.status === 'revised' && card.revision > 1) &&
      (!search || [card.employee_name, ...card.jobs.flatMap(job => [job.title, job.unitName])].some(text => String(text).toLocaleLowerCase().includes(search))));
    const full = zero(), period = zero(), summaryJobs = new Map<string, Total>();
    for (const card of filtered) {
      full.work += BigInt(card.workMicroseconds); full.rest += BigInt(card.breakMicroseconds);
      for (const job of card.jobs.filter(selectedJob)) {
        const total = summaryJobs.get(job.jobId) ?? zero(); total.work += BigInt(job.periodWorkMicroseconds); total.rest += BigInt(job.periodBreakMicroseconds); summaryJobs.set(job.jobId, total);
        period.work += BigInt(job.periodWorkMicroseconds); period.rest += BigInt(job.periodBreakMicroseconds);
      }
    }
    filtered.sort((a,b) => {
      const date = a.started_at.localeCompare(b.started_at), id = a.id.localeCompare(b.id);
      if (input.sort === 'oldest') return date || id;
      if (input.sort === 'name') return a.employee_name.localeCompare(b.employee_name) || -date || id;
      if (input.sort === 'pending') return b.pending_count - a.pending_count || -date || id;
      return -date || id;
    });
    const result = {
      rows: filtered.slice(input.offset, input.offset + 100), hasMore: filtered.length > input.offset + 100, timezone: organization.timezone, observedAt,
      summary: {shiftCount: filtered.length, employeeCount: new Set(filtered.map(row => row.user_id)).size, openCount: filtered.filter(row => !row.ended_at).length,
        pendingCount: filtered.reduce((sum,row) => sum + row.pending_count, 0), ...durations(period), cardWorkMicroseconds: full.work.toString(), cardBreakMicroseconds: full.rest.toString(),
        jobs: [...summaryJobs].map(([id,total]) => ({...jobIdentity(jobMap.get(id)!), ...durations(total)})).sort((a,b) => a.title.localeCompare(b.title) || a.jobId.localeCompare(b.jobId))}, options,
    };
    await recheckReportSession(tx, actor, sessionHash);
    return {result, jobs: evidenceJobs, access: {role: actor.role, units: unique(actor.unit_ids)}};
  }, true);
  // Release the consistent data snapshot, then revalidate current access before
  // publishing. A changed job/community cannot reuse old report authorization.
  return timeTransaction(db, async tx => {
    const actor = await currentTimeActor(tx, supplied, sessionHash);
    requireCondition(canonicalTimeJson(prepared.access) === canonicalTimeJson({role: actor.role, units: unique(actor.unit_ids)}), 409, 'Your time-card access changed. Refresh this view.');
    const current = await timeJobs(tx, actor, prepared.jobs.map(job => job.id));
    requireCondition(canonicalTimeJson(current) === canonicalTimeJson(prepared.jobs), 409, 'Time-card jobs or communities changed. Refresh this view.');
    await recheckReportSession(tx, actor, sessionHash);
    return prepared.result;
  });
}
