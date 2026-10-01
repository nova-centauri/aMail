import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailService } from './mail-service.js';

function fixture(email = 'orders@midstatelitho.com') {
  const state = { changes: 0, imap: 0, metered: 0 };
  let message = { id: 'message', accountId: 'account', isAnalyzed: false };
  const service = createMailService({
    config: { imapWriteProtectedAccounts: ['orders@midstatelitho.com'] },
    repos: {
      accounts: { getRaw: () => ({ id: 'account', email }) },
      messages: {
        get: () => message,
        setState: (id, next) => { state.changes++; message = { ...message, ...next }; return message; },
      },
    },
    logger: { warn() {}, info() {} },
    metering: { recordAnalyzed(n) { state.metered += n; } },
    ImapClient: class { constructor() { state.imap++; throw new Error('unexpected connection'); } },
    createSmtpTransport() { throw new Error('unexpected SMTP'); },
  });
  return { service, state };
}

test('protected IMAP flag and move writes fail before local state or connection changes', async () => {
  for (const field of ['isRead', 'isStarred', 'isArchived', 'isTrashed', 'isSpam']) {
    for (const value of [true, false]) {
      const { service, state } = fixture(' ORDERS@MIDSTATELITHO.COM ');
      await assert.rejects(service.updateMessageState('message', { [field]: value, isAnalyzed: true }), /disabled/);
      assert.deepEqual(state, { changes: 0, imap: 0, metered: 0 });
      await service.close();
    }
  }
});

test('protected account analyzed-only marks stay local and meter the transition once', async () => {
  const { service, state } = fixture();
  const result = await service.updateMessageState('message', { isAnalyzed: true, analyzedBy: 'test' });
  assert.equal(result.remoteSync.attempted, false);
  assert.equal(result.remoteSync.status, 'local-only');
  await service.updateMessageState('message', { isAnalyzed: true });
  assert.equal(state.imap, 0);
  assert.equal(state.metered, 1);
  await service.close();
});

test('protected sending is rejected before SMTP, credentials or Sent APPEND', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.sendMessage({ accountId: 'account' }), /disabled/);
  assert.deepEqual(state, { changes: 0, imap: 0, metered: 0 });
  await service.close();
});

test('unverifiable account identity fails closed before a provider mutation', async () => {
  const { service, state } = fixture('');
  await assert.rejects(service.updateMessageState('message', { isTrashed: true }), /verify/);
  assert.equal(state.changes, 0);
  await service.close();
});
