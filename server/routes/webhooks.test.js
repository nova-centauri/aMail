import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerApi } from './api.js';
import { registerMcp } from './mcp.js';
import { encryptJson } from '../services/crypto.js';
import { createMailService } from '../services/mail-service.js';
import { createFakeImapServer } from '../services/fake-imap.test-support.js';
import { createMessageEvents } from '../services/message-events.js';
import { createWebhookService } from '../services/webhooks.js';
import { verifyWebhookSignature } from '../services/webhook-delivery.js';

const token = 'webhook-route-token';
const credentialKey = Buffer.alloc(32, 8);
const FAKE_INTERNAL_DATE = Date.parse('2026-10-29T15:27:13.000Z');

function parseMcpResponse(text) {
  const payloads = [];
  for (const block of String(text).split(/\n\n+/)) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) payloads.push(JSON.parse(dataLine.slice(6)));
  }
  return payloads.length ? payloads.at(-1) : JSON.parse(text);
}

function raw(id, headers = []) {
  return [
    ...headers,
    'From: Pat <pat@example.com>',
    'To: Owner <owner@example.test>',
    `Subject: Sample ${id}`,
    `Message-ID: <${id}@example.test>`,
    'Date: Thu, 29 Oct 2026 15:27:13 +0000',
    '',
    'Hello there.',
    '',
  ].join('\r\n');
}

/** A real receiver on loopback, reachable only because the test allowlists 127.0.0.1. */
async function receiver(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(request.url.startsWith('/fail') ? 500 : 200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

async function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhook-routes-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey,
    accessToken: token,
    syncTimeoutMs: 5_000,
    syncBatchSize: 50,
    imapPoolIdleMs: 0,
    syncMinIntervalMs: 0,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
    trustedAuthservIds: [],
    webhookAllowHosts: ['127.0.0.1'],
    webhookTimeoutMs: 2_000,
  };
  const repos = createRepositories(createDatabase(config));
  const events = createMessageEvents({ repos, config, now: () => FAKE_INTERNAL_DATE + 60_000 });
  const imap = createFakeImapServer();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const mailService = createMailService({ config, repos, events, logger, ImapClient: imap.FakeImapClient });
  const webhooks = createWebhookService({ config, repos, events, logger, version: '0.1.0', autoDispatch: false });
  webhooks.start();
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', color: '#1a73e8', provider: 'custom',
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: encryptJson({ username: 'owner@example.test', password: 'test-only' }, credentialKey),
    signature: '', sync_enabled: 1,
  });
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService, remoteContent: { canIssueTokens: false }, webhooks });
  registerMcp(app, { config, repos, mailService, webhooks });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await webhooks.close();
    await mailService.close();
    events.close();
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const api = async (method, route, body, { auth = true } = {}) => {
    const response = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  const tool = async (name, args = {}, { auth = true } = {}) => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (response.status !== 200) return { status: response.status };
    const { result } = parseMcpResponse(await response.text());
    return { status: 200, isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
  };
  return { config, repos, mailService, webhooks, imap: imap.state, account, origin, api, tool };
}

