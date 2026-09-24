import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createStaff } from "../server/workforce";
import { lockAcademics, advanceAcademics, timetableCalendarMetadata } from "../server/timetable-engine";
import { exportTimetableCalendar, renderTimetableCalendar } from "../server/timetable-export";
import { timetableCalendarExportInput } from "../shared/timetable-export";

let db: Database, owner: Actor, units: string[], year: any, ownerAuth: Auth;
const origin = "http://localhost:3000", day = "2026-09-21";
type Auth = { hash: string; cookie: string; csrf: string };
const app = (database = db) => createApp(database, { origin, production: false, demo: true, staffDomain: "stjw.org" });
const unfold = (text: string) => text.replace(/\r\n[ \t]/g, "");
const denied = (error: any) => [401, 403, 404].includes(error.status);
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(), hash = digest(token), csrf = opaqueToken();
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", [hash, actor.org_id, actor.id, mode, csrf]);
  return { hash, cookie: "stjw_session=" + token, csrf };
}
async function send(path: string, body: unknown, auth = ownerAuth, method = "post", database = db) {
  return (request(app(database)) as any)[method]("/api" + path).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(body);
}
async function ok(path: string, body: unknown, auth = ownerAuth, method = "post") {
  const response = await send(path, body, auth, method);
  assert.ok(response.status < 300, JSON.stringify(response.body)); return response.body;
}
async function person(role: "owner" | "admin" | "manager" | "finance" | "employee" = "employee", unitIds = [units[0]]) {
  const id = await db.transaction(tx => createStaff(tx, owner, { name: "Synthetic instructional staff", email: randomUUID() + "@stjw.org", role, unitIds, jobIds: [] }, "stjw.org"));
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE id=$1", [id])).rows[0];
  return { ...row, mode: "password", unit_ids: unitIds } as Actor;
}
async function fixture(extra: Record<string, unknown> = {}) {
  const teacher = await person(), auth = await session(teacher);
  const section = await ok("/school/sections", { unitId: units[0], yearId: year.id, name: "Synthetic exported class " + randomUUID().slice(0, 6), teacherIds: [teacher.id], capacity: 30, homeroom: false });
  const input = { sectionId: section.id, roomId: null, startsOn: day, endsOn: day, weekdays: [1], startsAt: "09:00", endsAt: "10:00", reason: "Synthetic calendar export fixture", ...extra };
  const preview = await ok("/school/timetable/preview", input); assert.deepEqual(preview.issues, []);
  const saved = await ok("/school/timetable/save", { meeting: input, revision: preview.revision, reviewed: true, commandId: randomUUID() });
  const view = await request(app()).get("/api/school/timetable").set("Cookie", ownerAuth.cookie).query({ unitId: units[0], yearId: year.id, from: input.startsOn, to: input.endsOn, sectionId: section.id });
  assert.equal(view.status, 200);
  const query = { unitId: units[0], yearId: year.id, from: input.startsOn, to: input.endsOn, sectionId: section.id, expectedRevision: view.body.revision };
  return { teacher, auth, section, input, saved, query, view: view.body };
}
async function currentQuery(query: any) {
  const metadata = await db.transaction(async tx => { await lockAcademics(tx, owner.org_id); return timetableCalendarMetadata(tx, owner.org_id); });
  return { ...query, expectedRevision: metadata.revision };
}
// Real committed mutations between completed service phases. This proves the
// publication boundary, not cross-connection PostgreSQL wait behavior.
function afterPhase(phase: number, mutation: () => Promise<unknown>) {
  let phases = 0;
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    const result = await db.transaction(fn); phases++;
    if (phases === phase) await mutation(); return result;
  } } as Database;
}
function wrappedQueries(handler: (tx: Queryable, sql: string, params?: any[]) => Promise<void>) {
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({
    query: async <R extends Row = Row>(sql: string, params?: any[]) => { await handler(tx, sql, params); return tx.query<R>(sql, params); },
  })) } as Database;
}
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "timetable.export.owner@example.test" });
  const row = (await db.query("SELECT id,org_id,name,email,role FROM users WHERE role='owner'")).rows[0];
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map(r => r.id);
  owner = { ...row, mode: "password", unit_ids: units } as Actor; ownerAuth = await session(owner);
  year = await ok("/school/years", { unitId: units[0], name: "Synthetic export year", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  await ok("/school/attendance/config", { unitId: units[0], weekdays: [1, 2, 3, 4, 5, 6, 7], periods: ["Daily"], confirmed: true, version: 0, reason: "Synthetic instructional export configuration" }, ownerAuth, "put");
});
after(async () => { await db?.close(); });

