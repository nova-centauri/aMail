import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { ServiceUnavailableError } from '../errors.js';
import { errorHandler } from '../middleware/errors.js';
import { registerApi } from './api.js';
import { decryptJson } from '../services/crypto.js';
import { serializeAccountInput } from '../services/account-input.js';

function messageInput({ accountId, threadId, uid, subject, fromEmail, timestamp }) {
  return {
    account_id: accountId,
    thread_id: threadId,
    mailbox: 'INBOX',
    uid,
    rfc_message_id: `<api-${uid}@example.test>`,
    in_reply_to: null,
    references_json: '[]',
    subject,
    from_name: '',
    from_email: fromEmail,
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: timestamp,
    received_at: timestamp,
    html_body: '',
    text_body: '',
    snippet: subject,
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
  };
}

test('message API filters unified mail by smart category and account creation is connection-atomic', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-api-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 4),
    accessToken: null,
    syncBatchSize: 50,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
    releaseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  let rejectConnection = false;
  const mailService = {
    async testSettings() {
      if (rejectConnection) throw new ServiceUnavailableError('Sanitized connection failure.', 'IMAP_AUTH_FAILED');
      return { imap: true, smtp: true };
    },
    async updateMessageState(id, state) {
      const updated = repos.messages.setState(id, state);
      return { ...updated, remoteSync: { attempted: false, status: 'local-only', reason: 'test-double' } };
    },
  };
  const remoteContent = {
    canIssueTokens: false,
    async fetchToken() {
      throw new Error('not used');
    },
  };
  const logger = { error() {} };
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService, remoteContent });
  app.use(errorHandler(logger));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.releaseSha, config.releaseSha);
  // Health answers unauthenticated, so it must not describe the mailbox.
  assert.equal(Object.hasOwn(health, 'accounts'), false);

  const emptyChanges = await fetch(`${origin}/api/changes`);
  assert.equal(emptyChanges.status, 200);
  const emptyStamp = await emptyChanges.json();
  assert.equal(emptyStamp.changedAt, null);
  assert.equal(emptyStamp.changed, true);

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
    credential_ciphertext: 'test-only',
    signature: '',
    sync_enabled: 1,
  });
  const threadIds = [];
  for (const [index, sample] of [
    ['A human note', 'friend@example.test'],
    ['[acme/api] Workflow failed', 'notifications@github.com'],
    ['[FIRING:1] API latency', 'alerts@example.test'],
    ['Scheduled maintenance completed', 'updates@statuspage.io'],
  ].entries()) {
    const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    const thread = repos.threads.create({
      account_id: account.id,
      subject: sample[0],
      normalized_subject: sample[0].toLowerCase(),
      latest_at: timestamp,
    });
    threadIds.push(thread.id);
    repos.messages.upsert(messageInput({
      accountId: account.id,
      threadId: thread.id,
      uid: index + 1,
      subject: sample[0],
      fromEmail: sample[1],
      timestamp,
    }));
  }

  // A conversation belongs to the category of its latest scoped message. An
  // older CI notification must not make a newer human reply look like CI mail.
  repos.messages.upsert(messageInput({
    accountId: account.id,
    threadId: threadIds[1],
    uid: 5,
    subject: 'Re: Workflow failure — I can help',
    fromEmail: 'teammate@example.test',
    timestamp: '2026-01-06T00:00:00.000Z',
  }));
  const githubOnlyThread = repos.threads.create({
    account_id: account.id,
    subject: '[acme/web] Deploy check failed',
    normalized_subject: '[acme/web] deploy check failed',
    latest_at: '2026-01-07T00:00:00.000Z',
  });
  repos.messages.upsert(messageInput({
    accountId: account.id,
    threadId: githubOnlyThread.id,
    uid: 6,
    subject: '[acme/web] Deploy check failed',
    fromEmail: 'notifications@github.com',
    timestamp: '2026-01-07T00:00:00.000Z',
  }));

  const stamped = await (await fetch(`${origin}/api/changes`)).json();
  assert.ok(stamped.changedAt);
  assert.equal(stamped.changed, true);
  const unchanged = await (await fetch(`${origin}/api/changes?since=${encodeURIComponent(stamped.changedAt)}`)).json();
  assert.equal(unchanged.changed, false);

  const filteredResponse = await fetch(`${origin}/api/messages?folder=inbox&category=github_ci`);
  assert.equal(filteredResponse.status, 200);
  const filtered = await filteredResponse.json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.messages[0].category, 'github_ci');
  assert.equal(filtered.messages[0].subject, '[acme/web] Deploy check failed');
  assert.deepEqual(filtered.categoryCounts, { primary: 2, github_ci: 1, logs: 1, status: 1, ops_error: 0 });

  const searchedResponse = await fetch(`${origin}/api/messages?folder=inbox&q=Workflow%20failed`);
  assert.equal(searchedResponse.status, 200);
  const searched = await searchedResponse.json();
  assert.equal(searched.total, 1);
  assert.equal(searched.messages[0].subject, 'Re: Workflow failure — I can help');
  assert.equal(searched.messages[0].category, 'primary');
  assert.deepEqual(searched.categoryCounts, { primary: 1, github_ci: 0, logs: 0, status: 0, ops_error: 0 });

  const fromResponse = await fetch(`${origin}/api/messages?folder=inbox&q=${encodeURIComponent('from:teammate@example.test')}`);
  assert.equal(fromResponse.status, 200);
  const fromSearch = await fromResponse.json();
  assert.equal(fromSearch.total, 1);
  assert.equal(fromSearch.messages[0].subject, 'Re: Workflow failure — I can help');

  repos.messages.upsert({
    ...messageInput({
      accountId: account.id,
      threadId: threadIds[0],
      uid: 20,
      subject: 'A human note',
      fromEmail: 'friend@example.test',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    attachments_json: JSON.stringify([{ index: 0, filename: 'menu.pdf', contentType: 'application/pdf', size: 2048 }]),
  });
  const attachmentResponse = await fetch(`${origin}/api/messages?folder=inbox&q=${encodeURIComponent('from:friend has:attachment')}`);
  assert.equal(attachmentResponse.status, 200);
  const attachmentSearch = await attachmentResponse.json();
  assert.equal(attachmentSearch.total, 1);
  assert.equal(attachmentSearch.messages[0].hasAttachments, true);

  const afterResponse = await fetch(`${origin}/api/messages?folder=inbox&q=${encodeURIComponent('after:2026-01-06')}`);
  assert.equal(afterResponse.status, 200);
  const afterSearch = await afterResponse.json();
  assert.ok(afterSearch.messages.every((message) => message.subject !== 'A human note'));

  const draftContent = Buffer.from('draft-notes').toString('base64');
  const createdDraft = await fetch(`${origin}/api/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: account.id,
      to: ['ada@example.com'],
      subject: 'Draft with file',
      textBody: 'Working copy',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: draftContent }],
    }),
  });
  assert.equal(createdDraft.status, 201);
  const createdDraftBody = await createdDraft.json();
  assert.equal(createdDraftBody.draft.attachments[0].filename, 'notes.txt');
  const listedDrafts = await fetch(`${origin}/api/messages?folder=drafts`);
  const listed = await listedDrafts.json();
  assert.equal(listed.total, 1);
  assert.equal(listed.messages[0].hasAttachments, true);
  assert.equal(listed.messages[0].attachments[0].content, undefined);
  const allDraftsResponse = await fetch(`${origin}/api/drafts`);
  assert.equal(allDraftsResponse.status, 200);
  const allDrafts = await allDraftsResponse.json();
  assert.equal(allDrafts.drafts.length, 1);
  assert.equal(allDrafts.drafts[0].id, createdDraftBody.draft.id);
  assert.equal(allDrafts.drafts[0].subject, 'Draft with file');
  assert.equal(allDrafts.drafts[0].attachments[0].content, undefined);
  const accountDraftsResponse = await fetch(`${origin}/api/drafts?accountId=${encodeURIComponent(account.id)}`);
  assert.equal((await accountDraftsResponse.json()).drafts.length, 1);
  const loadedDraft = await fetch(`${origin}/api/drafts/${createdDraftBody.draft.id}`);
  assert.equal((await loadedDraft.json()).draft.attachments[0].content, draftContent);

  const allResponse = await fetch(`${origin}/api/messages?folder=inbox`);
  const all = await allResponse.json();
  assert.equal(all.total, 5);
  assert.equal(Object.values(all.categoryCounts).reduce((sum, count) => sum + count, 0), all.total);
  // Sidebar badges are conversation-level and stay available regardless of the
  // active folder view. All five seeded messages are unread inbox mail.
  assert.equal(all.folderCounts.inbox, 5);
  assert.equal(all.folderCounts.starred, 0);
  assert.equal(all.folderCounts.drafts, 1);

  // Routine ops digests stay out of the default inbox even when unread. Errors
  // surface in the dedicated Ops errors smart view.
  const quietThread = repos.threads.create({
    account_id: account.id,
    subject: 'Watchtower: all containers up to date',
    normalized_subject: 'watchtower: all containers up to date',
    latest_at: '2026-01-08T00:00:00.000Z',
  });
  repos.messages.upsert(messageInput({
    accountId: account.id,
    threadId: quietThread.id,
    uid: 7,
    subject: 'Watchtower: all containers up to date',
    fromEmail: 'watchtower@home.lab',
    timestamp: '2026-01-08T00:00:00.000Z',
  }));
  const errorThread = repos.threads.create({
    account_id: account.id,
    subject: 'Proxmox backup failed on pve-1',
    normalized_subject: 'proxmox backup failed on pve-1',
    latest_at: '2026-01-09T00:00:00.000Z',
  });
  repos.messages.upsert(messageInput({
    accountId: account.id,
    threadId: errorThread.id,
    uid: 8,
    subject: 'Proxmox backup failed on pve-1',
    fromEmail: 'root@proxmox.local',
    timestamp: '2026-01-09T00:00:00.000Z',
  }));
  const adaThread = repos.threads.create({
    account_id: account.id,
    subject: 'Press schedule for Thursday',
    normalized_subject: 'press schedule for thursday',
    latest_at: '2026-01-10T00:00:00.000Z',
  });
  const adaMessage = {
    ...messageInput({
      accountId: account.id,
      threadId: adaThread.id,
      uid: 9,
      subject: 'Press schedule for Thursday',
      fromEmail: 'ada@example.test',
      timestamp: '2026-01-10T00:00:00.000Z',
    }),
    to_json: JSON.stringify([{ name: 'Owner', email: 'owner@example.test' }]),
  };
  repos.messages.upsert(adaMessage);

  const defaultInbox = await (await fetch(`${origin}/api/messages?folder=inbox`)).json();
  assert.equal(defaultInbox.messages.some((item) => /Watchtower/.test(item.subject)), false);
  assert.equal(defaultInbox.messages.some((item) => /Proxmox backup failed/.test(item.subject)), true);
  assert.equal(defaultInbox.folderCounts.inbox, 7);

  const opsErrors = await (await fetch(`${origin}/api/messages?folder=inbox&category=ops_error`)).json();
  assert.equal(opsErrors.total, 1);
  assert.equal(opsErrors.messages[0].category, 'ops_error');

  // Person flags start empty and are configured at runtime.
  const noFlags = await (await fetch(`${origin}/api/flags`)).json();
  assert.deepEqual(noFlags.flags, []);
  assert.deepEqual(noFlags.opsSources.map((source) => source.id), ['proxmox', 'watchtower']);
  const unknownFlag = await fetch(`${origin}/api/messages?folder=inbox&flag=ada`);
  assert.equal(unknownFlag.status, 400);
  const savedFlags = await fetch(`${origin}/api/flags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags: [{ label: 'Ada', emails: ['Ada@example.test'], color: '#0b57d0' }] }),
  });
  assert.equal(savedFlags.status, 200);
  assert.deepEqual((await savedFlags.json()).flags[0], {
    id: 'ada', label: 'Ada', shortLabel: 'Ada', description: 'Mail involving Ada', color: '#0b57d0', emails: ['ada@example.test'],
  });
  const adaFlag = await (await fetch(`${origin}/api/messages?folder=inbox&flag=ada`)).json();
  assert.equal(adaFlag.total, 1);
  assert.equal(adaFlag.messages[0].from.email, 'ada@example.test');
  assert.equal(adaFlag.personFlag, 'ada');
  assert.equal(adaFlag.personFlagMeta.label, 'Ada');

  // The analyzed flag is the agent's read/unread: local-only, searchable, and
  // reported per conversation.
  assert.equal(adaFlag.messages[0].isAnalyzed, false);
  assert.equal(adaFlag.messages[0].unanalyzedCount, 1);
  assert.equal(defaultInbox.folderCounts.unanalyzed, 7);
  const analyzed = await fetch(`${origin}/api/messages/${adaThread.id}/analyzed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'triage-agent' }),
  });
  assert.equal(analyzed.status, 200);
  const analyzedBody = await analyzed.json();
  assert.equal(analyzedBody.message.isAnalyzed, true);
  assert.equal(analyzedBody.message.analyzedBy, 'triage-agent');
  assert.ok(analyzedBody.message.analyzedAt);
  assert.equal(analyzedBody.message.remoteSync.status, 'local-only');
  const afterAnalyzed = await (await fetch(`${origin}/api/messages?folder=inbox&flag=ada`)).json();
  assert.equal(afterAnalyzed.messages[0].isAnalyzed, true);
  assert.equal(afterAnalyzed.folderCounts.unanalyzed, 6);
  // Explicit search surfaces quiet ops digests too, so an agent asking for
  // unanalyzed mail sees every remaining conversation (7 = 8 seeded - 1 analyzed).
  const unanalyzedSearch = await (await fetch(`${origin}/api/messages?folder=inbox&q=${encodeURIComponent('is:unanalyzed')}`)).json();
  assert.equal(unanalyzedSearch.total, 7);
  assert.ok(unanalyzedSearch.messages.every((item) => item.isAnalyzed === false));
  const analyzedSearch = await (await fetch(`${origin}/api/messages?folder=inbox&q=${encodeURIComponent('is:analyzed')}`)).json();
  assert.equal(analyzedSearch.total, 1);
  assert.equal(analyzedSearch.messages[0].subject, 'Press schedule for Thursday');
  await fetch(`${origin}/api/messages/${adaThread.id}/unanalyzed`, { method: 'POST' });
  assert.equal((await (await fetch(`${origin}/api/messages?folder=inbox`)).json()).folderCounts.unanalyzed, 7);

  const invalidResponse = await fetch(`${origin}/api/messages?category=unknown`);
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, 'VALIDATION_ERROR');

  const accountPayload = {
    // Match AccountConnectForm.submit, including its legacy credentials.email.
    name: 'New account',
    email: 'new-account@gmail.com',
    displayName: 'New account',
    provider: 'gmail',
    credentials: { username: 'new-account@gmail.com', email: 'new-account@gmail.com', password: 'test-app-password' },
    signature: '',
    color: '#1a73e8',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  };
  rejectConnection = true;
  const rejected = await fetch(`${origin}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(accountPayload),
  });
  assert.equal(rejected.status, 503);
  assert.equal(repos.accounts.getByEmailRaw(accountPayload.email), null);

  rejectConnection = false;
  const createdResponse = await fetch(`${origin}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(accountPayload),
  });
  assert.equal(createdResponse.status, 201);
  const createdText = await createdResponse.text();
  assert.doesNotMatch(createdText, /test-app-password/);
  const created = JSON.parse(createdText);
  assert.equal(created.account.provider, 'gmail');
  assert.deepEqual(decryptJson(repos.accounts.getRaw(created.account.id).credential_ciphertext, config.credentialKey), accountPayload.credentials);
  assert.deepEqual(created.connection, { imap: true, smtp: true });

  const disabledSync = await fetch(`${origin}/api/accounts/${created.account.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syncEnabled: 'false' }),
  });
  assert.equal(disabledSync.status, 200);
  assert.equal((await disabledSync.json()).account.syncEnabled, false);

  const beforeRejectedUpdate = repos.accounts.getRaw(created.account.id).credential_ciphertext;
  rejectConnection = true;
  const rejectedUpdate = await fetch(`${origin}/api/accounts/${created.account.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials: { username: accountPayload.email, password: 'bad-replacement' } }),
  });
  assert.equal(rejectedUpdate.status, 503);
  assert.equal(repos.accounts.getRaw(created.account.id).credential_ciphertext, beforeRejectedUpdate);
});

test('account settings hide secrets, preserve blank passwords, verify changes atomically, and remove only local data', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-account-settings-'));
  const config = { dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), credentialKey: Buffer.alloc(32, 7), accessToken: 'settings-test-token' };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  const originalCredentials = {
    username: 'owner@me.com', imapUsername: 'owner', smtpUsername: 'owner@me.com',
    password: 'old-app-password', imapPassword: 'old-imap-password', smtpPassword: 'old-smtp-password',
    accessToken: 'old-oauth-token', imapAccessToken: 'old-imap-token', smtpAccessToken: 'old-smtp-token',
  };
  // Seed a legacy mixed credential blob to ensure password replacement clears
  // hidden higher-priority credentials, while a blank field preserves them.
  const account = repos.accounts.create(serializeAccountInput({
    email: 'owner@me.com', displayName: 'Owner', provider: 'icloud', credentials: originalCredentials,
  }, null, config));
  const untouched = repos.accounts.create(serializeAccountInput({
    email: 'other@example.test', provider: 'gmail', credentials: { password: 'other-password' },
  }, null, config));
  let rejectConnection = false;
  let whileTesting = () => {};
  const probes = [];
  const invalidated = [];
  const mailService = {
    async testSettings(settings) {
      probes.push(settings);
      whileTesting();
      if (rejectConnection) throw new ServiceUnavailableError('Credentials were rejected.', 'IMAP_AUTH_FAILED');
      return { imap: true, smtp: true };
    },
    invalidateAccount(id) { invalidated.push(id); },
    // Removing an account must never call an IMAP delete, send, or sync API.
    async updateMessageState() { assert.fail('Account removal must not mutate provider messages'); },
    async syncAccount() { assert.fail('Account removal must not synchronize provider mail'); },
    async sendMessage() { assert.fail('Account removal must not send mail'); },
  };
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService, remoteContent: { canIssueTokens: false } });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}/api/accounts`;
  const headers = { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' };
  const patch = (body) => fetch(`${origin}/${account.id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${origin}/${account.id}/settings`)).status, 401);
  const read = await fetch(`${origin}/${account.id}/settings`, { headers });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  const readText = await read.text();
  for (const secret of Object.entries(originalCredentials).filter(([key]) => /password|token/i.test(key)).map(([, value]) => value)) {
    assert.equal(readText.includes(secret), false);
  }
  assert.equal(readText.includes('credential_ciphertext'), false);
  const settings = JSON.parse(readText);
  assert.deepEqual(settings.credentials, { username: 'owner@me.com', imapUsername: 'owner', smtpUsername: 'owner@me.com', authType: 'oauth2' });
  assert.deepEqual(settings.account.imap, account.imap);
  assert.deepEqual(settings.account.smtp, account.smtp);
  assert.equal((await fetch(`${origin}/missing/settings`, { headers })).status, 404);

  const before = repos.accounts.getRaw(account.id);
  assert.equal((await patch({ displayName: 'Personal mail', credentials: { password: '' } })).status, 200);
  assert.equal((await patch({ color: '#334455' })).status, 200);
  assert.equal(repos.accounts.getRaw(account.id).credential_ciphertext, before.credential_ciphertext);
  assert.equal(probes.length, 0);
  assert.equal(invalidated.length, 0);
  const connectionBefore = repos.accounts.getRaw(account.id);
  rejectConnection = true;
  const failed = await patch({ credentials: { password: 'wrong-new-password' }, displayName: 'Should not save', imap: { host: 'imap.changed.test' } });
  assert.equal(failed.status, 503);
  assert.deepEqual(repos.accounts.getRaw(account.id), connectionBefore);
  assert.equal(invalidated.length, 0);

  rejectConnection = false;
  whileTesting = () => assert.deepEqual(repos.accounts.getRaw(account.id), connectionBefore);
  const saved = await patch({ credentials: { password: 'new-app-password' } });
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.doesNotMatch(savedText, /new-app-password|old-oauth-token|credential_ciphertext/);
  assert.deepEqual(probes.at(-1).credentials, { username: 'owner@me.com', imapUsername: 'owner', smtpUsername: 'owner@me.com', password: 'new-app-password' });
  assert.deepEqual(probes.at(-1).imap, settings.account.imap);
  assert.deepEqual(probes.at(-1).smtp, settings.account.smtp);
  const stored = repos.accounts.getRaw(account.id);
  assert.notEqual(stored.credential_ciphertext, before.credential_ciphertext);
  assert.equal(stored.credential_ciphertext.includes('new-app-password'), false);
  assert.deepEqual(decryptJson(stored.credential_ciphertext, config.credentialKey), probes.at(-1).credentials);
  assert.deepEqual(invalidated, [account.id]);
  whileTesting = () => {};
  assert.equal((await patch({ email: 'different@me.com' })).status, 400);
  assert.equal((await patch({ credentials: [] })).status, 400);
  assert.equal((await patch({ credentials: { password: null } })).status, 400);

  whileTesting = () => repos.accounts.update(account.id, { display_name: 'Changed in another tab' });
  assert.equal((await patch({ credentials: { password: 'would-overwrite-newer-settings' } })).status, 409);
  assert.equal(repos.accounts.get(account.id).displayName, 'Changed in another tab');
  assert.equal(decryptJson(repos.accounts.getRaw(account.id).credential_ciphertext, config.credentialKey).password, 'new-app-password');
  whileTesting = () => {};

  const timestamp = '2026-09-16T12:00:00.000Z';
  const thread = repos.threads.create({ account_id: account.id, subject: 'Local sample', normalized_subject: 'local sample', latest_at: timestamp });
  repos.messages.upsert(messageInput({ accountId: account.id, threadId: thread.id, uid: 1, subject: 'Local sample', fromEmail: 'friend@example.test', timestamp }));
  repos.drafts.create({ account_id: account.id, thread_id: thread.id, to_json: '[]', cc_json: '[]', bcc_json: '[]', subject: 'Draft', html_body: '', text_body: '', attachments_json: '[]' });
  repos.sync.save({ account_id: account.id, mailbox: 'INBOX', last_uid: 1, uid_validity: 5, last_error: null, synced_at: timestamp });
  repos.sync.recordSkip({ account_id: account.id, mailbox: 'INBOX', uid: 2, reason: 'test' });
  const removed = await fetch(`${origin}/${account.id}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 204);
  assert.equal(repos.accounts.get(account.id), null);
  assert.ok(repos.accounts.get(untouched.id));
  for (const table of ['messages', 'threads', 'drafts', 'sync_state', 'sync_skips']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id = ?`).get(account.id).count, 0);
  }
  assert.deepEqual(invalidated, [account.id, account.id]);
  assert.equal((await fetch(`${origin}/${account.id}`, { method: 'DELETE', headers })).status, 404);

  // Removing and adding again is available, but produces a fresh local account.
  const readded = await fetch(origin, { method: 'POST', headers, body: JSON.stringify({ email: account.email, provider: 'icloud', credentials: { username: account.email, password: 'new-app-password' } }) });
  assert.equal(readded.status, 201);
  assert.notEqual((await readded.json()).account.id, account.id);

  whileTesting = () => repos.accounts.remove(untouched.id);
  const removedWhileTesting = await fetch(`${origin}/${untouched.id}`, { method: 'PATCH', headers, body: JSON.stringify({ credentials: { password: 'replacement-after-removal' } }) });
  assert.equal(removedWhileTesting.status, 404);
  assert.equal(repos.accounts.get(untouched.id), null);
});
