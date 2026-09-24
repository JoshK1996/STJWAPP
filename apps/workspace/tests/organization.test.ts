import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { connectDatabase, migrate, type Database } from "../server/db";
import { initialize } from "../server/seed";
import { digest, opaqueToken, type Actor } from "../server/security";
import { createApp } from "../server/app";
import {
  previewUnit,
  saveUnit,
  validateUnitForest,
} from "../server/organization";
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
    id: randomUUID(),
    expectedVersion: 0,
    name: "Synthetic unit " + randomUUID(),
    kind: "department",
    parentId: null,
    description: "Synthetic organization review",
    reason: "Synthetic structure verification",
    ...changes,
  };
}
async function prepared(raw = input(), actor = owner) {
  const preview = await previewUnit(db, actor, raw);
  return {
    raw,
    preview,
    save: {
      ...raw,
      commandId: randomUUID(),
      structureVersion: preview.structureVersion,
      previewHash: preview.previewHash,
      reviewed: true,
    },
  };
}
async function create(raw = input()) {
  const p = await prepared(raw);
  return (await saveUnit(db, owner, p.save)).unit;
}
async function session(actor: Actor, mode = "password") {
  const token = opaqueToken(),
    csrf = opaqueToken();
  await db.query(
    "INSERT INTO sessions(token_hash,org_id,user_id,mode,csrf,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
    [digest(token), actor.org_id, actor.id, mode, csrf],
  );
  return { cookie: "stjw_session=" + token, csrf };
}
async function call(path: string, actor: Actor, body?: any, mode = "password") {
  const auth = await session(actor, mode);
  if (body)
    return request(app)
      .post("/api" + path)
      .set("Cookie", auth.cookie)
      .set("Origin", origin)
      .set("X-CSRF-Token", auth.csrf)
      .send(body);
  return request(app)
    .get("/api" + path)
    .set("Cookie", auth.cookie);
}

