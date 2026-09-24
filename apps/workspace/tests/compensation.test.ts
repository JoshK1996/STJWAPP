import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { toCsv } from "../server/reports";
import { parse } from "csv-parse/sync";
import { compensationCsvColumns } from "../shared/compensation";
import { parseCompensationCsv } from "../server/compensation-csv";
import { digest, opaqueToken, type Actor } from "../server/security";
import {
  compensationPreviewInput,
  compensationRate,
  type CompensationRate,
} from "../shared/compensation";
import {
  previewCompensation as previewWithSession,
  saveCompensation as saveWithSession,
  validateCompensationRates,
} from "../server/compensation";
let db: Database,
  owner: Actor,
  unitId: string,
  app: ReturnType<typeof createApp>;
const origin = "http://localhost:3000";
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (
    await db.query(
      "SELECT id,org_id,name,email,role FROM users WHERE role='owner'",
    )
  ).rows[0];
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: user.role,
    mode: "password",
    unit_ids: [],
  };
  unitId = (await db.query("SELECT id FROM units ORDER BY id")).rows[0].id;
  app = createApp(db, {
    origin,
    production: false,
    demo: true,
    staffDomain: "stjw.org",
  });
});
after(async () => {
  await db?.close();
});
const rate = (changes: Partial<CompensationRate> = {}) => ({
  id: randomUUID(),
  startsOn: "2026-01-01",
  endsOn: null,
  amount: "18.1250",
  currency: "USD",
  basis: "hour" as const,
  voided: false,
  note: "Synthetic rate",
  ...changes,
});
async function person(role = "employee") {
  const id = randomUUID(),
    jobId = randomUUID();
  await db.query(
    "INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic employee',$3,$4)",
    [id, owner.org_id, id + "@stjw.org", role],
  );
  await db.query(
    "INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",
    [owner.org_id, id, unitId],
  );
  await db.query(
    "INSERT INTO jobs(id,org_id,unit_id,title) VALUES($1,$2,$3,'Synthetic pay record job')",
    [jobId, owner.org_id, unitId],
  );
  await db.query(
    "INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)",
    [owner.org_id, id, jobId],
  );
  return {
    ...owner,
    id,
    role,
    email: id + "@stjw.org",
    unit_ids: [unitId],
    jobId,
  };
}
async function input() {
  const p = await person();
  return {
    userId: p.id,
    jobId: p.jobId,
    expectedVersion: 0,
    rates: [rate()],
    reason: "Synthetic initial pay record",
  };
}
async function prepared(raw: Awaited<ReturnType<typeof input>>, actor = owner) {
  const preview = await previewCompensation(db, actor, raw);
  return {
    ...raw,
    previewHash: preview.previewHash,
    commandId: randomUUID(),
    reviewed: true as const,
  };
}
async function session(actor = owner, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf, hash: digest(token) };
}
// Preserve these existing business fixtures while supplying their actual
// fixture session. The separate session suite uses normal setup/login routes.
const proofs = new Map<string, string>();
async function proofFor(actor: Actor) {
  if (!proofs.has(actor.id)) proofs.set(actor.id, (await session(actor)).hash);
  return proofs.get(actor.id)!;
}
async function previewCompensation(db: Database, actor: Actor, raw: unknown) {
  return previewWithSession(db, actor, raw, await proofFor(actor));
}
async function saveCompensation(db: Database, actor: Actor, raw: unknown) {
  return saveWithSession(db, actor, raw, await proofFor(actor));
}

