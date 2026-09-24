import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseImportWorkbook, createFinanceImportTemplate, financeWorkbookColumns, ImportWorkbookError } from '../server/import-workbook-parser.mjs';
import { readImportWorkbookZip, workbookCrc32 } from '../server/import-workbook-zip.mjs';
import { workbookConvertResultSchema, workbookInspectResultSchema } from '../shared/import-workbooks';
import { financeColumns } from '../shared/finance';
import { parseFinanceCsv } from '../server/finance-engine';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const sha = (x: Uint8Array | string) => createHash('sha256').update(x).digest('hex');
const base = { schemaVersion: 1, parserVersion: 1, kind: 'finance' } as const;
const inspect = (bytes: Uint8Array, sheetId?: number) => parseImportWorkbook({ ...base, action: 'inspect', bytes, ...(sheetId ? { sheetId } : {}) });
const convert = (bytes: Uint8Array, headerRow = 1) => parseImportWorkbook({ ...base, action: 'convert', bytes, sheetId: 1, headerRow, expectedWorkbookHash: sha(bytes) });
const esc = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
const row = (r: number, values: string[]) => `<row r="${r}">${values.map((v, i) => cell(String.fromCharCode(65 + i) + r, v)).join('')}</row>`;
const headers = row(1, [...financeColumns]);
const one = row(2, ['001', 'Synthetic, "quoted"', 'Example', 'detail', '-2.5000', ' First\nlast 🕊 ']);
function parts(sheet = `<worksheet xmlns="${NS}"><sheetData>${headers}${one}</sheetData></worksheet>`): Record<string, string> {
  return {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet sheetId="1" name="Synthetic" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
}
async function pack(values = parts(), compressed = false, descriptors = false) {
  const zip = new JSZip(); for (const [path, text] of Object.entries(values)) zip.file(path, text, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: compressed ? 'DEFLATE' : 'STORE', streamFiles: descriptors });
}
function central(bytes: Buffer) {
  const end = bytes.length - 22; assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let p = bytes.readUInt32LE(end + 16); const rows: { at: number; local: number; name: string }[] = [];
  while (p < end) {
    assert.equal(bytes.readUInt32LE(p), 0x02014b50);
    const n = bytes.readUInt16LE(p + 28), x = bytes.readUInt16LE(p + 30), c = bytes.readUInt16LE(p + 32);
    rows.push({ at: p, local: bytes.readUInt32LE(p + 42), name: bytes.subarray(p + 46, p + 46 + n).toString() }); p += 46 + n + x + c;
  }
  return rows;
}
async function reject(bytes: Uint8Array, codes?: string[]) {
  await assert.rejects(inspect(bytes), (e: unknown) => e instanceof ImportWorkbookError && (!codes || codes.includes(e.code)));
}

