import path from 'node:path';
import { createRequire } from 'node:module';
import { load as loadHtml } from 'cheerio';
import { listZipEntries, readZipEntries, ZipError } from './zip-reader.js';

/*
 * Turn attachment bytes into text (and PDF pages into pictures) so an agent
 * can read a file instead of receiving megabytes of base64.
 *
 * Everything here treats the bytes as hostile. It runs inside a worker thread
 * with a memory limit and a timeout (attachment-reader.js); this module adds
 * input-shape limits on top. Nothing here writes to disk, executes content,
 * follows links or touches the network: PDF.js gets the bytes in memory with
 * eval disabled and local font/cmap/wasm folders.
 */

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_PDF_PAGES_FOR_TEXT = 500;
export const DEFAULT_RENDER_MAX_DIMENSION = 1600;
export const MAX_RENDER_MAX_DIMENSION = 2400;
// Keep rendered pictures comfortably inside model image limits.
const MAX_RENDER_OUTPUT_BYTES = 3.5 * 1024 * 1024;
const MAX_RENDER_PIXELS = 12_000_000;
export const MAX_TEXT_CHARS = 5_000_000;
// Largest picture we will decode, in pixels. Decoded bitmaps live in native
// memory that the worker's V8 heap limit does not cover, so the size is
// checked from the file header before anything is decoded (25 MP is about
// 100 MB as RGBA).
export const MAX_DECODE_PIXELS = 25_000_000;

const require = createRequire(import.meta.url);

const EXTENSION_KINDS = new Map([
  ['pdf', 'pdf'],
  ['txt', 'text'], ['text', 'text'], ['log', 'text'], ['md', 'text'], ['markdown', 'text'],
  ['csv', 'text'], ['tsv', 'text'], ['json', 'text'], ['xml', 'text'], ['yaml', 'text'],
  ['yml', 'text'], ['ics', 'text'], ['vcf', 'text'], ['rtf', 'text'],
  ['html', 'html'], ['htm', 'html'],
  ['docx', 'docx'], ['xlsx', 'xlsx'], ['pptx', 'pptx'],
  ['eml', 'eml'],
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['gif', 'image'], ['webp', 'image'],
]);

const TYPE_KINDS = new Map([
  ['application/pdf', 'pdf'],
  ['application/x-pdf', 'pdf'],
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['message/rfc822', 'eml'],
  ['application/json', 'text'],
  ['application/xml', 'text'],
  ['application/rtf', 'text'],
  ['text/rtf', 'text'],
  ['application/csv', 'text'],
  ['text/calendar', 'text'],
]);

export class ExtractError extends Error {
  constructor(message, code = 'ATTACHMENT_UNREADABLE') {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

function baseType(contentType) {
  return String(contentType || '').split(';', 1)[0].trim().toLowerCase();
}

function extensionOf(filename) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(String(filename || '').trim());
  return match ? match[1].toLowerCase() : '';
}

function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Width and height from an image's own header, without decoding it.
 * Returns null when the header cannot be read.
 */
export function imageDimensions(bytes, type = sniffImage(bytes)) {
  try {
    if (type === 'image/png') {
      if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (type === 'image/gif') {
      if (bytes.length < 10) return null;
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (type === 'image/webp') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8X' && bytes.length >= 30) {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
      if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ' && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    if (type === 'image/jpeg') {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker === 0xff) { at += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) return null;
        const length = bytes.readUInt16BE(at + 2);
        // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
        if (length < 2) return null;
        at += 2 + length;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function officeKindFromZip(bytes) {
  try {
    const names = new Set(listZipEntries(bytes).map((entry) => entry.name));
    if (names.has('word/document.xml')) return 'docx';
    if (names.has('xl/workbook.xml')) return 'xlsx';
    if (names.has('ppt/presentation.xml')) return 'pptx';
  } catch {
    // Not a readable zip; fall through.
  }
  return null;
}

/**
 * Decide how to read a file. Magic bytes win over the declared type and the
 * file name, since both come from the sender.
 * @returns {'pdf'|'text'|'html'|'docx'|'xlsx'|'pptx'|'eml'|'image'|'unsupported'}
 */
export function detectKind({ bytes, contentType, filename }) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0);
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (sniffImage(buffer)) return 'image';
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return officeKindFromZip(buffer) || 'unsupported';
  }
  const type = baseType(contentType);
  const ext = extensionOf(filename);
  const declared = TYPE_KINDS.get(type) || EXTENSION_KINDS.get(ext)
    || (type.startsWith('text/') ? 'text' : null);
  if (!declared || declared === 'pdf' || declared === 'image' || ['docx', 'xlsx', 'pptx'].includes(declared)) {
    // Declared as a binary format, but the magic bytes did not match.
    return looksLikeText(buffer) && declared !== 'image' ? 'text' : 'unsupported';
  }
  return declared;
}

function looksLikeText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length < 0.02;
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType || ''));
  return match ? match[1].toLowerCase() : null;
}

