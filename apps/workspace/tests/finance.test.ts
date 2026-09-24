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
  compareFinance,
} from "../server/finance";
let db: Database,
  owner: Actor,
  unitId: string,
  otherUnit: string,
  app: ReturnType<typeof createApp>;
const origin = "http://localhost:3000",
  header = "lineCode,lineLabel,group,rowKind,amount,note\n";
before(async () => {
  db = await connectDatabase();
  await migrate(db);
  await initialize(db, { demo: false, ownerEmail: "owner@example.test" });
  const user = (await db.query("SELECT * FROM users WHERE role='owner'"))
      .rows[0],
    units = (await db.query("SELECT id FROM units ORDER BY id")).rows;
  unitId = units[0].id;
  otherUnit = units[1].id;
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
async function person(role = "finance") {
  const id = randomUUID(),
    email = id + "@stjw.org";
  await db.query(
    "INSERT INTO users(id,org_id,name,email,role) VALUES($1,$2,$3,$4,$5)",
    [id, owner.org_id, "Synthetic financial reviewer", email, role],
  );
  return { ...owner, id, email, role } as Actor;
}
function input(changes: Record<string, unknown> = {}) {
  return {
    unitId,
    reportId: randomUUID(),
    expectedVersion: 0,
    metadata: {
      title: "Synthetic monthly report",
      sourceName: "Synthetic finance export",
      currency: "USD",
      kind: "actual",
      basis: "period_activity",
      from: "2026-01-01",
      to: "2026-01-31",
      note: "",
    },
    csv:
      header +
      "A,Tuition,Operating,detail,0.1,\nB,Fees,Operating,detail,0.2,\nT,Total,Operating,total,0.3,",
    reason: "Synthetic source review",
    ...changes,
  };
}
async function publish(raw = input(), actor = owner) {
  const preview = await previewFinancialReport(db, actor, (await session(actor)).hash, raw);
  return publishFinancialReport(db, actor, (await session(actor)).hash, preview.id, {
    sourceHash: preview.sourceHash,
    fingerprint: preview.fingerprint,
    reviewed: true,
  });
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
test("financial imports preserve original source and immutable versioned corrections", async () => {
  const raw = input(),
    first = await publish(raw);
  assert.equal(first.version, 1);
  const revised = await publish({
    ...raw,
    expectedVersion: 1,
    csv: header + "A,Tuition,Operating,detail,0.4,",
    reason: "Synthetic correction",
  });
  assert.equal(revised.version, 2);
  const versions = (
    await db.query(
      "SELECT * FROM financial_report_versions WHERE report_id=$1 ORDER BY version",
      [raw.reportId],
    )
  ).rows;
  assert.equal(versions[0].source_text, raw.csv);
  assert.equal(versions[0].lines.length, 3);
  assert.equal(versions[1].lines[0].amount, "0.4");
  await assert.rejects(
    db.query(
      "UPDATE financial_report_versions SET reason=$1 WHERE report_id=$2",
      ["tampered", raw.reportId],
    ),
    /append-only/,
  );
  const result = await compareFinance(db, owner, (await session(owner)).hash, {
    leftId: raw.reportId,
    leftVersion: 1,
    rightId: raw.reportId,
    rightVersion: 2,
  });
  assert.equal(result.rows[0].delta, "0.3");
  assert.equal(result.rows[1].delta, null);
  assert.equal(result.leftTotals.detailSum, "0.3");
});
test("financial access uses current stored roles, including private previews and PIN restrictions", async () => {
  const finance = await person(),
    employee = await person("employee"),
    manager = await person("manager"),
    raw = input();
  const preview = await previewFinancialReport(db, finance, (await session(finance)).hash, raw);
  await assert.rejects(
    publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, {
      sourceHash: preview.sourceHash,
      fingerprint: preview.fingerprint,
      reviewed: true,
    }),
    /Private import preview/,
  );
  for (const actor of [employee, manager, { ...owner, mode: "pin" } as Actor])
    await assert.rejects(
      previewFinancialReport(db, actor, (await session(actor)).hash, raw),
      /access|password/i,
    );
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [finance.id]);
  await assert.rejects(
    publishFinancialReport(db, finance, (await session(finance)).hash, preview.id, {
      sourceHash: preview.sourceHash,
      fingerprint: preview.fingerprint,
      reviewed: true,
    }),
    /access/,
  );
  const auth = await session(owner, "pin");
  assert.equal(
    (await request(app).get("/api/finance/template").set("Cookie", auth.cookie))
      .status,
    403,
  );
});
test("concurrent financial publications append once, retry receipts are stable and stale previews fail", async () => {
  const raw = input(),
    preview = await previewFinancialReport(db, owner, (await session(owner)).hash, raw),
    other = await previewFinancialReport(db, owner, (await session(owner)).hash, raw),
    body = {
      sourceHash: preview.sourceHash,
      fingerprint: preview.fingerprint,
      reviewed: true,
    };
  const [a, b] = await Promise.all([
    publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, body),
    publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, body),
  ]);
  assert.deepEqual(a, b);
  assert.equal(
    (
      await db.query(
        "SELECT version FROM financial_report_versions WHERE report_id=$1",
        [raw.reportId],
      )
    ).rows.length,
    1,
  );
  await assert.rejects(
    publishFinancialReport(db, owner, (await session(owner)).hash, other.id, {
      sourceHash: other.sourceHash,
      fingerprint: other.fingerprint,
      reviewed: true,
    }),
    /changed/,
  );
  await assert.rejects(
    publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, {
      ...body,
      sourceHash: "0".repeat(64),
    }),
    /does not match/,
  );
});
test("expired financial previews cannot publish and audit failure rolls back all evidence writes", async () => {
  const raw = input(),
    preview = await previewFinancialReport(db, owner, (await session(owner)).hash, raw),
    body = {
      sourceHash: preview.sourceHash,
      fingerprint: preview.fingerprint,
      reviewed: true,
    };
  const failing: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO audit_events"))
              throw Error("Synthetic financial audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    publishFinancialReport(failing, owner, (await session(owner)).hash, preview.id, body),
    /Synthetic/,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM financial_reports WHERE id=$1", [
        raw.reportId,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT applied_at FROM financial_import_previews WHERE id=$1",
        [preview.id],
      )
    ).rows[0].applied_at,
    null,
  );
  // The immutable preview cannot be edited to expire it; use a separately created historical fixture.
  const old = randomUUID();
  await db.query(
    "INSERT INTO financial_import_previews SELECT $1,org_id,unit_id,actor_id,report_id,expected_version,metadata,lines,source_text,source_hash,fingerprint,reason,created_at,now()-interval '1 second',applied_at,receipt FROM financial_import_previews WHERE id=$2",
    [old, preview.id],
  );
  await assert.rejects(publishFinancialReport(db, owner, (await session(owner)).hash, old, body), /expired/);
  await publishFinancialReport(db, owner, (await session(owner)).hash, preview.id, body);
});
test("financial comparisons enforce organization, community, currency and period boundaries", async () => {
  const a = await publish(),
    b = await publish(input({ unitId: otherUnit }));
  await assert.rejects(
    compareFinance(db, owner, (await session(owner)).hash, {
      leftId: a.reportId,
      leftVersion: 1,
      rightId: b.reportId,
      rightVersion: 1,
    }),
    /same community/,
  );
  const raw = input();
  const changed = await publish({
    ...raw,
    metadata: { ...raw.metadata, currency: "CAD" },
  });
  await assert.rejects(
    compareFinance(db, owner, (await session(owner)).hash, {
      leftId: a.reportId,
      leftVersion: 1,
      rightId: changed.reportId,
      rightVersion: 1,
    }),
    /currency/,
  );
  const foreignOrg = randomUUID(),
    foreignId = randomUUID();
  await db.query(
    "INSERT INTO organizations(id,name,timezone) VALUES($1,$2,$3)",
    [foreignOrg, "Synthetic foreign organization", "UTC"],
  );
  await db.query(
    "INSERT INTO users(id,org_id,email,name,role) VALUES($1,$2,$3,'Synthetic foreign owner','owner')",
    [foreignId, foreignOrg, foreignId + "@example.test"],
  );
  await assert.rejects(
    compareFinance(
      db,
      { ...owner, id: foreignId, org_id: foreignOrg },
      (await session({ ...owner, id: foreignId, org_id: foreignOrg, email: foreignId + "@example.test" })).hash,
      {
        leftId: a.reportId,
        leftVersion: 1,
        rightId: a.reportId,
        rightVersion: 1,
      },
    ),
    /not found/,
  );
});
test("financial archive history preserves source versions and blocks further publication until restored", async () => {
  const raw = input(),
    published = await publish(raw),
    auth = await session();
  const post = (body: object) =>
    request(app)
      .post("/api/finance/reports/" + published.reportId + "/archive")
      .set("Origin", origin)
      .set("Cookie", auth.cookie)
      .set("X-CSRF-Token", auth.csrf)
      .send(body);
  assert.equal(
    (
      await post({
        stateVersion: 1,
        archived: true,
        reason: "Synthetic archive review",
      })
    ).status,
    200,
  );
  await assert.rejects(
    previewFinancialReport(db, owner, (await session(owner)).hash, { ...raw, expectedVersion: 1 }),
    /archived/,
  );
  assert.equal(
    (
      await post({
        stateVersion: 1,
        archived: false,
        reason: "Stale restoration",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post({
        stateVersion: 2,
        archived: false,
        reason: "Synthetic restore review",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM financial_report_events WHERE report_id=$1",
        [raw.reportId],
      )
    ).rows.length,
    2,
  );
  assert.equal(
    (
      await db.query(
        "SELECT version FROM financial_report_versions WHERE report_id=$1",
        [raw.reportId],
      )
    ).rows.length,
    1,
  );
});
test("financial exports neutralize spreadsheet formulas and retain source/version provenance", async () => {
  const published = await publish(
      input({ csv: header + "A,=HYPERLINK(bad),Operating,detail,-2.5,@bad" }),
    ),
    auth = await session();
  const csv = await request(app)
    .get(
      "/api/finance/reports/" + published.reportId + "/versions/1?format=csv",
    )
    .set("Cookie", auth.cookie);
  assert.equal(csv.status, 200);
  assert.ok(
    csv.text.includes("'=HYPERLINK") &&
      csv.text.includes("'@bad") &&
      csv.text.includes("source_hash"),
  );
  const source = await request(app)
    .get(
      "/api/finance/reports/" +
        published.reportId +
        "/versions/1?format=source",
    )
    .set("Cookie", auth.cookie);
  assert.equal(source.status, 200);
  assert.match(source.headers["content-disposition"], /\.txt/);
  assert.match(source.headers["content-type"], /text\/plain/);
});
