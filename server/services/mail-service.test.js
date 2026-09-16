import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  buildImapOptions,
  buildSmtpOptions,
  classifyMailConnectionError,
  compileRfc822Message,
  createMailService,
  sqliteConstraintReason,
} from './mail-service.js';
import { encryptJson } from './crypto.js';

const config = {
  allowInsecureTls: false,
  syncTimeoutMs: 12_345,
  syncMaxMessageBytes: 1024 * 1024,
  credentialKey: Buffer.alloc(32, 11),
};

test('non-implicit TLS ports require STARTTLS before authentication', () => {
  const account = {
    email: 'person@example.test',
    imap_host: 'mail.example.test',
    imap_port: 143,
    imap_secure: 0,
    smtp_host: 'mail.example.test',
    smtp_port: 587,
    smtp_secure: 0,
  };
  const credentials = { username: account.email, password: 'test-password' };
  const imap = buildImapOptions(account, credentials, config);
  const smtp = buildSmtpOptions(account, credentials, config);
  assert.equal(imap.secure, false);
  assert.equal(imap.doSTARTTLS, true);
  assert.equal(imap.tls.rejectUnauthorized, true);
  assert.equal(imap.disableAutoIdle, true);
  assert.equal(smtp.secure, false);
  assert.equal(smtp.requireTLS, true);
  assert.equal(smtp.tls.rejectUnauthorized, true);
});

test('implicit TLS ports do not also request STARTTLS', () => {
  const account = {
    email: 'person@example.test',
    imap_host: 'mail.example.test',
    imap_port: 993,
    imap_secure: 1,
    smtp_host: 'mail.example.test',
    smtp_port: 465,
    smtp_secure: 1,
  };
  const credentials = { password: 'test-password' };
  assert.equal(buildImapOptions(account, credentials, config).doSTARTTLS, undefined);
  assert.equal(buildSmtpOptions(account, credentials, config).requireTLS, false);
});

test('unsaved settings test verifies IMAP and SMTP without reading repositories', async () => {
  let imapOptions;
  let smtpOptions;
  let imapLogout = false;
  let smtpClosed = false;
  class FakeImapClient {
    constructor(options) { imapOptions = options; }
    async connect() {}
    async logout() { imapLogout = true; }
  }
  const service = createMailService({
    config,
    repos: {
      accounts: {
        getRaw() { throw new Error('unsaved tests must not read accounts'); },
      },
    },
    logger: { info() {}, warn() {} },
    ImapClient: FakeImapClient,
    createSmtpTransport(options) {
      smtpOptions = options;
      return {
        async verify() {},
        close() { smtpClosed = true; },
      };
    },
  });
  const result = await service.testSettings({
    email: 'person@example.test',
    provider: 'mailinabox',
    serverHost: 'box.example.test',
    credentials: { username: 'person@example.test', password: 'test-password' },
  });
  assert.deepEqual(result, { imap: true, smtp: true });
  assert.equal(imapOptions.host, 'box.example.test');
  assert.equal(imapOptions.port, 993);
  assert.equal(smtpOptions.host, 'box.example.test');
  assert.equal(smtpOptions.port, 587);
  assert.equal(smtpOptions.requireTLS, true);
  assert.equal(imapLogout, true);
  assert.equal(smtpClosed, true);
});

test('connection failures are actionable and never expose raw upstream text', async () => {
  class RejectingImapClient {
    async connect() {
      const error = new Error('AUTHENTICATIONFAILED upstream-secret-detail');
      error.authenticationFailed = true;
      throw error;
    }
    async logout() {}
  }
  const service = createMailService({
    config,
    repos: {},
    logger: { info() {}, warn() {} },
    ImapClient: RejectingImapClient,
    createSmtpTransport() {
      return { async verify() {}, close() {} };
    },
  });
  await assert.rejects(
    () => service.testSettings({
      email: 'person@gmail.com',
      provider: 'gmail',
      credentials: { username: 'person@gmail.com', password: 'test-password' },
    }),
    (error) => {
      assert.equal(error.code, 'IMAP_AUTH_FAILED');
      assert.match(error.message, /Google email address/);
      assert.doesNotMatch(error.message, /upstream-secret-detail/);
      assert.deepEqual(error.details.protocols.smtp, { ok: true });
      assert.equal(error.details.protocols.imap.code, 'IMAP_AUTH_FAILED');
      return true;
    },
  );
});

