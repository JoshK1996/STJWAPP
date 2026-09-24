import { inflateRawSync } from 'node:zlib';

export const importWorkbookLimits = Object.freeze({
  uploadBytes: 256 * 1024, entries: 128, entryBytes: 4 * 1024 * 1024, inflatedBytes: 16 * 1024 * 1024,
  expansionRatio: 100, sheets: 8, sheetId: 1024, cells: 20000, rows: 2000, columns: 64, strings: 20000,
  stringBytes: 8192, textBytes: 2 * 1024 * 1024, projectedTextBytes: 2 * 1024 * 1024, styles: 1000, depth: 32, attributes: 32,
  csvBytes: 200000, inspectBytes: 128 * 1024, resultBytes: 512 * 1024, errors: 20,
});
export class ImportWorkbookError extends Error {
  constructor(code, cells = []) { super(code); this.code = code; this.cells = cells.slice(0, importWorkbookLimits.errors); }
}
export function check(condition, code = 'invalid_container') { if (!condition) throw new ImportWorkbookError(code); }
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
export function workbookCrc32(bytes) {
  let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function extras(bytes) {
  for (let p = 0; p < bytes.length;) {
    check(p + 4 <= bytes.length); const id = bytes.readUInt16LE(p), size = bytes.readUInt16LE(p + 2);
    check(p + 4 + size <= bytes.length); check(![1, 0x7075].includes(id), 'unsupported_feature'); p += 4 + size;
  }
}
/** Minimal, bounded ZIP envelope. No extraction, URLs, filesystem or unbounded inflater. */
export function readImportWorkbookZip(raw) {
  const L = importWorkbookLimits;
  check(raw instanceof Uint8Array && raw.byteLength >= 22); check(raw.byteLength <= L.uploadBytes, 'limit');
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  }
  check(end >= 0); check(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 'unsupported_feature');
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16);
  check(count !== 65535 && directorySize !== 0xffffffff && directory !== 0xffffffff, 'unsupported_feature');
  check(count > 0 && count <= L.entries, 'limit'); check(bytes.readUInt16LE(end + 8) === count);
  check(directory + directorySize === end && directory > 0);
  const entries = [], names = new Set(); let at = directory, declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    check(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50);
    const needed = bytes.readUInt16LE(at + 6), flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10),
      crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24),
      nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32),
      offset = bytes.readUInt32LE(at + 42), attributes = bytes.readUInt32LE(at + 38);
    check(at + 46 + nameLength + extraLength + commentLength <= end && nameLength > 0 && nameLength <= 200);
    check(needed <= 20 && (flags & ~0x080e) === 0 && [0, 8].includes(method), 'unsupported_feature');
    check(bytes.readUInt16LE(at + 34) === 0 && ((attributes >>> 16) & 0xf000) !== 0xa000, 'unsupported_feature');
    check(compressed !== 0xffffffff && size !== 0xffffffff && offset !== 0xffffffff, 'unsupported_feature');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    check([...nameBytes].every(b => b >= 0x20 && b <= 0x7e));
    const name = nameBytes.toString('ascii');
    check(/^[A-Za-z0-9_[\]./-]+$/.test(name) && !name.startsWith('/') && !name.includes('//') && !name.split('/').some(v => v === '.' || v === '..'));
    check(!names.has(name.toLowerCase())); names.add(name.toLowerCase());
    extras(bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    check(size <= L.entryBytes && (size === 0 || compressed > 0 && size <= compressed * L.expansionRatio), 'limit');
    declaredTotal += size; check(declaredTotal <= L.inflatedBytes, 'limit');
    if (name.endsWith('/')) check(size === 0);
    entries.push({ name, nameBytes, flags, needed, method, crc, compressed, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  check(at === end); entries.sort((a, b) => a.offset - b.offset);
  let next = 0, actualTotal = 0; const result = new Map();
  for (const e of entries) {
    const p = e.offset; check(p === next && p + 30 <= directory && bytes.readUInt32LE(p) === 0x04034b50);
    check(bytes.readUInt16LE(p + 4) === e.needed && bytes.readUInt16LE(p + 6) === e.flags && bytes.readUInt16LE(p + 8) === e.method);
    const localCrc = bytes.readUInt32LE(p + 14), localCompressed = bytes.readUInt32LE(p + 18), localSize = bytes.readUInt32LE(p + 22),
      nameLength = bytes.readUInt16LE(p + 26), extraLength = bytes.readUInt16LE(p + 28), start = p + 30 + nameLength + extraLength;
    check(start <= directory && e.compressed <= directory - start);
    check(bytes.subarray(p + 30, p + 30 + nameLength).equals(e.nameBytes));
    extras(bytes.subarray(p + 30 + nameLength, start));
    const descriptor = (e.flags & 8) !== 0;
    check(descriptor ? [0, e.crc].includes(localCrc) && [0, e.compressed].includes(localCompressed) && [0, e.size].includes(localSize)
      : localCrc === e.crc && localCompressed === e.compressed && localSize === e.size);
    next = start + e.compressed;
    if (descriptor) {
      check(next + 12 <= directory);
      if (bytes.readUInt32LE(next) === 0x08074b50) next += 4;
      check(next + 12 <= directory && bytes.readUInt32LE(next) === e.crc && bytes.readUInt32LE(next + 4) === e.compressed && bytes.readUInt32LE(next + 8) === e.size);
      next += 12;
    }
    const source = bytes.subarray(start, start + e.compressed); let output;
    if (e.method === 0) { check(e.compressed === e.size); output = source; }
    else {
      try {
        const inflated = inflateRawSync(source, { maxOutputLength: Math.min(e.size + 1, L.entryBytes + 1), info: true });
        check(inflated.engine.bytesWritten === source.length); output = inflated.buffer;
      } catch (error) { if (error instanceof ImportWorkbookError) throw error; throw new ImportWorkbookError(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'limit' : 'invalid_container'); }
    }
    check(output.length === e.size && workbookCrc32(output) === e.crc);
    actualTotal += output.length; check(actualTotal <= L.inflatedBytes, 'limit');
    result.set(e.name, output);
  }
  check(next === directory); return result;
}
