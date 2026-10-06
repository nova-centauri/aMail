import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createDeepSearchService, estimateDeepSearchWork, planDeepSearchUnits, progressSnapshot } from './deep-search.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-deep-search-'));
  const db = createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') });
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const work = repos.accounts.create({
    email: 'work@example.test', display_name: 'Work', avatar_blob: null, avatar_mime: null,
    color: '#1a73e8', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  const home = repos.accounts.create({
    email: 'home@example.test', display_name: 'Home', avatar_blob: null, avatar_mime: null,
    color: '#0b57d0', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  let uid = 0;
  const add = (account, subject, extra = {}) => {
    const thread = repos.threads.create({
      account_id: account.id, subject, normalized_subject: subject.toLowerCase(), latest_at: '2026-01-01T00:00:00.000Z',
    });
    const message = repos.messages.upsert({
      account_id: account.id, thread_id: thread.id, mailbox: extra.mailbox || 'INBOX', uid: extra.uid || ++uid,
      rfc_message_id: extra.rfc_message_id || `<local-${uid}@example.test>`, in_reply_to: null, references_json: '[]',
      subject, from_name: extra.from_name || 'Vendor', from_email: extra.from_email || 'accounts@vendor.test',
      to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
      sent_at: extra.sent_at || '2026-01-01T00:00:00.000Z',
      received_at: extra.received_at || extra.sent_at || '2026-01-01T00:00:00.000Z',
      html_body: '', text_body: extra.text_body || `${subject} body`, snippet: extra.snippet || subject,
      attachments_json: extra.attachments_json || '[]', labels_json: '[]',
      is_read: 0, is_starred: 0, is_archived: extra.is_archived || 0, is_trashed: 0, is_spam: 0,
      snoozed_until: null, is_sent: extra.is_sent || 0, source_imported: extra.source_imported ?? 1,
    });
    return { thread, message };
  };
  return { repos, work, home, add };
}

function envelopeHit(repos, account, conversation, extras = {}) {
  repos.messages.upsert({
    account_id: account.id,
    thread_id: conversation.id,
    mailbox: extras.mailbox || 'INBOX',
    uid: extras.uid || 9001,
    rfc_message_id: extras.rfc_message_id || '<old-invoice@vendor.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: extras.subject || 'Old invoice',
    from_name: 'Vendor',
    from_email: 'accounts@vendor.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: extras.sent_at || '2019-01-01T00:00:00.000Z',
    received_at: extras.sent_at || '2019-01-01T00:00:00.000Z',
    html_body: '',
    text_body: '',
    snippet: extras.subject || 'Old invoice',
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
    source_imported: 0,
  });
  return conversation.id;
}

test('progress units count accounts and folders, not a fake timer', () => {
  const units = planDeepSearchUnits(
    [{ id: 'a', email: 'a@test' }, { id: 'b', email: 'b@test' }],
    [
      { accountId: 'a', folders: [{ mailbox: 'INBOX' }, { mailbox: 'Sent' }] },
      { accountId: 'b', folders: [{ mailbox: 'INBOX' }] },
    ],
  );
  assert.equal(units[0].kind, 'local');
  assert.equal(units.filter((unit) => unit.kind === 'imap').length, 3);
  assert.equal(units.length, 1 + 2 + 3);
});

test('progress estimate keeps unseen accounts on the bar', () => {
  const firstFolder = estimateDeepSearchWork({
    accountCount: 3,
    accountPlans: new Map([
      ['work', { folderCount: 3, seen: 1 }],
      ['home', { seen: 0 }],
      ['studio', { seen: 0 }],
    ]),
    completedMailboxes: 1,
  });
  assert.equal(firstFolder.total, 1 + 3 + 3 + 3);
  assert.equal(firstFolder.done, 2);
  assert.ok(firstFolder.ratio < 0.3);
  const afterFirstAccount = estimateDeepSearchWork({
    accountCount: 3,
    accountPlans: new Map([
      ['work', { folderCount: 3, seen: 3 }],
      ['home', { seen: 0 }],
      ['studio', { seen: 0 }],
    ]),
    completedMailboxes: 3,
  });
  assert.equal(afterFirstAccount.done, 4);
  assert.equal(afterFirstAccount.total, 10);
  assert.ok(afterFirstAccount.ratio < 0.5);
});

test('deep search streams local hits first then IMAP extras with real progress', async (t) => {
  const { repos, work, home, add } = fixture(t);
  const local = add(work, 'Recent invoice', { text_body: 'pay the recent invoice', sent_at: '2026-02-01T00:00:00.000Z' });
  add(home, 'Unrelated', { text_body: 'hello', from_email: 'friend@home.test' });
  const historical = repos.threads.create({
    account_id: home.id, subject: 'Old invoice', normalized_subject: 'old invoice', latest_at: '2019-01-01T00:00:00.000Z',
  });
  const events = [];
  let hitCalls = 0;
  const mailService = {
    async searchAndMaterialize({ onHits, onProgress }) {
      hitCalls += 1;
      onProgress?.({
        accountId: work.id,
        email: work.email,
        mailbox: null,
        phase: 'list',
        folderCount: 3,
        accountIndex: 0,
        accountCount: 2,
      });
      onProgress?.({
        accountId: work.id,
        email: work.email,
        mailbox: 'INBOX',
        folderCount: 3,
        accountIndex: 0,
        accountCount: 2,
      });
      const mid = events.filter((item) => item.event === 'progress').at(-1);
      assert.ok(mid?.data?.ratio < 1, 'bar must stay below 100% while other accounts remain');
      const threadId = envelopeHit(repos, home, historical, { uid: 77 });
      await onHits?.({ accountId: home.id, mailbox: 'INBOX', threadIds: [threadId] });
      onProgress?.({
        accountId: home.id,
        email: home.email,
        mailbox: 'Sent',
        folderCount: 3,
        accountIndex: 1,
        accountCount: 2,
      });
      return { cancelled: false, threadIds: [threadId] };
    },
  };
  const service = createDeepSearchService({ repos, mailService });
  const job = service.start({ query: 'invoice', paceMs: 0 });
  service.subscribe(job.id, (event, data) => events.push({ event, data }));
  await service.whenSettled(job.id);
  const snapshot = service.snapshot(job.id);
  assert.equal(snapshot.status, 'complete');
  assert.equal(hitCalls, 1);
  assert.ok(snapshot.messages.some((item) => item.id === local.thread.id));
  assert.ok(snapshot.messages.some((item) => item.id === historical.id));
  assert.ok(events.some((item) => item.event === 'result' && item.data.messages.some((row) => row.id === local.thread.id)));
  assert.ok(events.some((item) => item.event === 'result' && item.data.messages.some((row) => row.id === historical.id)));
  assert.ok(events.some((item) => item.event === 'progress' && item.data.mailbox === 'INBOX'));
  assert.ok(events.some((item) => item.event === 'progress' && item.data.mailbox === 'Sent'));
  assert.equal(progressSnapshot(job).done, progressSnapshot(job).total);
  assert.equal(progressSnapshot(job).phase, 'done');
});

test('deep search keeps operators and analyzed filters on the local cache', async (t) => {
  const { repos, work, add } = fixture(t);
  add(work, 'Invoice from Ada', { from_email: 'ada@example.test', text_body: 'invoice' });
  add(work, 'Invoice from Bea', { from_email: 'bea@example.test', text_body: 'invoice' });
  let providerCalls = 0;
  const service = createDeepSearchService({
    repos,
    mailService: {
      async searchAndMaterialize() {
        providerCalls += 1;
        return { cancelled: false, threadIds: [] };
      },
    },
  });
  const filtered = service.start({ query: 'invoice from:ada@example.test', paceMs: 0 });
  await service.whenSettled(filtered.id);
  assert.equal(service.snapshot(filtered.id).messages.length, 1);
  assert.equal(service.snapshot(filtered.id).messages[0].from.email, 'ada@example.test');
  assert.equal(providerCalls, 1);

  const analyzed = service.start({ query: 'invoice is:unanalyzed', paceMs: 0 });
  await service.whenSettled(analyzed.id);
  assert.equal(providerCalls, 1);
  assert.ok(service.snapshot(analyzed.id).messages.length >= 1);
});

test('cancel stops an in-flight deep search and keeps results so far', async (t) => {
  const { repos, work, add } = fixture(t);
  add(work, 'Recent invoice', { text_body: 'invoice' });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const service = createDeepSearchService({
    repos,
    mailService: {
      async searchAndMaterialize({ signal }) {
        await hold;
        if (signal?.aborted) return { cancelled: true, threadIds: [] };
        return { cancelled: false, threadIds: [] };
      },
    },
  });
  const job = service.start({ query: 'invoice', paceMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = service.cancel(job.id);
  release();
  await service.whenSettled(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(service.snapshot(job.id).status, 'cancelled');
  assert.ok(service.snapshot(job.id).messages.length >= 1);
});

test('cross-account Message-ID hits are deduped in the streamed page', async (t) => {
  const { repos, work, home, add } = fixture(t);
  add(work, 'Invoice copy', {
    rfc_message_id: '<same-invoice@vendor.test>',
    text_body: 'invoice',
    sent_at: '2026-01-02T00:00:00.000Z',
  });
  const other = repos.threads.create({
    account_id: home.id, subject: 'Invoice copy', normalized_subject: 'invoice copy', latest_at: '2019-01-01T00:00:00.000Z',
  });
  const service = createDeepSearchService({
    repos,
    mailService: {
      async searchAndMaterialize({ onHits }) {
        envelopeHit(repos, home, other, {
          rfc_message_id: '<same-invoice@vendor.test>',
          subject: 'Invoice copy',
          uid: 44,
        });
        await onHits?.({ threadIds: [other.id] });
        return { cancelled: false, threadIds: [other.id] };
      },
    },
  });
  const job = service.start({ query: 'invoice', paceMs: 0 });
  await service.whenSettled(job.id);
  const ids = service.snapshot(job.id).messages.map((item) => item.messageId || item.id);
  assert.equal(service.snapshot(job.id).messages.filter((item) => item.messageId === '<same-invoice@vendor.test>').length, 1);
  assert.ok(ids.length >= 1);
});
