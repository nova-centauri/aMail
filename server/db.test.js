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

test('the review queue drains over 5,000 pending messages beyond the newest 1,000 analyzed records', (t) => {
  const db = createDatabase(tempConfig(t));
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const account = seedAccount(repos);
  const expected = [];
  const baseline = Date.parse('2020-01-01T00:00:00.000Z');
  repos.runWriteBatch(() => {
    for (let index = 0; index < 6205; index += 1) {
      const timestamp = new Date(baseline + index * 1000).toISOString();
      const thread = repos.threads.create({
        account_id: account.id, subject: `Review ${index}`, normalized_subject: `review ${index}`, latest_at: timestamp,
      });
      const message = repos.messages.upsert(messageFields(account.id, thread.id, {
        uid: index + 1, rfc_message_id: `<review-${index}@example.test>`,
        sent_at: timestamp, received_at: timestamp,
      }));
      if (index < 5205) expected.push(message.id);
      else repos.messages.setState(message.id, { isAnalyzed: true, analyzedBy: 'previous-run' });
    }
  });
  const changeCount = () => db.prepare('SELECT total_changes() AS count').get().count;
  const before = changeCount();
  const initial = repos.messages.listUnanalyzed({ limit: 200 });
  assert.equal(initial.total, 5205);
  assert.equal(initial.hasMore, true);
  assert.deepEqual(initial.items.map((message) => message.id), expected.slice(0, 200));
  assert.deepEqual(repos.messages.listUnanalyzed({ limit: 200 }), initial);
  assert.equal(changeCount(), before, 'listing must not change messages, threads, or other database state');
  const seen = [];
  while (true) {
    const page = repos.messages.listUnanalyzed({ limit: 200 });
    assert.equal(page.total, expected.length - seen.length);
    assert.equal(page.hasMore, page.total > page.items.length);
    if (!page.items.length) break;
    for (const message of page.items) {
      assert.equal(message.isRead, false);
      assert.equal(message.isAnalyzed, false);
      assert.equal(Object.hasOwn(message, 'htmlBody'), false);
      assert.equal(Object.hasOwn(message, 'textBody'), false);
      seen.push(message.id);
      repos.messages.setState(message.id, { isAnalyzed: true, analyzedBy: 'test-review' });
    }
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, 5205);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE is_read = 1').get().count, 0);
});

test('review summaries cover all cached folders, preserve message ids, scope totals, and bound untrusted metadata', (t) => {
  const db = createDatabase(tempConfig(t));
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const account = seedAccount(repos);
  const other = seedAccount(repos, 'other@example.test');
  const timestamp = '2020-01-01T00:00:00.000Z';
  const thread = repos.threads.create({ account_id: account.id, subject: 'Same thread', normalized_subject: 'same thread', latest_at: timestamp });
  const states = [
    {}, { mailbox: 'Sent', is_sent: 1 }, { mailbox: 'Archive', is_archived: 1 },
    { mailbox: 'Spam', is_spam: 1 }, { mailbox: 'Trash', is_trashed: 1, is_spam: 1 },
    { is_archived: 1, snoozed_until: '2099-01-01T00:00:00.000Z' }, { mailbox: 'Custom folder' },
    { subject: 'Watchtower: no updates available', from_email: 'watchtower@example.test' },
  ];
  const ids = states.map((state, index) => repos.messages.upsert(messageFields(account.id, thread.id, {
    uid: index + 1, rfc_message_id: `<folder-${index}@example.test>`, ...state,
  })).id);
  // Exercise the stored category regardless of the operator's configured sources.
  db.prepare("UPDATE messages SET smart_category = 'ops_quiet' WHERE id = ?").run(ids.at(-1));
  const otherThread = repos.threads.create({ account_id: other.id, subject: 'Other', normalized_subject: 'other', latest_at: timestamp });
  const otherMessage = repos.messages.upsert(messageFields(other.id, otherThread.id));
  const all = repos.messages.listUnanalyzed({ limit: 200 });
  assert.equal(all.total, 9);
  assert.equal(all.hasMore, false);
  assert.deepEqual(all.items.map((item) => item.id), [...ids, otherMessage.id].sort());
  const scoped = repos.messages.listUnanalyzed({ accountId: account.id, limit: 200 });
  assert.equal(scoped.total, 8);
  assert.deepEqual(scoped.items.map((item) => item.id), ids.sort());
  assert.ok(scoped.items.every((item) => item.threadId === thread.id && item.id !== thread.id));
  assert.ok(scoped.items.some((item) => item.category === 'ops_quiet'));
  const otherOnly = repos.messages.listUnanalyzed({ accountId: other.id });
  assert.equal(otherOnly.total, 1);
  assert.equal(otherOnly.items[0].id, otherMessage.id);

  const huge = 'x'.repeat(5000);
  const people = Array.from({ length: 30 }, () => ({ name: huge, email: huge }));
  db.prepare('UPDATE messages SET subject = ?, snippet = ?, from_name = ?, to_json = ?, html_body = ?, text_body = ? WHERE id = ?')
    .run(huge, huge, huge, JSON.stringify(people), huge, huge, otherMessage.id);
  const summary = repos.messages.listUnanalyzed({ accountId: other.id }).items[0];
  assert.equal(summary.summaryTruncated, true);
  assert.equal(summary.subject.length, 1000);
  assert.equal(summary.snippet.length, 1000);
  assert.equal(summary.from.name.length, 256);
  assert.equal(summary.to.length, 20);
  assert.equal(summary.to[0].email.length, 320);
  assert.equal(Object.hasOwn(summary, 'htmlBody'), false);
  assert.equal(Object.hasOwn(summary, 'textBody'), false);
  assert.equal(repos.messages.get(otherMessage.id).textBody, huge);
  for (const limit of [0, 201, -1, 1.5]) assert.throws(() => repos.messages.listUnanalyzed({ limit }), RangeError);
});

