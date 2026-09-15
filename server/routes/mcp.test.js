import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerMcp } from './mcp.js';

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
