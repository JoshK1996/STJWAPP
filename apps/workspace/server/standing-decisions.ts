import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable, Row } from "./db";
import type { AppRequest } from "./auth";
import { audit, digest, requireCondition, Problem, type Actor } from "./security";
import { schoolActor } from "./school";
import { currentReportActor, recheckReportSession, lockReportExtraction } from "./report-source-access";
import { lockAcademics } from "./timetable-engine";
import { canonicalStandingJson, gradingPolicyEvidenceHash, standingPolicyEvidenceHash } from "./standing-policy-provenance";
import { copyStandingSource, lockStandingSourceAuthority, lockStandingSourceParents, assertStandingSourceUnchanged, normalizeStandingSource, type StandingSourceCopy } from "./standing-source";
import { calculateAcademicStanding, AcademicStandingValidationError, standingPolicySchema, standingCalculatorVersion } from "../shared/academic-standing";
import { renderStandingDecision } from "./standing-decision-export";
import { prepareStandingInput, retainStandingInput, eligibleStandingIssuesInput, standingDecisionListInput, standingDecisionCursorSchema,
  standingDecisionExportInput, standingReviewDataSchema, standingPreviewSchema, standingDecisionEnvelopeSchema, standingDecisionSummarySchema,
  standingDecisionDetailSchema, standingDecisionListSchema, eligibleStandingIssuesSchema, standingDecisionCurrentnessSchema,
  standingDecisionLimits as limits, type StandingReviewData, type StandingPreview, type StandingDecisionSummary, type StandingDecisionDetail,
  type StandingDecisionList, type EligibleStandingIssues, type StandingDecisionCurrentness } from "../shared/standing-decisions";