test("pay periods use exact nonnegative amounts, inclusive dates, and explicit void history", () => {
  const a = rate({ endsOn: "2026-02-28" }),
    b = rate({ startsOn: "2026-03-01", amount: "999999999999.9999" });
  const rows = validateCompensationRates([b, a]);
  assert.equal(rows[0].amount, "18.125");
  assert.equal(rows[1].amount, "999999999999.9999");
  assert.throws(
    () => validateCompensationRates([a, { ...b, startsOn: "2026-02-28" }]),
    /overlap/,
  );
  assert.throws(() => validateCompensationRates([rate(), b]), /overlap/);
  assert.throws(() => validateCompensationRates([a, a]), /distinct identity/);
  assert.throws(() => validateCompensationRates([b], [a]), /Retain existing/);
  assert.equal(
    validateCompensationRates([{ ...a, voided: true }, b]).length,
    2,
  );
  assert.equal(
    compensationRate.safeParse(rate({ amount: "-1" })).success,
    false,
  );
  assert.equal(
    compensationRate.safeParse(rate({ amount: "1.00001" })).success,
    false,
  );
  assert.equal(
    compensationRate.safeParse(rate({ startsOn: "2026-02-30" })).success,
    false,
  );
  assert.equal(
    compensationRate.safeParse(rate({ endsOn: "2025-12-31" })).success,
    false,
  );
});
test("reviewed pay changes are immutable, idempotent and preserve exact before/after rates", async () => {
  const raw = await input(),
    command = await prepared(raw),
    one = await saveCompensation(db, owner, command);
  assert.deepEqual(await saveCompensation(db, owner, command), one);
  await assert.rejects(
    saveCompensation(db, owner, {
      ...command,
      reason: "Changed retry contents",
    }),
    /already used/,
  );
  await assert.rejects(
    previewCompensation(db, owner, {
      ...raw,
      expectedVersion: 1,
      rates: [{ ...raw.rates[0], amount: "18.125" }],
    }),
    /Change at least one/,
  );
  const next = {
    ...raw,
    expectedVersion: 1,
    rates: [
      { ...raw.rates[0], endsOn: "2026-09-30" },
      rate({ startsOn: "2026-10-01", amount: "19.50" }),
    ],
    reason: "Synthetic future adjustment",
  };
  const two = await saveCompensation(db, owner, await prepared(next));
  assert.equal(two.version, 2);
  const history = (
    await db.query(
      "SELECT * FROM compensation_history WHERE schedule_id=$1 ORDER BY version",
      [one.id],
    )
  ).rows;
  assert.equal(history.length, 2);
  assert.equal(history[0].snapshot.rates[0].endsOn, null);
  assert.equal(history[1].snapshot.rates[1].amount, "19.5");
  await assert.rejects(
    db.query(
      "UPDATE compensation_history SET reason='tampered' WHERE schedule_id=$1",
      [one.id],
    ),
    /append-only/,
  );
  await assert.rejects(
    db.query("DELETE FROM compensation_commands WHERE command_id=$1", [
      command.commandId,
    ]),
    /append-only/,
  );
  const audit = (
    await db.query(
      "SELECT detail FROM audit_events WHERE action='compensation.saved' AND target_id=$1",
      [one.id],
    )
  ).rows;
  assert.ok(audit.every((x) => !JSON.stringify(x.detail).includes("18.125")));
});
test("pay review rejects stale versions, changed preview contents, and competing initial schedules", async () => {
  const raw = await input(),
    a = await prepared(raw),
    b = await prepared({ ...raw, rates: [{ ...raw.rates[0], amount: "20" }] });
  await assert.rejects(
    saveCompensation(db, owner, {
      ...a,
      rates: [{ ...raw.rates[0], amount: "21" }],
    }),
    /reviewed pay record changed/,
  );
  const result = await Promise.allSettled([
    saveCompensation(db, owner, a),
    saveCompensation(db, owner, b),
  ]);
  assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(result.filter((x) => x.status === "rejected").length, 1);
  await assert.rejects(
    previewCompensation(db, owner, raw),
    /Pay records changed/,
  );
});
test("new rates require current employee/job assignment, but historical corrections remain available", async () => {
  const raw = await input(),
    command = await prepared(raw);
  await db.query("DELETE FROM user_jobs WHERE user_id=$1 AND job_id=$2", [
    raw.userId,
    raw.jobId,
  ]);
  await assert.rejects(saveCompensation(db, owner, command), /assigned job/);
  await db.query(
    "INSERT INTO user_jobs(org_id,user_id,job_id) VALUES($1,$2,$3)",
    [owner.org_id, raw.userId, raw.jobId],
  );
  const first = await saveCompensation(db, owner, command);
  await db.query("DELETE FROM user_jobs WHERE user_id=$1 AND job_id=$2", [
    raw.userId,
    raw.jobId,
  ]);
  await db.query("UPDATE users SET active=false WHERE id=$1", [raw.userId]);
  const revised = {
    ...raw,
    expectedVersion: 1,
    rates: [{ ...raw.rates[0], voided: true }],
    reason: "Void incorrect synthetic historical entry",
  };
  assert.equal(
    (await saveCompensation(db, owner, await prepared(revised))).version,
    2,
  );
  await assert.rejects(
    previewCompensation(db, owner, {
      ...revised,
      expectedVersion: 2,
      rates: [...revised.rates, rate({ startsOn: "2027-01-01" })],
    }),
    /active employee/,
  );
  assert.equal(
    (
      await db.query("SELECT version FROM compensation_schedules WHERE id=$1", [
        first.id,
      ])
    ).rows[0].version,
    2,
  );
});
test("only current owner admin finance password users can inspect or modify pay records", async () => {
  const raw = await input(),
    finance = await person("finance"),
    admin = await person("admin"),
    manager = await person("manager");
  await previewCompensation(db, finance, raw);
  await previewCompensation(db, admin, raw);
  const preparedByFinance = await prepared(raw, finance);
  await assert.rejects(previewCompensation(db, manager, raw), /finance access/);
  await assert.rejects(
    previewCompensation(db, { ...owner, mode: "pin" }, raw),
    /password/,
  );
  await assert.rejects(
    previewCompensation(db, { ...owner, mode: "api" }, raw),
    /password/,
  );
  await assert.rejects(
    previewCompensation(db, { ...owner, org_id: randomUUID() }, raw),
    /inactive or unavailable/,
  );
  await assert.rejects(
    previewCompensation(db, owner, { ...raw, userId: randomUUID() }),
    /Staff member not found/,
  );
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [finance.id]);
  await assert.rejects(
    saveCompensation(db, finance, preparedByFinance),
    /finance access/,
  );
  const s = await session(manager);
  for (const path of [
    "/staff",
    "/jobs?userId=" + raw.userId,
    "/record?" + new URLSearchParams({ userId: raw.userId, jobId: raw.jobId }),
    "/history?" + new URLSearchParams({ userId: raw.userId, jobId: raw.jobId }),
    "/export?" + new URLSearchParams({ userId: raw.userId, jobId: raw.jobId }),
  ])
    await request(app)
      .get("/api/compensation" + path)
      .set("Cookie", s.cookie)
      .expect(403);
});
test("pay records, change receipts and history roll back together when auditing fails", async () => {
  const raw = await input(),
    command = await prepared(raw),
    wrapped = {
      ...db,
      transaction: (fn: any) =>
        db.transaction((tx) =>
          fn({
            query: (sql: string, params: unknown[]) => {
              if (sql.includes("INSERT INTO audit_events"))
                throw Error("Synthetic pay audit failure");
              return tx.query(sql, params);
            },
          }),
        ),
    } as Database;
  await assert.rejects(
    saveCompensation(wrapped, owner, command),
    /Synthetic pay audit failure/,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM compensation_schedules WHERE user_id=$1", [
        raw.userId,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT command_id FROM compensation_commands WHERE command_id=$1",
        [command.commandId],
      )
    ).rows.length,
    0,
  );
});
test("pay exports retain exact amounts, scope and recorded versions without wage calculations", async () => {
  const raw = await input();
  raw.rates[0].note = "=SYNTHETIC_FORMULA";
  await saveCompensation(db, owner, await prepared(raw));
  const s = await session(),
    query = new URLSearchParams({ userId: raw.userId, jobId: raw.jobId });
  const json = await request(app)
    .get("/api/compensation/export?" + query + "&format=json")
    .set("Cookie", s.cookie)
    .expect(200);
  const data = JSON.parse(json.text);
  assert.equal(data.schedule.version, 1);
  assert.equal(data.schedule.rates[0].amount, "18.125");
  assert.match(data.notice, /No earned wages/);
  const csv = await request(app)
    .get("/api/compensation/export?" + query)
    .set("Cookie", s.cookie)
    .expect(200);
  assert.match(csv.text, /18.125/);
  assert.match(csv.text, /'=SYNTHETIC_FORMULA/);
  assert.match(csv.text, /version/);
});
test("pay CSV templates retain identity, exact amounts, source bytes and reviewed corrections", async () => {
  const raw = await input();
  raw.rates[0].note = "=SYNTHETIC_FORMULA";
  await saveCompensation(db, owner, await prepared(raw));
  const s = await session(),
    query = new URLSearchParams({ userId: raw.userId, jobId: raw.jobId });
  const template = await request(app)
    .get("/api/compensation/template?" + query)
    .set("Cookie", s.cookie)
    .expect(200);
  const rows = parse(template.text, { bom: true, columns: true }) as Record<string,string>[];
  assert.equal(rows[0].rateId, raw.rates[0].id);
  assert.equal(rows[0].recordVersion, "1");
  assert.equal(rows[0].note, "'=SYNTHETIC_FORMULA");
  rows[0].endsOn = "2026-09-30";
  rows.push({
    ...rows[0],
    rateId: "",
    startsOn: "2026-10-01",
    endsOn: "",
    amount: "21.0001",
    note: "Synthetic Unicode résumé",
  });
  const csv = toCsv(rows, [...compensationCsvColumns]);
  const preview = await request(app)
    .post("/api/compensation/import-preview")
    .set("Cookie", s.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", s.csrf)
    .send({
      userId: raw.userId,
      jobId: raw.jobId,
      expectedVersion: 1,
      reason: "Synthetic reviewed pay CSV change",
      csv,
    })
    .expect(200);
  assert.equal(preview.body.sourceHash, digest(csv));
  assert.equal(preview.body.input.rates[0].note, "=SYNTHETIC_FORMULA");
  assert.ok(preview.body.input.rates[1].id);
  const command = {
    ...preview.body.input,
    previewHash: preview.body.data.previewHash,
    commandId: randomUUID(),
    reviewed: true,
  };
  await assert.rejects(
    saveCompensation(db, owner, {
      ...command,
      rates: command.rates.map((r: CompensationRate, i: number) =>
        i ? { ...r, amount: "99" } : r,
      ),
    }),
    /does not match/,
  );
  const receipt = await saveCompensation(db, owner, command);
  assert.equal(receipt.version, 2);
  assert.deepEqual(await saveCompensation(db, owner, command), receipt);
  const original = await request(app)
    .get("/api/compensation/history-source?" + query + "&version=2")
    .set("Cookie", s.cookie)
    .expect(200);
  assert.equal(original.text, csv);
  const history = await request(app)
    .get("/api/compensation/history?" + query)
    .set("Cookie", s.cookie)
    .expect(200);
  assert.equal(history.body.rows[0].source_hash, digest(csv));
  assert.equal(history.body.rows[0].has_import_source, true);
  assert.equal(history.body.rows[0].snapshot.importSource, undefined);
  await request(app)
    .get("/api/compensation/history-source?" + query + "&version=1")
    .set("Cookie", s.cookie)
    .expect(404);
});
test("pay CSV parsing rejects stale or ambiguous identities and altered supplied rates", () => {
  const context = {
      userId: randomUUID(),
      jobId: randomUUID(),
      expectedVersion: 3,
      previous: [] as CompensationRate[],
    },
    record = {
      userId: context.userId,
      jobId: context.jobId,
      recordVersion: 3,
      rateId: "",
      startsOn: "2026-01-01",
      endsOn: "",
      amount: "18.1234",
      currency: "USD",
      basis: "hour",
      voided: false,
      note: "",
    },
    csv = toCsv([record], [...compensationCsvColumns]);
  const rows = parseCompensationCsv(csv, context);
  assert.equal(rows[0].amount, "18.1234");
  assert.deepEqual(parseCompensationCsv(csv, context, rows), rows);
  assert.throws(
    () => parseCompensationCsv(csv, { ...context, expectedVersion: 4 }),
    /different employee, job or record version/,
  );
  assert.throws(
    () => parseCompensationCsv(csv, { ...context, userId: randomUUID() }),
    /different employee/,
  );
  assert.throws(
    () =>
      parseCompensationCsv(
        toCsv([{ ...record, voided: "yes" }], [...compensationCsvColumns]),
        context,
      ),
    /true or false/,
  );
  assert.throws(
    () => parseCompensationCsv(csv, context, [{ ...rows[0], amount: "19" }]),
    /does not match/,
  );
  assert.throws(
    () => parseCompensationCsv(csv, { ...context, previous: rows }, rows),
    /cannot reuse/,
  );
  assert.throws(
    () => parseCompensationCsv("x".repeat(64001), context),
    /64,000/,
  );
  assert.throws(
    () => parseCompensationCsv("id,amount\na,2", context),
    /column names/,
  );
});
test("pay history pages include all retained versions without duplicating source text", async () => {
  const raw = await input();
  let latest = await saveCompensation(db, owner, await prepared(raw));
  for (let v = 1; v < 12; v++) {
    const revised = {
      ...raw,
      expectedVersion: v,
      rates: [{ ...raw.rates[0], amount: String(18 + v) }],
      reason: "Synthetic history page " + v,
    };
    latest = await saveCompensation(db, owner, await prepared(revised));
  }
  const s = await session(),
    query = new URLSearchParams({ userId: raw.userId, jobId: raw.jobId }),
    first = await request(app)
      .get("/api/compensation/history?" + query)
      .set("Cookie", s.cookie)
      .expect(200);
  assert.equal(latest.version, 12);
  assert.equal(first.body.rows.length, 10);
  assert.equal(first.body.nextBeforeVersion, 3);
  const second = await request(app)
    .get("/api/compensation/history?" + query + "&beforeVersion=3")
    .set("Cookie", s.cookie)
    .expect(200);
  assert.deepEqual(
    second.body.rows.map((r: any) => r.version),
    [2, 1],
  );
  assert.equal(second.body.nextBeforeVersion, null);
});
test("pay import and source routes enforce current pay access", async () => {
  const raw = await input(),
    manager = await person("manager"),
    s = await session(manager),
    query = new URLSearchParams({ userId: raw.userId, jobId: raw.jobId });
  await request(app)
    .get("/api/compensation/template?" + query)
    .set("Cookie", s.cookie)
    .expect(403);
  await request(app)
    .get("/api/compensation/history-source?" + query + "&version=1")
    .set("Cookie", s.cookie)
    .expect(403);
  await request(app)
    .post("/api/compensation/import-preview")
    .set("Cookie", s.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", s.csrf)
    .send({
      userId: raw.userId,
      jobId: raw.jobId,
      expectedVersion: 0,
      reason: "Unauthorized synthetic import",
      csv: "x,y\na,b",
    })
    .expect(403);
});
