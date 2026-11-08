import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createMailService, REMOTE_OP_MAX_ATTEMPTS, remoteOpDelayMs } from './mail-service.js';
import { encryptJson } from './crypto.js';
import { createFakeImapServer } from './fake-imap.test-support.js';

const credentialKey = Buffer.alloc(32, 7);

const folders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
];

function raw(id, subject = 'Quote follow-up') {
  return [
    'From: Pat <pat@example.test>',
    'To: Owner <owner@example.test>',
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.test>`,
    'Date: Thu, 29 Oct 2026 15:27:13 +0000',
    '',
    'Hello there.',
    '',
  ].join('\r\n');
}

async function harness(t, { condstore = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-remote-ops-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey,
    syncTimeoutMs: 5_000,
    syncBatchSize: 50,
    imapPoolIdleMs: 0,
  };
  const db = createDatabase(config);
  const repos = createRepositories(db);
  const server = createFakeImapServer({ folders, condstore });
  const service = createMailService({
    config,
    repos,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ImapClient: server.FakeImapClient,
  });
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', color: '#1a73e8', provider: 'custom',
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: encryptJson({ username: 'owner@example.test', password: 'test-only' }, credentialKey),
    signature: '', sync_enabled: 1,
  });
  t.after(async () => {
    await service.close?.().catch(() => {});
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, repos, service, imap: server.state, account };
}

async function importedInboxMessage({ repos, service, imap, account }, id = 'm1') {
  imap.seed('INBOX', raw(id));
  await service.syncAccount(account.id);
  const message = repos.messages.findByRfcId(account.id, `<${id}@example.test>`);
  assert.ok(message, 'message imported');
  assert.equal(message.mailbox, 'INBOX');
  return message;
}

// Push every queued change's next attempt into the past so a retry runs now.
function makeDue(db) {
  db.prepare("UPDATE remote_ops SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
}

test('a failed archive is queued and pushed to the server by a later retry', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('connection reset');
  const result = await h.service.updateMessageState(message.id, { isArchived: true });

  assert.equal(result.isArchived, true, 'local state still changes');
  assert.equal(result.remoteSync.status, 'queued');
  assert.ok(result.remoteSync.retryAt);
  const queued = h.repos.remoteOps.get(message.id);
  assert.deepEqual(queued.fields, ['placement']);
  assert.equal(queued.status, 'pending');
  assert.equal(h.imap.messages('INBOX').length, 1, 'server still has it in the inbox');

  // Not due yet: a retry before the backoff leaves it alone.
  const early = await h.service.retryRemoteOps(h.account.id);
  assert.equal(early.attempted, 0);

  h.imap.failures.move = null;
  makeDue(h.db);
  const retried = await h.service.retryRemoteOps(h.account.id);

  assert.equal(retried.synced, 1);
  assert.equal(h.repos.remoteOps.get(message.id), null);
  assert.equal(h.imap.messages('INBOX').length, 0);
  assert.equal(h.imap.messages('Archive').length, 1);
  assert.equal(h.repos.messages.get(message.id).mailbox, 'Archive');
});

test('archive then undo while the server is down leaves nothing owed', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('timeout');
  await h.service.updateMessageState(message.id, { isArchived: true });
  assert.equal(h.repos.remoteOps.list().length, 1);
  // The undo needs no move (the server copy never left the inbox), so it
  // settles the queued archive instead of replaying it later.
  const undone = await h.service.updateMessageState(message.id, { isArchived: false });

  assert.equal(undone.remoteSync.reason, 'already-in-destination');
  assert.equal(h.repos.remoteOps.get(message.id), null);
  h.imap.failures.move = null;
  makeDue(h.db);
  await h.service.retryRemoteOps(h.account.id);
  assert.deepEqual(h.imap.moves, []);
  assert.equal(h.imap.messages('INBOX').length, 1);
});

test('two failures for one message merge into one retry of the latest state', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('timeout');
  h.imap.failures.flags = new Error('timeout');
  await h.service.updateMessageState(message.id, { isArchived: true });
  await h.service.updateMessageState(message.id, { isTrashed: true });
  await h.service.updateMessageState(message.id, { isRead: true });

  assert.equal(h.repos.remoteOps.list().length, 1);
  assert.deepEqual(h.repos.remoteOps.get(message.id).fields, ['read', 'placement']);
  h.imap.failures.move = null;
  h.imap.failures.flags = null;
  makeDue(h.db);
  await h.service.retryRemoteOps(h.account.id);

  assert.deepEqual(h.imap.moves.map((move) => move.destination), ['Trash'], 'one move, straight to Trash');
  assert.ok(h.imap.messages('Trash')[0].flags.includes('\\Seen'));
  assert.equal(h.repos.remoteOps.get(message.id), null);
});

test('a queued change is retried by the next account sync', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.flags = new Error('NO server busy');
  const result = await h.service.updateMessageState(message.id, { isStarred: true });
  assert.equal(result.remoteSync.status, 'queued');
  h.imap.failures.flags = null;
  makeDue(h.db);

  await h.service.syncAccount(h.account.id);

  assert.equal(h.repos.remoteOps.get(message.id), null);
  assert.ok(h.imap.messages('INBOX')[0].flags.includes('\\Flagged'));
});

test('a later successful change for the same message also pushes what was owed', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.flags = new Error('NO server busy');
  await h.service.updateMessageState(message.id, { isStarred: true });
  h.imap.failures.flags = null;

  // Not due yet, but this action reaches the server and carries the star too.
  const result = await h.service.updateMessageState(message.id, { isRead: true });

  assert.equal(result.remoteSync.status, 'synced');
  const flags = h.imap.messages('INBOX')[0].flags;
  assert.ok(flags.includes('\\Flagged'));
  assert.ok(flags.includes('\\Seen'));
  assert.equal(h.repos.remoteOps.get(message.id), null);
});

test('a change that keeps failing becomes stuck and can be requeued', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('NO [CANNOT] mailbox is read-only');
  await h.service.updateMessageState(message.id, { isTrashed: true });
  for (let attempt = 0; attempt < REMOTE_OP_MAX_ATTEMPTS; attempt += 1) {
    makeDue(h.db);
    await h.service.retryRemoteOps(h.account.id);
  }

  const stuck = h.repos.remoteOps.get(message.id);
  assert.equal(stuck.status, 'stuck');
  assert.equal(stuck.attempts, REMOTE_OP_MAX_ATTEMPTS);
  assert.match(stuck.lastError, /read-only/);
  assert.deepEqual(h.repos.remoteOps.counts(), { pending: 0, stuck: 1 });
  makeDue(h.db);
  assert.equal((await h.service.retryRemoteOps(h.account.id)).attempted, 0, 'stuck changes are not retried on their own');
  assert.equal(h.service.runtimeStatus().remoteChanges.stuck, 1);

  assert.equal(h.repos.remoteOps.requeue(), 1);
  h.imap.failures.move = null;
  makeDue(h.db);
  await h.service.retryRemoteOps(h.account.id);
  assert.equal(h.repos.remoteOps.get(message.id), null);
  assert.equal(h.imap.messages('Trash').length, 1);
});

test('completing a retry never drops a newer failure for the same message', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);
  const first = h.repos.remoteOps.enqueue({
    messageId: message.id, accountId: h.account.id, fields: ['read'], nextAttemptAt: new Date().toISOString(),
  });
  const second = h.repos.remoteOps.enqueue({
    messageId: message.id, accountId: h.account.id, fields: ['placement'], nextAttemptAt: new Date().toISOString(),
  });

  assert.equal(h.repos.remoteOps.complete(message.id, first.revision), false);
  assert.deepEqual(h.repos.remoteOps.get(message.id).fields, ['read', 'placement']);
  assert.equal(h.repos.remoteOps.complete(message.id, second.revision), true);
});

test('an undo that needs no server move still pushes a star that was owed', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('timeout');
  h.imap.failures.flags = new Error('timeout');
  await h.service.updateMessageState(message.id, { isArchived: true });
  await h.service.updateMessageState(message.id, { isStarred: true });
  assert.deepEqual(h.repos.remoteOps.get(message.id).fields, ['starred', 'placement']);
  h.imap.failures.move = null;
  h.imap.failures.flags = null;

  // The server copy never left the inbox, so the undo needs no move, but the
  // star it carries still has to reach the server.
  await h.service.updateMessageState(message.id, { isArchived: false });

  assert.ok(h.imap.messages('INBOX')[0].flags.includes('\\Flagged'));
  assert.equal(h.repos.remoteOps.get(message.id), null);
});

test('a flag change from another client does not overwrite one aMail still owes', async (t) => {
  const h = await harness(t, { condstore: true });
  const message = await importedInboxMessage(h);

  h.imap.failures.flags = new Error('NO server busy');
  await h.service.updateMessageState(message.id, { isStarred: true });
  h.imap.failures.flags = null;
  // Meanwhile the phone marks it read; the server still has no star.
  const [{ uid }] = h.imap.messages('INBOX');
  h.imap.mailboxes.get('INBOX').messages.get(uid).flags.add('\\Seen');
  h.imap.modseq += 1;

  await h.service.syncAccount(h.account.id);
  const local = h.repos.messages.get(message.id);
  assert.equal(local.isRead, true, 'the read from the phone arrives');
  assert.equal(local.isStarred, true, 'the owed star is kept');

  makeDue(h.db);
  await h.service.retryRemoteOps(h.account.id);
  const flags = h.imap.messages('INBOX')[0].flags;
  assert.ok(flags.includes('\\Flagged'));
  assert.ok(flags.includes('\\Seen'));
  assert.equal(h.repos.remoteOps.get(message.id), null);
});

test('re-importing a message keeps the read, star and folder aMail still owes', async (t) => {
  const h = await harness(t);
  const message = await importedInboxMessage(h);

  h.imap.failures.move = new Error('timeout');
  h.imap.failures.flags = new Error('timeout');
  await h.service.updateMessageState(message.id, { isArchived: true });
  await h.service.updateMessageState(message.id, { isRead: true });
  h.imap.failures.move = null;
  h.imap.failures.flags = null;
  // A full resync downloads the inbox copy again.
  await h.service.syncAccount(h.account.id, { mode: 'full' });

  const local = h.repos.messages.get(message.id);
  assert.equal(local.isArchived, true);
  assert.equal(local.isRead, true);
});

test('retry backoff doubles and caps at an hour', () => {
  assert.equal(remoteOpDelayMs(0), 60_000);
  assert.equal(remoteOpDelayMs(1), 120_000);
  assert.equal(remoteOpDelayMs(20), 60 * 60_000);
});
