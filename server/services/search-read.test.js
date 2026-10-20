import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { QueryDeadlineError } from '../errors.js';
import { createSearchRead, searchReadWorkerEnabled } from './search-read.js';
import { parseMailboxQuery } from '../mail/search-query.js';

function seed(repos) {
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
    credential_ciphertext: 'x',
    signature: '',
    sync_enabled: 0,
  });
  const thread = repos.threads.create({
    account_id: account.id,
    subject: 'Hello',
    normalized_subject: 'hello',
    latest_at: '2026-03-01T00:00:00.000Z',
  });
  repos.messages.upsert({
    account_id: account.id,
    thread_id: thread.id,
    mailbox: 'INBOX',
    uid: 1,
    rfc_message_id: '<search-read@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Hello',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-03-01T00:00:00.000Z',
    received_at: '2026-03-01T00:00:00.000Z',
    html_body: '<p>Hello</p>',
    text_body: 'Hello',
    snippet: 'Hello',
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
  return { account, thread };
}

test('search worker stays off in test unless explicitly enabled', () => {
  assert.equal(searchReadWorkerEnabled({ env: 'test', dataDir: '/tmp', dbPath: '/tmp/mail.sqlite' }), false);
  assert.equal(searchReadWorkerEnabled({
    env: 'test', dataDir: '/tmp', dbPath: '/tmp/mail.sqlite', searchReadWorker: true,
  }), true);
  assert.equal(searchReadWorkerEnabled({ env: 'production', dbPath: ':memory:', dataDir: '/tmp' }), false);
});

test('a hung search is interrupted and the worker respawns', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-search-read-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    env: 'test',
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    searchReadWorker: true,
    searchQueryDeadlineMs: 250,
    searchReadTestHangMs: 2000,
  };
  const db = createDatabase(config);
  const repos = createRepositories(db);
  t.after(() => repos.close());
  seed(repos);
  const searchRead = createSearchRead({ config });
  t.after(() => searchRead.close());
  await assert.rejects(
    () => searchRead.searchConversations({
      accountIds: repos.accounts.list().map((account) => account.id),
      folder: 'inbox',
      parsed: parseMailboxQuery('from:friend@example.test'),
      limit: 50,
      offset: 0,
    }),
    (error) => error instanceof QueryDeadlineError && error.code === 'QUERY_DEADLINE',
  );
});

test('getThread returns the stored conversation from the worker', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-search-read-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    env: 'test',
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    searchReadWorker: true,
    searchQueryDeadlineMs: 5_000,
  };
  const db = createDatabase(config);
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const { thread } = seed(repos);
  const searchRead = createSearchRead({ config });
  t.after(() => searchRead.close());
  const loaded = await searchRead.getThread(thread.id);
  assert.equal(loaded.thread.id, thread.id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].from.email, 'friend@example.test');
});
