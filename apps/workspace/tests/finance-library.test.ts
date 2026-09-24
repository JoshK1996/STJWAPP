import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { digest, issueSetup, type Actor } from "../server/security";
import { createApp } from "../server/app";
import {
  previewFinancialReport,
  publishFinancialReport,
} from "../server/finance";
import {
  initialDefinition,
  reportDefinition,
  type ReportDefinition,
} from "../shared/report-library";
import {
  saveReport,
  runReport,
  shapeReportRows,
} from "../server/report-library";

let db: Database,
  owner: Actor,
  unitId: string,
  app: ReturnType<typeof createApp>;
const origin = "http://localhost:3000",
  header = "lineCode,lineLabel,group,rowKind,amount,note\n";
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
    .rows[0];
  unitId = (await db.query("SELECT id FROM units ORDER BY id")).rows[0].id;
  owner = {
    id: user.id,
    org_id: user.org_id,
    name: user.name,
    email: user.email,
    role: user.role,
    mode: "password",
    unit_ids: [],
  };
  app = createApp(db, {
    origin,
    production: false,
    staffDomain: "stjw.org",
    demo: true,
  });
});
after(async () => {
  await db?.close();
});
function source(changes: Record<string, unknown> = {}) {
  return {
    unitId,
    reportId: randomUUID(),
    expectedVersion: 0,
    metadata: {
      title: "Synthetic financial source",
      sourceName: "Synthetic export",
      currency: "USD",
      kind: "actual",
      basis: "period_activity",
      from: "2026-01-01",
      to: "2026-01-31",
      note: "Private source note",
    },
    csv:
      header +
      "A,First,Operating,detail,0.1,Private line\nB,Second,Operating,detail,0.2,\nT,Total,Operating,total,0.3,",
    reason: "Synthetic financial source review",
    ...changes,
  };
}
async function publish(raw = source()) {
  const preview = await previewFinancialReport(db, owner, (await session(owner)).hash, raw);
  return publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, {
    sourceHash: preview.sourceHash,
    fingerprint: preview.fingerprint,
    reviewed: true,
  });
}
function definition(
  id: string,
  changes: Record<string, unknown> = {},
): ReportDefinition {
  return reportDefinition.parse({
    ...initialDefinition("finance"),
    unitId,
    financialReportId: id,
    ...changes,
  });
}
async function person(role = "finance") {
  const id = randomUUID(),
    email = id + "@stjw.org";
  await db.query(
    "INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,'Synthetic report reviewer',$3,$4)",
    [id, owner.org_id, email, role],
  );
  return { ...owner, id, email, role } as Actor;
}
type TestAuth = { cookie: string; csrf: string; hash: string };
const authCache = new Map<string, TestAuth>(), passwords = new Map<string, string>();
async function session(actor = owner, mode = "password"): Promise<TestAuth> {
  const key = actor.id + ":" + mode, cached = authCache.get(key); if (cached) return cached;
  let password = passwords.get(actor.id);
  if (!password) {
    password = "Synthetic-" + randomUUID();
    const token = await db.transaction(tx => issueSetup(tx, actor));
    const result = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password });
    assert.equal(result.status, 200); passwords.set(actor.id, password);
  }
  let credential = password;
  if (mode === "pin") {
    const current = await session(actor), pin = "739128";
    const changed = await request(app).post("/api/auth/pin").set("Origin", origin).set("Cookie", current.cookie)
      .set("X-CSRF-Token", current.csrf).send({ password, pin });
    assert.equal(changed.status, 200); credential = pin;
  }
  const result = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: actor.email, credential, mode });
  assert.equal(result.status, 200);
  const cookie = (result.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  const auth = { cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
  authCache.set(key, auth); return auth;
}
const savedInput = (def: ReportDefinition) => ({
  id: randomUUID(),
  version: 0,
  name: "Synthetic financial layout",
  description: "",
  definition: def,
  archived: false,
  reason: "Save reviewed layout",
});

test("financial summaries exclude imported totals and keep exact signed amounts and sorting beyond safe integers", () => {
  const def = definition(randomUUID(), {
    layout: "summary",
    sort: { key: "amount", direction: "asc" },
  });
  const rows = Array.from({ length: 497 }, (_, i) => ({
    group: "Large",
    row_kind: "detail",
    currency: "USD",
    amount: "999999999999.9999",
    line_code: String(i),
    line_label: "Large",
  }));
  rows.push(
    ...[
      {
        group: "Negative",
        row_kind: "detail",
        currency: "USD",
        amount: "-0.0002",
        line_code: "n",
        line_label: "Negative",
      },
      {
        group: "Tiny",
        row_kind: "detail",
        currency: "USD",
        amount: "0.0001",
        line_code: "p",
        line_label: "Tiny",
      },
    ],
  );
  assert.deepEqual(
    shapeReportRows(def, rows).rows.map((r) => r.amount),
    ["-0.0002", "0.0001", "496999999999999.9503"],
  );
  const details = definition(randomUUID(), {
    sort: { key: "amount", direction: "desc" },
  });
  assert.deepEqual(
    shapeReportRows(
      details,
      ["999999999999.9998", "999999999999.9999", "-2", "-10"].map((amount) => ({
        amount,
      })),
    ).rows.map((r) => r.amount),
    ["999999999999.9999", "999999999999.9998", "-2", "-10"],
  );
  assert.throws(
    () =>
      definition(randomUUID(), {
        layout: "summary",
        rowKinds: "all",
        sort: { key: "group_name", direction: "asc" },
      }),
    /detail lines only/,
  );
  assert.throws(
    () => shapeReportRows(def, [{ ...rows[0], row_kind: "total" }]),
    /detail lines/,
  );
  assert.throws(
    () =>
      shapeReportRows(def, [{ ...rows[0] }, { ...rows[0], currency: "EUR" }]),
    /one currency/,
  );
});
test("saved financial layouts retain an immutable version, archived sources, and export provenance", async () => {
  const raw = source();
  await publish(raw);
  const def = definition(raw.reportId, {
    layout: "summary",
    sort: { key: "group_name", direction: "asc" },
  });
  const saved = await saveReport(db, owner, (await session(owner)).hash, savedInput(def));
  await publish({
    ...raw,
    expectedVersion: 1,
    metadata: { ...raw.metadata, title: "Newer source title" },
    csv: header + "A,Changed,Operating,detail,9,",
  });
  await db.query("UPDATE financial_reports SET archived=true WHERE id=$1", [
    raw.reportId,
  ]);
  const data = await runReport(db, owner, saved.definition);
  assert.equal(data.rows[0].amount, "0.3");
  assert.equal(data.sourceRowCount, 2);
  assert.equal(data.provenance.financialVersion, 1);
  assert.equal(data.provenance.sourceArchived, true);
  assert.equal(data.provenance.title, raw.metadata.title);
  assert.equal(data.provenance.sourceHash, digest(raw.csv));
  const all = await runReport(
    db,
    owner,
    definition(raw.reportId, { rowKinds: "all" }),
  );
  assert.equal(all.rows.length, 3);
  const s = await session();
  const json = await request(app)
    .get(`/api/report-library/${saved.id}/export?version=1&format=json`)
    .set("Cookie", s.cookie)
    .expect(200);
  const result = JSON.parse(json.text);
  assert.equal(result.rows[0].amount, "0.3");
  assert.equal(result.provenance.financialVersion, 1);
  const csv = await request(app)
    .get(`/api/report-library/${saved.id}/export?version=1&format=csv`)
    .set("Cookie", s.cookie)
    .expect(200);
  assert.match(csv.text, /report_source_versions/);
  assert.ok(csv.text.includes(digest(raw.csv)));
  await request(app)
    .get(`/api/report-library/${saved.id}/run?version=2`)
    .set("Cookie", s.cookie)
    .expect(409);
});
test("financial source access uses current roles and organization, independently of saved-layout ownership", async () => {
  const raw = source();
  await publish(raw);
  const def = definition(raw.reportId),
    finance = await person();
  const saved = await saveReport(db, finance, (await session(finance)).hash, savedInput(def)),
    s = await session(finance);
  const manager = await person("manager"),
    managerSession = await session(manager),
    ownerSession = await session();
  await assert.rejects(runReport(db, manager, def), /Financial report access/);
  await assert.rejects(
    runReport(db, { ...owner, mode: "pin" }, def),
    /password/,
  );
  await assert.rejects(
    runReport(db, { ...owner, mode: "api" } as Actor, def),
    /password/,
  );
  await assert.rejects(
    runReport(db, { ...owner, org_id: randomUUID() }, def),
    (error: any) => error.status === 403,
  );
  await assert.rejects(
    runReport(db, owner, { ...def, unitId: randomUUID() }),
    /not found in this community/,
  );
  await assert.rejects(
    runReport(db, owner, { ...def, financialVersion: 99 }),
    /version not found/,
  );
  await request(app)
    .get(`/api/report-library/${saved.id}/run?version=1`)
    .set("Cookie", ownerSession.cookie)
    .expect(404);
  await request(app)
    .get(`/api/report-library/finance-options?unitId=${unitId}`)
    .set("Cookie", managerSession.cookie)
    .expect(403);
  const catalog = await request(app)
    .get(`/api/report-library/finance-options?unitId=${unitId}`)
    .set("Cookie", s.cookie)
    .expect(200);
  assert.ok(catalog.body.rows.some((r: any) => r.id === raw.reportId));
  assert.ok(!JSON.stringify(catalog.body).includes("Private"));
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [finance.id]);
  await assert.rejects(runReport(db, finance, def), /Financial report access/);
  await assert.rejects(
    saveReport(db, finance, (await session(finance)).hash, { ...savedInput(def), id: saved.id, version: 1 }),
    /Financial report access/,
  );
  await request(app)
    .get(`/api/report-library/${saved.id}/export?version=1`)
    .set("Cookie", s.cookie)
    .expect(403);
  await request(app)
    .get(`/api/report-library/finance-options?unitId=${unitId}`)
    .set("Cookie", s.cookie)
    .expect(403);
});
test("financial report saves roll back when their audit cannot be written", async () => {
  const raw = source();
  await publish(raw);
  const input = savedInput(definition(raw.reportId));
  const failing = {
    ...db,
    transaction: (fn: any) =>
      db.transaction((tx) =>
        fn({
          query: (sql: string, params: unknown[]) => {
            if (sql.includes("INSERT INTO audit_events"))
              throw new Error("Synthetic audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  } as Database;
  await assert.rejects(
    saveReport(failing, owner, (await session(owner)).hash, input),
    /Synthetic audit failure/,
  );
  assert.equal(
    (await db.query("SELECT id FROM saved_reports WHERE id=$1", [input.id]))
      .rows.length,
    0,
  );
});