test('TLS failures point to certificate hostnames without returning raw errors', () => {
  const failure = classifyMailConnectionError(
    Object.assign(new Error('certificate is valid for box.example.test; raw-detail'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    { protocol: 'smtp', provider: 'mailinabox' },
  );
  assert.deepEqual(failure, {
    code: 'SMTP_TLS_FAILED',
    message: 'SMTP TLS verification failed. Use the hostname on the server certificate and confirm its certificate chain is valid.',
  });
});

function syncHarness({
  maxMessageBytes = 512, messages, sources, previousSync = null, uidValidity = 41, rejectUpsert = () => false, connectDelayMs = 0,
  imapPoolIdleMs, syncMinIntervalMs, connectFailure = false, fetchHangs = false, syncPassBudgetMs, syncAccountTimeoutMs,
}) {
  const account = {
    id: 'sync-account',
    email: 'sync@example.test',
    display_name: 'Sync Account',
    provider: 'custom',
    imap_host: 'mail.example.test',
    imap_port: 993,
    imap_secure: 1,
    smtp_host: 'mail.example.test',
    smtp_port: 465,
    smtp_secure: 1,
    signature: '',
    sync_enabled: 1,
    credential_ciphertext: encryptJson({ username: 'sync@example.test', password: 'test-password' }, config.credentialKey),
  };
  const state = {
    clients: [],
    connects: 0,
    openSessions: 0,
    maxOpenSessions: 0,
    listCalls: 0,
    fetchCalls: [],
    fetchOneCalls: [],
    savedMessages: [],
    savedSync: null,
    skips: [],
    checkpoints: 0,
    logs: [],
  };
  const latestUid = Math.max(0, ...messages.map((message) => message.uid));
  class FakeImapClient extends EventEmitter {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect() {
      state.connects += 1;
      state.openSessions += 1;
      state.maxOpenSessions = Math.max(state.maxOpenSessions, state.openSessions);
      if (connectDelayMs) await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
      if (connectFailure) {
        const error = new Error('Socket timeout during connect');
        this.emit('error', error);
        throw error;
      }
    }
    async list() {
      state.listCalls += 1;
      return [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }];
    }
    // ImapFlow's fetch() holds the connection while the caller's loop body
    // runs; any command issued from inside that loop waits forever. Fail
    // loudly instead so a regression cannot hang the suite.
    assertIdle(command) {
      if (this.fetching) throw new Error(`${command} issued while a FETCH is being iterated (deadlock)`);
    }
    async mailboxOpen() { this.assertIdle('SELECT'); }
    async getMailboxLock() {
      this.assertIdle('SELECT');
      this.mailbox = { uidValidity, uidNext: latestUid + 1 };
      return { release() {} };
    }
    async *fetch(range, query, options) {
      this.assertIdle('FETCH');
      state.fetchCalls.push({ range, query, options });
      const wanted = String(range).split(',').map((part) => {
        const [start, end = start] = part.split(':').map(Number);
        return [start, end];
      });
      const matches = messages.filter((message) => wanted.some(([start, end]) => message.uid >= start && message.uid <= end));
      if (fetchHangs) {
        this.fetching = true;
        // A real stuck socket is a live handle; without one the event loop
        // would drain before the (unref'd) deadline could fire.
        const socket = setInterval(() => {}, 1_000);
        await new Promise((_, reject) => this.once('close', () => {
          clearInterval(socket);
          reject(new Error('Connection closed'));
        }));
      }
      this.fetching = true;
      try {
        for (const message of matches) {
          const row = { uid: message.uid };
          if (query.size && message.size !== undefined) row.size = message.size;
          if (query.envelope) Object.assign(row, message);
          if (query.source) {
            const source = sources.get(message.uid);
            if (source !== undefined) row.source = source.subarray(0, query.source.maxLength);
          }
          yield row;
        }
      } finally {
        this.fetching = false;
      }
    }
    async fetchOne(uid, query, options) {
      this.assertIdle('FETCH');
      state.fetchOneCalls.push({ uid, query, options });
      const source = sources.get(uid);
      return source === undefined ? null : { uid, source };
    }
    async logout() {
      if (this.closed) return;
      this.closed = true;
      state.openSessions -= 1;
      this.emit('close');
    }
    close() { void this.logout(); }
  }
  const repos = {
    accounts: {
      getRaw: (id) => id === account.id ? account : null,
      list: () => [{ id: account.id, syncEnabled: true }],
      markSynced() {},
    },
    sync: {
      get: () => state.savedSync || previousSync,
      save(value) { state.savedSync = value; },
      recordSkip(value) { state.skips.push(value); },
      clearSkips() { state.skips.length = 0; },
    },
    threads: {
      get: () => null,
      findBySubject: () => null,
      create: () => ({ id: `thread-${state.savedMessages.length + 1}`, accountId: account.id }),
    },
    messages: {
      findByRfcId: () => null,
      upsert(value) {
        if (rejectUpsert(value)) throw new Error('UNIQUE constraint failed: messages.account_id, mailbox, uid');
        state.savedMessages.push(value);
        return { id: `message-${state.savedMessages.length}` };
      },
    },
    checkpointWal() { state.checkpoints += 1; },
  };
  const logger = {
    info(fields, message) { state.logs.push({ level: 'info', fields, message }); },
    warn(fields, message) { state.logs.push({ level: 'warn', fields, message }); },
  };
  const service = createMailService({
    config: {
      ...config,
      syncBatchSize: 20,
      syncMaxMessageBytes: maxMessageBytes,
      imapPoolIdleMs: imapPoolIdleMs ?? 60_000,
      syncMinIntervalMs: syncMinIntervalMs ?? 0,
      syncPassBudgetMs: syncPassBudgetMs ?? 60_000,
      syncAccountTimeoutMs: syncAccountTimeoutMs ?? 60_000,
    },
    repos,
    logger,
    ImapClient: FakeImapClient,
  });
  return { service, state };
}

test('IMAP sync skips oversized sources without unrestricted body downloads', async () => {
  const smallSource = Buffer.from([
    'From: Sender <sender@example.test>',
    'To: Sync Account <sync@example.test>',
    'Subject: Small message',
    'Message-ID: <small@example.test>',
    'Date: Sat, 18 Jul 2026 12:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'A small, safe message body.',
  ].join('\r\n'));
  const maxMessageBytes = smallSource.length + 32;
  const unknownOversize = Buffer.concat([
    Buffer.from('TOP SECRET OVERSIZED CONTENT'),
    Buffer.alloc(maxMessageBytes + 1),
  ]).subarray(0, maxMessageBytes + 1);
  const { service, state } = syncHarness({
    maxMessageBytes,
    messages: [
      { uid: 1, size: maxMessageBytes + 100, internalDate: new Date('2026-07-18T12:00:00Z') },
      { uid: 2, size: smallSource.length, internalDate: new Date('2026-07-18T12:01:00Z') },
      { uid: 3, internalDate: new Date('2026-07-18T12:02:00Z') },
    ],
    sources: new Map([[2, smallSource], [3, unknownOversize]]),
  });

  const result = await service.syncAccount('sync-account');

  assert.equal(result.status, 'partial');
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.mailboxes[0].skipReasons, [{
    code: 'IMAP_MESSAGE_TOO_LARGE',
    count: 2,
    maxBytes: maxMessageBytes,
  }]);
  assert.equal(result.mailboxes[0].lastUid, 3);
  assert.equal(state.savedMessages.length, 1);
  assert.equal(state.savedMessages[0].rfc_message_id, '<small@example.test>');

  // One size-only scan, then one capped source FETCH for everything that is
  // not already known to be too large. Never a command per message.
  assert.equal(state.fetchCalls.length, 2);
  assert.equal(state.fetchCalls[0].range, '1:3');
  assert.equal(state.fetchCalls[0].query.size, true);
  assert.equal(state.fetchCalls[0].query.source, undefined);
  assert.equal(state.fetchCalls[1].range, '2,3');
  assert.deepEqual(state.fetchCalls[1].query.source, { start: 0, maxLength: maxMessageBytes + 1 });
  assert.equal(state.fetchOneCalls.length, 0);
  assert.equal(state.savedSync.last_uid, 3);
  assert.doesNotMatch(JSON.stringify(state.logs), /TOP SECRET OVERSIZED CONTENT/);
  await service.close();
});

