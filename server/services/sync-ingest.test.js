import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createSyncIngest } from './sync-ingest.js';

test('sync ingest worker opens and writes an encrypted database with a cloned key', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-sync-ingest-encrypted-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    env: 'production',
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    databaseKey: Buffer.alloc(32, 11),
    encryptDatabase: true,
    keyMode: 'env',
    syncWorker: true,
  };
  const seedDb = createDatabase(config);
  const seedRepos = createRepositories(seedDb);
  const account = seedRepos.accounts.create({
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
    credential_ciphertext: 'ciphertext',
    signature: '',
    sync_enabled: 1,
  });
  seedRepos.close();

  const ingest = createSyncIngest({ config });
  t.after(() => ingest.close());
  const result = await ingest.ingest({
    source: Buffer.from([
      'From: Friend <friend@example.test>',
      'To: Owner <owner@example.test>',
      'Subject: Encrypted worker',
      'Message-ID: <encrypted-worker@example.test>',
      'Date: Sun, 25 Oct 2026 18:00:00 +0000',
      '',
      'Worker message body.',
    ].join('\r\n')),
    account: { id: account.id },
    mailbox: 'INBOX',
    role: 'inbox',
    allMailMirror: false,
    message: {
      uid: 1,
      flags: [],
      labels: [],
      envelope: null,
      internalDate: new Date('2026-10-25T18:00:00.000Z'),
    },
  });
  await ingest.close();

  assert.equal(result.ok, true);
  assert.equal(result.imported, true);
  const verify = createDatabase(config);
  assert.equal(verify.prepare('SELECT count(*) AS count FROM messages').get().count, 1);
  verify.close();
});