test("strict local date request accepts367 inclusive days and rejects368, timestamps and hidden input", () => {
  const q = { unitId: randomUUID(), yearId: randomUUID(), from: "2026-01-01", to: "2027-01-02", expectedRevision: 0 };
  assert.equal(timetableCalendarExportInput.safeParse(q).success, true);
  for (const bad of [{ ...q, to: "2027-01-03" }, { ...q, to: "2026-02-30" }, { ...q, from: "2026-01-01T00:00:00Z" }, { ...q, to: "2025-01-01" }, { ...q, sectionId: [randomUUID()] }, { ...q, studentNumber: " " }, { ...q, expectedRevision: "0" }, { ...q, audience: "organization" }]) assert.equal(timetableCalendarExportInput.safeParse(bad).success, false);
});

function source(extra = {}) {
  return { formatVersion: 1, orgId: randomUUID(), unitId: randomUUID(), yearId: randomUUID(), from: day, to: "2026-09-22", timezone: "America/New_York", revision: 3, calendarRevisedAt: "2026-09-20T12:34:56.123456Z", events: [{ meetingId: randomUUID(), sectionId: randomUUID(), day, title: "Café 🎨 漢字 ".repeat(16), room: "Room 1; east, west\\north\r\nATTENDEE:outside", startsAt: "09:00", endsAt: "10:00", starts: "2026-09-21T13:00:00.000Z", ends: "2026-09-21T14:00:00.000Z", version: 1 }], ...extra };
}
test("renderer preserves dated identity, exact stable hashes, UTF8 folding and private fixed ICS properties", () => {
  const input = source(), file = renderTimetableCalendar(input), full = unfold(file.content);
  assert.equal(file.fileSha256, digest(file.content)); assert.deepEqual(renderTimetableCalendar(input), file);
  assert.ok(full.includes("DTSTAMP:20260920T123456Z\r\nLAST-MODIFIED:20260920T123456Z"));
  assert.ok(full.includes("LOCATION:Room 1\\; east\\, west\\\\north\\nATTENDEE:outside"));
  assert.ok(file.content.endsWith("END:VCALENDAR\r\n"));
  for (const line of file.content.split("\r\n")) { assert.ok(Buffer.byteLength(line) <= 75); assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line)), line); }
  assert.ok(!/(^|[^\r])\n/.test(file.content));
  assert.ok(!/^((METHOD|RRULE|EXDATE|ORGANIZER|ATTENDEE|ATTACH|URL|SEQUENCE):|BEGIN:VALARM)/m.test(full));
  const changed = renderTimetableCalendar({ ...input, revision: 4, events: [{ ...input.events[0], title: "Changed" }] });
  assert.equal(full.match(/UID:[^\r]+/)?.[0], unfold(changed.content).match(/UID:[^\r]+/)?.[0]); assert.notEqual(changed.fileSha256, file.fileSha256);
  const next = renderTimetableCalendar({ ...input, events: [...input.events, { ...input.events[0], day: "2026-09-22", starts: "2026-09-22T13:00:00Z", ends: "2026-09-22T14:00:00Z" }] });
  assert.equal(new Set(unfold(next.content).match(/UID:[^\r]+/g)).size, 2);
  assert.notEqual(unfold(renderTimetableCalendar({ ...input, orgId: randomUUID() }).content).match(/UID:[^\r]+/)?.[0], full.match(/UID:[^\r]+/)?.[0]);
  assert.throws(() => renderTimetableCalendar({ ...input, events: [input.events[0], input.events[0]] }), /duplicate/);
  assert.throws(() => renderTimetableCalendar({ ...input, events: [{ ...input.events[0], ends: input.events[0].starts }] }), /duration/);
  assert.throws(() => renderTimetableCalendar({ ...input, events: [{ ...input.events[0], title: "x".repeat(5 * 1024 * 1024) }] }), /size limit/);
});