test('a message the database rejects is skipped and reported instead of pinning the mailbox', async () => {
  const source = (id, body) => Buffer.from([
    'From: Sender <sender@example.test>',
    'To: Sync Account <sync@example.test>',
    `Subject: ${id}`,
    `Message-ID: <${id}@example.test>`,
    'Date: Sat, 18 Jul 2026 12:00:00 +0000',
    '',
    body,
  ].join('\r\n'));
  const sources = new Map([[1, source('first', 'ok')], [2, source('poison', 'PRIVATE POISON BODY')], [3, source('third', 'ok')]]);
  const { service, state } = syncHarness({
    maxMessageBytes: 4096,
    messages: [1, 2, 3].map((uid) => ({ uid, size: sources.get(uid).length })),
    sources,
    rejectUpsert: (value) => value.rfc_message_id === '<poison@example.test>',
  });

  const result = await service.syncAccount('sync-account');

  assert.equal(result.status, 'partial');
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.mailboxes[0].skipReasons, [{ code: 'IMAP_MESSAGE_IMPORT_FAILED', count: 1 }]);
  // The window moves past the rejected message so the next cycle does not
  // fetch, parse, and reject it again.
  assert.equal(result.mailboxes[0].lastUid, 3);
  assert.equal(state.savedSync.last_uid, 3);
  assert.equal(state.savedSync.last_error, null);
  assert.deepEqual(state.savedMessages.map((message) => message.rfc_message_id), ['<first@example.test>', '<third@example.test>']);
  const warnings = state.logs.filter((entry) => entry.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fields.mailbox, 'INBOX');
  assert.equal(warnings[0].fields.uid, 2);
  assert.equal(warnings[0].fields.err, 'UNIQUE messages.account_id, mailbox, uid');
  assert.equal(state.skips.length, 1);
  assert.equal(state.skips[0].uid, 2);
  assert.equal(state.skips[0].reason, 'UNIQUE messages.account_id, mailbox, uid');
  assert.doesNotMatch(JSON.stringify(state.logs), /PRIVATE POISON BODY/);
  await service.close();
});

