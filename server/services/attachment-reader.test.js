import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttachmentReader, createBoundedCache, runAttachmentJob } from './attachment-reader.js';
import { makePdf, makeXlsx } from './attachment-fixtures.test-support.js';

function fakeFetcher(files) {
  const calls = [];
  return {
    calls,
    async fetchBytes(messageId, index) {
      calls.push([messageId, index]);
      const file = files[`${messageId}:${index}`];
      if (!file) throw new Error('missing');
      return file;
    },
  };
}

test('read_attachment pages through a PDF in a real worker and reuses the parsed text', async () => {
  const pages = Array.from({ length: 6 }, (_v, i) => [`Section ${i + 1}`, ...Array.from({ length: 30 }, () => 'x'.repeat(40))]);
  const fetcher = fakeFetcher({ 'm1:0': { body: makePdf(pages), filename: 'q.pdf', contentType: 'application/pdf' } });
  const reader = createAttachmentReader({ fetchBytes: fetcher.fetchBytes });

  const first = (await reader.readText({ messageId: 'm1', index: 0, maxChars: 2000 })).attachment;
  assert.equal(first.kind, 'pdf');
  assert.equal(first.pageCount, 6);
  assert.equal(first.offset, 0);
  assert.equal(first.returnedChars, 2000);
  assert.equal(first.firstPage, 1);
  assert.equal(first.lastPage, 2);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 2000);
  assert.match(first.text, /^\[Page 1 of 6\]\nSection 1\n/);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);

  let offset = first.nextOffset;
  let text = first.text;
  while (offset !== null) {
    const next = (await reader.readText({ messageId: 'm1', index: 0, offset, maxChars: 2000 })).attachment;
    text += next.text;
    offset = next.nextOffset;
  }
  assert.equal(text.length, first.totalChars);
  for (let i = 1; i <= 6; i += 1) assert.equal(text.includes(`[Page ${i} of 6]\nSection ${i}`), true);

  const jump = (await reader.readText({ messageId: 'm1', index: 0, page: 5, maxChars: 1000 })).attachment;
  assert.match(jump.text, /^\[Page 5 of 6\]\nSection 5/);
  assert.equal(jump.firstPage, 5);

  assert.deepEqual(fetcher.calls, [['m1', 0]], 'one IMAP fetch for the whole read');

  await assert.rejects(reader.readText({ messageId: 'm1', index: 0, page: 7 }), (error) => error.code === 'VALIDATION_ERROR');
  await assert.rejects(reader.readText({ messageId: 'm1', index: 0, page: 1, offset: 5 }), /offset or page/);
  await assert.rejects(reader.readText({ messageId: 'm1', index: 0, maxChars: 50 }), (error) => error.code === 'VALIDATION_ERROR');
  const past = (await reader.readText({ messageId: 'm1', index: 0, offset: 10_000_000 })).attachment;
  assert.equal(past.returnedChars, 0);
  assert.equal(past.nextOffset, null);
});

test('spreadsheets page by sheet', async () => {
  const fetcher = fakeFetcher({
    'm2:1': {
      body: makeXlsx([{ name: 'Parts', rows: [['SKU', 'Qty'], ['BQ-500N', 1]] }, { name: 'Freight', rows: [['LTL', 326]] }]),
      filename: 'parts.xlsx',
      contentType: 'application/octet-stream',
    },
  });
  const reader = createAttachmentReader({ fetchBytes: fetcher.fetchBytes });
  const sheet2 = (await reader.readText({ messageId: 'm2', index: 1, page: 2 })).attachment;
  assert.equal(sheet2.kind, 'xlsx');
  assert.equal(sheet2.pageCount, 2);
  assert.equal(sheet2.text, '[Sheet 2 of 2: Freight]\nLTL\t326');
  assert.match(sheet2.note, /tab-separated/);
});

test('concurrent readers share one fetch and one parse; jobs run at most maxConcurrent at a time', async () => {
  let active = 0;
  let peak = 0;
  const jobs = [];
  const runJob = async (job) => {
    jobs.push(job.op);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { kind: 'text', text: `text of ${job.filename}` };
  };
  const files = {};
  for (let i = 0; i < 5; i += 1) files[`m:${i}`] = { body: Buffer.from(`file ${i}`), filename: `f${i}.txt`, contentType: 'text/plain' };
  const fetcher = fakeFetcher(files);
  const reader = createAttachmentReader({ fetchBytes: fetcher.fetchBytes, runJob, maxConcurrent: 2 });
  const results = await Promise.all([
    reader.readText({ messageId: 'm', index: 0 }),
    reader.readText({ messageId: 'm', index: 0 }),
    ...[1, 2, 3, 4].map((index) => reader.readText({ messageId: 'm', index })),
  ]);
  assert.equal(results[0].attachment.text, 'text of f0.txt');
  assert.equal(results[1].attachment.text, 'text of f0.txt');
  assert.equal(fetcher.calls.length, 5);
  assert.equal(jobs.length, 5);
  assert.equal(peak, 2);
});

