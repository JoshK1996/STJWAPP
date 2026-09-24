import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { calculateTermGpa, type TermGpaPolicy } from "../shared/term-gpa";
import { gpaDecisionCursorSchema, gpaDecisionListInput, gpaDecisionSummarySchema, gpaReviewDataSchema, prepareGpaInput,
  retainGpaInput, exactGpaSummarySchema, gpaRetainResultSchema, type GpaReviewData, type GpaDecisionEnvelope } from "../shared/gpa-decisions";
import { gradingPolicyEvidenceHash, canonicalStandingJson as canonical } from "../server/standing-policy-provenance";
import { gpaPolicyEvidenceHash } from "../server/gpa-policies";
import { digest } from "../server/security";
import { verifyGpaReviewData, checkedGpaReview, verifyGpaDecisionEnvelope, checkedGpaDecision, deriveGpaSummary } from "../server/gpa-decision-evidence";
import { renderGpaDecision, gpaDecisionCsvColumns } from "../server/gpa-decision-export";
import type { StandingEvidenceV1 } from "../shared/standing-evidence";
import type { StandingSource } from "../shared/academic-standing";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-09-23T12:00:00.000Z", reason = "Synthetic explicitly reviewed GPA evidence";
const clone = <T>(value: T): T => structuredClone(value);
const inconsistent = (error: unknown) => (error as { status?: number }).status === 422;

