import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerApi } from './api.js';
import { registerMcp } from './mcp.js';
import { issueAttachmentLink, safeAttachmentFetchError } from '../mcp/attachments.js';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../errors.js';
import { makeDocx, makePdf } from '../services/attachment-fixtures.test-support.js';

const TOKEN = 'synthetic-attachment-reader-token';

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
  const body = text ? JSON.parse(dataLine ? dataLine.slice(6) : text) : null;
  return { response, body };
}

function payload(result) {
  return JSON.parse(result.body.result.content[0].text);
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-mcp-attachments-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 7),
    remoteTokenKey: Buffer.alloc(32, 9),
    accessToken: TOKEN,
    publicOrigin: null,
    syncBatchSize: 50,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
  };
  const repos = createRepositories(createDatabase(config));
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', avatar_blob: null, avatar_mime: null, color: '#1a73e8',
    provider: 'custom', imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1, smtp_host: 'smtp.example.test',
    smtp_port: 465, smtp_secure: 1, credential_ciphertext: 'test-only', signature: '', sync_enabled: 1,
  });
  const thread = repos.threads.create({
    account_id: account.id, subject: 'Quote', normalized_subject: 'quote', latest_at: '2026-11-13T00:00:00.000Z',
  });
  const pdf = makePdf([['Quote EKA7FK', 'Total $19,937.00'], ['Terms: prepay with PO']]);
  const docx = makeDocx(['PO 5521', 'Ship overnight']);
  const files = [
    { index: 0, filename: 'quote.pdf', contentType: 'application/pdf', body: pdf },
    { index: 1, filename: 'po.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx },
  ];
  const timestamp = '2026-11-13T00:00:00.000Z';
  const message = repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'INBOX', uid: 7, rfc_message_id: '<att-7@example.test>',
    in_reply_to: null, references_json: '[]', subject: 'Quote', from_name: '', from_email: 'vendor@example.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null, sent_at: timestamp, received_at: timestamp,
    html_body: '<p>See attached</p>', text_body: 'See attached', snippet: 'See attached',
    attachments_json: JSON.stringify(files.map(({ body, ...meta }) => ({ ...meta, size: body.length }))),
    labels_json: '[]', is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, snoozed_until: null, is_sent: 0,
  });
  const fetches = [];
  const mutations = [];
  const mailService = {
    async fetchAttachment(id, index, options) {
      fetches.push([id, index, options]);
      const file = files.find((item) => item.index === index);
      return { filename: file.filename, contentType: file.contentType, body: file.body };
    },
    async updateMessageState() { mutations.push('state'); throw new Error('must not change mail'); },
    async syncAccount() { mutations.push('sync'); throw new Error('must not sync'); },
  };
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService, remoteContent: { canIssueTokens: false } });
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
  return { config, origin, repos, message, thread, files, fetches, mutations };
}

