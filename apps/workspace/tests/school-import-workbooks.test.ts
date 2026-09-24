import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { createApp } from "../server/app";
import { initialize } from "../server/seed";
import { digest, issueSetup, type Actor } from "../server/security";
import { inspectImportWorkbook, convertImportWorkbook, downloadImportWorkbookTemplate } from "../server/import-workbooks";
import { parseSchoolCsv } from "../server/school-imports";
import { workbookConvertInput, workbookInspectInput, workbookTemplateInput, workbookConvertResultSchema, workbookConvertResultSchemaFor,
  workbookInspectResultSchema, workbookColumnsFor, schoolWorkbookKinds, type WorkbookKind } from "../shared/import-workbooks";
import { schoolImportCatalog, type SchoolImportContext, type SchoolImportKind } from "../shared/school-imports";

const origin = "http://localhost:3000", password = "Synthetic-school-workbook-" + randomUUID(), pin = "389271";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type Credential = { actor: Actor; hash: string; cookie: string; csrf: string };
type StaffInput = { name: string; email: string; role: "employee" | "finance" | "admin"; unitIds: string[]; jobIds: string[] };
let db: Database, app: ReturnType<typeof createApp>, owner: Credential, office: Credential, finance: Credential, admin: Credential;
let officeInput: StaffInput, adminInput: StaffInput, unitId: string, otherUnit: string, valid: Buffer, numeric: Buffer;
async function authenticated(headers: unknown): Promise<Credential> {
  assert.ok(Array.isArray(headers)); const cookie = String(headers[0]).split(";")[0];
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, cookie, csrf: me.body.actor.csrf, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
}
async function login(email: string, mode: "password" | "pin" = "password") {
  const response = await request(app).post("/api/auth/login").set("Origin", origin).send({ email, mode, credential: mode === "pin" ? pin : password });
  assert.equal(response.status, 200); return authenticated(response.headers["set-cookie"]);
}
async function write(auth: Credential, path: string, body: object, method: "post" | "patch" = "post") {
  return request(app)[method](path).set("Origin", origin).set("Cookie", auth.cookie).set("X-CSRF-Token", auth.csrf).send(body);
}
async function provision(role: StaffInput["role"]) {
  const input: StaffInput = { role, name: "Synthetic workbook " + role, email: `${randomUUID()}@example.test`, unitIds: [unitId], jobIds: [] };
  const created = await write(owner, "/api/staff", input); assert.equal(created.status, 201);
  const token = new URL(created.body.setupUrl).hash.slice(7);
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  return { input, credential: await authenticated(setup.headers["set-cookie"]) };
}
async function grant(enabled: boolean, target = office, unit = unitId) {
  assert.equal((await write(owner, "/api/school/office-grants", { unitId: unit, userId: target.actor.id, enabled })).status, 200);
}
async function workbook(kind: WorkbookKind, row?: (string | number)[], reordered = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Private school source");
  const headers = [...workbookColumnsFor(kind)]; if (reordered) headers.reverse();
  sheet.addRow(headers); if (row) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}
function wrapped(beforeFinal?: () => Promise<void>, hook?: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  let count = 0;
  return { ...db, transaction: async action => {
    count++; if (count === 2 && beforeFinal) await beforeFinal();
    return db.transaction(tx => action({ query: async<T extends Row>(sql: string, params: any[] = []) => {
      const value = await tx.query<T>(sql, params); if (hook) await hook(tx, sql, params); return value;
    } }));
  } };
}
const input = () => ({ kind: "school_students" as const, unitId, base64: valid.toString("base64") });
async function auditCount() { return Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'import.workbook_%'")).rows[0].n); }
async function businessCounts() { return (await db.query(`SELECT (SELECT count(*)::int FROM students) AS students,
  (SELECT count(*)::int FROM school_people) AS people,(SELECT count(*)::int FROM households) AS households,
  (SELECT count(*)::int FROM student_contacts) AS contacts,(SELECT count(*)::int FROM school_import_batches) AS batches,
  (SELECT count(*)::int FROM student_enrollments) AS enrollments,(SELECT count(*)::int FROM section_students) AS roster`)).rows[0]; }
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "synthetic.school-workbook@example.test" });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: "example.test" });
  const person = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, person as { id: string; org_id: string }));
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  owner = await authenticated(setup.headers["set-cookie"]);
  const units = (await request(app).get("/api/me").set("Cookie", owner.cookie)).body.units;
  unitId = units.find((u: any) => u.kind === "school").id; otherUnit = units.find((u: any) => u.kind === "administration").id;
  const employee = await provision("employee"); office = employee.credential; officeInput = employee.input;
  finance = (await provision("finance")).credential;
  const administrator = await provision("admin"); admin = administrator.credential; adminInput = administrator.input;
  await grant(true); assert.equal((await write(office, "/api/auth/pin", { password, pin })).status, 200);
  valid = await workbook("school_students", ["00017", "=Literal student text", ""]);
  numeric = await workbook("school_students", [17, "Synthetic numeric identifier", ""]);
});
after(async () => { await db?.close(); });

