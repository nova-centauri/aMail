import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { listConversations } from './inbox.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-inbox-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
  const executed = [];
  // Observe the real SQL, including lazy statements, without recording mail.
  const tracked = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            const value = prepared[method];
            if (['all', 'get', 'run'].includes(method)) return (...args) => {
              executed.push(sql);
              return value.apply(prepared, args);
            };
            return typeof value === 'function' ? value.bind(prepared) : value;
          },
        });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const repos = createRepositories(tracked);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', avatar_blob: null, avatar_mime: null,
    color: '#1a73e8', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  let uid = 0;
  const add = (thread, extra = {}) => repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'INBOX', uid: ++uid,
    rfc_message_id: `<fixture-${uid}@example.test>`, in_reply_to: null, references_json: '[]',
    subject: thread.subject, from_name: '', from_email: 'friend@example.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: `2026-01-01T00:${String(uid).padStart(2, '0')}:00.000Z`,
    received_at: `2026-01-01T00:${String(uid).padStart(2, '0')}:00.000Z`,
    html_body: '', text_body: '', snippet: 'Short list preview', attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
    snoozed_until: null, is_sent: 0, ...extra,
  });
  const thread = (subject) => repos.threads.create({
    account_id: account.id, subject, normalized_subject: subject.toLowerCase(), latest_at: '2026-01-01T00:00:00.000Z',
  });
  return { repos, executed, account, add, thread };
}

test('conversation pages omit large bodies, avoid candidate totals, and enrich only visible threads', (t) => {
  const { repos, executed, add, thread } = fixture(t);
  const body = `bodyonlyneedle ${'x'.repeat(256 * 1024)}`;
  const ids = [];
  let message;
  for (let index = 0; index < 6; index += 1) {
    const conversation = thread(`Conversation ${index}`);
    ids.push(conversation.id);
    message = add(conversation, { text_body: body, html_body: `<p>${body}</p>` });
  }
  const assertPage = (query) => {
    executed.length = 0;
    const page = listConversations(repos, { page: 2, pageSize: 2, query });
    assert.equal(page.total, 6);
    assert.equal(page.categoryCounts.primary, 6);
    assert.deepEqual(page.messages.map((item) => item.id), [ids[3], ids[2]]);
    assert.equal(executed.filter((sql) => sql === 'SELECT * FROM threads WHERE id = ?').length, 2);
    assert.equal(executed.some((sql) => sql.startsWith('SELECT COUNT(*) AS count FROM messages m')), false);
    const candidateSql = executed.filter((sql) => /FROM messages(?: m)?\s+WHERE/.test(sql) && /^SELECT (?:m\.)?id,/.test(sql));
    assert.equal(candidateSql.length, 1);
    assert.doesNotMatch(candidateSql[0], /html_body|text_body|SELECT \*/);
    for (const item of page.messages) {
      assert.equal(Object.hasOwn(item, 'htmlBody'), false);
      assert.equal(Object.hasOwn(item, 'textBody'), false);
    }
    assert.ok(JSON.stringify(page).length < 10_000);
  };
  assertPage('');
  assertPage('bodyonlyneedle'); // FTS finds content even though candidates omit it.
  assert.equal(repos.messages.get(message.id).textBody, body);
  assert.equal(repos.messages.forThread(message.threadId)[0].htmlBody, `<p>${body}</p>`);
});

test('pagination preserves matching against older messages and whole-thread state aggregates', (t) => {
  const { repos, executed, add, thread } = fixture(t);
  const mixed = thread('Mixed state');
  add(mixed, { from_email: 'older@example.test', is_starred: 1 });
  const latest = add(mixed, { is_read: 1 });
  repos.messages.setState(latest.id, { isAnalyzed: true });
  add(mixed, { mailbox: 'Archive', is_archived: 1, from_email: 'archived@example.test' });
  add(thread('Other thread'));
  for (const query of ['from:older@example.test is:unread', 'from:older@example.test is:unanalyzed', 'from:older@example.test is:starred']) {
    executed.length = 0;
    const page = listConversations(repos, { query, pageSize: 1 });
    assert.equal(page.total, 1);
    assert.equal(page.messages[0].id, mixed.id);
    assert.equal(page.messages[0].latestMessageId, latest.id);
    assert.equal(page.messages[0].messageCount, 3);
    assert.equal(page.messages[0].unreadCount, 2);
    assert.equal(page.messages[0].unanalyzedCount, 2);
    assert.equal(page.messages[0].isRead, false);
    assert.equal(page.messages[0].isAnalyzed, false);
    assert.equal(page.messages[0].isStarred, true);
    assert.equal(executed.filter((sql) => sql === 'SELECT * FROM threads WHERE id = ?').length, 1);
  }
  assert.equal(listConversations(repos, { query: 'from:older@example.test is:analyzed' }).total, 0);
});

test('operator and FTS search paginate through the whole cached corpus', (t) => {
  const { repos, add, thread } = fixture(t);
  const oldFrom = thread('Ancient invoice');
  add(oldFrom, {
    from_email: 'accounts@vendor.test',
    from_name: 'Vendor Accounts',
    text_body: 'unique-corpus-token winter-close',
    snippet: 'unique-corpus-token',
    sent_at: '2020-01-01T00:00:00.000Z',
    received_at: '2020-01-01T00:00:00.000Z',
    uid: 1,
  });
  const originMs = Date.parse('2026-06-01T00:00:00.000Z');
  for (let index = 0; index < 1100; index += 1) {
    const timestamp = new Date(originMs + ((1100 - index) * 1000)).toISOString();
    add(thread(`Recent ${index}`), {
      from_email: 'noreply@example.test',
      sent_at: timestamp,
      received_at: timestamp,
      uid: index + 2,
      rfc_message_id: `<recent-${index}@example.test>`,
    });
  }
  const fromPage = listConversations(repos, { query: 'from:accounts@vendor.test', pageSize: 10 });
  assert.equal(fromPage.total, 1);
  assert.equal(fromPage.messages[0].id, oldFrom.id);

  const ftsPage = listConversations(repos, { query: 'unique-corpus-token', page: 1, pageSize: 5 });
  assert.equal(ftsPage.total, 1);
  assert.equal(ftsPage.messages[0].id, oldFrom.id);

  const newest = listConversations(repos, { page: 1, pageSize: 50 });
  assert.equal(newest.total, 1101);
  assert.equal(newest.messages.length, 50);
  const later = listConversations(repos, { page: 23, pageSize: 50 });
  assert.equal(later.total, 1101);
  assert.ok(later.messages.some((item) => item.id === oldFrom.id));
});

test('attachment filenames are indexed and pruneBodies keeps existing FTS tokens', (t) => {
  const { repos, add, thread } = fixture(t);
  const conversation = thread('Catering');
  const message = add(conversation, {
    text_body: 'please find the winter menu attached',
    snippet: 'please find the winter menu attached',
    attachments_json: JSON.stringify([{ index: 0, filename: 'wintermenu.pdf', contentType: 'application/pdf', size: 2048 }]),
  });
  const byName = listConversations(repos, { query: 'wintermenu' });
  assert.equal(byName.total, 1);
  assert.equal(byName.messages[0].id, conversation.id);

  const pruned = repos.retention.pruneBodies('2099-01-01T00:00:00.000Z');
  assert.equal(pruned, 1);
  assert.equal(repos.messages.get(message.id).textBody, '');
  const stillFound = listConversations(repos, { query: 'winter menu attached' });
  assert.equal(stillFound.total, 1);
  assert.equal(stillFound.messages[0].id, conversation.id);
});

