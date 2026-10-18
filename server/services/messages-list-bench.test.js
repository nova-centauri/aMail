import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { buildConversationSearch, cheapWindowedListingSql } from './conversation-search.js';
import { listConversations } from './inbox.js';

const ACCOUNT_COUNT = 8;
const MESSAGES_PER_ACCOUNT = 1_200;

function seedMailbox(db, { accounts = ACCOUNT_COUNT, messagesPerAccount = MESSAGES_PER_ACCOUNT } = {}) {
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
    NULL, '', ?, '', '',
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
        const category = messageIndex % 40 === 0 ? 'ops_quiet' : 'primary';
        insertThread.run(threadId, accountId, `Subject ${messageIndex}`, `subject ${messageIndex}`, sentAt, sentAt, sentAt);
        insertMessage.run(
          messageId, accountId, threadId, messageIndex + 1, `<${messageId}@example.test>`,
          `Subject ${messageIndex}`, `friend${messageIndex}@example.test`,
          sentAt, sentAt, category, sentAt, sentAt,
        );
      }
    }
  })();
  return accountIds;
}

function timeMs(work) {
  const started = process.hrtime.bigint();
  const result = work();
  return { result, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

test('bounded inbox listing beats the windowed COUNT path and keeps the same page', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-list-bench-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const accountIds = seedMailbox(db);
  const nowIso = '2026-10-18T00:00:00.000Z';
  const after = buildConversationSearch({
    accountIds, folder: 'inbox', hideQuiet: true, limit: 50, offset: 0, nowIso,
  });
  const before = {
    params: { ...after.params },
    ...cheapWindowedListingSql({
      accountSql: `m.account_id IN (${accountIds.map((_, index) => `@headAccount${index}`).join(', ')})`,
      hideQuiet: true,
      category: '',
      folder: 'inbox',
    }),
  };

  const beforePlan = db.prepare(`EXPLAIN QUERY PLAN ${before.pageSql}`).all(before.params)
    .map((row) => row.detail).join('\n');
  const afterPlan = db.prepare(`EXPLAIN QUERY PLAN ${after.pageSql}`).all(after.params)
    .map((row) => row.detail).join('\n');
  assert.match(beforePlan, /MATERIALIZE/);
  assert.doesNotMatch(afterPlan, /MATERIALIZE/);
  assert.match(afterPlan, /idx_messages_inbox_list/);

  const runBefore = () => {
    db.prepare(before.pageSql).all(before.params);
    db.prepare(before.categorySql).all(before.params);
  };
  const runAfter = () => {
    db.prepare(after.pageSql).all(after.params);
    db.prepare(after.categorySql).all(after.params);
  };
  runBefore();
  runAfter();
  const beforeTiming = timeMs(runBefore);
  const afterTiming = timeMs(runAfter);
  const beforePage = db.prepare(before.pageSql).all(before.params);
  const afterPage = db.prepare(after.pageSql).all(after.params);
  assert.deepEqual(afterPage.map((row) => row.threadId), beforePage.map((row) => row.threadId));
  assert.equal(beforePage[0].total, ACCOUNT_COUNT * MESSAGES_PER_ACCOUNT * 39 / 40);
  const listed = await listConversations(repos, { folder: 'inbox', pageSize: 50 });
  assert.equal(listed.total, beforePage[0].total);
  assert.equal(listed.messages.length, 50);
  assert.ok(
    afterTiming.durationMs < beforeTiming.durationMs,
    `expected bounded listing ${afterTiming.durationMs.toFixed(1)}ms < windowed ${beforeTiming.durationMs.toFixed(1)}ms`,
  );
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    messages: ACCOUNT_COUNT * MESSAGES_PER_ACCOUNT,
    beforeWindowedMs: Number(beforeTiming.durationMs.toFixed(2)),
    afterBoundedMs: Number(afterTiming.durationMs.toFixed(2)),
    speedup: Number((beforeTiming.durationMs / Math.max(afterTiming.durationMs, 0.01)).toFixed(1)),
  }));
});
