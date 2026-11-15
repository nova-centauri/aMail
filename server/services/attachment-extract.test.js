import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeText,
  detectKind,
  extractText,
  flattenExtract,
  htmlToText,
  imageDimensions,
  MAX_DECODE_PIXELS,
  MAX_TEXT_CHARS,
  renderImage,
  renderPdfPage,
} from './attachment-extract.js';
import { listZipEntries, readZipEntries, ZipError } from './zip-reader.js';
import { makeDocx, makePdf, makePptx, makeXlsx, makeZip } from './attachment-fixtures.test-support.js';

test('detectKind trusts magic bytes over the sender\'s type and name', () => {
  const pdf = makePdf([['Hello']]);
  assert.equal(detectKind({ bytes: pdf, contentType: 'application/octet-stream', filename: 'scan.bin' }), 'pdf');
  assert.equal(detectKind({ bytes: makeDocx(['x']), contentType: 'application/octet-stream', filename: 'a' }), 'docx');
  assert.equal(detectKind({ bytes: makeXlsx([{ name: 'S', rows: [['a']] }]), contentType: '', filename: '' }), 'xlsx');
  assert.equal(detectKind({ bytes: makePptx([['a']]), contentType: '', filename: '' }), 'pptx');
  assert.equal(detectKind({ bytes: Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1'), contentType: 'text/plain', filename: 'a.txt' }), 'image');
  // Claims to be a PDF but is not: plain text gets read as text, binary does not.
  assert.equal(detectKind({ bytes: Buffer.from('just words'), contentType: 'application/pdf', filename: 'a.pdf' }), 'text');
  assert.equal(detectKind({ bytes: Buffer.from([0, 1, 2, 3, 0, 9]), contentType: 'application/pdf', filename: 'a.pdf' }), 'unsupported');
  assert.equal(detectKind({ bytes: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv', filename: 'x.csv' }), 'text');
  assert.equal(detectKind({ bytes: Buffer.from('<p>Hi</p>'), contentType: 'text/html', filename: 'x' }), 'html');
  assert.equal(detectKind({ bytes: Buffer.from('From: a@b\r\n\r\nhi'), contentType: 'message/rfc822', filename: '' }), 'eml');
  assert.equal(detectKind({ bytes: makeZip([{ name: 'a.txt', data: 'x' }]), contentType: 'application/zip', filename: 'a.zip' }), 'unsupported');
  assert.equal(detectKind({ bytes: Buffer.from([0, 0, 0, 0]), contentType: 'application/octet-stream', filename: 'x.bin' }), 'unsupported');
});

test('decodeText honours declared charsets, BOMs and Windows-1252 mail', () => {
  assert.equal(decodeText(Buffer.from('caf\xe9', 'latin1'), 'text/plain; charset=iso-8859-1'), 'café');
  assert.equal(decodeText(Buffer.from('café'), 'text/plain'), 'café');
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), ''), 'hi');
  assert.equal(decodeText(Buffer.from('caf\xe9 \x93quoted\x94', 'latin1'), 'text/plain'), 'café “quoted”');
  assert.equal(decodeText(Buffer.from('ok'), 'text/plain; charset=not-a-charset'), 'ok');
});

test('htmlToText drops scripts and styles and keeps block and cell breaks', () => {
  const text = htmlToText('<html><head><title>T</title><style>p{}</style></head><body><script>alert(1)</script><h1>Quote</h1><p>Line&nbsp;one</p><table><tr><td>Qty</td><td>Price</td></tr><tr><td>1</td><td>$5</td></tr></table></body></html>');
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('p{}'), false);
  assert.match(text, /Quote\n+Line one/);
  assert.match(text, /Qty\tPrice/);
  assert.match(text, /1\t\$5/);
});

test('Word, Excel and PowerPoint files read as text with sheet and slide markers', async () => {
  const docx = await extractText({ bytes: makeDocx(['Purchase order 4471', 'Ship to: Dock &amp; Gate 3']), contentType: '', filename: 'po.docx' });
  assert.equal(docx.kind, 'docx');
  assert.equal(docx.text, 'Purchase order 4471\nShip to: Dock & Gate 3');

  const xlsx = await extractText({
    bytes: makeXlsx([
      { name: 'Quote', rows: [['Item', 'Qty', 'Price'], ['Feeder', 2, 3745.5], [null, null, 'Total']] },
      { name: 'Notes &amp; terms', rows: [['Net 30']] },
    ]),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: 'q.xlsx',
  });
  assert.equal(xlsx.kind, 'xlsx');
  assert.deepEqual(xlsx.pages, ['Item\tQty\tPrice\nFeeder\t2\t3745.5\n\t\tTotal', 'Net 30']);
  assert.deepEqual(xlsx.pageNames, ['Quote', 'Notes & terms']);
  const flat = flattenExtract(xlsx);
  assert.match(flat.text, /^\[Sheet 1 of 2: Quote\]\nItem\tQty/);
  assert.equal(flat.text.slice(flat.pageStarts[1]).startsWith('[Sheet 2 of 2: Notes & terms]\nNet 30'), true);

  const pptx = await extractText({ bytes: makePptx([['Agenda', 'Pricing'], ['Thanks']]), contentType: '', filename: 'deck.pptx' });
  assert.deepEqual(pptx.pages, ['Agenda\nPricing', 'Thanks']);
  assert.equal(pptx.pageLabel, 'Slide');
});

test('a forwarded .eml reads as headers, body and a list of nested files', async () => {
  const eml = Buffer.from([
    'From: Vendor <vendor@example.test>',
    'To: buyer@example.test',
    'Subject: Your invoice',
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'Invoice attached.',
    '--b',
    'Content-Type: application/pdf; name="inv.pdf"',
    'Content-Disposition: attachment; filename="inv.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4').toString('base64'),
    '--b--',
    '',
  ].join('\r\n'));
  const result = await extractText({ bytes: eml, contentType: 'message/rfc822', filename: 'fwd.eml' });
  assert.equal(result.kind, 'eml');
  assert.match(result.text, /From: "?Vendor"? <vendor@example\.test>/);
  assert.match(result.text, /Subject: Your invoice/);
  assert.match(result.text, /Invoice attached\./);
  assert.match(result.text, /- inv\.pdf \(application\/pdf, 8 bytes\)/);
});

test('PDF text comes back per page and a scan without text is flagged', async () => {
  const pdf = await extractText({ bytes: makePdf([['Quote 84944', 'Total (USD) $1,250.00'], ['Terms: Net 30']]), contentType: 'application/pdf', filename: 'q.pdf' });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.pageCount, 2);
  assert.deepEqual(pdf.pages, ['Quote 84944\nTotal (USD) $1,250.00', 'Terms: Net 30']);
  assert.equal(pdf.noTextLayer, false);
  const flat = flattenExtract(pdf);
  assert.equal(flat.text, '[Page 1 of 2]\nQuote 84944\nTotal (USD) $1,250.00\n\n[Page 2 of 2]\nTerms: Net 30');

  const scan = await extractText({ bytes: makePdf([null, null]), contentType: 'application/pdf', filename: 'scan.pdf' });
  assert.equal(scan.noTextLayer, true);
  assert.match(scan.note, /view_attachment/);
});