function plainSource(uid) {
  return Buffer.from([
    'From: Sender <sender@example.test>',
    'To: Sync Account <sync@example.test>',
    `Subject: Message ${uid}`,
    `Message-ID: <message-${uid}@example.test>`,
    'Date: Sat, 18 Jul 2026 12:00:00 +0000',
    '',
    `Body ${uid}`,
  ].join('\r\n'));
}

function mailboxOf(uids) {
  const sources = new Map(uids.map((uid) => [uid, plainSource(uid)]));
  return { messages: uids.map((uid) => ({ uid, size: sources.get(uid).length })), sources };
}

test('sources arrive in chunked FETCHes and never a command inside a FETCH loop', async () => {
  const uids = Array.from({ length: 60 }, (_, index) => index + 1);
  const { service, state } = syncHarness({ ...mailboxOf(uids), maxMessageBytes: 4096 });

  const result = await service.syncAccount('sync-account', { limit: 100 });

  assert.equal(result.status, 'ok');
  assert.equal(result.imported, 60);
  // One size scan plus ceil(60 / 25) source chunks.
  assert.deepEqual(state.fetchCalls.map((call) => Boolean(call.query.source)), [false, true, true, true]);
  assert.equal(state.fetchOneCalls.length, 0);
  assert.equal(state.savedSync.last_uid, 60);
  await service.close();
});

test('a burst larger than one page is imported oldest first instead of skipped', async () => {
  const uids = Array.from({ length: 12 }, (_, index) => index + 11);
  const { service, state } = syncHarness({
    ...mailboxOf(uids),
    maxMessageBytes: 4096,
    previousSync: { last_uid: 10, uid_validity: 41 },
    syncPassBudgetMs: 0,
  });

  // A zero budget stops after one page per pass, so the backlog drains over
  // passes; every message still arrives exactly once.
  const first = await service.syncAccount('sync-account', { limit: 5, force: true });
  assert.equal(first.imported, 5);
  assert.equal(first.remaining, 7);
  assert.equal(state.savedSync.last_uid, 15);
  assert.equal(state.fetchCalls[0].range, '11:22');

  const second = await service.syncAccount('sync-account', { limit: 5, force: true });
  assert.equal(second.imported, 5);
  assert.equal(second.remaining, 2);
  const third = await service.syncAccount('sync-account', { limit: 5, force: true });
  assert.equal(third.imported, 2);
  assert.equal(third.remaining, 0);

  assert.deepEqual(
    state.savedMessages.map((message) => message.uid),
    uids,
  );
  await service.close();
});

test('a pass with budget left keeps paging until the backlog is drained', async () => {
  const uids = Array.from({ length: 12 }, (_, index) => index + 11);
  const { service, state } = syncHarness({
    ...mailboxOf(uids),
    maxMessageBytes: 4096,
    previousSync: { last_uid: 10, uid_validity: 41 },
  });

  const result = await service.syncAccount('sync-account', { limit: 5 });

  assert.equal(result.imported, 12);
  assert.equal(result.remaining, 0);
  assert.equal(state.savedSync.last_uid, 22);
  await service.close();
});

test('the first sync of a mailbox still imports only its newest window', async () => {
  const uids = Array.from({ length: 12 }, (_, index) => index + 1);
  const { service, state } = syncHarness({ ...mailboxOf(uids), maxMessageBytes: 4096 });

  const result = await service.syncAccount('sync-account', { limit: 5 });

  assert.equal(state.fetchCalls[0].range, '8:12');
  assert.equal(result.imported, 5);
  assert.equal(result.remaining, 0);
  await service.close();
});

