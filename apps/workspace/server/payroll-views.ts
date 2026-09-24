import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable, Row } from './db';
import { audit, canReport, orgWide, Problem, requireCondition, type Actor } from './security';
import { currentReportActor, recheckReportSession, reportTransaction } from './report-source-access';
import { withAuthorizedWorkforceSource, type WorkforceReportProof } from './workforce-report-access';
import { workforceReportBoundsV2 } from './reports-v2';
import {
  createPayrollViewSchema, updatePayrollViewSchema, deletePayrollViewSchema, payrollViewIdSchema,
  payrollViewFiltersSchema, payrollViewLimit, payrollViewListSchema, savedPayrollViewSchema,
  resolvePayrollViewFilters, resolvedPayrollViewSchema, type PayrollViewFilters, type SavedPayrollView,
} from '../shared/payroll-views';

const unavailableReason = 'This view uses a unit, employee or calendar range that is unavailable under your current access. Edit its filters before opening it.';
const unavailable = () => new Problem(404, 'Saved payroll view is unavailable under your current access.');
const conflict = 'This saved payroll view changed or was removed. Refresh your saved views before trying again.';
const capture = (actor: Actor): Actor => ({ ...actor, id: actor.id.toLowerCase(), org_id: actor.org_id.toLowerCase(), unit_ids: [...actor.unit_ids], ...(actor.scopes ? { scopes: [...actor.scopes] } : {}) });
const exact = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const projection = `id,name,filters,revision,creation_fingerprint,deleted_at,${exact('created_at')} AS created_at,${exact('updated_at')} AS updated_at`;
type Metadata = { timezone: string; as_of: string };

function reporting(actor: Actor) {
  requireCondition(canReport(actor), 403, 'A current reporting role is required for saved payroll views.');
}
async function metadata(tx: Queryable, actor: Actor): Promise<Metadata> {
  const row = (await tx.query<Metadata>(`SELECT timezone,${exact('clock_timestamp()')} AS as_of FROM organizations WHERE id=$1`, [actor.org_id])).rows[0];
  requireCondition(row, 404, 'Report organization not found.'); return row;
}

/** Mirrors the existing row scope: explicit manager units OR that manager's own history.
 * Target account SHARE follows the actor lock; bounded transaction retries handle
 * concurrent cross-account writers, while active/membership changes cannot pass it. */
