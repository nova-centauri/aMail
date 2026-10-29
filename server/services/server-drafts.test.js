import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createMailService } from './mail-service.js';
import { encryptJson } from './crypto.js';
import { createFakeImapServer } from './fake-imap.test-support.js';

const credentialKey = Buffer.alloc(32, 9);

function harness(t, { imap = {}, config = {}, provider = 'custom', email = 'owner@example.test' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-server-drafts-'));
  const fullConfig = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey,
    syncTimeoutMs: 5_000,
    syncBatchSize: 50,
    imapPoolIdleMs: 0,
    ...config,
  };
  const repos = createRepositories(createDatabase(fullConfig));
  const server = createFakeImapServer(imap);
  const logs = [];
  const sent = [];
  let counter = 0;
  const service = createMailService({
    config: fullConfig,
    repos,
    logger: {
      info(fields, message) { logs.push({ level: 'info', fields, message }); },
      warn(fields, message) { logs.push({ level: 'warn', fields, message }); },
      error() {},
      debug() {},
    },
    ImapClient: server.FakeImapClient,
    createSmtpTransport: () => ({
      async sendMail(payload) {
        sent.push(payload);
        return { accepted: payload.envelope.to, rejected: [] };
      },
      close() {},
    }),
    createMessageId: () => `<draft-${++counter}@example.test>`,
  });
  const account = repos.accounts.create({
    email, display_name: 'Owner', color: '#1a73e8', provider,
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: encryptJson({ username: email, password: 'test-only' }, credentialKey),
    signature: '', sync_enabled: 1,
  });
  t.after(async () => {
    await service.close?.().catch(() => {});
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { repos, service, server: server.state, account, logs, sent };
}

function seedReceived(repos, account, { messageId = '<original@example.test>', references = [] } = {}) {
  const thread = repos.threads.create({
    account_id: account.id, subject: 'Dialing for dollars', normalized_subject: 'dialing for dollars',
    latest_at: '2026-10-28T12:00:00.000Z',
  });
  const message = repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'INBOX', uid: 5,
    rfc_message_id: messageId, in_reply_to: null, references_json: JSON.stringify(references),
    subject: 'Dialing for dollars', from_name: 'Jim', from_email: 'jim@example.test',
    to_json: JSON.stringify([{ name: 'Owner', email: account.email }]), cc_json: '[]', bcc_json: '[]',
    reply_to_json: null, sent_at: '2026-10-28T12:00:00.000Z', received_at: '2026-10-28T12:00:00.000Z',
    html_body: '<p>Call me</p>', text_body: 'Call me', snippet: 'Call me',
    attachments_json: '[]', labels_json: '[]', is_read: 1, is_starred: 0, is_archived: 0,
    is_trashed: 0, is_spam: 0, snoozed_until: null, is_sent: 0,
  });
  return { thread, message };
}

test('a new draft is appended to the server Drafts mailbox with \\Draft and reply headers', async (t) => {
  const { repos, service, server, account } = harness(t);
  const { thread } = seedReceived(repos, account, { references: ['<earlier@example.test>'] });

  const saved = await service.saveDraft({
    accountId: account.id,
    threadId: thread.id,
    to: [{ name: 'Jim', email: 'jim@example.test' }],
    bcc: ['hidden@example.test'],
    subject: 'Re: Dialing for dollars',
    textBody: 'Happy to talk Friday.',
  });

  assert.equal(server.appends.length, 1);
  const [append] = server.appends;
  assert.equal(append.path, 'Drafts');
  assert.deepEqual(append.flags, ['\\Draft', '\\Seen']);
  assert.match(append.raw, /^In-Reply-To: <original@example\.test>$/m);
  assert.match(append.raw, /^References: <earlier@example\.test> <original@example\.test>$/m);
  assert.match(append.raw, /^Bcc: hidden@example\.test$/m, 'a draft keeps Bcc for whoever sends it');
  assert.match(append.raw, /^Message-ID: <draft-1@example\.test>$/m);
  assert.match(append.raw, /Happy to talk Friday\./);

  assert.equal(saved.created, true);
  assert.deepEqual(
    { mailbox: saved.server.mailbox, uid: saved.server.uid, replaced: saved.server.replaced },
    { mailbox: 'Drafts', uid: append.uid, replaced: 'none' },
  );
  const row = repos.messages.get(saved.draft.id);
  assert.equal(row.isDraft, true);
  assert.equal(row.mailbox, 'Drafts');
  assert.equal(row.uid, append.uid);
  assert.equal(row.threadId, thread.id, 'the draft joins the conversation it answers');
  assert.equal(row.inReplyTo, '<original@example.test>');
  assert.equal(repos.drafts.listAll().length, 0, 'nothing is kept as an aMail-only draft');
});