test("GET metadata and POST attachment share source revision, omit private roster data and preserve CSV columns", async () => {
  const f = await fixture();
  assert.equal(typeof f.view.revision, "number"); assert.match(f.view.calendarRevisedAt, /^\d{4}-.*Z$/);
  const r = await send("/school/timetable/export", f.query, f.auth);
  assert.equal(r.status, 200, r.text); assert.match(r.headers["content-type"], /text\/calendar.*utf-8/);
  assert.equal(r.headers["cache-control"], "private, no-store"); assert.match(r.headers["content-disposition"], /stjw-timetable-2026-09-21-to-2026-09-21.ics/);
  assert.equal(r.headers["x-stjw-file-sha256"], digest(r.text)); assert.equal(r.headers["x-stjw-timetable-revision"], String(f.query.expectedRevision));
  assert.equal(r.headers["x-stjw-occurrence-count"], "1"); assert.ok(!r.text.includes(f.teacher.id) && !r.text.includes(f.teacher.email));
  const again = await exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query); assert.equal(again.content, r.text);
  const csv = await request(app()).get("/api/school/timetable").set("Cookie", ownerAuth.cookie).query({ unitId: units[0], yearId: year.id, from: day, to: day, sectionId: f.section.id, format: "csv" });
  assert.equal(csv.text.split(/\r?\n/)[0], '\ufeff"day","start","end","timezone","class","room","teachers","meeting_id","version"');
  const audit = (await db.query("SELECT detail FROM audit_events WHERE action='school.timetable_exported' AND actor_id=$1 ORDER BY created_at DESC LIMIT 1", [f.teacher.id])).rows[0].detail;
  assert.equal(audit.fileSha256, digest(r.text)); assert.equal(audit.hasSectionFilter, true);
  for (const privateValue of [f.teacher.id, f.section.id, f.section.name]) assert.ok(!JSON.stringify(audit).includes(privateValue));
});

test("password/CSRF/current unit/class/year authority rejects unavailable users and filters", async () => {
  const f = await fixture(), outsider = await person("manager"), otherTeacher = await fixture(), outsiderAuth = await session(outsider);
  for (const actor of [outsider, await person("finance"), await person("employee", [units[1]])]) await assert.rejects(exportTimetableCalendar(db, actor, (await session(actor)).hash, await currentQuery(f.query)), denied);
  await assert.rejects(exportTimetableCalendar(db, otherTeacher.teacher, otherTeacher.auth.hash, await currentQuery(f.query)), denied);
  await assert.rejects(exportTimetableCalendar(db, f.teacher, f.auth.hash, { ...await currentQuery(f.query), studentNumber: "Unknown exact student" }), denied);
  await assert.rejects(exportTimetableCalendar(db, owner, ownerAuth.hash, { ...await currentQuery(f.query), yearId: randomUUID() }), denied);
  await assert.rejects(exportTimetableCalendar(db, owner, ownerAuth.hash, { ...await currentQuery(f.query), unitId: units[1] }), denied);
  const q = await currentQuery(f.query);
  assert.equal((await request(app()).post("/api/school/timetable/export").set("Origin", origin).send(q)).status, 401);
  assert.equal((await request(app()).post("/api/school/timetable/export").set("Cookie", f.auth.cookie).set("Origin", origin).send(q)).status, 403);
  const pin = await session(f.teacher, "pin"); assert.equal((await send("/school/timetable/export", q, pin)).status, 403);
  await assert.rejects(exportTimetableCalendar(db, { ...owner, mode: "api" }, ownerAuth.hash, q), denied);
  await assert.rejects(exportTimetableCalendar(db, owner, undefined, q), denied);
  await db.query("UPDATE users SET active=false WHERE id=$1", [outsider.id]);
  await assert.rejects(exportTimetableCalendar(db, outsider, outsiderAuth.hash, q), denied);
});

