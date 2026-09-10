import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DATABASE_KEY_INFO, loadConfig } from './config.js';
import {
  DatabaseKeyError,
  createDatabase,
  createRepositories,
  encryptDatabaseInPlace,
  isPlaintextSqliteFile,
  openDatabase,
} from './db.js';
import { deriveSubkey } from './services/crypto.js';

function tempConfig(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-db-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, dbPath: path.join(dataDir, 'amail.sqlite'), ...extra };
}

function seedAccount(repos, email = 'owner@example.test') {
  return repos.accounts.create({
    email,
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
    credential_ciphertext: 'ciphertext',
    signature: '',
    sync_enabled: 1,
  });
}

test('the database key is derived only when whole-database encryption is opted in', () => {
  const env = { AMAIL_ENCRYPTION_KEY: 'a-long-operator-secret-value-0123456789' };
  assert.equal(loadConfig(env).databaseKey, null);
  assert.equal(loadConfig(env).encryptDatabase, false);
  assert.equal(loadConfig({ AMAIL_ENCRYPT_DATABASE: 'true' }).databaseKey, null);
  const keyed = loadConfig({ ...env, AMAIL_ENCRYPT_DATABASE: 'true' });
  assert.equal(keyed.encryptDatabase, true);
  assert.equal(keyed.databaseKey.length, 32);
  assert.deepEqual(keyed.databaseKey, deriveSubkey(env.AMAIL_ENCRYPTION_KEY, DATABASE_KEY_INFO));
  // The database key is independent from the credential key so neither
  // reveals the other.
  assert.notDeepEqual(keyed.databaseKey, keyed.credentialKey);
  assert.deepEqual(loadConfig({ GIGAMAIL_ENCRYPTION_KEY: env.AMAIL_ENCRYPTION_KEY, GIGAMAIL_ENCRYPT_DATABASE: '1' }).databaseKey, keyed.databaseKey);
});

test('a plain .env keeps producing a plaintext database exactly as before', (t) => {
  const config = tempConfig(t);
  const repos = createRepositories(createDatabase(config));
  seedAccount(repos);
  repos.close();
  assert.equal(isPlaintextSqliteFile(config.dbPath), true);
  const reopened = createRepositories(createDatabase(config));
  assert.equal(reopened.accounts.list().length, 1);
  reopened.close();
});

test('a keyed database is unreadable without its key and rejects a wrong key', (t) => {
  const key = Buffer.alloc(32, 3);
  const config = tempConfig(t, { databaseKey: key });
  const repos = createRepositories(createDatabase(config));
  seedAccount(repos);
  repos.close();
  assert.equal(isPlaintextSqliteFile(config.dbPath), false);
  assert.equal(fs.readFileSync(config.dbPath).includes('owner@example.test'), false);

  assert.throws(() => openDatabase(config.dbPath), (error) => error instanceof DatabaseKeyError && error.code === 'DATABASE_KEY_REQUIRED');
  assert.throws(() => openDatabase(config.dbPath, { key: Buffer.alloc(32, 4) }), (error) => error instanceof DatabaseKeyError && error.code === 'DATABASE_KEY_INVALID');
  assert.throws(() => createDatabase({ ...config, databaseKey: null }), (error) => error.code === 'DATABASE_KEY_REQUIRED');
  assert.throws(() => openDatabase(config.dbPath, { key: Buffer.alloc(16, 3) }), (error) => error.code === 'DATABASE_KEY_MALFORMED');

  const reopened = createRepositories(createDatabase(config));
  assert.equal(reopened.accounts.list()[0].email, 'owner@example.test');
  reopened.close();
});

