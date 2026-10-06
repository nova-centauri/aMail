import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerApi } from './api.js';

function parseSse(text) {
  const events = [];
  for (const block of String(text).split(/\n\n+/)) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

test('deep search SSE streams local results, progress, and IMAP extras', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-deep-api-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 4),
    accessToken: null,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
  };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  const account = repos.accounts.create({
    email: 'work@example.test', display_name: 'Work', avatar_blob: null, avatar_mime: null,
    color: '#1a73e8', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  const localThread = repos.threads.create({
    account_id: account.id, subject: 'Recent invoice', normalized_subject: 'recent invoice', latest_at: '2026-02-01T00:00:00.000Z',
  });
  repos.messages.upsert({
    account_id: account.id, thread_id: localThread.id, mailbox: 'INBOX', uid: 1,
    rfc_message_id: '<recent@vendor.test>', in_reply_to: null, references_json: '[]',
    subject: 'Recent invoice', from_name: 'Vendor', from_email: 'accounts@vendor.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: '2026-02-01T00:00:00.000Z', received_at: '2026-02-01T00:00:00.000Z',
    html_body: '', text_body: 'pay the recent invoice', snippet: 'Recent invoice',
    attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
    snoozed_until: null, is_sent: 0,
  });
  const historical = repos.threads.create({
    account_id: account.id, subject: 'Old invoice', normalized_subject: 'old invoice', latest_at: '2019-01-01T00:00:00.000Z',
  });
  const mailService = {
    async searchAndMaterialize({ onHits, onProgress }) {
      onProgress?.({ accountId: account.id, email: account.email, mailbox: 'INBOX', accountIndex: 0, accountCount: 1 });
      repos.messages.upsert({
        account_id: account.id, thread_id: historical.id, mailbox: 'INBOX', uid: 88,
        rfc_message_id: '<old@vendor.test>', in_reply_to: null, references_json: '[]',
        subject: 'Old invoice', from_name: 'Vendor', from_email: 'accounts@vendor.test',
        to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
        sent_at: '2019-01-01T00:00:00.000Z', received_at: '2019-01-01T00:00:00.000Z',
        html_body: '', text_body: '', snippet: 'Old invoice', attachments_json: '[]', labels_json: '[]',
        is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
        snoozed_until: null, is_sent: 0, source_imported: 0,
      });
      await onHits?.({ accountId: account.id, mailbox: 'INBOX', threadIds: [historical.id] });
      onProgress?.({ accountId: account.id, email: account.email, mailbox: 'Sent', accountIndex: 0, accountCount: 1 });
      return { cancelled: false, threadIds: [historical.id] };
    },
  };
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService, remoteContent: { canIssueTokens: false } });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const fast = await (await fetch(`${origin}/api/messages?q=invoice`)).json();
  assert.ok(fast.messages.some((item) => item.id === localThread.id));
  assert.equal(fast.messages.some((item) => item.id === historical.id), false);

  const created = await fetch(`${origin}/api/search/deep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'invoice', paceMs: 0 }),
  });
  assert.equal(created.status, 202);
  const started = await created.json();
  assert.ok(started.jobId);
  await new Promise((resolve) => setTimeout(resolve, 50));
  let snapshot = await (await fetch(`${origin}/api/search/deep/${started.jobId}`)).json();
  for (let attempt = 0; attempt < 20 && snapshot.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot = await (await fetch(`${origin}/api/search/deep/${started.jobId}`)).json();
  }
  assert.equal(snapshot.status, 'complete');
  assert.ok(snapshot.messages.some((item) => item.id === localThread.id));
  assert.ok(snapshot.messages.some((item) => item.id === historical.id));
  assert.equal(snapshot.progress.done, snapshot.progress.total);

  const stream = await fetch(`${origin}/api/search/deep?q=invoice&paceMs=0`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const events = parseSse(await stream.text());
  assert.ok(events.some((item) => item.event === 'hello'));
  assert.ok(events.some((item) => item.event === 'progress' && item.data.total >= 1));
  assert.ok(events.some((item) => item.event === 'result' && item.data.messages.some((row) => row.id === historical.id)));
  assert.ok(events.some((item) => item.event === 'done' && item.data.status === 'complete'));

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const slowService = {
    async searchAndMaterialize({ signal }) {
      await hold;
      if (signal?.aborted) return { cancelled: true, threadIds: [] };
      return { cancelled: false, threadIds: [] };
    },
  };
  const slowApp = express();
  slowApp.use(express.json());
  registerApi(slowApp, { config, repos, mailService: slowService, remoteContent: { canIssueTokens: false } });
  slowApp.use(errorHandler({ error() {} }));
  const slowServer = slowApp.listen(0, '127.0.0.1');
  await once(slowServer, 'listening');
  t.after(async () => { await new Promise((resolve) => slowServer.close(resolve)); });
  const slowOrigin = `http://127.0.0.1:${slowServer.address().port}`;
  const cancelStart = await (await fetch(`${slowOrigin}/api/search/deep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'invoice', paceMs: 0 }),
  })).json();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cancelled = await fetch(`${slowOrigin}/api/search/deep/${cancelStart.jobId}`, { method: 'DELETE' });
  release();
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
});