export function decodeText(bytes, contentType) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const declared = charsetOf(contentType);
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // Unknown label: fall through to detection.
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const replacements = (utf8.match(/�/g) || []).length;
  if (replacements > 0 && replacements / Math.max(1, utf8.length) > 0.001) {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

const BLOCK_TAGS = 'p,div,br,li,tr,h1,h2,h3,h4,h5,h6,section,article,header,footer,table,blockquote,pre,hr';

export function htmlToText(html) {
  const $ = loadHtml(String(html || ''));
  $('script,style,noscript,template,head,iframe,object,svg').remove();
  $(BLOCK_TAGS).each((_index, element) => {
    $(element).before('\n');
    $(element).after('\n');
  });
  $('td,th').each((_index, element) => {
    $(element).after('\t');
  });
  return tidy($.root().text().replace(/\u00a0/g, ' '));
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Paragraph text from WordprocessingML or DrawingML, in document order. */
function officeXmlToText(xml, { paragraph, run, tab = null, lineBreak = null }) {
  const tags = new RegExp(`<(/?)(${[paragraph, run, tab, lineBreak].filter(Boolean).join('|')})(?:\\s[^>]*)?/?>`, 'g');
  let out = '';
  let inRun = false;
  let runStart = 0;
  for (let match = tags.exec(xml); match; match = tags.exec(xml)) {
    const [whole, closing, name] = match;
    const selfClosing = whole.endsWith('/>');
    if (name === run) {
      if (!closing && !selfClosing) {
        inRun = true;
        runStart = match.index + whole.length;
      } else if (closing && inRun) {
        out += decodeXmlEntities(xml.slice(runStart, match.index));
        inRun = false;
      }
    } else if (name === paragraph && closing) {
      out += '\n';
    } else if (name === tab && !closing) {
      out += '\t';
    } else if (name === lineBreak && !closing) {
      out += '\n';
    }
  }
  return out;
}

function zipParts(bytes, names) {
  try {
    return readZipEntries(bytes, names);
  } catch (error) {
    if (error instanceof ZipError) throw new ExtractError(`This Office file could not be opened: ${error.message}`);
    throw error;
  }
}

export function extractDocx(bytes) {
  const parts = zipParts(bytes, ['word/document.xml']);
  const xml = parts.get('word/document.xml');
  if (!xml) throw new ExtractError('This Word file has no document body.');
  return { text: tidy(officeXmlToText(xml.toString('utf8'), { paragraph: 'w:p', run: 'w:t', tab: 'w:tab', lineBreak: 'w:br' })) };
}

function relationshipTargets(xml) {
  const targets = new Map();
  for (const match of String(xml || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) targets.set(id, decodeXmlEntities(target));
  }
  return targets;
}

function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
}

export function extractPptx(bytes) {
  const index = zipParts(bytes, ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
  const presentation = index.get('ppt/presentation.xml')?.toString('utf8') || '';
  const rels = relationshipTargets(index.get('ppt/_rels/presentation.xml.rels')?.toString('utf8'));
  const slidePaths = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((match) => rels.get(match[1]))
    .filter(Boolean)
    .map((target) => resolvePart('ppt/presentation.xml', target))
    .slice(0, MAX_PDF_PAGES_FOR_TEXT);
  const slides = zipParts(bytes, slidePaths);
  const pages = slidePaths.map((name) => tidy(officeXmlToText(slides.get(name)?.toString('utf8') || '', {
    paragraph: 'a:p', run: 'a:t', lineBreak: 'a:br',
  })));
  return { pages, pageLabel: 'Slide' };
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref || ''))?.[1] || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value - 1;
}