test("unit hierarchy rejects cycles, foreign parents, duplicate names, excessive depth and oversized structures", () => {
  assert.throws(
    () => validateUnitForest([{ id: "a", name: "A", parent_id: "a" }]),
    /inside itself/,
  );
  assert.throws(
    () =>
      validateUnitForest([
        { id: "a", name: "A", parent_id: "b" },
        { id: "b", name: "B", parent_id: "a" },
      ]),
    /inside itself/,
  );
  assert.throws(
    () => validateUnitForest([{ id: "a", name: "A", parent_id: "unknown" }]),
    /parent in this/,
  );
  assert.throws(
    () =>
      validateUnitForest([
        { id: "a", name: "School" },
        { id: "b", name: "school" },
      ]),
    /unique/,
  );
  const chain = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    name: "Level " + i,
    parent_id: i ? String(i - 1) : null,
  }));
  assert.equal(validateUnitForest(chain).get("7")?.length, 8);
  assert.throws(
    () =>
      validateUnitForest([
        ...chain,
        { id: "8", name: "Level 8", parent_id: "7" },
      ]),
    /eight levels/,
  );
  assert.throws(
    () =>
      validateUnitForest(
        Array.from({ length: 251 }, (_, i) => ({
          id: String(i),
          name: "Unit " + i,
        })),
      ),
    /250/,
  );
});
test("organization writes are reviewed and idempotent and retain immutable name and path history", async () => {
  const parent = await create(input({ kind: "school" })),
    p = await prepared(input({ parentId: parent.id }));
  assert.deepEqual(p.preview.affected[0].afterPath, [parent.name, p.raw.name]);
  await assert.rejects(
    saveUnit(db, owner, { ...p.save, reviewed: false }),
    /true/,
  );
  await assert.rejects(
    saveUnit(db, owner, { ...p.save, previewHash: "0".repeat(64) }),
    /exact organization/,
  );
  const result = await saveUnit(db, owner, p.save);
  assert.deepEqual(await saveUnit(db, owner, p.save), result);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM organization_structure_history WHERE unit_id=$1",
        [result.unit.id],
      )
    ).rows.length,
    1,
  );
  await assert.rejects(
    saveUnit(db, owner, { ...p.save, name: "Changed command" }),
    /different change/,
  );
  const edit = await prepared(
    input({
      id: parent.id,
      expectedVersion: 1,
      name: parent.name + " renamed",
      kind: "school",
    }),
  );
  assert.equal(edit.preview.affected.length, 2);
  await saveUnit(db, owner, edit.save);
  const historical = (
    await db.query(
      "SELECT snapshot FROM organization_structure_history WHERE unit_id=$1 AND unit_version=2",
      [parent.id],
    )
  ).rows[0].snapshot;
  assert.equal(historical.before.name, parent.name);
  assert.equal(historical.affected.length, 2);
  await assert.rejects(
    db.query("DELETE FROM organization_structure_history WHERE unit_id=$1", [
      parent.id,
    ]),
    /append-only/,
  );
  await assert.rejects(
    db.query(
      "UPDATE organization_structure_commands SET result='{}' WHERE command_id=$1",
      [p.save.commandId],
    ),
    /append-only/,
  );
});
test("parent manager assignment never expands child workforce or school access, even after reorganizing", async () => {
  const parent = await create(),
    child = await create(input({ parentId: parent.id })),
    manager = await person("manager");
  await db.query(
    "INSERT INTO user_units(org_id,user_id,unit_id) VALUES($1,$2,$3)",
    [owner.org_id, manager.id, parent.id],
  );
  await db.query(
    "INSERT INTO school_office_grants(org_id,unit_id,user_id,granted_by) VALUES($1,$2,$3,$4)",
    [owner.org_id, parent.id, manager.id, owner.id],
  );
  assert.equal((await call("/organization/structure", manager)).status, 403);
  const me = (await call("/me", manager)).body;
  assert.deepEqual(
    me.units.map((x: any) => x.id),
    [parent.id],
  );
  assert.equal(
    (
      await call("/jobs", manager, {
        unitId: child.id,
        title: "Forbidden inherited job",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/school/years", manager, {
        unitId: child.id,
        name: "Forbidden inherited school year",
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
      })
    ).status,
    403,
  );
  const move = await prepared(
    input({
      id: child.id,
      expectedVersion: child.version,
      name: child.name,
      parentId: null,
    }),
  );
  await saveUnit(db, owner, move.save);
  const putBack = await prepared(
    input({
      id: child.id,
      expectedVersion: child.version + 1,
      name: child.name,
      parentId: parent.id,
    }),
  );
  await saveUnit(db, owner, putBack.save);
  assert.deepEqual((await call("/me", manager)).body.actor.unit_ids, [
    parent.id,
  ]);
  assert.equal(
    (
      await db.query("SELECT job_id FROM user_jobs WHERE user_id=$1", [
        manager.id,
      ])
    ).rows.length,
    0,
  );
});
test("current role, active account and password scope are required at the service and HTTP boundaries", async () => {
  const admin = await person("admin"),
    p = await prepared(input(), admin);
  await db.query("UPDATE users SET role='employee' WHERE id=$1", [admin.id]);
  await assert.rejects(saveUnit(db, admin, p.save), /administrator access/);
  await db.query("UPDATE users SET role='admin',active=false WHERE id=$1", [
    admin.id,
  ]);
  await assert.rejects(previewUnit(db, admin, input()), /administrator access/);
  await assert.rejects(
    previewUnit(db, { ...owner, mode: "api" }, input()),
    /Password/,
  );
  assert.equal(
    (await call("/organization/structure", owner, undefined, "pin")).status,
    403,
  );
  const finance = await person();
  assert.equal((await call("/organization/structure", finance)).status, 403);
});
test("opposing concurrent moves cannot create a cycle or replace newer structural revisions", async () => {
  const a = await create(),
    b = await create();
  const pa = await prepared(
    input({
      id: a.id,
      expectedVersion: a.version,
      name: a.name,
      parentId: b.id,
    }),
  );
  const pb = await prepared(
    input({
      id: b.id,
      expectedVersion: b.version,
      name: b.name,
      parentId: a.id,
    }),
  );
  const outcomes = await Promise.allSettled([
    saveUnit(db, owner, pa.save),
    saveUnit(db, owner, pb.save),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = outcomes.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(rejected.reason.message, /structure changed/);
  const units = (
    await db.query("SELECT * FROM units WHERE org_id=$1", [owner.org_id])
  ).rows;
  validateUnitForest(units);
  const afterA = units.find((x) => x.id === a.id)!,
    afterB = units.find((x) => x.id === b.id)!;
  const nested = afterA.parent_id ? afterA : afterB,
    top = afterA.parent_id ? afterB : afterA;
  await assert.rejects(
    previewUnit(
      db,
      owner,
      input({
        id: top.id,
        expectedVersion: top.version,
        name: top.name,
        parentId: nested.id,
      }),
    ),
    /inside itself/,
  );
});
test("audit failure rolls back the unit, immutable history, command receipt and structural revision", async () => {
  const p = await prepared(),
    before = (
      await db.query(
        "SELECT version FROM organization_structure_state WHERE org_id=$1",
        [owner.org_id],
      )
    ).rows[0].version;
  const broken = {
    ...db,
    transaction: (work: any) =>
      db.transaction((tx) =>
        work({
          query: async (sql: string, params?: any[]) => {
            if (sql.includes("INSERT INTO audit_events"))
              throw new Error("Synthetic structure audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  } as Database;
  await assert.rejects(
    saveUnit(broken, owner, p.save),
    /Synthetic structure audit failure/,
  );
  for (const table of ["units", "organization_structure_history"])
    assert.equal(
      (
        await db.query(
          `SELECT * FROM ${table} WHERE ${table === "units" ? "id" : "unit_id"}=$1`,
          [p.raw.id],
        )
      ).rows.length,
      0,
    );
  assert.equal(
    (
      await db.query(
        "SELECT * FROM organization_structure_commands WHERE command_id=$1",
        [p.save.commandId],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT version FROM organization_structure_state WHERE org_id=$1",
        [owner.org_id],
      )
    ).rows[0].version,
    before,
  );
});
test("a new school unit supports school setup but never copies existing policies, students or staff", async () => {
  const unit = await create(input({ kind: "school" }));
  assert.equal(
    (
      await db.query("SELECT user_id FROM user_units WHERE unit_id=$1", [
        unit.id,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM students WHERE unit_id=$1", [unit.id])).rows
      .length,
    0,
  );
  assert.equal(
    (
      await db.query("SELECT unit_id FROM grading_settings WHERE unit_id=$1", [
        unit.id,
      ])
    ).rows.length,
    0,
  );
  const year = await call("/school/years", owner, {
    unitId: unit.id,
    name: "Synthetic new-school year",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  assert.equal(year.status, 201, year.body.error);
  assert.equal(year.body.unit_id, unit.id);
  const otherOrg = randomUUID(),
    otherUnitId = randomUUID();
  await db.query(
    "INSERT INTO organizations(id,name,timezone) VALUES($1,'Other synthetic org','UTC')",
    [otherOrg],
  );
  await db.query(
    "INSERT INTO units(id,org_id,name,kind) VALUES($1,$2,'Other synthetic school','school')",
    [otherUnitId, otherOrg],
  );
  await assert.rejects(
    previewUnit(db, owner, input({ parentId: otherUnitId })),
    /parent in this organization/,
  );
});