test('hand-authored OOXML converts exact quoted text to existing finance validator without export apostrophes', async () => {
  const bytes = await pack(), result = await convert(bytes); workbookConvertResultSchema.parse(result);
  assert.deepEqual(financeWorkbookColumns, financeColumns);
  assert.equal(result.csv, '\uFEFF"lineCode","lineLabel","group","rowKind","amount","note"\r\n"001","Synthetic, ""quoted""","Example","detail","-2.5000"," First\nlast 🕊 "');
  assert.equal(result.csvHash, sha(result.csv)); assert.equal(result.workbookHash, sha(bytes)); assert.notEqual(result.csvHash, result.workbookHash);
  assert.equal(parseFinanceCsv(result.csv)[0].amount, '-2.5'); assert.equal(parseFinanceCsv(result.csv)[0].lineCode, '001');
  assert.deepEqual(result.rowMap, [{ csvRow: 2, worksheetRow: 2 }]);
});
test('actual ExcelJS blank text template, filled by ExcelJS, passes preflight and schema roundtrip', async () => {
  const generated = await createFinanceImportTemplate(); assert.equal(generated.hash, sha(generated.bytes)); assert.ok(generated.bytes.length < 262144);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(generated.bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.getWorksheet(1)!; ['A01', '=Literal text', 'Example', 'detail', '900000000001.1000', ''].forEach((v, i) => sheet.getCell(2, i + 1).value = v);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer()); const result = await convert(bytes);
  assert.equal(result.rowCount, 1); assert.ok(result.csv.includes('"=Literal text"')); assert.equal(parseFinanceCsv(result.csv)[0].amount, '900000000001.1');
  workbookInspectResultSchema.parse(await inspect(bytes, 1));
});
test('reordered exact headers and selected leading/blank rows retain real worksheet mapping', async () => {
  const data = row(1, ['Instructions']) + row(3, ['amount', 'lineCode', 'lineLabel', 'group', 'rowKind', 'note']) + row(5, ['0.0001', '00', 'Sample', '', 'detail', '']);
  const bytes = await pack(parts(`<worksheet xmlns="${NS}"><sheetData>${data}</sheetData></worksheet>`)), result = await convert(bytes, 3);
  assert.deepEqual(result.emptyRows, [4]); assert.deepEqual(result.ignoredLeadingRows, { count: 2, nonemptyRows: [1] });
  assert.deepEqual(result.rowMap, [{ csvRow: 2, worksheetRow: 5 }]); assert.equal(parseFinanceCsv(result.csv)[0].amount, '0.0001');
});
test('inspect samples explicitly shorten display only and preserve full conversion text', async () => {
  const text = '🕊'.repeat(200), bytes = await pack(parts(`<worksheet xmlns="${NS}"><sheetData>${headers}${row(2, ['A', 'Sample', '', 'detail', '1', text])}</sheetData></worksheet>`));
  const result = await inspect(bytes, 1); workbookInspectResultSchema.parse(result);
  assert.equal([...result.samples[1].cells[5].value].length, 128); assert.equal(result.samples[1].cells[5].shortened, true);
  assert.ok((await convert(bytes)).csv.includes(text));
});
test('non-text numeric/date/boolean/error and formula cached values cannot be imported', async () => {
  for (const changed of ['<c r="E2"><v>9007199254740993</v></c>', '<c r="E2" t="n"><v>45100.5</v></c>', '<c r="E2" t="d"><v>2026-01-01</v></c>', '<c r="E2" t="b"><v>1</v></c>', '<c r="E2" t="e"><v>#REF!</v></c>', '<c r="E2"><f>WEBSERVICE("http://example.invalid")</f><v>1</v></c>', '<c r="E2"><f t="shared" si="0"/><v>1</v></c>']) {
    const s = parts(); s['xl/worksheets/sheet1.xml'] = s['xl/worksheets/sheet1.xml'].replace(cell('E2', '-2.5000'), changed);
    await reject(await pack(s), ['non_text_cell', 'unsupported_feature']);
  }
});
test('every sheet is preflighted and hidden selected sheets are unavailable', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Data'); sheet.addRow([...financeColumns]); sheet.addRow(['A', 'Sample', '', 'detail', '1', '']);
  const hidden = book.addWorksheet('Private calculation', { state: 'hidden' }); hidden.getCell('A1').value = { formula: '1+1', result: 2 };
  await reject(new Uint8Array(await book.xlsx.writeBuffer()), ['unsupported_feature']);
  hidden.getCell('A1').value = 'text'; const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  assert.equal((await convert(bytes)).ignoredSheets[0].state, 'hidden');
  await assert.rejects(inspect(bytes, 2), (e: any) => e.code === 'invalid_input');
});
test('hidden populated rows/columns, merge, filtering, hyperlinks and rich text reject', async () => {
  for (const change of [
    (s: string) => s.replace('<row r="2">', '<row r="2" hidden="1">'),
    (s: string) => s.replace('<sheetData>', '<cols><col min="1" max="1" hidden="1"/></cols><sheetData>'),
    (s: string) => s.replace('</worksheet>', '<mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>'),
    (s: string) => s.replace('</worksheet>', '<autoFilter ref="A1:F2"/></worksheet>'),
    (s: string) => s.replace('</worksheet>', '<hyperlinks><hyperlink ref="A2"/></hyperlinks></worksheet>'),
    (s: string) => s.replace(cell('A2', '001'), '<c r="A2" t="inlineStr"><is><r><t>001</t></r></is></c>'),
  ]) { const p = parts(); p['xl/worksheets/sheet1.xml'] = change(p['xl/worksheets/sheet1.xml']); await reject(await pack(p)); }
});
test('text OOXML escape variants and control/entity forms reject instead of silently recasting', async () => {
  for (const value of ['_x0041_', '_X0041_', '_x005F_x0041_', '\r', '\x7f']) {
    const p = parts(); p['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="${NS}"><sheetData>${headers}${row(2, ['A', 'Sample', '', 'detail', '1', value])}</sheetData></worksheet>`; await reject(await pack(p), ['unsupported_feature']);
  }
  const p = parts(); p['xl/worksheets/sheet1.xml'] = p['xl/worksheets/sheet1.xml'].replace('001</t>', '&#95;x0041_</t>'); await reject(await pack(p), ['unsupported_feature']);
});
test('DOCTYPE, processing instructions, namespace forgery, malformed UTF-8 and deep XML reject', async () => {
  for (const transform of [
    (s: string) => '<!DOCTYPE worksheet [<!ENTITY leak SYSTEM "file:///must-not-open">]>' + s,
    (s: string) => '<?fetch href="http://example.invalid"?>' + s,
    (s: string) => s.replace(NS, 'https://invalid.example/namespace'),
    (s: string) => s.replace('</worksheet>', '<a>'.repeat(40) + '</a>'.repeat(40) + '</worksheet>'),
    (s: string) => s.replace('<row r="2">', '<row r="2" r="2">'),
  ]) { const p = parts(); p['xl/worksheets/sheet1.xml'] = transform(p['xl/worksheets/sheet1.xml']); await reject(await pack(p)); }
  const z = new JSZip(); for (const [n, v] of Object.entries(parts())) z.file(n, n.endsWith('sheet1.xml') ? Buffer.from([0xc0, 0xaf]) : v, { createFolders: false });
  await reject(await z.generateAsync({ type: 'nodebuffer' }));
});
test('shared strings/styles and duplicate/sparse coordinate bounds are checked before library load', async () => {
  for (const transform of [
    (s: string) => s.replace(cell('A2', '001'), '<c r="A2" t="s"><v>20001</v></c>'),
    (s: string) => s.replace(cell('A2', '001'), '<c r="A2" s="1001" t="str"><v>text</v></c>'),
    (s: string) => s.replace(cell('A2', '001'), cell('A2', '001') + cell('A2', 'twice')),
    (s: string) => s.replace(cell('A2', '001'), cell('XFD2', 'value')),
    (s: string) => s.replace('<row r="2">', '<row r="1048576">'),
  ]) { const p = parts(); p['xl/worksheets/sheet1.xml'] = transform(p['xl/worksheets/sheet1.xml']); await reject(await pack(p)); }
});
test('package whitelist rejects macros, media, unknown parts, external relationships and unsafe target paths', async () => {
  for (const name of ['xl/vbaProject.bin', 'xl/media/image1.png', 'xl/externalLinks/externalLink1.xml', 'xl/worksheets/_rels/sheet1.xml.rels']) {
    const p = parts(); p[name] = 'untrusted'; await reject(await pack(p), ['unsupported_feature']);
  }
  for (const target of ['../worksheets/sheet1.xml', 'https://example.invalid/workbook', '/xl/worksheets/sheet1.xml', 'worksheets/%2e%2e/sheet1.xml']) {
    const p = parts(); p['xl/_rels/workbook.xml.rels'] = p['xl/_rels/workbook.xml.rels'].replace('worksheets/sheet1.xml', target); await reject(await pack(p));
  }
  const p = parts(); p['xl/_rels/workbook.xml.rels'] = p['xl/_rels/workbook.xml.rels'].replace('Target=', 'TargetMode="External" Target='); await reject(await pack(p), ['unsupported_feature']);
});
test('ordinary DEFLATE and signed data descriptors are verified', async () => {
  for (const descriptor of [false, true]) assert.equal((await convert(await pack(parts(), true, descriptor))).rowCount, 1);
  assert.equal(workbookCrc32(Buffer.from('123456789')), 0xcbf43926);
});
test('corrupt data descriptors and truncated local/central archives reject', async () => {
  const original = await pack(parts(), true, true), first = central(original)[0];
  const start = first.local + 30 + original.readUInt16LE(first.local + 26) + original.readUInt16LE(first.local + 28);
  const descriptor = start + original.readUInt32LE(first.at + 20);
  assert.equal(original.readUInt32LE(descriptor), 0x08074b50);
  for (const offset of [4, 8, 12]) {
    const bytes = Buffer.from(original); bytes.writeUInt32LE(original.readUInt32LE(descriptor + offset) ^ 1, descriptor + offset); await reject(bytes);
  }
  for (const end of [21, start + 1, first.at + 20, original.length - 1]) await reject(original.subarray(0, end));
});
test('only exact inert ExcelJS style extensions are allowed', async () => {
  const generated = await createFinanceImportTemplate(), zip = await JSZip.loadAsync(generated.bytes);
  const styles = await zip.file('xl/styles.xml')!.async('string');
  assert.ok(styles.includes('defaultSlicerStyle="SlicerStyleLight1"'));
  for (const mutation of [
    styles.replace('defaultSlicerStyle="SlicerStyleLight1"', 'defaultSlicerStyle="Other"'),
    styles.replace('defaultSlicerStyle="SlicerStyleLight1"', 'defaultSlicerStyle="SlicerStyleLight1" unexpected="1"'),
    styles.replace('TimeSlicerStyleLight1', '_x0041_'),
  ]) {
    const changed = await JSZip.loadAsync(generated.bytes); changed.file('xl/styles.xml', mutation);
    await reject(await changed.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), ['unsupported_feature']);
  }
});
test('directory/local disagreement, CRC corruption, encryption, overlap and appended bytes reject', async () => {
  const original = await pack(); const c = central(original);
  const variants = [
    (b: Buffer) => b.writeUInt16LE(1, c[0].at + 8),
    (b: Buffer) => b.writeUInt32LE(0, c[1].at + 42),
    (b: Buffer) => b.writeUInt32LE(1, c[0].at + 16),
    (b: Buffer) => b.writeUInt32LE(0xffffffff, c[0].at + 24),
    (b: Buffer) => b.writeUInt16LE(99, c[0].at + 10),
    (b: Buffer) => { b[c[0].local + 30] ^= 1; return 0; },
  ];
  for (const mutate of variants) { const b = Buffer.from(original); mutate(b); await reject(b); }
  await reject(Buffer.concat([original, Buffer.from('extra')])); await reject(Buffer.concat([Buffer.from('prefix'), original]));
});
test('duplicate normalized ZIP names and traversal are never sanitized into an accepted archive', async () => {
  const p = parts(); p['XL/workbook.xml'] = p['xl/workbook.xml']; await reject(await pack(p));
  const q = parts(); q['../xl/workbook.xml'] = q['xl/workbook.xml']; await reject(await pack(q));
});
test('actual inflater is bounded even when directory and local size falsely promise a tiny result', async () => {
  const p = parts(); p['docProps/app.xml'] = 'A'.repeat(2 * 1024 * 1024);
  const b = await pack(p, true), c = central(b).find(c => c.name === 'docProps/app.xml')!;
  b.writeUInt32LE(1, c.at + 24); b.writeUInt32LE(1, c.local + 22);
  await reject(b, ['limit']);
});
test('upload/entry/XML-token/string/data-row/output limits reject without truncation', async () => {
  await reject(new Uint8Array(262145), ['limit']);
  const many: Record<string, string> = {}; for (let i = 0; i < 129; i++) many['x' + i] = ''; await reject(await pack(many), ['limit']);
  const p = parts(); p['docProps/app.xml'] = '<x>' + 'a'.repeat(65538) + '</x>'; await reject(await pack(p), ['limit']);
  const tooLong = parts(`<worksheet xmlns="${NS}"><sheetData>${headers}${row(2, ['A', 'Sample', '', 'detail', '1', 'x'.repeat(8193)])}</sheetData></worksheet>`); await reject(await pack(tooLong), ['limit']);
  const book = new ExcelJS.Workbook(), s = book.addWorksheet('Data'); s.addRow([...financeColumns]);
  for (let i = 0; i < 501; i++) s.addRow([String(i), 'Sample', '', 'detail', '1', '']);
  await assert.rejects(convert(new Uint8Array(await book.xlsx.writeBuffer())), (e: any) => e.code === 'limit');
});
test('wrong/duplicate/extra headers and data columns fail and hash mismatch never converts', async () => {
  for (const transform of [
    (s: string) => s.replace('lineCode</t>', 'wrong</t>'),
    (s: string) => s.replace('lineCode</t>', 'lineLabel</t>'),
    (s: string) => s.replace('</row>', cell('G1', 'extra') + '</row>'),
    (s: string) => s.replace('</sheetData>', '<row r="3">' + cell('G3', 'hidden data') + '</row></sheetData>'),
  ]) { const p = parts(); p['xl/worksheets/sheet1.xml'] = transform(p['xl/worksheets/sheet1.xml']); await assert.rejects(convert(await pack(p)), (e: any) => e.code === 'header_mismatch'); }
  const bytes = await pack(); await assert.rejects(parseImportWorkbook({ ...base, action: 'convert', bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: '0'.repeat(64) }), (e: any) => e.code === 'source_changed');
});
test('all-sheet cells and XML values remain finite; invented options cannot relax limits', async () => {
  const bytes = await pack(); await assert.rejects(parseImportWorkbook({ ...base, action: 'inspect', bytes, maxBytes: Infinity }), (e: any) => e.code === 'invalid_input');
  await assert.rejects(parseImportWorkbook({ ...base, action: 'convert', bytes, sheetId: 1, headerRow: 0, expectedWorkbookHash: sha(bytes) }), (e: any) => e.code === 'invalid_input');
  assert.ok(readImportWorkbookZip(bytes).has('xl/worksheets/sheet1.xml'));
});
test('huge workbook IDs and dimension hints cannot create sparse ExcelJS allocations', async () => {
  const p = parts(); p['xl/workbook.xml'] = p['xl/workbook.xml'].replace('sheetId="1"', 'sheetId="2147483647"'); await reject(await pack(p), ['limit']);
  const q = parts(); q['xl/worksheets/sheet1.xml'] = q['xl/worksheets/sheet1.xml'].replace('<sheetData>', '<dimension ref="A1:BL2001"/><sheetData>'); await reject(await pack(q), ['limit']);
});
test('500 rows succeed while bounded inspection can succeed before conversion rejects oversized CSV', async () => {
  const book = new ExcelJS.Workbook(), s = book.addWorksheet('Data'); s.addRow([...financeColumns]);
  for (let i = 0; i < 500; i++) s.addRow([String(i), 'Sample', '', 'detail', '1', '']);
  assert.equal((await convert(new Uint8Array(await book.xlsx.writeBuffer()))).rowCount, 500);
  for (let i = 0; i < 500; i++) s.getCell(i + 2, 6).value = Array.from({ length: 8 }, (_, j) => sha(`${i}:${j}`)).join('');
  const bytes = new Uint8Array(await book.xlsx.writeBuffer()); assert.ok(bytes.length < 262144);
  assert.equal((await inspect(bytes)).sheets[0].populatedCells, 2506);
  await assert.rejects(convert(bytes), (e: any) => e.code === 'limit');
});
test('empty styled cells still count against whole-workbook cell budget', async () => {
  const cells: string[] = [];
  for (let r = 1; r <= 313; r++) {
    const cols = Array.from({ length: 64 }, (_, i) => { let n = i + 1, name = ''; while (n) { n--; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26); } return `<c r="${name}${r}"/>`; });
    cells.push(`<row r="${r}">${cols.join('')}</row>`);
  }
  await reject(await pack(parts(`<worksheet xmlns="${NS}"><sheetData>${cells.join('')}</sheetData></worksheet>`), true), ['limit']);
});
test('repeated shared strings have a separate whole-workbook projected-text budget before ExcelJS', async () => {
  async function repeated(count: number) {
    const references = Array.from({ length: count }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>0</v></c></row>`).join('');
    const p = parts(`<worksheet xmlns="${NS}"><sheetData>${headers}${references}</sheetData></worksheet>`);
    p['xl/sharedStrings.xml'] = `<sst xmlns="${NS}" count="${count}" uniqueCount="1"><si><t>${'x'.repeat(8192)}</t></si></sst>`;
    p['[Content_Types].xml'] = p['[Content_Types].xml'].replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
    p['xl/_rels/workbook.xml.rels'] = p['xl/_rels/workbook.xml.rels'].replace('</Relationships>', `<Relationship Id="rId2" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
    const bytes = await pack(p); assert.ok(bytes.length < 32768); return bytes;
  }
  assert.equal((await inspect(await repeated(255))).sheets[0].populatedCells, 261);
  await reject(await repeated(257), ['limit']);
});
async function worker(task: unknown) {
  const w = new Worker(new URL('../server/import-workbook-worker.mjs', import.meta.url), { workerData: task, env: {}, execArgv: [], stdout: true, stderr: true });
  let diagnostics = ''; w.stdout!.on('data', c => diagnostics += c); w.stderr!.on('data', c => diagnostics += c);
  const timeout = setTimeout(() => { void w.terminate(); }, 10000);
  try { return await new Promise<any>((resolve, reject) => { w.once('message', result => { assert.equal(diagnostics, ''); resolve(result); }); w.once('error', reject); w.once('exit', () => reject(Error('worker exited without a result'))); }); }
  finally { clearTimeout(timeout); await w.terminate(); }
}
test('fixed worker runs template/inspect/convert under plain Node with empty environment and arguments', async () => {
  const template = await worker({ ...base, action: 'template' }); assert.equal(template.ok, true); assert.ok(template.result.bytes instanceof Uint8Array);
  const seen = await worker({ ...base, action: 'inspect', bytes: template.result.bytes }); assert.equal(seen.ok, true); workbookInspectResultSchema.parse(seen.result);
  const bytes = await pack(), actual = await worker({ ...base, action: 'convert', bytes, sheetId: 1, headerRow: 1, expectedWorkbookHash: sha(bytes) });
  assert.equal(actual.ok, true); workbookConvertResultSchema.parse(actual.result);
});
test('worker redacts untrusted failure content instead of exposing stacks or input', async () => {
  const secret = 'Synthetic-marker-not-a-real-secret', result = await worker({ ...base, action: 'inspect', bytes: Buffer.from(secret) });
  assert.deepEqual(result, { ok: false, code: 'invalid_container', cells: [] }); assert.ok(!JSON.stringify(result).includes(secret));
});