test('agents can read, view and download attachments without changing mail', async (t) => {
  const { config, origin, repos, message, thread, files, fetches, mutations } = await setup(t);

  const listing = await mcpCall(origin, 'tools/list');
  const tools = Object.fromEntries(listing.body.result.tools.map((tool) => [tool.name, tool]));
  for (const name of ['read_attachment', 'view_attachment', 'get_attachment_link', 'get_attachment']) assert.ok(tools[name], `missing ${name}`);
  assert.equal(tools.read_attachment.annotations.readOnlyHint, true);
  assert.match(tools.read_attachment.description, /untrusted/);
  assert.match(tools.get_attachment_link.description, /never put it in chat/);
  assert.match(tools.list_messages.description, /latestMessageId/);

  for (const accessToken of ['', 'wrong']) {
    assert.equal((await mcpCall(origin, 'read_attachment', { id: message.id, index: 0 }, accessToken)).response.status, 401);
  }

  const read = payload(await mcpCall(origin, 'read_attachment', { id: message.id, index: 0 })).attachment;
  assert.equal(read.kind, 'pdf');
  assert.equal(read.pageCount, 2);
  assert.equal(read.filename, 'quote.pdf');
  assert.equal(read.sha256, createHash('sha256').update(files[0].body).digest('hex'));
  assert.equal(read.text, '[Page 1 of 2]\nQuote EKA7FK\nTotal $19,937.00\n\n[Page 2 of 2]\nTerms: prepay with PO');
  assert.equal(read.nextOffset, null);
  const page2 = payload(await mcpCall(origin, 'read_attachment', { id: message.id, index: 0, page: 2 })).attachment;
  assert.equal(page2.text, '[Page 2 of 2]\nTerms: prepay with PO');
  const docx = payload(await mcpCall(origin, 'read_attachment', { id: message.id, index: 1 })).attachment;
  assert.equal(docx.text, 'PO 5521\nShip overnight');
  assert.deepEqual(fetches.map(([id, index, options]) => [id, index, options]), [
    [message.id, 0, { strict: true, maxBytes: 25 * 1024 * 1024 }],
    [message.id, 1, { strict: true, maxBytes: 25 * 1024 * 1024 }],
  ], 'paging reuses the first fetch');

  const missing = payload(await mcpCall(origin, 'read_attachment', { id: thread.id, index: 0 }));
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.match(missing.error.message, /latestMessageId/);
  assert.equal(payload(await mcpCall(origin, 'read_attachment', { id: message.id, index: 9 })).error.message, 'Attachment not found.');
  const asThread = payload(await mcpCall(origin, 'get_message', { id: thread.id }));
  assert.equal(asThread.error.code, 'NOT_FOUND');
  assert.match(asThread.error.message, /conversation \(thread\)/);

  let canvas = true;
  try {
    await import('@napi-rs/canvas');
  } catch {
    canvas = false;
  }
  if (canvas) {
    const viewed = await mcpCall(origin, 'view_attachment', { id: message.id, index: 0, page: 2, maxDimension: 500 });
    const [summary, image] = viewed.body.result.content;
    assert.equal(JSON.parse(summary.text).attachment.page, 2);
    assert.equal(image.type, 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  }
  const notAPage = await mcpCall(origin, 'view_attachment', { id: message.id, index: 1, page: 2 });
  assert.equal(notAPage.body.result.isError, true);

  const link = payload(await mcpCall(origin, 'get_attachment_link', { id: message.id, index: 0, minutes: 2 })).attachment;
  assert.equal(link.filename, 'quote.pdf');
  assert.equal(link.size, files[0].body.length);
  assert.equal(link.reusableUntilExpiry, true);
  assert.ok(link.url.startsWith(`${origin}/api/content/attachment?token=`));
  const expiresIn = Date.parse(link.expiresAt) - Date.now();
  assert.ok(expiresIn > 60_000 && expiresIn <= 120_000);
  const download = await fetch(link.url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="quote\.pdf"/);
  assert.equal(download.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), files[0].body);
  assert.deepEqual(fetches.at(-1), [message.id, 0, { strict: true, maxBytes: 25 * 1024 * 1024 }], 'agent links re-verify the exact part');

  const tampered = new URL(link.url);
  tampered.searchParams.set('token', `${tampered.searchParams.get('token').slice(0, -2)}AA`);
  assert.equal((await fetch(tampered)).status, 400);
  const expired = issueAttachmentLink(config, { messageId: message.id, index: 0, minutes: 1, now: Date.now() - 5 * 60_000 });
  assert.equal((await fetch(expired.url)).status, 410);
  const tooLong = await mcpCall(origin, 'get_attachment_link', { id: message.id, index: 0, minutes: 11 });
  assert.equal(tooLong.body.result.isError, true, 'links last at most 10 minutes');
  assert.equal(tooLong.body.result.content[0].text.includes('token='), false);

  assert.deepEqual(mutations, []);
  assert.equal(repos.messages.get(message.id).isRead, false);
  assert.equal(repos.messages.get(message.id).isAnalyzed, false);
});