async function targetsAvailable(tx: Queryable, actor: Actor, filters: PayrollViewFilters): Promise<boolean> {
  if (filters.unitId) {
    const unit = (await tx.query('SELECT id FROM units WHERE org_id=$1 AND id=$2 FOR SHARE', [actor.org_id, filters.unitId])).rows[0];
    if (!unit) return false;
    if (!orgWide(actor) && !actor.unit_ids.includes(filters.unitId)) {
      if (filters.userId && filters.userId !== actor.id) return false;
      const own = (await tx.query(`SELECT EXISTS(SELECT 1 FROM segments s
        JOIN shifts h ON h.id=s.shift_id AND h.org_id=s.org_id AND h.revision=s.revision
        JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id
        WHERE h.org_id=$1 AND h.user_id=$2 AND j.unit_id=$3) AS allowed`, [actor.org_id, actor.id, filters.unitId])).rows[0];
      if (!own.allowed) return false;
    }
  }
  if (filters.userId) {
    const person = (await tx.query('SELECT id,active FROM users WHERE org_id=$1 AND id=$2 FOR SHARE', [actor.org_id, filters.userId])).rows[0];
    if (!person?.active) return false;
    if (!orgWide(actor) && filters.userId !== actor.id) {
      const access = (await tx.query(`SELECT (
        EXISTS(SELECT 1 FROM user_units WHERE org_id=$1 AND user_id=$2 AND unit_id=ANY($3::uuid[]))
        OR EXISTS(SELECT 1 FROM segments s JOIN shifts h ON h.id=s.shift_id AND h.org_id=s.org_id AND h.revision=s.revision
          JOIN jobs j ON j.id=s.job_id AND j.org_id=s.org_id
          WHERE h.org_id=$1 AND h.user_id=$2 AND j.unit_id=ANY($3::uuid[]))
        ) AS allowed`, [actor.org_id, filters.userId, actor.unit_ids])).rows[0];
      if (!access.allowed) return false;
    }
  }
  return true;
}
function resolve(filters: PayrollViewFilters, meta: Metadata) {
  let result: ReturnType<typeof resolvePayrollViewFilters>;
  try { result = resolvePayrollViewFilters(filters, meta.timezone, meta.as_of); }
  catch (error) {
    if (error instanceof RangeError) throw new Problem(400, 'The saved view dates are unavailable in the organization timezone.');
    throw error;
  }
  workforceReportBoundsV2(result.query, meta.timezone);
  if (result.comparisonQuery) workforceReportBoundsV2(result.comparisonQuery, meta.timezone);
  return result;
}
async function decorate(tx: Queryable, actor: Actor, row: Row, meta: Metadata): Promise<SavedPayrollView> {
  const filters = payrollViewFiltersSchema.parse(row.filters);
  let available = await targetsAvailable(tx, actor, filters);
  if (available) try { resolve(filters, meta); } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError || (error instanceof Problem && error.status === 400))) throw error;
    available = false;
  }
  return savedPayrollViewSchema.parse({ id: row.id, name: row.name, revision: row.revision, filters,
    createdAt: row.created_at, updatedAt: row.updated_at,
    availability: available ? 'available' : 'unavailable', unavailableReason: available ? null : unavailableReason });
}
async function writableFilters(tx: Queryable, actor: Actor, filters: PayrollViewFilters, meta: Metadata) {
  requireCondition(await targetsAvailable(tx, actor, filters), 404, unavailableReason);
  resolve(filters, meta);
}
async function owned(tx: Queryable, actor: Actor, id: string, lock = false): Promise<Row> {
  const row = (await tx.query(`SELECT ${projection} FROM payroll_saved_views WHERE org_id=$1 AND user_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`, [actor.org_id, actor.id, id])).rows[0];
  if (!row) throw unavailable(); return row;
}
function fresh(row: Row, revision: number) {
  requireCondition(row.deleted_at === null && row.revision === revision && revision < 2_147_483_647, 409, conflict);
}
async function write<T>(db: Database, supplied: Actor, sessionHash: string | undefined, work: (tx: Queryable, actor: Actor, meta: Metadata) => Promise<T>): Promise<T> {
  const identity = capture(supplied), hash = sessionHash;
  requireCondition(identity.mode === 'password', 403, 'Password sign-in is required to change saved payroll views.');
  requireCondition(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 401, 'A current workspace session is required.');
  try {
    return await reportTransaction(db, async tx => {
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
      // Serializes all this account's creations/counts and follows credential writers' lock order.
      const actor = await currentReportActor(tx, identity, hash, true); reporting(actor);
      const result = await work(tx, actor, await metadata(tx, actor)); JSON.stringify(result);
      await recheckReportSession(tx, actor, hash); return result;
    });
  } catch (error: any) {
    if (['55P03', '57014', '40001', '40P01'].includes(error?.code)) throw new Problem(503, 'Saved payroll views are busy. Refresh and try again.');
    throw error;
  }
}
function read<T>(db: Database, actor: Actor, proof: WorkforceReportProof, load: (tx: Queryable, actor: Actor, meta: Metadata) => Promise<T>): Promise<T> {
  requireCondition(actor.mode === 'password' || actor.mode === 'api', 403, 'Saved payroll views require workspace or scoped reporting access.');
  return withAuthorizedWorkforceSource(db, capture(actor), { ...proof }, async (tx, current) => {
    reporting(current); return load(tx, current, await metadata(tx, current));
  }, async (_tx, _actor, value) => value, { repeatableRead: true });
}