test('fetch and parse failures are not cached', async () => {
  let fail = true;
  const reader = createAttachmentReader({
    fetchBytes: async () => {
      if (fail) throw Object.assign(new Error('Could not retrieve this attachment.'), { code: 'ATTACHMENT_UNAVAILABLE' });
      return { body: Buffer.from('ok now'), filename: 'a.txt', contentType: 'text/plain' };
    },
  });
  await assert.rejects(reader.readText({ messageId: 'm', index: 0 }), /Could not retrieve/);
  fail = false;
  assert.equal((await reader.readText({ messageId: 'm', index: 0 })).attachment.text, 'ok now');
});

test('the worker is killed when a job runs too long, and unknown errors stay generic', async () => {
  const slow = makePdf(Array.from({ length: 200 }, (_v, i) => [`Page ${i}`]));
  await assert.rejects(
    runAttachmentJob({ op: 'text', bytes: slow, contentType: 'application/pdf', filename: 'slow.pdf' }, { timeoutMs: 1 }),
    (error) => error.code === 'ATTACHMENT_READ_TIMEOUT' && error.status === 503,
  );
  await assert.rejects(
    runAttachmentJob({ op: 'nope', bytes: Buffer.from('x') }),
    (error) => error.code === 'ATTACHMENT_UNREADABLE' && error.message === 'aMail could not read this attachment.',
  );
  const caller = Buffer.from('hello world');
  const result = await runAttachmentJob({ op: 'text', bytes: caller, contentType: 'text/plain', filename: 'a.txt' });
  assert.equal(result.text, 'hello world');
  assert.equal(caller.toString(), 'hello world', 'the caller\'s buffer is not detached');
});

test('renderPicture refuses pages on non-PDF files and passes PDF pages through', async () => {
  const seen = [];
  const reader = createAttachmentReader({
    fetchBytes: async (messageId) => (messageId === 'pdf'
      ? { body: makePdf([['a'], ['b']]), filename: 'a.pdf', contentType: 'application/pdf' }
      : { body: Buffer.from('\x89PNG\r\n\x1a\nxxxx', 'latin1'), filename: 'a.png', contentType: 'image/png' }),
    runJob: async (job) => {
      seen.push([job.op, job.page ?? null, job.maxDimension]);
      return { mimeType: 'image/png', data: Buffer.from('img'), width: 10, height: 20, pageCount: job.page ? 2 : undefined };
    },
  });
  const pdf = await reader.renderPicture({ messageId: 'pdf', index: 0, page: 2, maxDimension: 900 });
  assert.equal(pdf.summary.page, 2);
  assert.equal(pdf.summary.pageCount, 2);
  assert.equal(pdf.image.data.toString(), 'img');
  const png = await reader.renderPicture({ messageId: 'png', index: 0 });
  assert.equal(png.summary.page, undefined);
  await assert.rejects(reader.renderPicture({ messageId: 'png', index: 0, page: 2 }), /Only PDF/);
  await assert.rejects(reader.renderPicture({ messageId: 'pdf', index: 0, maxDimension: 99999 }), (error) => error.code === 'VALIDATION_ERROR');
  assert.deepEqual(seen, [['render-pdf', 2, 900], ['render-image', null, 1600]]);
});

test('bounded cache expires, evicts oldest first and skips oversize values', () => {
  let now = 0;
  const cache = createBoundedCache({ maxEntries: 2, maxWeight: 10, ttlMs: 100, weigh: (value) => value.length, now: () => now });
  cache.set('a', 'aaaa');
  cache.set('b', 'bbbb');
  assert.equal(cache.get('a'), 'aaaa');
  cache.set('c', 'cccc');
  assert.equal(cache.get('b'), undefined, 'b was least recently used');
  assert.equal(cache.get('a'), 'aaaa');
  cache.set('huge', 'x'.repeat(11));
  assert.equal(cache.get('huge'), undefined);
  now = 200;
  assert.equal(cache.get('a'), undefined);
});