test("strict school request context requires a unit and rejects year, section, repeats and arbitrary headers", () => {
  for (const kind of schoolWorkbookKinds) {
    assert.equal(workbookTemplateInput.parse({ kind, unitId }).kind, kind);
    assert.ok(!workbookTemplateInput.safeParse({ kind }).success);
    assert.ok(!workbookInspectInput.safeParse({ kind, base64: valid.toString("base64") }).success);
    assert.ok(!workbookConvertInput.safeParse({ kind, unitId, base64: valid.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(valid), columns: [] }).success);
  }
  for (const extra of [{ unitId: [unitId, unitId] }, { yearId: randomUUID() }, { sectionId: randomUUID() }])
    assert.ok(!workbookTemplateInput.safeParse({ kind: "school_roster", unitId, ...extra }).success);
  assert.ok(!workbookTemplateInput.safeParse({ kind: "finance", unitId }).success);
  assert.ok(!workbookInspectInput.safeParse({ kind: "finance", unitId, base64: valid.toString("base64") }).success);
});

test("all six blank templates and converters match existing CSV catalogs without creating school data", async () => {
  const before = await businessCounts();
  for (const kind of schoolWorkbookKinds) {
    const schoolKind = kind.slice(7) as SchoolImportKind, headers = schoolImportCatalog[schoolKind].columns;
    const template = await downloadImportWorkbookTemplate(db, office.actor, office.hash, { kind, unitId });
    assert.equal(template.hash, sha(template.buffer));
    const inspected = await inspectImportWorkbook(db, office.actor, office.hash, { kind, unitId, base64: template.buffer.toString("base64"), sheetId: 1 });
    assert.deepEqual(inspected.samples[0].cells.map(c => c.value), headers);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(template.buffer as any);
    assert.equal(book.worksheets[0].getCell(2, headers.length).value, null); assert.equal(book.worksheets[0].getCell(501, headers.length).numFmt, "@");
    // Empty contact booleans/actions deliberately remain empty. Conversion
    // cannot infer permissions or supply a business-valid relationship.
    const row = headers.map((_, i) => i === 0 ? "00017" : i === 1 ? "=Literal, \"text\"\né" : "");
    const source = await workbook(kind, row), result = await convertImportWorkbook(db, office.actor, office.hash,
      { kind, unitId, base64: source.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(source) });
    workbookConvertResultSchemaFor(kind).parse(result); assert.deepEqual(result.headers, headers);
    const context = schoolKind === "roster" ? { kind: schoolKind, unitId, sectionId: randomUUID() }
      : schoolKind === "enrollments" ? { kind: schoolKind, unitId, yearId: randomUUID() } : { kind: schoolKind, unitId };
    const parsed = parseSchoolCsv(context as SchoolImportContext, result.csv);
    assert.deepEqual(parsed[0], Object.fromEntries(headers.map((header, index) => [header, row[index]])));
    assert.equal(result.csvHash, sha(result.csv)); assert.equal(result.csvBytes, Buffer.byteLength(result.csv));
    assert.ok(!workbookConvertResultSchema.safeParse(result).success);
  }
  assert.deepEqual(await businessCounts(), before);
});