test('a hung IMAP session is closed at the deadline and does not block later syncs', async () => {
  const { service, state } = syncHarness({
    ...mailboxOf([1]),
    maxMessageBytes: 4096,
    fetchHangs: true,
    syncAccountTimeoutMs: 50,
  });

  const [result] = await service.syncAll({ force: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'IMAP_SYNC_TIMEOUT');
  assert.equal(state.clients[0].closed, true);
  assert.ok(state.logs.some((entry) => entry.message === 'IMAP synchronization exceeded its deadline; connection closed'));

  // The next pass opens a fresh session instead of waiting on the dead one.
  const [again] = await service.syncAll({ force: true });
  assert.equal(again.error, 'IMAP_SYNC_TIMEOUT');
  assert.equal(state.connects, 2);
  await service.close();
});

test('concurrent and recent full syncs share one IMAP pass', async () => {
  const { service, state } = syncHarness({ messages: [], sources: new Map(), connectDelayMs: 20 });

  // The web client, a second tab, and the background poller all ask at once:
  // one IMAP session, one shared result.
  const [a, b, c] = await Promise.all([
    service.syncAll({ mailbox: 'INBOX' }),
    service.syncAll({ mailbox: 'INBOX', maxAgeMs: 20_000 }),
    service.syncAll(),
  ]);
  assert.equal(state.connects, 1);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a[0].accountId, 'sync-account');

  // A poll that accepts a recent result gets the last one without IMAP.
  const recent = await service.syncAll({ mailbox: 'INBOX', maxAgeMs: 20_000 });
  assert.equal(recent, a);
  assert.equal(state.connects, 1);

  // A manual refresh reuses the pooled IMAP session instead of reconnecting.
  await service.syncAll({ mailbox: 'INBOX', force: true });
  assert.equal(state.connects, 1);
  assert.equal(state.listCalls, 1);
  await service.syncAll({ mailbox: 'Archive', force: true });
  assert.equal(state.connects, 1);
  assert.equal(state.listCalls, 1);

  // A request with a different target waits for the running one instead of
  // opening a second session to the same server, then runs on the same pool.
  const first = service.syncAll({ mailbox: 'INBOX', force: true });
  const second = service.syncAll({ mailbox: 'Archive', force: true });
  await Promise.all([first, second]);
  assert.equal(state.connects, 1);
  assert.equal(state.maxOpenSessions, 1);
  assert.ok(state.checkpoints >= 1);
  await service.close();
  assert.equal(state.openSessions, 0);
});

test('the server enforces a minimum sync interval unless force is set', async () => {
  const { service, state } = syncHarness({ messages: [], sources: new Map(), syncMinIntervalMs: 60_000 });
  await service.syncAll({ mailbox: 'INBOX' });
  const checkpoints = state.checkpoints;
  await service.syncAll({ mailbox: 'INBOX' });
  assert.equal(state.checkpoints, checkpoints);
  await service.syncAll({ mailbox: 'INBOX', force: true });
  assert.ok(state.checkpoints > checkpoints);
  await service.close();
});

test('idle IMAP errors retire the connection without crashing or retiring its replacement', async () => {
  const { service, state } = syncHarness({ messages: [], sources: new Map() });
  try {
    await service.syncAll({ force: true });
    const first = state.clients[0];
    assert.doesNotThrow(() => first.emit('error', new Error('Socket timeout')));
    await service.syncAll({ force: true });
    assert.equal(state.connects, 2, 'a failed idle socket must not be reused');
    const replacement = state.clients[1];
    assert.doesNotThrow(() => first.emit('error', new Error('late old-socket error')));
    await service.syncAll({ force: true });
    assert.equal(state.connects, 2, 'late errors from the retired socket leave its replacement usable');
    replacement.emit('close');
    await service.syncAll({ force: true });
    assert.equal(state.connects, 3, 'a closed connection must also be replaced');
    assert.ok(state.logs.some((entry) => entry.message === 'IMAP connection became unavailable'));
    await service.close();
    assert.doesNotThrow(() => state.clients.at(-1).emit('error', new Error('late shutdown error')));
  } finally {
    await service.close();
  }
});

test('IMAP error handling is installed before connect and remains during teardown', async () => {
  let client;
  const logs = [];
  class FailingImapClient extends EventEmitter {
    constructor() { super(); client = this; }
    async connect() {
      assert.equal(this.listenerCount('error'), 1);
      this.emit('error', new Error('Socket timeout password=fixture-secret'));
      throw new Error('Socket timeout');
    }
    async logout() { this.emit('error', new Error('late teardown error')); }
  }
  const service = createMailService({
    config,
    repos: {},
    logger: { info() {}, warn(fields, message) { logs.push({ fields, message }); } },
    ImapClient: FailingImapClient,
    createSmtpTransport: () => ({ async verify() {}, close() {} }),
  });
  await assert.rejects(() => service.testSettings({
    email: 'person@example.test', provider: 'custom', serverHost: 'mail.example.test',
    credentials: { username: 'person@example.test', password: 'fixture-secret' },
  }), (error) => error.code === 'IMAP_TIMEOUT');
  assert.doesNotThrow(() => client.emit('error', new Error('after logout')));
  assert.ok(logs.some(({ fields }) => fields.code === 'IMAP_TIMEOUT'));
  assert.doesNotMatch(JSON.stringify(logs), /fixture-secret|person@example/);
});

test('failed pooled IMAP connects close their socket and never enter the reusable pool', async () => {
  const { service, state } = syncHarness({ messages: [], sources: new Map(), connectFailure: true });
  try {
    await assert.rejects(() => service.syncAccount('sync-account', { force: true }),
      (error) => error.code === 'IMAP_SYNC_FAILED');
    assert.equal(state.openSessions, 0);
    assert.doesNotThrow(() => state.clients[0].emit('error', new Error('late failed-connect error')));
    await assert.rejects(() => service.syncAccount('sync-account', { force: true }),
      (error) => error.code === 'IMAP_SYNC_FAILED');
    assert.equal(state.connects, 2);
    assert.equal(state.openSessions, 0);
  } finally {
    await service.close();
  }
});