const iso = (value: any) => new Date(value).toISOString();
const unavailable = () => new Problem(404, "This standing record is unavailable under your current access.");
const valid = (condition: unknown) => requireCondition(condition, 422, "The retained standing evidence is inconsistent or unsupported.");
const changed = (condition: unknown) => requireCondition(condition, 409, "The reviewed standing source or predecessor changed. Prepare and review it again.");
const canonical = canonicalStandingJson;
type Scope = { orgId: string; unitId: string; studentId: string; yearId: string; termId: string; policyId: string };
const scopeParams = (s: Scope) => [s.orgId, s.unitId, s.studentId, s.yearId, s.termId, s.policyId];
const sourceScope = (copy: StandingSourceCopy, policyId: string): Scope => ({ orgId: copy.orgId, unitId: copy.unitId, ...copy.selection, policyId });
function decoded<T>(schema: z.ZodType<T>, text: string): T {
  try { const raw = JSON.parse(text); const parsed = schema.safeParse(raw); valid(parsed.success); return parsed.data!; }
  catch (error) { if (error instanceof Problem) throw error; throw new Problem(422, "The retained standing evidence is inconsistent or unsupported."); }
}
function sourceCopy(text: string): StandingSourceCopy {
  try { const raw = JSON.parse(text) as StandingSourceCopy; normalizeStandingSource(raw); return raw; }
  catch { throw new Problem(422, "The private source evidence is inconsistent or unsupported."); }
}
async function transaction<T>(db: Database, fn: (tx: Queryable) => Promise<T>, repeatable = false): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(async tx => {
      if (repeatable) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL statement_timeout='15s'"); await tx.query("SET LOCAL lock_timeout='5s'");
      return fn(tx);
    }); } catch (error: any) {
      if (["40001", "40P01"].includes(error.code) && attempt < 1 && Date.now() - started < 15000) continue;
      if (["55P03", "57014", "40001", "40P01"].includes(error.code)) throw new Problem(503, "The standing source is busy. Retry the same command when it is available.");
      if (error instanceof AcademicStandingValidationError) throw new Problem(422, "The confirmed policy does not apply to this selected reviewed source.");
      throw error;
    }
  }
}
async function currentOffice(tx: Queryable, supplied: Actor, sessionHash: string | undefined, unitId: string) {
  requireCondition(sessionHash, 401, "A verified password session is required.");
  const actor = await currentReportActor(tx, supplied, sessionHash);
  if (!["developer", "owner", "admin"].includes(actor.role)) {
    if (!actor.unit_ids.includes(unitId)) throw unavailable();
    if (!(await tx.query("SELECT unit_id FROM school_office_grants WHERE org_id=$1 AND user_id=$2 AND unit_id=$3 FOR SHARE", [actor.org_id, actor.id, unitId])).rows.length) throw unavailable();
  }
  if (!(await tx.query("SELECT id FROM units WHERE org_id=$1 AND id=$2", [actor.org_id, unitId])).rows.length) throw unavailable();
  return actor;
}
async function policyVersion(tx: Queryable, orgId: string, unitId: string, yearId: string, versionId: string, lock = false): Promise<Row> {
  const row = (await tx.query(`SELECT v.*,p.unit_id,p.year_id,p.archived,p.active_policy_version_id FROM standing_policy_versions v
    JOIN standing_policies p ON p.id=v.policy_id AND p.org_id=v.org_id WHERE v.id=$1 AND v.org_id=$2 AND p.unit_id=$3 AND p.year_id=$4${lock ? " FOR SHARE OF p" : ""}`, [versionId, orgId, unitId, yearId])).rows[0];
  if (!row) throw unavailable();
  changed(!row.archived && row.active_policy_version_id === row.id);
  valid(standingPolicyEvidenceHash(row.policy) === row.policy_hash);
  const policy = standingPolicySchema.parse(row.policy);
  valid(policy.policyId === row.policy_id && policy.version === row.version && policy.orgId === orgId && policy.unitId === unitId && policy.yearId === yearId);
  return { ...row, policy };
}
async function series(tx: Queryable, scope: Scope, lock: boolean): Promise<Row | undefined> {
  if (lock) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standing-series:" + scopeParams(scope).join(":")]);
  return (await tx.query(`SELECT * FROM standing_series WHERE org_id=$1 AND unit_id=$2 AND student_id=$3 AND year_id=$4 AND term_id=$5 AND policy_id=$6${lock ? " FOR UPDATE" : ""}`, scopeParams(scope))).rows[0];
}
function review(copy: StandingSourceCopy, version: Row, latestId: string | null, latestNumber: number): StandingReviewData {
  const normalized = normalizeStandingSource(copy), result = calculateAcademicStanding(version.policy, normalized.source);
  valid(version.evidence?.unit?.id === copy.unitId && version.evidence?.year?.id === copy.selection.yearId);
  const rules = version.policy.courseRules as Array<{ courseId: string }>, savedCourses = version.evidence.courses as Array<{ id: string; code: string; title: string }>;
  valid(Array.isArray(savedCourses) && new Set(savedCourses.map(c => c.id)).size === savedCourses.length);
  const courses = rules.map(r => { const course = savedCourses.find(c => c.id === r.courseId); valid(course); return { id: course!.id, code: course!.code, title: course!.title }; });
  return standingReviewDataSchema.parse({ schemaVersion: 1, calculatorVersion: standingCalculatorVersion,
    policyVersion: { id: version.id, policyId: version.policy_id, version: version.version, hash: version.policy_hash }, policy: version.policy,
    policyConfirmation: { sourceDescription: version.source_description, reason: version.reason, confirmedBy: { id: version.confirmed_by, name: version.confirmed_name }, confirmedAt: iso(version.confirmed_at), courses },
    ...normalized, result, expected: { policyVersionId: version.id, policyHash: version.policy_hash, cardId: copy.issue.cardId,
      cardVersion: copy.evidence.parents.card.version, issueId: copy.issue.id, issueHash: copy.issue.hash, currentSourceHash: copy.evidence.currentSourceHash,
      comparisonHash: copy.evidence.comparisonHash, latestDecisionId: latestId, latestDecisionNumber: latestNumber } });
}
function checkedReview(text: string, hash: string) {
  valid(digest(text) === hash); const data = decoded(standingReviewDataSchema, text);
  valid(canonical(data) === text && standingPolicyEvidenceHash(data.policy) === data.policyVersion.hash);
  valid(data.policy.policyId === data.policyVersion.policyId && data.policy.version === data.policyVersion.version && data.expected.policyVersionId === data.policyVersion.id && data.expected.policyHash === data.policyVersion.hash);
  valid(data.policyConfirmation.courses.length === data.policy.courseRules.length && new Set(data.policyConfirmation.courses.map(c => c.id)).size === data.policyConfirmation.courses.length && data.policy.courseRules.every(r => data.policyConfirmation.courses.some(c => c.id === r.courseId)));
  valid(data.source.issue.id === data.expected.issueId && data.source.issue.hash === data.expected.issueHash && data.evidence.issueHash === data.expected.issueHash && data.evidence.comparisonHash === data.expected.comparisonHash);
  valid(data.source.issue.cardId === data.expected.cardId && data.source.current.cardVersion === data.expected.cardVersion && data.source.current.sourceHash === data.expected.currentSourceHash &&
    data.evidence.currentSourceHash === data.expected.currentSourceHash && data.source.issue.sourceHash === data.evidence.issuedSourceHash &&
    data.evidence.parents.card.id === data.expected.cardId && data.evidence.parents.card.version === data.expected.cardVersion && data.evidence.parents.card.latestIssueId === data.source.current.latestIssueId &&
    data.evidence.parents.student.id === data.source.identity.studentId && data.evidence.parents.unit.id === data.source.identity.unitId && data.evidence.parents.organization.id === data.source.identity.orgId);
  for (const release of data.evidence.selectedReleases) {
    valid(digest(canonical(release.projection)) === release.hash && gradingPolicyEvidenceHash(release.capturedPolicy) === release.projection.gradingPolicy.hash &&
      release.projection.orgId === data.source.identity.orgId && release.projection.unitId === data.source.identity.unitId && release.projection.student.id === data.source.identity.studentId &&
      release.projection.term.id === data.source.identity.termId && release.projection.term.yearId === data.source.identity.yearId);
  }
  valid(canonical(calculateAcademicStanding(data.policy, data.source)) === canonical(data.result));
  return data;
}
const requiredCourses = (version: Row) => version.policy.courseRules.filter((r: any) => r.disposition === "include" && r.required).map((r: any) => r.courseId);
async function freshSource(tx: Queryable, supplied: Actor, sessionHash: string, copy: StandingSourceCopy, versionId: string) {
  const authority = await lockStandingSourceAuthority(tx, supplied, sessionHash, copy);
  const version = await policyVersion(tx, authority.orgId, authority.unitId, copy.selection.yearId, versionId, true);
  await lockStandingSourceParents(tx, authority, copy, requiredCourses(version));
  const fresh = await copyStandingSource(tx, authority.actor, copy.selection);
  assertStandingSourceUnchanged(copy, fresh, authority);
  return { actor: authority.actor, version, fresh };
}
async function previewQuota(tx: Queryable, actor: Actor, bytes: number) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standing-previews-quota:" + actor.org_id]);
  await tx.query("DELETE FROM standing_previews WHERE org_id=$1 AND (consumed_at IS NOT NULL OR expires_at<=clock_timestamp())", [actor.org_id]);
  const stats = (await tx.query(`SELECT count(*)::int AS count,COALESCE(sum(bytes),0)::text AS bytes,
    count(*) FILTER(WHERE prepared_by=$2)::int AS own FROM standing_previews WHERE org_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [actor.org_id, actor.id])).rows[0];
  requireCondition(stats.own < limits.previews && stats.count < limits.organizationPreviews && BigInt(stats.bytes) + BigInt(bytes) <= BigInt(limits.organizationPreviewBytes), 409,
    "The private review capacity is full. Finish an existing review or wait for it to expire before preparing another.");
}
function summary(row: Row): StandingDecisionSummary {
  return standingDecisionSummarySchema.parse({ id: row.id, seriesId: row.series_id, number: row.number, supersedesId: row.supersedes_id,
    policyVersionId: row.policy_version_id, outcome: row.outcome, snapshotHash: row.snapshot_hash, jsonHash: row.json_hash, csvHash: row.csv_hash, capturedAt: iso(row.captured_at) });
}
function stored(row: Row): StandingDecisionDetail {
  // PGlite's text result decoder strips a leading UTF-8 BOM. Read the exact
  // database bytes through ASCII base64 so both PostgreSQL drivers preserve it.
  row.csv_text = Buffer.from(row.csv_base64, "base64").toString("utf8");
  valid(digest(row.snapshot_text) === row.snapshot_hash && digest(row.json_text) === row.json_hash && digest(row.csv_text) === row.csv_hash);
  valid(Buffer.byteLength(row.json_text) === row.json_bytes && Buffer.byteLength(row.csv_text) === row.csv_bytes && Buffer.byteLength(row.snapshot_text) + row.json_bytes + row.csv_bytes === row.bytes);
  const decision = decoded(standingDecisionEnvelopeSchema, row.snapshot_text);
  valid(canonical(decision) === row.snapshot_text && row.json_text === canonical({ schemaVersion: 1, snapshotHash: row.snapshot_hash, decision }) + "\n");
  valid(decision.id === row.id && decision.seriesId === row.series_id && decision.number === row.number && decision.previewId === row.preview_id && decision.reviewedBy.id === row.reviewed_by);
  valid(decision.supersedesId === row.supersedes_id && decision.previewHash === row.preview_hash && decision.capturedAt === iso(row.captured_at) && decision.reviewedBy.name === row.reviewer_name && decision.reason === row.reason &&
    decision.number === decision.data.expected.latestDecisionNumber + 1 && decision.supersedesId === decision.data.expected.latestDecisionId && decision.data.policyVersion.id === row.policy_version_id &&
    decision.data.policyVersion.policyId === row.policy_id && decision.data.source.issue.cardId === row.card_id && decision.data.source.issue.cardVersion === row.card_version && decision.data.source.issue.id === row.issue_id && decision.data.result.outcome === row.outcome);
  valid(decision.data.source.identity.orgId === row.org_id && decision.data.source.identity.unitId === row.unit_id && decision.data.source.identity.studentId === row.student_id && decision.data.source.identity.yearId === row.year_id && decision.data.source.identity.termId === row.term_id);
  checkedReview(canonical(decision.data), decision.previewHash);
  return standingDecisionDetailSchema.parse({ decision, snapshotHash: row.snapshot_hash, jsonHash: row.json_hash, csvHash: row.csv_hash, jsonBytes: row.json_bytes, csvBytes: row.csv_bytes });
}

export async function prepareStanding(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<StandingPreview> {
  const input = prepareStandingInput.parse(raw); requireCondition(sessionHash, 401, "A verified password session is required.");
  const selection = { studentId: input.studentId, yearId: input.yearId, termId: input.termId, reportCardIssueId: input.reportCardIssueId };
  const copy = await transaction(db, async tx => {
    await lockReportExtraction(tx, supplied);
    const actor = await currentReportActor(tx, supplied, sessionHash);
    const copy = await copyStandingSource(tx, actor, selection);
    await policyVersion(tx, actor.org_id, copy.unitId, input.yearId, input.policyVersionId);
    return copy;
  }, true);
  return transaction(db, async tx => {
    const { actor, version, fresh } = await freshSource(tx, supplied, sessionHash, copy, input.policyVersionId);
    const scope = sourceScope(fresh, version.policy_id), prior = await series(tx, scope, true);
    const data = review(fresh, version, prior?.latest_decision_id ?? null, prior?.latest_number ?? 0);
    const reviewText = canonical(data), copyText = canonical(fresh), bytes = Buffer.byteLength(reviewText) + Buffer.byteLength(copyText);
    requireCondition(bytes <= limits.bytes, 422, "This private review exceeds the supported evidence size. Choose a narrower issued card.");
    await previewQuota(tx, actor, bytes);
    const now = (await tx.query("SELECT clock_timestamp() AS now")).rows[0].now, createdAt = iso(now), expiresAt = new Date(new Date(now).getTime() + limits.previewMinutes * 60000).toISOString();
    const id = randomUUID(), previewHash = digest(reviewText);
    await tx.query(`INSERT INTO standing_previews(id,org_id,unit_id,prepared_by,student_id,year_id,term_id,policy_id,policy_version_id,
      card_id,card_version,issue_id,expected_series_id,expected_latest_id,expected_latest_number,review_text,preview_hash,source_copy_text,comparison_hash,bytes,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [id, actor.org_id, scope.unitId, actor.id,
      scope.studentId, scope.yearId, scope.termId, scope.policyId, version.id, fresh.issue.cardId, fresh.issue.cardVersion, fresh.issue.id,
      prior?.id ?? null, prior?.latest_decision_id ?? null, prior?.latest_number ?? 0, reviewText, previewHash, copyText, fresh.evidence.comparisonHash, bytes, createdAt, expiresAt]);
    await audit(tx, actor, "standing.preview.prepared", id, { unitId: scope.unitId, policyVersionId: version.id, previewHash, bytes, schemaVersion: 1 });
    await recheckReportSession(tx, actor, sessionHash);
    return standingPreviewSchema.parse({ id, expiresAt, previewHash, data });
  });
}