test("publication rejects actual teacher, office, unit, role and session revocation after extraction", async () => {
  for (const kind of ["teacher", "office", "unit", "role", "session"]) {
    const f = await fixture(); let actor = f.teacher, auth = f.auth;
    if (["office", "role"].includes(kind)) { actor = await person(kind === "role" ? "admin" : "employee"); auth = await session(actor); }
    if (kind === "office") await ok("/school/office-grants", { unitId: units[0], userId: actor.id, enabled: true });
    const mutation = () => kind === "teacher" ? db.query("DELETE FROM section_teachers WHERE user_id=$1", [actor.id])
      : kind === "office" ? db.query("DELETE FROM school_office_grants WHERE user_id=$1", [actor.id])
      : kind === "unit" ? db.query("DELETE FROM user_units WHERE user_id=$1", [actor.id])
      : kind === "role" ? db.query("UPDATE users SET role='employee' WHERE id=$1", [actor.id])
      : db.query("DELETE FROM sessions WHERE token_hash=$1", [auth.hash]);
    const database = afterPhase(2, mutation), result = await send("/school/timetable/export", f.query, auth, "post", database);
    assert.ok([401, 403, 404].includes(result.status), kind + ": " + result.text);
    assert.ok(!result.headers["content-disposition"] && !result.text.includes("BEGIN:VCALENDAR"));
    assert.equal((await db.query("SELECT id FROM audit_events WHERE action='school.timetable_exported' AND actor_id=$1", [actor.id])).rows.length, 0);
  }
});

test("source phase and final publication recheck scope while keeping academic and authority locks in separate transactions", async () => {
  const f = await fixture();
  const deniedBetween = afterPhase(1, () => db.query("DELETE FROM section_teachers WHERE user_id=$1", [f.teacher.id]));
  await assert.rejects(exportTimetableCalendar(deniedBetween, f.teacher, f.auth.hash, f.query), denied);
  const traces: string[][] = [];
  const database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
    const statements: string[] = []; traces.push(statements);
    return db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => { statements.push(sql); return tx.query<R>(sql, params); } }));
  } } as Database;
  await exportTimetableCalendar(database, owner, ownerAuth.hash, f.query);
  assert.equal(traces.length, 3);
  assert.ok(traces[1].some(sql => sql.includes("pg_advisory_xact_lock")));
  assert.ok(!traces[1].some(sql => /FOR (SHARE|UPDATE|NO KEY)/.test(sql)));
  for (const trace of [traces[0], traces[2]]) assert.ok(!trace.some(sql => sql.includes("pg_advisory_xact_lock") || /FROM sections.*FOR /s.test(sql)));
});

test("revision changes before extraction require refresh; changes after extraction preserve captured bytes and dated UID", async () => {
  const f = await fixture();
  const change = () => ok(`/school/sections/${f.section.id}`, { version: f.section.version, name: "Renamed synthetic export class", room: "", capacity: 30, teacherIds: [f.teacher.id] }, ownerAuth, "patch");
  const captured = await exportTimetableCalendar(afterPhase(2, change), f.teacher, f.auth.hash, f.query);
  assert.ok(captured.content.includes(f.section.name)); assert.ok(!captured.content.includes("Renamed synthetic"));
  await assert.rejects(exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query), (e: any) => e.status === 409);
  const next = await exportTimetableCalendar(db, f.teacher, f.auth.hash, await currentQuery(f.query));
  assert.ok(next.content.includes("Renamed synthetic")); assert.notEqual(next.fileSha256, captured.fileSha256);
  assert.equal(unfold(next.content).match(/UID:[^\r]+/)?.[0], unfold(captured.content).match(/UID:[^\r]+/)?.[0]);
  const q = await currentQuery(f.query);
  await assert.rejects(exportTimetableCalendar(afterPhase(1, () => db.transaction(async tx => { await lockAcademics(tx, owner.org_id); await advanceAcademics(tx, owner.org_id); })), owner, ownerAuth.hash, q), (e: any) => e.status === 409);
});