test('saving again replaces the server copy and keeps the same draft id', async (t) => {
  const { repos, service, server, account } = harness(t);
  const content = Buffer.from('quote bytes').toString('base64');
  const first = await service.saveDraft({
    accountId: account.id,
    to: ['buyer@example.test'],
    subject: 'Quote',
    textBody: 'v1',
    attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', content }],
  });
  const second = await service.saveDraft({ textBody: 'v2' }, first.draft.id);

  assert.equal(second.draft.id, first.draft.id);
  assert.equal(second.created, false);
  assert.equal(second.server.replaced, 'deleted');
  const live = server.messages('Drafts');
  assert.equal(live.length, 1, 'only the newest version stays on the server');
  assert.equal(live[0].messageId, '<draft-2@example.test>');
  assert.match(live[0].raw, /v2/);
  assert.match(live[0].raw, /quote\.pdf/, 'stored attachment bytes carry over');
  assert.match(live[0].raw, /^To: buyer@example\.test$/m, 'omitted fields are preserved');
  assert.deepEqual(server.deletes, [{ path: 'Drafts', uid: first.server.uid }]);
  const row = repos.messages.get(first.draft.id);
  assert.equal(row.uid, live[0].uid);
  assert.equal(row.messageId, '<draft-2@example.test>');
  assert.equal(repos.messages.listDrafts(account.id).length, 1);
});

test('a draft already imported from the server is updated in place on the server', async (t) => {
  const { repos, service, server, account } = harness(t);
  const raw = [
    'Message-ID: <gmail-draft@example.test>',
    'From: owner@example.test',
    'To: jim@example.test',
    'Subject: Re: Dialing for dollars',
    'In-Reply-To: <original@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'Typed in Gmail',
    '--b',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    '',
    'server-only bytes',
    '--b--',
    '',
  ].join('\r\n');
  const uid = server.seed('Drafts', raw, ['\\Draft']);
  const thread = repos.threads.create({ account_id: account.id, subject: 'Re: Dialing for dollars', normalized_subject: 'dialing for dollars', latest_at: '2026-10-28T00:00:00.000Z' });
  const imported = repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'Drafts', uid,
    rfc_message_id: '<gmail-draft@example.test>', in_reply_to: '<original@example.test>', references_json: '["<original@example.test>"]',
    subject: 'Re: Dialing for dollars', from_name: '', from_email: account.email,
    to_json: JSON.stringify([{ name: '', email: 'jim@example.test' }]), cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: '2026-10-28T00:00:00.000Z', received_at: '2026-10-28T00:00:00.000Z',
    html_body: '', text_body: 'Typed in Gmail', snippet: 'Typed in Gmail',
    attachments_json: JSON.stringify([{ index: 0, filename: 'notes.txt', contentType: 'text/plain', size: 17 }]),
    labels_json: '[]', is_read: 1, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
    snoozed_until: null, is_sent: 0, is_draft: 1,
  });

  const saved = await service.saveDraft({ textBody: 'Edited by aMail' }, imported.id);

  assert.equal(saved.draft.id, imported.id);
  const live = server.messages('Drafts');
  assert.equal(live.length, 1);
  assert.notEqual(live[0].uid, uid);
  assert.match(live[0].raw, /Edited by aMail/);
  assert.match(live[0].raw, /^In-Reply-To: <original@example\.test>$/m, 'reply headers survive the rewrite');
  assert.match(live[0].raw, /notes\.txt/);
  assert.match(live[0].raw, new RegExp(Buffer.from('server-only bytes').toString('base64')), 'attachment bytes are fetched from the server copy');
});

test('a stale UID is never deleted when it holds a different message', async (t) => {
  const { repos, service, server, account } = harness(t);
  const first = await service.saveDraft({ accountId: account.id, subject: 'Mine', textBody: 'v1' });
  // Another client replaced the message at that UID (e.g. after UIDVALIDITY reset).
  const mailbox = server.mailboxes.get('Drafts');
  mailbox.messages.get(first.server.uid).messageId = '<someone-else@example.test>';

  const second = await service.saveDraft({ textBody: 'v2' }, first.draft.id);

  assert.equal(second.server.replaced, 'kept');
  assert.equal(second.server.replacedReason, 'message-id-mismatch');
  assert.equal(server.deletes.length, 0);
  assert.equal(server.messages('Drafts').length, 2);
  assert.equal(repos.messages.get(first.draft.id).messageId, '<draft-2@example.test>');
});

test('servers without UIDPLUS: the UID is found by Message-ID', async (t) => {
  const { repos, service, server, account } = harness(t, { imap: { uidplus: false } });
  const first = await service.saveDraft({ accountId: account.id, subject: 'No UIDPLUS', textBody: 'v1' });
  assert.equal(first.server.uid, server.appends[0].uid);
  const second = await service.saveDraft({ textBody: 'v2' }, first.draft.id);
  assert.equal(second.server.replaced, 'deleted');
  assert.equal(server.messages('Drafts').length, 1);
  assert.equal(repos.messages.get(first.draft.id).uid, server.appends[1].uid);
});

