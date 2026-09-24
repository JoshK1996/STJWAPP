import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { createEvents, cancelEvent } from "../server/community";
import { eventCreateInput } from "../shared/community";
import { calendarExportQuery } from "../shared/calendar-export";
import { exportCalendar, renderCalendarFile } from "../server/calendar-export";
import { digest, opaqueToken, type Actor } from "../server/security";

let db: Database, owner: Actor, units: string[];
const range = { from: "2026-09-01T04:00:00.000Z", to: "2026-10-01T04:00:00.000Z", audience: "all" };
const origin = "http://localhost:3000";
before(async () => {
  db = await connectDatabase(); await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'")).rows[0];
  units = (await db.query("SELECT id FROM units ORDER BY id")).rows.map((row) => row.id);
  owner = { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: user.role, mode: "password", unit_ids: units };
});
after(async () => { await db?.close(); });
function app(database = db) {
  return createApp(database, { origin, production: false, demo: true, staffDomain: "stjw.org" });
}
async function person(role = "employee", memberships = [units[0]]) {
  const id = randomUUID(), email = id + "@stjw.org";
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic calendar user',$3,$4)", [id, owner.org_id, email, role]);
  for (const unit of memberships) await db.query("INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)", [owner.org_id,id,unit]);
  return { ...owner, id, email, role, unit_ids: memberships } as Actor;
}
async function session(actor: Actor, mode = "password", expired = false) {
  const token = opaqueToken(), hash = digest(token);
  await db.query("INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [hash, actor.org_id, actor.id, mode, opaqueToken(), new Date(Date.now() + (expired ? -60000 : 3600000))]);
  return { hash, cookie: "stjw_session=" + token };
}
async function events(actor: Actor, changes: Record<string, unknown> = {}, repeat = { frequency: "none", interval: 1, count: 1 }) {
  return (await createEvents(db, actor, eventCreateInput.parse({ event: {
    title: "Synthetic exported event", description: "Private event description", location: "Private room",
    audience: "personal", unitId: null, timezone: "America/New_York", startsAt: "2026-09-14T13:00:00.000Z", endsAt: "2026-09-14T14:00:00.000Z", ...changes,
  }, repeat }))).rows;
}
function beforeExport(operation: () => Promise<void>) {
  return { ...db, transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => { await operation(); return db.transaction(fn); } } as Database;
}
const unfold = (value: string) => value.replace(/\r\n[ \t]/g, "");

test("calendar files use stable occurrence UIDs, UTC revision/start/end, escaped text and UTF-8 octet folding", () => {
  const row = { id: randomUUID(), version: 1, starts_at: "2026-11-01T01:30:00-04:00", ends_at: "2026-11-01T01:30:00-05:00", updated_at: "2026-09-20T12:34:56.789Z",
    title: "Café 🎨 漢字 ".repeat(16), location: "Room 1; east, west\\north",
    description: "First\r\nBEGIN:VEVENT\rATTENDEE:mailto:outside@example.test\nEND:VEVENT\u000b" };
  const file = renderCalendarFile([row]), full = unfold(file);
  assert.ok(file.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(file.endsWith("END:VCALENDAR\r\n"));
  for (const line of file.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line)), line);
  }
  assert.ok(!/(^|[^\r])\n/.test(file));
  assert.equal(full.split("\r\n").filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.ok(full.includes("DTSTART:20261101T053000Z\r\nDTEND:20261101T063000Z"));
  assert.ok(full.includes("DTSTAMP:20260920T123456Z"));
  assert.ok(full.includes("LOCATION:Room 1\\; east\\, west\\\\north"));
  assert.ok(full.includes("DESCRIPTION:First\\nBEGIN:VEVENT\\nATTENDEE:mailto:outside@example.test\\nEND:VEVENT�"));
  assert.ok(!full.includes("\r\nATTENDEE:") && !full.includes("\r\nMETHOD:") && !full.includes("RRULE:"));
  const updated = unfold(renderCalendarFile([{ ...row, title: "Changed", version: 2 }]));
  assert.equal(full.match(/UID:[^\r]+/)?.[0], updated.match(/UID:[^\r]+/)?.[0]);
  assert.ok(updated.includes("SEQUENCE:1\r\n"));
  assert.throws(() => renderCalendarFile([{ ...row, id: "invalid\r\nATTENDEE:evil" }]));
  assert.throws(() => renderCalendarFile([{ ...row, starts_at: "2026-09-01T12:00:00.001Z", ends_at: "2026-09-01T12:00:00.002Z" }]), /calendar second/);
});

