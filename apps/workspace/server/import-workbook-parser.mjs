import ExcelJS from 'exceljs';
import { SaxesParser } from 'saxes';
import { createHash } from 'node:crypto';
import { readImportWorkbookZip, importWorkbookLimits as L, ImportWorkbookError, check } from './import-workbook-zip.mjs';

export { importWorkbookLimits, ImportWorkbookError } from './import-workbook-zip.mjs';
export const financeWorkbookColumns = Object.freeze(['lineCode', 'lineLabel', 'group', 'rowKind', 'amount', 'note']);
// Fixed destinations only. Keep these worker-safe values aligned with the
// shared application catalogs; callers can never supply their own columns.
export const workbookImportColumns = Object.freeze({
  finance: financeWorkbookColumns,
  staff: Object.freeze(['name', 'email', 'role', 'unitIds', 'jobIds']),
  grade_scores: Object.freeze(['assignmentId', 'bookVersion', 'assignmentVersion', 'studentId', 'studentName', 'status', 'points', 'note']),
  compensation_rates: Object.freeze(['userId', 'jobId', 'recordVersion', 'rateId', 'startsOn', 'endsOn', 'amount', 'currency', 'basis', 'voided', 'note']),
  school_students: Object.freeze(['studentNumber', 'name', 'dateOfBirth']),
  school_enrollments: Object.freeze(['studentNumber', 'gradeLevel', 'startsOn', 'endsOn', 'status']),
  school_roster: Object.freeze(['studentNumber', 'startsOn', 'endsOn']),
  school_households: Object.freeze(['householdId', 'version', 'name', 'address', 'archived']),
  school_household_members: Object.freeze(['householdId', 'householdVersion', 'personId', 'personVersion', 'role', 'remove']),
  school_contacts: Object.freeze(['studentId', 'studentNumber', 'studentVersion', 'personId', 'personVersion', 'contactVersion', 'relationship', 'isGuardian', 'canCommunicate', 'canPickup', 'pickupUntilAction', 'pickupUntil', 'emergencyPriority', 'restrictionNoteAction', 'restrictionNote']),
});
const workbookSheetNames = Object.freeze({ finance: 'Financial data', staff: 'New staff', grade_scores: 'Assignment scores', compensation_rates: 'Employee pay rates', school_students: 'New students', school_enrollments: 'School-year enrollment', school_roster: 'Class roster', school_households: 'Households', school_household_members: 'Household membership', school_contacts: 'Student contacts' });
function columnsFor(kind) { check(typeof kind === 'string' && Object.hasOwn(workbookImportColumns, kind), 'invalid_input'); return workbookImportColumns[kind]; }
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, cell) => { throw new ImportWorkbookError(code, cell ? [cell] : []); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, required, optional = []) {
  check(plain(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'invalid_input');
}
function integer(value, max = 2147483647) { return Number.isSafeInteger(value) && value >= 1 && value <= max; }
function number(text, max = 2147483647, zero = true) {
  check(typeof text === 'string' && /^(0|[1-9]\d*)$/.test(text)); const n = Number(text);
  check(Number.isSafeInteger(n) && (zero || n > 0)); check(n <= max, 'limit'); return n;
}
function exactText(text) {
  check(!/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|_x[0-9a-f]{4}_/i.test(text), 'unsupported_feature');
  check(Buffer.byteLength(text, 'utf8') <= L.stringBytes, 'limit'); return text;
}
function attr(node, name, uri = '') { return node.attrs.find(a => a.local === name && a.uri === uri)?.value; }
function child(node, name) { const values = node.children.filter(x => x.local === name); check(values.length <= 1); return values[0]; }
const walk = function* (node) { yield node; for (const item of node.children) yield* walk(item); };
const valueOf = node => { check(node && node.children.length === 0); return exactText(node.text); };

/** Saxes sees only bounded UTF-8 input. No entity/doctype resolver is installed. */
function xml(bytes, budget) {
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid_container'); }
  check(!text.includes('\r'), 'unsupported_feature');
  // Lexical allocation ceiling, not XML parsing: bound every span between '>'
  // before SAX can accumulate a giant unfinished tag, comment or text token.
  let last = 0; for (let i = 0; i < text.length; i++) { check(i - last <= 65536, 'limit'); if (text[i] === '>') last = i; }
  const parser = new SaxesParser({ xmlns: true, fragment: false }), stack = []; let root;
  parser.on('error', () => fail('invalid_container'));
  parser.on('doctype', () => fail('unsupported_feature'));
  parser.on('processinginstruction', () => fail('unsupported_feature'));
  parser.on('cdata', () => fail('unsupported_feature'));
  parser.on('xmldecl', data => check(data.version === '1.0' && (!data.encoding || /^utf-8$/i.test(data.encoding)), 'unsupported_feature'));
  parser.on('opentag', data => {
    check(++budget.nodes <= 100000 && stack.length < L.depth, 'limit');
    const attrs = Object.values(data.attributes); check(attrs.length <= L.attributes, 'limit');
    for (const a of attrs) { exactText(a.value); budget.text += Buffer.byteLength(a.value); }
    check(budget.text <= L.textBytes, 'limit');
    const node = { local: data.local, uri: data.uri, attrs, children: [], text: '' };
    if (stack.length) stack.at(-1).children.push(node); else { check(!root); root = node; } stack.push(node);
  });
  parser.on('text', part => {
    budget.text += Buffer.byteLength(part); check(budget.text <= L.textBytes, 'limit');
    if (stack.length) { const node = stack.at(-1); node.text += part; check(Buffer.byteLength(node.text) <= 65536, 'limit'); }
    else check(part.trim() === '');
  });
  parser.on('closetag', () => stack.pop());
  try { for (let i = 0; i < text.length; i += 1024) parser.write(text.slice(i, i + 1024)); parser.close(); }
  catch (error) { if (error instanceof ImportWorkbookError) throw error; fail('invalid_container'); }
  check(root && !stack.length); return root;
}
const allowedPart = name => ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/theme/theme1.xml'].includes(name) || /^xl\/worksheets\/sheet[1-9]\d*\.xml$/.test(name);
const expectedType = name => name === 'xl/workbook.xml' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  : /^xl\/worksheets\//.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
    : name === 'xl/styles.xml' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
      : name === 'xl/sharedStrings.xml' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'
        : name === 'xl/theme/theme1.xml' ? 'application/vnd.openxmlformats-officedocument.theme+xml'
          : name === 'docProps/core.xml' ? 'application/vnd.openxmlformats-package.core-properties+xml'
            : name === 'docProps/app.xml' ? 'application/vnd.openxmlformats-officedocument.extended-properties+xml' : null;
function packageTypes(node, parts) {
  check(node.local === 'Types' && node.uri === TYPES); const overrides = new Map(), defaults = new Map();
  for (const c of node.children) {
    check(c.uri === TYPES && c.children.length === 0);
    if (c.local === 'Default') {
      const ext = attr(c, 'Extension'), type = attr(c, 'ContentType');
      // ExcelJS emits the unused VML default even for a plain workbook. Actual
      // VML parts are still rejected by the package entry allowlist.
      const allowed = { xml: 'application/xml', rels: 'application/vnd.openxmlformats-package.relationships+xml', vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing' };
      check(!defaults.has(ext) && Object.hasOwn(allowed, ext) && type === allowed[ext], 'unsupported_feature'); defaults.set(ext, type);
    } else {
      check(c.local === 'Override'); const path = attr(c, 'PartName'), type = attr(c, 'ContentType');
      check(path?.startsWith('/') && parts.has(path.slice(1)) && expectedType(path.slice(1)) === type && !overrides.has(path), 'unsupported_feature'); overrides.set(path, type);
    }
  }
  for (const name of parts.keys()) if (expectedType(name)) check(overrides.get('/' + name) === expectedType(name));
  check(defaults.get('rels') === 'application/vnd.openxmlformats-package.relationships+xml');
}
function relationships(node, base, parts) {
  check(node.local === 'Relationships' && node.uri === PKG); const result = new Map();
  for (const c of node.children) {
    check(c.local === 'Relationship' && c.uri === PKG && c.children.length === 0);
    const id = attr(c, 'Id'), target = attr(c, 'Target'), type = attr(c, 'Type'), mode = attr(c, 'TargetMode');
    check(id && id.length <= 100 && !result.has(id));
    check(!mode || mode === 'Internal', 'unsupported_feature');
    check(target && /^[A-Za-z0-9_./-]+$/.test(target) && !target.startsWith('/') && !target.split('/').some(v => v === '.' || v === '..' || !v), 'unsupported_feature');
    const path = base + target; check(parts.has(path) && allowedPart(path), 'unsupported_feature');
    const expected = path === 'xl/workbook.xml' ? REL + '/officeDocument' : path === 'docProps/core.xml' ? PKG + '/metadata/core-properties'
      : path === 'docProps/app.xml' ? REL + '/extended-properties' : /^xl\/worksheets\//.test(path) ? REL + '/worksheet'
        : path === 'xl/styles.xml' ? REL + '/styles' : path === 'xl/sharedStrings.xml' ? REL + '/sharedStrings' : path === 'xl/theme/theme1.xml' ? REL + '/theme' : '';
    check(expected && type === expected && (base === '' ? ['xl/workbook.xml', 'docProps/core.xml', 'docProps/app.xml'].includes(path) : path.startsWith('xl/') && path !== 'xl/workbook.xml'), 'unsupported_feature');
    check(![...result.values()].some(r => r.path === path)); result.set(id, { path, type });
  }
  return result;
}
function sharedStrings(root) {
  if (!root) return []; check(root.local === 'sst' && root.uri === NS && root.children.length <= L.strings, 'limit');
  return root.children.map(si => { check(si.local === 'si' && si.uri === NS && si.children.length === 1, 'unsupported_feature'); const t = si.children[0]; check(t.local === 't' && t.uri === NS, 'unsupported_feature'); return valueOf(t); });
}
function styleCount(root) {
  if (!root) return 0; check(root.local === 'styleSheet' && root.uri === NS);
  for (const section of root.children) {
    if (section.local === 'extLst') {
      // ExcelJS always writes these two inert style defaults. No other extension
      // content is accepted, and slicer/timeline parts remain forbidden.
      const known = new Map([
        ['{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}', ['slicerStyles', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main', 'defaultSlicerStyle', 'SlicerStyleLight1']],
        ['{9260A510-F301-46a8-8635-F512D64BE5F5}', ['timelineStyles', 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main', 'defaultTimelineStyle', 'TimeSlicerStyleLight1']],
      ]), seen = new Set();
      check(section.uri === NS && section.children.length <= 2, 'unsupported_feature');
      for (const ext of section.children) {
        const id = attr(ext, 'uri'), rule = known.get(id), item = ext.children[0];
        check(ext.local === 'ext' && ext.uri === NS && rule && !seen.has(id) && ext.children.length === 1 && item.local === rule[0] && item.uri === rule[1]
          && ext.attrs.filter(a => a.uri !== 'http://www.w3.org/2000/xmlns/').length === 1
          && item.children.length === 0 && item.text.trim() === '' && item.attrs.length === 1 && attr(item, rule[2]) === rule[3], 'unsupported_feature'); seen.add(id);
      }
    } else for (const n of walk(section)) {
      check(n.uri === NS && n.local !== 'extLst', 'unsupported_feature');
      if (n.local === 'numFmt') number(attr(n, 'numFmtId'), 65535);
    }
  }
  for (const n of root.children) check(n.children.length <= L.styles, 'limit');
  return child(root, 'cellXfs')?.children.length ?? 0;
}
const forbidden = new Set(['f', 'mergeCells', 'hyperlinks', 'autoFilter', 'tableParts', 'drawing', 'legacyDrawing', 'picture', 'conditionalFormatting', 'dataValidations', 'extLst', 'oleObjects', 'controls']);
function coordinate(ref) {
  const match = /^([A-Z]{1,2})([1-9]\d*)$/.exec(ref ?? ''); check(match);
  let col = 0; for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  check(col <= L.columns, 'limit'); const row = number(match[2], L.rows, false); return { row, col };
}
function worksheet(root, info, strings, styles, budget) {
  check(root.local === 'worksheet' && root.uri === NS);
  for (const n of walk(root)) check(n.uri === NS && !forbidden.has(n.local), 'unsupported_feature');
  const dimension = child(root, 'dimension');
  if (dimension) { const range = (attr(dimension, 'ref') ?? '').split(':'); check(range.length <= 2); for (const ref of range) coordinate(ref); }
  const hiddenColumns = [];
  for (const col of child(root, 'cols')?.children ?? []) {
    check(col.local === 'col'); const min = number(attr(col, 'min'), L.columns, false), max = number(attr(col, 'max'), L.columns, false); check(max >= min);
    if (['1', 'true'].includes(attr(col, 'hidden'))) hiddenColumns.push([min, max]);
  }
  const data = child(root, 'sheetData'); check(data); const values = new Map(), rowIds = new Set(); let lastRow = 0, lastColumn = 0;
  for (const row of data.children) {
    check(row.local === 'row'); const r = number(attr(row, 'r'), L.rows, false); check(!rowIds.has(r)); rowIds.add(r);
    for (const c of row.children) {
      check(c.local === 'c'); check(++budget.cells <= L.cells, 'limit');
      const ref = attr(c, 'r'), location = coordinate(ref), col = location.col;
      check(location.row === r); check(!values.has(ref));
      if (attr(c, 's') !== undefined) check(number(attr(c, 's'), L.styles) < styles);
      const type = attr(c, 't'), v = child(c, 'v'), inline = child(c, 'is'); let value = '';
      const coords = { sheetId: info.sheetId, row: r, column: col };
      if (type === 's') { check(c.children.length === 1 && v); value = strings[number(valueOf(v), L.strings)]; check(value !== undefined); }
      else if (type === 'inlineStr') { check(c.children.length === 1 && inline && inline.children.length === 1); const t = inline.children[0]; check(t.local === 't'); value = valueOf(t); }
      else if (type === 'str') { check(c.children.length === 1 && v); value = valueOf(v); }
      else if ((type === undefined || type === 'n') && c.children.length === 0) value = '';
      else fail('non_text_cell', coords);
      exactText(value);
      // Count every resolved occurrence, not only a shared-string definition.
      // This is a separate whole-workbook projection budget from XML text/attrs.
      budget.projectedText += Buffer.byteLength(value, 'utf8'); check(budget.projectedText <= L.projectedTextBytes, 'limit');
      if (value !== '' && (['1', 'true'].includes(attr(row, 'hidden')) || hiddenColumns.some(([a, b]) => col >= a && col <= b))) fail('unsupported_feature', coords);
      values.set(ref, { row: r, column: col, value });
      if (value !== '') { lastRow = Math.max(lastRow, r); lastColumn = Math.max(lastColumn, col); }
    }
  }
  return { ...info, values, lastRow, lastColumn, populatedCells: [...values.values()].filter(c => c.value !== '').length };
}
function preflight(bytes) {
  const archive = readImportWorkbookZip(bytes), parts = new Map(), budget = { nodes: 0, text: 0, projectedText: 0, cells: 0 };
  for (const [name, value] of archive) {
    if (name.endsWith('/')) { check(['_rels/', 'docProps/', 'xl/', 'xl/_rels/', 'xl/worksheets/', 'xl/theme/'].includes(name), 'unsupported_feature'); continue; }
    check(allowedPart(name), 'unsupported_feature'); parts.set(name, xml(value, budget));
  }
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) check(parts.has(name));
  packageTypes(parts.get('[Content_Types].xml'), parts);
  const top = relationships(parts.get('_rels/.rels'), '', parts); check([...top.values()].filter(v => v.path === 'xl/workbook.xml').length === 1);
  const rels = relationships(parts.get('xl/_rels/workbook.xml.rels'), 'xl/', parts), book = parts.get('xl/workbook.xml');
  check(book.local === 'workbook' && book.uri === NS);
  for (const n of walk(book)) check(n.uri === NS && !['definedName', 'externalReferences', 'extLst'].includes(n.local), 'unsupported_feature');
  const sheets = child(book, 'sheets'); check(sheets && sheets.children.length > 0 && sheets.children.length <= L.sheets, 'limit');
  const strings = sharedStrings(parts.get('xl/sharedStrings.xml')), styles = styleCount(parts.get('xl/styles.xml')), ids = new Set(), names = new Set(), paths = new Set();
  const result = sheets.children.map(s => {
    check(s.local === 'sheet'); const sheetId = number(attr(s, 'sheetId'), L.sheetId, false), name = exactText(attr(s, 'name') ?? ''), state = attr(s, 'state') ?? 'visible', rel = rels.get(attr(s, 'id', REL));
    check(name.length > 0 && name.length <= 31 && !/[\\/?*\[\]:]/.test(name) && !ids.has(sheetId) && !names.has(name.toLowerCase()));
    check(['visible', 'hidden', 'veryHidden'].includes(state) && rel?.type === REL + '/worksheet' && !paths.has(rel.path));
    ids.add(sheetId); names.add(name.toLowerCase()); paths.add(rel.path);
    return worksheet(parts.get(rel.path), { sheetId, name, state }, strings, styles, budget);
  });
  check([...parts.keys()].filter(n => /^xl\/worksheets\//.test(n)).length === paths.size);
  return result;
}

function validateTask(input) {
  const base = ['schemaVersion', 'parserVersion', 'kind', 'action'];
  check(plain(input) && input.schemaVersion === 1 && input.parserVersion === 1, 'invalid_input');
  columnsFor(input.kind);
  if (input.action === 'template') keys(input, ['grade_scores', 'compensation_rates'].includes(input.kind) ? [...base, 'rows'] : base);
  else if (input.action === 'inspect') { keys(input, [...base, 'bytes'], ['sheetId']); check(input.sheetId === undefined || integer(input.sheetId), 'invalid_input'); }
  else { check(input.action === 'convert', 'invalid_input'); keys(input, [...base, 'bytes', 'sheetId', 'headerRow', 'expectedWorkbookHash']); check(integer(input.sheetId) && integer(input.headerRow, 20) && typeof input.expectedWorkbookHash === 'string' && /^[a-f0-9]{64}$/.test(input.expectedWorkbookHash), 'invalid_input'); }
}
export async function parseImportWorkbook(input) {
  validateTask(input);
  if (input.action === 'template') return createImportWorkbookTemplate(input.kind, input.rows);
  check(input.bytes instanceof Uint8Array && input.bytes.byteLength <= L.uploadBytes, 'limit');
  const bytes = Buffer.from(input.bytes), workbookHash = hash(bytes), sheets = preflight(bytes);
  if (input.action === 'convert') check(workbookHash === input.expectedWorkbookHash, 'source_changed');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes); } catch { fail('invalid_container'); }
  check(workbook.worksheets.length === sheets.length);
  for (const sheet of sheets) {
    const parsed = workbook.getWorksheet(sheet.sheetId); check(parsed?.name === sheet.name && parsed.state === sheet.state);
    const seen = new Set();
    parsed.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      const original = sheet.values.get(cell.address); check(original && (cell.value === null ? '' : cell.value) === original.value, 'unsupported_feature'); seen.add(cell.address);
    }));
    for (const [ref, cell] of sheet.values) if (cell.value !== '') check(seen.has(ref));
  }
  const summary = sheets.map(({ values, ...info }) => info), base = { schemaVersion: 1, parserVersion: 1, workbookHash, workbookBytes: bytes.length };
  const selected = input.sheetId === undefined ? undefined : sheets.find(s => s.sheetId === input.sheetId);
  if (input.sheetId !== undefined) check(selected?.state === 'visible', 'invalid_input');
  if (input.action === 'inspect') {
    const samples = selected ? Array.from({ length: Math.min(selected.lastRow, 20) }, (_, i) => ({ row: i + 1, cells: [...selected.values.values()].filter(c => c.row === i + 1 && c.column <= 16).sort((a, b) => a.column - b.column).map(c => {
      const chars = Array.from(c.value); return { column: c.column, value: chars.slice(0, 128).join(''), shortened: chars.length > 128 };
    }) })) : [];
    const result = { ...base, sheets: summary, samples }; check(Buffer.byteLength(JSON.stringify(result)) <= L.inspectBytes, 'limit'); return result;
  }
  const columns = columnsFor(input.kind);
  const rowValues = r => Array.from({ length: columns.length }, (_, i) => selected.values.get(String.fromCharCode(65 + i) + r)?.value ?? '');
  const headers = rowValues(input.headerRow);
  const headerNames = input.kind === 'compensation_rates' ? headers.map(header => header.trim()) : headers;
  check(new Set(headerNames).size === columns.length && columns.every(k => headerNames.includes(k)), 'header_mismatch');
  if (input.kind.startsWith('school_') || input.kind === 'staff') check(columns.every((k, i) => headers[i] === k), 'header_mismatch');
  check(![...selected.values.values()].some(c => c.row >= input.headerRow && c.column > columns.length && c.value !== ''), 'header_mismatch');
  const rows = [], rowMap = [], emptyRows = [];
  for (let r = input.headerRow + 1; r <= selected.lastRow; r++) {
    const row = rowValues(r); if (row.every(v => v === '')) { emptyRows.push(r); continue; }
    check(rows.length < (['grade_scores', 'compensation_rates'].includes(input.kind) ? 200 : 500), 'limit'); rows.push(row); rowMap.push({ csvRow: rows.length + 1, worksheetRow: r });
  }
  check(rows.length > 0, 'header_mismatch');
  const record = row => row.map(v => '"' + v.replaceAll('"', '""') + '"').join(',');
  let sourceBytes = 3; const records = [];
  for (const row of [headers, ...rows]) {
    const encoded = record(row), length = Buffer.byteLength(encoded); check(length <= (input.kind === 'compensation_rates' ? 10000 : input.kind.startsWith('school_') || input.kind === 'staff' ? 4096 : 20000), 'limit');
    sourceBytes += length + (records.length ? 2 : 0); check(sourceBytes <= (input.kind === 'compensation_rates' ? 64000 : L.csvBytes), 'limit'); records.push(encoded);
  }
  const csv = '\uFEFF' + records.join('\r\n');
  const leading = [...new Set([...selected.values.values()].filter(c => c.row < input.headerRow && c.value !== '').map(c => c.row))].sort((a, b) => a - b);
  const result = { ...base, sheetId: selected.sheetId, sheetName: selected.name, headerRow: input.headerRow, headers, rowCount: rows.length, rowMap, csv, csvHash: hash(csv), csvBytes: Buffer.byteLength(csv),
    ignoredSheets: summary.filter(s => s.sheetId !== selected.sheetId).map(({ sheetId, name, state }) => ({ sheetId, name, state })),
    ignoredLeadingRows: { count: input.headerRow - 1, nonemptyRows: leading }, emptyRows };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.resultBytes, 'limit'); return result;
}
export async function createImportWorkbookTemplate(kind, suppliedRows) {
  const columns = columnsFor(kind);
  let rows = [];
  const populated = kind === 'grade_scores' || kind === 'compensation_rates';
  if (populated) {
    check(Array.isArray(suppliedRows) && suppliedRows.length >= 1 && suppliedRows.length <= 200, 'invalid_input');
    check(suppliedRows.every(row => Array.isArray(row) && row.length === columns.length && row.every(value => typeof value === 'string' && value.length <= 8192)), 'invalid_input');
    // Capture only bounded text. No caller selects headers, number formats or
    // formula objects, and no school defaults are supplied for missing scores.
    rows = suppliedRows.map(row => [...row]);
    let total = 3;
    for (const [index, row] of [columns, ...rows].entries()) {
      const size = Buffer.byteLength(row.map(value => '"' + value.replaceAll('"', '""') + '"').join(','));
      check(size <= (kind === 'compensation_rates' ? 10000 : 20000), 'limit'); total += size + (index ? 2 : 0); check(total <= (kind === 'compensation_rates' ? 64000 : L.csvBytes), 'limit');
    }
  } else check(suppliedRows === undefined, 'invalid_input');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet(workbookSheetNames[kind]);
  sheet.addRow([...columns]);
  for (const row of rows) sheet.addRow(row);
  for (let col = 1; col <= columns.length; col++) { sheet.getColumn(col).numFmt = '@'; sheet.getColumn(col).width = col === columns.length ? 40 : 22; }
  // No sample amounts or policies: all editable cells are preformatted as text.
  for (let row = 2; row <= (populated ? 201 : 501); row++) for (let col = 1; col <= columns.length; col++) sheet.getCell(row, col).numFmt = '@';
  const bytes = new Uint8Array(await book.xlsx.writeBuffer()); check(bytes.length <= L.uploadBytes, 'limit');
  const captured = preflight(bytes);
  // Prove the generated XML still contains exactly the offered text (including
  // control/line-ending behavior); silently sanitized cells cannot publish.
  if (populated) for (const [r, row] of [columns, ...rows].entries()) for (const [c, value] of row.entries())
    check((captured[0].values.get(String.fromCharCode(65 + c) + (r + 1))?.value ?? '') === value, 'unsupported_feature');
  return { bytes, hash: hash(bytes), formatVersion: 1 };
}
export async function createFinanceImportTemplate() { return createImportWorkbookTemplate('finance'); }