test('Gmail drafts go to [Gmail]/Drafts by special-use; a missing Drafts mailbox is created', async (t) => {
  const gmail = harness(t, {
    provider: 'gmail',
    imap: {
      folders: [
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
        { path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts' },
        { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' },
      ],
    },
  });
  const saved = await gmail.service.saveDraft({ accountId: gmail.account.id, subject: 'Gmail', textBody: 'x' });
  assert.equal(saved.server.mailbox, '[Gmail]/Drafts');
  assert.equal(gmail.server.created.length, 0);

  const bare = harness(t, { imap: { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }] } });
  const created = await bare.service.saveDraft({ accountId: bare.account.id, subject: 'Bare', textBody: 'x' });
  assert.deepEqual(bare.server.created, ['Drafts']);
  assert.equal(created.server.mailbox, 'Drafts');
  assert.equal(created.server.createdMailbox, true);
});

test('a server failure saves nothing locally and write-protected accounts are refused', async (t) => {
  const failing = harness(t, { imap: { failAppend: Object.assign(new Error('NO [OVERQUOTA] secret upstream text'), { responseStatus: 'NO' }) } });
  await assert.rejects(
    failing.service.saveDraft({ accountId: failing.account.id, subject: 'Lost?', textBody: 'x' }),
    (error) => error.code === 'DRAFT_SAVE_FAILED' && !/secret/.test(error.message),
  );
  assert.equal(failing.repos.messages.listDrafts(failing.account.id).length, 0);
  assert.equal(failing.repos.drafts.listAll().length, 0);

  const guarded = harness(t, { config: { imapWriteProtectedAccounts: ['owner@example.test'] } });
  await assert.rejects(
    guarded.service.saveDraft({ accountId: guarded.account.id, subject: 'No', textBody: 'x' }),
    /IMAP writes are disabled/,
  );
  assert.equal(guarded.server.connects, 0);
});

test('local-only drafts migrate to the server: dry run lists, apply moves and removes the local copy', async (t) => {
  const { repos, service, server, account } = harness(t);
  const { thread } = seedReceived(repos, account);
  const content = Buffer.from('local bytes').toString('base64');
  const local = repos.drafts.create({
    account_id: account.id, thread_id: thread.id,
    to_json: JSON.stringify([{ name: 'Jim', email: 'jim@example.test' }]), cc_json: '[]', bcc_json: '[]',
    subject: 'Re: Dialing for dollars', html_body: '', text_body: 'Old local draft',
    attachments_json: JSON.stringify([{ index: 0, filename: 'a.txt', contentType: 'text/plain', size: 11, content }]),
  });

  const dry = await service.migrateLocalDrafts();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 1);
  assert.deepEqual(
    { id: dry.drafts[0].id, accountEmail: dry.drafts[0].accountEmail, subject: dry.drafts[0].subject, recipients: dry.drafts[0].recipients, attachments: dry.drafts[0].attachments },
    { id: local.id, accountEmail: 'owner@example.test', subject: 'Re: Dialing for dollars', recipients: 1, attachments: 1 },
  );
  assert.equal(server.connects, 0, 'a dry run never touches the mail server');
  assert.equal(repos.drafts.listAll().length, 1);

  const applied = await service.migrateLocalDrafts({ dryRun: false });
  assert.equal(applied.moved, 1);
  assert.equal(applied.failed, 0);
  assert.equal(repos.drafts.listAll().length, 0);
  const [live] = server.messages('Drafts');
  assert.match(live.raw, /Old local draft/);
  assert.match(live.raw, /^In-Reply-To: <original@example\.test>$/m, 'the migrated reply threads with its conversation');
  assert.match(live.raw, /a\.txt/);
  const row = repos.messages.get(applied.drafts[0].draftId);
  assert.equal(row.isDraft, true);
  assert.equal(row.threadId, thread.id);
});

test('sending a saved draft removes it from the server Drafts mailbox', async (t) => {
  const { repos, service, server, account, sent } = harness(t);
  const saved = await service.saveDraft({ accountId: account.id, to: ['jim@example.test'], subject: 'Send me', textBody: 'Ready' });
  const result = await service.sendMessage({
    accountId: account.id, draftId: saved.draft.id, to: ['jim@example.test'], subject: 'Send me', textBody: 'Ready',
  });
  assert.equal(sent.length, 1);
  assert.equal(result.draftCleanup.status, 'deleted');
  assert.equal(server.messages('Drafts').length, 0);
  assert.equal(repos.messages.get(saved.draft.id), null);
  assert.equal(repos.messages.listDrafts(account.id).length, 0);
});

test('a Drafts sync drops local copies of drafts that left the server', async (t) => {
  const { repos, service, server, account } = harness(t);
  const keep = await service.saveDraft({ accountId: account.id, subject: 'Keep', textBody: 'k' });
  const gone = await service.saveDraft({ accountId: account.id, subject: 'Sent from Gmail', textBody: 'g' });
  // Another client sends or discards the second draft.
  server.mailboxes.get('Drafts').messages.delete(gone.server.uid);
  repos.sync.save({ account_id: account.id, mailbox: 'Drafts', last_uid: gone.server.uid, uid_validity: server.uidValidity, last_error: null, synced_at: new Date().toISOString() });

  await service.syncAccount(account.id, { mailbox: 'Drafts' });

  assert.ok(repos.messages.get(keep.draft.id));
  assert.equal(repos.messages.get(gone.draft.id), null);
  assert.equal(repos.messages.listDrafts(account.id).length, 1);
});
