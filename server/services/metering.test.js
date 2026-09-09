import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { loadConfig } from '../config.js';
import { createMailService } from './mail-service.js';
import { createMeteringService } from './metering.js';

function fakeFetch({ fail = () => false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (fail(calls.length)) return { ok: false, status: 503 };
    return { ok: true, status: 200 };
  };
  return { impl, calls };
}

test('metering is a no-op unless AMAIL_METERING_URL is configured', async () => {
  assert.equal(loadConfig({}).meteringUrl, null);
  assert.equal(loadConfig({ AMAIL_METERING_URL: 'not a url' }).meteringUrl, null);
  assert.equal(loadConfig({ AMAIL_METERING_URL: 'ftp://meter.example.test/x' }).meteringUrl, null);
  assert.equal(loadConfig({ AMAIL_METERING_URL: 'https://meter.example.test/v1/events' }).meteringUrl, 'https://meter.example.test/v1/events');
  assert.equal(loadConfig({ AMAIL_TENANT_ID: '  tenant-42 ' }).tenantId, 'tenant-42');

  const { impl, calls } = fakeFetch();
  const metering = createMeteringService({ config: loadConfig({}), fetchImpl: impl });
  assert.equal(metering.enabled, false);
  metering.recordAnalyzed(5);
  await metering.flush();
  await metering.close();
  assert.equal(calls.length, 0);
  assert.equal(metering.pendingCount(), 0);
});

test('analyzed marks are batched into count-only events with a bearer token', async () => {
  const { impl, calls } = fakeFetch();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 9, 12, 0, tick++));
  const metering = createMeteringService({
    config: {
      meteringUrl: 'https://meter.example.test/v1/events',
      meteringToken: 'meter-secret',
      tenantId: 'tenant-42',
      releaseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    fetchImpl: impl,
    now,
    flushIntervalMs: 60_000,
  });
  assert.equal(metering.enabled, true);
  metering.recordAnalyzed();
  metering.recordAnalyzed(2);
  metering.recordAnalyzed(0);
  metering.recordAnalyzed(-4);
  assert.equal(metering.pendingCount(), 3);
  await metering.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://meter.example.test/v1/events');
  assert.equal(calls[0].headers.authorization, 'Bearer meter-secret');
  assert.equal(calls[0].body.tenant, 'tenant-42');
  assert.equal(calls[0].body.release, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(calls[0].body.events.length, 1);
  assert.equal(calls[0].body.events[0].type, 'analyzed');
  assert.equal(calls[0].body.events[0].count, 3);
  assert.match(calls[0].body.events[0].at, /^2026-09-09T12:00:00/);
  const serialized = JSON.stringify(calls[0].body);
  for (const forbidden of ['messageId', 'subject', 'from', 'by', '@']) {
    assert.equal(serialized.includes(forbidden), false, `payload must not carry ${forbidden}`);
  }
  assert.equal(metering.pendingCount(), 0);
  await metering.close();
});

test('failed deliveries stay queued and are retried in order', async () => {
  const { impl, calls } = fakeFetch({ fail: (attempt) => attempt === 1 });
  const warnings = [];
  const metering = createMeteringService({
    config: { meteringUrl: 'https://meter.example.test/v1/events' },
    fetchImpl: impl,
    logger: { warn: (details) => warnings.push(details), error() {}, info() {} },
    flushIntervalMs: 60_000,
  });
  metering.recordAnalyzed(2);
  await metering.flush();
  assert.equal(calls.length, 1);
  assert.equal(metering.pendingCount(), 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].status, 503);

  metering.recordAnalyzed(1);
  await metering.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.events.map((event) => event.count), [2, 1]);
  assert.equal(metering.pendingCount(), 0);
  await metering.close();
});

test('the analyzed transition is metered once per message and never on re-marks', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-metering-'));
  const config = { dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), credentialKey: Buffer.alloc(32, 9), syncBatchSize: 50 };
  const repos = createRepositories(createDatabase(config));
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const recorded = [];
  const metering = { enabled: true, recordAnalyzed: (count) => recorded.push(count) };
  const mailService = createMailService({ config, repos, logger: { warn() {}, info() {} }, metering });

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
    credential_ciphertext: 'unused',
    signature: '',
    sync_enabled: 1,
  });
  const thread = repos.threads.create({ account_id: account.id, subject: 'Hi', normalized_subject: 'hi', latest_at: '2026-01-01T00:00:00.000Z' });
  const message = repos.messages.upsert({
    account_id: account.id,
    thread_id: thread.id,
    mailbox: 'INBOX',
    uid: 1,
    rfc_message_id: '<m1@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Hi',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-01-01T00:00:00.000Z',
    received_at: '2026-01-01T00:00:00.000Z',
    html_body: '',
    text_body: 'Hi',
    snippet: 'Hi',
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

  await mailService.updateMessageState(message.id, { isRead: true });
  assert.deepEqual(recorded, []);
  await mailService.updateMessageState(message.id, { isAnalyzed: true, analyzedBy: 'triage-agent' });
  assert.deepEqual(recorded, [1]);
  await mailService.updateMessageState(message.id, { isAnalyzed: true, analyzedBy: 'other-agent' });
  assert.deepEqual(recorded, [1]);
  await mailService.updateMessageState(message.id, { isAnalyzed: false });
  assert.deepEqual(recorded, [1]);
  await mailService.updateMessageState(message.id, { isAnalyzed: true });
  assert.deepEqual(recorded, [1, 1]);
});