/** Pure synthetic evidence; not a claim of DB authenticity or school policy. */
function fixture(): GpaReviewData {
  const rawPolicy = { name: "  Captured scale  ", calculation: "total_points" as const, missing: "exclude" as const,
    emptyCategories: "renormalize" as const, allowExtraCredit: false, capAt100: true, decimals: 2, rounding: "nearest" as const,
    categories: [{ id: id(20), name: "  Category  ", weight: 10000 }], scale: [{ label: " A ", minimum: 9000 }, { label: "B", minimum: 0 }] };
  const gradingHash = gradingPolicyEvidenceHash(rawPolicy), sourceHash = digest("synthetic issued full source"), issueHash = digest("synthetic issue");
  const identity = { orgId: id(1), unitId: id(2), yearId: id(3), studentId: id(4), termId: id(5), gradeLevel: "Synthetic" };
  const policy: TermGpaPolicy = { schemaVersion: 1, calculatorVersion: "term-gpa-v1", policyId: id(6), version: 1,
    orgId: identity.orgId, unitId: identity.unitId, yearId: identity.yearId, name: "Synthetic GPA policy", basis: "awarded_label",
    formula: "explicit_course_weighted_points", termIds: [identity.termId], gradeLevels: [identity.gradeLevel],
    minimumIncludedCourses: 2, missingWork: "use_reviewed_grade", display: { decimalPlaces: 4, rounding: "half_even" },
    acceptedGradingPolicies: [{ hash: gradingHash, version: 2, labelRules: [{ label: " A ", kind: "points", points: "3.25" }, { label: "B", kind: "points", points: "4.1" }] }],
    courseRules: [0, 1].map(i => ({ courseId: id(30 + i), disposition: "include" as const, required: true, weight: i ? "0.5" : "1.5", reason })) };
  const source: StandingSource = { schemaVersion: 1, identity, issue: { orgId: id(1), unitId: id(2), yearId: id(3), studentId: id(4),
    id: id(7), cardId: id(8), number: 1, cardVersion: 4, hash: issueHash, sourceHash, termIds: [id(5)] },
    current: { cardId: id(8), cardVersion: 4, latestIssueId: id(7), cardState: "issued", sourceHash, sourceState: "matches_issue" }, cells: [] };
  const year = { id: id(3), name: "Synthetic year", version: 1, starts_on: "2026-01-01", ends_on: "2026-12-31" };
  const term = { id: id(5), name: "Synthetic term", version: 1, starts_on: "2026-01-01", ends_on: "2026-06-30" };
  const issued = { student: { id: id(4), name: '=Synthetic, "student"\n🪐', studentNumber: "0000123", unitId: id(2), version: 1, personVersion: 1 }, year,
    terms: [term], enrollment: { id: id(9), version: 1, grade_level: "Synthetic", status: "enrolled" as const, starts_on: "2026-01-01", ends_on: "2026-12-31" } };
  const evidence: StandingEvidenceV1 = { schemaVersion: 1, kind: "standing_evidence", issueHash, issuedSourceHash: sourceHash, currentSourceHash: sourceHash,
    comparisonHash: digest("synthetic full comparison"), parents: { student: { id: id(4), personId: id(10), version: 1, personVersion: 1 },
      organization: { id: id(1), name: "Synthetic organization" }, unit: { id: id(2), name: "Synthetic unit", version: 1 },
      card: { id: id(8), version: 4, latestIssueId: id(7) }, issued, current: clone(issued) }, matrix: [], selectedReleases: [], fullCardDependencyUserIds: [id(11)] };
  for (let i = 0; i < 2; i++) {
    const projection: StandingEvidenceV1["selectedReleases"][number]["projection"] = { schemaVersion: 1, kind: "standing_student_release",
      orgId: id(1), unitId: id(2), releaseId: id(40 + i), bookId: id(50 + i), bookVersion: 3, createdBy: id(11), reviewedAt: date,
      section: { id: id(60 + i), courseId: id(30 + i) }, term: { id: id(5), yearId: id(3) }, gradingPolicy: { hash: gradingHash, version: 2 },
      student: { id: id(4), startsOn: "2026-01-01", endsOn: "2026-06-30" },
      grade: { percentage: i ? "89.25" : "95", label: i ? "B" : " A ", missing: 0, pending: 0, incomplete: false, hasEvidence: true, provisional: false } };
    const release = { hash: digest(canonical(projection)), projection, capturedPolicy: clone(rawPolicy) }; evidence.selectedReleases.push(release);
    const anchor = { section: { id: id(60 + i), name: "Synthetic section " + i, version: 1, archived: false,
      courseId: id(30 + i), courseCode: "SYN" + i, courseTitle: "Synthetic course " + i, courseVersion: 1 },
      roster: { version: 1, startsOn: "2026-01-01", endsOn: "2026-06-30" }, book: { id: id(50 + i), version: 3, status: "locked" as const, policyVersion: 2 },
      release: { id: id(40 + i), bookVersion: 3 }, inClass: true, problem: null };
    evidence.matrix.push({ sectionId: id(60 + i), termId: id(5), issued: anchor, current: clone(anchor) });
    source.cells.push({ sectionId: id(60 + i), courseId: id(30 + i), termId: id(5), printedIncluded: true, sourceState: "matches_issue",
      gradingPolicy: projection.gradingPolicy, release: { id: projection.releaseId, bookId: projection.bookId, bookVersion: 3, hash: release.hash, reviewedAt: date }, grade: projection.grade });
  }
  const { schemaVersion: _s, calculatorVersion: _c, policyId: _id, version: _v, orgId: _o, unitId: _u, yearId: _y, ...configuration } = policy;
  const hash = gpaPolicyEvidenceHash(policy);
  return gpaReviewDataSchema.parse({ schemaVersion: 1, calculatorVersion: "term-gpa-v1", policyVersion: { id: id(12), policyId: id(6), version: 1, hash,
    configurationHash: digest(canonical({ schemaVersion: 1, kind: "term_gpa_configuration", configuration })) }, policy,
    policyConfirmation: { sourceDescription: "Synthetic original configuration source", reason, confirmedBy: { id: id(11), name: "Synthetic owner" }, confirmedAt: date,
      evidence: { schemaVersion: 1, hashAlgorithm: "sha256-canonical-json-v1", catalogHash: digest("synthetic original catalog"), unit: { id: id(2), name: "Synthetic unit" },
        year: { id: id(3), name: year.name, version: 1, startsOn: year.starts_on, endsOn: year.ends_on, archived: false },
        terms: [{ id: id(5), name: term.name, version: 1, startsOn: term.starts_on, endsOn: term.ends_on, locked: false }],
        courses: [0, 1].map(i => ({ id: id(30 + i), code: "SYN" + i, title: "Synthetic course " + i, version: 1, archived: false, offeredInYear: true })),
        gradingPolicies: [{ hash: gradingHash, version: 2, policy: rawPolicy, provenance: [{ kind: "confirmed_settings", unitId: id(2), version: 2 }] }] } },
    source, evidence, result: calculateTermGpa({ policy, source }),
    labels: { studentName: issued.student.name, studentNumber: issued.student.studentNumber, yearName: year.name, termName: term.name,
      organizationName: "Synthetic organization", unitName: "Synthetic unit", courses: evidence.matrix.map(cell => ({ sectionId: cell.sectionId,
        courseId: cell.issued!.section.courseId, sectionName: cell.issued!.section.name, courseCode: cell.issued!.section.courseCode,
        courseTitle: cell.issued!.section.courseTitle, printDisposition: "included", printedExclusionReason: null })) },
    expected: { policyVersionId: id(12), policyHash: hash, cardId: id(8), cardVersion: 4, issueId: id(7), issueHash,
      currentSourceHash: sourceHash, comparisonHash: evidence.comparisonHash, latestDecisionId: null, latestDecisionNumber: 0 } });
}
function envelope(data = fixture()): GpaDecisionEnvelope {
  return { schemaVersion: 1, id: id(70), seriesId: id(71), number: 1, supersedesId: null, previewId: id(72), previewHash: digest(canonical(data)),
    capturedAt: date, reviewedBy: { id: id(73), name: "Synthetic reviewer" }, reason, data };
}
function stored(decision = envelope()) {
  const f = renderGpaDecision(decision), s = decision.data.source;
  return { id: decision.id, series_id: decision.seriesId, number: decision.number, supersedes_id: decision.supersedesId,
    org_id: s.identity.orgId, unit_id: s.identity.unitId, student_id: s.identity.studentId, year_id: s.identity.yearId, term_id: s.identity.termId,
    preview_id: decision.previewId, preview_hash: decision.previewHash, policy_id: decision.data.policyVersion.policyId,
    policy_version_id: decision.data.policyVersion.id, card_id: s.issue.cardId, card_version: s.issue.cardVersion, issue_id: s.issue.id,
    reviewed_by: decision.reviewedBy.id, reviewer_name: decision.reviewedBy.name, reason: decision.reason, outcome: decision.data.result.outcome,
    gpa_summary: deriveGpaSummary(decision.data.result), captured_at: date, snapshot_text: f.snapshotText, snapshot_hash: f.snapshotHash,
    json_text: f.jsonText, json_hash: f.jsonHash, csv_base64: Buffer.from(f.csvText).toString("base64"), csv_hash: f.csvHash,
    json_bytes: f.jsonBytes, csv_bytes: f.csvBytes, bytes: f.bytes };
}
const recalculate = (data: GpaReviewData) => { data.result = calculateTermGpa({ policy: data.policy, source: data.source }); return data; };
function reconfigure(data: GpaReviewData) {
  const { schemaVersion: _s, calculatorVersion: _c, policyId: _i, version: _v, orgId: _o, unitId: _u, yearId: _y, ...configuration } = data.policy;
  data.policyVersion.configurationHash = digest(canonical({ schemaVersion: 1, kind: "term_gpa_configuration", configuration }));
  data.policyVersion.hash = data.expected.policyHash = gpaPolicyEvidenceHash(data.policy); return recalculate(data);
}