function sharedStrings(xml) {
  const strings = [];
  for (const item of String(xml || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const run of item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXmlEntities(run[1]);
    strings.push(text);
  }
  return strings;
}

function sheetToRows(xml, strings) {
  const rows = [];
  for (const row of String(xml || '').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1])).join('');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
      else value = decodeXmlEntities(raw ?? '');
      const at = ref ? columnIndex(ref) : cells.length;
      if (at >= 0 && at < 16384) cells[at] = value.replace(/[\t\r\n]+/g, ' ');
    }
    rows.push(Array.from(cells, (value) => value ?? '').join('\t'));
  }
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.join('\n');
}

export function extractXlsx(bytes) {
  const index = zipParts(bytes, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']);
  const workbook = index.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = relationshipTargets(index.get('xl/_rels/workbook.xml.rels')?.toString('utf8'));
  const strings = sharedStrings(index.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((match) => ({
    name: decodeXmlEntities(/\bname="([^"]*)"/.exec(match[1])?.[1] || ''),
    path: rels.get(/\br:id="([^"]+)"/.exec(match[1])?.[1] || ''),
  })).filter((sheet) => sheet.path).map((sheet) => ({ ...sheet, path: resolvePart('xl/workbook.xml', sheet.path) }))
    .slice(0, 200);
  const parts = zipParts(bytes, sheets.map((sheet) => sheet.path));
  const pages = sheets.map((sheet) => sheetToRows(parts.get(sheet.path)?.toString('utf8'), strings));
  return {
    pages,
    pageLabel: 'Sheet',
    pageNames: sheets.map((sheet) => sheet.name),
    note: 'Cells are tab-separated, one row per line. Dates and times appear as Excel serial numbers.',
  };
}