test('review cursors retain equal-time siblings and use received time with legacy timestamp fallbacks', (t) => {
  const db = createDatabase(tempConfig(t));
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const account = seedAccount(repos);
  const timestamp = '2020-01-01T00:00:00.000Z';
  const thread = repos.threads.create({ account_id: account.id, subject: 'Cursor ties', normalized_subject: 'cursor ties', latest_at: timestamp });
  const ids = Array.from({ length: 3 }, (_, index) => repos.messages.upsert(messageFields(account.id, thread.id, {
    uid: index + 1, rfc_message_id: `<tie-${index}@example.test>`,
    received_at: timestamp,
    // Sender timestamps must not reorder messages with the same receipt time.
    sent_at: new Date(Date.parse(timestamp) + index * 60_000).toISOString(),
  })).id).sort();
  const sentFallback = repos.messages.upsert(messageFields(account.id, thread.id, {
    uid: 4, rfc_message_id: '<sent-fallback@example.test>', received_at: null, sent_at: '2021-01-01T00:00:00.000Z',
  }));
  const createdFallback = repos.messages.upsert(messageFields(account.id, thread.id, {
    uid: 5, rfc_message_id: '<created-fallback@example.test>', received_at: null, sent_at: null,
  }));
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2022-01-01T00:00:00.000Z', createdFallback.id);
  const first = repos.messages.listUnanalyzed({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
  repos.messages.setState(ids[1], { isAnalyzed: true });
  const next = repos.messages.listUnanalyzed({ limit: 2, afterTimestamp: timestamp, afterId: ids[1] });
  assert.equal(next.total, 4);
  assert.equal(next.hasMore, true);
  assert.deepEqual(next.items.map((item) => item.id), [ids[2], sentFallback.id]);
  const final = repos.messages.listUnanalyzed({ limit: 2, afterTimestamp: sentFallback.sentAt, afterId: sentFallback.id });
  assert.deepEqual(final.items.map((item) => item.id), [createdFallback.id]);
  assert.equal(final.hasMore, false);
  const end = repos.messages.listUnanalyzed({ afterTimestamp: final.items[0].createdAt, afterId: createdFallback.id });
  assert.equal(end.items.length, 0);
  assert.equal(end.total, 4, 'an exhausted cursor does not claim the earlier blocked queue is empty');
});

test('review pages use pending-message ordering indexes in every scope and cursor mode', (t) => {
  const db = createDatabase(tempConfig(t));
  let pageQuery;
  const tracked = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        const statement = target.prepare(sql);
        if (/FROM messages WHERE analyzed_at IS NULL/.test(sql) && /ORDER BY/.test(sql)) {
          const all = statement.all.bind(statement);
          statement.all = (...args) => {
            pageQuery = { sql, args };
            return all(...args);
          };
        }
        return statement;
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const repos = createRepositories(tracked);
  t.after(() => repos.close());
  const account = seedAccount(repos);
  for (const accountId of [null, account.id]) {
    for (const afterTimestamp of [null, '2026-01-01T00:00:00.000Z']) {
      repos.messages.listUnanalyzed({ accountId, afterTimestamp, afterId: 'cursor-id', limit: 10 });
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${pageQuery.sql}`).all(...pageQuery.args)
        .map((row) => row.detail).join('\n');
      assert.doesNotMatch(plan, /TEMP B-TREE/);
      if (accountId) assert.match(plan, /SEARCH messages USING INDEX idx_messages_review_account_order \(account_id=/);
      else assert.match(plan, /USING INDEX idx_messages_review_order/);
    }
  }
});

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
