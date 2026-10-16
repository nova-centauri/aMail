import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { buildConversationSearch } from './conversation-search.js';
import { conversationListEtag, listConversations, parsePageSize } from './inbox.js';

const ACCOUNT_COUNT = 20;
const MESSAGES_PER_ACCOUNT = 1_500;

function seedLargeMailbox(db, { accounts = ACCOUNT_COUNT, messagesPerAccount = MESSAGES_PER_ACCOUNT } = {}) {
  const insertAccount = db.prepare(`INSERT INTO accounts (
    id, email, display_name, avatar_blob, avatar_mime, color, provider,
    imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
    credential_ciphertext, signature, sync_enabled, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, NULL, '#1a73e8', 'custom', 'imap.test', 993, 1, 'smtp.test', 465, 1, 'x', '', 0, ?, ?)`);
  const insertThread = db.prepare(`INSERT INTO threads (
    id, account_id, subject, normalized_subject, participants_json, snippet,
    latest_at, message_count, unread_count, unanalyzed_count, is_starred, labels_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, '[]', 'snippet', ?, 1, 1, 1, 0, '[]', ?, ?)`);
  const insertMessage = db.prepare(`INSERT INTO messages (
    id, account_id, thread_id, mailbox, uid, rfc_message_id, in_reply_to, references_json,
    subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
    sent_at, received_at, html_body, text_body, snippet, attachments_json, labels_json,
    is_read, is_starred, is_archived, is_trashed, is_spam, snoozed_until, is_sent, is_draft,
    analyzed_at, analyzed_by, smart_category, smart_category_reason, smart_category_rule,
    smart_category_version, source_imported, created_at, updated_at
  ) VALUES (
    ?, ?, ?, 'INBOX', ?, ?, NULL, '[]',
    ?, '', ?, '[]', '[]', '[]', NULL,
    ?, ?, '', '', 'snippet', '[]', '[]',
    0, 0, 0, 0, 0, NULL, 0, 0,
    NULL, '', 'primary', '', '',
    1, 1, ?, ?
  )`);
  const accountIds = [];
  db.transaction(() => {
    for (let accountIndex = 0; accountIndex < accounts; accountIndex += 1) {
      const accountId = `acct-${accountIndex}`;
      const created = '2020-01-01T00:00:00.000Z';
      insertAccount.run(accountId, `owner${accountIndex}@example.test`, `Owner ${accountIndex}`, created, created);
      accountIds.push(accountId);
      for (let messageIndex = 0; messageIndex < messagesPerAccount; messageIndex += 1) {
        const threadId = `thr-${accountIndex}-${messageIndex}`;
        const messageId = `msg-${accountIndex}-${messageIndex}`;
        const sentAt = new Date(Date.UTC(2026, 0, 1, 0, 0, messageIndex)).toISOString();
        insertThread.run(threadId, accountId, `Subject ${messageIndex}`, `subject ${messageIndex}`, sentAt, sentAt, sentAt);
        insertMessage.run(
          messageId,
          accountId,
          threadId,
          messageIndex + 1,
          `<${messageId}@example.test>`,
          `Subject ${messageIndex}`,
          `friend${messageIndex}@example.test`,
          sentAt,
          sentAt,
          sentAt,
          sentAt,
        );
      }
    }
  })();
  return accountIds;
}

function timeMs(work) {
  const started = process.hrtime.bigint();
  const result = work();
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { result, durationMs };
}

async function timeMsAsync(work) {
  const started = process.hrtime.bigint();
  const result = await work();
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { result, durationMs };
}

test('GET /api/messages is cheap on a 20-account, 30k-message mailbox', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-inbox-bench-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const accountIds = seedLargeMailbox(db);
  const totalMessages = ACCOUNT_COUNT * MESSAGES_PER_ACCOUNT;
  assert.equal(accountIds.length, ACCOUNT_COUNT);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c), totalMessages);

  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_inbox_list'`).all();
  assert.equal(indexes.length, 1);

  const cheapSql = buildConversationSearch({
    accountIds,
    folder: 'inbox',
    hideQuiet: true,
    limit: 50,
    offset: 0,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  const legacySql = buildConversationSearch({
    accountIds,
    folder: 'inbox',
    hideQuiet: true,
    forceLegacy: true,
    limit: 50,
    offset: 0,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  const cheapPlan = db.prepare(`EXPLAIN QUERY PLAN ${cheapSql.pageSql}`).all(cheapSql.params);
  const planText = cheapPlan.map((row) => row.detail).join('\n');
  console.log(`inbox-bench-plan ${planText.replaceAll('\n', ' | ')}`);
  assert.match(planText, /INDEX|COVERING|idx_messages/i);

  const runLegacySql = () => {
    db.prepare(legacySql.pageSql).all(legacySql.params);
    db.prepare(legacySql.countSql).get(legacySql.params);
    db.prepare(legacySql.categorySql).all(legacySql.params);
  };
  const runCheapSql = () => {
    db.prepare(cheapSql.pageSql).all(cheapSql.params);
    db.prepare(cheapSql.countSql).get(cheapSql.params);
    db.prepare(cheapSql.categorySql).all(cheapSql.params);
  };

  // Warm the statements once so the comparison is execution, not prepare.
  runLegacySql();
  runCheapSql();
  const before = timeMs(runLegacySql);
  const after = timeMs(runCheapSql);
  const assembled = await timeMsAsync(() => listConversations(repos, { folder: 'inbox', pageSize: 50 }));
  const assembledAfter = await timeMsAsync(() => listConversations(repos, { folder: 'inbox', pageSize: 50 }));
  const cached = assembledAfter.result;
  const stamp = repos.changes.stamp().changedAt;
  const etag = conversationListEtag(stamp, { folder: 'inbox', pageSize: 50, query: '' });
  const etagAgain = conversationListEtag(stamp, { folder: 'inbox', pageSize: parsePageSize(50), query: '' });

  const report = {
    accounts: ACCOUNT_COUNT,
    messages: totalMessages,
    beforeLegacySqlMs: Number(before.durationMs.toFixed(2)),
    afterCheapSqlMs: Number(after.durationMs.toFixed(2)),
    afterListConversationsMs: Number(assembled.durationMs.toFixed(2)),
    cachedListConversationsMs: Number(assembledAfter.durationMs.toFixed(2)),
    speedupSql: before.durationMs > 0 ? Number((before.durationMs / Math.max(after.durationMs, 0.01)).toFixed(1)) : null,
    pageSize: cached.pageSize,
    total: cached.total,
    etag,
  };
  // Printed for the PR. The assertions below are the gate.
  console.log(`inbox-bench ${JSON.stringify(report)}`);

  assert.equal(cached.pageSize, 50);
  assert.equal(cached.messages.length, 50);
  assert.equal(cached.total, totalMessages);
  assert.ok(after.durationMs < before.durationMs, `cheap SQL ${after.durationMs}ms should beat legacy ${before.durationMs}ms`);
  assert.ok(assembledAfter.durationMs < 5, `unchanged inbox cache should be nearly free, got ${assembledAfter.durationMs}ms`);
  assert.equal(etag, etagAgain);
  assert.ok(assembled.durationMs < 500, `assembled inbox listing ${assembled.durationMs}ms should stay well under a second`);
});
