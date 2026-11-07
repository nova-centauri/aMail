import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDatabase, createRepositories } from '../db.js';
import { createMailService } from '../services/mail-service.js';
import { encryptJson } from '../services/crypto.js';
import { createFakeImapServer } from '../services/fake-imap.test-support.js';
import { createAmailMcpServer } from './server.js';

const credentialKey = Buffer.alloc(32, 9);

function raw(index) {
  return [
    'From: Pat <pat@example.test>',
    'To: Owner <owner@example.test>',
    `Subject: Order ${index}`,
    `Message-ID: <claim-${index}@example.test>`,
    `Date: Thu, 29 Oct 2026 15:${String(10 + index).padStart(2, '0')}:00 +0000`,
    '',
    'Hello there.',
    '',
  ].join('\r\n');
}

async function harness(t, count = 4) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-claims-'));
  const config = {
    dataDir, dbPath: path.join(dataDir, 'mail.sqlite'), credentialKey,
    syncTimeoutMs: 5_000, syncBatchSize: 50, imapPoolIdleMs: 0,
  };
  const db = createDatabase(config);
  const repos = createRepositories(db);
  const imap = createFakeImapServer({ folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }] });
  const mailService = createMailService({
    config, repos, logger: { info() {}, warn() {}, error() {}, debug() {} }, ImapClient: imap.FakeImapClient,
  });
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', color: '#1a73e8', provider: 'custom',
    avatar_blob: null, avatar_mime: null,
    imap_host: 'imap.example.test', imap_port: 993, imap_secure: 1,
    smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: encryptJson({ username: 'owner@example.test', password: 'test-only' }, credentialKey),
    signature: '', sync_enabled: 1,
  });
  for (let index = 1; index <= count; index += 1) imap.state.seed('INBOX', raw(index));
  await mailService.syncAccount(account.id);

  const server = createAmailMcpServer({ config, repos, mailService });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claims-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await mailService.close?.().catch(() => {});
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(body.error || 'tool error'), { body });
    return body;
  };
  return { db, repos, account, call };
}

// Move every live claim's expiry into the past.
function expireClaims(db) {
  db.prepare("UPDATE messages SET claimed_until = '2000-01-01T00:00:00.000Z' WHERE claimed_by IS NOT NULL").run();
}

test('two agents asking for work get different emails', async (t) => {
  const h = await harness(t);
  const queue = (await h.call('list_unanalyzed_messages')).messages.map((message) => message.id);

  const first = await h.call('claim_messages', { by: 'sweep-a', limit: 2 });
  const second = await h.call('claim_messages', { by: 'sweep-b', limit: 5 });

  const a = first.messages.map((message) => message.id);
  const b = second.messages.map((message) => message.id);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2, 'only the two nobody holds are left');
  assert.deepEqual(a.filter((id) => b.includes(id)), []);
  assert.deepEqual(a, queue.slice(0, 2), 'taken in review-queue order');
  assert.equal(first.messages[0].claimedBy, 'sweep-a');
  assert.ok(Date.parse(first.claimedUntil) > Date.now() + 14 * 60_000, 'default lease is 15 minutes');
  assert.deepEqual((await h.call('claim_messages', { by: 'sweep-c' })).messages, []);
});

test('claiming exact ids refuses ones another agent holds and says who', async (t) => {
  const h = await harness(t, 2);
  const [one, two] = (await h.call('list_unanalyzed_messages')).messages.map((message) => message.id);
  await h.call('claim_messages', { by: 'sweep-a', ids: [one] });

  const result = await h.call('claim_messages', { by: 'sweep-b', ids: [one, two] });

  assert.deepEqual(result.messages.map((message) => message.id), [two]);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].id, one);
  assert.equal(result.refused[0].reason, 'claimed');
  assert.equal(result.refused[0].claimedBy, 'sweep-a');
});