test("GPA DTO inputs reject authored source, repeated query fields, unreviewed results and noncanonical cursors", () => {
  const d = fixture(), prepare = { policyVersionId: id(12), studentId: id(4), yearId: id(3), termId: id(5), reportCardIssueId: id(7) };
  assert.ok(prepareGpaInput.safeParse(prepare).success);
  for (const extra of [{ actorId: id(1) }, { result: d.result }, { source: d.source }, { orgId: id(1) }]) assert.equal(prepareGpaInput.safeParse({ ...prepare, ...extra }).success, false);
  const retain = { previewId: id(72), previewHash: digest(canonical(d)), expectedPolicyVersionId: id(12), expectedCardVersion: 4,
    expectedLatestDecisionId: null, reviewed: true, reason: "  " + reason + "  ", commandId: id(74) };
  assert.equal(retainGpaInput.parse(retain).reason, reason); assert.equal(retainGpaInput.safeParse({ ...retain, reviewed: false }).success, false);
  const query = { unitId: id(2), studentId: id(4), yearId: id(3) };
  assert.equal(gpaDecisionListInput.parse(query).latestOnly, false); assert.equal(gpaDecisionListInput.parse({ ...query, latestOnly: "true" }).latestOnly, true);
  for (const latestOnly of [true, "yes", "1", ["true"]]) assert.equal(gpaDecisionListInput.safeParse({ ...query, latestOnly }).success, false);
  assert.equal(gpaDecisionListInput.safeParse({ ...query, studentId: [id(4)] }).success, false);
  const cursor = { schemaVersion: 1, capturedAt: date, id: id(70), revision: 1000, filterHash: digest("filter") };
  assert.ok(gpaDecisionCursorSchema.safeParse(cursor).success);
  for (const altered of [{ schemaVersion: 2 }, { revision: 1001 }, { capturedAt: "2026-09-23T12:00:00Z" }, { filterHash: "bad" }])
    assert.equal(gpaDecisionCursorSchema.safeParse({ ...cursor, ...altered }).success, false);
  assert.equal(gpaDecisionListInput.safeParse({ ...query, cursor: "a".repeat(385) }).success, false);
});