test('enabling encryption on an existing install migrates the plaintext file in place once', (t) => {
  const config = tempConfig(t);
  const plaintext = createRepositories(createDatabase(config));
  const account = seedAccount(plaintext);
  const thread = plaintext.threads.create({ account_id: account.id, subject: 'Keep me', normalized_subject: 'keep me', latest_at: '2026-01-01T00:00:00.000Z' });
  plaintext.messages.upsert({
    account_id: account.id,
    thread_id: thread.id,
    mailbox: 'INBOX',
    uid: 1,
    rfc_message_id: '<keep@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Keep me',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-01-01T00:00:00.000Z',
    received_at: '2026-01-01T00:00:00.000Z',
    html_body: '',
    text_body: 'searchable body text',
    snippet: 'searchable body text',
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
  plaintext.close();
  assert.equal(isPlaintextSqliteFile(config.dbPath), true);

  const key = Buffer.alloc(32, 8);
  const keyed = { ...config, databaseKey: key };
  const database = createDatabase(keyed);
  assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
  const repos = createRepositories(database);
  assert.equal(repos.accounts.list()[0].email, 'owner@example.test');
  assert.deepEqual(repos.messages.searchThreadIds({ accountId: account.id, folder: 'inbox', ftsQuery: 'searchable' }), [thread.id]);
  repos.close();
  assert.equal(isPlaintextSqliteFile(config.dbPath), false);
  assert.equal(fs.existsSync(`${config.dbPath}-wal`) && fs.statSync(`${config.dbPath}-wal`).size > 0, false);
  assert.equal(fs.readFileSync(config.dbPath).includes('searchable body text'), false);

  // The second keyed boot is an ordinary open, not another migration.
  const again = createRepositories(createDatabase(keyed));
  assert.equal(again.accounts.list().length, 1);
  again.close();
  assert.throws(() => encryptDatabaseInPlace(config.dbPath, key), (error) => error.code === 'DATABASE_NOT_PLAINTEXT');
});

test('a missing or empty file is treated as a fresh database', (t) => {
  const config = tempConfig(t);
  assert.equal(isPlaintextSqliteFile(config.dbPath), null);
  fs.writeFileSync(config.dbPath, '');
  assert.equal(isPlaintextSqliteFile(config.dbPath), null);
  const repos = createRepositories(createDatabase({ ...config, databaseKey: Buffer.alloc(32, 1) }));
  assert.equal(repos.accounts.list().length, 0);
  repos.close();
  assert.equal(isPlaintextSqliteFile(config.dbPath), false);
});

function messageFields(accountId, threadId, extra = {}) {
  return {
    account_id: accountId,
    thread_id: threadId,
    mailbox: 'INBOX',
    uid: 1,
    rfc_message_id: '<density@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Keep headers',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2020-01-01T00:00:00.000Z',
    received_at: '2020-01-01T00:00:00.000Z',
    html_body: '<p>old body</p>',
    text_body: 'old body',
    snippet: 'old body',
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
    ...extra,
  };
}

test('WAL uses NORMAL synchronous, a bounded cache, and an explicit autocheckpoint', (t) => {
  const config = tempConfig(t);
  const database = createDatabase(config);
  t.after(() => database.close());
  assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(database.pragma('synchronous', { simple: true }), 1);
  assert.equal(database.pragma('cache_size', { simple: true }), -16000);
  assert.equal(database.pragma('wal_autocheckpoint', { simple: true }), 1000);
  assert.equal(database.pragma('journal_size_limit', { simple: true }), 64 * 1024 * 1024);
  assert.equal(database.pragma('mmap_size', { simple: true }), 268435456);
});

test('a keyed database does not enable mmap', (t) => {
  const config = tempConfig(t, { databaseKey: Buffer.alloc(32, 5) });
  const database = createDatabase(config);
  t.after(() => database.close());
  assert.equal(database.pragma('mmap_size', { simple: true }), 0);
});

test('the same RFC Message-ID in another mailbox is stored as a copy instead of rewriting UNIQUE keys', (t) => {
  const config = tempConfig(t);
  const db = createDatabase(config);
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const account = seedAccount(repos);
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Copied',
    normalized_subject: 'copied',
    latest_at: '2026-01-01T00:00:00.000Z',
  });
  const inbox = repos.messages.upsert(messageFields(account.id, thread.id, {
    mailbox: 'INBOX',
    uid: 5,
    rfc_message_id: '<copy@example.test>',
  }));
  const archive = repos.messages.upsert(messageFields(account.id, thread.id, {
    mailbox: 'Archive',
    uid: 50,
    rfc_message_id: '<copy@example.test>',
    is_archived: 1,
  }));
  assert.notEqual(archive.id, inbox.id);
  assert.equal(inbox.mailbox, 'INBOX');
  assert.equal(repos.messages.get(inbox.id).mailbox, 'INBOX');
  assert.equal(repos.messages.get(archive.id).mailbox, 'Archive');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
});

test('retention prune clears old bodies and keeps headers, and a change stamp moves with writes', (t) => {
  const config = tempConfig(t);
  const repos = createRepositories(createDatabase(config));
  t.after(() => repos.close());
  const account = seedAccount(repos);
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Keep headers',
    normalized_subject: 'keep headers',
    latest_at: '2020-01-01T00:00:00.000Z',
  });
  const message = repos.messages.upsert(messageFields(account.id, thread.id));
  const before = repos.changes.stamp();
  assert.ok(before.changedAt);
  const pruned = repos.retention.pruneBodies('2024-01-01T00:00:00.000Z');
  assert.equal(pruned, 1);
  const kept = repos.messages.get(message.id);
  assert.equal(kept.htmlBody, '');
  assert.equal(kept.textBody, '');
  assert.equal(kept.snippet, 'old body');
  assert.equal(kept.subject, 'Keep headers');
  const after = repos.changes.stamp();
  assert.ok(after.changedAt >= before.changedAt);
  repos.sync.recordSkip({ account_id: account.id, mailbox: 'INBOX', uid: 5, reason: 'UNIQUE messages.account_id, mailbox, uid' });
  repos.checkpointWal();
});