test("expanded recurring events retain local time across both daylight-saving transitions in exported UTC occurrences", async () => {
  const actor = await person(), auth = await session(actor);
  await events(actor, { startsAt: "2026-03-07T14:00:00.000Z", endsAt: "2026-03-07T15:00:00.000Z" }, { frequency: "daily", interval: 1, count: 2 });
  await events(actor, { startsAt: "2026-10-31T13:00:00.000Z", endsAt: "2026-10-31T14:00:00.000Z" }, { frequency: "daily", interval: 1, count: 2 });
  const result = await exportCalendar(db, actor, auth.hash, { from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z", audience: "personal" });
  const full = unfold(result.content);
  assert.equal(result.eventCount, 4);
  for (const expected of ["20260307T140000Z", "20260308T130000Z", "20261031T130000Z", "20261101T140000Z"]) assert.ok(full.includes("DTSTART:" + expected));
  assert.equal(new Set(full.match(/UID:[^\r]+/g)).size, 4);
});

test("download enforces private, explicit-unit and organization scope, audience filters, cancellation and exclusive range boundaries", async () => {
  const actor = await person(), other = await person(), auth = await session(actor);
  const mine = (await events(actor, { title: "Own private event" }))[0];
  const others = (await events(other, { title: "Other private event" }))[0];
  const visibleUnit = (await events(owner, { audience: "unit", unitId: units[0], title: "Visible unit" }))[0];
  const hiddenUnit = (await events(owner, { audience: "unit", unitId: units[1], title: "Hidden unit" }))[0];
  const org = (await events(owner, { audience: "organization", title: "Community event" }))[0];
  const cancelled = (await events(actor, { title: "Cancelled event" }))[0];
  await cancelEvent(db, actor, cancelled.id, cancelled.version);
  const before = (await events(actor, { startsAt: "2026-08-31T04:00:00Z", endsAt: range.from }))[0];
  const after = (await events(actor, { startsAt: range.to, endsAt: "2026-10-02T04:00:00Z" }))[0];
  const spanning = (await events(actor, { startsAt: "2026-08-31T04:00:00Z", endsAt: "2026-09-02T04:00:00Z" }))[0];
  const foreignOrg = randomUUID(), foreignUser = randomUUID(), foreignEvent = randomUUID();
  await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Synthetic foreign tenant','UTC')", [foreignOrg]);
  await db.query("INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Foreign calendar owner',$3,'owner')", [foreignUser,foreignOrg,foreignUser+'@example.test']);
  await db.query("INSERT INTO calendar_events(id,org_id,creator_id,series_id,audience,title,starts_at,ends_at,timezone) VALUES($1,$2,$3,$4,'organization','Foreign event','2026-09-14T13:00:00Z','2026-09-14T14:00:00Z','UTC')", [foreignEvent,foreignOrg,foreignUser,randomUUID()]);
  const result = await request(app()).get("/api/calendar/export").query(range).set("Cookie", auth.cookie);
  assert.equal(result.status, 200); assert.match(result.headers["content-type"], /text\/calendar.*charset=utf-8/);
  assert.match(result.headers["content-disposition"], /attachment.*\.ics/); assert.match(result.headers["cache-control"], /no-store/);
  const full = unfold(result.text);
  for (const row of [mine, visibleUnit, org, spanning]) assert.ok(full.includes(row.id));
  for (const id of [others.id,hiddenUnit.id,cancelled.id,before.id,after.id,foreignEvent]) assert.ok(!full.includes(id));
  assert.ok(full.includes("DTSTART:20260831T040000Z")); // Overlapping events keep their full duration.
  const ownOnly = await exportCalendar(db, actor, auth.hash, { ...range, audience: "personal" });
  assert.ok(!ownOnly.content.includes(visibleUnit.id) && !ownOnly.content.includes(org.id));
  const ownerAuth = await session(owner), ownerFile = await exportCalendar(db, owner, ownerAuth.hash, range);
  assert.ok(ownerFile.content.includes(hiddenUnit.id)); assert.ok(!ownerFile.content.includes(mine.id) && !ownerFile.content.includes(others.id));
  const audits = (await db.query("SELECT detail FROM audit_events WHERE actor_id=$1 AND action='calendar.exported'", [actor.id])).rows;
  assert.equal(audits.length, 2);
  assert.equal(audits[0].detail.format, "ics"); assert.match(audits[0].detail.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(audits).includes("Private event description") && !JSON.stringify(audits).includes("Own private event"));
});

test("export rejects anonymous, PIN, API, expired and revoked sessions at the request boundary", async () => {
  const actor = await person(), pin = await session(actor, "pin"), expired = await session(actor, "password", true), revoked = await session(actor);
  await db.query("DELETE FROM sessions WHERE token_hash=$1", [revoked.hash]);
  const endpoint = () => request(app()).get("/api/calendar/export").query(range);
  assert.equal((await endpoint()).status, 401);
  assert.equal((await endpoint().set("Cookie", pin.cookie)).status, 403);
  assert.equal((await endpoint().set("Cookie", expired.cookie)).status, 401);
  assert.equal((await endpoint().set("Cookie", revoked.cookie)).status, 401);
  const token = opaqueToken();
  await db.query("INSERT INTO api_tokens(id,org_id,user_id,token_hash,name,scopes,expires_at) VALUES($1,$2,$3,$4,'Synthetic read token',$5,now()+interval '1 hour')", [randomUUID(),actor.org_id,actor.id,digest(token),JSON.stringify(["reports:read","staff:read"])]);
  assert.equal((await endpoint().set("Authorization", "Bearer " + token)).status, 403);
  await assert.rejects(exportCalendar(db, { ...actor, mode: "api" }, undefined, range), /Password/);
});

test("export reloads role/membership and session after request authentication instead of trusting the stale actor", async () => {
  const actor = await person("admin", [units[0], units[1]]), auth = await session(actor);
  const restricted = (await events(owner, { audience: "unit", unitId: units[1] }))[0];
  const current = (await events(actor, { title: "Retained personal event" }))[0];
  const wrapped = beforeExport(async () => {
    await db.query("UPDATE users SET role='employee' WHERE id=$1", [actor.id]);
    await db.query("DELETE FROM user_units WHERE user_id=$1 AND unit_id=$2", [actor.id, units[1]]);
  });
  const response = await request(app(wrapped)).get("/api/calendar/export").query(range).set("Cookie", auth.cookie);
  assert.equal(response.status, 200); assert.ok(response.text.includes(current.id)); assert.ok(!response.text.includes(restricted.id));
  const revoked = beforeExport(async () => { await db.query("DELETE FROM sessions WHERE token_hash=$1", [auth.hash]); });
  assert.equal((await request(app(revoked)).get("/api/calendar/export").query(range).set("Cookie", auth.cookie)).status, 401);
  const newSession = await session(actor);
  const inactive = beforeExport(async () => { await db.query("UPDATE users SET active=false WHERE id=$1", [actor.id]); });
  assert.equal((await request(app(inactive)).get("/api/calendar/export").query(range).set("Cookie", newSession.cookie)).status, 403);
});

test("invalid, empty and oversized exports fail without truncated files or export audits", async () => {
  const actor = await person(), auth = await session(actor);
  for (const query of [{ ...range, to: range.from }, { ...range, to: "2029-01-01T00:00:00Z" }, { ...range, audience: "classes" }, { ...range, userId: owner.id }]) assert.equal(calendarExportQuery.safeParse(query).success, false);
  await assert.rejects(exportCalendar(db, actor, auth.hash, { ...range, audience: "personal" }), /No calendar events/);
  await db.query(`INSERT INTO calendar_events(id,org_id,creator_id,series_id,audience,title,starts_at,ends_at,timezone)
    SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$1,$2,$3,'personal','Synthetic capacity event','2026-09-14T13:00:00Z','2026-09-14T14:00:00Z','UTC' FROM generate_series(1,2001) g`, [actor.org_id,actor.id,randomUUID()]);
  await assert.rejects(exportCalendar(db, actor, auth.hash, { ...range, audience: "personal" }), /shorter range/);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='calendar.exported'", [actor.id])).rows.length, 0);
  await db.query("UPDATE calendar_events SET cancelled_at=now() WHERE id='00000000-0000-4000-8000-000000002001'");
  assert.equal((await exportCalendar(db, actor, auth.hash, { ...range, audience: "personal" })).eventCount, 2000);
});

test("an audit failure prevents delivery and rolls back the export record", async () => {
  const actor = await person(), auth = await session(actor); await events(actor);
  const wrapped: Database = { ...db, transaction: (fn) => db.transaction((tx) => fn({ query: async (sql, params) => {
    if (sql.startsWith("INSERT INTO audit_events")) throw new Error("Synthetic export audit failure");
    return tx.query(sql, params);
  } })) };
  await assert.rejects(exportCalendar(wrapped, actor, auth.hash, { ...range, audience: "personal" }), /Synthetic export audit failure/);
  assert.equal((await db.query("SELECT id FROM audit_events WHERE actor_id=$1 AND action='calendar.exported'", [actor.id])).rows.length, 0);
});