export async function getStandingPreview(db: Database, supplied: Actor, sessionHash: string | undefined, rawId: unknown): Promise<StandingPreview> {
  requireCondition(sessionHash, 401, "A verified password session is required.");
  const id = z.uuid().parse(rawId);
  return transaction(db, async tx => {
    const row = (await tx.query("SELECT * FROM standing_previews WHERE org_id=$1 AND prepared_by=$2 AND id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp()", [supplied.org_id, supplied.id, id])).rows[0];
    if (!row) { await currentReportActor(tx, supplied, sessionHash); throw unavailable(); }
    const actor = await currentOffice(tx, supplied, sessionHash, row.unit_id), data = checkedReview(row.review_text, row.preview_hash);
    const guarded = (await tx.query("SELECT id FROM standing_previews WHERE id=$1 AND org_id=$2 AND prepared_by=$3 FOR SHARE", [id, actor.org_id, actor.id])).rows[0];
    const live = guarded && (await tx.query("SELECT consumed_at IS NULL AND expires_at>clock_timestamp() AS live FROM standing_previews WHERE id=$1", [id])).rows[0]?.live;
    if (!live) throw unavailable();
    await recheckReportSession(tx, actor, sessionHash!);
    return standingPreviewSchema.parse({ id, expiresAt: iso(row.expires_at), previewHash: row.preview_hash, data });
  });
}