test('sqlite constraint messages are named without retrying the fetch', () => {
  assert.equal(
    sqliteConstraintReason(new Error('UNIQUE constraint failed: messages.account_id, mailbox, uid')),
    'UNIQUE messages.account_id, mailbox, uid',
  );
  assert.equal(sqliteConstraintReason(new Error('FOREIGN KEY constraint failed')), 'FOREIGN KEY');
  assert.equal(sqliteConstraintReason(new Error('CHECK constraint failed: smart_category')), 'CHECK smart_category');
  assert.equal(sqliteConstraintReason(new Error('no such table: messages')), null);
});

test('UIDVALIDITY changes reset the incremental window and are reported', async () => {
  const source = Buffer.from([
    'From: Sender <sender@example.test>',
    'To: Sync Account <sync@example.test>',
    'Subject: New mailbox generation',
    'Message-ID: <new-generation@example.test>',
    '',
    'Mailbox identity changed safely.',
  ].join('\r\n'));
  const { service, state } = syncHarness({
    messages: [{ uid: 5, size: source.length }],
    sources: new Map([[5, source]]),
    previousSync: { last_uid: 99, uid_validity: 40 },
    uidValidity: 41,
  });

  const result = await service.syncAccount('sync-account');

  assert.equal(state.fetchCalls[0].range, '1:5');
  assert.equal(result.status, 'ok');
  assert.equal(result.mailboxes[0].uidValidityChanged, true);
  assert.equal(state.savedSync.uid_validity, 41);
  assert.equal(state.savedSync.last_uid, 5);
  assert.ok(state.logs.some((entry) => entry.message === 'IMAP UIDVALIDITY changed; resynchronizing mailbox window'));
  await service.close();
});

test('RFC822 compilation preserves the chosen Message-ID and keeps Bcc envelope-only', async () => {
  const raw = await compileRfc822Message({
    envelope: {
      from: 'sender@example.test',
      to: ['visible@example.test', 'hidden@example.test'],
    },
    messageId: '<stable-message@example.test>',
    date: new Date('2026-07-18T12:00:00.000Z'),
    from: { name: 'Sender Name', address: 'sender@example.test' },
    to: 'visible@example.test',
    subject: 'Stable message',
    text: 'Hello from aMail.',
  });
  const source = raw.toString('utf8');
  assert.match(source, /^Message-ID: <stable-message@example\.test>$/m);
  assert.match(source, /^Date: Sat, 18 Jul 2026 12:00:00 \+0000$/m);
  assert.match(source, /^To: visible@example\.test$/m);
  assert.doesNotMatch(source, /^Bcc:/mi);
  assert.doesNotMatch(source, /hidden@example\.test/i);
});

function sendHarness({ provider = 'custom', ImapClient, appendResult, appendError, smtpResult, smtpError } = {}) {
  const account = {
    id: 'account-1',
    email: 'sender@example.test',
    display_name: 'Sender Name',
    provider,
    imap_host: provider === 'gmail' ? 'imap.gmail.com' : 'box.example.test',
    imap_port: 993,
    imap_secure: 1,
    smtp_host: provider === 'gmail' ? 'smtp.gmail.com' : 'box.example.test',
    smtp_port: provider === 'gmail' ? 465 : 587,
    smtp_secure: provider === 'gmail' ? 1 : 0,
    signature: '',
    credential_ciphertext: encryptJson({ username: 'sender@example.test', password: 'test-password' }, config.credentialKey),
  };
  const state = {
    appended: null,
    savedInput: null,
    smtpPayload: null,
    smtpClosed: false,
    imapLogout: false,
    threadCreates: 0,
    logs: [],
  };
  class DefaultImapClient {
    async connect() {}
    async list() { return [{ path: 'Sent Items', name: 'Sent Items', specialUse: '\\Sent' }]; }
    async append(...args) {
      state.appended = args;
      if (appendError) throw appendError;
      return appendResult ?? { uid: 42 };
    }
    async logout() { state.imapLogout = true; }
  }
  const repos = {
    accounts: { getRaw: (id) => id === account.id ? account : null },
    threads: {
      get: () => null,
      findBySubject: () => null,
      create: () => {
        state.threadCreates += 1;
        return { id: 'thread-1', accountId: account.id };
      },
    },
    messages: {
      findByRfcId: () => null,
      upsert(input) {
        state.savedInput = input;
        return {
          id: 'message-1',
          accountId: input.account_id,
          threadId: input.thread_id,
          messageId: input.rfc_message_id,
          subject: input.subject,
        };
      },
    },
    drafts: { remove() {} },
  };
  const logger = {
    info(fields, message) { state.logs.push({ level: 'info', fields, message }); },
    warn(fields, message) { state.logs.push({ level: 'warn', fields, message }); },
  };
  const service = createMailService({
    config,
    repos,
    logger,
    ImapClient: ImapClient || DefaultImapClient,
    createSmtpTransport() {
      return {
        async sendMail(payload) {
          state.smtpPayload = payload;
          if (smtpError) throw smtpError;
          return smtpResult ?? { accepted: payload.envelope.to, rejected: [], messageId: '<transport-generated@example.test>' };
        },
        close() { state.smtpClosed = true; },
      };
    },
    createMessageId: () => '<stable-message@example.test>',
  });
  return { service, state };
}

