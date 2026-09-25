import { testStaffRevision } from '../scripts/test-staff-revision';
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import request from "supertest";
import ExcelJS from "exceljs";
import { connectDatabase, migrate, type Database, type Queryable, type Row } from "../server/db";
import { initialize } from "../server/seed";
import { createApp } from "../server/app";
import { digest, issueSetup, type Actor } from "../server/security";
import { inspectImportWorkbook, convertImportWorkbook, downloadFinanceWorkbookTemplate } from "../server/import-workbooks";
import { runImportWorkbook, ImportWorkbookProblem, type WorkbookTemplate } from "../server/import-workbook-runtime";
import { withSpreadsheetSlot } from "../server/spreadsheet-admission";
import { withSnapshotXlsxSlot } from "../server/report-snapshot-xlsx-runtime";
import { workbookConvertResultSchema, workbookInspectResultSchema, workbookIssueSchema, workbookLimits } from "../shared/import-workbooks";
import { financeColumns } from "../shared/finance";
import { parseFinanceCsv } from "../server/finance-engine";

const origin = "http://localhost:3000", password = "Synthetic-Workbook-" + randomUUID();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Credential = { actor: Actor; cookie: string; csrf: string; hash: string };
let db: Database, app: ReturnType<typeof createApp>, owner: Credential, finance: Credential, employee: Credential, template: WorkbookTemplate;
let financeInput: { name: string; email: string; role: "finance"; unitIds: string[]; jobIds: string[] }, valid: Buffer, numeric: Buffer;
async function authenticated(cookieHeader: unknown): Promise<Credential> {
  assert.ok(Array.isArray(cookieHeader)); const cookie = String(cookieHeader[0]).split(";")[0];
  const me = await request(app).get("/api/me").set("Cookie", cookie); assert.equal(me.status, 200);
  return { actor: me.body.actor, csrf: me.body.actor.csrf, cookie, hash: digest(cookie.slice(cookie.indexOf("=") + 1)) };
}
async function login(email: string, mode: "password" | "pin" = "password") {
  const result = await request(app).post("/api/auth/login").set("Origin", origin).send({ email, mode, credential: mode === "password" ? password : "782619" });
  assert.equal(result.status, 200); return authenticated(result.headers["set-cookie"]);
}
async function write(credential: Credential, route: string, body: object, method: "post" | "patch" = "post") {
  return request(app)[method](route).set("Origin", origin).set("Cookie", credential.cookie).set("X-CSRF-Token", credential.csrf).send(body);
}
async function provision(role: "finance" | "employee") {
  const unit = (await request(app).get("/api/me").set("Cookie", owner.cookie)).body.units[0];
  const input = { name: "Synthetic workbook " + role, email: `workbook.${role}@example.test`, role, unitIds: [unit.id], jobIds: [] };
  const created = await write(owner, "/api/staff", input); assert.equal(created.status, 201);
  const token = new URL(created.body.setupUrl).hash.slice(7);
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  return { credential: await authenticated(setup.headers["set-cookie"]), input };
}
async function workbook(useNumber = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Private worksheet title");
  sheet.addRow(["Reviewed instruction"]); sheet.addRow([...financeColumns]);
  sheet.addRow(["0012", "=Literal label", "Operations", "detail", useNumber ? -2.5 : "-2.5000", "Quoted, \"cell\"\nUnicode é"]);
  sheet.getRow(5).values = ["0013", "Other", "Operations", "detail", "0.1000", ""];
  const other = book.addWorksheet("Excluded source title"); other.addRow(["Separate unselected text"]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
function wrapped(beforeFinal?: () => Promise<void>, hook?: (tx: Queryable, sql: string, params: any[]) => Promise<void>): Database {
  let transactions = 0;
  return { ...db, transaction: async action => {
    transactions++; if (transactions === 2 && beforeFinal) await beforeFinal();
    return db.transaction(tx => action({ query: async<T extends Row>(sql: string, params: any[] = []) => {
      const result = await tx.query<T>(sql, params); if (hook) await hook(tx, sql, params); return result;
    } }));
  } };
}
async function auditCount() { return Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'import.workbook_%'")).rows[0].n); }
const input = () => ({ kind: "finance" as const, base64: valid.toString("base64") });
before(async () => {
  db = await connectDatabase(); await migrate(db); await initialize(db, { demo: false, ownerEmail: "workbook.owner@example.test" });
  app = createApp(db, { origin, production: false, demo: false, staffDomain: "example.test" });
  const person = (await db.query("SELECT id,org_id FROM users WHERE role='owner'")).rows[0];
  const token = await db.transaction(tx => issueSetup(tx, person as { id: string; org_id: string }));
  const setup = await request(app).post("/api/auth/setup").set("Origin", origin).send({ token, password }); assert.equal(setup.status, 200);
  owner = await authenticated(setup.headers["set-cookie"]);
  const prepared = await provision("finance"); finance = prepared.credential; financeInput = prepared.input as typeof financeInput;
  employee = (await provision("employee")).credential;
  assert.equal((await write(finance, "/api/auth/pin", { password, pin: "782619" })).status, 200);
  template = await downloadFinanceWorkbookTemplate(db, owner.actor, owner.hash);
  valid = await workbook(); numeric = await workbook(true);
});
after(async () => { await db?.close(); });

test("normal finance proof inspects and converts exact text with explicit exclusions without creating business data", async () => {
  const first = await inspectImportWorkbook(db, finance.actor, finance.hash, input());
  assert.deepEqual(first.samples, []); assert.equal(first.workbookHash, sha(valid)); assert.equal(first.sheets.length, 2);
  const selected = await inspectImportWorkbook(db, finance.actor, finance.hash, { ...input(), sheetId: first.sheets[0].sheetId });
  assert.equal(selected.samples[2].cells[4].value, "-2.5000");
  const result = await convertImportWorkbook(db, finance.actor, finance.hash, { ...input(), sheetId: first.sheets[0].sheetId, headerRow: 2, expectedWorkbookHash: first.workbookHash });
  assert.deepEqual(result.rowMap, [{ csvRow: 2, worksheetRow: 3 }, { csvRow: 3, worksheetRow: 5 }]); assert.deepEqual(result.emptyRows, [4]);
  assert.deepEqual(result.ignoredLeadingRows, { count: 1, nonemptyRows: [1] }); assert.equal(result.ignoredSheets[0].name, "Excluded source title");
  assert.ok(result.csv.startsWith("\uFEFF")); assert.ok(result.csv.includes('"-2.5000"')); assert.ok(!result.csv.includes("'-2.5000"));
  assert.equal(result.csvHash, sha(result.csv)); assert.equal(result.csvBytes, Buffer.byteLength(result.csv));
  assert.deepEqual(parseFinanceCsv(result.csv), [{ lineCode: "0012", lineLabel: "=Literal label", group: "Operations", rowKind: "detail", amount: "-2.5", note: 'Quoted, "cell"\nUnicode é' }, { lineCode: "0013", lineLabel: "Other", group: "Operations", rowKind: "detail", amount: "0.1", note: "" }]);
  const data = (await db.query("SELECT (SELECT count(*)::int FROM financial_reports) AS reports,(SELECT count(*)::int FROM financial_import_previews) AS previews")).rows[0]; assert.deepEqual(data, { reports: 0, previews: 0 });
  const audit = (await db.query("SELECT detail FROM audit_events WHERE action='import.workbook_converted' ORDER BY created_at DESC LIMIT 1")).rows[0].detail;
  assert.deepEqual(Object.keys(audit).sort(), ["kind", "parserVersion", "workbookHash", "workbookBytes", "sheetId", "headerRow", "rowCount", "csvHash", "csvBytes", "ignoredSheetCount", "ignoredLeadingRowCount", "emptyRowCount"].sort());
  assert.ok(!JSON.stringify(audit).includes("Private worksheet") && !JSON.stringify(audit).includes("-2.5000"));
});
test("fixed blank template roundtrips through inspection and contains text formatting without invented rows", async () => {
  assert.equal(template.hash, sha(template.buffer)); assert.ok(template.bytes <= workbookLimits.inputBytes);
  const inspected = await inspectImportWorkbook(db, owner.actor, owner.hash, { kind: "finance", base64: template.buffer.toString("base64"), sheetId: 1 });
  assert.equal(inspected.sheets.length, 1); assert.deepEqual(inspected.samples[0].cells.map(c => c.value), [...financeColumns]);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(template.buffer as any);
  assert.equal(book.worksheets[0].getCell("E501").numFmt, "@"); assert.equal(book.worksheets[0].getCell("E2").value, null);
});
test("worker domain errors keep coordinates and stale workbook hash distinct", async () => {
  await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, { kind: "finance", base64: numeric.toString("base64") }), (e: any) => e instanceof ImportWorkbookProblem && e.status === 422 && e.issue.code === "non_text_cell" && e.issue.cells.some((c: any) => c.row === 3 && c.column === 5));
  await assert.rejects(convertImportWorkbook(db, finance.actor, finance.hash, { ...input(), sheetId: 1, headerRow: 2, expectedWorkbookHash: "0".repeat(64) }), (e: any) => e.status === 409 && e.issue.code === "source_changed");
});
test("base64 validates canonical pad bits and decoded cap before a worker can publish", async () => {
  const before = await auditCount();
  await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, { kind: "finance", base64: "Zh==" }), (e: any) => e.status === 400);
  await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, { kind: "finance", base64: Buffer.alloc(workbookLimits.inputBytes + 1).toString("base64") }), (e: any) => e.status === 413);
  await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, { kind: "finance", base64: "A".repeat(workbookLimits.base64Characters + 4) }), (e: any) => e.status === 413);
  assert.equal(await auditCount(), before);
});
test("current finance session is mandatory before worker admission, including cached actors", async () => {
  for (const credential of [undefined, "f".repeat(64)]) await assert.rejects(inspectImportWorkbook(db, finance.actor, credential, input()), (e: any) => e.status === 401);
  await assert.rejects(inspectImportWorkbook(db, employee.actor, employee.hash, input()), (e: any) => e.status === 403);
  await assert.rejects(inspectImportWorkbook(db, { ...finance.actor, org_id: randomUUID() }, finance.hash, input()), (e: any) => e.status === 403);
  await assert.rejects(inspectImportWorkbook(db, { ...finance.actor, mode: "api" }, finance.hash, input()), (e: any) => e.status === 403);
});
test("normal logout while worker phase is outside transactions denies result and audit then normal login recovers", async () => {
  const before = await auditCount();
  const source = wrapped(async () => { assert.equal((await write(finance, "/api/auth/logout", {})).status, 200); });
  await assert.rejects(inspectImportWorkbook(source, finance.actor, finance.hash, input()), (e: any) => e.status === 401);
  assert.equal(await auditCount(), before); finance = await login(financeInput.email);
  assert.equal((await inspectImportWorkbook(db, finance.actor, finance.hash, input())).workbookHash, sha(valid));
});
test("normal account role change between worker and publication rechecks current authority", async () => {
  const before = await auditCount();
  const source = wrapped(async () => { assert.equal((await write(owner, `/api/staff/${finance.actor.id}`, { ...financeInput, expectedRevision: await testStaffRevision(db,finance.actor.id), role: "employee", active: true }, "patch")).status, 200); });
  try {
    await assert.rejects(inspectImportWorkbook(source, finance.actor, finance.hash, input()), (e: any) => [401, 403].includes(e.status));
    assert.equal(await auditCount(), before); const downgraded = await login(financeInput.email);
    await assert.rejects(inspectImportWorkbook(db, downgraded.actor, downgraded.hash, input()), (e: any) => e.status === 403);
  } finally {
    assert.equal((await write(owner, `/api/staff/${finance.actor.id}`, { ...financeInput, expectedRevision: await testStaffRevision(db,finance.actor.id), active: true }, "patch")).status, 200);
    finance = await login(financeInput.email);
  }
});
test("even coordinate errors require final current proof after worker completion", async () => {
  const before = await auditCount(), source = wrapped(async () => { assert.equal((await write(finance, "/api/auth/logout", {})).status, 200); });
  await assert.rejects(inspectImportWorkbook(source, finance.actor, finance.hash, { kind: "finance", base64: numeric.toString("base64") }), (e: any) => e.status === 401);
  assert.equal(await auditCount(), before); finance = await login(financeInput.email);
});
test("post-audit failure, controlled final expiry and final cancellation roll back only transient audit", async () => {
  const before = await auditCount();
  for (const mode of ["failure", "expiry", "abort"] as const) {
    const controller = new AbortController();
    const source = wrapped(undefined, async (tx, sql, params) => {
      if (sql.startsWith("INSERT INTO audit_events") && params[3] === "import.workbook_inspected") {
        if (mode === "failure") throw new Error("Synthetic workbook audit failure");
        // A normally created proof is expired only inside this isolated test
        // transaction, which must roll back. Not a natural-duration claim.
        if (mode === "expiry") await tx.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [finance.hash]);
        if (mode === "abort") controller.abort();
      }
    });
    await assert.rejects(inspectImportWorkbook(source, finance.actor, finance.hash, input(), controller.signal), (e: any) => mode === "failure" ? e.message === "Synthetic workbook audit failure" : e.status === (mode === "expiry" ? 401 : 499));
    assert.equal(await auditCount(), before);
  }
  assert.equal((await inspectImportWorkbook(db, finance.actor, finance.hash, input())).workbookHash, sha(valid));
});
test("shared admission excludes both import/export directions and releases failures", async () => {
  await withSnapshotXlsxSlot("exporter", async () => { await assert.rejects(inspectImportWorkbook(db, finance.actor, finance.hash, input()), (e: any) => e.status === 429); });
  await withSpreadsheetSlot("importer", async () => { await assert.rejects(withSnapshotXlsxSlot("exporter", async () => null), (e: any) => e.status === 429 && /spreadsheet export/.test(e.message)); });
  await assert.rejects(withSpreadsheetSlot("failed", async () => { throw new Error("Synthetic slot failure"); }));
  assert.ok((await downloadFinanceWorkbookTemplate(db, finance.actor, finance.hash)).bytes);
});
test("actual worker deadline and cancellation terminate work and permit a later template", async () => {
  await assert.rejects(runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "finance", action: "template" }, { deadlineMs: 1 }), (e: any) => e.status === 503);
  const controller = new AbortController();
  const pending = runImportWorkbook({ schemaVersion: 1, parserVersion: 1, kind: "finance", action: "template" }, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, (e: any) => e.status === 499);
  assert.ok((await downloadFinanceWorkbookTemplate(db, finance.actor, finance.hash)).bytes);
});
test("HTTP routes enforce ordinary proofs, strict bodies, origin/CSRF and private binary bytes", async () => {
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", origin).send(input())).status, 401);
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", origin).set("Cookie", finance.cookie).send(input())).status, 403);
  assert.equal((await write(finance, "/api/import-workbooks/inspect", { ...input(), arbitrary: true })).status, 400);
  assert.equal((await request(app).post("/api/import-workbooks/inspect").set("Origin", "http://other.test").set("Cookie", finance.cookie).set("X-CSRF-Token", finance.csrf).send(input())).status, 403);
  const inspected = await write(finance, "/api/import-workbooks/inspect", input()); assert.equal(inspected.status, 200); workbookInspectResultSchema.parse(inspected.body); assert.equal(inspected.headers["cache-control"], "private, no-store");
  const converted = await write(finance, "/api/import-workbooks/convert", { ...input(), sheetId: 1, headerRow: 2, expectedWorkbookHash: inspected.body.workbookHash }); assert.equal(converted.status, 200); workbookConvertResultSchema.parse(converted.body);
  const invalid = await write(finance, "/api/import-workbooks/inspect", { kind: "finance", base64: numeric.toString("base64") }); assert.equal(invalid.status, 422); workbookIssueSchema.parse(invalid.body);
  const binary = await request(app).get("/api/import-workbooks/template?kind=finance").set("Cookie", finance.cookie).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => done(null, Buffer.concat(chunks))); });
  assert.equal(binary.status, 200); assert.equal(binary.headers["x-workbook-sha256"], sha(binary.body)); assert.equal(binary.headers["cache-control"], "private, no-store"); assert.match(binary.headers["content-disposition"], /stjw-financial-template\.xlsx/);
  assert.equal((await request(app).get("/api/import-workbooks/template?kind=finance&kind=finance").set("Cookie", finance.cookie)).status, 400);
  assert.equal((await request(app).get("/api/import-workbooks/template?kind=finance&url=https://other.test").set("Cookie", finance.cookie)).status, 400);
  const pin = await login(financeInput.email, "pin"); assert.equal((await write(pin, "/api/import-workbooks/inspect", input())).status, 403);
  const token = await write(owner, "/api/tokens", { name: "Synthetic workbook denial", scopes: ["reports:read"], days: 1 }); assert.equal(token.status, 200);
  assert.equal((await request(app).get("/api/import-workbooks/template?kind=finance").set("Authorization", `Bearer ${token.body.token}`)).status, 403);
});
