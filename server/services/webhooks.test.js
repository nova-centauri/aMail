import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { loadConfig } from '../config.js';
import { createMessageEvents } from './message-events.js';
import {
  checkWebhookUrl,
  createWebhookTransport,
  parseWebhookAllowHosts,
  parseWebhookEventList,
  signWebhookBody,
  verifyWebhookSignature,
  WebhookDeliveryError,
} from './webhook-delivery.js';
import {
  createWebhookService,
  ENV_WEBHOOK_ID,
  MAX_WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  webhookRetryDelayMs,
} from './webhooks.js';

const credentialKey = Buffer.alloc(32, 6);
const START = Date.parse('2026-11-02T09:00:00.000Z');
const MINUTE = 60_000;

function accountInput(email) {
  return {
    email, display_name: email, color: '#1a73e8', provider: 'custom', avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'ciphertext', signature: '', sync_enabled: 1,
  };
}

/** A transport double: records every POST and answers from `respond`. */
function fakeTransport({ allowHosts = [] } = {}) {
  const real = createWebhookTransport({
    allowHosts,
    resolveHost: async (host) => {
      if (host.endsWith('.internal.test')) return [{ address: '10.0.0.8', family: 4 }];
      if (host === 'missing.example.test') throw new Error('ENOTFOUND');
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  const calls = [];
  const transport = {
    respond: () => ({ status: 200 }),
    calls,
    checkUrl: real.checkUrl,
    assertDeliverable: real.assertDeliverable,
    async post(request) {
      calls.push(request);
      const result = await transport.respond(request, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return transport;
}

function harness(t, { configExtra = {}, transport = fakeTransport(), dataDir = null, start = true } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhooks-'));
  const config = {
    dataDir: dir,
    dbPath: path.join(dir, 'mail.sqlite'),
    credentialKey,
    webhookAllowHosts: [],
    webhookMaxQueue: 1_000,
    webhookDeliveryLogSize: 100,
    webhookMaxConsecutiveFailures: 20,
    ...configExtra,
  };
  const repos = createRepositories(createDatabase(config));
  const clock = { now: START };
  const events = createMessageEvents({ repos, config, now: () => clock.now });
  const logs = [];
  const logger = {
    info() {},
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };
  const webhooks = createWebhookService({
    config, repos, events, logger, transport, version: '9.9.9', now: () => clock.now, random: () => 0.5, autoDispatch: false,
  });
  if (start) webhooks.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await webhooks.close();
    events.close();
    repos.close();
  };
  t.after(async () => {
    await close();
    if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const emit = (type = 'message.received', data = {}) => events.emit(type, {
    messageId: 'message-1', accountId: 'account-1', accountEmail: 'owner@example.test', threadId: 'thread-1',
    mailbox: 'INBOX', rfcMessageId: '<m1@example.test>', from: { name: 'Pat', email: 'pat@example.com' },
    subject: 'Hello', receivedAt: new Date(clock.now).toISOString(), isSpam: false, authentication: null, ...data,
  });
  return { config, repos, events, webhooks, transport, clock, logs, emit, close, dir };
}

test('signature matches a known vector and the reference verifier enforces time and content', () => {
  const secret = 'whsec_test_secret_0123456789';
  const body = '{"id":"evt_1","type":"ping"}';
  const header = signWebhookBody(secret, body, 1_700_000_000);
  assert.equal(header, 't=1700000000,v1=ca4620dcda0df82d724dc9135fc3e9d3313af224c6485dbd6e057d118e621e32');
  assert.equal(verifyWebhookSignature(secret, body, header, { nowSeconds: 1_700_000_000 }), true);
  assert.equal(verifyWebhookSignature(secret, body, header, { nowSeconds: 1_700_000_300 }), true);
  assert.equal(verifyWebhookSignature(secret, body, header, { nowSeconds: 1_700_000_301 }), false, 'outside the 5-minute tolerance');
  assert.equal(verifyWebhookSignature(secret, `${body} `, header, { nowSeconds: 1_700_000_000 }), false, 'body changed');
  assert.equal(verifyWebhookSignature('another-secret-value', body, header, { nowSeconds: 1_700_000_000 }), false);
  assert.equal(verifyWebhookSignature(secret, body, 't=1700000000,v1=zz', { nowSeconds: 1_700_000_000 }), false);
  assert.equal(verifyWebhookSignature(secret, body, '', { nowSeconds: 1_700_000_000 }), false);
});

test('webhook settings parse from the environment with safe defaults', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.webhookUrl, null);
  assert.equal(defaults.webhookSecret, null);
  assert.deepEqual(defaults.webhookEvents, ['message.received']);
  assert.deepEqual(defaults.webhookAllowHosts, []);
  assert.equal(defaults.webhookTimeoutMs, 10_000);
  assert.equal(defaults.webhookMaxConsecutiveFailures, 20);
  assert.equal(defaults.webhookMaxQueue, 1_000);
  const set = loadConfig({
    AMAIL_WEBHOOK_URL: ' https://hooks.example.test/amail ',
    AMAIL_WEBHOOK_SECRET: 'a-long-shared-secret-value',
    AMAIL_WEBHOOK_EVENTS: 'message.received, message.sent, bogus.event',
    AMAIL_WEBHOOK_ALLOW_HOSTS: 'Receiver.LAN, 192.168.1.20, [fd00::5], *.wild.example, bad host',
    AMAIL_WEBHOOK_MAX_CONSECUTIVE_FAILURES: '3',
  });
  assert.equal(set.webhookUrl, 'https://hooks.example.test/amail');
  assert.deepEqual(set.webhookEvents, ['message.received', 'message.sent']);
  assert.deepEqual(set.webhookAllowHosts, ['receiver.lan', '192.168.1.20', 'fd00::5']);
  assert.equal(set.webhookMaxConsecutiveFailures, 3);
  assert.deepEqual(parseWebhookEventList('nothing.valid'), ['message.received']);
  assert.deepEqual(parseWebhookEventList('*'), ['*']);
  assert.deepEqual(parseWebhookAllowHosts(''), []);
});

test('webhook URLs must be https, credential-free and public', () => {
  const refused = (url, code, options) => assert.throws(() => checkWebhookUrl(url, options), (error) => {
    assert.equal(error.code, code, url);
    assert.equal(error.expose, true);
    return true;
  });
  refused('http://hooks.example.test/amail', 'WEBHOOK_URL_BLOCKED');
  refused('ftp://hooks.example.test/amail', 'WEBHOOK_URL_BLOCKED');
  refused('https://user:pass@hooks.example.test/amail', 'WEBHOOK_URL_BLOCKED');
  refused('not a url', 'WEBHOOK_URL_INVALID');
  refused('', 'WEBHOOK_URL_INVALID');
  refused(`https://hooks.example.test/${'a'.repeat(2100)}`, 'WEBHOOK_URL_INVALID');
  for (const url of [
    'https://127.0.0.1/hook', // loopback
    'https://10.1.2.3/hook', 'https://172.16.5.5/hook', 'https://192.168.1.20:8443/hook', // RFC 1918
    'https://169.254.169.254/latest/meta-data/', // link-local / cloud metadata
    'https://100.64.0.1/hook', // CGNAT
    'https://[::1]/hook', 'https://[fe80::1]/hook', 'https://[fd00:ec2::254]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://2130706433/hook', 'https://0x7f.1/hook', // other spellings of 127.0.0.1
    'https://0.0.0.0/hook',
  ]) refused(url, 'WEBHOOK_PRIVATE_ADDRESS');

  assert.equal(checkWebhookUrl('https://hooks.example.test:8443/amail?x=1#frag').toString(), 'https://hooks.example.test:8443/amail?x=1');
  assert.equal(checkWebhookUrl('https://93.184.216.34/hook').hostname, '93.184.216.34');

  // The allowlist is exact: it admits that host (private, or plain http) and nothing else.
  const allowHosts = parseWebhookAllowHosts('192.168.1.20, receiver.lan');
  assert.equal(checkWebhookUrl('http://192.168.1.20:8080/hook', { allowHosts }).port, '8080');
  assert.equal(checkWebhookUrl('http://receiver.lan/hook', { allowHosts }).protocol, 'http:');
  refused('https://192.168.1.21/hook', 'WEBHOOK_PRIVATE_ADDRESS', { allowHosts });
  refused('http://other.lan/hook', 'WEBHOOK_URL_BLOCKED', { allowHosts });
  refused('http://user:pw@receiver.lan/hook', 'WEBHOOK_URL_BLOCKED', { allowHosts });
});

test('the transport refuses hosts that resolve to private addresses and never follows redirects', async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body });
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        response.end();
      } else if (request.url === '/slow') {
        // Never answers; the transport's deadline has to end it.
      } else {
        response.writeHead(204);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const { port } = server.address();

  const lookups = [];
  const strict = createWebhookTransport({
    resolveHost: async (host) => {
      lookups.push(host);
      if (host === 'rebind.example.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
      if (host === 'missing.example.test') throw new Error('ENOTFOUND');
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  await assert.rejects(strict.assertDeliverable('https://internal.example.test/hook'), { code: 'WEBHOOK_PRIVATE_ADDRESS' });
  await assert.rejects(strict.assertDeliverable('https://rebind.example.test/hook'), { code: 'WEBHOOK_PRIVATE_ADDRESS' });
  await assert.rejects(strict.assertDeliverable('https://missing.example.test/hook'), { code: 'WEBHOOK_DNS_FAILED' });
  await assert.rejects(strict.post({ url: 'https://internal.example.test/hook', body: '{}' }), (error) => {
    assert.ok(error instanceof WebhookDeliveryError);
    assert.equal(error.reason, 'private-address');
    return true;
  });
  await assert.rejects(strict.post({ url: `http://127.0.0.1:${port}/ok`, body: '{}' }), { reason: 'url-blocked' });
  assert.equal(seen.length, 0, 'nothing reached the loopback listener');

  // AMAIL_WEBHOOK_ALLOW_HOSTS=127.0.0.1 is the escape hatch for a receiver on the operator's own network.
  const allowed = createWebhookTransport({ allowHosts: ['127.0.0.1'], timeoutMs: 300, userAgent: 'aMail-Webhook/9.9.9' });
  const ok = await allowed.post({
    url: `http://127.0.0.1:${port}/ok?source=test`,
    headers: { 'content-type': 'application/json', 'x-amail-event': 'ping' },
    body: '{"hello":"wörld"}',
  });
  assert.deepEqual(ok, { status: 204 });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/ok?source=test');
  assert.equal(seen[0].body, '{"hello":"wörld"}');
  assert.equal(seen[0].headers['user-agent'], 'aMail-Webhook/9.9.9');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength('{"hello":"wörld"}')));

  // A redirect is reported, not followed: the metadata address is never contacted.
  assert.deepEqual(await allowed.post({ url: `http://127.0.0.1:${port}/redirect`, body: '{}' }), { status: 302 });
  assert.equal(seen.length, 2);
  await assert.rejects(allowed.post({ url: `http://127.0.0.1:${port}/slow`, body: '{}' }), { reason: 'timeout' });
  await assert.rejects(allowed.post({ url: 'http://127.0.0.1:1/closed', body: '{}' }), { reason: 'connection-failed' });
});

test('create returns the secret once, stores it encrypted, and never returns it again', async (t) => {
  const h = harness(t);
  const account = h.repos.accounts.create(accountInput('owner@example.test'));
  const { webhook, secret } = await h.webhooks.create({
    url: 'https://hooks.example.test/amail',
    events: ['message.received', 'message.sent'],
    description: '  Control plane\n',
    accountIds: [account.id],
  });
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(webhook.url, 'https://hooks.example.test/amail');
  assert.equal(webhook.description, 'Control plane');
  assert.deepEqual(webhook.events, ['message.received', 'message.sent']);
  assert.deepEqual(webhook.accountIds, [account.id]);
  assert.equal(webhook.status, 'active');
  assert.equal(webhook.source, 'api');
  assert.equal('secret' in webhook, false);

  const stored = h.repos.webhooks.get(webhook.id);
  assert.equal(stored.secret_ciphertext.includes(secret), false);
  assert.match(stored.secret_ciphertext, /^v1\./);
  for (const view of [h.webhooks.list(), h.webhooks.get(webhook.id), await h.webhooks.update(webhook.id, { description: 'Renamed' })]) {
    assert.equal(JSON.stringify(view).includes(secret), false);
    assert.equal(JSON.stringify(view).includes('secret_ciphertext'), false);
  }

  // The caller may supply its own secret; rotation hands back the new one exactly once.
  const own = await h.webhooks.create({ url: 'https://hooks.example.test/two', events: ['*'], secret: 'caller-chosen-secret-123' });
  assert.equal(own.secret, 'caller-chosen-secret-123');
  const rotated = await h.webhooks.update(own.webhook.id, { rotateSecret: true });
  assert.match(rotated.secret, /^whsec_/);
  assert.notEqual(rotated.secret, own.secret);
  assert.equal((await h.webhooks.update(own.webhook.id, { secret: 'another-caller-secret-456' })).secret, undefined);

  h.emit('message.sent', { accountId: account.id });
  await h.webhooks.dispatchDue();
  const signedWith = (call, candidate) => verifyWebhookSignature(candidate, call.body, call.headers['x-amail-signature'], { nowSeconds: START / 1000 });
  const first = h.transport.calls.find((call) => call.url.endsWith('/amail'));
  const second = h.transport.calls.find((call) => call.url.endsWith('/two'));
  assert.equal(signedWith(first, secret), true);
  assert.equal(signedWith(second, 'another-caller-secret-456'), true);
  assert.equal(signedWith(second, rotated.secret), false);

  await assert.rejects(h.webhooks.create({ url: 'https://hooks.example.test/x', events: [] }), /at least one/);
  await assert.rejects(h.webhooks.create({ url: 'https://hooks.example.test/x', events: ['message.deleted'] }), /Unknown webhook event/);
  await assert.rejects(h.webhooks.create({ url: 'https://hooks.example.test/x', events: ['*'], secret: 'short' }), /secret must be/);
  await assert.rejects(h.webhooks.create({ url: 'https://hooks.example.test/x', events: ['*'], accountIds: ['nope'] }), /does not exist/);
  await assert.rejects(h.webhooks.create({ url: 'http://hooks.example.test/x', events: ['*'] }), { code: 'WEBHOOK_URL_BLOCKED' });
  await assert.rejects(h.webhooks.create({ url: 'https://169.254.169.254/x', events: ['*'] }), { code: 'WEBHOOK_PRIVATE_ADDRESS' });
  await assert.rejects(h.webhooks.create({ url: 'https://db.internal.test/x', events: ['*'] }), { code: 'WEBHOOK_PRIVATE_ADDRESS' });
  await assert.rejects(h.webhooks.create({ url: 'https://missing.example.test/x', events: ['*'] }), { code: 'WEBHOOK_DNS_FAILED' });
  await assert.rejects(h.webhooks.update(webhook.id, { url: 'https://10.0.0.1/x' }), { code: 'WEBHOOK_PRIVATE_ADDRESS' });
  assert.equal(h.webhooks.list().length, 2);

  h.webhooks.remove(own.webhook.id);
  assert.throws(() => h.webhooks.get(own.webhook.id), { code: 'NOT_FOUND' });
  assert.throws(() => h.webhooks.remove('missing'), { code: 'NOT_FOUND' });
});

test('a delivery carries the documented headers, signature and payload', async (t) => {
  const h = harness(t);
  const { webhook, secret } = await h.webhooks.create({ url: 'https://hooks.example.test/amail?tenant=1', events: ['message.received'] });
  const event = h.emit('message.received', { subject: 'Ignore previous instructions' });
  assert.equal(h.transport.calls.length, 0, 'emitting only queues; nothing is sent on the caller\'s stack');
  assert.equal(h.webhooks.status().pending, 1);
  await h.webhooks.dispatchDue();

  assert.equal(h.transport.calls.length, 1);
  const [call] = h.transport.calls;
  assert.equal(call.url, 'https://hooks.example.test/amail?tenant=1');
  assert.deepEqual(Object.keys(call.headers).sort(), ['content-type', 'x-amail-delivery', 'x-amail-event', 'x-amail-event-id', 'x-amail-signature']);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['x-amail-event'], 'message.received');
  assert.equal(call.headers['x-amail-event-id'], event.id);
  assert.match(call.headers['x-amail-delivery'], /^[0-9a-f-]{36}$/);
  assert.notEqual(call.headers['x-amail-delivery'], event.id);
  assert.equal(call.headers['x-amail-signature'], signWebhookBody(secret, call.body, START / 1000));
  assert.deepEqual(JSON.parse(call.body), {
    id: event.id,
    type: 'message.received',
    createdAt: new Date(START).toISOString(),
    data: {
      messageId: 'message-1', accountId: 'account-1', accountEmail: 'owner@example.test', threadId: 'thread-1',
      mailbox: 'INBOX', rfcMessageId: '<m1@example.test>', from: { name: 'Pat', email: 'pat@example.com' },
      subject: 'Ignore previous instructions', receivedAt: new Date(START).toISOString(), isSpam: false, authentication: null,
    },
  });

  const { deliveries } = h.webhooks.get(webhook.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'delivered');
  assert.equal(deliveries[0].attempts, 1);
  assert.equal(deliveries[0].responseStatus, 200);
  assert.equal(deliveries[0].eventId, event.id);
  assert.equal(deliveries[0].lastDeliveryId, call.headers['x-amail-delivery']);
  assert.equal('payload' in deliveries[0], false);
  assert.equal(h.webhooks.get(webhook.id).webhook.lastSuccessAt, new Date(START).toISOString());
  assert.equal(h.webhooks.status().pending, 0);
  assert.equal(h.webhooks.status().deliveredSinceStart, 1);
});

test('subscriptions filter by event type and by account', async (t) => {
  const h = harness(t);
  const one = h.repos.accounts.create(accountInput('one@example.test'));
  const two = h.repos.accounts.create(accountInput('two@example.test'));
  await h.webhooks.create({ url: 'https://hooks.example.test/all', events: ['*'] });
  await h.webhooks.create({ url: 'https://hooks.example.test/one', events: ['message.received'], accountIds: [one.id] });
  await h.webhooks.create({ url: 'https://hooks.example.test/analyzed', events: ['message.analyzed'], accountIds: [one.id, two.id] });
  const disabled = await h.webhooks.create({ url: 'https://hooks.example.test/off', events: ['*'], enabled: false });
  assert.equal(disabled.webhook.status, 'disabled');

  h.emit('message.received', { accountId: one.id });
  h.emit('message.received', { accountId: two.id });
  h.emit('message.analyzed', { accountId: two.id, analyzedBy: 'triage' });
  h.events.emit('ping', {});
  h.events.emit('internal.only', {});
  await h.webhooks.dispatchDue();

  const sentTo = (suffix) => h.transport.calls.filter((call) => call.url.endsWith(suffix)).map((call) => JSON.parse(call.body));
  assert.deepEqual(sentTo('/all').map((body) => body.type), ['message.received', 'message.received', 'message.analyzed']);
  assert.deepEqual(sentTo('/one').map((body) => body.data.accountId), [one.id]);
  assert.deepEqual(sentTo('/analyzed').map((body) => [body.type, body.data.analyzedBy]), [['message.analyzed', 'triage']]);
  assert.equal(sentTo('/off').length, 0);
});

test('failures retry on the documented schedule, which survives a restart, then fail for good', async (t) => {
  assert.deepEqual([...WEBHOOK_RETRY_DELAYS_MS], [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 360 * MINUTE]);
  assert.equal(WEBHOOK_MAX_ATTEMPTS, 6);
  assert.equal(webhookRetryDelayMs(1, () => 0.5), 1 * MINUTE);
  assert.equal(webhookRetryDelayMs(1, () => 0), 54_000);
  assert.equal(webhookRetryDelayMs(1, () => 1), 66_000);
  assert.equal(webhookRetryDelayMs(5, () => 0.5), 360 * MINUTE);
  assert.equal(webhookRetryDelayMs(6, () => 0.5), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhooks-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = harness(t, { dataDir: dir });
  first.transport.respond = () => ({ status: 503 });
  const { webhook, secret } = await first.webhooks.create({ url: 'https://hooks.example.test/amail', events: ['message.received'] });
  const event = first.emit();
  await first.webhooks.dispatchDue();
  let [delivery] = first.webhooks.get(webhook.id).deliveries;
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.error, 'http-503');
  assert.equal(delivery.nextAttemptAt, new Date(START + (1 * MINUTE)).toISOString());

  // Not due yet: another pass sends nothing.
  first.clock.now = START + 30_000;
  await first.webhooks.dispatchDue();
  assert.equal(first.transport.calls.length, 1);
  first.clock.now = START + (1 * MINUTE);
  first.transport.respond = () => new WebhookDeliveryError('timeout');
  await first.webhooks.dispatchDue();
  [delivery] = first.webhooks.get(webhook.id).deliveries;
  assert.equal(delivery.attempts, 2);
  assert.equal(delivery.error, 'timeout');
  assert.equal(delivery.nextAttemptAt, new Date(START + (6 * MINUTE)).toISOString());
  await first.close();

  // A new process on the same database picks the retry up where it was.
  const second = harness(t, { dataDir: dir });
  second.transport.respond = () => ({ status: 500 });
  second.clock.now = START + (5 * MINUTE);
  await second.webhooks.dispatchDue();
  assert.equal(second.transport.calls.length, 0, 'the persisted schedule is honoured after a restart');
  const expectedWaits = [6, 36, 156, 516];
  const deliveryIds = new Set();
  for (const [index, minutes] of expectedWaits.entries()) {
    second.clock.now = START + (minutes * MINUTE);
    await second.webhooks.dispatchDue();
    assert.equal(second.transport.calls.length, index + 1);
    const call = second.transport.calls[index];
    // Every attempt re-sends the same event id and body with a fresh delivery id and timestamp.
    assert.equal(call.headers['x-amail-event-id'], event.id);
    assert.equal(JSON.parse(call.body).id, event.id);
    assert.equal(verifyWebhookSignature(secret, call.body, call.headers['x-amail-signature'], { nowSeconds: second.clock.now / 1000 }), true);
    deliveryIds.add(call.headers['x-amail-delivery']);
  }
  assert.equal(deliveryIds.size, expectedWaits.length);
  [delivery] = second.webhooks.get(webhook.id).deliveries;
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attempts, WEBHOOK_MAX_ATTEMPTS);
  assert.equal(delivery.error, 'http-500');
  assert.equal(delivery.nextAttemptAt, null);
  const after = second.webhooks.get(webhook.id).webhook;
  assert.equal(after.consecutiveFailures, 1);
  assert.equal(after.status, 'active');
  assert.equal(after.lastError, 'http-500');
  second.clock.now += 24 * 60 * MINUTE;
  await second.webhooks.dispatchDue();
  assert.equal(second.transport.calls.length, expectedWaits.length, 'a failed delivery is never sent again');

  // A success resets the streak; a redirect counts as a failure.
  second.transport.respond = () => ({ status: 204 });
  second.emit();
  await second.webhooks.dispatchDue();
  assert.equal(second.webhooks.get(webhook.id).webhook.consecutiveFailures, 0);
  second.transport.respond = () => ({ status: 301 });
  second.emit();
  await second.webhooks.dispatchDue();
  assert.equal(second.webhooks.get(webhook.id).deliveries[0].error, 'redirect-not-followed-301');
});

test('a subscription is switched off after consecutive failed events and can be re-enabled', async (t) => {
  const h = harness(t, { configExtra: { webhookMaxConsecutiveFailures: 2 } });
  h.transport.respond = () => ({ status: 500 });
  const { webhook } = await h.webhooks.create({ url: 'https://hooks.example.test/amail', events: ['message.received'] });
  const healthy = await h.webhooks.create({ url: 'https://hooks.example.test/healthy', events: ['message.sent'] });
  h.emit();
  h.emit();
  h.emit();
  // Walk the clock through every retry of all three events.
  for (let step = 0; step < 80 && h.webhooks.get(webhook.id).webhook.enabled; step += 1) {
    await h.webhooks.dispatchDue();
    h.clock.now += 30 * MINUTE;
  }
  const off = h.webhooks.get(webhook.id);
  assert.equal(off.webhook.enabled, false);
  assert.equal(off.webhook.status, 'auto-disabled');
  assert.equal(off.webhook.disabledReason, 'consecutive-failures');
  assert.equal(off.webhook.consecutiveFailures, 2);
  assert.ok(off.webhook.disabledAt);
  assert.equal(off.webhook.pendingDeliveries, 0);
  assert.deepEqual(off.deliveries.map((item) => item.status), ['failed', 'failed', 'failed']);
  assert.ok(off.deliveries.some((item) => item.error === 'subscription-disabled'), 'the event still queued is closed, not left pending');
  assert.ok(h.logs.some((entry) => entry.message === 'Webhook subscription switched off' && entry.fields.reason === 'consecutive-failures'));
  assert.equal(h.webhooks.list().find((item) => item.id === webhook.id).status, 'auto-disabled');
  assert.deepEqual(
    (({ subscriptions, active, disabled, autoDisabled }) => ({ subscriptions, active, disabled, autoDisabled }))(h.webhooks.status()),
    { subscriptions: 2, active: 1, disabled: 1, autoDisabled: 1 },
  );
  assert.equal(h.webhooks.get(healthy.webhook.id).webhook.status, 'active');

  // While off, new events are not queued for it.
  const before = h.transport.calls.length;
  h.emit();
  await h.webhooks.dispatchDue();
  assert.equal(h.transport.calls.length, before);

  h.transport.respond = () => ({ status: 200 });
  const revived = await h.webhooks.update(webhook.id, { enabled: true });
  assert.equal(revived.webhook.status, 'active');
  assert.equal(revived.webhook.consecutiveFailures, 0);
  h.emit();
  await h.webhooks.dispatchDue();
  assert.equal(h.transport.calls.length, before + 1);

  // 410 Gone switches a subscription off at once.
  h.transport.respond = () => ({ status: 410 });
  h.emit();
  await h.webhooks.dispatchDue();
  assert.equal(h.webhooks.get(webhook.id).webhook.disabledReason, 'gone');

  // Disabling by hand is reported as disabled, not auto-disabled.
  const manual = await h.webhooks.update(healthy.webhook.id, { enabled: false });
  assert.equal(manual.webhook.status, 'disabled');
  assert.equal(manual.webhook.disabledReason, 'manual');
});

test('the queue is bounded per subscription: the oldest undelivered events are dropped and counted', async (t) => {
  const h = harness(t, { configExtra: { webhookMaxQueue: 3, webhookDeliveryLogSize: 4 } });
  const { webhook } = await h.webhooks.create({ url: 'https://hooks.example.test/amail', events: ['message.received'] });
  const other = await h.webhooks.create({ url: 'https://hooks.example.test/other', events: ['message.sent'] });
  const emitted = [];
  for (let index = 0; index < 8; index += 1) {
    h.clock.now += 1_000;
    emitted.push(h.emit('message.received', { messageId: `message-${index}` }));
  }
  const queued = h.webhooks.get(webhook.id);
  assert.equal(queued.webhook.pendingDeliveries, 3);
  assert.equal(queued.webhook.droppedCount, 5);
  assert.ok(h.logs.some((entry) => /Webhook queue is full/.test(entry.message)));
  assert.equal(h.webhooks.get(other.webhook.id).webhook.droppedCount, 0);

  await h.webhooks.dispatchDue();
  // Only the three newest events were sent, oldest of those first.
  assert.deepEqual(h.transport.calls.map((call) => JSON.parse(call.body).data.messageId), ['message-5', 'message-6', 'message-7']);
  assert.equal(h.webhooks.status().dropped, 5);
  assert.equal(h.webhooks.status().pending, 0);
  // The log is pruned to the newest N finished deliveries.
  const log = h.webhooks.get(webhook.id).deliveries;
  assert.equal(log.length, 4);
  assert.deepEqual(log.map((item) => item.status), ['delivered', 'delivered', 'delivered', 'dropped']);
  assert.equal(log.at(-1).error, 'queue-full');
  assert.equal(emitted.length, 8);
});

test('one static subscription comes from the environment and follows it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhooks-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    webhookUrl: 'https://mcc.example.test/hooks/amail',
    webhookSecret: 'environment-shared-secret-value',
    webhookEvents: ['message.received'],
  };
  const first = harness(t, { dataDir: dir, configExtra: env });
  const [webhook] = first.webhooks.list();
  assert.equal(webhook.id, ENV_WEBHOOK_ID);
  assert.equal(webhook.source, 'env');
  assert.equal(webhook.url, 'https://mcc.example.test/hooks/amail');
  assert.deepEqual(webhook.events, ['message.received']);
  assert.equal(first.repos.webhooks.get(ENV_WEBHOOK_ID).secret_ciphertext, '', 'the environment secret is not copied into the database');

  first.emit('message.sent');
  const event = first.emit('message.received');
  await first.webhooks.dispatchDue();
  assert.equal(first.transport.calls.length, 1);
  const [call] = first.transport.calls;
  assert.equal(call.headers['x-amail-event-id'], event.id);
  assert.equal(verifyWebhookSignature(env.webhookSecret, call.body, call.headers['x-amail-signature'], { nowSeconds: START / 1000 }), true);

  // It is managed in the environment: only enabled can change over the API.
  await assert.rejects(first.webhooks.update(ENV_WEBHOOK_ID, { url: 'https://elsewhere.example.test/' }), { code: 'CONFLICT' });
  await assert.rejects(first.webhooks.update(ENV_WEBHOOK_ID, { rotateSecret: true }), { code: 'CONFLICT' });
  assert.throws(() => first.webhooks.remove(ENV_WEBHOOK_ID), { code: 'CONFLICT' });
  assert.equal((await first.webhooks.update(ENV_WEBHOOK_ID, { enabled: false })).webhook.status, 'disabled');
  await first.close();

  // Restart with new events: the row follows, and stays disabled because the URL is the same.
  const second = harness(t, { dataDir: dir, configExtra: { ...env, webhookEvents: ['message.received', 'message.analyzed'] } });
  assert.deepEqual(second.webhooks.list()[0].events, ['message.received', 'message.analyzed']);
  assert.equal(second.webhooks.list()[0].enabled, false);
  await second.close();

  // A different URL starts clean; removing the variable removes the subscription.
  const third = harness(t, { dataDir: dir, configExtra: { ...env, webhookUrl: 'https://mcc.example.test/hooks/v2' } });
  assert.equal(third.webhooks.list()[0].url, 'https://mcc.example.test/hooks/v2');
  assert.equal(third.webhooks.list()[0].enabled, true);
  await third.close();
  const fourth = harness(t, { dataDir: dir });
  assert.deepEqual(fourth.webhooks.list(), []);
  assert.equal(fourth.webhooks.status().enabled, false);
  await fourth.close();

  // An unsigned or unsafe environment webhook is refused, loudly, and nothing is sent.
  for (const bad of [
    { webhookUrl: 'https://mcc.example.test/hooks/amail', webhookSecret: null },
    { webhookUrl: 'https://mcc.example.test/hooks/amail', webhookSecret: 'short' },
    { webhookUrl: 'http://mcc.example.test/hooks/amail', webhookSecret: env.webhookSecret },
    { webhookUrl: 'https://192.168.1.5/hooks/amail', webhookSecret: env.webhookSecret },
  ]) {
    const refused = harness(t, { dataDir: dir, configExtra: bad });
    assert.deepEqual(refused.webhooks.list(), []);
    assert.ok(refused.logs.some((entry) => entry.level === 'error'));
    await refused.close();
  }
  // With the host allowlisted, a LAN receiver over http is accepted.
  const lan = harness(t, {
    dataDir: dir,
    transport: fakeTransport({ allowHosts: ['192.168.1.5'] }),
    configExtra: { webhookUrl: 'http://192.168.1.5:8080/hooks/amail', webhookSecret: env.webhookSecret, webhookAllowHosts: ['192.168.1.5'] },
  });
  assert.equal(lan.webhooks.list()[0].url, 'http://192.168.1.5:8080/hooks/amail');
});

