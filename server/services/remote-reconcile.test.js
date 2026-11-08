import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createMailService, reconcileRole } from './mail-service.js';
import { encryptJson } from './crypto.js';
import { createFakeImapServer } from './fake-imap.test-support.js';

const credentialKey = Buffer.alloc(32, 5);

const plainFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
  { path: 'Receipts', name: 'Receipts', specialUse: null },
];

const gmailFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
  { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' },
  { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: '[Gmail]/Spam', name: 'Spam', specialUse: '\\Junk' },
];

function raw(id, subject = 'Freight quote') {
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

function harness(t, { folders = plainFolders } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-reconcile-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey,
    syncTimeoutMs: 5_000,
    syncBatchSize: 50,
    imapPoolIdleMs: 0,
    // Check on every sync and act on the second sighting straight away.
    reconcileIntervalMs: 0,
    reconcileConfirmMs: 0,
  };
  const repos = createRepositories(createDatabase(config));
  const server = createFakeImapServer({ folders });
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
  const rowsFor = (id) => repos.messages.forThread(repos.messages.findByRfcId(account.id, `<${id}@example.test>`)?.threadId || '')
    .filter((message) => message.messageId === `<${id}@example.test>`);
  const inbox = () => repos.messages.list({ accountId: account.id, folder: 'inbox', includeTotal: false }).items;
  const archive = () => repos.messages.list({ accountId: account.id, folder: 'archive', includeTotal: false }).items;
  return { repos, service, imap: server.state, account, rowsFor, inbox, archive };
}

async function seedAndImport(h, id = 'm1') {
  const uid = h.imap.seed('INBOX', raw(id));
  await h.service.syncAccount(h.account.id);
  const [row] = h.rowsFor(id);
  assert.equal(row.mailbox, 'INBOX');
  return { uid, row };
}

test('mail archived in another client leaves the inbox, keeping its id and analyzed mark', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h);
  await h.service.updateMessageState(row.id, { isAnalyzed: true, analyzedBy: 'mail-sweep' });

  // The phone moves it to Archive.
  h.imap.place('Archive', h.imap.expunge('INBOX', uid));
  await h.service.syncAccount(h.account.id);
  // First sighting only marks it; the Archive copy arrived as a second row.
  assert.ok(h.repos.messages.get(row.id).remoteMissingAt);
  assert.equal(h.repos.messages.get(row.id).mailbox, 'INBOX');

  await h.service.syncAccount(h.account.id);

  const rows = h.rowsFor('m1');
  assert.equal(rows.length, 1, 'the Archive copy merged into the original row');
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].mailbox, 'Archive');
  assert.equal(rows[0].isArchived, true);
  assert.equal(rows[0].isAnalyzed, true, 'agents do not review it again');
  assert.equal(rows[0].remoteMissingAt, null);
  assert.deepEqual(h.inbox().map((message) => message.id), []);
});

test('a change still owed on the destination copy survives the merge', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h, 'o1');

  h.imap.place('Archive', h.imap.expunge('INBOX', uid));
  await h.service.syncAccount(h.account.id);
  const copy = h.archive().find((message) => message.messageId === row.messageId && message.id !== row.id);
  assert.ok(copy, 'the Archive copy arrived as its own row');
  h.repos.messages.setState(copy.id, { isStarred: true });
  h.repos.remoteOps.enqueue({
    messageId: copy.id, accountId: h.account.id, fields: ['starred'], nextAttemptAt: '2999-01-01T00:00:00.000Z',
  });

  await h.service.syncAccount(h.account.id);

  assert.equal(h.repos.messages.get(copy.id), null, 'merged into the original row');
  const owed = h.repos.remoteOps.get(row.id);
  assert.ok(owed, 'the owed star moved to the surviving row');
  assert.deepEqual(owed.fields, ['starred']);
  assert.equal(h.repos.messages.get(row.id).isStarred, true);
});

test('Gmail: archived on the web, the inbox row follows the message to All Mail', async (t) => {
  const h = harness(t, { folders: gmailFolders });
  const source = raw('g1');
  h.imap.seed('[Gmail]/All Mail', source);
  const uid = h.imap.seed('INBOX', source);
  await h.service.syncAccount(h.account.id);
  const [row] = h.rowsFor('g1');
  assert.equal(row.mailbox, 'INBOX');

  h.imap.expunge('INBOX', uid);
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const moved = h.repos.messages.get(row.id);
  assert.equal(moved.mailbox, '[Gmail]/All Mail');
  assert.equal(moved.uid, 1);
  assert.equal(moved.isArchived, true);
  assert.deepEqual(h.inbox(), []);
});

