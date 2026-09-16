import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerMcp } from './mcp.js';
import { ServiceUnavailableError } from '../errors.js';

function messageInput({ accountId, threadId, uid, subject, fromEmail, timestamp }) {
  return {
    account_id: accountId,
    thread_id: threadId,
    mailbox: 'INBOX',
    uid,
    rfc_message_id: `<mcp-${uid}@example.test>`,
    in_reply_to: null,
    references_json: '[]',
    subject,
    from_name: '',
    from_email: fromEmail,
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: timestamp,
    received_at: timestamp,
    html_body: `<p>${subject}</p>`,
    text_body: subject,
    snippet: subject,
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
  };
}

function parseMcpResponse(text) {
  const payloads = [];
  for (const block of String(text).split(/\n\n+/)) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    payloads.push(JSON.parse(dataLine.slice(6)));
  }
  if (payloads.length) return payloads.at(-1);
  return JSON.parse(text);
}

async function mcpRpc(origin, { token, method, params, id = 1 }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = parseMcpResponse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

async function lifecycleEndpoint(t) {
  const app = express();
  app.use(express.json());
  registerMcp(app, { config: {}, repos: {}, mailService: {}, remoteContent: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function promptly(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('MCP client disconnect aborts a pending tool and closes its server once', async (t) => {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const connect = McpServer.prototype.connect;
  const transportClose = t.mock.method(StreamableHTTPServerTransport.prototype, 'close');
  let closeCount = 0;
  t.mock.method(McpServer.prototype, 'connect', async function (transport) {
    this.registerTool('wait_for_disconnect', {}, async ({ signal }) => {
      entered.resolve(signal);
      await new Promise((resolve) => signal.addEventListener('abort', () => {
        aborted.resolve();
        resolve();
      }, { once: true }));
      return { content: [] };
    });
    this.server.onclose = () => {
      closeCount += 1;
      closed.resolve();
    };
    t.after(() => this.close());
    await connect.call(this, transport);
  });
  const origin = await lifecycleEndpoint(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const request = fetch(`${origin}/mcp`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_disconnect', arguments: {} } }),
  }).then((response) => response.text()).catch((error) => error);
  const signal = await promptly(entered.promise, 'pending tool did not start');
  assert.equal(signal.aborted, false);
  controller.abort();
  await promptly(Promise.all([aborted.promise, closed.promise, request]), 'disconnect did not abort the tool and close the server');
  assert.equal(signal.aborted, true);
  assert.equal(closeCount, 1);
  assert.equal(transportClose.mock.callCount(), 1);
});

test('MCP delayed successful response finishes before request resources close', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const connect = McpServer.prototype.connect;
  const transportClose = t.mock.method(StreamableHTTPServerTransport.prototype, 'close');
  t.mock.method(McpServer.prototype, 'connect', async function (transport) {
    this.registerTool('delayed_result', {}, async ({ signal }) => {
      entered.resolve(signal);
      await release.promise;
      return { content: [{ type: 'text', text: 'completed synthetic work' }] };
    });
    this.server.onclose = () => closed.resolve();
    t.after(() => this.close());
    await connect.call(this, transport);
  });
  t.after(() => release.resolve());
  const origin = await lifecycleEndpoint(t);
  const request = mcpRpc(origin, { method: 'tools/call', params: { name: 'delayed_result', arguments: {} } });
  const signal = await promptly(entered.promise, 'delayed tool did not start');
  assert.equal(signal.aborted, false);
  assert.equal(transportClose.mock.callCount(), 0);
  release.resolve();
  const result = await promptly(request, 'successful SSE response did not end');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.result.content[0].text, 'completed synthetic work');
  await promptly(closed.promise, 'successful request did not close its server');
  assert.equal(transportClose.mock.callCount(), 1);
});

for (const phase of ['connect', 'handleRequest']) {
  test(`MCP ${phase} failure returns an error and closes request resources once`, async (t) => {
    const transportClose = t.mock.method(StreamableHTTPServerTransport.prototype, 'close');
    const serverClose = t.mock.method(McpServer.prototype, 'close');
    const target = phase === 'connect' ? McpServer.prototype : StreamableHTTPServerTransport.prototype;
    t.mock.method(target, phase, async () => {
      throw new Error('synthetic transport failure');
    });
    const origin = await lifecycleEndpoint(t);
    const result = await mcpRpc(origin, { method: 'tools/list', params: {} });
    assert.equal(result.response.status, 500);
    assert.deepEqual(result.body, {
      jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null,
    });
    assert.equal(transportClose.mock.callCount(), 1);
    assert.equal(serverClose.mock.callCount(), 1);
  });
}

test('MCP endpoint requires access token and exposes inbox tools', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-mcp-'));
  const accessToken = 'test-mcp-access-token';
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 7),
    accessToken,
    syncBatchSize: 50,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
    releaseSha: null,
  };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  const mailService = {
    async testSettings() {
      return { imap: true, smtp: true };
    },
    async testAccount() {
      return { imap: true, smtp: true };
    },
    async syncAccount() {
      return { accountId: 'x', status: 'ok' };
    },
    async syncAll() {
      return [];
    },
    async sendMessage() {
      throw new Error('not used');
    },
    async updateMessageState() {
      throw new Error('not used');
    },
  };
  const remoteContent = { canIssueTokens: false };
  const logger = { error() {} };
  const app = express();
  app.use(express.json());
  registerMcp(app, { config, repos, mailService, remoteContent });
  app.use(errorHandler(logger));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const denied = await mcpRpc(origin, { method: 'tools/list', params: {} });
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.error?.code, 'AUTH_REQUIRED');

  const wrongToken = await mcpRpc(origin, {
    token: 'wrong-token',
    method: 'tools/list',
    params: {},
  });
  assert.equal(wrongToken.response.status, 401);

  const account = repos.accounts.create({
    email: 'owner@example.test',
    display_name: 'Owner',
    avatar_blob: null,
    avatar_mime: null,
    color: '#1a73e8',
    provider: 'custom',
    imap_host: 'imap.example.test',
    imap_port: 993,
    imap_secure: 1,
    smtp_host: 'smtp.example.test',
    smtp_port: 465,
    smtp_secure: 1,
    credential_ciphertext: 'secret-ciphertext-must-not-leak',
    signature: '',
    sync_enabled: 1,
  });
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Hello from MCP',
    normalized_subject: 'hello from mcp',
    latest_at: '2026-03-01T00:00:00.000Z',
  });
  const firstMessage = repos.messages.upsert(messageInput({
    accountId: account.id,
    threadId: thread.id,
    uid: 1,
    subject: 'Hello from MCP',
    fromEmail: 'friend@example.test',
    timestamp: '2026-03-01T00:00:00.000Z',
  }));

  const listedTools = await mcpRpc(origin, {
    token: accessToken,
    method: 'tools/list',
    params: {},
  });
  assert.equal(listedTools.response.status, 200);
  const toolNames = listedTools.body.result.tools.map((tool) => tool.name).sort();
  for (const required of [
    'list_accounts',
    'list_providers',
    'list_messages',
    'list_unanalyzed_messages',
    'get_message',
    'get_attachment',
    'get_thread',
    'send_message',
    'message_action',
    'sync_mail',
    'test_account',
    'add_account',
    'update_account',
    'delete_account',
  ]) {
    assert.ok(toolNames.includes(required), `missing tool ${required}`);
  }

  const accountsCall = await mcpRpc(origin, {
    token: accessToken,
    method: 'tools/call',
    params: { name: 'list_accounts', arguments: {} },
    id: 2,
  });
  assert.equal(accountsCall.response.status, 200);
  assert.equal(accountsCall.body.result.isError, undefined);
  const accountsPayload = JSON.parse(accountsCall.body.result.content[0].text);
  assert.equal(accountsPayload.accounts.length, 1);
  assert.equal(accountsPayload.accounts[0].email, 'owner@example.test');
  assert.equal(accountsPayload.accounts[0].provider, 'custom');
  assert.equal(accountsPayload.accounts[0].syncEnabled, true);
  assert.equal(accountsCall.text.includes('secret-ciphertext'), false);
  assert.equal(Object.hasOwn(accountsPayload.accounts[0], 'credentials'), false);

  const messagesCall = await mcpRpc(origin, {
    token: accessToken,
    method: 'tools/call',
    params: {
      name: 'list_messages',
      arguments: { folder: 'inbox', page: 1, pageSize: 20 },
    },
    id: 3,
  });
  assert.equal(messagesCall.response.status, 200);
  const messagesPayload = JSON.parse(messagesCall.body.result.content[0].text);
  assert.equal(messagesPayload.total, 1);
  assert.equal(messagesPayload.messages[0].subject, 'Hello from MCP');
  assert.equal(messagesPayload.messages[0].from.email, 'friend@example.test');

  const secondMessage = repos.messages.upsert(messageInput({
    accountId: account.id, threadId: thread.id, uid: 2, subject: 'Another message in the thread',
    fromEmail: 'friend@example.test', timestamp: '2026-03-01T00:01:00.000Z',
  }));
  const thirdMessage = repos.messages.upsert(messageInput({
    accountId: account.id, threadId: thread.id, uid: 3, subject: 'Newest message in the thread',
    fromEmail: 'friend@example.test', timestamp: '2026-03-01T00:02:00.000Z',
  }));
  const queueCall = (args) => mcpRpc(origin, {
    token: accessToken, method: 'tools/call', params: { name: 'list_unanalyzed_messages', arguments: args },
  });
  const beforeReads = database.prepare('SELECT total_changes() AS count').get().count;
  const queued = await queueCall({ pageSize: 2 });
  assert.equal(queued.body.result.isError, undefined);
  const page = JSON.parse(queued.body.result.content[0].text);
  assert.equal(page.scope, 'all_cached_messages');
  assert.equal(page.accountId, null);
  assert.equal(page.total, 3);
  assert.equal(page.pageSize, 2);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.nextCursor, 'string');
  assert.deepEqual(page.messages.map((message) => message.id), [firstMessage.id, secondMessage.id]);
  assert.ok(page.messages.every((message) => message.threadId === thread.id));
  assert.ok(page.messages.every((message) => !Object.hasOwn(message, 'htmlBody') && !Object.hasOwn(message, 'textBody')));
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, beforeReads);

  // Leave the oldest blocked. Marking earlier messages must not shift cursor pages.
  repos.messages.setState(secondMessage.id, { isAnalyzed: true, analyzedBy: 'test' });
  const continued = await queueCall({ pageSize: 2, cursor: page.nextCursor });
  const next = JSON.parse(continued.body.result.content[0].text);
  assert.equal(next.total, 2, 'total still includes the blocked message before the cursor');
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(next.messages.map((message) => message.id), [thirdMessage.id]);
  const repeated = JSON.parse((await queueCall({})).body.result.content[0].text);
  assert.deepEqual(repeated.messages.map((message) => message.id), [firstMessage.id, thirdMessage.id]);
  assert.equal(repeated.pageSize, 50);
  const scoped = JSON.parse((await queueCall({ accountId: account.id, pageSize: 1 })).body.result.content[0].text);
  assert.equal(scoped.total, 2);
  assert.equal(scoped.accountId, account.id);
  for (const args of [
    { pageSize: 0 }, { pageSize: 201 }, { pageSize: 1.5 }, { cursor: 'not-json' },
    { accountId: account.id, cursor: page.nextCursor },
    { cursor: Buffer.from(JSON.stringify({ version: 1, accountId: null, timestamp: "' OR 1=1 --", id: 'x' })).toString('base64url') },
    { accountId: 'missing-account' },
  ]) {
    const invalid = await queueCall(args);
    assert.ok(invalid.body.result?.isError || invalid.body.error, `accepted invalid queue args: ${JSON.stringify(args)}`);
  }
  assert.equal(repos.messages.get(firstMessage.id).isRead, false);
  assert.equal(repos.messages.get(firstMessage.id).isAnalyzed, false);

  const cookieAuth = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Cookie: `amail_session=${encodeURIComponent(accessToken)}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    }),
  });
  assert.equal(cookieAuth.status, 200);
});

test('get_attachment authenticates and returns bounded exact bytes for one verified attachment', async (t) => {
  const maxBytes = 8 * 1024 * 1024;
  const token = 'synthetic-attachment-test-token';
  const bytes = Buffer.from([0, 1, 255, 128, 13, 10, 0, 60, 115, 99, 114, 105, 112, 116, 62]);
  const message = { id: 'message-1', isRead: false, isAnalyzed: false, attachments: [
    { index: 4, filename: 'sample.bin', contentType: 'application/octet-stream', size: bytes.length },
  ] };
  const reads = [];
  const fetches = [];
  const mutations = [];
  let fetched = { filename: 'sample.bin', contentType: 'application/octet-stream', body: bytes };
  let failure;
  const repos = {
    messages: { get(id) { reads.push(id); return id === message.id ? message : null; } },
    threads: { get() { throw new Error('Must not resolve a thread.'); } },
  };
  const mailService = {
    async fetchAttachment(...args) { fetches.push(args); if (failure) throw failure; return fetched; },
    async updateMessageState() { mutations.push('mark'); throw new Error('Must not mark mail.'); },
    async syncAccount() { mutations.push('sync'); throw new Error('Must not sync.'); },
    async syncAll() { mutations.push('syncAll'); throw new Error('Must not sync.'); },
  };
  const app = express();
  app.use(express.json());
  registerMcp(app, { config: { accessToken: token }, repos, mailService });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (args, accessToken = token) => mcpRpc(origin, {
    token: accessToken, method: 'tools/call', params: { name: 'get_attachment', arguments: args },
  });
  const payload = (result) => JSON.parse(result.body.result.content[0].text);
  const validArgs = { id: message.id, index: 4 };

  for (const accessToken of ['', 'wrong-token']) {
    const denied = await call(validArgs, accessToken);
    assert.equal(denied.response.status, 401);
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(fetches, []);

  const listing = await mcpRpc(origin, { token, method: 'tools/list', params: {} });
  const tool = listing.body.result.tools.find((item) => item.name === 'get_attachment');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['id', 'index']);

  for (const args of [
    {}, { id: message.id }, { index: 4 }, { id: '', index: 4 }, { id: '   ', index: 4 },
    { id: 'x'.repeat(129), index: 4 }, { id: 123, index: 4 },
    ...[-1, 0.5, 10001, '4', null, {}, []].map((index) => ({ id: message.id, index })),
  ]) {
    const invalid = await call(args);
    assert.ok(invalid.body.result?.isError || invalid.body.error, `accepted invalid input ${JSON.stringify(args)}`);
  }
  assert.deepEqual(reads, [], 'schema failures must not access mail');
  for (const args of [{ id: 'missing', index: 4 }, { id: 'thread-1', index: 4 }, { id: message.id, index: 0 }]) {
    assert.deepEqual(payload(await call(args)), { error: { code: 'NOT_FOUND', message: args.id === message.id ? 'Attachment not found.' : 'Message not found.' } });
  }
  message.attachments.push({ ...message.attachments[0] });
  assert.equal(payload(await call(validArgs)).error.code, 'NOT_FOUND', 'duplicate indexes are ambiguous');
  message.attachments.pop();
  message.attachments[0].size = maxBytes + 1;
  assert.deepEqual(payload(await call(validArgs)), { error: { code: 'VALIDATION_ERROR', message: 'Attachment exceeds the 8 MiB limit.' } });
  assert.deepEqual(fetches, [], 'missing or oversize metadata must fail before fetching');
  message.attachments[0].size = bytes.length;

  const result = await call(validArgs);
  assert.equal(result.body.result.isError, undefined);
  assert.deepEqual(payload(result), { attachment: {
    messageId: message.id, index: 4, filename: 'sample.bin', contentType: 'application/octet-stream',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'base64', contentBase64: bytes.toString('base64'),
  } });
  assert.deepEqual(fetches, [[message.id, 4, { strict: true }]]);
  assert.deepEqual(Buffer.from(payload(result).attachment.contentBase64, 'base64'), bytes);

  fetched = { filename: '\u0000\r\n\u202e' + 'x'.repeat(400), contentType: 'y'.repeat(200), body: Buffer.alloc(0) };
  const labels = payload(await call(validArgs)).attachment;
  assert.equal(labels.filename, 'x'.repeat(256));
  assert.equal(labels.contentType, 'y'.repeat(128));
  assert.equal(labels.size, 0);
  assert.equal(labels.contentBase64, '');
  fetched = { filename: {}, contentType: ['text/html'], body: bytes };
  const fallback = payload(await call(validArgs)).attachment;
  assert.equal(fallback.filename, 'attachment');
  assert.equal(fallback.contentType, 'application/octet-stream');

  fetched = { body: Buffer.alloc(maxBytes, 0xa5) };
  const boundary = payload(await call(validArgs)).attachment;
  assert.equal(boundary.size, maxBytes);
  assert.equal(boundary.sha256, createHash('sha256').update(fetched.body).digest('hex'));
  assert.deepEqual(Buffer.from(boundary.contentBase64, 'base64'), fetched.body);
  fetched = { body: Buffer.alloc(maxBytes + 1) };
  const oversize = await call(validArgs);
  assert.equal(oversize.body.result.isError, true);
  assert.deepEqual(payload(oversize), { error: { code: 'VALIDATION_ERROR', message: 'Attachment exceeds the 8 MiB limit.' } });
  assert.equal(oversize.text.includes('contentBase64'), false);

  for (const error of [new Error('parser raw secret'), new ServiceUnavailableError('upstream raw secret', 'RAW_UPSTREAM_SECRET')]) {
    failure = error;
    const unavailable = await call(validArgs);
    assert.deepEqual(payload(unavailable), { error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'Could not retrieve this attachment.' } });
    assert.equal(unavailable.text.includes('secret'), false);
  }
  failure = null;
  fetched = { body: 'not a byte buffer' };
  assert.equal(payload(await call(validArgs)).error.code, 'ATTACHMENT_UNAVAILABLE');
  assert.deepEqual(mutations, []);
  assert.equal(message.isRead, false);
  assert.equal(message.isAnalyzed, false);
});