test('compose attachments are compiled into the SMTP raw message and stored locally', async () => {
  const { service, state } = sendHarness();
  const content = Buffer.from('invoice-bytes').toString('base64');
  await service.sendMessage({
    accountId: 'account-1',
    to: ['visible@example.test'],
    subject: 'Invoice attached',
    textBody: 'See the PDF.',
    attachments: [{ filename: 'invoice.txt', contentType: 'text/plain', content }],
  });
  assert.match(state.smtpPayload.raw.toString(), /invoice\.txt/);
  assert.match(state.smtpPayload.raw.toString(), /aW52b2ljZS1ieXRlcw==/);
  const stored = JSON.parse(state.savedInput.attachments_json);
  assert.equal(stored[0].filename, 'invoice.txt');
  assert.equal(stored[0].content, content);
});

test('non-Gmail sends use identical RFC822 bytes for SMTP and Sent APPEND', async () => {
  const { service, state } = sendHarness();
  const result = await service.sendMessage({
    accountId: 'account-1',
    to: ['visible@example.test'],
    cc: ['copy@example.test'],
    bcc: ['hidden@example.test'],
    subject: 'Sent copy integration',
    textBody: 'Stable message body.',
  });

  assert.equal(state.smtpClosed, true);
  assert.deepEqual(state.smtpPayload.envelope, {
    from: 'sender@example.test',
    to: ['visible@example.test', 'copy@example.test', 'hidden@example.test'],
  });
  assert.ok(Buffer.isBuffer(state.smtpPayload.raw));
  assert.match(state.smtpPayload.raw.toString(), /^Message-ID: <stable-message@example\.test>$/m);
  assert.doesNotMatch(state.smtpPayload.raw.toString(), /^Bcc:/mi);
  assert.equal(state.appended[0], 'Sent Items');
  assert.strictEqual(state.appended[1], state.smtpPayload.raw);
  assert.deepEqual(state.appended[2], ['\\Seen']);
  assert.ok(state.appended[3] instanceof Date);
  assert.equal(state.savedInput.rfc_message_id, '<stable-message@example.test>');
  assert.equal(state.savedInput.sent_at, state.appended[3].toISOString());
  assert.equal(state.imapLogout, true);
  assert.deepEqual(result.delivery, {
    status: 'accepted',
    recipientCount: 3,
    acceptedCount: 3,
    rejectedCount: 0,
    unconfirmedCount: 0,
  });
  assert.deepEqual(result.sentCopy, { attempted: true, status: 'appended', mailbox: 'Sent Items' });
});

test('all-rejected SMTP results are not saved or APPENDed as successful sends', async () => {
  class ForbiddenImapClient {
    constructor() { throw new Error('an all-rejected send must not open IMAP'); }
  }
  const smtpError = new Error('550 raw-upstream-rejection-detail');
  smtpError.code = 'EENVELOPE';
  smtpError.rejected = ['visible@example.test', 'hidden@example.test'];
  smtpError.rejectedErrors = [new Error('recipient policy raw-upstream-rejection-detail')];
  const { service, state } = sendHarness({ smtpError, ImapClient: ForbiddenImapClient });

  await assert.rejects(
    () => service.sendMessage({
      accountId: 'account-1',
      to: ['visible@example.test'],
      bcc: ['hidden@example.test'],
      subject: 'Rejected delivery',
      textBody: 'No recipient accepted this message.',
    }),
    (error) => {
      assert.equal(error.code, 'SMTP_ALL_RECIPIENTS_REJECTED');
      assert.deepEqual(error.details.delivery, {
        status: 'rejected',
        recipientCount: 2,
        acceptedCount: 0,
        rejectedCount: 2,
        unconfirmedCount: 0,
      });
      assert.doesNotMatch(error.message, /raw-upstream-rejection-detail/);
      return true;
    },
  );

  assert.ok(state.smtpPayload, 'the SMTP attempt should still be observable');
  assert.equal(state.smtpClosed, true);
  assert.equal(state.savedInput, null);
  assert.equal(state.threadCreates, 0);
  assert.equal(state.appended, null);
  assert.doesNotMatch(JSON.stringify(state.logs), /raw-upstream-rejection-detail/);
});