test("GPA exact summary preserves reduced fractions and enforces incomplete null with retained wrapper", () => {
  const e = envelope(), f = renderGpaDecision(e), gpa = deriveGpaSummary(e.data.result)!;
  assert.deepEqual(gpa, { numerator: "277", denominator: "80", display: "3.4625", displayRule: { decimalPlaces: 4, rounding: "half_even" } });
  const summary = { id: e.id, seriesId: e.seriesId, number: 1, supersedesId: null, policyVersionId: id(12), outcome: "calculated",
    gpa, snapshotHash: f.snapshotHash, jsonHash: f.jsonHash, csvHash: f.csvHash, capturedAt: date };
  assert.ok(gpaRetainResultSchema.safeParse({ decision: summary, replayed: false }).success);
  assert.equal(gpaRetainResultSchema.safeParse(summary).success, false);
  for (const alteration of [{ outcome: "incomplete" }, { gpa: null }, { gpa: { ...gpa, numerator: "554", denominator: "160" } }, { gpa: { ...gpa, numerator: 277 } }])
    assert.equal(gpaDecisionSummarySchema.safeParse({ ...summary, ...alteration }).success, false);
  assert.equal(exactGpaSummarySchema.safeParse({ ...gpa, numerator: "0", denominator: "2" }).success, false);
});

test("raw policy whitespace, exact grades and complete confirmation evidence survive strict nested parsing", () => {
  const d = fixture(), text = canonical(d), verified = checkedGpaReview(text, digest(text));
  assert.equal(canonical(verified), text); assert.equal(verified.policyConfirmation.evidence.gradingPolicies[0].policy.name, "  Captured scale  ");
  assert.equal(verified.evidence.selectedReleases[0].capturedPolicy.scale[0].label, " A ");
  const bad = clone(d); bad.evidence.selectedReleases[0].capturedPolicy.name = "Captured scale";
  assert.throws(() => verifyGpaReviewData(bad), inconsistent);
  const unknown = clone(d) as unknown as Record<string, unknown>; unknown.invented = true;
  assert.throws(() => verifyGpaReviewData(unknown), inconsistent);
  assert.throws(() => checkedGpaReview(JSON.stringify(d), digest(JSON.stringify(d))), inconsistent);
});

test("changed normalized grades and every flag are rejected even after GPA and review hashes are recomputed", () => {
  const changes = [ { label: "B" }, { percentage: "99" }, { missing: 1 }, { pending: 1 }, { incomplete: true }, { provisional: true }, { hasEvidence: false } ];
  for (const alteration of changes) {
    const d = fixture(); d.source.cells[0].grade = { ...d.source.cells[0].grade!, ...alteration }; recalculate(d);
    assert.ok(gpaReviewDataSchema.safeParse(d).success, JSON.stringify(alteration));
    const text = canonical(d); assert.throws(() => checkedGpaReview(text, digest(text)), inconsistent);
    assert.throws(() => renderGpaDecision(envelope(d)), inconsistent);
  }
});

