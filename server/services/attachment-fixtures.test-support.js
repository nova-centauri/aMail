// Small, hand-built attachment files for tests: ZIP-based Office documents
// and minimal PDFs. Not loaded by production code.
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_value, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * entries: [{ name, data, method?: 0|8, declaredSize?, encrypted? }]
 * declaredSize lets a test lie about the uncompressed size (zip bombs).
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const size = entry.declaredSize ?? data.length;
    const flags = entry.encrypted ? 1 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function makeDocx(paragraphs) {
  const body = paragraphs.map((text) => (
    `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  )).join('');
  return makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` },
  ]);
}

export function makeXlsx(sheets) {
  const strings = [];
  const stringIndex = (value) => {
    let at = strings.indexOf(value);
    if (at < 0) at = strings.push(value) - 1;
    return at;
  };
  const columns = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sheetXml = sheets.map(({ rows }) => {
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
      if (value === null || value === undefined) return '';
      const ref = `${columns[c]}${r + 1}`;
      return typeof value === 'number'
        ? `<c r="${ref}"><v>${value}</v></c>`
        : `<c r="${ref}" t="s"><v>${stringIndex(value)}</v></c>`;
    }).join('')}</row>`).join('');
    return `<worksheet><sheetData>${body}</sheetData></worksheet>`;
  });
  const workbook = `<workbook xmlns:r="r"><sheets>${sheets.map((sheet, i) => (
    `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  )).join('')}</sheets></workbook>`;
  const rels = `<Relationships>${sheets.map((_sheet, i) => (
    `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )).join('')}</Relationships>`;
  const shared = `<sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
  return makeZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: shared },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ]);
}

export function makePptx(slides) {
  const presentation = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slides.map((_slide, i) => (
    `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`
  )).join('')}</p:sldIdLst></p:presentation>`;
  const rels = `<Relationships>${slides.map((_slide, i) => (
    `<Relationship Id="rId${i + 1}" Target="slides/slide${i + 1}.xml"/>`
  )).join('')}</Relationships>`;
  return makeZip([
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels },
    ...slides.map((lines, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `<p:sld xmlns:a="a" xmlns:p="p">${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:sld>`,
    })),
  ]);
}

function escapePdfText(text) {
  return String(text).replace(/[\\()]/g, (match) => `\\${match}`);
}

/**
 * A minimal valid PDF. Each page is a list of text lines in Helvetica, or
 * null for a page with no text at all (like a scan without OCR).
 */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesRef = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const stream = lines
      ? `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join(' ')} ET`
      : '0.5 g 72 72 300 300 re f';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`;
  objects[pagesRef - 1] = `<< /Type /Pages /Kids [${kids.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