test("school header order and record byte cap are enforced while finance keeps reordered columns", async () => {
  const source = await workbook("school_students", ["", "Literal", "00017"], true);
  await assert.rejects(convertImportWorkbook(db, office.actor, office.hash, { kind: "school_students", unitId, base64: source.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(source) }), (e: any) => e.status === 422 && e.issue.code === "header_mismatch");
  const large = await workbook("school_students", ["00017", "é".repeat(2100), ""]);
  await assert.rejects(convertImportWorkbook(db, office.actor, office.hash, { kind: "school_students", unitId, base64: large.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(large) }), (e: any) => e.status === 413);
  const financeSource = await workbook("finance", ["", "1.0000", "detail", "Group", "Label", "00017"], true);
  const result = await convertImportWorkbook(db, finance.actor, finance.hash, { kind: "finance", base64: financeSource.toString("base64"), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(financeSource) });
  workbookConvertResultSchema.parse(result); assert.deepEqual(result.headers, [...workbookColumnsFor("finance")].reverse());
});

test("authority is current office scope rather than finance role, stale supplied units or workbook text", async () => {
  const badBytes = { ...input(), base64: "Zh==" };
  await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, badBytes), (e: any) => e.status === 403);
  for (const hash of [undefined, "f".repeat(64)]) await assert.rejects(inspectImportWorkbook(db, office.actor, hash, input()), (e: any) => e.status === 401);
  await assert.rejects(inspectImportWorkbook(db, { ...office.actor, role: "owner", unit_ids: [otherUnit] }, office.hash, { ...input(), unitId: otherUnit }), (e: any) => e.status === 403);
  await assert.rejects(inspectImportWorkbook(db, { ...owner.actor, org_id: randomUUID() }, owner.hash, input()), (e: any) => e.status === 403);
  await assert.rejects(inspectImportWorkbook(db, owner.actor, owner.hash, { ...input(), unitId: randomUUID() }), (e: any) => e.status === 404);
  assert.equal((await inspectImportWorkbook(db, admin.actor, admin.hash, { ...input(), unitId: otherUnit })).workbookHash, sha(valid));
});

test("normal office grant revocation between parsing and publication denies both success and coordinate errors", async () => {
  for (const bytes of [valid, numeric]) {
    const before = await auditCount(), source = wrapped(async () => grant(false));
    try { await assert.rejects(inspectImportWorkbook(source, office.actor, office.hash, { ...input(), base64: bytes.toString("base64") }), (e: any) => e.status === 403); assert.equal(await auditCount(), before); }
    finally { await grant(true); }
  }
});

test("normal membership removal and administrator downgrade revoke cached authority after the worker", async () => {
  const before = await auditCount();
  const membership = wrapped(async () => { assert.equal((await write(owner, `/api/staff/${office.actor.id}`, { ...officeInput, unitIds: [otherUnit], active: true }, "patch")).status, 200); });
  try { await assert.rejects(inspectImportWorkbook(membership, office.actor, office.hash, input()), (e: any) => [401, 403].includes(e.status)); }
  finally { assert.equal((await write(owner, `/api/staff/${office.actor.id}`, { ...officeInput, active: true }, "patch")).status, 200); office = await login(officeInput.email); await grant(true); }
  const downgraded = wrapped(async () => { assert.equal((await write(owner, `/api/staff/${admin.actor.id}`, { ...adminInput, role: "employee", active: true }, "patch")).status, 200); });
  try { await assert.rejects(inspectImportWorkbook(downgraded, admin.actor, admin.hash, input()), (e: any) => [401, 403].includes(e.status)); }
  finally { assert.equal((await write(owner, `/api/staff/${admin.actor.id}`, { ...adminInput, active: true }, "patch")).status, 200); admin = await login(adminInput.email); }
  assert.equal(await auditCount(), before);
});

test("normal session logout while parsing denies the result and template publication", async () => {
  const before = await auditCount();
  for (const template of [false, true]) {
    const current = office, source = wrapped(async () => { assert.equal((await write(current, "/api/auth/logout", {})).status, 200); });
    await assert.rejects(template ? downloadImportWorkbookTemplate(source, current.actor, current.hash, { kind: "school_contacts", unitId })
      : inspectImportWorkbook(source, current.actor, current.hash, input()), (e: any) => e.status === 401);
    office = await login(officeInput.email);
  }
  assert.equal(await auditCount(), before);
});