test("representation timestamps preserve microseconds and strictly advance beyond a future baseline", async () => {
  const orgId = randomUUID();
  await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic future timestamp baseline','UTC')", [orgId]);
  await db.query("INSERT INTO timetable_revisions(org_id,version,calendar_revised_at) VALUES($1,7,'2099-01-01T00:00:00.000000Z')", [orgId]);
  const meta = await db.transaction(async tx => { await lockAcademics(tx, orgId); return timetableCalendarMetadata(tx, orgId); });
  assert.match(meta.calendarRevisedAt, /\.\d{6}Z$/);
  const next = await db.transaction(async tx => { await lockAcademics(tx, orgId); await advanceAcademics(tx, orgId); return timetableCalendarMetadata(tx, orgId); });
  assert.equal(next.revision, meta.revision + 1); assert.equal(next.calendarRevisedAt, "2099-01-01T00:00:00.000001Z");
  await db.query("UPDATE timetable_revisions SET calendar_revised_at='2100-01-01' WHERE org_id=$1", [orgId]);
  assert.deepEqual(await timetableCalendarMetadata(db, orgId), next);
  await db.query("UPDATE timetable_revisions SET version=version+1 WHERE org_id=$1", [orgId]);
  assert.equal((await timetableCalendarMetadata(db, orgId)).calendarRevisedAt, "2099-01-01T00:00:00.000002Z");
});

test("audit failure and expiry after audit roll back the download audit and publish no attachment", async () => {
  const f = await fixture();
  const failure = wrappedQueries(async (_tx, sql, params) => { if (sql.includes("INSERT INTO audit_events") && params?.includes("school.timetable_exported")) throw new Error("Synthetic export audit failure"); });
  const failed = await send("/school/timetable/export", f.query, f.auth, "post", failure);
  assert.equal(failed.status, 500); assert.ok(!failed.headers["content-disposition"]);
  let expired = false;
  const database = { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction(tx => fn({ query: async <R extends Row = Row>(sql: string, params?: any[]) => {
    const result = await tx.query<R>(sql, params);
    if (sql.includes("INSERT INTO audit_events") && params?.includes("school.timetable_exported")) { expired = true; await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [f.auth.hash]); }
    return result;
  } })) } as Database;
  const result = await send("/school/timetable/export", f.query, f.auth, "post", database);
  assert.equal(result.status, 401); assert.equal(expired, true); assert.ok(!result.headers["content-disposition"]);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE action='school.timetable_exported' AND actor_id=$1", [f.teacher.id])).rows.length, 0);
});

test("student filter uses dated places without disclosing identity and requires office even when all classes remain assigned", async () => {
  const f = await fixture({ startsOn: "2026-09-21", endsOn: "2026-09-23", weekdays: [1, 2, 3] });
  const student = await ok("/school/students", { unitId: units[0], name: "Synthetic private pupil", studentNumber: randomUUID() });
  await ok(`/school/students/${student.id}/enrollments`, { enrollment: { yearId: year.id, gradeLevel: "2", startsOn: "2026-01-01", endsOn: "2026-12-31" } });
  await ok(`/school/sections/${f.section.id}/roster`, { studentId: student.id, startsOn: "2026-09-22", endsOn: "2026-09-22" });
  await ok("/school/office-grants", { unitId: units[0], userId: f.teacher.id, enabled: true });
  await db.query("UPDATE students SET active=false WHERE id=$1", [student.id]);
  const query = { ...await currentQuery(f.query), studentNumber: student.student_number };
  const file = await exportTimetableCalendar(db, f.teacher, f.auth.hash, query);
  assert.equal(file.count, 1); assert.ok(unfold(file.content).includes("X-STJW-SOURCE-DATE:2026-09-22"));
  for (const value of [student.id, student.student_number, "Synthetic private pupil", f.teacher.id]) assert.ok(!file.content.includes(value));
  assert.equal(file.filename, "stjw-timetable-2026-09-21-to-2026-09-23.ics");
  const audit = (await db.query("SELECT detail FROM audit_events WHERE action='school.timetable_exported' AND actor_id=$1 ORDER BY created_at DESC LIMIT 1", [f.teacher.id])).rows[0].detail;
  assert.equal(audit.hasStudentFilter, true); assert.ok(!JSON.stringify(audit).includes(student.student_number));
  await assert.rejects(exportTimetableCalendar(afterPhase(2, () => db.query("DELETE FROM school_office_grants WHERE user_id=$1", [f.teacher.id])), f.teacher, f.auth.hash, query), denied);
});