test("altered raw release or normalized identity cannot hide behind recomputed projection and result hashes", () => {
  for (const kind of ["student", "section", "term", "book", "policy_version", "review_time", "release_hash", "raw_grade"] as const) {
    const d = fixture(), r = d.evidence.selectedReleases[0];
    if (kind === "student") r.projection.student.id = id(900);
    if (kind === "section") r.projection.section.id = id(900);
    if (kind === "term") r.projection.term.id = id(900);
    if (kind === "book") r.projection.bookId = id(900);
    if (kind === "policy_version") r.projection.gradingPolicy.version++;
    if (kind === "review_time") d.source.cells[0].release!.reviewedAt = "2026-09-23T12:00:01.000Z";
    if (kind === "release_hash") d.source.cells[0].release!.hash = digest("changed");
    if (kind === "raw_grade") r.projection.grade.label = "B";
    r.hash = digest(canonical(r.projection)); recalculate(d);
    assert.throws(() => verifyGpaReviewData(d), inconsistent, kind);
  }
});

test("matrix completeness, captured labels and original policy selection identity are mandatory", () => {
  const mutations: ((d: GpaReviewData) => void)[] = [
    d => { d.evidence.matrix.push(clone(d.evidence.matrix[0])); },
    d => { d.source.cells.pop(); d.labels.courses.pop(); recalculate(d); },
    d => { d.labels.courses[0].sectionName = "Invented label"; },
    d => { d.labels.studentNumber = "changed"; },
    d => { d.source.identity.gradeLevel = "changed"; },
    d => { d.policyConfirmation.evidence.courses[1] = clone(d.policyConfirmation.evidence.courses[0]); },
    d => { d.evidence.selectedReleases.push(clone(d.evidence.selectedReleases[0])); },
    d => { d.expected.comparisonHash = digest("changed"); },
    d => { d.evidence.parents.current = null; },
  ];
  for (const mutate of mutations) { const d = fixture(); mutate(d); assert.throws(() => verifyGpaReviewData(d), inconsistent); }
});

test("printed-excluded stale releases remain raw evidence but cannot become usable normalized grades", () => {
  const d = fixture();
  for (const anchor of [d.evidence.matrix[0].issued!, d.evidence.matrix[0].current!]) { anchor.book!.status = "open"; anchor.problem = "review_required"; }
  d.labels.courses[0].printDisposition = "excluded"; d.labels.courses[0].printedExclusionReason = "Explicit synthetic printed exclusion";
  d.source.cells[0].printedIncluded = false; d.source.cells[0].grade = null; d.source.cells[0].release = null; d.source.cells[0].gradingPolicy = null; recalculate(d);
  assert.equal(verifyGpaReviewData(d).result.outcome, "incomplete");
  const raw = d.evidence.selectedReleases[0]; d.source.cells[0].grade = raw.projection.grade; d.source.cells[0].gradingPolicy = raw.projection.gradingPolicy;
  d.source.cells[0].release = { id: raw.projection.releaseId, bookId: raw.projection.bookId, bookVersion: raw.projection.bookVersion, hash: raw.hash, reviewedAt: raw.projection.reviewedAt }; recalculate(d);
  assert.throws(() => verifyGpaReviewData(d), inconsistent);
});

test("source-unavailable and current organization renames preserve issued labels and incomplete totals", () => {
  const d = fixture(); d.evidence.parents.organization.name = "Current renamed organization"; d.evidence.parents.unit.name = "Current renamed unit";
  d.source.current.sourceHash = d.evidence.currentSourceHash = d.expected.currentSourceHash = digest("changed current full source");
  d.source.current.sourceState = "source_changed"; recalculate(d);
  assert.equal(verifyGpaReviewData(d).labels.organizationName, "Synthetic organization");
  assert.equal(d.result.outcome, "incomplete"); assert.equal(deriveGpaSummary(d.result), null);
  d.evidence.parents.current = null; d.source.current.sourceHash = d.evidence.currentSourceHash = d.expected.currentSourceHash = null;
  d.source.current.sourceState = "source_unavailable"; for (const a of d.evidence.matrix) a.current = null;
  for (const c of d.source.cells) c.sourceState = "source_unavailable"; recalculate(d);
  assert.equal(verifyGpaReviewData(d).result.totals, null);
});