test('download links are refused without a public origin or a token key', () => {
  assert.throws(() => issueAttachmentLink({ remoteTokenKey: Buffer.alloc(32, 1), publicOrigin: null }, { messageId: 'm', index: 0 }), /AMAIL_ORIGIN/);
  assert.throws(() => issueAttachmentLink({ remoteTokenKey: null, publicOrigin: 'https://mail.example.test' }, { messageId: 'm', index: 0 }), /unlocked/);
  const link = issueAttachmentLink({ remoteTokenKey: Buffer.alloc(32, 1), publicOrigin: 'https://mail.example.test' }, { messageId: 'm', index: 3, minutes: 5, now: 0 });
  assert.equal(link.expiresAt, '1970-01-01T00:05:00.000Z');
  assert.equal(link.url.includes('m'), true);
  assert.equal(new URL(link.url).searchParams.get('token').includes('"m"'), false, 'the token is opaque');
});

test('attachment fetch failures reach agents as fixed codes and sentences only', () => {
  const upstream = new ServiceUnavailableError('IMAP said: secret body text', 'ATTACHMENT_IDENTITY_UNVERIFIED');
  const identity = safeAttachmentFetchError(upstream);
  assert.equal(identity.code, 'ATTACHMENT_IDENTITY_UNVERIFIED');
  assert.doesNotMatch(identity.message, /secret/);
  assert.equal(safeAttachmentFetchError(new NotFoundError('Attachment not found in the original message.')).code, 'ATTACHMENT_NOT_ON_SERVER');
  const tooLarge = safeAttachmentFetchError(new ValidationError('Attachment exceeds the 8 MiB limit.'), 25 * 1024 * 1024);
  assert.equal(tooLarge.message, 'Attachment exceeds the 25 MiB limit.');
  const unknown = safeAttachmentFetchError(new ServiceUnavailableError('parser detail', 'SOMETHING_ELSE'));
  assert.equal(unknown.code, 'ATTACHMENT_UNAVAILABLE');
  assert.equal(safeAttachmentFetchError(new Error('raw socket detail')).code, 'ATTACHMENT_UNAVAILABLE');
});

test('incomplete-message queries count and list rows a search saved from headers alone', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-incomplete-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const repos = createRepositories(createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), credentialKey: Buffer.alloc(32, 7) }));
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', avatar_blob: null, avatar_mime: null, color: '#1a73e8',
    provider: 'custom', imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1, smtp_host: 'smtp.example.test',
    smtp_port: 465, smtp_secure: 1, credential_ciphertext: 'test-only', signature: '', sync_enabled: 1,
  });
  const thread = repos.threads.create({ account_id: account.id, subject: 'News', normalized_subject: 'news', latest_at: '2026-11-14T00:00:00.000Z' });
  const row = (uid, sourceImported, attachments) => repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'INBOX', uid, rfc_message_id: `<m-${uid}@example.test>`,
    in_reply_to: null, references_json: '[]', subject: 'News', from_name: '', from_email: 'office@example.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: `2026-11-1${uid}T00:00:00.000Z`, received_at: `2026-11-1${uid}T00:00:00.000Z`,
    html_body: '', text_body: '', snippet: 'News', attachments_json: JSON.stringify(attachments),
    labels_json: '[]', is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, snoozed_until: null,
    is_sent: 0, source_imported: sourceImported,
  });
  const pdf = [{ index: 0, filename: 'news.pdf', contentType: 'application/octet-stream', size: 0, contentId: null }];
  const placeholderWithFile = row(4, 0, pdf);
  row(3, 0, []);
  row(2, 1, pdf);

  assert.deepEqual(repos.messages.incompleteSummary(), [{ accountId: account.id, messages: 2, withAttachments: 1 }]);
  assert.deepEqual(repos.messages.incompleteSummary({ accountId: 'other' }), []);
  assert.deepEqual(repos.messages.incompleteIds({ accountId: account.id }), [placeholderWithFile.id]);
  assert.equal(repos.messages.incompleteIds({ withAttachments: false }).length, 2);
  assert.deepEqual(repos.messages.incompleteIds({ withAttachments: false, offset: 1, limit: 5 }).length, 1);
});