test("instructional overrides intersect pattern weekdays, revision advances, cancellations and empty filters never produce partial files", async () => {
  const f = await fixture({ startsOn: "2026-09-21", endsOn: "2026-09-23", weekdays: [1, 2] });
  const before = f.view.calendarRevisedAt;
  await ok("/school/attendance/days", { unitId: units[0], yearId: year.id, date: "2026-09-22", instructional: false, label: "Synthetic holiday", version: 0 }, ownerAuth, "put");
  await ok("/school/attendance/days", { unitId: units[0], yearId: year.id, date: "2026-09-23", instructional: true, label: "Synthetic instructional day", version: 0 }, ownerAuth, "put");
  let query = await currentQuery(f.query), file = await exportTimetableCalendar(db, owner, ownerAuth.hash, query);
  assert.equal(file.count, 1); assert.ok(unfold(file.content).includes("X-STJW-SOURCE-DATE:2026-09-21"));
  const metadata = await db.transaction(async tx => { await lockAcademics(tx, owner.org_id); return timetableCalendarMetadata(tx, owner.org_id); });
  assert.ok(metadata.calendarRevisedAt > before);
  await assert.rejects(exportTimetableCalendar(db, owner, ownerAuth.hash, { ...query, teacherId: randomUUID() }), (e: any) => e.status === 400);
  await ok(`/school/timetable/${f.saved.id}/cancel`, { version: f.saved.version, reason: "Synthetic cancelled export pattern", commandId: randomUUID() });
  query = await currentQuery(query);
  await assert.rejects(exportTimetableCalendar(db, owner, ownerAuth.hash, query), (e: any) => e.status === 400);
  await db.query("UPDATE sections SET archived=true WHERE id=$1", [f.section.id]);
  await assert.rejects(exportTimetableCalendar(db, owner, ownerAuth.hash, query), (e: any) => e.status === 404);
});

test("engine UTC export retains local wall times across DST and rejects gaps, folds and unconfirmed calendars", async () => {
  for (const [start, end, expected] of [
    ["2026-03-07", "2026-03-08", ["20260307T140000Z", "20260308T130000Z"]],
    ["2026-10-31", "2026-11-01", ["20261031T130000Z", "20261101T140000Z"]],
  ] as const) {
    const f = await fixture({ startsOn: start, endsOn: end, weekdays: [6, 7] });
    const file = unfold((await exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query)).content);
    for (const value of expected) assert.ok(file.includes("DTSTART:" + value));
  }
  const f = await fixture();
  // Invalid fixture states deliberately bypass normal save validation to prove
  // the reader refuses malformed legacy data instead of omitting bad events.
  for (const [date, start, end] of [["2026-03-08", "02:30", "03:30"], ["2026-11-01", "01:15", "01:45"]]) {
    await db.query("UPDATE timetable_meetings SET starts_on=$2,ends_on=$2,weekdays=ARRAY[7],starts_at=$3,ends_at=$4 WHERE id=$1", [f.saved.id, date, start, end]);
    await assert.rejects(exportTimetableCalendar(db, f.teacher, f.auth.hash, { ...f.query, from: date, to: date }), (e: any) => e.status === 409);
  }
  await db.query("UPDATE timetable_meetings SET starts_on=$2,ends_on=$2,weekdays=ARRAY[1],starts_at='09:00',ends_at='10:00' WHERE id=$1", [f.saved.id, day]);
  await db.query("UPDATE attendance_settings SET confirmed=false WHERE unit_id=$1", [units[0]]);
  try { await assert.rejects(exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query), (e: any) => e.status === 409); }
  finally { await db.query("UPDATE attendance_settings SET confirmed=true WHERE unit_id=$1", [units[0]]); }
});