test('webhook REST routes need the bearer token, return the secret once, and deliver signed events', async (t) => {
  const h = await harness(t);
  const hook = await receiver(t);

  for (const [method, route] of [['GET', '/webhooks'], ['POST', '/webhooks'], ['GET', '/webhooks/x'], ['PATCH', '/webhooks/x'], ['DELETE', '/webhooks/x'], ['POST', '/webhooks/x/test']]) {
    const denied = await h.api(method, route, method === 'GET' || method === 'DELETE' ? undefined : {}, { auth: false });
    assert.equal(denied.status, 401, `${method} ${route}`);
  }

  const empty = await h.api('GET', '/webhooks');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.webhooks, []);
  assert.deepEqual(Object.keys(empty.body.eventTypes), ['message.received', 'message.sent', 'message.analyzed']);

  // Unsafe targets are refused before anything is stored or contacted.
  for (const [url, code] of [
    ['http://hooks.example.test/amail', 'WEBHOOK_URL_BLOCKED'],
    ['https://127.0.0.2/hook', 'WEBHOOK_PRIVATE_ADDRESS'],
    ['https://10.0.0.5/hook', 'WEBHOOK_PRIVATE_ADDRESS'],
    ['https://192.168.1.9/hook', 'WEBHOOK_PRIVATE_ADDRESS'],
    ['https://169.254.169.254/latest/meta-data/', 'WEBHOOK_PRIVATE_ADDRESS'],
    ['https://[fe80::1]/hook', 'WEBHOOK_PRIVATE_ADDRESS'],
    ['https://user:pw@hooks.example.test/', 'WEBHOOK_URL_BLOCKED'],
  ]) {
    const refused = await h.api('POST', '/webhooks', { url, events: ['message.received'] });
    assert.equal(refused.status, 422, url);
    assert.equal(refused.body.error.code, code, url);
  }
  assert.equal((await h.api('POST', '/webhooks', { url: `${hook.origin}/amail`, events: ['nope'] })).status, 400);
  assert.equal(h.webhooks.list().length, 0);

  const created = await h.api('POST', '/webhooks', {
    url: `${hook.origin}/amail`,
    events: ['message.received'],
    description: 'Control plane',
    accountIds: [h.account.id],
  });
  assert.equal(created.status, 201);
  const { webhook, secret } = created.body;
  assert.match(secret, /^whsec_/);
  assert.equal(webhook.status, 'active');
  assert.equal(webhook.description, 'Control plane');

  const listed = await h.api('GET', '/webhooks');
  assert.equal(listed.body.webhooks.length, 1);
  assert.equal(listed.text.includes(secret), false);
  assert.equal(listed.body.status.subscriptions, 1);
  const detail = await h.api('GET', `/webhooks/${webhook.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.text.includes(secret), false);
  assert.deepEqual(detail.body.deliveries, []);
  assert.equal((await h.api('GET', '/webhooks/missing')).status, 404);

  // A real message arrives; the receiver gets one signed POST it can verify.
  h.imap.seed('INBOX', raw('hook-1', [
    'Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=pat@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
  ]));
  await h.mailService.syncAccount(h.account.id);
  await h.webhooks.dispatchDue();
  assert.equal(hook.requests.length, 1);
  const [request] = hook.requests;
  assert.equal(request.url, '/amail');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['user-agent'], 'aMail-Webhook/0.1.0');
  assert.equal(request.headers['x-amail-event'], 'message.received');
  assert.match(request.headers['x-amail-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
  const signedAt = Number(request.headers['x-amail-signature'].match(/^t=(\d+)/)[1]);
  assert.equal(verifyWebhookSignature(secret, request.body, request.headers['x-amail-signature'], { nowSeconds: signedAt }), true);
  assert.equal(verifyWebhookSignature('wrong-secret-entirely', request.body, request.headers['x-amail-signature'], { nowSeconds: signedAt }), false);
  const event = JSON.parse(request.body);
  const stored = h.repos.messages.findByRfcId(h.account.id, '<hook-1@example.test>');
  assert.equal(event.id, request.headers['x-amail-event-id']);
  assert.equal(event.type, 'message.received');
  assert.equal(event.data.messageId, stored.id);
  assert.equal(event.data.accountEmail, 'owner@example.test');
  assert.equal(event.data.subject, 'Sample hook-1');
  // No trusted id is configured for this account yet, so the verdicts are marked untrusted.
  assert.deepEqual(event.data.authentication, {
    spf: 'pass', dkim: 'pass', dmarc: 'pass', authservId: 'mx.example.net', trusted: false,
    fromAligned: true, dkimDomains: ['example.com'], returnPath: null,
  });
  assert.equal(request.body.includes('Hello there'), false);
  const afterDelivery = await h.api('GET', `/webhooks/${webhook.id}`);
  assert.deepEqual(afterDelivery.body.deliveries.map((item) => [item.eventType, item.status, item.responseStatus]), [['message.received', 'delivered', 200]]);

  // Test ping, patch, rotate, disable, delete.
  const ping = await h.api('POST', `/webhooks/${webhook.id}/test`);
  assert.equal(ping.status, 200);
  assert.equal(ping.body.delivery.ok, true);
  assert.equal(hook.requests.at(-1).headers['x-amail-event'], 'ping');

  const patched = await h.api('PATCH', `/webhooks/${webhook.id}`, { events: ['message.received', 'message.analyzed'], url: `${hook.origin}/fail` });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.webhook.events, ['message.received', 'message.analyzed']);
  assert.equal(patched.body.secret, undefined);
  const failingPing = await h.api('POST', `/webhooks/${webhook.id}/test`);
  assert.deepEqual([failingPing.body.delivery.ok, failingPing.body.delivery.error], [false, 'http-500']);

  const rotated = await h.api('PATCH', `/webhooks/${webhook.id}`, { rotateSecret: true });
  assert.match(rotated.body.secret, /^whsec_/);
  assert.notEqual(rotated.body.secret, secret);
  const disabled = await h.api('PATCH', `/webhooks/${webhook.id}`, { enabled: false });
  assert.equal(disabled.body.webhook.status, 'disabled');
  assert.equal((await h.api('PATCH', `/webhooks/${webhook.id}`, { url: 'https://10.0.0.1/' })).status, 422);

  const health = await h.api('GET', '/health');
  assert.deepEqual(
    (({ subscriptions, active, disabled: off, autoDisabled }) => ({ subscriptions, active, off, autoDisabled }))(health.body.webhooks),
    { subscriptions: 1, active: 0, off: 1, autoDisabled: 0 },
  );
  const publicHealth = await h.api('GET', '/health', undefined, { auth: false });
  assert.equal(publicHealth.body.webhooks, undefined, 'unauthenticated probes see no webhook state');

  assert.equal((await h.api('DELETE', `/webhooks/${webhook.id}`)).status, 204);
  assert.equal((await h.api('DELETE', `/webhooks/${webhook.id}`)).status, 404);
  assert.deepEqual((await h.api('GET', '/webhooks')).body.webhooks, []);
});

test('webhook MCP tools mirror REST and never return a stored secret', async (t) => {
  const h = await harness(t);
  const hook = await receiver(t);
  assert.equal((await h.tool('list_webhooks', {}, { auth: false })).status, 401);

  const refused = await h.tool('create_webhook', { url: 'https://169.254.169.254/x', events: ['message.received'] });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error.code, 'WEBHOOK_PRIVATE_ADDRESS');

  const created = await h.tool('create_webhook', { url: `${hook.origin}/mcp-hook`, events: ['message.analyzed'], description: 'Agent hook' });
  assert.equal(created.isError, false);
  assert.match(created.data.secret, /^whsec_/);
  const id = created.data.webhook.id;

  const listed = await h.tool('list_webhooks');
  assert.equal(listed.data.webhooks.length, 1);
  assert.equal(JSON.stringify(listed.data).includes(created.data.secret), false);
  assert.ok(listed.data.eventTypes['message.received']);

  const ping = await h.tool('test_webhook', { id });
  assert.equal(ping.data.delivery.ok, true);
  assert.equal(hook.requests[0].headers['x-amail-event'], 'ping');

  const updated = await h.tool('update_webhook', { id, events: ['*'], enabled: false });
  assert.deepEqual(updated.data.webhook.events, ['*']);
  assert.equal(updated.data.webhook.status, 'disabled');
  assert.equal(updated.data.secret, undefined);
  const rotated = await h.tool('update_webhook', { id, rotateSecret: true });
  assert.match(rotated.data.secret, /^whsec_/);

  const detail = await h.tool('get_webhook', { id });
  assert.equal(detail.data.webhook.id, id);
  assert.deepEqual(detail.data.deliveries.map((item) => item.eventType), ['ping']);
  assert.equal(JSON.stringify(detail.data).includes(rotated.data.secret), false);

  assert.deepEqual((await h.tool('delete_webhook', { id })).data, { deleted: true, id });
  assert.equal((await h.tool('get_webhook', { id })).data.error.code, 'NOT_FOUND');
});

test('routes mounted without a webhook service answer 503 instead of failing', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhook-none-'));
  const config = { dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), credentialKey, accessToken: null };
  const repos = createRepositories(createDatabase(config));
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService: {}, remoteContent: { canIssueTokens: false } });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'WEBHOOKS_UNAVAILABLE');
});

test('authentication verdicts are stored per account trust and exposed over REST and MCP', async (t) => {
  const h = await harness(t);
  const headers = [
    'Return-Path: <bounce@example.com>',
    'Authentication-Results: mx.forged.example; spf=pass smtp.mailfrom=pat@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
    'Authentication-Results: mx.example.net; spf=softfail smtp.mailfrom=bounce@example.com; dkim=none; dmarc=fail header.from=example.com',
  ];

  // Before the account trusts a server, the topmost header is stored but untrusted.
  h.imap.seed('INBOX', raw('auth-1', headers));
  await h.mailService.syncAccount(h.account.id);
  const first = h.repos.messages.findByRfcId(h.account.id, '<auth-1@example.test>');
  assert.equal(first.authentication.trusted, false);
  assert.equal(first.authentication.authservId, 'mx.forged.example');

  // Set the trusted id over REST; a bad entry is rejected.
  const bad = await h.api('PATCH', `/accounts/${h.account.id}`, { trustedAuthservIds: ['mx.example.net', 'not ok!'] });
  assert.equal(bad.status, 400);
  const patched = await h.api('PATCH', `/accounts/${h.account.id}`, { trustedAuthservIds: ['MX.Example.net'] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.account.trustedAuthservIds, ['mx.example.net']);
  assert.equal(patched.body.connection, undefined, 'changing trust does not re-test the connection');
  const settings = await h.api('GET', `/accounts/${h.account.id}/settings`);
  assert.deepEqual(settings.body.effectiveTrustedAuthservIds, ['mx.example.net']);

  h.imap.seed('INBOX', raw('auth-2', headers));
  await h.mailService.syncAccount(h.account.id);
  const second = h.repos.messages.findByRfcId(h.account.id, '<auth-2@example.test>');
  const expected = {
    spf: 'softfail', dkim: 'none', dmarc: 'fail', authservId: 'mx.example.net', trusted: true,
    fromAligned: false, dkimDomains: [], returnPath: 'bounce@example.com',
  };

  // REST: single message and thread reads.
  const message = await h.api('GET', `/messages/${second.id}`);
  assert.deepEqual(message.body.message.authentication, expected);
  const thread = await h.api('GET', `/threads/${second.threadId}`);
  assert.deepEqual(thread.body.messages.find((item) => item.id === second.id).authentication, expected);

  // MCP: full reads and the body-less triage rows.
  assert.deepEqual((await h.tool('get_message', { id: second.id })).data.message.authentication, expected);
  const mcpThread = await h.tool('get_thread', { id: second.threadId });
  assert.deepEqual(mcpThread.data.messages.find((item) => item.id === second.id).authentication, expected);
  const queue = await h.tool('list_unanalyzed_messages', {});
  const queued = queue.data.messages.find((item) => item.id === second.id);
  assert.deepEqual(queued.authentication, expected);
  assert.equal('textBody' in queued, false);
  assert.equal(queue.data.messages.find((item) => item.id === first.id).authentication.trusted, false);
  const claim = await h.tool('claim_messages', { by: 'trust-scorer', ids: [second.id] });
  assert.deepEqual(claim.data.messages[0].authentication, expected);

  // MCP update_account sets the same list and reports what is in effect.
  const cleared = await h.tool('update_account', { id: h.account.id, trustedAuthservIds: [] });
  assert.deepEqual(cleared.data.account.trustedAuthservIds, []);
  assert.deepEqual(cleared.data.account.effectiveTrustedAuthservIds, []);
  const set = await h.tool('update_account', { id: h.account.id, trustedAuthservIds: ['*.example.net'] });
  assert.deepEqual(set.data.account.effectiveTrustedAuthservIds, ['*.example.net']);
  const accounts = await h.tool('list_accounts');
  assert.deepEqual(accounts.data.accounts[0].trustedAuthservIds, ['*.example.net']);
  // Unrelated account updates keep the list.
  const renamed = await h.api('PATCH', `/accounts/${h.account.id}`, { displayName: 'Owner Two' });
  assert.deepEqual(renamed.body.account.trustedAuthservIds, ['*.example.net']);

  // A message imported before these columns existed reads as null, not as a verdict.
  const thread0 = h.repos.threads.create({ account_id: h.account.id, subject: 'Old', normalized_subject: 'old', latest_at: '2026-01-01T00:00:00.000Z' });
  const legacy = h.repos.messages.upsert({
    account_id: h.account.id, thread_id: thread0.id, mailbox: 'INBOX', uid: 900,
    rfc_message_id: '<legacy@example.test>', in_reply_to: null, references_json: '[]',
    subject: 'Old', from_name: '', from_email: 'pat@example.com', to_json: '[]', cc_json: '[]', bcc_json: '[]',
    reply_to_json: null, sent_at: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:00.000Z',
    html_body: '', text_body: '', snippet: '', attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, snoozed_until: null, is_sent: 0,
  });
  assert.equal(legacy.authentication, null);
  assert.equal((await h.tool('get_message', { id: legacy.id })).data.message.authentication, null);
});