export function listPayrollViews(db: Database, actor: Actor, proof: WorkforceReportProof) {
  return read(db, actor, proof, async (tx, current, meta) => {
    const rows = (await tx.query(`SELECT ${projection} FROM payroll_saved_views WHERE org_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 26`, [current.org_id, current.id])).rows;
    requireCondition(rows.length <= payrollViewLimit, 409, 'This account has more saved views than supported. Contact an administrator.');
    const views: SavedPayrollView[] = [];
    for (const row of rows) views.push(await decorate(tx, current, row, meta));
    return payrollViewListSchema.parse({ views, limit: payrollViewLimit });
  });
}
export function resolvePayrollView(db: Database, actor: Actor, proof: WorkforceReportProof, rawId: unknown) {
  const id = payrollViewIdSchema.parse(rawId);
  return read(db, actor, proof, async (tx, current, meta) => {
    const row = await owned(tx, current, id); if (row.deleted_at !== null) throw unavailable();
    const view = await decorate(tx, current, row, meta);
    requireCondition(view.availability === 'available', 404, unavailableReason);
    return resolvedPayrollViewSchema.parse({ view, ...resolve(view.filters, meta), timezone: meta.timezone, asOf: meta.as_of });
  });
}
export function createPayrollView(db: Database, actor: Actor, sessionHash: string | undefined, raw: unknown) {
  const input = createPayrollViewSchema.parse(raw);
  const fingerprint = createHash('sha256').update(JSON.stringify({ name: input.name, filters: input.filters })).digest('hex');
  return write(db, actor, sessionHash, async (tx, current, meta) => {
    const prior = (await tx.query(`SELECT ${projection} FROM payroll_saved_views WHERE org_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE`, [current.org_id, current.id, input.id])).rows[0];
    if (prior) {
      requireCondition(prior.deleted_at === null && prior.creation_fingerprint === fingerprint, 409, conflict);
      return decorate(tx, current, prior, meta);
    }
    requireCondition(Number((await tx.query('SELECT count(*) AS count FROM payroll_saved_views WHERE org_id=$1 AND user_id=$2 AND deleted_at IS NULL', [current.org_id, current.id])).rows[0].count) < payrollViewLimit,
      409, 'You can keep up to 25 saved payroll views. Remove one before creating another.');
    await writableFilters(tx, current, input.filters, meta);
    await tx.query(`INSERT INTO payroll_saved_views(org_id,user_id,id,name,filters,revision,creation_fingerprint,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$7::timestamptz,$7::timestamptz)`, [current.org_id, current.id, input.id, input.name, JSON.stringify(input.filters), fingerprint, meta.as_of]);
    await audit(tx, current, 'payroll.view_created', input.id, { name: input.name, filters: input.filters, revision: 1 });
    return decorate(tx, current, await owned(tx, current, input.id), meta);
  });
}
export function updatePayrollView(db: Database, actor: Actor, sessionHash: string | undefined, rawId: unknown, raw: unknown) {
  const id = payrollViewIdSchema.parse(rawId), input = updatePayrollViewSchema.parse(raw);
  return write(db, actor, sessionHash, async (tx, current, meta) => {
    const previous = await owned(tx, current, id, true); fresh(previous, input.revision);
    await writableFilters(tx, current, input.filters, meta);
    const result = await tx.query(`UPDATE payroll_saved_views SET name=$1,filters=$2,revision=revision+1,updated_at=$3::timestamptz
      WHERE org_id=$4 AND user_id=$5 AND id=$6 AND revision=$7 AND deleted_at IS NULL RETURNING id`, [input.name, JSON.stringify(input.filters), meta.as_of, current.org_id, current.id, id, input.revision]);
    requireCondition(result.rows.length === 1, 409, conflict);
    await audit(tx, current, 'payroll.view_updated', id, { before: { name: previous.name, filters: previous.filters, revision: previous.revision }, after: { name: input.name, filters: input.filters, revision: input.revision + 1 } });
    return decorate(tx, current, await owned(tx, current, id), meta);
  });
}
export function deletePayrollView(db: Database, actor: Actor, sessionHash: string | undefined, rawId: unknown, raw: unknown) {
  const id = payrollViewIdSchema.parse(rawId), input = deletePayrollViewSchema.parse(raw);
  return write(db, actor, sessionHash, async (tx, current, meta) => {
    const previous = await owned(tx, current, id, true); fresh(previous, input.revision);
    const result = await tx.query(`UPDATE payroll_saved_views SET deleted_at=$1::timestamptz,updated_at=$1::timestamptz,revision=revision+1
      WHERE org_id=$2 AND user_id=$3 AND id=$4 AND revision=$5 AND deleted_at IS NULL RETURNING id`, [meta.as_of, current.org_id, current.id, id, input.revision]);
    requireCondition(result.rows.length === 1, 409, conflict);
    await audit(tx, current, 'payroll.view_deleted', id, { name: previous.name, filters: previous.filters, beforeRevision: previous.revision, revision: input.revision + 1 });
    return { id, revision: input.revision + 1, deleted: true as const };
  });
}
