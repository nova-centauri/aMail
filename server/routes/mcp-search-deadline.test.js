import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { createDatabase, createRepositories } from '../db.js';
import { createLogger } from '../logging.js';
import { createAuthenticator } from '../middleware/auth.js';
import { createSearchRead } from '../services/search-read.js';

const silent = createLogger({ logLevel: 'silent' });

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

async function mcpCall(origin, token, name, args) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  return { response, body: parseMcpResponse(text) };
}

test('pathological list_messages hits the deadline without blocking health', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-mcp-deadline-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const token = 'deadline-token';
  const config = {
    env: 'test',
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    accessToken: token,
    credentialKey: Buffer.alloc(32, 3),
    searchReadWorker: true,
    searchQueryDeadlineMs: 350,
    searchReadTestHangMs: 2_000,
    staticDir: path.join(dataDir, 'missing-static'),
    trustProxy: false,
    logLevel: 'silent',
    keyMode: 'env',
  };
  const db = createDatabase(config);
  const repos = createRepositories(db);
  const searchRead = createSearchRead({ config, logger: silent });
  repos.searchRead = searchRead;
  t.after(async () => {
    await searchRead.close();
    repos.close();
  });
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
    credential_ciphertext: 'x',
    signature: '',
    sync_enabled: 0,
  });
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Freeze',
    normalized_subject: 'freeze',
    latest_at: '2026-10-20T00:00:00.000Z',
  });
  repos.messages.upsert({
    account_id: account.id,
    thread_id: thread.id,
    mailbox: 'INBOX',
    uid: 1,
    rfc_message_id: '<freeze@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Freeze',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-10-20T00:00:00.000Z',
    received_at: '2026-10-20T00:00:00.000Z',
    html_body: '<p>Freeze</p>',
    text_body: 'Freeze',
    snippet: 'Freeze',
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
  });

  const app = createApp({
    config,
    repos,
    mailService: { runtimeStatus: () => ({ inFlight: false }) },
    remoteContent: { canIssueTokens: false },
    logger: silent,
    auth: createAuthenticator({ config }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  let maxLagMs = 0;
  const lagTimer = setInterval(() => {
    const scheduled = Date.now();
    setImmediate(() => {
      maxLagMs = Math.max(maxLagMs, Date.now() - scheduled);
    });
  }, 20);
  if (typeof lagTimer.unref === 'function') lagTimer.unref();

  const healthStatuses = [];
  const healthTimer = setInterval(async () => {
    try {
      const health = await fetch(`${origin}/api/health`);
      healthStatuses.push(health.status);
    } catch (error) {
      healthStatuses.push(String(error?.message || error));
    }
  }, 40);
  if (typeof healthTimer.unref === 'function') healthTimer.unref();

  const listed = await mcpCall(origin, token, 'list_messages', {
    q: 'from:friend@example.test',
    folder: 'inbox',
    pageSize: 50,
  });
  await new Promise((resolve) => setImmediate(resolve));
  clearInterval(lagTimer);
  clearInterval(healthTimer);

  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.result?.isError, true);
  const payload = JSON.parse(listed.body.result.content[0].text);
  assert.equal(payload.error.code, 'QUERY_DEADLINE');
  assert.match(payload.error.message, /narrow the query/i);
  assert.ok(healthStatuses.length > 0, 'health should have been polled while search ran');
  assert.deepEqual([...new Set(healthStatuses)], [200]);
  assert.ok(maxLagMs <= 200, `event-loop lag ${maxLagMs}ms exceeded 200ms`);
});