test('the review queue hides other agents’ live claims only when asked as a named reviewer', async (t) => {
  const h = await harness(t, 3);
  const claimed = (await h.call('claim_messages', { by: 'sweep-a', limit: 1 })).messages[0].id;

  const anonymous = await h.call('list_unanalyzed_messages');
  assert.equal(anonymous.total, 3, 'unnamed callers see the whole queue as before');
  assert.equal(anonymous.messages.find((message) => message.id === claimed).claimedBy, 'sweep-a');

  const asB = await h.call('list_unanalyzed_messages', { by: 'sweep-b' });
  assert.equal(asB.total, 2);
  assert.equal(asB.claimedByOthers, 1);
  assert.ok(!asB.messages.some((message) => message.id === claimed));

  const asA = await h.call('list_unanalyzed_messages', { by: 'sweep-a' });
  assert.equal(asA.total, 3, 'your own claims stay in your queue');
  assert.equal(asA.claimedByOthers, 0);
});

test('marking a message analyzed releases its claim', async (t) => {
  const h = await harness(t, 1);
  const id = (await h.call('claim_messages', { by: 'sweep-a' })).messages[0].id;

  await h.call('mark_messages_analyzed', { ids: [id], by: 'sweep-a' });

  const row = h.repos.messages.get(id);
  assert.equal(row.isAnalyzed, true);
  assert.equal(row.claimedBy, null);
  assert.equal(row.claimedUntil, null);
  const again = await h.call('claim_messages', { by: 'sweep-b', ids: [id] });
  assert.equal(again.refused[0].reason, 'already-analyzed');
});

test('an expired claim is free for another agent to take', async (t) => {
  const h = await harness(t, 1);
  const id = (await h.call('claim_messages', { by: 'sweep-a', leaseMinutes: 1 })).messages[0].id;
  expireClaims(h.db);

  const taken = await h.call('claim_messages', { by: 'sweep-b' });

  assert.deepEqual(taken.messages.map((message) => message.id), [id]);
  assert.equal(h.repos.messages.get(id).claimedBy, 'sweep-b');
  assert.equal((await h.call('list_unanalyzed_messages', { by: 'sweep-a' })).total, 0);
});

test('claiming again extends your own lease', async (t) => {
  const h = await harness(t, 1);
  const first = await h.call('claim_messages', { by: 'sweep-a', leaseMinutes: 1 });
  const again = await h.call('claim_messages', { by: 'sweep-a', ids: [first.messages[0].id], leaseMinutes: 30 });

  assert.equal(again.messages.length, 1);
  assert.ok(Date.parse(again.claimedUntil) > Date.parse(first.claimedUntil));
  assert.equal(h.repos.messages.get(first.messages[0].id).claimedUntil, again.claimedUntil);
});

test('release gives back only your own claims', async (t) => {
  const h = await harness(t, 3);
  const mine = (await h.call('claim_messages', { by: 'sweep-a', limit: 2 })).messages.map((message) => message.id);
  const theirs = (await h.call('claim_messages', { by: 'sweep-b', limit: 1 })).messages[0].id;

  assert.equal((await h.call('release_message_claims', { by: 'sweep-a', ids: [mine[0], theirs] })).released, 1);
  assert.equal(h.repos.messages.get(theirs).claimedBy, 'sweep-b');
  assert.equal(h.repos.messages.get(mine[0]).claimedBy, null);
  assert.equal((await h.call('release_message_claims', { by: 'sweep-a' })).released, 1);
  assert.equal(h.repos.messages.get(mine[1]).claimedBy, null);
});

test('claim inputs are checked before anything changes', async (t) => {
  const h = await harness(t, 1);
  const [message] = (await h.call('list_unanalyzed_messages')).messages;

  await assert.rejects(h.call('claim_messages', { by: 'sweep-a', ids: [message.id, message.id] }));
  await assert.rejects(h.call('claim_messages', { by: 'sweep-a', ids: [message.id], accountId: h.account.id }));
  await assert.rejects(h.call('claim_messages', { by: 'sweep-a', leaseMinutes: 500 }));
  await assert.rejects(h.call('claim_messages', { by: '   ' }));
  assert.equal(h.repos.messages.get(message.id).claimedBy, null);
  const missing = await h.call('claim_messages', { by: 'sweep-a', ids: ['no-such-id'] });
  assert.deepEqual(missing.refused, [{ id: 'no-such-id', reason: 'not-found' }]);
});