test('test sends one signed ping that is logged but neither retried nor counted', async (t) => {
  const h = harness(t);
  const { webhook, secret } = await h.webhooks.create({ url: 'https://hooks.example.test/amail', events: ['message.received'] });
  const ok = await h.webhooks.test(webhook.id);
  assert.equal(ok.ok, true);
  assert.equal(ok.responseStatus, 200);
  assert.equal(ok.error, null);
  const [call] = h.transport.calls;
  assert.equal(call.headers['x-amail-event'], 'ping');
  assert.equal(call.headers['x-amail-event-id'], ok.eventId);
  assert.equal(call.headers['x-amail-delivery'], ok.deliveryId);
  assert.equal(verifyWebhookSignature(secret, call.body, call.headers['x-amail-signature'], { nowSeconds: START / 1000 }), true);
  assert.deepEqual(JSON.parse(call.body), {
    id: ok.eventId, type: 'ping', createdAt: new Date(START).toISOString(),
    data: { webhookId: webhook.id, message: 'aMail webhook test' },
  });

  h.transport.respond = () => new WebhookDeliveryError('connection-failed');
  const failed = await h.webhooks.test(webhook.id);
  assert.deepEqual([failed.ok, failed.responseStatus, failed.error], [false, null, 'connection-failed']);
  h.clock.now += 24 * 60 * MINUTE;
  await h.webhooks.dispatchDue();
  assert.equal(h.transport.calls.length, 2, 'a ping is never retried');
  const view = h.webhooks.get(webhook.id);
  assert.equal(view.webhook.consecutiveFailures, 0);
  assert.deepEqual(view.deliveries.map((item) => [item.eventType, item.status]), [['ping', 'failed'], ['ping', 'delivered']]);
  await assert.rejects(h.webhooks.test('missing'), { code: 'NOT_FOUND' });
});