test("MFA, stale supplied role and session deletion before preflight are rejected", async () => {
  const f = await fixture(), admin = await person("admin"), auth = await session(admin);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [admin.id]);
  await assert.rejects(exportTimetableCalendar(db, admin, auth.hash, f.query), denied);
  await db.query("DELETE FROM sessions WHERE token_hash=$1", [auth.hash]);
  await assert.rejects(exportTimetableCalendar(db, admin, auth.hash, f.query), denied);
  await db.query("UPDATE sessions SET mfa_verified=false WHERE token_hash=$1", [f.auth.hash]);
  // Match the actual factor schema without storing a real TOTP secret.
  await db.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-not-a-secret','synthetic',now(),now())", [f.teacher.id, owner.org_id, randomUUID()]);
  await assert.rejects(exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query), (e: any) => e.status === 401);
});

test("migration023 establishes an additive timestamp baseline and preserves existing revision numbers", async () => {
  const isolated = await connectDatabase();
  try {
    await isolated.query("CREATE TABLE timetable_revisions(org_id uuid PRIMARY KEY,version integer NOT NULL DEFAULT 0)");
    const id = randomUUID(); await isolated.query("INSERT INTO timetable_revisions VALUES($1,42)", [id]);
    const before = Date.now(), migration = await readFile(new URL("../server/migrations/023_timetable_calendar_revision.sql", import.meta.url), "utf8");
    for (const sql of migration.match(/(?:[^;$]|\$(?!\$)|\$\$[\s\S]*?\$\$)+;/g) ?? []) await isolated.query(sql);
    const row = (await isolated.query("SELECT * FROM timetable_revisions")).rows[0];
    assert.equal(row.version, 42); assert.ok(new Date(row.calendar_revised_at).getTime() >= before && new Date(row.calendar_revised_at).getTime() <= Date.now());
    const exact = (await isolated.query("SELECT calendar_revised_at::text AS timestamp FROM timetable_revisions WHERE org_id=$1", [id])).rows[0].timestamp;
    await isolated.query("UPDATE timetable_revisions SET version=version+1 WHERE org_id=$1", [id]);
    assert.equal((await isolated.query("SELECT version,calendar_revised_at>$2::timestamptz AS advanced FROM timetable_revisions WHERE org_id=$1", [id,exact])).rows[0].advanced, true);
    const next = (await isolated.query("INSERT INTO timetable_revisions(org_id) VALUES($1) RETURNING *", [randomUUID()])).rows[0];
    assert.equal(next.version, 0); assert.ok(next.calendar_revised_at);
  } finally { await isolated.close(); }
});

test("every captured class is reauthorized; losing one assignment cannot publish a reduced file", async () => {
  const f = await fixture();
  const section = await ok("/school/sections", { unitId: units[0], yearId: year.id, name: "Synthetic second permitted class", teacherIds: [f.teacher.id], capacity: 30, homeroom: false });
  const input = { ...f.input, sectionId: section.id, startsAt: "10:00", endsAt: "11:00" };
  const preview = await ok("/school/timetable/preview", input);
  await ok("/school/timetable/save", { meeting: input, revision: preview.revision, reviewed: true, commandId: randomUUID() });
  const { sectionId: _unused, ...query } = await currentQuery(f.query);
  assert.equal((await exportTimetableCalendar(db, f.teacher, f.auth.hash, query)).count, 2);
  await assert.rejects(exportTimetableCalendar(afterPhase(2, () => db.query("DELETE FROM section_teachers WHERE section_id=$1 AND user_id=$2", [section.id, f.teacher.id])), f.teacher, f.auth.hash, query), denied);
});