test("final proof and cancellation roll back audit after controlled expiry, MFA and onboarding changes", async () => {
  const before = await auditCount();
  for (const mode of ["expiry", "mfa", "onboarding", "abort", "audit"] as const) {
    const controller = new AbortController(), source = wrapped(undefined, async (tx, sql, params) => {
      if (!sql.startsWith("INSERT INTO audit_events") || params[3] !== "import.workbook_inspected") return;
      // Controlled in-transaction mutations of an ordinary synthetic account
      // prove the final predicate and rollback, not natural elapsed-time waits.
      if (mode === "expiry") await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [office.hash]);
      if (mode === "onboarding") await tx.query("UPDATE users SET requires_credential_change=true WHERE id=$1", [office.actor.id]);
      if (mode === "mfa") await tx.query("INSERT INTO mfa_factors(user_id,org_id,id,secret_cipher,credential_digest,pending_expires_at,enabled_at) VALUES($1,$2,$3,'synthetic-test-only','synthetic-test-only',clock_timestamp(),clock_timestamp())", [office.actor.id, office.actor.org_id, randomUUID()]);
      if (mode === "abort") controller.abort();
      if (mode === "audit") throw new Error("Synthetic workbook audit rollback");
    });
    await assert.rejects(inspectImportWorkbook(source, office.actor, office.hash, input(), controller.signal), (e: any) => mode === "audit" ? e.message === "Synthetic workbook audit rollback" : e.status === (mode === "abort" ? 499 : 401));
    assert.equal(await auditCount(), before);
  }
  assert.equal((await inspectImportWorkbook(db, office.actor, office.hash, input())).workbookHash, sha(valid));
});

test("captured input remains bound to authorized kind, unit and bytes despite caller mutation after the first await", async () => {
  const raw = input(), source = wrapped(async () => { raw.unitId = otherUnit; raw.base64 = "Zh=="; });
  const result = await inspectImportWorkbook(source, office.actor, office.hash, raw); assert.equal(result.workbookHash, sha(valid));
  const entry = (await db.query("SELECT detail FROM audit_events WHERE action='import.workbook_inspected' ORDER BY created_at DESC LIMIT 1")).rows[0].detail;
  assert.equal(entry.unitId, unitId); assert.equal(entry.kind, "school_students");
  assert.deepEqual(Object.keys(entry).sort(), ["kind", "unitId", "parserVersion", "workbookHash", "workbookBytes", "sheetId", "sheetCount"].sort());
  assert.ok(!JSON.stringify(entry).includes("Private school source") && !JSON.stringify(entry).includes("Literal"));
});

test("school HTTP routes preserve private proof, strict scope, CSRF and binary hash boundaries", async () => {
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", origin).send(input())).status, 401);
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", origin).set("Cookie", office.cookie).send(input())).status, 403);
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", "http://other.test").set("Cookie", office.cookie).set("X-CSRF-Token", office.csrf).send(input())).status, 403);
  const inspected = await write(office, "/api/import-workbooks/inspect", input()); assert.equal(inspected.status, 200); workbookInspectResultSchema.parse(inspected.body); assert.equal(inspected.headers["cache-control"], "private, no-store");
  const converted = await write(office, "/api/import-workbooks/convert", { ...input(), sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(valid) }); assert.equal(converted.status, 200); workbookConvertResultSchemaFor("school_students").parse(converted.body);
  for (const query of ["kind=school_students", `kind=school_students&unitId=${unitId}&unitId=${unitId}`, `kind=school_students&unitId=${unitId}&yearId=${randomUUID()}`, `kind=finance&unitId=${unitId}`])
    assert.equal((await request(app).get("/api/import-workbooks/template?" + query).set("Cookie", office.cookie)).status, 400);
  const binary = await request(app).get(`/api/import-workbooks/template?kind=school_contacts&unitId=${unitId}`).set("Cookie", office.cookie).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => done(null, Buffer.concat(chunks))); });
  assert.equal(binary.status, 200); assert.equal(binary.headers["x-workbook-sha256"], sha(binary.body)); assert.equal(binary.headers["cache-control"], "private, no-store"); assert.match(binary.headers["content-disposition"], /stjw-contacts-template\.xlsx/);
  const pinAuth = await login(officeInput.email, "pin"); assert.equal((await write(pinAuth, "/api/import-workbooks/inspect", input())).status, 403);
  const token = await write(owner, "/api/tokens", { name: "Synthetic school workbook denial", scopes: ["reports:read"], days: 1 }); assert.equal(token.status, 200);
  assert.equal((await request(app).get(`/api/import-workbooks/template?kind=school_students&unitId=${unitId}`).set("Authorization", `Bearer ${token.body.token}`)).status, 403);
});