test('deleted in another client: trashed rows move to Trash', async (t) => {
  const h = harness(t, { folders: gmailFolders });
  const { uid, row } = await seedAndImport(h, 'd1');

  h.imap.place('[Gmail]/Trash', h.imap.expunge('INBOX', uid));
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const moved = h.repos.messages.get(row.id);
  assert.equal(moved.mailbox, '[Gmail]/Trash');
  assert.equal(moved.isTrashed, true);
  assert.equal(h.rowsFor('d1').length, 1);
});

test('filed into a custom folder elsewhere, it shows under Archive', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h, 'r1');

  h.imap.place('Receipts', h.imap.expunge('INBOX', uid));
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const moved = h.repos.messages.get(row.id);
  assert.equal(moved.mailbox, 'Receipts');
  assert.equal(moved.isArchived, true);
  assert.deepEqual(h.archive().map((message) => message.id), [row.id]);
});

test('gone from the server for good: kept locally under Archive, never deleted', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h, 'x1');

  h.imap.expunge('INBOX', uid);
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const kept = h.repos.messages.get(row.id);
  assert.ok(kept, 'the row is still there');
  assert.equal(kept.mailbox, 'INBOX');
  assert.equal(kept.uid, null, 'later actions stay local instead of aiming at a missing UID');
  assert.equal(kept.isArchived, true);
  assert.ok(kept.remoteMissingAt);
  assert.deepEqual(h.inbox(), []);
  const result = await h.service.updateMessageState(row.id, { isArchived: false });
  assert.equal(result.remoteSync.reason, 'message-has-no-imap-uid');
});

test('a UID missing on one pass and back on the next changes nothing', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h, 'b1');

  const removed = h.imap.expunge('INBOX', uid);
  await h.service.syncAccount(h.account.id);
  assert.ok(h.repos.messages.get(row.id).remoteMissingAt);
  h.imap.seedAt('INBOX', uid, removed.raw);
  await h.service.syncAccount(h.account.id);

  const unchanged = h.repos.messages.get(row.id);
  assert.equal(unchanged.remoteMissingAt, null);
  assert.equal(unchanged.mailbox, 'INBOX');
  assert.equal(unchanged.isArchived, false);
});

test('a message with a server change still queued is left for the retry queue', async (t) => {
  const h = harness(t);
  const { uid, row } = await seedAndImport(h, 'q1');
  h.repos.remoteOps.enqueue({
    messageId: row.id, accountId: h.account.id, fields: ['placement'], nextAttemptAt: '2999-01-01T00:00:00.000Z',
  });

  h.imap.expunge('INBOX', uid);
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const untouched = h.repos.messages.get(row.id);
  assert.equal(untouched.mailbox, 'INBOX');
  assert.equal(untouched.isArchived, false);
  assert.equal(untouched.remoteMissingAt, null);
});

test('purged from Trash elsewhere: still in local Trash, only marked', async (t) => {
  const h = harness(t);
  const uid = h.imap.seed('Trash', raw('t1'));
  await h.service.syncAccount(h.account.id);
  const [row] = h.rowsFor('t1');
  assert.equal(row.isTrashed, true);

  h.imap.expunge('Trash', uid);
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);

  const kept = h.repos.messages.get(row.id);
  assert.equal(kept.isTrashed, true);
  assert.equal(kept.mailbox, 'Trash');
  assert.ok(kept.remoteMissingAt);
});

test('a listing that disagrees with the mailbox count is not trusted', async (t) => {
  const h = harness(t);
  const { row } = await seedAndImport(h, 'c1');
  // The server's SEARCH comes back empty while the mailbox says it has mail.
  h.imap.lieAboutSearch = true;
  await h.service.syncAccount(h.account.id);
  await h.service.syncAccount(h.account.id);
  h.imap.lieAboutSearch = false;

  const untouched = h.repos.messages.get(row.id);
  assert.equal(untouched.mailbox, 'INBOX');
  assert.equal(untouched.remoteMissingAt, null);
});

test('a found message takes the role of the folder it landed in', () => {
  const descriptors = [
    { mailbox: 'INBOX', role: 'inbox' },
    { mailbox: '[Gmail]/All Mail', role: 'archive' },
    { mailbox: '[Gmail]/Trash', role: 'trash' },
  ];
  assert.equal(reconcileRole('[Gmail]/All Mail', gmailFolders, descriptors), 'archive');
  assert.equal(reconcileRole('[Gmail]/Trash', gmailFolders, descriptors), 'trash');
  assert.equal(reconcileRole('INBOX', gmailFolders, descriptors), 'inbox');
  assert.equal(reconcileRole('Receipts', plainFolders, descriptors), 'archive');
  const withSent = [...gmailFolders, { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' }];
  assert.equal(reconcileRole('[Gmail]/Sent Mail', withSent, descriptors), null);
});