export async function extractEml(bytes) {
  const { simpleParser } = await import('mailparser');
  const parsed = await simpleParser(bytes, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const header = [
    parsed.from?.text && `From: ${parsed.from.text}`,
    parsed.to?.text && `To: ${parsed.to.text}`,
    parsed.cc?.text && `Cc: ${parsed.cc.text}`,
    parsed.date && `Date: ${parsed.date.toISOString()}`,
    parsed.subject && `Subject: ${parsed.subject}`,
  ].filter(Boolean).join('\n');
  const body = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
  const files = (parsed.attachments || []).map((item) => `- ${item.filename || 'attachment'} (${item.contentType}, ${item.size} bytes)`);
  return {
    text: tidy([header, body, files.length ? `Attached inside this email:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n')),
    note: files.length ? 'Files inside a forwarded email are listed by name only.' : undefined,
  };
}

let pdfjsPromise = null;

function pdfjsAssets() {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`,
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
    wasmUrl: `${path.join(root, 'wasm')}${path.sep}`,
    iccUrl: `${path.join(root, 'iccs')}${path.sep}`,
  };
}

async function openPdf(bytes) {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({
    // PDF.js may transfer/detach the array it is given, so pass a copy.
    data: new Uint8Array(bytes),
    ...pdfjsAssets(),
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    // Skip embedded images larger than this instead of decoding them.
    maxImageSize: MAX_DECODE_PIXELS,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    return await task.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') throw new ExtractError('This PDF is password protected.', 'ATTACHMENT_ENCRYPTED');
    throw new ExtractError('This PDF could not be opened.');
  }
}

async function closePdf(doc) {
  try {
    await (doc.loadingTask?.destroy?.() ?? doc.destroy?.());
  } catch {
    // Best effort; the worker exits after the job anyway.
  }
}

function pageText(items) {
  let out = '';
  let lastY = null;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && out && !out.endsWith('\n')) out += '\n';
    out += item.str;
    if (item.hasEOL && !out.endsWith('\n')) out += '\n';
    if (y !== null) lastY = y;
  }
  return tidy(out);
}

export async function extractPdf(bytes) {
  const doc = await openPdf(bytes);
  try {
    const pageCount = doc.numPages;
    const readable = Math.min(pageCount, MAX_PDF_PAGES_FOR_TEXT);
    const pages = [];
    let total = 0;
    for (let number = 1; number <= readable; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      page.cleanup();
      pages.push(text);
      total += text.length;
      if (total > MAX_TEXT_CHARS) break;
    }
    const textChars = pages.reduce((sum, text) => sum + text.replace(/\s/g, '').length, 0);
    const noTextLayer = textChars < 20 * pages.length;
    return {
      pages,
      pageLabel: 'Page',
      pageCount,
      noTextLayer,
      incomplete: pages.length < pageCount || undefined,
      note: [
        noTextLayer ? 'This PDF has little or no text layer (it may be a scan). Use view_attachment with a page number to see the page as an image.' : null,
        pages.length < pageCount ? `Only the first ${pages.length} of ${pageCount} pages were read as text. Use view_attachment for later pages, or get_attachment_link to download the whole file.` : null,
      ].filter(Boolean).join(' ') || undefined,
    };
  } finally {
    await closePdf(doc);
  }
}

/**
 * Text for any supported kind.
 * @returns {Promise<{ kind: string, text?: string, pages?: string[], pageLabel?: string, pageNames?: string[], pageCount?: number, noTextLayer?: boolean, note?: string }>}
 */
export async function extractText(input) {
  return capExtract(await extractAnyText(input));
}

const TRUNCATED_NOTE = `Only the first ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters of this file were read as text. Use get_attachment_link to download the whole file.`;

/** Keep extracted text within MAX_TEXT_CHARS and say so when anything is cut. */
function capExtract(extract) {
  let cut = false;
  if (typeof extract.text === 'string' && extract.text.length > MAX_TEXT_CHARS) {
    extract.text = extract.text.slice(0, MAX_TEXT_CHARS);
    cut = true;
  }
  if (Array.isArray(extract.pages)) {
    let left = MAX_TEXT_CHARS;
    const kept = [];
    for (const pageText of extract.pages) {
      if (left <= 0) { cut = true; break; }
      if (pageText.length > left) {
        kept.push(pageText.slice(0, left));
        left = 0;
        cut = true;
      } else {
        kept.push(pageText);
        left -= pageText.length;
      }
    }
    extract.pages = kept;
  }
  if (!cut) return extract;
  return {
    ...extract,
    incomplete: true,
    note: [extract.note, TRUNCATED_NOTE].filter(Boolean).join(' '),
  };
}

async function extractAnyText({ bytes, contentType, filename }) {
  const kind = detectKind({ bytes, contentType, filename });
  switch (kind) {
    case 'pdf': return { kind, ...(await extractPdf(bytes)) };
    case 'docx': return { kind, ...extractDocx(bytes) };
    case 'xlsx': return { kind, ...extractXlsx(bytes) };
    case 'pptx': return { kind, ...extractPptx(bytes) };
    case 'eml': return { kind, ...(await extractEml(bytes)) };
    case 'html': return { kind, text: htmlToText(decodeText(bytes, contentType)) };
    case 'text': return { kind, text: tidy(decodeText(bytes, contentType)) };
    case 'image':
      return { kind, text: '', note: 'This attachment is a picture. Use view_attachment to see it.' };
    default:
      throw new ExtractError('aMail cannot read this file type as text. Use get_attachment_link to download it.', 'ATTACHMENT_TYPE_UNSUPPORTED');
  }
}

/** Join extracted pages into one string with page markers, keeping where each page starts. */
export function flattenExtract(extract) {
  if (!Array.isArray(extract.pages)) return { text: extract.text || '', pageStarts: [] };
  const label = extract.pageLabel || 'Page';
  const total = extract.pageCount || extract.pages.length;
  let text = '';
  const pageStarts = [];
  extract.pages.forEach((pageText, i) => {
    if (i) text += '\n\n';
    pageStarts.push(text.length);
    const name = extract.pageNames?.[i] ? `: ${extract.pageNames[i]}` : '';
    text += `[${label} ${i + 1} of ${total}${name}]\n${pageText}`;
  });
  return { text, pageStarts };
}

let canvasModule;

async function loadCanvas() {
  if (canvasModule === undefined) {
    try {
      canvasModule = await import('@napi-rs/canvas');
    } catch {
      canvasModule = null;
    }
  }
  if (!canvasModule) {
    throw new ExtractError('Picture rendering is not available on this aMail server.', 'ATTACHMENT_RENDER_UNAVAILABLE');
  }
  return canvasModule;
}

function encodeCanvas(canvas) {
  const png = canvas.toBuffer('image/png');
  if (png.length <= 1.5 * 1024 * 1024) return { mimeType: 'image/png', data: png };
  for (const quality of [85, 70, 55]) {
    const jpeg = canvas.toBuffer('image/jpeg', quality);
    if (jpeg.length <= MAX_RENDER_OUTPUT_BYTES) return { mimeType: 'image/jpeg', data: jpeg };
  }
  throw new ExtractError('The rendered picture is too large to return.', 'ATTACHMENT_RENDER_TOO_LARGE');
}

function fitScale(width, height, maxDimension) {
  const longest = Math.max(width, height, 1);
  let scale = maxDimension / longest;
  if (width * scale * height * scale > MAX_RENDER_PIXELS) scale = Math.sqrt(MAX_RENDER_PIXELS / (width * height));
  return scale;
}

export async function renderPdfPage(bytes, pageNumber, { maxDimension = DEFAULT_RENDER_MAX_DIMENSION } = {}) {
  await loadCanvas();
  const doc = await openPdf(bytes);
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
      throw new ExtractError(`Page ${pageNumber} does not exist; this PDF has ${doc.numPages} page(s).`, 'ATTACHMENT_PAGE_OUT_OF_RANGE');
    }
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: fitScale(base.width, base.height, maxDimension) });
    const { canvas, context } = doc.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    // A white page, so transparent PDFs do not render as black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const encoded = encodeCanvas(canvas);
    page.cleanup();
    return { ...encoded, width: canvas.width, height: canvas.height, pageCount: doc.numPages };
  } finally {
    await closePdf(doc);
  }
}

