import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config.js';
import { createDatabase, createRepositories } from '../db.js';
import { parseMailboxQuery } from '../mail/search-query.js';
import {
  buildThreadDocuments,
  buildTypesenseQuery,
  createSearchEngine,
  resolveSearchBackend,
  searchTokens,
} from './search-engine.js';

const logger = { info() {}, warn() {} };

test('search backend stays inside SQLCipher unless Typesense is explicitly forced', () => {
  const url = 'http://typesense:8108/';
  const key = 'secret';
  assert.deepEqual(resolveSearchBackend({ searchEngine: 'auto' }), {
    name: 'fts', enabled: false, plaintextIndex: false, reason: 'unconfigured',
  });
  assert.equal(resolveSearchBackend({
    searchEngine: 'auto', typesenseUrl: url, typesenseApiKey: key, encryptDatabase: false, keyMode: 'env',
  }).name, 'typesense');
  assert.equal(resolveSearchBackend({
    searchEngine: 'auto', typesenseUrl: url, typesenseApiKey: key, encryptDatabase: true, databaseKey: Buffer.alloc(32), keyMode: 'env',
  }).reason, 'encrypted-database');
  const forced = resolveSearchBackend({
    searchEngine: 'typesense', typesenseUrl: url, typesenseApiKey: key, encryptDatabase: true, databaseKey: Buffer.alloc(32), keyMode: 'env',
  });
  assert.equal(forced.enabled, true);
  assert.equal(forced.plaintextIndex, true);
  assert.equal(resolveSearchBackend({
    searchEngine: 'off', typesenseUrl: url, typesenseApiKey: key,
  }).enabled, false);
  const locked = new Proxy({
    keyMode: 'keyslot',
    searchEngine: 'auto',
    typesenseUrl: url,
    typesenseApiKey: key,
    encryptDatabase: true,
  }, {
    get(target, property) {
      if (property === 'databaseKey') throw new Error('locked');
      return target[property];
    },
  });
  assert.equal(resolveSearchBackend(locked).reason, 'encrypted-database');
  assert.equal(loadConfig({}).searchEngine, 'auto');
  assert.equal(loadConfig({ AMAIL_SEARCH_ENGINE: 'FTS' }).searchEngine, 'fts');
  assert.equal(loadConfig({ AMAIL_SEARCH_ENGINE: 'elasticsearch' }).searchEngine, 'auto');
  assert.equal(loadConfig({ AMAIL_TYPESENSE_API_KEY: 'abc', AMAIL_TYPESENSE_URL: 'http://127.0.0.1:8108' }).typesenseApiKey, 'abc');
});

test('indexed threads keep body text across a prune and denormalize folder operators', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const docs = buildThreadDocuments([
    {
      id: 'm1', account_id: 'acct', thread_id: 'thread', mailbox: 'INBOX',
      subject: 'Invoice', from_name: 'Vendor Accounts', from_email: 'accounts@vendor.test',
      to_json: JSON.stringify([{ name: 'Owner', email: 'owner@example.test' }]),
      cc_json: '[]', bcc_json: '[]', reply_to_json: null,
      sent_at: '2020-01-01T00:00:00.000Z', text_body: '', snippet: 'old',
      attachments_json: '[]', is_read: 0, is_starred: 1, is_archived: 0, is_trashed: 0, is_spam: 0,
      snoozed_until: null, is_sent: 0, analyzed_at: null, smart_category: 'primary', source_imported: 1,
    },
    {
      id: 'm2', account_id: 'acct', thread_id: 'thread', mailbox: 'INBOX',
      subject: 'Invoice', from_name: 'Vendor Accounts', from_email: 'accounts@vendor.test',
      to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
      sent_at: '2024-05-01T00:00:00.000Z', text_body: 'please pay the winter invoice', snippet: 'please pay',
      attachments_json: JSON.stringify([{ filename: 'bill.pdf', contentType: 'application/pdf', size: 10 }]),
      is_read: 1, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
      snoozed_until: null, is_sent: 0, analyzed_at: '2026-01-01T00:00:00.000Z', smart_category: 'primary', source_imported: 1,
    },
  ], now);
  assert.equal(docs.length, 2);
  assert.equal(Object.hasOwn(docs[0], 'text_body'), false);
  assert.equal(docs[1].text_body, 'please pay the winter invoice');
  assert.ok(docs[0].from_tokens.includes('vendor'));
  assert.ok(docs[0].from_tokens.includes('accounts@vendor.test'));
  assert.ok(docs[1].thread_from.includes('inbox:vendor'));
  assert.ok(docs[0].unread_in.includes('inbox'));
  assert.ok(docs[0].starred_in.includes('inbox'));
  assert.ok(docs[0].attachment_in.includes('inbox'));
  assert.ok(docs[0].attachments === '' || docs[1].attachments.includes('bill.pdf'));
  assert.equal(docs[0].latest_inbox, Date.parse('2024-05-01T00:00:00.000Z'));
  assert.ok(docs[0].unanalyzed_in.includes('inbox'));
  assert.ok(docs[0].imported_in.includes('inbox'));
  assert.ok(searchTokens('accounts@vendor.test').includes('vendor'));

  const envelope = buildThreadDocuments([{
    id: 'env', account_id: 'acct', thread_id: 'env-thread', mailbox: 'INBOX',
    subject: 'Old', from_name: '', from_email: 'a@b.test', to_json: '[]', cc_json: '[]', bcc_json: '[]',
    sent_at: '2019-01-01T00:00:00.000Z', text_body: '', snippet: 'Old', attachments_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, is_sent: 0,
    analyzed_at: null, smart_category: 'primary', source_imported: 0,
  }], now);
  assert.deepEqual(envelope[0].unanalyzed_in, []);
  assert.deepEqual(envelope[0].imported_in, []);
});

