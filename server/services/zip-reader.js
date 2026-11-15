import { inflateRawSync } from 'node:zlib';

/*
 * Just enough of the ZIP format to read the XML parts of Office files
 * (DOCX, XLSX, PPTX) that arrive as email attachments. The input is
 * untrusted, so every size is bounded before any work is done:
 *
 * - Only stored (0) and deflate (8) entries; anything else is skipped.
 * - The central directory is the source of truth. Entry counts, names and
 *   offsets are range-checked against the buffer.
 * - Each entry inflates with maxOutputLength set to its declared size (and to
 *   maxEntryBytes), and the running total is capped by maxTotalBytes, so a zip
 *   bomb fails fast instead of filling memory.
 * - Encrypted entries are refused.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('Not a ZIP archive.');
}

/**
 * List entries without inflating anything.
 * @returns {{ name: string, method: number, compressedSize: number, size: number, localOffset: number, encrypted: boolean }[]}
 */
export function listZipEntries(buffer, { maxEntries = 5000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) throw new ZipError('Not a ZIP archive.');
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (count > maxEntries) throw new ZipError('ZIP archive has too many entries.');
  if (directoryOffset + directorySize > eocd) throw new ZipError('ZIP central directory is out of range.');

  const entries = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('ZIP central directory is damaged.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > eocd) throw new ZipError('ZIP central directory is damaged.');
    entries.push({
      name: buffer.toString('utf8', cursor + 46, nameEnd),
      method,
      compressedSize,
      size,
      localOffset,
      encrypted: Boolean(flags & 0x1),
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/**
 * Read the named entries (exact names) as Buffers. Missing names are left out
 * of the result. Throws ZipError when a limit is crossed.
 */
export function readZipEntries(buffer, names, { maxEntryBytes = 16 * 1024 * 1024, maxTotalBytes = 48 * 1024 * 1024 } = {}) {
  const wanted = new Set(names);
  const out = new Map();
  let total = 0;
  for (const entry of listZipEntries(buffer)) {
    if (!wanted.has(entry.name) || out.has(entry.name)) continue;
    if (entry.encrypted) throw new ZipError('Encrypted ZIP entries are not supported.');
    if (entry.size > maxEntryBytes) throw new ZipError('A ZIP entry is too large to read.');
    if (total + entry.size > maxTotalBytes) throw new ZipError('ZIP content is too large to read.');
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new ZipError('ZIP entry header is damaged.');
    }
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw new ZipError('ZIP entry is out of range.');
    const raw = buffer.subarray(dataStart, dataEnd);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.size, maxEntryBytes)) });
      } catch {
        throw new ZipError('A ZIP entry could not be decompressed.');
      }
    } else {
      continue;
    }
    if (data.length !== entry.size) throw new ZipError('A ZIP entry size does not match its header.');
    total += data.length;
    out.set(entry.name, data);
  }
  return out;
}
