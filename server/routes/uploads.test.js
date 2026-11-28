import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import helmet from 'helmet';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { browserOriginGuard } from '../middleware/request-security.js';
import { registerMcp } from './mcp.js';
import { registerUploadRoutes } from './uploads.js';
import {
  createUploadStaging,
  MAX_WAITING_UPLOADS,
  resolveUploadReferences,
  STAGED_FILE_TTL_MS,
} from '../services/upload-staging.js';
import { parseSingleFileUpload } from '../services/multipart.js';

const TOKEN = 'synthetic-upload-token';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300_000, 0x41), Buffer.from('\n%%EOF\n')]);

function multipart(parts, boundary = '----amailtest') {
  const chunks = [];
  for (const part of parts) {
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n`
      + (part.type ? `Content-Type: ${part.type}\r\n` : '') + '\r\n'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function mcpCall(origin, name, args, token = TOKEN) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }),
  });
  const text = await response.text();
  const dataLine = text.split('\n').reverse().find((line) => line.startsWith('data: '));
  return { response, body: text ? JSON.parse(dataLine ? dataLine.slice(6) : text) : null };
}

const payload = (result) => JSON.parse(result.body.result.content[0].text);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-uploads-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 7),
    remoteTokenKey: Buffer.alloc(32, 9),
    accessToken: TOKEN,
    publicOrigin: null,
  };
  const repos = createRepositories(createDatabase(config));
  const saved = [];
  const mailService = {
    async saveDraft(input, draftId) {
      saved.push({ input, draftId });
      const attachments = (input.addAttachments || []).map((item, index) => ({
        index, filename: item.filename, contentType: item.contentType, size: Buffer.from(item.content, 'base64').length,
      }));
      return { draft: { id: draftId, attachments }, server: { saved: true } };
    },
  };
  const app = express();
  app.use(helmet());
  app.use(browserOriginGuard(config));
  app.use(express.json({ limit: '1mb' }));
  registerUploadRoutes(app);
  registerMcp(app, { config, repos, mailService, remoteContent: {} });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  config.publicOrigin = origin;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { origin, saved, app };
}

test('a browser upload through a one-time link attaches to a draft', async (t) => {
  const { origin, saved } = await setup(t);

  const tools = Object.fromEntries((await mcpCall(origin, 'tools/list')).body.result.tools.map((tool) => [tool.name, tool]));
  assert.ok(tools.create_upload_link && tools.get_upload);
  assert.match(tools.create_upload_link.description, /never put it in chat/);
  assert.equal((await mcpCall(origin, 'create_upload_link', {}, 'wrong')).response.status, 401);

  const link = payload(await mcpCall(origin, 'create_upload_link', { filename: 'Quote.pdf' }));
  assert.match(link.uploadId, /^upl_[0-9a-f]{32}$/);
  assert.ok(link.url.startsWith(`${origin}/api/upload?token=`));
  assert.equal(payload(await mcpCall(origin, 'get_upload', { uploadId: link.uploadId })).state, 'waiting');

  const page = await fetch(link.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  const html = await page.text();
  assert.match(html, /type="file" name="file"/);
  assert.doesNotMatch(html, /<script/);

  const form = multipart([{ name: 'file', filename: 'local-name.pdf', type: 'application/pdf', body: PDF }]);
  const posted = await fetch(link.url, { method: 'POST', headers: { 'Content-Type': form.contentType, Origin: origin }, body: form.body });
  assert.equal(posted.status, 201);
  const sha256 = createHash('sha256').update(PDF).digest('hex');
  assert.match(await posted.text(), new RegExp(sha256));

  // Single use: the page and a second upload are both gone.
  assert.equal((await fetch(link.url)).status, 410);
  assert.equal((await fetch(link.url, { method: 'POST', headers: { 'Content-Type': form.contentType, Origin: origin }, body: form.body })).status, 410);

  const status = payload(await mcpCall(origin, 'get_upload', { uploadId: link.uploadId }));
  assert.equal(status.state, 'uploaded');
  assert.equal(status.filename, 'Quote.pdf');
  assert.equal(status.contentType, 'application/pdf');
  assert.equal(status.size, PDF.length);
  assert.equal(status.sha256, sha256);

  const result = payload(await mcpCall(origin, 'save_draft', { draftId: 'draft-1', addAttachments: [{ uploadId: link.uploadId }] }));
  assert.equal(result.draft.attachments[0].filename, 'Quote.pdf');
  assert.equal(result.draft.attachments[0].size, PDF.length);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].input.addAttachments[0].uploadId, undefined);
  assert.ok(Buffer.from(saved[0].input.addAttachments[0].content, 'base64').equals(PDF));

  // A staged file goes to one draft only.
  assert.equal(payload(await mcpCall(origin, 'get_upload', { uploadId: link.uploadId })).state, 'unknown');
  const again = payload(await mcpCall(origin, 'save_draft', { draftId: 'draft-1', addAttachments: [{ uploadId: link.uploadId }] }));
  assert.equal(again.error.code, 'NOT_FOUND');
  assert.equal(saved.length, 1);
});

test('the upload page refuses bad tokens, cross-origin posts, fake PDFs and oversize bodies', async (t) => {
  const { origin, app } = await setup(t);
  assert.equal((await fetch(`${origin}/api/upload?token=nope`)).status, 410);
  assert.equal((await fetch(`${origin}/api/upload`)).status, 410);

  const staging = app.locals.uploadStaging;
  const form = multipart([{ name: 'file', filename: 'q.pdf', type: 'application/pdf', body: PDF }]);

  const crossSite = staging.createLink();
  const refused = await fetch(`${origin}/api/upload?token=${crossSite.token}`, {
    method: 'POST', headers: { 'Content-Type': form.contentType, Origin: 'https://evil.example' }, body: form.body,
  });
  assert.equal(refused.status, 403);
  assert.ok(staging.linkFor(crossSite.token), 'a refused cross-origin post leaves the link usable');

  const fake = staging.createLink();
  const notPdf = multipart([{ name: 'file', filename: 'q.pdf', type: 'application/pdf', body: '<html>login</html>' }]);
  const mismatch = await fetch(`${origin}/api/upload?token=${fake.token}`, {
    method: 'POST', headers: { 'Content-Type': notPdf.contentType, Origin: origin }, body: notPdf.body,
  });
  assert.equal(mismatch.status, 422);
  assert.equal(staging.status(fake.uploadId).state, 'unknown');

  const big = staging.createLink();
  const huge = multipart([{ name: 'file', filename: 'big.bin', body: Buffer.alloc(9 * 1024 * 1024) }]);
  const tooLarge = await fetch(`${origin}/api/upload?token=${big.token}`, {
    method: 'POST', headers: { 'Content-Type': huge.contentType, Origin: origin }, body: huge.body,
  });
  assert.equal(tooLarge.status, 413);
});

test('staging expires links and files, caps waiting uploads, and resolves only staged ids', () => {
  let clock = 1_000_000;
  const staging = createUploadStaging({ now: () => clock });
  const link = staging.createLink({ minutes: 5 });
  clock += 5 * 60_000;
  assert.equal(staging.linkFor(link.token), null);
  assert.throws(() => staging.acceptUpload(link.token, { filename: 'a.txt', body: Buffer.from('x') }), { code: 'UPLOAD_LINK_GONE' });

  const live = staging.createLink({ minutes: 99 });
  assert.equal(live.expiresAt, clock + 30 * 60_000, 'minutes are capped at 30');
  const stored = staging.acceptUpload(live.token, { filename: 'notes.txt', contentType: 'text/html', body: Buffer.from('hello') });
  assert.equal(stored.contentType, 'text/plain', 'the name decides the type, and HTML is never kept as HTML');
  clock += STAGED_FILE_TTL_MS;
  assert.equal(staging.status(stored.uploadId).state, 'unknown');

  for (let index = 0; index < MAX_WAITING_UPLOADS; index += 1) staging.createLink();
  assert.throws(() => staging.createLink(), { code: 'UPLOADS_BUSY' });

  assert.deepEqual(resolveUploadReferences({ body: 'x' }, staging), { input: { body: 'x' }, used: [] });
  assert.throws(() => resolveUploadReferences({ addAttachments: [{ uploadId: 'upl_x', url: 'https://a.test/f' }] }, staging), /one of uploadId, url or content/);
  assert.throws(() => resolveUploadReferences({ addAttachments: [{ uploadId: 'not-an-id' }] }, staging), { code: 'NOT_FOUND' });
});

test('the multipart reader takes one file field and ignores other fields', () => {
  const form = multipart([
    { name: 'note', body: 'hi' },
    { name: 'file', filename: 'a b.pdf', type: 'application/pdf', body: Buffer.from('%PDF-1.4\r\n--not-a-boundary\r\n') },
  ]);
  const part = parseSingleFileUpload(form.body, form.contentType);
  assert.equal(part.filename, 'a b.pdf');
  assert.equal(part.contentType, 'application/pdf');
  assert.equal(part.body.toString(), '%PDF-1.4\r\n--not-a-boundary\r\n');

  const two = multipart([
    { name: 'file', filename: 'a.txt', body: 'a' },
    { name: 'file', filename: 'b.txt', body: 'b' },
  ]);
  assert.throws(() => parseSingleFileUpload(two.body, two.contentType), /one file at a time/);
  assert.throws(() => parseSingleFileUpload(multipart([{ name: 'file', filename: 'e.txt', body: '' }]).body, form.contentType.replace('amailtest', 'amailtest')), /No file was chosen/);
  assert.throws(() => parseSingleFileUpload(Buffer.from('junk'), 'multipart/form-data; boundary=x'), /malformed/);
  assert.throws(() => parseSingleFileUpload(form.body.subarray(0, form.body.length - 30), form.contentType), /cut short/);
});