test('partial SMTP delivery is saved, APPENDed, and returned as sanitized counts', async () => {
  const smtpResult = {
    accepted: ['visible@example.test'],
    rejected: ['copy@example.test', 'hidden@example.test'],
    rejectedErrors: [new Error('550 raw-partial-rejection-detail')],
  };
  const { service, state } = sendHarness({ smtpResult });
  const result = await service.sendMessage({
    accountId: 'account-1',
    to: ['visible@example.test'],
    cc: ['copy@example.test'],
    bcc: ['hidden@example.test'],
    subject: 'Partial delivery',
    textBody: 'At least one recipient accepted this message.',
  });

  assert.deepEqual(result.delivery, {
    status: 'partial',
    recipientCount: 3,
    acceptedCount: 1,
    rejectedCount: 2,
    unconfirmedCount: 0,
  });
  assert.equal(result.id, 'message-1');
  assert.ok(state.savedInput);
  assert.ok(state.appended);
  const warning = state.logs.find((entry) => entry.message === 'SMTP accepted the message for only some recipients');
  assert.ok(warning);
  assert.deepEqual(warning.fields.delivery, result.delivery);
  assert.doesNotMatch(JSON.stringify(state.logs), /raw-partial-rejection-detail/);
});

test('Sent APPEND failure stays non-fatal and returns only a sanitized status', async () => {
  const appendError = new Error('NO [OVERQUOTA] raw-upstream-secret-detail');
  const { service, state } = sendHarness({ appendError });
  const result = await service.sendMessage({
    accountId: 'account-1',
    to: ['visible@example.test'],
    subject: 'Accepted by SMTP',
    textBody: 'This remains sent even if APPEND fails.',
  });

  assert.equal(result.id, 'message-1');
  assert.deepEqual(result.sentCopy, {
    attempted: true,
    status: 'failed',
    reason: 'IMAP_APPEND_QUOTA_EXCEEDED',
  });
  assert.ok(state.smtpPayload, 'SMTP must have accepted the raw message');
  const warning = state.logs.find((entry) => entry.level === 'warn');
  assert.ok(warning);
  assert.doesNotMatch(JSON.stringify(warning), /raw-upstream-secret-detail/);
  assert.equal(state.imapLogout, true);
});

test('Gmail skips IMAP APPEND because Gmail automatically files SMTP sends', async () => {
  class ForbiddenImapClient {
    constructor() { throw new Error('Gmail send must not open IMAP for APPEND'); }
  }
  const { service, state } = sendHarness({ provider: 'gmail', ImapClient: ForbiddenImapClient });
  const result = await service.sendMessage({
    accountId: 'account-1',
    to: ['visible@example.test'],
    subject: 'Gmail managed Sent copy',
    textBody: 'Gmail stores this automatically.',
  });

  assert.ok(state.smtpPayload);
  assert.equal(state.appended, null);
  assert.deepEqual(result.sentCopy, {
    attempted: false,
    status: 'provider-managed',
    reason: 'gmail-auto-copies-sent',
  });
});

test('attachment download re-fetches the original IMAP source and returns one part', async () => {
  const pdf = Buffer.from('%PDF-1.4 attachment-bytes');
  const source = Buffer.from([
    'From: Billing <billing@example.test>',
    'To: Owner <owner@example.test>',
    'Subject: Invoice',
    'Message-ID: <invoice@example.test>',
    'Date: Thu, 13 Aug 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bound"',
    '',
    '--bound',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Invoice attached.',
    '--bound',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--bound--',
    '',
  ].join('\r\n'));
  let fetchOneUid = null;
  class FakeImapClient {
    async connect() {}
    async getMailboxLock(mailbox) {
      assert.equal(mailbox, 'INBOX');
      return { release() {} };
    }
    async fetchOne(uid, query) {
      fetchOneUid = uid;
      assert.equal(query.source.maxLength, config.syncMaxMessageBytes + 1);
      return { uid, source };
    }
    async logout() {}
  }
  const account = {
    id: 'account-1',
    email: 'owner@example.test',
    credential_ciphertext: encryptJson({ username: 'owner@example.test', password: 'app-password' }, config.credentialKey),
    imap_host: 'imap.example.test',
    imap_port: 993,
    imap_secure: 1,
    provider: 'custom',
  };
  const service = createMailService({
    config,
    repos: {
      accounts: { getRaw: (id) => id === account.id ? account : null },
      messages: {
        get: (id) => id === 'msg-1' ? {
          id: 'msg-1',
          accountId: account.id,
          mailbox: 'INBOX',
          uid: 42,
          attachments: [{ index: 0, filename: 'invoice.pdf', contentType: 'application/pdf', size: pdf.length }],
        } : null,
      },
    },
    logger: { info() {}, warn() {} },
    ImapClient: FakeImapClient,
  });

  const first = await service.fetchAttachment('msg-1', 0);
  assert.equal(fetchOneUid, 42);
  assert.equal(first.filename, 'invoice.pdf');
  assert.equal(first.contentType, 'application/pdf');
  assert.equal(first.body.includes(pdf), true);

  fetchOneUid = null;
  const cached = await service.fetchAttachment('msg-1', 0);
  assert.equal(fetchOneUid, null);
  assert.equal(cached.body.equals(first.body), true);
});