test('Typesense queries group by thread and do not clip pages at 100 or 1000', () => {
  const nowMs = Date.parse('2026-09-28T00:00:00.000Z');
  const built = buildTypesenseQuery({
    accountIds: ['acct-1'],
    folder: 'inbox',
    parsed: parseMailboxQuery('from:vendor subject:invoice -from:spam@x.test has:attachment after:2024-01-01 is:unread is:starred please pay'),
    page: 21,
    pageSize: 50,
    nowMs,
  });
  const search = built.searches[0];
  assert.equal(search.collection, 'amail_messages_v1');
  assert.equal(search.q, 'please pay');
  assert.equal(search.group_by, 'thread_key');
  assert.equal(search.group_limit, 1);
  assert.equal(search.page, 21);
  assert.equal(search.per_page, 50);
  assert.equal(search.limit_hits, undefined);
  assert.match(search.sort_by, /_text_match:desc/);
  assert.match(search.filter_by, /from_tokens:=vendor/);
  assert.match(search.filter_by, /subject_tokens:=invoice/);
  assert.match(search.filter_by, /thread_from:=`inbox:spam@x\.test`/);
  assert.match(search.filter_by, /attachment_in:=inbox/);
  assert.match(search.filter_by, /unread_in:=inbox/);
  assert.match(search.filter_by, /starred_in:=inbox/);
  assert.match(search.filter_by, /latest_inbox:>=/);
  assert.equal(built.searches.length, 6);
  assert.match(built.searches[1].filter_by, /category_in:=`inbox:primary`/);
  assert.doesNotMatch(search.filter_by, /category_in:/);

  const analyzed = buildTypesenseQuery({
    accountIds: ['acct-1'],
    folder: 'inbox',
    parsed: parseMailboxQuery('is:analyzed invoice'),
    offset: 1000,
    limit: 50,
    nowMs,
  });
  assert.match(analyzed.searches[0].filter_by, /!\(unanalyzed_in:=inbox\)/);
  assert.match(analyzed.searches[0].filter_by, /imported_in:=inbox/);
  assert.equal(analyzed.searches[0].offset, 1000);
  assert.equal(analyzed.searches[0].limit, 50);
  assert.equal(buildTypesenseQuery({ accountIds: ['acct-1'], parsed: parseMailboxQuery('from:ada@example.test'), nowMs }), null);
});

