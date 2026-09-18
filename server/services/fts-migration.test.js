import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';

function messageInput({ accountId, threadId, uid, subject, textBody, timestamp }) {
  return {
    account_id: accountId,
    thread_id: threadId,
    mailbox: 'INBOX',
    uid,
    rfc_message_id: `<fts-${uid}@example.test>`,
    in_reply_to: null,
    references_json: '[]',
    subject,
    from_name: 'Sender',
    from_email: 'sender@example.test',
    to_json: JSON.stringify([{ name: 'Owner', email: 'owner@example.test' }]),
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: timestamp,
    received_at: timestamp,
    html_body: '',
    text_body: textBody,
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

test('reopening a pre-FTS mailbox indexes search in batches and keeps SQLite temp on the data volume', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-fts-migrate-'));
  const config = { dataDir, dbPath: path.join(dataDir, 'amail.sqlite') };
  const seed = createDatabase(config);
  const repos = createRepositories(seed);
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
    credential_ciphertext: 'test-only',
    signature: '',
    sync_enabled: 1,
  });
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Workflow failed',
    normalized_subject: 'workflow failed',
    latest_at: '2026-08-01T00:00:00.000Z',
  });

  const body = `${'lorem ipsum '.repeat(400)} unique-token-42`;
  for (let uid = 1; uid <= 120; uid += 1) {
    const timestamp = new Date(Date.UTC(2026, 7, 1, 0, uid)).toISOString();
    repos.messages.upsert(messageInput({
      accountId: account.id,
      threadId: thread.id,
      uid,
      subject: uid === 42 ? 'Invoice for unique-token-42' : `Message ${uid}`,
      textBody: uid === 42 ? body : `ordinary body ${uid} ${'x'.repeat(2048)}`,
      timestamp,
    }));
  }

  seed.exec('DROP TRIGGER IF EXISTS messages_ad_fts');
  seed.exec('DROP TABLE IF EXISTS messages_fts');
  repos.close();

  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 120);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count, 120);
  assert.match(
    String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`).get()?.sql || ''),
    /content\s*=\s*''/,
  );
  assert.ok(fs.statSync(path.join(dataDir, 'tmp')).isDirectory());
  assert.equal(process.env.SQLITE_TMPDIR, path.join(dataDir, 'tmp'));
  assert.ok(
    db.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH '"unique-token-42"'`).get().count >= 1,
  );
});

function seedAccount(repos) {
  return repos.accounts.create({
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
    credential_ciphertext: 'test-only',
    signature: '',
    sync_enabled: 1,
  });
}

function ftsHits(db, term) {
  return db.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH ?`).get(`"${term}"`).count;
}

test('re-importing an indexed message updates the search index instead of failing', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-fts-upsert-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'amail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const account = seedAccount(repos);
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Quarterly numbers',
    normalized_subject: 'quarterly numbers',
    latest_at: '2026-08-01T00:00:00.000Z',
  });
  const timestamp = '2026-08-01T00:00:00.000Z';

  // The local copy of a sent message has no UID yet; the next Sent sync finds
  // it by Message-ID and re-imports it with the UID the server assigned.
  const local = repos.messages.upsert({
    ...messageInput({ accountId: account.id, threadId: thread.id, uid: null, subject: 'Quarterly numbers', textBody: 'draft-token', timestamp }),
    mailbox: 'Sent',
    is_sent: 1,
  });
  const synced = repos.messages.upsert({
    ...messageInput({ accountId: account.id, threadId: thread.id, uid: 77, subject: 'Quarterly numbers', textBody: 'server-token', timestamp }),
    mailbox: 'Sent',
    rfc_message_id: '<fts-null@example.test>',
    is_sent: 1,
  });

  assert.equal(synced.id, local.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count, 1);
  assert.equal(ftsHits(db, 'server-token'), 1);
  assert.equal(ftsHits(db, 'draft-token'), 0);
});

test('deleting messages and removing accounts drop their search rows', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-fts-delete-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'amail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const account = seedAccount(repos);
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Hello',
    normalized_subject: 'hello',
    latest_at: '2026-08-01T00:00:00.000Z',
  });
  const timestamp = '2026-08-01T00:00:00.000Z';
  const first = repos.messages.upsert(messageInput({ accountId: account.id, threadId: thread.id, uid: 1, subject: 'Hello', textBody: 'first-token', timestamp }));
  repos.messages.upsert(messageInput({ accountId: account.id, threadId: thread.id, uid: 2, subject: 'Hello', textBody: 'second-token', timestamp }));

  db.prepare('DELETE FROM messages WHERE id = ?').run(first.id);
  assert.equal(ftsHits(db, 'first-token'), 0);
  assert.equal(ftsHits(db, 'second-token'), 1);

  assert.equal(repos.accounts.remove(account.id), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count, 0);
});

test('migrating a content-bearing FTS index to contentless keeps pruned body tokens', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-fts-contentless-'));
  const config = { dataDir, dbPath: path.join(dataDir, 'amail.sqlite') };
  const seed = createDatabase(config);
  const seedRepos = createRepositories(seed);
  const account = seedAccount(seedRepos);
  const thread = seedRepos.threads.create({
    account_id: account.id,
    subject: 'Hello',
    normalized_subject: 'hello',
    latest_at: '2020-08-01T00:00:00.000Z',
  });
  const message = seedRepos.messages.upsert(messageInput({
    accountId: account.id, threadId: thread.id, uid: 1, subject: 'Hello', textBody: 'legacy-token', timestamp: '2020-08-01T00:00:00.000Z',
  }));
  const rowid = seed.prepare('SELECT rowid AS rowid FROM messages WHERE id = ?').get(message.id).rowid;
  seedRepos.retention.pruneBodies('2099-01-01T00:00:00.000Z');
  assert.equal(seedRepos.messages.get(message.id).textBody, '');
  seed.exec(`
    DROP TRIGGER IF EXISTS messages_ad_fts;
    DROP TABLE IF EXISTS messages_fts;
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      subject, snippet, from_name, from_email, recipients, text_body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
  `);
  seed.prepare(`INSERT INTO messages_fts(
    rowid, subject, snippet, from_name, from_email, recipients, text_body
  ) VALUES (?, 'Hello', 'Hello', 'Sender', 'sender@example.test', 'Owner owner@example.test', 'legacy-token')`).run(rowid);
  seedRepos.close();

  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.match(
    String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`).get()?.sql || ''),
    /content\s*=\s*''/,
  );
  assert.equal(ftsHits(db, 'legacy-token'), 1);
  db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count, 0);
});
