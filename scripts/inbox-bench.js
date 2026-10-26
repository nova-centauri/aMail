/**
 * Opt-in inbox listing benchmark. Not part of `npm test`.
 *
 *   npm run bench
 *
 * Prints before/after timings for the windowed latest-per-thread COUNT path
 * vs the bounded per-account inbox walk on a 20-account, 200k-message mailbox.
 * Wall-clock numbers are informational; CI uses messages-list-bench.test.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, createRepositories } from '../server/db.js';
import { buildConversationSearch, cheapWindowedListingSql } from '../server/services/conversation-search.js';
import { conversationListEtag, listConversations, parsePageSize } from '../server/services/inbox.js';
import { parseMailboxQuery } from '../server/mail/search-query.js';

const ACCOUNT_COUNT = 20;
const MESSAGES_PER_ACCOUNT = 10_000;

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-inbox-bench-'));
const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
const repos = createRepositories(db);

try {
  const accountIds = seedLargeMailbox(db);
  const totalMessages = ACCOUNT_COUNT * MESSAGES_PER_ACCOUNT;
  const cheapSql = buildConversationSearch({
    accountIds,
    folder: 'inbox',
    hideQuiet: true,
    limit: 50,
    offset: 0,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  const windowedSql = {
    params: { ...cheapSql.params },
    ...cheapWindowedListingSql({
      accountSql: `m.account_id IN (${accountIds.map((_, index) => `@headAccount${index}`).join(', ')})`,
      hideQuiet: true,
      category: '',
      folder: 'inbox',
    }),
  };
  const cheapPlan = db.prepare(`EXPLAIN QUERY PLAN ${cheapSql.pageSql}`).all(cheapSql.params);
  const planText = cheapPlan.map((row) => row.detail).join(' | ');
  const windowedPlan = db.prepare(`EXPLAIN QUERY PLAN ${windowedSql.pageSql}`).all(windowedSql.params)
    .map((row) => row.detail)
    .join(' | ');

  const runWindowedSql = () => {
    db.prepare(windowedSql.pageSql).all(windowedSql.params);
    db.prepare(windowedSql.categorySql).all(windowedSql.params);
  };
  const runCheapSql = () => {
    db.prepare(cheapSql.pageSql).all(cheapSql.params);
    db.prepare(cheapSql.categorySql).all(cheapSql.params);
  };

  runWindowedSql();
  runCheapSql();
  const before = timeMs(runWindowedSql);
  const after = timeMs(runCheapSql);
  const folders = timeMs(() => repos.messages.folderCountsForAccounts(accountIds));
  const missingDomainInput = {
    accountIds,
    folder: 'inbox',
    parsed: parseMailboxQuery('from:does-not-exist.invalid'),
    limit: 50,
    offset: 0,
  };
  const missingDomainSql = buildConversationSearch({
    ...missingDomainInput,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  const missingDomainPlan = db.prepare(`EXPLAIN QUERY PLAN ${missingDomainSql.pageSql}`).all(missingDomainSql.params)
    .map((row) => row.detail)
    .join(' | ');
  repos.messages.searchConversations(missingDomainInput);
  const missingDomain = timeMs(() => repos.messages.searchConversations(missingDomainInput));
  const assembled = await timeMsAsync(() => listConversations(repos, { folder: 'inbox', pageSize: 50 }));
  const assembledAfter = await timeMsAsync(() => listConversations(repos, { folder: 'inbox', pageSize: 50 }));
  const cached = assembledAfter.result;
  const stamp = repos.changes.stamp().changedAt;
  const etag = conversationListEtag(stamp, { folder: 'inbox', pageSize: parsePageSize(50), query: '' });

  const report = {
    accounts: ACCOUNT_COUNT,
    messages: totalMessages,
    beforeWindowedSqlMs: Number(before.durationMs.toFixed(2)),
    afterBoundedSqlMs: Number(after.durationMs.toFixed(2)),
    folderCountsMs: Number(folders.durationMs.toFixed(2)),
    missingDomainSearchMs: Number(missingDomain.durationMs.toFixed(2)),
    missingDomainTotal: missingDomain.result.total,
    afterListConversationsMs: Number(assembled.durationMs.toFixed(2)),
    cachedListConversationsMs: Number(assembledAfter.durationMs.toFixed(2)),
    speedupSql: before.durationMs > 0 ? Number((before.durationMs / Math.max(after.durationMs, 0.01)).toFixed(1)) : null,
    pageSize: cached.pageSize,
    total: cached.total,
    etag,
    plan: planText,
    beforePlan: windowedPlan,
    missingDomainPlan,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  repos.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