export async function retainStanding(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<{ decision: StandingDecisionSummary; replayed: boolean }> {
  const input = retainStandingInput.parse(raw); requireCondition(sessionHash, 401, "A verified password session is required.");
  const fingerprint = digest(canonical({ action: "retain", input }));
  return transaction(db, async tx => {
    // This namespace is ALWAYS first. Never take it after account/academic/domain
    // locks. Existing success must be reachable without a current source/preview.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standing-decision-command:" + supplied.org_id + ":" + supplied.id + ":" + input.commandId]);
    const receipt = (await tx.query("SELECT * FROM standing_decision_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3", [supplied.org_id, supplied.id, input.commandId])).rows[0];
    if (receipt) {
      const row = (await tx.query("SELECT *,encode(convert_to(csv_text,'UTF8'),'base64') AS csv_base64 FROM standing_decisions WHERE org_id=$1 AND reviewed_by=$2 AND id=$3", [supplied.org_id, supplied.id, receipt.decision_id])).rows[0];
      if (!row) throw unavailable();
      const actor = await currentOffice(tx, supplied, sessionHash, row.unit_id);
      requireCondition(receipt.fingerprint === fingerprint, 409, "This command UUID was already used for a different standing decision.");
      stored(row); await recheckReportSession(tx, actor, sessionHash);
      return { decision: summary(row), replayed: true };
    }
    const preview = (await tx.query("SELECT * FROM standing_previews WHERE org_id=$1 AND prepared_by=$2 AND id=$3", [supplied.org_id, supplied.id, input.previewId])).rows[0];
    if (!preview) { await currentReportActor(tx, supplied, sessionHash); throw unavailable(); }
    const original = sourceCopy(preview.source_copy_text);
    const { actor, version, fresh } = await freshSource(tx, supplied, sessionHash, original, preview.policy_version_id);
    const data = checkedReview(preview.review_text, preview.preview_hash), freshData = review(fresh, version, data.expected.latestDecisionId, data.expected.latestDecisionNumber);
    changed(canonical(freshData) === preview.review_text && input.previewHash === preview.preview_hash && input.expectedPolicyVersionId === version.id && input.expectedCardVersion === data.expected.cardVersion && input.expectedLatestDecisionId === data.expected.latestDecisionId);
    const locked = (await tx.query("SELECT * FROM standing_previews WHERE org_id=$1 AND prepared_by=$2 AND id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE", [actor.org_id, actor.id, input.previewId])).rows[0];
    if (!locked) throw unavailable();
    changed(locked.preview_hash === preview.preview_hash && locked.source_copy_text === preview.source_copy_text);
    const scope = sourceScope(fresh, version.policy_id); let prior = await series(tx, scope, true);
    changed((prior?.latest_decision_id ?? null) === data.expected.latestDecisionId && (prior?.latest_number ?? 0) === data.expected.latestDecisionNumber);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standing-decisions-quota:" + actor.org_id]);
    const capturedAt = iso((await tx.query("SELECT clock_timestamp() AS now")).rows[0].now), id = randomUUID(), seriesId = prior?.id ?? randomUUID(), number = (prior?.latest_number ?? 0) + 1;
    const envelope = standingDecisionEnvelopeSchema.parse({ schemaVersion: 1, id, seriesId, number, supersedesId: prior?.latest_decision_id ?? null,
      previewId: input.previewId, previewHash: preview.preview_hash, capturedAt, reviewedBy: { id: actor.id, name: actor.name }, reason: input.reason, data });
    const files = renderStandingDecision(envelope), stats = (await tx.query("SELECT count(*)::int AS count,COALESCE(sum(bytes),0)::text AS bytes FROM standing_decisions WHERE org_id=$1", [actor.org_id])).rows[0];
    requireCondition(stats.count < limits.organizationCount && BigInt(stats.bytes) + BigInt(files.bytes) <= BigInt(limits.organizationBytes), 409, "The retained decision capacity is full. Contact the owner for a reviewed capacity change; existing evidence was preserved.");
    if (!prior) prior = (await tx.query("INSERT INTO standing_series(id,org_id,unit_id,student_id,year_id,term_id,policy_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [seriesId, ...scopeParams(scope), actor.id])).rows[0];
    const row = (await tx.query(`INSERT INTO standing_decisions(id,org_id,unit_id,series_id,student_id,year_id,term_id,policy_id,number,supersedes_id,
      policy_version_id,card_id,card_version,issue_id,preview_id,preview_hash,reviewed_by,reviewer_name,captured_at,reason,outcome,
      snapshot_text,snapshot_hash,json_text,json_hash,csv_text,csv_hash,json_bytes,csv_bytes,bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
      [id, actor.org_id, scope.unitId, seriesId, scope.studentId, scope.yearId, scope.termId, scope.policyId, number, envelope.supersedesId,
        version.id, fresh.issue.cardId, fresh.issue.cardVersion, fresh.issue.id, input.previewId, preview.preview_hash, actor.id, actor.name, capturedAt,
        input.reason, data.result.outcome, files.snapshotText, files.snapshotHash, files.jsonText, files.jsonHash, files.csvText, files.csvHash, files.jsonBytes, files.csvBytes, files.bytes])).rows[0];
    await tx.query("UPDATE standing_series SET latest_number=$2,latest_decision_id=$3 WHERE id=$1", [seriesId, number, id]);
    const consumed = await tx.query("UPDATE standing_previews SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id", [input.previewId]);
    if (!consumed.rows.length) throw unavailable();
    await tx.query("INSERT INTO standing_decision_commands(org_id,actor_id,command_id,fingerprint,decision_id) VALUES($1,$2,$3,$4,$5)", [actor.org_id, actor.id, input.commandId, fingerprint, id]);
    await audit(tx, actor, "standing.decision.retained", id, { unitId: scope.unitId, policyVersionId: version.id, previewId: input.previewId, schemaVersion: 1, snapshotHash: files.snapshotHash, jsonHash: files.jsonHash, csvHash: files.csvHash, bytes: files.bytes });
    await recheckReportSession(tx, actor, sessionHash);
    return { decision: summary(row), replayed: false };
  });
}

async function historical<T>(db: Database, supplied: Actor, sessionHash: string | undefined, rawId: unknown, fn: (tx: Queryable, actor: Actor, row: Row) => Promise<T>) {
  requireCondition(sessionHash, 401, "A verified password session is required."); const id = z.uuid().parse(rawId);
  return transaction(db, async tx => {
    const lookup = (await tx.query("SELECT unit_id FROM standing_decisions WHERE id=$1 AND org_id=$2", [id, supplied.org_id])).rows[0];
    if (!lookup) { await currentReportActor(tx, supplied, sessionHash); throw unavailable(); }
    const actor = await currentOffice(tx, supplied, sessionHash, lookup.unit_id);
    const row = (await tx.query("SELECT *,encode(convert_to(csv_text,'UTF8'),'base64') AS csv_base64 FROM standing_decisions WHERE id=$1 AND org_id=$2", [id, actor.org_id])).rows[0];
    if (!row) throw unavailable();
    const result = await fn(tx, actor, row); await recheckReportSession(tx, actor, sessionHash); return result;
  });
}
export async function getStandingDecision(db: Database, supplied: Actor, sessionHash: string | undefined, id: unknown): Promise<StandingDecisionDetail> {
  return historical(db, supplied, sessionHash, id, async (_tx, _actor, row) => stored(row));
}
export async function exportStandingDecision(db: Database, supplied: Actor, sessionHash: string | undefined, id: unknown, raw: unknown) {
  const { format } = standingDecisionExportInput.parse(raw);
  return historical(db, supplied, sessionHash, id, async (tx, actor, row) => {
    stored(row); const content = format === "json" ? row.json_text : row.csv_text, fileHash = format === "json" ? row.json_hash : row.csv_hash;
    await audit(tx, actor, "standing.decision.exported", row.id, { unitId: row.unit_id, format, fileHash, bytes: Buffer.byteLength(content), schemaVersion: 1 });
    return { content: content as string, fileHash: fileHash as string, filename: "standing-decision-" + row.id + "-v1." + format,
      contentType: format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8" };
  });
}
async function checkListScope(tx: Queryable, actor: Actor, input: { unitId: string; studentId: string; yearId: string; termId?: string; policyId?: string }) {
  if (!(await tx.query("SELECT id FROM students WHERE org_id=$1 AND unit_id=$2 AND id=$3", [actor.org_id, input.unitId, input.studentId])).rows.length ||
    !(await tx.query("SELECT id FROM school_years WHERE org_id=$1 AND unit_id=$2 AND id=$3", [actor.org_id, input.unitId, input.yearId])).rows.length) throw unavailable();
  if (input.termId && !(await tx.query("SELECT id FROM school_terms WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND id=$4", [actor.org_id, input.unitId, input.yearId, input.termId])).rows.length) throw unavailable();
  if (input.policyId && !(await tx.query("SELECT id FROM standing_policies WHERE org_id=$1 AND unit_id=$2 AND year_id=$3 AND id=$4", [actor.org_id, input.unitId, input.yearId, input.policyId])).rows.length) throw unavailable();
}
export async function eligibleStandingIssues(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<EligibleStandingIssues> {
  const input = eligibleStandingIssuesInput.parse(raw);
  return transaction(db, async tx => {
    const actor = await currentOffice(tx, supplied, sessionHash, input.unitId); await checkListScope(tx, actor, input);
    const rows = (await tx.query(`SELECT c.id AS card_id,c.version AS card_version,c.term_ids,i.id AS issue_id,i.number,i.snapshot_hash,i.issued_at
      FROM report_cards c JOIN LATERAL(SELECT id,number,card_version,snapshot_hash,issued_at FROM report_card_issues WHERE card_id=c.id AND org_id=c.org_id ORDER BY number DESC LIMIT 1)i ON true
      WHERE c.org_id=$1 AND c.unit_id=$2 AND c.student_id=$3 AND c.year_id=$4 AND $5=ANY(c.term_ids) AND c.status='issued' AND c.version=i.card_version
      ORDER BY i.issued_at DESC,i.id DESC LIMIT $6`, [actor.org_id, input.unitId, input.studentId, input.yearId, input.termId, limits.page + 1])).rows;
    requireCondition(rows.length <= limits.page, 422, "The issued-copy selection exceeds the supported limit. No alternatives were truncated.");
    const result = eligibleStandingIssuesSchema.parse({ items: rows.map(r => ({ cardId: r.card_id, cardVersion: r.card_version, issueId: r.issue_id, issueNumber: r.number, issueHash: r.snapshot_hash, termIds: r.term_ids, issuedAt: iso(r.issued_at) })) });
    await recheckReportSession(tx, actor, sessionHash!); return result;
  });
}
export async function listStandingDecisions(db: Database, supplied: Actor, sessionHash: string | undefined, raw: unknown): Promise<StandingDecisionList> {
  const input = standingDecisionListInput.parse(raw); let cursor: z.infer<typeof standingDecisionCursorSchema> | null = null;
  if (input.cursor) {
    try { const text = Buffer.from(input.cursor, "base64url").toString("utf8"); cursor = standingDecisionCursorSchema.parse(JSON.parse(text)); requireCondition(Buffer.from(canonical(cursor)).toString("base64url") === input.cursor, 400, "Invalid decision cursor."); }
    catch { throw new Problem(400, "Invalid decision cursor."); }
  }
  return transaction(db, async tx => {
    const actor = await currentOffice(tx, supplied, sessionHash, input.unitId); await checkListScope(tx, actor, input);
    const revision = (await tx.query(`SELECT count(*)::int AS revision FROM standing_decisions WHERE org_id=$1 AND unit_id=$2 AND student_id=$3 AND year_id=$4
      AND ($5::uuid IS NULL OR term_id=$5) AND ($6::uuid IS NULL OR policy_id=$6)`, [actor.org_id, input.unitId, input.studentId, input.yearId, input.termId ?? null, input.policyId ?? null])).rows[0].revision;
    requireCondition(!cursor || cursor.revision === revision, 409, "Decision history changed while paging. Discard partial pages and reload the complete list.");
    // List metadata only: never read fifty full retained export/evidence bodies.
    const rows = (await tx.query(`SELECT d.id,d.series_id,d.number,d.supersedes_id,d.policy_version_id,d.outcome,d.snapshot_hash,d.json_hash,d.csv_hash,d.captured_at,
      d.student_id,d.year_id,d.term_id,d.policy_id,v.version AS policy_version,(s.latest_decision_id=d.id) AS latest
      FROM standing_decisions d JOIN standing_series s ON s.id=d.series_id JOIN standing_policy_versions v ON v.id=d.policy_version_id
      WHERE d.org_id=$1 AND d.unit_id=$2 AND d.student_id=$3 AND d.year_id=$4 AND ($5::uuid IS NULL OR d.term_id=$5) AND ($6::uuid IS NULL OR d.policy_id=$6)
      AND (NOT $7::boolean OR d.id=s.latest_decision_id) AND ($8::timestamptz IS NULL OR (d.captured_at,d.id)<($8::timestamptz,$9::uuid))
      ORDER BY d.captured_at DESC,d.id DESC LIMIT $10`, [actor.org_id, input.unitId, input.studentId, input.yearId, input.termId ?? null, input.policyId ?? null,
        input.latestOnly, cursor?.capturedAt ?? null, cursor?.id ?? null, limits.page + 1])).rows;
    const last = rows[limits.page - 1];
    const result = standingDecisionListSchema.parse({ items: rows.slice(0, limits.page).map(r => ({ ...summary(r), studentId: r.student_id, yearId: r.year_id, termId: r.term_id,
      policyId: r.policy_id, policyVersion: r.policy_version, latest: r.latest })), nextCursor: rows.length > limits.page ? Buffer.from(canonical({ capturedAt: iso(last.captured_at), id: last.id, revision })).toString("base64url") : null });
    await recheckReportSession(tx, actor, sessionHash!); return result;
  }, true);
}
async function currentMetadata(tx: Queryable, orgId: string, data: StandingReviewData): Promise<Pick<StandingDecisionCurrentness, "policyState" | "cardState">> {
  const policy = (await tx.query("SELECT archived,active_policy_version_id FROM standing_policies WHERE org_id=$1 AND id=$2 FOR SHARE", [orgId, data.policyVersion.policyId])).rows[0];
  const card = (await tx.query("SELECT status,version,(SELECT id FROM report_card_issues WHERE card_id=c.id ORDER BY number DESC LIMIT 1) AS issue_id FROM report_cards c WHERE org_id=$1 AND id=$2 FOR SHARE OF c", [orgId, data.source.issue.cardId])).rows[0];
  return { policyState: policy?.archived ? "archived" : policy?.active_policy_version_id === data.policyVersion.id ? "current" : "superseded",
    cardState: !card ? "unavailable" : card.status === "issued" && card.version === data.expected.cardVersion && card.issue_id === data.expected.issueId ? "current" : "changed" };
}
export async function standingDecisionCurrentness(db: Database, supplied: Actor, sessionHash: string | undefined, id: unknown): Promise<StandingDecisionCurrentness> {
  const detail = await getStandingDecision(db, supplied, sessionHash, id), data = detail.decision.data;
  const selection = { studentId: data.source.identity.studentId, yearId: data.source.identity.yearId, termId: data.source.identity.termId, reportCardIssueId: data.source.issue.id };
  try {
    const copy = await transaction(db, async tx => { await lockReportExtraction(tx, supplied); const actor = await currentReportActor(tx, supplied, sessionHash); return copyStandingSource(tx, actor, selection); }, true);
    return await transaction(db, async tx => {
      const authority = await lockStandingSourceAuthority(tx, supplied, sessionHash!, copy);
      await tx.query("SELECT id FROM standing_policies WHERE org_id=$1 AND id=$2 FOR SHARE", [authority.orgId, data.policyVersion.policyId]);
      await lockStandingSourceParents(tx, authority, copy, data.policy.courseRules.filter(r => r.disposition === "include" && r.required).map(r => r.courseId));
      const fresh = await copyStandingSource(tx, authority.actor, selection); assertStandingSourceUnchanged(copy, fresh, authority);
      const metadata = await currentMetadata(tx, authority.orgId, data);
      const state = fresh.evidence.comparisonHash === data.expected.comparisonHash && metadata.policyState === "current" && metadata.cardState === "current" ? "matches_current_sources" : "source_changed";
      await recheckReportSession(tx, authority.actor, sessionHash!);
      return standingDecisionCurrentnessSchema.parse({ checkedAt: iso((await tx.query("SELECT clock_timestamp() AS now")).rows[0].now), state, ...metadata });
    });
  } catch (error: any) {
    if (!(error instanceof Problem) || ![404, 409, 422].includes(error.status)) throw error;
    // Reauthorize before reporting source absence; a revoked office scope must
    // never become a successful historical/currentness response.
    return transaction(db, async tx => {
      await lockAcademics(tx, supplied.org_id);
      const actor = await currentOffice(tx, supplied, sessionHash, data.source.identity.unitId), metadata = await currentMetadata(tx, actor.org_id, data);
      await recheckReportSession(tx, actor, sessionHash!);
      return standingDecisionCurrentnessSchema.parse({ checkedAt: iso((await tx.query("SELECT clock_timestamp() AS now")).rows[0].now), ...metadata,
        state: metadata.cardState === "changed" || error.status === 409 ? "source_changed" : "source_check_unavailable" });
    });
  }
}

export function installStandingDecisions(app: Express, db: Database) {
  const base = "/api/school/standing", actor = schoolActor, session = (req: any) => (req as AppRequest).sessionHash;
  const send = (res: any, data: unknown) => res.set("Cache-Control", "private, no-store").json(data);
  app.get(base + "/eligible-issues", async (req, res) => send(res, await eligibleStandingIssues(db, actor(req), session(req), req.query)));
  app.post(base + "/previews", async (req, res) => { const data = await prepareStanding(db, actor(req), session(req), req.body); send(res.status(201), data); });
  app.get(base + "/previews/:id", async (req, res) => send(res, await getStandingPreview(db, actor(req), session(req), req.params.id)));
  app.post(base + "/decisions", async (req, res) => { const data = await retainStanding(db, actor(req), session(req), req.body); send(res.status(data.replayed ? 200 : 201), data.decision); });
  app.get(base + "/decisions", async (req, res) => send(res, await listStandingDecisions(db, actor(req), session(req), req.query)));
  app.get(base + "/decisions/:id", async (req, res) => send(res, await getStandingDecision(db, actor(req), session(req), req.params.id)));
  app.get(base + "/decisions/:id/currentness", async (req, res) => send(res, await standingDecisionCurrentness(db, actor(req), session(req), req.params.id)));
  app.get(base + "/decisions/:id/export", async (req, res) => {
    const file = await exportStandingDecision(db, actor(req), session(req), req.params.id, req.query);
    res.set("Cache-Control", "private, no-store").set("X-STJW-File-SHA256", file.fileHash).type(file.contentType).attachment(file.filename).send(file.content);
  });
}