export async function renderImage(bytes, { maxDimension = DEFAULT_RENDER_MAX_DIMENSION } = {}) {
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new ExtractError('This picture format cannot be shown.', 'ATTACHMENT_TYPE_UNSUPPORTED');
  // Check the size from the header first: decoding a small file that claims
  // huge dimensions would allocate the whole bitmap outside the heap limit.
  const size = imageDimensions(bytes, sniffed);
  if (!size || !size.width || !size.height) throw new ExtractError('This picture could not be decoded.');
  if (size.width * size.height > MAX_DECODE_PIXELS) {
    throw new ExtractError(
      `This picture is ${size.width}×${size.height} pixels, too large to show. Use get_attachment_link to download it.`,
      'ATTACHMENT_TOO_LARGE',
    );
  }
  let canvasLib;
  try {
    canvasLib = await loadCanvas();
  } catch (error) {
    // No canvas: hand back the original when it is small enough to be safe.
    if (bytes.length <= MAX_RENDER_OUTPUT_BYTES) return { mimeType: sniffed, data: bytes, width: null, height: null };
    throw error;
  }
  let image;
  try {
    image = await canvasLib.loadImage(bytes);
  } catch {
    throw new ExtractError('This picture could not be decoded.');
  }
  if (image.width <= maxDimension && image.height <= maxDimension && bytes.length <= 1.5 * 1024 * 1024 && sniffed !== 'image/gif') {
    return { mimeType: sniffed, data: bytes, width: image.width, height: image.height };
  }
  const scale = Math.min(1, fitScale(image.width, image.height, maxDimension));
  const canvas = canvasLib.createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { ...encodeCanvas(canvas), width: canvas.width, height: canvas.height };
}
