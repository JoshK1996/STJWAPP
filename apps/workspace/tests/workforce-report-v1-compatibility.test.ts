import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connectDatabase, migrate, type Database } from "../server/db";
import { aggregateSegments, getReport, reportColumns, toCsv } from "../server/reports";
import { loadReportSource, saveReport, shapeReportRows } from "../server/report-library";
import { captureReportSnapshot, readReportSnapshot, readReportSnapshotPreview, listReportSnapshots } from "../server/report-snapshots";
import { reportDefinition, outputColumns } from "../shared/report-library";
import { snapshotDataSchema, snapshotEnvelopeSchema } from "../shared/report-snapshots";
import type { Actor } from "../server/security";

// Fixed pre-v2 evidence, specified independently of current serializers/readers.
// Each decimal timestamp is original synthetic source; expected v1 values are deliberately lossy.
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const V1_DEFINITION_TEXT = "{\"columns\":[\"employee_name\",\"kind\",\"started_at\",\"ended_at\",\"duration_ms\",\"revision\",\"id\"],\"groupBy\":\"employee\",\"layout\":\"details\",\"range\":{\"from\":\"2025-01-15\",\"preset\":\"custom\",\"to\":\"2025-01-15\"},\"sort\":{\"direction\":\"asc\",\"key\":\"id\"},\"source\":\"workforce\"}";
const V1_PAYLOAD_TEXT = "{\"asOf\":\"2025-01-15T16:00:00.000Z\",\"columns\":[{\"key\":\"employee_name\",\"label\":\"Employee\"},{\"key\":\"kind\",\"label\":\"Work / break\"},{\"key\":\"started_at\",\"label\":\"Started at (UTC)\"},{\"key\":\"ended_at\",\"label\":\"Ended at (UTC)\"},{\"key\":\"duration_ms\",\"label\":\"Duration (milliseconds)\"},{\"key\":\"revision\",\"label\":\"Shift revision\"},{\"key\":\"id\",\"label\":\"Segment ID\"}],\"definition\":{\"columns\":[\"employee_name\",\"kind\",\"started_at\",\"ended_at\",\"duration_ms\",\"revision\",\"id\"],\"groupBy\":\"employee\",\"layout\":\"details\",\"range\":{\"from\":\"2025-01-15\",\"preset\":\"custom\",\"to\":\"2025-01-15\"},\"sort\":{\"direction\":\"asc\",\"key\":\"id\"},\"source\":\"workforce\"},\"description\":\"Fixed v1 evidence.\",\"name\":\"Legacy workforce fixture\",\"notice\":\"Recorded work and break durations only. Paid-break, overtime, leave accrual, and payroll rules are not configured.\",\"provenance\":{},\"range\":{\"from\":\"2025-01-15\",\"to\":\"2025-01-15\"},\"reportId\":\"10000000-0000-4000-8000-000000000020\",\"reportVersion\":1,\"rowCount\":6,\"rows\":[{\"duration_ms\":1,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.001Z\",\"id\":\"10000000-0000-4000-8000-000000000011\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.000Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.001Z\",\"id\":\"10000000-0000-4000-8000-000000000012\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.001Z\"},{\"duration_ms\":1,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.002Z\",\"id\":\"10000000-0000-4000-8000-000000000013\",\"kind\":\"break\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.001Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.002Z\",\"id\":\"10000000-0000-4000-8000-000000000014\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.002Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:01:00.000Z\",\"id\":\"10000000-0000-4000-8000-000000000015\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:01:00.000Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:02:00.000Z\",\"id\":\"10000000-0000-4000-8000-000000000016\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:02:00.000Z\"}],\"schemaVersion\":1,\"source\":\"workforce\",\"sourceReadStartedAt\":\"2025-01-15T16:00:00.000Z\",\"sourceRowCount\":6,\"timezone\":\"UTC\"}";
const V1_PAYLOAD_HASH = "0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982";
const V1_ENVELOPE_TEXT = "{\"capturedAt\":\"2025-01-15T16:01:00.000Z\",\"data\":{\"asOf\":\"2025-01-15T16:00:00.000Z\",\"columns\":[{\"key\":\"employee_name\",\"label\":\"Employee\"},{\"key\":\"kind\",\"label\":\"Work / break\"},{\"key\":\"started_at\",\"label\":\"Started at (UTC)\"},{\"key\":\"ended_at\",\"label\":\"Ended at (UTC)\"},{\"key\":\"duration_ms\",\"label\":\"Duration (milliseconds)\"},{\"key\":\"revision\",\"label\":\"Shift revision\"},{\"key\":\"id\",\"label\":\"Segment ID\"}],\"definition\":{\"columns\":[\"employee_name\",\"kind\",\"started_at\",\"ended_at\",\"duration_ms\",\"revision\",\"id\"],\"groupBy\":\"employee\",\"layout\":\"details\",\"range\":{\"from\":\"2025-01-15\",\"preset\":\"custom\",\"to\":\"2025-01-15\"},\"sort\":{\"direction\":\"asc\",\"key\":\"id\"},\"source\":\"workforce\"},\"description\":\"Fixed v1 evidence.\",\"name\":\"Legacy workforce fixture\",\"notice\":\"Recorded work and break durations only. Paid-break, overtime, leave accrual, and payroll rules are not configured.\",\"provenance\":{},\"range\":{\"from\":\"2025-01-15\",\"to\":\"2025-01-15\"},\"reportId\":\"10000000-0000-4000-8000-000000000020\",\"reportVersion\":1,\"rowCount\":6,\"rows\":[{\"duration_ms\":1,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.001Z\",\"id\":\"10000000-0000-4000-8000-000000000011\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.000Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.001Z\",\"id\":\"10000000-0000-4000-8000-000000000012\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.001Z\"},{\"duration_ms\":1,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.002Z\",\"id\":\"10000000-0000-4000-8000-000000000013\",\"kind\":\"break\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.001Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:00:00.002Z\",\"id\":\"10000000-0000-4000-8000-000000000014\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:00:00.002Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:01:00.000Z\",\"id\":\"10000000-0000-4000-8000-000000000015\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:01:00.000Z\"},{\"duration_ms\":0,\"employee_name\":\"=Synthetic Worker\",\"ended_at\":\"2025-01-15T14:02:00.000Z\",\"id\":\"10000000-0000-4000-8000-000000000016\",\"kind\":\"work\",\"revision\":1,\"started_at\":\"2025-01-15T14:02:00.000Z\"}],\"schemaVersion\":1,\"source\":\"workforce\",\"sourceReadStartedAt\":\"2025-01-15T16:00:00.000Z\",\"sourceRowCount\":6,\"timezone\":\"UTC\"},\"id\":\"10000000-0000-4000-8000-000000000021\",\"payloadHash\":\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"reason\":\"Reviewed fixed v1 workforce evidence\",\"reviewerId\":\"10000000-0000-4000-8000-000000000002\",\"schemaVersion\":1}";
const V1_JSON_HASH = "75b10955af750ec9dc41d5a41a6ff893cd5dea050a60182927278abd21b4db10";
const V1_MANIFEST_TEXT = "{\"mode\":\"organization\",\"records\":[{\"id\":\"10000000-0000-4000-8000-000000000011\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000005\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"},{\"id\":\"10000000-0000-4000-8000-000000000012\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000005\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"},{\"id\":\"10000000-0000-4000-8000-000000000013\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000005\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"},{\"id\":\"10000000-0000-4000-8000-000000000014\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000005\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"},{\"id\":\"10000000-0000-4000-8000-000000000015\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000006\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"},{\"id\":\"10000000-0000-4000-8000-000000000016\",\"jobId\":\"10000000-0000-4000-8000-000000000004\",\"revision\":1,\"shiftId\":\"10000000-0000-4000-8000-000000000007\",\"unitId\":\"10000000-0000-4000-8000-000000000003\",\"userId\":\"10000000-0000-4000-8000-000000000002\"}],\"source\":\"workforce\",\"unitIds\":[\"10000000-0000-4000-8000-000000000003\"]}";
const V1_MANIFEST_HASH = "adab4d5a3f3799af254029e9866b653cb196a033ad2c93e485062d7ca7b9f372";
const V1_CSV_TEXT = "\"employee_name\",\"kind\",\"started_at\",\"ended_at\",\"duration_ms\",\"revision\",\"id\",\"snapshot_row_kind\",\"snapshot_row_count\",\"snapshot_source_row_count\",\"snapshot_id\",\"snapshot_captured_at\",\"snapshot_payload_hash\",\"report_id\",\"report_version\",\"report_as_of\",\"report_timezone\",\"report_source_versions\"\r\n\"'=Synthetic Worker\",\"work\",\"2025-01-15T14:00:00.000Z\",\"2025-01-15T14:00:00.001Z\",\"1\",\"1\",\"10000000-0000-4000-8000-000000000011\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"\r\n\"'=Synthetic Worker\",\"work\",\"2025-01-15T14:00:00.001Z\",\"2025-01-15T14:00:00.001Z\",\"0\",\"1\",\"10000000-0000-4000-8000-000000000012\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"\r\n\"'=Synthetic Worker\",\"break\",\"2025-01-15T14:00:00.001Z\",\"2025-01-15T14:00:00.002Z\",\"1\",\"1\",\"10000000-0000-4000-8000-000000000013\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"\r\n\"'=Synthetic Worker\",\"work\",\"2025-01-15T14:00:00.002Z\",\"2025-01-15T14:00:00.002Z\",\"0\",\"1\",\"10000000-0000-4000-8000-000000000014\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"\r\n\"'=Synthetic Worker\",\"work\",\"2025-01-15T14:01:00.000Z\",\"2025-01-15T14:01:00.000Z\",\"0\",\"1\",\"10000000-0000-4000-8000-000000000015\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"\r\n\"'=Synthetic Worker\",\"work\",\"2025-01-15T14:02:00.000Z\",\"2025-01-15T14:02:00.000Z\",\"0\",\"1\",\"10000000-0000-4000-8000-000000000016\",\"record\",\"6\",\"6\",\"10000000-0000-4000-8000-000000000021\",\"2025-01-15T16:01:00.000Z\",\"0606b2f6beb4fdfae6e5f1156e67d115b3e0ac215bb0e70bd420d93c4f7a6982\",\"10000000-0000-4000-8000-000000000020\",\"1\",\"2025-01-15T16:00:00.000Z\",\"UTC\",\"{}\"";
const V1_CSV_HASH = "d3817271c134696175ba21e0279b8e3f24978b403b91340f7e0855a97f695c7d";
const V1_DIRECT_CSV = "\ufeff\"employee_name\",\"unit_name\",\"job_title\",\"kind\",\"started_at\",\"ended_at\",\"duration_seconds\",\"shift_id\",\"id\",\"revision\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"work\",\"2025-01-15T14:02:00.000Z\",\"2025-01-15T14:02:00.000Z\",\"0\",\"10000000-0000-4000-8000-000000000007\",\"10000000-0000-4000-8000-000000000016\",\"1\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"work\",\"2025-01-15T14:01:00.000Z\",\"2025-01-15T14:01:00.000Z\",\"0\",\"10000000-0000-4000-8000-000000000006\",\"10000000-0000-4000-8000-000000000015\",\"1\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"work\",\"2025-01-15T14:00:00.002Z\",\"2025-01-15T14:00:00.002Z\",\"0\",\"10000000-0000-4000-8000-000000000005\",\"10000000-0000-4000-8000-000000000014\",\"1\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"break\",\"2025-01-15T14:00:00.001Z\",\"2025-01-15T14:00:00.002Z\",\"0.001\",\"10000000-0000-4000-8000-000000000005\",\"10000000-0000-4000-8000-000000000013\",\"1\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"work\",\"2025-01-15T14:00:00.001Z\",\"2025-01-15T14:00:00.001Z\",\"0\",\"10000000-0000-4000-8000-000000000005\",\"10000000-0000-4000-8000-000000000012\",\"1\"\r\n\"'=Synthetic Worker\",\"Synthetic Unit\",\"Synthetic job\",\"work\",\"2025-01-15T14:00:00.000Z\",\"2025-01-15T14:00:00.001Z\",\"0.001\",\"10000000-0000-4000-8000-000000000005\",\"10000000-0000-4000-8000-000000000011\",\"1\"";
const V1_DIRECT_CSV_HASH = "5d205fa6cb83a7ba943c2e7900ba9e6181a07d8a3ad1b0131d4a9721233ef851";
const sourceRows = [
  {
    "id": "10000000-0000-4000-8000-000000000011",
    "kind": "work",
    "started_at": "2025-01-15T14:00:00.000900Z",
    "ended_at": "2025-01-15T14:00:00.001100Z",
    "shift_id": "10000000-0000-4000-8000-000000000005",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  },
  {
    "id": "10000000-0000-4000-8000-000000000012",
    "kind": "work",
    "started_at": "2025-01-15T14:00:00.001100Z",
    "ended_at": "2025-01-15T14:00:00.001900Z",
    "shift_id": "10000000-0000-4000-8000-000000000005",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  },
  {
    "id": "10000000-0000-4000-8000-000000000013",
    "kind": "break",
    "started_at": "2025-01-15T14:00:00.001900Z",
    "ended_at": "2025-01-15T14:00:00.002100Z",
    "shift_id": "10000000-0000-4000-8000-000000000005",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  },
  {
    "id": "10000000-0000-4000-8000-000000000014",
    "kind": "work",
    "started_at": "2025-01-15T14:00:00.002100Z",
    "ended_at": "2025-01-15T14:00:00.002900Z",
    "shift_id": "10000000-0000-4000-8000-000000000005",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  },
  {
    "id": "10000000-0000-4000-8000-000000000015",
    "kind": "work",
    "started_at": "2025-01-15T14:01:00.000100Z",
    "ended_at": "2025-01-15T14:01:00.000900Z",
    "shift_id": "10000000-0000-4000-8000-000000000006",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  },
  {
    "id": "10000000-0000-4000-8000-000000000016",
    "kind": "work",
    "started_at": "2025-01-15T14:02:00.000100Z",
    "ended_at": "2025-01-15T14:02:00.000900Z",
    "shift_id": "10000000-0000-4000-8000-000000000007",
    "revision": 1,
    "user_id": "10000000-0000-4000-8000-000000000002",
    "employee_name": "=Synthetic Worker",
    "job_id": "10000000-0000-4000-8000-000000000004",
    "job_title": "Synthetic job",
    "unit_id": "10000000-0000-4000-8000-000000000003",
    "unit_name": "Synthetic Unit"
  }
];
let db: Database;
const owner: Actor = { id: id(2), org_id: id(1), name: '=Synthetic Worker', email: 'v1.fixture.owner@example.test', role: 'owner', mode: 'password', unit_ids: [id(3)] };
// This fixed, nonsecret proof exists only in a fresh in-memory test database. No HTTP listener or production connection is opened.
const sessionHash = 'a'.repeat(64), now = new Date('2025-01-15T16:00:00.000Z');
const query = { start: '2025-01-15', end: '2025-01-15', group: 'day' as const };
const reason = 'Reviewed fixed v1 workforce evidence';
const oldCommand = { version: 1, previewId: id(22), payloadHash: V1_PAYLOAD_HASH, commandId: id(23), reviewed: true as const, reason };
const pendingCommand = { ...oldCommand, previewId: id(32), commandId: id(34) };
const bytes = Buffer.byteLength(V1_PAYLOAD_TEXT) + Buffer.byteLength(V1_MANIFEST_TEXT) + Buffer.byteLength(V1_ENVELOPE_TEXT) + Buffer.byteLength(V1_CSV_TEXT);

before(async () => {
  db = await connectDatabase(); await migrate(db);
  await db.query("INSERT INTO organizations(id,name,timezone,demo) VALUES($1,'Synthetic v1 compatibility','UTC',false)", [owner.org_id]);
  await db.query("INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,$4,'owner')", [owner.id,owner.org_id,owner.email,owner.name]);
  await db.query("INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,'Synthetic Unit','department')", [id(3),owner.org_id]);
  await db.query("INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic job')", [id(4),owner.org_id,id(3)]);
  await db.query('INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)', [owner.org_id,owner.id,id(3)]);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,'password','synthetic-local-only',clock_timestamp()+interval '1 hour')", [sessionHash,owner.org_id,owner.id]);
  for (const shiftId of [id(5),id(6),id(7)]) {
    const rows=sourceRows.filter(row=>row.shift_id===shiftId);
    await db.query('INSERT INTO shifts(id,org_id,user_id,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,1)', [shiftId,owner.org_id,owner.id,rows[0].started_at,rows.at(-1)!.ended_at]);
  }
  for(const row of sourceRows) await db.query('INSERT INTO segments(id,org_id,shift_id,job_id,kind,started_at,ended_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)', [row.id,owner.org_id,row.shift_id,row.job_id,row.kind,row.started_at,row.ended_at]);
  await saveReport(db,owner,sessionHash,{id:id(20),version:0,name:'Legacy workforce fixture',description:'Fixed v1 evidence.',definition:JSON.parse(V1_DEFINITION_TEXT),archived:false,reason:'Create a fixed legacy compatibility definition'});
  await db.query('INSERT INTO report_run_snapshots(id,org_id,user_id,report_id,report_version,preview_id,payload_text,payload_hash,access_manifest,manifest_hash,json_text,json_hash,csv_text,csv_hash,bytes,captured_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [id(21),owner.org_id,owner.id,id(20),id(22),V1_PAYLOAD_TEXT,V1_PAYLOAD_HASH,V1_MANIFEST_TEXT,V1_MANIFEST_HASH,V1_ENVELOPE_TEXT,V1_JSON_HASH,V1_CSV_TEXT,V1_CSV_HASH,bytes,'2025-01-15T16:01:00.000Z']);
  // Fixed old fingerprint keys are in the historical canonical order, independent of the current capture implementation.
  const fingerprint=hash(JSON.stringify({commandId:id(23),payloadHash:V1_PAYLOAD_HASH,previewId:id(22),reason,reportId:id(20),reviewed:true,version:1}));
  await db.query('INSERT INTO report_snapshot_commands(org_id,user_id,command_id,snapshot_id,fingerprint) VALUES($1,$2,$3,$4,$5)', [owner.org_id,owner.id,id(23),id(21),fingerprint]);
  // This pre-existing v1 preview models a review prepared before a precision upgrade.
  await db.query("INSERT INTO report_run_previews(id,org_id,user_id,report_id,report_version,snapshot_id,payload_text,payload_hash,access_manifest,manifest_hash,bytes,expires_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '10 minutes')", [id(32),owner.org_id,owner.id,id(20),id(33),V1_PAYLOAD_TEXT,V1_PAYLOAD_HASH,V1_MANIFEST_TEXT,V1_MANIFEST_HASH,Buffer.byteLength(V1_PAYLOAD_TEXT)+Buffer.byteLength(V1_MANIFEST_TEXT)]);
});
after(async()=>{await db?.close();});

test('v1 arithmetic deliberately preserves repeated sub-millisecond truncation rather than new exact totals',()=>{
  // Independent exact durations: work 200+800+800+800+800=3400us, break200us.
  // Legacy Date boundaries produce work1ms and break1ms, total2ms (not3.6ms).
  assert.deepEqual(aggregateSegments(sourceRows,query,'UTC',now),{
    workMs:1,breakMs:1,
    buckets:[{key:'2025-01-15T00:00:00.000Z',label:'Jan 15',workMs:1,breakMs:1}],
    staff:[{id:owner.id,name:owner.name,workMs:1,breakMs:1}],
  });
});

test('v1 direct report numeric cells and BOM CRLF CSV remain fixed for microsecond SQL source',async()=>{
  const precise=(await db.query(`SELECT sum(extract(epoch FROM (ended_at-started_at))*1000000)::text AS microseconds FROM segments WHERE org_id=$1`,[owner.org_id])).rows[0];
  assert.equal(Number(precise.microseconds),3600);
  const result=await getReport(db,owner,query,now);
  assert.deepEqual({work:result.workMs,rest:result.breakMs,durations:result.rows.map(row=>row.duration_ms),seconds:result.rows.map(row=>row.duration_seconds)}, {work:1,rest:1,durations:[0,0,0,1,0,1],seconds:[0,0,0,0.001,0,0.001]});
  const csv=toCsv(result.rows,reportColumns);assert.equal(csv,V1_DIRECT_CSV);assert.equal(hash(csv),V1_DIRECT_CSV_HASH);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=Synthetic Worker"'));assert.ok(csv.includes('\r\n'));
});

test('unversioned definitions and v1 summary columns round-trip without precision defaults or changed units',async()=>{
  const definition=reportDefinition.parse(JSON.parse(V1_DEFINITION_TEXT));assert.deepEqual(definition,JSON.parse(V1_DEFINITION_TEXT));assert.equal(Object.hasOwn(definition,'precisionVersion'),false);
  const source=await db.transaction(tx=>loadReportSource(tx,owner,definition,now,{id:id(20),version:1,auditSources:false}));
  assert.deepEqual({...source.report,schemaVersion:1,name:'Legacy workforce fixture',description:'Fixed v1 evidence.',sourceReadStartedAt:now.toISOString()},JSON.parse(V1_PAYLOAD_TEXT));
  const summary=reportDefinition.parse({...definition,layout:'summary',sort:{key:'work_ms',direction:'desc'}});
  assert.deepEqual(outputColumns(summary).map(column=>column.key),['group_name','group_id','record_count','duration_ms','work_ms','break_ms']);
  assert.deepEqual(shapeReportRows(summary,source.rows).rows,[{group_name:owner.name,group_id:owner.id,record_count:6,duration_ms:2,work_ms:1,break_ms:1}]);
});

test('fixed old payload envelope manifest and CSV retain their exact hashes on read export and list',async()=>{
  assert.equal(hash(V1_PAYLOAD_TEXT),V1_PAYLOAD_HASH);assert.equal(hash(V1_ENVELOPE_TEXT),V1_JSON_HASH);assert.equal(hash(V1_MANIFEST_TEXT),V1_MANIFEST_HASH);assert.equal(hash(V1_CSV_TEXT),V1_CSV_HASH);
  assert.deepEqual(snapshotDataSchema.parse(JSON.parse(V1_PAYLOAD_TEXT)),JSON.parse(V1_PAYLOAD_TEXT));assert.deepEqual(snapshotEnvelopeSchema.parse(JSON.parse(V1_ENVELOPE_TEXT)),JSON.parse(V1_ENVELOPE_TEXT));
  const json=await readReportSnapshot(db,owner,sessionHash,id(20),id(21),'json'),csv=await readReportSnapshot(db,owner,sessionHash,id(20),id(21),'csv');
  assert.equal(json.content,V1_ENVELOPE_TEXT);assert.equal(json.jsonHash,V1_JSON_HASH);assert.equal(json.payloadHash,V1_PAYLOAD_HASH);assert.equal(csv.content,V1_CSV_TEXT);assert.equal(csv.csvHash,V1_CSV_HASH);
  assert.equal(csv.content!.startsWith('\uFEFF'),false);assert.deepEqual(json.snapshot,JSON.parse(V1_ENVELOPE_TEXT));
  const listed=await listReportSnapshots(db,owner,sessionHash,id(20));assert.equal(listed.rows[0].id,id(21));assert.equal(listed.rows[0].rowCount,6);assert.equal(listed.rows[0].csvHash,V1_CSV_HASH);
});

test('a pre-existing v1 review captures v1 bytes without silently upgrading definition or numeric rows',async()=>{
  const preview=await readReportSnapshotPreview(db,owner,sessionHash,id(20),id(32));assert.deepEqual(preview.data,JSON.parse(V1_PAYLOAD_TEXT));assert.equal(preview.payloadHash,V1_PAYLOAD_HASH);
  const captured=await captureReportSnapshot(db,owner,sessionHash,id(20),pendingCommand);assert.equal(captured.snapshot.id,id(33));
  const json=await readReportSnapshot(db,owner,sessionHash,id(20),id(33),'json'),csv=await readReportSnapshot(db,owner,sessionHash,id(20),id(33),'csv');
  const expectedJson=V1_ENVELOPE_TEXT.replace(id(21),id(33)).replace('2025-01-15T16:01:00.000Z',captured.snapshot.capturedAt);
  const expectedCsv=V1_CSV_TEXT.replaceAll(id(21),id(33)).replaceAll('2025-01-15T16:01:00.000Z',captured.snapshot.capturedAt);
  assert.equal(json.content,expectedJson);assert.equal(json.jsonHash,hash(expectedJson));assert.equal(json.payloadHash,V1_PAYLOAD_HASH);assert.equal(csv.content,expectedCsv);assert.equal(csv.csvHash,hash(expectedCsv));
  assert.equal((await db.query('SELECT id FROM report_run_previews WHERE id=$1',[id(32)])).rows.length,0);
});

test('old successful capture retry survives absent preview and later definition archive without regenerating bytes',async()=>{
  await saveReport(db,owner,sessionHash,{id:id(20),version:1,name:'Archived after precision planning',description:'This must not replace retained labels.',definition:JSON.parse(V1_DEFINITION_TEXT),archived:true,reason:'Archive the live definition after preserving evidence'});
  const replay=await captureReportSnapshot(db,owner,sessionHash,id(20),oldCommand);assert.equal(replay.snapshot.id,id(21));assert.equal(replay.snapshot.jsonHash,V1_JSON_HASH);assert.equal(replay.snapshot.csvHash,V1_CSV_HASH);
  await assert.rejects(captureReportSnapshot(db,owner,sessionHash,id(20),{...oldCommand,reason:'Different reason is a different command'}),(error: any)=>error.status===409);
  assert.equal((await readReportSnapshot(db,owner,sessionHash,id(20),id(21),'csv')).content,V1_CSV_TEXT);
  assert.deepEqual((await listReportSnapshots(db,owner,sessionHash,id(20))).rows.map(row=>row.id).sort(),[id(21),id(33)]);
});

test('legacy evidence is still denied after current scope loss and unchanged when authority returns',async()=>{
  await db.query("UPDATE users SET role='employee' WHERE id=$1",[owner.id]);
  try{await assert.rejects(readReportSnapshot(db,owner,sessionHash,id(20),id(21),'csv'),(error: any)=>error.status===404);await assert.rejects(captureReportSnapshot(db,owner,sessionHash,id(20),oldCommand),(error: any)=>error.status===404);assert.deepEqual((await listReportSnapshots(db,owner,sessionHash,id(20))).rows,[]);}
  finally{await db.query("UPDATE users SET role='owner' WHERE id=$1",[owner.id]);}
  assert.equal((await readReportSnapshot(db,owner,sessionHash,id(20),id(21),'json')).content,V1_ENVELOPE_TEXT);
});