test("fixed GPA export keeps original exact text, full JSON evidence, BOM and formula protection", () => {
  const e = envelope(), f = renderGpaDecision(e), rows = parse(f.csvText, { bom: true, columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map(r => r.row_kind), ["evaluation", "course", "course"]);
  assert.equal(rows[0].gpa_numerator, "277"); assert.equal(rows[0].gpa_denominator, "80"); assert.equal(rows[0].gpa_display, "3.4625");
  assert.equal(rows[0].weighted_points_numerator, "277"); assert.equal(rows[0].weighted_points_denominator, "40");
  assert.equal(rows[0].total_weight_numerator, "2"); assert.equal(rows[0].total_weight_denominator, "1");
  assert.equal(rows[1].points, "3.25"); assert.equal(rows[1].weight, "1.5"); assert.equal(rows[1].awarded_label, " A ");
  assert.equal(rows[0].student_name, "'" + e.data.labels.studentName); assert.equal(rows[0].student_number, "0000123");
  assert.equal(f.csvText.codePointAt(0), 0xfeff); assert.ok(f.csvText.includes("\r\n")); assert.ok(!f.csvText.endsWith("\n"));
  assert.equal(f.jsonText, canonical({ schemaVersion: 1, snapshotHash: f.snapshotHash, decision: e }) + "\n");
  assert.equal(f.snapshotText, canonical(e)); assert.equal(f.bytes, Buffer.byteLength(f.snapshotText) + f.jsonBytes + f.csvBytes);
  for (const [text, hash] of [[f.snapshotText, f.snapshotHash], [f.jsonText, f.jsonHash], [f.csvText, f.csvHash]]) assert.equal(digest(text), hash);
  assert.equal(new Set(gpaDecisionCsvColumns).size, gpaDecisionCsvColumns.length); assert.equal(gpaDecisionCsvColumns.length, 79);
});

test("stored readback binds scope, summary, predecessor, exact file bytes and UTF-8 BOM without mutating row", () => {
  const row = stored(), original = clone(row), detail = checkedGpaDecision(row);
  assert.deepEqual(row, original); assert.equal(detail.decision.data.result.outcome, "calculated");
  const changed: Record<string, unknown>[] = [ { student_id: id(900) }, { reviewer_name: "Changed" }, { number: 2 }, { outcome: "incomplete" },
    { gpa_summary: { ...row.gpa_summary!, display: "3.4626" } }, { json_text: row.json_text + "\n" }, { csv_bytes: row.csv_bytes + 1 },
    { csv_base64: Buffer.from(Buffer.from(row.csv_base64, "base64").toString("utf8").slice(1)).toString("base64") } ];
  for (const alteration of changed) assert.throws(() => checkedGpaDecision({ ...row, ...alteration }), inconsistent);
  const e = envelope(); e.supersedesId = id(900); assert.throws(() => verifyGpaDecisionEnvelope(e), inconsistent);
  e.supersedesId = null; e.previewHash = digest("wrong"); assert.throws(() => verifyGpaDecisionEnvelope(e), inconsistent);
});

test("missing required courses resolve captured labels while incomplete exports never invent zero totals", () => {
  const d = fixture(); d.policy.courseRules.push({ courseId: id(80), disposition: "include", required: true, weight: "1", reason });
  d.policyConfirmation.evidence.courses.push({ id: id(80), code: "ABSENT", title: "Required captured missing course", version: 1, archived: false, offeredInYear: false });
  reconfigure(d); assert.equal(verifyGpaReviewData(d).result.outcome, "incomplete");
  const f = renderGpaDecision(envelope(d)), rows = parse(f.csvText, { bom: true, columns: true }) as Record<string, string>[];
  const missing = rows.find(r => r.row_kind === "blocker" && r.blocker_codes === "missing_required_course")!;
  assert.equal(missing.course_title, "Required captured missing course"); assert.equal(missing.course_code, "ABSENT");
  for (const row of rows) for (const key of ["gpa_numerator", "gpa_denominator", "gpa_display", "weighted_points_numerator", "weighted_points_denominator", "total_weight_numerator", "total_weight_denominator"])
    assert.equal(row[key], "");
  assert.equal(checkedGpaDecision(stored(envelope(d))).decision.data.result.totals, null);
});

test("calculated zero and huge exact points remain canonical string fractions in files and summary", () => {
  for (const points of ["0", "9999999999999999.999999"]) {
    const d = fixture(); for (const rule of d.policy.acceptedGradingPolicies[0].labelRules) if (rule.kind === "points") rule.points = points;
    reconfigure(d); const f = renderGpaDecision(envelope(d)), rows = parse(f.csvText, { bom: true, columns: true }) as Record<string, string>[];
    if (points === "0") { assert.equal(rows[0].gpa_numerator, "0"); assert.equal(rows[0].gpa_denominator, "1"); assert.equal(rows[0].gpa_display, "0.0000"); }
    else { assert.equal(rows[0].gpa_numerator, "9999999999999999999999"); assert.equal(rows[0].gpa_denominator, "1000000"); assert.equal(rows[1].points, points); }
    assert.deepEqual(deriveGpaSummary(d.result), stored(envelope(d)).gpa_summary);
  }
});

test("no selected cells can retain explicit incomplete evidence with full policy scale provenance", () => {
  const d = fixture(); d.evidence.matrix = []; d.evidence.selectedReleases = []; d.evidence.fullCardDependencyUserIds = [];
  d.source.cells = []; d.labels.courses = []; recalculate(d);
  const f = renderGpaDecision(envelope(d)), rows = parse(f.csvText, { bom: true, columns: true }) as Record<string, string>[];
  assert.equal(rows[0].row_kind, "evaluation"); assert.equal(rows[0].gpa_display, "");
  assert.equal(rows.filter(r => r.row_kind === "course").length, 0);
  assert.equal(JSON.parse(f.jsonText).decision.data.policyConfirmation.evidence.gradingPolicies.length, 1);
  assert.equal(checkedGpaDecision(stored(envelope(d))).decision.data.result.outcome, "incomplete");
});

test("unsupported source version, missing confirmation evidence and reordered matrices fail closed", () => {
  const d = fixture();
  for (const mutate of [
    (v: Record<string, any>) => { v.calculatorVersion = "term-gpa-v2"; },
    (v: Record<string, any>) => { delete v.policyConfirmation.evidence; },
    (v: Record<string, any>) => { v.evidence.selectedReleases[0].projection.schemaVersion = 2; },
    (v: Record<string, any>) => { v.source.cells.reverse(); v.result = calculateTermGpa({ policy: v.policy, source: v.source }); },
  ]) { const v = clone(d); mutate(v); assert.throws(() => verifyGpaReviewData(v), inconsistent); }
});

test("individually valid large evidence is rejected when combined retained files exceed the8MiB cap", () => {
  const d = fixture(), sourceCell = clone(d.source.cells[0]), matrixCell = clone(d.evidence.matrix[0]), release = clone(d.evidence.selectedReleases[0]), label = clone(d.labels.courses[0]);
  d.source.cells = []; d.evidence.matrix = []; d.evidence.selectedReleases = []; d.labels.courses = [];
  d.policy.courseRules = []; d.policyConfirmation.evidence.courses = [];
  for (let i = 0; i < 200; i++) {
    const sectionId = id(1000 + i), courseId = id(2000 + i), releaseId = id(3000 + i), bookId = id(4000 + i);
    const r = clone(release); r.projection.section = { id: sectionId, courseId }; r.projection.releaseId = releaseId; r.projection.bookId = bookId;
    r.hash = digest(canonical(r.projection)); d.evidence.selectedReleases.push(r);
    const m = clone(matrixCell); m.sectionId = sectionId;
    for (const a of [m.issued!, m.current!]) { a.section.id = sectionId; a.section.courseId = courseId; a.section.name = "S".repeat(5000);
      a.section.courseTitle = "T".repeat(5000); a.book!.id = bookId; a.release!.id = releaseId; }
    d.evidence.matrix.push(m);
    const c = clone(sourceCell); c.sectionId = sectionId; c.courseId = courseId; c.release = { id: releaseId, bookId, bookVersion: 3, hash: r.hash, reviewedAt: date };
    d.source.cells.push(c); d.labels.courses.push({ ...clone(label), sectionId, courseId, sectionName: m.issued!.section.name, courseTitle: m.issued!.section.courseTitle });
    d.policy.courseRules.push({ courseId, disposition: "include", required: true, weight: "1", reason });
    d.policyConfirmation.evidence.courses.push({ id: courseId, code: label.courseCode!, title: m.issued!.section.courseTitle!, version: 1, archived: false, offeredInYear: true });
  }
  reconfigure(d); assert.equal(verifyGpaReviewData(d).result.outcome, "calculated");
  assert.throws(() => renderGpaDecision(envelope(d)), error => inconsistent(error) && /size limit/.test((error as Error).message));
});