test('the Typesense client imports with emplace and reads grouped thread pages', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url, body, key: request.headers['x-typesense-api-key'] });
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url.startsWith('/collections/amail_messages_v1')) {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      if (request.method === 'POST' && request.url.includes('/documents/import')) {
        response.writeHead(200);
        response.end(body.split('\n').filter(Boolean).map(() => '{"success":true}').join('\n'));
        return;
      }
      if (request.method === 'POST' && request.url === '/multi_search') {
        const parsed = JSON.parse(body);
        response.writeHead(200);
        response.end(JSON.stringify({
          results: parsed.searches.map((entry, index) => ({
            found: index === 0 ? 3 : (entry.filter_by.includes('inbox:primary') ? 2 : 0),
            grouped_hits: index === 0 ? [
              { hits: [{ document: { thread_id: 'thread-b' } }] },
              { hits: [{ document: { thread_id: 'thread-a' } }] },
            ] : [],
          })),
        }));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const rows = [{
    id: 'm1', account_id: 'acct', thread_id: 'thread-a', mailbox: 'INBOX',
    subject: 'Hello', from_name: '', from_email: 'a@b.test', to_json: '[]', cc_json: '[]', bcc_json: '[]',
    sent_at: '2026-01-01T00:00:00.000Z', text_body: '', snippet: 'Hello', attachments_json: '[]',
    is_read: 1, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, is_sent: 0,
    analyzed_at: null, smart_category: 'primary', source_imported: 1,
  }];
  const repos = {
    messages: {
      searchThreadPage() { return []; },
      searchThreadIdsForMessages() { return ['thread-a']; },
      searchRowsForThreads() { return rows; },
    },
  };
  const engine = createSearchEngine({
    config: {
      searchEngine: 'typesense',
      typesenseUrl: `http://127.0.0.1:${port}`,
      typesenseApiKey: 'test-key',
      encryptDatabase: false,
      keyMode: 'env',
    },
    repos,
    logger,
  });
  t.after(() => {
    engine.stop();
    server.close();
  });
  engine.start();
  await engine.whenIdle();
  assert.equal(engine.enabled, true);
  engine.noteWrite({ messageIds: ['m1'] });
  await engine.whenIdle();
  const imported = requests.find((entry) => entry.url.includes('action=emplace'));
  assert.ok(imported);
  assert.equal(imported.key, 'test-key');
  const document = JSON.parse(imported.body);
  assert.equal(document.id, 'm1');
  assert.equal(Object.hasOwn(document, 'text_body'), false);

  const page = await engine.searchConversations({
    accountIds: ['acct'],
    folder: 'inbox',
    parsed: parseMailboxQuery('from:vendor hello'),
    page: 1,
    pageSize: 50,
    nowMs: Date.parse('2026-09-28T00:00:00.000Z'),
  });
  assert.deepEqual(page.threadIds, ['thread-b', 'thread-a']);
  assert.equal(page.total, 3);
  assert.equal(page.categoryCounts.find((row) => row.category === 'primary').count, 2);
  const search = requests.find((entry) => entry.url === '/multi_search');
  const body = JSON.parse(search.body);
  assert.equal(body.searches[0].group_by, 'thread_key');
  assert.equal(body.searches[0].per_page, 50);
  assert.equal(body.searches[0].limit_hits, undefined);
  assert.match(body.searches[0].filter_by, /from_tokens:=vendor/);
});

test('message writes notify the search indexer after the database transaction', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-search-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const events = [];
  repos.setSearchIndexer((event) => events.push(event));
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', avatar_blob: null, avatar_mime: null,
    color: '#1a73e8', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  const conversation = repos.threads.create({
    account_id: account.id, subject: 'Hello', normalized_subject: 'hello', latest_at: '2026-01-01T00:00:00.000Z',
  });
  const base = {
    account_id: account.id, thread_id: conversation.id, mailbox: 'INBOX',
    in_reply_to: null, references_json: '[]', subject: 'Hello', from_name: '', from_email: 'a@b.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:00.000Z',
    html_body: '', text_body: 'hello body', snippet: 'hello', attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0, snoozed_until: null, is_sent: 0,
  };
  events.length = 0;
  const first = repos.messages.upsert({ ...base, uid: 1, rfc_message_id: '<1@example.test>' });
  const second = repos.messages.upsert({ ...base, uid: 2, rfc_message_id: '<2@example.test>' });
  assert.deepEqual(events.map((event) => event.messageIds), [[first.id], [second.id]]);
  repos.messages.setState(first.id, { isAnalyzed: true, analyzedBy: 'test' });
  assert.deepEqual(events.at(-1).messageIds, [first.id]);
  events.length = 0;
  repos.runWriteBatch(() => {
    repos.messages.upsert({ ...base, uid: 3, rfc_message_id: '<3@example.test>' });
    repos.messages.upsert({ ...base, uid: 4, rfc_message_id: '<4@example.test>' });
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageIds.length, 2);
  repos.accounts.remove(account.id);
  assert.equal(events.at(-1).accountRemoved, account.id);
});
