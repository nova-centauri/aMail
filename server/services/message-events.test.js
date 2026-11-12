import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { encryptJson } from './crypto.js';
import { createMailService } from './mail-service.js';
import { createFakeImapServer } from './fake-imap.test-support.js';
import { createMailboxEventHub } from './mailbox-events.js';
import { createMessageEvents, MESSAGE_EVENT_TYPES, receivedSuppression } from './message-events.js';
import { createSyncIngest } from './sync-ingest.js';
import { loadConfig } from '../config.js';

const credentialKey = Buffer.alloc(32, 9);
// The fake IMAP server stamps every message with this INTERNALDATE.
const FAKE_INTERNAL_DATE = Date.parse('2026-10-29T15:27:13.000Z');
const HOUR = 60 * 60 * 1000;

function raw(id, { subject = 'Freight quote', from = 'Pat <pat@example.com>', headers = [] } = {}) {
  return [
    ...headers,
    `From: ${from}`,
    'To: Owner <owner@example.test>',
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.test>`,
    'Date: Thu, 29 Oct 2026 15:27:13 +0000',
    '',
    'Hello there.',
    '',
  ].join('\r\n');
}

function harness(t, { nowMs = FAKE_INTERNAL_DATE + HOUR, provider = 'custom', configExtra = {}, folders } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-events-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey,
    syncTimeoutMs: 5_000,
    syncBatchSize: 50,
    imapPoolIdleMs: 0,
    syncMinIntervalMs: 0,
    ...configExtra,
  };
  const repos = createRepositories(createDatabase(config));
  const clock = { now: nowMs };
  const events = createMessageEvents({ repos, config, now: () => clock.now });
  const seen = [];
  events.on('*', (event) => seen.push(event));
  const imap = createFakeImapServer(folders ? { folders } : undefined);
  const service = createMailService({
    config,
    repos,
    events,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ImapClient: imap.FakeImapClient,
    createSmtpTransport: () => ({
      async sendMail(payload) {
        return { accepted: payload.envelope.to, rejected: [] };
      },
      close() {},
    }),
  });
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', color: '#1a73e8', provider,
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: encryptJson({ username: 'owner@example.test', password: 'test-only' }, credentialKey),
    signature: '', sync_enabled: 1,
  });
  t.after(async () => {
    await service.close?.().catch(() => {});
    events.close();
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const ofType = (type) => seen.filter((event) => event.type === type);
  return { repos, service, events, imap: imap.state, account, seen, ofType, clock, config };
}

test('the event catalogue names the three message events', () => {
  assert.deepEqual(Object.keys(MESSAGE_EVENT_TYPES), ['message.received', 'message.sent', 'message.analyzed']);
  assert.equal(loadConfig({}).eventRecencyMs, 24 * HOUR);
  assert.equal(loadConfig({ AMAIL_EVENT_RECENCY_HOURS: '72' }).eventRecencyMs, 72 * HOUR);
  assert.equal(loadConfig({ AMAIL_EVENT_RECENCY_HOURS: '0' }).eventRecencyMs, 24 * HOUR);
});

test('message.received fires once for a new inbound message and never for a re-sync or a flag change', async (t) => {
  const h = harness(t, { provider: 'gmail' });
  h.imap.seed('INBOX', raw('new-1', {
    subject: 'Invoice 42',
    headers: [
      'Return-Path: <bounce@example.com>',
      'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=bounce@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
    ],
  }));
  await h.service.syncAccount(h.account.id);

  const received = h.ofType('message.received');
  assert.equal(received.length, 1);
  const [event] = received;
  const stored = h.repos.messages.findByRfcId(h.account.id, '<new-1@example.test>');
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  assert.equal(event.createdAt, new Date(h.clock.now).toISOString());
  assert.deepEqual(event.data, {
    messageId: stored.id,
    accountId: h.account.id,
    accountEmail: 'owner@example.test',
    threadId: stored.threadId,
    mailbox: 'INBOX',
    rfcMessageId: '<new-1@example.test>',
    from: { name: 'Pat', email: 'pat@example.com' },
    subject: 'Invoice 42',
    receivedAt: '2026-10-29T15:27:13.000Z',
    isSpam: false,
    authentication: {
      spf: 'pass', dkim: 'pass', dmarc: 'pass', authservId: 'mx.google.com', trusted: true,
      fromAligned: true, dkimDomains: ['example.com'], returnPath: 'bounce@example.com',
    },
  });
  // No body, snippet, recipients or attachments ride along.
  assert.equal(JSON.stringify(event).includes('Hello there'), false);

  // The same UID again (a full re-sync) is an update, not a new row.
  await h.service.syncAccount(h.account.id, { mode: 'full', force: true });
  // A flag change, a claim and an analyzed mark are updates too.
  await h.service.updateMessageState(stored.id, { isRead: true });
  h.repos.messages.claim({ claimant: 'triage', ids: [stored.id], leaseMs: 60_000 });
  assert.equal(h.ofType('message.received').length, 1);
});

test('sent mail, drafts, trash and second copies of a message are not announced; spam is, flagged', async (t) => {
  const h = harness(t, {
    folders: [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
      { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
      { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
      { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
    ],
  });
  h.imap.seed('Sent', raw('sent-1', { from: 'Owner <owner@example.test>' }));
  h.imap.seed('Drafts', raw('draft-1', { from: 'Owner <owner@example.test>' }), ['\\Draft']);
  h.imap.seed('Trash', raw('trash-1'));
  h.imap.seed('Junk', raw('spam-1', { subject: 'You won' }));
  h.imap.seed('INBOX', raw('both-1'));
  h.imap.seed('Archive', raw('both-1'));
  await h.service.syncAccount(h.account.id);

  const received = h.ofType('message.received');
  assert.deepEqual(received.map((event) => [event.data.rfcMessageId, event.data.mailbox, event.data.isSpam]).sort(), [
    ['<both-1@example.test>', 'INBOX', false],
    ['<spam-1@example.test>', 'Junk', true],
  ]);
  // Sent and draft rows are stored without an authentication verdict.
  assert.equal(h.repos.messages.findByRfcId(h.account.id, '<sent-1@example.test>').authentication, null);
  assert.equal(h.repos.messages.findByRfcId(h.account.id, '<draft-1@example.test>').authentication, null);
  assert.deepEqual(h.repos.messages.findByRfcId(h.account.id, '<spam-1@example.test>').authentication, {
    spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', authservId: null, trusted: false,
    fromAligned: false, dkimDomains: [], returnPath: null,
  });
});

test('a first sync of old mail is suppressed by the recency window, and later arrivals still fire', async (t) => {
  // 30 hours after the fake server's INTERNALDATE: outside the default 24h window.
  const h = harness(t, { nowMs: FAKE_INTERNAL_DATE + (30 * HOUR) });
  for (let index = 0; index < 25; index += 1) h.imap.seed('INBOX', raw(`old-${index}`));
  await h.service.syncAccount(h.account.id);
  assert.equal(h.repos.messages.list({ accountId: h.account.id, folder: 'inbox' }).total, 25);
  assert.equal(h.ofType('message.received').length, 0);
  assert.deepEqual(h.events.stats(), { emitted: 0, suppressed: 25, suppressedBackfill: 25 });

  // The same import inside the window announces every message.
  const recent = harness(t, { nowMs: FAKE_INTERNAL_DATE + (2 * HOUR) });
  for (let index = 0; index < 3; index += 1) recent.imap.seed('INBOX', raw(`fresh-${index}`));
  await recent.service.syncAccount(recent.account.id);
  assert.equal(recent.ofType('message.received').length, 3);

  // A wider window (AMAIL_EVENT_RECENCY_HOURS) admits the older mail.
  const wide = harness(t, { nowMs: FAKE_INTERNAL_DATE + (30 * HOUR), configExtra: { eventRecencyMs: 48 * HOUR } });
  wide.imap.seed('INBOX', raw('wide-1'));
  await wide.service.syncAccount(wide.account.id);
  assert.equal(wide.ofType('message.received').length, 1);
});

test('the suppression rule is explicit about each reason', () => {
  const base = { isSent: false, isDraft: false, isTrashed: false, sourceImported: true, receivedAt: '2026-10-29T15:00:00.000Z' };
  const at = { nowMs: Date.parse('2026-10-29T16:00:00.000Z'), recencyMs: 24 * HOUR };
  assert.equal(receivedSuppression(base, { copy: false }, at), null);
  assert.equal(receivedSuppression(null, {}, at), 'missing');
  assert.equal(receivedSuppression(base, { copy: true }, at), 'copy');
  assert.equal(receivedSuppression({ ...base, isSent: true }, {}, at), 'sent');
  assert.equal(receivedSuppression({ ...base, isDraft: true }, {}, at), 'draft');
  assert.equal(receivedSuppression({ ...base, isTrashed: true }, {}, at), 'trash');
  assert.equal(receivedSuppression({ ...base, sourceImported: false }, {}, at), 'envelope-only');
  assert.equal(receivedSuppression({ ...base, receivedAt: '2026-10-27T00:00:00.000Z' }, {}, at), 'backfill');
});

test('a write that rolls back is never announced, and a batch announces only after it commits', async (t) => {
  const h = harness(t);
  const thread = h.repos.threads.create({ account_id: h.account.id, subject: 'Batch', normalized_subject: 'batch', latest_at: new Date(h.clock.now).toISOString() });
  const input = (uid) => ({
    account_id: h.account.id, thread_id: thread.id, mailbox: 'INBOX', uid,
    rfc_message_id: `<batch-${uid}@example.test>`, in_reply_to: null, references_json: '[]',
    subject: `Batch ${uid}`, from_name: '', from_email: 'pat@example.com',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: new Date(h.clock.now).toISOString(), received_at: new Date(h.clock.now).toISOString(),
    html_body: '', text_body: '', snippet: '', attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, snoozed_until: null, is_sent: 0,
  });
  assert.throws(() => h.repos.runWriteBatch(() => {
    h.repos.messages.upsert(input(1));
    assert.equal(h.ofType('message.received').length, 0, 'nothing is announced inside the transaction');
    throw new Error('batch failed');
  }), /batch failed/);
  assert.equal(h.repos.messages.findByUid(h.account.id, 'INBOX', 1), null);
  assert.equal(h.ofType('message.received').length, 0);

  h.repos.runWriteBatch(() => {
    h.repos.messages.upsert(input(2));
    h.repos.messages.upsert(input(3));
  });
  assert.equal(h.ofType('message.received').length, 2);
  // An envelope-only search hit is not announced until its source arrives.
  h.repos.messages.upsert({ ...input(4), source_imported: 0 });
  assert.equal(h.ofType('message.received').length, 2);
  h.repos.messages.upsert({ ...input(4), source_imported: 1 });
  assert.equal(h.ofType('message.received').length, 3);
});

test('message.sent and message.analyzed fire on the transition only', async (t) => {
  const h = harness(t);
  const sent = await h.service.sendMessage({
    accountId: h.account.id,
    to: ['pat@example.com'],
    subject: 'Quote attached',
    textBody: 'See attached.',
  });
  const [sentEvent] = h.ofType('message.sent');
  assert.equal(h.ofType('message.sent').length, 1);
  assert.equal(sentEvent.data.messageId, sent.id);
  assert.equal(sentEvent.data.accountEmail, 'owner@example.test');
  assert.equal(sentEvent.data.subject, 'Quote attached');
  assert.equal(sentEvent.data.authentication, null);
  assert.ok(sentEvent.data.sentAt);
  assert.equal(h.ofType('message.received').length, 0);

  h.imap.seed('INBOX', raw('review-1'));
  await h.service.syncAccount(h.account.id);
  const message = h.repos.messages.findByRfcId(h.account.id, '<review-1@example.test>');
  await h.service.updateMessageState(message.id, { isAnalyzed: true, analyzedBy: 'triage-agent' });
  await h.service.updateMessageState(message.id, { isAnalyzed: true, analyzedBy: 'someone-else' });
  await h.service.updateMessageState(message.id, { isRead: true });
  const analyzed = h.ofType('message.analyzed');
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].data.messageId, message.id);
  assert.equal(analyzed[0].data.analyzedBy, 'triage-agent');
  assert.ok(analyzed[0].data.analyzedAt);
});

test('a failing subscriber cannot break ingestion or other subscribers', async (t) => {
  const h = harness(t);
  h.events.on('message.received', () => {
    throw new Error('subscriber bug');
  });
  const after = [];
  h.events.on('message.received', (event) => after.push(event));
  h.imap.seed('INBOX', raw('robust-1'));
  const result = await h.service.syncAccount(h.account.id);
  assert.equal(result.mailboxes.find((item) => item.mailbox === 'INBOX').imported, 1);
  assert.equal(after.length, 1);
});

test('rows created on the sync worker thread are announced on the main thread', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-events-worker-'));
  const config = { env: 'production', dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), syncWorker: true };
  const repos = createRepositories(createDatabase(config));
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', color: '#1a73e8', provider: 'custom',
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'ciphertext', signature: '', sync_enabled: 1,
  });
  const events = createMessageEvents({ repos, config, now: () => FAKE_INTERNAL_DATE + HOUR });
  const received = [];
  events.on('message.received', (event) => received.push(event));
  const ingest = createSyncIngest({
    config,
    onWrites: (writes) => writes.forEach((write) => repos.messageWrites.publish(write)),
  });
  t.after(async () => {
    await ingest.close();
    events.close();
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const job = (uid) => ({
    source: Buffer.from(raw('worker-1', {
      headers: ['Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=pat@example.com; dkim=none'],
    })),
    account: { id: account.id },
    trustedAuthservIds: ['mx.example.net'],
    mailbox: 'INBOX',
    role: 'inbox',
    allMailMirror: false,
    message: { uid, flags: [], labels: [], envelope: null, internalDate: new Date(FAKE_INTERNAL_DATE) },
  });
  const first = await ingest.ingest(job(1));
  assert.equal(first.ok, true);
  assert.equal(first.imported, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].data.rfcMessageId, '<worker-1@example.test>');
  assert.deepEqual(received[0].data.authentication, {
    spf: 'pass', dkim: 'none', dmarc: 'none', authservId: 'mx.example.net', trusted: true,
    fromAligned: true, dkimDomains: [], returnPath: null,
  });
  // The same UID again is an update inside the worker: nothing new to announce.
  await ingest.ingest(job(1));
  assert.equal(received.length, 1);
});

test('the SSE hub adds a message.received frame with ids and keeps the existing refetch events', async (t) => {
  const h = harness(t);
  const hub = createMailboxEventHub({ repos: h.repos, mailService: h.service, messageEvents: () => h.service.events, coalesceMs: 1_000 });
  const frames = [];
  const unsubscribe = hub.subscribe((frame) => frames.push(frame));
  t.after(() => {
    unsubscribe();
    hub.close();
  });
  h.imap.seed('INBOX', raw('sse-1'));
  await h.service.syncAccount(h.account.id);
  const stored = h.repos.messages.findByRfcId(h.account.id, '<sse-1@example.test>');
  const [event] = h.ofType('message.received');

  const received = frames.filter((frame) => frame.event === 'message.received');
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0].data).sort(), ['accountId', 'changedAt', 'id', 'messageId', 'receivedAt', 'threadId']);
  assert.equal(received[0].data.id, event.id);
  assert.equal(received[0].data.messageId, stored.id);
  assert.equal(received[0].data.accountId, h.account.id);
  assert.equal(received[0].data.threadId, stored.threadId);
  assert.equal(received[0].data.receivedAt, '2026-10-29T15:27:13.000Z');
  assert.ok(received[0].data.changedAt);
  assert.ok(Number.isInteger(received[0].id));
  // Existing consumers still get their names, with only { changedAt }. Those
  // are coalesced, so give the quiet window time to flush.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  for (const name of ['change-version', 'new-mail', 'message.new']) {
    const frame = frames.find((item) => item.event === name);
    assert.ok(frame, name);
    assert.deepEqual(Object.keys(frame.data), ['changedAt']);
  }
  // Replay covers the new frame like any other.
  assert.ok(hub.replaySince(received[0].id - 1).events.some((item) => item.event === 'message.received'));

  // After the last client leaves, the hub stops listening.
  unsubscribe();
  h.imap.seed('INBOX', raw('sse-2'));
  await h.service.syncAccount(h.account.id);
  assert.equal(frames.filter((frame) => frame.event === 'message.received').length, 1);
});