test('broken files fail with a plain message, not parser internals', async () => {
  await assert.rejects(
    extractText({ bytes: Buffer.from('%PDF-1.4\nnot really a pdf'), contentType: 'application/pdf', filename: 'x.pdf' }),
    (error) => error.name === 'ExtractError' && error.message === 'This PDF could not be opened.',
  );
  await assert.rejects(
    extractText({ bytes: Buffer.from([0, 1, 2, 3, 4]), contentType: 'application/octet-stream', filename: 'x.bin' }),
    (error) => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED' && /get_attachment_link/.test(error.message),
  );
  const brokenDocx = makeZip([{ name: 'word/document.xml', data: 'x'.repeat(1000), declaredSize: 10 }]);
  await assert.rejects(
    extractText({ bytes: brokenDocx, contentType: '', filename: 'x.docx' }),
    (error) => error.name === 'ExtractError' && /could not be opened/.test(error.message),
  );
});

test('text past the extraction limit is cut with a note, never silently', async () => {
  const big = Buffer.alloc(MAX_TEXT_CHARS + 10, 'a');
  const result = await extractText({ bytes: big, contentType: 'text/plain', filename: 'big.txt' });
  assert.equal(result.text.length, MAX_TEXT_CHARS);
  assert.equal(result.incomplete, true);
  assert.match(result.note, /get_attachment_link/);
  const small = await extractText({ bytes: Buffer.from('short'), contentType: 'text/plain', filename: 'a.txt' });
  assert.equal(small.incomplete, undefined);
  assert.equal(small.note, undefined);
});