test("positive and negative UTC zones preserve the local occurrence date in its identity", async () => {
  for (const [zone, startsAt, endsAt, expected] of [
    ["Pacific/Kiritimati", "00:30", "01:00", "20260920T103000Z"],
    ["America/Los_Angeles", "18:00", "19:00", "20260922T010000Z"],
  ]) {
    await db.transaction(async tx => { await lockAcademics(tx, owner.org_id); await tx.query("UPDATE organizations SET timezone=$2 WHERE id=$1", [owner.org_id, zone]); await advanceAcademics(tx, owner.org_id); });
    try {
      const f = await fixture({ startsAt, endsAt });
      const file = unfold((await exportTimetableCalendar(db, f.teacher, f.auth.hash, f.query)).content);
      assert.ok(file.includes("DTSTART:" + expected)); assert.ok(file.includes(":20260921\r\nDTSTAMP:"));
    } finally { await db.transaction(async tx => { await lockAcademics(tx, owner.org_id); await tx.query("UPDATE organizations SET timezone='America/New_York' WHERE id=$1", [owner.org_id]); await advanceAcademics(tx, owner.org_id); }); }
  }
});

test("exactly2000 occurrences export;2001 and output expanded beyond5MiB fail completely", async () => {
  const largeYear = await ok("/school/years", { unitId: units[1], name: "Synthetic capacity year", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  await ok("/school/attendance/config", { unitId: units[1], weekdays: [1, 2, 3, 4, 5, 6, 7], periods: ["Daily"], confirmed: true, version: 0, reason: "Synthetic capacity calendar" }, ownerAuth, "put");
  let last: any;
  for (let i = 0; i < 7; i++) {
    const section = await ok("/school/sections", { unitId: units[1], yearId: largeYear.id, name: "Synthetic capacity class " + i, teacherIds: [], capacity: 30, homeroom: false });
    const meeting = { sectionId: section.id, roomId: null, startsOn: "2026-01-01", endsOn: i === 6 ? "2026-07-19" : "2026-10-27", weekdays: [1, 2, 3, 4, 5, 6, 7], startsAt: "09:00", endsAt: "10:00", reason: "Synthetic bounded export test" };
    const preview = await ok("/school/timetable/preview", meeting);
    const saved = await ok("/school/timetable/save", { meeting, revision: preview.revision, reviewed: true, commandId: randomUUID() });
    last = { meeting, saved };
  }
  let query = await currentQuery({ unitId: units[1], yearId: largeYear.id, from: "2026-01-01", to: "2026-10-27" });
  const file = await exportTimetableCalendar(db, owner, ownerAuth.hash, query);
  assert.equal(file.count, 2000); assert.equal(unfold(file.content).split("BEGIN:VEVENT").length - 1, 2000);
  const meeting = { ...last.meeting, id: last.saved.id, version: last.saved.version, endsOn: "2026-07-20" };
  const preview = await ok("/school/timetable/preview", meeting);
  await ok("/school/timetable/save", { meeting, revision: preview.revision, reviewed: true, commandId: randomUUID() });
  query = await currentQuery(query);
  const response = await send("/school/timetable/export", query);
  assert.equal(response.status, 400); assert.ok(!response.headers["content-disposition"] && !response.text.includes("BEGIN:VCALENDAR"));
  const input = source(), events = Array.from({ length: 2000 }, () => ({ ...input.events[0], meetingId: randomUUID(), title: ",".repeat(1900) }));
  assert.ok(Buffer.byteLength(JSON.stringify({ ...input, events })) < 5 * 1024 * 1024);
  assert.throws(() => renderTimetableCalendar({ ...input, events }), /size limit/);
});
