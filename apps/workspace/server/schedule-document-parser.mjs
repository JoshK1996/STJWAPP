import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { SaxesParser } from 'saxes';
import { readImportWorkbookZip } from './import-workbook-zip.mjs';

const fail = message => { throw Error(message); };
const check = (condition, message = 'The document contains unsupported or malformed content.') => { if (!condition) fail(message); };
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const MAX_BYTES = 2 * 1024 * 1024;
function xml(bytes, visit = {}) {
  const value = text(bytes); check(value.length <= 4 * 1024 * 1024);
  let depth = 0, nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', () => fail('Malformed document XML.'));
  parser.on('doctype', () => fail('Document type definitions are not supported.'));
  parser.on('processinginstruction', () => fail('Document processing instructions are not supported.'));
  parser.on('opentag', node => { check(++depth <= 64 && ++nodes <= 100000 && Object.keys(node.attributes).length <= 64, 'Document XML exceeds the supported complexity.'); visit.open?.(node); });
  parser.on('closetag', node => { visit.close?.(node); depth--; });
  parser.on('text', value => visit.text?.(value));
  parser.on('cdata', value => visit.text?.(value));
  parser.write(value).close();
}
function admitted(bytes, format) {
  const entries = readImportWorkbookZip(bytes, MAX_BYTES);
  check(entries.has('[Content_Types].xml') && entries.has(format === 'xlsx' ? 'xl/workbook.xml' : 'word/document.xml'), 'Choose an ordinary XLSX or DOCX file.');
  for (const [path, value] of entries) {
    check(!/vbaProject|embeddings\/|activeX\/|externalLinks\//i.test(path), 'Macros, embedded objects and external workbook links are not supported.');
    if (/\.(xml|rels)$/.test(path)) xml(value, { open(node) {
      if (node.local === 'Relationship') check(!Object.values(node.attributes).some(a => a.local === 'TargetMode' && a.value === 'External'), 'External document links are not supported. Save a copy without linked content.');
      if (format === 'xlsx') check(node.local !== 'f', 'Formulas are not imported. Paste the displayed values into a copy first.');
    } });
  }
  return entries;
}
function rowCollector() {
  let cells = 0, rows = 0, chars = 0;
  return (values, row) => {
    check(++rows <= 2000 && values.length <= 64, 'Use a smaller document: at most 2,000 rows and 64 columns.');
    cells += values.length; check(cells <= 20000, 'Use a smaller document: at most 20,000 cells.');
    const clean = values.map(value => { const result = String(value ?? '').replaceAll('\u0000', ''); chars += result.length; check(result.length <= 8192 && chars <= 1000000, 'The extracted text is too large.'); return result; });
    return { row, cells: clean };
  };
}
async function xlsx(bytes, add, warnings) {
  admitted(bytes, 'xlsx');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(bytes));
  check(workbook.worksheets.length <= 8, 'Use a workbook with no more than 8 worksheets.');
  const sheets = []; let dateCells = false;
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== 'visible') { warnings.push(`Hidden worksheet omitted: ${sheet.name.slice(0, 100)}.`); continue; }
    check(sheet.rowCount <= 2000 && sheet.columnCount <= 64, 'The worksheet exceeds 2,000 rows or 64 columns.');
    const rows = [];
    sheet.eachRow((row, number) => {
      const values = [];
      for (let column = 1; column <= row.cellCount; column++) {
        const cell = row.getCell(column), value = cell.value;
        if (value == null) values.push('');
        else if (value instanceof Date) { check(Number.isFinite(value.getTime())); dateCells = true; values.push(value.getUTCFullYear() < 1905 ? value.toISOString().slice(11, 19) : value.toISOString().slice(0, 19)); }
        else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
        else if (Array.isArray(value.richText)) values.push(value.richText.map(run => run.text).join(''));
        else fail('Formulas, error cells and linked cells are not imported. Paste their displayed values into a copy first.');
      }
      if (values.some(value => value.trim())) rows.push(add(values, number));
    });
    sheets.push({ id: sheet.id, name: sheet.name, rows });
  }
  if (dateCells) warnings.push('Excel date/time cells have no time zone. Review the displayed dates and confirm the organization time zone.');
  warnings.push('Only visible worksheet cell values are read. Images, charts, comments and formatting are not schedule data.');
  return sheets;
}
function docx(bytes, add, warnings) {
  const entries = admitted(bytes, 'docx'), rows = []; let inText = 0, tableDepth = 0, paragraph = '', cell = '', cells = [], ignored = 0, inCell = false;
  const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  xml(entries.get('word/document.xml'), {
    open(node) {
      if (node.uri !== WORD) return;
      if (node.local === 'del' || node.local === 'moveFrom') ignored++;
      if (node.local === 'tbl') { tableDepth++; check(tableDepth <= 1, 'Nested Word tables are not supported. Copy the desired table into a separate document.'); }
      if (node.local === 'tr') cells = [];
      if (node.local === 'tc') { inCell = true; cell = ''; }
      if (node.local === 'p') paragraph = '';
      if (node.local === 't') inText++;
      if (!ignored && ['tab', 'br', 'cr'].includes(node.local)) paragraph += node.local === 'tab' ? '\t' : ' ';
    },
    text(value) { if (inText && !ignored) paragraph += value; },
    close(node) {
      if (node.uri !== WORD) return;
      if (node.local === 't') inText--;
      if (node.local === 'p') { if (inCell) cell += (cell ? ' ' : '') + paragraph; else if (paragraph.trim()) rows.push(add(paragraph.split('\t'), rows.length + 1)); }
      if (node.local === 'tc') { cells.push(cell); inCell = false; }
      if (node.local === 'tr' && cells.some(value => value.trim())) rows.push(add(cells, rows.length + 1));
      if (node.local === 'tbl') tableDepth--;
      if (node.local === 'del' || node.local === 'moveFrom') ignored--;
    },
  });
  warnings.push('Word main-body paragraphs and tables are extracted. Headers, footers, drawings, comments and deleted revisions are omitted; verify the complete schedule.');
  return [{ id: 1, name: 'Word document', rows }];
}
async function pdf(bytes, add, warnings) {
  check(Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-', 'Choose a valid text-based PDF.');
  // Only bytes enter PDF.js. No URL, scripts, annotations, attachments or rendering is requested.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const unavailable = () => Promise.reject(Error('External PDF resources are not supported.'));
  globalThis.fetch = unavailable;
  const task = getDocument({ data: Uint8Array.from(bytes), useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, isEvalSupported: false,
    useWasm: false, enableXfa: false, stopAtErrors: true, disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0,
    CMapReaderFactory: class { fetch = unavailable; }, StandardFontDataFactory: class { fetch = unavailable; } });
  task.onPassword = () => task.destroy();
  const sheets = [];
  try {
    const doc = await task.promise; check(doc.numPages <= 20, 'Use a PDF with no more than 20 pages.');
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p), content = await page.getTextContent(), rows = []; let values = [], current = '', y = null, endX = null;
      const flush = () => { if (current.trim()) values.push(current.trim()); if (values.some(value => value.trim())) rows.push(add(values, rows.length + 1)); values = []; current = ''; endX = null; };
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const x = item.transform[4], nextY = item.transform[5];
        if (y !== null && Math.abs(nextY - y) > 3) flush();
        if (endX !== null && x - endX > Math.max(8, item.height * 0.7)) { if (current.trim()) values.push(current.trim()); current = ''; }
        current += item.str; y = nextY; endX = x + item.width;
        if (item.hasEOL) flush();
      }
      flush(); sheets.push({ id: p, name: `PDF page ${p}`, rows }); page.cleanup();
    }
  } finally { await task.destroy(); }
  warnings.push('PDF reading order and column spacing can differ from the visible page. Review every extracted row and every page; images and scanned text are not read.');
  return sheets;
}
export async function parseScheduleDocument(format, bytes) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_BYTES, 'Choose a file no larger than 2 MiB.');
  const warnings = [], add = rowCollector(); let sheets;
  if (format === 'csv') { const source = parse(text(bytes), { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 65536 }); sheets = [{ id: 1, name: 'CSV rows', rows: source.map((values, i) => add(values, i + 1)) }]; }
  else if (format === 'xlsx') sheets = await xlsx(bytes, add, warnings);
  else if (format === 'docx') sheets = docx(bytes, add, warnings);
  else if (format === 'pdf') sheets = await pdf(bytes, add, warnings);
  else fail('Choose CSV, XLSX, PDF or DOCX.');
  if (!sheets.some(sheet => sheet.rows.length)) warnings.push('No readable text was found. Scanned or image-only documents need manual rows or a text/Excel/CSV copy; OCR is not available.');
  const result = { format, sourceHash: createHash('sha256').update(bytes).digest('hex'), sheets, warnings };
  check(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES, 'The extracted document is too large.'); return result;
}