function pngHeader(width, height) {
  const ihdr = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(ihdr, 0);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write('IHDR', 12, 'latin1');
  ihdr.writeUInt32BE(width, 16);
  ihdr.writeUInt32BE(height, 20);
  return ihdr;
}

test('a picture whose header claims huge dimensions is refused before decoding', async () => {
  assert.deepEqual(imageDimensions(pngHeader(640, 480)), { width: 640, height: 480 });
  const gif = Buffer.from('GIF89a\x20\x03\x58\x02\x00\x00\x00', 'latin1');
  assert.deepEqual(imageDimensions(gif), { width: 800, height: 600 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
  assert.deepEqual(imageDimensions(jpeg), { width: 640, height: 480 });
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);

  const side = Math.ceil(Math.sqrt(MAX_DECODE_PIXELS)) + 1;
  await assert.rejects(renderImage(pngHeader(side, side)), (error) => error.code === 'ATTACHMENT_TOO_LARGE' && /get_attachment_link/.test(error.message));
  await assert.rejects(renderImage(pngHeader(0, 10)), /could not be decoded/);
});

test('zip reader refuses bombs, encryption and damaged directories', () => {
  const plain = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'stored', method: 0 }]);
  assert.deepEqual(listZipEntries(plain).map((entry) => entry.name), ['a.txt', 'b.txt']);
  const read = readZipEntries(plain, ['a.txt', 'b.txt', 'missing']);
  assert.equal(read.get('a.txt').toString(), 'hello');
  assert.equal(read.get('b.txt').toString(), 'stored');
  assert.equal(read.has('missing'), false);

  // 4 MiB of zeros compresses to a few KB; a declared size of 1 KiB must not inflate it.
  const bomb = makeZip([{ name: 'a.txt', data: Buffer.alloc(4 * 1024 * 1024), declaredSize: 1024 }]);
  assert.throws(() => readZipEntries(bomb, ['a.txt']), ZipError);
  const honestButHuge = makeZip([{ name: 'a.txt', data: Buffer.alloc(4 * 1024 * 1024) }]);
  assert.throws(() => readZipEntries(honestButHuge, ['a.txt'], { maxEntryBytes: 1024 * 1024 }), /too large/);
  assert.throws(() => readZipEntries(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }]), ['a.txt']), /Encrypted/);
  assert.throws(() => listZipEntries(Buffer.from('not a zip at all, just text padding....')), ZipError);
  const truncated = plain.subarray(0, plain.length - 30);
  assert.throws(() => listZipEntries(truncated), ZipError);
});

let canvasAvailable = true;
try {
  await import('@napi-rs/canvas');
} catch {
  canvasAvailable = false;
}

test('a PDF page renders to a picture within the size limit', { skip: !canvasAvailable && 'canvas not installed' }, async () => {
  const bytes = makePdf([['Page one'], ['Page two']]);
  const picture = await renderPdfPage(bytes, 2, { maxDimension: 800 });
  assert.equal(picture.mimeType, 'image/png');
  assert.equal(picture.pageCount, 2);
  assert.equal(Math.max(picture.width, picture.height), 800);
  assert.equal(picture.data.subarray(1, 4).toString('latin1'), 'PNG');
  await assert.rejects(renderPdfPage(bytes, 3), (error) => error.code === 'ATTACHMENT_PAGE_OUT_OF_RANGE');

  const { createCanvas } = await import('@napi-rs/canvas');
  const big = createCanvas(3000, 1000);
  big.getContext('2d').fillRect(0, 0, 10, 10);
  const resized = await renderImage(big.toBuffer('image/png'), { maxDimension: 600 });
  assert.deepEqual([resized.width, resized.height], [600, 200]);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.deepEqual(imageDimensions(createCanvas(123, 45).toBuffer(type)), { width: 123, height: 45 }, type);
  }
  const small = createCanvas(50, 40).toBuffer('image/png');
  const asIs = await renderImage(small);
  assert.equal(asIs.data, small);
  await assert.rejects(renderImage(Buffer.from('not an image')), (error) => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED');
});