test('the number of subscriptions is capped and a missing encryption key fails closed', async (t) => {
  const h = harness(t);
  for (let index = 0; index < MAX_WEBHOOK_SUBSCRIPTIONS; index += 1) {
    await h.webhooks.create({ url: `https://hooks.example.test/${index}`, events: ['*'] });
  }
  await assert.rejects(h.webhooks.create({ url: 'https://hooks.example.test/more', events: ['*'] }), { code: 'CONFLICT' });

  const keyless = harness(t, { configExtra: { credentialKey: null } });
  await assert.rejects(keyless.webhooks.create({ url: 'https://hooks.example.test/x', events: ['*'] }), { code: 'CREDENTIAL_ENCRYPTION_UNAVAILABLE' });
  assert.equal(keyless.transport.calls.length, 0);
});

test('events are sent by the background dispatcher, never on the emitting call', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-webhooks-auto-'));
  const config = { dataDir: dir, dbPath: path.join(dir, 'mail.sqlite'), credentialKey };
  const repos = createRepositories(createDatabase(config));
  const events = createMessageEvents({ repos, config });
  const transport = fakeTransport();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let delivered;
  const done = new Promise((resolve) => { delivered = resolve; });
  transport.respond = async () => {
    await gate;
    delivered();
    return { status: 200 };
  };
  const webhooks = createWebhookService({ config, repos, events, transport });
  webhooks.start();
  t.after(async () => {
    await webhooks.close();
    events.close();
    repos.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await webhooks.create({ url: 'https://hooks.example.test/amail', events: ['message.received'] });
  // The receiver is hanging, yet emit returns at once with the event queued.
  const event = events.emit('message.received', { messageId: 'm', accountId: 'a' });
  assert.ok(event.id);
  assert.equal(transport.calls.length, 0);
  release();
  await done;
  assert.equal(transport.calls.length, 1);
});
